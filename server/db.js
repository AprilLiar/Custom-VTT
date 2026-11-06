import { createClient } from '@libsql/client';
import { writeSync } from 'node:fs';
import { IMAGE_COLUMNS, hashImageData } from './images.js';
import { trackTrip } from './dbProfile.js';
import {
  ARCHIVED_TABLES,
  OLD_CHARACTER_COLUMNS,
  OLD_COUNTER_COLUMNS,
  PURGED_TABLES,
  buildArchive,
  verifyArchive,
} from './compendiumArchive.js';

// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN env vars);
// a local libSQL file otherwise — same client, same SQL.
const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

// **This connects straight to the primary. There is no embedded replica any
// more (decided, reversed — it was Phases 0 and 5 of the round-trip work, and
// it took the site down).**
//
// The original problem was real and is worth stating, because it is the thing
// that must not come back: every helper below sends one statement per call, so
// against a remote database an action costs (its await-chain length) x (the
// round trip). Declaring a move was 26 queries in a 14-deep chain and took 3-5
// seconds. Nothing was slow — the trips were.
//
// An **embedded replica** (`syncUrl` + `offline: true`) answered that by keeping
// a whole copy of the database on this server's disk: reads local, writes local,
// pushed to the primary on a ten-second timer. It genuinely was fast. It was
// also, on this host, unaffordable and then fatal:
//
//  - **Render's free tier has no persistent disk.** `replica.db` is gone on
//    every cold start, so every boot re-downloaded the entire database. That is
//    the 6 GB Turso sync bill: not the game, just the same bytes over and over.
//  - **The whole libSQL binding is synchronous.** `createClient` with a
//    `syncUrl` and `db.sync()` both do network I/O *on the calling thread*, so
//    no `Promise.race`, timer or signal handler can shorten one.
//  - **Those two met.** As the database grew, the bootstrap pull passed
//    Render's five-minute port scan: the socket was bound at 13:02:30 and the
//    event loop then blocked for **783 seconds**, so the process never reached
//    `accept()` and answered nothing. A listening server that cannot run its
//    own accept loop is indistinguishable from a dead one. "No open ports
//    detected... Timed Out", with the site down and no way in — including no
//    way to run the tool that would have shrunk the database.
//
// So the replica is gone rather than merely switched off. What replaced it is
// the half of that work which was never tied to it: **`readMany`/`writeMany`
// collapse a group of statements into one round trip**, and the DDL queue does
// the same for the ~148 statements a boot used to make. The depth that remains
// is far below the depth that caused the original complaint, and it costs
// nothing at boot. If actions turn out to feel slow again, the answer is more
// batching where the chains are deepest — or a paid plan with a persistent
// disk, which is the only thing that makes an embedded replica actually viable
// here.
//
// Writes now land at the primary the moment they return, so there is no local
// pile that a container recycle can lose, and nothing to flush on SIGTERM.
const REMOTE_SCHEMES = /^(libsql|https?|wss?):/i;
const usingRemote = REMOTE_SCHEMES.test(url);

// Built as a pure function so the regression that would be *silent* can be
// pinned: reintroducing `syncUrl`/`offline` here would look perfectly healthy
// in every test and locally, and would only reappear as a deploy that times out
// against a database too big to pull. See server/test/dbConfig.test.js, which
// asserts their absence.
export function buildClientConfig({ url, authToken }) {
  return authToken ? { url, authToken } : { url };
}

// **Boot logging that actually reaches the log (bugfix — Render deploys that
// timed out having printed nothing at all).**
//
// Under Render, stdout is a PIPE, and Node writes to a pipe *asynchronously*:
// the bytes sit in a buffer until the event loop gets a turn. Anything that
// blocks the loop therefore swallows the `console.log` placed immediately
// before it — the process hangs holding its own explanation. That is how the
// replica's blocking bootstrap managed to time out a deploy while printing
// nothing at all. `writeSync(1, ...)` puts the line on the file descriptor
// before the next call starts, so a boot that stalls says where.
//
// The replica is gone and with it the call that could hang, but boot lines
// still use this: a slow boot on a cold free-tier container is exactly when the
// log matters most, and it costs one syscall. Everything else logs normally.
export function bootLog(line) {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    console.log(line);
  }
}

// **Nothing in this module touches the network at import time (bugfix — a
// Render deploy that hung forever, silently).**
//
// `createClient` used to run right here, at module scope. With a `syncUrl` its
// constructor performed a blocking `PullDb`, so if the primary did not answer
// it **never returned** — verified directly against a blackholed address: no
// throw, no timeout, no output, forever. ES module imports are hoisted and
// evaluated before a single statement of server/index.js runs, so that hang
// happened before the first `console.log` and before `httpServer.listen`.
// Render's view of it was a service that printed nothing and opened no port.
//
// A remote client has no such constructor — it is lazy, and connects on the
// first statement — so the hang itself is gone with the replica. Construction
// stays deferred anyway, because the property worth keeping is broader than the
// bug that produced it: **importing this module must never do I/O**, so
// index.js can bind the port and put its 503 gate up before anything else is
// attempted. `server/test/dbBoot.test.js` pins that.
let client = null;

export function connectDb() {
  if (client) return client;
  if (usingRemote) bootLog(`Database: connecting to ${redactedPrimary()}`);
  client = createClient(buildClientConfig({ url, authToken }));
  return client;
}

export const remoteMode = usingRemote;

// The primary's host without its credentials — safe to print into a log that
// Render keeps and that the user pastes into chat.
function redactedPrimary() {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// Turso speaks plain HTTP under its own `libsql://` scheme; the ws:// variants
// are the same server too. Only used by the reachability probe below — the
// client itself is still handed the URL exactly as configured.
export function primaryHttpUrl(target = url) {
  return target
    .replace(/^libsql:/i, 'https:')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:');
}

// How long the boot probe waits for the primary. A Turso database that has
// been idle takes a moment to wake, so this is generous rather than tight;
// setting it to 0 skips the probe entirely.
export const PROBE_TIMEOUT_MS = Number(process.env.TURSO_PROBE_TIMEOUT_MS ?? 10_000);

// **Find out at boot whether the database is there, by name.**
//
// This was load-bearing when the next call was the replica's blocking
// bootstrap: that call could not be interrupted by any timer or signal, so the
// reachability question had to be asked somewhere it *could* be given up on.
// With a plain remote client there is no such call — a broken connection now
// surfaces as a normal rejected promise on the first statement.
//
// It stays because the boot failure it names is still worth naming. An expired
// token or a paused database otherwise appears as every request 500ing with a
// driver error, on a host whose logs are the only thing the GM can see. Ten
// seconds and one sentence at boot is a much better trade than that.
//
// **Any HTTP response counts as reachable**, 404 and 401 included. The
// question this answers is "will a connection to this host complete", not "is
// this URL correct" — a wrong path or a rejected token still proves the host
// is up and the socket connects. Only a transport-level failure (DNS, refused,
// timeout) is a real negative.
export async function probePrimary({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!usingRemote || !(timeoutMs > 0)) return { skipped: true };
  const target = new URL('/health', primaryHttpUrl()).toString();
  const started = Date.now();
  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    return { ok: true, status: res.status, ms: Date.now() - started, host: redactedPrimary() };
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? String(err),
      ms: Date.now() - started,
      host: redactedPrimary(),
      timedOut: err?.name === 'TimeoutError',
    };
  }
}

// One libSQL result set as plain objects keyed by column name. Shared by `all`
// and by `readMany` below, so a batched read and a lone one hand back exactly
// the same shape.
function rowsOf(result) {
  return result.rows.map((row) => {
    const obj = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

// Safe helpers that always return plain objects keyed by column name.
//
// Both of them first drain anything `initDb` has queued (see `ddl` below), so
// no caller can ever read or write against a half-built schema — the queue is
// an optimisation of *when* the DDL is sent, never of whether it has landed
// before the next statement that might depend on it.
export async function all(sql, args = []) {
  if (ddlQueue?.length) await flushDdl();
  return rowsOf(await trackTrip(() => connectDb().execute({ sql, args }), sql));
}

export async function one(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0] ?? null;
}

export async function run(sql, args = []) {
  if (ddlQueue?.length) await flushDdl();
  return trackTrip(() => connectDb().execute({ sql, args }), sql);
}

// **Many statements, one round trip (decided, new — Phase 2 of the round-trip
// work).**
//
// `db.batch` posts a whole array of statements together and hands back one
// result set each, so a group of independent reads costs what a single read
// costs. `Promise.all([all(...), all(...)])` looks concurrent and is the shape
// most of this codebase already uses, but it still puts N requests on the wire.
//
// **This is now the only thing standing between an action and its old 3-5
// second cost.** The embedded replica that used to make per-statement depth
// free is gone (see the note at the top of this file), so every trip saved here
// is a trip actually saved. Reach for these two over `Promise.all` in any new
// handler, and prefer them when touching an old one.
//
// Takes the same `[sql, args]` pairs the helpers take and returns an array of
// row arrays in the same order, so converting a `Promise.all` of reads is a
// mechanical change with the destructuring left alone.
export async function readMany(statements) {
  const list = statements.filter(Boolean);
  if (!list.length) return [];
  if (ddlQueue?.length) await flushDdl();
  // One statement is not worth a batch — it is the same trip either way, and
  // this keeps callers from having to special-case an empty or single group.
  if (list.length === 1) {
    const [sql, args = []] = list[0];
    return [await all(sql, args)];
  }
  // One trip for the whole group — which is the entire point of this function,
  // and why the profiler counts it as one.
  const results = await trackTrip(
    () => connectDb().batch(list.map(([sql, args = []]) => ({ sql, args })), 'read'),
    `batch:read x${list.length}`
  );
  return results.map(rowsOf);
}

// The write-side twin: every statement lands, in order, in one round trip and
// one implicit transaction. Use it where a handler writes several independent
// rows — a new character's eight dice, a Tic's round events.
export async function writeMany(statements) {
  const list = statements.filter(Boolean);
  if (!list.length) return [];
  if (ddlQueue?.length) await flushDdl();
  if (list.length === 1) {
    const [sql, args = []] = list[0];
    return [await run(sql, args)];
  }
  return trackTrip(
    () => connectDb().batch(list.map(([sql, args = []]) => ({ sql, args })), 'write'),
    `batch:write x${list.length}`
  );
}

// **`initDb`'s schema work, collected and sent in one trip (decided, new —
// Phase 4 of the round-trip work).**
//
// Booting used to cost 148 statements against a warm database, every one of
// them awaited on its own: ~65 reads of `sqlite_master` (one per
// `ensureColumn`, one per migration guard), 38 `CREATE TABLE IF NOT EXISTS`
// that find the table already there, a handful of idempotent `UPDATE`s, and
// ~26 seed lookups. None of it does any work on a database that is already
// current — but the depth is real, and Render's free tier cold-starts often
// enough that it is paid over and over.
//
// Two things fix it without changing a single outcome:
//
//  - **One snapshot of `sqlite_master`** instead of one read per column
//    (`schemaTables` below). Every `ensureColumn` and every migration guard
//    then answers from memory.
//  - **A queue.** `ddl()` collects statements instead of sending them; the
//    queue is drained in a single `db.batch` the moment anything needs the
//    database to be current — which `all`, `run`, `readMany` and `writeMany`
//    all do for themselves, so a migration or a seed added later gets the
//    flush automatically without knowing this queue exists.
//
// The point is that nothing here decides the schema is *probably* fine and
// skips it. A version stamp would be simpler and much more dangerous: a Perk
// added to the registry, a Tag renamed, a seed row a GM deleted — all of them
// would silently stop being repaired, and the failure would show up as a
// missing mechanic weeks later. This runs the whole of `initDb`, every boot,
// exactly as before. It just stops paying a round trip per line to do it.
let ddlQueue = null;
let schemaSnapshot = null;
// `table.column` for every ALTER already queued but not yet flushed, so a
// second `ensureColumn` for the same column does not queue it twice. Kept
// beside the snapshot rather than spliced into it: the snapshot holds real
// `CREATE TABLE` text that the migration guards match against, and editing
// that text to fake a column in would be a trap for the next guard added.
const pendingColumns = new Set();
// `CREATE TABLE` text for every table this boot has queued but not yet sent.
// The snapshot is taken before any of them go out, so on a fresh database this
// is the only place the table exists — see `tableSql`.
const queuedTables = new Map();

function ddl(sql, args = []) {
  if (!ddlQueue) throw new Error('ddl() is only valid while initDb is running');
  const created = /^\s*CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql);
  if (created) queuedTables.set(created[1], sql);
  ddlQueue.push([sql, args]);
}

async function flushDdl() {
  if (!ddlQueue?.length) return;
  const pending = ddlQueue;
  // Reset before awaiting: writeMany re-enters this file, and anything queued
  // while the batch is in flight belongs to the *next* flush.
  ddlQueue = [];
  await writeMany(pending);
}

// The database's own `CREATE TABLE` text, read once per boot. Invalidated by
// the table-rebuilding migrations below, which are the only things that change
// it out from under us.
async function schemaTables() {
  if (!schemaSnapshot) {
    const rows = await all("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
    schemaSnapshot = new Map(rows.map((r) => [r.name, r.sql || '']));
  }
  return schemaSnapshot;
}

// The `CREATE TABLE` text a table will have once this boot's queue has landed.
//
// The snapshot first, then the queue: on an existing database the stored text
// is the truth and a queued `IF NOT EXISTS` will not touch it; on a fresh one
// the table exists only in the queue, and the queued statement is exactly what
// it is about to become. Both callers below need that composite answer rather
// than the snapshot alone, and for the same reason — the base CREATEs are
// frozen at their historical shape, so a brand-new database is born needing
// most of the column work and all of the rebuilds beneath them.
async function tableSql(table) {
  return (await schemaTables()).get(table) ?? queuedTables.get(table) ?? null;
}

function invalidateSchemaSnapshot() {
  schemaSnapshot = null;
  pendingColumns.clear();
}

// Column-adding migration that works on both local files and Turso:
// checks the table's stored CREATE statement rather than PRAGMA.
//
// It reads `tableSql`, not the snapshot, and the difference matters: nearly
// every column below is one that *only* this function ever adds, because the
// base CREATEs are frozen at their historical shape. Consulting the snapshot
// alone would find no table on a brand-new database, skip the ALTER, and leave
// a fresh world missing three dozen columns until its second boot.
// **Which part of an uploaded picture actually shows.** Four fractions of the
// image's own width and height — see `client/src/lib/imageCrop.js` for why they
// are normalised per axis rather than as a square, and why NULL means "no crop"
// rather than "the default crop".
//
// The picture itself is never cut down: `image_data` keeps whatever was
// uploaded, so the Arena card can render the whole thing while every thumbnail
// shows the chosen region, and re-opening the editor starts from the original
// rather than from a crop of a crop. Four columns instead of one packed string
// because every other optional field on these tables is its own column, and a
// REAL is a REAL.
async function ensureCropColumns(table) {
  for (const axis of ['x', 'y', 'w', 'h']) {
    await ensureColumn(table, `crop_${axis}`, 'REAL');
  }
}

// **A cache key for every stored picture (bandwidth).** See server/images.js
// for why the URL carries a content hash rather than relying on an ETag. Ten
// columns across nine tables, derived from the same registry the router uses so
// the two can never disagree about which tables hold an image.
//
// `image_hash` and `vitruvian_image_hash` appear in no existing CREATE TABLE
// text — including inside a comment, which is the trap ensureColumn's own note
// warns about — so both are safe to detect by word boundary. They do not
// collide with each other either: `\bimage_hash\b` cannot match inside
// `vitruvian_image_hash`, because the character before it is an underscore and
// therefore not a word boundary.
async function ensureImageHashColumns() {
  for (const { table, hash } of IMAGE_COLUMNS) await ensureColumn(table, hash, 'TEXT');
}

// Fill in the hash for every picture stored before the column existed.
//
// Runs inside initDb, which server/index.js awaits **before** it flips
// bootState to 'ready' — so no request is ever served against a row this has
// not reached. On a database that is already current every one of these
// queries returns nothing — a scan of a table with tens of rows, the cost of
// which is the round trip rather than the scan. Nine of them, once per boot.
//
// `chat_log` is deliberately skipped: index.js deletes the whole log on every
// boot, so a chat row written before this column existed cannot survive long
// enough to be read.
async function backfillImageHashes() {
  for (const { table, data, hash } of IMAGE_COLUMNS) {
    if (table === 'chat_log') continue;
    // **Check the column is really there before selecting it.** Most of these
    // data columns live in a base CREATE TABLE rather than arriving through
    // ensureColumn, and a base CREATE is frozen: `IF NOT EXISTS` will not
    // repair a table that already exists in an older shape, and no ALTER is
    // queued for it either. So a database whose `characters` predates
    // `image_data` — which is exactly what server/test/migrationReasonsToFight
    // builds, and what any sufficiently old deployment could be — would crash
    // the whole boot here on `no such column`. Nothing else at boot reads these
    // columns, so this backfill is the first thing that would ever have noticed.
    const sql = await tableSql(table);
    if (!sql || !new RegExp(`\\b${data}\\b`).test(sql)) continue;
    const rows = await all(
      `SELECT id, ${data} AS data FROM ${table} WHERE ${data} IS NOT NULL AND ${hash} IS NULL`
    );
    if (!rows.length) continue;
    bootLog(`Database: hashing ${rows.length} stored image(s) in ${table}.${data}`);
    await writeMany(
      rows.map((r) => [`UPDATE ${table} SET ${hash} = ? WHERE id = ?`, [hashImageData(r.data), r.id]])
    );
  }
}

async function ensureColumn(table, column, columnDdl) {
  const key = `${table}.${column}`;
  if (pendingColumns.has(key)) return;
  const sql = await tableSql(table);
  if (sql && !new RegExp(`\\b${column}\\b`).test(sql)) {
    pendingColumns.add(key);
    ddl(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDdl}`);
  }
}

// scene_summons gained a NOT NULL scene_id (decided, revised — see the
// table's own CREATE-time comment for why summons stopped being
// Scene-independent). SQLite can't ALTER a UNIQUE constraint in place
// either, and the UNIQUE shape itself has to change too
// (UNIQUE(character_id) → UNIQUE(scene_id, character_id)) — so this isn't
// a plain ensureColumn, it's the same rebuild shape as
// migrateMoveInteractionsTrigger above. **Existing rows are dropped, not
// copied forward** — deliberately, not an oversight: an old row predates
// the very column this migration exists to add, so it has no Scene to
// attach to and nothing sensible to backfill with, and scene_summons has
// only ever held live, ephemeral "who's on stage right now" state anyway
// (never a history worth preserving) — clearing it costs a GM one click
// to re-summon whoever was there, the same trust already placed in this
// table by every other write here treating it as disposable.
//
// **Rebuilds through `run()` directly, start to finish — never leans on
// the still-queued `CREATE TABLE IF NOT EXISTS` above to recreate it
// afterward.** `tableSql()` (via `schemaTables()` → `all()`) flushes
// `ddlQueue` the moment it is called, which runs that queued CREATE
// TABLE (and, on an existing database, no-ops it — the OLD table is still
// there to satisfy IF NOT EXISTS) *before* this function's own body gets
// to decide anything. Dropping the table and trusting the queue to
// recreate it later would leave nothing queued to do so once that flush
// has already happened — the table would simply stay gone. So the DROP
// and the CREATE both happen here, immediately, the same as every other
// rebuild in this file.
async function migrateSceneSummonsSceneId() {
  const sql = await tableSql('scene_summons');
  if (!sql || sql.includes('scene_id')) return;
  await run('DROP TABLE scene_summons');
  await run(`
    CREATE TABLE scene_summons (
      id INTEGER PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      temp_npc_id INTEGER REFERENCES temp_npcs(id) ON DELETE CASCADE,
      scene_picture_id INTEGER NOT NULL REFERENCES scene_pictures(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK(side IN ('left','right')),
      pos_x REAL,
      pos_y REAL,
      scale REAL NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK ((character_id IS NULL) <> (temp_npc_id IS NULL)),
      UNIQUE(scene_id, character_id),
      UNIQUE(scene_id, temp_npc_id)
    )
  `);
  invalidateSchemaSnapshot();
}

// chat_log.kind originally had a 2-value CHECK ('roll','message'), then grew
// to 3 ('move_reveal'), then 4 ('lane_snapshot'), then 5 ('round_summary',
// the Combat Automation overhaul's once-per-pair-per-round replay card —
// §1.5), now 6 ('quirk', a Quirk card shared to the table from a character
// sheet). Same rebuild pattern each time, since SQLite can't ALTER a CHECK
// constraint in place — a fresh database's CREATE TABLE IF NOT EXISTS below
// already gets the current CHECK directly, so this only fires against a
// database whose stored table SQL still has an older one.
//
// **The guard tests for the NEWEST value, not any of them.** It used to look
// for 'round_summary'; a database rebuilt for that one and then met with this
// version would have matched and skipped, leaving the older 5-value CHECK in
// place and every shared Quirk refused at the insert.
async function migrateChatLogKind() {
  const sql = await tableSql('chat_log');
  // Newest values: 'reminder' and 'stance_roll' (Panic at the Dojo fights).
  if (!sql || sql.includes("'stance_roll'")) return;
  await run(`
    CREATE TABLE chat_log_v2 (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot','round_summary','quirk','reminder','stance_roll')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL,
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER,
      content TEXT,
      image_data TEXT,
      image_mime_type TEXT,
      payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    INSERT INTO chat_log_v2 (id, kind, character_id, dice_rolled, modifier, move_id, content, image_data, image_mime_type, payload, created_at)
    SELECT id, kind, character_id, dice_rolled, modifier, move_id, content, image_data, image_mime_type, payload, created_at FROM chat_log
  `);
  await run('DROP TABLE chat_log');
  await run('ALTER TABLE chat_log_v2 RENAME TO chat_log');
  invalidateSchemaSnapshot();
}

// **Archive the old system, then remove it (decided, new — the pivot).**
//
// One boot does both, and the order is the whole safety argument:
//
//   1. Every archived table and its row count are read in ONE batch, which is
//      one read transaction — the counts describe exactly the rows that came
//      back, with nothing written in between.
//   2. The archive is built and checked (`verifyArchive`): every table's count
//      matches, and the stored text parses back to exactly what was built. If
//      either fails, **nothing is deleted** — the boot carries on with the old
//      tables still in place, says why in the log, and tries again next boot.
//   3. The archive row and every `DROP TABLE` go out in ONE write batch, which
//      is one transaction. Either the archive is stored and the tables are
//      gone, or neither happened. There is no moment where the data has been
//      dropped and the archive has not landed.
//
// Archives are append-only. A second one is only ever written if old tables
// reappear (a rollback to the previous deploy recreates them), and it never
// replaces the first.
//
// Column drops come after, one at a time and best-effort: SQLite can refuse a
// DROP COLUMN for reasons that have nothing to do with the data, and a refusal
// must not take the boot down. The heavy one — the backdrop picture — is
// cleared inside the transaction first, so its bytes are gone even if its
// column stays.
export let oldSystemPurge = { status: 'not-run', problems: [] };

async function archiveAndPurgeOldSystem() {
  const tables = await schemaTables();
  const presentPurged = PURGED_TABLES.filter((t) => tables.has(t));
  const columnPresent = (table, column) => new RegExp(`\\b${column}\\b`).test(tables.get(table) ?? '');
  const oldCharacterColumns = OLD_CHARACTER_COLUMNS.filter((c) => columnPresent('characters', c));
  const oldCounterColumns = OLD_COUNTER_COLUMNS.filter((c) => columnPresent('counters', c));
  if (!presentPurged.length && !oldCharacterColumns.length && !oldCounterColumns.length) {
    oldSystemPurge = { status: 'clean', problems: [] };
    return;
  }

  const writes = [];
  const archived = ARCHIVED_TABLES.filter((t) => tables.has(t));
  let archiveSummary = null;
  if (archived.length) {
    const results = await readMany([
      ...archived.map((t) => [`SELECT * FROM ${t} ORDER BY rowid`]),
      ...archived.map((t) => [`SELECT COUNT(*) AS n FROM ${t}`]),
      tables.has('characters') ? ['SELECT id, name FROM characters ORDER BY id'] : null,
    ]);
    const rowsByTable = {};
    const expectedCounts = {};
    archived.forEach((t, i) => {
      rowsByTable[t] = results[i];
      expectedCounts[t] = Number(results[archived.length + i][0].n);
    });
    const characterNames = tables.has('characters') ? results[archived.length * 2] : [];
    const archive = buildArchive({ rowsByTable, characterNames, archivedAt: new Date().toISOString() });
    const serialized = JSON.stringify(archive);
    const check = verifyArchive({ archive, serialized, expectedCounts });
    if (!check.ok) {
      oldSystemPurge = { status: 'skipped', problems: check.problems };
      bootLog(`Database: old system NOT removed — the archive did not verify: ${check.problems.join('; ')}`);
      return;
    }
    writes.push(
      [
        `CREATE TABLE IF NOT EXISTS compendium_archive (
          id INTEGER PRIMARY KEY,
          archived_at TEXT NOT NULL,
          counts TEXT NOT NULL,
          payload TEXT NOT NULL
        )`,
      ],
      [
        'INSERT INTO compendium_archive (archived_at, counts, payload) VALUES (?, ?, ?)',
        [archive.archivedAt, JSON.stringify(archive.counts), serialized],
      ]
    );
    archiveSummary = archive.counts;
  }
  if (columnPresent('characters', 'vitruvian_image_data')) {
    writes.push(['UPDATE characters SET vitruvian_image_data = NULL, vitruvian_image_mime_type = NULL']);
  }
  for (const t of presentPurged) writes.push([`DROP TABLE IF EXISTS ${t}`]);
  await writeMany(writes);

  const columnProblems = [];
  for (const [table, columns] of [['characters', oldCharacterColumns], ['counters', oldCounterColumns]]) {
    for (const column of columns) {
      try {
        await run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      } catch (err) {
        columnProblems.push(`${table}.${column}: ${err.message}`);
      }
    }
  }
  invalidateSchemaSnapshot();
  await schemaTables();
  oldSystemPurge = { status: 'purged', problems: columnProblems, archived: archiveSummary };
  if (archiveSummary) {
    const rows = Object.values(archiveSummary).reduce((a, b) => a + b, 0);
    bootLog(`Database: archived ${rows} old-system row(s) from ${Object.keys(archiveSummary).length} table(s)`);
  }
  bootLog(`Database: removed ${presentPurged.length} old-system table(s)`);
  if (columnProblems.length) bootLog(`Database: columns left in place (data already cleared): ${columnProblems.join('; ')}`);
}

export async function initDb() {
  ddlQueue = [];
  queuedTables.clear();
  invalidateSchemaSnapshot();
  // Read `sqlite_master` once, before anything is queued, so all ~60
  // `ensureColumn` checks and all six migration guards below are answered from
  // memory. See the note above `ddlQueue` for why this is a queue rather than
  // a version stamp that skips the work.
  await schemaTables();

  // Before anything else touches the schema: archive the old system and take
  // it out. See archiveAndPurgeOldSystem above.
  await archiveAndPurgeOldSystem();

  // Phase 0's demo table is no longer used.
  ddl('DROP TABLE IF EXISTS pings');

  ddl(`
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      character_type TEXT NOT NULL DEFAULT 'pc' CHECK(character_type IN ('pc','npc')),
      image_data TEXT,          -- the profile picture, base64, stored directly in Turso
      image_mime_type TEXT,     -- e.g. 'image/jpeg', needed to render image_data correctly
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      folder_id INTEGER -- character list folder; NULL = root
    )
  `);
  await ensureColumn('characters', 'folder_id', 'INTEGER');
  // The PC (= the player) an NPC is assigned to; NULL = the GM's alone. See server/control.js.
  await ensureColumn('characters', 'assigned_to', 'INTEGER');
  await ensureCropColumns('characters');

  // The old system's archive (see archiveAndPurgeOldSystem). Declared here as
  // well as inside the purge so a brand-new database has it too, and the
  // download endpoint never has to ask whether the table exists.
  ddl(`
    CREATE TABLE IF NOT EXISTS compendium_archive (
      id INTEGER PRIMARY KEY,
      archived_at TEXT NOT NULL,
      counts TEXT NOT NULL,     -- JSON {table: rows}, so a listing need not load the payload
      payload TEXT NOT NULL     -- the whole archive document, JSON
    )
  `);

  // GM-created folders for organizing the character list — same structural
  // pattern as move_folders (create/rename/delete). Nested: parent_id is a
  // self-reference (NULL = root); ON DELETE SET NULL is metadata only — the
  // actual reparenting-on-delete logic is explicit in character_folder:delete
  // (promote to the deleted folder's own parent, not unconditionally to root).
  ddl(`
    CREATE TABLE IF NOT EXISTS character_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES character_folders(id) ON DELETE SET NULL
    )
  `);
  await ensureColumn('character_folders', 'parent_id', 'INTEGER REFERENCES character_folders(id) ON DELETE SET NULL');

  // No FK clause on character_id: libsql enforces foreign keys, and chat
  // entries must survive character deletion (history shows "(deleted)").
  // kind='message' rows are free-text chat posts (optionally with an
  // attached image/GIF); kind='move_reveal' rows mark a declared move's
  // reveal (move_id set, posted automatically — see combat:tic_forward);
  // dice_rolled stays '[]' for both rather than NULL, since it predates
  // them and was already NOT NULL on existing databases. The text column is
  // named `content`, not `message` — a column literally named "message"
  // would collide with ensureColumn's word-boundary detection, which would
  // then false-positive-match the CHECK constraint's own `'message'` enum
  // literal above and skip adding the column entirely.
  // kind='lane_snapshot' rows (Chat Log redesign, item 4) mark a cumulative
  // per-lane Tic Counter snapshot posted every time any move in that lane
  // reveals — payload carries the whole snapshot (pairIndex, round/Tic
  // window, and every currently-revealed move in the lane with its own
  // footprint + embedded full move data for the Genius Observer expand) as
  // JSON, since (unlike declared_moves' per-viewer secrecy) a chat card is
  // broadcast identically to everyone and so only ever needs to carry
  // already-public data. Replaces the old single-move move_reveal card
  // going forward; move_reveal rows already in a live chat log keep
  // rendering exactly as before (see ChatPanel.jsx) for history's sake.
  // Combat Automation (Phase 9, planned — see vttprojectplan.md): a
  // kind='roll' row optionally carries this same payload column too, when
  // (and only when) the roll is for a declared move's own reveal-time Roll
  // — never for a bare Dice Tray/manual Stat/Pool roll, which have no move
  // to attack with. Documented shape (not yet populated by any handler —
  // that's the socket-event sub-phase):
  //   { declaredMoveId, moveId, pairIndex, side: 'left'|'right',
  //     targetCandidateIds: number[] }
  // targetCandidateIds is every character currently seated on the opposing
  // side of the roller's own pair at roll time — trivially one id for a
  // normal 1-on-1 pair, more than one under Uneven Combat, where the future
  // Apply-damage flow will need to ask which target(s) it actually hit.
  ddl(`
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot','round_summary','quirk','reminder','stance_roll')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL, -- JSON array of {slot_name, size, bonus, result}
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER, -- set for kind='move_reveal'; no FK, same survive-deletion reasoning as character_id
      content TEXT, -- free-text message content; kind='message' only
      image_data TEXT, -- base64; kind='message' only. GIFs stored raw/unresized to keep animation
      image_mime_type TEXT,
      payload TEXT, -- JSON; kind='lane_snapshot' always, kind='roll' optionally (see above)
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn(
    'chat_log',
    'kind',
    "TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot'))"
  );
  await ensureColumn('chat_log', 'content', 'TEXT');
  await ensureColumn('chat_log', 'image_data', 'TEXT');
  await ensureColumn('chat_log', 'image_mime_type', 'TEXT');
  await ensureColumn('chat_log', 'payload', 'TEXT');
  await migrateChatLogKind();

  // Role-play tab: per-character question/answer entries. The 6 canonical
  // questions live in client code; their answers are upserted here keyed by
  // question text (is_custom = 0). Custom questions are rows with is_custom = 1.
  ddl(`
    CREATE TABLE IF NOT EXISTS roleplay_entries (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      is_custom INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ---------------------------------------------------------------------
  // Relationships board (decided, new) — see the plan's own section.
  // ---------------------------------------------------------------------
  //
  // **A board IS its owner.** There is no `boards` table: every row below
  // carries `owner_character_id`, and that is the whole of a board's identity.
  // Pan and zoom are deliberately not here either — where somebody is looking
  // is a property of the person looking, not of the game (the same rule
  // SettingsPage states for brand hue), so the camera lives in localStorage.
  //
  // **Foreign keys ARE enforced here — measured, not assumed.** An earlier
  // version of this comment claimed the opposite, reasoning that `PRAGMA
  // foreign_keys` is only ever touched inside the six rebuild helpers above and
  // that SQLite defaults it OFF per connection. Both facts are true and the
  // conclusion was still wrong: `@libsql/client` turns it ON when it opens the
  // connection, so `PRAGMA foreign_keys` reads 1 before `initDb` has run a
  // single statement. Probe it before believing either story.
  //
  // Two consequences that shape the deletion code, and neither is optional:
  //
  //   - `relationship_nodes.character_id` has NO `ON DELETE` action, so with
  //     enforcement on, deleting a character that still has nodes pointing at
  //     it is **refused**. That makes the conversion in
  //     DELETE /api/characters/:id (nodes on other players' boards become
  //     board-local people) mandatory rather than merely kind — without it the
  //     delete fails outright.
  //   - The explicit board deletions in that same handler are belt-and-braces
  //     now rather than the only belt, and they stay: that handler spells out
  //     its whole cascade by hand as a matter of style, and an ordering that
  //     works whether or not the pragma is on is worth more than the saved
  //     lines.
  //
  // CHECK constraints are enforced regardless of the pragma, which is what
  // makes the discriminator below real under either story.

  // A person who exists only on one player's board. NOT named "temp npcs":
  // when the GM deletes a world NPC, every node referencing it converts into
  // one of these (keeping the last-known name and picture), and "temporary"
  // would then be a lie about the most permanent thing on the board.
  ddl(`
    CREATE TABLE IF NOT EXISTS relationship_people (
      id INTEGER PRIMARY KEY,
      owner_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      image_data TEXT,
      image_mime_type TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureCropColumns('relationship_people');

  // One placement on one board, at a point in world coordinates.
  //
  // Exactly one of character_id / person_id is set, and the CHECK is what makes
  // that a schema fact rather than a convention every reader has to remember.
  // Nickname and Notes live on the NODE, not on the person: the same NPC
  // dragged out twice is two independent placements, because placing somebody
  // twice usually means they occupy two roles in your head.
  ddl(`
    CREATE TABLE IF NOT EXISTS relationship_nodes (
      id INTEGER PRIMARY KEY,
      owner_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      character_id INTEGER REFERENCES characters(id),
      person_id INTEGER REFERENCES relationship_people(id),
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      nickname TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK ((character_id IS NULL) <> (person_id IS NULL))
    )
  `);

  // A relationship: a line between two placements, or between a placement and a
  // loose point in space.
  //
  // **An endpoint is either a node or a coordinate.** `ON DELETE SET NULL` is
  // what makes "delete the character but keep the relationships" nearly free —
  // the handler writes the last-known anchor into from_x/from_y first, then
  // deletes the node, and the line is left hanging exactly where the portrait
  // was. (It writes the null explicitly too: an ordering that is correct
  // whether or not the pragma is on costs nothing and survives a change to it.)
  //
  // `retired` is a past relationship kept for history: forced grey, half
  // transparent, and pushed to the backmost layer so anything may overlap it.
  ddl(`
    CREATE TABLE IF NOT EXISTS relationship_edges (
      id INTEGER PRIMARY KEY,
      owner_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      from_node_id INTEGER REFERENCES relationship_nodes(id) ON DELETE SET NULL,
      from_side TEXT NOT NULL DEFAULT 'right' CHECK(from_side IN ('top','right','bottom','left')),
      from_x REAL,
      from_y REAL,
      to_node_id INTEGER REFERENCES relationship_nodes(id) ON DELETE SET NULL,
      to_side TEXT NOT NULL DEFAULT 'left' CHECK(to_side IN ('top','right','bottom','left')),
      to_x REAL,
      to_y REAL,
      label TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#f87179',
      arrow TEXT NOT NULL DEFAULT 'none' CHECK(arrow IN ('none','from','to')),
      retired INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // **A hand-drawn arc, stored as an offset rather than a control point.**
  // NULL means the line has never been bent by hand and takes whatever the
  // automatic fan gives it — which is what keeps two lines between the same
  // pair from overlapping. A number overrides that fan with the arc the player
  // dragged: a perpendicular displacement of the curve's control point, in the
  // edge's own from→to frame.
  //
  // The frame is the whole reason this is one number and not a point. An
  // absolute control point would be a fixed place in the world, and the arc
  // would flatten out the instant either portrait moved; an offset is relative
  // to the line's own two ends, so the curve travels with them.
  await ensureColumn('relationship_edges', 'bend', 'REAL');
  // **The other half of the bend.** `bend` is the control point's offset ACROSS
  // the chord; `bend_u` is where along it that offset is applied — 0 at one end,
  // 1 at the other, NULL reading as 0.5, which is exactly what the single-column
  // version always did. Two numbers is what makes a hand bend omni-directional
  // and lets the arc form where it was grabbed rather than always in the middle.
  // The older column keeps its name rather than being migrated to `bend_v`: the
  // rename would move every stored arc for no change in behaviour.
  await ensureColumn('relationship_edges', 'bend_u', 'REAL');

  // ---------------------------------------------------------------------
  // Scene tab (decided, new). A GM-authored fullscreen background picture
  // ("a Scene") plus a lightweight, portrait-only, narrative-only roster
  // ("Temp NPCs") — distinct from real fighting NPCs the same way this app
  // already keeps the Relationships board's `relationship_people` distinct
  // from `characters`. Every real Character and every Temp NPC can carry
  // any number of transparent-PNG "Scene Pictures", picked at summon time.
  //
  // Temp NPCs get their own folder tree, mirroring character_folders
  // exactly (self-referencing parent_id, ON DELETE SET NULL is metadata
  // only — the actual promote-one-level-on-delete logic is explicit in
  // temp_npc_folder:delete, same as character_folder:delete).
  ddl(`
    CREATE TABLE IF NOT EXISTS temp_npc_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES temp_npc_folders(id) ON DELETE SET NULL
    )
  `);

  ddl(`
    CREATE TABLE IF NOT EXISTS temp_npcs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      image_data TEXT,
      image_mime_type TEXT,
      folder_id INTEGER REFERENCES temp_npc_folders(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureCropColumns('temp_npcs');

  // Scenes: a fullscreen background picture, foldered the same way again.
  ddl(`
    CREATE TABLE IF NOT EXISTS scene_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES scene_folders(id) ON DELETE SET NULL
    )
  `);

  ddl(`
    CREATE TABLE IF NOT EXISTS scenes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      image_data TEXT,
      image_mime_type TEXT,
      folder_id INTEGER REFERENCES scene_folders(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // The right-drawer THUMBNAIL crop only. The live stage never reads these
  // columns — it always renders the full, uncropped image, scaled per
  // `background_fit` below.
  await ensureCropColumns('scenes');
  // **Background fit (decided, new) — per-SCENE, not per-viewer.** Unlike
  // the Settings page's own Scene Stage sliders (character height/gap/size,
  // all deliberately per-device: "how big YOU like characters on your own
  // screen"), how a Scene's own BACKDROP scales inside the stage box is an
  // authored property of that Scene's art, the same trust level as the
  // backdrop image itself — a battle map's own edges can carry real
  // information (an NPC drawn into a corner, part of a room) that a
  // Player's own device happening to crop with `cover` would hide from
  // them specifically, which the GM has no way to know or fix per-viewer.
  // So it lives on the row, applies identically to every viewer, and is
  // edited in `SceneEditor.jsx` alongside the backdrop picker itself, not
  // in Settings. One of a small fixed set (`server/index.js`'s own
  // `VALID_BACKGROUND_FITS`) — `'cover'` (crop to fill, the previously
  // hardcoded-only behavior and still the default) plus `contain`/`fill`,
  // which map straight onto their own CSS `object-fit` keyword, and
  // `fit-height`/`fit-width`, which don't exist as an `object-fit` keyword
  // at all (`object-fit` always PICKS an axis itself, based on the image's
  // own aspect ratio vs the box's; these two force a SPECIFIC axis
  // regardless — see ScenePage.jsx's own `BACKDROP_FIT_CLASS` for how).
  await ensureColumn('scenes', 'background_fit', "TEXT NOT NULL DEFAULT 'cover'");

  // **A copied Scene SHARES its backdrop rather than storing a second copy of
  // it (decided, new).** Self-referential: a copy holds NULL `image_data` and
  // points at whichever Scene actually owns the bytes, keeping its own
  // `image_hash`/`image_mime_type`/crop so its URL is the owner's id plus the
  // same content hash — one row of bytes in the database, one cached fetch in
  // the browser, however many copies exist.
  //
  // Backdrops are the largest thing this schema stores (see the whole Hosting
  // cost section: they *are* the 6GB), so duplicating them per copy is the one
  // thing this feature must not do.
  //
  // **Always points at the OWNER, never at another copy.** `scene:copy`
  // resolves `source.image_source_id ?? source.id`, so copying a copy still
  // points one hop at the bytes and no chain can form to walk or to break.
  // `ON DELETE SET NULL` is the backstop only — `scene:delete` promotes the
  // bytes to a dependent first, so a deleted original never blanks its copies.
  await ensureColumn('scenes', 'image_source_id', 'INTEGER REFERENCES scenes(id) ON DELETE SET NULL');

  // **Which view the Scene is in (Panic at the Dojo, decided).** 'scene' is
  // the stage as it always was; 'simple' adds Simple Combat's ten-space lane;
  // 'combat' is the grid map. Per Scene, so each Scene remembers its own mode,
  // and switched by the GM alone.
  await ensureColumn('scenes', 'combat_mode', "TEXT NOT NULL DEFAULT 'scene'");
  // The Cinematic Weight of each of the Scene's two fights (WEIGHTS keys), or
  // NULL until the GM presets one.
  await ensureColumn('scenes', 'simple_weight', 'TEXT');
  await ensureColumn('scenes', 'combat_weight', 'TEXT');
  // **The Combat map (Phase 3):** a Combat Background separate from the Scene
  // backdrop (image kind 'scene-combat'), and its grid — square size and
  // offset in the MAP IMAGE's own pixels (decided), and line opacity. See
  // client/src/lib/combatGrid.js.
  await ensureColumn('scenes', 'combat_image_data', 'TEXT');
  await ensureColumn('scenes', 'combat_image_mime_type', 'TEXT');
  await ensureColumn('scenes', 'combat_image_hash', 'TEXT');
  await ensureColumn('scenes', 'grid_size', 'INTEGER NOT NULL DEFAULT 70');
  await ensureColumn('scenes', 'grid_offset_x', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('scenes', 'grid_offset_y', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('scenes', 'grid_opacity', 'REAL NOT NULL DEFAULT 0.6');

  // Singleton: which Scene is currently active, same shape as combat_state's
  // own id=1 row.
  ddl(`
    CREATE TABLE IF NOT EXISTS scene_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_scene_id INTEGER REFERENCES scenes(id) ON DELETE SET NULL
    )
  `);
  ddl(`INSERT OR IGNORE INTO scene_state (id, active_scene_id) VALUES (1, NULL)`);

  // Scene Pictures: owned by exactly one of a Character or a Temp NPC — the
  // same discriminator relationship_nodes uses for character_id/person_id.
  // Both FKs CASCADE, deliberately UNLIKE relationship_nodes.character_id
  // (which carries no ON DELETE at all, forcing an explicit app-level
  // conversion before a character can be deleted): a scene_pictures row has
  // no cross-owner reference to preserve, so there is nothing worth saving
  // across the owner's own deletion — CASCADE says exactly that.
  ddl(`
    CREATE TABLE IF NOT EXISTS scene_pictures (
      id INTEGER PRIMARY KEY,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      temp_npc_id INTEGER REFERENCES temp_npcs(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      image_data TEXT NOT NULL,
      image_mime_type TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK ((character_id IS NULL) <> (temp_npc_id IS NULL))
    )
  `);

  // The stage roster: who is currently summoned. **Scene-specific (decided,
  // revised).** This table originally had no `scene_id` at all, on the
  // reasoning that a summon should follow you between backgrounds — that
  // was reversed on the table's own request: without a Scene-scoped roster
  // there was no way to prepare a Scene's cast and layout in advance
  // without it bleeding into whichever Scene was actually live. `scene_id`
  // is therefore NOT NULL, and the UNIQUEs are now per-Scene
  // (`UNIQUE(scene_id, character_id)`) rather than table-wide — the same
  // character can be independently prepared into more than one Scene at
  // once, each with its own side/position/scale, which is exactly what
  // "prepare in advance" means in practice.
  ddl(`
    CREATE TABLE IF NOT EXISTS scene_summons (
      id INTEGER PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      temp_npc_id INTEGER REFERENCES temp_npcs(id) ON DELETE CASCADE,
      scene_picture_id INTEGER NOT NULL REFERENCES scene_pictures(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK(side IN ('left','right')),
      pos_x REAL,
      pos_y REAL,
      scale REAL NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK ((character_id IS NULL) <> (temp_npc_id IS NULL)),
      -- SQLite treats NULLs as distinct under UNIQUE, so this correctly
      -- means "one seat per character (or per temp_npc) PER SCENE" rather
      -- than "one NULL-character_id row per Scene" — the same trick
      -- combat_participants relies on for its own per-character uniqueness
      -- elsewhere.
      UNIQUE(scene_id, character_id),
      UNIQUE(scene_id, temp_npc_id)
    )
  `);
  await migrateSceneSummonsSceneId();
  // **Manual drag-to-place and resize (decided, new).** `pos_x`/`pos_y` are
  // fractions (0..1) of the viewer's own measured stage box, NULL meaning
  // "never manually placed — still governed by layoutStage.js's automatic
  // cramming." A fraction of each viewer's own stage, not a raw world pixel
  // (contrast relationship_nodes.x/y above, which ARE raw pixels): the Scene
  // stage has no pan/zoom camera the way the Relationships board does, and
  // is already viewed at whatever size each device's own screen happens to
  // be, so a fraction is what keeps a drag looking right on every screen.
  // `scale` is a per-summon size multiplier, independent of position — a
  // figure can be resized without ever leaving the automatic layout, so it
  // is NOT NULL (unlike pos_x/pos_y, "never resized" and "resized back to
  // 1x" are the same state).
  await ensureColumn('scene_summons', 'pos_x', 'REAL');
  await ensureColumn('scene_summons', 'pos_y', 'REAL');
  await ensureColumn('scene_summons', 'scale', 'REAL NOT NULL DEFAULT 1');
  // **Hidden (decided, new).** GM-only toggle, no schema split needed the
  // way scene_notes required one — this is a per-summon flag, not a
  // separate secret document, so a plain column plus per-viewer filtering
  // of the SAME stage payload (server/index.js: buildStagePayload/
  // stagePayloadFor) is enough. A hidden summon is still fully present and
  // editable for the GM (rendered at reduced opacity — see StageRoster.jsx)
  // but is dropped from the payload entirely for every non-GM viewer,
  // including the character's own Player — "not leaving any trace behind"
  // is read literally: this is a GM narrative tool, not a Player-facing
  // stealth mechanic the owning Player gets to see through.
  await ensureColumn('scene_summons', 'is_hidden', 'INTEGER NOT NULL DEFAULT 0');
  // **Simple Combat: the lane space (0-9) this summon stands in.** NULL until
  // someone moves a miniature; until then the stage payload packs everyone
  // from the left (packLane in client/src/lib/simpleLane.js), so a new summon
  // finds a space by itself.
  await ensureColumn('scene_summons', 'lane_slot', 'INTEGER');
  // ---------------------------------------------------------------------

  // GM Notes (decided, new). Two shapes, one dialog:
  //   - **scene_notes**: any number per Scene, each pinned to exactly one
  //     (the `scene_id` FK is NOT NULL — unlike scene_summons, which is
  //     deliberately scene-independent, a Note's whole point here is to
  //     belong to a specific Scene).
  //   - **master_note**: a singleton, same `id=1` CHECK shape as
  //     scene_state/combat_state above — one Note in the whole world,
  //     reachable from any Scene's own Notes dialog via a switch, for
  //     campaign-wide planning that isn't about any one Scene.
  // **Genuinely GM-secret, not just GM-managed (decided).** Unlike the rest
  // of this feature's own authoring content (Temp NPCs, Scenes — open REST,
  // just not rendered for a Player), these are read behind the same
  // `viewerFromQuery` 403 gate `/api/characters/:id/relationships` uses, and
  // every broadcast goes only to GM-identified sockets (see emitToGm) —
  // campaign notes are exactly the kind of spoiler-bearing text a GM does
  // not want a technically-curious Player fetching straight off the API.
  ddl(`
    CREATE TABLE IF NOT EXISTS scene_notes (
      id INTEGER PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ddl(`
    CREATE TABLE IF NOT EXISTS master_note (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      body TEXT NOT NULL DEFAULT ''
    )
  `);
  ddl(`INSERT OR IGNORE INTO master_note (id, body) VALUES (1, '')`);
  // ---------------------------------------------------------------------

  // **Scene drawings (decided, new).** A shared pen/eraser annotation layer
  // over the stage — the opposite trust model from GM Notes just above:
  // open to BOTH roles (a Player may draw and erase exactly like a GM), and
  // deliberately carries no author column at all, per the feature's own
  // requirement ("do not keep info about who drew something, it is just a
  // drawing for everybody"). `points` is a JSON-encoded array of `[x, y]
  // pairs, fractions (0..1) of the drawer's own measured stage box at the
  // moment they drew — the exact same reasoning as scene_summons.pos_x/
  // pos_y above (no shared camera, so a fraction is what looks right on
  // every viewer's own screen). `width` is ALSO a fraction, of the stage's
  // own width specifically, for the same reason a raw pixel width would
  // render inconsistently thick or thin across differently-sized screens.
  // `color` is meaningless for an eraser stroke but stored anyway rather
  // than made nullable — one less branch everywhere a row is read, and the
  // column is never rendered with when `is_eraser` is set. An eraser
  // stroke is not represented as a deletion or a geometric clip against
  // earlier strokes — it is stored as an ordinary stroke row, and every
  // client composites it with `globalCompositeOperation: 'destination-out'`
  // instead of `'source-over'` when replaying (StageRoster's sibling
  // component SceneDrawingLayer.jsx) — the ordering IS the eraser: it only
  // ever erases whatever was drawn before it in `id` order, never anything
  // drawn after, which is exactly what a person watching an eraser pass
  // over a page would expect. `scene_id` is NOT NULL and CASCADEs off its
  // Scene, same as scene_notes — a drawing belongs to exactly the Scene it
  // was made on and never follows the roster between Scenes the way a
  // summon briefly used to.
  ddl(`
    CREATE TABLE IF NOT EXISTS scene_drawings (
      id INTEGER PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      points TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#ef4444',
      width REAL NOT NULL DEFAULT 0.01,
      is_eraser INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // ---------------------------------------------------------------------

  // **Timestamps (decided, new; revised).** A GM-exclusive tool for
  // narrative time markers played as a table-wide beat: dims the Scene and
  // fades a chosen Date/subtext in, big and bold, then fades back out.
  // Deliberately GLOBAL, not `scene_id`-scoped the way scene_notes/
  // scene_drawings above are — a Timestamp is a moment in the CAMPAIGN's
  // own timeline, not an annotation belonging to one particular backdrop,
  // so a GM can play one from whichever Scene happens to be active. Same
  // "not about any one Scene" reasoning master_note above already uses,
  // just as its own ordinary multi-row table rather than a singleton —
  // there can be any number of these, unlike the one Master Note.
  // **Two different trust levels for the SAME row, split by verb.**
  // Managing them (create/edit/delete/list) is exactly as GM-secret as GM
  // Notes — emitToGm-only, never io.emit, and the REST read is behind the
  // same GM-only 403 gate (`/api/scene-timestamps`, server/index.js). But
  // PLAYING one is the opposite of a Note: the whole point is for the
  // WHOLE TABLE to see it, so `stage:timestamp_play` broadcasts via a
  // plain `io.emit`, carrying only the one played Timestamp's own display
  // fields (`date`/`subtext`) resolved server-side from `timestampId` — a
  // Player socket is never handed read access to the rest of the list, and
  // can't play an arbitrary id either (the handler still checks
  // `identity.role === 'gm'` before it will look one up at all).
  // **`date` is a real calendar date (decided, revised — was free text),
  // stored as an ISO `YYYY-MM-DD` string** (SQLite has no native DATE
  // type, and plain ISO text both sorts and compares correctly as-is,
  // exactly what `GET /api/scene-timestamps`'s own `ORDER BY date` below
  // relies on) — the exact string an `<input type="date">` already
  // produces/consumes, so the client needs no conversion either. `name`
  // stays a separate free-text field purely for finding an entry again in
  // the management grid; it is never shown when played. **`is_current`
  // (decided, new) marks at most ONE row "the Current Timestamp" — an
  // exclusivity the write side enforces (`scene_timestamp:set_current`,
  // server/index.js: clears every row's flag before setting the new one),
  // never left to the client to keep straight across two writes.
  ddl(`
    CREATE TABLE IF NOT EXISTS scene_timestamps (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      subtext TEXT NOT NULL DEFAULT '',
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // A table that already existed under the original (free-text `date_text`,
  // no `is_current`) shape gets these two added in place — `date_text`
  // itself is left standing, unused, rather than dropped: this codebase
  // never DROP COLUMNs an existing table, only adds (see this function's
  // own header/every other ensureColumn call for the same reasoning).
  await ensureColumn('scene_timestamps', 'date', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('scene_timestamps', 'is_current', 'INTEGER NOT NULL DEFAULT 0');

  // **A Scene may CUE a Timestamp: activating it plays that beat automatically
  // (decided, new).** The column lives on `scenes`, pointing AT a Timestamp —
  // never a `scene_id` on `scene_timestamps`, which would undo the deliberate
  // decision recorded above that a Timestamp is a moment in the CAMPAIGN's
  // timeline rather than an annotation on one backdrop. Pointing this way round
  // keeps that intact and costs nothing: the list stays flat and global, many
  // Scenes may cue the same moment, and a Scene that cues nothing is simply
  // NULL.
  //
  // Declared here rather than beside the other `scenes` columns because a
  // REFERENCES clause names a table that has to exist first, and
  // `scene_timestamps` is created immediately above. `ON DELETE SET NULL`
  // rather than CASCADE for the obvious reason: deleting a moment from the
  // timeline must not delete the Scene that happened to cue it.
  await ensureColumn(
    'scenes',
    'timestamp_id',
    'INTEGER REFERENCES scene_timestamps(id) ON DELETE SET NULL'
  );
  // ---------------------------------------------------------------------

  // Character-owned counters (Phase 5). character_id is nullable for the
  // standalone counters the Combat Arena once created; the Arena is gone, but
  // the column keeps accepting NULL so no existing row becomes invalid.
  // (The old `show_in_combat` flag only fed the Arena card and was dropped
  // with it — see OLD_COUNTER_COLUMNS.)
  ddl(`
    CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      target_pips INTEGER NOT NULL CHECK(target_pips BETWEEN 2 AND 20),
      current_pips INTEGER NOT NULL DEFAULT 0,
      -- Purely cosmetic tracking tag — no mechanical effect. Character-owned
      -- counters only (server rejects it for a standalone character_id=NULL
      -- counter). The value list is left exactly as it was, so a Counter
      -- already tagged with one of the old system's rewards stays valid.
      reward_type TEXT CHECK(reward_type IN ('story','statistic','perk','move','combat_prowess'))
    )
  `);
  // **A Gate is a marker on ONE pip of a Counter.** The GM writes on a point of
  // progress — *when this fills to here, something happens* — and the table sees
  // that something is coming without necessarily seeing what.
  //
  // `UNIQUE(counter_id, pip_index)` is the mechanic, not housekeeping: a Gate is
  // a property of a pip, and two on one pip would be two things to draw in one
  // place and two lines to post at one moment.
  //
  // `secret` decides only whether the NAME and DESCRIPTION reach a Player. That
  // a Gate exists is never hidden — the pip is drawn twice the size for
  // everybody — so the stripping happens on the two text columns alone (see
  // `visibleGate` in server/counterGates.js).
  ddl(`
    CREATE TABLE IF NOT EXISTS counter_gates (
      id INTEGER PRIMARY KEY,
      counter_id INTEGER NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
      pip_index INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      secret INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(counter_id, pip_index)
    )
  `);

  // ---------------------------------------------------------------- Panic at the Dojo
  //
  // **A fighter's combat setup — the sheet's Combat tab (decided, new).** One
  // row per Character or Temp NPC, owned by exactly one of them (the same
  // discriminator scene_pictures uses), created the first time anything is
  // saved. It holds the round combat-token picture (separate from the profile
  // picture and the Scene Pictures) and which Unique tokens this fighter uses,
  // as a JSON array of catalog keys (client/src/lib/panicTokens.js).
  //
  // Max HP and bar count are deliberately NOT here: they are set per placed
  // token, so three copies of one Temp NPC can differ.
  ddl(`
    CREATE TABLE IF NOT EXISTS combat_profiles (
      id INTEGER PRIMARY KEY,
      character_id INTEGER UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
      temp_npc_id INTEGER UNIQUE REFERENCES temp_npcs(id) ON DELETE CASCADE,
      image_data TEXT,
      image_mime_type TEXT,
      image_hash TEXT,
      crop_x REAL,
      crop_y REAL,
      crop_w REAL,
      crop_h REAL,
      unique_tokens TEXT NOT NULL DEFAULT '[]',
      CHECK ((character_id IS NULL) <> (temp_npc_id IS NULL))
    )
  `);
  // Armor sources (decided, new): JSON ['always' | stanceId, ...] — see
  // panicTokens.js normalizeArmorSources.
  await ensureColumn('combat_profiles', 'armor_sources', "TEXT NOT NULL DEFAULT '[]'");

  // **Stances (decided after scoping).** A fighter's named dice pools: `dice`
  // is a JSON array of 1-8 slots, each `{ die: 4..12 }` or `{ fixed: 0..12 }`
  // (client/src/lib/stanceDice.js). Which one is ACTIVE belongs to each placed
  // copy in a fight, not here.
  ddl(`
    CREATE TABLE IF NOT EXISTS combat_stances (
      id INTEGER PRIMARY KEY,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      temp_npc_id INTEGER REFERENCES temp_npcs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      dice TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK ((character_id IS NULL) <> (temp_npc_id IS NULL))
    )
  `);

  // **Reminders: chat lines a fighter's player writes to remember a mechanic.**
  // `scope` is the column they sit in on the Combat tab — this fighter's own
  // turn, someone else's turn, or the round — and `timing` whether they fire at
  // its start or end. For `others`, `target` narrows whose turns: anyone, this
  // fighter's allies, its enemies, or one named fighter (`target_character_id`
  // or `target_temp_npc_id`). Sides come from Start Combat.
  ddl(`
    CREATE TABLE IF NOT EXISTS combat_reminders (
      id INTEGER PRIMARY KEY,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      temp_npc_id INTEGER REFERENCES temp_npcs(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK(scope IN ('self','others','round')),
      timing TEXT NOT NULL CHECK(timing IN ('start','end')),
      target TEXT NOT NULL DEFAULT 'any' CHECK(target IN ('any','allies','enemies','one')),
      target_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      target_temp_npc_id INTEGER REFERENCES temp_npcs(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK ((character_id IS NULL) <> (temp_npc_id IS NULL))
    )
  `);
  // Optional: a reminder bound to one of its owner's Stances fires only while
  // that Stance is active. Deleting the Stance unbinds it, keeping the text.
  await ensureColumn('combat_reminders', 'stance_id', 'INTEGER REFERENCES combat_stances(id) ON DELETE SET NULL');

  // **A fighter in a fight (Panic at the Dojo).** One placed copy of a
  // Character or Temp NPC on a Scene, in one of the two separate fights
  // (decided): 'combat' rows stand on the map at a grid cell; 'simple' rows
  // (Phase 4) belong to a Simple Combat summon. Every copy is independent —
  // HP, tokens and the Challenge (Phase 4) live on this row, not on the actor.
  ddl(`
    CREATE TABLE IF NOT EXISTS combatants (
      id INTEGER PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('simple','combat')),
      summon_id INTEGER REFERENCES scene_summons(id) ON DELETE CASCADE,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      temp_npc_id INTEGER REFERENCES temp_npcs(id) ON DELETE CASCADE,
      grid_col INTEGER,
      grid_row INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK ((character_id IS NULL) <> (temp_npc_id IS NULL))
    )
  `);
  // Phase 4 — the fighter's state (server/combatState.js, client/src/lib/
  // hpBars.js): Panic token counts as JSON {key: n}, the Challenge it holds
  // (another combatant in the same fight), the HP bar stack, Dizzy, and the
  // active Stance (NULL = the owner's first).
  await ensureColumn('combatants', 'tokens', "TEXT NOT NULL DEFAULT '{}'");
  await ensureColumn('combatants', 'challenge_id', 'INTEGER');
  await ensureColumn('combatants', 'hp_max', 'INTEGER');
  await ensureColumn('combatants', 'hp_current', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combatants', 'hp_bars', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('combatants', 'hp_broken', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combatants', 'dizzy', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combatants', 'active_stance_id', 'INTEGER');
  // The active Stance as a derived Stance's key ("form.x+style.y", builder
  // phase 2); active_stance_id is the purged hand-made Stances' leftover.
  await ensureColumn('combatants', 'active_stance_key', 'TEXT');
  // Cinematic Weight preset (client/src/lib/cinematicWeight.js): this copy's
  // level and level table ('hero' | 'warrior'), and the round it last Bled in
  // (Bleeding happens once per Round).
  await ensureColumn('combatants', 'level', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('combatants', 'fighter_kind', 'TEXT');
  await ensureColumn('combatants', 'bled_round', 'INTEGER');
  // A Frantic Hero's pick this turn { formId, styleId, abilityId } (builder phase 4).
  await ensureColumn('combatants', 'frantic_pick', 'TEXT');
  // A Simple Combat fighter is created on its first change, keyed by its
  // summon: at most one row per summon, so INSERT OR IGNORE is race-free.
  ddl('CREATE UNIQUE INDEX IF NOT EXISTS idx_combatants_summon_unique ON combatants(summon_id) WHERE summon_id IS NOT NULL');

  // Character builds (server/builds.js, client/src/lib/patd/build.js): the
  // player's choices as JSON, one row per character.
  ddl(`
    CREATE TABLE IF NOT EXISTS character_builds (
      character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // The turn's dice board (server/diceMarks.js): per Stance roll, which dice
  // are crossed out and which Action each was laid on. Purely visual.
  ddl(`
    CREATE TABLE IF NOT EXISTS dice_marks (
      roll_id TEXT PRIMARY KEY,
      combatant_id INTEGER,
      character_id INTEGER,
      dice INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Snapshots before each committed Action (server/engine/snapshots.js), so
  // the GM can retrieve its die and undo it (full automation, phase B).
  ddl(`
    CREATE TABLE IF NOT EXISTS fight_snapshots (
      id INTEGER PRIMARY KEY,
      fight_id INTEGER NOT NULL,
      roll_id TEXT,
      placement_key TEXT,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Homebrew content (server/homebrew.js, client/src/lib/patd/homebrew.js):
  // the GM's own Forms, Styles and Archetypes, one cleaned item per row.
  ddl(`
    CREATE TABLE IF NOT EXISTS homebrew (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Map tiles (server/mapTiles.js, client/src/lib/mapTiles.js): one row per
  // tile kind on a square of a Scene's Combat map (grid cell) or Simple Combat
  // lane (col = lane space, row = 0).
  ddl(`
    CREATE TABLE IF NOT EXISTS map_tiles (
      id INTEGER PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('simple','combat')),
      col INTEGER NOT NULL,
      row INTEGER NOT NULL,
      kind TEXT NOT NULL
    )
  `);
  ddl('CREATE INDEX IF NOT EXISTS idx_map_tiles_scene ON map_tiles(scene_id, mode, col, row)');

  // **A fight (Panic at the Dojo, Phase 5)** — one per Scene per mode. The
  // sides are JSON arrays of combatant ids; `turn_order` is this round's
  // [{ side, id }] (client/src/lib/initiative.js); `pending_stance_combatant`
  // is set while a fighter with several Stances is choosing one at the start
  // of their turn. See server/fights.js.
  ddl(`
    CREATE TABLE IF NOT EXISTS fights (
      id INTEGER PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('simple','combat')),
      allies TEXT NOT NULL DEFAULT '[]',
      enemies TEXT NOT NULL DEFAULT '[]',
      round INTEGER NOT NULL DEFAULT 1,
      turn_order TEXT NOT NULL DEFAULT '[]',
      turn_index INTEGER NOT NULL DEFAULT 0,
      pending_stance_combatant INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(scene_id, mode)
    )
  `);
  // The previous round's order, so "Previous turn" can step back into it.
  await ensureColumn('fights', 'prev_turn_order', 'TEXT');
  // The engine's runtime for this fight (client/src/lib/patd/engine/runtime.js): JSON.
  await ensureColumn('fights', 'runtime', 'TEXT');
  // Early / Late Movement in progress (full automation phase D): JSON or NULL.
  await ensureColumn('fights', 'movement_phase', 'TEXT');
  // A Copy's Original (full automation phase E): map_tiles of kind 'copy'.
  await ensureColumn('map_tiles', 'owner_id', 'INTEGER');
  // An open reaction window (full automation phase F): JSON or NULL.
  await ensureColumn('fights', 'reaction_window', 'TEXT');

  // **Table-wide settings the GM sets for everyone** (Settings page). A
  // singleton, like scene_state. `simple_lanes`: how many lanes Simple
  // Combat has (1-3) — shared, because lane positions are shared.
  ddl(`
    CREATE TABLE IF NOT EXISTS table_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      simple_lanes INTEGER NOT NULL DEFAULT 1
    )
  `);
  ddl('INSERT OR IGNORE INTO table_settings (id) VALUES (1)');
  // The lanes' vertical position, a share of the stage height (NULL = 5/7).
  await ensureColumn('table_settings', 'lane_y', 'REAL');

  // ---------------------------------------------------------------- Audio Player
  //
  // **The GM Tools drawer's third tool (decided, new).** A GM-run soundtrack
  // that every connected client hears in sync, wherever in the app they are.
  //
  // **Tracks are YouTube LINKS, never uploaded audio.** Every other piece of
  // media in this schema is base64 in a TEXT column (portraits, backdrops,
  // scene pictures), and that is exactly what must not happen here: a song is
  // three orders of magnitude larger than a portrait, `express.json` caps a
  // request at 3mb and Socket.io at 8mb, and the whole point of the feature is
  // background music for a session, not a media library. So the database
  // stores an 11-character video id and YouTube does the serving.
  ddl(`
    CREATE TABLE IF NOT EXISTS audio_playlists (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // **A track cannot exist without a playlist (decided).** The NOT NULL FK plus
  // ON DELETE CASCADE is the entire enforcement — there is no "loose songs"
  // state to design a UI around, and deleting a playlist takes its songs with
  // it. `sort_order` follows `moves.sort_order`, this schema's only other
  // hand-ordered list: read as `ORDER BY sort_order, id` so a playlist nobody
  // has reordered (all zeroes) still comes back in creation order.
  ddl(`
    CREATE TABLE IF NOT EXISTS audio_tracks (
      id INTEGER PRIMARY KEY,
      playlist_id INTEGER NOT NULL REFERENCES audio_playlists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      youtube_id TEXT NOT NULL,  -- the 11-char video id, parsed out of whatever URL was pasted
      duration_ms INTEGER,       -- NULL until a client reports it: only YouTube knows a video's length
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // **The one row that says what the table is listening to** — a singleton with
  // the same `id = 1` CHECK shape as master_note above.
  //
  // **It stores an ANCHOR, not a position.** A stored position would be stale
  // the millisecond after it was written and would need a ticking loop to keep
  // current; this app has no such loop and does not want one. An anchor —
  // "`position_ms` into the track, as of server instant `anchored_at_ms`" —
  // stays true forever untouched, and every client derives its own live
  // position from it (see expectedPositionMs in server/audioSync.js). Paused is
  // the degenerate case that needs no clock at all: the anchor IS the position.
  //
  // `anchor_id` is bumped on every single state change. It is what lets the
  // server ignore N clients all reporting the same track ending, and what lets
  // a client notice its own state is stale.
  ddl(`
    CREATE TABLE IF NOT EXISTS audio_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      track_id INTEGER REFERENCES audio_tracks(id) ON DELETE SET NULL,
      is_playing INTEGER NOT NULL DEFAULT 0,
      position_ms INTEGER NOT NULL DEFAULT 0,
      anchored_at_ms INTEGER NOT NULL DEFAULT 0,
      anchor_id INTEGER NOT NULL DEFAULT 0,
      repeat_mode TEXT NOT NULL DEFAULT 'playlist' CHECK(repeat_mode IN ('off','playlist','track')),
      shuffle INTEGER NOT NULL DEFAULT 0,
      shuffle_seed INTEGER NOT NULL DEFAULT 0
    )
  `);
  ddl(`INSERT OR IGNORE INTO audio_state (id) VALUES (1)`);
  // **Every boot comes up paused, deliberately.** Render's free tier cold-starts
  // between sessions constantly, and resuming an anchor taken six hours ago
  // would compute a position deep past the end of the track. What is worth
  // keeping across a restart is the GM's repeat/shuffle choice and which song
  // was queued; playback itself is not.
  ddl(`UPDATE audio_state SET is_playing = 0 WHERE is_playing != 0`);

  await ensureImageHashColumns();

  await ensureIndexes();

  // Everything above only queued; send it in one trip. (There used to be world
  // seeds here — Perks, Tags, Tells, the Styles — whose reads drained most of
  // the queue early. They went with the old system.)
  await flushDdl();
  ddlQueue = null;

  // After the queue is drained, so the columns exist to be written to.
  await backfillImageHashes();
}

// **Indexes on the foreign keys this app actually looks rows up by (decided,
// new).** The schema had none at all — every `WHERE character_id = ?` was a
// full table scan, and SQLite only indexes `INTEGER PRIMARY KEY` for free.
//
// Honest about the size of the win: most of these tables hold tens of rows,
// where a scan and a seek are indistinguishable, and a remote statement's cost
// is the trip rather than the scan. They are declared here rather than inside
// each CREATE TABLE so that adding one later needs no table rebuild, and they
// ride the same batch as the rest of the schema, so the whole set costs nothing
// extra at boot. (The old system's indexes went with its tables: dropping a
// table drops its indexes.)
async function ensureIndexes() {
  const indexes = [
    // Read once per character on the sheet.
    ['counters', 'character_id'],
    ['roleplay_entries', 'character_id'],
    ['audio_tracks', 'playlist_id'],
    // A board is read whole, by owner; and `character_id` is the lookup that
    // finds every node to convert when the GM deletes a world NPC.
    ['relationship_people', 'owner_character_id'],
    ['relationship_nodes', 'owner_character_id'],
    ['relationship_nodes', 'character_id'],
    ['relationship_edges', 'owner_character_id'],
    // Both ends, because deleting a node has to find every line touching it and
    // neither column can serve the other's lookup.
    ['relationship_edges', 'from_node_id'],
    ['relationship_edges', 'to_node_id'],
    // Every Counter render asks for its Gates.
    ['counter_gates', 'counter_id'],
    // The Scene tab's roster/library reads, by folder and by owner.
    ['temp_npcs', 'folder_id'],
    ['scenes', 'folder_id'],
    ['scene_pictures', 'character_id'],
    ['scene_pictures', 'temp_npc_id'],
    // The Notes dialog's own read, by whichever Scene is currently active.
    ['scene_notes', 'scene_id'],
    // The drawing layer's own read (buildStagePayload) and the eraser's
    // "clear everything on this Scene" sweep, both by active Scene.
    ['scene_drawings', 'scene_id'],
    // The Combat tab's own read, by owner.
    ['combat_reminders', 'character_id'],
    ['combat_reminders', 'temp_npc_id'],
    ['combat_stances', 'character_id'],
    ['combat_stances', 'temp_npc_id'],
    // The stage payload reads a Scene's fighters on every broadcast.
    ['combatants', 'scene_id'],
  ];
  for (const [table, column] of indexes) {
    ddl(`CREATE INDEX IF NOT EXISTS idx_${table}_${column} ON ${table}(${column})`);
  }
}

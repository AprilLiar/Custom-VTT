import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  all, one, run, readMany, writeMany, initDb,
  bootLog, connectDb, probePrimary, remoteMode, PROBE_TIMEOUT_MS, oldSystemPurge,
} from './db.js';
import { gateChatLine, gatesCrossed, isValidPip, visibleGates } from './counterGates.js';
import { DIE_SIZES, clamp, clampModifier, rollDie, rollTotal } from './gameLogic.js';
import { profile, profileReport, PROFILING } from './dbProfile.js';
import { parseYouTubeId, expectedPositionMs, nextTrackId } from './audioSync.js';
import {
  IMAGE_KINDS, imageSpec, imageUrl, hashImageData, servableMime, sanitizeImageMime,
  withImageUrl, shapeCharacter,
} from './images.js';
import { ORPHAN_SWEEPS, countOrphans, deleteOrphans, trimChatLog } from './cleanup.js';
import {
  registerCombatSetupHandlers, deleteCombatSetupFor, parseOwner, loadProfile, loadReminders, loadAllProfiles,
  loadStances, loadAllStances, purgeTempNpcCombat, purgeHandmadeCombatSetup,
} from './combatSetup.js';
import { TRAY, clampLaneY, clampLanes, laneCapacity, moveOnLane, packLane } from '../client/src/lib/simpleLane.js';
import { loadCombatTokens, registerCombatMapHandlers, sceneGrid } from './combatMap.js';
import { EMPTY_FIGHT_STATE, loadSimpleStates, registerCombatStateHandlers, releaseChallengesOf } from './combatState.js';
import { loadFightState, registerFightHandlers } from './fights.js';
import { loadMapTiles, registerMapTileHandlers } from './mapTiles.js';
import { deleteBuild, loadBuild, registerBuildHandlers } from './builds.js';
import { controlsCharacter, dropAssignmentsTo, loadAssignments, setAssignment } from './control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();

// **gzip everything (bandwidth).** The app went 60% over Render's included
// bandwidth, and nothing here was compressed at all. It matters more than it
// looks: this app's JSON is full of base64, and base64 gzips *well* even when
// the underlying bytes are already compressed, because it re-encodes 8-bit
// data into a 64-symbol alphabet with an obvious statistical structure. The
// built client bundle alone drops from ~968KB to under 300KB on every cold
// load. Mounted first so it wraps every route below, static assets included.
app.use(compression());

// **The port opens before the database does, and everything answers 503 until
// the database boot finishes (bugfix — Render deploys that timed out having
// printed nothing).**
//
// Booting talks to the Turso primary through a synchronous native call that
// cannot be interrupted (see `connectDb` in db.js). While it runs, this
// process serves nothing — and it used to not be listening either, so Render's
// port scan found nothing to scan, gave up, and killed the container before a
// single buffered log line was ever flushed. Listening first turns that silent
// timeout into an ordinary, readable startup: the port is open in milliseconds,
// the log says what boot is waiting on, and `/api/health` reports 503 until the
// database is genuinely ready, so Render's health check still refuses to call a
// half-booted deploy live.
//
// Socket.io is attached at the end of boot rather than here, so a client that
// connects during startup meets a plain HTTP 503 — a transport error the
// client's own reconnection loop retries automatically — instead of a live
// socket whose handlers would query tables that do not exist yet.
let bootState = 'starting';
let bootDetail = 'starting up';
app.use((_req, res, next) => {
  if (bootState === 'ready') return next();
  res
    .status(503)
    .set('Retry-After', '5')
    .type('text/plain')
    .send(`Dogfight is still starting up (${bootDetail}). Retry in a moment.`);
});

app.use(express.json({ limit: '3mb' })); // portraits arrive as base64 JSON
const httpServer = createServer(app);
// Exported so a future server/perkAutomations.js PERK_HOOKS entry can
// broadcast (die:updated/character:updated/etc.) after a manual effect.
// maxHttpBufferSize raised from Socket.io's 1MB default: chat GIFs are sent
// raw/unresized (to keep their animation) up to a 1MB client-side cap. The
// headroom above that is deliberate: it is what an upload is allowed to be,
// not what a broadcast carries — a picture goes out as a URL now (see
// server/images.js), so this ceiling only ever applies on the way IN.
// Constructed detached from httpServer on purpose; see the boot gate above.
// **perMessageDeflate is opt-IN (bandwidth).** Socket.io v4 turns WebSocket
// compression off by default, and the reason is memory: zlib keeps a context
// per connection, which at thousands of sockets is real. This app serves one
// table — a handful of sockets — while shipping JSON and base64, which is
// exactly the payload compression was invented for. `threshold` leaves the
// small deltas (die:updated, counter:updated) uncompressed, where the frame
// overhead would cost more than it saved.
export const io = new Server({
  maxHttpBufferSize: 8 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024 },
});

// ---------- shared lookups ----------

const getCharacter = (id) => one('SELECT * FROM characters WHERE id = ?', [id]);

// Mobile readiness (Change 002) §12: vitruvian_image_data is only ever read
// on a character's OWN Core Stats tab (CoreStatsTab.jsx, via a single-
// character getCharacter fetch) — never in a roster/list view. Any endpoint
// returning MULTIPLE characters at once strips it before responding, so a
// phone on a slow connection isn't downloading a full base64 backdrop image
// per character just to render name-and-portrait cards.
// **Stamp a freshly written picture with its cache key.**
//
// Done as a small step AFTER the write rather than folded into each of the
// sixteen INSERT/UPDATE statements that touch an image, and that is a
// deliberate trade: those statements have sixteen different column orders and
// parameter arrays, and threading one more value through each of them by hand
// is exactly the kind of edit that lands the hash in the crop column on the one
// site nobody re-read. This reads the row back and hashes what is actually
// there, so it cannot be wrong about which bytes it describes.
//
// The cost is one extra round trip per upload. Uploading a picture is a human
// action measured in seconds, and this happens once per picture rather than
// once per render, so it is not a trip worth folding away.
async function stampImageHash(kind, id) {
  const spec = imageSpec(kind);
  const rowId = Number(id);
  if (!spec || !Number.isInteger(rowId)) return;
  const row = await one(`SELECT ${spec.data} AS data FROM ${spec.table} WHERE id = ?`, [rowId]);
  // **A row that borrows its picture must keep the OWNER's hash.** A copied
  // Scene holds no bytes of its own (scenes.image_source_id), so hashing its
  // empty data column would overwrite the one value its URL is built from and
  // point it at a picture that does not exist. Only scenes can be in this
  // state; every other kind always owns what it shows.
  if (kind === 'scene' && row?.data == null) {
    const borrowed = await one('SELECT image_source_id FROM scenes WHERE id = ?', [rowId]);
    if (borrowed?.image_source_id != null) return;
  }
  await run(`UPDATE ${spec.table} SET ${spec.hash} = ? WHERE id = ?`, [hashImageData(row?.data), rowId]);
}

// `omitVitruvianArt` used to live here. It existed because the Tab 1 backdrop
// was too heavy to include in a list response, which made the single-character
// endpoint the only place it could come from. At ~60 bytes a URL it now rides
// everywhere, so `shapeCharacter` (server/images.js) replaces it outright
// rather than sitting beside it.

const getRoleplay = (characterId) =>
  all('SELECT * FROM roleplay_entries WHERE character_id = ? ORDER BY id', [characterId]);
const getCounters = (characterId) =>
  all('SELECT * FROM counters WHERE character_id = ? ORDER BY id', [characterId]);
// **Gates ride their own channel, not the Counter payload.** A Counter goes out
// with `io.emit` — everybody's Arena shows everybody's clocks — and a Gate can
// carry something only the GM may read. Rather than make five Counter
// broadcasts viewer-aware, Gates are pushed per socket on their own event and
// held separately by the client, the same shape the Relationships board uses.
//
// The whole list every time: there are a handful of Counters in a world and a
// few Gates on each, and a whole-list push cannot leave a client holding a Gate
// that has since moved.
const getAllGates = () => all('SELECT * FROM counter_gates ORDER BY counter_id, pip_index');

async function emitGates() {
  const gates = await getAllGates();
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data?.identity;
    if (!identity) continue;
    socket.emit('counter_gates:updated', { gates: visibleGates(gates, identity) });
  }
}

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC
const sqliteToIso = (ts) =>
  ts && !ts.includes('T') ? new Date(ts.replace(' ', 'T') + 'Z').toISOString() : ts;

// GET /api/combat has no socket to carry an identity, so the client sends
// it as query params instead — same shape as identity:set's payload.
function viewerFromQuery(query) {
  if (query?.role === 'gm') return { role: 'gm' };
  const characterId = Number(query?.characterId);
  if (query?.role === 'player' && Number.isInteger(characterId)) {
    return { role: 'player', characterId };
  }
  return null;
}


// Reasons to Fight and the Stance matchup both live in
// server/combatBonuses.js now — see getCombatRollBonus there for why they're
// summed in one place rather than added per call site.


// Combat Automation (Phase 9, sub-phase 3): a GM-authored system notice —
// "Block/Dodge has failed," "Partial Block — 1.5 damage," a Forfeit/
// Interruption Stamina-refund note, and so on (see the plan's 4.1-4.4). Same
// insertion shape chat:message already uses for a GM-posted row (posts as
// the GM_CHAT_SENTINEL_ID persona), just triggered by combat resolution
// instead of the compose box.

// Combat Automation (Phase 9, sub-phase 3): the shared clamp+update+
// broadcast a Stamina change already uses (see stamina:adjust below) —
// factored out so Forfeit's full refund (4.3) and Interruption's half
// refund (4.4) can reuse it instead of duplicating the clamp/broadcast
// logic. Returns the character's new current_stamina, or null if the
// character doesn't exist. `delta` can be negative (a cost), though every
// current caller only ever passes a positive refund.

// Combat Automation (Phase 9, sub-phase 5): actually executes a move's
// stored On Hit/Block/Miss/Successful Defense/Failed Defense automations
// (move_interactions.automations — self_recovery/opponent_recovery/
// self_stamina/opponent_stamina) once that trigger's outcome is decided,
// closing the plan's long-standing open item ("these are already fully
// modeled... but never actually fire"). `self`/`opponent` are resolved by
// each call site below to whichever character actually owns `moveId` for
// this firing and whoever's on the other side of it — see combat:apply_
// damage (hit), pool:roll/dice:roll_custom (miss), and combat:resolve_
// defense (block/defense_success/defense_failure) for exactly who plays
// which role at each trigger.
//
// **Recovery is applied to the clock, not to a row (decided, new).** An
// `opponent_recovery`/`self_recovery` no longer picks a declared move to
// bump a counter on; it asks what that character is doing at the Tic it
// fires on — winding up, mid-move, or between moves — puts the frames where
// that answer says they go, and slides everything they had declared after it
// that many Tics later. `planImposedRecovery` in server/combatTiming.js
// holds the whole rule, and `imposeRecovery` in server/roundResolution.js
// is the only caller. The old "whichever of their declared moves ends
// latest" fallback is gone with it: the question was never *which* move, and
// "between moves" is now a real answer rather than a missing one.
// opponent_recovery/opponent_stamina are still silently skipped if there is
// no opponent at all (declaredMoveId unresolvable).

// Combat Automation overhaul: fireMissIfNoDamage used to live here, firing
// a move's 'miss' trigger whenever its own reveal-time roll came back under
// 5. Both halves of that are gone. The trigger moved (a Miss is an attack
// evaded by a Dodge now, fired only from applySuccessfulDodge in
// server/roundResolution.js; a sub-5 roll is Insignificant Damage, which is
// a hit that did too little to matter and fires On Hit), and the path
// itself was already unreachable — every combat roll
// is server-computed by the engine, so no client roll has carried a
// declaredMoveId since the overhaul.

// ---------- REST API ----------

// Express 4 doesn't catch async route errors — without this a DB hiccup
// would crash the whole server.
// The message rides along with the 500 (decided, new).
//
// It used to be a flat `internal error`, which meant a failing endpoint told
// nobody anything: the server log had the stack, but the log lives on Render
// and the person looking at the broken screen is usually not the person who can
// read it. That is exactly how an Arena that threw on every load presented as
// an infinite spinner with no way in — see the Arena's own error state.
//
// Nothing is leaked by this that the app does not already hand out: there is no
// auth here by design (see the plan), `/api/health` has always returned
// `err.message`, and every reader is a GM or a player at the same table.
// **Which region of an uploaded picture shows.** Four fractions of the
// picture's own width and height, and the one field on any of these tables that
// reaches a renderer as raw CSS — `client/src/lib/imageCrop.js` turns it into
// four percentages on an <img>. So it is validated rather than clamped: a NaN
// or a rectangle that leaves the picture would draw a thumbnail as an empty box
// with nothing logged anywhere.
//
// Anything that is not a real rectangle inside the picture is stored as four
// NULLs, which the client reads as "no crop" and renders with plain
// `object-fit: cover` — exactly what every picture uploaded before the crop
// editor existed still does.
//
// **Always written together with the image**, never on its own: a new picture
// means the old crop described a different photograph, so it goes.
const CROP_COLUMNS = 'crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?';

// A Scene's own backdrop-scaling mode (server: scenes.background_fit — see
// db.js's own comment on why this is per-Scene, not a per-viewer Settings
// slider). Never trust a client-sent value straight into a column read
// back out as CSS-affecting data — scene:update below falls back to
// whatever the Scene already had for anything outside this set.
const VALID_BACKGROUND_FITS = new Set(['cover', 'contain', 'fill', 'fit-height', 'fit-width']);

// The Scene page's three views (Panic at the Dojo) — see scenes.combat_mode.
const SCENE_MODES = new Set(['scene', 'simple', 'combat']);

// **How far outside the backdrop's own rectangle a summon may be placed
// (bugfix).** `scene_summons.pos_x`/`pos_y` are fractions of the BACKDROP
// IMAGE, and this used to clamp them to `[0, 1]` — "somewhere on the
// artwork", which sounds right and quietly broke dragging a figure DOWN on
// an ordinary Scene. A landscape backdrop in a landscape stage is scaled by
// `cover` until its own height matches the stage's exactly, so the image's
// bottom edge IS the stage's bottom edge — where an auto-placed figure
// already stands. Every downward drag therefore computed a fraction past
// the ceiling and was clamped back to where it started, while upward drags
// had the whole stage to move through; under Best Fit/`contain` (a new
// Scene's default) the letterboxed part of the stage was unreachable for
// the same reason. One whole image-dimension of slack past each edge is far
// more than a real placement needs while still bounding what a hand-sent
// event can store. Mirrored by POS_MIN/POS_MAX in
// client/src/components/StageRoster.jsx.
const SUMMON_POS_MIN = -1;
const SUMMON_POS_MAX = 2;

function cropValues(payload) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = num(payload?.cropX);
  const y = num(payload?.cropY);
  const w = num(payload?.cropW);
  const h = num(payload?.cropH);
  const slack = 1e-6;
  const ok =
    x !== null && y !== null && w !== null && h !== null &&
    w > 0 && h > 0 &&
    x >= -slack && y >= -slack && x + w <= 1 + slack && y + h <= 1 + slack;
  return ok ? [x, y, w, h] : [null, null, null, null];
}

const wrap = (fn) => (req, res) =>
  // Same pass-through profiling as the socket handlers — a REST read like
  // `GET /api/characters/:id` is exactly the kind of deep await-chain the
  // report is looking for. Labelled by route rather than by URL so twenty
  // character fetches aggregate into one row.
  profile(`${req.method} ${req.route?.path ?? req.path}`, () => fn(req, res)).catch((err) => {
    console.error(`error in ${req.method} ${req.path}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ? `internal error: ${err.message}` : 'internal error' });
    }
  });

// **Every stored picture, at a URL the browser can cache forever.**
//
// The change this route exists for: images used to travel as base64 `data:`
// URIs inside JSON, which the browser cache cannot touch — so every portrait
// was re-downloaded on every page load and every phone unlock, and the scene
// backdrop rode along on every drag and every pen stroke. Behind a URL keyed by
// content hash, each picture is fetched once and never again.
//
// **One route rather than ten.** `kind` is a KEY into a frozen registry, never
// a fragment spliced into SQL: an unknown kind is a 404 before a query is built,
// and the only identifiers that reach the statement are the ones written out in
// server/images.js. Ten near-identical handlers would be ten places for the
// cache headers to drift apart.
//
// **The three security headers are not decoration.** As inert `data:` URIs
// these bytes were harmless; served from our own origin, the stored
// `image_mime_type` becomes a content type the browser obeys — and this app has
// no auth by design, so anyone with the link can upload. `servableMime` is the
// real defence (an allow-list, applied on the way in as well); nosniff and the
// null CSP are there for whatever it fails to imagine.
app.get('/api/img/:kind/:id/:hash', wrap(async (req, res) => {
  const spec = imageSpec(req.params.kind);
  const id = Number(req.params.id);
  if (!spec || !Number.isInteger(id) || id < 1) return res.status(404).end();

  const row = await one(
    `SELECT ${spec.data} AS data, ${spec.mime} AS mime, ${spec.hash} AS hash FROM ${spec.table} WHERE id = ?`,
    [id]
  );
  if (!row?.data) return res.status(404).end();

  // **`immutable` only where the URL is actually telling the truth**, and the
  // truth is recomputed here rather than read out of the column.
  //
  // The stored `image_hash` is an optimisation — it lets the hot paths select a
  // cache key without dragging the bytes into the process — but trusting it
  // here would make a stale one dangerous: a write that updated the picture and
  // missed the hash would still satisfy `req.params.hash === row.hash`, and a
  // year-long cache entry would be pinned to bytes that have moved on. Hashing
  // what we are actually about to send makes that unrepresentable: a stale
  // stored hash can then only ever produce a URL that fails to match, which is
  // served correctly and simply not cached. sha256 over a picture is
  // microseconds, and a given client fetches a given URL at most once, ever.
  const trueHash = hashImageData(row.data);
  const exact = req.params.hash === trueHash;
  res.set('Cache-Control', exact ? 'public, max-age=31536000, immutable' : 'no-store');
  res.type(servableMime(row.mime));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");

  // An ETag buys nothing while `immutable` holds — the browser will not ask —
  // but a hard reload revalidates, and answering 304 there turns a GM's
  // habitual force-refresh from "re-download every picture" into a handful of
  // empty responses.
  if (exact) {
    res.set('ETag', `"${trueHash}"`);
    if (req.fresh) return res.status(304).end();
  }

  const buffer = Buffer.from(row.data, 'base64');
  res.set('Content-Length', String(buffer.length));
  return res.end(buffer);
}));

app.get('/api/health', async (_req, res) => {
  try {
    const started = Date.now();
    await run('SELECT 1');
    // `readMs` is the one number that cannot be reproduced locally: it is a
    // real round trip to Turso from inside Render, which is what every
    // statement in every handler now pays (see the note at the top of db.js for
    // why the embedded replica that used to make it free is gone). Multiply it
    // by an action's chain depth to predict how that action feels.
    res.json({
      ok: true,
      db: 'connected',
      mode: remoteMode ? 'remote' : 'local-file',
      readMs: Date.now() - started,
    });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'error', message: err.message });
  }
});

// **Stances ride along (decided, new).** The Compendium needs every
// character's stances to decide which styled moves each of them could ever
// learn, and its only way to get them was to fetch a whole character sheet per
// character — `getCharacter(c.id)` in a loop, 24 queries each, re-run on every
// one of the twenty events it listened to. Two queries here replace all of
// that, and nothing else on this endpoint changes: `stances` is additive, so
// callers that only want the flat roster are untouched.
app.get('/api/characters', wrap(async (_req, res) => {
  const characters = await all('SELECT * FROM characters ORDER BY id');
  res.json(characters.map(shapeCharacter));
}));

// **The Relationships board, read whole.**
//
// Deliberately its own endpoint rather than one more key on
// GET /api/characters/:id. That payload is refetched by roughly twenty
// unrelated socket events — every Stamina tick among them — and a board carries
// base64 pictures for its board-local people. Folding it in would drag all of
// that along on every one of those refetches, for a tab most of them have
// nothing to do with.
async function getRelationshipBoard(ownerCharacterId) {
  const [people, nodes, edges] = await readMany([
    ['SELECT * FROM relationship_people WHERE owner_character_id = ? ORDER BY id', [ownerCharacterId]],
    ['SELECT * FROM relationship_nodes WHERE owner_character_id = ? ORDER BY id', [ownerCharacterId]],
    ['SELECT * FROM relationship_edges WHERE owner_character_id = ? ORDER BY id', [ownerCharacterId]],
  ]);
  // The board's own people carry portraits; shaped here so the REST read and
  // the emitRelationships broadcast can never disagree about the format.
  return { people: people.map(withImageUrl('person')), nodes, edges };
}

// ---------------------------------------------------------------------------
// Undo — the last three states of a board
// ---------------------------------------------------------------------------
//
// **Whole snapshots, on the server, rather than inverse commands on the client.**
// An inverse works fine for a move or a colour, and falls apart on a delete:
// undoing one has to bring a row back with the SAME id, or every relationship
// that pointed at it now points at nothing. Re-inserting by id is something only
// the writer can do, so the writer is where undo lives — and it also means the
// GM and the owner, who edit the same board, share one history rather than
// holding two that disagree.
//
// Three deep, as asked. In memory only: an undo stack is a working convenience
// for the session you are in, not a record of the game, and one that survived a
// restart would let somebody reach back past a night's play.
//
// Keyed by owner, so one player's undo can never touch another's board.
const UNDO_DEPTH = 3;
const undoStacks = new Map(); // ownerCharacterId -> snapshot[] (oldest first)

// Take a snapshot of a board as it is RIGHT NOW. Called before a write, so the
// top of the stack is always the state to return to.
async function pushUndo(ownerCharacterId) {
  const id = Number(ownerCharacterId);
  if (!Number.isInteger(id)) return;
  const snapshot = await getRelationshipBoard(id);
  const stack = undoStacks.get(id) ?? [];
  stack.push(snapshot);
  // Oldest out first: three is the window the table asked for, and an unbounded
  // stack of boards carrying base64 portraits is a memory leak with a nice name.
  while (stack.length > UNDO_DEPTH) stack.shift();
  undoStacks.set(id, stack);
}

// Put a board back exactly as it was: clear the three tables for this owner and
// re-insert every row with its original id. Explicit column lists rather than a
// row spread, so a future column added to one of these tables fails loudly here
// instead of being silently dropped on the first undo.
async function restoreBoard(ownerCharacterId, snapshot) {
  const id = Number(ownerCharacterId);
  await run('DELETE FROM relationship_edges WHERE owner_character_id = ?', [id]);
  await run('DELETE FROM relationship_nodes WHERE owner_character_id = ?', [id]);
  await run('DELETE FROM relationship_people WHERE owner_character_id = ?', [id]);
  // People first, then nodes, then edges — the order the references run in, so
  // the database never sees a row pointing at one that is not back yet.
  for (const p of snapshot.people) {
    await run(
      `INSERT INTO relationship_people (id, owner_character_id, name, image_data, image_mime_type, created_at, crop_x, crop_y, crop_w, crop_h)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, id, p.name, p.image_data, p.image_mime_type, p.created_at, p.crop_x, p.crop_y, p.crop_w, p.crop_h]
    );
  }
  for (const n of snapshot.nodes) {
    await run(
      `INSERT INTO relationship_nodes (id, owner_character_id, character_id, person_id, x, y, nickname, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [n.id, id, n.character_id, n.person_id, n.x, n.y, n.nickname, n.notes, n.created_at]
    );
  }
  for (const e of snapshot.edges) {
    await run(
      `INSERT INTO relationship_edges (id, owner_character_id, from_node_id, from_side, from_x, from_y,
        to_node_id, to_side, to_x, to_y, label, color, arrow, retired, created_at, bend, bend_u)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, id, e.from_node_id, e.from_side, e.from_x, e.from_y, e.to_node_id, e.to_side, e.to_x, e.to_y,
        e.label, e.color, e.arrow, e.retired, e.created_at, e.bend, e.bend_u]
    );
  }
}

// How many steps back this board can go, so the client can grey its own control
// rather than firing into an empty stack to find out.
const undoDepthFor = (ownerCharacterId) => undoStacks.get(Number(ownerCharacterId))?.length ?? 0;

// Who may read or write one board: its owner, or the GM. The GM edits rather
// than merely watches (decided) — useful for setting a new player up with a
// starting web — so there is one predicate, not two.
function maySeeBoard(viewer, ownerCharacterId) {
  if (!viewer) return false;
  if (viewer.role === 'gm') return true;
  return controlsCharacter(viewer, ownerCharacterId);
}

// Who may write a Scene Picture for a given owner (Scene tab plan, Phase 3).
// Mirrors maySeeBoard's shape — the GM always may, a Player only for their
// own character — plus the split a relationship board never needed: nobody
// plays a Temp NPC, so a temp_npc owner is GM-only regardless of viewer.
function mayWriteScenePicture(viewer, ownerType, ownerId) {
  if (!viewer) return false;
  if (viewer.role === 'gm') return true;
  // A character the Player controls: their own PC, or an NPC assigned to them.
  return ownerType === 'character' && controlsCharacter(viewer, ownerId);
}

// The live stage everyone shares (Scene tab plan, Phase 4): which Scene is
// active right now, who's summoned onto it, and what's been drawn on it.
// **Unfiltered** — includes every summon's `is_hidden` flag and every
// stroke, regardless of viewer. Never sent to a socket directly; always go
// through `stagePayloadFor` first (mirrors buildCombatUpdate/
// combatUpdateFor's own split, for the identical reason: one query per
// change, one cheap per-viewer redaction per socket, rather than
// re-querying per viewer).
// snake_case throughout, matching activeScene above and every other row
// this feature reads verbatim off the DB (scene_pictures, temp_npcs, …) —
// only outbound WRITE payloads (stage:summon's own emit target) use
// camelCase in this app's convention. character_id/temp_npc_id decide
// ownership client-side the same way scene_pictures' own rows do.
async function buildStagePayload() {
  const state = await one('SELECT active_scene_id FROM scene_state WHERE id = 1');
  // **Hash and a presence flag, never the bytes (bandwidth).** The backdrop is
  // the biggest single row in this payload, and this payload is emitted PER
  // SOCKET from thirteen call sites — every drag, every resize, every summon.
  // Selecting `image_hash` instead of `image_data` is most of why a stage
  // broadcast went from hundreds of kilobytes to hundreds of bytes.
  const sceneRow = state?.active_scene_id
    ? await one(
        `SELECT id, name, image_hash, image_source_id,
                (image_data IS NOT NULL) AS has_image, background_fit, combat_mode,
                combat_image_hash, (combat_image_data IS NOT NULL) AS has_combat_image,
                grid_size, grid_offset_x, grid_offset_y, grid_opacity, simple_weight, combat_weight
         FROM scenes WHERE id = ?`,
        [state.active_scene_id]
      )
    : null;
  const activeScene = sceneRow
    ? {
        id: sceneRow.id,
        name: sceneRow.name,
        background_fit: sceneRow.background_fit,
        combat_mode: SCENE_MODES.has(sceneRow.combat_mode) ? sceneRow.combat_mode : 'scene',
        // The Combat map (Phase 3): its own picture and grid.
        combat_image_url: imageUrl('scene-combat', sceneRow.id, {
          hash: sceneRow.combat_image_hash,
          present: sceneRow.has_combat_image,
        }),
        grid: sceneGrid(sceneRow),
        // Cinematic Weight per fight (keys of client/src/lib/cinematicWeight.js).
        weights: { simple: sceneRow.simple_weight ?? null, combat: sceneRow.combat_weight ?? null },
        // A copy's backdrop is served from whichever Scene owns the bytes —
        // see shapeScene, and scenes.image_source_id for why.
        image_url: imageUrl('scene', sceneRow.image_source_id ?? sceneRow.id, {
          hash: sceneRow.image_hash,
          present: sceneRow.has_image || sceneRow.image_source_id != null,
        }),
      }
    : null;
  // **Scene-scoped (decided, revised) — a summon belongs to exactly one
  // Scene now (scene_summons.scene_id, NOT NULL; see db.js's own comment
  // on the column), so this only ever reads the ACTIVE Scene's own roster.
  // No active Scene means nothing to show, same as the backdrop itself.**
  const summonRows = activeScene
    ? await all(
        `
    SELECT ss.id, ss.side, ss.character_id, ss.temp_npc_id, ss.scene_picture_id,
           ss.pos_x, ss.pos_y, ss.scale, ss.is_hidden, ss.lane_slot,
           sp.image_hash AS picture_hash,
           COALESCE(c.name, tn.name) AS name
    FROM scene_summons ss
    JOIN scene_pictures sp ON sp.id = ss.scene_picture_id
    LEFT JOIN characters c ON c.id = ss.character_id
    LEFT JOIN temp_npcs tn ON tn.id = ss.temp_npc_id
    WHERE ss.scene_id = ?
    ORDER BY ss.id DESC
  `,
        [activeScene.id]
      )
    : [];
  // **Not `withImageUrl` here.** That helper reads `row.id` by definition, and a
  // summon row's own id is `scene_summons.id` — the PICTURE belongs to
  // `scene_pictures.id`, which rides along as `scene_picture_id`. So this one is
  // explicit. `present: true` is the schema speaking rather than an assumption:
  // `scene_pictures.image_data` is NOT NULL.
  // Simple Combat's lane, packed over EVERY summon (hidden ones included) in
  // summon order, before the per-viewer redaction — so a space a hidden
  // fighter stands in is taken for everyone, and looks empty to a Player.
  const simpleLanes = await readSimpleLanes();
  // Characters only: a Temp NPC's figure never takes a lane space (decided).
  const lane = packLane([...summonRows].filter((s) => s.character_id != null).sort((a, b) => a.id - b.id), simpleLanes);
  // Simple Combat fight state (Phase 4), per summon.
  const simpleStates = activeScene ? await loadSimpleStates(activeScene.id) : new Map();
  const summons = summonRows.map(({ picture_hash, ...summon }) => ({
    ...summon,
    lane_slot: lane.get(summon.id) ?? null,
    fight: simpleStates.get(summon.id) ?? EMPTY_FIGHT_STATE,
    image_url: imageUrl('scene-picture', summon.scene_picture_id, {
      hash: picture_hash,
      present: true,
    }),
  }));
  // Drawings (decided, new) — every stroke on the active Scene, oldest
  // first: `id ASC`, not summons' own `DESC`, because replay order is load-
  // bearing here (see db.js's own comment on scene_drawings — an eraser
  // stroke only erases what was drawn before it, in this exact order, on
  // every viewer's own canvas).
  const drawings = activeScene
    ? await all(
        'SELECT id, points, color, width, is_eraser FROM scene_drawings WHERE scene_id = ? ORDER BY id ASC',
        [activeScene.id]
      )
    : [];
  // The Combat map's tokens (Phase 3) — nothing on them is hidden, so every
  // viewer gets the same list.
  const combatTokens = activeScene ? await loadCombatTokens(activeScene.id) : [];
  // Per fighter (`character:<id>` / `temp_npc:<id>`): which Unique tokens
  // their token row shows and the names of their Stances — what the token
  // panel needs, for both fights at once.
  const fighterSetup = activeScene ? await loadFighterSetup() : {};
  // Phase 5: each mode's fight (rounds, order, a pending Stance pick), or null.
  const fights = activeScene
    ? { simple: await loadFightState(activeScene.id, 'simple'), combat: await loadFightState(activeScene.id, 'combat') }
    : { simple: null, combat: null };
  // Map tiles, per mode — public, like the tokens.
  const tiles = await loadMapTiles(activeScene?.id ?? null);
  const laneY = (await readTableSettings()).laneY;
  return { activeScene, summons, drawings, combatTokens, simpleLanes, laneY, fighterSetup, fights, tiles };
}

async function loadFighterSetup() {
  const [profiles, stances] = await Promise.all([loadAllProfiles(), loadAllStances()]);
  const out = {};
  for (const [key, p] of Object.entries(profiles)) out[key] = { unique_tokens: p.unique_tokens, armor_sources: p.armor_sources, stances: [] };
  for (const [key, list] of Object.entries(stances)) {
    out[key] = {
      unique_tokens: out[key]?.unique_tokens ?? [],
      armor_sources: out[key]?.armor_sources ?? [],
      stances: list.map((s) => ({ id: s.id, name: s.name })),
    };
  }
  return out;
}

// **A miniature's fight state goes with it.** Un-summoning deletes the Simple
// Combat row (its tokens, HP and Stance) and frees any Challenge naming it. Spelled out rather than trusting
// the summon_id FK's ON DELETE CASCADE, like every delete in this file.
async function dropSummonFightState(summonIds) {
  for (const summonId of summonIds) {
    const rows = await all('SELECT id FROM combatants WHERE summon_id = ?', [summonId]);
    await releaseChallengesOf(rows.map((r) => r.id));
    await run('DELETE FROM combatants WHERE summon_id = ?', [summonId]);
  }
}

// The table settings as the client sees them: { simpleLanes, laneY }.
async function readTableSettings() {
  const row = await one('SELECT simple_lanes, lane_y FROM table_settings WHERE id = 1');
  return { simpleLanes: clampLanes(row?.simple_lanes), laneY: clampLaneY(row?.lane_y ?? undefined) };
}

// How many lanes Simple Combat has (table_settings.simple_lanes, 1-3).
async function readSimpleLanes() {
  return clampLanes((await one('SELECT simple_lanes FROM table_settings WHERE id = 1'))?.simple_lanes);
}

// Per-viewer redaction of the unfiltered snapshot above — a Hidden summon
// (`is_hidden`) is dropped entirely for anyone who isn't the GM, including
// the character's own Player (see db.js's own comment on the column for
// why that's read literally rather than scoped to "everyone but the
// owner"). Drawings carry no ownership at all, so they need no filtering —
// every viewer sees the exact same array.
function stagePayloadFor(built, viewer) {
  if (viewer?.role === 'gm') return built;
  return { ...built, summons: built.summons.filter((s) => !s.is_hidden) };
}

// One query, one redaction per connected socket — same shape as
// emitCombatUpdated, and for the same reason: a Hidden summon must never
// cross the wire to a non-GM socket even transiently, so this can't be a
// single io.emit the way stage:updated used to be before Hidden existed.
async function emitStageUpdated() {
  const built = await buildStagePayload();
  for (const viewerSocket of io.sockets.sockets.values()) {
    viewerSocket.emit('stage:updated', stagePayloadFor(built, viewerSocket.data?.identity));
  }
}

// A private board must never cross the wire to another player, so this is a
// per-socket emit rather than an io.emit — the same shape refreshCapabilities
// uses, and for the same reason. The board is read ONCE regardless of how many
// sockets are entitled to it.
async function emitRelationships(ownerCharacterId) {
  const id = Number(ownerCharacterId);
  if (!Number.isInteger(id)) return;
  let payload = null;
  for (const socket of io.sockets.sockets.values()) {
    if (!maySeeBoard(socket.data?.identity, id)) continue;
    payload = payload ?? (await getRelationshipBoard(id));
    // `undoDepth` rides every board update so the client can grey its own Undo
    // rather than firing into an empty stack to find out it was empty.
    socket.emit('relationships:updated', { characterId: id, ...payload, undoDepth: undoDepthFor(id) });
  }
}

app.get('/api/characters/:id/relationships', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (!maySeeBoard(viewer, req.params.id)) return res.status(403).json({ error: 'not yours' });
  res.json(await getRelationshipBoard(Number(req.params.id)));
}));

// GM Notes (decided, new) — genuinely GM-secret, not merely GM-managed: the
// same viewerFromQuery 403 gate the Relationships board's own read uses
// above, and every broadcast (below) goes only to GM-identified sockets.
// Unlike Temp NPCs/Scenes (open REST, just not rendered for a Player),
// campaign notes are exactly the kind of spoiler-bearing text a GM does not
// want a technically-curious Player pulling straight off the API.
function emitToGm(event, payload) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.identity?.role === 'gm') socket.emit(event, payload);
  }
}

// **A Scene row is public; which Timestamp it cues is not.**
//
// Scenes are GM-*managed* but not GM-*secret* — a Player's client is told a
// Scene activated, and `GET /api/scenes` is an open read. `timestamp_id` is the
// one field on the row that is not like the rest: the Timestamp list is behind
// a GM-only 403 precisely so a Player cannot enumerate the campaign's timeline,
// and `stage:timestamp_play` broadcasts a played Timestamp's date and subtext
// but deliberately never its id, so a Player socket has nothing to correlate.
// Leaking the id here would chip at that for no gain, so the field is dropped
// for everyone but the GM — who is also the only client that has any use for
// it (SceneEditor's own picker).
const publicScene = ({ timestamp_id: _cue, ...rest }) => rest;

// **A Scene's backdrop may live on ANOTHER Scene's row (see scenes.image_source_id).**
//
// A copy holds no bytes — only the hash, the mime type and a pointer at the
// owner — so its URL has to be built from the OWNER's id and its own hash.
// `withImageUrl` cannot know that (it is shared by ten kinds and only ever
// looks at the row it is handed), so scenes get this wrapper instead, and every
// path that ships a Scene row goes through it.
//
// No extra query, deliberately: the hash rides on the copy's own row, so the
// URL is `image_source_id ?? id` plus that hash and nothing needs looking up.
// That matters because the scenes list is read on every Scene-drawer open.
const shapeScene = (row) => {
  if (!row) return row;
  // The Combat Background (Panic at the Dojo) is a second picture on the same
  // row: it goes out as a URL like the backdrop, never as bytes.
  const { combat_image_data, combat_image_mime_type, combat_image_hash, ...rest } = row;
  row = {
    ...rest,
    combat_image_url: imageUrl('scene-combat', row.id, { data: combat_image_data, hash: combat_image_hash }),
  };
  const shaped = withImageUrl('scene')(row);
  if (row.image_source_id == null) return shaped;
  // `present: true` rather than `Boolean(image_data)`: a copy's own data column
  // is empty by design, and the picture very much exists.
  const url = imageUrl('scene', row.image_source_id, { hash: row.image_hash, present: true });
  return url ? { ...shaped, image_url: url } : shaped;
};

function emitScene(event, row) {
  if (!row) return;
  const stripped = publicScene(row);
  for (const socket of io.sockets.sockets.values()) {
    socket.emit(event, socket.data?.identity?.role === 'gm' ? row : stripped);
  }
}

app.get('/api/scene-notes', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  const sceneId = Number(req.query.sceneId);
  if (!Number.isInteger(sceneId)) return res.json([]);
  res.json(await all('SELECT * FROM scene_notes WHERE scene_id = ? ORDER BY id', [sceneId]));
}));

// **What every stored picture costs, without sending any of them (GM only).**
//
// Feeds the Re-encode Images tool. Sizes and ids, never bytes: the tool's whole
// job is to find the pictures that are too big, so a listing that shipped them
// would be self-defeating. `LENGTH()` on the base64 column is within a few
// percent of the decoded size (base64 is a fixed 4:3 expansion), which is far
// more precision than "is this one worth re-encoding" needs.
// **The profiler's report (see server/dbProfile.js).** Only meaningful with
// DOGFIGHT_PROFILE=1; otherwise it says so rather than returning an empty table
// that would read as "nothing is slow".
app.get('/api/profile', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  if (!PROFILING) {
    return res.json({ profiling: false, hint: 'start the server with DOGFIGHT_PROFILE=1' });
  }
  res.type('text/plain').send(profileReport(Number(req.query.rtt) || 200));
}));

app.get('/api/image-inventory', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  const items = [];
  for (const [kind, spec] of Object.entries(IMAGE_KINDS)) {
    // chat_log is wiped on every boot; there is nothing durable to re-encode.
    if (spec.table === 'chat_log') continue;
    const rows = await all(
      `SELECT id, LENGTH(${spec.data}) AS bytes, ${spec.mime} AS mime, ${spec.hash} AS hash
       FROM ${spec.table} WHERE ${spec.data} IS NOT NULL ORDER BY id`
    );
    for (const row of rows) {
      items.push({ kind, id: row.id, bytes: row.bytes, mime: row.mime, hash: row.hash });
    }
  }
  res.json({ items, totalBytes: items.reduce((sum, i) => sum + (i.bytes ?? 0), 0) });
}));

// **The whole music library in one trip, GM only.** Playlists and their tracks
// are GM furniture — a Player never enumerates them, they only ever hear
// whatever is currently playing (see the audio:state broadcast). Both lists
// come back together because the panel always renders both and this library is
// small by construction: a row is a name and an 11-character video id, never
// audio.
app.get('/api/audio-library', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  const [playlists, tracks] = await readMany([
    ['SELECT * FROM audio_playlists ORDER BY id', []],
    ['SELECT * FROM audio_tracks ORDER BY playlist_id, sort_order, id', []],
  ]);
  res.json({ playlists, tracks });
}));

app.get('/api/master-note', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  res.json(await one('SELECT * FROM master_note WHERE id = 1'));
}));

// **The old system's archive (decided, new — the pivot).** The Compendium as it
// stood when the old system was removed, written by archiveAndPurgeOldSystem in
// db.js before anything was dropped. GM-only, same gate as the Notes above.
//
// The listing carries the counts and never the payload, so Settings can show
// what is in each archive without pulling the whole document; the download is a
// separate request that comes back as a file.
app.get('/api/compendium-archive', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  const rows = await all('SELECT id, archived_at, counts FROM compendium_archive ORDER BY id');
  res.json({
    archives: rows.map((r) => ({ id: r.id, archivedAt: r.archived_at, counts: JSON.parse(r.counts) })),
    purge: oldSystemPurge,
  });
}));

app.get('/api/compendium-archive/:id', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  const row = await one('SELECT archived_at, payload FROM compendium_archive WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  const day = String(row.archived_at).slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dogfight-compendium-archive-${day}.json"`);
  // Sent exactly as stored — the text that was verified before the old tables
  // were dropped — rather than parsed and re-serialised.
  res.send(row.payload);
}));

// Timestamps — same GM-only 403 gate as the two GM Notes reads above (see
// db.js's own comment on scene_timestamps for why managing the list is
// GM-secret while actually PLAYING one is not). Sorted chronologically —
// `(date = '')` puts anything with no date set last rather than first
// (an empty string otherwise sorts before every real 'YYYY-MM-DD' value),
// `id` breaks a tie between two rows sharing the same date by creation
// order. SceneTimestampDialog.jsx's own grid relies on rows already
// arriving in this exact order — it only groups/chunks what it's handed,
// it never re-sorts client-side.
app.get('/api/scene-timestamps', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (viewer?.role !== 'gm') return res.status(403).json({ error: 'GM only' });
  res.json(await all("SELECT * FROM scene_timestamps ORDER BY (date = '') ASC, date ASC, id ASC"));
}));

// Character-list folders (GM-managed) — separate from /api/characters so
// existing callers that just want the flat character array are unaffected.
app.get('/api/character-folders', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM character_folders ORDER BY name'));
}));

// Scene tab: the Temp NPC roster's own library — open read, same reasoning
// as character-folders above (GM-*managed*, not GM-*secret*).
app.get('/api/temp-npcs', wrap(async (_req, res) => {
  res.json((await all('SELECT * FROM temp_npcs ORDER BY name')).map(withImageUrl('temp-npc')));
}));

app.get('/api/temp-npc-folders', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM temp_npc_folders ORDER BY name'));
}));

// Scene tab: a picture's owner is exactly one of a Character or a Temp NPC
// (see scene_pictures' own CHECK) — open read, matching character_folders
// above: this is GM-*managed* content, not GM-*secret* content, so nothing
// here is gated server-side. The write side (Phase 3) is where ownership
// actually gets enforced.
// A fighter's Combat tab (Panic at the Dojo): token picture, Unique tokens,
// Reminders. Readable by everyone — nothing on it is secret, and every
// token's row is public on the board anyway.
// A character's build (builder phase 1), or null when none is saved yet.
app.get('/api/characters/:id/build', wrap(async (req, res) => {
  res.json({ build: await loadBuild(req.params.id) });
}));

app.get('/api/combat-setup', wrap(async (req, res) => {
  const owner = parseOwner(req.query.ownerType, req.query.ownerId);
  if (!owner) return res.status(400).json({ error: 'bad owner' });
  const [profile, reminders, stances] = await Promise.all([loadProfile(owner), loadReminders(owner), loadStances(owner)]);
  res.json({ profile, reminders, stances });
}));

// Every fighter's combat profile at once, keyed `character:<id>` /
// `temp_npc:<id>` — what the Scene's combat views draw tokens from.
app.get('/api/table-settings', wrap(async (_req, res) => {
  res.json(await readTableSettings());
}));

app.get('/api/combat-profiles', wrap(async (_req, res) => {
  res.json(await loadAllProfiles());
}));

app.get('/api/scene-pictures', wrap(async (req, res) => {
  const { ownerType, ownerId } = req.query;
  const id = Number(ownerId);
  if (!Number.isInteger(id) || (ownerType !== 'character' && ownerType !== 'temp_npc')) {
    return res.json([]);
  }
  const column = ownerType === 'character' ? 'character_id' : 'temp_npc_id';
  res.json((await all(`SELECT * FROM scene_pictures WHERE ${column} = ? ORDER BY id`, [id])).map(withImageUrl('scene-picture')));
}));

// Scene tab: the GM's Scenes library (Phase 4) — open read, same reasoning
// as temp-npcs/character-folders above.
app.get('/api/scenes', wrap(async (req, res) => {
  // Not a 403 like the Timestamp list itself — the Scene list is open read by
  // design (GM-managed, not GM-secret). Only the `timestamp_id` field is
  // withheld; see publicScene.
  const viewer = viewerFromQuery(req.query);
  const rows = (await all('SELECT * FROM scenes ORDER BY name')).map(shapeScene);
  res.json(viewer?.role === 'gm' ? rows : rows.map(publicScene));
}));

app.get('/api/scene-folders', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM scene_folders ORDER BY name'));
}));

// The live stage everyone shares — open read (nothing here requires a 403,
// unlike GM Notes), but per-viewer REDACTED same as the socket's own
// stage:updated (see stagePayloadFor) — a Hidden summon must not leak
// through this REST fetch either, so this takes an identity the same way
// GET /api/combat does.
app.get('/api/stage', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  res.json(stagePayloadFor(await buildStagePayload(), viewer));
}));

app.get('/api/characters/:id', wrap(async (req, res) => {
  const character = await getCharacter(req.params.id);
  if (!character) return res.status(404).json({ error: 'not found' });
  // What survives of the sheet (decided, revised — the pivot): Counters and
  // Role-play. Relationships and Scene Pictures have their own endpoints, and
  // the profile picture rides on `character` itself.
  const [roleplay, counters] = await Promise.all([getRoleplay(character.id), getCounters(character.id)]);
  res.json({ character, roleplay, counters });
}));

// The Gates on every Counter, as this viewer is allowed to know them. Its own
// endpoint rather than a key on the Counter payloads for the reason above: a
// Counter is public and a Gate need not be, and `GET /api/characters/:id` has
// no idea who is asking.
app.get('/api/counter-gates', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  // Unlike a board there is nothing to refuse — a Gate's EXISTENCE is public —
  // but an unidentified caller is treated as a Player, which is the closed
  // answer rather than the open one.
  res.json({ gates: visibleGates(await getAllGates(), viewer) });
}));

// Global search, by character name. (It also searched Moves, Perks, Tells and
// Tags until the pivot removed them.) Role-based visibility (e.g. hiding NPCs
// from Players) is applied client-side, same as everywhere else in this
// no-auth app — the server has no concept of role.
app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ characters: [] });
  const characters = await all(
    'SELECT id, name, character_type, assigned_to FROM characters WHERE name LIKE ? ORDER BY name',
    [`%${q}%`]
  );
  res.json({ characters });
}));

// **Plain create (decided, revised — the pivot).** Name, PC/NPC, folder and an
// optional profile picture, in one request. The old creation wizard seeded
// eight Stat dice and a Stamina pool here and walked the player through Stats,
// Stance, Moves, Perks and Quirks; none of that exists any more, and everything
// the sheet still has (Counters, Role-play, Relationships, Scene Pictures) is
// filled in on the sheet afterwards.
app.post('/api/characters', wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const characterType = req.body?.characterType === 'npc' ? 'npc' : 'pc';

  let folderId = null;
  if (req.body?.folderId != null) {
    const folder = await one('SELECT id FROM character_folders WHERE id = ?', [req.body.folderId]);
    if (folder) folderId = folder.id;
  }

  const imageData = req.body?.imageData ? String(req.body.imageData) : null;
  const result = await run(
    `INSERT INTO characters (name, character_type, folder_id, image_data, image_mime_type, crop_x, crop_y, crop_w, crop_h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      characterType,
      folderId,
      imageData,
      imageData ? String(req.body.imageMimeType ?? 'image/jpeg') : null,
      // All-null unless a valid crop came with the picture — see cropValues.
      ...(imageData ? cropValues(req.body) : [null, null, null, null]),
    ]
  );
  const character = await getCharacter(Number(result.lastInsertRowid));
  await stampImageHash('character', character.id);
  io.emit('character:created', shapeCharacter(character));
  res.status(201).json(character);
}));

app.put('/api/characters/:id', wrap(async (req, res) => {
  const character = await getCharacter(req.params.id);
  if (!character) return res.status(404).json({ error: 'not found' });

  const sets = [];
  const args = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    sets.push('name = ?');
    args.push(name);
  }
  if (req.body?.imageData !== undefined) {
    sets.push('image_data = ?', 'image_mime_type = ?', CROP_COLUMNS);
    args.push(String(req.body.imageData), String(req.body.imageMimeType ?? 'image/jpeg'), ...cropValues(req.body));
  }
  if (sets.length) {
    args.push(character.id);
    await run(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`, args);
  }

  const updated = await getCharacter(character.id);
  await stampImageHash('character', updated.id);
  io.emit('character:updated', shapeCharacter(updated));
  res.json(updated);
}));

// **A player's memory outlives the GM's roster (decided).**
//
// When a character is deleted, every Relationships node on somebody ELSE's
// board that pointed at them would be left dangling. Rather than dropping those
// nodes — which would silently destroy part of a player's map because the GM
// tidied up — each one converts into a board-local person on the board it
// already sits on, carrying the last-known name and picture across. Position,
// Nickname, Notes and (from Phase 3) every relationship are untouched: to that
// board, nothing happened except that this person stopped being someone the
// GM tracks.
//
// Runs BEFORE the character row goes, so the name and picture are still there
// to copy, and before the deleted character's own board rows are cleared.
// One person per board, not per node: two placements of the same NPC on one
// board are two views of one person and must not become two people.
async function convertRelationshipNodesToPeople(character) {
  const nodes = await all(
    'SELECT * FROM relationship_nodes WHERE character_id = ?',
    [character.id]
  );
  if (!nodes.length) return;
  const boards = [...new Set(nodes.map((n) => n.owner_character_id))];
  for (const ownerCharacterId of boards) {
    // The owner's own board is about to be deleted wholesale below, so there is
    // nothing worth converting there.
    if (ownerCharacterId === character.id) continue;
    const inserted = await run(
      `INSERT INTO relationship_people (owner_character_id, name, image_data, image_mime_type)
       VALUES (?, ?, ?, ?)`,
      [ownerCharacterId, character.name, character.image_data ?? null, character.image_mime_type ?? null]
    );
    await run(
      `UPDATE relationship_nodes SET person_id = ?, character_id = NULL
       WHERE character_id = ? AND owner_character_id = ?`,
      [Number(inserted.lastInsertRowid), character.id, ownerCharacterId]
    );
    await emitRelationships(ownerCharacterId);
  }
}

app.delete('/api/characters/:id', wrap(async (req, res) => {
  const character = await getCharacter(req.params.id);
  if (!character) return res.status(404).json({ error: 'not found' });

  // Explicit cascade, in dependency order. Chat log rows are deliberately
  // kept — chat history survives character deletion.
  await run('DELETE FROM roleplay_entries WHERE character_id = ?', [character.id]);
  await convertRelationshipNodesToPeople(character);
  await run('DELETE FROM relationship_edges WHERE owner_character_id = ?', [character.id]);
  await run('DELETE FROM relationship_nodes WHERE owner_character_id = ?', [character.id]);
  await run('DELETE FROM relationship_people WHERE owner_character_id = ?', [character.id]);
  // Scene tab: no conversion needed the way a relationship node needs one —
  // a scene_pictures/scene_summons row has no cross-owner reference to
  // preserve, it belongs to this character alone. Summons first, so a
  // character currently on stage is pulled off it before their pictures
  // (which a summon row also points at) disappear underneath them.
  const wasSummoned = await one('SELECT id FROM scene_summons WHERE character_id = ?', [character.id]);
  await run('DELETE FROM scene_summons WHERE character_id = ?', [character.id]);
  await run('DELETE FROM scene_pictures WHERE character_id = ?', [character.id]);
  // Their Counters' Gates go first — spelled out for the same reason every
  // other line in this cascade is, rather than trusting the DDL's ON DELETE.
  await run(
    'DELETE FROM counter_gates WHERE counter_id IN (SELECT id FROM counters WHERE character_id = ?)',
    [character.id]
  );
  await run('DELETE FROM counters WHERE character_id = ?', [character.id]);
  await deleteCombatSetupFor('character', character.id);
  await deleteBuild(character.id);
  const wasInAFight = await one('SELECT id FROM combatants WHERE character_id = ?', [character.id]);
  await run('DELETE FROM combatants WHERE character_id = ?', [character.id]);
  await run('DELETE FROM characters WHERE id = ?', [character.id]);
  // NPCs this PC controlled go back to the GM.
  setAssignment(character.id, null);
  const freed = dropAssignmentsTo(character.id);
  if (freed.length) await run('UPDATE characters SET assigned_to = NULL WHERE assigned_to = ?', [character.id]);
  for (const npcId of freed) io.emit('character:updated', { id: npcId, assigned_to: null });

  io.emit('character:deleted', { id: character.id });
  if (wasSummoned || wasInAFight) await emitStageUpdated();
  res.json({ ok: true });
}));

// **How much of the log a page load fetches (decided, new — Phase 4 of the
// round-trip work).**
//
// This used to be the whole thing, every time, with no bound at all — and
// `chat_log` is where pasted images live, base64 in `image_data`, so a session
// with a dozen shared pictures made every reload and every reconnect drag
// several megabytes across the wire before the Chat tab could paint. It is one
// query either way, so this is not about round trips; it is about the size of
// the answer.
//
// Deliberately generous, and deliberately the *tail*: 300 entries is far more
// than a fight produces, the GM clears the log between fights anyway
// (`chat:cleared`), and live entries arrive over the socket regardless of this
// number. The cost is that scrollback older than 300 entries does not come
// back after a reload — nothing in the UI pages further back, so an unbounded
// fetch was only ever serving the part of the log nobody scrolled to.
const CHAT_HISTORY_LIMIT = 300;

app.get('/api/chat', wrap(async (_req, res) => {
  // Chat now holds two kinds of entry: messages (with an optional picture or
  // GIF) and Dice Tray rolls. The old system's cards — move reveals, lane
  // snapshots, round summaries, Quirk cards — are no longer written, and the
  // log is wiped on every boot, so none can be left over to render.
  const rows = await all(`
    SELECT c.id, c.kind, c.character_id, c.modifier, c.dice_rolled, c.content, c.payload,
           c.image_hash, (c.image_data IS NOT NULL) AS has_image, c.image_mime_type, c.created_at,
           ch.name AS character_name
    FROM (SELECT * FROM chat_log ORDER BY id DESC LIMIT ${CHAT_HISTORY_LIMIT}) c
    LEFT JOIN characters ch ON ch.id = c.character_id
    ORDER BY c.id
  `);
  res.json(
    rows.map((row) => {
      const dice = JSON.parse(row.dice_rolled);
      const isGmPost = row.character_id === GM_CHAT_SENTINEL_ID;
      return {
        id: row.id,
        kind: row.kind,
        characterId: isGmPost ? null : row.character_id,
        characterName: isGmPost ? 'GM' : (row.character_name ?? '(deleted)'),
        modifier: row.modifier,
        dice,
        // Same rule as logRoll's own broadcast: the modifier applies once, to
        // the total.
        total: rollTotal(dice, row.modifier),
        message: row.content,
        imageUrl: imageUrl('chat', row.id, { hash: row.image_hash, present: row.has_image }),
        imageMimeType: row.image_mime_type,
        // Fight cards (Panic at the Dojo): a Reminder or a Stance roll.
        payload: row.kind === 'reminder' || row.kind === 'stance_roll' ? safeJson(row.payload) : undefined,
        timestamp: sqliteToIso(row.created_at),
      };
    })
  );
}));

// ---------- Socket.io game events ----------

// A Counter's optional reward tag — purely cosmetic (no mechanical
// effect), character-owned counters only. See counter:create/counter:set_reward.
const REWARD_TYPES = ['story', 'statistic', 'perk', 'move', 'combat_prowess'];

// chat_log.character_id's sentinel for "the GM, generically" — a GM-posted
// message, a GM-posted Dice Tray roll, or a system line. characters.id is an
// AUTOINCREMENT rowid starting at 1, so 0 can never collide with a real row;
// chat_log.character_id stays NOT NULL without a schema change.
const GM_CHAT_SENTINEL_ID = 0;

// A dice roll, written to the log and broadcast. Only the Dice Tray rolls now;
// these two helpers lived in the combat engine until the pivot removed it.
async function logRoll({ characterId, characterName, modifier, dice }) {
  await run('INSERT INTO chat_log (character_id, dice_rolled, modifier) VALUES (?, ?, ?)', [
    characterId,
    JSON.stringify(dice),
    modifier,
  ]);
  // Normalised back to null on the broadcast, matching how GET /api/chat reads
  // a GM-posted row back after a reload, so a live entry and its reload render
  // identically.
  io.emit('roll:result', {
    kind: 'roll',
    characterId: characterId === GM_CHAT_SENTINEL_ID ? null : characterId,
    characterName,
    modifier,
    dice,
    // rollTotal, not a bare sum: the modifier applies once, to the total.
    total: rollTotal(dice, modifier),
    timestamp: new Date().toISOString(),
  });
}

// A line from the table itself rather than from anyone — a Counter crossing
// one of its Gates, for instance.
async function postSystemMessage(text) {
  await run(`INSERT INTO chat_log (kind, character_id, dice_rolled, content) VALUES ('message', ?, '[]', ?)`, [
    GM_CHAT_SENTINEL_ID,
    text,
  ]);
  io.emit('chat:message', {
    kind: 'message',
    characterId: null,
    characterName: 'GM',
    message: text,
    imageData: null,
    imageMimeType: null,
    timestamp: new Date().toISOString(),
  });
}

// **A fight card in chat (Panic at the Dojo)** — a Reminder box or a Stance
// roll, from the table rather than from anyone. Everything it shows rides in
// `payload`, so the card renders the same after a reload.
async function postCard(kind, payload) {
  const result = await run(
    "INSERT INTO chat_log (kind, character_id, dice_rolled, payload) VALUES (?, ?, '[]', ?)",
    [kind, GM_CHAT_SENTINEL_ID, JSON.stringify(payload)]
  );
  io.emit('chat:card', {
    id: Number(result.lastInsertRowid),
    kind,
    payload,
    timestamp: new Date().toISOString(),
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ============================================================ Audio Player
//
// **The first wall-clock-authoritative state in this app.** Everything else
// here advances by event — combat Tics are a plain integer counter — but
// "everyone hears the same second of the same song at the same moment" is a
// claim about real time, so the server publishes an instant and every client
// translates it through a measured clock offset (see server/audioSync.js).
//
// The server owns three things and the clients own none of them: what is
// playing, the anchor it is playing from, and what comes next.

const AUDIO_STATE_SQL = 'SELECT * FROM audio_state WHERE id = 1';

// What every client gets. Deliberately carries the track's own fields inline
// rather than an id to look up: a Player never receives the playlist list (it
// is GM furniture, emitToGm only), so without this they would have an id they
// could not render. It is also the exact set of facts a client needs and no
// more — the same "resolve it server-side, broadcast only what renders" shape
// as stage:timestamp_play.
async function getAudioPayload() {
  const state = await one(AUDIO_STATE_SQL);
  if (!state) return null;
  const track = state.track_id
    ? await one('SELECT * FROM audio_tracks WHERE id = ?', [state.track_id])
    : null;
  return {
    trackId: track?.id ?? null,
    youtubeId: track?.youtube_id ?? null,
    name: track?.name ?? null,
    playlistId: track?.playlist_id ?? null,
    durationMs: track?.duration_ms ?? null,
    isPlaying: Boolean(state.is_playing) && Boolean(track),
    positionMs: state.position_ms,
    anchoredAtMs: state.anchored_at_ms,
    anchorId: state.anchor_id,
    repeatMode: state.repeat_mode,
    shuffle: Boolean(state.shuffle),
    // **The server's own clock rides along with every state change.** A client
    // that has just connected can compute where it should be from this alone,
    // before its ping handshake has even finished — one fewer round trip
    // between "the GM pressed play" and "I am in sync".
    serverMs: Date.now(),
  };
}

// The single write path. Every playback change goes through here so that
// bumping `anchor_id`, re-arming the end-of-track timer and broadcasting can
// never be forgotten at one call site and remembered at the others.
async function writeAudioState(patch) {
  const prev = await one(AUDIO_STATE_SQL);
  const next = {
    track_id: patch.trackId !== undefined ? patch.trackId : prev.track_id,
    is_playing: patch.isPlaying !== undefined ? (patch.isPlaying ? 1 : 0) : prev.is_playing,
    position_ms: patch.positionMs !== undefined ? Math.max(0, Math.round(patch.positionMs)) : prev.position_ms,
    anchored_at_ms: patch.anchoredAtMs !== undefined ? patch.anchoredAtMs : prev.anchored_at_ms,
    repeat_mode: patch.repeatMode !== undefined ? patch.repeatMode : prev.repeat_mode,
    shuffle: patch.shuffle !== undefined ? (patch.shuffle ? 1 : 0) : prev.shuffle,
    shuffle_seed: patch.shuffleSeed !== undefined ? patch.shuffleSeed : prev.shuffle_seed,
  };
  await run(
    `UPDATE audio_state SET track_id = ?, is_playing = ?, position_ms = ?, anchored_at_ms = ?,
       anchor_id = anchor_id + 1, repeat_mode = ?, shuffle = ?, shuffle_seed = ? WHERE id = 1`,
    [
      next.track_id,
      next.is_playing,
      next.position_ms,
      next.anchored_at_ms,
      next.repeat_mode,
      next.shuffle,
      next.shuffle_seed,
    ]
  );
  const payload = await getAudioPayload();
  armTrackEndTimer(payload);
  io.emit('audio:state', payload);
  return payload;
}

// Where the playing track is RIGHT NOW, by the server's own clock. Used to
// anchor a pause exactly where the music actually is, rather than where it was
// when it started.
function livePositionMs(state) {
  return expectedPositionMs(
    { is_playing: state.is_playing, position_ms: state.position_ms, anchored_at_ms: state.anchored_at_ms },
    Date.now()
  );
}

// The playlist a given track belongs to, in its stored order — the input
// nextTrackId needs.
async function tracksAround(trackId) {
  const track = await one('SELECT * FROM audio_tracks WHERE id = ?', [trackId]);
  if (!track) return { track: null, tracks: [] };
  const tracks = await all(
    'SELECT id FROM audio_tracks WHERE playlist_id = ? ORDER BY sort_order, id',
    [track.playlist_id]
  );
  return { track, tracks };
}

// Start a track from the top (or from `positionMs`), playing.
async function startTrack(trackId, positionMs = 0) {
  if (trackId == null) {
    return writeAudioState({ trackId: null, isPlaying: false, positionMs: 0, anchoredAtMs: Date.now() });
  }
  return writeAudioState({
    trackId,
    isPlaying: true,
    positionMs,
    anchoredAtMs: Date.now(),
  });
}

// Move by one, in either direction. `atNaturalEnd` distinguishes a track
// finishing by itself (where 'repeat: off' means stop and 'repeat: track'
// means loop) from a GM pressing a button (where neither applies) — see
// nextTrackId's own comment.
async function advance(direction, atNaturalEnd) {
  const state = await one(AUDIO_STATE_SQL);
  if (!state?.track_id) return null;
  const { tracks } = await tracksAround(state.track_id);
  const target = nextTrackId({
    tracks,
    currentId: state.track_id,
    repeatMode: state.repeat_mode,
    shuffle: Boolean(state.shuffle),
    shuffleSeed: state.shuffle_seed,
    direction,
    atNaturalEnd,
  });
  return startTrack(target, 0);
}

// **Auto-advance without a ticking loop.** Two mechanisms, both guarded by the
// same `anchor_id`, so whichever arrives first wins and the other is a no-op:
//
//  1. Clients report `audio:track_ended` when their own player hits the end.
//     This is the primary path and needs no duration — the GM's browser is
//     always in the room.
//  2. Once any client has told us the track's length, this timer is armed for
//     the remaining time plus a small grace. It is the safety net for the case
//     where every client is backgrounded (phone browsers throttle timers and
//     may never fire the ENDED event) and the music would otherwise just stop.
//
// Exactly one timer exists at a time and it is re-armed on every state change,
// so there is no accumulation and nothing to clean up on shutdown.
let trackEndTimer = null;
const TRACK_END_GRACE_MS = 1500;

function armTrackEndTimer(payload) {
  if (trackEndTimer) clearTimeout(trackEndTimer);
  trackEndTimer = null;
  if (!payload?.isPlaying || !payload.durationMs || !payload.trackId) return;
  const remaining = payload.durationMs - (Date.now() - payload.anchoredAtMs + payload.positionMs);
  const delay = Math.max(0, remaining) + TRACK_END_GRACE_MS;
  // A duration we cannot believe (a livestream reports 0, a bad report could be
  // anything) must not schedule a timer days out or fire in a tight loop.
  if (!Number.isFinite(delay) || delay > 6 * 60 * 60 * 1000) return;
  const armedFor = payload.anchorId;
  trackEndTimer = setTimeout(async () => {
    try {
      const current = await one(AUDIO_STATE_SQL);
      if (!current || current.anchor_id !== armedFor || !current.is_playing) return;
      await advance(1, true);
    } catch (err) {
      console.error('audio: failed to auto-advance at end of track:', err);
    }
  }, delay);
  trackEndTimer.unref?.();
}

io.on('connection', (socket) => {
  const on = (event, handler) => {
    socket.on(event, async (payload) => {
      try {
        // `profile` is a pass-through unless DOGFIGHT_PROFILE=1 — see
        // server/dbProfile.js for what it measures and why waves, not counts.
        await profile(event, () => handler(payload ?? {}));
      } catch (err) {
        console.error(`error handling ${event}:`, err);
      }
    });
  };

  // The Combat tab (Panic at the Dojo) — see server/combatSetup.js.
  registerCombatSetupHandlers({ on, socket, io, mayWrite: mayWriteScenePicture, cropValues, stampImageHash, emitStageUpdated });
  // The Combat map (Panic at the Dojo, Phase 3) — see server/combatMap.js.
  registerCombatMapHandlers({ on, socket, mayWrite: mayWriteScenePicture, emitStageUpdated, stampImageHash });
  // A fighter's HP, tokens, Challenge and Stance (Phase 4) — see server/combatState.js.
  registerCombatStateHandlers({ on, socket, mayWrite: mayWriteScenePicture, emitStageUpdated, postCard });
  registerMapTileHandlers({ on, socket, emitStageUpdated });
  registerBuildHandlers({ on, socket, io, mayWrite: mayWriteScenePicture, emitStageUpdated });
  // Rounds, turns, Stance rolls and Reminders (Phase 5) — see server/fights.js.
  registerFightHandlers({ on, socket, emitStageUpdated, postCard, postSystemMessage, emitAll: (event, payload) => io.emit(event, payload) });

  // Who this connection is playing as — stored per-socket, in memory only
  // (lost on disconnect, matching the no-login/session-only model; the
  // client re-sends it on every reconnect — see roleContext.jsx). Decides what
  // this socket is shown: hidden Scene summons, the GM-only Notes and
  // Timestamps, and whose Relationships board it may read.
  on('identity:set', async ({ role, characterId }) => {
    if (role === 'gm') {
      socket.data.identity = { role: 'gm' };
    } else {
      const id = Number(characterId);
      if (role === 'player' && Number.isInteger(id)) {
        const character = await one('SELECT id FROM characters WHERE id = ?', [id]);
        socket.data.identity = character ? { role: 'player', characterId: character.id } : null;
      }
    }
    // **Answer every identity with the audio anchor — this is what makes
    // joining late work.** Identity is re-sent on every reconnect, so this is
    // the one moment the server reliably hears "someone is back". A client that
    // connects twenty seconds into a song learns the anchor here and seeks
    // straight to twenty seconds; nothing else would ever tell it, because
    // audio:state is only broadcast when the state CHANGES.
    socket.emit('audio:state', await getAudioPayload());
  });

  // **The Dice Tray** — one die of any size (d4-d12) plus the modifier typed
  // into the tray, posted to chat. The modifier is exactly that number and
  // nothing else (decided, revised — the pivot): every bonus that used to ride
  // on a character's roll (Reasons to Fight, the Stance matchup, Perks) went
  // with the old system. `characterId: null` posts as the generic GM persona,
  // the same convention as chat:message; a character id only changes whose
  // name the roll is posted under.
  on('dice:roll_custom', async ({ characterId, size, modifier }) => {
    const die = Number(size);
    if (!DIE_SIZES.includes(die)) return;
    const asGm = characterId == null;
    const character = asGm ? null : await getCharacter(characterId);
    if (!asGm && !character) return;
    await logRoll({
      characterId: asGm ? GM_CHAT_SENTINEL_ID : character.id,
      characterName: asGm ? 'GM' : character.name,
      modifier: clampModifier(modifier),
      dice: [{ slot_name: 'Custom', size: die, bonus: 0, result: rollDie(die) }],
    });
  });


  // Character-list folders — GM-managed (client-side gated), same structural
  // pattern as move folders: create/rename/delete, delete returns to root.
  on('character_folder:create', async ({ name, parentFolderId }) => {
    const folderName = String(name ?? '').trim();
    if (!folderName) return;
    let parentId = null;
    if (parentFolderId != null) {
      const parent = await one('SELECT id FROM character_folders WHERE id = ?', [parentFolderId]);
      if (parent) parentId = parent.id; // unknown parent falls back to root
    }
    const result = await run('INSERT INTO character_folders (name, parent_id) VALUES (?, ?)', [
      folderName,
      parentId,
    ]);
    io.emit('character_folder:created', await one('SELECT * FROM character_folders WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  on('character_folder:rename', async ({ folderId, name }) => {
    const folder = await one('SELECT * FROM character_folders WHERE id = ?', [folderId]);
    const folderName = String(name ?? '').trim();
    if (!folder || !folderName) return;
    await run('UPDATE character_folders SET name = ? WHERE id = ?', [folderName, folder.id]);
    io.emit(
      'character_folder:updated',
      await one('SELECT * FROM character_folders WHERE id = ?', [folder.id])
    );
  });

  on('character_folder:delete', async ({ folderId }) => {
    const folder = await one('SELECT * FROM character_folders WHERE id = ?', [folderId]);
    if (!folder) return;
    // Directly-contained characters and direct child folders promote one
    // level, to this folder's own parent (root if it was already at root) —
    // not unconditionally to root, so deleting a nested folder only
    // collapses that one level rather than flattening the whole subtree.
    await run('UPDATE characters SET folder_id = ? WHERE folder_id = ?', [folder.parent_id, folder.id]);
    await run('UPDATE character_folders SET parent_id = ? WHERE parent_id = ?', [folder.parent_id, folder.id]);
    await run('DELETE FROM character_folders WHERE id = ?', [folder.id]);
    io.emit('character_folder:deleted', { folderId: folder.id, parentFolderId: folder.parent_id });
  });

  // **Assign an NPC to a player (GM only).** `playerCharacterId` is the PC the
  // player picked at the door; null hands the NPC back to the GM. See control.js.
  on('character:assign', async ({ characterId, playerCharacterId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const npc = await getCharacter(characterId);
    if (!npc || npc.character_type !== 'npc') return;
    let target = null;
    if (playerCharacterId != null) {
      const pc = await getCharacter(playerCharacterId);
      if (!pc || pc.character_type !== 'pc') return;
      target = pc.id;
    }
    await run('UPDATE characters SET assigned_to = ? WHERE id = ?', [target, npc.id]);
    setAssignment(npc.id, target);
    io.emit('character:updated', { id: npc.id, assigned_to: target });
  });

  // Drag-and-drop reassignment: touches only folder_id.
  on('character:set_folder', async ({ characterId, folderId }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    let target = null;
    if (folderId != null) {
      const folder = await one('SELECT id FROM character_folders WHERE id = ?', [folderId]);
      if (folder) target = folder.id;
    }
    await run('UPDATE characters SET folder_id = ? WHERE id = ?', [target, character.id]);
    io.emit('character:updated', shapeCharacter({ ...character, folder_id: target }));
  });

  // ---------------------------------------------------------------------
  // Scene tab: the Temp NPC roster and its folder tree (Phase 2). Same
  // structural pattern as character_folders/characters above, but every
  // write here is server-enforced GM-only (`role !== 'gm'` idiom, the
  // `quirk:create` convention) — this plan's own deliberate departure from
  // character_folder:*'s older, merely client-gated precedent (see
  // vttprojectplan.md's "Scene tab" section for why).
  // ---------------------------------------------------------------------

  on('temp_npc_folder:create', async ({ name, parentFolderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const folderName = String(name ?? '').trim();
    if (!folderName) return;
    let parentId = null;
    if (parentFolderId != null) {
      const parent = await one('SELECT id FROM temp_npc_folders WHERE id = ?', [parentFolderId]);
      if (parent) parentId = parent.id;
    }
    const result = await run('INSERT INTO temp_npc_folders (name, parent_id) VALUES (?, ?)', [
      folderName,
      parentId,
    ]);
    io.emit(
      'temp_npc_folder:created',
      await one('SELECT * FROM temp_npc_folders WHERE id = ?', [Number(result.lastInsertRowid)])
    );
  });

  on('temp_npc_folder:rename', async ({ folderId, name }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const folder = await one('SELECT * FROM temp_npc_folders WHERE id = ?', [folderId]);
    const folderName = String(name ?? '').trim();
    if (!folder || !folderName) return;
    await run('UPDATE temp_npc_folders SET name = ? WHERE id = ?', [folderName, folder.id]);
    io.emit('temp_npc_folder:updated', await one('SELECT * FROM temp_npc_folders WHERE id = ?', [folder.id]));
  });

  on('temp_npc_folder:delete', async ({ folderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const folder = await one('SELECT * FROM temp_npc_folders WHERE id = ?', [folderId]);
    if (!folder) return;
    // Same promote-one-level rule as character_folder:delete: direct Temp
    // NPCs and direct child folders move up to this folder's own parent
    // (root if it was already at root), not unconditionally to root.
    await run('UPDATE temp_npcs SET folder_id = ? WHERE folder_id = ?', [folder.parent_id, folder.id]);
    await run('UPDATE temp_npc_folders SET parent_id = ? WHERE parent_id = ?', [folder.parent_id, folder.id]);
    await run('DELETE FROM temp_npc_folders WHERE id = ?', [folder.id]);
    io.emit('temp_npc_folder:deleted', { folderId: folder.id, parentFolderId: folder.parent_id });
  });

  on('temp_npc:create', async ({ name, folderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const npcName = String(name ?? '').trim();
    if (!npcName) return;
    let folder = null;
    if (folderId != null) {
      const row = await one('SELECT id FROM temp_npc_folders WHERE id = ?', [folderId]);
      if (row) folder = row.id;
    }
    const result = await run('INSERT INTO temp_npcs (name, folder_id) VALUES (?, ?)', [npcName, folder]);
    await stampImageHash('temp-npc', Number(result.lastInsertRowid));
    io.emit('temp_npc:created', withImageUrl('temp-npc')(await one('SELECT * FROM temp_npcs WHERE id = ?', [Number(result.lastInsertRowid)])));
  });

  // The name is always sent; a picture is only sent when the file picker in
  // TempNpcEditor actually produced one — same "absent means leave it
  // alone" contract relationships:update_person uses for the same reason.
  on('temp_npc:update', async ({ tempNpcId, name, imageData, imageMimeType, ...payload }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const npc = await one('SELECT * FROM temp_npcs WHERE id = ?', [tempNpcId]);
    const npcName = String(name ?? '').trim();
    if (!npc || !npcName) return;
    await run(
      imageData
        ? `UPDATE temp_npcs SET name = ?, image_data = ?, image_mime_type = ?, ${CROP_COLUMNS} WHERE id = ?`
        : 'UPDATE temp_npcs SET name = ? WHERE id = ?',
      imageData
        ? [npcName, String(imageData), String(imageMimeType ?? 'image/jpeg'), ...cropValues(payload), npc.id]
        : [npcName, npc.id]
    );
    await stampImageHash('temp-npc', npc.id);
    io.emit('temp_npc:updated', withImageUrl('temp-npc')(await one('SELECT * FROM temp_npcs WHERE id = ?', [npc.id])));
  });

  on('temp_npc:set_folder', async ({ tempNpcId, folderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const npc = await one('SELECT * FROM temp_npcs WHERE id = ?', [tempNpcId]);
    if (!npc) return;
    let target = null;
    if (folderId != null) {
      const folder = await one('SELECT id FROM temp_npc_folders WHERE id = ?', [folderId]);
      if (folder) target = folder.id;
    }
    await run('UPDATE temp_npcs SET folder_id = ? WHERE id = ?', [target, npc.id]);
    io.emit('temp_npc:updated', withImageUrl('temp-npc')({ ...npc, folder_id: target }));
  });

  on('temp_npc:delete', async ({ tempNpcId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const npc = await one('SELECT * FROM temp_npcs WHERE id = ?', [tempNpcId]);
    if (!npc) return;
    // Explicit cascade, matching DELETE /api/characters/:id's own style —
    // both FKs are already ON DELETE CASCADE, but every delete in this file
    // spells its cascade out by hand rather than trusting the DDL alone.
    const wasSummoned = await one('SELECT id FROM scene_summons WHERE temp_npc_id = ?', [npc.id]);
    await run('DELETE FROM scene_summons WHERE temp_npc_id = ?', [npc.id]);
    await run('DELETE FROM scene_pictures WHERE temp_npc_id = ?', [npc.id]);
    await deleteCombatSetupFor('temp_npc', npc.id);
    const wasInAFight = await one('SELECT id FROM combatants WHERE temp_npc_id = ?', [npc.id]);
    await run('DELETE FROM combatants WHERE temp_npc_id = ?', [npc.id]);
    await run('DELETE FROM temp_npcs WHERE id = ?', [npc.id]);
    io.emit('temp_npc:deleted', { tempNpcId: npc.id });
    if (wasSummoned || wasInAFight) await emitStageUpdated();
  });

  // ---------------------------------------------------------------------
  // Scene tab: Scene Pictures (Phase 3) — the transparent-PNG art a
  // Character or Temp NPC is summoned onto the stage with. Per-owner gate
  // (mayWriteScenePicture), NOT flatly GM-only: this is the one place in
  // the whole feature a Player writes anything, for their own character's
  // own pictures. `io.emit`, matching move:updated's shape — GM-managed
  // library content, same as every other Scene tab authoring event, not a
  // secret the way a pre-reveal declared move is.
  // ---------------------------------------------------------------------

  const ownerColumn = (ownerType) => (ownerType === 'character' ? 'character_id' : 'temp_npc_id');
  const ownerTable = (ownerType) => (ownerType === 'character' ? 'characters' : 'temp_npcs');

  on('scene_picture:create', async ({ ownerType, ownerId, name, imageData, imageMimeType }) => {
    const id = Number(ownerId);
    if (!Number.isInteger(id) || (ownerType !== 'character' && ownerType !== 'temp_npc')) return;
    if (!mayWriteScenePicture(socket.data.identity, ownerType, id)) return;
    if (!imageData) return;
    const owner = await one(`SELECT id FROM ${ownerTable(ownerType)} WHERE id = ?`, [id]);
    if (!owner) return;
    const pictureName = String(name ?? '').trim();
    const result = await run(
      `INSERT INTO scene_pictures (${ownerColumn(ownerType)}, name, image_data, image_mime_type) VALUES (?, ?, ?, ?)`,
      [id, pictureName, String(imageData), String(imageMimeType ?? 'image/png')]
    );
    await stampImageHash('scene-picture', Number(result.lastInsertRowid));
    io.emit(
      'scene_picture:created',
      withImageUrl('scene-picture')(
        await one('SELECT * FROM scene_pictures WHERE id = ?', [Number(result.lastInsertRowid)])
      )
    );
  });

  // "Copy picture from profile" (decided, new) — takes the FULL portrait
  // (characters.image_data), not the zoomed-in view CharacterSheet shows.
  // A character's own portrait crop (crop_x/crop_y/crop_w/crop_h) is a
  // display-only transform read at render time (see CroppedImage.jsx) —
  // the stored bytes are always the whole, uncropped upload, so this is
  // exactly "reuse what's already there" with no re-processing needed.
  // Only characters have a profile picture to copy from; a Temp NPC has no
  // portrait at all, so this event doesn't accept one.
  on('scene_picture:copy_from_profile', async ({ characterId }) => {
    const id = Number(characterId);
    if (!Number.isInteger(id)) return;
    if (!mayWriteScenePicture(socket.data.identity, 'character', id)) return;
    const character = await one('SELECT name, image_data, image_mime_type FROM characters WHERE id = ?', [id]);
    if (!character?.image_data) return;
    const result = await run(
      'INSERT INTO scene_pictures (character_id, name, image_data, image_mime_type) VALUES (?, ?, ?, ?)',
      [id, 'Profile', character.image_data, character.image_mime_type || 'image/jpeg']
    );
    await stampImageHash('scene-picture', Number(result.lastInsertRowid));
    io.emit(
      'scene_picture:created',
      withImageUrl('scene-picture')(
        await one('SELECT * FROM scene_pictures WHERE id = ?', [Number(result.lastInsertRowid)])
      )
    );
  });

  on('scene_picture:update', async ({ scenePictureId, name }) => {
    const picture = await one('SELECT * FROM scene_pictures WHERE id = ?', [scenePictureId]);
    if (!picture) return;
    const ownerType = picture.character_id != null ? 'character' : 'temp_npc';
    const ownerId = picture.character_id ?? picture.temp_npc_id;
    if (!mayWriteScenePicture(socket.data.identity, ownerType, ownerId)) return;
    const pictureName = String(name ?? '').trim();
    if (!pictureName) return;
    await run('UPDATE scene_pictures SET name = ? WHERE id = ?', [pictureName, picture.id]);
    await stampImageHash('scene-picture', picture.id);
    io.emit('scene_picture:updated', withImageUrl('scene-picture')(await one('SELECT * FROM scene_pictures WHERE id = ?', [picture.id])));
  });

  on('scene_picture:delete', async ({ scenePictureId }) => {
    const picture = await one('SELECT * FROM scene_pictures WHERE id = ?', [scenePictureId]);
    if (!picture) return;
    const ownerType = picture.character_id != null ? 'character' : 'temp_npc';
    const ownerId = picture.character_id ?? picture.temp_npc_id;
    if (!mayWriteScenePicture(socket.data.identity, ownerType, ownerId)) return;
    // Explicit, matching every other delete in this file — scene_summons'
    // own FK is already ON DELETE CASCADE, but nothing here trusts the DDL
    // alone. Un-summons whoever was showing this picture, if anyone was.
    const wasSummoned = await one('SELECT id FROM scene_summons WHERE scene_picture_id = ?', [picture.id]);
    if (wasSummoned) await dropSummonFightState([wasSummoned.id]);
    await run('DELETE FROM scene_summons WHERE scene_picture_id = ?', [picture.id]);
    await run('DELETE FROM scene_pictures WHERE id = ?', [picture.id]);
    io.emit('scene_picture:deleted', { scenePictureId: picture.id });
    if (wasSummoned) await emitStageUpdated();
  });

  // ---------------------------------------------------------------------
  // Scene tab: Scenes, their folders, and activation (Phase 4). Same
  // structural pattern as temp_npc_folders/temp_npcs above — every write
  // here is server-enforced GM-only, the quirk:create idiom.
  // ---------------------------------------------------------------------

  on('scene_folder:create', async ({ name, parentFolderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const folderName = String(name ?? '').trim();
    if (!folderName) return;
    let parentId = null;
    if (parentFolderId != null) {
      const parent = await one('SELECT id FROM scene_folders WHERE id = ?', [parentFolderId]);
      if (parent) parentId = parent.id;
    }
    const result = await run('INSERT INTO scene_folders (name, parent_id) VALUES (?, ?)', [
      folderName,
      parentId,
    ]);
    io.emit(
      'scene_folder:created',
      await one('SELECT * FROM scene_folders WHERE id = ?', [Number(result.lastInsertRowid)])
    );
  });

  on('scene_folder:rename', async ({ folderId, name }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const folder = await one('SELECT * FROM scene_folders WHERE id = ?', [folderId]);
    const folderName = String(name ?? '').trim();
    if (!folder || !folderName) return;
    await run('UPDATE scene_folders SET name = ? WHERE id = ?', [folderName, folder.id]);
    io.emit('scene_folder:updated', await one('SELECT * FROM scene_folders WHERE id = ?', [folder.id]));
  });

  on('scene_folder:delete', async ({ folderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const folder = await one('SELECT * FROM scene_folders WHERE id = ?', [folderId]);
    if (!folder) return;
    // Same promote-one-level rule as temp_npc_folder:delete/character_folder:delete.
    await run('UPDATE scenes SET folder_id = ? WHERE folder_id = ?', [folder.parent_id, folder.id]);
    await run('UPDATE scene_folders SET parent_id = ? WHERE parent_id = ?', [folder.parent_id, folder.id]);
    await run('DELETE FROM scene_folders WHERE id = ?', [folder.id]);
    io.emit('scene_folder:deleted', { folderId: folder.id, parentFolderId: folder.parent_id });
  });

  on('scene:create', async ({ name, folderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const sceneName = String(name ?? '').trim();
    if (!sceneName) return;
    let folder = null;
    if (folderId != null) {
      const row = await one('SELECT id FROM scene_folders WHERE id = ?', [folderId]);
      if (row) folder = row.id;
    }
    const result = await run('INSERT INTO scenes (name, folder_id) VALUES (?, ?)', [sceneName, folder]);
    await stampImageHash('scene', Number(result.lastInsertRowid));
    emitScene('scene:created', shapeScene(await one('SELECT * FROM scenes WHERE id = ?', [Number(result.lastInsertRowid)])));
  });

  // The name is always sent; a background is only sent when the file picker
  // in SceneEditor actually produced one — same "absent means leave it
  // alone" contract temp_npc:update/relationships:update_person use.
  // `backgroundFit` is a THIRD, independent field — always sent alongside
  // `name` (SceneEditor.jsx's own `<select>` always has a current value),
  // but unlike the image it never needs an "absent means unchanged" branch
  // of its own: an invalid/missing value just falls back to whatever the
  // Scene already had, rather than being treated as "no change requested."
  on('scene:update', async ({ sceneId, name, imageData, imageMimeType, backgroundFit, timestampId, ...payload }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const scene = await one('SELECT * FROM scenes WHERE id = ?', [sceneId]);
    const sceneName = String(name ?? '').trim();
    if (!scene || !sceneName) return;
    const fit = VALID_BACKGROUND_FITS.has(backgroundFit) ? backgroundFit : scene.background_fit;
    // **Which Timestamp this Scene cues.** `undefined` is "leave it alone" —
    // the same absent-means-untouched contract `imageData` uses above — while
    // an explicit `null` clears the cue, which is what the picker's own "None"
    // option sends. Resolved against the table rather than trusted, so a stale
    // id from a deleted Timestamp lands as NULL instead of a dangling FK.
    let cue = scene.timestamp_id;
    if (timestampId !== undefined) {
      cue =
        timestampId == null
          ? null
          : ((await one('SELECT id FROM scene_timestamps WHERE id = ?', [timestampId]))?.id ?? null);
    }
    await run('UPDATE scenes SET timestamp_id = ? WHERE id = ?', [cue, scene.id]);
    // Giving a copy its own backdrop ends the borrowing: it now holds real
    // bytes, and leaving the pointer set would have shapeScene serve the old
    // Scene's picture over the new one.
    await run(
      imageData
        ? `UPDATE scenes SET name = ?, background_fit = ?, image_data = ?, image_mime_type = ?, image_source_id = NULL, ${CROP_COLUMNS} WHERE id = ?`
        : 'UPDATE scenes SET name = ?, background_fit = ? WHERE id = ?',
      imageData
        ? [sceneName, fit, String(imageData), String(imageMimeType ?? 'image/jpeg'), ...cropValues(payload), scene.id]
        : [sceneName, fit, scene.id]
    );
    await stampImageHash('scene', scene.id);
    emitScene('scene:updated', shapeScene(await one('SELECT * FROM scenes WHERE id = ?', [scene.id])));
    // The active Scene's own background may have just changed — the stage
    // carries a copy of that row, not a live join, so it needs its own push.
    const state = await one('SELECT active_scene_id FROM scene_state WHERE id = 1');
    if (state?.active_scene_id === scene.id) await emitStageUpdated();
  });

  on('scene:set_folder', async ({ sceneId, folderId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const scene = await one('SELECT * FROM scenes WHERE id = ?', [sceneId]);
    if (!scene) return;
    let target = null;
    if (folderId != null) {
      const folder = await one('SELECT id FROM scene_folders WHERE id = ?', [folderId]);
      if (folder) target = folder.id;
    }
    await run('UPDATE scenes SET folder_id = ? WHERE id = ?', [target, scene.id]);
    emitScene('scene:updated', shapeScene({ ...scene, folder_id: target }));
  });

  // **Copying a Scene shares the backdrop instead of duplicating it (decided,
  // new).** Only the picture and the name travel — `name (copy)`, same folder,
  // same background fit and thumbnail crop, which are how that picture is
  // framed rather than separate content. The prepared roster, the GM Notes,
  // the drawings and the Timestamp cue are deliberately NOT copied: a copy is
  // a fresh stage wearing the same backdrop.
  //
  // The bytes are shared rather than written twice — see scenes.image_source_id
  // in db.js. Backdrops are the largest thing this schema stores, so a copy
  // costs a row, not a picture.
  on('scene:copy', async ({ sceneId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const scene = await one('SELECT * FROM scenes WHERE id = ?', [sceneId]);
    if (!scene) return;
    // Point at the OWNER, never at another copy: copying a copy still lands one
    // hop from the bytes, so no chain can form to walk or to break.
    const owner = scene.image_data != null ? scene.id : scene.image_source_id;
    const result = await run(
      `INSERT INTO scenes (name, folder_id, background_fit, image_mime_type, image_hash,
                           image_source_id, crop_x, crop_y, crop_w, crop_h)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${scene.name} (copy)`,
        scene.folder_id,
        scene.background_fit,
        scene.image_mime_type,
        scene.image_hash,
        owner ?? null,
        scene.crop_x,
        scene.crop_y,
        scene.crop_w,
        scene.crop_h,
      ]
    );
    // The Combat map's grid and background come along (Panic at the Dojo). The
    // map picture is copied as bytes: it has no shared-owner scheme of its own.
    await run(
      `UPDATE scenes SET grid_size = ?, grid_offset_x = ?, grid_offset_y = ?, grid_opacity = ?,
         combat_image_data = ?, combat_image_mime_type = ?, combat_image_hash = ? WHERE id = ?`,
      [
        scene.grid_size ?? 70,
        scene.grid_offset_x ?? 0,
        scene.grid_offset_y ?? 0,
        scene.grid_opacity ?? 0.6,
        scene.combat_image_data ?? null,
        scene.combat_image_mime_type ?? null,
        scene.combat_image_hash ?? null,
        Number(result.lastInsertRowid),
      ]
    );
    emitScene(
      'scene:created',
      shapeScene(await one('SELECT * FROM scenes WHERE id = ?', [Number(result.lastInsertRowid)]))
    );
  });

  on('scene:delete', async ({ sceneId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const scene = await one('SELECT * FROM scenes WHERE id = ?', [sceneId]);
    if (!scene) return;
    // **Hand the backdrop on before deleting the Scene that owns it.** Copies
    // borrow these bytes (scenes.image_source_id); the column's own
    // ON DELETE SET NULL would leave every one of them holding a hash and no
    // picture. So one dependent inherits the bytes and the rest are repointed
    // at it — deleting an original never blanks its copies, and the picture is
    // still stored exactly once.
    if (scene.image_data != null) {
      const heirs = await all('SELECT id FROM scenes WHERE image_source_id = ?', [scene.id]);
      if (heirs.length) {
        const [heir, ...rest] = heirs;
        await run(
          'UPDATE scenes SET image_data = ?, image_mime_type = ?, image_hash = ?, image_source_id = NULL WHERE id = ?',
          [scene.image_data, scene.image_mime_type, scene.image_hash, heir.id]
        );
        if (rest.length) {
          await writeMany(
            rest.map((r) => ['UPDATE scenes SET image_source_id = ? WHERE id = ?', [heir.id, r.id]])
          );
        }
        // Their URLs just changed owner, so every client needs the new one.
        for (const r of [heir, ...rest]) {
          emitScene('scene:updated', shapeScene(await one('SELECT * FROM scenes WHERE id = ?', [r.id])));
        }
      }
    }
    const state = await one('SELECT active_scene_id FROM scene_state WHERE id = 1');
    const wasActive = state?.active_scene_id === scene.id;
    // Explicit, matching every other delete in this file. scene_state's own
    // FK is ON DELETE SET NULL (already correct), but nothing here trusts
    // the DDL alone. Same for scene_notes'/scene_summons'/scene_drawings'
    // own ON DELETE CASCADE — deleting a Scene takes its own prepared
    // roster and every stroke drawn on it with it, which is exactly what
    // "scene-specific" (scene_summons.scene_id) means.
    await run('UPDATE scene_state SET active_scene_id = NULL WHERE active_scene_id = ?', [scene.id]);
    await run('DELETE FROM scene_notes WHERE scene_id = ?', [scene.id]);
    await run('DELETE FROM fights WHERE scene_id = ?', [scene.id]);
    await run('DELETE FROM map_tiles WHERE scene_id = ?', [scene.id]);
    await run('DELETE FROM combatants WHERE scene_id = ?', [scene.id]);
    await run('DELETE FROM scene_summons WHERE scene_id = ?', [scene.id]);
    await run('DELETE FROM scene_drawings WHERE scene_id = ?', [scene.id]);
    await run('DELETE FROM scenes WHERE id = ?', [scene.id]);
    io.emit('scene:deleted', { sceneId: scene.id });
    if (wasActive) await emitStageUpdated();
  });

  // The force-navigate signal (decision #3): every switch cuts every
  // connected client to /scene, including the very first activation of the
  // session (active_scene_id starts NULL). `sceneId: null` is accepted too
  // — deactivating leaves scene_state consistent with scene:delete's own
  // ON DELETE SET NULL, but deliberately has nothing in the client that
  // navigates anyone anywhere for it (there is no scene to cut to).
  on('scene:activate', async ({ sceneId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    let target = null;
    let cue = null;
    if (sceneId != null) {
      const scene = await one('SELECT id, timestamp_id FROM scenes WHERE id = ?', [sceneId]);
      if (!scene) return;
      target = scene.id;
      cue = scene.timestamp_id ?? null;
    }
    await run('UPDATE scene_state SET active_scene_id = ? WHERE id = 1', [target]);
    await emitStageUpdated();

    // **A Scene that cues a Timestamp plays it on activation (decided, new).**
    //
    // Two decisions taken deliberately and worth not re-litigating:
    //
    //  - **Every activation fires it**, including re-activating the Scene that
    //    is already live. Activating is a deliberate GM action, so it doubles as
    //    a way to re-play the beat without opening the Timestamp dialog.
    //  - **It does NOT touch `is_current`.** The star is the GM's own marker for
    //    where the campaign sits and stays theirs to move; cueing a beat from a
    //    backdrop is a presentation act, not a statement about the timeline.
    //
    // Emitted after the stage so a client has the new backdrop before the card
    // fades over it, and through the same `io.emit` of date/subtext only that
    // `stage:timestamp_play` uses — never the id — so this adds no new way for a
    // Player to learn anything about the list.
    if (cue != null) {
      const ts = await one('SELECT date, subtext FROM scene_timestamps WHERE id = ?', [cue]);
      if (ts) io.emit('stage:timestamp_played', { date: ts.date, subtext: ts.subtext });
    }
  });

  // Summoning (Phase 5) — the payload is deliberately just { scenePictureId
  // }, never an owner id: the server resolves the picture's own owner and
  // derives everything else from that, so a client can't summon under one
  // identity while claiming another. Three invariants this handler exists
  // to make unforgeable:
  //   1. `side` comes from `identity.role`, never the payload — a GM's
  //      summons always land 'right', a Player's always 'left'.
  //   2. Ownership is the exact mayWriteScenePicture gate: GM may summon
  //      any Temp NPC or real NPC; a Player only their own character.
  //   3. **`scene_id` is always the currently ACTIVE Scene, read server-side
  //      — never a client-claimed one (decided, revised).** Summons are
  //      scene-specific now (see scene_summons' own comment in db.js: a GM
  //      preparing a Scene's roster in advance shouldn't have it bleed into
  //      whichever Scene is actually live) — refused outright with no
  //      active Scene, since there is nothing to pin a summon to yet.
  // Selecting the same picture that's already showing un-summons (decision
  // #4's toggle); a different picture swaps in place — side and
  // created_at both untouched, so a swap never reorders the stage. This is
  // the ONLY way to clear a seat (decision #6) — there is deliberately no
  // separate "remove from stage" write (the on-stage "x" button, Client-
  // side, just re-emits this with the summon's own current picture). A GM
  // may summon any Temp NPC or real character (mayWriteScenePicture's own
  // GM-always-may branch), so re-selecting in their own drawer clears
  // anyone's seat, PC included; a Player un-summons the same way, scoped to
  // just their own character.
  on('stage:summon', async ({ scenePictureId }) => {
    const viewer = socket.data.identity;
    if (!viewer) return;
    const state = await one('SELECT active_scene_id FROM scene_state WHERE id = 1');
    if (!state?.active_scene_id) return;
    const picture = await one('SELECT * FROM scene_pictures WHERE id = ?', [scenePictureId]);
    if (!picture) return;
    const ownerType = picture.character_id != null ? 'character' : 'temp_npc';
    const ownerId = picture.character_id ?? picture.temp_npc_id;
    if (!mayWriteScenePicture(viewer, ownerType, ownerId)) return;

    const side = viewer.role === 'gm' ? 'right' : 'left';
    const ownerColumn = ownerType === 'character' ? 'character_id' : 'temp_npc_id';
    const existing = await one(`SELECT * FROM scene_summons WHERE scene_id = ? AND ${ownerColumn} = ?`, [
      state.active_scene_id,
      ownerId,
    ]);

    if (!existing) {
      await run(
        `INSERT INTO scene_summons (scene_id, ${ownerColumn}, scene_picture_id, side) VALUES (?, ?, ?, ?)`,
        [state.active_scene_id, ownerId, picture.id, side]
      );
    } else if (existing.scene_picture_id === picture.id) {
      await dropSummonFightState([existing.id]);
      await run('DELETE FROM scene_summons WHERE id = ?', [existing.id]);
    } else {
      await run('UPDATE scene_summons SET scene_picture_id = ? WHERE id = ?', [picture.id, existing.id]);
    }
    await emitStageUpdated();
  });

  // Manual drag-to-place and resize — the same ownership gate stage:summon
  // itself uses (GM may move/resize any summon; a Player only their own
  // character's; nobody but the GM may touch a Temp NPC's), resolved off the
  // SUMMON's own owner rather than trusting a client-claimed id. Committed
  // once per gesture (on release), never mid-drag — stage:updated is an
  // unscoped io.emit to every connected socket, so a client streaming every
  // pointermove here would re-render the whole table's screens 60x/second
  // for a drag only one of them can see move live anyway.
  on('stage:reposition_summon', async ({ summonId, posX, posY }) => {
    const viewer = socket.data.identity;
    const summon = await one('SELECT * FROM scene_summons WHERE id = ?', [summonId]);
    if (!viewer || !summon) return;
    const ownerType = summon.character_id != null ? 'character' : 'temp_npc';
    const ownerId = summon.character_id ?? summon.temp_npc_id;
    if (!mayWriteScenePicture(viewer, ownerType, ownerId)) return;
    await run('UPDATE scene_summons SET pos_x = ?, pos_y = ? WHERE id = ?', [
      clamp(Number(posX), SUMMON_POS_MIN, SUMMON_POS_MAX),
      clamp(Number(posY), SUMMON_POS_MIN, SUMMON_POS_MAX),
      summon.id,
    ]);
    await emitStageUpdated();
  });

  // **The Scene / Simple Combat / Combat toggle — GM only.** Applies to the
  // active Scene; every viewer's page follows through stage:updated.
  on('scene:set_mode', async ({ mode }) => {
    if (socket.data.identity?.role !== 'gm' || !SCENE_MODES.has(mode)) return;
    const state = await one('SELECT active_scene_id FROM scene_state WHERE id = 1');
    if (!state?.active_scene_id) return;
    await run('UPDATE scenes SET combat_mode = ? WHERE id = ?', [mode, state.active_scene_id]);
    await emitStageUpdated();
  });

  // **Simple Combat: move a miniature to a lane space (0-9), or to the tray
  // (`null`, GM only).** Same ownership rule as dragging a figure. The whole
  // lane is saved at once (moveOnLane), so the packed positions everyone was
  // standing in become explicit and nobody shifts when one fighter moves; an
  // occupied target swaps its occupant into the mover's old place.
  on('lane:move', async ({ summonId, slot }) => {
    const viewer = socket.data.identity;
    const summon = await one('SELECT * FROM scene_summons WHERE id = ?', [Number(summonId)]);
    // Temp NPCs never stand on the lane (decided).
    if (!viewer || !summon || summon.character_id == null) return;
    if (!mayWriteScenePicture(viewer, 'character', summon.character_id)) return;
    const target = slot == null ? null : Number(slot);
    const lanes = await readSimpleLanes();
    if (target === null ? viewer.role !== 'gm' : !(Number.isInteger(target) && target >= 0 && target < laneCapacity(lanes))) return;
    const rows = await all('SELECT id, lane_slot FROM scene_summons WHERE scene_id = ? AND character_id IS NOT NULL ORDER BY id', [summon.scene_id]);
    const next = moveOnLane(packLane(rows, lanes), summon.id, target);
    await writeMany([...next].map(([id, s]) => ['UPDATE scene_summons SET lane_slot = ? WHERE id = ?', [s ?? TRAY, id]]));
    await emitStageUpdated();
  });

  // **Table settings (GM).** Simple Combat's lane count, for everyone.
  // Also the lanes' height (laneY, a share of the stage height; null resets).
  on('table_settings:set', async ({ simpleLanes, laneY }) => {
    if (socket.data.identity?.role !== 'gm' || (simpleLanes === undefined && laneY === undefined)) return;
    if (simpleLanes !== undefined) await run('UPDATE table_settings SET simple_lanes = ? WHERE id = 1', [clampLanes(simpleLanes)]);
    if (laneY !== undefined) await run('UPDATE table_settings SET lane_y = ? WHERE id = 1', [laneY === null ? null : clampLaneY(laneY)]);
    io.emit('table_settings:updated', await readTableSettings());
    await emitStageUpdated();
  });

  on('stage:resize_summon', async ({ summonId, scale }) => {
    const viewer = socket.data.identity;
    const summon = await one('SELECT * FROM scene_summons WHERE id = ?', [summonId]);
    if (!viewer || !summon) return;
    const ownerType = summon.character_id != null ? 'character' : 'temp_npc';
    const ownerId = summon.character_id ?? summon.temp_npc_id;
    if (!mayWriteScenePicture(viewer, ownerType, ownerId)) return;
    await run('UPDATE scene_summons SET scale = ? WHERE id = ?', [clamp(Number(scale), 0.25, 4), summon.id]);
    await emitStageUpdated();
  });

  // Hidden (decided, new) — GM-only regardless of ownership, unlike every
  // other stage write above: this is a narrative control the GM exercises
  // over the whole table, not a "may I edit my own character" permission,
  // so it deliberately does NOT go through mayWriteScenePicture. The write
  // itself is a plain toggle; what actually keeps a hidden summon secret is
  // stagePayloadFor filtering it out of every non-GM emitStageUpdated()
  // payload above, not anything client-side.
  on('stage:toggle_hidden', async ({ summonId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const summon = await one('SELECT * FROM scene_summons WHERE id = ?', [summonId]);
    if (!summon) return;
    await run('UPDATE scene_summons SET is_hidden = ? WHERE id = ?', [summon.is_hidden ? 0 : 1, summon.id]);
    await emitStageUpdated();
  });

  // Scene drawings (decided, new) — open to BOTH roles (a Player may draw
  // and erase exactly like a GM), the opposite trust model from GM Notes
  // just below: nothing here is secret, and nothing here is scoped to an
  // owner the way stage:summon's own writes are. `scene_id` is resolved
  // server-side off the active Scene, same pattern stage:summon already
  // established — never client-claimed, and refused outright with no
  // active Scene (nothing to pin a stroke to). Points are validated and
  // capped rather than trusted verbatim: a malformed or absurdly long array
  // from a misbehaving client should not be able to bloat the table or
  // break every other viewer's own canvas replay.
  const MAX_DRAWING_POINTS = 4000;
  on('scene_draw:add', async ({ points, color, width, isEraser }) => {
    const viewer = socket.data.identity;
    if (!viewer) return;
    const state = await one('SELECT active_scene_id FROM scene_state WHERE id = 1');
    if (!state?.active_scene_id) return;
    if (!Array.isArray(points) || points.length < 2 || points.length > MAX_DRAWING_POINTS) return;
    // **Four decimals, not full double precision (bandwidth).** These are
    // fractions of the stage, so the fourth decimal is a ten-thousandth of the
    // canvas — far finer than a pixel on any screen, and invisible on every
    // one. Stored verbatim they serialise as `0.43212345678901234`, ~41 bytes
    // per point against a 4000-point cap, and the whole accumulated set used
    // to be re-sent on every stage change. Rounding costs nothing visible and
    // takes roughly two thirds off every stroke, stored and broadcast alike.
    const round4 = (n) => Math.round(n * 10000) / 10000;
    const cleanPoints = points.map((p) => [
      round4(clamp(Number(p?.[0]), 0, 1)),
      round4(clamp(Number(p?.[1]), 0, 1)),
    ]);
    if (cleanPoints.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return;
    const result = await run(
      'INSERT INTO scene_drawings (scene_id, points, color, width, is_eraser) VALUES (?, ?, ?, ?, ?)',
      [
        state.active_scene_id,
        JSON.stringify(cleanPoints),
        typeof color === 'string' && color ? color.slice(0, 32) : '#ef4444',
        clamp(Number(width) || 0.01, 0.001, 0.2),
        isEraser ? 1 : 0,
      ]
    );
    // **The one new stroke, not the whole stage (bandwidth).** This handler
    // used to call emitStageUpdated(), which rebuilds the ENTIRE stage — the
    // scene backdrop, every summoned figure's picture, and every stroke ever
    // drawn — and sends it to every connected socket. Measured at ~600KB per
    // pen stroke, per viewer: a single sketch could run to a gigabyte across a
    // table. A stroke is append-only by nature (see db.js's note on why an
    // eraser is a stroke too, not a deletion), so a delta is not merely
    // cheaper here, it is the honest shape.
    io.emit('scene_draw:added', {
      id: Number(result.lastInsertRowid),
      points: cleanPoints,
      color: typeof color === 'string' && color ? color.slice(0, 32) : '#ef4444',
      width: clamp(Number(width) || 0.01, 0.001, 0.2),
      is_eraser: isEraser ? 1 : 0,
    });
  });

  // The eraser's "double-press" gesture — wipes every stroke on the active
  // Scene, regardless of who drew it (there is no author column to filter
  // by even if this wanted to — see db.js's own comment on scene_drawings).
  // Deliberately not GM-gated: the whole feature is a shared, anonymous
  // tool by design, so the ability to clear it is shared too.
  on('scene_draw:clear', async () => {
    if (!socket.data.identity) return;
    const state = await one('SELECT active_scene_id FROM scene_state WHERE id = 1');
    if (!state?.active_scene_id) return;
    await run('DELETE FROM scene_drawings WHERE scene_id = ?', [state.active_scene_id]);
    // Its own event too, for the same reason as scene_draw:added above.
    io.emit('scene_draw:cleared', {});
  });

  // GM Notes (decided, new) — see the tables' own comment in db.js for why
  // these are genuinely GM-secret rather than merely GM-managed: every
  // handler here is GM-only, server-enforced (not just hidden client-side),
  // and every broadcast goes through emitToGm, never io.emit.
  on('scene_note:create', async ({ sceneId, title, body }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const scene = await one('SELECT id FROM scenes WHERE id = ?', [sceneId]);
    if (!scene) return;
    const result = await run('INSERT INTO scene_notes (scene_id, title, body) VALUES (?, ?, ?)', [
      scene.id,
      String(title ?? ''),
      String(body ?? ''),
    ]);
    emitToGm('scene_note:created', await one('SELECT * FROM scene_notes WHERE id = ?', [Number(result.lastInsertRowid)]));
  });

  on('scene_note:update', async ({ noteId, title, body }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const note = await one('SELECT id FROM scene_notes WHERE id = ?', [noteId]);
    if (!note) return;
    await run('UPDATE scene_notes SET title = ?, body = ? WHERE id = ?', [
      String(title ?? ''),
      String(body ?? ''),
      note.id,
    ]);
    emitToGm('scene_note:updated', await one('SELECT * FROM scene_notes WHERE id = ?', [note.id]));
  });

  on('scene_note:delete', async ({ noteId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const note = await one('SELECT id FROM scene_notes WHERE id = ?', [noteId]);
    if (!note) return;
    await run('DELETE FROM scene_notes WHERE id = ?', [note.id]);
    emitToGm('scene_note:deleted', { noteId: note.id });
  });

  // The Master Note is a singleton (id=1, seeded at boot — see db.js) —
  // update only, never create/delete.
  on('master_note:update', async ({ body }) => {
    if (socket.data.identity?.role !== 'gm') return;
    await run('UPDATE master_note SET body = ? WHERE id = 1', [String(body ?? '')]);
    emitToGm('master_note:updated', await one('SELECT * FROM master_note WHERE id = 1'));
  });

  // Timestamps (decided, new) — see db.js's own comment on scene_timestamps
  // for why management is GM-secret (emitToGm, exactly like GM Notes above)
  // while playing one is not. Global, not Scene-scoped — no scene lookup or
  // scene_id to carry, unlike scene_note:create above. `date` is stored
  // exactly as the client's own `<input type="date">` sends it
  // (`'YYYY-MM-DD'`, or `''` if left blank) — no server-side reformatting,
  // since that same string is both what sorts correctly (the REST read's
  // own `ORDER BY date` above) and what the client's own
  // formatTimestampDate turns into "May 12, 2015" for display.
  on('scene_timestamp:create', async ({ name, date, subtext }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const result = await run(
      'INSERT INTO scene_timestamps (name, date, subtext) VALUES (?, ?, ?)',
      [String(name ?? ''), String(date ?? ''), String(subtext ?? '')]
    );
    emitToGm(
      'scene_timestamp:created',
      await one('SELECT * FROM scene_timestamps WHERE id = ?', [Number(result.lastInsertRowid)])
    );
  });

  on('scene_timestamp:update', async ({ timestampId, name, date, subtext }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const ts = await one('SELECT id FROM scene_timestamps WHERE id = ?', [timestampId]);
    if (!ts) return;
    await run('UPDATE scene_timestamps SET name = ?, date = ?, subtext = ? WHERE id = ?', [
      String(name ?? ''),
      String(date ?? ''),
      String(subtext ?? ''),
      ts.id,
    ]);
    emitToGm('scene_timestamp:updated', await one('SELECT * FROM scene_timestamps WHERE id = ?', [ts.id]));
  });

  on('scene_timestamp:delete', async ({ timestampId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const ts = await one('SELECT id FROM scene_timestamps WHERE id = ?', [timestampId]);
    if (!ts) return;
    await run('DELETE FROM scene_timestamps WHERE id = ?', [ts.id]);
    emitToGm('scene_timestamp:deleted', { timestampId: ts.id });
  });

  // **"Current" (decided, new) — at most ONE row may carry it, an
  // exclusivity enforced here, never left for the client to keep straight
  // across two separate writes.** Clears every row's flag first, then sets
  // it on the target — UNLESS the target already carried it, which reads
  // as "un-star the current one" (a toggle, not a one-way pin) rather than
  // requiring a separate "clear" action. `currentId` in the broadcast is
  // the new current row's id, or `null` if the toggle turned it off
  // entirely — either way it's the one thing every other GM tab's own copy
  // of the list needs to patch itself without a full refetch.
  on('scene_timestamp:set_current', async ({ timestampId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const ts = await one('SELECT id, is_current FROM scene_timestamps WHERE id = ?', [timestampId]);
    if (!ts) return;
    await run('UPDATE scene_timestamps SET is_current = 0');
    const nextCurrentId = ts.is_current ? null : ts.id;
    if (nextCurrentId != null) {
      await run('UPDATE scene_timestamps SET is_current = 1 WHERE id = ?', [nextCurrentId]);
    }
    emitToGm('scene_timestamp:current_changed', { currentId: nextCurrentId });
  });

  // **The one Timestamp write that is NOT GM-secret.** Resolves the played
  // row server-side from `timestampId` (never trusting client-sent display
  // text) and broadcasts only its `date`/`subtext` to EVERY connected
  // socket — a Player never gets to enumerate the rest of the list, just
  // whichever one the GM actually played, same as everyone seeing a Scene
  // activate without a Player getting to browse the Scene list itself.
  on('stage:timestamp_play', async ({ timestampId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    const ts = await one('SELECT * FROM scene_timestamps WHERE id = ?', [timestampId]);
    if (!ts) return;
    io.emit('stage:timestamp_played', { date: ts.date, subtext: ts.subtext });
  });

  // **Replace one stored picture with a smaller encoding of itself (GM only).**
  //
  // The counterpart of /api/image-inventory: the browser fetches a picture,
  // re-encodes it to WebP on a canvas, and hands the result back here. Doing it
  // client-side is what keeps the server free of an image library for work that
  // only needs doing once — and it is the only way to reach the live database
  // without handing anybody a set of Turso credentials.
  //
  // Writes the three image columns and nothing else, through the same registry
  // the read route uses, so it cannot touch a column it was not meant to. The
  // mime is allow-listed on the way in like every other image write.
  on('image:reencode', async ({ kind, id, imageData, imageMimeType } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const spec = imageSpec(kind);
    const rowId = Number(id);
    const data = typeof imageData === 'string' && imageData ? imageData : null;
    if (!spec || !Number.isInteger(rowId) || !data) return;
    const existing = await one(`SELECT LENGTH(${spec.data}) AS bytes FROM ${spec.table} WHERE id = ?`, [rowId]);
    if (!existing) return;
    // **Never make a picture bigger.** A re-encode that came out worse than the
    // original — a tiny image where WebP's header dominates, a photograph
    // already saved at a lower quality — is refused rather than stored, so the
    // tool can only ever shrink the database.
    if (data.length >= (existing.bytes ?? 0)) {
      socket.emit('image:reencoded', { kind, id: rowId, skipped: 'not-smaller', bytes: existing.bytes });
      return;
    }
    await run(
      `UPDATE ${spec.table} SET ${spec.data} = ?, ${spec.mime} = ?, ${spec.hash} = ? WHERE id = ?`,
      [data, sanitizeImageMime(imageMimeType, 'image/webp'), hashImageData(data), rowId]
    );
    // **Carry the new hash to anything borrowing this picture.** A copied Scene
    // stores the owner's hash on its own row (scenes.image_source_id) and its
    // URL is built from it, so re-encoding the owner without this leaves every
    // copy pointing at a hash that no longer matches. The picture would still
    // be served — `/api/img` recomputes the true hash — but only with
    // `no-store`, so it would never be cached again, which is the opposite of
    // what the re-encode tool is for.
    if (kind === 'scene') {
      const heirs = await all('SELECT id FROM scenes WHERE image_source_id = ?', [rowId]);
      if (heirs.length) {
        await writeMany(
          heirs.map((h) => [
            'UPDATE scenes SET image_hash = ?, image_mime_type = ? WHERE id = ?',
            [hashImageData(data), sanitizeImageMime(imageMimeType, 'image/webp'), h.id],
          ])
        );
        for (const h of heirs) {
          emitScene('scene:updated', shapeScene(await one('SELECT * FROM scenes WHERE id = ?', [h.id])));
        }
      }
    }
    socket.emit('image:reencoded', { kind, id: rowId, was: existing.bytes, now: data.length });
  });

  // ======================================================== Audio Player
  //
  // **The clock handshake — the only audio event a Player may send.** Stateless,
  // ungated, no database: it answers with the server's own `Date.now()` so a
  // client can measure the offset between its clock and this one. Device clocks
  // are wrong by arbitrary amounts (minutes, on a phone that has not synced),
  // and every client computes its playback position from a server instant, so
  // this is load-bearing rather than a nicety. See clockOffset in
  // server/audioSync.js for what the client does with several of these.
  on('audio:ping', ({ t0 } = {}) => {
    socket.emit('audio:pong', { t0, serverMs: Date.now() });
  });

  // **Duration is reported by clients because only YouTube knows it.** There is
  // no server-side way to learn how long a video is without an API key, and the
  // first client to load it has the answer for free. Used for the end-of-track
  // safety timer and to show a length in the panel; never trusted for anything
  // that would misbehave if a client lied (see armTrackEndTimer's own bounds).
  on('audio:duration', async ({ trackId, durationMs } = {}) => {
    const id = Number(trackId);
    const ms = Math.round(Number(durationMs));
    // **The floor and the max() are both about pre-roll ads.** A client sitting
    // through an advert reports the ADVERT's length — fifteen seconds for a
    // four-minute song — and taking that at face value would arm the
    // end-of-track timer to skip the song almost immediately. Keeping the
    // largest report ever seen is self-correcting: the first client past the ad
    // supplies the real length and it wins permanently, in whichever order the
    // two reports arrive.
    if (!Number.isInteger(id) || !Number.isFinite(ms) || ms < 5000) return;
    const track = await one('SELECT id, duration_ms FROM audio_tracks WHERE id = ?', [id]);
    if (!track || (track.duration_ms ?? 0) >= ms) return;
    await run('UPDATE audio_tracks SET duration_ms = ? WHERE id = ?', [ms, id]);
    const state = await one(AUDIO_STATE_SQL);
    // Learning the length of the song that is playing right now is exactly when
    // the safety timer becomes armable.
    if (state?.track_id === id) armTrackEndTimer(await getAudioPayload());
    emitToGm('audio_track:updated', await one('SELECT * FROM audio_tracks WHERE id = ?', [id]));
  });

  // **A track ended.** Every client that was playing reports this; the
  // `anchorId` guard means the first one advances and the rest are no-ops, so
  // six people in the session do not skip six songs.
  on('audio:track_ended', async ({ trackId, anchorId } = {}) => {
    const state = await one(AUDIO_STATE_SQL);
    if (!state || !state.is_playing) return;
    if (Number(anchorId) !== state.anchor_id) return; // a stale client, from before the last change
    if (Number(trackId) !== state.track_id) return;
    await advance(1, true);
  });

  // **A track that cannot play anywhere skips itself.** YouTube refuses embeds
  // for all sorts of reasons a GM cannot see when they paste the link — the
  // uploader disabled embedding (101/150), the video is private or gone (100),
  // the id is malformed (2). Without this the table sits in silence waiting for
  // a song that will never start, and nobody can tell why.
  //
  // Acted on the FIRST report from any client rather than a majority: a track
  // one person at the table cannot hear has already broken the premise of a
  // shared soundtrack. The anchorId guard makes the other reports no-ops, and
  // the GM is told which song was skipped and why.
  on('audio:error', async ({ trackId, anchorId, code } = {}) => {
    const state = await one(AUDIO_STATE_SQL);
    if (!state || Number(anchorId) !== state.anchor_id || Number(trackId) !== state.track_id) return;
    const fatal = [2, 100, 101, 150].includes(Number(code));
    if (!fatal) return; // code 5 and friends are transient; the client retries them itself
    const track = await one('SELECT * FROM audio_tracks WHERE id = ?', [state.track_id]);
    emitToGm('audio:track_unplayable', { trackId: state.track_id, name: track?.name ?? null, code: Number(code) });
    await advance(1, true);
  });

  // ---- everything below is GM-only ----

  // Playlists and tracks are GM furniture: a Player never sees the library,
  // only whatever is currently playing. So management broadcasts with
  // emitToGm, exactly like Scene Notes and Timestamps.
  on('audio_playlist:create', async ({ name } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const clean = String(name ?? '').trim().slice(0, 120) || 'New playlist';
    const result = await run('INSERT INTO audio_playlists (name) VALUES (?)', [clean]);
    emitToGm(
      'audio_playlist:created',
      await one('SELECT * FROM audio_playlists WHERE id = ?', [Number(result.lastInsertRowid)])
    );
  });

  on('audio_playlist:rename', async ({ playlistId, name } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const list = await one('SELECT id FROM audio_playlists WHERE id = ?', [playlistId]);
    if (!list) return;
    const clean = String(name ?? '').trim().slice(0, 120);
    if (!clean) return;
    await run('UPDATE audio_playlists SET name = ? WHERE id = ?', [clean, list.id]);
    emitToGm('audio_playlist:updated', await one('SELECT * FROM audio_playlists WHERE id = ?', [list.id]));
  });

  // **Deleting the playlist that is playing stops the music.** The tracks go
  // with it (ON DELETE CASCADE), so there is nothing left to advance to — and
  // silently jumping to some other playlist's song would be a stranger outcome
  // than silence.
  on('audio_playlist:delete', async ({ playlistId } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const list = await one('SELECT id FROM audio_playlists WHERE id = ?', [playlistId]);
    if (!list) return;
    const state = await one(AUDIO_STATE_SQL);
    const playingHere = state?.track_id
      ? await one('SELECT id FROM audio_tracks WHERE id = ? AND playlist_id = ?', [state.track_id, list.id])
      : null;
    await run('DELETE FROM audio_playlists WHERE id = ?', [list.id]);
    emitToGm('audio_playlist:deleted', { playlistId: list.id });
    if (playingHere) await startTrack(null);
  });

  // **The name YouTube gives the video is a suggestion, never a requirement.**
  // Fetched server-side because a browser fetch to youtube.com would be refused
  // by CORS, and through oEmbed because it needs no API key and no quota. A
  // failure is answered rather than swallowed, so the dialog can just leave the
  // field blank and let the GM type — looking up a title must never be the
  // thing that stops a song being saved.
  on('audio:lookup_title', async ({ url } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const youtubeId = parseYouTubeId(url);
    if (!youtubeId) {
      socket.emit('audio:title', { url, youtubeId: null, title: null, error: 'not-a-youtube-link' });
      return;
    }
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${youtubeId}`
        )}&format=json`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (!res.ok) throw new Error(`oembed answered ${res.status}`);
      const data = await res.json();
      socket.emit('audio:title', { url, youtubeId, title: String(data?.title ?? '').slice(0, 200) });
    } catch (err) {
      socket.emit('audio:title', { url, youtubeId, title: null, error: err?.message ?? 'lookup failed' });
    }
  });

  on('audio_track:create', async ({ playlistId, name, url } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const list = await one('SELECT id FROM audio_playlists WHERE id = ?', [playlistId]);
    if (!list) return;
    const youtubeId = parseYouTubeId(url);
    // A row whose link does not resolve could never play, so it is refused at
    // the door rather than stored as a song that silently does nothing.
    if (!youtubeId) {
      socket.emit('audio_track:rejected', { playlistId: list.id, reason: 'not-a-youtube-link' });
      return;
    }
    const last = await one(
      'SELECT sort_order FROM audio_tracks WHERE playlist_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [list.id]
    );
    const result = await run(
      'INSERT INTO audio_tracks (playlist_id, name, youtube_id, sort_order) VALUES (?, ?, ?, ?)',
      [list.id, String(name ?? '').trim().slice(0, 200) || 'Untitled', youtubeId, (last?.sort_order ?? -1) + 1]
    );
    emitToGm(
      'audio_track:created',
      await one('SELECT * FROM audio_tracks WHERE id = ?', [Number(result.lastInsertRowid)])
    );
  });

  // **Renaming is live; re-linking restarts.** Changing the label of the song
  // that is playing must not interrupt it — the anchor is untouched and the
  // header just relabels. Changing the LINK is a different song by definition,
  // so it restarts from zero rather than dropping the listener into the middle
  // of something they never heard the start of.
  on('audio_track:update', async ({ trackId, name, url } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const track = await one('SELECT * FROM audio_tracks WHERE id = ?', [trackId]);
    if (!track) return;
    let youtubeId = track.youtube_id;
    if (url !== undefined && String(url).trim() !== '') {
      const parsed = parseYouTubeId(url);
      if (!parsed) {
        socket.emit('audio_track:rejected', { trackId: track.id, reason: 'not-a-youtube-link' });
        return;
      }
      youtubeId = parsed;
    }
    const nextName = name !== undefined ? String(name).trim().slice(0, 200) || track.name : track.name;
    const linkChanged = youtubeId !== track.youtube_id;
    await run(
      'UPDATE audio_tracks SET name = ?, youtube_id = ?, duration_ms = ? WHERE id = ?',
      [nextName, youtubeId, linkChanged ? null : track.duration_ms, track.id]
    );
    emitToGm('audio_track:updated', await one('SELECT * FROM audio_tracks WHERE id = ?', [track.id]));
    const state = await one(AUDIO_STATE_SQL);
    if (state?.track_id === track.id) {
      if (linkChanged) await startTrack(track.id, 0);
      else io.emit('audio:state', await getAudioPayload()); // relabel only, anchor untouched
    }
  });

  // **Deleting the playing song advances to the next one (decided).** The
  // replacement is chosen BEFORE the row goes away, because once it is gone
  // there is no playlist position left to reason from. `ON DELETE SET NULL` on
  // audio_state.track_id is the backstop if any path ever misses this.
  on('audio_track:delete', async ({ trackId } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const track = await one('SELECT * FROM audio_tracks WHERE id = ?', [trackId]);
    if (!track) return;
    const state = await one(AUDIO_STATE_SQL);
    const wasPlaying = state?.track_id === track.id;
    let replacement = null;
    if (wasPlaying) {
      const { tracks } = await tracksAround(track.id);
      replacement = nextTrackId({
        tracks: tracks.filter((t) => t.id !== track.id),
        currentId: track.id,
        repeatMode: state.repeat_mode,
        shuffle: Boolean(state.shuffle),
        shuffleSeed: state.shuffle_seed,
        direction: 1,
      });
    }
    await run('DELETE FROM audio_tracks WHERE id = ?', [track.id]);
    emitToGm('audio_track:deleted', { trackId: track.id, playlistId: track.playlist_id });
    if (wasPlaying) await startTrack(replacement, 0);
  });

  // **Move Up / Move Down send the whole new order, not a swap.** Same wire
  // format as move:reorder, for the same reason: the server never has to
  // reconstruct an intent from a delta, and two GMs reordering at once cannot
  // interleave into an order neither of them asked for.
  on('audio_track:reorder', async ({ playlistId, trackIds } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const list = await one('SELECT id FROM audio_playlists WHERE id = ?', [playlistId]);
    if (!list || !Array.isArray(trackIds)) return;
    const rows = await all('SELECT id FROM audio_tracks WHERE playlist_id = ? ORDER BY sort_order, id', [
      list.id,
    ]);
    const known = new Set(rows.map((r) => r.id));
    const sequence = [...new Set(trackIds.map(Number))].filter((id) => known.has(id));
    // Anything the client left out keeps its relative order at the end, so a
    // stale client cannot silently drop songs it had not heard about yet.
    for (const row of rows) if (!sequence.includes(row.id)) sequence.push(row.id);
    await writeMany(
      sequence.map((id, i) => ['UPDATE audio_tracks SET sort_order = ? WHERE id = ?', [i, id]])
    );
    emitToGm('audio_tracks:reordered', { playlistId: list.id, trackIds: sequence });
  });

  // ---- transport ----

  on('audio:play', async ({ trackId } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const track = await one('SELECT id FROM audio_tracks WHERE id = ?', [trackId]);
    if (!track) return;
    await startTrack(track.id, 0);
  });

  // Pause anchors the music where it ACTUALLY is by the server clock, not where
  // it started — which is what makes resume exact rather than approximate.
  on('audio:pause', async () => {
    if (socket.data.identity?.role !== 'gm') return;
    const state = await one(AUDIO_STATE_SQL);
    if (!state?.is_playing) return;
    await writeAudioState({ isPlaying: false, positionMs: livePositionMs(state), anchoredAtMs: Date.now() });
  });

  on('audio:resume', async () => {
    if (socket.data.identity?.role !== 'gm') return;
    const state = await one(AUDIO_STATE_SQL);
    if (!state || state.is_playing || !state.track_id) return;
    await writeAudioState({ isPlaying: true, anchoredAtMs: Date.now() });
  });

  on('audio:stop', async () => {
    if (socket.data.identity?.role !== 'gm') return;
    await startTrack(null);
  });

  on('audio:seek', async ({ positionMs } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const ms = Math.max(0, Math.round(Number(positionMs)));
    if (!Number.isFinite(ms)) return;
    const state = await one(AUDIO_STATE_SQL);
    if (!state?.track_id) return;
    await writeAudioState({ positionMs: ms, anchoredAtMs: Date.now() });
  });

  on('audio:next', async () => {
    if (socket.data.identity?.role !== 'gm') return;
    await advance(1, false);
  });

  // **Previous restarts the current track when it is more than three seconds
  // in.** Every media player on earth behaves this way and it is what a hand
  // reaches for — "take me back to the start of this" far more often than
  // "take me to the song before it".
  on('audio:previous', async () => {
    if (socket.data.identity?.role !== 'gm') return;
    const state = await one(AUDIO_STATE_SQL);
    if (state?.track_id && livePositionMs(state) > 3000) {
      await startTrack(state.track_id, 0);
      return;
    }
    await advance(-1, false);
  });

  // Changing shuffle re-seeds it, so turning it off and on again genuinely
  // reshuffles rather than replaying the same "random" order forever.
  on('audio:set_mode', async ({ repeatMode, shuffle } = {}) => {
    if (socket.data.identity?.role !== 'gm') return;
    const state = await one(AUDIO_STATE_SQL);
    if (!state) return;
    const patch = {};
    if (repeatMode !== undefined && ['off', 'playlist', 'track'].includes(repeatMode)) {
      patch.repeatMode = repeatMode;
    }
    if (shuffle !== undefined) {
      patch.shuffle = Boolean(shuffle);
      if (Boolean(shuffle) !== Boolean(state.shuffle)) patch.shuffleSeed = Math.floor(Math.random() * 2 ** 31);
    }
    if (!Object.keys(patch).length) return;
    // The anchor is carried forward untouched: changing shuffle or repeat must
    // never interrupt the song that is already playing.
    patch.positionMs = state.position_ms;
    patch.anchoredAtMs = state.anchored_at_ms;
    await writeAudioState(patch);
  });

  // --- the Compendium's shelf (GM) ---

  // --- what a character actually has ---

  const emitRoleplay = async (characterId) =>
    io.emit('roleplay:updated', { characterId, entries: await getRoleplay(characterId) });

  // Upsert the answer to one of the canonical (non-custom) questions
  on('roleplay:save_answer', async ({ characterId, question, answer }) => {
    const character = await getCharacter(characterId);
    const q = String(question ?? '').trim();
    if (!character || !q) return;
    const existing = await one(
      'SELECT * FROM roleplay_entries WHERE character_id = ? AND question = ? AND is_custom = 0',
      [character.id, q]
    );
    if (existing) {
      await run('UPDATE roleplay_entries SET answer = ? WHERE id = ?', [
        String(answer ?? ''),
        existing.id,
      ]);
    } else {
      await run(
        'INSERT INTO roleplay_entries (character_id, question, answer, is_custom) VALUES (?, ?, ?, 0)',
        [character.id, q, String(answer ?? '')]
      );
    }
    await emitRoleplay(character.id);
  });

  on('roleplay:add_question', async ({ characterId, question }) => {
    const character = await getCharacter(characterId);
    const q = String(question ?? '').trim();
    if (!character || !q) return;
    const custom = await one(
      'SELECT COUNT(*) AS count FROM roleplay_entries WHERE character_id = ? AND is_custom = 1',
      [character.id]
    );
    if (Number(custom.count) >= 20) return; // up to 20 additional questions
    await run(
      'INSERT INTO roleplay_entries (character_id, question, answer, is_custom) VALUES (?, ?, ?, 1)',
      [character.id, q, '']
    );
    await emitRoleplay(character.id);
  });

  on('roleplay:update_entry', async ({ entryId, question, answer }) => {
    const entry = await one('SELECT * FROM roleplay_entries WHERE id = ?', [entryId]);
    if (!entry) return;
    const q = entry.is_custom ? String(question ?? entry.question).trim() : entry.question;
    if (!q) return;
    await run('UPDATE roleplay_entries SET question = ?, answer = ? WHERE id = ?', [
      q,
      String(answer ?? ''),
      entry.id,
    ]);
    await emitRoleplay(entry.character_id);
  });

  on('roleplay:delete_question', async ({ entryId }) => {
    const entry = await one(
      'SELECT * FROM roleplay_entries WHERE id = ? AND is_custom = 1',
      [entryId]
    );
    if (!entry) return;
    await run('DELETE FROM roleplay_entries WHERE id = ?', [entry.id]);
    await emitRoleplay(entry.character_id);
  });

  // -------------------------------------------------------------------
  // Relationships board
  // -------------------------------------------------------------------
  //
  // Every handler starts with the same gate. There is no per-event variation
  // because there is no per-event rule: you may write a board if you own it or
  // you are the GM, full stop. A caller who is neither is dropped silently, the
  // way move:declare treats a declaration for a character it doesn't own.
  const mayWriteBoard = (ownerCharacterId) =>
    maySeeBoard(socket.data.identity, ownerCharacterId);

  // Node writes arrive by node id, not by board id, so the owner has to be
  // read back off the row before the gate can be applied — otherwise a caller
  // could move a node on somebody else's board by naming its id.
  const loadOwnedNode = async (nodeId) => {
    const node = await one('SELECT * FROM relationship_nodes WHERE id = ?', [nodeId]);
    if (!node || !mayWriteBoard(node.owner_character_id)) return null;
    return node;
  };

  // Half a node's width/height. Kept as a literal rather than imported from the
  // client's geometry module — the server has no business importing client code
  // — and pinned against NODE_W/NODE_H by relationshipGeometry.test.js so the
  // two cannot drift.
  const NODE_CENTER_OFFSET = 56;

  const clampText = (value, max) => String(value ?? '').slice(0, max);
  // A world coordinate. Bounded because the plane is infinite but a number is
  // not: a NaN or an Infinity here would put a node nowhere and take the whole
  // board's layout with it.
  const coord = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, n)) : 0;
  };

  on('relationships:add_node', async ({ characterId, targetCharacterId, personId, x, y }) => {
    if (!mayWriteBoard(characterId)) return;
    const owner = await getCharacter(characterId);
    if (!owner) return;
    // Exactly one source, matching the table's own CHECK. Asked here as well so
    // a malformed payload is a dropped event rather than a constraint error.
    const hasCharacter = targetCharacterId != null;
    const hasPerson = personId != null;
    if (hasCharacter === hasPerson) return;
    await pushUndo(owner.id);
    if (hasCharacter && !(await getCharacter(targetCharacterId))) return;
    if (hasPerson) {
      const person = await one(
        'SELECT id FROM relationship_people WHERE id = ? AND owner_character_id = ?',
        [personId, owner.id]
      );
      // A person belongs to one board. Placing somebody else's is not a thing.
      if (!person) return;
    }
    await run(
      `INSERT INTO relationship_nodes (owner_character_id, character_id, person_id, x, y)
       VALUES (?, ?, ?, ?, ?)`,
      [owner.id, hasCharacter ? Number(targetCharacterId) : null, hasPerson ? Number(personId) : null, coord(x), coord(y)]
    );
    await emitRelationships(owner.id);
  });

  // One write per drag, sent on pointerup. Nothing hits the DB mid-gesture.
  on('relationships:move_node', async ({ nodeId, x, y }) => {
    const node = await loadOwnedNode(nodeId);
    if (!node) return;
    await pushUndo(node.owner_character_id);
    await run('UPDATE relationship_nodes SET x = ?, y = ? WHERE id = ?', [coord(x), coord(y), node.id]);
    await emitRelationships(node.owner_character_id);
  });

  on('relationships:update_node', async ({ nodeId, nickname, notes }) => {
    const node = await loadOwnedNode(nodeId);
    if (!node) return;
    await pushUndo(node.owner_character_id);
    await run('UPDATE relationship_nodes SET nickname = ?, notes = ? WHERE id = ?', [
      clampText(nickname ?? node.nickname, 80),
      clampText(notes ?? node.notes, 8000),
      node.id,
    ]);
    await emitRelationships(node.owner_character_id);
  });

  // **The ✕ menu's two options.**
  //
  // `keepRelationships` leaves every line touching this node hanging exactly
  // where its portrait was: the last-known anchor is written into from_x/from_y
  // (or to_x/to_y) and the node reference nulled, in ONE statement per side, so
  // there is no instant where a row has neither an anchor nor a coordinate.
  // The line keeps its colour, its label and its arrowhead, and can be dragged
  // onto somebody else later.
  //
  // The loose end lands at the node's CENTRE rather than at the dot it was
  // attached to. The dot is a property of a portrait that no longer exists; the
  // middle of where that person used to be is the honest answer, and it is the
  // one place that reads the same for all four sides.
  on('relationships:delete_node', async ({ nodeId, keepRelationships }) => {
    const node = await loadOwnedNode(nodeId);
    if (!node) return;
    await pushUndo(node.owner_character_id);
    if (keepRelationships) {
      const cx = node.x + NODE_CENTER_OFFSET;
      const cy = node.y + NODE_CENTER_OFFSET;
      await run(
        `UPDATE relationship_edges SET from_node_id = NULL, from_x = ?, from_y = ? WHERE from_node_id = ?`,
        [cx, cy, node.id]
      );
      await run(
        `UPDATE relationship_edges SET to_node_id = NULL, to_x = ?, to_y = ? WHERE to_node_id = ?`,
        [cx, cy, node.id]
      );
    } else {
      await run('DELETE FROM relationship_edges WHERE from_node_id = ? OR to_node_id = ?', [
        node.id,
        node.id,
      ]);
    }
    await run('DELETE FROM relationship_nodes WHERE id = ?', [node.id]);
    await emitRelationships(node.owner_character_id);
  });

  // -------------------------------------------------------------------
  // Relationships: the lines
  // -------------------------------------------------------------------

  const SIDE_NAMES = new Set(['top', 'right', 'bottom', 'left']);
  const side = (value, fallback) => (SIDE_NAMES.has(value) ? value : fallback);

  // Both endpoints must be nodes on the SAME board — the board this caller may
  // write. Checked by reading them back rather than trusting the payload, the
  // same way loadOwnedNode does, so naming a node id from another board buys
  // nothing.
  on('relationships:add_edge', async ({ fromNodeId, fromSide, toNodeId, toSide }) => {
    const from = await loadOwnedNode(fromNodeId);
    const to = await loadOwnedNode(toNodeId);
    if (!from || !to) return;
    if (from.owner_character_id !== to.owner_character_id) return;
    // A line from somebody to themselves is a loop with nothing to say, and the
    // curve maths would have to special-case a zero-length span to draw it.
    if (from.id === to.id) return;
    await pushUndo(from.owner_character_id);
    await run(
      `INSERT INTO relationship_edges (owner_character_id, from_node_id, from_side, to_node_id, to_side)
       VALUES (?, ?, ?, ?, ?)`,
      [from.owner_character_id, from.id, side(fromSide, 'right'), to.id, side(toSide, 'left')]
    );
    await emitRelationships(from.owner_character_id);
  });

  const loadOwnedEdge = async (edgeId) => {
    const edge = await one('SELECT * FROM relationship_edges WHERE id = ?', [edgeId]);
    if (!edge || !mayWriteBoard(edge.owner_character_id)) return null;
    return edge;
  };

  // **Colour is user data that reaches a renderer.** It goes straight into an
  // SVG `stroke` and into a `<marker>` id, so it is the one field on this board
  // that is validated rather than merely clamped: a strict `#rrggbb`, and
  // anything else falls back to the column default rather than being stored.
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const DEFAULT_EDGE_COLOR = '#f87179';
  const colour = (value, fallback = DEFAULT_EDGE_COLOR) =>
    HEX.test(String(value ?? '')) ? String(value).toLowerCase() : fallback;

  const ARROWS = new Set(['none', 'from', 'to']);

  // **The hand-drawn arc, as a perpendicular offset.** Bounded for exactly the
  // reason `coord` is bounded: the plane is infinite and a number is not, and
  // one NaN here would take the line off the board entirely.
  //
  // `null` is a real value here and means "no hand bend" — the line goes back
  // to whatever the automatic fan gives it. That is distinct from the field
  // being absent, which like every other field on this event means "leave it
  // alone", so the three cases have to stay apart: undefined keeps, null
  // clears, a number sets.
  // **The hand-drawn arc, as two fractions of the line's own frame.** `bend` is
  // the control point's offset ACROSS the chord and `bendU` is where along it
  // that offset sits. Bounded for exactly the reason `coord` is bounded: the
  // plane is infinite and a number is not, and one NaN here would take the line
  // off the board entirely.
  const BEND_LIMIT = 4000;
  const BEND_U_LIMIT = 2;
  const bounded = (value, limit, fallback = null) => {
    // Explicitly, before Number() gets its hands on it: `Number(null)` is 0,
    // which is a perfectly finite number and would store "hand-bent, straight"
    // where the caller asked for "not hand-bent at all".
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(-limit, Math.min(limit, n));
  };

  // What a relationship SAYS, as opposed to where it is attached (move_end).
  // Every field is optional: the editor applies each control live, so a single
  // change sends a single field and everything else keeps its stored value.
  on('relationships:update_edge', async (payload) => {
    const { edgeId, label, color, arrow, retired, bend, bendU } = payload;
    const edge = await loadOwnedEdge(edgeId);
    if (!edge) return;
    await pushUndo(edge.owner_character_id);
    // **The two halves of a bend move together.** `bend: null` clears the whole
    // hand bend, so `bend_u` has to go with it or a later re-bend would inherit
    // a stale along-the-line position from an arc nobody can see any more.
    const clearing = bend === null;
    await run(
      `UPDATE relationship_edges SET label = ?, color = ?, arrow = ?, retired = ?, bend = ?, bend_u = ? WHERE id = ?`,
      [
        clampText(label ?? edge.label, 60),
        colour(color ?? edge.color, edge.color),
        // Validated here as well as by the column's CHECK so a bad value is a
        // dropped event rather than a thrown constraint — the same shape
        // `side()` uses for the four dot names.
        ARROWS.has(arrow) ? arrow : ARROWS.has(edge.arrow) ? edge.arrow : 'none',
        retired == null ? edge.retired : retired ? 1 : 0,
        bend === undefined ? edge.bend : bounded(bend, BEND_LIMIT),
        clearing ? null : bendU === undefined ? edge.bend_u : bounded(bendU, BEND_U_LIMIT, 0.5),
        edge.id,
      ]
    );
    await emitRelationships(edge.owner_character_id);
  });

  on('relationships:delete_edge', async ({ edgeId }) => {
    const edge = await loadOwnedEdge(edgeId);
    if (!edge) return;
    await pushUndo(edge.owner_character_id);
    await run('DELETE FROM relationship_edges WHERE id = ?', [edge.id]);
    await emitRelationships(edge.owner_character_id);
  });

  // Moving or re-attaching one end of a line. Both are the same write: an end
  // is either a node and a side, or a point in space, and this swaps between
  // them. `nodeId: null` drops it loose at (x, y); a node id picks it back up.
  on('relationships:move_end', async ({ edgeId, end, nodeId, side: toSide, x, y }) => {
    const edge = await loadOwnedEdge(edgeId);
    if (!edge || (end !== 'from' && end !== 'to')) return;
    let target = null;
    if (nodeId != null) {
      target = await loadOwnedNode(nodeId);
      if (!target || target.owner_character_id !== edge.owner_character_id) return;
      // Re-attaching an end onto the node the OTHER end already holds would
      // make the loop add_edge refuses to create, so it is refused here too.
      const otherNodeId = end === 'from' ? edge.to_node_id : edge.from_node_id;
      if (otherNodeId != null && Number(otherNodeId) === target.id) return;
    }
    await pushUndo(edge.owner_character_id);
    const columns =
      end === 'from'
        ? ['from_node_id', 'from_side', 'from_x', 'from_y']
        : ['to_node_id', 'to_side', 'to_x', 'to_y'];
    await run(
      `UPDATE relationship_edges SET ${columns[0]} = ?, ${columns[1]} = ?, ${columns[2]} = ?, ${columns[3]} = ? WHERE id = ?`,
      [
        target ? target.id : null,
        side(toSide, end === 'from' ? 'right' : 'left'),
        target ? null : coord(x),
        target ? null : coord(y),
        edge.id,
      ]
    );
    await emitRelationships(edge.owner_character_id);
  });

  on('relationships:create_person', async (payload) => {
    const { characterId, name, imageData, imageMimeType } = payload;
    if (!mayWriteBoard(characterId)) return;
    const owner = await getCharacter(characterId);
    const personName = clampText(name, 80).trim();
    // Name is the one mandatory field: a face with no name is not a person you
    // can think about, and the rail would show a blank row.
    if (!owner || !personName) return;
    await pushUndo(owner.id);
    await run(
      `INSERT INTO relationship_people (owner_character_id, name, image_data, image_mime_type, crop_x, crop_y, crop_w, crop_h)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner.id, personName, imageData ? String(imageData) : null, imageData ? String(imageMimeType ?? 'image/jpeg') : null,
        ...cropValues(payload)]
    );
    if (imageData) {
      const created = await one(
        'SELECT id FROM relationship_people WHERE owner_character_id = ? ORDER BY id DESC LIMIT 1',
        [owner.id]
      );
      await stampImageHash('person', created?.id);
    }
    await emitRelationships(owner.id);
  });

  on('relationships:update_person', async (payload) => {
    const { personId, name, imageData, imageMimeType } = payload;
    const person = await one('SELECT * FROM relationship_people WHERE id = ?', [personId]);
    if (!person || !mayWriteBoard(person.owner_character_id)) return;
    const personName = clampText(name ?? person.name, 80).trim();
    if (!personName) return;
    // An absent picture means "leave it alone", not "clear it" — the editor
    // only sends one when the file picker actually produced one.
    await pushUndo(person.owner_character_id);
    await run(
      imageData
        ? `UPDATE relationship_people SET name = ?, image_data = ?, image_mime_type = ?, ${CROP_COLUMNS} WHERE id = ?`
        : 'UPDATE relationship_people SET name = ? WHERE id = ?',
      imageData
        ? [personName, String(imageData), String(imageMimeType ?? 'image/jpeg'), ...cropValues(payload), person.id]
        : [personName, person.id]
    );
    if (imageData) await stampImageHash('person', person.id);
    await emitRelationships(person.owner_character_id);
  });

  // Deleting a person takes their placements with them — they are that person
  // and nothing else. Explicit, because ON DELETE actions cannot be relied on
  // here (see the tables' own note in db.js).
  on('relationships:delete_person', async ({ personId }) => {
    const person = await one('SELECT * FROM relationship_people WHERE id = ?', [personId]);
    if (!person || !mayWriteBoard(person.owner_character_id)) return;
    await pushUndo(person.owner_character_id);
    // Their lines go with them. Deleting the person is the one destructive
    // choice on the board that offers no "keep the relationships" option — the
    // ✕ menu on a node is where that choice lives, and this is a level above it.
    await run(
      `DELETE FROM relationship_edges WHERE from_node_id IN (SELECT id FROM relationship_nodes WHERE person_id = ?)
          OR to_node_id IN (SELECT id FROM relationship_nodes WHERE person_id = ?)`,
      [person.id, person.id]
    );
    await run('DELETE FROM relationship_nodes WHERE person_id = ?', [person.id]);
    await run('DELETE FROM relationship_people WHERE id = ?', [person.id]);
    await emitRelationships(person.owner_character_id);
  });

  // **Ctrl+Z.** Pops the most recent snapshot and puts the board back exactly as
  // it was — same rows, same ids — so relationships that pointed at a deleted
  // node point at it again rather than at nothing.
  //
  // The stack is per board and shared: the GM and the owner edit the same web,
  // so they undo the same history. Whoever presses it takes back the last
  // change made to that board, not the last change made by them — which is the
  // only version that can be coherent when two people are drawing at once.
  on('relationships:undo', async ({ characterId }) => {
    if (!mayWriteBoard(characterId)) return;
    const id = Number(characterId);
    const stack = undoStacks.get(id);
    if (!stack?.length) return;
    await restoreBoard(id, stack.pop());
    if (!stack.length) undoStacks.delete(id);
    await emitRelationships(id);
  });

  on('counter:create', async ({ characterId, name, targetPips, rewardType }) => {
    const counterName = String(name ?? '').trim();
    const target = Math.trunc(Number(targetPips));
    if (!counterName || !Number.isInteger(target)) return;
    if (target < 2 || target > 20) return;
    // Every Counter belongs to a character now. Standalone counters lived in
    // the Combat Arena, which the pivot removed; any already in the database
    // are kept untouched, but nothing shows them, so none are made.
    if (characterId == null) return;
    const character = await getCharacter(characterId);
    if (!character) return;
    const charId = character.id;
    const reward = REWARD_TYPES.includes(rewardType) ? rewardType : null;
    const result = await run(
      'INSERT INTO counters (character_id, name, target_pips, reward_type) VALUES (?, ?, ?, ?)',
      [charId, counterName, target, reward]
    );
    io.emit('counter:created', await one('SELECT * FROM counters WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  // Sets or clears (rewardType omitted/unknown) a counter's reward tag at
  // any point in its lifetime — character-owned counters only, same
  // restriction as creation time.
  on('counter:set_reward', async ({ counterId, rewardType }) => {
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    if (!counter || counter.character_id == null) return;
    const reward = REWARD_TYPES.includes(rewardType) ? rewardType : null;
    await run('UPDATE counters SET reward_type = ? WHERE id = ?', [reward, counter.id]);
    io.emit('counter:updated', await one('SELECT * FROM counters WHERE id = ?', [counter.id]));
  });

  on('counter:adjust', async ({ counterId, delta }) => {
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    const change = Math.trunc(Number(delta) || 0);
    if (!counter || !change) return;
    const currentPips = clamp(counter.current_pips + change, 0, counter.target_pips);
    await run('UPDATE counters SET current_pips = ? WHERE id = ?', [currentPips, counter.id]);
    io.emit('counter:updated', await one('SELECT * FROM counters WHERE id = ?', [counter.id]));

    // **Reaching a Gate is announced.** That is the whole reason a Gate exists:
    // a point of progress the table agreed would matter, said out loud at the
    // moment it arrives rather than noticed later. Computed against the CLAMPED
    // value, so a +5 on a counter with two pips left announces the two Gates it
    // actually reached and not the three it did not.
    const gates = await all('SELECT * FROM counter_gates WHERE counter_id = ?', [counter.id]);
    const reached = gatesCrossed(gates, counter.current_pips, currentPips);
    if (reached.length) {
      const owner = counter.character_id != null ? await getCharacter(counter.character_id) : null;
      const label = owner ? `${owner.name} - ${counter.name}` : counter.name;
      for (const gate of reached) {
        await postSystemMessage(gateChatLine(label, gate, currentPips, counter.target_pips));
      }
    }
  });

  on('counter:delete', async ({ counterId }) => {
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    if (!counter) return;
    // Spelled out rather than left to ON DELETE CASCADE. The pragma is on and
    // the cascade would fire, but every other delete in this file states its own
    // cascade (see DELETE /api/characters/:id), and one that quietly relies on
    // the DDL is the one a future rebuild breaks.
    await run('DELETE FROM counter_gates WHERE counter_id = ?', [counter.id]);
    await run('DELETE FROM counters WHERE id = ?', [counter.id]);
    io.emit('counter:deleted', { counterId: counter.id });
    await emitGates();
  });

  // ---- Gates -------------------------------------------------------------
  //
  // **GM-only, and that is the mechanic rather than a permission.** A Gate is
  // the GM writing on a Counter's future, and `secret` is meaningless if the
  // person it is kept from can author it. Counters themselves stay open to
  // whoever controls the character, exactly as before.
  const isGm = () => socket.data?.identity?.role === 'gm';

  on('counter_gate:save', async ({ counterId, pipIndex, name, description, secret }) => {
    if (!isGm()) return;
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    if (!counter) return;
    const pip = Math.trunc(Number(pipIndex));
    if (!isValidPip(pip, counter.target_pips)) return;
    // One Gate per pip, so saving is an upsert rather than a create-or-fail:
    // the editor opens on a pip and does not know or care whether the row it is
    // about to write already exists.
    await run(
      `INSERT INTO counter_gates (counter_id, pip_index, name, description, secret)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(counter_id, pip_index)
       DO UPDATE SET name = excluded.name, description = excluded.description, secret = excluded.secret`,
      [counter.id, pip, clampText(name, 60).trim(), clampText(description, 2000), secret ? 1 : 0]
    );
    await emitGates();
  });

  on('counter_gate:delete', async ({ gateId }) => {
    if (!isGm()) return;
    await run('DELETE FROM counter_gates WHERE id = ?', [gateId]);
    await emitGates();
  });

  // Free-text chat message, optionally with an attached image/GIF (see Chat
  // Log above). Attributed to a character the same way a roll is — chosen
  // client-side in the compose box, not implied by the current page — or to
  // GM_CHAT_SENTINEL_ID, the GM's own generic persona (no real character
  // row; characters.id starts at 1, so 0 can never collide with a real
  // one). Never kept long-term: wiped by chat:clear and automatically on
  // every server boot (see the initDb() call at the bottom of this file).
  const MAX_CHAT_MESSAGE_LENGTH = 2000;
  on('chat:message', async ({ characterId, text, imageData, imageMimeType }) => {
    const asGm = characterId == null;
    const character = asGm ? null : await getCharacter(characterId);
    if (!asGm && !character) return;
    const message =
      typeof text === 'string' ? text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH) : '';
    const image = typeof imageData === 'string' && imageData ? imageData : null;
    if (!message && !image) return;
    const mimeType = image ? sanitizeImageMime(imageMimeType, 'image/png') : null;
    const result = await run(
      `INSERT INTO chat_log (kind, character_id, dice_rolled, content, image_data, image_mime_type, image_hash)
       VALUES ('message', ?, '[]', ?, ?, ?, ?)`,
      [asGm ? GM_CHAT_SENTINEL_ID : character.id, message || null, image, mimeType, hashImageData(image)]
    );
    // **The picture goes out as a URL, not as bytes (bandwidth).** A chat GIF
    // could be ~5.3MB base64, echoed to every socket including the uploader's
    // own — and then re-sent inside GET /api/chat on every page load and every
    // phone unlock for as long as it stayed in the readable tail. As a URL it
    // is fetched once per person and cached.
    //
    // The row id is captured for the same reason: it is what the URL is built
    // from, and ChatPanel can now key on it instead of falling back to the
    // list index.
    // **Keep only what anyone can scroll back to.** CHAT_HISTORY_LIMIT is a READ
    // limit — GET /api/chat returns the newest N — but nothing ever deleted the
    // rest, so a long session left everything older in the database, unreachable
    // by anybody and re-downloaded on every cold start.
    await run(trimChatLog(CHAT_HISTORY_LIMIT));
    const id = Number(result.lastInsertRowid);
    io.emit('chat:message', {
      id,
      kind: 'message',
      characterId: asGm ? null : character.id,
      characterName: asGm ? 'GM' : character.name,
      message: message || null,
      imageUrl: imageUrl('chat', id, { data: image }),
      timestamp: new Date().toISOString(),
    });
  });

  // GM-only client-side, same as every other admin-style control in this
  // no-auth app — the server itself has no concept of role.
  on('chat:clear', async () => {
    await run('DELETE FROM chat_log');
    io.emit('chat:cleared');
  });

});

// ---------- static frontend ----------

const clientDist = path.join(__dirname, '..', 'client', 'dist');
// **Vite content-hashes every filename**, so an asset URL can never refer to
// different bytes tomorrow — which is exactly the condition `immutable`
// requires. Without this, Express defaults to `max-age=0` and every returning
// visitor pays a conditional request per asset just to be told nothing
// changed. `index.html` is the one file whose URL is stable while its contents
// change on every deploy, so it is explicitly excluded below.
app.use(express.static(clientDist, { maxAge: '1y', immutable: true, index: false }));
// An unknown API path is a 404, not the SPA shell — a browser tab still running
// the pre-pivot bundle asks for /api/moves and friends, and should get a clean
// "not here" rather than HTML it tries to parse as JSON.
app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (_req, res) => {
  // The SPA shell names the current bundle, so a cached copy would pin a
  // browser to the previous deploy's JavaScript.
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(clientDist, 'index.html'));
});

// **Listen first.** Everything below this line can block the event loop for an
// unbounded time (see the boot gate near the top of this file), and a process
// that is not listening while it does so is indistinguishable, from outside,
// from a process that has died — which is exactly how the Render timeouts
// presented. Requests answer 503 until `bootState` flips at the very end.
httpServer.listen(PORT, () => {
  // Against a plain local file the boot below finishes before this callback
  // ever runs, and announcing a 503 window that has already closed would read
  // as a fault rather than as progress.
  bootLog(
    bootState === 'ready'
      ? `Dogfight server listening on port ${PORT}`
      : `Dogfight server listening on port ${PORT} — answering 503 until the database boot finishes`
  );
});

// **Is the database actually there? Asked by name, at boot, once.**
//
// Not load-bearing any more — see probePrimary in db.js. A remote client is
// lazy and cannot hang the boot the way the replica's blocking bootstrap
// could, so this is no longer the difference between a deploy and a timeout.
// It is kept because the alternative diagnosis for an expired token or a
// paused database is "every request 500s with a driver error", and exiting
// non-zero is the right outcome for Render besides: a failed deploy leaves the
// previous one serving.
if (remoteMode) {
  bootDetail = 'checking that the Turso primary is reachable';
  const probe = await probePrimary();
  if (probe.ok === false) {
    console.error(
      `Could not reach the Turso database at ${probe.host} after ${probe.ms}ms ` +
        `(${probe.timedOut ? `no answer within ${PROBE_TIMEOUT_MS}ms` : probe.error}), ` +
        'so the server is stopping rather than starting up to 500 on every request.\n' +
        'Check that TURSO_DATABASE_URL points at a live database, that the database has not been ' +
        'paused or archived for inactivity, and that TURSO_AUTH_TOKEN has not expired.\n' +
        'Set TURSO_PROBE_TIMEOUT_MS=0 to skip this check.'
    );
    process.exit(1);
  }
  if (probe.ok) {
    bootLog(`Database: ${probe.host} answered in ${probe.ms}ms (HTTP ${probe.status})`);
  }
}

// Open the connection. Nothing is downloaded and nothing blocks: a remote
// libSQL client is lazy and speaks Hrana over HTTP, so this is bookkeeping
// until the first statement. That is the whole of what replaced a bootstrap
// pull which, on the last deploy, held the event loop for 783 seconds and cost
// the site its port scan — see the note at the top of db.js.
bootDetail = 'connecting to the database';
connectDb();
console.log(remoteMode ? 'Database: remote (Turso)' : 'Database: local file');

bootDetail = 'creating and migrating tables';
await initDb();
await loadAssignments(all);
await purgeTempNpcCombat();
await purgeHandmadeCombatSetup();
// Chat is intentionally ephemeral — see chat:clear below — and clearing it
// on every boot doubles as clearing it between sessions on Render's free
// tier, which spins the server down after inactivity.
await run('DELETE FROM chat_log');

// **What this boot throws away, and why it is safe to (bandwidth).**
//
// Two things were accumulating with nothing to prune them: chat beyond the
// visible window, and images whose owner was deleted out from under them.
// (Replays of finished fights were a third, until the pivot removed the Arena.) Every one of them is bytes Turso stores and,
// when something does read them, bytes that cross the network.
//
// This sweep mattered when the whole database was pulled on every cold start;
// it matters differently now, and still. With no replica the pull is gone, but
// so is the only other thing that was ever going to bound the database's size —
// a table nobody prunes grows for the life of the world. See server/cleanup.js
// for the queries and server/test/cleanup.test.js for what each is allowed to
// touch; the ownership sweep in particular deletes artwork unattended, so it is
// pinned against live owners, deleted owners and deliberately-NULL owner ids
// before it is ever run here.
try {
  for (const sweep of ORPHAN_SWEEPS) {
    const found = await one(countOrphans(sweep));
    if (found?.n > 0) {
      console.log(`Cleanup: removing ${found.n} ${sweep.label}`);
      await run(deleteOrphans(sweep));
    }
  }

  // **No VACUUM here (bugfix — it was actively harmful, and it was mine).**
  //
  // It was added so the file would actually shrink rather than sit at its
  // high-water mark, which is true of SQLite and was the right instinct for a
  // local file. Against the embedded replica it was the opposite of what it
  // looked like: a VACUUM rewrites every page, replication's unit is the
  // modified page, so the next sync pushed the *entire database* — which is
  // exactly the 73-second sync at the end of the failed deploy.
  //
  // Now there is no replica and no local file to reclaim: the pages belong to
  // Turso, which manages its own storage. So a VACUUM here would be a
  // full-database rewrite bought for nothing at all. The sweeps above delete the
  // rows; what the primary does with the freed pages is the primary's business.
} catch (err) {
  // Never fatal: a world that cannot be tidied is still a world that can be
  // played, and a cleanup bug must not take the table's session down with it.
  console.error('Cleanup at boot did not complete:', err);
}
// Open for business: the 503 gate stands down and sockets are attached to the
// already-listening HTTP server. Both in this order, so the first client to
// get a socket through can never beat the gate.
bootState = 'ready';
io.attach(httpServer);
console.log(`Dogfight server ready on port ${PORT}`);

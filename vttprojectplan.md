# Dogfight: Martial Arts TTRPG — Project Plan

## Overview
A small, self-hosted virtual tabletop for one group (GM + players), accessed remotely over the internet from multiple devices simultaneously. No login system — one shared link, everyone sees everything within their role. Presentation-focused, fighting-game visual style.

**Status: between systems.** The original game system was removed in one pass (see **The pivot** below). What remains is the table’s shell — characters, the Scene tab, chat with a Dice Tray, music. The new system is **Panic at the Dojo** as a visual combat assistant — see **Game system — Panic at the Dojo combat assistant**. Everything this document used to say about the old system (Moves, Perks, Quirks, Stances, the 8 Stat dice, Stamina, the Combat Arena and its timing engine, the Rules page) is in git history: the last commit carrying it is the parent of the pivot commit.

## The pivot (decided, implemented)
The GM hard-pivoted away from the original system. What was asked for, and what was decided in answering it:

- **Kept, unchanged:** the character roster and its folders; the Scene tab in full (Scenes, folders, Temp NPCs, Scene Pictures, summons, drawings, notes, timestamps, the master note); the Audio Player and its library; the Relationships board; Counters with their Gates and Rewards; Role-play; the Settings page's Primary Color and Scene Stage settings; the Re-encode Images GM tool.
- **Character sheet:** only **Counters**, **Role-play**, **Relationships** (PC-only) and **Scene Pictures** tabs remain, opening on Counters. The **name and profile picture** — which used to live on the removed Core Stats tab — now sit in a header above the tabs (`CharacterHeader.jsx`), so the profile picture survives with its crop editor.
- **Removed entirely:** the Combat Arena (page, header status strip, every combat table and replay), the Compendium (page and tab), the Rules page and `game_rules.md`, the Core Stats / Stances / Moves / Perks / Quirks sheet tabs, the Character Creation wizard, Stamina, the Dice Pools, Inventory, Injuries, Weapons, the Roll Requester and Fight Pauses GM tools, the Cutscene Speed setting, the Counters' **Show in Combat** checkbox (the column is dropped), and standalone (Arena) Counter creation.
- **New character is a plain create:** name, PC/NPC, folder, and an optional profile picture with the same crop preview as everywhere else — one `POST /api/characters`. No dice are seeded; there is nothing to seed.
- **Chat keeps plain messages and the Dice Tray.** Old card kinds (move reveals, replays, lane snapshots) are gone from the renderer; since the chat log is cleared on every boot anyway, none survive the deploy. A Dice Tray roll is `1d{4–12} + modifier` (±20), attributed to the poster — nothing is added to it from any system.

### The archive, and the one-time purge (decided, implemented)
"Extract everything as a JSON (no pictures) so everything can be recovered" — done inside the database, at boot, before anything is deleted (`archiveAndPurgeOldSystem` in `server/db.js`, rules in `server/compendiumArchive.js`):

1. **What is archived** (`ARCHIVED_TABLES`): the whole Compendium — Moves and every Move child table, Move folders, Tells, Tags, Perks, Perk Tags and their links, Quirks — plus the Styles (`attributes`, `attribute_counters`) a Move's ids point into, and who had what (`character_moves` and its override/tag/roll-bonus rows, `character_perks`, `character_quirks`), with every character's id → name so the file reads on its own. **Pictures are stripped** (`image_data`, `image_mime_type`, `image_hash`, crop columns). Stances, dice, Stamina, inventory, injuries, weapons and combat state were purged **without** export, as the GM chose.
2. **Checked before anything is dropped:** the rows are read in one read transaction together with `COUNT(*)` per table; `verifyArchive` requires every count to match and the serialised text to round-trip exactly. Any problem → nothing is deleted, the boot logs why, and Settings shows it.
3. **Then one atomic batch** inserts the archive row into `compendium_archive` and drops all 36 old tables (`PURGED_TABLES`) **children first** — libSQL enforces foreign keys on this connection (measured), so a parent-first drop is refused and would roll the whole batch back. Nothing kept references a dropped table. The vitruvian backdrop bytes are cleared in the same transaction.
4. **Afterwards, best-effort:** the old columns on `characters` (`OLD_CHARACTER_COLUMNS`: vitruvian image, active stance, stamina, next-roll penalty) and `counters.show_in_combat` are dropped. A failure here is recorded, not fatal.

It runs once: a database with no old tables reports `clean` and writes nothing. The archive is **append-only** and is served GM-only: `GET /api/compendium-archive` lists archives with their counts and the boot's purge status; `GET /api/compendium-archive/:id` downloads one as `dogfight-compendium-archive-YYYY-MM-DD.json` (format `dogfight-old-system-archive`, version 1). Settings has a GM-only **Old System Archive** section with the download link. Verified on a copy of a fully-populated pre-pivot database: 105 rows from 22 tables archived, 36 tables removed, every kept table's row count unchanged, the profile picture byte-identical.

**Standalone Counters already in the database are kept, not deleted** — they were the Arena's, nothing shows them now, and nothing new creates them (`counter:create` requires a character). Whether to delete them is an open item.

## Roles / access model
On every fresh page load, a modal asks who's playing: a **GM** button, or a scrollable **"Play as…"** list of every PC — picking one logs in as that character. This is a client-side display filter, not authentication: no login, no password, anyone can pick anyone (accepted trust model). The server tracks the chosen identity per connection (`identity:set`) and uses it where a per-viewer answer matters (secret Counter Gates, the Relationships board, Scene Picture write gates, GM-only endpoints via `?role=gm`).
- **Player (picked a character):** the `/` home route, the header's roster link (labelled **Character**) and any unknown route go to that Player's own sheet. Direct-URL access to another sheet is not blocked (same trust model). A Player has no UI path to create a character.
- **GM:** the roster shows all characters (`pc` and `npc`); can view/edit anything.
- **NPCs assigned to a player (decided, new; implemented).** By default every NPC is the GM's alone. On an NPC's sheet the GM picks **Assigned to: Nobody (GM only) / <PC>'s player** (`character:assign { characterId, playerCharacterId | null }`, GM-only; only an NPC can be assigned, and only to a PC, because a player *is* the PC they picked at the door). From then on that player controls the NPC in every part of the system, exactly like their own character:
  - **Sheet:** they can open it (other NPC sheets still send a Player home) and edit it; it is linked in the header beside **Character** (and in the mobile menu), and it shows up in their Search.
  - **Chat and dice:** the composer's fixed name becomes a **Post as** picker of their own PC plus their NPCs.
  - **Scene and combat:** the Summon dock and the Combat token dock list each controlled character; they can move, resize and unsummon its figure, drag its lane miniature or map token, edit its Panic tokens, HP, Challenge and Stance, set up its Combat tab and Scene Pictures, and pick its stance at turn start.
  - **Enforcement:** one rule, `controlsCharacter(viewer, characterId)` in `server/control.js`, behind every server write gate that used to say "their own character" (Scene Pictures, summons, combat setup, map tokens, fighter state, stance picks, Relationships writes). Assignments are mirrored in memory (loaded at boot, updated on every change) so the gates stay synchronous. The client copy is `useControl()` (`client/src/lib/useControl.js`).
  - Unassigning takes control away immediately; **deleting the PC hands their NPCs back to the GM**. The roster shows "→ <PC>" on an assigned NPC's card (GM view).
  - Tested in `server/test/control.test.js` and `scripts/playtest-npc-assign.mjs`.
- The choice is not remembered — it asks again on every reload. The identity is re-sent on every socket reconnect.
- Activity is not hidden by role: rolls and edits are broadcast to everyone.
- **Character-list folders are GM-managed and nest to any depth** (`character_folders.parent_id`); deleting one promotes its direct characters and child folders one level up.

## Stack
- **Frontend:** React + Vite, Tailwind CSS, Framer Motion (transitions/layout), GSAP (impact effects)
- **Backend:** Node.js + Express — also serves the built frontend (single deployable app). An unknown `/api/*` path answers a JSON `404` rather than the SPA shell, so a tab still running an old bundle gets a clean "not here".
- **Real-time:** Socket.io
- **Database:** Turso — free, hosted, SQLite-compatible (libSQL). The server connects straight to the primary — the embedded replica was removed (Database round-trips, Phase 6); actions stay fast by batching (`readMany`/`writeMany`, one round trip per group of statements). Missing tables are created at startup (`CREATE TABLE IF NOT EXISTS`).
- **Hosting:** Render — free web service tier; merging to `main` is the deploy. The free tier sleeps after inactivity (~30-60s wake). Configured by `render.yaml` (`healthCheckPath: /api/health`, the two `TURSO_*` secrets). Node pinned to 22 (`.node-version`, `engines.node`). The server listens before it opens the database and answers `503` until boot finishes.
- **Access:** one shared URL, no auth
- **Mobile:** installable PWA (manifest + service worker); every page is usable on a phone (bottom nav below `md:`, 44px touch targets, sticky scrollable sheet tabs). Playwright drives a mobile device matrix (`playwright.config.js`, `e2e-mobile/`) alongside the `node --test` server suite.

> **Reading the three infrastructure sections below:** they were written while the old system existed and keep their measurements and decisions verbatim, because those still govern the code that survives (write batching, image URLs, deltas, compression). Where they cite a removed feature (a combat round, a Move grant, the Compendium) as the example being measured, read it as history — the mechanism it motivated is what is still current.

## Database round-trips (decided, new)
**Status: Phase 0 shipped.** Reported from the table as "every operation of declaring, granting or
choosing takes 3-5 seconds". It was measured rather than guessed: `all`/`one`/`run` were wrapped in
an `AsyncLocalStorage` counter and each socket handler and REST route made to report its query count
and wall time, run twice against a fresh database — once bare, once with 40ms injected before every
query so that **serialization depth** (how many queries an action runs *in a row*) could be read off
directly as `wall / 40`.

**Nothing was slow. The trips were.** The database answers in single-digit milliseconds; what costs
seconds is that `server/db.js` sends one statement per call, so an action's wall time is
`depth x round-trip`:

| Operation | Queries | Depth | @40ms |
| --- | --- | --- | --- |
| `combat:character_done_declaring` (2nd side — resolves the round) | 210 | **145** | 5808ms |
| `initDb()` (warm database, **every** boot) | 148 | 148 | ~5900ms |
| `GET /api/combat` | 46 | 10 | 415ms |
| `combat:next_round` | 29 | 15 | 620ms |
| `move:declare` | 26 | **14** | 573ms |
| `combat:character_done_declaring` (1st side) | 24 | 15 | 599ms |
| `GET /api/characters/:id` | 24 | 6 | 248ms |
| `POST /api/characters` | 10 | 10 | 419ms |
| `move:grant` | 3 | 3 | 125ms |

At a cross-region round-trip of 150-250ms a 14-deep declare lands at 2.1-3.5s, which is exactly the
reported band.

**Phase 0 — the embedded replica (shipped, then REMOVED — see Phase 6).** Kept below as the record of
what was tried and why it looked right: everything in this phase was true of the replica itself, and
none of it survived contact with a host that has no persistent disk. `createClient({ url:
'file:replica.db', syncUrl: TURSO_DATABASE_URL, authToken })` keeps a full copy of the database on
the server's own disk. Reads
are answered locally in microseconds and never leave the process; only writes go to the primary.
Three properties make this safe rather than merely fast, and all three were verified against the
installed client before it was wired in:

- **`readYourWrites` defaults to `true`** (`node_modules/libsql/index.js` — `opts?.readYourWrites ?? true`),
  so a write is visible to the very next local read. The engine reads back what it just wrote
  constantly, and would be *incorrect* rather than merely stale without this.
- **One instance.** Render's free tier runs a single web service, so no second writer's frames need
  chasing. `syncInterval` is therefore off by default and opt-in via `TURSO_SYNC_SECONDS`, for the
  case where something outside the server writes to the primary (a `turso db shell` session).
- **The local file is disposable** — a cache of the primary, rebuilt on boot, so Render's ephemeral
  disk costs nothing and the primary stays the only durable copy. It is gitignored
  (`replica.db`, `replica.db-*`) and its location is overridable with `TURSO_REPLICA_PATH`.

`syncReplica()` runs once before `initDb()` and is **deliberately fatal on failure**: a server that
came up holding an empty replica would let the seed functions conclude the world has no ruleset, no
Tells and no Perks, and write a second copy of all three into the primary. The failure path was
exercised against an unreachable primary — it stops before `initDb` with a message naming the two
env vars to check.

Nothing else changed: with no `TURSO_DATABASE_URL`, or one that is already a `file:` URL, the client
is constructed exactly as before and the boot log says `Database: local file (no replica)`.

**Phase 1 — the client refetch storm (shipped).** `move:grant` costs the server three queries; the
delay was never the grant, it was what every connected browser did when the broadcast landed. Four
components each kept their own roster copy and all four wrote the same wrong rule — refetch
`/api/characters` on `character:created`, `character:updated` **and** `character:deleted` — and
`character:updated` is what `adjustStamina` emits every time a fighter's Stamina moves. `ChatPanel`
is mounted on every page, so one Stamina tick had every browser in the session re-fetching. The
Compendium was worse: one `refreshAll` bound to twenty event names that refetched Tells, Tags, the
ruleset, every Move, every Character **and a full character sheet per character in the game**
(24 queries each) purely to read their stances.

- **`client/src/lib/useRoster.js` (new)** owns the one copy of the rule: refetch only on a real
  membership change, and **patch a `character:updated` in place from its own payload** — it already
  carries the whole character, so it costs no request at all. Merging rather than replacing is what
  keeps the `stances` that only the roster fetch supplies. Returns `null` until the first fetch so
  callers can still tell "loading" from "no characters". Used by `ChatPanel`, `CharacterList`,
  `Compendium` and `PerksCompendium`.
- **`GET /api/characters` now returns each character's `stances`** — two queries for the whole
  roster, replacing the per-character sheet fetch the Compendium was doing in a loop. Additive, so
  callers that only want the flat roster are untouched.
- **The Compendium's `refreshAll` is four narrow refetchers** mapped to the events that actually
  invalidate their data (Tells / Tags / library / roster), instead of one function on twenty events.
- **`CharacterSheet` fetches once per Perk event, not twice.** `perk:granted`/`perk:revoked` were
  bound to both `refetchMoves` and `refetchPerks`, each running its own `getCharacter` and throwing
  half the result away.

Measured in a real browser against a live server: five `character:updated` broadcasts (confirmed
received) now cause **0** API requests where they previously caused five roster refetches, and one
grant causes **one** request — `/api/moves`, 9 queries — where it previously caused five endpoint
fetches plus a full sheet per character. A whole Compendium refresh is now 15 queries and **flat in
roster size**; it used to be 14 + 24n.

**Phase 2 — a batched read/write seam (shipped, with a caveat worth recording).**
`readMany`/`writeMany` in `db.js` wrap `db.batch`, which posts a whole array of statements together
and returns one result set each: many statements, **one** round trip. They take the same
`[sql, args]` pairs the plain helpers take and return rows in the same order, so converting a
`Promise.all` of reads is mechanical. Pinned by `server/test/dbBatch.test.js`, which asserts a
batched read returns *exactly* what the same reads return one at a time, plus the two edge cases
every call site meets — an empty group and a group of one.

Converted: `attachInteractions` (six sub-table reads, 6 trips to 1), `getMovesFor` (five, to 1),
`resolveStaminaCosts`, `GET /api/combat`'s bulk reads, and character creation's eight dice inserts.
Both `getMovesFor` and `resolveStaminaCosts` also take a `knownDice` option now, so the combat
snapshot hands down the dice it has already read — that is what stopped one request reading the same
character's dice **three** times. `attributes` and `attribute_counters` are memoised for the life of
the process in `combatBonuses.js`: `seedRuleset` is their only writer and it runs at boot, so there
is no invalidation problem to have.

**The caveat, because it changes what to expect from the rest of this work.** Measured at 40ms a
trip, total trips fell hard but wall time mostly did not:

| | trips | wall @40ms |
| --- | --- | --- |
| `POST /api/characters` | 10 → **3** | 419ms → **128ms** |
| `GET /api/combat` | 46 → **20** | 415ms → 416ms |
| `move:declare` | 26 → **23** | 573ms → 538ms |
| resolve a round | 210 → **205** | 5808ms → 5810ms |

Batching only shortens the critical path where the statements were **sequential**. Most of what was
converted already ran inside a `Promise.all`, and parallel requests cost count, not depth — so the
real win here is character creation (genuinely a `for await` loop, now one trip), plus far less load
on the connection and much more headroom under the libSQL client's 20-request concurrency limit,
which `GET /api/combat` at 46 was liable to queue behind. **The depth that costs seconds is in the
declare gate and the round engine, which is Phase 3.**

**Phase 3 — the round engine (shipped, and it settles what is left).** Resolving one round issued 210
queries across 75 distinct statements, re-fetching the pair's invariants at every one of its seven
Tics. Three things changed:

- **`withPerkCache` in `perkEngine.js`.** "Who holds which Perk" was asked eleven times per round —
  it is on the path of every roll, trigger and threshold, for both fighters — and cannot change
  within a resolution. Memoised through an `AsyncLocalStorage` scoped to one `advancePairResolution`
  call, deliberately *not* a module-level cache: Node yields at every await, so a `perk:grant`
  arriving between Tics would leave a process-wide map stale for the rest of the session.
- **The two per-Tic progress writes go together** through `writeMany`. They are one record — "this
  Tic is finished" — and a crash between them would leave the halves disagreeing.
- **`applyIdleTicStaminaRegen`'s three reads batch into one**, and it runs once per Tic.

Result: **210 → 176 trips**, and the round still resolves correctly end to end (pair back to
Declaration, round 2, the same chat output).

**Two findings worth more than the numbers.**

**Awaiting the resolution never blocked anything.** The plan for this phase said to acknowledge the
click and resolve asynchronously. That was written on the assumption that Socket.io serialises a
socket's handlers. **It does not** — measured directly: it invokes each handler and ignores the
returned promise, so a slow handler does not delay the next event from that or any other client.
Detaching the call was implemented, measured, and **reverted**: it bought no responsiveness and
opened a window for two resolutions of the same pair to overlap. The comment at that call site now
says so, because the code looks like it should block and does not.

**Depth is structural now, and Phase 0 is what pays for it.** At 40ms a trip the round went 5808ms →
5600ms: 176 trips but still ~140 of them one after another. What was removed had been running inside
`Promise.all` groups already, and parallel requests cost count, not depth. What remains is genuinely
sequential — roughly twenty ordered DB steps per Tic, each depending on the last, which is what
resolving a fight Tic by Tic *is*. Collapsing it would mean threading one loaded context through
every helper in the engine, which `CLAUDE.md` flags as the high-risk module, and it is not worth that
for a cost the embedded replica has already removed: 140 local reads is not a number anybody can feel.

**So the shape of Phases 0–3 is:** Phase 0 removed the cost of reads, Phases 1–3 removed the waste.
**This was then measured against a live game and found to be only half the story — see Phase 5.**

**Phase 4 — standing costs (shipped).** The costs nobody triggers, paid on every boot and every page
load. `initDb` re-ran 148 awaited statements against a database that needed nothing done — ~65 reads
of `sqlite_master` (one per `ensureColumn`, one per migration guard), 38 `CREATE TABLE IF NOT EXISTS`
that find the table already there, and ~26 seed lookups — and Render's free tier cold-starts often
enough that it is paid over and over.

- **One `sqlite_master` snapshot, and a DDL queue.** `ddl()` collects statements instead of sending
  them; the queue drains in a single `db.batch` the moment anything needs the database to be current,
  which `all`, `run`, `readMany` and `writeMany` each do for themselves — so a migration or a seed
  added later gets the flush without knowing the queue exists.
- **The seeds' guards became one batched read** and one batched write, instead of a `COUNT` per table
  and a `SELECT` per Tag and per registered Perk.
- **Indexes on the foreign keys the app looks rows up by.** The schema had *none*: every
  `WHERE character_id = ?` was a full scan, since SQLite only indexes `INTEGER PRIMARY KEY` for free.
  Honest about the size of this one — most of these tables hold tens of rows, and reads are local
  now; it matters for `chat_log`, `round_events` and `declared_moves`, which grow for the life of a
  world.
- **`GET /api/chat` returns the last 300 entries**, not the entire log. That endpoint is where pasted
  images live (base64, in `chat_log.image_data`), so an unbounded fetch dragged megabytes across on
  every reload and reconnect. One query either way — this is about the size of the answer, not trips.
  The cost: scrollback older than 300 entries does not survive a reload. Nothing in the UI pages
  further back, and the GM clears the log between fights.

**Result: 148 trips → 4 on a warm boot; 243 → 30 on a brand-new database.**

**No version stamp, deliberately.** The obvious fix — stamp a schema version and skip `initDb` when
it matches — is simpler and much more dangerous: a Perk added to the registry, a Tag renamed, a seed
row a GM deleted would all silently stop being repaired, and the failure would surface as a missing
mechanic weeks later. Phase 4 runs the whole of `initDb` every boot, exactly as before; it just stops
paying a round trip per line to do it.

**Two regressions caught by comparing schemas rather than by reading the diff.** Both were invisible
on a second boot, which is why `server/test/initDbSchema.test.js` tests the *first* one. (a) The
snapshot is taken before this boot's CREATEs are sent, so on a fresh database the table `ensureColumn`
is about to alter is not in it — reading the snapshot alone skipped every ALTER, and a new world came
up missing three dozen columns. (b) The table-rebuilding migrations exist *because* the base CREATE
above them still declares the old shape, so a fresh database is born needing the rebuild; a guard
reading the pre-CREATE snapshot skipped it and left the new world with the old CHECK constraint. Both
are fixed by `tableSql` answering from the snapshot **or** the pending queue — the queued statement
is exactly what the table is about to become. Verified by diffing `sqlite_master` and the seeded rows
against the old `initDb`: identical on a fresh database, on repeat boots, and on three vintages of
legacy database upgraded forward.

**Phase 5 — writes go local too (shipped, then REMOVED — see Phase 6).** Its diagnosis still stands
and is the reason the batching work matters: *counts are not latency, and writes are not reads*. Its
mechanism does not — `offline: true` needs the replica that Phase 6 deletes.

**First, the correction, because it is the more useful half.** Phases 1–4 were steered by *trip
counts*, measured against a local file where every statement is sub-millisecond, and then converted
to wall time by multiplying by an assumed round-trip. That arithmetic assumes every trip costs the
same. **It does not.** After Phase 0 a read costs approximately nothing and a write costs a full
round trip — arguably two, since `readYourWrites` must pull the replication frame back before the
next local read is correct. Counting reads and writes as one unit made a change that removed 34 reads
and no writes look like progress. The round-trip time itself was never measured either; the report
flagged it as unverified and then quoted wall times anyway.

A live playtest after Phase 0 deployed settled it: **the delay dropped only slightly.** That is the
ground truth the numbers could not see, and it says writes are what remain. Treat this as the
standing lesson for any future performance work here: **counts are not latency, and a probe against a
local file cannot tell you the difference. Measure the deployed thing, or measure reads and writes
separately.**

**The fix, which is the architecture the user proposed:** `offline: true` on the libSQL client. A
write lands in the local replica immediately and is pushed to the primary by `db.sync()`, which
`startSyncLoop` runs every ten seconds in the background. Reads were already local; now writes are
too, and an action's cost stops depending on the network at all.

- **Why it is safe here:** exactly one writer. Reconciling concurrent writers is the hard and
  dangerous part of local-first, and Render's free tier runs a single instance — so the local file is
  the truth of the moment and the primary is an asynchronous copy of it. This is the same property
  that made Phase 0 safe, used harder.
- **The accepted trade (decided, explicitly):** a crash costs up to one sync window. Losing the last
  few seconds of a fight is cheaper than making every action of it wait. Worst case somebody re-rolls
  a die.
- **The real risk is not the ten seconds — it is a sync that fails quietly.** An expired token or a
  network partition looks exactly like a healthy sync from inside the game: everything lands,
  everything is fast, and nothing is wrong until Render recycles the container and takes the whole
  unsynced backlog with it. So `syncOnce` counts failures rather than swallowing them, `syncHealth()`
  reports staleness, and a health *change* is logged **and** broadcast as `db:sync_health`, which
  `SyncHealthBanner` puts on screen in red. That alarm is the price of admission for this trade, not
  a nicety. It is deliberately not dismissible — "offline" is self-correcting and everyone knows what
  it means, while this is silent data loss in progress and the only fix is a human noticing.
- **`SIGTERM` flushes before exit** (time-boxed to 5s). Render sends it before recycling a service,
  which turns the common planned case — a redeploy, a free-tier spin-down — from "lose up to one
  window" into "lose nothing".
- **libSQL's own `syncInterval` is deliberately unused.** Its timer swallows the result, and an alarm
  that cannot see a failure is not an alarm.

**Phase 5.1 — the sync loop was blocking the event loop (bugfix, shipped).** Phase 5 broke the Arena
in production: it hung on "Loading…" forever while every other page stayed fast.

**The whole libSQL binding is synchronous.** Every symbol it exports is `*Sync` — better-sqlite3
lineage — and `db.sync()` is `databaseSyncSync`, which does **network I/O on the calling thread**.
(`createClient` proves it: given a `syncUrl` the constructor itself performs a blocking `PullDb` and
throws if the primary rejects it.) For local statements that costs microseconds and is exactly why
this app is fast; for a sync it means Node serves *nothing* until it returns.

Phase 0 called it once at boot, where a stall is harmless. Phase 5 put it on a ten-second timer,
turning a boot-time cost into a permanent one. Why the **Arena** specifically: a page needing one
request slips between the stalls, but the Arena fires five requests plus a move query per fighter and
re-runs that on a dozen different events, so it is overwhelmingly the most likely thing to be caught
— and if it never completes a full set, it never leaves its loading gate (`combat`, `roster`,
`folders`, `tells`), which is precisely the reported symptom.

The fix is **not** to sync less often — that trades durability for latency, the wrong way round. The
loop now notices what it costs: every sync is timed, a slow one widens the interval (capped at 2% of
wall-clock, and at 5 minutes absolute), a failure backs off exponentially rather than hammering a
blocking call into an unreachable primary once a cycle, and the duration is logged. The boot sync and
the `SIGTERM` flush stay blocking and unthrottled on purpose — at both moments there is nothing else
to serve. `GET /api/health` now reports `sync` so the deployed state can be read from outside;
`server/test/dbConfig.test.js` pins the schedule, since both cases it exists for need a real primary
and can never be reproduced locally.

**The standing lesson, and it is the same one as Phase 5's.** A native module whose every export ends
in `Sync` is telling you it blocks. That is free for local work and ruinous for anything that touches
the network, and the difference is invisible in development — where `usingRemote` is false and the
sync path never runs at all. **Check what blocks before putting it on a timer.**

**Phase 5.2 — the Arena could be taken down by one bad row (bugfix, shipped).** The Arena stayed
stuck on "Loading…" after 5.1, so the blocking sync was not the cause. Five confirmed ones were found
instead, each a 500 from `GET /api/combat`:

- **`combat_state` row 1 missing.** Every field below it is dereferenced off that row, and *nothing
  else in the app reads `combat_state`* — which is exactly why the Arena alone broke while every
  other page stayed fast. `initDb` seeds the row each boot, so its absence means something ate it;
  the endpoint now re-creates it and says so, because a fight that has to be restarted beats an
  Arena nobody can open.
- **Four unguarded `JSON.parse` calls** on mid-round pause payloads (Dodge, Block, conflict,
  grapple) — the least trustworthy rows in the database, written by a resolution a redeploy or a
  spin-down may have interrupted halfway. One unreadable pause on one pair now degrades to "this
  pair has no prompt", loudly logged, instead of costing everyone the whole screen. The shaping step
  is guarded too, since parsing safely and then shaping unsafely is a guard in name only.

**Two failures of reporting mattered as much as the bug.** `GET /api/combat` is the Arena's whole
world — if it throws there is no partial state to fall back on — and every fetch ended in
`.catch(console.error)` behind a `!combat || !roster || !folders || !tells` gate. So any failure
became an infinite spinner with no error, no detail and no retry. The Arena now renders **which**
endpoint failed and **why**, with a retry; and `wrap` returns the real message instead of a flat
`internal error`, since there is no auth here by design and `/api/health` has always done the same.
A UI that cannot report its own failure makes every future failure equally opaque, which is the more
expensive bug.

`scripts/playtest-arena-resilience.mjs` pins all five. **It also has its own lesson.** The first
version passed everything while testing nothing three separate ways: it corrupted a different
database file than the server was reading, it asserted on `payload.pairs` which is a truthy `[]`
when no fight exists, and it seated fighters with `combat:seat` — an event that does not exist, so
`combat:next_round` was a no-op and `shapePair` never ran. It now proves it shares the server's
database, proves a real fight is open before corrupting anything, and waits on broadcasts rather
than sleeping. **Verified the only way that means anything: 6 probes fail against the pre-fix server
and 0 against the fixed one.**

**Phase 5.3 — the actual cause: `attributes is not defined` (bugfix, shipped).** Neither 5.1 nor 5.2
was it. The Arena's own error banner — added in 5.2 — reported the answer in one line the moment it
deployed: `/api/combat — internal error: attributes is not defined`.

**It was a Phase 2 regression, not a Phase 5 one.** Commit `04ae8ca` replaced a local
`const [counters, attributes] = ...` in `getPairStanceMatchup` with `const { beats, nameById } =
await rulesetTables()`, and the memo returned no `attributes` — but a closure further down,
`deltasFor`, still iterated it. `rulesetTables()` now returns the rows too.

**Why every test missed it, and why that is the important part.** `deltasFor` is only reached for a
facing where *both* fighters have an active stance. Every fixture in this repo creates bare NPCs, so
the closure was unreachable in testing and the code looked exercised while the broken line never
ran. It also explains the misleading shape of the failure: the Arena alone broke, because nothing
else computes a stance matchup, and it broke *later* than the deploy that caused it, because it
needed someone to set a stance. **A fixture simpler than real data does not test the code real data
reaches** — `playtest-arena-resilience.mjs` now gives both fighters stances and asserts
`stanceMatchups` is non-empty before trusting a single probe below it.

**ESLint, scoped to correctness (decided, new).** `no-undef` finds this in milliseconds; it cost four
deploys instead. `npm run lint` covers `server/` and `scripts/` with `js.configs.recommended` minus
`no-unused-vars`/`no-empty` — a correctness gate, not a style gate, because a lint run noisy enough
to ignore is worth nothing. `client/src` is deliberately excluded for now: several components carry
`eslint-disable-next-line react-hooks/exhaustive-deps`, and ESLint 9 errors on a directive naming a
rule it has not loaded, so linting the client means taking on the React Hooks plugin — worth doing,
not worth bundling into a hotfix.

**The standing lesson, and it is about method, not code.** Three deploys were spent theorising from
"what changed most recently" — and the answer was a commit four phases back, invisible to every test,
reachable only with production-shaped data. What actually solved it was making the failure *report
itself*: one error banner turned four days of guessing into a one-line diagnosis. **When a symptom
cannot be reproduced, stop reasoning about causes and go make the system say what is wrong.**

**What this does not fix.** The remaining wait is the browser↔Render hop: the click travels to the
server and the broadcast travels back, roughly 100–200ms depending on region, and no database change
touches it. If the game still feels laggy after this, that hop is the culprit and **optimistic UI is
the answer to it** — the client applying the change immediately and reconciling on the broadcast.
That is the next thing to try, and deliberately not bundled in here.

**Verification is honest about its limit.** `offline: true` only activates with a real `syncUrl`, and
development runs against a plain local file, so **the offline path cannot be exercised outside the
deploy at all**. What *is* pinned locally (`server/test/dbConfig.test.js`) is the one failure that
would otherwise be invisible: that the flag survives the vendor's own config expansion and reaches
the driver. If it were ever dropped upstream, every write would silently go back to costing a round
trip, every test would still pass, and the only symptom would be a game that feels slow again.
Turso's own documentation calls the offline-sync story beta — that, rather than the ten seconds, is
the standing risk to watch.

**Phase 5.4 — booting hung on the primary, and said nothing (bugfix, shipped).** A Render deploy
built fine, ran `npm start`, and then printed **nothing at all** — no log line, no error, no exit —
until Render gave up eight minutes later with "No open ports detected… Timed Out". Nothing about the
deploy said which of the dozens of things a boot does had stalled.

**The cause is the same synchronous binding Phase 5.1 is about, hit one step earlier.**
`createClient` ran at module scope in `server/db.js`, and with a `syncUrl` its constructor performs a
blocking `PullDb`. Verified directly against a blackholed address: against a primary that does not
answer, **the constructor never returns** — no throw, no timeout, no output, indefinitely. And
because ES module imports are evaluated before a single statement of `server/index.js` runs, that
hang happened before the first `console.log` and before `httpServer.listen`. A process that is not
listening and has printed nothing is, from outside, indistinguishable from a dead one.

Three changes, each addressing a different half of "invisible":

- **The port opens first.** `httpServer.listen(PORT)` now runs *before* any database work, and an
  Express gate answers every request `503 Service Unavailable` (with a `Retry-After` and a plain
  sentence naming the current boot step) until boot completes. Socket.io is constructed **detached**
  and `io.attach(httpServer)` is called only at the end of boot, so a client connecting during
  startup meets a plain HTTP 503 — a transport error its own reconnection loop retries — rather than
  a live socket whose handlers would query tables that do not exist yet. `healthCheckPath:
  /api/health` (see `render.yaml`) sits behind the same gate, so Render still refuses to call a
  half-booted deploy live; what changes is that the port scan now finds a port.
- **An interruptible probe stands in for the un-interruptible call.** Before `connectDb()`, boot
  `fetch`es the primary's `/health` with an `AbortSignal.timeout` (10s, `TURSO_PROBE_TIMEOUT_MS`, `0`
  disables). `fetch` is ordinary async I/O and *can* be abandoned; the libSQL call cannot, because no
  `Promise.race`, `setTimeout` or signal handler gets a turn on the event loop while a native call is
  running. **Any HTTP response counts as reachable**, 401 and 404 included — the question is whether
  a connection completes, not whether the URL is right. Only a transport failure is a negative, and
  it now costs ten seconds and a named cause (paused/archived database, expired token, wrong URL)
  followed by `process.exit(1)`. Exiting is also the better outcome for Render: a *failed* deploy
  leaves the previous one serving, where a *hung* one leaves nothing.
- **Boot lines are written with `fs.writeSync(1, …)`, not `console.log`.** Under Render stdout is a
  pipe, and Node writes to a pipe asynchronously — the bytes wait for the event loop. A `console.log`
  placed immediately before a call that blocks the event loop forever is therefore never flushed: the
  process hangs holding its own explanation. Only the handful of boot lines that sit next to a
  blocking call use it (`bootLog` in `db.js`); everything else logs normally.

**The Node version is pinned too** (`.node-version` = `22`, `engines.node` = `22.x`). `>=20` let
Render install Node 26 against a codebase developed and tested on 22, with `@libsql/client`'s native
bindings restored from a build cache rather than rebuilt. That was never proven to be a cause — an
ABI mismatch throws rather than hangs — but a deploy is the wrong place to discover a Node version
nobody has run the tests on.

`server/test/dbBoot.test.js` pins both halves: that importing `db.js` against an unroutable primary
completes without connecting, and that the probe gives up on its own budget. Neither is observable
from inside a healthy app, and a regression in either is silent until the next deploy against a slow
primary.

**The standing lesson, sharper than 5.1's.** *Check what blocks before putting it on a timer* was
half of it. The other half: **a boot step that can block must not be able to block silently.** Open
the port, name the step, and make the thing you cannot interrupt be preceded by something you can.

**Phase 6 — the embedded replica is removed (decided, shipped; this reverses Phases 0 and 5).**
Phase 5.4 opened the port before the database work and the next deploy still timed out — because
binding a socket is necessary and **not sufficient**. The log says it exactly:

```
13:02:30  Dogfight server listening on port 10000 — answering 503 until the database boot finishes
13:02:34  Database: primary answered, replica open in 3474ms
13:03:03  ==> No open HTTP ports detected on 0.0.0.0, continuing to scan...   (x5, to 13:07:40)
13:07:40  ==> Port scan timeout reached
13:15:37  Database: ... synced from the primary in 783198ms
13:16:59  ==> Timed Out
```

The port was open at 13:02:30 and Render saw nothing, because `db.sync()` then blocked the event loop
for **783 seconds**: the process never reached `accept()`, and a listening server that cannot run its
own accept loop is indistinguishable from a dead one. Render gives up after five minutes.

**The cause is architectural, and it is the same one as the 6GB Turso bill.** Render's free tier has
no persistent disk, so `replica.db` is gone on every cold start and every boot re-downloads the whole
database. That was always the dominant cost; as the database grew it became the outage. And it was a
trap with no exit from inside: the re-encode tool that would shrink the database needs the app to
boot, and the app could not boot because the database was too big.

So the replica is **gone from the code**, not switched off behind a flag — `buildClientConfig` returns
`{ url, authToken }` and `libsql://` resolves to the Hrana-over-HTTP client: lazy, no native binding,
no local file, no `sync()`, nothing that can block the event loop at boot or at any other time.
Deleted with it: `syncReplica`, `syncOnce`, `startSyncLoop`, `nextSyncDelayMs`, `syncHealth`,
`SYNC_SECONDS`, `TURSO_REPLICA_PATH`, the frame counters, the SIGTERM flush, the `db:sync_health`
event and `SyncHealthBanner`. `probePrimary`, `bootLog` and the 503 gate all stay — no longer
load-bearing, still the difference between a named boot failure and every request 500ing.

Two lines in that log were **bugs of this project's own**, and both are fixed here:

- **`boot pull moved 0.0MB` was wrong instrumentation, not good news.** Confirmed in the libSQL
  source: on the pull path `try_push`/`try_pull` returns a hardcoded `frames_synced: 1`, and the
  bootstrap `/export` download is not counted at all. The number was a constant being formatted, and
  it is exactly the kind of confident zero that is worse than no logging. (`FRAME_BYTES = 4096` was
  wrong too — a WAL frame is 4096 + a 24-byte header.)
- **`VACUUM` at boot was actively harmful.** It rewrites every page, replication's unit is the
  modified page, so under `offline: true` the next sync pushed the *entire database* — the
  `sync took 72979ms` at the end of that deploy. It is removed: with no replica and no local file
  there are no freed pages of ours to reclaim, so a VACUUM would now be a full-database rewrite
  bought for nothing.

**The risk, stated plainly: this may make actions feel slow again.** Phases 0–5 exist because a
14-deep declare against a remote database took 3–5 seconds, and a remote connection puts the network
back on each statement. What did not exist then and does now is the half of that work which was never
tied to the replica: **`readMany`/`writeMany` collapse a group of statements into one round trip**,
and the DDL queue does the same for the ~148 statements a boot used to make. The remaining depth is
far below the depth that caused the original complaint — but that is a reasoned expectation, not a
measurement, and it cannot be measured anywhere but production, because it depends on the real
network path between Render and Turso.

**So measure it.** `scripts/latency.mjs` (new, read-only, safe against a live game) reports the
server-side cost of one round trip and the wall-clock of the read-heavy endpoints:
`E2E_URL=https://… node scripts/latency.mjs`. `readMs` on `/api/health` is the per-statement number
every handler pays. If it is bad, the honest options are more batching where the chains are deepest,
or a paid Render plan with a persistent disk — which is the only thing that makes an embedded replica
viable here at all.

**The standing lesson.** The replica was not a bad idea; it was a bad fit for a host with no disk,
and the arithmetic that made it a bad fit (bootstrap cost x cold starts per day) was available from
the first day and never done. **Before adopting a cache, price the cache miss and count how often it
happens.**

## Action latency — measured, not estimated (decided, new)

Reported twice, most recently as "even on perfect internet I experience a 3 sec delay between
making an action and seeing the change". The earlier round-trip work (Phases 0-5, now reversed
— see Database round-trips) was argued from **query counts**, and the Phase 5 note already
records why that was the wrong unit. This is the right one.

**Wall time ≈ sequential depth × round trip.** Queries issued together cost one trip; queries
issued one after another cost one trip each. `readMany`/`writeMany` exist to turn the second
into the first. So the number that matters is the **wave** count — a wave being a group of
statements that were in flight at the same time, which makes the wave count the sequential
depth exactly.

**`server/dbProfile.js` measures it**, off unless `DOGFIGHT_PROFILE=1`, with
`DOGFIGHT_TRACE=<event>` printing one action's waves in order. `scripts/profile-actions.mjs`
drives the actions a player waits on and prints the table; `GET /api/profile?role=gm&rtt=N`
reads it back. Measured against a local file, so the DEPTH is exact and only the multiplier is
unknown — which is the right split, because the multiplier is the one thing a local run cannot
know and `scripts/latency.mjs` measures against the deployment.

| action | queries | **waves** | @40ms | @120ms | @200ms |
| --- | --- | --- | --- | --- | --- |
| `combat:character_done_declaring` | 114 | **78** | 3.1s | 9.4s | **15.7s** |
| `combat:next_round` | 32 | **17** | 0.7s | 2.0s | 3.4s |
| `move:declare` | 29 | **15** | 0.6s | 1.8s | **3.0s** |
| `GET /api/combat` | 22 | **11** | 0.4s | 1.3s | 2.2s |
| `GET /api/characters/:id` | 17 | **8** | 0.3s | 1.0s | 1.6s |
| `stamina:adjust` | 2 | **2** | 0.1s | 0.2s | 0.4s |

**`move:declare` at 15 waves is 3.0s at a 200ms round trip — the reported number, exactly.**
Note what that implies: the delay is not the player's internet, it is the hop between Render
and Turso, and it is paid fifteen times for one declare.

The `move:declare` trace shows where they go: waves 2-10 are **nine independent reads in nine
waves** — the pair, leg dice, move tags, character tag overrides, roll slots, the previous
move, perk definitions, per-character frame overrides, a COUNT — almost none of which depend on
each other's results. `character_perks` is read **twice** in that stretch (waves 8 and 9),
once for tags/stamina and once for frame deltas, because `withPerkCache` does not wrap this
path. Waves 12-15 are the `emitCombatUpdated` broadcast rebuilding the whole combat payload.

**Ranked by payoff, and none of these are speculative — each names its own waves:**

1. **Move the database next to the server.** Zero code, and it divides EVERY row above by the
   same factor: at 40ms instead of 200ms, declare is 0.6s and the resolution is 3.1s. If the
   Turso database and the Render service are in different regions this is the whole problem,
   and `scripts/latency.mjs` against production says so in one number (`readMs`).
2. **Batch waves 2-10 of `move:declare` into two or three `readMany` groups** (~6 waves saved,
   1.2s at 200ms). They are already independent; nothing about the logic changes.
3. **Wrap the declare path in `withPerkCache`** so `character_perks` is read once (~1 wave).
4. **`combat:character_done_declaring` at 78 waves is the real monster** and needs its own
   pass: it is the resolution loop, which walks Tics and moves with per-step queries. Worth
   profiling with `DOGFIGHT_TRACE` before touching, because 78 waves will not come down by
   guessing at it.
5. **The broadcast costs 4 waves on every write.** Rebuilding the whole combat payload after
   each declare is most of `GET /api/combat`'s own depth, paid again.

Not done here — the ask was to investigate and suggest. The profiler is the deliverable that
makes any of it verifiable afterwards rather than hopeful.

## Hosting cost — bandwidth and sync (decided, new; phase 1 shipped)

The app went 60% over Render's included bandwidth (7.97GB against 5GB — 4.82GB
WebSocket, 2.93GB HTTP) and pushed ~6GB through Turso's sync allowance in a single
billing period. A forensic pass found all three numbers trace to one habit rather than
three separate problems: **base64 images in TEXT columns, shipped inside JSON.**

- **Turso.** `render.yaml` has no `disk:` block, so `replica.db` does not survive a
  restart and **every cold start downloads the whole database**. Render's free tier spins
  down after ~15 minutes idle and every deploy restarts it too, so a 30–150MB database
  (that size *is* the images) times several boots a day is the entire 6GB. The sync loop
  is rounding error beside it.
- **WebSocket.** `emitStageUpdated()` re-sent the scene backdrop, every summoned figure's
  full picture and every stroke ever drawn — to every socket — on all thirteen of its
  triggers, including each figure drag and **each pen stroke**. Measured: **600KB per
  gesture, per viewer.**
- **HTTP.** No compression at all, and because every image was a `data:` URI inside JSON,
  **the browser cache could not work** — every portrait re-downloaded on every page load
  and every phone unlock.

### Phase 1 — compression, deltas, and idle sync (shipped)

- **gzip on every HTTP response** (`compression`, mounted above every route). Base64
  gives back ~25% — it re-encodes already-compressed bytes into a 64-symbol alphabet —
  but the *structural* JSON this app is mostly made of gives back **~95%**, and the built
  client bundle drops from ~968KB to under 300KB on every cold load.
- **`perMessageDeflate` on Socket.io**, which v4 leaves **off by default** for memory
  reasons (one zlib context per connection). Right call at thousands of sockets, wrong
  one for a single table shipping JSON. A `threshold` keeps the small deltas uncompressed,
  where framing would cost more than it saves.
- **`Cache-Control: immutable` on static assets** — safe because Vite content-hashes every
  filename — with `index.html` explicitly `no-cache`, since its URL is stable while its
  contents name the current bundle.
- **A pen stroke is its own event** (`scene_draw:added` / `scene_draw:cleared`) instead of
  a full stage rebuild, and coordinates are **rounded to 4 decimals** — a ten-thousandth
  of the stage is far finer than a pixel, and full double precision cost ~41 bytes per
  point against a 4000-point cap. **607KB → 3.2KB per stroke.**
- **`character:updated` carries no picture bytes** (`omitCharacterArt`, `server/payloads.js`).
  It fires on every Stamina change — several times per fighter per round — and was carrying
  *two* base64 images to deliver a two-byte integer. **300KB → 0.3KB.**
  - **Its consumers must MERGE, never replace.** Two of them replaced
    (`CharacterSheet`, `CombatArena`) and were fixed in the same commit; a consumer that
    replaces will blank the portrait until the next full fetch, and the fix is always to
    make it merge rather than to put the bytes back.
- **The sync loop skips when nothing has been written** — *moot, and then deleted: Phase 6
  removes the loop entirely.* It used to push on a timer regardless — 8,640 round trips a
  day against a database nobody had touched.
- **`.sync()`'s `frames_synced` is logged** (frames × 4096 = bytes) — **this was wrong, and
  it is deleted.** The intent was right: a 6GB bill could only be reasoned about by
  arithmetic, so the boot pull should print its own size. But the number is not a
  measurement. libSQL's pull path returns a hardcoded `frames_synced: 1` and does not count
  the bootstrap download at all, so a 13-minute full-database pull printed `0.0MB` — a
  confident zero, which is worse than no logging. (The frame size was wrong too: 4096 plus
  a 24-byte header.) The lesson is worth more than the line: **before trusting a metric,
  find where the number is produced.**
- **The August Temporary-Damage migration is guarded.** It re-scanned every row of `dice`
  with a correlated subquery on every boot, forever, to add zero. Kept (a database that has
  genuinely never booted since must still be repaired) but behind a single existence check.
- **`scripts/playtest-bandwidth.mjs`** asserts byte ceilings on real payloads, so a future
  `SELECT *` carrying an image back into a broadcast fails a test rather than a bill. It
  measures HTTP over raw `node:http`, because `fetch` decompresses transparently and would
  report what the app produced rather than what Render charges for.

### Phase 2 — images become cacheable URLs (shipped)

Images **stay in Turso**; only the transport changed. A row now carries
`image_url` instead of base64, and the browser fetches each picture once.

- **`GET /api/img/:kind/:id/:hash`**, one route for all ten image columns across
  nine tables. `kind` is a **key lookup into a frozen registry** (`server/images.js`),
  never a fragment spliced into SQL — an unknown kind is a 404 before a query is built.
- **The content hash lives in the path, not an ETag.** An ETag still costs one
  conditional request per image per page load; a hash makes a changed picture a
  *different URL*, so the response is `immutable` for a year and a re-upload is picked
  up instantly. The stale-image-after-upload failure mode is unrepresentable rather
  than merely unlikely. Ten `image_hash` columns, backfilled at boot before the server
  accepts a request; a row that somehow lacks one serves under a `live` sentinel with
  `no-store` — correct, just uncacheable, never a 404.
- **The route recomputes the hash from the bytes it is about to send** rather than
  trusting the stored column. The column is an optimisation (it lets the hot paths
  select a cache key without dragging bytes into the process); trusting it would make a
  stale one dangerous, because a year-long cache entry could be pinned to bytes that had
  moved on. Recomputing means a stale hash can only ever produce a URL that fails to
  match, which is served and simply not cached.
- **A security fix shipped with the route, not after it.** As inert `data:` URIs these
  bytes were harmless; served from our own origin, the stored `image_mime_type` becomes
  a content type the browser **obeys** — and this app has no auth by design, so anyone
  with the link can upload. An allow-list guards both the read and write paths (SVG is
  refused specifically: it looks like an image type and is really a document type), with
  `X-Content-Type-Options: nosniff` and a null CSP behind it.
- **Two chokepoints carried most of the win:** `attachInteractions` (every path to a move
  row passes through it — `getMovesFor` runs once per **seated character** inside
  `/api/combat`, so the whole compendium's art was duplicated per fighter) and
  `buildStagePayload`, which is emitted per socket from thirteen call sites.
- **`portraitSrc` kept its exact signature**, so all eleven call sites were untouched.
  `client/src/lib/portraitCache.js` is **deleted** — a hand-rolled base64→blob decode
  cache whose own header admitted it saved zero bytes; the browser does that natively for
  a real URL.
- **Two things genuinely broke and were fixed here.** Copy Move re-uploaded the source's
  base64, which the client no longer holds — the server copies row to row now, as
  `scene_picture:copy_from_profile` already did, which is also less traffic than before.
  And `ScenePage`'s `img.complete` effect **stays**, with its comment rewritten: it
  blamed `data:` URIs, but an `immutable` cached image completes just as instantly, so
  the drag-down bug it guards is exactly as live.

Measured: **a stage drag went 600 KB → 0.4 KB per viewer**, `GET /api/characters`
600 KB → 0.3 KB, `GET /api/stage` 603 KB → 1.1 KB. `scripts/playtest-bandwidth.mjs`
enforces those as ceilings now, and also asserts the cache and security headers.

### Phase 3 — shrink the database, which shrinks the boot pull (shipped)

The phase that moves the Turso number, because the boot pull **is** the database.

- **Everything encodes to WebP now.** The five upload pipelines saved JPEG, and passed
  PNG through **losslessly** whenever the source was PNG — which is how `scene_pictures`
  came to hold the largest rows in the schema (a 1024px transparent cutout is routinely
  1–2MB before base64). WebP keeps the alpha those cutouts need. Measured on
  artwork-like content: a 1024px scene picture went **1519KB → 24KB**, a 1600×900
  backdrop **2103KB → 25KB**. On incompressible noise the same encoder saves only ~9%,
  so the honest expectation for real art is a large multiple, not a fixed one.
  Portraits also drop 800px → 512px; backdrops **stay at 1600px** and change format only.
  **GIFs are never re-encoded** — a canvas export keeps one frame and kills the animation
  — and their upload cap drops 4MB → 1MB.
- **A GM-only "Re-encode Images" tool**, rather than a script. A one-shot migration would
  need Turso credentials to reach the live database; this needs nothing but being logged
  in as the GM. It reads `GET /api/image-inventory` (ids and sizes, never bytes — a
  listing that carried the pictures would defeat its own purpose), then fetches each
  picture, re-encodes it on a canvas, and sends back **only the results that came out
  smaller**. Safe to re-run: an already-optimal picture is skipped, and the server refuses
  a write that would make a row bigger, so the tool can only ever shrink the database.
- **Chat is capped to what is readable.** `CHAT_HISTORY_LIMIT` is a *read* limit —
  `GET /api/chat` returns the newest 300 — but nothing ever deleted the rest, so a long
  session left everything older in the database, unreachable by anybody and re-downloaded
  on every cold start. Whole rows go now, text and picture alike.
- **An orphan sweep at boot.** `scene_pictures` cascades from both owners and
  `relationship_people` from its character, so in a healthy database these find nothing —
  but the six table-rebuild migrations run `PRAGMA foreign_keys = OFF`, and any delete
  inside one of those windows skipped its cascade silently. **A NULL owner id is never an
  orphan**: `scene_pictures` has exactly one of `character_id`/`temp_npc_id` by its own
  CHECK, so reading a NULL as a missing owner would delete every picture in the world.
  That property is pinned by test, because this deletes artwork unattended.
- **Completed rounds are pruned to the current fight.** They outlive their fight so a
  "Watch Round N" card still works — but those cards live in `chat_log`, which is wiped on
  the same boot, so anything from an earlier fight was already unreachable. `round_events`
  cascades off them, which is where the bulk is.
- **`VACUUM` last — WRONG, and removed in Phase 6.** The reasoning was that SQLite never
  returns freed pages to the file on its own, so without it the database stays at its
  high-water mark. True of a local file, and the exact opposite of helpful against an
  embedded replica: a VACUUM rewrites every page, replication's unit is the modified page,
  so the next sync pushed the whole database. It is gone, and there is nothing left for it
  to reclaim now that Turso owns the pages. The whole block is still wrapped: a world that
  cannot be tidied is still a world that can be played.

**A move may not be pushed more than ONE round into the future (decided, new).** A
cascade that shoves a declaration into the NEXT round is an ordinary postponement — it keeps
its place at the spot the cascade put it and hands its Stamina back, which is the existing
`leavesRound` rule. A cascade that would shove it TWO rounds out is not a postponement: the
player declared it for this round's shape, and two rounds of that shape have changed
underneath it. Those are **refunded in full and taken off the board**.

- **`pushHorizon` (`server/combatDamage.js`, unit-tested) is the single rule**, returning
  `'this-round' | 'next-round' | 'too-far'`. Both push paths classify through it, so the
  boundary is pinned by test rather than by two similar-looking inequalities in two files. It
  asks `overlapsRoundWindow` once per window — "is it in this round" already has exactly one
  answer everywhere in this codebase, and the next round is that same question one window
  along. A move whose FOOTPRINT still reaches back into the next round is `'next-round'`, not
  too far: some of it genuinely happens within one round of where it was declared.
- **Both push paths, not just the obvious one.** The Block/conflict cascade got the new branch
  in `resolveMoveConflict`; the **grapple chain had no round awareness at all** and could shove
  a queued move arbitrarily far down the Tic strip. It reads its window from
  `pair_round_resolutions` — the same source `planCascadeFor` uses, because `combat_pairs`
  carries the round's START but not its LENGTH and so cannot answer the question alone. (Using
  `combat_pairs` was a first attempt, and it failed loudly: the column does not exist, the query
  threw, and `playtest-grapple-chain` went from green to nine failures.)
- **`scripts/playtest-push-cap.mjs`** drives the real `combat:resolve_move_conflict` handler on
  real rows, with the pause written directly so `blockedUntil` lands two rounds out — a
  two-round push is not reachable from a natural fight. It proves the row is deleted AND that
  the Stamina comes back, and it drains the pool first, because `adjustStamina` clamps at
  `max_stamina` and a refund into a nearly-full pool passes a naive assertion for the wrong
  reason (observed: a 3-point refund reading as +1).

**A derived field can be silently un-derived by a spread (bugfix — `attack_targets.map
is not a function`).** `withImageUrl` returns `{ ...rest, image_url }`, where `rest` is
the **whole row** minus the three image columns. `attachInteractions` spread it LAST,
under a comment asserting it "only ever REMOVES image_data/image_mime_type and adds
image_url, so it cannot disturb any of the derived fields above it". That was simply
false, and it put the raw `attack_targets` and `defense_frame_positions` JSON strings
straight back on top of the arrays the same object had just parsed.

Three things made it survive two PRs:

- **Nothing threw at the boundary.** The payload was well-formed JSON; it was just the
  wrong type, in two fields, on every move-bearing endpoint.
- **The client's guard let it through.** `move.attack_targets?.length` is truthy for a
  string, so `'["Skull"]'` passed the check and died on `.map` — taking the page down
  rather than showing one wrong line. That guard is now `Array.isArray`, so a
  recurrence is a missing field instead of a white screen at the table.
- **Every other call site had it right** (`shapeCharacter`, the perks list), so the
  pattern looked proven.

The fix is ordering: the shaped row is spread FIRST and every derived field is applied on
top, which is the shape that cannot have this bug. `server/test/images.test.js` pins the
property rather than the symptom — that `withImageUrl` carries every non-image column —
including an executable demonstration of the wrong spread order, so a future reader who
believes the old comment fails a test instead of shipping it.

#### What remains

**The thing none of this fixed, until it took the site down.** Render's free tier has no
persistent disk, so the replica was rebuilt on every cold start — this work made that pull
smaller, not absent, and the database grew back past Render's five-minute port scan anyway.
**Phase 6 of the round-trip section resolves it by removing the replica**, which deletes
the cold-start pull entirely rather than shrinking it. The sweeps above still matter and
still run: they are now the *only* thing bounding the database's size, since nothing else
was ever going to prune a table nobody prunes.


## Characters
- **Roster** (`/`, GM only — a Player is sent to their own sheet): cards in a responsive grid with an edge-to-edge portrait, an NPC badge and a folder-path chip; a nested folder tree (`FolderTreeNav`) beside it (a "Change…" drawer below `md:`), drag a card onto a folder to file it or tap its ⇄ button. Folder create/rename/delete and filing are GM-only.
- **+ Add Character** (decided, revised — plain create): name, PC/NPC toggle, folder picker, and an optional profile picture (`usePictureUpload`/`fileToPortrait`, with the crop preview) — sent in the one `POST /api/characters`. Delete asks for confirmation and cascades through everything the character owns (Counters and their Gates, Role-play, Relationships boards, Scene Pictures and summons).
- **Character sheet** (`/character/:id`): a header with the editable **name** and **profile picture** (click to replace, crop editor), then four tabs — **Counters** (default), **Role-play**, **Relationships** (PCs only) and **Scene Pictures**. Same open-access editing as everywhere else.
  - **Back arrow (decided, new):** for the GM, "Back to folder" returns to the roster in the folder the sheet was opened from (`location.state.fromFolder` → the roster's `location.state.folder`). A sheet opened another way, such as from Search, returns to the character's own folder, and a folder deleted meanwhile falls back to the root. A Player has no roster: on an NPC assigned to them the arrow is "Back to my character", and on their own sheet there is none.
  - **Role-play:** persistent free-text answers under seven canonical questions (what they love and can't pass by on the street; biggest traumatic memory; irrational fear; favourite food; what infuriates them; biggest vice; what they would fight for, no matter what), plus up to 20 custom questions per character. Answers are keyed by the question's exact text, so appending to `FIXED_QUESTIONS` is safe and rewording one orphans its answers.
  - Relationships and Scene Pictures are described in their own sections below.

## Game mechanic — Counters
Simple, persistent "clocks" — no automation, just a name, a target (2-20 pips), a current count, and +/- buttons, on a character's **Counters** tab. Created by whoever controls that character. Every Counter belongs to a character (decided, revised: standalone Arena counters are no longer created; existing ones are kept in the database — see The pivot).
- **Gates (decided, new)**: a marker the GM puts on **one pip** of a Counter — *when this fills to here, something happens*. A Gate carries a **name**, a **description** and a **Secret** switch, and no mechanics of its own: it is a reminder with a place on the clock.
  - **The pip is drawn twice the size, for everybody.** That a point of progress matters is never the secret; the secret is only what happens there. The table can always see one coming, which is most of what makes a Gate worth putting down.
  - **Secret decides who may read the WORDS.** Off, everyone reads the name and description by hovering the pip. On, a Player sees `???` for both — and sees it because the payload does not contain them. **Protect by absence**, the same rule the board's private data follows: a flag saying "hide this" is a request, and the network tab answers it either way. `visibleGate` in `server/counterGates.js` is the only place that decides.
  - **Authoring is GM-only, and that is the mechanic rather than a permission.** `secret` means nothing if the person it is kept from can author it. Counters themselves stay open to whoever controls the character, exactly as before.
  - **One Gate per pip**, as a `UNIQUE(counter_id, pip_index)` rather than a convention — a Gate is a property of a pip, and two on one pip would be two things to draw in one place and two lines to post at one moment. Saving is therefore an upsert: the editor opens on a pip and neither knows nor cares whether a row is already there.
  - **Reaching one posts to the Chat Log.** Upward only, and inclusive at the top (`from < pip <= to`): landing on a Gate reaches it, ticking back down past it is a correction rather than an event, and coming back up reaches it again because the second time is a second time the table needs reminding. One `+5` announces every Gate it passes, in order, computed against the *clamped* value so it never announces past the end. The line names an open Gate and **never** a secret one — chat is broadcast to the whole table, so it is the one place a secret could escape by accident.
  - **Gates ride their own per-viewer channel** (`counter_gates:updated` and `GET /api/counter-gates`), not the Counter payload. A Counter is public — `counter:updated` is an `io.emit` — so folding Gates in would have meant making five broadcasts and two REST payloads viewer-aware. A second channel that already knows who is asking is smaller and harder to get wrong; it is the shape the Relationships board uses.
  - `CounterPips` draws the pips, Gates included, wherever a Counter is shown.
  - **`DialogShell` gained an opt-in `portal`.** The Gate editor is opened from a Counter row, deep inside the sheet's tab body: `fixed inset-0 z-50` put it in the right place and painted it *under* the page around it, so it was visible and every click on it landed on `<main>`. Found by measuring `elementFromPoint` on the dialog's own Cancel button. Off by default — the ten dialogs that predate it all render near the page root and work.
- **Reward tag (decided)**: a character-owned counter can optionally carry one **Reward** — purely a tracking label, no mechanical effect — set at creation or changed any time after via a small colored select that doubles as the tag itself, next to the counter's name. Five types, each with its own color: **Story** (amber), **Statistic** (blue), **Perk** (violet), **Move** (orange), **Combat Prowess** (red). (A pre-pivot standalone counter can never have one; `counter:set_reward` ignores it.)
- **The open drop-down used to be unreadable, and the cause was global (fixed).** Reported on this control: the reward select's *closed* state is a coloured pill, and the pale `color` it sets was inherited by its `<option>`s into a popup the browser painted **light** — because the document never declared `color-scheme`, so a dark app was asking for light widgets everywhere. One line on `:root` (`color-scheme: dark`) fixes all thirteen `<select>`s in the app at once and takes native scrollbars, checkboxes and date pickers with it; an explicit `option { background-color; color }` rule backs it up, because engines disagree about how much of a popup an author may style, and states it once rather than at each select — several of which deliberately colour the closed control and must not leak that colour into the open list.

## Game mechanic — Chat Log
A single shared feed for the whole table (`ChatPanel.jsx`). Two entry kinds survive the pivot:
- **Messages (`kind='message'`):** a compose box at the bottom — a Player posts as their own character (a fixed label, or a **Post as** picker when the GM has assigned them NPCs — see Roles / access model); the GM defaults to a **GM** persona and may pick any character instead. `characterId: null` means "post as GM", stored with the sentinel `GM_CHAT_SENTINEL_ID = 0`. Text (≤2000 chars) and/or an image: pasted, or picked with the paperclip (`fileToChatImage` — static images capped at 480px wide; GIFs sent as raw bytes, ≤4MB, so they stay animated; Socket.io `maxHttpBufferSize` is 8MB). Each entry shows the poster's avatar, name and time.
- **Rolls (`kind='roll'`) from the Dice Tray:** five small d4/d6/d8/d10/d12 buttons (`DiceIcon.jsx`, inline SVG) plus a ±20 modifier stepper above the compose box. Clicking a die emits `dice:roll_custom { characterId, size, modifier }`; the server rolls `1d{size}`, clamps the modifier, and posts `roll:result`. The line reads `d8: 6 + 3 = ` with the result bold and larger; the die face is recovered client-side as `result − modifier`. The tray's modifier persists between rolls.
- **Counters from a roll card:** every roll card carries a small `+` opening `CounterAdjustDialog` — the roller's own Counters, each adjustable, plus a create form — reusing `counter:create`/`counter:adjust`. Centred on mobile so the bottom nav never covers it.
- **System lines:** a Counter reaching an open Gate posts a plain line (see Counters).
- A page load fetches the last 300 entries. The log is cleared on every server boot (`DELETE FROM chat_log`) and by the GM's **Clear Chat** button.

## Global UI — Search
Every page's header carries a Search bar for all roles. Typing debounces (250ms) `GET /api/search?q=…`, which matches **Characters** by name (case-insensitive substring) and returns `{ characters }`. NPCs are filtered out client-side for Players. Clicking a result opens that character's sheet.

## Global UI — Visual Theme
A red/black metallic fighting-game look (Tekken/Mortal Kombat reference). A `--color-brand-*` red scale (`client/src/index.css`'s `@theme`) is the one UI accent; warm-tinted `zinc-700…950` surfaces and a `.bg-arena` radial glow on full-page shells. The Settings page regenerates the whole brand scale from one picked hue (`client/src/lib/theme.js`), persisted in `localStorage` and applied before React renders. `.panel-cut-sm/-/-lg` diagonal-cut corners replace rounded corners (`rounded-full` pills excepted). Rajdhani (`font-display`) for headings, buttons, labels, uppercase chrome and chat. Themed scrollbars everywhere; `color-scheme: dark` on `:root` so native widgets (select popups, date pickers) render dark. An anime "Ink & Impact" pass was built and reverted in full (PRs #51-#55) — a judgement about the look; don't re-attempt it as a whole-app pass.

## Settings
`/settings`, via the header's cog, every role; all settings persist per browser.
- **Primary Color** — preset swatches plus a custom picker and reset (see Visual Theme).
- **Scene Stage** (`client/src/lib/sceneSettings.js`) — Character Height (0.5–1.5×), Distance Apart (0–3×), Picture Size (0.5–2×) and Show name plates, applied to your own view of the stage only.
- **Simple Combat Lanes** (GM-only, the whole table): 1, 2 or 3 lanes of ten.
  - **Lane height (decided, new):** a slider that moves the lanes up or down the screen (still centred), from 20% to 90% of the stage height, with Reset to the original 5/7. It is table-wide: `table_settings.lane_y` (NULL = 5/7), sent as `table_settings:set { laneY }`, and the stage payload carries `laneY`. `laneGeometry` takes it as its centre.
- **Old System Archive** (GM-only) — lists the pivot's archive(s) with row counts and a **Download JSON** link, and shows the purge status, including any problem the boot recorded.

## Game mechanic — GM Tools
A small circular widget overlaid on every page, GM-only (`GmToolsWidget.jsx`, mounted in `App.jsx`). Tapping it darkens and blurs the page and opens a list of tools: **Preset Narrative Combat Weight** (see the Panic at the Dojo section, "Cinematic Weight as built"), the **Audio Player** (below), **Re-encode Images** (see Hosting cost, Phase 2) and **Commit Homebrew** (see "Commit Homebrew"). The server checks the GM role itself; hiding the widget is a convenience, not the boundary.
- **The app has one error boundary** (`ErrorBoundary.jsx`, wrapping the router in `main.jsx`): anything that throws during render shows a reload prompt instead of an empty page.
- **Audio Player (the third tool, decided, new; implemented).** A GM-run
  soundtrack that every connected client hears **at the same point in the same
  song**, including somebody who joins twenty seconds late. Playback survives
  changing tabs and navigating into and out of the chrome-free Scene route, and
  stops only when the GM stops it.

  **The hard rule, stated by the user and enforced rather than aspired to: it is
  better to play nothing than to play out of sync.** A client that cannot
  establish where it should be goes silent instead of guessing.

  - **Songs are YouTube links, never uploads.** A song is three orders of
    magnitude larger than a portrait, and `express.json` caps a request at 3mb —
    so the database stores an 11-character video id and YouTube does the
    serving. **Video is never shown**: the player is a real 240×135 iframe
    parked 9999px off-screen. Deliberately not `display:none` (which removes it
    from the render tree, and browsers then stop or refuse to start media in it)
    nor `visibility:hidden` (treated inconsistently across engines) nor a 1×1 box
    (YouTube's own player logic misbehaves at degenerate sizes). Off-screen is
    the one variant every browser agrees about.
  - **The server stores an ANCHOR, not a position** — see `audio_state` in the
    Data model for the full reasoning. It is the first wall-clock-authoritative
    state in this codebase; combat Tics are a plain counter that advances by
    event, and nothing before this needed to make a claim about real time.
  - **Clients measure their clock against the server's rather than trusting it.**
    Five sequential `audio:ping` round trips, and `clockOffset` keeps the
    **lowest-RTT** sample — a fast trip has less room to be asymmetric than a
    slow one, and averaging drags the good sample toward the bad ones. Sequential
    rather than parallel because simultaneous pings queue behind each other on
    one connection and every RTT but the first would be inflated. Measured on
    `performance.now()`, which is monotonic, so an NTP correction mid-session
    cannot silently poison every position computed afterwards.
  - **A handshake that fails is retried, and a good reading is never thrown away
    (bugfix — "it says re-syncing and does not play").** Reported from a phone,
    and the gate was doing exactly what it was told: the clock must be inside
    ±250ms, i.e. a best-of-five round trip under 500ms. On mobile data against a
    free-tier host that has just woken up, that is a coin flip — and losing it
    was **permanent**, because nothing measured again. Worse, every
    `visibilitychange` **deleted** the existing offset before re-measuring, so on
    a phone (where switching apps is constant) a working clock had to survive an
    unbounded run of those coin flips while a broken one never recovered.

    The gate itself is unchanged — the table's rule is still "better silent than
    out of sync". What changed is that failing it is no longer terminal:

      - **Lowest-RTT-wins now applies ACROSS handshakes, not just within one.** A
        12ms reading from a minute ago is better evidence than a 600ms one taken
        now, so a measurement is replaced only by a better one, or once it is
        older than five minutes (`CLOCK_MAX_AGE_MS` — long enough that an app
        switch does not chop the music, short enough not to bet audio on a clock
        that slept through a suspend).
      - **Retries back off (750ms → 20s) with more samples each time** (9, up
        from 5): the minimum of N round trips can only improve as N grows, which
        is the honest way to get a clean reading on a link where most trips are
        slow and a few are fine.
      - **Retries only run while something is actually playing**, so an idle
        table pings nobody — verified by counting frames, not assumed.

    `scheduleClockRetry` is **idempotent**, and that is load-bearing rather than
    tidiness: it is called from the recovery tick, from reconcile's own no-clock
    gate and from every broadcast, and a first draft that cleared and re-armed
    the timer on each call would have pushed the retry further out on every tick
    and never fired it at all.
  - **A silent client re-checks itself until it converges (bugfix, same report).**
    `reconcile` is event-driven by design, which is right for drift — but several
    of the states it can land in are silent ones waiting on something that fires
    no event: an advert finishing, a buffer that filled while the tab was hidden,
    a load that never produced a state change. Those **latched**, and a latched
    silence is indistinguishable from a broken feature. So while this client is
    silent AND the table is playing, a 2.5s tick re-runs reconcile. It costs
    nothing in the normal case, because a client that is playing is not silent.
  - **The indicator says WHY it is silent, not just that it is.** Every silent
    state rendered as the same "re-syncing" — true of all of them, useful about
    none, and the reason the first report of this bug could not say more than
    "it says syncing". `silentReason()` maps the engine's own detail to words:
    *loading the track*, *buffering*, *measuring the clock*, *reconnecting*, *an
    advert is playing*, *out of sync — retrying*.
  - **Re-sync happens on events only — no polling timer (decided, explicitly).**
    The events are: a track starting or changing, play, pause, a GM seek, a
    socket re-connect, the tab becoming visible again, and the player's own
    transition out of buffering. **The accepted cost, recorded here so it is not
    rediscovered as a bug:** a client that stays connected and visible through a
    long track gets no correction, so drift can accumulate. If that turns out to
    be audible in play, the fix is one slow timer calling the already-built
    reconcile function.
  - **What "silent rather than out of sync" actually means.** The engine mutes
    itself when the clock offset is not established or is worse than ±250ms
    (half the best round trip is an honest bound on how wrong it can be), while
    buffering, after 30s offline, when three correction attempts have failed to
    land inside tolerance, and when the player's reported duration disagrees with
    the table's by more than 2s — **that last one is a pre-roll advert**, which
    drift alone cannot detect because the position looks fine, it is just a
    position inside the wrong audio. Tolerance is 400ms because
    `getCurrentTime()` is only about that accurate; chasing a tighter number
    produces seek-thrash, which is far more audible than 400ms of drift.
  - **The unlock is a gesture taken at face value, then VERIFIED (bugfix — "audio
    blocked, tap the record", and tapping the record did nothing, on desktop).**
    The original tried to *infer* permission: play, pause on the next animation
    frame, and two seconds later check whether a PLAYING state had been seen in
    between. **It could essentially never succeed**, for two compounding reasons:
    a YouTube embed does not reach PLAYING within one animation frame (its state
    changes cross an iframe by postMessage, hundreds of milliseconds later), so
    the pause cancelled the play *before* the event the detector was waiting for
    could fire; and at role-modal time there is usually no video loaded at all,
    so `playVideo()` had nothing to play. Either alone pins `unlocked` to false
    forever, and reconcile's gate then parks on `blocked` permanently — with the
    remedy it offers re-running the identical broken probe.

    **This is also the real cause of the earlier "re-syncing" report**, which was
    diagnosed as the clock gate. That clock work was a genuine latent bug and is
    worth keeping, but it was not what the table was hitting. Recorded as a
    standing lesson: *a fix that cannot be reproduced is a hypothesis, and the
    first thing it should buy is a better error message.*

    There is no probe now. A user gesture **is** the permission browsers ask
    for, so having one is taken at face value; and a tap now does the one thing
    that reliably works on Safari and iOS — calls `playVideo()` synchronously
    inside the click handler — rather than a ceremony whose result had to be
    guessed. Optimism is then checked by observation: `armPlayWatchdog` gives the
    player 4s to actually reach PLAYING or BUFFERING, and says `blocked` only
    when it does not. That is a fact rather than an inference, and PLAYING clears
    it.
  - **`onReady`'s iframe reload can no longer dead-end the engine (bugfix, same
    file).** When the embed's `allow` lacks `autoplay` it is set and the iframe
    reloaded, and the handler returned early waiting for a second `onReady` —
    but whether the IFrame API re-runs its handshake against the same Player
    object after a manual reload is not guaranteed. If it does not, `playerReady`
    stays false forever, every reconcile returns on its first line, and the
    engine is silently dead with no indicator saying so. The reload is now
    attempted at most once, with a 5s fallback that marks the player ready
    anyway: a player with the wrong `allow` may still fail to autoplay, but it
    can be started by a tap, which beats one that can never start at all.
  - **`window.__dogfightAudio()` dumps the engine's whole internal state.** The
    YouTube embed is unreachable from the development sandbox (the egress proxy
    refuses youtube.com), so every bug in the player half of `audioEngine.js` has
    had to be diagnosed by reading rather than running — and two were diagnosed
    wrong before being diagnosed right. The distinction between "the browser
    refused", "the API never loaded" and "the clock is not good enough" is
    invisible in a one-word status but obvious in `{ apiLoaded, playerReady,
    unlocked, currentVideoId, ytPlayerState, clock }`. No UI, no cost, and it
    turns the next report into a single answer.
  - **A one-second fade at each end of a song (decided, new).** `fadeEnvelope`
    (server/audioSync.js, unit-tested) is a pure function of **where in the track
    we are**, deliberately not a timed ramp fired by an event — a seek, a track
    change, a stall and a resume all move the position, and a position-derived
    shape reads the new one for free where a timed ramp would have to be
    cancelled and re-aimed at every one of them (a first draft did exactly that,
    and needed a rescue timer to stop one mis-aimed ramp muting a client for the
    rest of a song).
    - **Volume is a PRODUCT:** the listener's own per-device setting × the
      envelope. So the GM can move the volume slider mid-fade and the fade
      continues against the new ceiling, and an interrupted fade can never
      strand the listener's setting at some value it happened to ramp through.
    - **An unknown duration fades in but never out.** `duration_ms` is NULL
      until a client reports it (only YouTube knows a video's length), and a
      guessed tail would duck the middle of a song — far worse than no tail.
    - **Past the reported end the gain returns to 1.** The duration is a number
      some other browser reported; if it was short, the song is still playing,
      and the alternative is a client that muted itself with nothing coming to
      put it right. Reading "past the end and still going" as "that duration was
      wrong" is what makes one bad report cost a second of dip instead of the
      rest of the track.
    - **A track shorter than two fades is left alone**, rather than being made
      quieter than everything around it.
    - **An entry ramp on top**, taken as `min` with the envelope: a client that
      starts making sound somewhere other than a track's first second — joining
      mid-song, resuming, recovering from a seek — ramps up over the same second
      instead of slamming on. `min` rather than a product, so neither half can
      ever raise the other: joining two seconds before the end fades in AND out.
    - Driven by a 50ms `setInterval` (not rAF, which stops in a background tab)
      armed **only while this client is actually audible**, so a paused or idle
      table costs nothing.
  - **Autoplay is unlocked by the role modal.** Browsers refuse sound until the
    person has interacted with the page, and picking Player/GM is the one
    mandatory tap on every load — so `roleContext.jsx` calls the engine's
    unlock synchronously from inside that click handler. Synchronously and from
    the handler itself, not an effect reacting to `role`: that might survive
    Chrome's sticky activation but will not survive Safari's. The unlock
    unmutes *before* playing, because Safari records what the element did during
    the interaction and a mute-then-play unlock teaches it the wrong lesson
    permanently. Failure is detected (no playback within 2s) rather than assumed
    away, and the indicator then reads **"Tap to enable audio"** — which is
    itself a fresh gesture. **iOS is the standing risk here** and wants a real
    device test; the blocked-state affordance is the mitigation.
  - **Auto-advance without a ticking loop.** Clients report `audio:track_ended`
    and the first valid report wins (`anchor_id` de-duplicates the rest); once
    any client has reported a duration the server also arms a single
    `setTimeout` as a safety net for the case where every listener is
    backgrounded and no ENDED ever fires. One timer, re-armed on every state
    change. **Repeat (off / playlist / track) and shuffle are GM toggles**,
    defaulting to advance-and-loop. Shuffle is a *seeded* permutation so the
    server and every client agree on what comes next without negotiating — and
    so it can be unit-tested at all.
  - **The panel** is a fullscreen `DialogShell`, like Notes and Timestamps, and
    opens *instead of* the GM drawer rather than inside it (the drawer's scrim is
    `z-[60]` and `DialogShell` is `z-50`, so a dialog rendered within would paint
    underneath it). Playlists in a left rail, tracks on the right, a pinned
    transport row above. **A track row puts the name in the left half, truncated
    with `…`, and binds its tools to the right end** — Play/Pause, Move Up, Move
    Down, Edit, Delete, in that order, so a sixth tool appends on the right
    without moving the five already there. Delete is the only one that confirms.
    The tools are revealed by hover on a pointer device and by a completed tap on
    a touch one — **deliberately not this app's usual `.hover-only-action`
    convention**, which makes such buttons permanently visible on touch rather
    than revealing them; same bespoke approach `StageRoster` takes on the stage,
    and for the same reason. Move Up/Down send the whole new order, like
    `move:reorder`.
  - **The now-playing indicator: one bar, never two.** `CombatHeaderBar` — the
    global strip that used to exist only during a fight — gains a **second reason
    to render**, so on every page but the Scene the record and song name appear
    in exactly that row, in exactly its existing style. It also stops collapsing
    on the Arena while music is playing, or the indicator would vanish on one
    page. **On the Scene** there is no bar: the record and name sit top-right,
    always (not only in cinematic mode), with the text on the same tinted plate
    character nameplates use so the two read as one family over artwork. The chip
    steps inboard to `right-[17rem]` for a GM whose Scene list drawer is open,
    and sits at `right-3` otherwise — so it never covers the drawer and never
    moves at all for a Player.
  - **The record is a drawn SVG spun by Framer Motion, not a GIF.** There is no
    GIF, Lottie or animated asset anywhere in this repo, and `index.css` zeroes
    every CSS animation under `prefers-reduced-motion` — a GIF would ignore that,
    ship a fixed resolution to a high-DPI phone, and not follow the theme. The
    name scrolls only when it genuinely overflows. Both are materially smaller on
    mobile (`h-4 w-4 md:h-6 md:w-6`, `text-[10px] md:text-xs`), since mobile is
    the primary way this app is played.
  - **Tapping the record opens the Audio Player on the playing song's playlist**
    — GM only; for a Player it is a plain indicator. Routed through a
    module-level registry (`lib/audioPanel.js`), the same answer this codebase
    already gives three times for sibling components that cannot reach each
    other through props (see `ticDropTarget.js`).
  - **Volume is per-device and not synced** — everyone hears the same song at the
    same instant, but how loud it should be is a property of the room the
    listener is in. A Settings slider, localStorage, zero means muted. It does
    **not** use `sceneSettings.js`'s shared `saveScale`, whose `Number(v) ||
    fallback` coercion would turn a volume of exactly 0 back into the default —
    harmless for every other setting there, fatal for the one control whose zero
    is the point.
  - **The engine is not a React component**, and that is load-bearing rather than
    stylistic: `Shell()` in `App.jsx` has two separate `return` branches, so
    anything React renders inside it is unmounted when you cross into `/scene` —
    which would tear down and re-create the iframe, and re-parenting an iframe
    reloads it. So `lib/audioEngine.js` is a module singleton imported for its
    side effects in `main.jsx`, owning an element it appends to `document.body`
    and never moves. React only ever *reads* it, through `useAudioStatus`.
  - **What is playing is mirrored straight off the broadcast, separately from
    whether this device can play it (bugfix, found by driving the app).** The two
    were folded together at first, and the consequence was that a client whose
    YouTube was blocked or still loading showed *nothing at all* on screen while
    the rest of the table listened to a song. What is playing is a fact about the
    table; only whether this device can join it is a fact about the player — and
    a device that cannot reach YouTube now says so on the indicator.
  - `server/audioSync.js` holds everything expressible as a number — URL
    parsing, clock offset, expected position, seeded shuffle and next-track
    selection — pure, with no I/O, imported by *both* sides
    (`../../../server/audioSync.js`, the same cross-boundary sharing
    `CharacterCreationDialog` already uses for the creation rules). 21 unit
    tests, per CLAUDE.md's standing rule that the risky arithmetic is pinned
    before any UI touches it.

## Game mechanic — Relationships board (decided, new; Phase 1 implemented)

A seventh tab on a **Player Character's** sheet: an infinite 2D board where a player drags
NPCs out of the world roster — or invents people who were never fighters — and draws named,
coloured, directional relationships between them. Miro is the stated model. It is the first
thing in this app that is a *tool* rather than a rule: nothing here touches combat.

**Why it exists.** `roleplay_entries` holds seven prose questions and everything else on a
sheet is a fighter's mechanics, so who your character knows has had nowhere to live. The
world already has a cast, filed in nested `character_folders`, that a Player can see in the
Arena roster and nowhere else.

**Decisions taken up front** (each one asked, not assumed):

- **The board lives in the DB, keyed to the owning PC**, and is private to that character's
  viewer **plus the GM, who can fully edit it**. Not localStorage: a map that vanishes with a
  cleared cache is not a record.
- **Each placement is its own node**, with its own Nickname and Notes. The same NPC dragged
  out twice is two independent nodes — placing someone twice usually means they occupy two
  roles in your head, and shared fields would fight that.
- **Infinite canvas, pan + zoom.** Nodes are stored in world coordinates.
- **Phone is view-and-navigate only.** Precise pointer work has no room on that screen; the
  map stays readable there rather than being hidden.
- **The text halo is `backdrop-filter`** on a rectangle sized to the text — blur and fade
  what passes *behind* the box, text stays sharp on top. One CSS property, so it costs
  nothing at any node count.
- **Floating ends stay put, are draggable, and re-attach** by dropping on another node's dot,
  keeping colour, label and arrowhead.
- **If the GM deletes a world NPC, every node referencing it converts to a board-local
  person**, keeping the last-known name and picture, the player's Nickname and Notes, and
  every relationship. A GM tidying the roster must not silently destroy part of a player's map.
- **The emoji picker is a hand-rolled curated grid.** This client's entire runtime is react,
  react-router, framer-motion, gsap, lucide and socket.io-client; a picker library would be
  the largest dependency in it.

**Players see NPCs in the rail.** A deliberate exception to the rule that a Player never sees
an NPC outside combat (`CharacterList` filters them; a Player is bounced off an NPC sheet).
The Arena roster is the existing precedent: knowing who exists is not reading their sheet,
and a relationship map is worthless without the cast.

**Phased, five slices, each deployable.** Phase 1 ships the part that is expensive to change
later and cheap to change now — how the board claims space, how the camera feels, and what
the void looks like. Phases 2-5 add nodes, relationships, the editors, and the motion pass.

### Phase 1 (implemented)

- **`client/src/lib/boardViewport.js`** — the camera as pure maths, unit-tested. Two spaces:
  *world* (where nodes live, stored, camera-independent) and *screen* (pixels inside the
  viewport). One implementation of each direction, because the bug this file exists to
  prevent is a point converted one way by one call site and the other way by another —
  which looks perfect at 100% and puts every dropped node in the wrong place at 40%.
  `toWorld`/`toScreen` are pinned as exact inverses at four zoom levels.
- **The camera is a ref during a gesture, state between them.** Writing pan into React state
  on every `pointermove` re-renders the whole board sixty times a second, and the feel is a
  stated requirement — the difference between liquid and rigid is exactly here. A drag writes
  `transform` straight onto the world layer from a rAF and commits once on `pointerup`.
- **Depth is parallax, not decoration.** Two dot fields at different sizes and opacities,
  panned at different rates, painted on the *viewport* rather than the world layer — a
  background inside the transform would be dragged at exactly the camera's speed and the
  parallax would die. One field alone reads as a flat grid.
- **`FolderRosterNode` extracted from `CombatArena.jsx`** to `client/src/components/FolderRoster.jsx`,
  unchanged. It already took the characters as a map and the card as a render prop, so it
  knew nothing about seating; the alternative was a second copy that would have drifted the
  first time either one's collapse behaviour changed.
- **The rail is three sections**: *You* pinned at the top and outside every folder, the
  glowing-white **Custom** folder for board-local people, then the world's NPCs in the GM's
  own nested folders. Custom is deliberately **not** a `character_folders` row — those people
  belong to one player's board, and the world's folder tree belongs to everybody.
- **Two ways to be big.** Inline, the tab drops the sheet's `max-w-3xl` (`WIDE_TABS` in
  `CharacterSheet.jsx`) and takes a `clamp()`ed slab of viewport height. Fullscreen portals
  the whole board over the app, past the header and the 320px chat panel, Escape to return.
  The height is a magic number on purpose: a `calc()` against a header, an optional combat
  bar and a mobile bottom nav is wrong the moment a fight starts.
- **Fullscreen portals to `document.body`.** The void sets a `transform` on its world layer,
  and a transformed ancestor makes `position: fixed` resolve against that ancestor — the
  exact trap this codebase has already hit three times (`MovePickerDialog`, the Arena hover
  cards). Every popover from Phase 2 on must portal for the same reason.
- **The tab is PC-only** (`PC_ONLY_TABS`): an NPC has nobody to keep a board for.

**Two things the browser pass caught that nothing else would have.** The void was too black
— a true black swallows the dot field and reads as "nothing rendered", so the base is
greyish-black with a soft central glow. And wheel-zoom at `exp(-deltaY/220)` sent a single
notch straight to the zoom ceiling; `/500` makes one notch a ~22% step.

### Phase 2 (implemented) — the cast

- **`relationship_people`** (a person who exists only on one board) and
  **`relationship_nodes`** (one placement, in world coordinates). A board *is* its owner:
  there is no `boards` table, every row carries `owner_character_id`, and the camera stays in
  localStorage because where somebody is looking is a property of the person looking.
- **Nickname and Notes live on the NODE, not the person.** The same NPC dragged out twice is
  two independent placements, because placing somebody twice usually means they occupy two
  roles in your head.
- **The board is its own endpoint**, `GET /api/characters/:id/relationships`, not one more
  key on `GET /api/characters/:id`. That payload is refetched by roughly twenty unrelated
  socket events — every Stamina tick among them — and a board carries base64 pictures.
- **Broadcast is per-socket, never `io.emit`.** A private board must not cross the wire to
  another player, so `emitRelationships` iterates sockets and emits only to the owner and the
  GM — the `refreshCapabilities` shape. The board is read once regardless of how many sockets
  are entitled to it. Every write is gated by the same predicate (`maySeeBoard`); there is no
  per-event variation because there is no per-event rule.
- **Two drag systems, deliberately.** Rail → board is native HTML5 DnD on the
  `text/character-id` mime `CharacterList` and Arena seating already use. Inside the board is
  pointer events, because native DnD reports no continuous position and has no touch
  equivalent. A node drag writes `transform` straight onto its own element from the pointer
  handler and emits **once**, on drop.
- **Player Characters are in the rail too** (decided during the phase, on the user's call).
  The other people at the table are relationships as much as NPCs are — often the strongest
  ones a character has — and they live in the same `character_folders` tree, so showing both
  is the honest reading of "the GM's actual structure" rather than a filtered view of it.
  PCs carry a badge and sort first inside their folder; the board's owner is excluded and
  pinned at the top instead.
- **`HaloText`** — the shared "text always wins" wrapper. One `backdrop-filter` on a
  rectangle sized to the text, so what passes behind it is blurred and faded while the text
  stays sharp. It costs the same at one node as at a hundred, which a proximity-based
  approach would not. The opaque scrim underneath is **not** optional: `backdrop-filter`
  under a transformed ancestor is a real browser minefield, and where the blur is dropped the
  text must still be legible.
- **The world-NPC-deleted conversion is wired into `DELETE /api/characters/:id`** — one
  board-local person per board, not per node, so two placements of one NPC become two views
  of one person rather than two people.

### Phase 3 (implemented) — the web

- **`relationship_edges`.** An endpoint is either a node and a side, or a point in world
  space. The "delete the character but keep the relationships" option writes the last-known
  anchor into `from_x/from_y` and nulls the node reference in ONE statement per side, so
  there is no instant where a row has neither.
- **The loose end lands at the node's CENTRE**, not at the dot it was attached to. The dot is
  a property of a portrait that no longer exists; the middle of where that person used to be
  is the honest answer, and it reads the same for all four sides.
- **`relationshipGeometry.js`** — anchors, hit-testing, the curve and the fan, all pure and
  unit-tested. The property worth pinning is invisible with one line and obvious with three:
  **two lines between the same pair must not overlap.** A pair is keyed *unordered*, so A→B
  and B→A share one fan; offsets are symmetric about zero and handed out in stable id order,
  so adding a line never reshuffles the ones already there. (Symmetric offsets turned out not
  to be enough — see Phase 6, where a reversed edge's own negated direction cancelled them
  out and the two lines drew on top of each other anyway.)
- **Hit-testing is arithmetic, not `elementFromPoint`** — exact at any zoom, it does not
  fight pointer capture, and it does not care that the element under the cursor is the line
  being dragged.
- **One gesture serves drawing and re-attaching.** Dragging from a dot proposes a new line;
  dragging a loose end proposes moving an existing one. They differ only in what happens on
  release, so they share every frame in between. The rubber band snaps to the target's dot
  once you are over somebody, so the drop is never a surprise.
- **Retired lines get their own SVG surface that paints first**, which is what "moves to the
  backmost layer" means; z-index inside one surface cannot express it as simply. (That
  one-surface-per-band idea is now the board's whole layer stack — see the table in Phase 6.)
- **A loop is refused** — from somebody to themselves has nothing to say, and the curve maths
  would need a special case for a zero-length span. `move_end` refuses it too.
- **Edges follow a dragged node live**, by the technique the node itself uses: the two or
  three paths touching it are recomputed and their `d` written directly, no re-render.
  Without it a dragged portrait tears away from its own relationships until you let go.

**Four bugs, three of which only a browser could have found.**

1. **The SVG surface was a 1×1 box trusting `overflow: visible`.** It does not work: an
   outermost `<svg>` clips to its viewport regardless, so every relationship was drawn and
   then thrown away — three lines in the database and nothing on screen, nothing logged. The
   surface spans a large box now, with a `viewBox` mapping user units to world units 1:1.
2. **A temporal-dead-zone `ReferenceError` took the whole tab down.** A hook's dependency
   ARRAY is evaluated at render time, so `useCallback(fn, [nodesById])` with `const nodesById`
   declared further down the component threw before anything rendered. The declarations moved
   above every hook that reads them. `no-use-before-define` was tried as a guard and
   deliberately not kept — see `eslint.config.mjs` for why.
3. **`useRelationshipBoard` silently threw every edge away.** Its socket handler was written
   in Phase 2 and named `people` and `nodes` explicitly; the moment the server started
   sending `edges` they were dropped on the floor. It spreads the payload now — a board is
   whatever the server says a board is.
4. **Re-grabbing a node right after dropping it made it fly off** (reported from play). A
   drag writes the new position straight to the DOM and tells the server on release; until
   the broadcast returns, React state holds the OLD coordinates, so the next grab computed
   its offset against the old position while the portrait was drawn at the new one — jumping
   by exactly the previous drag's distance, compounding. A `livePos` ref is the local truth
   between a drop and its confirmation, and every reader goes through one positioned view. A
   regression probe grabs the same node three times and asserts the total displacement is
   exactly the sum of the three drags.

### The void's depth, rebuilt (decided, second attempt)

The first version was two tiled dot fields at different sizes panned at different rates. It
read as depth at 100% and fell apart everywhere else: scaling a fixed tile with the camera
means zooming out packs the dots tighter and tighter until the field is a grey mess, and two
grids at different scales beat into moiré on the way there. Reported from play as "just a
mess of dots, especially when zooming out a lot".

The two jobs are split now, and neither is a scaled tile:

1. **The dots hold a constant on-screen density.** Their world spacing doubles whenever
   zooming out would push them closer than 40px apart and halves past 88px — the grid steps
   to a coarser or finer one instead of crowding. It still pans 1:1 with the camera, so the
   field belongs to the world rather than to the screen; the stepping is invisible in motion
   and is what every infinite canvas does. `dotSpacing` lives in `boardViewport.js` with the
   rest of the camera maths, swept across the whole zoom range by a test.
2. **Depth is three large soft clouds** drifting at a fraction of the camera's rate. A
   slow-moving gradient is a far better distance cue than a second grid, and it cannot moiré
   against anything because it has no repeat.

**Wheel now zooms** rather than pans (reported from play — the first version reserved zoom
for Ctrl, which read as backwards). A trackpad's sideways swipe still pans, since that
gesture has no zoom meaning: a wheel event whose `deltaX` dominates is a pan, everything
else is a zoom.

### Phase 4 (implemented) — the editors

- **Double-click a line → a popover** with colour, label, emoji, arrowhead side, Retire and
  Delete. Portalled to `document.body` and positioned by the extracted
  `useAnchoredPosition` — the board sets a `transform`, and a transformed ancestor captures
  `position: fixed`. Anchored to the screen point of the double-click rather than to the
  line, so the panel does not chase its own subject if the board is panned behind it.
- **Every control applies live.** There is a Close, not a Save: colour is chosen against the
  actual board, and staging it means picking blind. Matches the sheet's existing habit —
  Role-play saves on blur and there is no Save button anywhere on it.
- **A local draft, echoing the server** (`RoleplayTab`'s pattern, and needed for the same
  reason). Binding the controls straight to the row looked right and felt broken: a keystroke
  or a checkbox tick could not show until the write had reached the server and the broadcast
  had returned, so the checkbox visibly did not move when clicked. The draft answers
  instantly and re-syncs on the edge id, not on every broadcast — re-syncing on each one
  would yank the caret back mid-word as this component's own echo returned. The label emit is
  debounced; a socket frame per keystroke is a lot of traffic for a value nobody reads until
  you stop typing.
- **Colour is validated, not clamped.** It is the one field on this board that reaches a
  renderer — into an SVG `stroke` and into a `<marker>` id — so the server accepts strict
  `#rrggbb` and falls back to the value already stored for anything else. `arrow` is checked
  against the three the renderer can draw before the write, so a bad value is a dropped
  field rather than a thrown constraint.
- **The emoji picker is a hand-rolled curated grid** in six rows chosen for what a
  relationship is — bonds, trouble, standing, dealings, secrets, kin. It inserts at the
  caret into an ordinary text field rather than owning one: `"⚔️ rivals"` and `"owes me 💰"`
  are both things people write, and only one of them is the end of the string. A complete set
  would be worse here — scrolling a thousand emoji to find the dagger is slower than seeing
  it in the second row — and a picker library would be the largest dependency in a client
  whose whole runtime is seven packages. (A right-click-to-favourite row was added on top of
  it later — see Phase 7.)
- **"Retired shown" toggle** beside the zoom controls, on by default, appearing only once
  something is retired. Per-viewer in `localStorage` beside the camera: what you are looking
  at is a property of the person looking. Retired lines are hidden entirely rather than
  dimmed further — a fainter ghost is still clutter.

**Two things reported from play, both fixed here.**

1. **Clicking a line now exposes a grab handle on each end**, and dragging one re-aims that
   end at another character or another dot. Releasing it over empty space **disconnects** it,
   leaving the line hanging exactly as a deleted character would — one gesture covers re-aim
   and detach, because they are the same act with different endings. A loose end shows its
   handle permanently, selected or not: it is already detached and has to be findable to be
   picked back up.
2. **Dropping on an anchor dot now works.** The dots protrude beyond the portrait, so a
   connector released exactly ON one — the most natural aim there is — landed outside the
   strict `hitNode` rect and connected to nothing; you had to drop on the picture.
   `hitNodeArea` accepts a padded region, and `dropTarget` picks the **nearest centre** among
   matches, because a pad wide enough to be forgiving is wide enough for two close nodes to
   both accept the same point.

**`useHoverCardPosition` is now `useAnchoredPosition`** in `client/src/lib/`, extracted from
`CombatArena.jsx` where it was module-local. It takes either a ref or a static viewport rect,
the second form for anchors that are not elements at all — a point on an SVG curve. The Arena
imports it; there is no second copy to drift.

### Phase 5 (implemented) — the feel

**The lines lag, the portrait does not.** The one asymmetry that makes the board feel full of
liquid rather than made of sticks: whatever is under your finger tracks the pointer exactly —
anything else reads as rubber-banding the cursor — while the relationships attached to it
whip along behind and catch up. A rAF loop eases a drawn position toward the node's true one
and keeps running for a few frames after release, so the web *settles* rather than snapping,
writing to the paths' `d` directly and never through React. Measured mid-drag at ~87px of
trail, landing exactly on the anchor dot once settled.

An exponential chase rather than a spring, deliberately: no overshoot, so a line never
crosses its own anchor, and there is one constant to tune instead of three.

Everything else in the pass: a spring overshoot when a portrait lands (only after a real
drag — a click that moved nothing must not bounce), a hover lift, dots that bloom, lines that
**draw themselves in** (`pathLength="1"` normalises the dash maths so one keyframe covers a
short link and a long one, and because the element persists across renders it runs once per
line — and once for the whole web when the board is opened, which is the nicest moment the
tab has), and clouds that breathe on their own. The autonomous drift lives on a *child* of
the clouds layer, because the parent's `transform` is rewritten by the camera sixty times a
second and a CSS animation on the same property would simply lose.

**`prefers-reduced-motion` is read twice.** The global rule in `index.css` zeroes CSS
animations and transitions, but framer-motion animates through inline styles it cannot reach
— so `useReducedMotion()` collapses every spring and the edge chase to instant as well.

### Hardening

- **One decoded image per distinct picture** (`portraitCache.js`). A `data:` URI is not
  cached by anything — it *is* the bytes — so the same NPC placed twenty times was the same
  ~150KB string decoded twenty times, and this board is the first place in the app where one
  person can be on screen more than once. A reference-counted `blob:` URL is decoded once and
  shared; the count is on the entry rather than a timer, because revoking while somebody
  still renders it shows as a broken image. Verified in the browser: four portraits, three
  distinct URLs, the twice-placed Baron sharing one.
- **The board opens on the map, not on empty space.** The camera is per-browser, so opening a
  board on a second device — or one laid out far from the origin — landed at the default view
  with the whole cast off screen and no hint it existed. Found by opening the board at phone
  size and seeing a perfect, empty void.

  **And the first fix was wrong in an instructive way.** `boundsVisible` tested the cast's
  bounding box for *any* overlap with the viewport, which counted a nineteen-pixel sliver of
  one portrait's edge as "the map is visible" — the phone still opened empty. The screenshot
  said it was broken; measuring where the nodes actually were said why. `anyNodeVisible` asks
  per node whether its **centre** is on screen: a face you can recognise, not a hairline of
  one. Framing runs once, on the first load that has nodes, and never touches a camera that
  already shows somebody.
- **Phone confirmed view-only**: nodes and relationships render, the rail is hidden, and there
  are no connect dots at all.

### Phase 6 (implemented) — bending by hand, and three things play found

**Lines you bend yourself.** Grab a relationship anywhere along its length and pull: the
point under your finger follows, and the line bows into the arc it defines. What is stored
is a single `relationship_edges.bend` REAL — the same perpendicular displacement of the
quadratic's control point that the automatic fan hands out — and **never a control point**.
(One number turned out to be one too few: see Phase 8, where it became a pair so the arc can
form off-centre and in any direction.)
An absolute control point is a fixed place in the world, so the arc would flatten the moment
either portrait moved; an offset is measured against the line's own two ends and travels with
them. `NULL` means "never bent by hand" and returns the line to the fan; `0` is a real,
distinct value meaning "I straightened this one myself", which is why the server takes the
three cases apart explicitly (`Number(null)` is a perfectly finite `0`).

The maths behind "grab **any** point", not just the middle: with the control point at the
chord's midpoint plus `offset` along the normal, `B(t)` is the straight line plus
`2t(1-t) · offset · n` — so the curve's distance from the chord at parameter `t` is
`2t(1-t) · offset`, and the offset that puts a grabbed point back under the pointer is that
read the other way. The weight is **floored at 0.25**: a quadratic's ends do not move however
hard its control point is pulled, so without a floor, grabbing within a few pixels of an
anchor divides by nearly zero and throws the line off the board on the first frame. The drag
also applies a **delta rather than an absolute** — it records what the pointer says at the
moment of the grab and adds only the change since — which makes the first frame a no-op by
construction wherever you grabbed, floor included. The editor grows a **Reset curve** button
whenever `bend` is set, which hands the line back to the fan rather than pinning it flat.

**A→B and B→A no longer draw one line.** Reported from play, and the fan was wrong in a way
its test could not see. `edgePath` takes its perpendicular from the edge's OWN direction, so
an edge stored B→A has both its direction and its fan offset negated — and the two negations
cancel, producing an identical control point. The old test asserted the offsets were unequal
and summed to zero. Both were true of two curves lying exactly on top of each other, which is
why it passed for two phases. Every fan is now laid out in one frame — the pair's canonical
direction, low node id to high — with the offset flipped for a backwards edge so its own
negated direction restores it. The test asserts the **drawn curves** diverge, not the numbers
behind them; reverting the fix turns it red with "both curves bowed the same way: -7.5 and
-7.5".

**The anchor dots were unreachable, and the layer stack was the reason.** The dots got a 32px
hit box so that hovering merely *near* one lights it up — but measuring with
`elementFromPoint` said the hover was landing on a `path`, not on the dot. Every edge carries
a transparent 16px-wide hit stroke, it begins exactly at an anchor dot, and the live-edge
surface sat at `z-[1]` above portraits with no z-index at all: the invisible stroke covered
the very dot it was attached to, so a connected node's dot could be neither lit nor pressed.
A line drawing over somebody's face was the visible half of the same mistake. The stack is
now stated once, in `RelationshipEdges`:

| z | layer |
|---|---|
| 0 | retired edges — anything at all may overlap them |
| 1 | live edges |
| 2 | the portraits |
| 3 | end handles, and the line being drawn right now |
| 4 | text |

Layer 3 exists because of what layer 2 broke: a selected line's two handles sit exactly on
the dots, so they have to climb back above the portraits or re-aiming a line would start a
new one every time. The rubber band joins them there, since a proposal you are aiming at
somebody must stay visible over the face you are aiming at. `DROP_PAD` widened to 22 to stay
in step with the dot's reach — a dot you can light up by hovering is a dot you must be able
to drop on.

**Players can take Perks for themselves**, the mirror of the Moves tab's Learn/Forget. The
Perk library has been readable to Players since the page was opened to them, and asking the
GM to tick a box was the only way to act on what you read. No learnability gate, because a
Perk has none — a Move's Learn button can be closed by style and `perk:grant` has no
equivalent rule. Automated Perks are offered like any other: the trust-based no-auth model
is the whole app's design, and every grant is visible to the GM.

### Phase 7 (implemented) — favourite emoji, and two labels that overlapped

**Right-click an emoji to favourite it.** Six labelled rows are quick to scan once and slow
to scan every time, and everyone reaches for the same three or four. Favourites ride in a
first row, newest first, so the emoji you just decided you liked is the first one you see
next time. Right-click rather than a long-press or a mode toggle: it is the one gesture on a
desktop pointer not already spoken for in the picker — left-click inserts — and it costs no
chrome at all. Per viewer in `localStorage`, like the board camera and "show retired": this
app has no accounts by design, so "per user" is "per browser", and a shared column would make
one player's favourites everybody's. Capped at sixteen, and the stored list is filtered on
the way **out** as well as in, since every entry is rendered straight into a button and the
value is editable in any devtools.

**The counter wheel's labels no longer sit on their own icons.** Every label used to hang on
its node's ray at a fixed `RADIUS + 44`. That is fine above or below the wheel, where the
text grows sideways into empty space, and wrong at the sides, where it grows back along the
ray straight into the node — so "Improvisation" (thirteen characters) and "Defensive" landed
on top of the shuffle and shield icons. Reported from play.

Each label is now pushed out by the part of its own half-width that actually points at the
node, `|cos θ| · halfWidth`, so a label at the top does not move at all and only the ones
that were overlapping do. The other half of the fix is the viewBox: pushing "Improvisation"
clear of its icon pushes it off the right edge instead, where an outermost `<svg>` clips it
away without a word — the same trap the relationship board hit — so the box is measured from
the labels actually being drawn rather than being a constant that happens to fit today's
seven styles. `stanceGraphLayout.js` holds both, with a test that reconstructs the old
placement and asserts it collided, so the new one cannot pass vacuously.

### Phase 8 (implemented) — two-axis bends, undo, and the keyboard

**A bend is two numbers now, not one.** The control point is stored as a pair of
fractions of the line's own frame — `bend` is the offset ACROSS the chord (the column
keeps its name) and `bend_u` is where ALONG it that offset sits, NULL reading as 0.5.
Two degrees of freedom is what makes the gesture omni-directional and what lets the arc
form where it was grabbed: with `u` pinned at the middle, which is all the first version
had, every arc peaked in the centre however near an end you pulled, and dragging along
the line did nothing at all because the drag was projected onto the normal and the other
half thrown away.

The maths is one identity. A quadratic's only control-point term is `2t(1−t)·C`, so
moving `C` by Δ moves the curve at parameter `t` by `2t(1−t)·Δ`. Read backwards: to make
the grabbed point follow the pointer exactly, move `C` by the pointer's own delta divided
by that weight — both components at once. The weight is floored (grabbing within a few
pixels of an anchor would otherwise divide by nearly zero), and the drag adds only the
change since the grab, so the first frame is a no-op by construction wherever you
grabbed. Every arc already on a board survives untouched: `u = 0.5` reproduces the old
single-number curve exactly.

**`Number(null)` is `0`, twice.** Reading either column with a bare `Number()` was a
silent disaster in both directions — on `bend` it would have read every un-bent line in
the world as "hand-bent, dead straight" and switched the automatic fan off for the whole
board; on `bend_u` it would have jammed every arc stored before that column existed hard
against one end. Both are caught by one `column()` guard, and both were caught by tests
rather than by anybody looking at a board.

**Undo, three deep, and it lives on the server.** An inverse command works fine for a
move or a colour and falls apart on a delete: undoing one has to bring the row back with
the SAME id, or every relationship that pointed at it now points at nothing. So each
mutating handler snapshots the whole board before it writes, and `relationships:undo`
restores the three tables by re-inserting every row with its original id. In memory only
— an undo stack is a convenience for the session you are in, not a record of the game —
and shared per board rather than per person, because the GM and the owner edit the same
web and two private histories would disagree the moment both drew. `undoDepth` rides
every broadcast so the corner's Undo button can grey itself rather than firing into an
empty stack. Ctrl+Z (and ⌘Z) is bound on the board.

**Delete and Backspace remove whatever is selected**, line or portrait, and the
relationship editor's Delete no longer asks first. The confirmation was buying nothing
once there was an undo behind the whole board, and it cost a click every time — which is
most of what tidying a web is. A portrait deleted by key keeps its relationships,
floating loose: it is the gentler of the ✕ menu's two options and the right default for a
key that is easy to hit by accident. Neither key fires while focus is in an input, a
textarea or a contenteditable, because Backspace in the label field has to delete a
character rather than the relationship it names.

**The anchor dot no longer lags behind its portrait.** The lines trailing a dragged face
is the board's whole feel and is deliberate; the handle sitting ON the anchor dot is a
different thing — it belongs to the portrait, and leaving it behind read as the dot
coming unstuck. It is now moved on the pointer's own frame from the node's TRUE position
rather than the chase's eased one.

**And that fix had a second half only measuring caught.** React never wrote that
`transform`, so React never removed it: the handle tracked perfectly during the drag and
then jumped a full drag-length the moment it was released, because the stale offset was
applied on top of the freshly rendered position. Cleared in a layout effect keyed on
`nodes` — after React has placed the handles, before the browser paints, so no frame
shows the old spot. The path registry is keyed by both strings and raw numeric edge ids,
which the first version of that loop found the hard way, in the browser, with a
`startsWith is not a function` that took the tab down.

### Planned, not yet built
- Nothing. The feature is complete.

**Foreign keys ARE enforced — corrected, and measured.** Phase 1's write-up of this section
claimed the opposite, reasoning that `PRAGMA foreign_keys` is only ever touched *inside* the
six table-rebuild helpers in `db.js`, is never enabled at connection setup, and that SQLite
defaults it OFF per connection. Every one of those facts is true and the conclusion was
still wrong: **`@libsql/client` turns it on when it opens the connection**, so
`PRAGMA foreign_keys` reads `1` before `initDb` has run a single statement. Probed directly
rather than reasoned about, after a test written to assert the wrong behaviour failed.

Two consequences, both load-bearing:

- `relationship_nodes.character_id` carries **no** `ON DELETE` action, so deleting a
  character with nodes still pointing at them is **refused by the database**. That makes the
  conversion in `DELETE /api/characters/:id` mandatory rather than merely considerate —
  remove it and the delete fails outright, which is by far the better failure mode than a
  quietly broken board.
- The explicit board deletions in that handler are belt-and-braces now rather than the only
  belt, and they stay: that handler spells out its whole cascade by hand as a matter of
  style, and an ordering that is correct under either answer is worth more than the saved
  lines.

`CHECK` constraints hold regardless of the pragma, so the discriminator on
`relationship_nodes` (exactly one of `character_id` / `person_id`) is a real guard under
either story. **The lesson is the one this project keeps relearning:** a chain of true facts
is not a measurement. `server/test/relationshipsSchema.test.js` now pins the pragma itself.

## Game mechanic — Scene tab (decided, new; complete, all 6 phases shipped)

A second "everyone's screen shows the same thing" surface, alongside the Combat Arena — but built
for roleplay/downtime scenes rather than fighting: a GM-controlled fullscreen background picture
("a Scene") with characters' transparent-PNG art sliding on/off it as they're "summoned," in the
visual language of a light novel or Foundry VTT's Theatre module rather than a battle map. Full
design and phasing lives in the session plan this was built from; the decisions below are the ones
that held across every phase, from the first line of schema to the final motion pass.

**Decisions, locked before any code was written:**

- **Temp NPCs are a brand-new, lightweight, global, GM-managed roster** (`temp_npcs`) — not a flag
  on `characters`. Cheap, narrative-only, and deliberately never touches Arena seating, Compendium
  grants, or the character sheet's other tabs. Foldered in its own tree (`temp_npc_folders`),
  mirroring `character_folders` exactly, with real create/rename/delete of its own — nothing else
  in the app manages this tree, so the GM's drawer (Phase 2) is genuinely its only home.
- **Scenes are foldered too** (`scene_folders`, the GM's own addition on top of the original ask) —
  the same tree shape again, for the right-hand Scenes drawer (Phase 4).
- **The GM's left drawer mixes both rosters in one place**: a "Temp NPCs" section (its own
  GM-editable folder tree) stacked over a read-only "Characters" section that simply reflects the
  real `character_folders` tree — that tree already has its own management UI (the Character List
  page), so this drawer never duplicates it. **Every character lands here, PC or NPC** — Phase 2
  shipped this filtered to `character_type = 'npc'` only, which turned out wrong: a playtest found
  the GM had no way at all to summon a PC (mayWriteScenePicture already grants a GM write access to
  any character, PC included, so the gap was purely this filter, fixed post-launch, see below).
- **Every new write here is GM-only, enforced server-side** (`if (socket.data.identity?.role !==
  'gm') return;`, the `quirk:create` idiom) — a deliberate departure from `character_folder:*`'s
  older, merely client-gated precedent. A fresh authoring surface shouldn't regress to the looser
  convention just because it happens to reuse the same folder shape.
- **The Scene page is always fullscreen, for both roles**, from the moment it's opened. The GM's
  authoring tools (create Scene, upload picture, manage Temp NPC folders, summon) live in
  drawers/overlays on top of that canvas, not a separate management page (Phase 2 onward).
- **Switching the active Scene force-navigates every connected Player** straight to the fullscreen
  view — every switch, including the first activation of a session. No other feature in this app
  force-navigates anyone; this is a deliberate, new pattern (Phase 4). The force-navigate listener
  diffs only `activeScene?.id`, never the rest of the shared payload — diffing the whole thing
  would re-navigate every Player on every summon/un-summon too, which is a materially worse
  failure than the accepted "cutting to a new scene interrupts whatever you were doing" tradeoff.
- **A Scene Picture is "pick one at summon, swap freely after."** Summoning opens a picker of that
  owner's own Scene Pictures; once on stage, the same control swaps which picture shows without
  leaving the stage — position/order in the lineup is preserved, only the image changes (Phase 5).
- **Summons are Scene-specific (decided, revised — reverses the original "independent of the active
  Scene" rule).** `scene_summons.scene_id` is now `NOT NULL`: switching to a different Scene shows
  that Scene's own prepared roster, not whoever was summoned before. This exists so a GM can prepare
  a Scene's cast and layout in advance — populate it, position everyone, resize as needed — without
  any of that leaking into whichever Scene the table is actually looking at, and without a later
  Scene switch wiping it out either. `stage:summon` resolves `scene_id` itself from
  `scene_state.active_scene_id`, same as `side` from identity — never a client-claimed value — and
  is refused outright with no active Scene (nothing to pin a summon to yet). The per-owner `UNIQUE`
  moved from table-wide to per-Scene (`UNIQUE(scene_id, character_id)`), so the same character can
  be independently prepared into more than one Scene at once, each with its own side/position/scale.
- **The stage's "who is currently summoned" state is public to everyone watching** — a plain
  `io.emit('stage:updated', ...)`, no per-viewer redaction, unlike `combat:updated`'s secrecy
  around pre-reveal declared moves. What's GM-only is the *authoring* library (Scenes, Temp NPCs,
  folders) and *who may summon what* (see below) — never the shared "what's on stage right now."
- **`stage:summon`'s `side` is derived from `identity.role` server-side, never taken from the
  client payload** — a GM's summons are always `'right'`, a Player's always `'left'`. Ownership is
  checked the same way `scene_picture:*` writes are: GM may summon any character (PC or NPC) or
  Temp NPC; a Player only their own character. The payload is deliberately just `{ scenePictureId }` — the
  server resolves that picture's own owner rather than trusting a separately-sent id that could
  disagree with it.
- **Mobile: landscape-only, by design.** `useIsLandscape()` (`client/src/lib/useMediaQuery.js`)
  gates on `!useIsDesktop() && !useIsLandscape()` — width-scoped, not raw orientation, so a desktop
  window resized taller than wide is never blocked. No portrait layout for the stage is ever built;
  a phone-width portrait viewport sees a "flip your device" message instead (`OrientationGate.jsx`).
- **The route is genuinely chrome-free, not chrome-covered.** `App.jsx`'s `Shell()` branches on
  `location.pathname === '/scene'` and mounts no header, no mobile menu, no `CombatHeaderBar`, no
  `ChatPanel`, no `BottomNav` at all — a new pattern, deliberately not the Relationships board's
  `fullscreen` toggle (a `createPortal` that only ever paints *over* the still-mounted chrome). A
  force-navigated Player must not be able to tap a still-present bottom nav out from under the
  page, which a portal-over-chrome approach would still allow. `ScenePage.jsx` carries the one way
  off the route itself (a small corner link back to the Arena) and the "Scene" header/mobile-menu
  links (`App.jsx`) are the way onto it.

**Data model** (six new tables, `server/db.js`, right after the Relationships board's own tables):
`temp_npc_folders`/`temp_npcs` (mirrors `character_folders`, plus `ensureCropColumns`),
`scene_folders`/`scenes` (same shape again, for the GM's right-hand Scenes drawer), `scene_state`
(a `combat_state`-style singleton holding `active_scene_id`), `scene_pictures` (owned by exactly
one of a `character_id`/`temp_npc_id`, `CHECK`-enforced like `relationship_nodes`'s own
discriminator), and `scene_summons` (same discriminator, plus `UNIQUE(character_id)` /
`UNIQUE(temp_npc_id)` so an owner held at most one seat on stage — SQLite treats `NULL` as
distinct under `UNIQUE`, so a Temp NPC's own uniqueness never collided with a character's).
**Revised later** (see "Summons are Scene-specific" above): `scene_summons` gained a `NOT NULL
scene_id` and both `UNIQUE`s moved to per-Scene, so an owner now holds at most one seat *per Scene*
rather than one seat, full stop.

**Every new FK here is a straightforward `ON DELETE CASCADE`** — deliberately unlike
`relationship_nodes.character_id`, which carries no `ON DELETE` action at all because a
relationship node can point at a character who isn't its board's owner and needs converting rather
than deleting. Nothing here has that shape: a `scene_pictures`/`scene_summons` row has no
cross-owner reference to preserve, so there is nothing worth saving across the owner's own
deletion, and copying the no-action pattern here would only make deleting a character with Scene
Pictures fail for no reason. `DELETE /api/characters/:id` gained two explicit lines for the same
belt-and-braces reason every other line in that handler is spelled out by hand.

Phases 2-6 (Temp NPCs, the upload pipeline, Scenes/activation/force-navigate, summoning, motion)
each landed as their own PR, ending in a deploy + playtest checkpoint, mirroring the Relationships
board's own cadence — this section grew one `### Phase N` heading at a time as each one actually
shipped, rather than being stubbed out in advance. All six are implemented; see Phase 6's own
subsection below for the wrap-up.

### Phase 1 (implemented) — schema, the chromeless route, the orientation gate

Schema (six tables, above), the chromeless `/scene` route, the orientation gate, and an empty
`ScenePicturesEditor.jsx` wired into a new final Character Sheet tab (every character, PC or NPC,
gets it — not gated by `PC_ONLY_TABS`). `GET /api/scene-pictures` is open, unfiltered REST,
matching `GET /api/character-folders` — this is GM-*managed* content, not GM-*secret* content. A
"Scene" link was added to the desktop header and the mobile "More" menu — the route itself carries
no chrome once you're on it, so this is the only way in besides typing the URL by hand.

Verified: `server/test/sceneSchema.test.js` (both discriminators, both `UNIQUE`s, FK enforcement,
CASCADE-not-blocked contrasted directly against `relationship_nodes`'s refusal), `initDbSchema.test.js`
extended for the two `ensureCropColumns` calls, `e2e-mobile/scene.spec.js` (chrome genuinely absent
from the DOM at every viewport, the orientation gate's three width/orientation combinations, the
new sheet tab) — 720 server tests and 18 Playwright checks (6 tests × 3 device projects) passing.

### Phase 2 (implemented) — Temp NPCs and folders

`temp_npc_folders`/`temp_npcs` CRUD, all GM-only and server-enforced: `temp_npc_folder:create/
rename/delete` (promote-one-level-on-delete, identical to `character_folder:delete`'s own rule) and
`temp_npc:create/update/set_folder/delete` (name-only for now — the portrait upload arrives in
Phase 3 alongside Scene Pictures, the one place this feature actually touches the image pipeline).
`temp_npc:delete` spells out its cascade by hand (`scene_summons` → `scene_pictures` →
`temp_npcs`), matching `DELETE /api/characters/:id`'s own style even though both FKs are already
`ON DELETE CASCADE`. Reads are open REST (`GET /api/temp-npcs`, `GET /api/temp-npc-folders`),
matching `GET /api/characters`/`GET /api/character-folders` — GM-*managed*, not GM-*secret*.

`SceneCastDrawer.jsx` (new), the left overlay on `ScenePage.jsx`'s canvas, mounted only when
`useRole().role === 'gm'` — a Player who navigates to `/scene` directly never sees it. Two sections:
- **Temp NPCs** — `FolderTreeNav` (this app's existing "manage a folder tree" widget, already doing
  this exact job for `character_folders` and move Disciplines) reused as-is for create/rename/
  delete/navigate, with a short list of the selected folder's Temp NPCs beneath it and an inline
  "+ New" form. Cards are draggable (`text/temp-npc-id`, mirroring `text/character-id`) onto a
  folder row to refile. Double-clicking a card opens `TempNpcEditor.jsx` — a name field, a delete
  button, and (decision #9) the very same `ScenePicturesEditor` every character's sheet tab uses,
  embedded directly, since a Temp NPC has nothing else to edit.
- **Characters** — read-only `FolderRosterNode` (its 3rd consumer, after the Arena's seating
  rail and the Relationships board's own "The world" section; the 4th arrives with Phase 4's Scenes
  drawer), reflecting the real `character_folders` tree. Shipped this phase filtered to
  `character_type = 'npc'` only — corrected post-launch to include PCs too, see below.

Verified: `npm run lint` and the full server suite (720/720, no regressions — this phase added no
new server tests, since nothing here is timing/math the way Combat Timing or `sceneLayout.js` will
be). `e2e-mobile/scene.spec.js` gained two tests: the GM checkpoint itself (create → rename → open
the picture editor and rename through it → delete the Temp NPC → rename and delete the folder, each
step asserted against the live DOM) and a gate test confirming a Player sees neither drawer section.
Both passing across the same three device projects as Phase 1.

### Phase 3 (implemented) — the Scene Pictures upload pipeline

`scene_picture:create/update/delete`, the one place in the whole feature a Player writes anything —
gated by a new `mayWriteScenePicture(viewer, ownerType, ownerId)` (`server/index.js`, beside
`maySeeBoard`): the GM always may; a Player only for their own character's own pictures; a Temp
NPC's are GM-only always, since nobody plays one. `scene_picture:created/updated/deleted` broadcast
via plain `io.emit`, matching `move:updated`'s shape — this is GM-managed library content, not a
secret the way a pre-reveal declared move is, and each `ScenePicturesEditor` instance filters
incoming events to its own owner rather than the server scoping the emit.

`fileToScenePicture` (`client/src/lib/image.js`) — the same "PNG stays PNG, else JPEG 0.85" branch
`fileToSmallImage` already uses for Moves/Tells, capped at 1024px on the longest side (the art shows
at real screen height on the stage, not as a thumbnail). **No crop step**, unlike every other
picture upload in the app: `scene_pictures` carries no `crop_*` columns (Phase 1's own schema
decision), and cropping a transparent character cutout the way a portrait photo gets cropped doesn't
make sense — the art already arrives framed the way it's meant to show. `ScenePicturesEditor.jsx`
(replacing Phase 1's list-only skeleton) is now the full grid: upload, rename (a `window.prompt`,
matching `FolderTreeNav`'s own convention), delete, live-patched over the socket. The empty state is
`+ Add picture` for anyone who can edit and the read-only "No Scene Pictures yet." only for anyone
who can't — Phase 1's own test for the always-empty tab was updated to match, since a GM (who can
always edit) now sees the add tile, never the read-only line.

`temp_npc:update` gained an optional portrait — the Temp NPC's own regular picture (its `Thumb`
everywhere in the drawer), deferred from Phase 2. Reuses `fileToPortrait`/`usePictureUpload`/the
crop dialog exactly like `PersonEditor.jsx`'s own board-local person, since `temp_npcs` carries the
same `crop_*` columns a portrait needs (unlike `scene_pictures` above) — an "absent picture means
leave it alone" payload contract, identical to `relationships:update_person`'s.

Verified: `npm run lint`, the full server suite (720/720, no schema changes this phase so nothing
new to pin there), and **`scripts/playtest-scene.mjs`** (new) — a live-socket script in
`playtest-relationships.mjs`'s own shape, since a server-enforced write gate can only really be
proven by asking as somebody who lacks it: a GM and two Player sockets, confirming a Player may
write their own character's Scene Pictures, may NOT write another Player's or a Temp NPC's (create,
rename, AND delete all separately), the GM may write anyone's, and `scene_picture:created` reaches
every socket (`io.emit`, not scoped) — 10/10 checks passing. `e2e-mobile/scene.spec.js` gained three
tests: a GM's full upload → rename → delete round trip, a Player uploading to their own character
(cross-checked against the REST read, not just the DOM), and the updated empty-state assertions
above. All passing across the same three device projects as Phases 1-2.

**"Copy picture from profile" (decided, new; implemented).** A second tile beside `+ Add picture`,
character-only (a Temp NPC has no portrait to copy from) and shown only when that character actually
has one. `scene_picture:copy_from_profile` (`{ characterId }`, same `mayWriteScenePicture` gate as
`scene_picture:create`) reads `characters.image_data`/`image_mime_type` straight off the row and
inserts it as a new Scene Picture named "Profile" — no client-side re-upload, re-resize, or
re-encode, since the bytes already exist server-side. **Copies the FULL portrait, not the zoomed-in
view the sheet shows elsewhere**: a character's crop (`crop_x/crop_y/crop_w/crop_h`) is a
display-only transform `CroppedImage.jsx` applies at render time (see that file's own comment) — the
stored `image_data` is always the whole, uncropped upload `fileToPortrait` produced, so reading it
straight through is already "the full version," with nothing to undo. Verified live:
`scripts/playtest-scene-copy-profile-picture.mjs` (8 checks) — the copy is byte-identical to the
portrait regardless of a crop set on it, named "Profile," a Player may copy their own, may NOT copy
another character's, the GM may copy anyone's, and a character with no portrait yields nothing.

**Copying a Scene shares its backdrop rather than duplicating it (decided, new).**
`scene:copy` makes `<name> (copy)` in the same folder, carrying the picture, the background
fit and the thumbnail crop — the last two being how that picture is *framed* rather than
separate content. **Nothing else travels**: not the prepared roster, the GM Notes, the
drawings, or the Timestamp cue. A copy is a fresh stage wearing the same backdrop.

- **`scenes.image_source_id` (nullable, self-referential).** A copy stores NULL `image_data`
  and points at whichever Scene owns the bytes, keeping its own `image_hash`/
  `image_mime_type`, so its URL is the owner's id plus the same content hash: **one row of
  bytes in the database and one cached fetch in the browser, however many copies exist.**
  Backdrops are the largest thing this schema stores — they *are* the 6GB the whole Hosting
  cost section is about — so duplicating one per copy is the single thing this feature must
  not do.
- **Always one hop.** `scene:copy` resolves `source.image_data != null ? source.id :
  source.image_source_id`, so copying a copy still points straight at the bytes. No chain can
  form, therefore none can be walked or broken.
- **`shapeScene` is the one resolver, and every path that ships a Scene row goes through it.**
  `withImageUrl` cannot do this itself — it is shared by ten kinds and only ever sees the row
  it is handed — so scenes get a wrapper that rebuilds `image_url` from the owner's id. It
  needs no extra query, because the hash rides on the copy's own row; that matters because
  the scenes list is read on every drawer open. `buildStagePayload` resolves the same way
  from its own SELECT.
- **Three writes had to learn about borrowing, and each would have been silent:**
  - `stampImageHash` would have hashed a copy's empty data column and overwritten the one
    value its URL is built from, pointing it at a picture that does not exist.
  - `scene:update` with a new backdrop now clears `image_source_id` — the copy owns bytes
    now, and leaving the pointer would serve the old Scene's picture over the new one.
  - `image:reencode` carries the new hash to every borrower. The picture would still be
    served (`/api/img` recomputes the true hash) but only with `no-store`, so it would never
    be cached again — the opposite of what the re-encode tool exists for.
- **Deleting the owner promotes rather than orphans.** The column's own `ON DELETE SET NULL`
  would leave every copy holding a hash and no picture, so `scene:delete` hands the bytes to
  one dependent, repoints the rest at it, and re-broadcasts them. A deleted original never
  blanks its copies, and the picture is still stored exactly once.
- **Client:** a "Duplicate Scene" button in `SceneEditor` beside Delete, closing the dialog on
  use — the new Scene arrives on `scene:created`, and leaving the editor open on the ORIGINAL
  would only confuse which one was just made.
- **`scripts/playtest-scene-copy.mjs`** (17 checks) pins the property that cannot be seen by
  looking: it asserts against `/api/image-inventory`, which lists only rows that actually hold
  bytes, so a copy that silently duplicated them would fail. Also covers copy-of-a-copy, that
  no Notes or Timestamp cue travel, and the promote-on-delete — including that the picture is
  *still* stored exactly once afterwards.

**Two playtests were not idempotent, and both were found by running them twice (bugfix).**
`playtest-scene` left a Scene active and then failed its own next run — the leftover made a
Player's correctly-refused `scene:activate` look like it had worked, a false alarm that only
ever appeared on the second run. It now clears the active Scene before that check and again at
the end. `playtest-scene-copy` looked its teardown up by name, and two copies of one Scene
share a name, so it deleted the same row twice and leaked the other; it tracks ids instead.
Same class as the `repeat_mode` leak in `playtest-audio`: **a singleton that outlives a run is
a precondition to state, not to inherit.**

### Phase 4 (implemented) — Scenes, activation, and the force-navigate cut

`scene_folder:create/rename/delete` and `scene:create/update/set_folder/delete`, structurally
identical to Phase 2's `temp_npc_folder:*`/`temp_npc:*` (promote-one-level-on-delete, GM-only
server-enforced, the "absent picture means leave it alone" contract for `scene:update`'s optional
backdrop). `scene:activate` is new: GM-only, writes `scene_state.active_scene_id`, then broadcasts
`stage:updated` — a plain `io.emit`, no per-viewer redaction, matching decision #3's "the stage is
public to everyone watching." A new `getStagePayload()` helper (`server/index.js`, beside
`mayWriteScenePicture`) is the one place that builds `{ activeScene, summons: [] }`, called from
`GET /api/stage` and from every write that can change it — `scene:activate` itself, `scene:delete`
when the deleted Scene was the active one (its own `scene_state` FK is `ON DELETE SET NULL`, but the
handler spells the reset out explicitly, matching this file's own house style), and `scene:update`
when the *active* Scene's own backdrop just changed. `summons` stays `[]` until Phase 5 — the shape
is settled now specifically so that phase only adds rows to an existing field, never changes what
`stage:updated` carries.

**The force-navigate listener** (decision #3) lives in `App.jsx`'s `Shell()`, not on `ScenePage.jsx`
— it has to run before a Player's browser even gets to that component, since being cut there from
anywhere else in the app is the entire point. A `useRef` sentinel tracks the last `activeScene?.id`
this listener has personally seen **over the `stage:updated` socket event**, never seeded from a
REST fetch — a page load or reconnect that happens to land while a Scene is already active must
never navigate anyone on its own; only a live switch does, and `stage:updated` only ever fires for
one. Diffs *only* `activeScene?.id`, exactly as Risk #1 in this section demanded: a later
summon/un-summon (Phase 5) fires the same event with the same id and must not re-cut anyone, which
is also what a Scene *rename* while it's the active one already proves today, ahead of summoning
existing at all. A `null` id (nothing active, or the active Scene got deleted) never navigates
anywhere — there is no Scene to cut to.

`SceneListDrawer.jsx` (new), the right overlay on `ScenePage.jsx`'s canvas, mirroring
`SceneCastDrawer`'s left-side structure — `FolderTreeNav` for the folder tree, a list of the current
folder's Scenes, an inline "+ New" form — but with a click split neither existing drawer needed:
**single-click activates** a Scene (the constant, cheap action), **double-click opens
`SceneEditor.jsx`** (rename/backdrop/delete, the rare one). The active Scene's row is highlighted
with a "Live" badge. `SceneEditor.jsx` mirrors `TempNpcEditor.jsx` (name field, `usePictureUpload` +
the crop dialog + `fileToSceneBackground`, a delete button) minus the embedded
`ScenePicturesEditor` — a Scene owns a backdrop, never Scene Pictures.

`fileToSceneBackground` (`client/src/lib/image.js`) caps by **width**, not longest side, at 1600px —
a backdrop is always meant to be read at real screen width, mirroring `fileToPortrait`'s own "cap at
N wide" framing rather than `fileToScenePicture`'s. `ScenePage.jsx` now renders the active Scene's
backdrop full-bleed (`object-cover`) via a new `useStage()` hook (`client/src/lib/useStage.js`) —
fetch-once-then-subscribe, the `useRoster`-style convention, and deliberately NOT what the
force-navigate listener uses (that one owns its own narrower, non-REST-seeded tracking, per above).
An active Scene with no backdrop yet shows its name centered instead of a broken image.

Verified: `npm run lint`, the full server suite (720/720, no schema changes this phase). Extended
`scripts/playtest-scene.mjs` with a GM-only enforcement pass on every new Scene/scene-folder write,
`scene:activate` reaching every socket live, and deleting the active Scene resetting `activeScene`
to `null` live rather than only on the next fetch — 18/18 checks passing. `e2e-mobile/scene.spec.js`
gained this suite's first two-viewer test (two real browser contexts, a GM and a Player, in one
test — the force-navigate effect only exists as one role's action on the other's browser): the full
checkpoint in one pass — first activation force-navigates a Player from their own sheet; a second
activation re-cuts them in place, still on `/scene`; the Player leaves on their own; renaming the
still-active Scene (Phase 5's summon/un-summon shape, simulated ahead of that phase existing) does
not re-navigate them. Plus the now-standard Player-gate test for the new drawer. Manually confirmed
in-browser that an uploaded backdrop actually paints full-bleed on the canvas once activated.

### Phase 5 (implemented) — summoning and the stage roster

**`client/src/lib/sceneLayout.js`**, written and unit-tested first, standalone, per CLAUDE.md's
standing rule for exactly this kind of placement math (the same discipline Combat Timing got).
`layoutStage({ left, right, stageWidth })` is pure — no DOM — so its test lives in
`server/test/sceneLayout.test.js`, importing the client module directly, the same arrangement
`boardViewport.test.js` already uses for the Relationships board's own pure camera math. Eight
tests pin the properties the plan called out: room-to-spare gives exact natural spacing; rank 0 on
each side is always flush against its own screen edge, at any crowd size; consecutive ranks never
collide, even fully crammed; adding a member never reorders anyone already on stage, only shrinks
the shared factor; the factor is genuinely shared across both sides combined, not computed
per-side; and the `MIN_STEP_FACTOR` floor holds under extreme crowding.

**`stage:summon`** (`server/index.js`), the two invariants the whole mechanic
depends on: `side` is derived from `identity.role` server-side and never read from the payload (a
GM's summons always land `'right'`, a Player's always `'left'` — proven by a raw socket sending a
forged `side` field and watching the server ignore it), and ownership is the exact
`mayWriteScenePicture` gate reused verbatim (summoning is, after all, just another way of touching
somebody's Scene Pictures). The payload is deliberately just `{ scenePictureId }` — the server
resolves the picture's own owner rather than trusting a separately-sent id that could disagree with
it. Re-picking the picture already showing un-summons; a different picture updates the
`scene_summons` row **in place** (same `id`, same `created_at`), which is what makes "swap freely
after" (decision #4) concrete — a swap never reorders the stage. `getStagePayload()`'s `summons`
field is now real: a join across `scene_pictures` and `characters`/`temp_npcs` for the image and
owner name, `ORDER BY id DESC` — already rank-0-first order, so the client only has to filter by
side, never re-sort. Three existing delete paths (`DELETE /api/characters/:id`,
`temp_npc:delete`, `scene_picture:delete`) each already cascaded `scene_summons` but never told
anyone live — all three now check `wasSummoned` first and broadcast `stage:updated` when it
matters, the same `wasSeated`/`emitCombatUpdated` pattern combat deletion already uses.

**`SummonPicker.jsx`** (new) — one small dialog, not a floating popover as the plan's own draft
wording suggested: a `DialogShell` fits this app's existing "click a card, get a small dialog"
rhythm (`TempNpcEditor`, `SceneEditor`) far more cheaply than viewport-relative positioning would,
for the same interaction. Lists an owner's Scene Pictures, highlights the one currently showing,
and both toggling off and swapping are the same `stage:summon` emit — the server sorts out which
case it is. Shared by both callers: `SceneCastDrawer`'s rows (any character or Temp NPC, GM-only)
and `PlayerSummonDock` (new, bottom-left on `ScenePage`, a Player's own equivalent scoped to just
their own character).

**The click split that had to change**: `SceneCastDrawer`'s Temp NPC cards used to be
double-click-to-edit with no other action. Overloading the same card with click-to-summon broke
that — a browser `dblclick` fires two real `click` events first, so double-clicking to edit also
fired the summon picker open (and closed) twice in front of the editor. Harmless for
`SceneListDrawer`'s own click/dblclick split (a stray re-activate of an already-active Scene is a
no-op), not harmless for popping a second dialog mid-edit. Temp NPC cards now split the two actions
onto two elements: the whole card is the summon trigger, a small "✎" button of its own opens
`TempNpcEditor`. Real character cards (`CharacterCard`) have no editor here at all, so they stay a
single, unambiguous summon trigger — no split needed.

**`StageRoster.jsx`** (new) renders the actual figures — hard-cut via `layoutStage`, no motion yet
(that's Phase 6), bottom-anchored inside a fixed `SLOT_WIDTH` column with `object-fit: contain`
(image aspect ratio is deliberately not `layoutStage`'s problem). Wrapped in its own
`position + z-[1]` stacking context so a crowded roster's own `z` values (1..N per side) never leak
out to outrank the drawers' `z-10`/`z-20` — without it, a side with more than ~10 summons would
start painting over the GM's own controls.

**A real layout bug, found and fixed during this phase's own browser verification**: a GM's own
`SceneCastDrawer`/`SceneListDrawer` sit directly over the canvas's left/right edges — the exact
edges decision #3 wants a GM's own summons entering from. Unmeasured, a small right-side roster
rendered entirely underneath `SceneListDrawer`, invisible and unclickable behind it. Fixed with a
new `DRAWER_WIDTH` constant (`sceneLayout.js`, `= 256`, matching both drawers'
`w-64`): for a GM, `ScenePage` narrows the `stageWidth` handed to `layoutStage` by `DRAWER_WIDTH *
2` and shifts every figure's `x` by `DRAWER_WIDTH` afterward, so the roster lays out entirely
within the visible gap between the two drawers rather than the canvas's full, mostly-obscured
width. A Player has no drawers, so their own stage uses the full measured width unmodified — proven
by their own self-summon landing at the true `x = 0` left edge in the Playwright test below.

Verified: `npm run lint`, the full server suite (728/728 — the 8 new `sceneLayout` tests, no schema
changes). Extended `scripts/playtest-scene.mjs` with the summon surface: a Player may summon and
un-summon their own character but not another Player's or a Temp NPC's; a GM's forged `side` field
is ignored server-side; swapping a picture updates the summon row in place (same id); deleting a
summoned character removes them from `stage:updated` live, not just the next fetch. `e2e-mobile/
scene.spec.js` gained two tests: the GM's full summon → swap → un-summon round trip (including a
`DRAWER_WIDTH`-pinning position check, since Phase 5 first shipped this as the on-stage remove
button's own reachability check — see Post-launch fixes below for why that button is gone and the
check moved to a plain bounding-box assertion instead), and a Player summoning themselves from
their own docked control with a DOM measurement proving the left-edge position. Manually verified
beyond what's committed: bulk-summoned 11 characters via raw
sockets against the live dev server and measured every figure's real `getBoundingClientRect()` in
a browser — the compression step matched `layoutStage`'s own formula to the pixel (a `factor` of
exactly `0.5`, an `118px` step between every consecutive rank, rank 0 on each side flush against
its edge) — the strongest confirmation available that the pure function and its wiring genuinely
agree, not just each independently "look right."

### Phase 6 (implemented) — the feel

Mirrors the Relationships board's own "Phase 5 — the feel" sequencing (functional pieces first,
motion after) and the plan's own final phase. Everything lives in `StageRoster.jsx` — no server
changes, no new files.

**The position/entrance split, `RelationshipNode.jsx`'s own pattern, applied here for the same
reason.** Each figure is two elements: an outer plain `div` that owns POSITION (`left`, a bare
number straight off `layoutStage`, recomputed every render as the roster reflows) and an inner
`motion.div` that owns the ENTRANCE/EXIT slide. Risk #4 named this exact conflict ahead of time —
had both lived on one element, framer-motion's own `animate` would compose `transform` itself and
overwrite the position's `left`-driven layout on every reflow, snapping every figure back to its
slide-in origin each time somebody else summoned or un-summoned. Split like this, a reposition
never touches the motion.div at all: `initial` only plays once, on that figure's own mount, keyed
by `entry.id` (the `scene_summons` row's own id), which never changes across a reflow.

**Named variants, `RoundCutscene.jsx`'s own vocabulary style** — `ENTER_LEFT`/`ENTER_RIGHT`/`EXIT`,
plain objects rather than a switch full of inline ones. Only two entrance directions: the side a
summon is bound to (decision #3 — a Player's own summons always land `'left'`, a GM's always
`'right'`) is exactly the direction its portrait slides in from, so the slide reads as the
character stepping onto the stage from that edge. One `EXIT` for both sides — un-summoning reads as
the picture simply leaving (fade + scale down), not as a reversed entrance, so it doesn't need its
own side split. Mount/unmount animation (`AnimatePresence`, wrapping the roster's own `.map()`)
handles the exit — without it, React would remove an un-summoned figure from the DOM immediately,
with no chance for `EXIT` to ever play.

**`useReducedMotion()`** gates the `transition` on the inner `motion.div` to `{ duration: 0 }`
rather than removing `initial`/`animate` — the same choice `RelationshipNode.jsx` already made, and
for the same reason: the target state is still reached in one render, which is what "collapses to
instant" means in practice, without a second code path that could drift from the animated one.

Verified: `npm run lint`, the full server suite (728/728 — no server changes this phase).
`e2e-mobile/scene.spec.js` gained two tests: summoning a second character while the first is
already on stage, confirming the first's own position actually changes (a real reflow, not a
no-op) with zero page errors thrown — the practical proof that the split holds together, since a
clobbered `transform` would either throw or leave the figure visibly stuck; and a reduced-motion
smoke test (`test.use({ reducedMotion: 'reduce' })`) confirming a summon still lands correctly with
no hang or error under that setting. Manually verified beyond what's committed: tracked one
specific figure's `left` (matched by its own `img[alt]`, since DOM child order changes as rank 0
shifts to whoever summoned most recently) before and after a second summon — it moved by exactly
one natural step (`236px`, unchanged from Phase 5's own math), confirming the reflow and the motion
code compose correctly through the real rendering pipeline, not just each in isolation.

This is the last of the six originally-scoped phases — the mechanic itself was complete here. A
round of live playtesting surfaced five follow-up fixes, folded into the plan below rather than
numbered as a seventh phase (none of them add new scope; each corrects something the six phases
above already claimed to do).

### Post-launch fixes (implemented) — playtest follow-ups

**PCs were missing from the GM's own "Characters" section.** Phase 2 shipped that section filtered
to `character_type = 'npc'`, so a GM had no drawer path to summon a PC at all — `mayWriteScenePicture`
already granted a GM write access to any character, PC included, so this was purely a client-side
filter bug, not a permissions gap. Dropped the filter; the section (and its empty-state/heading)
renamed from "Characters (NPCs)" to plain "Characters" everywhere it appears (`SceneCastDrawer.jsx`,
`e2e-mobile/scene.spec.js`), and its internal names (`npcTree`/`npcsByFolder`/`NpcCard`/etc.)
renamed to match what they now actually hold (`characterTree`/`charsByFolder`/`CharacterCard`).

**The orientation gate had no way out.** `OrientationGate.jsx`'s rotate-prompt branch never
rendered the "Back to the Arena" corner link — only the canvas branch did — so a phone-width Player
stuck in portrait had no way off the chromeless `/scene` route short of physically rotating the
device first. `ScenePage.jsx`'s corner link is now a shared `TopLeftControls` component rendered on
both branches (the gate branch passes no `onHideUi`, so it renders just the back link).

**Character-art tops didn't line up (first attempt, later superseded — see "Full-bleed stage" below).**
`StageRoster.jsx`'s figure `<img>` used `max-h-[85vh]` — a cap, not a fixed size — so a figure's
rendered height followed its own PNG's own aspect ratio; two characters bottom-anchored via
`object-bottom` at different aspect ratios still had their heads land at different screen heights.
First fix: a fixed `h-[85vh]` box with `w-full`/`object-fit: contain`, on the theory that most
standing-figure art is taller than the box's own narrow aspect ratio and would end up height-bound.
Playtesting immediately after this shipped showed that theory didn't hold for real art (see below).

**Cinematic hide-UI toggle (new).** `ScenePage.jsx` gained a purely local (never socket-synced)
`uiHidden` state: an "eye" button in `TopLeftControls`, next to the back link, hides every overlay
control down to just the backdrop and the summoned figures — both drawers, the corner controls, and
the "No Scene active yet."/Scene-name text, for either role. There is deliberately no separate "show
UI" control; a plain `onClick` on the stage's own root div brings everything back on the next tap
anywhere, matching the ask verbatim ("tapping anything brings them back"). `StageRoster` itself is
untouched by this — the figures are the one thing cinematic mode never hides.

**The on-stage "✕" remove button was removed.** Phase 5 added a GM-only on-stage remove control
(`stage:remove_summon`) as "the GM's explicit clear, mirrors the Arena's seated-card ✕" — but
decision #6 already named re-selecting the same character in the list as un-summoning's *only* path,
and the on-stage button broke the cinematic illusion besides. Removed the button and `canRemove` prop
from `StageRoster.jsx`/`ScenePage.jsx`, and the `stage:remove_summon` handler from `server/index.js`
entirely — nothing else called it once the button was gone. This is fully redundant with the
PC-visibility fix above, not just coincidentally timed with it: with PCs now listed in the GM's own
drawer, `stage:summon`'s re-select toggle (via `mayWriteScenePicture`'s GM-always-may branch) already
covers clearing *any* seat — Temp NPC, real NPC, or PC — so there was never a case the removed button
covered that the drawer's own click doesn't.

Verified: `npm run lint`, the full server suite (728/728, no schema changes). `scripts/
playtest-scene.mjs`'s own `stage:remove_summon`-specific checks were replaced with equivalent
`stage:summon` re-select checks (ownership still refuses a non-owning Player, the GM's re-select
still clears a PC's own seat) — 30/30 checks passing. `e2e-mobile/scene.spec.js` gained a new
orientation-gate assertion (the corner link works while gated) and a new cinematic-toggle test
(hiding clears every overlay control, a plain click anywhere restores them); the Phase 5 summon
test's on-stage-remove assertions became a plain position/height check, further reworked by the
next fix below.

**Full-bleed stage: the whole screen is the working surface, and heights are lined up by height
alone.** Two more rounds of playtesting, right after the two fixes above shipped:

1. A GM's own summons were still confined to "the gap between the drawers" — `ScenePage.jsx`
   narrowed `stageWidth` by `DRAWER_WIDTH * 2` and shifted `x` by `DRAWER_WIDTH` (Phase 5's own fix
   for a different problem: keeping the on-stage remove button, since removed above, reachable).
   The actual ask is the opposite: the cinematic no-UI view (`uiHidden` above) is this page's own
   look benchmark, and that view has no drawers to dodge, so the layout underneath the interface
   should already match it — artwork bleeding behind a GM's drawers on their own translucent
   `bg-zinc-950/90` is intended, not a bug. Removed `DRAWER_WIDTH` entirely (`sceneLayout.js`,
   `ScenePage.jsx`, `StageRoster.jsx`) — `layoutStage` now always receives the full measured canvas
   width, for either role, with no offset.
2. The `h-[85vh]`/`w-full`/`object-fit: contain` box from the fix above turned out not to line up
   real art's tops at all: `object-fit: contain` only lands an image flush against the box's own top
   when the image is height-bound (taller, proportionally, than the box), and a box as narrow as
   `SLOT_WIDTH` (220px) against `85vh` tall is an unusually extreme aspect ratio — most real art,
   closer to a portrait crop than a full-body sprite, is WIDTH-bound instead, landing short with a
   gap above. Replaced with height-ONLY sizing: `h-screen` (using the whole scene height, per the
   ask) with `w-auto` — every image is scaled to the exact same height, full stop, with whatever
   width its own aspect ratio produces, so there is no second box dimension left for `object-fit` to
   negotiate and every top lands on the same line by construction. Also needed `max-w-none`:
   Tailwind's own preflight resets `img { max-width: 100% }` for ordinary inline images, which
   silently re-clamped a wide/short character's width back down despite `w-auto`, discovered only
   by measuring an intentionally extreme 500×150 test image's rendered box in a real browser (900px
   tall on a 900px-tall viewport, but its width capped at ~220px instead of the ~3000px the aspect
   ratio implied, until `max-w-none` was added). This is a pure rendering rule, not stored per
   picture, so it applies retroactively to every already-uploaded Scene Picture with no migration —
   `SLOT_WIDTH` itself is untouched, since it was always the horizontal SPACING unit for
   `layoutStage`'s own crowding math, never a clipping box for the art (see that file's own comment).

Verified: `npm run lint`, the full server suite (728/728, unaffected — pure client rendering, no
server changes). `scripts/playtest-scene.mjs` (30/30, unaffected — layout-agnostic). `e2e-mobile/
scene.spec.js`'s Phase 5 summon test: the drawer-avoidance position check became a no-inset check
(the wrapper's `left` now pins against `stageWidth - SLOT_WIDTH` directly, no `DRAWER_WIDTH`
subtracted), and the fixed-height assertion moved from `85vh` to the full `900px` test viewport
height. Manually verified beyond what's committed: a throwaway script summoned two Temp NPCs with
deliberately mismatched synthetic art (100×500 and 500×150) and measured both in a real browser —
both landed at `top: 0, bottom: 900` despite one rendering 180px wide and the other 3000px, directly
confirming the height-only rule holds regardless of aspect ratio, plus a screenshot confirming the
wide figure visibly extends behind the Scenes drawer rather than stopping short of it.

**Two real-device bugs the full-bleed pass above introduced, caught from an actual production
screenshot rather than any of the above (both of the above were verified on desktop-sized headless
Chromium, which never exercises either failure mode):**

1. **A wide right-side character overflowed past the true right edge of the screen — not bleeding
   behind a drawer, but off the canvas entirely, on a real phone.** The right side's `x` was still an
   absolute `left`-based coordinate (`stageWidth - SLOT_WIDTH`) applied as CSS `left`, a leftover from
   before this pass — that formula only actually lands a figure flush against the screen's own right
   edge when it renders at exactly `SLOT_WIDTH` wide, which is no longer guaranteed now that
   rendering doesn't clip to that width. Fixed at the root: `layoutStage`'s `x` is now a distance from
   the entry's OWN edge for both sides (0 at rank 0, growing inward) — identical values on both sides,
   no longer `stageWidth`-dependent for the right side's own anchor point — and the caller
   (`StageRoster.jsx`) applies it as CSS `right` for a right-side entry instead of `left`. The browser
   now aligns flush to the true edge regardless of how wide the image actually renders; a figure can
   still grow further left into the drawer (intended), never further right off-screen (the bug).
   `server/test/sceneLayout.test.js`'s two `stageWidth - SLOT_WIDTH` assertions became `0`, and a new
   test pins that a right-side entry's `x` no longer depends on `stageWidth` at all.
2. **`h-screen` (100vh) rendered every figure taller than what was actually visible on a real phone.**
   Plain `vh` on mobile Safari is pinned to the LARGEST possible viewport (address bar fully
   collapsed), not the currently-visible one — so a figure sized to `100vh` while the address bar was
   still showing had its top pushed up above the real, visible top of the screen. Changed to
   `h-[70dvh]`: `dvh` (already this app's own convention for exactly this problem — see
   GmToolsWidget/Compendium/DialogShell's own `dvh` dialogs) tracks the current visible viewport
   instead of the chrome-collapsed one, and dropping from 100 to 70 leaves real headroom on top of
   that rather than trusting the browser chrome's own height down to the pixel — the user's own
   request, verbatim.

Verified: `npm run lint`, the full server suite (729/729 — one new `sceneLayout` test, no schema
changes). `scripts/playtest-scene.mjs` (30/30, unaffected). `e2e-mobile/scene.spec.js`'s Phase 5
summon test: the position check now asserts the wrapper's actual right edge sits flush against the
true viewport edge (`getBoundingClientRect().right`), not an inset formula; the height assertion
moved from the full test-viewport height to 70% of it. The Phase 6 reflow test's own `stageFigureLeft`
helper (GM summons, always side 'right' — it was reading a `.style.left` that no longer exists on
those figures) was renamed `stageFigureOffset` and reads whichever of `left`/`right` is actually set.
Manually verified beyond what's committed: a throwaway script summoned a deliberately extreme
600×150 image on a GM's own (right) side and measured it in a real browser — landed at `right: 1280`
(exactly the 1280px viewport's own true edge, confirming no overflow) and `height: 630, top: 270`
(exactly 70% of a 900px viewport, with the remaining 30% left clear at the top) — both numbers
confirming the fix rather than merely "looking right" in a screenshot.

**Manual drag-to-place and resize (decided, new).** Every summoned figure a viewer may edit (the GM:
anyone; a Player: only their own character's summon — the exact ownership rule `mayWriteScenePicture`
already enforces for `stage:summon`/`scene_picture:*`, mirrored client-side so a handle only ever
appears where the write would actually succeed) can be dragged anywhere on the stage and resized by
hand, on both mouse and touch. Two new nullable/defaulted columns on `scene_summons`:
`pos_x`/`pos_y` (fractions 0..1 of the *viewer's own* measured stage box, NULL meaning "never
manually placed — still governed by `layoutStage`'s automatic cramming") and `scale` (a per-summon
size multiplier, `NOT NULL DEFAULT 1`, independent of position — a figure can be resized without
ever leaving the automatic layout). A fraction of each viewer's own stage rather than a raw world
pixel (contrast `relationship_nodes.x`/`y`, which ARE raw pixels under that board's own pan/zoom
camera): the Scene stage has no camera and is already viewed at whatever size each device's own
screen happens to be (the backdrop is already `object-cover`, accepting some per-device framing
difference), so a fraction is what keeps a drag looking right on every screen without building one.
- **Two new socket handlers, `stage:reposition_summon`/`stage:resize_summon`**, both resolving the
  summon's own owner and gating through `mayWriteScenePicture` exactly like `stage:summon`, both
  broadcasting the same full `stage:updated` payload every other Scene write already does (no new
  event name for clients to learn). Values are clamped server-side (`pos_x`/`pos_y` to `[0,1]`,
  `scale` to `[0.25,4]`) rather than refused outright.
- **Committed once per gesture, on release — never mid-drag.** `stage:updated` is an unscoped
  `io.emit` to every connected socket, so streaming a write on every `pointermove` would re-render
  the whole table's screens dozens of times a second for a drag only the dragging viewer can see
  live anyway. Everyone else just sees the figure land in its new spot once the drag ends — the same
  trade-off `RelationshipBoard.jsx`'s own node drag already makes.
- **The drag/resize itself mirrors `RelationshipBoard.jsx`'s own node-drag**, not Framer Motion's
  `drag` prop: `onPointerDown` per figure, `window`-level `pointermove`/`pointerup`/`pointercancel`
  (not per-element, and no `setPointerCapture` — a drag has to keep tracking once the pointer leaves
  the figure it started on), a plain ref rather than state for the in-progress gesture, and direct
  DOM writes with no re-render until the drop. Framer's own `drag` prop was deliberately avoided —
  this codebase has hit the "two things both want `transform`" bug three times already
  (`StageRoster.jsx`'s and `RelationshipNode.jsx`'s own header comments), and `drag` would reintroduce
  exactly that conflict on figures that already have a transform-owning `motion.div` for their
  entrance/exit slide. A small handle drives the resize; dragging it tracks vertical distance only,
  matching this file's own established height-only sizing rule, and writes straight to that one
  `<img>`'s pixel height during the gesture before converting back to a `scale` ratio on release.
- **Corner controls: hidden by default, two reveal gestures, two corners (decided, revised).** The
  resize handle sits at a figure's own top-LEFT corner (moved from bottom-right); a new "remove from
  stage" ✕ sits at the top-right, reusing `stage:summon`'s own toggle (its own picture re-selected)
  rather than adding a second write — decision #4/#6 already made "no separate remove-from-stage
  write" a rule, and this button just gives that existing toggle an on-stage trigger. Both are hidden
  until revealed, on either of two gestures: real hover (`group-hover:opacity-100`, desktop's own
  affordance, free) or a completed tap that did NOT turn into a drag (`selectedId` in
  `StageRoster.jsx`, toggled in the shared pointerup handler — mobile has no hover to catch this).
  **Deliberately not this app's own established `.hover-only-action` convention**
  (`client/src/index.css`: a hover-only control defaults to always-visible on a coarse pointer, since
  there's nothing to hover) — here a single press is explicitly meant to BE the reveal gesture, so a
  bespoke per-figure toggle replaces that default for these two controls specifically. Single-select:
  tapping a different figure swaps which one is showing rather than stacking. Hidden corner buttons
  carry `pointer-events-none` (not just `opacity-0`), so an invisible one can never steal the
  pointerdown that should start a drag there instead. Resizing back down or re-dragging to the
  automatic layout still has no dedicated reset — un-summoning (the ✕) and re-summoning already
  produces a brand-new `scene_summons` row at `pos_x`/`pos_y` NULL, `scale` 1, which remains the
  escape hatch for position/size specifically, distinct from the ✕'s own job of clearing the seat.
- **Corner buttons stay clickable under the GM's own drawers (bugfix, found during manual
  verification of the above).** `StageRoster`'s whole roster renders inside its own low, fixed
  stacking context (`z-[1]` on the roster's outer wrapper) so a crowded roster's internal ranks never
  outrank the GM drawers' `z-10` (`SceneCastDrawer`/`SceneListDrawer`) — deliberate, since bleeding
  art behind a translucent drawer is the whole point of the full-bleed stage. CSS stacking contexts
  nest strictly, though: no *internal* z-index, however high, can out-rank a *sibling* context, so a
  figure's own `MANUAL_Z`/`ACTIVE_GESTURE_Z` never actually cleared the drawer either — confirmed
  live with Playwright's own hit-testing, not just an opacity check: a figure docked near the screen
  edge (routine for a GM's own right-side summons) had its Resize/✕ buttons visually reveal correctly
  on hover (opacity doesn't care about paint order) while a real click silently hit-tested to the
  drawer sitting on top of them instead. Fixed by promoting the roster's own *wrapper* to `z-[15]`
  (clears the drawers' `z-10`, stays below `TopLeftControls`' `z-20`) for as long as any figure's
  controls are showing — tracked via a new `hoveredId` state (real hover) alongside the existing
  `selectedId` (tap-select) — rather than bumping any one figure, since only the wrapper's own
  promotion can actually escape the sibling context. Accepted trade-off: while true, the *whole*
  roster briefly renders above the drawers, not just the figure being reached for, since they all
  share one wrapper — visually minor and only for as long as a hover/selection lasts, versus the
  added complexity of a React portal for just the one figure.
- **Hide Interface's exit gesture changed from "tap anywhere" to "press the toggle again" (decided,
  revised).** The original tap-anywhere-on-the-stage-to-return would have fought with dragging — a
  drag press on the stage is itself a tap on the stage, so it would have stolen the first frame of
  every drag to close cinematic mode, or exited it out from under a GM mid-repositioning a character.
  The hide/show toggle button (`ScenePage.jsx`'s `TopLeftControls`) is now the one element that
  survives `uiHidden` — every other overlay control, including the back-arrow off this route, still
  hides — and its own icon/title now flip between `EyeOff`/"Hide interface" and `Eye`/"Show interface"
  depending on state, since it now does both jobs. `StageRoster` itself was already rendered
  unconditionally regardless of `uiHidden` (*"the figures themselves are the one thing cinematic mode
  never hides"*), so the new drag/resize handlers needed no special-casing to keep working while
  hidden — they simply were never gated behind that flag to begin with.

**GM Notes (decided, new).** A GM-only "Notes" button in `ScenePage.jsx`'s corner controls (hides
along with the back-arrow while Hide Interface is on — see above — since it's a GM tool, not part
of the cinematic view) opens a dialog with two shapes behind a switch:
- **Scene Notes** — any number, each pinned to whichever Scene is currently active
  (`scene_notes.scene_id`, `NOT NULL`, `ON DELETE CASCADE` off `scenes`). Create/edit/delete, plain
  title + body.
- **Master Note** — a singleton (`master_note`, `id=1` `CHECK`, same shape as `scene_state`/
  `combat_state`'s own id=1 row), one Note for the whole campaign, reachable from any Scene's own
  Notes dialog and always the same content regardless of which one you opened it from — for
  planning that isn't about any single Scene.
- **Genuinely GM-secret, not merely GM-managed (decided) — the one deliberate departure from this
  feature's own established secrecy model.** Every other piece of Scene-tab authoring content (Temp
  NPCs, Scenes themselves, Scene Pictures) is open REST + an unscoped `io.emit`, "GM-*managed*, not
  GM-*secret*" — a Player's client simply never renders the drawers that would show it, matching
  `GET /api/characters`. Campaign notes are the opposite kind of content: spoilers, upcoming twists,
  NPC secrets a GM plans around — exactly what a technically-curious Player pulling the API directly
  would be looking for. `GET /api/scene-notes` and `GET /api/master-note` both go through the same
  `viewerFromQuery` 403 gate the Relationships board's own read already uses (`role !== 'gm'` →
  refused), and every write (`scene_note:create/update/delete`, `master_note:update`) is a
  server-enforced GM-only socket handler whose broadcast (`emitToGm`, new — mirrors
  `emitRelationships`'s per-socket-filter shape) reaches only GM-identified sockets, never a plain
  `io.emit`.
- No dedicated "browse notes across every Scene" view — the dialog always shows the *currently
  active* Scene's own notes, matching how the rest of the Scene tab already treats "one Scene at a
  time" as the working set. With no Scene active, the Scene Notes side shows a message instead
  (Notes need a concrete Scene to pin to); the Master Note side is unaffected either way.

**Notes dialog: full-height workspace + two-column saved boxes (decided, revised).** The original
layout stacked every Scene Note inline in one scrollable list, each in a fixed `rows={4}` textarea —
a note longer than a few lines was only readable by scrolling inside its own cramped box. Reworked
into three regions (`SceneNotesDialog.jsx`): a `editingId` state (`null` | `'new'` | a note's id)
tracks which ONE note, if any, sits in a full-height middle workspace (`NoteEditor`, no fixed `rows`,
`flex-1` instead); every other note renders as a compact clickable box (`NoteColumn`) in a side
column, split half-into-left-then-half-into-right (`Math.ceil(others.length / 2)`) rather than a
fixed per-column capacity nothing in the request specified. Saving (create OR update) clears
`editingId` immediately — before the server's own echo lands — which is what actually moves a note
out of the workspace and into a box the moment you're done with it; clicking a box moves that note
BACK into the workspace for further editing, excluding it from the side columns while it's there.
Each side column is independently `max-h-[70dvh] overflow-y-auto` (nested inside DialogShell's own
single shared scroll container) so a long list of saved notes never pushes the workspace itself
off-screen — the actual fix for "impossible to see it fully without scrolling."

**Follow-up, same day: full screen width, and saved boxes show their full body (decided,
revised).** Two further requests on the same dialog. First, `DialogShell`'s own `maxWidth` prop
was still capping it at `max-w-5xl` (1024px) even though the `fullscreen` variant it uses already
asks for `md:w-full` — changed to `maxWidth="max-w-none"`, the same override the `theater` variant
already uses internally, so the cap comes off and the dialog actually fills the screen width
(minus the shell's own small `md:p-4` margin). Second, `NoteColumn`'s own body preview dropped its
`line-clamp-3` — a saved note's box now always shows its FULL text (growing to whatever height that
needs) rather than an ellipsis-truncated 3-line preview, with `whitespace-pre-wrap` added so the
box actually preserves the note's own line breaks instead of collapsing them into one flowed
paragraph the way a plain `<p>` would.

**Follow-up: legible on a phone — and the breakpoint is HEIGHT, not width (decided, revised).**
Reported as "notes are barely visible on mobile; make the text scrollable when opened, with a
larger text and text field". The diagnosis matters more than the numbers:

- **The Scene tab is landscape-only** (`OrientationGate`), so "Notes on mobile" means a phone held
  sideways — about 844x390. That is **wider** than Tailwind's `md`, so every `md:` rule in this
  file already applied to it: a phone was being served the full desktop layout, three columns and
  all, inside 390px of height. Any fix written against WIDTH would have missed entirely, which is
  worth recording because the instinct is to reach for `md:` first.
- **The scarce resource is vertical.** `50dvh` of a landscape phone is 195px, and the note's title
  field plus the Cancel/Delete/Save row take most of it. That is the "barely visible".
- **A `dvh` guess cannot fix it, and made it worse.** A first attempt at `78dvh` overflowed the
  dialog and pushed Save off the bottom of the screen, because `fullscreen` resolves to
  `md:h-auto md:max-h-[90dvh]` at that width and a percentage height inside an auto-height parent
  resolves to auto. The fix is to give the panel a **definite** height on a short viewport
  (`panelClassName="[@media(max-height:640px)]:h-full"`) and then let flex distribute it: the
  dialog body is one flex column, the tab row is `shrink-0`, the workspace is `flex-1 min-h-0`, and
  the textarea is `flex-1 min-h-0 overflow-y-auto`. `min-h-0` is the load-bearing half — without
  it a flex item floors at its content size, so a long note grows the box instead of scrolling
  inside it, which is exactly what "make the text scrollable when opened" was asking for.
- **Text is 16px everywhere now**, with the `md:text-sm` downgrades dropped: notes are read, not
  skimmed, and on iOS Safari a focused field under 16px zooms the whole page in, which makes the
  dialog unusable one-handed. Side-box previews come up from `text-xs` to `text-sm` for the same
  reason, keeping the untruncated bodies decided above.
- Fixed chrome (tab row, title field, the editor's own padding) tightens under
  `[@media(max-height:640px)]`, which is what takes the open note from 4 to 6 visible lines on a
  real phone.

Measured, not assumed — 127px of note at 844x390, 163px at 932x430, 418px on a desktop, with the
Save button on screen and the dialog body not overflowing at any of the three.

**Manually-placed summons are anchored to the Scene's own artwork, not to each viewer's own screen
shape (bugfix, decided, revised).** Reported live: a GM repositioning a character saw it land in a
visibly different vertical spot on a Player's own screen — same horizontal position, wrong height.
Root cause: `pos_x`/`pos_y` were a fraction of the DRAGGING viewer's own measured stage box, and the
backdrop renders with `object-cover`, which crops that background differently depending on how each
viewer's OWN aspect ratio compares to the image's natural one — a wide desktop GM and a narrower
tablet Player crop the same picture differently, so "53.9% down MY OWN box" lands at a different
point in the ARTWORK for each of them, usually most visibly on the vertical axis (stage-box aspect
ratios tend to vary more in height-to-width proportion across devices than the images uploaded for
them do). Fixed with a new `client/src/lib/sceneProjection.js`: `stageToImageFraction`/
`imageFractionToStage` replicate `object-cover`'s own crop math to convert between "a fraction of
THIS viewer's stage box" and "a fraction of the image's own natural content" — the latter is what
`scene_summons.pos_x`/`pos_y` store and transmit now, so "the GM put them here" means the same
visual spot in the picture for every viewer, projected back through each one's own crop at render
time. `ScenePage.jsx` captures the backdrop `<img>`'s own `naturalWidth`/`naturalHeight` via
`onLoad` (reset whenever `backgroundSrc` changes) and now tracks `stageHeight` alongside the
pre-existing `stageWidth`; both flow down to `StageRoster.jsx`, which applies the conversion at both
ends — `stageToImageFraction` when a drag commits, `imageFractionToStage` when a manual figure
renders. Degrades to a plain stage-box fraction (the original behavior) whenever there's no image
loaded yet, so nothing breaks for a Scene with no backdrop. Auto-placed (never-dragged) figures are
untouched — `layoutStage`'s own left/right cramming was never image-relative to begin with and
still isn't; only the manual-position branch changed.

**Hidden (decided, new).** A per-summon GM-only toggle — `scene_summons.is_hidden`
(`INTEGER NOT NULL DEFAULT 0`, a plain `ensureColumn`, no schema split needed the way Notes required
one). A new corner button in `StageRoster.jsx`, stacked directly under the ✕ (same reveal mechanics:
hover or tap-select), GM-only regardless of ownership — unlike every other corner control, this does
NOT go through `mayWriteScenePicture`/`canEditSummon`, since hiding is a narrative tool the GM wields
over the whole table, not a "may I edit my own character" permission. A Hidden summon stays fully
present and editable for the GM (rendered at 50% opacity) but is genuinely absent — not just
CSS-hidden — from every non-GM view, **including the character's own Player** ("for Players, the
Hidden character becomes fully invisible" is read literally, not scoped to "everyone but the
owner"): `server/index.js`'s `getStagePayload` was split into `buildStagePayload` (the unfiltered
snapshot, now also carrying `is_hidden` and `drawings`, see below) and `stagePayloadFor(built,
viewer)` (drops any `is_hidden` row for a non-GM viewer), mirroring `buildCombatUpdate`/
`combatUpdateFor`'s existing split exactly. `emitStageUpdated()` replaces every former
`io.emit('stage:updated', …)` call site with a per-socket loop (`buildCombatUpdate`'s own
`emitCombatUpdated` shape) — a Hidden summon must never cross the wire to a non-GM socket even
transiently, so a single unscoped broadcast was no longer correct once Hidden existed. `GET
/api/stage` picked up the same redaction and now takes an `identity` query param (`getStage`,
`useStage`) the same way `GET /api/combat` already does, for the same reason.

**Scene drawings — a shared pen/eraser annotation layer (decided, new).** The opposite trust model
from GM Notes: open to BOTH roles (a Player may draw and erase exactly like a GM), and the
`scene_drawings` table deliberately carries no author column at all ("do not keep info about who
drew something, it is just a drawing for everybody"). Each row is one stroke: `scene_id` (`NOT
NULL`, `ON DELETE CASCADE`), `points` (JSON array of `[x, y]` pairs — fractions of the Scene's own
background image, the same `sceneProjection.js` coordinate space `pos_x`/`pos_y` use, for the same
hard-sync reasoning above), `color`, `width` (also an image-relative fraction, so a line reads the
same relative thickness on every viewer's own screen), and `is_eraser`. An eraser stroke is not a
deletion or a geometric clip against earlier strokes — it's an ordinary stroke row that every client
composites with `globalCompositeOperation: 'destination-out'` instead of `'source-over'`
(`SceneDrawingLayer.jsx`) when replaying every row in `id` order: the ORDER is the eraser, since a
stroke only ever erases what was already painted before it, never anything drawn after — matching
what a person watching an eraser pass over a real page would expect, without needing any
point-in-polygon math. `scene_draw:add` resolves `scene_id` server-side off the active Scene (same
pattern `stage:summon` established — refused outright with no active Scene), and validates/clamps
points (max 4000, each coordinate clamped to `[0,1]`) and width (`[0.001, 0.2]`) rather than trusting
a client verbatim. `scene_draw:clear` — the eraser tool's own "double-press" gesture client-side —
wipes every stroke on the active Scene regardless of who drew it (there's no author column to filter
by even if this wanted to); deliberately NOT GM-gated, since the whole feature is a shared, anonymous
tool by design, so the ability to clear it is shared too. Drawings ride the SAME `stage:updated`
payload as summons (`buildStagePayload`'s own `drawings` field, `ORDER BY id ASC` — replay order is
load-bearing, unlike `summons`' own `DESC`) rather than a separate event, so they stay in sync with
Scene switches automatically through the subscription `useStage()` already provides.
`SceneDrawingLayer` is a `<canvas>` rendered as a SIBLING of `StageRoster`, not nested inside it —
nesting would inherit that component's own low, capped stacking context (see the corner-button/GM-
drawer bugfix above) and hide a drawing under a manually-placed figure. Its own `STAGE_DRAWING_Z`
(700) sits above `StageRoster`'s `MANUAL_Z` (500, drawings render OVER steady-state figures, the
common "circle this, point at that" GM annotation use) but below `ACTIVE_GESTURE_Z` (9000, a figure
actively being dragged/resized right now still visually wins). The canvas only captures the stage's
pointer events (`pointer-events: auto`) while a tool is actually selected (`'pen'`/`'erase'`) — at
the default `'select'` tool it's `pointer-events: none`, letting every event fall through to
`StageRoster`'s own figures beneath regardless of the canvas's z-index. Because that capture spans
the WHOLE stage while active, every other corner control that must stay reachable regardless of the
active tool was bumped above `STAGE_DRAWING_Z` too: `TopLeftControls` and `PlayerSummonDock` both
moved from `z-20` to `z-[1000]`, and the new `SceneDrawToolbar` itself sits at `z-[950]` — the exact
same class of bug the drawer/corner-button fix above already caught once, deliberately avoided here
by getting the ordering right from the start rather than discovering it live. A stroke commits once,
on release, never mid-gesture — the same trade-off `stage:reposition_summon`/`stage:resize_summon`
already make, for the identical reason (streaming every point would re-render every other viewer's
canvas at pointer-move frequency for a line only the drawer can see move live anyway); the drawer's
OWN in-progress stroke still paints locally in real time for instant feedback, just not broadcast
until it's done. `SceneDrawToolbar` docks bottom-right (the one corner nothing else claims — GM
drawers own the full left/right edges, `PlayerSummonDock` owns bottom-left, `TopLeftControls` owns
top-left), available to both roles, hidden with the rest of the UI chrome while Hide Interface is on
(the canvas itself, like `StageRoster`, is not — drawings are part of the Scene, not UI chrome).
Pen: color swatch + width slider. Eraser: width slider only, plus the clear-all double-press.
Clicking the already-active tool's own button returns to `'select'`, the same "press it again"
shape `TopLeftControls`' hide/show toggle already uses. Last-used pen color/width and eraser width
are remembered **per device** (`sceneSettings.js`'s existing localStorage convention, extended:
`loadSceneDrawColor`/`loadScenePenWidth`/`loadSceneEraserWidth`), re-saved on every change rather
than read once — "remember it for each user" means live, not just at load, and this app's no-login
model has no other place for a per-user setting to live anyway.

**Corner buttons: a separate, always-stable overlay, never a second container the figure itself
moves through (bugfix, decided, THIRD design — supersedes the two-container/`FigurePortal` design
below).** That two-container design (kept here for the record of what was tried and why it broke,
rather than silently deleted) was itself found to be broken shortly after shipping: reported live
as "characters in Scene re-play their summoning animation every time I hover or un-hover over
them... this also resets the position of the characters, making it difficult to position characters
properly." **Root cause: changing a `createPortal()` call's own `target` between renders is NOT the
identity-preserving DOM move it was assumed (and, incorrectly, believed confirmed) to be.**
Diagnosed live with a throwaway Playwright script: a `data-diag-marker` DOM attribute set on a
figure's own wrapper vanished after a single hover, and `getComputedStyle` on a captured element
reference went stale (empty string, i.e. detached) mid-hover, both proving React was fully
unmounting and remounting the figure's subtree on every hover/un-hover — replaying its entrance
slide-in every time, and, far worse, orphaning `gestureRef`'s captured DOM node if a hover fired
while a drag was live, silently breaking the drag.

Fixed by giving up on ever moving or portaling the figure's own DOM subtree for ANY reason. A figure
now lives in exactly ONE wrapper (`wrapperRef`, `z-[1]`, never bumped) for its entire time on stage,
full stop — nothing about it changes based on hover/select state. The three corner buttons (Resize,
Remove from stage, Hide/Reveal) are rendered by a wholly separate, always-mounted, stateless sibling
component, `ControlsOverlay`, which:
- takes no figure DOM as `children` at all — it renders its OWN plain `<button>` elements,
  positioned with `position: fixed` at coordinates read from `elRefs.current.get(elevatedId)?.wrapper
  .getBoundingClientRect()` (a live snapshot, not a portal target);
- re-measures that snapshot in a `useEffect` keyed on `elevatedId` (`selectedId ?? hoveredId`) plus a
  `window` resize listener — not continuously (no rAF/ResizeObserver polling), since a
  merely-selected/hovered figure isn't expected to move on its own between those events;
- goes stale exactly once — a live drag/resize of the CURRENTLY elevated figure, which writes
  `style.left`/`style.top`/`style.height` directly without a re-render — handled by having
  `startMove`/`startResize` null the snapshot out the instant such a gesture begins (hiding the
  buttons for its duration) and the pointer-up handler re-measure and restore it once the gesture
  ends, via a plain ref (`elevatedIdRef`) mirroring `elevatedId` so the always-mounted pointer-event
  effect can read the current value without re-subscribing its `window` listeners on every hover;
- sits at `CONTROLS_Z` (15, clearing the drawers' z-10) as a plain sibling of the roster's own
  wrapper `<div>`, never nested inside anything the wrapper's own `z-[1]` caps — the same
  clears-the-drawer requirement the two earlier designs were both chasing, now satisfied with no
  DOM identity ever at stake, since these buttons carry no drag-gesture or animation state of their
  own to lose.

The roster wrapper still owns the same background click-catcher as before
(`onClick={(e) => e.target === e.currentTarget && setSelectedId(null)}`) — tapping any of its own
empty space (not a figure) clears the selection, "clicking on a place where there are no characters
deselects" (verbatim), unchanged by this redesign. `ACTIVE_GESTURE_Z` (9000, an in-progress
drag/resize) still isn't part of the elevation priority (`selectedId ?? hoveredId`) — a fresh drag
that never went through a prior tap-select or hover simply never shows corner buttons at all during
that drag, matching the pre-existing, out-of-scope limitation that a drag starting from directly
under a drawer was never specifically solved.

<details><summary>Superseded: the two-container/<code>FigurePortal</code> design (kept for
history — root cause of the remount regression above, do not resurrect)</summary>

Reported live: selecting a character on the Scene stage made the rest of the Scene UI (the GM's own
drawers, the draw toolbar) unreachable for as long as the selection lasted. Root cause was the fix
for the corner-button/drawer bug before THAT one: it promoted the roster's single wrapper `<div>` to
`CONTROLS_Z` whenever ANY figure was selected/hovered — which correctly let that ONE figure's own
corner buttons clear the drawer, but also lifted the WHOLE roster with it, with no way to dismiss it
short of re-tapping the exact same figure. "Fixed" (until the regression above) with two
ALWAYS-mounted sibling containers instead of one dynamically-bumped wrapper: a fixed-low-z-index
"crowd" container every figure lived in by default, and a fixed-`CONTROLS_Z` "elevated" container
with `pointer-events: none` on itself (so its own empty space passed clicks through) that the
currently selected-or-hovered figure was moved into via `createPortal(children, target, entry.id)`
— believed, incorrectly, to preserve the figure's own DOM node (and therefore its drag/resize refs)
across the container change, since only the portal's `containerInfo` was thought to change between
renders. It did not: see the root-cause paragraph above. `AnimatePresence` also could not wrap a raw
`createPortal()` result directly (`React.isValidElement()` returns `false` for a Portal, so
`AnimatePresence` silently dropped it), which this design's `FigurePortal` wrapper component papered
over — a real, if secondary, wrinkle worth remembering if a future design ever revisits portalling
an `AnimatePresence`-tracked child for an unrelated reason.
</details>

**Background Fit (decided, new).** How a Scene's own backdrop scales inside the stage box —
Cover (crop to fill, the previous hardcoded-only behavior and still the default), Best Fit/Contain
(show the whole image, letterboxed), Stretch/Fill (distort to fill exactly), Vertical Fit (match
height exactly, width free) and Horizontal Fit (match width exactly, height free).

- **Per-SCENE, not a per-viewer Settings slider — a real product decision, asked and confirmed
  rather than assumed.** Every OTHER Scene Stage control (Character Height, Distance Apart, Picture
  Size — Settings page) is deliberately per-device: how big YOU like characters on your own screen
  is a property of the person looking, not of the game. Background Fit breaks that pattern on
  purpose: a battle map's own edges can carry real information (an NPC drawn into a corner, part of
  a room) that a Player's own device happening to crop away with Cover would hide from them
  specifically, with no way for the GM to know or fix it per-viewer. So it's an authored property of
  the Scene's own art — `scenes.background_fit` (server: db.js), edited in `SceneEditor.jsx`
  alongside the backdrop picture itself, applying identically to every viewer, GM and Players alike.
  `GET /api/scenes`'s existing `SELECT *` picks it up for free; `buildStagePayload`'s own narrower
  `activeScene` query (server/index.js — deliberately NOT `SELECT *`, to avoid shipping thumbnail-
  only crop columns to every client on every stage update) needed `background_fit` added to its
  explicit column list by hand. `scene:update` always writes it alongside `name` (not the "absent
  means unchanged" contract the image upload itself uses) — server-validated against a fixed set
  (`VALID_BACKGROUND_FITS`) with a silent fallback to whatever the Scene already had for anything
  outside it, never trusting a client-sent value straight into a column read back out as
  CSS-affecting data. A `scenes` table that already existed under the pre-Background-Fit schema
  upgrades cleanly via `ensureColumn` (verified live the same way `scene_timestamps`' own
  `date`/`is_current` upgrade path was: hand-crafted the old schema, booted the server against it,
  confirmed no error and a normal read/update round-trip).
- **`fit-height`/`fit-width` have no `object-fit` keyword of their own — CSS `object-fit` always
  PICKS an axis itself** (`cover` picks whichever axis needs MORE scale to fully cover; `contain`
  picks whichever needs LESS), so there is no native way to force a SPECIFIC axis regardless of
  which way that leaves the other one going. `client/src/lib/backgroundFit.js`'s own
  `backdropFitClassName` instead sizes the `<img>` itself along just the one named axis (`height:
  100%` or `width: 100%`, the other left `auto` — how a plain replaced element already scales
  proportionally with zero help from `object-fit`) and centers it on the free axis with
  `left/top: 50%` + a matching `-translate`; the stage's own `overflow-hidden` (ScenePage.jsx's
  outer div) clips whatever overflows there, exactly like `cover` already relies on it doing.
  `max-w-none` (or an explicit width) still has to beat Tailwind's own preflight `img { max-width:
  100% }` reset, the same StageRoster.jsx height-only sizing already needed it for.
- **A necessary correctness fix, not scope creep: `sceneProjection.js` used to hardcode `cover`'s
  own crop math.** A manually-placed summon's `pos_x`/`pos_y` (and a drawing's own stored points)
  are fractions of the BACKDROP IMAGE, projected to screen pixels at render time by replicating
  whatever crop/letterbox/stretch the backdrop's own fit mode actually does — `coverGeometry`
  generalized into `fitGeometry`/`fitScale`, taking the active Scene's own `fit` and computing each
  mode's own scale-per-axis (uniform for cover/contain/fit-height/fit-width, independent X/Y for
  fill) before the shared offset/round-trip math. Left unfixed, any Scene using a non-Cover fit mode
  would have silently rendered every manually-placed figure and drawing in the WRONG spot the moment
  this feature shipped. `StageRoster.jsx`/`SceneDrawingLayer.jsx` both thread the active Scene's own
  `backgroundFit` through their existing `projectionGeometry`/`geometry` objects (added to each
  effect's own dependency array too, so a mid-session fit-mode edit or Scene switch doesn't leave a
  drag/stroke committing through a stale one); every function defaults `fit` to `'cover'` when
  omitted, so no pre-existing call site anywhere needed touching. Verified two ways: new unit tests
  (`server/test/sceneProjection.test.js` — each mode's own geometry promise, a stage->image->stage
  round-trip for all five, the no-image-yet degrade-to-plain-fraction case) and a live Playwright
  pass placing a summon at a known image fraction under `contain` on a real (canvas-generated, not
  hand-edited-base64) tall image and confirming it renders at the exact computed pixel — not where
  the old, unconditional Cover math would have put it.
- **Verification:** unit tests above (all 10 pass); live Playwright pass cycling a Scene through
  every fit mode via `SceneEditor.jsx`'s new `<select>` and confirming the backdrop `<img>`'s own
  className/rendered box matches each mode's promise (Cover/Contain/Fill fill the box exactly
  regardless of the image's own aspect ratio; Vertical/Horizontal Fit match their own named axis
  exactly while the free axis auto-scales from the image's REAL natural size); `scene:update`
  accepting `backgroundFit` alongside a fresh image upload in the same call; the schema-upgrade path
  against a hand-crafted pre-feature `scenes` table.
- **Best Fit, not Cover, is what a GM sees pre-selected the first time a Scene gets a backdrop
  (decided, revised).** `scenes.background_fit` defaults to `'cover'` at the schema level — every
  Scene needs SOME stored value, and Cover was the only mode that existed before this setting shipped
  — so `scene.background_fit` was never actually falsy, and `SceneEditor.jsx`'s own `<select>` always
  opened on "Cover" even for a Scene with nothing uploaded yet to have an opinion about. Its initial
  state now reads the stored value only once a backdrop already exists (`scene.image_data` truthy) —
  at that point it's a real choice, the GM's own or Cover from before this setting existed, and has to
  be respected exactly as stored; a Scene with no backdrop yet has no real choice to respect, so the
  picker opens on Best Fit instead, the mode least likely to hide part of the art on an odd-shaped
  screen. Purely the dialog's own initial React state — nothing about `scenes.background_fit`'s own
  schema default, `DEFAULT_BACKGROUND_FIT`, or what an EXISTING Scene already has changes.
- **Bugfix: a manually-placed figure moved DOWN from its default position never reached Players;
  moving it UP always did.** Root cause was upstream of any of the fit-mode math above: a `data:` URI
  backdrop (every Scene's own background is one) can finish decoding before React attaches the
  `onLoad` listener that captures its natural size — no network round trip creates the usual gap — and
  when that race is lost, the browser never fires `load` again for that same `src`, so `imageNatural`
  stayed stuck at `{width:0, height:0}` for the rest of that backdrop's life. `stageToImageFraction`
  silently falls back to a plain stage-box fraction whenever the natural size is unknown, and because
  an auto-placed figure's own default position already sits exactly at the stage's bottom edge, ANY
  downward drag from there instantly computed a fraction past 1 under that fallback and got clamped
  right back to where it started — while an upward drag still had the whole box above it to work with,
  so it always looked fine. `ScenePage.jsx` now also checks the backdrop `<img>`'s own `.complete`/
  `.naturalWidth` once per `backgroundSrc` change (a ref, read in a `useEffect` right after the
  existing reset-to-zero effect) and sets `imageNatural` from that if the image turns out to already
  be loaded by then — `onLoad` still handles a genuinely fresh load; this only catches the race.
  Verified live: reproduced with a real (non-degenerate-aspect-ratio) generated PNG backdrop under a
  headless GM browser session — `imageNaturalWidth/Height` read `0` and a 150px downward drag produced
  no visible movement (`pos_y` landing exactly at the clamp ceiling, `1`) before the fix; after it, a
  sequence of alternating up/down drags all produced proportional, non-clamped `pos_y` values matching
  their actual pixel distance in both directions. `scripts/playtest-scene-drag.mjs` (server-only, no
  backdrop image involved) still passes unchanged — this bug was entirely in the client's own natural-
  size capture, never in the server-enforced write path that script covers.
- **Bugfix, the SECOND half of the same report: a figure could not be dragged DOWN at all, and the
  drop never survived a reload.** The natural-size race above was real and worth fixing, but it was
  not the whole story — the report persisted after it shipped, with the telling detail that GM and
  Player now AGREED, on a position that was not where the GM had dropped the figure. `pos_x`/`pos_y`
  were clamped to `[0, 1]`: fractions of the backdrop image, so the bound reads as "somewhere on the
  artwork" and sounds obviously right. It is not. **A landscape backdrop in a landscape stage is
  scaled by `cover` until its own HEIGHT matches the stage's exactly** (`renderedHeight ===
  containerHeight`, so `offsetY === 0`) — the image's bottom edge IS the stage's bottom edge, and an
  auto-placed figure already stands precisely there. Its `fy` was therefore already `1.0` before any
  drag began: every downward drag computed a fraction past the ceiling, was clamped straight back,
  and stored `pos_y = 1` — while upward drags had the entire stage to travel through. That asymmetry
  is the whole "moving down does nothing, moving up is fine" report, and the clamped value being
  what persisted is why a reload "reset" the figure for the GM too. Under Best Fit/`contain` (now a
  new Scene's default) the same bound bites from the other side: the letterboxed part of the stage
  lies outside `[0, 1]` and could not be reached at all.
  - **Fixed by widening the bound to `[-1, 2]`** — one whole image-dimension of slack past each
    edge (`SUMMON_POS_MIN`/`SUMMON_POS_MAX` in server/index.js, mirrored as `POS_MIN`/`POS_MAX` in
    StageRoster.jsx, the same mirror-with-a-cross-reference convention `VALID_BACKGROUND_FITS`
    already uses). Far more than any real placement needs — a figure a full backdrop-height below
    the artwork is well off every screen — while still bounding what a hand-sent event can store.
    A figure standing "in front of" the scene with its feet below the artwork's bottom edge is an
    ordinary thing to want, and is now expressible.
  - **The earlier verification missed this because of the test image's own shape.** The natural-size
    fix was proven against a synthetic 800x1400 PORTRAIT backdrop, which `cover` overflows massively
    on a landscape stage (`renderedHeight` 2240 against a 800px box) — leaving ~719px of downward
    headroom and hiding the clamp entirely. Re-run against a 1600x900 landscape backdrop (the shape
    a real Scene actually uses) the bug reproduced immediately and exactly: `pos_y=1` after every
    downward drag, `0.85` after an upward one. Worth remembering as a fixture lesson in its own
    right — the aspect ratio of a test backdrop is load-bearing for anything touching `cover`.
  - **Verified**: the same landscape reproduction after the fix — a 220px downward drag moves the
    figure the full 220px and stores `pos_y=1.275`; **reloading the GM's own page leaves it exactly
    where it was dropped (0px drift)**, and a Player's window agrees to the pixel.
    `scripts/playtest-scene-drag.mjs` gained a check that a `pos_y` past the artwork's own bottom
    edge survives the round trip unclamped, and its existing clamp check now pins the new bounds.

**Timestamp tool (decided, new; revised — real dates, a compact 7-column grid, "Current").** A
GM-exclusive corner tool for narrative time markers played as a table-wide beat: dims the Scene 90%
to black and fades a chosen Date/subtext in, big and bold, centered, then fades back out. Docked
bottom-right in `SceneDrawToolbar.jsx`'s own row (Clock icon), alongside Pen/Eraser — "alongside the
other tools" (verbatim spec) reads as the SAME dock those already own, not a new corner, so the
button is simply GM-gated inside that existing component rather than getting its own.

- **Data model — one flat, GLOBAL table, not per-Scene (decided).** `scene_timestamps` (`id`, `name`,
  `date`, `subtext`, `is_current`, `created_at`) carries no `scene_id` at all, unlike `scene_notes`/
  `scene_drawings`. A Timestamp is a moment in the CAMPAIGN's own timeline, not an annotation
  belonging to whichever backdrop happens to be active — the same "not about any one Scene"
  reasoning `master_note` already uses, just as its own ordinary multi-row table instead of a
  singleton. A GM can play any Timestamp from any Scene; switching Scenes never changes the list.
- **Two different trust levels for the same table, split by verb (decided).** Managing the list
  (create/update/delete/the REST list read/marking one Current) is exactly as GM-secret as GM Notes:
  every socket handler checks `identity.role === 'gm'` and broadcasts only via `emitToGm`, and
  `GET /api/scene-timestamps` sits behind the same GM-only 403 gate `/api/master-note` uses — a
  Player can't enumerate the list over either transport. **Playing one is the opposite** — the whole
  point is for the WHOLE TABLE to see it, so `stage:timestamp_play` (GM-only to trigger) resolves the
  row server-side from `timestampId` and broadcasts `stage:timestamp_played` via a plain `io.emit`
  carrying only that one row's `date`/`subtext` — never an id, never the rest of the list, so a
  Player socket has nothing to look anything up with even if it wanted to.
- **`date` is a real calendar date (decided, REVISED — was free text).** Originally a plain
  `<input>` on the theory that this game's calendar is whatever the table's fiction says it is —
  corrected once actual use made clear the point was auto-sorting a timeline, which needs a real,
  comparable date underneath, not a string a GM could type "Day 47" or "Three Years Later" into.
  Stored as an ISO `YYYY-MM-DD` string (SQLite has no native DATE type; ISO text both sorts and
  compares correctly as-is and is exactly what an `<input type="date">` already produces/consumes,
  so no conversion happens on either end) and displayed everywhere as `formatTimestampDate`
  (`client/src/lib/timestampFormat.js`) renders it — `"May 12, 2015"`, `Date.UTC` +
  `timeZone: 'UTC'` on both ends so the calendar date typed into the editor is the exact same one
  shown back regardless of the viewer's own timezone. A table that already had the original
  free-text shape gets `date`/`is_current` added via `ensureColumn` (server/db.js) rather than a
  destructive rename — the old `date_text` column is left standing, unused (this codebase never
  drops a column, only adds), verified live by hand-crafting the pre-revision schema, booting the
  server against it, and confirming no error and a normal create/read round-trip. `name` stays a
  separate free-text field purely for finding an entry again in the management grid — never shown
  when played.
- **Auto-sorted chronologically, undated last (decided, new).** `GET /api/scene-timestamps` orders
  by `(date = '') ASC, date ASC, id ASC` — real dates first in calendar order, anything left blank
  sorted to the very end rather than jumbled at the front (an empty string would otherwise sort
  BEFORE every real date, lexicographically). `SceneTimestampDialog.jsx` never re-sorts client-side;
  it only chunks the order it's handed into the grid below.
- **Client — `SceneTimestampDialog.jsx`** (GM-only, opened from the toolbar button, `DialogShell`
  `fullscreen`+`portal`, mirroring `SceneNotesDialog.jsx`'s own shape minus its Scene/Master tab
  split, since there's only ever the one flat list here): a compact card grid, a trailing `+` tile,
  and a Name/Date/Subtext editor (`editingId`: `null` | `'new'` | an id, same pattern Notes' own
  `NoteEditor` uses) reused for both create and edit.
  - **A fixed 7-column grid, infinite rows, and a new Date always hard-starts a fresh row even if
    the previous one still had room (verbatim spec, decided, new).** Not expressible with CSS
    `grid-auto-flow` alone — there is no "restart the row on a value change" rule in CSS grid — so
    `groupIntoRows` builds the rows in JS: chunks the already-sorted list at 7, but also cuts a row
    short the moment the date changes, even mid-row. Every row still renders with the identical
    `grid-template-columns: repeat(7, minmax(0, 1fr))`, so despite being separate DOM rows they stay
    visually aligned into one continuous grid. Verified live: a run of 8 same-date entries
    correctly spans rows 2 and 3 uninterrupted (`[…,7]` then `[1]`), and the very next, different-
    dated entry gets its OWN fresh row 4 rather than filling the 6 empty slots row 3 left behind.
  - **Cards are now deliberately tiny (verbatim spec: "much smaller… so more fit simultaneously") —
    name plus formatted date only, `h-14`, no subtext preview at rest** (subtext is secondary flavor
    text, not needed to identify an entry at a glance, and the space it would cost isn't worth it at
    this size). Play/Edit/Star all scaled down to match: **Play** (centered, giant relative to the
    card but no longer literally giant) and **Star** and **Edit**, now side by side in the top-right
    corner ("near the edit button", verbatim) — same video-thumbnail hover convention as before
    (`.hover-only-action`/`group-hover`, CharacterList.jsx's own card-action convention, defaults
    visible on a coarse pointer since there's no hover to reveal it there).
  - **"Current" (decided, new) — a Star toggle, exclusive to at most one row at a time.** Clicking a
    non-current row's Star marks IT current and un-marks whatever was current before, in the same
    server write (`scene_timestamp:set_current`, server/index.js — clears every row's flag, then
    sets the target, so the exclusivity is never something the client has to keep straight across
    two separate writes); clicking the CURRENTLY-current row's own Star again clears it to none
    (a toggle, not a one-way pin). The Current card's Star stays visible even without hovering
    (unlike every other card's), doubling as an always-on badge — paired with a `border-brand-500`/
    `bg-brand-900/30` tint on the card itself — so which one is Current reads at a glance across the
    whole grid, not only on hover. `scene_timestamp:current_changed` broadcasts just `{ currentId }`
    (the new current row's id, or `null` once toggled off) — enough for every open GM tab's own copy
    of the list to patch itself locally without a refetch.
  - **Opening the dialog auto-scrolls to the Current Timestamp, once (verbatim spec: "so after there
    are a lot of them, I do not need to scroll for a long time").** `scrollIntoView({block:'center'})`
    on the Current card's own ref, guarded by a ref-flag so it only fires the first time the list
    loads with one — not on every subsequent live patch, which would otherwise yank the view out
    from under whatever the GM is actually looking at mid-session. Verified live against a
    120-Timestamp list with the Current one buried near the end: on open, it lands centered in the
    viewport with no manual scrolling.
  - **Pressing Play closes the dialog first.** A full-screen dim-and-fade beat playing out behind the
    GM's own management window instead of over the Scene everyone else is looking at would defeat the
    point, so `play()` emits `stage:timestamp_play` and calls `onClose()` in the same action.
- **Client — `TimestampCutscene.jsx`** — always mounted in `ScenePage.jsx`, like `StageRoster`/
  `SceneDrawingLayer`, regardless of `uiHidden`: this is narrative content, not a UI control, the
  same reasoning that already keeps summoned figures visible through cinematic mode. Listens for
  `stage:timestamp_played` and renders nothing until one arrives; the played `date` is run through
  the SAME `formatTimestampDate` the management grid uses, so the big bold text is never left in raw
  `YYYY-MM-DD` — and, since it's now real prose ("May 12, 2015") rather than free-text flavor text,
  the `uppercase` styling that used to shout it in caps was dropped (it would have rendered "MAY 12,
  2015" regardless of the actual casing typed in). One continuous Framer Motion keyframe run
  (`opacity: [0,1,1,0]`, `times:[0,0.2,0.8,1]`) covering fade-in/hold/fade-out as a single timeline —
  the dim (a `bg-black` layer fixed at `0.9` opacity) and the text share the SAME parent opacity, so
  one keyframe run animates both the "dim the Scene" and the "fade the text" halves of the spec at
  once, rather than two things kept in sync by hand. `key={play.seq}` (a fresh `Date.now()` each
  play) forces a remount — and therefore restarts the animation from t=0 — even if the SAME
  Timestamp is played again before the previous run finished, the same trick `RoundCutscene.jsx`'s
  own `ImpactBurst` uses for back-to-back hits. Reduced motion keeps the information (the card shown
  for the full configured duration) and drops the fade ramp: straight to fully shown, hold, straight
  back off, rather than skipping the beat entirely. `pointer-events-none` on the whole overlay — the
  dim is purely visual, nothing underneath (the hide-interface toggle included) is ever actually
  blocked from a click while a card plays.
- **A Scene can CUE a Timestamp, played automatically on activation (decided, new).**
  `scenes.timestamp_id` — nullable, `ON DELETE SET NULL`, added by `ensureColumn` — and
  `scene:activate` plays that Timestamp for the whole table straight after pushing the new
  stage.
  - **The column is on `scenes`, pointing AT a Timestamp — never a `scene_id` on
    `scene_timestamps`.** That direction is what preserves the decision recorded above: a
    Timestamp stays a moment in the CAMPAIGN's timeline, the list stays flat and global, and
    many Scenes may cue the same moment. A `scene_id` on the Timestamp would have quietly
    converted the feature into per-Scene annotations.
  - **`ON DELETE SET NULL`, not CASCADE** — deleting a moment from the timeline must not
    delete the Scene that happened to cue it. Pinned by the playtest, because the wrong
    keyword here destroys authored content and nothing else would notice.
  - **Every activation fires it, including re-activating the Scene already live (decided).**
    Activating is a deliberate GM action, so it doubles as a way to replay the beat without
    opening the Timestamp dialog.
  - **It does NOT touch `is_current` (decided).** The star is the GM's own marker for where
    the campaign sits and stays theirs to move; cueing a beat from a backdrop is a
    presentation act, not a claim about the timeline.
  - **`timestamp_id` is withheld from Players, unlike the rest of the Scene row.** Scenes are
    GM-*managed* but not GM-*secret* — `GET /api/scenes` is an open read and `scene:updated`
    reaches everyone — whereas the Timestamp list sits behind a GM-only 403 precisely so a
    Player cannot enumerate the campaign's timeline, and `stage:timestamp_play` deliberately
    broadcasts date/subtext but never an id. Leaking the cue id on the Scene row would chip at
    that for no gain, so `publicScene` strips it: `GET /api/scenes` returns it only for
    `?role=gm`, and `emitScene` sends the full row to GM sockets and the stripped row to
    everyone else. The auto-play broadcast reuses `stage:timestamp_played` unchanged, so this
    adds **no new event and no new way for a Player to learn anything**.
  - **Client** — a "Timestamp on activate" `<select>` in `SceneEditor.jsx` below Background
    Fit, defaulting to None, listing every Timestamp as `Name — May 12, 2015` via the same
    `formatTimestampDate` the grid and the cutscene use. Always sent on save (`null` for
    None), because the server reads `undefined` as "leave it alone" — which is the right
    contract for the optional background but the wrong one for a picker that always has a
    value. `getScenes` now takes an identity so the GM drawer's own fetch carries
    `{ role: 'gm' }` and gets the cue back to pre-select.
  - **`scripts/playtest-scene-timestamp-cue.mjs`** covers all of it against a live server with
    a real second (Player) socket: that an uncued Scene is silent, that a cued one reaches a
    PLAYER, that the payload carries date/subtext and **no id**, that re-activation replays,
    that `is_current` is untouched, that a Player's Scene list has no `timestamp_id`, that
    clearing the cue stops the beat, and that deleting the Timestamp leaves the Scene standing
    with a NULL cue. None of that is unit-testable — every one is a question about what
    crosses the socket and to whom.
- **Settings — "Timestamp Card Duration" (decided, new).** Per-device, `sceneSettings.js`
  (`loadTimestampDuration`/`saveTimestampDuration`, 1–10s, default 3s — "roughly 3 seconds" per
  spec), same "read once at `ScenePage` mount, per-viewer, never socket-synced" shape every other
  Scene Settings slider already uses: every viewer's socket receives the identical play event, but
  each renders the fade timing on their own configured clock — an absolute duration rather than a
  multiplier like Cutscene Speed, since there's no existing pace here to scale.
- **Verification:** `scripts/playtest-scene-timestamps.mjs` (GM-only management + REST 403 for a
  Player, a forged `scene_timestamp:create` from a Player is silently refused, chronological
  auto-sort with undated rows last, Current's exclusivity — marking a second row current un-marks
  the first, re-toggling the current one clears it to none — a Player may not trigger a play or set
  Current, playing broadcasts `date`/`subtext` to BOTH a GM and a Player socket with no id/name
  attached). Manual Playwright pass (throwaway, deleted before committing): the toolbar button sits
  in the same row as Pen and is absent entirely for a Player while Pen still renders; the date
  displays as "May 12, 2015"; the exact row layout (`[1,7,1,1,1]`) an 8-entry same-date run followed
  by a different date produces, proving same-date entries span rows uninterrupted while a new date
  always hard-starts a fresh one; the Current badge persists without hovering and moves correctly
  when a different row is starred; auto-scroll centers the Current card on open even 120 entries
  deep; the create/edit/delete round-trip through the dialog; pressing Play closes the dialog and the
  big Date text plus subtext plus a 90%-opacity black dim layer appear, clearing itself once the
  configured duration elapses; and booting the server against a hand-crafted pre-revision table
  upgrades it cleanly with no error and no data loss.


## Data model
Every table the server creates (`server/db.js`, all `CREATE TABLE IF NOT EXISTS`). Picture-bearing tables store base64 `image_data` + `image_mime_type` + a content `image_hash` (served as cacheable `/api/img/:kind/:id/:hash` URLs, see Hosting cost) and, where a crop editor exists, `crop_x/y/w/h`.

- **characters** — `id, name, character_type ('pc'|'npc'), image_data, image_mime_type, image_hash, crop_x/y/w/h, folder_id, created_at`
- **character_folders** — `id, name, parent_id` (self-reference, any depth)
- **counters** — `id, character_id, name, target_pips, current_pips, reward_type` (Story/Statistic/Perk/Move/Combat Prowess; `character_id` NULL only on pre-pivot standalone rows)
- **counter_gates** — `id, counter_id, pip_index, name, description, secret, created_at`, `UNIQUE(counter_id, pip_index)`
- **roleplay_entries** — `id, character_id, question, answer, is_custom`
- **relationship_nodes / relationship_edges / relationship_people** — the Relationships board (see its section)
- **scene_pictures** — `id, character_id | temp_npc_id, name, image_*`
- **temp_npcs, temp_npc_folders** — the Scene tab's throwaway cast
- **scenes, scene_folders, scene_state** (`active_scene_id`), **scene_summons** (`scene_id, character_id | temp_npc_id, scene_picture_id, side, pos_x, pos_y, scale, is_hidden`), **scene_drawings**, **scene_notes**, **scene_timestamps**, **master_note**
- **audio_playlists, audio_tracks, audio_state** — the Audio Player
- **chat_log** — `id, kind ('message'|'roll'), character_id, dice_rolled, modifier, content, image_*, payload, created_at` (`move_id` is a leftover column, unused)
- **combat_profiles** — `id, character_id | temp_npc_id (UNIQUE each), image_data, image_mime_type, image_hash, crop_x/y/w/h, unique_tokens (JSON array)`
- **combat_reminders** — `id, character_id | temp_npc_id, scope, timing, target, target_character_id, target_temp_npc_id, text, stance_id, created_at`
- **combat_stances** — `id, character_id | temp_npc_id, name, dice (JSON), created_at`
- **scenes.combat_mode**, **scene_summons.lane_slot** — see Phase 2 as built.
- **scenes.combat_image_*, grid_*** and **combatants** — see Phase 3 as built.
- **map_tiles** — see Map tiles.
- **characters.assigned_to** — the PC (player) an NPC is assigned to; NULL = the GM's alone. See Roles / access model.
- **scenes.simple_weight / combat_weight**, **combatants.level / fighter_kind / bled_round** — see Cinematic Weight as built.
- **table_settings** — `id = 1, simple_lanes` — see Multi-lane as built.
- **fights** — see Phase 5 as built.
- **chat_log.kind** also allows `reminder` and `stance_roll` (fight cards, JSON in `payload`).
- **event_lanes** — `id, name, visibility ('all'|'gm'), position`; **event_notes** — `id, lane_id, text, color, position, author_role ('gm'|'player'), author_character_id, created_at` — see Events tab.
- **homebrew** — `id, kind, data JSON, published, created_at, updated_at` — see Homebrew builder. The committed core is not in the database: it is files in the repo (`homebrew/items/`, `homebrew/automation.json`) — see Commit Homebrew.
- **compendium_archive** — `id, archived_at, counts (JSON), payload (the archive document)`; append-only

## Real-time events (Socket.io)
Clients emit; the server validates, writes, and broadcasts. The surviving contract:
- **Identity:** `identity:set { role, characterId? }` (re-sent on reconnect; answered with `audio:state`).
- **Characters & folders:** `character_folder:create|rename|delete`, `character:set_folder` → `character_folder:*`, `character:updated`. Create/edit/delete characters is REST (`POST/PUT/DELETE /api/characters`), broadcasting `character:created|updated|deleted`.
- **Counters:** `counter:create { characterId, name, targetPips, rewardType? }`, `counter:adjust`, `counter:set_reward`, `counter:delete`, `counter_gate:save|delete` → `counter:created|updated|deleted`, per-viewer `counter_gates:updated`.
- **Role-play:** `roleplay:save_answer|add_question|update_entry|delete_question` → `roleplay:updated`.
- **Relationships:** `relationships:add_node|move_node|update_node|delete_node|add_edge|update_edge|delete_edge|move_end|create_person|update_person|delete_person|undo` (per-viewer payloads — see its section).
- **Chat:** `chat:message { characterId, text, imageData? }` → `chat:message`; `dice:roll_custom { characterId, size, modifier }` → `roll:result`; `chat:clear` → `chat:cleared`.
- **Scene tab:** `temp_npc*`, `temp_npc_folder:*`, `scene_picture:create|copy_from_profile|update|delete`, `scene_folder:*`, `scene:create|update|set_folder|copy|delete|activate`, `stage:summon|reposition_summon|resize_summon|toggle_hidden|timestamp_play`, `scene_draw:add|clear`, `scene_note:*`, `master_note:update`, `scene_timestamp:*` (see the Scene tab section).
- **Audio:** `audio_playlist:*`, `audio_track:*`, `audio:play|pause|resume|stop|seek|next|previous|set_mode|ping|duration|track_ended|error|lookup_title` → `audio:state` (see Audio Player).
- **Scene modes:** `scene:set_mode` (GM), `lane:move` → `stage:updated`.
- **Table settings:** `table_settings:set` (GM) → `table_settings:updated`.
- **Fights:** `fight:start|next|choose_stance|set_sides|end` → `stage:updated`; cards → `chat:card`; `fight:turn_ended { combatantId }` and `fight:ended { mode }` (io.emit) for the Scene's pinned roll cards.
- **Map tiles:** `map_tile:place|remove|destroy|move|clear` → `stage:updated` (see Map tiles).
- **NPC assignment:** `character:assign { characterId, playerCharacterId | null }` (GM) → `character:updated { id, assigned_to }`.
- **Fighter state:** `fighter:token|challenge|hp|set_hp|add_bar|remove_bar|clear_dizzy|set_stance|heal` → `stage:updated`; `fight:preset_weight` (GM) → `stage:updated`; a Bleed posts a `chat:card` reminder.
- **Combat map:** `scene:set_grid`, `scene:set_combat_image`, `combat_token:place|move|remove|clear` → `stage:updated`. A hand move first asks `move:hand_cost` and, on "Yes", `move:hand_pay` (acks; play feedback batch 2).
- **Batch 4:** `fight:resolving { sceneId, mode, busy }` (io.emit); prompts gain `skippable` (answer `'__skip'`); `/api/fighter-state/:id` gains `supers`.
- **Batch 5:** `fight:resolving` gains `steps [{ label, state: 'done' | 'now' | 'queued' }]`; `fight:reorder { mode, from, to }` (GM); `board:current { mode }` → ack `{ payload | null, characterId }`; map tiles in the stage payload gain `by` (who placed it), and `map_tile:move` / `map_tile:remove` only act on your own (the GM: any). Column `map_tiles.placed_by`.
- **Batch 3:** `move:undo` (ack), `fight:active_range { mode }` (ack → `{ combatantId, squares }`); `move:reach` gains `canUndo`; target prompts gain `mode`, `area` and squares on their options; `pick:view` / `pick:clear` (io.emit) and `move:view_end` show every board pick to everyone.
- **Interrupts:** `interrupt:offers` (ack), `react:open` (ack: `{ payload, clusters }` or `{ queued: true }`), `react:pass`, `interrupt:cancel { mode }` (GM) → `stage:updated` (`fights[mode].interrupt = { active, queue } | null`); `interrupt:open { mode, combatantId, by, payload, clusters }` (io.emit) when a queued Interrupt's turn comes (play feedback batch 2).
- **Combat tab:** `combat_profile:update` → `combat_profile:updated`; `combat_reminder:create|update|delete` → `combat_reminders:updated`; `combat_stance:create|update|delete` → `combat_stances:updated`.
- **GM tools:** `image:reencode`.
- **Events tab:** `event_lane:create|update|move|delete` (GM), `event_note:create|update|delete|move` → `events:updated` (each socket gets its own board: GM-only lanes go only to the GM).
- **Homebrew:** `homebrew:save|publish|delete` (GM) → `homebrew:updated { items, automation, coreIds }`; `homebrew:commit` (GM, ack) commits the published items to the repo — see Commit Homebrew.

REST reads: `/api/events` (the board for `?role=…&characterId=…`), `/api/homebrew` (`{ items, automation, coreIds }`), `/api/health`, `/api/characters`, `/api/characters/:id` (→ `{ character, roleplay, counters }`), `/api/characters/:id/relationships`, `/api/character-folders`, `/api/counter-gates`, `/api/chat`, `/api/search`, `/api/temp-npcs`, `/api/temp-npc-folders`, `/api/scene-pictures`, `/api/scenes`, `/api/scene-folders`, `/api/stage`, `/api/scene-notes`, `/api/scene-timestamps`, `/api/master-note`, `/api/audio-library`, `/api/img/:kind/:id/:hash`, `/api/image-inventory`, `/api/profile`, `/api/compendium-archive[/:id]`, `/api/combat-setup`, `/api/combat-profiles`, `/api/table-settings`.

## Pages / views
Header: the "Dogfight" logo (→ your home: the roster for a GM, your sheet for a Player), the **Characters**/**Character** link, **Scene**, **Events**, Search, Chat toggle, and the Settings cog. Below `md:` a bottom nav (Characters, Chat) and a "More" menu (Search, Scene, Events, Settings) replace it.
1. **Role-select modal** — every fresh load.
2. **Character list** (`/`, GM) — see Characters.
3. **Character sheet** (`/character/:id`) — header + Counters / Role-play / Relationships / Scene Pictures.
4. **Scene** (`/scene`) — chromeless, landscape; see the Scene tab section.
5. **Settings** (`/settings`).
6. **Events** (`/events`, everyone) — sticky notes in lanes; see Events tab. Linked as **Events** in the header (desktop) and the "More" menu (mobile).
Chat is a side panel on desktop (open by default) and a full-screen overlay on mobile (closed by default, with an unread badge on `roll:result`/`chat:message`).

## Events tab (decided, new; implemented)
A global page of sticky notes in lanes, for keeping track of what's going on in the story.
- **Lanes (GM):** a name and a visibility toggle, **Everyone** or **GM only**. The GM adds them (name + visibility at the top), renames one (double-click its name), switches its visibility (the badge), moves it up or down, and deletes it.
  - **Deleting a lane** moves its notes to the end of the first remaining lane of the same visibility; an Everyone lane's notes may also go to a GM-only lane (hiding them is safe), never the reverse. With nowhere to go, they're deleted with it. The confirm says which.
- **Notes (anyone who sees the lane):** written straight into a lane (decided: there is no Unsorted row) with **+ Note** at the end of the row. Short text (up to 280 characters) and one of five colours: yellow (default), pink, blue, green, orange. Each shows its author (the GM or the character's name).
  - **Only the author or the GM** edits a note's text or colour, or deletes it (decided). Clicking your own note opens its editor.
- **Moving (anyone who sees the note):** drag a note along its lane to reorder it, or drop it into another lane you can see; a bright bar marks where it lands. A Player can't move notes into or out of a GM-only lane (they never see one).
  - The mouse drags the whole note; touch drags by the grip (⋮⋮) at its corner, so a finger can still scroll the lane. Holding a dragged note near a lane's end scrolls that lane.
  - **Each lane is a row that scrolls sideways on its own.**
- **Privacy by absence:** the board is shaped per viewer (`shapeBoard`); a GM-only lane and its notes never reach a Player — not on `GET /api/events`, not in `events:updated`.
- **Live:** every change re-sends each connected socket its own board; a moved note shows at once on the mover's screen.
- **Code:** `server/events.js` (handlers, `shapeBoard`, `placeAt`), `client/src/components/EventsPage.jsx`. Tests: `server/test/events.test.js` (who sees what, who edits what, where a move lands) and `scripts/playtest-events.mjs` (lanes, notes, permissions, moves, a lane hidden and shown, a lane deleted). A browser run (desktop and phone) showed the board, a note dragged from one lane into another, and the editor.

## Game system — Panic at the Dojo combat assistant (decided, planned)
The new system is **Panic at the Dojo: Patch'd Up** (Vel Mini / Liberi Gothica, 2024-2025 revision; the book is CC-BY-SA 4.0, so token names and short rules text may appear in the app with attribution). **The app is a visual assistant, not a rules engine:** it shows the fight — positions, HP bars, tokens, turn order — and posts reminders. It never rolls Action Dice, resolves Actions, applies damage, or spends tokens on anyone's behalf. Every number changes because a person pressed a button.

Rules facts the design leans on (book pages in brackets):
- **Tokens [p.75-78].** Four kinds. **Basic**: Iron, Power, Speed. **Status**: Burning, Fatigue, Weakness. **Challenge is a Unique token (decided, the user's ruling — the book lists it among the Status tokens):** a "discard a Unique / any token" may take a held Challenge; a Status, Basic or non-Unique discard never does. **Unique**: tokens specific to an Archetype, Form or Style. **Super**: Unique tokens created by a Super Move. The book caps each type at 10 (Training at 4, Challenge at 1); **decided: the app caps every type at 9** (single-digit counter), Challenge at 1.
- **The Unique token catalog** (hardcoded from the book, decided): **Control** (Control Form; also granted by the Counter bonus), **Chaos** (Demon; also given by Mastermind Style's Diabolical Plan), **Luck** (Underdog), **Mentor** (Teacher), **Inspired** (Teacher / Motivating Style), **Poltergeist** (Phantom), **Training** (Training Style), **Rapid Strike** (Super token, the Underdog's Blur Super Move). The book says "and others", so the catalog is one constant in one module and gains entries by a one-line change.
- **End Phase [p.68]**, in order: End of Turn Abilities; Traps; then tokens: the active character takes damage equal to their Burning tokens and discards half of them (rounded up), Iron can't reduce it; a Challenge is removed if its holder tried to damage their Challenger this turn; **everyone** discards 3 Speed tokens (all of them if fewer); the active character may discard up to 3 Fatigue if they didn't leave their starting space.
- **Health bars [p.62]:** damage never carries from one bar into the next. A broken bar makes you **Dizzy until the end of the current turn**. Breaking the last bar means **Taken Out** (0 HP, revived by any healing).

### Character sheet — new **Combat** tab
~~Also available for Temp NPCs~~ — **superseded (decided, revised): Temp NPCs take no part in combat at all.** See "Temp NPCs out of combat" below.
1. **Token image** — a round combat token, separate from the profile picture and the Scene Pictures; uploaded with the same picture pipeline and crop.
2. **Unique tokens** — the catalog above, one checkbox each. A placed token shows every Basic and Status token plus the checked Unique ones.
3. **Reminders** — three columns of user-written reminders, each a text and a trigger. They post to chat as reminder boxes, public to everyone (decided), carrying the character's name and portrait.
   - **Your turn:** start or end of this character's turn.
   - **Others' turns:** start or end of someone else's turn, filtered to **anyone / allies / enemies / one named character** (decided). Sides come from Start Combat.
   - **Round:** start or end of a round.
   - **Automatic (global) reminders**, never authored, from the End Phase: **Burning** (active character holds X: "take X damage, Iron can't reduce it, then discard ⌈X/2⌉"), **Speed** (every character holding Speed: "discard 3 Speed"), **Fatigue** (active character holds Fatigue: "if you didn't leave your starting space, you may discard up to 3 Fatigue"), **Challenge** (active character holds a Challenge: "if you tried to damage <Challenger> this turn, discard their Challenge"). All fire at the end of the turn. One reminder box per rule, listing every character it applies to with their portraits. Reminders only remind: the app never removes the tokens itself.
4. **Stances** (decided, added after scoping). A fighter (Character or Temp NPC) can have several Stances, each a **name** and a **dice pool of 1 to 8 slots**; each slot is a die from **d4 to d12** or a **fixed number from 0 to 12** in its place. Exactly one stance is **active** at a time — **per placed copy**, like HP (decided), defaulting to the first stance.
   - **At the start of a fighter's turn** (Phase 5): with one stance, its dice roll straight into chat, each die's result shown separately. With several, a dialog lists the stances by name and asks for one; only the chosen stance's dice roll. The dialog goes to the fighter's **player, and the GM can always answer it too** (decided); NPCs and Temp NPCs ask the GM. **Stance selection happens before any reminder of that turn fires**, so stance-bound reminders see the new stance.
   - **The active stance can also be switched any time** from the token panel (decided), for corrections and abilities that change stance mid-turn. Switching never rolls; rolling happens only at turn start.
   - **Reminders can be bound to a stance** (optional): a bound reminder fires only while that stance is the fighter's active one.
- **Max HP and HP bar count are not on the sheet** (decided): they're set on each placed token.

### Scene page — the **Scene / Simple Combat / Combat** toggle
A three-way toggle at the top of the Scene page, **shown to the GM only** (decided: Players don't see it at all); everyone's view follows (like Scene activation). It is hidden while the cinematic hide-UI mode (the crossed-eye button) is on. Combat state is **per Scene**, one fight at a time per mode; switching Scenes pauses that Scene's fight. **Simple Combat and Combat are separate fights** (decided), each with its own placements, HP, tokens and initiative.
- **Scene** — everything the Scene tab does today.
- **Simple Combat** — the Scene as it is — **the full-size figures stay too** (decided) — plus an overlay: a single lane of 10 segments in perspective (see the sketch: a trapezoid strip, outer segments slanting outward), centred at **5/7 of the screen height from the top**. The lane glows faintly in the dominant colour of the Scene background; the lane lines glow soft white with a black outline. Every summoned character stands on it as a **miniature**: their current Scene Picture, scaled slightly smaller than a segment, fading to transparent toward the bottom edge so the feet disperse, on a small vector plinth like a tabletop mini's base. They start packed from the left in any order. One per segment, drag to move, snap to the segment's centre; while dragging, the segment under the pointer fills with a half-transparent yellow glow. Clicking a miniature opens the same token panel as Combat (below).
- **Combat** — a top-down map:
  - Each Scene gains a **Combat Background**, a separate image from its Scene background.
  - A square grid overlays it, with GM controls: **square size in pixels** (±1 steps, live preview), **X/Y offset**, and **opacity** (slider). The grid stops at a **10% padding** inside the image's edges, and lines simply end there even if that cuts a square short.
  - Characters and Temp NPCs are dragged onto the map as round tokens, snapped to grid squares. **The same actor can be placed several times** (minions), and **each copy is independent**: its own HP bars, tokens, Challenge and initiative turns.
  - **Zoom (decided, added with Phase 5):** each viewer can zoom the battle map, 1× to 5×, with the mouse wheel (about the pointer) or +/−/fit buttons in its bottom-right corner, and pan by dragging empty map. It is local to that viewer and never synced. Placing, moving and the drop highlight work at any zoom; the map and its tokens are clipped to the area between the drawers.
  - **Tokens stick to their squares (fix):** a token slides (160ms) only when it moves itself (a drop, a swap). Any render where the view moved (pan, zoom, resize) turns the slide off, so tokens move with the map in the same frame instead of trailing it.
  - **Stage figures locked in Simple Combat (decided, new):** while the Scene is in Simple Combat, the full-size figures behind the lane can't be moved, resized or unsummoned from the stage by anyone (`StageRoster locked`), so a drag aimed at the lane never shifts them.
  - **Kept mounted (fix):** the Scene's backdrop, figures and drawings stay mounted (hidden) while the Scene is in Combat, so leaving Combat shows them at once instead of reloading. Once shown, the Combat map likewise stays mounted outside Combat. A hidden map ignores palette drags (`active` prop).
  - **Decided for Phase 3:** Combat mode is **map only** — the Scene's figures, drawings and lane are hidden while it is on. Grid size and offset are in the **map image's own pixels**. Tokens come from a GM **Fighters** drawer (left) and a Player's own **dock**; the right drawer holds the map settings. One token per square: **dropping onto another token swaps the two**, like the lane; a brand-new token can't swap, so an occupied square refuses it.

### The token panel (on a Combat token or a Simple Combat miniature)
Clicking a token opens its panel; a click that turns into a drag closes the panel and moves the token instead.
- **Upper panel — tokens:** one row of icons: Basic, Status, then the actor's checked Unique tokens. Icons come from an open-source game-icon set (game-icons.net, CC BY 3.0, credited in the app). Clicking an icon shows its name above it and **+ / − / −−** (add 1, remove 1, remove all) below it. Only one icon is open at a time. **Any token with a count of 1 or more stays shown above the token permanently**, with a high-contrast red count badge in its bottom-right quarter (half the icon's width and height).
- **Upper panel — Challenge slot:** a small empty round button. Clicking it lists every fighter in this fight to its right; picking one fills the button with that fighter's portrait and keeps it shown permanently above the token, half-transparent. Sparse, small, half-transparent red particles drift from it toward the chosen Challenger, a gentle "threat" cue. Book meaning: this token's holder carries that fighter's Challenge. Cap 1.
- **Quick spend (decided, added with Phase 5):** with the panel closed, clicking a token icon shown above a fighter removes one, the same as its "−" — tokens are spent far more often than gained. Only for whoever may edit that fighter. **The held Challenge works the same way (decided, fix):** clicking it with the panel closed removes it (`fighter:challenge { target: null }`); with the panel open it still opens the Challenger picker.
- **Decided for Phase 4:** a **compact HP bar stack is always visible** under every fighter (the full panel opens on click), and **everyone sees every fighter's HP and tokens**; only the owner (or GM) edits.
- **Bottom panel — HP bars:** a bar with **−** at its left end and **+** at its right (±1; Max HP up to 99, so two digits). A golden **+** under it adds another bar. Every bar shares the first bar's Max HP, and new bars start full. Extra bars stack behind and slightly below the main bar, bottom half visible. When the current bar reaches 0 it plays a **breaking animation**, the next bar moves up, and a **Dizzy ("sleeping") icon** covers the whole token **until the end of the current turn**. The last bar breaking leaves the token Taken Out at 0 HP; healing revives it. Max HP and bar count are set here, per placed token.

### Initiative and rounds
- **Start Combat** (GM-only, in Simple Combat or Combat): a dialog lists every fighter in the fight in a middle column, each as "Name ×N", where N is its HP bar count. Arrow buttons send each fighter to the **Allies** (left) or **Enemies** (right) column. The GM then picks which side starts and which character opens.
- **The order** (the GM's own design, decided over the book's side-slot meter):
  - Each HP bar is one turn per round.
  - After the GM's opener, the rest of round 1 is filled at random, alternating ally and enemy turns one-for-one for as long as both sides have turns left. Leftover turns of the bigger side follow.
  - Wherever there's a choice, the same character is never placed in two adjacent slots.
  - **The order is rolled once, at Start Combat (decided, revised in play feedback 5).** Every later round repeats it; the GM may drag entries on the rail anywhere, alternation or not. (Was: every new round re-rolled the order, opening with the side opposite the last turn.)
  - Randomisation is not a dice roll and never posts to chat.
- **Initiative rail:** a vertical, auto-scrolling list on the right: portrait in a rectangular frame, then the name; the current turn is highlighted. The GM advances turns. Advancing fires End-of-turn reminders, then Start-of-turn ones, and round reminders at round boundaries.
- This order logic is the system's one piece of real algorithm. It's built first as a pure module with unit tests (alternation, the uneven tail, no adjacent repeats, the opposite-side opener).

### Delivery phases (each one commit to `main`, deploy and playtest)
1. **Foundations — implemented.** Schema, the Unique token catalog, the Combat tab (token image, Unique picks, Reminders) on characters and Temp NPCs, and the pure initiative module with unit tests. Details under **Phase 1 as built** below.
2. **The toggle and Simple Combat — implemented.** Scene/Simple/Combat state per Scene, the lane overlay, miniatures, drag and snap. Details under **Phase 2 as built** below.
2b. **Stances — implemented** (data, editor, stance-bound Reminders; see **Stances as built** below). The turn-start roll and pick dialog arrive with Phase 5, the token-panel switch with Phase 4.
2c. **Multi-lane Simple Combat — implemented** (added after scoping). A GM setting in Settings, **1 to 3 lanes** of ten (up to 3×10), for the whole table — not per browser, because lane positions are shared. Each lane count has its own pre-tuned look rather than one tilt stretched taller. Details under **Multi-lane as built** below.
3. **Combat map — implemented.** Combat Background, the grid with its controls, placing and moving tokens, multiple copies. Details under **Phase 3 as built** below.
4. **Token panel — implemented.** Panic tokens with badges, Challenge with particles, the HP bar stack with break and Dizzy, on both modes. Details under **Phase 4 as built** below.
5. **Fights — implemented.** The Start Combat dialog, the initiative rail, rounds and turns, the turn-start Stance roll or pick, Reminders and the automatic End Phase reminders in chat. Details under **Phase 5 as built** below. The same commit added the **quick spend** (Phase 4) and **map zoom** (Phase 3).

### Phase 1 as built
- **One catalog, two consumers.** `client/src/lib/panicTokens.js` is plain data (`BASIC_TOKENS`, `STATUS_TOKENS`, `UNIQUE_TOKENS`, `TOKEN_CAP = 9`, `tokensFor`, `normalizeUniqueKeys`), imported by the client and by the server alike (the repo is one ESM package), so the two ends can't disagree about which keys exist. Icons are separate (`client/src/lib/panicIcons.jsx`, game-icons.net via `react-icons/gi`, CC BY 3.0 — the credit line is shown under the Combat tab). Colours: Basic sky, Status orange, Unique violet, Super amber. Adding a Unique token is one catalog entry plus one icon.
- **`client/src/lib/initiative.js`** — `buildRound({ allies, enemies, firstSide, openerId, rng })` → `[{ side, id }]` and `nextFirstSide(order)`. Pure, also shared. Choosing a slot: never whoever took the slot just before (if anyone else can), preferably not whoever took that side's previous slot, then someone with the most turns left (the greedy rule that keeps a 3-bar boss's tail from going back to back), random among ties. Pinned by `server/test/initiative.test.js` with a seeded rng.
- **Tables:** `combat_profiles` (one per Character or Temp NPC, created on first save: the token picture with its crop, and `unique_tokens` as a JSON array) and `combat_reminders` (`scope` self/others/round, `timing` start/end, `target` any/allies/enemies/one with `target_character_id`/`target_temp_npc_id`, `text` ≤500, at most 60 per fighter). The token picture is image kind `combat-token`.
- **Server:** `server/combatSetup.js` (kept out of index.js). Events `combat_profile:update` (any of: `imageData`+crop, `clearImage`, `uniqueTokens`; absent fields untouched) → `combat_profile:updated { ownerType, ownerId, profile }`; `combat_reminder:create|update|delete` → `combat_reminders:updated { ownerType, ownerId, reminders }`. Reads `GET /api/combat-setup?ownerType&ownerId` → `{ profile, reminders }` and `GET /api/combat-profiles` → every profile keyed `character:<id>`/`temp_npc:<id>`. Write access is the Scene Pictures rule: GM always, a Player for their own character, Temp NPCs GM-only. Deleting a fighter deletes their profile and reminders; reminders elsewhere that **named** them fall back to "Anyone" with their text kept.
- **UI:** the sheet's **Combat** tab sits second, after Counters. The Temp NPC editor gains a Scene Pictures / Combat switch (widening while on Combat). The tab shows the round token (crop previewed at 48/64/96px), the always-present Basic and Status tokens as chips, the eight Unique tokens as checkbox cards (source and one-line rule), three Reminder columns with Start/End badges, target chips, inline edit and delete, and a collapsed list of the four automatic reminders.

### Phase 2 as built
- **`scenes.combat_mode`** ('scene' | 'simple' | 'combat', default 'scene') rides `activeScene` in every stage payload. `scene:set_mode { mode }` (GM only) sets it on the active Scene. `SceneModeToggle.jsx` sits top-centre for the GM only and hides with the interface.
- **`client/src/lib/simpleLane.js`** (pure, shared, tested in `server/test/simpleLane.test.js`): `LANE_SLOTS = 10`, `TRAY = -1`, `packLane`, `moveOnLane`, `laneGeometry(w, h, inset)`, `slotAtX`.
- **`scene_summons.lane_slot`** — NULL until someone moves a miniature. `buildStagePayload` packs every summon (hidden ones included, before the per-viewer redaction) in summon order: explicit spaces kept, the rest filling free spaces from the left, beyond ten → the tray. `lane:move { summonId, slot }` saves the whole lane at once (so nobody shifts), swaps an occupied target's occupant into the mover's old space, and uses the figure-drag ownership rule; `slot: null` sends a fighter to the tray (GM only, stored as `-1` so it isn't packed back on by itself).
- **`SimpleCombatLane.jsx`**: a trapezoid whose top edge is 83% of its bottom edge, centred at 5/7 of the stage height. It glows in the backdrop's most prominent colour (`client/src/lib/dominantColor.js`: hue buckets weighted by saturation and brightness, soft-white fallback), with white lines over a black outline. Miniatures are the summon's Scene Picture at 80% of a space's width, fading out over the bottom 38%, on an SVG plinth. Drag past a 5px threshold, snap to the space's centre, yellow highlight under the pointer; a click that isn't a drag is reserved for the token panel. A "Waiting" tray below the lane holds overflow (dropping there is GM-only). For the GM the lane fits between the two w-64 drawers; positions are spaces, so GM and Player agree even at different widths. Hidden fighters are ghosted for the GM; to a Player their space looks empty. z-index 5: above the figures, under the drawers.

### Stances as built (2b)
- **`client/src/lib/stanceDice.js`** (pure, shared, tested in `server/test/stanceDice.test.js`): a slot is `{ die: 4|6|8|10|12 }` or `{ fixed: 0..12 }`; `normalizeDice` accepts 1-8 valid slots or rejects the whole pool; `rollStance(dice, rng)` → `[{ die, result } | { fixed, result }]` in slot order; `describeDice` → "d10 d6 d6 5".
- **`combat_stances`** (`character_id | temp_npc_id, name ≤60, dice JSON`, at most 20 per fighter; listed by id, so the **first is the default** active stance) and **`combat_reminders.stance_id`** (nullable).
- **Events:** `combat_stance:create { ownerType, ownerId, name, dice }`, `combat_stance:update { stanceId, name?, dice? }`, `combat_stance:delete { stanceId }` → `combat_stances:updated { ownerType, ownerId, stances }`. Same write rule as the rest of the Combat tab. `combat_reminder:create|update` take an optional `stanceId` (null = any stance), which must be one of the reminder owner's own stances. Deleting a stance **unbinds** its reminders rather than deleting them. `GET /api/combat-setup` now also returns `stances`.
- **UI:** a Stances section between Tokens and Reminders. Each stance shows its name, a "default" tag on the first, and its dice as die-shape icons with fixed numbers in amber boxes. The editor has a name field and per-slot selects (d4-d12 or Fixed, plus a 0-12 number), with + Die and ✕ within 1-8. The Reminder form gains an "Any stance / <stance>" select, and a bound reminder shows a violet chip with the stance's name.

### Phase 3 as built
- **`client/src/lib/combatGrid.js`** (pure, shared, tested in `server/test/combatGrid.test.js`): `normalizeGrid` (size 8-400, offsets ±400, opacity 0-1; default 70/0/0/0.6), `innerRect` (10% padding), `gridLines` (lines every square from the offset, framed by the padding edges and stopping there), `cellAt`/`cellCenter`/`cellRect`, `cellInside` (a cell holds a token when its centre is inside the padding), `fitImage` (contain, centred between drawers), `moveToken` (move or swap).
- **Scenes:** `combat_image_data/mime/hash` (image kind `scene-combat`, sent as `combat_image_url` — `shapeScene` strips the bytes) and `grid_size`, `grid_offset_x`, `grid_offset_y`, `grid_opacity`. A copied Scene carries its grid and its map picture (copied as bytes). The map is processed like a backdrop (`fileToSceneBackground`), so "pixels" are the stored picture's.
- **`combatants`** — one placed copy of a fighter on a Scene: `scene_id, mode ('simple'|'combat'), summon_id, character_id | temp_npc_id, grid_col, grid_row`. Phase 4 hangs HP, tokens and the Challenge off it. Deleting a character, a Temp NPC or a Scene removes its rows.
- **Server:** `server/combatMap.js`. `scene:set_grid` (GM; writes only the fields it names, so quick ±1 clicks can't overwrite each other), `scene:set_combat_image { imageData, imageMimeType } | { clear }` (GM), `combat_token:place { ownerType, ownerId, col, row }`, `combat_token:move { combatantId, col, row }` (swaps), `combat_token:remove`, `combat_token:clear` (GM). Moving and removing follow the figure rule: GM anything, a Player their own character. **Placing is the GM's alone (decided, batch 3):** a Player never places a token, not even their own. The stage payload gains `activeScene.combat_image_url`, `activeScene.grid` and `combatTokens` (`[{ id, owner_type, owner_id, name, col, row, image_url, crop }]` — the combat token picture when there is one, else the portrait).
- **Client:** `CombatMap.jsx` (the fitted map, an SVG grid of black-under-white lines at the chosen opacity, round tokens with a ring and shadow, drag with a 5px threshold, a yellow highlight on the target square, a hover ✕ to remove, click reserved for the token panel), `CombatDrawers.jsx` (`CombatFightersDrawer` with search, `CombatMapDrawer` with upload/replace/remove, ±1 steppers and typed values for size and offsets, an opacity slider and Clear the map; the Player dock was removed in batch 3), and `client/src/lib/combatDrag.js` (a small pub/sub so a drawer entry can be dragged onto the map).

### Multi-lane as built (2c)
- **`table_settings`** — a singleton (`id = 1`) of table-wide GM settings: `simple_lanes` (1-3, default 1). `GET /api/table-settings` → `{ simpleLanes }`; `table_settings:set { simpleLanes }` (GM) → `table_settings:updated` plus a stage update. Every stage payload carries `simpleLanes`.
- **Spaces:** lane L, column C is space `L * 10 + C`; lane 0 is the **front** lane, filled first. `packLane(summons, lanes)` treats a stored space beyond the current count as unset, so turning lanes down repacks those fighters onto the lanes that remain (overflow → Waiting tray). `lane:move` accepts spaces below `lanes * 10`.
- **`LANE_PRESETS`** in `simpleLane.js` — one hand-tuned shape per count: back edge as a share of the front (0.83 / 0.80 / 0.77, a flatter tilt as lanes are added), total depth as a share of the front width (0.062 / 0.105 / 0.14, growing less than linearly), lane thickness front→back (1 / 1, 0.86 / 1, 0.87, 0.76), and the front width (100% / 97% / 94%). The board stays centred at 5/7. `slotAt(geometry, x, y)` picks the lane by height, then the column; `laneLinesPath` draws the outline, the lines between lanes and the straight column dividers. Miniatures scale with their space (back lanes smaller), and nearer lanes stand in front.
- **Settings:** a GM-only **Simple Combat Lanes** section (1 × 10 / 2 × 10 / 3 × 10), live for everyone.

### Phase 4 as built
- **`client/src/lib/hpBars.js`** (pure, shared, tested in `server/test/hpBars.test.js`): `{ max (1-99 | null), current, bars, broken, dizzy }`. `applyHpDelta` (no carry-over; 0 with a bar left → break, next bar full, Dizzy; last bar stops at 0 = Taken Out; healing revives, never above Max, never repairs), `setHp` (setting Max the first time fills the bar), `addBar` (the golden +), `removeBar` (only a back bar), `barsLeft`, `isTakenOut`.
- **`combatants` gains** `tokens` (JSON counts, capped at 9), `challenge_id` (another combatant in the same Scene **and** mode), `hp_max`, `hp_current`, `hp_bars`, `hp_broken`, `dizzy` and `active_stance_id`. A Simple Combat fighter's row (`mode 'simple'`, keyed by `summon_id`, unique) is created on its first change, so the two fights stay separate.
- **Server:** `server/combatState.js`. Events name a fighter by ref `{ combatantId }` (map) or `{ summonId }` (lane): `fighter:token { ref, key, delta | clear }`, `fighter:challenge { ref, target: ref | null }`, `fighter:hp { ref, delta }`, `fighter:set_hp { ref, max?, current? }`, `fighter:add_bar`, `fighter:remove_bar`, `fighter:clear_dizzy` (until turns end Dizzy by themselves in Phase 5), and `fighter:set_stance { ref, stanceId }` (own stances only). Write rule as for figures. **Every fighter and map write runs through one server-wide queue**, because each is read-change-write and quick clicks on "+" would otherwise both read 3 and both write 4. Removing a token frees any Challenge naming it.
- **Payload:** each `combatTokens[]` entry and each summon carries `fight: { combatant_id, tokens, challenge_id, hp, active_stance_id }`, and the stage carries `fighterSetup` — `{ "character:<id>": { unique_tokens, stances: [{ id, name }] } }`.
- **Client:** `FighterOverlay.jsx`, shared by both views. Held tokens show above the fighter, each with a red count badge filling the icon's bottom-right quarter, plus the Challenger's portrait, half-transparent with a red ring. A compact HP stack sits underneath, with "×N" when there are back bars. The Dizzy icon floats over the fighter, a skull marks Taken Out, and, **only during the turn of the fighter holding a Challenge**, a target lock on their Challenger (see "Challenge target lock" below; it replaced the earlier faint sparks). The open panel shows the whole token row (icons at least 28px), with the opened icon's name above it and + / − / −− below; the Challenge picker; the HP bar with − and + at its ends, a shatter-and-slide animation when a bar breaks, the golden +, "−bar" and Max; Clear Dizzy; and the Stance select. Clicking elsewhere closes it, and a drag closes it before moving. While a panel is open its view is raised above the drawers; the map's root is click-through, so the drawers stay usable.

### Phase 5 as built
- **`client/src/lib/fightFlow.js`** (pure, tested in `server/test/fightFlow.test.js`): `remindersToFire({ moment, active, fighters, remindersByOwner, defaultStanceByOwner })`. Reminders belong to an owner, so each fires at most once per moment, however many copies that owner has. `self` fires on the owner's own turn. `others` fires on another owner's turn — a copy's turn is not "someone else's" to another copy of the same owner — filtered by any / allies / enemies / one. `round` fires once per owner in the fight. A stance-bound reminder needs that stance active on the relevant copy, or on the owner's first stance when none is chosen. `automaticReminders({ active, fighters })` gives Burning, Speed (everyone holding it), Fatigue and Challenge (naming the Challenger).
- **`fights`** — one per Scene per mode (`UNIQUE(scene_id, mode)`): `allies`/`enemies` (combatant ids), `round`, `turn_order` ([{ side, id }]), `turn_index`, `pending_stance_combatant`.
- **Server:** `server/fights.js`, its writes on the same queue as the fighter writes.
  - `fight:start { mode, allies, enemies, firstSide, opener }` (GM; refs, so Simple Combat summons get their combatant rows here).
  - `fight:end { mode, outcome }` (GM, decided): the rail's ✕ opens an **End Combat** dialog: Allies won, Enemies won, Skip (no XP: the fight ended mechanically but the story goes on), or Cancel. On a win, every character on the winning side gets **Victory XP (+2)** and every one on the losing side **Defeat XP (+1)**, once per character, on builds with an XP track (hero types; Warriors have none). Each award is logged on the build with the Scene's name (`addXp` in `server/builds.js`), broadcast as `build:updated`, and summed up in a chat line that also flags who can level up.
  - `fight:previous { mode }` (GM, decided): steps the marker back one valid turn, and from a round's first turn back into the last round (its order is kept in `fights.prev_turn_order`, saved when a round is re-rolled). It only moves the marker: nothing rolls or triggers again, and tokens and HP stay. It broadcasts `fight:turn_ended` for the turn being left. The rail's **‹** button, left of Next turn; it is disabled on round 1's first turn.
  - `fight:next { mode }` (GM): End reminders, then the automatic ones, Dizzy cleared for the whole fight, the next valid turn (removed fighters are skipped), and at the round's end Round End, a re-roll opened by the other side, a "— Round N —" line and Round Start. Then the new turn: one stance rolls at once, several set `pending_stance_combatant` and wait, and only after that do the Start reminders fire.
  - `fight:choose_stance { mode, stanceId }`: the fighter's player or the GM.
  - `fight:set_sides` (GM, from the next round).
  - `fight:reorder { mode, from, to }` (GM, play feedback 5): moves one entry of the order; the current turn can't be moved and stays the current turn.
  - `fight:end` (GM; HP, tokens and positions stay).
  - **Turns per round = every HP bar the fighter has, broken ones included (decided, revised: the book's rule, p.60-61).** "Even after some of the Boss's health bars are lost, they will still take 4 Turns each Round, to keep the fight even." So breaking a bar no longer costs a turn next round. A Taken Out fighter's turns still come up (Heroic Spirit lets them donate a turn). Only adding or removing a bar changes the count. `turnsPerRound` in `hpBars.js`. (It used to count only unbroken bars; that was the earlier default, now replaced.)
- **Chat:** `chat_log.kind` gains `'reminder'` and `'stance_roll'` (the CHECK is rebuilt by `migrateChatLogKind`). `postCard(kind, payload)` stores the card's whole content in `payload` and broadcasts `chat:card`; `GET /api/chat` returns `payload` for those kinds. A **Reminder** box is violet, an automatic **Rule reminder** orange; each has a title ("Start of Aya's turn", "End of round 2") and the fighters it concerns with their tokens. A **Stance roll** box is blue, with each die (or fixed number) in its own tile.
- **Client:** `FightControls.jsx`.
  - `StartCombatButton` (GM, top centre, when this mode has no fight).
  - `FightSetupDialog`: Allies / Fighters / Enemies columns with arrow buttons, "Name ×N" turn counts, the side that starts, and the opener; reused as **Change sides**.
  - `InitiativeRail`: top-left (see the mobile follow-ups below), right of the GM's left drawer. It shows "Round N", side dots, portraits in rectangular frames and names; the current turn is outlined and scrolled into view, past turns are dimmed, and "stance…" shows while a pick is pending. GM controls: Previous turn (‹), Next turn, Change sides, End Combat.
  - `StancePrompt`: a dialog for the fighter's player and the GM. It still shows in cinematic mode, while the rest of the rail hides with the interface.
- Fight cards count towards the mobile Chat unread badge.

### Cinematic Weight as built — the "Preset Narrative Combat Weight" GM tool
The book's **Cinematic Weight** (p.38-40) sets how big a fight is. The GM picks a weight per fight, and each fighter gets a level and a level table:

| Weight | HP per bar | Heal Value | Bleed Value | Super Moves per side per round |
|---|---|---|---|---|
| Featherweight | 10 | 1 | 2 | 0 |
| Lightweight | 15 | 2 | 3 | 1 |
| Middleweight | 20 | 2 | 4 | 1 |
| Heavyweight | 25 | 3 | 5 | 1 |
| Worldweight | 30 | 3 | 6 | 2 |

- **Level bonus HP (decided: the book's tables, chosen per fighter), added to EVERY bar as the book says.** Hero table (Focused/Fused/Frantic), levels 1-10: 0,1,2,3,4,6,7,8,9,10. Warrior table: 0,2,3,5,7,8,10,12,13,15. The tool defaults PCs to Hero and NPCs / Temp NPCs to Warrior.
- **Bonus Die (decided: rolled with the stance).** From level 2 a fighter adds d4 (Lv 2-3), d6 (4-5), d8 (6-7), d10 (8-9) or d12 (10) to the turn-start Stance roll. Its tile is labelled "bonus dN".
- **The tool** (`CombatWeightTool.jsx`, the first GM Tools entry; the GM Tools sheet now sits at z 1100, above the Scene page's z-1000 controls such as Start Combat). It works only on `/scene` while the active Scene is in Simple Combat or Combat, and applies to **that mode's fight**. It offers the five weights, an "All at level" shortcut, and per fighter a Hero/Warrior toggle and a level, with the resulting HP shown. **Apply** sets `scenes.simple_weight` / `scenes.combat_weight` and resets every fighter in that fight to **one full bar** of weight HP + level bonus (broken bars, Dizzy and the Bleed mark cleared). Fighters added later keep the manual HP controls.
- **The Bleed zone:** with a weight set, the last Bleed-Value HP of each bar is a purple band on the compact and full HP bars.
- **Bleeding (decided: announced once per round, on crossing).** When damage (`fighter:hp` with a negative delta, or `fighter:set_hp` lowering current) takes a fighter from above the Bleed Value to at or below it, a global Rule reminder card names them ("Mira Bleeds (HP 4 ≤ 4) — "When you Bleed" abilities trigger"). `combatants.bled_round` holds the fight round of the last one, so it is not repeated that round (outside a fight it counts as round 0).
- **Heal button:** the full HP panel gets "Heal +N", healing by the weight's Heal Value (`fighter:heal { ref }`, same write rule as the other HP controls).
- **The weight on the rail (decided):** the initiative rail shows "Middleweight · Heal 2 · Bleed 4".
- **Rules and code:** `client/src/lib/cinematicWeight.js` (tables, `barHp`, `bonusHp`, `bonusDie`, `crossesBleed`), tested in `server/test/cinematicWeight.test.js`. Server: `fight:preset_weight { mode, weight, fighters: [{ ref, level, kind }] }` (GM only, active Scene) and `fighter:heal` in `server/combatState.js`. The bonus die is added in `server/fights.js`. The stage payload carries `activeScene.weights { simple, combat }`, and each fighter's state has `level` and `kind`. Playtest: `scripts/playtest-combat-weight.mjs`.
- **Not tracked (the user's choice):** the per-weight Super Move limit, the character-type **Bleed Ability** at the start of a turn while Bleeding, and the book's Complications (Guest Heroes, Uneven Fights, Stooges sharing a bar).

### Temp NPCs out of combat (decided, new)
The GM will never use Temp NPCs in combat, so they take **no part in it anywhere**. They remain Scene figures (Scene Pictures, summons, folders), and nothing else changes for them on the Scene.
- **Gone for them:** the Combat section of the Temp NPC editor; the Temp NPCs list in the GM's Fighters drawer; Reminder targets; map tokens (`combat_token:place` refuses them); lane miniatures (they never take a lane space or appear in the Waiting tray, and `lane:move` refuses them); fight state (`resolveRef` refuses them); fights and the Combat Weight tool. Combat setup writes for a Temp NPC owner are refused, and so is a Reminder naming one.
- **Existing data:** at every boot, `purgeTempNpcCombat` deletes any Temp NPC combat data left from before: their combatants (freeing Challenges naming them), Combat setup and Reminders, and resets Reminders that named one to "Anyone". It is idempotent.
- Earlier sections that mention Temp NPCs in combat describe the history; this decision supersedes them. NPC **characters** are the way to bring enemies into a fight.

### Armor sources (decided, new)
On a character's **Combat tab**, the Armor chip opens **Armor sources**: lasting Armor the fighter always has, any number up to 9. Each source is **Always** or **in one Stance** of theirs.
- In a fight, every source whose condition holds (Always, or the token's current Stance) adds **1 Armor** to the token row, on top of Armor added by hand. The open token's label shows "(N from Armor sources, M added)". The +/− buttons change only the hand-added part.
- Stored on the profile as `combat_profiles.armor_sources` (JSON `['always' | stanceId]`), set with `combat_profile:update { armorSources }`, which keeps only the owner's own Stances. Deleting a Stance drops the sources bound to it. The stage payload's `fighterSetup` carries `armor_sources`.
- Pure rules: `normalizeArmorSources`, `innateArmor` in `panicTokens.js`, tested in `server/test/armorSources.test.js`.
- **Fix that came with it:** Combat-setup changes (profile, Stances) now also refresh the Scene (`stage:updated`), so a token row shows new Unique tokens, Armor sources or Stance names at once instead of on the next unrelated update.

### Challenge target lock (decided, new)
The Challenge's on-board reminder is now a **target lock**, shown **only during the turn of the fighter holding the Challenge**. It pops the moment their turn starts, reminding them who they must target, and is gone otherwise. A red reticle locks onto the Challenger: an outer ring of four turning segments, an inner ring with four ticks pulsing, and a red glow. An arrow runs from the holder to it, its dashes flowing toward the target. It is one small SVG (`ChallengeLock` in `FighterOverlay.jsx`), animated only by CSS transforms and a dash offset (`challenge-lock-*` in `index.css`, still under reduced motion), and only mounted while it is showing. The views get `activeCombatantId` (the current turn's combatant) from `ScenePage`. It replaced the faint drifting sparks.

### Token notes — removed (decided)
Token notes (two per token per Stance) and their presets on the character sheet were built, then **removed at the user's request as unnecessary and disruptive**. Nothing in the app reads or writes them any more. Databases that ran that version keep two unused leftovers: `combatants.notes` and `combat_stances.note_left/note_right`. They are harmless, like `chat_log.move_id`. The GM's own **Scene Notes** are a separate feature and stay. One part was kept as a general fix: un-summoning a miniature deletes its Simple Combat fight row (`dropSummonFightState`), freeing any Challenge naming it, instead of leaving it orphaned.

### Map tiles — implemented (decided, new)
Special squares from the book's **Obstacles** (p.70-72) and the Battle Parameters, placed on the Combat map (a grid cell) or a Simple Combat lane (a lane space). Each mode keeps its own tiles, the way each mode keeps its own fight.
- **The list (decided):**
  - **Obstacles:** Fog, Pit, Pit Trap (a Pit and a Trap in one space), Rubble, Trap, Wall.
  - **Markers:** Danger Zone (Traffic), King Zone (King of the Hill), Control Zone and the Important Thing (Secure the McGuffin).
  - **Not included (the user's choice):** Copies, Stairs and Conveyor Belts.
  - **Deadly Trap (QA pass):** a Trap that deals 3 instead of 1 — placed by the Trickster's Funny Little Box of Pain, also on the palette. Stored as `deadly_trap`.
- **The palette:** a round overlay button at the left of the screen, shown only in Simple Combat and Combat (right of the GM's drawer). It **stays up with the interface hidden (decided)**, so tiles can be placed in cinematic mode. It opens a small vertical list of every tile, each with its look and name.
  - **Drag** one onto a square to place it.
  - **Tap** one for a small window with a brief mechanical description.
  - The GM also gets **Clear all tiles** for this mode.
- **Who (decided, revised in play feedback 5):** everyone, GM and Players, places tiles, as in the book's Free Placement. **Moving and removing: only what you placed** (or what a character you control placed, by hand or through an Action); the GM always may. Destroying a Wall or Rubble is open to everyone. Clearing a whole mode is GM-only. A personal lock button under the palette stops your own drags from moving anything.
- **Stacking (decided: the book's rules, p.72-73, re-checked)** — `client/src/lib/mapTiles.js` (`placeTile`, `removeTile`, `destroyTile`, `mergeInto`, and `STACKING_MATRIX` as data). Every pair is tested in `server/test/mapTiles.test.js`.
  - Fog, Pits and Traps share a space; a Pit and a Trap together display as one **Pit Trap**.
  - **Rubble and Walls are destructive:** placing either clears every other obstacle from the space first, Fog included.
  - **Fog is the only obstacle that may be placed onto Rubble or a Wall**, and it then shares their space. (Fixed: Fog used to replace Rubble, and a Wall used to keep Fog when placed.)
  - A Pit or Trap placed on Rubble replaces it (Fog stays). Placed on a Wall it destroys the Wall into Rubble, and that Rubble destroys it, so the space becomes Rubble.
  - An obstacle placed on itself changes nothing.
  - Destroying a Wall leaves Rubble, which, being placed, clears the space. Destroying Rubble leaves whatever Fog was on it.
  - A moved stack is placed destructive-first and Fog last, so a Fog + Rubble or Fog + Wall arrives intact.
  - Markers share a square with anything (one of each per square), and survive Rubble and Walls. The book's "no obstacles inside a King/Control Zone" is described on the tile but not enforced.
  - The matrix (what a space holds after placing ROW onto COLUMN):

    | Placing ↓ onto → | Fog | Pit | Trap | Rubble | Wall |
    |---|---|---|---|---|---|
    | **Fog** | Fog | Fog + Pit | Fog + Trap | Fog + Rubble | Fog + Wall |
    | **Pit** | Fog + Pit | Pit | Pit Trap | Pit | Rubble |
    | **Trap** | Fog + Trap | Pit Trap | Trap | Trap | Rubble |
    | **Rubble** | Rubble | Rubble | Rubble | Rubble | Rubble |
    | **Wall** | Wall | Wall | Wall | Wall | Wall |
- **Visual stacking (decided, new): up to three effects per square** (a Pit Trap counts as one), each drawn as its own **nested frame**. The first sits at the square's edge, and each next one is shrunk 17% toward the centre (`tileShapes(kind, quad, color, layer)`), so every frame's corner motif stays visible. Each gets its own name line, sized to fit the innermost frame. A square with more than three shows the first three and "+N"; tapping it still lists every tile.
- **Placed tiles (decided):**
  - **Tapping** a square opens the description of each tile on it, with **Remove**. Walls and Rubble also get **Destroy**: a Wall becomes Rubble, and Rubble is gone.
  - **Dragging** a square moves its whole stack onto another square, by the same rules. Dragging it off the map or lane removes it.
  - A token or miniature standing on a square covers it; move it to reach the tile.
- **The look** (`client/src/lib/tileArt.js`):
  - A frame just inside the square, with each tile's motif in the four corners: bricks (Wall), loose rocks (Rubble), spikes (Trap), depth rings (Pit), spikes and rings (Pit Trap), wisps (Fog), hazard stripes (Danger), crowns (King), brackets (Control) and sparkles (Important Thing).
  - Each tile is colour-coded, with its name (or names) in the middle.
  - The art is authored for a unit square and bent into each square's real shape, so on a lane it follows the space's perspective.
  - The layer sits above the grid / lane lines and below every token and miniature.
- **Trap damage — automated (decided, revised twice):** at the end of every turn the turn-trigger engine's End Phase deals 1 damage to everyone on a Trap or Pit Trap (with Bleed and its follow-ons), posted in the End Phase notice. **Since full automation phase C, Armor blocks it automatically** through the damage pipeline; before that, a fighter with Armor got an orange reminder instead. A Shield doesn't stop it (Shields only block Actions and Abilities that target you), so Trap damage goes straight to HP. The reminder below is now only the fallback when the engine isn't running. Was: **Trap reminder (decided, new):** at the end of every turn, a global automatic reminder (orange **Rule reminder**) names every fighter of the fight standing on a Trap or Pit Trap: "everyone standing on a Trap or Pit Trap takes 1 damage". It covers map tokens by grid cell and lane miniatures by lane space. `fightersOnTraps` / `automaticReminders` in `fightFlow.js`; the squares come from `server/fights.js`.
- **Data and events:**
  - Table `map_tiles (scene_id, mode, col, row, kind)`: one row per kind per square. Lane spaces are col = space index, row 0. Cleared with the Scene.
  - The stage payload carries `tiles { simple, combat }`.
  - Events: `map_tile:place { mode, col, row, kind }`, `map_tile:remove`, `map_tile:destroy`, `map_tile:move { mode, from, to | null }`, `map_tile:clear { mode }` (GM). All run through the server-wide write queue and answer with `stage:updated`.
- **Code:** server `server/mapTiles.js`; client `MapTiles.jsx` (`MapTileLayer`, `MapTilePalette`). `combatDrag.js` now has a second channel for tile drags. Playtest: `scripts/playtest-map-tiles.mjs`.

### Playtest follow-ups (mobile) — implemented
- **The initiative rail stays up in cinematic mode**, Next turn included, and it now sits **top-left** under the corner buttons: at the left edge for Players and in cinematic mode, just right of the GM's left drawer otherwise. This keeps it clear of the chat button and cards on the right, and it stops above the bottom-left dock.
- **An open token panel never leaves the screen.** If the row above the fighter or the panel below would cross an edge, both shift by the same distance (vertically, and horizontally on narrow screens), keeping their spacing. They're re-measured as their content changes. While a panel is open its layer sits at z 1001, above the docks and corner controls.
- **Chat on the Scene** (`SceneChat.jsx`; the Scene route has no Chat panel of its own):
  - **Floating cards:** every new entry (message, roll, fight card) appears bottom-right as a card, newer ones pushing older ones up. At most four show, clipped at the top on a short screen. One countdown restarts with every new card, and 6 seconds after the last one they all go.
  - **Automation notices (decided):** a fight card with `notice: true` reports something the app already did. That covers abilities that ran, Trap damage dealt and the Speed discard. It is drawn grey ("Automated · {title}", smaller text) in the chat, and on the Scene it fades on its own after 2.5 s without restarting the shared countdown. Everything that still needs a person keeps its colour: orange rule reminders (including "by hand" abilities and Bleed) and violet reminders. Burning, Fatigue, the Challenge removal and Traps are now done in the End Phase notice (full automation phase C).
  - **Pinned stance roll (decided):** a turn-start Stance roll ignores the countdown. It stays until that fighter's turn ends — the server broadcasts `fight:turn_ended { combatantId }` on Next turn, and `fight:ended` on End Combat — because the player needs those numbers for the whole turn. Stance roll cards carry `combatant_id` for this.
  - **Chat button:** a round button above the GM Tools wrench opens the full Chat as an overlay over the Scene (full screen on a phone, a 20rem column otherwise) and closes it on a second press. It is visible even with the interface hidden.

## Character builder & turn automation (decided, implemented)

The Combat tab's hand-made setup (Stances as name + dice, Unique token picks, Reminders, Armor sources) is **replaced by a real character builder** driven by the user's exported rules content. Characters are created by choosing a hero type, Archetypes, Forms, Styles and so on. The app then derives the Stances and their dice, and runs the simple start- and end-of-turn triggers. **Players still roll their dice**; the dice are pre-configured. Playing Actions stays manual.

### The content (decided)
- **Source:** the user's export of *Panic at the Dojo 2e / PATCH'D UP Beta* (CC-BY-SA 4.0), in three files: `panic-at-the-dojo.content.json` (the catalog), `.schema.json` (JSON Schema 2020-12) and `.import-guide.md` (data model, resolution contract, operation reference). The original Builds and the Focused / Fused / Frantic Bleed abilities are replaced by the user's six Builds. Bleed interactions of Forms, Styles and villain Archetypes stay.
- **What it holds:** 12 Forms (coloured dice: purple / green, fixed numbers, aliases, Skills), 65 Styles (range, Archetype) and 12 Freestyles (replace the Form's green dice and keep its purple ones; one banned Form each). 13 player and 8 villain Archetypes, each with Focused / Fused / Frantic ability variants. 6 Builds, 12 Skills, 183 Actions (10 Basic), 169 Abilities split into event rules, and 34 Super Moves. The advancement tracks for Focused, Fused, Frantic and Warrior (bonus die, bonus HP per bar, grants per level, XP), 12 Features, 7 Warrior's Paths, the NPC types (Warrior, Boss, Stooges) and 7 option-specific token mechanics. Every entity has a stable string `id`; saved characters store ids, never names.
- **It is declarative, not an engine:** effects are trees of `op` nodes, values are `{ ref }` paths or `{ operator, args }` expressions. The app interprets a safe subset with an explicit dispatch table, **never `eval`/`Function`**. Entries marked `requires_ruling` (only The Untouchable, which is unfinished) are shown as text and never automated.
- **In the repo:** the JSON lives in the repo as shared data, so the server and the client read the same file. A unit test validates it against the schema, checks ids are unique and every reference resolves, and pins the counts.

### Decisions (the user's answers)
- **Purge:** the Combat tab loses its Stances, Unique picks, Reminders and Armor sources; **only the token picture stays**. Existing characters' data there is **deleted outright** (no archive).
- **Everyone uses the builder, and nothing is locked:** any character, PC or NPC, may pick any hero type (Focused / Fused / Frantic) or NPC type (Warrior / Boss / Stooges), and any player or villain Archetype. The type's numbers (Stances, HP bars, turns) are defaults.
- **Legality: warn only.** The construction rules (3 Forms, Styles matching the Archetypes, at most one Freestyle and its banned Form, unique picks, counts per hero type) are checked and shown as warnings, never blocking.
- **Advancement: level, grants and XP.** Level 1-10 on the sheet, XP tracked with the book's awards (Victory 2 / Defeat 1) and level-ups prompted at the XP thresholds. A level unlocks its grants (Super Moves, Features, extra Forms for Frantic, Warrior's Path) for the player to pick. Its bonus die and bonus HP per bar feed the fight, and the Combat Weight tool reads the level and hero type from the sheet.
- **Builder UI: step by step, then editable.** A guided first run (hero type → Archetypes → Forms → Styles / Freestyle → Build → Skills), then one overview page where any part can be changed. It shows the derived Stances ("{Style} {Form alias} Stance": dice from the Form, or Freestyle-modified, plus the level's bonus die; range from the Style).
- **Actions and Super Moves: on the character sheet only** (decided), as a read-only reference: what each Stance can do, with costs, Gates and rules text. Not in the combat token panel.
- **Dice: the automatic turn-start roll stays.** The chosen Stance's pre-configured pool (with colours) rolls into chat as now.
- **Token cap stays 9** (Training 4, Shield 8), though the content says 10.
- **Triggers automated** (phase 3):
  - **Self effects** (tokens, Shield, heal, temporary Armor, Action Pool numbers): applied automatically.
  - **Choices** ("you may", "choose one": Song, Mood, Ammo, Weapon): a quick prompt to whoever controls the fighter, then applied. Persistent choices are kept per token for the fight.
  - **Targets** (Challenge, damage, tokens to an enemy or ally): a target picker, then applied. Angel's turn-start Challenge lives here.
  - **Movement and placing** (move, push, teleport, place obstacles) are **not** automated: they become reminder cards with the rule's text.
  - Anything unsupported likewise becomes a reminder card naming the ability.
- **HP changes from triggers are applied** to the HP bars, with a chat card saying what happened; Bleed announcements follow. **A Shield absorbs damage first** (decided, revised; see the Shield entry). Armor and Iron are **not** subtracted automatically: the card reminds the defender.
- **Follow-on triggers: for app-caused events.** When an automated effect Challenges, damages or makes someone Bleed, the matching "after / when" rules run too (Focused Angel's "after you Challenge an enemy, deal 1 and heal 1"). Events from manual play (HP edited by hand) only get reminder cards.
- **Range is computed on the board:**
  - **Map:** square-grid distance on **the diamond grid (decided, revised — was a diagonal counting 1): a diagonal counts 2** (Manhattan, `|dx| + |dy|`), for Ranges and movement alike. This is a house rule: the book's Range rule counts a diagonal as 1 ("diagonal or lateral, a space is a space"); the user chose the diamond, since there is no real diagonal step, only two lateral ones. "Adjacent" means the four lateral neighbours.
  - **Lanes:** a small grid (each lane a row, each space a column), same rule.
  - **Sight:** Walls block a straight line from anywhere in your space to anywhere in the target's. Fog limits targeting enemies in or next to it to Range 1; allies in Fog are fine.
  - Stance range comes from the Style (plus modifiers such as Blaster's).
- **Frantic Heroes** assemble a new Stance each turn (Form, Style and Archetype ability, excluding last turn's) — implemented in phase 4.

### Phases (each one commit to `main`, deploy, playtest)
0. **Content and purge — implemented.** The content, schema and import guide are in `client/src/data/patd/`. The pure index is `client/src/lib/patd/content.js` (`indexContent`, `collectReferences`); the server reads it once via `server/patdContent.js`. `server/test/patdContent.test.js` validates the content with Ajv 2020 (a dev dependency) and checks unique ids, every reference and the counts. **One known source conflict is allowed and awaits the user's ruling:** Brawling Style's *Tough It Out* keeps `sourceCostText: "3+ or 11+"` (not in the schema) beside its structured cost "3+ or 9+". The Combat tab now holds only the token picture. `combat_stance:*` and `combat_reminder:*` are removed, and `combat_profile:update` takes only the picture. `purgeHandmadeCombatSetup` runs at every boot until phase 2: it deletes all hand-made Stances and Reminders, clears Unique picks, Armor sources and tokens' active Stances. With no Stances, a turn starts with no pick and no roll; the automatic reminders still fire. Plan as written:
    Add the content JSON and its schema to the repo, with a shared loader (`client/src/lib/patd/content.js`: index by id, resolve) and the validation test. Delete the Combat tab's Stances, Unique picks, Reminders and Armor sources, their tables' data, events and UI; keep the token picture. Fights fall back to "no Stance" (no automatic roll) until phase 2.
1. **The builder — implemented.**
   - **Pure rules:** `client/src/lib/patd/build.js` (tested in `server/test/patdBuild.test.js`):
     - `buildTypes`: the six hero and NPC types as one open list.
     - `normalizeBuild`: unknown ids dropped, level 1-10, XP, strings trimmed.
     - `deriveStance`: name "{Style} {alias} Stance"; the Form's dice, or with a Freestyle the Form's purple ones plus its own; the level's bonus die; range from the Style plus the Form's `stance.construct` rules (Blaster +1 maximum; Control Form's either/or choice stored per Stance as `constructChoice`).
     - `deriveBuild`: always-on Abilities (the Archetypes' chosen variant, Build, hero type, granted Features, Warrior's Path), always-on Actions (Basic, Archetype, Build, Features), each Stance's Abilities and Actions, option tokens owned, Skills (one per Form, one replacement, the free two-word Skill) and Health Bars.
     - `levelInfo`: bonus die, bonus HP per bar, next XP threshold, whether the XP allows a level-up, and the grants so far.
     - `buildWarnings`: the construction rules as warnings only.
   - **Build fields added in the QA pass:** a Stance's `form2Id` (the Machine's second Form), `greaterFusionId` (Greater Fusion's Archetype that becomes Focused) and `bonusFrantic` (Improved / Greater Frenzy's Archetypes, one each). See "QA pass: everything automated".
   - **Storage:** table `character_builds (character_id, data JSON, updated_at)`; `server/builds.js`. Events `build:save { characterId, build }` (cleaned on the server) and `build:clear`, both for whoever controls the character, broadcast as `build:updated`. `GET /api/characters/:id/build`. Deleted with the character.
   - **UI:** `components/builder/` (`BuildTab`, `BuildSteps`, `BuildParts`) under the token picture on the Combat tab.
     - The first run steps through Type → Archetypes (player and villain, with each one's ability variant and text) → Stances (Form, alias, Style or Freestyle, construct choice, live name, dice and range; Frantic picks Forms and Styles instead) → Build → Skills → Level.
     - The Level step holds level, XP with Victory +2 / Defeat +1, "Level up" when the XP allows it, granted items, Super Moves from the owned Archetypes, Warrior's Path and Boss Health Bars.
     - After that, an overview with each part editable in place, warnings, and the **rules reference**: Abilities, Actions (cost, Gates, text) and Super Moves, always-on ones and per Stance.
   - The content loads on first use as its own ~86KB (gzipped) chunk (`lib/patd/useContent.js`). Playtest: `scripts/playtest-builds.mjs`.
   - Plan as written:
    A `character_builds` row per character: hero/NPC type, Archetypes with their variant, Forms, Styles and Freestyle, Build, Skills (3 from Forms, up to 1 replacement, 1 free two-word), level, XP and grant picks. The step-by-step first run and the overview with warnings. Derived Stances (name, dice with colours, bonus die, range). The read-only Actions / Abilities / Super Moves reference. Pure derivation and legality rules unit-tested.
2. **Fights use the build — implemented.** `server/fighterStances.js` derives each character's build: `stancesOf`, `rollDerived`, and `setupFromDerived` for the stage payload's `fighterSetup`.
   - **Stances:** a derived Stance's id is its key "form.x+style.y". The token's choice lives in `combatants.active_stance_key` (shown as `fight.active_stance_id`); `fighter:set_stance` takes a key, but only one of the build's own.
   - **Turn start:** the pick and the roll use the derived Stances. Their dice keep their colours, and the build level's bonus die is marked `bonus`. The chat card tints the tiles purple, green and amber. The combatant's own level no longer adds a second bonus die.
   - **Fighter setup:** `fighterSetup` per character now holds the build's option tokens (`unique_tokens`), Armor sources (`armorSourcesOf`: unconditional continuous `grant_armor` rules, 'always' or per Stance key), Stance names, level, HP table (hero types: Hero, NPC types: Warrior) and Health Bars.
   - **Combat Weight tool:** it takes level, table and Health Bars from that setup, and `fight:preset_weight` accepts `bars`.
   - **Removed:** the hand-made Reminder firing.
   - Frantic Heroes have no fixed Stances; phase 4 gives them the per-turn pick. Playtest: `scripts/playtest-build-fights.mjs`.
   - Plan as written:
    Derived Stances drive the turn-start pick and roll (die colours shown in the roll card). Option tokens (Chaos, Control, Luck, Mentor, Poltergeist, Training, Rapid Strike) join the token row automatically. Continuous `grant_armor` rules feed Armor (always, or while the granting Stance is active). Level and bonus HP feed the Combat Weight tool. HP bars from the type (Boss 2-5) are a default.
3. **Turn triggers — implemented.**
   - **The interpreter:** `client/src/lib/patd/interpreter.js` (pure; tested in `server/test/patdInterpreter.test.js`).
     - `ruleSupport(rule)` pre-scans a rule: every op, `{ref}` path, selector and limit must be in the supported subset, or the whole rule is left to a reminder card (never half-run). 83 of the content's 123 turn-start / turn-end rules are fully automatic.
     - `runRule(rule, ctx)` walks the op tree with an explicit dispatch table (no `eval`). It covers tokens (gain, discard, distribute, choose), Shield, heal, pay HP, damage, temporary Armor, Challenge, Action Pool numbers, `optional`, `choose_one`, `choose_mode`, conditions, `for_each`, per-fighter fight state and usage limits.
     - Geometry: `gridDistance` (the diamond grid — see Range above), `lineOfSight(a, b, walls)` and `targetable`. Sight is a straight line between the two squares' centres; a Wall square it passes through blocks it, and grazing a Wall's corner does not. Fighters fill one square, so this is the plan's "from anywhere in your space" rule for one-square fighters. Fog around the target (in it or next to it) limits targeting an enemy to Range 1.
   - **The engine:** `server/triggers.js`, `createTriggerEngine({ io, postCard, emitStageUpdated })`, one per server.
     - `server/fights.js` calls `schedule(fight, activeId, 'start')` after the turn-start roll (and after `fight:choose_stance`), and `schedule(…, 'end')` on `fight:next` before the turn ends. It is never awaited, so a prompt waiting on a person never holds the write queue. Each write is queued on its own, and each fight's triggers run one after another on their own chain.
     - **Who listens:** the active fighter's `own_turn` / `allied_turn` / `any_turn` rules, allies' `allied_turn` / `any_turn` rules, enemies' `enemy_turn` / `any_turn` rules. Abilities are the build's always-on ones plus the active Stance's.
     - **The world:** the fight's fighters, their squares (map cell, or lane space as column and lane row), Walls and Fog from `map_tiles`, and the fight's Combat Weight (Heal and Bleed Values; Middleweight when none is set).
     - **Effects:** they write to `combatants` (tokens capped as usual, HP through the bars, Bleed once per round with its card, `challenge_id`). Each ability that did something posts a rule card (`automatic: 'ability'`) saying what happened. An unsupported rule posts "{Ability} — by hand" with its rules text (`automatic: 'ability_manual'`).
     - **A turn's questions belong to that turn (fix, decided):** each prompt says whose turn it is for (`when`: "Start of Bo's turn", shown in amber in the dialog). When the turn ends (Next turn, Previous turn), the ones still open close as declined, with a grey note ("not answered before the turn ended — skipped"). That turn's triggers still running ask nothing more but keep their automatic effects (`turnOver`, turn generations).
       - The bug it fixes: an unanswered prompt held the fight's chain, so every later turn's prompts queued behind it and popped up on later turns. Trickster's steal looked as if it fired "on a random turn".
       - Playtest: `scripts/playtest-trickster.mjs`.
     - **Fight generations (fix):** starting or ending a fight bumps that Scene's trigger generation. Work queued from before is skipped, work already running stops at its next ability, and it opens no new prompts; the fight's chain starts afresh. The bug it fixes: ending a fight while an ability was asking (Cyborg asks once per token amount) let it open its next prompt after the end. That held the Scene's chain until the 10-minute timeout, and the next fight there (Scene ids are reused once deleted) got no triggers. Playtest: `scripts/playtest-fight-reset.mjs`.
     - **Follow-ons:** `self.damage_taken`, `self.bleed`, `self.challenge_given_to_enemy` and `self.tokens_discarded_by_action_or_ability` (Halcyon's Iron) run for app-caused events, up to 3 deep.
     - **"You may" rules:** a rule with `optional: true` asks a Yes / No first (Decoy Style). If it opens by picking something (a token to discard, a token to take), the pick itself offers "Don't discard" / "Skip" instead, and with nothing to pick it is skipped without asking.
     - **Multi-picks:** a `choose` with a maximum above 1 (Trickster's steal and / or convert) shows check-box buttons: a ✓ and a highlighted border on each pick, plus "N selected".
     - **Trickster (decided: automated):** `select_token` (a non-Unique token, so Power, Iron, Speed or a Status token, held by someone else in Stance range; Copies aren't tracked, so "you or your Copies" is your own range), then `steal_tokens` and / or `convert_tokens` (to Iron), picked together in one multi-choice. Stealing then converting turns the stolen token into Iron.
     - **The End Phase, automated (decided):** after the turn's end abilities, Trap damage (see the Trap note above), then everyone discards 3 Speed, or all if fewer. A continuous `end_phase.speed_discard` 0 (Shadow Form, Silent Freestyle) keeps all of it, and `end_phase.speed_discard_floor` (Scrambling Style: 2) never goes below that. The Speed and Trap reminders are no longer posted. (Phase C of full automation adds Burning, the Challenge removal and the Fatigue discard, all in one End Phase notice.)
   - **Prompts:** server → client `trigger:prompt { id, characterId, combatantId, fighterName, kind: 'confirm'|'choose'|'targets', title, text, options: [{id, label}], minimum, maximum }`, sent to the GM and whoever controls the fighter.
     - Client → server `trigger:answer { id, answer }` (true / false, an option id, or a list of ids). The first allowed answer wins, and `trigger:resolved { id }` closes it everywhere.
     - Open prompts are re-sent on `identity:set` (a reconnect). They time out after 10 minutes. `fight:end` closes that fight's prompts and forgets its fight state.
     - The dialog is `TriggerPrompts` in `FightControls.jsx`, shown on the Scene one prompt at a time.
   - Playtest: `scripts/playtest-turn-triggers.mjs`. It covers Wild Form, Aura Style, Fused Phantom and Fused Demon running on their own, the Fused Angel heal-and-Challenge prompts answered by its player, Heroic Style healing, and a reconnect and fight end with a prompt open.
   - Plan as written:
    A pure interpreter (`client/src/lib/patd/interpreter.js`) for `own_turn.start` / `own_turn.end_abilities` rules (plus `allied_turn` / `any_turn` starts where simple), with the operation subset above. Prompts for choices and targets go to the fighter's controller (like the Stance prompt). Board range and sight checks come from `combatGrid` / `simpleLane` geometry plus map tiles. Follow-on events (`self.challenge_given_to_enemy`, `self.bleed`, `self.damage_taken`, ...) run when an automated effect caused them. Reminder cards cover the rest. Heavily unit-tested against the content's own rules.
4. **Frantic and NPC types — implemented.**
   - **Frantic Heroes (Frantic Versatility):**
     - `deriveBuild` splits the Frantic-variant Archetype abilities out of the always-on ones into `franticAbilityIds`. Only the one picked this turn is active. Fused abilities granted later stay constant. The sheet's rules reference lists them as "Frantic Abilities (one each turn)".
     - At each of their turns the fight waits on a pick. `pending_stance.assemble` is `{ forms, styles, abilities }` (from `franticOptions`), each `[{ id, name, used }]`, where `used` marks last turn's part.
     - The player (or GM) answers `fight:choose_stance { mode, stanceId: "form.x+style.y", abilityId }`. The server refuses a pick that repeats last turn's Form, Style or Ability (`franticPickAllowed`). A part with nothing else left is offered again, so a turn can't stall.
     - The pick is stored in `combatants.frantic_pick` (JSON `{ formId, styleId, abilityId }`, cleared when a fight starts). The Stance is derived on the fly (`stanceOfBuild`: any known Form with any known Style, plus the level's bonus die), rolls as usual, and its parts' rules and the picked Frantic Ability run as turn triggers.
     - The fighter setup lists every Form + Style pair's name (and `assembles: true`), so the token panel names whatever was picked.
     - The dialog is `FranticPick` in `FightControls.jsx`: three rows of buttons, last turn's struck through.
   - **Warriors:** a new op `trigger_warrior_path` runs the build's Warrior's Path rules as the follow-on event `warrior_path.trigger`.
     - Improved Warrior (level 3): its rule is text only in the content, so the engine matches it by id. At **Start Combat** (`triggers.startFight`, before the first turn) it gives the Path's benefit.
     - Greater Warrior (level 7) also triggers the Path at each turn start, through its own rule.
     - Paths that move (Badger) become by-hand cards like any movement.
   - **Bosses:** several Stances (the turn-start pick), Health Bars from the build, and a turn per Health Bar. All of this was already in place from phase 2 and `turnsPerRound`; the playtest pins it.
   - **Stooges (decided default; the user may revise):** a Stooges character's bodies are its token copies.
     - In a fight, all its bodies form **one unit with one turn per round**: only the leading body (the lowest combatant id in the fight) is in the order.
     - They share **one Stance**: the roll sets it on every body.
     - Only the leading body's abilities run as triggers.
     - HP stays per body. A shared Health Bar is not tracked, matching the Cinematic Weight decision not to track "Stooges sharing a bar".
   - Playtest: `scripts/playtest-frantic-npcs.mjs`.
   - Plan as written:
    Frantic per-turn Stance assembly with previous-turn exclusions. Warrior (Warrior's Path triggers), Boss (several Stances and bars) and Stooges (one shared Stance, turn and health bar across several bodies) behaviour in fights.

### XP on the sheet (decided)
- The build keeps `xp` and an `xpLog` of the last 30 changes `{ at, amount, reason }` (`withXp`: never below 0, a no-op change isn't logged).
- The sheet's overview has an **Experience** section for hero builds: the total, a bar to the next level's threshold (amber once a level-up is allowed), −1 / +1 / Victory +2 / Defeat +1 buttons for whoever controls the character, **Level up** when the XP allows, and the recent history. The Level step's Victory / Defeat buttons log too. End Combat adds its awards on its own.

### Rulings (decided)
Small, named patches to the book's content, applied when it is indexed on both server and client (`client/src/lib/patd/rulings.js`, `applyRulings`). The content file stays the user's export, and each ruling's note is added to the Ability's rules text so the sheet shows it.
- **Halcyon Style:** "at the start of your turn, you may discard one token". Ruled: **only a Status token** (Burning, Fatigue, Weakness), never a basic one. With none held it is skipped silently; otherwise a choice of which, or "Don't discard". Its "gain that many Iron" half now runs as a follow-on.

### Action cards and the dice board (decided)
- **Cards like the book's** (`components/actions/ActionCards.jsx`, matched against the PDF):
  - An Action is a dark-green slanted header reading "cost: Name" over a mint-green body with a brighter green right edge. The base effect comes first, then each Gate on its own line with its threshold in bold.
  - A Super Move is a dark card with its mark: Alpha (purple, "α Super") or Delta (teal, "Δ Super").
- **The sheet:** Actions are a section of their own, apart from the Abilities, which are now headed "Active effects".
  - **Basic Actions** (the 10, collapsed by default) and **Personal Actions** (always available, then each Stance's, or each Form and Style for Frantic, then Super Moves) sit side by side with a divider on wide screens and stacked on phones.
- **Opening the board (revised, play feedback 5):** the **Action button** at the bottom of the screen, not the dice on the Stance roll card (those only show the roll now).
- **The turn's dice board** (`components/actions/DiceBoard.jsx`). While a fighter's turn lasts, whoever controls them (or the GM) taps the dice on that turn's Stance roll card, in the chat or the Scene's pinned card, to open it.
  - **Layout (decided, revised):** a full-screen overlay with **no header**. The footer holds the dice (30% smaller than at first), the ✕ (Escape also closes it), and a one-line hint or message. A scrollable list of the Actions this turn can use runs in two columns with a vertical line between them: **Basic** on the left, **Personal** on the right (only the rolled Stance's, plus the always-available ones and Super Moves; decided). The roll's dice sit enlarged along the bottom.
  - **Dragging a die onto an Action** (pointer events, so touch, pen and mouse) crosses the die out and lights the Action in mild green, with **every Gate up to the one its number reaches** (decided, revised: by the rules you get each Gate up to it).
    - `gateFor` gives the top Gate: the highest cost or effect threshold at or below the number. An "X" cost buys its base effect with any number and reaches its effect Gates (Grapple, a 7: base, 4+ and 7+).
    - The card's header shows the die.
  - **Token costs (decided):** tapping an Action with a non-dice cost (no die selected) pays it for real (`client/src/lib/patd/tokenCost.js`).
    - **Checked first:** against the fighter's live tokens, HP, Shield and the enemies holding their Challenge (`GET /api/fighter-state/:combatantId`).
    - **Not enough:** the footer says what it needs.
    - **Exactly one way and nothing to decide:** paid at once.
    - **Otherwise:** a full-screen dialog shows only the affordable options and, for the one picked, only its own questions: which Basic tokens (steppers for the kinds held), how much HP for an X cost, or whose Challenge. It is never a fixed matrix.
    - **Paid:** the card lights with every Gate up to what the payment counts as (its rating), including the cost Gates ("5 Iron: …", "4 Basic Tokens: …"), and its header shows "✓ 1 Iron + 1 Speed". A notice reports it in the chat.
    - **Tapping a paid Action again undoes the payment in full:** tokens and Shield come back, and HP is restored exactly (a bar the cost broke comes back too) if nothing changed it since, otherwise the HP is given back. A Challenge returns to its holder.
    - A Free Action just lights up. Laying a die on a token-only Action is refused with a note.
  - **Server checks:** `dice:pay { rollId, actionId, option, answers }` / `dice:unpay { rollId, actionId }` are for the fighter's controllers or the GM, while the roll is active. The Action must be one this turn can use: Basic, the rolled Stance's (its key is kept with the marks), or always available. A refused payment answers `dice:pay_failed`. Marks now also carry `pay: { actionId: { option, rating, text, amount } }`.
  - **Tapping (decided, revised):** tapping a die crosses it out and selects it (a ring). Tapping an Action then lays the die on it, the same as dragging. Tapping the selected die again brings it back. Tapping a die that's on an Action takes it off and selects it, to lay elsewhere. Tapping the empty board deselects.
  - **Purely visual:** nothing is paid, spent or resolved.
- **Shared and kept for the turn** (`server/diceMarks.js`, table `dice_marks (roll_id, combatant_id, character_id, dice, data, active, created_at)`, the last 300 rolls).
  - Each Stance roll card now carries `roll_id`, `character_id` and `stance_key`. Its marks `{ used, assign: { dieIndex: { actionId, threshold } } }` are editable while the roll is **active**: from the roll until that fighter's turn ends (Next turn, End Combat). Previous turn makes their latest roll active again.
  - The client sends `dice:mark { rollId, used, assign }` (controllers or GM only, cleaned by `cleanMarks`). Everyone gets `dice:marks { rollId, used, assign, active }`, and `GET /api/dice-marks` returns the recent ones (`lib/diceMarks.js`, `useDiceMarks`).
  - Crossed dice show crossed on the chat card for everyone. Closing and reopening the board shows the same state.

### The sheet's rules reference
- Rules text keeps its line breaks. An Action's or Super Move's **Gates** ("3+: …", and the cost Gates "5 Iron: …") are split from the base effect (`client/src/lib/patd/gates.js`, `splitGates`) and listed one per line with the threshold in amber.

### Open questions to settle in their phase
- Stooges: whether the unit should also share one Health Bar across its bodies (today each body has its own HP; see phase 4).
- Which `modify_rule` passives get visible badges (e.g. "Unblockable by Shields") versus staying in the rules text.
- Super Move round limits, once Actions exist only on the sheet.

## Homebrew builder (decided, implemented)

A GM-only page (`/homebrew`, the flask icon in the header and the mobile menu) for the GM's own **Forms, Styles and Archetypes**. They join the book's content everywhere: the character builder, derived Stances and dice, the fights and the turn triggers.

### Decisions (the user's answers)
- **Abilities: a simple rule editor.** Each Ability has rules text and rules. A rule has a moment (start or end of your turn, an ally's turn, an enemy's turn, every turn, when you Bleed, when you take damage, after you Challenge) and an optional "you may".
  - Its effects: gain tokens, a Shield, heal (a number or the Heal Value), deal damage, pay HP, Challenge, discard tokens (any or Status), temporary Armor, add a number to the Action Pool, or "choose one of" up to 4 of these.
  - **Text notification (decided):** an effect that just posts an orange reminder card in the chat at the rule's moment, like any rule left to people (`op: 'notify'`, `automatic: 'ability_text'`). It shows its own message, or the Ability's rules text when the message is empty, so movement, placing and anything else not automated can still prompt the table at the right time.
  - Each effect is aimed at you, a chosen ally or enemy in Stance range, you and every ally in range, or every enemy in range.
  - These compile to the content's own op trees and **run automatically** like the book's. A "Text only" rule becomes a "by hand" card.
  - An Ability left without rules text gets its rules' summary.
- **Actions: yes**, with a name, a cost text and rules text. They are reference only on the sheet until Claude automates them (see "Commit Homebrew").
- **Visibility: the GM publishes.** New items are drafts, listed only in the GM's builder. "Published" offers them in every player's builder. Unpublishing never breaks a character already using one: drafts still resolve, they are just not listed.
- **Copy from book: yes.** Any book Form, Style or Archetype can start a new item ("{name} (copy)"); the book's entry is untouched.
  - Rules the editor can express become editable steps.
  - Any other rule (conditions, limits, other events) is kept exactly as is and runs as the book's would.

### As built
- **Pure module:** `client/src/lib/patd/homebrew.js` (tested in `server/test/homebrew.test.js`).
  - `cleanHomebrew` validates an item against the book. Form dice are d4-d12 or a fixed 1-12, purple or green, at most 6. A Style's range is 0-12 with the maximum never below the minimum. Counts are capped, and unknown steps and moments are dropped.
  - `compileRule` and `specFromRule` turn editor rules into content rules and back.
  - `itemToContent` gives the catalog entries. Ids are `form.hb-<name>-<4 chars>` (likewise `style.` and `archetype.`); Abilities are `ability.<tail>.a<n>` with rules `….rule-<n>`, Actions `action.<tail>.x<n>`.
  - `mergeHomebrew` adds the items to the book: lists, Abilities, Actions, and a homebrew Style joining its Archetype's `styleIds`.
  - `copyFromBook` and `describeSpec` (the editor's one-line preview).
- **Item fields:** `{ kind, name, descriptionText, published, abilities: [{ uid, name, rulesText, variant?, rules }], actions: [{ uid, name, cost, rulesText }] }`, plus by kind. Each Ability's and Action's `uid` (8 base-36 characters) is its stable id inside the item: kept across renames, edits and reorders, so Claude's automation map is keyed by it (see "Commit Homebrew"):
  - **Form:** `aliases`, `actionDice`, `skillId`.
  - **Style:** `range`, `archetypeId`.
  - **Archetype:** `archetypeKind`. Its Abilities each say which heroes get them: Focused, Fused or Frantic, or always.
- **Storage:** table `homebrew (id, kind, data JSON, published, created_at, updated_at)`; `server/homebrew.js`.
  - Events (GM only): `homebrew:save { item }` creates or updates, and answers `homebrew:saved { id, clientKey }`. `homebrew:publish { id, published }` and `homebrew:delete { id }` complete the set. Each broadcasts `homebrew:updated { items, automation, coreIds }` and a stage update. `homebrew:commit` (ack) is the Commit Homebrew tool.
  - `GET /api/homebrew` returns `{ items, automation, coreIds }`: every item, Claude's automation map and the ids in the committed core.
  - Deleting an item drops it from builds using it (unknown ids are cleaned away).
- **Merging:** the server merges every item into `patdContent()` at boot and after each change (`setHomebrewItems`). `bookContent()` stays the pure book, used for cleaning, copying and the schema test. A content version invalidates the derived-build cache.
  - On the client, `useContent()` merges too (drafts only for the GM, with Claude's automation on top) and stays live over `homebrew:updated`; `useBookContent()`, `useHomebrewState()` and `useHomebrewItems()` are the parts.
  - The builder marks homebrew with ✦ (and "draft"). Homebrew Styles with no listed Archetype are grouped under "Homebrew".
- **UI:** `components/HomebrewPage.jsx`.
  - On the left: new Form / Style / Archetype, Copy from book, and the items with Draft / Published and their wrench (with a legend).
  - On the right, the editor: name, the kind's fields, the dice editor with a live dice row, description, Abilities with their rules and effects, and Actions. Create / Save, Delete (with a confirm) and Close. The header shows the item's wrench and, once Claude automated the item, each Ability and Action shows its own; both follow the working copy as the GM types.
- **A Form's Skill: a book Skill or "Other" (decided).** "Other (write your own)…" asks for a name and what it lets you do. The item stores `customSkill { name, rulesText }`, which becomes a Skill entry `skill.<tail>.s1` in the merged content: listed among the Skills and used as the Form's Skill.
- **Not in homebrew (yet):** Freestyles, Super Moves, Builds, Features, and movement or placing effects (write those as text).
- Playtest: `scripts/playtest-homebrew.mjs`.

## Commit Homebrew (decided, implemented)

The user's request: a GM tool that snapshots all their homebrew into the game's core, so it is visible on GitHub. Then, whenever the user says **"automate homebrew content"**, Claude goes through it and automates it.
- Claude re-automates only what changed; a small wording change gets a small adjustment.
- Every item keeps a smart id, even across a rename or a copy.
- No buffer lingers in the system.
- A wrench by each item shows its state.

### Decisions (the user's answers)
- **Where the core lives: the repo, straight to `main`.** The app commits itself with a GitHub token. Every commit redeploys the app on Render.
- **The pipeline: git history, no buffer** (the user picked this over a buffer file):
  - Each item is its own file, rewritten by every Commit.
  - Claude's automation map records, for each Ability and Action, the fingerprint of the wording it automated and the commit that wording came from.
  - A pass diffs against that exact commit, so no buffer copy of the old text ever exists.
- **What greys the wrench: rules wording only.**
  - For an Ability: its rules text and its rule steps.
  - For an Action: its cost and its rules text.
  - Renames, descriptions, dice and range don't grey it.
- **A changed item keeps its old automation running** (grey wrench) until Claude's next pass. It is never dropped back to "by hand".
- **The baseline for a pass:** the last version Claude automated (that part's `basedOn`).
- **Only published items are committed.** Drafts stay out. An item that is unpublished or deleted leaves the core at the next Commit, and its automation is removed at the next pass.
- **The wrench:**
  - **Blue, filled:** automated.
  - **Grey, filled:** automated, but the wording changed or a part was added since.
  - **Hollow outline:** committed, not automated yet.
  - **No wrench:** never committed.
- **Live edits win.** The `homebrew` table is what the app uses; the committed core is the record and a backup.
- **Smart ids.**
  - An item's id (`form.hb-…`) never changes, including on a rename.
  - A copy is a new item with its own id.
  - Each Ability and Action has a `uid` that survives renames, edits and reorders.
  - A missing or repeated uid gets a new one.
  - Items saved before uids existed get theirs once, at boot.

### As built
- **Pure module:** `client/src/lib/patd/homebrewSync.js`, shared by the server, the client and the script. It provides:
  - **fingerprints:** `abilityFingerprint` and `actionFingerprint`, 16 hex digits of a double FNV-1a over the normalized wording. Whitespace runs don't count. For an Ability the hash also covers the stable JSON of its rule steps.
  - `partsOf(item)` and `partState(part, autoItem)` → `new | stale | automated`.
  - `wrenchState(item, { autoItem, inCore })` → `automated | stale | waiting | none`.
  - `coreFileText` and `parseCoreFile`: a deterministic file, without `published`.
  - `planCommit(items, existing, same)` → add / change / remove.
  - `automationReport(items, automation)`: Claude's to-do list, with leftovers.
- **In the repo (`homebrew/`, see its README):**
  - `homebrew/items/<id>.json`: one file per published item.
  - `homebrew/automation.json`: `{ version: 1, items: { <itemId>: { name, entries: { <uid>: { part, name, fingerprint, basedOn, …automation } } } } }`.
  - The automation for an Ability is `rules`: content rules exactly like the book's, with ids rewritten to the Ability's own.
  - The automation for an Action is any of:
    - `effect`;
    - a structured `cost` (the live cost text always wins);
    - `gates`, `limits`, `conditions`, `timing`.
  - An entry with no automation means "checked: its own rule steps, or nothing, are right".
  - The app writes only `items/`; only Claude writes `automation.json`.
- **Running it:** `itemToContent(item, autoItem)` applies each entry by uid to the live item. It works whatever the part's position or name, and even after the wording changed.
  - An automated Ability, or an Action with an `effect`, is marked `automationState: 'automated'`; homebrew catalog entries also carry their `uid`.
  - The server merges with `homebrewAutomation()`; clients get the same map in the homebrew payload.
- **Server:**
  - `server/homebrewCore.js` reads the core and the map from disk at boot. The `HOMEBREW_DIR` env var can point it elsewhere. After a commit, the core is updated in memory so the wrenches don't wait for the redeploy.
  - `restoreAndMigrateHomebrew()` runs at boot:
    - An **empty** `homebrew` table gets the core's items back (cleaned).
    - Older items get their uids, saved to the table.
  - `server/githubCommit.js` makes one commit with the Git Data API (no clone):
    1. Read the ref, the commit and the `homebrew/items` tree.
    2. Compare git blob shas computed locally, so unchanged files are seen without fetching them.
    3. Create a tree on `base_tree`; removed files get `sha: null`.
    4. Create the commit and fast-forward the ref.
  - If `main` moved meanwhile, it rebuilds on the new head (up to 3 tries). A commit with nothing new is skipped.
  - The commit message lists what was added, changed and removed.
  - Config:
    - `GITHUB_TOKEN`: a fine-grained token with Contents read/write on the repo, set in Render's Environment.
    - `GITHUB_REPO`: default `AprilLiar/Custom-VTT`.
    - `GITHUB_BRANCH`: default `main`.
    - `GITHUB_API_URL`: for the playtest's fake GitHub.
  - `homebrew:commit` (GM, ack) answers one of:
    - `{ ok, sha, url, added, changed, removed, files }`;
    - `{ ok, unchanged }`;
    - `{ error: 'no-token' | 'busy' | 'github' | 'gm-only' }`.
- **The GM tool** (`CommitHomebrewTool.jsx`, GM Tools → Commit Homebrew):
  - Before committing, it lists:
    - how many published items will be in the core;
    - which are new to it;
    - how many leave it;
    - which are grey or waiting for Claude.
  - It warns that committing redeploys the app.
  - The result links to the commit on GitHub.
  - Without a token it says how to add one, and offers **Download snapshot** (`homebrew-snapshot-<date>.json`), which Claude can import.
- **The wrench:** `HomebrewWrench.jsx`, with `WrenchLegend`.
- **Claude's script:** `scripts/homebrew-automation.mjs`.
  - `status` (the default) lists every committed item with its wrench, and each part as new, stale or automated:
    - a new part with its text;
    - a stale part with a **word diff** between its wording at `basedOn` (`git show`) and now;
    - leftovers to prune.
  - `stamp <itemId> [uid… | --all]` records a part's current fingerprint and `basedOn`, the last commit of its file. It refuses a file with uncommitted changes.
  - `prune` removes the automation of deleted items and parts.
  - `import <snapshot.json>` writes a downloaded snapshot into `homebrew/items/`.
- **Tests:**
  - `server/test/homebrewPipeline.test.js` covers:
    - uids;
    - fingerprints;
    - every wrench state;
    - automation by uid after a rename, a reorder and a reword;
    - core files and the commit plan;
    - the commit against `server/test/fakeGithub.js`: skip-when-unchanged, removal and the race retry;
    - the to-do list.
  - The same test checks the **repo's own `homebrew/`**:
    - no leftover automation;
    - every entry is stamped with a real commit;
    - every automated rule passes `ruleSupport`;
    - the census counts every Claude-automated Ability rule and Action as automatic, not by hand.
- **Playtest:** `scripts/playtest-commit-homebrew.mjs` boots its own server on a fresh database, its own core and a fake GitHub. It covers:
  - the restore with automation;
  - uids on save;
  - a commit of the published items only;
  - "unchanged";
  - a player refused;
  - unpublishing removes the file;
  - the boot uid migration;
  - "no token".

### Runbook: "automate homebrew content" (Claude)
1. `git pull` to fetch the app's Commit Homebrew commits, then run `node scripts/homebrew-automation.mjs` for the to-do list.
2. **New parts:** write the automation into `homebrew/automation.json` under the item id and the part's uid.
   - An Ability gets `rules`: book-shaped, using only what `ruleSupport` accepts.
   - An Action gets `effect`, plus a structured `cost` and the rest as needed.
   - If something genuinely needs engine code, add it to the engine like any book mechanic, and say so in the commit.
   - A part that needs nothing still gets an entry, via `stamp --all`.
3. **Stale parts:** read the word diff and adjust only what the change touches. A changed number is a changed number.
4. `stamp <itemId> [uid…]` every part you wrote or checked, then `prune` the leftovers.
5. Run `npm test`. `homebrewPipeline.test.js` refuses unstamped entries, leftovers and automation the engine would run by hand. Then lint, build, commit `homebrew/automation.json` (and any engine code) to `main`, and push.
6. If the user sent a snapshot file instead (no token yet): `import` it, commit the items first (stamps name that commit), then automate.

## Full automation (decided; phases A–J implemented)

**Goal (the user's):** everything in a fight is automated. The only input from people is laying dice and tokens on Actions (the dice board) and answering the choices that pop up. Grounded in the book's combat chapter (PDF pp.56-77: the 8-phase turn, Damage Resolution "WEPIA", Action Resolution, the six movement types, Obstacles, Tokens) and the content's operation reference (`import-guide.md`).

**Where it starts:** 91 of 306 Ability rules run automatically, and no Action or Super Move resolves.
- **Missing operations:** movement (`move` ×51, `push` ×40, `pull` ×32, `teleport` ×22), obstacles (`place_obstacle` ×42), passive modifiers (`modify_rule` ×65 across ~60 keys), durations (`temporary`, `schedule`, `register_trigger`), Action Pool manipulation (rerolls, splits, …), and ~80 event names.

### Decisions (the user's answers)
- **Turns:** whoever controls the active character (the GM for NPCs) ends the turn with **End turn** on the dice board. The engine then runs Late Movement and the End Phase. The GM can still end or step back any turn.
- **Committing dice:** laying a die on an Action (drag or tap) only *places* it.
  - Each placed die shows its **order number** (top-right), and is grey until committed.
  - A **Commit** button in the footer performs every placed Action in the order the dice were placed. Committed dice are crossed out and locked.
  - Committing can be repeated: commit 2 of 4, close, commit the rest later.
  - Only the **GM can retrieve** a committed die (for a player or an NPC). Retrieving **undoes it fully**: each committed Action is snapshotted, and retrieving restores the state from before it. Actions committed after it return to placed (grey) as well.
  - Token-cost and Free Actions are placed the same way (they get an order number) and are paid at Commit.
- **Gates:** a placed die lights every Gate it reaches. **Tapping a lower lit Gate makes the Action stop there**; the default is the highest.
- **Power toggle:** on the footer's left, a toggle shows the Power balance. When on, the placed Actions' hits are Enhanced, up to what the character's Forms and Styles allow per hit (`enhance_hit.additional_uses`, `power_tokens.additional_per_hit`), while Power lasts.
- **Hit spends:** each character has **Ask / Auto / Never** for Power, Iron and Shield (on the sheet's Combat tab). Players default to Ask, NPCs to Auto. The board's Power toggle stands in for "Ask" on your own committed Actions.
- **Free Movement:** a **Move** button lets the active character move before each Action (reachable squares glow with their Speed cost). In the Early and Late Movement phases, everyone else holding Speed gets **Move or Done**. The phase waits for them, the GM can skip, and a phase with no Speed holders passes at once.
- **Reactions → Interrupts (decided, revised):** no reaction windows and no asking after every Action. Each character who can act outside their turn gets an **Interrupt** button. It appears whenever they have something usable right now: a token Action they can pay for whose conditions allow it (the Mentor's on an ally's turn, "only during an enemy's turn" …), or a dice Action a **Chaos token** can pay, i.e. one where a 4 is a valid input. The button opens the Action interface with only those, split like the turn board.
  - The footer shows the resources they can be paid with: held numbers, Chaos, Luck, Speed as Shadow Form allows on others' turns, and so on.
  - Cards are grouped **by resource**, one rectangular cluster per resource, packed into **two columns** without wasted space, clusters sized to their cards; the whole view scrolls.
  - **During a multi-Action Commit**, after each Action the batch **pauses until the active player taps Continue**, but only when someone else has a reaction available.
- **Challenge:** enforced. Damaging Actions must target the Challenger whenever legal; the End Phase removes the Challenge when its holder tried to damage them.
- **Picking (revised):** targets, squares and placements are picked **on the map or lane** (legal ones glow; the dice board steps aside). Squares get **no list**: a slim bar at the **top** of the screen names only what is doing it and how, e.g. "One-Two Form (Move 2)", with Skip when skipping is allowed.
- **Pushes and pulls:** the pusher **taps the landing square**. The engine finds a legal path (each space farther from or closer to the origin, sliding along Walls), and asks which path only when paths cross different Traps or Pits.
- **World of Cardboard: always on.** A push or pull into a Wall smashes it into Rubble; the target enters that space and the movement ends there.
- **Super Moves:** all limits enforced: not in Round 1, once per fight per character, two matching numbers of 3+, and the side's per-round limit from the Cinematic Weight (Feather 0, Light/Middle/Heavy 1, World 2).
- **Simple Combat too:** lanes are a small grid (each lane a row of 10 spaces; the ends are the arena edge) with the same rules.
- **Rulings:** Tough It Out costs **3+ or 9+** (the structured data). Fused Trickster stays **allied turns** as written. Stooges keep HP per body (phase 4).

### Architecture
- **Server-authoritative engine.** The engine grows out of `server/triggers.js` into `server/engine/`. Pure, unit-tested rules live in `client/src/lib/patd/` beside the interpreter: damage, movement, pool, modifiers. The server applies them through the write queue.
- **Fight runtime** (`fights.runtime` JSON), persisted so a restart loses nothing:
  - per fighter: Action Pool, placed and committed dice, turn flags (moved, damaged, start square, Armor triggers used, damage attempted on the Challenger, actions performed), usage counters, temporary modifiers and scheduled effects;
  - per fight: Super Moves used per side and round, and the current phase.
- **Event bus:** one `emit(event, subject, payload)` routes every content event name to the listening rules, by relation (`self.*`, `ally*`, `enemy*`, `*_in_range.*`, `visible_enemy.*`, `any_*`). It replaces today's ad-hoc follow-ons.
- **Modifiers:** a registry answers "which `modify_rule` values apply to this fighter now". Sources: continuous rules of the active Stance and the constant Abilities, installed temporaries with their durations, and the current Action's scope.
- **Snapshots:** before each committed Action, the fight's combatant rows, its map tiles and the runtime are saved, so Retrieve can restore them.
- **Unsupported pieces** never silently vanish: an operation the engine cannot run yet posts a "by hand" card naming the step, as today.

### Phases (each one commit to `main`; easy for the agent to test with unit tests and socket playtests)
- **A. Engine core — implemented.**
  - **Runtime:** `client/src/lib/patd/engine/runtime.js`, kept in `fights.runtime` via `server/engine/runtimeStore.js`. It holds the round, a turn sequence, the active fighter, and per fighter `state` (persistent choices), `pool`, `placed`, `flags` (per turn) and `fight` (per fight), plus usage counters, temporaries, scheduled effects and the sides' Super counts.
  - **Boundaries:** `startTurn` resets ':turn' and ':action' counters and the flags, and an owner's ':own_turn' counters at their turn. A new round resets ':round' counters and Super counts. `addTemp` / `expireTemps` handle every content duration: end of turn, start of next own turn, after the target's next turn, end of (next) round, next Action, next damaging Action, current hit, end of fight.
  - **Writers:** only the fight's engine chain writes the runtime. It is loaded per job and saved with `env.save()`, and a stale job (ended fight) never saves.
  - **Event bus:** `engine/bus.js` (`listenersFor`) routes `self.` / `ally.` / `ally_in_range.` / `enemy.` / `enemy_in_range.` / `visible_enemy.` / `shield_in_range.` / `any_` events. The trigger engine's follow-ons go through it (`emitEvent`). `turnEvents` gives the turn-boundary events by relation.
  - **Modifiers:** `engine/modifiers.js` (`modifiersOn`) collects `modify_rule` and lasting `grant_armor` from continuous rules of active sources, including auras whose selector reaches other fighters, plus runtime temporaries. Queries: `valueOf`, `sumMod`, `listMod`, `hasMod`. The End Phase Speed rules now read it.
  - **Snapshots:** `server/engine/snapshots.js` saves and restores the fight's combatant rows, its map tiles, lane slots and the runtime.
  - Tests: `server/test/engineCore.test.js`; playtest `scripts/playtest-engine-runtime.mjs`.
- **B. The Action Pool and Commit — implemented.**
  - **Turn board** (`server/diceMarks.js`, one `dice_marks` row per Stance roll). Its data is `{ stanceKey, results, extra (numbers added to the pool), placements, power, paused, committing }` (`client/src/lib/patd/diceBoard.js`: `poolOf`, `publicBoard`, `reservedBy` / `minusReserved`, `stopChoices`).
  - **Placing:** `board:place { rollId, die | option+answers, actionId }` places a die (only on an Action with a dice cost) or a token payment. A payment is checked against the fighter's tokens minus what earlier placements already promise; nothing is paid yet.
  - **Other edits:** `board:unplace`, `board:stop { key, stop }` (stop at a lower lit Gate), and `board:power`. A placement's `threshold` is the top Gate it reaches.
  - **Commit:** `board:commit` runs `server/engine/actions.js` on the fight's chain. For each uncommitted placement, in order:
    1. A snapshot (`fight_snapshots`, including the pool's added numbers).
    2. The cost is paid (tokens, HP, Shield, the Challenge back from its holder).
    3. The effect resolves through the interpreter with `payment.rating`, `resolution.gateRating` (or the stop) and `history`. A damaging Action must include the Challenger (`mustTarget`). Steps the engine can't run yet go into a "By hand:" line (`onUnsupported`).
    4. The bus emits `self.action.before / cost_paid / resolved`, `self.dice_action.resolved`, `self.damage_dealing_action.resolved`, `self.first_action_on_own_turn.resolved`, `ally.action.resolved`, `any_action.fully_resolved`, `self.token_action.pay_cost` and `self.hp_paid`. Temporaries expire ("or next Action", "next damaging Action").
    5. A card reports what happened: a notice, or orange when part was by hand.
    - Between Actions the batch **pauses until Continue** whenever someone could react (`reactionsAvailable`, filled in by phase F). A cost that can't be paid stops the batch, and that Action stays placed.
  - **Retrieve (GM):** `board:retrieve { rollId, key }` restores that placement's snapshot (HP, tokens, positions, tiles, runtime, the pool's extras). That placement and every later one go back to placed. Players can't.
  - **End turn:** `board:end_turn { rollId }` is for whoever controls the active fighter (or the GM), not while performing. It shares `nextTurn` with the GM's Next turn.
  - **The board UI** (`DiceBoard.jsx`):
    - Dice show an order badge (top-right, outside the greyed face). Placed is grey; committed is grey and crossed, and only the GM can tap it to retrieve.
    - Tapping a placed die takes it back. Tapping a token-cost Action places or unplaces its payment (with `PayDialog` for choices). Tapping a lit Gate line sets the stop.
    - The footer holds Power (balance and toggle), the pool (rolled dice, fixed numbers, added numbers in blue), Commit N or Continue, End turn and ✕.
    - The chat's roll card shows placed (grey, numbered) and committed (crossed) dice to everyone, plus added numbers.
    - Prompts (`TriggerPrompts`) now open above the board (`DialogShell zIndex`). A required Challenger starts picked and can't be unpicked.
  - `add_pool_number` lands on the fighter's active board.
  - **Not yet:** an Action's own `conditions` and `limits` (e.g. Swift Strike "only during enemy turns", "once per turn"). They come with reactions (phase F), where they matter.
  - Tests: interpreter Challenge and Gate tests; playtest `scripts/playtest-dice-marks.mjs` (place, unplace, stop, Commit with real damage and the cost paid, GM Retrieve undo, recommit, End turn).
- **C. Damage pipeline (WEPIA) — implemented.**
  - **The rules, pure** (`client/src/lib/patd/engine/damage.js`, book p.69 "Damage Resolution"). `resolveDamage(hit, decide)` runs one hit in the book's order:
    1. Base damage, with an Action's own adjustment (Elder Style −1, minimum 0).
    2. **Weakness:** an attacker hitting an enemy discards 1 for −2 (Armor Install: −1), minimum 0.
    3. **Weird effects:** a Pit gives −1 against attacks from beyond Range 3; Heroic Style splits an ally's hit (`ally_in_range.would_take_damage` → `split_incoming_damage`; the first redirector only, the other half resolves as its own hit with no further split).
    4. **Power:** the attacker may spend 1 per hit, plus `enhance_hit.additional_uses` (Power Form 2, Ego, Giant) and `power_tokens.additional_per_hit` (Drive Install). Each is +1 damage and +1 push (the push lands in phase D). Exploit Weakness (`spend_target_weakness_as_own_power`) spends the target's Weakness first.
    5. **Iron:** only against Actions and Abilities. Up to **2 per hit** (the glossary's "Reducing a Hit: 1 or 2"; Drive Install +1; an Armor Install attacker caps it at 1), each −1 damage and −1 push/pull. Then "spend 1 Iron to take 1 less from any source" (Iron Form, Mountainous) via `self.would_take_damage` → `spend_tokens` + `reduce_damage`. It is offered only when Armor won't block the whole hit anyway, and it ignores Unblockable, as its content says.
    6. **Shield:** blocks damage from Actions and Abilities, and Burning, 1-for-1, breaking when used up. Off under `shield.disabled`.
    7. **Armor:** if the hit is still 1+, it blocks 3 the first time this turn (The Tank: `armor.first_trigger_reduction` 10), 2 the second, 1 after that. That is once per source per turn (Armor Install: twice; a 1-damage hit blocked to 0 doesn't spend it), once per hit, and never at 0 damage.
       - Sources: hand-added Armor tokens, the build's Armor (`armorSourcesOf`), others' Armor auras, and "Armor against Burning" (Inferno) for Burning.
       - **Temporary Armor** (Guard) is a binary special token `temp_armor` (cap 1, shown on the token row). It triggers after all the rest, once, and is then lost.
       - Off under `armor.disabled`.
    8. The rest comes off HP.
    - **Stops and sources:** Dizzy fighters take no damage, and `damage.immunity` stops a source (Winged: fall, Phoenix: burning_tokens, Volcanic: traps, Vortex/Spirit: pits). Traps and Fall get Armor only; Burning gets Shield and Armor.
    - **Unblockable** (`unblockableSet`) switches off armor / shields / iron_tokens / tokens / abilities / all. It comes from the attacker's lasting `unblockable` (Mad Style …), the resolution's own `modify_rule` (Shockwave, Crush, Heat Beam), `next_damage_action.unblockable` (Take Aim, on Actions), the node's `ignoreDefenses` (Become My Canvas), and **Build Abilities, which are always Unblockable** (book p.26: builds marked `unblockable`). `allowIronTokens` (Immortal Army) lets Iron back in. Unblockable by Abilities also skips the target's damage triggers.
  - **Hit spends (decided): Ask / Auto / Never** for Power, Iron and Shield.
    - Stored as `build.prefs` (`normalizePrefs`; a missing key means players Ask, NPCs Auto: `spendPrefs`), set in **Hit spends** on the sheet's Combat tab, under the build.
    - **Ask** prompts whoever controls that fighter: "Enhance the hit" (0..max Power), "Reduce the hit" (0..max Iron, saying how much Armor would block), "Shield" (yes/no).
    - **Auto** spends Power fully, Iron only on damage Armor won't take anyway, and the Shield always. **Never** spends nothing.
    - On your own committed Actions the **dice board's Power toggle** decides instead (on: Enhance every hit as far as allowed). It starts on when the Power setting is Auto.
  - **Applied on the server** (`server/engine/hits.js`, behind `world.damage(f, n, attacker, { source, ignore, allowIron, mods, unblockable, power, emit })`). Every hit goes through it: Actions, Ability damage, the token panel's **Take damage**, Traps and Burning.
    - It writes the spent tokens, counts Armor triggers in the runtime (`flags.armorTriggers`), marks an attempt on your Challenger (`flags.damagedChallenger`), and runs the Bleed check.
    - The interpreter's `damage` op only says who hits whom; its log line lists the steps ("deals 2 damage to X (Weakness −2, Power +2, Iron −1, Shield absorbs 2 and breaks, Armor −3)").
    - **Events through the bus:** `self.power_tokens_spent`, `self.hit_enhanced_with_power`, `self.iron_tokens_spent`, `self.hit_reduced(_from_enemy)`, `self.damage_reduced_by_iron`, `self.shield_absorbed(_from_enemy_action)`, `enemy_in_range.own_shield_damaged/broken` and `…damaged/broke_allied_shield` (`emitEvent` takes a listener filter), `shield_in_range.broken`, `self.armor_triggered`, `self.damage_reduced_by_armor`.
    - **Events when HP is lost:** `self.damage_taken`, `self.took_damage_from_action`, `self.took_damage_from_enemy_action`, `self.burning_token_damage_taken`, `enemy_in_range.trap_damage_taken`, `self.damage_dealt(_to_enemy)`, `self.action_or_ability.damage_dealt`, `self.bleed`, `self.fell_to_zero_hp`. Per Action: `self.action.damage_dealt_to_enemy { enemyCount }`. On-hit events fire even at 0 damage, on-damage ones only when HP is lost. `current_hit` temporaries end after each hit.
  - **Interpreter additions:**
    - `modify_rule` run as an effect applies for that resolution only (scope `mods`).
    - `temporary` installs `modify_rule`s and temporary Armor in the runtime until their duration ends (`world.addTemp`). "Until your next Action" now means a later Action (`rt.actionSeq`).
    - New ops: `spend_tokens`, `reduce_damage`, `split_incoming_damage`. A "you may spend …" is only offered when it can be paid.
    - Only **enforced rule keys** (`ENFORCED_RULES` in `engine/modifiers.js`) count as supported; any other `modify_rule` is still "by hand".
    - The Action and damage events are now supported trigger events, so Abilities listening to them run automatically when their steps are supported.
  - **The End Phase, automated** (book p.68), as one notice:
    1. **Traps** deal 1 through the pipeline (Armor now applies automatically; it was a reminder before).
    2. **Burning** damages the active fighter by their Burning (no Iron; Shield and Armor apply), then they discard half, rounded up.
    3. **Challenges** are removed from whoever tried to damage their Challenger this turn.
    4. **Speed:** the discard honours `end_phase.speed_discard` (Shadow 0, Drive Install 1).
    5. **Fatigue:** an active fighter who never left their starting space (`flags.startSquare`) discards up to 3. This is done for them (decided: nobody would decline).
  - **Not yet:**
    - Choosing what a Shield blocks (Status tokens instead of damage; only damage or nothing is modelled).
    - Copies' Iron (`iron.can_reduce_hits_to_own_copies`, phase E).
    - The Power push and the Iron push/pull reduction (computed, applied in phase D).
    - Wall damage to Rubble (phase E).
    - Fall damage from Pits (phase D).
  - Tests: `server/test/damage.test.js` (every step, sources, Unblockable, immunity, Auto, prefs), plus the runtime "next Action" test. New playtest `scripts/playtest-damage.mjs`, which checks:
    - one hit through every step, with the player asked and the NPC on Auto;
    - temporary Armor on the 2nd trigger;
    - the board's Power toggle on a Commit;
    - Burning, Challenge removal and Fatigue in the End Phase;
    - the sheet setting.
    - The end-phase, trap-armor, shield-xp and turn-triggers playtests were updated: Armor now blocks Traps, and players are asked before their Shield blocks.
- **D. Board and movement — implemented.**
  - **One board model, pure** (`client/src/lib/patd/engine/board.js`, book pp.53-60), for the map and the lanes.
    - **Squares:** `{ col, row }`. On a lane a square is (space, lane): stored as lane slot `lane × 10 + space`, and lane tiles as space index (row 0).
    - **Full spaces:** Walls and units. Rubble, Pits, Traps and Fog leave a space empty, and movement only enters empty spaces.
    - **Bounds:** the map's are the cells whose centre lies inside the image's 10% padding (`server/imageSize.js` reads the image's size from its bytes, PNG / JPEG / WebP / GIF, cached by hash). A lane's are 10 spaces × the lane count.
    - **Where the Outside is:** on the map, all four edges. On lanes, **only a lane's ends** (decided: "the ends are the arena edge"), so nobody goes off a lane's front or back.
  - **The diamond grid (decided, revised):** every step of movement is lateral (the four neighbours); a diagonal is two steps through a space that must itself be empty, so nobody slips between two Walls. Distance is `gridDistance` (Manhattan).
  - **Free Movement** (`freeMoveReach`, cheapest Speed): 1 per lateral step (so a diagonal costs 2), +1 for each step out of a Pit, never through full spaces, never Outside. Weightless Style alone still steps diagonally, for 1. Traps on the path deal 1 and Rubble gives 1 Fatigue. Speed is paid after, only for the spaces moved.
    - **Fatigued** (decided): the move discards 1 Fatigue and goes 2 spaces less (the path's last 2).
    - **Swap:** 2 Speed swaps with an adjacent ally.
  - **Action Movement** (`actionMoveDestinations`): "move X" goes exactly X when it can, and otherwise as far as it can; "up to X" may stop early. No repeated spaces, and Rubble or a Pit ends it at once. The mover picks the square.
  - **Teleport X:** any empty space within Range 1-X (the diamond). It is safe: no Trap, Pit or Rubble effects.
  - **Swap Spaces:** both fighters trade places.
  - **Fatigue** shortens Action Movement and Teleports by 2 too (discard 1).
  - **Push and Pull** (`forcedMoves`, `landingsOf`):
    - Each lateral step is strictly farther from (push) or closer to (pull) the origin. Units block.
    - **A pull of an adjacent target spins them** (book: "into any other space adjacent to both of you"). On the diamond grid no space is laterally adjacent to both, so (decided) the spin goes to the spaces adjacent to the puller that touch the target's corner: one diagonal hop around them per space pulled.
    - **World of Cardboard (always on):** a push into a Wall smashes it into Rubble; they enter it and the movement ends.
    - Rubble and Pits end it. Traps on the way trigger.
    - **The Outside:** only off an edge they started on; otherwise they stop at the edge.
    - The distance is the Action's, plus the same hit's Power (+1 each) and minus its Iron (−1 each). It is −1 if they stand in a Pit, and less by "you move one less space" (The Tank, via `self.would_be_pushed_or_pulled` → `reduce_forced_movement`).
    - A push without a hit may be **resisted with Iron** (up to 2): Ask prompts, Auto resists only a risky push, Never doesn't.
    - **The pusher taps the landing square.** A route is asked only when the routes cross different Traps (decided).
    - **Landing:**
      - a Pit deals 2 fall damage (source `fall` / `pits`, through the damage pipeline);
      - Rubble gives 1 Fatigue; a Trap deals 1;
      - the Outside means **removed from play and Dizzy** (off the map; on lanes, the tray). The Comeback comes in phase F.
    - **Save Yourself:** 1 Speed, or 2 out of a Pit, moves one space instead. It is offered as a square pick with a Skip, only when the landing is dangerous (decided default).
    - **Traps** deal damage once per turn (runtime `trapsHit`).
  - **Applied on the server** (`server/engine/moves.js`, behind `world.move / teleport / forced / swap`). The world (`server/triggers.js`) gives it `board()`, `setSquare` (a map cell, or the lane slot through `moveOnLane`), `smashWall` and `setDizzy`. It posts one grey **movement notice** per move.
  - **Interpreter:**
    - New ops: `move`, `teleport`, `push`, `pull`, `swap_spaces`, `reduce_forced_movement`. Each hit records its push bonus and resist in `history.hits`.
    - A "you may move / teleport" rule is one square pick with a Skip, not a yes/no first.
    - New events: `self.would_be_pushed_or_pulled`, `self.pushed`, `self.push_finished`, `self.movement.finished`, `self.free_movement.one_space_finished`, `any_movement_phase.start`.
  - **Picking squares (decided: on the map or lane, with a compact list):**
    - A `square` prompt (`{ kind: 'square', mode, options: [{ id: 'c,r', col, row, label, note }] }`) opens `lib/squarePick.js`.
    - The legal squares glow green on the map or lane (`SquarePickLayer`; Free Movement squares glow blue with their Speed cost). Tap one, or pick it from the short bar docked at the bottom.
    - While a pick is open the dice board steps aside and the initiative rail fades and lets taps through.
  - **The Move button** on the dice board's footer, for the active fighter before each Action (not mid-Commit), starts Free Movement: `move:reach` (an ack with `{ mode, speed, fatigued, options, swaps }`), then `move:free { combatantId, to }` and `move:swap { combatantId, allyId }`. **Done** ends it.
  - **Early and Late Movement (decided)** live in `fights.movement_phase`: `{ kind, activeId, waiting }`.
    - **Early** opens after the turn's start triggers, for every other fighter on the board holding Speed. **Late** opens on End turn, for everyone holding Speed, and the turn ends once it's done.
    - `MovementPhaseBar` gives each waiting fighter's controller **Move** and **Done** (`move:done`); the GM can **Skip** (`move:skip`).
    - Commit is refused during either phase. The GM's Next turn skips Late Movement, and Previous turn clears the phase.
    - Late Movement lets everyone move at once (decided: not the book's active-allies-enemies order).
    - Each phase emits `any_movement_phase.start`.
  - **Not yet:**
    - `move_obstacles`, `teleport_to` and `pull_until` (phase E / H);
    - obstacles as targets or origins (`bindings.rubble`; phase E);
    - pushing Copies (phase E);
    - the Comeback rule for those removed from play (phase F).
  - **Tests:** `server/test/board.test.js` (spaces, Free Movement costs, Action Movement, Teleport, push with Pits, Traps, Cardboard, the Outside, lanes' ends, pull and spin, Save Yourself, map bounds and image sizes) and the interpreter's "you may Teleport" test.
  - **Playtests:**
    - `scripts/playtest-movement.mjs`: Early Movement and its Commit lock, reach and cost, a Relentless push picked as a square, Cardboard with Save Yourself declined, the Outside, Late Movement, the GM's Skip.
    - `scripts/playtest-lane-movement.mjs`: lanes as a grid, the slot saved, off a lane's end.
    - The damage, dice-marks and turn-triggers playtests were updated: Swift Style's Speed now opens Late Movement, and Aura Style's push now runs.
    - A phone-landscape browser run covered the phase bar, Move with the costs, the push square bar and a tapped landing, with no console errors.
- **E. Obstacles and Copies — implemented.**
  - **Obstacles from the rules:**
    - `place_obstacle` (Trap, Fog, Pit, Rubble, Wall, Copy) goes on picked spaces. The squares glow on the map or lane, and only legal ones are offered: the book's stacking (`mapTiles.js placeTile`), never a Wall or Copy onto a fighter, `empty` when asked. A "you may place …" is one space pick with a Skip.
    - `destroy_obstacle`: a Wall becomes Rubble, and anything else is gone. `replace_obstacle` swaps one obstacle for another.
    - **A Wall or Rubble hit for 2+ in one hit is destroyed** (a damage target of kind `…_or_obstacle`).
    - New selectors: `space` (squares in range, picked one at a time; `count: { maximum }` may stop early), `obstacle` (with `types`), `own_copy`, and `enemy_ / unit_ / ally_or_obstacle`. Refs `self.space` and `targets.x.space` work.
    - Not yet: `deadly_trap`, `move_obstacles`, and the selectors' `adjacent_to_binding`, `originBinding`, `inFog` and `obstacleBinding` (these stay by hand).
    - World functions: `world.spaces / obstacles / canPlace / placeObstacle / destroyObstacle / replaceObstacle`.
  - **Copies (book p.71):**
    - **Storage:** a Copy is a `map_tiles` row of kind `copy` with `owner_id`, its Original's combatant id (`ensureColumn`). Snapshots keep it, and **hand tile edits leave Copies alone**.
    - **On the board:** a Copy fills its space like a unit. It can be targeted as an enemy (added to enemy picks) or as an obstacle, never as an ally.
    - **No tokens, Shields or HP:** gaining or discarding tokens, healing and HP costs do nothing to it. **Any damage destroys it**, a Trap's included, and the End Phase destroys a Copy standing on a Trap.
    - **Movement:** pushed, it moves its tile; pushed Outside, it's gone. "Within range of you or your Copies" (`self_or_copies_range`) counts from each of them.
    - **Acting from a Copy:** an Original with Copies picks where each committed Action is performed from (a square pick: "Here" or a Copy). The Action's ranges then count from there (`ctx.originSquare`).
    - **Look:** drawn on the map and lanes as the Original's picture, faded, in a dashed violet ring labelled "Copy" (`CopyLayer`).
    - Not yet: moving your Copies with Free Movement, an Action's own movement moving the Copy instead, and `copies.maximum_hp`. (Copy events — `self.copy_destroyed`, `enemy.destroyed_own_copy` — came in phase G.)
  - **Tests:** interpreter tests (a Trap on a picked space, only legal spaces for a Wall, a Wall destroyed by 2 damage, a Copy placed and picked as your own; `deadly_trap` stays by hand).
  - **Playtest** `scripts/playtest-obstacles.mjs`:
    - Volcanic's "you may place a Trap" as one pick;
    - the Necromancer's Copy on an empty space, owned by its Original;
    - a hand-placed Trap leaving the Copy;
    - the End Phase Trap destroying it;
    - Hidden Style's Fog.
  - A browser run showed the Copy drawn on the map, with no console errors.
- **F. Turn structure and reactions — implemented.**
  - **The rules, pure** (`client/src/lib/patd/engine/turn.js`):
    - `turnContext` says whose turn it is from an Action's point of view (own, allied, enemy).
    - `evalCondition` covers the content's conditions: `context.isOwnTurn / isEnemyTurn / isAlliedTurn / performedByAnotherAction`, `self.tokens.*`, `eq / not / and / or`. Anything unknown is left to people.
    - `actionUsable` checks conditions and limits: uses per turn, enemy turn, round or fight, counted in the runtime's `usage` under `action:<id>:<fighter>:<period>`, so `startTurn` clears them. `recordUse` counts a use.
    - `reactionClusters` gives the reactions on offer, by resource. `atZero` is Taken Out at zero HP, and `comebackSquares` gives the empty spaces within 3 of the edge (on lanes, of the ends).
  - **An Action's conditions and limits are enforced** when it is placed ("Swift Strike: only during an enemy's turn", "only once per turn", counting what's already placed) and counted when performed. Nobody at zero HP places Actions, and nothing is placed during a movement phase.
  - **Reactions (decided then; replaced since by Interrupts, see the feedback batch below):**
    - **The window:** after each of the active fighter's committed Actions, everyone else in play who can actually react gets one. That means a token Action they can pay for whose conditions allow it now, or a dice Action a **Chaos token** reaches "as if you had spent a 4" (once per turn). The window lives in `fights.reaction_window`: `{ seq, activeId, offers, done }`, shown as `{ activeId, waiting }`.
    - **The pause:** with Actions still placed, the batch **pauses until Continue**, but only when someone can react.
    - **React and Pass:** the **React bar** (`ReactBar`) gives each waiting fighter's controller **React** or **Pass** (`react:pass`).
    - **The reaction board:** React (`react:open`, an ack) opens that fighter's own board (`react-<fight>-<seq>-<id>`, `data.reaction`). It lists only the reactions on offer, **one rectangular cluster per resource** ("Paid with tokens", "Chaos token (as a 4)") packed into two columns; the view scrolls. A Chaos 4 sits in the pool, and the footer has Commit and Pass.
    - **One reaction each:** committing performs it, and that fighter is done for the window.
    - **Closing:** the window closes on Continue, the active fighter's next Commit, or the end of the turn, and freezes its reaction boards.
  - **The Comeback rule (book p.63):** someone removed from play may come back on an empty space within 3 of the edge, picked as a square with a Skip. It is free at the start of a Round, or costs 3 HP at the start of their own turn (if they have it). Stooges never come back.
  - **Heroic Spirit (book p.63):** an active fighter still Taken Out after the Start Phase picks an ally in play. The turn's board then belongs to that ally (`data.heroic`, and `actingOn(row)` everywhere a board's fighter is read): the ally places, commits and ends the turn with the donor's dice in their own current Stance. It emits `self.giving_heroic_spirit`.
  - **Control tokens (book p.117):** after an Action's cost is paid and before it resolves, each enemy whose range the actor is in, holding Control (once per turn), is asked:
    - **Copy (1):** they then perform the same Action as a reaction with a 4. Not possible for once-per-turn Actions.
    - **Dodge (2):** they, or an ally in their range, become immune to it (left out of its targets).
    - **Parry (3):** the Action is negated, they deal 2 damage to the actor, and may Move up to 2.
    - The engine does this itself, so the content's Control and Chaos mechanic rules are skipped (`ENGINE_NATIVE`).
  - **Taken Out** (zero HP on the last bar) takes no damage (book p.62).
  - **Already automatic now:** Luck's "after any Action, spend 1 to Teleport 3 and Heal 1", whose steps (spend, teleport, heal) now run.
  - **Not yet:** numbers held outside your turn (Reversal Form, Patience Style; phase H) and Training's pool boost (phase H); Luck paying for costs (`substitute_cost`); Mentor's Heroic Spirit bonus (by hand); Poltergeist (phase H); "times targeted" limits; the book's ally-before-enemy reaction order (everyone may react at once).
  - **Tests:** `server/test/turn.test.js` (turn context, Swift Strike's condition, limits with pending placements, reactions by resource with and without Chaos, Taken Out, Comeback squares on map and lanes).
  - **Playtest** `scripts/playtest-reactions.mjs`:
    - a reaction window with its pause, React, a reaction board refusing what isn't on offer, Swift Strike paid with Iron, and Continue;
    - the enemy-turn condition refused on Ana's own turn;
    - a Parry;
    - a Taken Out fighter taking no damage;
    - Heroic Spirit giving Cy's dice to Ana.
  - The dice-marks playtest now uses Armored Style's You Stay, since Swift Strike can't be used on your own turn. A browser run (phone landscape) covered the React bar and the clustered reaction board; it caught a render crash before the rules loaded, which is now fixed.
- **G. Modifiers and durations — implemented.**
  - **Range and sight under modifiers:**
    - A fighter's range is now their Stance's changed by `range.set`, `range.minimum_set`, `range.maximum_set` (`'infinite'`) and the summed bonuses: `range.maximum_bonus`, "your next Action" (`next_action.maximum_range_bonus`, a temporary until that Action) and "this Action" (`current_action.maximum_range_bonus`). This is `effectiveRange` in `engine/modifiers.js`.
    - `sight.ignore` (Dark, Fullmetal, Parkour, Avalanche Style) sees through Fog and/or Walls.
    - Every range check uses both: targets, spaces and obstacles.
  - **Movement modifiers:**
    - `rubble.no_fatigue` (Winged, Weightless).
    - `free_movement.cost_per_space` (Weightless: every space costs 1, diagonals and Pits too).
    - `free_movement.disabled`.
    - **Caged Style's `speed_tokens.cannot_gain_or_spend`:** an adjacent enemy gains no Speed from rules, has no Free Movement or swap (the reach is empty), and its Action Movement is reduced to zero, as the Style's text says. Hand edits on the token panel still work.
  - **Speed gains:**
    - "When you gain Speed, replace half with Power / Iron" (Power and Iron Form, Mountainous Freestyle) is `self.gain_speed_tokens` with `replace_token_gain`.
    - The End Phase reads Scrambling Style's floor of 2 from its `end_phase.speed_discard` rule, as a modifier of its owner.
  - **Extra Action Dice:** a Stance's own continuous `action_dice.additional` (Quickdraw +d6, Lucky +d4) is part of its derived dice (`build.js extraDice`), before the level's bonus die. The sheet's dice row titles it "Extra d6 (an Ability)".
  - **Durations:**
    - `temporary` installs modifiers, temporary Armor and `register_trigger` items. A trigger registered for a while runs as a rule of its source, for its owner, until it expires; outside a `temporary` it lasts the fight.
    - **`schedule` (delayed effects):** "at the end of this turn" (`current_turn.end`, run before the End Phase) and "at the start of your next turn" (`next_turn.start`, the owner's next turn). They are stored in the runtime's `scheduled` with what they captured: targets, bindings and variables, fighters and Copies by id. `runScheduled` rehydrates the ids and runs them by their owner. Other moments (Showdown's "the target side's next selected turn") stay by hand.
  - **Rule limits counted in HP healed and tokens gained** (`limit.metric` `hp_healed` / `tokens_gained`): the heal or gain is cut to what the period still allows. A heal counts what it really healed (`world.heal` returns it). Examples: Armored Style's 3 HP a turn, Vampire's Bleed Value and 4 Power a turn, Heartless.
  - **"This turn" state** (getters on each fighter, from the runtime's per-turn flags): `self.performedActionThisTurn` (One-Two Form, Chaotic Freestyle), `self.tookDamageThisTurn` (Brawling Style, Bumbling Build; set when HP is lost), `self.obstaclesDestroyedThisTurn` (Collateral Style; counted by whoever destroyed it), and `self.standingOnWall` (Parkour).
  - **Refs relative to the rule's owner:**
    - `….holdsOwnChallenge` (Knockdown, Taunting, Judgment).
    - `context.isOwnTurn` (Mastermind).
    - Operators `is_enemy` (Crosshair), `is_obstacle` and `not_in` (Misfortunes).
    - A selector origin of `original` is the Copy's maker, i.e. you (Crystal).
  - **Events now emitted:**
    - `self.action_dice.rolled`: after Heroic Spirit at the start of the turn.
    - `own_action_phase.start`: after Early Movement, or right away when nobody moves (`triggers.actionPhase`, from `fights.js`). It is **never awaited inside the server-wide queue**, which would deadlock: the playtest caught this.
    - Token gains: `self.tokens_given_to_enemy` and `self.weakness_given_to_enemy` (whose rule gave them), and `visible_enemy.gain_basic_tokens` (Ego; Basic = Power, Iron, Speed).
    - Copies: `self.copy_destroyed` (Crystal) and `enemy.destroyed_own_copy` (Zombie, with the destroyer as `event.attacker`).
    - `self.reactive_action.before` (Swift Style, on reaction boards).
    - What an Action did, on `self.action.resolved`, `self.dice_action.resolved` and `self.damage_dealing_action.resolved`: `enemiesDamaged` (Fullmetal, Mad), `enemiesForcedMoved`, `alliesForcedMoved` and `movedSwappedOrTeleportedSelf` (Ogre's, Dance Form, Circular Freestyle).
    - Other payloads: `self.pushed` carries `source` (Slasher pulls toward it), `self.damage_taken` carries `sourceType` (a Super Move counts as an Action), and `self.damage_dealt` carries `damage`.
  - **New range mode:** `adjacent_to_any_own_copy` (Zombie Style's end of turn).
  - **Derived, not run:** `stance.construct` (Blaster, Control Form) is applied when the Stance is derived (`stanceRange`). The Frantic Hero's assembly is the engine's own (`ENGINE_NATIVE`).
  - **Fixed:** `for_each` over a ref (Knockdown's damagers) crashed in `select`; it now takes a selector or a list.
  - **Coverage:** 191 of the 238 triggered Ability rules are now automatic (155 after phase F).
  - **Not yet:**
    - ~~"If an enemy discards your Challenge token using an enemy Action or Ability" stays by hand~~ — automated since play feedback batch 2 (Challenge is a Unique token, decided).
    - Also by hand: Greater Frenzy's two Frantic Abilities, Showdown's delayed effect, Giant's `self.move_over_wall`, Puppets moving obstacles, and Weightless's "share a space".
  - **Tests:** `server/test/modifiersDurations.test.js` covers HP and token limits, the "this turn" state, holdsOwnChallenge both ways, isOwnTurn, is_enemy, not_in, an Action's damaged enemies, a scheduled effect capturing a target by id and running later, the cost per space, Quickdraw's die, and `effectiveRange`.
  - **Playtest** `scripts/playtest-modifiers.mjs`:
    - Zombie's Copy placed at the start of the turn and dealing 1 to the adjacent enemy at its end;
    - Caged emptying the adjacent enemy's Free Movement;
    - Brawling's Shield 2 after a turn it was hit;
    - Scrambling keeping 2 Speed;
    - an enemy destroying the Copy and taking Zombie's 1 damage;
    - Quickdraw's extra d6.
  - All 19 automation playtests pass.
- **H. Pool manipulation and special operations — implemented.**
  - **The Action Pool changed by rules.** The numbers live on the owner's active turn board (`dice_marks.data`). An Ability changes them in place through `changePool(combatantId, change)` (`engine/actions.js`), which reads and saves the board in one queued step. `commitBoard` re-reads the board after each Action, so changes made by the Action's own events survive.
    - **Pure helpers** (`diceBoard.js`): `setPoolValue` marks a number `changed`; `removePoolNumber` marks it `removed`, and it keeps its index but leaves `poolOf`; `addPoolValue` adds a number; `livePool` is what's left (not removed, not spent by a committed Action; placed-but-uncommitted numbers still count).
    - **The world:** `pool(f)` and `changePool(f, fn)`, from the boards preloaded per job, and the getter `self.actionPool` (Training's "if you still have numbers").
    - **Ops:**
      - `increase_pool_number` (Mentor, Training, Improved Fusion).
      - `increase_distinct_pool_numbers`: the Wardancer's +3/+2/+1 to different numbers, to a maximum.
      - `set_pool_number` (Focused Mastery: any 1–9).
      - `replace_pool_number` with `roll_die` (Frenzy Mastery's d12).
      - `duplicate_pool_number` (Fusion Mastery: one of 6 or less).
      - `reroll_die` / `reroll_dice` (Mythical Freestyle, Improved Focus: up to 3, keeping the new results).
      - `combine_pool_numbers` / `split_pool_number` (Flashy Style).
      - `remove_lowest_action_die` (Judgment Style): the smallest die, else the bonus die, else the smallest number.
      - `modify_pool_numbers` (every number ± n, to a minimum).
    - **Picks:** the owner picks numbers in a `choose` prompt ("5 (d10)"); rerolls use a multi-pick `targets` prompt. A "you may …" (rule-level `optional`, or an `optional` step opening with a pool op) offers **Skip** in the pick itself, with no yes/no first. One choice needs no asking.
    - **On the board:** a number changed by an Ability is drawn lime with a ✦ ("Changed by an Ability"); taken-out numbers disappear. Snapshots keep the rolled `results` as well, so Retrieve brings rerolls and changes back.
  - **Actions performed by rules (`perform_action`):**
    - **Which Actions:** Gunkata's Gunslinger Actions (`tags: ['gunslinger']`), the Teacher's "a Unique Action available to the active character's Stance", any of the actor's (`availableActions`), and the Elder's "a Unique Dice Action available to anyone's Stance, not this one, not one already picked this turn" (`world.actionsFor(f, { gunslinger, unique, dice })`).
    - **How:** the owner picks one if several; it is then performed without its cost, with `rating` (4; A Warrior's Death 10, whose added 10 leaves the pool) for its Gates and X, by `runner.performFree`. That is `perform()` run **inside the rule's own env** (`envIn`: no second runtime save), with nesting capped at 3. Control's Copy now uses the same env too.
  - **Movement and targeting:**
    - **`teleport_to` a picked space:** "adjacent to the target" (Denial, Suddenly, Nothing Personal, Rocket Style), "anywhere you can see" (Effortless), "anywhere on the map" (Lightning Drop). A Trap there triggers; Rubble never does.
    - **Ranges measured from a bound thing** (`adjacent_to_binding`, `on_or_adjacent_to_binding` with `originBinding`: a target, a binding, or a ref like `event.target`), for spaces, units and obstacles: Open the Path, Hunger, Raise the Dead, Siren Song, Bombardment, Scatter Shot.
    - **A selector origin of another target** (`origin: targets.ally / targets.copy / bindings.each`): "within range of that ally" measures with the ally's own range; an obstacle measures with yours.
    - **The step's actor** (`actor`): `damage` dealt by someone else (Slugfest's target hits back, Follow My Lead's ally, the Necromancer's Copies) and `swap_spaces` (a swap with a Wall stays by hand).
  - **Smaller pieces:**
    - `repeat` N times (Mentor: once per Mentor token).
    - "Per Action" limits count within that one Action (`ctx.actionSeq`); limit metric `uses`.
    - `self.training_token_spent` is emitted when a Training token is spent.
    - `is_ally`.
    - New refs: `history.tokensDiscarded` (Hunger), `history.damageDealtToTargetByThisAction` (Burning Fist), `history.damageTakenByEach` (Grape Shot), `history.enemiesDamagedByThisAction` (Icicle Fall), `history.challengedByThisAction`, `payment.hp`, `payment.tokens.<kind>` (XYZ-Burst, Bad Luck), `targets.x.tokens.<kind>` (Blazing), `targets.x.statusTokenCount` (Apply Pressure: Burning, Fatigue and Weakness — a held Challenge no longer counts since it was decided to be a Unique token, play feedback batch 2), and `self.hpLostThisTurn` (Karma; damage and HP paid).
  - **Fixed:** a placement made only one obstacle when its `count` was larger (Pyroclasm's 3 Traps, Raise the Dead's 2 Copies, Crawl into View's 4). The node's count is now how many are placed, one space per pick.
  - **Coverage:** 211 of the 238 triggered Ability rules (191 after G), and 180 of the 217 Actions and Super Moves (143 before), are automatic.
  - **Not yet:** the Mythical d12's own reroll event, Improved Frenzy's change of Stance part, Luck's `substitute_cost`, Poltergeist's optional tokens, `choose_integer` (Ka-Boom), `selector_by_gate`, `joint_choice` (Song Form), `ensure_target` (Protect), `gain_tokens_until`, `move_obstacles`, `return_to_play` (Rescue), `replay_start_effects` (Mood Shift), Dancing Mad's open-ended repeat, and the Fog-only selectors (`inFog`, `within_placed_obstacles`). These stay by hand.
  - **Tests:** `server/test/poolOps.test.js` covers the pool helpers, the Wardancer, Improved Focus (with a skip), Flashy's combine and split, Focused / Fusion / Frenzy Mastery, Judgment's lowest die, Training once per Action, Gunkata performing a Gunslinger Action with a 4, teleporting next to the target, Pyroclasm's 3 Traps, and a range from an ally.
  - **Playtest** `scripts/playtest-pool.mjs`: Judgment taking the d4 of the enemy holding its Challenge, the Wardancer's +3/+2 at the start of the Action Phase (never past 9, marked as changed), and Gunkata performing Take Aim at the start of the turn. The obstacles playtest now declines the Necromancer's end-of-turn "each Copy may Move 1", which is automatic now, so the Copy stays on its Trap. All 21 automation playtests pass.
- **I. Super Moves and NPC types — implemented.**
  - **Super Moves on the board (decided: all limits enforced).**
    - **The rules, pure** (`engine/turn.js`):
      - `superOnBoard`: every Super Move paid with two matching numbers, i.e. all but Transcendant Spirit, which is used while giving your Heroic Spirit (by hand).
      - `superUsable`: not in Round 1; once per fight per character (the runtime's `super:<fighter>:fight`, a placed one counting); the side's per-Round limit from the Scene's Cinematic Weight (`weight.supers`: Feather 0, Light / Middle / Heavy 1, World 2; counted in `rt.sides[side].supersThisRound`, reset each Round).
      - `superPair`: the picked number and a free one matching it, both 3+.
    - **On the board:** the Super Move cards under Personal are drop targets. Drop (or tap) one number of a matching pair on one, and the server pairs it with its mate (`board:place` → a `super` placement holding `dice: [i, j]`). Both dice show as placed, and the pair shows under the card ("#1 5 + 5", "✓" once done). It can't be placed on a reaction board. Refusals say why: "not in Round 1", "once per fight", "your side has used its Super Move this Round", "no Super Moves at this Cinematic Weight", "needs two matching numbers, each 3 or higher".
    - **Commit performs it like an Action, paid with its pair.** Differences:
      - its hits are the Super Move's (`source: 'super'`);
      - "no token responses" (`allowsTokenResponses: false`) makes them unblockable by Iron;
      - it is no Action (`isAction: false`): no Control against it;
      - it triggers no "before / after an Action" Abilities (`triggersAbilities: false`), though its hits' own events still run;
      - it counts once for the fighter and once for their side this Round.
  - **Super Moves' own operations:**
    - `gain_tokens_until` ("until they hold 6": Erupting Burning Fist, You Are Nothing).
    - `destroy_shield` (Lucky Hit).
    - `discard_tokens` with `tokenFilter` `basic` / `unique` / `non_unique` and `amount: 'all'`. A fix: Basic and Unique discards found nothing before.
    - Range `target_and_adjacent` (Lead Rain).
    - Selector `self_and_visible_allies` (Inspire Perfection).
    - `context.isEnemyTurn` / `isAlliedTurn` relative to the rule's owner (Hyper Install).
  - **NPC types:** Warriors (Warrior's Path), Bosses (several Stances, a turn per Health Bar) and Stooges (one shared Stance and unit, only the leading body's Abilities, no Comeback) were already in the engine from builder phase 4 and the earlier phases. Nothing new was needed.
  - **Coverage:** 25 of the 34 Super Moves resolve automatically, and 186 of the 217 Actions and Super Moves together.
  - **Not yet (by hand):** Dancing Mad's open-ended repeat, Poltergeist Panic (`move_obstacles`), Arcana Install (`poltergeist.total_per_action`), My Final Technique (`remove_from_play`), Transcendant Spirit, Funny Little Box of Pain (`deadly_trap`), and Immortal Army (`choose_integer`).
  - **Tests:** `server/test/superMoves.test.js` covers which Supers go on the board, every limit, the pair and its spent dice, Erupting Burning Fist, Lucky Hit, Lead Rain and Inspire Perfection.
  - **Playtest** `scripts/playtest-supers.mjs`:
    - refused in Round 1;
    - a later turn with a pair of 3+ (Thorns Form's fixed 5 and d6s);
    - a lone number refused;
    - placed with its pair, and Commit dealing Heaven's Piledriver's 6;
    - refused on the next turn (once per fight).
  - All 22 automation playtests pass.
- **J. Coverage sweep — implemented.**
  - **The census** (`client/src/lib/patd/coverage.js`, `census(content)`) puts every Ability rule, Action and Super Move in one of two groups: automatic, or by hand with its reason.
    - A triggered rule is automatic when `ruleSupport` passes or its Ability is engine-native (`ENGINE_NATIVE`, now this module's single list, shared with `server/triggers.js`).
    - A continuous rule is automatic when it only installs enforced modifiers or lasting Armor (`continuousSupport`).
    - An Action or Super Move is automatic when its whole effect is supported.
  - **Nothing is dropped silently:**
    - a triggered rule the engine can't run posts its "by hand" reminder when it fires;
    - an Action's or Super Move's unsupported step is listed under "By hand:" on its card;
    - **new:** at the start of a fight, each fighter whose lasting (continuous) rules aren't all enforced gets one orange reminder, "‹name› — by hand all fight: part of ‹Abilities› is not automated" (e.g. Caged Style's Action Movement).
  - **New enforcement:** `abilities.disabled` (Synchro Breaker). While a fighter has it, none of their rules run (triggered or registered) and their continuous modifiers are off (`abilitiesOff`).
  - **Where it ends:**

    | Kind | Automatic | Was |
    |---|---|---|
    | Triggered Ability rules | **221 of 238** (93%; 214 at phase J) | 91 of 306 Ability rules in all, before phase A |
    | Continuous Ability rules | **41 of 68** (37 at phase J) | |
    | Actions | **160 of 183** | none resolved |
    | Super Moves | **27 of 34** | |

    The rest are by hand with their reasons. Run `node scripts/coverage.mjs` for the totals and reasons, or `--list` for every entry. The content's one `requires_ruling` entry, The Untouchable, keeps its ruling part by hand.
  - **The biggest by-hand groups left:**
    - Build-time grants (`grant_archetype_variant`, Greater Focus and Frenzy).
    - Several one-off rule keys: Walls treated as empty, movement restrictions, cost changes, delegation, Copy HP.
    - The by-hand ops named in phases H and I.
  - **Tests:**
    - `server/test/coverage.test.js` covers that everything is counted, every by-hand entry has a reason, and the automatic counts never drop below the floor this phase reached (raise `FLOOR` as more becomes automatic). It also checks the `requires_ruling` entry stays by hand.
    - `abilities.disabled` is in `modifiersDurations.test.js`.
  - **Playtests:**
    - The modifiers playtest also checks the fight-start "by hand all fight" reminder.
    - The pool playtest no longer expects a Wardancer notice when every number is already 9+.
    - All 22 automation playtests pass: supers, pool, modifiers, end-phase, trap-armor, shield-xp, turn-triggers, fights, homebrew, dice-marks, damage, movement, lane-movement, obstacles, reactions, engine-runtime, trickster, frantic-npcs, build-fights, counter-gates, combat-weight, fighter-state.

## Implementation Phases (iterative — each ends with a deploy + playtest checkpoint)
The old system's phases (1-9 and the playtest batches after them) are complete history in git. The current state:
- **Pivot — done.** Old system archived and removed (this document's **The pivot**).
- **Character builder & turn automation — implemented**, in phases 0-4 (see its section above). Further changes are follow-ups from play.
- **Homebrew builder — implemented** (see its section above). **Commit Homebrew — implemented** (see its section): the GM commits published homebrew to the repo; Claude automates it on request.
- **Full automation — in progress**, phases A-J (see its section above).
- **Panic at the Dojo combat assistant**, in the five phases listed in its section above. Phases 1, 2, 2b (Stances) and 3 are implemented; so are multi-lane Simple Combat (2c), Phase 4 and Phase 5 — the whole scoped assistant — plus the Cinematic Weight GM tool. Further changes are follow-ups from play.

## Implementation Risks & Recommendations
- **The archive is the only copy of the old Compendium's data.** It lives in `compendium_archive` and is downloadable from Settings; keep a downloaded copy outside the app. Restoring the old system would mean reverting the pivot commit's code and re-importing from the archive by hand — there is no importer.
- **Build the new system's risky core in isolation, with unit tests, before wiring UI.** The old timing engine's lesson stands: pure, tested rules first.
- **Render cold starts** can hit as a session starts; Socket.io reconnection and `useSocketRefresh` resync are what cover it.
- **Identity is a client-side pick, not a login** — accepted. Anything the new system needs to keep secret must be protected by absence from the payload (as Counter Gates and the Relationships board do), never by a client-side flag.

### Play feedback after phase J (decided, implemented)
- **"By hand all fight" says the rule.** At the start of a fight, each Ability whose lasting rules aren't all automated gets one orange card titled "‹Ability› — by hand all fight", with the **Ability's rules text**. It no longer says "keep it in mind".
- **Armor highlight** (replaced in batch 2 by one ring per Armor source — see below): while a fighter has 1+ Armor, a steel-blue ring glows around their token (Combat) or base (Simple Combat), via `ArmorGlow` and `.armor-glow`. Armor here is Armor tokens, plus the build's Armor sources that hold in the current Stance, plus temporary Armor (then `armorHeld`; now `armorRings` in `panicTokens.js`).
- **Square picks: no list, a slim top bar.**
  - The legal squares glow on the map or lane and are tapped there.
  - `SquarePromptBar` is one line at the top of the screen: what is doing it, with the movement in brackets ("One-Two Form (Move 2)", "Relentless Style (Push 1)", "Volcanic Style (Place a Trap)", "Kneecapper (act from)"), plus **Skip** only when skipping is allowed.
  - **How the name is known:** the engine keeps `env.source`, the Ability or Action resolving now, for the movers' titles. The interpreter's space picks name their purpose.
  - Free Movement's bar is slim and at the top too: "‹name› · N Speed", plus Done. The squares show their own costs.
- **Landing preview on the dice board:**
  - **Dragging** a die over an Action card outlines that card **sky-blue** and lights every Gate up to the one that die reaches (the highest its number allows).
  - The card goes **red** when the die can't pay for it.
  - A **tapped (selected) die** does the same when the pointer is over a card.
  - Super Moves show whether the die has a matching partner.
- **The tapped die glows:** a lifted lime underglow that pulses (`.die-selected`, on the die's wrapper). The face's cut corners clip any shadow put on the face itself, which is why the old ring barely showed.
- **Iron Form, fully automatic** (also Mountainous Freestyle):
  - **Armor triggers:** +1 Iron (its rule).
  - **Gaining Speed:** half of it, rounded down, becomes Iron (its rule).
  - **"Spend 1 Iron to take 1 less damage from any source (even Reduced Hits)" is now the damage step's own (`engine/hits.js`):**
    - It is offered after the Iron step, against any source: Actions, Abilities, Traps, Burning, falls, hits already Reduced with Iron.
    - It follows the fighter's Iron preference: Ask, Auto, Never.
    - It only uses Iron not already spent on that hit, so an Iron token can't be spent twice.
    - It only applies when Armor won't take the whole hit anyway.
  - Its content rule is skipped as a rule (`coverage.js isIronAnySource`).
  - The notice reads "Iron Form −1", and the Iron counts for "after you spend Iron" (Armored, Scrambling Style).
- **Simple Combat: figures are grabbed by their base.** The miniature's box and picture let the pointer through; only the plinth takes it, as a slightly larger invisible ellipse. A figure standing behind another can now be picked and dragged by its own base.
- **Interrupts replace the reaction windows** (decided, revised):
  - **No windows:** Commit performs every placed Action without pausing, and there is no Continue.
  - **Who gets the button:** `interrupt:offers` (an ack) returns, for the fighters this person controls, who can take a Reactive Action **right now** and with what (`triggers.interruptOffers`, `reactionClusters`).
    - **Token Actions** they can pay for, whose conditions and limits allow it now.
    - **Dice Actions a Chaos token can pay "as if you had spent a 4"** (`gateFor(action, 4)` must not be null, so a 4 must be a valid input; once per turn).
    - **Taken Out or out of play:** only Actions marked usable while Taken Out (the Mentor's Remember Your Training). Placement allows those too.
  - **The button:** each such fighter gets an **⚡ Interrupt · ‹name›** button at the bottom left, clear of the GM's sidebar (`InterruptBar`, refreshed on every stage or board change).
  - **Interrupt (`react:open`)** opens their Interrupt board (reopening an open one) — since batch 2 under the Interrupt lock, or queued while an Action resolves (see batch 2).
    - **The layout is the turn board's:** **Basic** on the left, **Personal** (by group) on the right, only what's on offer. Each card is tinted by the resource that pays for it (emerald for tokens, fuchsia for Chaos, both when both), with a small legend.
    - **Not now** (`react:pass`) closes it.
    - After its one Reactive Action, the board closes. Open Interrupt boards close at the end of the turn.
- **Tests and playtests:**
  - `scripts/playtest-iron-form.mjs` covers:
    - Speed from the Movement Action becoming half Iron;
    - Iron Form after Iron Reduced the hit;
    - +1 Iron when Armor triggers;
    - the "Iron Form −1" notice;
    - an End Phase Trap (no Iron step, Iron Form asked);
    - no Iron spent twice.
  - The reactions playtest now checks Interrupts: no pause; the offers; Interrupt opening only what's on offer and reopening the same board; Swift Strike performed; the board closing; Swift Strike leaving the offer.
  - The modifiers playtest checks the rules text in the "by hand all fight" card.
  - **A browser run (desktop) showed:**
    - the Armor ring;
    - the Interrupt button and its split board;
    - the slim top bar "Relentless Style (Push 1)" with glowing squares;
    - the tapped die's glow;
    - the drag and hover previews (Damage lit to 9+ for a 10).
  - The Simple Combat lane (base grabbing, base ring) wasn't covered by the browser run.

### Play feedback batch 2 (decided, implemented)
- **Every step shows as it happens.** One-Two Form's "Move 1 before each Action" did move the fighter; the board just didn't show it until the whole Action was over. Now the stage is refreshed after each step: a move or a push shows at once (`setSquare` flushes), token and HP changes mark the stage dirty and **every prompt flushes it before it is sent** (`markDirty` / `flushStage` in `server/triggers.js`), and every saved job flushes too. So a Relentless push is on the board before the pushed Slasher is asked whether to pull. `scripts/playtest-live-steps.mjs` checks the One-Two pick is taken and every later question sees it, and that the push shows before Slasher asks.
- **Armor rings, one per source.** Concentric rings around the token (Combat) or base (Simple Combat), one per Armor source: Armor tokens, the build's sources that hold in the current Stance, then temporary Armor (dashed) outermost. A ring is bright while that Armor is still to trigger this turn and **very faint once it has triggered** (the first N rings, N = the fight's `armor_used[combatantId]`, from the runtime's `armorTriggers`). **The Tank's** Armor (blocks 10 the first time) is the innermost ring, **pure black** (setup `armor_first_reduction`, from the build's lasting `armor.first_trigger_reduction`). `ArmorRings` in `FighterOverlay.jsx`, `armorRings()` in `panicTokens.js`, `.armor-ring*` in `index.css`.
- **Commit closes the Action board**, so the board and the fighters are in view for the target picks that follow.
- **One-target picks take the latest tap:** tapping another target replaces the pick. Multi-target picks still toggle.
- **Hand moves ask about Speed.** Dragging a fighter who holds Speed (map or lane, in a fight) asks "Do you need to spend Speed tokens on this move?":
  - **No** just moves them (fixing the board).
  - **Yes · x/y**: x is the cheapest Free Movement there (the diamond grid; Weightless' cost per space; never through full spaces; searched up to 3 × the straight distance + 10, so a map without bounds stays quick), y the Speed held. Disabled when y < x or there's no way there; pressed, it spends x, then the move goes.
  - **Cancel the move** puts the token back. Without Speed (or outside a fight) nothing is asked.
  - Server: `move:hand_cost { combatantId, col, row | slot }` → `{ cost, speed }` and `move:hand_pay` (checks again, spends), both acks (`triggers.handCost`, `moves.handCost`). Client: `HandMoveDialog.jsx` (`useHandMove`). `scripts/playtest-movement.mjs` checks the costs (2 lateral = 2, a diagonal = 2, both = 3), a refused "Yes" and a paid one.
- **The diamond grid (decided: diagonal = 2)** for movement and Ranges — see "Range is computed on the board" and phase D. Range areas are diamonds; "adjacent" is the four lateral neighbours (melee, Swap, "adjacent to the target", Fog's "next to it", Copies).
- **Challenge discards (decided: Challenge is a Unique token):**
  - "Discard a Unique token" and "discard a token" (any) may take a held Challenge; Status, Basic and non-Unique discards never do. It is offered in the "which token?" pick like any other.
  - **Protected when:** the holder is under `challenge.cannot_discard` (Showdown: the target can't discard it before the end of their next turn), or the Challenger has `own_challenges.immune_to_enemy_action_or_ability_removal` (Distracting Style) and the discarder is the Challenger's enemy (`world.challengeRemovable`).
  - **Discarded by the Challenger's enemy:** `enemy.removed_own_challenge_by_enemy_action_or_ability` runs for the Challenger with `event.formerHolder`, so Judgment, Shining, Armored, Quickdraw, Taunting, Crying and Decoy (heal the ally nearest the former holder — range `nearest_to_event_former_holder`) are automatic. The holder can't be Challenged by that Challenger again this turn (book p.9).
  - **Giving a Challenge** (`world.challenge`): never to someone already holding yours; **a Shield may block it** — its holder is asked, 1 Shield is spent, and the Challenge isn't given (no "after you Challenge" rules) — unless it is **Unblockable by Shields** (the Angel's `challenge.unblockable`, Showdown) or that Shield already took this Action's damage; a Shield that blocked the Challenge then lets this Action's damage through (one choice per Action, book p.25). Someone already holding another Challenge chooses whose to keep.
  - Apply Pressure's Status count no longer includes a held Challenge.
  - The census marks `challenge.unblockable`, `challenge.cannot_discard` and `own_challenges.immune_to_enemy_action_or_ability_removal` enforced (`ENFORCED_RULES`): 221 of 238 triggered and 41 of 68 continuous Ability rules are automatic now.
  - Tests: two interpreter tests (the discard kinds and protection; a blocked Challenge, Decoy's nearest ally, all 7 rules supported) and `scripts/playtest-challenge.mjs` (a Shield blocking Decoy's Challenge; Purify discarding a held Challenge and Armored giving the former holder 2 Weakness; Distracting's Challenge never offered).
- **The Combat tab keeps its drawers.** Both sets of drawers (Scene: cast and Scene list; Combat: fighters and map) stay mounted once shown, hidden by `display`, so switching to and from Combat fetches nothing again (the Scene list, folders and cast don't reload).
- **The Combat map defaults to the Scene's artwork.** With no Combat Background uploaded, `activeScene.combat_image_url` points at the Scene's own picture (the same URL, never a copy; `combat_image_own: false`), with the grid over it. The map's bounds come from that picture (`mapBounds`, from the bytes' owner for a copied Scene). Uploading a map replaces it there; Remove brings the artwork back.
- **The Interrupt lock (decided):**
  - **Pressing Interrupt** shows everyone a full-screen "⚡ ‹name› is interrupting the current turn"; nobody can act. The interrupter's own Interrupt board sits above it; the lock drops **as soon as they Commit** (the Reactive Action then resolves), or when they give it up (Not now / Give it up). The GM can **Cancel it** (a stuck lock).
  - **It never cuts into a resolving Action.** Pressed while the fight's chain is busy (an Action resolving, a prompt waiting), it waits: a small **⚡ ‹name›** chip at the bottom of the screen, and the lock opens as soon as the stack finishes; their board opens on the connection that pressed it (`interrupt:open`). Someone who can no longer interrupt by then is skipped.
  - **Enforced on the server:** while it is up, only the interrupter's Interrupt board can Commit (`board:commit` refuses others: "wait — ‹name› is interrupting"), and Free Movement waits.
  - Server: `server/interrupts.js` (in memory per fight: `active`, `queue`), `fight.interrupt` in the stage, `triggers.isBusy` / `triggers.onIdle` (the chain counts its jobs), `wireInterrupts` in `fights.js`, `interrupt:cancel` (GM). Client: `InterruptLock` in `FightControls.jsx`. Tests: `server/test/interrupts.test.js`; the reactions playtest checks the queue while Bo's Action resolves, the lock and board opening for Ana when it finishes, a refused Commit under the lock, and the lock dropping on her Commit.
- **A browser run (desktop) showed:** the Armor rings on the map and on the Simple Combat lane (two blue; the Tank's black inner ring; faint once triggered); the map on the Scene's artwork with the drawer's note; no refetch over five tab switches; the hand-move dialog ("Yes · 2/3" for a diagonal, spending 2); the lock over the GM's screen, lifted by Cancel it.

### Play feedback batch 3 (decided, implemented)
1. **The GM places every token.** The Player's token dock is gone, and `combat_token:place` is GM-only on the server. Players still move their own.
2. **Full Combat's fighters drawer shows the characters in their folders** (the GM's character folders, collapsible, as on the Scene's cast drawer); a search shows the matches in their folders.
3. **The obstacle palette's button stays put.** Only the button sits in the centred box; the palette and its info card hang beside it, centred on it.
4. **Larger Armor rings:** thicker (3px, the Tank's 4px) and further out (map: half a token + 6px, 6px apart; lane: wider ellipses, 7px apart), still faint once used.
5. **A token's ✕ shows only once it is tapped** (selected) — on a phone too, where hover never happens, so it can't be hit by accident.
6. **Choices name their obstacles:** `describe` says "place Copy", "place Fog", "place up to 2 Fogs"… (Mysterious Build's two options were both "place obstacle").
7. **A refused Action shakes:** besides the note at the bottom, its card flashes red and shudders (`.action-refused`; reduced motion: no shake). Local refusals (not enough tokens, wrong kind of cost, a Super Move without a pair) and the server's (`dice:pay_failed`, matched to the Action last placed) both do it.
8. **No token menu while any choice is open:** while this client holds an engine prompt or a square/target pick is open (`isChoosing`/`useChoosing` in `lib/squarePick.js`), tapping a token or figure never opens its panel, and an open one closes. A tap on a token standing on a legal square of the open pick goes to the pick (`pickAt`) — so "act from" your own square works even with Copies about, and targets are tapped directly.
9. **Targets are picked on the board.** A target pick's options carry their squares, and the prompt carries `mode` and `area` (the Range: Stance, explicit or adjacent ranges, from `world.spaces`). The Range is shaded faint red, each legal target brighter red; a tap picks it, as if from the list. One target: the tap answers. Several: taps toggle (a required Challenger stays), then Done; Skip when none is required. Targets off the board are buttons in the slim top bar. Prompts whose options have no squares keep the list.
10. **Free Movement can be taken back.** The move bar's back arrow (shown when possible: `move:reach` → `canUndo`) undoes the last Free Movement (`move:undo`): back to where they stood, the Speed refunded (and a Fatigue spent on it). Possible until an Action is committed in that fight, they press Done in a movement phase, or the turn moves on; never for a move that crossed a Trap or Rubble (its harm is done), nor onto a space taken since. Kept in memory per fighter (`triggers.undoFreeMove`).
11. **Brambles (Thorns Form; Dangerous Freestyle) deals its damage.** "Range 1-X" with X a ref (the destroyed Shield's value) was compared unevaluated, so nobody was ever in range; selectors now evaluate their range bounds first (`resolveRange`).
12. **The active fighter's attack range shows** very faintly red on the map or lane during a fight: `fight:active_range` (an ack) gives the squares their Stance reaches now (modifiers and sight included), refreshed on every stage change (`ActiveRangeLayer`). It stays up during choices too, under whatever is picked.
13. **Every range shows on every screen (decided — the table shares a player monitor).** The active range is fetched by every viewer. Every open square or target pick goes to every socket as a view-only `pick:view { id, kind, mode, title, fighterName, area, options: [{ id, col, row }] }` (option labels stay with whoever is asked), re-sent on (re)connect and cleared by `trigger:resolved`; Free Movement's reach goes out the same way (`kind: 'move'`, cleared by `pick:clear` when the mover closes it or is Done). `PickViewLayer` draws them — the target Range faint red and targets brighter red, a square pick lime, a reach dashed sky blue — and the one asked still picks on their own layer.
- **Tests and checks:** an interpreter test for Brambles and the obstacle labels; the movement playtest takes a move back; the reactions playtest checks a target pick's squares and Range, that a player who isn't asked sees it too, and the active range; the combat-map playtest checks a Player can't place even their own token. A browser run showed the palette staying put, the faint active range, the red board target pick (tapping Ana answered it, no panel opened) and the result, and a player's screen showing that same pick and Range.

### Play feedback batch 4 (decided, implemented)
1. **"Resolving".** While a fight's chain holds any job — a turn's start or end, a Commit's queued Actions, an Interrupt, triggers and their follow-ons, prompts waiting — a faint green plaque with a spinning icon sits at the bottom of the screen: not a good time to make Actions. It fades out over 200ms once the last of it resolves. The server sends `fight:resolving { sceneId, mode, busy }` when the chain starts and empties (`onChain`), and again to a (re)connecting viewer (`triggers.resolvingNow`). Client: `ResolvingPlaque`.
2. **"A different / another target" is enforced.** The content marks these selectors with `excludeBindings` (Left, Right!'s second hit, Stand Strong's second ally, Leap Out, Taunting's second and third Challenge, Frostbite), but the interpreter never read it, so the same enemy could be picked twice. A selector now leaves out whoever those bindings already hold (read before the new pick overwrites a binding of the same name). The other "different/another" texts are already handled by their own operations (unique choices, distinct token amounts and pool numbers, unique obstacle destinations). Test: Left, Right! asks [2, 3] then [3]; alone, the 2 damage has no target.
3. **Level up opens a window** (`LevelUpDialog`) listing what the next level brings, from the type's advancement track (every level, every track): the bonus die and HP per bar (old → new), each Feature with its rules, and every grant that needs a choice, with the choice right there:
   - a Super Move (from the Archetypes owned, not already taken);
   - a new Stance (Form + Style, with the Form's construct choice);
   - a new Archetype (its Fused ability; Villains where the track allows);
   - a new Form or Style (Frantic);
   - the Archetype upgraded at level 9 (picked if several qualify);
   - the Warrior's Path with Improved Warrior.
   "Level up" applies it all at once and is enabled only when every choice is made; "Later" leaves the level as it is. Both Level up buttons (the Experience box and the builder's Level step) open it.
4. **Super Moves by a tap.** Tapping a Super Move card uses it with a free pair of matching numbers, 3 or higher: the only pair at once, or a choice of pair ("5 + 5", "3 + 3") when there are several; a tapped die still works too. The card says when it can't be used and why ("Not now: not in Round 1", once per fight, the side's limit this Round, none at Featherweight), from `/api/fighter-state/:id`'s new `supers { round, usedByMe, sideUsed, sideLimit }` (`superStatus`); a tap then shakes the card with the reason. The book's limits are unchanged (from Round 2, once per fight per fighter, per side per Round by Cinematic Weight). The reported "Supers disappear from Round 2" wasn't reproduced; the cards now always stay listed with their state.
5. **Skip on every movement and target pick.** Prompts gain `skippable`; their bars and dialogs show Skip, which answers `'__skip'`: a Move, Teleport, push or pull, placement or space pick moves or places nothing, and a target pick picks nobody, so that step does nothing. A movement pick now asks even with a single landing, and a Challenger who is the only legal target is still asked (and can be skipped) rather than picked automatically. Save Yourself keeps its own Skip.
- **Checks:** interpreter tests (Left, Right!; the Challenger asked and skippable); the movement playtest skips a push; the browser showed the level-up window (Level up disabled until the Super Move is picked; saved as level 2 with it), a Super Move card's "Not now" and its shake, the Resolving plaque during a Commit and its fade, and Skip on the target bar.

### Play feedback 5 (decided, implemented)

Thirteen points from play, each pinned down with the user before work began.

1. **Obstacles: only your own.** `map_tiles.placed_by` is the character whose controller placed a tile: a Player's PC for a hand placement, the fighter's character for one an Action or Ability placed, NULL for the GM's. Moving a square (all of its tiles must be yours) and removing a tile are refused for anyone else; the GM always may. Destroying a Wall or Rubble by hand stays open to everyone, and so does placing. The stage sends each tile's `by`, so the client doesn't start a drag it can't finish and shows "Placed by someone else" in place of Remove. Snapshots keep `placed_by`.
   - **The obstacle lock:** a small lock button under the Map Tiles button. **Personal**, kept on the device (`localStorage vtt.obstacleLock`): while on, your own drags don't move placed obstacles; placing new ones still works.
2. **Pinch to zoom** on the Combat map: two fingers on empty map zoom about their midpoint and carry the map with it.
3. **The camera may leave the arena.** The map pans at any zoom (dragging empty map, no longer only when zoomed in) until a strip of it is left on screen (a quarter of it, at most 120px). Zoom runs 0.5× to 5×; Fit resets.
   - **Not done: Simple Combat lanes.** The lane view has no camera at all (it is drawn onto the Scene stage), so pinch and pan there need a camera built first. Open.
4. **The resolve stack.** `fight:resolving` carries `steps`. The plaque reads "Step 2 of 5 · Jab"; a tap opens the list (done ticked, the current one spinning, queued below). A Commit queues every placed Action up front; a turn's start ("Start of turn"), the End Phase, the Action Phase and a fight's start are steps; a triggered Ability joins when it does or asks something, placed before the queued steps, so the total grows as things arise. An Action declined at "no valid targets" leaves the stack.
5. **Initiative is rolled once.** `repeatRound` (initiative.js) builds each later round from the last: leavers drop out, someone with fewer turns loses their last ones, new fighters and new turns go to the end. **The GM drags entries on the rail** by a grip (`moveEntry`, `fight:reorder`), ignoring alternation; the current turn can't be dragged. The new order holds for every following round.
6. **The only legal target is the target.** A pick that must be made (not a "you may", not an "up to"), of one, with exactly one candidate, asks nobody — units and squares alike (a Move, Teleport, push or pull with one legal square). This revises batch 4's "Skip on every pick": Skip stays wherever there is a choice.
7. **Mastermind Style is automated.** "You cannot perform Actions. Instead, you pay their costs, but make your allies perform them for you": at Commit the Mastermind picks an ally they can see (one: no asking), and the Action runs as that ally — their square, range, Stance and Abilities — while the Mastermind pays and answers every choice. A notice says who performed it. Limits count on the Mastermind's list. "After each Action an ally performs during your turn, you may Move 1" now fires (the world's active character was not set during a Commit, so every "during your own turn" rule missed it — fixed). No ally in sight: not performed, the dice stay. Super Moves and Copied Actions are not delegated.
8. **"No valid targets".** Before anything is paid, an Action whose every target pick is empty right now (`hasNoTargets`: the picks that can be judged up front, not those measured from an earlier pick) asks "perform it anyway?". Yes performs it; No takes it off the board, its dice free again, and the rest of the Commit goes on.
9. **The Action button.** At the bottom of the screen for whoever controls the fighter whose turn it is (the GM: always; after Heroic Spirit, the ally). It opens the same dice board. The Stance roll's dice in the chat no longer open it.
10. **Taken Out at zero HP.** The book's text could not be re-read here (the PDF is not in the repo), so this follows what the content quotes from it: "If you heal someone at zero HP, they revive immediately, and may take turns and be attacked by enemies again", and "Abilities do not work while you are Taken Out".
    - Enemies can't target them, for anything; their own side can (healing revives).
    - Their Abilities are off, continuous ones included — except at the start of their own turn (the Angel "cannot be Taken Out by HP loss": her heal runs; the Teacher still gains Mentor Tokens), on falling to zero (A Warrior's Death) and when giving Heroic Spirit.
    - They take no part in Early or Late Movement. They already took no damage and gave their turn through Heroic Spirit.
    - The token is half transparent and grey, with the skull.
    - **Assumed, to confirm:** they stay on their square and still fill it (healing needs them in range).
11. **Walls and Rubble are targeted as enemies.** Any pick whose target is then dealt damage offers the Walls and Rubble in range beside the enemies (never Traps, Fog or Pits). 2+ in one hit breaks it (a Wall leaves Rubble); less says so and does nothing. Every other step skips an obstacle target (no tokens, no push).
12. **Notch padding** on the dice board and its payment dialog: the safe-area insets, which are zero on a desktop.
13. **Fatigue is only about your own movement.** It never touched a Push or Pull; the notice that said so was a leftover line from an earlier movement that found nowhere to go (now flushed). A Move an enemy makes you take ignores Fatigue (`byEnemy`). The token is spent when the movement happens or when it left none, not when the mover skips.

- **Tests and checks:** unit tests for `repeatRound`, `moveEntry`, Walls as targets, Taken Out targeting and `hasNoTargets` (455 pass). `scripts/playtest-batch5.mjs` covers the Action button's board, the stack, Mastermind, "no valid targets", Taken Out and the repeated order; the fights, map-tiles, reactions and turn-triggers playtests were updated. A browser run at desktop and phone size showed the button, the lock, the rail drag, the panned map and the padded board.
- **Known:** `scripts/playtest-npc-assign.mjs` has failed since batch 3 made placing a token GM-only; it needs updating.

### QA pass: everything automated (decided, implemented)

The user's standing rule: **nothing is left "by hand"** — the core rules are fixed, so custom code is worth writing for any of them. Every Stance part (Form, Style, Freestyle), Archetype, Feature, Super Move and token mechanic was checked against its printed text, and every rule the census left to people was given an automation. **The census is 100%: 238 of 238 triggered Ability rules, 68 of 68 lasting ones, 183 of 183 Actions, 34 of 34 Super Moves.** This supersedes every "Not yet" / "by hand" list in the phases above.

- **How it is proved:**
  - `server/test/allRules.test.js` runs every Ability rule, Action and Super Move through the interpreter against a full fake world, every question answered, at a low and a high Gate. Nothing may throw, and nothing may come back by hand.
  - `server/test/coverage.test.js` holds the census at 100% (the floor), and `server/test/qaPass.test.js` pins each new rule.
  - A text-vs-data audit (each number printed in a rule found in its data) flagged nothing real.
  - All 32 fight playtests pass.
- **Bugs found and fixed:**
  - Nothing Personal crashed on its target (a `select` of a ref, the Challenge holder's id).
  - The token mechanics were never attached to their owners. Training Style's Training tokens, Control Form's Control, the Underdog's Luck, the Phantom's Poltergeist, the Teacher's Mentor and the Blur's Rapid Strike Action never ran or showed. They now come with their Form, Style or Archetype (`build.js`).
  - Lasting rules ignored their own conditions: Mad Style's Knife and Pistol, Fullmetal's Tracer ammo, Hidden Style in Fog and Vortex Style on a Pit applied all the time. `modifiersOn` now checks the condition (`world.ruleHolds`).
- **Interpreter (`interpreter.js`)** — new operators, selectors and steps:
  - Operators: `lookup` (Singing Style's Mood token); `within_range_of_self_or_copies` (Rallying); `within_stance_range` (Hypnotic Gaze); `enemy_shares_space_with_obstacle` (Telekinesis); `choose_integer` (Ka-Boom!, Immortal Army: asked where the number is used); `adjacent`.
  - What an Action did: `history.targets` (each target once), `history.obstaclesDestroyed`, `history.shieldBroke`, `history.lastDestroyedSquare`. The Action events carry `actionTargets`, `distinctTargetCount`, `enemyTargets` and `obstaclesDestroyed` (Crystal, Whip and Explosion Style). `self.throw_or_grapple.resolved` (Whip) and `event.controlledActor` (Control Form, Grave Freestyle) are new.
  - Ranges measured from what happened:
    - `on_or_adjacent_to_destroyed_obstacles` (Explosion Style);
    - `adjacent_to_event_action_target` (Crystal Style);
    - `adjacent_to_destroyed_copy` (the Swarm);
    - `within_placed_obstacles` (Darkness Dawns);
    - `origin: any_previous_target` (Open the Path).
  - Selectors and picks:
    - `inFog` (Twilight Sorrow, Ghost Walk) and `standingOnAnyObstacle` (Poltergeist Panic);
    - `inPlay: false` (Rescue);
    - `includeAdjacentToTargets` (Flamethrower at 4 Power);
    - `selector_by_gate` (Rip Chord, Flamethrower: the selector of the highest Gate reached);
    - `bindings.x.one` (Walled In: one of the Walls placed, picked);
    - a `select` given a ref resolves ids to fighters.
  - Steps:
    - `ensure_target`: Protect's Contain options share one enemy.
    - `joint_choice`: Sing Along and Diss Track. At the higher Gate the target picks their own option on their own screen (`ctx.askAs`).
    - `duplicate_token`: Syphon; its pick is of your own tokens.
    - `reduce_shield`: Aura Surge.
    - `return_to_play`: Rescue.
    - `remove_from_play`: My Final Technique. Out for good: no Comeback, no Rescue.
    - `pull_until`: First Aid.
    - `replay_start_effects`: Mood Shift runs your `own_turn.start` rules again.
    - `move_obstacles`: Poltergeist Panic, each Rubble or Trap moved where picked, never stacked.
    - `become_taken_out`: zero HP already is.
    - The open-ended `repeat`: Dancing Mad, "again?" after each, ending after the same enemy is hit twice.
  - Push and pull now move obstacles too (`world.forcedObstacle`: Telekinesis, Shining Style). Pushing yourself is never resisted with Iron (`willing`). A swap with an obstacle trades spaces (`world.swapWithObstacle`).
- **Lasting rules now enforced** (`modifiers.js ENFORCED_RULES`):
  - **Targeting:**
    - Blaster Form and Amplify: one extra target within the Stance's range, once per Action (`ctx.extraTargets`).
    - Whip Style: Throw within range. Ogre's Style: Throw any number of enemies within range.
    - Relentless Style: enemies holding your Challenge are always within your range.
  - **Movement** (`engine/board.js`, set per mover by `moves.js boardFor`):
    - Shining Style: enemies can't enter a space next to it.
    - Parkour: Walls are empty to you.
    - Spirit Style: Walls are Rubble to you (Fatigue, and the move stops there).
    - The Giant: moves over Walls, which become Rubble, +1 Fatigue.
    - Weightless: every space is empty.
    - Vortex Style: from a Pit, every Pit is one step away.
    - Caged Style: Action Movement is zero.
  - **Tokens and costs:**
    - Machine Style: Iron spent as Power or Speed.
    - Unbreakable Style: allies in range spend your tokens.
    - Both go through `world.spendable` and `world.spend`, everywhere tokens are spent: hits, Free Movement, Save Yourself and payments.
    - Elder Style: token costs −1 (never below 2), and a number counts one higher against a dice Action's costs and Gates (`diceBoard.costBonus`).
    - The Untouchable: Dodge costs 1 (the content's one "requires a ruling", read plainly).
  - **Copies:** Mirrored Style's Copies have 2 HP, and its Iron reduces hits to them.
  - **Weapon Throw:** the disabled Weapon can't be chosen again until your next turn.
- **Costs** (`tokenCost.js`, `engine/actions.js`):
  - Luck pays in place of up to 3 Basic tokens, HP or Shield each. It covers what is missing; you are asked whether to use more.
  - Roughhousing's optional extra 2 or 4 Basic tokens are asked at Commit (`payment.additionalBasicTokens`).
  - Bag of Tricks's "one or more" costs: the placed die or tokens are the first, the rest are offered at Commit, and X is how many were paid.
  - Token costs are paid through the world, so HP paid counts as HP lost.
- **Native in the engine** (`coverage.js NATIVE_RULES`; their data rule is never run):
  - Mythical Freestyle: a d12 of 3 or less is re-rolled at the turn's start.
  - Persistant Freestyle: up to two numbers totalling 5 or less are kept at the turn's end and come back next turn.
  - Poltergeist tokens (`actions.js poltergeist`): up to 2 more per Action (3 under Arcana Install). X counts the cost's own. The X choices are:
    - +1 to up to X listed numbers (never damage or choices);
    - Range +X;
    - teleport X first, or Rubble into X spaces first;
    - 1 damage to X enemies after, or Push 1 / Pull 1 to X previous targets.
  - Improved Frenzy: once per Round after the dice, change Style or Archetype. The dice stay; the Stance and its Abilities change.
  - Greater Frenzy: once per fight, a second Frantic Ability for the turn (`frantic_pick.abilityId2`).
  - Showdown: settled when the next turn of the target's side starts (`schedule at: target_side.next_turn.selected`).
  - Transcendant Spirit: offered when giving Heroic Spirit. The ally's dice give their maximums, an 8 is added, then Shield 4 and a heal; it counts as the Super Move of the fight and of the side's Round.
  - Deadly Trap: 3 damage.
- **Built by the builder** (`coverage.js BUILD_RULES`, `build.js`):
  - The Machine: each Stance has a second Form (`form2Id`; both Forms' dice and Abilities, never a green die). Freestyles give a warning.
  - Greater Focus: the original Archetype's Fused Ability is added to the Focused.
  - Greater Fusion: the chosen Fused Archetype (`greaterFusionId`) becomes Focused.
  - Improved and Greater Frenzy: one new Frantic Ability each, from an Archetype not yet had (`bonusFrantic`).
  - Improved Warrior: the Warrior's Path choice, applied at the start of combat.
  - The Archetype step shows these choices as soon as the level grants them; missing ones are warned.
- **The Giant's 2×2** (`board.js cellsOf`, `nearestCells`): it fills four squares, needs all four empty to move, and Range counts from its nearest square. The stage sends `size` and the map draws it 2×2. On Simple Combat lanes it is one space.

## Open items to decide later
- **Panic at the Dojo assistant — details to settle in their phase**, with the default the build will use unless told otherwise:
  - **Turns per round once bars break:** settled (decided, revised): the book's rule, every bar keeps its turn. See Phase 5 as built.
  - **Simple Combat with more than 10 fighters:** the lane stays at 10 segments; extras wait in an off-lane tray.
  - **Joining or leaving mid-fight:** a fighter placed or removed after Start Combat joins (at the end of the order) or leaves from the next round.
  - **End Combat** (GM): clears that mode's initiative; placements, HP and tokens stay until the GM clears them.
  - **Shield — implemented (decided, new):** a special token after Armor (`shield`, cap 8, the book's Shield Cap; per-token caps via `capOf`). It **absorbs damage (decided, revised; was tracked by hand)**: damage from an Action or Ability hits the Shield first, up to its value. A Shield used up breaks and the rest hits HP (`absorbWithShield` in `panicTokens.js`). Ability damage from the trigger engine absorbs this way and emits `self.shield_absorbed`. For an Action's hit, the token panel has **Take damage** (a number and a button), which sends `fighter:damage { ref, amount }`. Outside a fight it is applied directly. In a fight the trigger engine applies it on the fight's chain: the attacker is the active fighter when they're on the other side, and `self.shield_absorbed` plus `self.shield_absorbed_from_enemy_action { attacker, amount, shieldBroke }` run, so **Thorns Form** deals 1 back, or 2 if the Shield broke. A notice reports it. HP "−" / "+" stay raw HP changes (costs, fixes) and never touch the Shield. Traps and HP costs go past it. It is also drawn on the HP bar as a **blue extension** after the bar, as long relative to the bar as the Shield is to the current bar's Max HP. The two share the bar's width (flex 1 : ratio), so the proportion holds and the panel keeps its size. The full panel prints the value in it. Only a damage Shield is modelled, not the book's Status-token or "Nothing" kinds. **Since full automation phase C** the Shield is one step of Damage Resolution: a player is asked before it blocks (Ask by default; Auto and Never on the sheet), and Burning hits it too.
  - **Armor — implemented (decided, new):** a special token, `armor` in `panicTokens.js`'s `SPECIAL_TOKENS`, shown for every fighter in the token row just **after the Challenge slot**. It is a count like any token (how many sources of Armor the fighter has), with the same +/−, quick spend and cap. The book's rule (p.24) is in its description: each turn the first hit is reduced by 3, a second source by 2, the rest by 1. It works on any damage, including Fall, Burning and Traps, but not on HP costs. **Since full automation phase C it is applied automatically** in Damage Resolution, and temporary Armor is its own binary token (`temp_armor`).
  - **Cinematic Weight extras** not tracked yet: the Bleed Ability at turn start, Complications (Guest Heroes, Uneven Fights, Stooges). (Super Move limits per round are enforced since full automation phase I.)
- **Pre-pivot standalone Counters** still in the database (the Arena's): delete them, or give them a home in the new system.
- **`combatants.notes`, `combat_stances.note_left/note_right`** are unused leftovers of the removed token notes; harmless, removable whenever those tables next change shape.
- **`chat_log.move_id`** is an unused leftover column; harmless, removable whenever `chat_log` next changes shape.
- **Relationships "Planned, not yet built"** items (see that section).

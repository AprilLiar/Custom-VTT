# Dogfight: Martial Arts TTRPG — Project Plan

## Overview
A small, self-hosted virtual tabletop for one group (DM + players), accessed remotely over the internet from multiple devices simultaneously. No login system — one shared link, everyone sees everything within their role. Presentation-focused, fighting-game visual style. Core mechanic is a stepped dice-pool system tied to character HP/actions.

## Roles / access model
On every fresh page load, a modal asks who's playing: a **GM** button (unchanged position, right side), or — on the left — a scrollable **"Play as…"** list of every PC, picking one logs in as that specific character. This is still a client-side display filter, not authentication — there's no login, no password, and anyone can technically pick anyone's PC (same trust model as everywhere else) — but it's now a real enough identity that the server tracks it per-connection (`identity:set`, see Combat Timing below) so it can actually tell whose declared moves to reveal early, closing what used to be an accepted "no-login Tell secrecy" gap (see Known risks to watch, below).
- **Player (picked a character):** character list (the Role Modal's own "Play as…" picker) shows only characters with `character_type = 'pc'` to pick from at the door. **Decided (revised):** once in, a Player no longer browses the character-list *page* at all — the header's roster link is relabeled **Character** and, along with the `/` home route and any unknown route, goes straight to that Player's own sheet (`/character/:characterId`, see Pages / views below) instead of the roster grid. This is still just nav discoverability, not a hard lock: direct-URL access to another character's sheet (typing/pasting `/character/:id`) remains unrestricted, same trust model as everywhere else in this no-auth app — a Player simply has no in-app link that leads anywhere but their own sheet anymore. One real side effect: since the character-list page (and its "+ Add Character" form) is no longer reachable by a Player, a Player currently has no UI path to create a new character — an accepted consequence of this change, not a separate restriction.
- **GM:** character list shows all characters (`pc` and `npc`). Character creation form includes a PC/NPC toggle. Can view/edit anything.
- The choice is not remembered — it asks again on every reload, and there's no in-app way to switch identity without reloading. The chosen identity is re-sent to the server on every socket reconnect (a Render cold-start, a dropped connection mid-session), since the server only keeps it in memory per-connection, not persisted.
- This restriction is about **who can control which characters**, not about hiding activity: rolls, inventory/injury updates, stance changes, etc. are broadcast to and visible by everyone regardless of role — a Player sees an NPC's roll just like anyone else's. The only things actually restricted for Players are the character-list page itself (now unreachable via nav for a Player at all — see above — and, on the rare occasion it's reached, still only PCs are listed/openable) and creating/editing NPCs — both GM-only. The Combat Arena is a deliberate exception to even that: NPCs placed there become visible to Players too (see below). Declared-move visibility during combat is the one place identity now actually matters server-side — see Combat Timing.
- **Character-list folders are GM-managed** (decided): only the GM creates/renames/deletes folders and drags characters into them; Players just browse whatever folders the GM has set up (same nested folder nav, same drag target for the GM, but no create/rename/delete controls or drag handles rendered for Players). This is the one organizational feature that's GM-only in the same way NPC creation is, even though folder contents themselves aren't secret. **Character folders nest (decided)**, mirroring Move Disciplines: `character_folders.parent_id` self-references to any depth; creating one while another is selected nests it inside; deleting one promotes its direct characters and direct child folders one level up to its own parent (root if it was already at root), not unconditionally to root, and the client follows the currently-viewed folder up to that same parent if it's the one being deleted.

## Stack
- **Frontend:** React + Vite, Tailwind CSS, Framer Motion (transitions/layout), GSAP (impact/roll effects)
- **Backend:** Node.js + Express — also serves the built frontend (single deployable app)
- **Real-time:** Socket.io
- **Database:** Turso — free, hosted, SQLite-compatible (libSQL), no credit card required. Used instead of a local SQLite file because Render's free tier has no persistent disk; same SQL, same schema. **Accessed through an embedded replica with offline writes, so neither reads nor writes cross the network on the request path — the local file is the truth of the moment and the primary is an asynchronous copy of it, pushed every 10s (decided, new — see Database round-trips below).**
- **Hosting:** Render — free web service tier, no credit card required. Supports WebSockets natively while active. Tradeoff: the free tier sleeps after inactivity, so the first connection after a quiet period takes ~30-60 seconds to wake up (a one-time delay at the start of a session, not an ongoing issue).
- **Access:** one shared URL, no auth, no per-player restrictions
- **Mobile:** installable PWA (manifest + service worker, see Mobile Readiness below); Playwright (`@playwright/test`) drives a 5-project mobile device matrix (`playwright.config.js`, `e2e-mobile/`) alongside the existing `node --test` server suite

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

**Phase 0 — the embedded replica (shipped).** `createClient({ url: 'file:replica.db', syncUrl:
TURSO_DATABASE_URL, authToken })` keeps a full copy of the database on the server's own disk. Reads
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

**Phase 5 — writes go local too (shipped, and it corrects the four phases above).**

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

## Game mechanic — Dice Pools (Core Stats tab)
Each character has 3 fixed dice pools, always the same slot names for every character:

| Pool | Slots |
|------|-------|
| Head | Skull, Brain |
| Core | Left Hand, Stamina, Body, Right Hand |
| Legs | Left Leg, Right Leg |

- Each die can be rolled individually (opens a dialog asking for an ad-hoc +/- modifier for that roll, clamped to ±20), or via **Pool Roll**: a single button on the sheet enters selection mode, where any set of that character's active dice — across Head/Core/Legs alike, not one body section at a time — is picked and rolled together with one shared +/- modifier.
- Each die has a green up-arrow and red down-arrow next to it to step its size: d4 → d6 → d8 → d10 → d12.
- Stepping up past d12: size stays at d12, and a permanent bonus stacks instead (d12 → d12+1 → d12+2 → ...). This bonus is added to every future roll of that die.
- Stepping down from d12+N: the bonus is reduced first (d12+2 → d12+1 → d12 → d10 → d8 ...); only once size is back to d4 with no bonus does the next down-click incapacitate the die.
- Incapacitated: die is greyed out and shown as scratched-out; can't be rolled or stepped further down. Clicking the up-arrow on an incapacitated die revives it to a normal d4 (size 4, bonus 0, active).

## Game mechanic — Stamina & Stat Lock (Core Stats tab)
Each die tracks two states: its **current** value (fluctuates during play) and its **locked** value (the "fully rested" baseline).
- **Lock in Stats** — snapshots every die's current size/bonus/status as the new locked baseline for that character. Persists indefinitely until pressed again (stored in the DB, not session-based). Unaffected by Injuries (below) — always a verbatim current→locked copy.
- **Revert Stats to Base** — resets every die's current size/bonus/status back to its locked baseline, **with any Injury penalties on that slot re-applied (decided, new rule)** — see Injuries below. Not a raw copy of the locked row when the slot has one or more penalizing Injuries. **It clears `half_damage` too (bugfix).** That flag is not a size — it is half a step of damage already taken, waiting for its other half (see `applyHalfDamage`) — and reverting used to write size/bonus/status back while leaving it standing, so a Stat that read as fully restored still took its next hit twice as hard. Reported as "revert stats to base does not heal half damage". The locked baseline has no `half_damage` of its own by construction (a base value is a whole value), so reverting always clears it rather than restoring some remembered flag.
- Locking/reverting only affects the 8 dice — Current Stamina is tracked independently and is untouched by either button.
- **Visual tint per die:** compare current vs. locked using a rank (d4=0, d6=1, d8=2, d10=3, d12=4, then +1 per bonus point beyond d12). Above locked → green tint; below locked → red tint; equal → no tint. Tint opacity scales with the size of the difference — bigger gap, stronger tint.
- **Injuries affecting base stats (decided, new rule):** an Injury (Core Stats tab's Injuries list — see Pages / views below) can optionally target one of the 8 die slots with an integer rank penalty (`injuries.slot_name` + `injuries.penalty`; `rankOf`/`applyRankPenalty` in `server/gameLogic.js`, same rank unit the tint above already uses). The penalty is **never applied live** — only **Revert Stats to Base** applies it, subtracting however many ranks that slot's Injuries sum to (more than one Injury can stack on the same slot) from the locked size/bonus, floored at incapacitated rather than going negative (same floor manual step-down already hits at a bare d4). Because this only ever pushes the reverted-to value *below* the true locked baseline, it shows up automatically via the existing red tint above — no new client-side visual code needed. Max Stamina is **not** recomputed on revert (matches "Current Stamina untouched" above) even when the penalized slot is Stamina — only the die's own size/bonus/status reflect the penalty.
- **Any Stamina change animates (decided, new rule):** Current Stamina's displayed number always plays the same "bigger and vibrating, falling back down" pop (`PopNumber.jsx` — a `motion.span` keyed on the value, scale 1.35→1 with an amber/yellow flash, `duration: 0.35`) whenever it actually changes — 1 free Stamina per idle Tic, automatic per-round regen, the manual `stamina:regen` roll, a move's Stamina Cost being spent/refunded on Done Declaring, and a manual `stamina:adjust` alike. Always the same yellow flash regardless of spend vs. gain — the point is "this number just changed," not which direction. Originally bespoke to this tab's own Stamina number; now the one shared component reused everywhere a Stamina value is shown (this tab and the Combat Arena's participant cards alike).
- **Maximum Stamina** = `stamina_multiplier × (locked Stamina die's size + locked Stamina die's bonus)`. The multiplier defaults to 4 but is stored per-character (not hardcoded), so future Perks can change it without code changes. Recalculated whenever stats are locked. Current Stamina is clamped down if a re-lock lowers Max Stamina below it.
- **Current Stamina** — tracked independently, starts at Max Stamina for a new character. **Automatic per-round Stamina Regen (decided, new rule):** every round from the 2nd on, `combat:next_round` itself rolls each seated character's Stamina die at its *current* size/bonus and adds the result to Current Stamina (clamped to Max) — automatically, for everyone at once, no button press needed. Round 1 (Start Combat) is the existing full-restore instead (see Combat Timing below), so there's nothing to regen there. This coexists independently with Idle-Tic Stamina Regen below — both are separate sources that just add to the same Current Stamina. The `stamina:regen` button (`{ characterId }`, see Real-time events below) still exists as a manual one-off roll on top of this, e.g. to top up mid-round outside the normal cadence. How Current Stamina is spent/reduced during play isn't defined yet — depends on the Moves tab.
- **Idle-Tic Stamina Regen (decided, new rule):** during the Tic Countdown, a seated character regains **+1 Stamina** for every Tic that's completely empty for them — no Startup, Active, Recovery, or carryover from any of their own declared moves covering that Tic at all (`isTicIdle` in `server/combatTiming.js`, checked against their full footprint set regardless of which round declared it). Evaluated once for every Tic as the resolution engine reaches it (see the Resolution Phase below) — exactly once per Tic, in order, since nothing steps backward any more. **Modular by design (decided):** the base rate is 1 idle Tic per Stamina point, but a per-seat running count (`combat_participants.idle_regen_progress`) tracks progress toward whatever rate is actually in effect for that character — `perkAutomations.js`'s `IDLE_STAMINA_REGEN_HOOKS` map (parallel to `PERK_HOOKS`, see Perks & Tags below) lets a future Perk require more idle Tics per point instead (e.g. 1 Stamina for every 2 Tics spent blocking) by adding an entry keyed by its exact name; empty for now, since no such Perk exists yet. A character already at Max Stamina is skipped entirely rather than silently banking progress they can't spend. `idle_regen_progress` resets to 0 when combat ends (`combat:end`) or the seat is cleared (`combat:clear`/leaving the arena).

## Game mechanic — Stances (Stances tab)
Each character builds their own stances via an in-sheet **Stance Creator**; stances are not shared between characters. **Decided (revised): the 2 styles are picked by clicking directly on the counter-chart graph** (see below), not from a separate list/chip picker — the Creator renders the same `StanceGraph` the tab already shows for browsing matchups, with an `onNodeClick` handler and a larger invisible hit-circle per node for easier clicking; a hint line shows the running "X/2 selected" count. Clicking an already-picked node deselects it; a third click while 2 are already picked is a no-op until one is freed up.
- A stance is a name plus exactly 2 styles (attributes), chosen from the fixed pool of 7 — seeded once as core ruleset, not editable in-app. The **final list** (decided): Speed, Power, Improvisation, Technique, Keep-out, Defensive, Close-Quarters. Each style has an assigned open-source icon (lucide, stored as an icon name on the attribute row) shown throughout the UI.
- The 7 styles form the **2-Paradox tournament**: a complete tournament — every pair of styles has a winner, so each style defeats exactly 3 others and is defeated by the remaining 3 (21 seeded winner→loser pairs). The full defeats table:

  | Style | Defeats |
  |-------|---------|
  | Speed | Power, Improvisation, Keep-out |
  | Power | Defensive, Improvisation, Technique |
  | Improvisation | Technique, Keep-out, Close-Quarters |
  | Technique | Speed, Defensive, Keep-out |
  | Keep-out | Power, Defensive, Close-Quarters |
  | Defensive | Speed, Improvisation, Close-Quarters |
  | Close-Quarters | Speed, Power, Technique |

- Counter bonus (**decided, revised**): **+1 for each enemy style you are strong against, −1 for each you are weak towards** (the same seeded edge read from the loser's side). A stance is two Styles, so a matchup compares 4 cross-pairs and at most 3 of them can be wins — an ideal counter-pick is therefore a **+3/−3 edge, a 6-point total swing** between the two sides, not the ±6/12-point swing the original +2 produced. That earlier value let a counter-pick decide a roll outright rather than tilt it. The value lives in one place (`COUNTER_BONUS` in `server/ruleset.js`) and is seeded into `attribute_counters.bonus`; because that table only seeds when empty, `initDb` also re-points any row still carrying the old default at the current constant — deliberately scoped to that one previously-shipped value rather than a blanket UPDATE, since `bonus` is per-row precisely so a table can hand-tune an individual matchup. Styles are also expected to carry their own mechanical benefits eventually — structure TBD, schema kept extensible for it.
- A character's Stances tab lists all stances they've created; left-clicking one makes it that character's **currently active stance** (exactly one at a time, mechanically relevant — not cosmetic). This is tracked per-character and broadcast live, so it's visible to everyone (including opponents), Pokemon-switch style. The active stance also shows as a badge on the sheet header, and (Phase 6) in each participant's Combat Arena summary.
- **No deactivation** (decided): the active stance can only be switched, never turned off. Every character should keep at least one stance with one active at all times — the first stance created auto-activates, the last remaining stance can't be deleted, and deleting the active stance auto-activates a surviving one. (A brand-new character has none until their first is created — the tab nudges for it.)
- The Stances tab shows the **counter chart** to everyone: a vector (SVG) graph of the 7-style tournament that blends with the UI, arrows pointing winner → disadvantaged. When a stance is active, its two styles are highlighted — green edges for matchups it counters, red for matchups that counter it — plus **Best/Worst Matchups** lists: enemy style-pairs ranked by net score (sum of ±`COUNTER_BONUS` across all 4 cross pairs; a style shared with the enemy pair contributes 0), top and bottom few shown.
- How the active stance's attributes actually modify rolls/outcomes beyond this scoring depends on the Moves tab (next), so full resolution logic is an open item until that's defined — the data (stances, attributes, counter bonuses, active stance) is modeled now so it's ready to plug in.

## Game mechanic — Moves & Tells (Moves tab)
- **Default Moves** (Block, Jab, Dodge, etc. — list still incomplete) are automatically available to every character, PC or NPC, with no granting step.
- **Unique Moves** are not present at character creation; the GM grants them individually.
- Both are created through the same GM-only **Move Creator**, just flagged `is_default` vs not.
- **Move structure (decided).** A move card renders top-to-bottom as:
  1. **Tell header** — a special header strip showing only the move's Tell (art + name), nothing else.
  2. **Name** (top-left, with the move's small uploaded art beside it) and **Frame Data** (to its right): a single line of adjoining squares — **Startup (yellow), Active (red), Recovery (blue)** — one square per Tic. Each segment is assigned 0-10 squares at creation (at least 1 total); the card just renders however many exist (e.g. Startup 3 / Active 2 / Recovery 1 → 6 squares). Combat meaning: placed on Tic *N*, the move charges up through its Startup squares, actively hits through its Active squares, then its Recovery squares carry over — eating into the next round if they run past the round's end. **Defense Frames (decided):** a 4th, **green** annotation that can mark *any* individual square in that same sequence — mid-Startup, mid-Active, or mid-Recovery — as also granting a defensive window, via `moves.defense_frame_positions` (a JSON array of 0-based indices into the full Startup+Active+Recovery sequence, `sanitizeDefensePositions` in `server/moveLogic.js`). This is purely a display/annotation layer on top of the existing Startup/Active/Recovery totals, **not a 4th timing phase** — it never changes `startup_tics`/`active_tics`/`recovery_tics` or touches `combatTiming.js`'s placement/reveal/overflow math at all. In the Move Creator, the live frame-bar preview itself is the editor: click any square to toggle its Defense tag on/off (`FrameBar`'s optional `onToggle`); shrinking a frame count filters out now-out-of-range tags at render/submit time without discarding them from state, so re-growing the count undoes the shrink cleanly.
  3. **Style and Tags chips.**
  4. **Description** text.
  5. **Special interactions** — three categories always available: **On Hit / On Block / On Miss**. Each holds free text plus optional **automations**, limited to exactly four types for now: add/remove Recovery on yourself (±), add Recovery to the opponent, lose additional Stamina yourself, or the opponent loses Stamina. Anything else stays text-only, adjudicated at the table. Automations are stored/displayed now; they execute in the combat phases. A move flagged **Defensive** (`is_defensive`, decided) gets two more categories at the bottom of the same list — **On Successful Defense / On Failed Defense** — with the identical text + automation editor; a move that isn't Defensive never has these two, and switching Defensive off and re-saving drops any previously-stored rows for them (they're simply no longer accepted by the normalizer, so a wholesale `move:update` — which always replaces every interaction row — just doesn't recreate them). A category (any of the five) is only ever stored, and only ever rendered on a move card, when it actually has non-whitespace text or at least one automation — a category with neither simply doesn't exist for that move. Defensive moves show a small "Defensive" badge next to their name.
- **Images, not icons**: Moves and Tells each carry a small uploaded picture (commissioned simple art, uploaded by the GM through the Tell manager / Move Creator; resized client-side to ≤128px, PNG transparency preserved). Until uploaded, an initial-letter placeholder shows. Only the 7 styles keep open-source (lucide) icons.
- **Style (decided)**: every move is assigned one of the 7 styles (required in the Creator; rows created before this rule may be NULL = unrestricted). No mechanical modifier — it gates two things: **learnability** (a Unique move can only be granted to a character who has at least one stance containing that style — enforced server-side on grant and shown in the Grant checklist) and **usability** (a move is only usable while the character's *active* stance contains its style — unusable moves render dimmed on the Moves tab). Already-granted moves are kept if stances later change; they just show as unusable. **A Default move never has a Style (decided):** since a Default move is auto-available to every character regardless of stance, giving it a style would be meaningless — the Move Creator hides the Style picker whenever the Default toggle is checked (checking Default also clears any style already picked) and shows a note instead; the server enforces this too (`writeMove` forces `style_attribute_id = NULL` whenever `is_default` is true, ignoring whatever the request sent), and a validity check requires either Default or a picked Style before a move can be saved. A one-time migration nulled `style_attribute_id` on any pre-existing Default rows that had one.
- **Combat Style (decided, new — the move's own style)**: a **second, always-optional** style field on a move (`moves.combat_style_attribute_id`), distinct from the Style *gate* above and never a substitute for it. Where the gate says *who may learn and use this move*, the Combat Style says *what the move is made of*: when the move rolls, its style is **added to its user's active stance** for the Stance matchup, so three styles are scored against three instead of two against two (`matchupStyles` in `client/src/lib/matchups.js`). **Duplicates are the point and are deliberately kept** — a Strength move thrown from a Strength/Technique stance scores as `[Strength, Technique, Strength]`, so every cross-pair involving Strength counts twice and that style's half of the matchup doubles, *for better or worse depending on what it is facing*. A style whose net against the opposing stance is already 0 doubles to nothing, and a style the opponent also holds cancels as it always did — the duplicate is inert, never a self-counter. Nothing downstream may de-duplicate either side, which is why the pure helper and its tests exist rather than an inline `[...stance, style]`.
  - **Both sides count their own move (decided).** A styled attack met by a styled guard is scored as what *both* fighters are actually doing: each fighter's styles are their stance plus their own move's Combat Style. Which move counts is the one being rolled for when the caller knows it (every engine roll does — it rolls *for* a specific declared move), and otherwise whatever that fighter is visibly doing at the Tic: their revealed declared move whose footprint still covers it, freshest first. A move that hasn't revealed contributes nothing — it would leak, and it isn't out yet.
  - **Not on Initiative (decided).** The round's Initiative Brain roll passes `includeMoveStyles: false`: it is not any move's roll, it happens as the round opens before anything is declared, and letting a move still running from last round tilt it would be a rule nobody asked for.
  - **Kept on Default moves (decided).** Unlike the Style gate — which `writeMove` forces to NULL on a Default move — the Combat Style survives there. "Anyone may throw this" is a statement about *who*, not about what the move is made of, and dropping it would put the whole mechanic out of reach of the moves every character actually has.
  - **The Tic must be passed in, not read (bugfix found building this).** `combat_pairs.current_tic` is written only *after* a Tic finishes processing (see `advancePairResolution`'s crash-recovery ordering), so during resolution it lags one Tic behind. Reading it to answer "what is the opponent doing right now" made the attacker's just-revealed move look like it wasn't out yet, and the **defender's** roll silently scored against the bare stance while the attacker's own roll — which passes its `moveId` explicitly — was correct. Every engine roll now passes its own Tic; only manual rolls fall back to `current_tic`, which is accurate precisely because no resolution is mid-flight when a human clicks a die.
- **Roll (decided, optional)**, configured directly below Style in the Move Creator: a move can specify which dice it rolls plus one flat bonus (±20) shared across the whole collection — mechanically identical to Pool Roll (one shared modifier across an arbitrary dice selection), just pre-configured per move. Most moves are expected to have one, but it's optional for scalability (e.g. purely narrative moves). On a character's Moves tab, a move with a Roll shows the character's *actual current* die for each configured slot as a clickable button (e.g. `Body (d8+3)`, the same combined-formula convention as the Chat Log), pre-filled with the move's bonus — its own flat bonus plus any Perk-granted `move_roll_bonus` for that move (see Perks & Tags: this is now the live use case for that automation) — but freely editable before rolling, in the same roll dialog used everywhere else. An incapacitated die among the configured slots is silently dropped rather than blocking the roll, exactly like Pool Roll. In the Compendium (no character context to resolve real dice against), the Roll shows only the static slot names and bonus.
  - **Roll slot vocabulary (decided, revised)**: 7 choices, not the 8 concrete dice — Skull, Brain, Stamina, Body, plus two **ambiguous appendage choices** (**Left/Right Hand** and **Left/Right Leg**) and **Weapon**, which names no die at all and resolves to whatever the character is carrying (see **Game mechanic — The Weapon** below). The GM doesn't commit to a side at creation time; the *player* picks Left or Right at the moment the move is actually rolled, on the character's Moves tab. If a Roll includes either ambiguous choice, ONE Left/Right pick governs the whole Roll — a move using both Left/Right Hand and Left/Right Leg resolves both together from that single choice (e.g. "Left" rolls the Left Hand die AND the Left Leg die), not independently per slot.
  - **An appendage slot may be taken TWICE, meaning both sides (decided, new)**: clicking Hand (or Leg) a second time in the Move Creator cycles it to **Both Hands** / **Both Legs** — the Roll then rolls the Left *and* Right die of that appendage together. This is what a Straight Block is: it guards with both hands. Two is a hard ceiling (a character has exactly two of each), and a concrete Stat — Skull/Brain/Stamina/Body — is one-of-a-kind and still caps at one; the Creator's button cycles off → one → both → off. **Taking a slot twice answers its Left/Right question**, so such a move needs only ONE Tell (not the Right/Left pair above), records no `appendage_choice` when declared, and is never asked which side to use. A move that takes Hand twice *and* Leg once is still ambiguous — about the Leg only. Storage: `move_roll_slots` keeps one row per distinct slot plus a `count` column (SQLite can't drop the table's `UNIQUE(move_id, slot_name)` without a rebuild, and every reader groups by slot anyway); rows written before that column read back as 1, so nothing needed migrating. `move_defensive_roll_slots` mirrors it exactly. Attack Target is unaffected — it is a *set* of Stats damage may land on, where "twice" would mean nothing, and Hand/Leg there already expands to both sides when no side is chosen. The Moves tab renders one Roll button per available side (e.g. `Right: Body (d8+3) + Right Hand (d10+3)` / `Left: Body (d8+3) + Left Hand (d8+3)`) so the player can see each side's actual current dice before committing; clicking either opens the roll dialog pre-filled exactly like a normal Roll.
  - **Ambiguous Roll needs two Tells (decided)**: a move using Left/Right Hand or Left/Right Leg needs a **Right Tell** and a **Left Tell** instead of the usual single Tell — the Move Creator swaps in two Tell dropdowns in that case. Since nothing commits to a side until the move is actually rolled, the move's Tell header always shows **both Tells side by side** (in the Compendium and on every character sheet) rather than picking one arbitrarily.
  - **Roll type — Stat vs. Custom (decided, new):** the Move Creator's Roll section starts with a Stat/Custom toggle. **Stat** is everything described above (`moves.roll_type = 'stat'`, the default). **Custom** replaces the whole body-part-slot picker with a single base die picked from d4-d12 (`moves.custom_roll_size`) — for weapons, whose damage die belongs to the item, not the wielder, so it shouldn't move when the wielder's own Stats change. The two are mutually exclusive and enforced server-side (see `move:create`/`move:update` below): switching types in the Creator clears the other type's own picks, and `writeMove` forces `roll_slots = []` for a Custom move and `custom_roll_size = NULL` for a Stat move regardless of what's sent. A Custom Roll has no character-die concept at all — no incapacitation, no per-character resolution — so its Moves-tab button always just reads `d{size}{+bonus}` and is always clickable; rolling it goes through `dice:roll_custom` (see Real-time events below) instead of `pool:roll`, including at reveal-time auto-Roll. The flat **Bonus** field is shared with the Stat type (still `roll_modifier`, still folds in any Perk `roll_bonus` into `effective_roll_modifier`).
  - **Attack Target (Change 001, decided, new):** every Move with a Roll also carries an Attack Target — which of the same 7 slots its damage may actually be applied to (Weapon among them, where it means something different — see The Weapon below). Full mechanic (multi-select, empty-by-default, Successful-Block replacement, server-authoritative enforcement) documented in its own **Game mechanic — Attack Target** section below, since it interacts with Combat Automation's damage/defense flow rather than move creation alone.
- **Tags (decided)**: each move carries 0-10 Tags, picked from the world-level GM-managed `tags` list (created/edited in the Compendium, like Tells — this pulls the base tag tables forward from Phase 4; per-character tag overrides via Perks remain Phase 4). Tags can also change dynamically later (Perks adding Tags to specific moves). A Tag has a **name and an optional description**; hovering a Tag anywhere it's shown (the Tag manager, a Move Creator's picker, a Move card) pops a tooltip with that description.
- **The Moves tab filters by Tell and by Tag (decided, new; later joined by Attack Target and Attack Roll — see the four-filter split).** Two multi-select-OR chip rows above the move grid, in exactly the Compendium's own filter language — picks *within* a row are OR'd, the two rows are AND'd, and an empty row is not applied at all. **Tell and Tag rather than the Compendium's Style and Tag:** on your own sheet a Style you cannot currently use is already dimmed and labelled, while "which of these opens with the shoulder drop" had no answer at all. Each row lists only the Tells and Tags that moves **on this sheet** actually carry — the Compendium is the library and shows the world's whole vocabulary, but a sheet is a hand of cards, and a filter that can only ever return nothing is worse than no filter. Both halves of an ambiguous move's Left/Right Tell pair count as that move's Tells, and a Perk's `effective_tag_ids` override is what a Tag filter reads, so the filter agrees with the chips actually printed on the card.

- **Compendium** — a persistent library of every move ever created (default and unique). **Decided (revised twice): Players can browse it, and can teach themselves a move from it** — folder nav, style filter, move cards, Tell/Tag tooltips all render the same as for the GM, and a **Learn / Forget** button on every *Unique* move grants or drops it on the Player's own character. Reading the library and being unable to act on it was the gap: the only route was asking the GM to tick a box on your behalf. Default moves are already everyone's, so they offer nothing; the style-learnability rule is unchanged and still enforced server-side, with the button saying why it is closed rather than silently refusing. **Forget** is offered as the undo — and it is offered **on the character's own Moves tab as well as in the Compendium** (decided, revised): taking something and putting it down are the same act, and only the library offered the second half, so noticing an unwanted Move on your sheet meant going elsewhere to find it again. The GM's own **Revoke** on that tab is unchanged and still keeps its confirmation, because undoing somebody else's choice is a different act from undoing your own. Nothing tracks who granted what, so a Player dropping a move the GM gave them is possible and accepted, the same trust model as every other control here. The Move Creator form, Tell/Tag managers, per-move Grant…/Edit/Delete actions, drag-to-grant, and the "drag a move here to grant" character rail remain GM-only (`role === 'gm'`, client-side gating only, same trust model as every other GM-only control in this app). The GM drags a move from the compendium onto a character in the page's character rail to grant it (a per-move Grant checklist covers touch devices); the GM can revoke a Unique move from the character's Moves tab.
- **Compendium folders, shown in the UI as "Discipline" (decided)**: folders exist to organize moves by which **martial art/discipline** they come from (Karate, Muay Thai, etc.) — "Discipline" is purely a display label for the same underlying folder mechanism (`move_folders`, `folder:*` events), chosen because "Style" already means something else (the 7 tournament attributes). **Disciplines nest (decided)** — `move_folders.parent_id` self-references, so a discipline can itself contain sub-disciplines to any depth (e.g. "Striking / Boxing / Southpaw"). The GM creates disciplines and places moves in them — either assigned in the Move Creator (a select showing the full indented hierarchy, e.g. "Striking / Boxing"), or by **dragging a move card onto a discipline row** in the nested nav (dragging onto "All Moves"/root clears the move's discipline); creating a discipline while another is selected nests it inside that one. Deleting a discipline promotes its directly-contained moves and direct child disciplines **one level up, to the deleted discipline's own parent** (root if it was already at root) — not unconditionally to root, so removing a nested discipline only collapses that one level rather than flattening its whole subtree; if the client is currently viewing the deleted discipline, it follows automatically to that parent (or root). **"All Moves" shows every move regardless of discipline** — a specific discipline shows only its own moves. A **style filter** further narrows whichever of those two is currently showing — **multi-select, OR'd together (decided, revised):** each of the 7 style icons toggles independently (a `Set` of attribute ids, not a single value), and a move matches if its style is *any* of the currently-selected ones; no selection shows everything, same as before. Every move card, everywhere (Compendium and every character sheet, not just under a style filter), always shows its **full discipline path** — "📁 Striking / Boxing" if filed under a nested one, or **"Without Discipline"** if not.
- **A modifier modifies the ROLL, not each die (decided, fix; implemented).** Every modifier in the game — the ad-hoc one typed into a roll dialog, Reasons to Fight, the Stance matchup, a move's own Roll Modifier, a Perk's per-move bonus — was added to **each die separately**, so a move rolling Skull + Body + Brain at +4 collected +12. It is summed once and added to the total now (`rollTotal` in `server/gameLogic.js`, unit-tested).
  - **The payload shape is the rule.** `dice[].result` is a die's face plus **its own** flat bonus (the `+1`s it earned past d12, which really do belong to that die); `total` is where the shared modifier lands. Every roll path now emits that shape — the hand-thrown pool roll, the Dice Tray, a single Stat roll, the engine's own reveal-time and defence rolls, the Interruption roll and both copies of the Initiative roll — so the client has one rule to read rather than a per-caller guess.
  - **Single-die rolls change shape but not arithmetic**, and are converted anyway: one payload shape beats a display layer that has to know which era each row came from.
  - **The display had to move with it.** `decomposeRoll` used to subtract the shared modifier back out to recover a die's face; it now subtracts only the die's own bonus, and the modifier is printed once on a **total line** (`formatRollTotal`) that the chat card and the cutscene log share. A single die with no modifier still prints no total — that would just be the same number twice. `MoveCard`'s Roll formula was folding the modifier into every slot too (`Skull (d4+9) + Body (d6+9)` for one +9 move) and now appends it once: `Skull (d4) + Body (d6) + 9`.
  - **The grapple chain's ±5 stops being a special case.** It was kept out of `mod` precisely *because* `mod` was per-die and a ±5 in there would have paid out per die; it stays separate now only so the swing keeps its own line in the cutscene.
  - **One back-compat note:** rows written before this change baked the modifier into every die, so re-totalling one would double-count. Chat is wiped on every server restart and a deploy restarts the server, so none survive; a round **replay** recorded before the change keeps its correct stored `total` but will decompose its per-die faces as though the modifier were part of the face.
  - **Verified against the running app** (`scripts/playtest-roll-modifier.mjs`, 11 checks): a three-die pool at +3 totals sum+3 (not sum+9), no die carries the modifier inside it, a reloaded roll reports the same total as the live broadcast, and the engine's own three-Stat move roll obeys the same rule.
- **Reading a move while declaring it (decided, new; implemented).** The declare picker showed a
  name, a Stamina figure and a frame glyph — not enough to choose with, and finding out what a
  move actually did meant leaving the Arena for the Compendium mid-declaration. Every chip now
  opens the **full `MoveCard`** (description, Roll, Attack Target, Tags, interactions, grapple
  directions) on the front-most layer. **Opened only by the ⓘ on the chip
  (decided, revised).** Hover shipped first as a mouse shortcut and was removed after one
  playtest: the card covers the Tic Counter you are aiming at, the pointer that opened it is
  already on the chip you are about to drag, and it does not close until the pointer leaves — so
  reaching for a move hid the thing you needed to see to place it. Tap was never available either,
  since tapping a chip is how a move gets picked up for tap-to-place. Reading and aiming are
  separate intentions and get separate controls; **starting to aim — dragging the chip or tapping
  it to place — closes the card**, unconditionally, because the card and the drop target share a
  screen and the drag is the deliberate act. The ⓘ sits
  *outside* the draggable button: nested inside it, a press on the ⓘ starts the drag instead. The
  card is portalled at `z-[80]` for the same reason `CompactDeclaredMoveCard`'s is — an ancestor
  with `perspective` establishes a stacking context no z-index inside it can escape.
- **Compendium tag filter (decided, new; implemented).** A second filter row beside the style icons, filtering by **Tag** — the same multi-select-OR control (`tagFilter`, a `Set` of tag ids; one shared `toggleIn` factory now backs both filters rather than two copies of the same reducer). A move matches if it carries *any* selected Tag; no selection applies no filter. **The two filters AND with each other while each ORs within itself** — "a Strength or Speed move that is Grab or Feint". Client-only: `tag_ids` already rides every move out of `attachInteractions`, so nothing server-side changed. Rendered as words rather than icons, since a Tag is GM-authored free text with no icon to stand in for it, and the whole row hides itself when the world has no Tags yet.
- **Copying a move (decided, new; implemented).** A **Copy** action beside Edit and Delete on every move card, opening the Move Creator on a full duplicate: every field, both Roll pools, the interactions, the Tags, the grapple cross, the art — with the name pre-suffixed `(copy)`. Building a variant is a two-field edit rather than a twenty-field re-entry.
  - **A pre-filled form, not an instant duplicate (decided).** Most copies exist in order to be changed; a silent second identical move in the library is a thing the GM then has to find and edit anyway. So Copy opens the form and only the Create button commits it.
  - **It is a create, not an edit, and the client says so by dropping the id.** `copyDraft` strips `id` (and `granted_character_ids` — a copy is a move nobody has learned yet, and inheriting the grants would silently hand it to everyone who had the original). `MoveCreator` keys "am I editing?" off `initial?.id != null` rather than off `initial` being truthy, which is what keeps a copy titled *New Move*, buttoned *Create Move*, and free to name the move it was copied from as its own Requirement.
  - **Two things needed a rule of their own, because "leave it alone" means different things on a create and an edit.** The art: `image === undefined` correctly means "keep the stored image" when editing, but a create has no stored image, so a copy would come out blank — it now forwards the source's `image_data` unless the GM picks a new one. And the position: a new move takes `sort_order` 0, which lands it *first* in a hand-ordered library, far from its source — so a copy passes the source's own `sort_order` and lets the newer id break the tie, filing it immediately after the original. `sortOrder` is honoured on INSERT only; on UPDATE it would reset the GM's drag order on every plain edit.
- **Custom Compendium ordering — drag a move onto another move (decided, new; implemented).** `moves.sort_order`, and every move read path orders by `(sort_order, id)` so a library nobody has reordered (all zeroes) comes back in exactly the id order it always did. `move:reorder` takes the full ordered id list of the view that was rearranged.
  - **Reordering is local to the view (decided).** The server redistributes the `sort_order` values *those same moves already occupy*, re-sorted and handed back out in the new sequence — so rearranging inside one Discipline can never make a move jump past something in another Discipline it was already behind, and "All Moves" stays consistent with every filtered view of it. On a library still at all-zeroes there is nothing to redistribute, so positions fall back to the rows' current `(sort_order, id)` index, which spreads them out in the order they already had.
  - **The card body reorders; the drop target disambiguates (decided).** A move card already had two drags — onto a Discipline to file it, onto a character to grant it — and reordering became a third on the same handle. Rather than add a dedicated grip, the three drop *zones* stay disjoint: a Discipline row and a rail character are not move cards, so dropping on a move card means reorder and nothing else. `dataTransfer.types` is checked during `dragover` (where `getData` is unreadable) so a card only claims drops that are actually carrying a move.
- **Tells** — a separate, world-level list, editable by the GM at any time (unlike the fixed 7 stance attributes). A Tell is a **name + small uploaded image**. Two placeholders ("Tell 1", "Tell 2") are seeded so moves can be created immediately; the GM replaces them with real Tells. A Tell in use by a move can't be deleted. When creating a move, the GM picks one Tell from this list.
- **Declaring a move** — happens during combat, with real timing/reveal mechanics covered in detail in "Combat Timing" below. Short version: only the Tell is shown to everyone until the move's Startup timer completes — *except* the player logged in as the declaring character (sees their own move immediately) and the GM for an NPC's move (the GM effectively declared it); the GM never gets early sight of a Player's move, "for fairness."

## Game mechanic — Combat Arena
No map or tokens. Instead, a dedicated shared Combat Arena page (built in Phase 6 as **structure only** — seating, pairing, and everything below; the round/Tic timing described in Combat Timing below is Phase 7):
- The GM drags characters (PC or NPC) from a roster rail onto a **left** or **right** side to start a fight — the rail lists only not-yet-seated characters (role-filtered the same as the character list: PCs only for a Player, though only the GM ever sees the rail or drag handles at all). **The roster is grouped by character folder, recursively (decided)**: folders render first, nested with visible indentation, sorted alphabetically at every level; each folder header is clickable to collapse/expand its whole subtree (local UI state, a `Set` of collapsed folder ids) and shows a running count of every available character inside it including descendants; a folder whose entire subtree has nobody available hides itself rather than showing an always-empty row; inside an expanded folder, its own direct characters render before its child folders. Folderless characters render **last**, under their own "Folderless" heading, below every folder. Each seated/available card shows a simplified view: portrait, active stance (if any — the same live-broadcast stance the Stances tab shows, since it's meant to be visible strategic info), dice pools, and stamina — not the full sheet. **This view is read-only** (decided, revised — one exception below): no roll/step controls on the card itself, since Phase 6 has no combat-triggered rolling to do yet — click a card to jump to that character's own sheet to actually roll/step, and the Arena's copy stays live via the same broadcasts the sheet uses. **Seated participant cards render horizontally (decided)**: a full-height portrait column (`object-cover`, no padding/gaps, ~7rem wide growing to ~8rem on larger screens) fills the entire left side of the card, with name/NPC badge/active stance/stamina/dice pools stacked on the right; the card itself keeps a `min-h-40 min-w-64` floor plus the existing fill/scale-with-Uneven-Combat behavior from before. **Each die chip carries its Stat's icon (decided, new):** the card used to show eight bare `d4` chips whose only identification was a hover title — unreadable at a glance, in the one view whose whole purpose is glancing. The icon is the same one `ANATOMY` already gives that Stat on the Vitruvian figure and in the Damage dialog, so a fighter's Skull looks the same wherever you meet it; Left and Right share an icon exactly as they do everywhere else, with the pair always drawn in that order and the title still naming the side.
- **Stance matchup bonus (decided, new — automated):** the counter chart stops being something the table reads off the Stances tab and applies by hand. A seated character's own active stance, scored against their opponent's active stance by exactly the `pairScore` the Best/Worst Matchups list already shows (4 cross-pairs, +/-`COUNTER_BONUS` each), becomes a **flat bonus on all of that character's rolls, behaving exactly like Reasons to Fight** below — same application points (`die:roll`, `pool:roll`, the per-pair Brain Initiative roll, and every roll the resolution engine makes), same server-side folding into the roll's modifier so it can't be bypassed. Both live in `server/combatBonuses.js` now (`getCombatRollBonus` sums them), which is also the one place to add the next such always-on modifier.
  - **Omitted whenever a side isn't exactly one fighter (decided, revised — this used to be gated on the Uneven Combat toggle, and that was a bug).** With more than two fighters there is no single enemy stance to score against, and handing the lone fighter a bonus per opponent (or averaging them) would be a new rule nobody asked for. The rule is the **opponent count**, measured per pair. It was previously written as "omitted for everyone the moment the Uneven Combat toggle is on, anywhere in the fight", which is a different and wrong thing: the toggle only *permits* lopsided pairs, it does not make any given pair lopsided. A plain 1v1 in a fight with the toggle enabled has exactly one stance on each side and a perfectly well-defined matchup — and gating on the flag silently took the modifier out of every roll in that fight as well as the badge off the VS divider ("matchups near the vs plaque disappeared and now I do not see the modifiers again"). Both `getStanceMatchupBonus` and `getPairStanceMatchup` now read only the per-pair count, which already answers the genuinely-uneven case on its own.
  - Also 0 when the character isn't seated in a pair whose fight has started, or when either fighter has no active stance. The one exception to the "fight has started" gate is the **initiative roll itself**: on a fight's first round that roll runs *before* the pair's own `combat_pairs` row exists (its `declaring_side` is decided by that very roll), so `getStanceMatchupBonus` takes a `requireActiveFight: false` there. Reasons to Fight never hit this because it reads `combat_participants` directly, with no pair join to be too early for.
- **Reasons to Fight (decided, new rule):** each seated participant's card carries a small 0-3 counter with up/down arrows (`combat_participants.reasons_to_fight`) — the one interactive control on an otherwise read-only card, open to whoever controls the character (same open-access trust model as Counters). Grants **+1 to all of that character's rolls per point** — `die:roll`, `pool:roll`, and the per-pair Brain Initiative roll at `combat:next_round` alike — while a fight is actually underway (`combat_state.phase` non-null; seating for an about-to-start fight doesn't count yet). Folded directly into the roll's modifier server-side (`getReasonsToFightBonus` in `server/index.js`) rather than as a client-side pre-fill, so it can't be bypassed by whatever a roll dialog happened to pre-fill. Lives on the seat (`combat_participants`), not the character, so it naturally resets to 0 whenever they're re-seated for a new fight.
- **Exception to normal NPC hiding:** once an NPC is placed in the arena, its simplified stats become visible to Players too — the whole point is so players can see and strategize against their opponent. This is the one place NPC info is shown to Players.
- **Pairing (decided):** the GM arranges participants into **pairs** by dragging a character card onto a specific pair row's left or right zone (a semi-translucent divider marks each pair); an empty row is always available at the end to start a new pair. Dropping onto an already-occupied zone *adds* to that side of the pair rather than replacing — that's what makes an Uneven Combat grouping (2v1, etc.) possible. Since the system centers on 1-on-1 duels even within a larger fight, this pairing is a real grouping (`pair_index`), not just visual ordering.
- **Uneven Combat** toggle (GM-only): when on, a pair can have multiple characters on one side against a single character on the other. This is a GM-side convenience flag — the app doesn't hard-block uneven pairs when it's off, that's on the GM to respect.
- Only the GM can drag characters into, out of, or around the arena; a small ✕ on each seated card (GM-only) removes just that character, and a page-level **Clear Arena** button (GM-only) empties it entirely.
- Arena state (who's in it, sides, pairing, the Uneven Combat toggle) is persisted like everything else, so it survives reloads mid-fight. Deleting a seated character removes them from the arena too (explicit cascade, same pattern as the rest of a character's owned records).
- **Counters in the Arena (decided, pulled forward from the Counters mechanic):** the page also lists every counter relevant to the fight — any character's counter flagged Show in Combat (only while that character is actually seated), plus standalone counters. Standalone counters are **created** GM-only (a small form on the page), but **adjusting** pips or deleting any counter shown here follows the same open-access rule as the character sheet's own Counters tab (no per-counter ownership check anywhere in this app) — only creation of a new standalone one is gated.

### A broken Leg forbids Movement (decided, new)

`movementBlockedByLegs({ tagNames, legStatuses })` in `server/tagAutomations.js` — a
move carrying the **Movement** Tag cannot be declared, and cannot resolve, while
**either** Leg is incapacitated. Either, not both: the Tag says the move is
footwork, footwork on one leg is not footwork, and "a broken leg stops you
moving" needs no follow-up question at the table. An empty `legStatuses` blocks
nothing — this rule refuses moves, so a missing row must not be read as evidence
of a break.

Gated in **both** places, from the one pure rule: `move:declare` refuses it
outright (silent, like every other rejection there), and the declare picker greys
the card and names the reason, so nothing that looks draggable is silently
ignored.

**A move already declared when a Leg breaks FIZZLES, and its Stamina is refunded
(decided).** Checked at the top of `resolveAttack`, ahead of even the grapple
branch — a grab you cannot step into is no more throwable than a strike you
cannot step into. The fighter did not choose this; the leg went under them
mid-round, and the rule that ends the move should not also charge for it. Posts a
`move_fizzled` round_event and a chat line, because a declared move that simply
never comes out reads as a bug unless the round says why.

## Game mechanic — Combat Timing (Initiative, Tells, Tics)
**Rewritten in full after the Combat Automation overhaul (Phase F).** A round now has exactly two phases — **Declaration** (human, unchanged) and **Resolution** (fully automatic). Nobody steps a Tic by hand any more; there is no Start Tic Countdown button, no Tic Forward/Backward, and no Next Round button. Finishing the last declaration in a pair is what starts that pair's Resolution, and finishing Resolution is what opens its next Declaration. The moments a human is still asked anything are a **Dodge** at full coverage and a **Block** at full or too-short coverage (both the GM's call — see the Defence rework subsection), and a Block-too-late **move conflict** (the affected *player's* Forfeit/Postpone call). Everything else, including every roll, resolves server-side from the rules.

**Per-pair clocks (decided, done — introduced in the overhaul's Phase B):** both Resolution *and* round/phase state run **independently per pair**, exactly like Declaration already did — each pair has its own `combat_pairs.round_number`/`phase`/`round_start_tic`/`current_tic` (see the Data model above) rather than sharing one `combat_state` clock. One pair can be resolving round 5's Tic Countdown while another pair is still mid-Declaration on round 3, or mid-Countdown at a completely different Tic — no fight ever waits on another. `phase` is `'declaration'` or `'resolving'` (the old `'tic_countdown'` value from before this overhaul, renamed to anticipate Phase C's automatic-resolution engine reusing this same phase value for what becomes an automatic, not manually-stepped, process). Stepping it by hand is gone entirely (those three events no longer exist) — see the Resolution Phase below. A Player always sees their own pair; a GM picks which fight they're watching from a per-pair tab strip showing each pair's round number and live status, with only the selected pair mounting a running cutscene.

The Tic Countdown is still, underneath, a single **global counter that never resets** *per pair* — round boundaries are just markers on that pair's own timeline, which is what makes overflow between rounds work cleanly (see below) — it's just no longer shared arena-wide. **Decided (revised, combat redesign):** Declaration is no longer one shared phase for the whole arena, though — it now runs **independently per pair** (see the Declaration Phase below). Each round has two phases:

**"Fresh" (decided, new):** a GM checkbox sitting next to **Start Combat**, `combat_state.fresh_start`, toggled by `combat:toggle_fresh`. **Only with Fresh on does starting a fight restore every seated character to full Stamina**; with it off — the default — everyone starts the fight on whatever Stamina they were still carrying, so a run of back-to-back fights genuinely wears people down. It is **off for every new fight and reset to off by End Combat / Clear Arena**, deliberately a per-fight choice rather than a standing setting: the version of this rule that carried over would quietly make every fight after the first one fresh again. It governs the fight's **first round only** — the automatic per-round Stamina Regen from round 2 on (see Stamina & Stat Lock above) is a separate rule and runs either way. The checkbox only renders while a fight has an unstarted pair, since it has nothing to do once one is underway. Both copies of the round-start restore are gated on it (`combat:next_round` in `server/index.js` and `startPairDeclaration` in `server/roundResolution.js`).

**Start Combat / End Combat (decided):** a Combat Arena toggle, separate from the round loop below — while a fight is on, a slim **status strip** appears at the top of *every* page in the app (not just the Arena — see `CombatHeaderBar.jsx`), showing the round number, the same Tic Counter visuals the Arena renders, and this viewer's own current state, so a fight is legible from wherever anyone happens to be. **Post-overhaul the strip is a status display, not a control:** its Tic ◀/▶ buttons, the Start Tic Countdown button and the Next Round button are all gone, because nothing advances a round by hand any more. What the strip *does* still carry is the one thing that must reach a GM regardless of page — the **Dodge prompt** (see the Resolution Phase below); it's mounted there precisely because the Arena is not always on screen. The drag-and-drop declare target and the per-character declaration UI still live only on the Arena page. **Start Combat** (Arena-only) is just the first **Next Round** press under a friendlier label; **End Combat** (in both the strip and the Arena) resets `declared_moves`/`combat_pairs` (**Phase B: `combat_pairs` rows are deleted here too, not just cleared to null fields — see the Data model above for why they otherwise persist/upsert round to round**) the same way **Clear Arena** does, but — unlike Clear Arena — leaves everyone seated, so a new fight can start right away without re-seating.

**Declaration Phase**
- The GM presses **Next Round** (or, for the very first round, **Start Combat** — the same event): increments the round number, marks this round's start Tic, rolls the Brain die for every participant (posted to chat as normal initiative rolls), opens declarations. **The Brain roll's modifier (decided, bugfix):** it's `reasons_to_fight - overflowPenalty` for that character — Reasons to Fight applies from round 1 onward, same as any other roll (see Reasons to Fight under Combat Arena above), and **a new penalty (decided, new rule) docks 1 per Tic of overflow the character is still carrying from a previous round's declared move(s)** into this round — `computeInitiativeOverflowPenalty({ blockedUntilTic, nextRoundStartTic })` in `server/combatTiming.js`, `max(0, blockedUntilTic - nextRoundStartTic)`, reusing the same "last-queued move's full footprint end" lookup `move:declare`'s own placement floor already uses (0 for a character with no still-carrying moves). **Bugfix:** the roll's numeric *value* already included Reasons to Fight before, but the modifier passed to `logRoll` was hardcoded `0`, so the Chat Log's dice-breakdown feature (see Chat Log below) had nothing to attribute the bonus to and silently folded it into what looked like the raw die face — reading, from the chat log alone, as if Reasons to Fight did nothing. The real (now combined) modifier is passed through, so the breakdown correctly shows it as its own line. **Decided (bugfix): the new round's start Tic is floored a full `round_length` past the previous round's own start (`computeNextRoundStartTic` in `server/combatTiming.js`), not simply set to wherever `current_tic` currently sits.** The original rule (`round_start_tic = current_tic`) assumed the GM always steps the Tic Countdown all the way to the round's last Tic before pressing Next Round; if Next Round is pressed early instead — right after Start Tic Countdown, or partway through — `current_tic` hasn't moved (or hasn't moved far), so the new round could start at or near the *same* absolute Tic as the one just declared into. Since a character's next placement is floored by their last move's full footprint end even across a round boundary (see below), this made last round's declared-but-never-resolved moves wrongly "occupy" the same Tics again this round. The fix advances both `current_tic` and `round_start_tic` together to `max(current_tic, round_start_tic + round_length)` whenever there was a previous round (`phase` was already non-null) — the very first Start Combat press (`phase` null) is exempt and still just starts wherever the counter sits (always 0). Genuine cross-round overflow is unaffected: a move whose footprint ends later than this floor still correctly blocks the new round, since `computePlacementTic` takes the max of the two.
- **Decided (revised, combat redesign): declaration is resolved independently per pair, not once across the whole arena.** The original Phase 7 rule computed one Initiative comparison for "the whole left side" vs. "the whole right side" of the *entire* arena, meaning every pair's losing side had to declare together as one literal batch even if they had nothing to do with each other. This read as a real bug once more than one pair was in play — pair 1's loser and pair 2's loser could be on opposite literal sides yet have no reason to wait on one another. Now: **Initiative is still per side, not per character** (a side's Initiative is the *highest* Brain roll among characters on that side of *that specific pair*), but it's computed once per pair (`resolveSideInitiative`, unchanged function, just called once per `pair_index` instead of once for the whole roster) — so two, three, or more pairs can be genuinely mid-Declaration at the same time, each on its own losing-side-then-winning-side sequence, fully independent of every other pair. A pair with only one side seated skips straight to that side, same as before.
- **Brain and Stamina are outside the Stance matchup entirely (decided, new).** The matchup scores what two fighters' STYLES do to each other — it is a fact about an exchange of blows — and two of the eight Stats are not part of that exchange: **Brain** is thinking (reading the room, going first) and **Stamina** is the engine, which does not care what stance anybody took. `MATCHUP_EXEMPT_SLOTS` + `matchupAppliesToSlots` in `combatBonuses.js`, pure and unit-tested in `server/test/matchupSlots.test.js`.
  - **Only a roll made ENTIRELY of exempt Stats is exempt, and that asymmetry is the design.** A move rolling Skull + Brain is still a punch; letting it shed the matchup by naming Brain would turn the exemption into a loophole worth building moves around. A roll with no Stats to name at all — a Custom Roll, a hand-thrown path with no slot list — keeps the matchup, which is what every one of those paths already did.
  - **Enforced at the one funnel, not per call site.** `getCombatRollBonusBreakdown` takes the slots the roll is actually made of and zeroes both halves of the matchup term (stance *and* Combat Style, which are one mechanic) when they are all exempt. Every caller that knows its slots passes them: `die:roll`, `pool:roll`, the engine's `rollFor`, the defensive roll, and the Interruption roll (whose slots are decided a few lines earlier than they used to be, because the modifier now needs to know before the die is picked).
  - **This reverses an earlier decision, and the reversal is the point.** The bullet below records the Initiative roll being *given* the matchup as a bugfix; the rule underneath it changed. Initiative is a pure Brain roll, so it no longer carries a matchup at all — both copies of it (`combat:next_round` in `server/index.js`, `startPairDeclaration` in `roundResolution.js`) drop it together, which is the discipline that bugfix was really about. Reasons to Fight and the overflow penalty are untouched. `roundResolution.test.js`'s Initiative test was rewritten to assert the new rule rather than deleted, so the two copies are still pinned to agreeing with each other.
- **The Stance matchup applies to Initiative on every round (decided, bugfix).** The Initiative Brain roll exists in two copies — `combat:next_round` (`server/index.js`) opens a fight's first round, `startPairDeclaration` (`server/roundResolution.js`) opens every round after it — and only the first had learned the Stance matchup bonus when that rule was automated. From **round 2 onward a fighter's stance advantage silently stopped counting toward who declares first**, which is exactly the class of bug two hand-maintained copies produce. Both now read the same `getStanceMatchupBonus`/Reasons-to-Fight helpers, so the next modifier added to one cannot go missing from the other. (Audited alongside it and found correct: `die:roll`, `pool:roll`, `dice:roll_custom`, and every roll the resolution engine makes all fold in the move's own Bonus, Perk roll bonuses, Reasons to Fight and the Stance matchup — measured, not merely read. The separate report that *the engine's automatic move rolls* dropped their modifiers turned out to be a display defect in the round cutscene, not an arithmetic one — see "A roll is shown as the sum it is" under the Round Cutscene above.)
- **Initiative ties (decided):** if a pair's two sides' top Brain roll is exactly tied, only the character(s) — on either side — who actually posted that tied roll are eligible tie-break candidates (a side with one high outlier and one low roller under Uneven Combat isn't dragged in by its low roller). Among those candidates, in order: highest **current** Brain value (die size + bonus) wins; if still tied, highest **locked** Brain value wins; if still tied, whoever has **Speed** in their currently active stance wins — only if that actually narrows the field (if none of the tied candidates have it, or all of them do, it decides nothing and the cascade falls through); if still tied after all of that, it's random. Whichever side the winning candidate belongs to wins the roll-off, same as the non-tied case — the loser declares first. (`resolveSideInitiative` in `server/combatTiming.js`, its `random` source injectable so this stays deterministic in tests.)
- **Declaring is per character now, not a shared side-wide batch (decided, revised).** The original Phase 7 rule had one "Done Declaring" press commit an entire side's Stamina Cost and hand the floor to the other side all at once. Now every seated character finishes declaring **individually** — `combat:character_done_declaring` (open access, same trust model as declaring itself) commits just *that* character's own pending Stamina Cost and marks them done; a pair's declaring side only flips to the other side (or clears to fully-done) once *every* character on the currently-open side has pressed their own Done Declaring. This is what makes Uneven Combat's multi-character sides work naturally: each of the 2 (or 3, or more) characters sharing a side declares and finishes at their own pace, and the side as a whole is only "done" once the last of them is.
- **Per-pair declaration state (`combat_pairs`, decided):** one row per `pair_index` that currently has participants, recreated fresh every `combat:next_round`. `declaring_side` is whichever side of *that pair* may currently call `move:declare` — `null` once both sides of it have finished (or trivially, if only one side was ever seated). There's no separate "pending side" field: once the currently-open side finishes, the server just checks whether the *other* side of that same pair has anyone left who hasn't finished yet — if so, `declaring_side` flips to them; if the other side is empty or already fully done, it clears to `null` instead. **The instant `declaring_side` clears, that pair drops into Resolution and its round resolves itself** (see the Resolution Phase below) — it does not wait on any other pair, and no button is involved.
- **The VS divider shows the Stance matchup (decided, new).** A pair's divider now carries a small signed number on each side — what that fighter's active stance is worth against the one across from them — so both players can see what they are facing *before* anyone commits a move, and a stance choice stops being a guess about an off-screen chart. The tooltip spells it out (`Stance matchup: Speed + Power vs Speed + Improvisation — +1 on this fighter's rolls`) and says that a move's Combat Style adds to it on that move's own roll.
  - **Computed server-side, by the same code that feeds the real bonus** (`getPairStanceMatchup` in `combatBonuses.js`, sharing `pairScore` with `getStanceMatchupBonus`), and sent on the combat payload as `stanceMatchups`. It is the same number, not a second calculation the client could drift from — the mirroring this codebase already calls out as a known risk for `computeHitDamage`.
  - **Stance-only, deliberately.** It is a standing fact about the two fighters, visible during Declaration when nothing has revealed yet; a number that flickered as moves came and went would be unreadable, and pre-reveal it would leak. It is keyed off `combat_participants` rather than `combat_pairs`, so it shows as soon as both fighters are seated — before the fight starts, which is exactly when a stance is still worth changing.
  - **Absent, not zero, when the rule doesn't apply.** A side that isn't exactly one fighter, or a fighter with no active stance, renders *nothing* — a `0` would read as "even matchup" rather than "no matchup", and the bonus genuinely isn't applied in those cases either. (The Uneven Combat toggle is **not** one of those conditions any more — see the bugfix above.) `pairScore` is antisymmetric, so one call answers both sides and the two badges are always exact opposites.
- **The declare picker shows what each move's Combat Style is worth (decided, new).** A move carrying a Combat Style joins that style to its user's stance for the matchup, which is a real and sometimes decisive modifier on that move's roll — and until now the only way to find the number out was to declare the move and watch the roll. Every styled move in the Declaration move list now carries a small signed line (`Strength +2 vs their stance`), green for a gain and red for a loss.
  - **Computed server-side by the same function that feeds the VS divider.** `getPairStanceMatchup` returns `leftStyleDeltas`/`rightStyleDeltas` — for each style in the ruleset, what adding it to that side's stance would change the matchup by. One small array per side, computed where both stances and the counter chart are already in hand, rather than shipping the counter chart to the client and re-deriving it there.
  - **Scored against the opponent's stance only**, exactly like the divider's own number and for the same reason: during Declaration nothing has revealed, so what the other side's move will contribute is unknowable, and a number that changed as their moves came and went would be unreadable. The line is omitted entirely whenever the matchup rule doesn't apply to that pair — the same condition that leaves the divider's badge off.
  - **Layout follows the panels:** a column on mobile (where the two sides stack, so top = left side) and a row on desktop (where they sit side by side, so left = left side). One order can't point at the right fighter in both layouts. A stance switch refetches the combat snapshot, so the readout can't go stale behind the local `active_stance_id` patch.
- **Tell cards are sized for real Tell names (decided, fix).** The compact declared-move card was a fixed `w-28` with a `truncate`d 9px name, which cut anything past roughly eight characters down to an ellipsis — while the Lanes panel itself was still capped at `max-w-3xl` inside an Arena that had gone full-width, leaving most of the row empty. The panel now takes the Arena's full width, the card is `w-44`, and the name **wraps** (`break-words`, no truncation) at a readable size, so a Tell like "Dropping Shoulder Feint" is legible in full rather than legible up to a guess. The revealed face matches the same width so a lane doesn't jump when a move reveals.
- **The GM's Declaration Lanes (decided, revised — Lanes redesign):** since several pairs can be mid-Declaration simultaneously, the GM gets a compact per-pair table (Arena-only, unlike its predecessor it stays visible through Tic Countdown too, not just Declaration — see Pages / views below for the full layout) showing every seated participant's live status: **Declaring** (grey — it's their side's turn and they haven't pressed Done Declaring yet), **Declared** (green — they've pressed it, but their own side isn't *fully* done yet, e.g. a pairmate under Uneven Combat still hasn't), **Waiting for round start** (blue — their whole side has finished, whether or not the other side of their pair has even started), or a dimmed **Not yet** for anyone whose side isn't currently open at all. A Player never uses this — they only ever act for their own single character. **Clicking a lane (decided, revised — was clicking an individual eligible NPC row)** selects that whole pair as the GM's "active" lane (client-only convenience state, not server-enforced — `move:declare` was always open-access regardless of who's "controlling" a character); every not-yet-declared NPC on that lane's currently-declaring side gets its own declare panel (plural under Uneven Combat), and the GM switches lanes by clicking a different one.
- **Who sees a declared move early (decided):** the player logged in as the declaring character (see Roles / access model above) sees their own move's real identity and Stamina Cost immediately, on every `combat:updated` from the moment it's declared — no more waiting for the natural reveal Tic. The GM sees an NPC's declared move immediately too (the GM effectively declared it — no secrecy needed between the GM and themselves), but does **not** get early sight of a Player's move, "for fairness": the GM is an adversarial party in this fight, not an omniscient narrator, so a Player's secret stays exactly as hidden from the GM as it is from any other Player. Everyone else, regardless of role, sees only the Tell until the move's real reveal Tic passes — at which point it's public to everyone, always. This is enforced server-side (see `identity:set`/`isRevealedToViewer` below), closing what used to be an accepted "no-login" gap where only the exact socket that clicked declare could see its own move. This rule is unaffected by the per-pair redesign above — it was always per-character, not per-side.
- A character can queue more than one move for the round during this phase, but once the Tic countdown starts, no new declarations can be made or changed.
- **Declaring is drag-and-drop (decided):** the declare picker lists whichever character currently has the floor's moves under **Default**/**Unique** tabs (a card per move, its Stamina Cost shown) — a Player's own character when it's their turn, or one of the GM's currently-selected lane's not-yet-declared NPCs (see the Declaration Lanes bullet above); dragging a card onto the Tic Counter (the Arena page's centerpiece — see Pages / views below) declares it. The strip is exactly `round_length` squares — the current round's own Tics, nothing more (**decided**, revisited after playtesting: no lookahead squares past the round's own window). While dragging, any square before that character's own next-eligible Tic (e.g. still finishing a move carried over from last round) shades as **blocked**; the Tic Counter also live-previews the move's footprint — amber Startup, red Active, blue Recovery squares — clamped to wherever the drop would actually land (never earlier than that blocked boundary), so the *declaring player* sees exactly how much of the timeline it'll occupy and exactly where it'll really start, even if they're hovering over a too-early square. This preview is purely local to that client's own drag interaction (never broadcast), so it can't leak a move's position to an opponent. The Tic actually dropped on is honored as the move's `placement_tic` when it's at or after the character's own next-eligible Tic; dropping earlier than that (or past the visible strip, for an overflowing follow-up move) silently **snaps forward** to the earliest legal Tic rather than rejecting the drop, so a player never has to fuss with finding the exact minimum by hand. This is also how a character queues several moves ahead of time in one go — drop each one at whatever future Tic makes sense, rather than being limited to the single next available slot.
  - **The held move is highlighted (decided, new).** Tap-to-declare picks a move up and waits for a Tic, but the chip gave no sign it was the one being held — on a phone, where there is no drag to watch, the whole gesture was invisible. The held chip is now lit, and tapping it again puts it down, so a mis-tap does not have to be undone from the banner at the other end of the screen.
  - **A long move name no longer breaks its own card (bugfix).** The picker chip is content-sized, so its first line always ran right into the top-right corner — where two things sit: the ⓘ "read this move" badge, positioned half outside the chip, and `panel-cut-sm`'s bevel, which shaves the last few pixels of whatever reaches it. Every name lost its closing bracket and a long one lost more, which is how it was reported ("the move card in the Arena is corrupted with longer names"). The chip now reserves that corner (`pr-6`), caps itself at the panel's width (`min-w-0 max-w-full` — a flex item's default `min-width: auto` had let it walk out of the panel entirely), wraps rather than truncating, and sets `text-left` explicitly, since a `<button>` centres its text and that only showed once a name was long enough to wrap.
  - **The picker card's frame data is a compact dot row (decided, reverted).** It was briefly drawn at exactly Tic-square size, on the theory that a move you are about to drag should read as the piece of timeline it will become. In practice it did the opposite: a long move's bar dominated its own card, pushed the name and Stamina Cost around, and made the picker a wall of squares to scan through. Frame data on a *card* is a summary — "this is a 2/1/3" — not a ruler; the strip itself is where a footprint gets measured, and the live drag preview already draws it there at true scale. The `FrameBar` on a `DeclareMoveCard` is back to small (`h-2 w-2` cells), and `TIC_SQUARE_SIZE` is no longer shared with it.
  - **A declared move's own card is available as a full overlay (decided, new):** hovering (or tapping) *your own* compact declared-move card raises the complete `MoveCard` above every other element, rather than expanding in place and reflowing the lane. "What exactly did I commit to here?" is a question you ask mid-declaration, and the compact card deliberately doesn't have room to answer it. Unchanged secrecy: this is your own already-declared move, so nothing is revealed that the viewer didn't already author.
- For a character's next queued move (their 1st this round or their 4th), its placement Tic can be no earlier than whichever is later: the round's start Tic, or that character's own last-queued move's **full footprint end** (`reveal_tic + active_tics + recovery_tics` — through Startup, Active, *and* Recovery, not just the reveal Tic; see the Resolution Phase below for why this is a revised rule) — even if that move was queued in a *previous* round. That second case is exactly how overflow works (next point).
- **Requirement — a move that may only follow another move (decided, new; implemented).** `moves.requirement_move_id`, a nullable self-reference on `moves` (no child table: a move has at most one Requirement, so there is nothing to group). A move carrying one may be declared **only immediately after** the move it names — "not later, not without it, but right after". Motivated by Combo Moves and Grappling Chains, but it is a general move property, not a grappling one, and sits outside the Grappling toggle in the Move Creator.
  - **"Right after" is a Tic claim, not just an ordering one (decided).** The follow-up's `placement_tic` is **forced** to the required move's own full footprint end — the same `computePlacementTic` floor every other move is merely gated by. The dragged Tic is ignored rather than snapped-forward-from: for an ordinary move the drop is a floor, for a Requirement move it is not a choice at all. This is what makes "not later" mean something; without it a combo could be held back three Tics and still count.
  - **The gate is the queue, not the outcome (decided).** Whether the required move *hit* is deliberately not checked. A round is declared in full before any of it resolves, so at declare time the answer is unknowable; gating on it would mean striking an already-declared move mid-resolution, which is precisely the rollback problem Grappling designed itself out of ("Reversibility: solved by not needing it"). A combo that whiffs still runs.
  - **Only the LAST-queued move counts.** `move:declare` reads the character's own declared move whose footprint ends latest — the one this declaration would in fact come right after — and compares its `move_id`. A Requirement satisfied earlier in the queue no longer satisfies it, which is what makes this "right after" rather than "at some point after". Re-queueing the required move re-opens the follow-up. The lookup deliberately has no round filter, so a Requirement can be satisfied across a round boundary exactly as the placement floor already carries across one.
  - **A move may never require itself** (`normalizeRequirement`, dropped server-side and excluded from its own picker) — it could never be declared at all, since it would have to follow a copy of itself that could never have been declared either. Chains of three or more need no depth guard: each link is checked independently. A cycle between two *different* moves is harmless — it just describes two moves that can each only follow the other, so neither can open a sequence.
  - **Grapple chains are exempt, structurally.** `declareChainedMove` inserts into `declared_moves` directly and never passes through the `move:declare` handler, so a move chained by a won grapple ignores its own Requirement. This is the intended reading: the grapple already earned the move. "This move can *only* be reached as a grapple chain" used to be authorable only as a trick — give it a Requirement it can never satisfy by hand — and is now said directly with the **Secondary** flag below.
- **Secondary — a move you are handed rather than one you reach for (decided, new).** `moves.is_secondary`, a plain flag, the first control in the Move Creator's field row because it decides what the move is *for* before anything else about it matters. A Secondary move is granted, listed and readable exactly like any other — it just cannot be declared off the picker by hand.
  - **The rule, in one pure function.** `declarableByHand({ isSecondary, requirementMoveId, previousMoveId })` in `moveLogic.js`: a Requirement must be satisfied (that part is unchanged and applies to every move), **and** a Secondary move with **no** Requirement is never hand-declarable at all. So Secondary never *adds* a position a move can be declared from — it removes the free one.
  - **That covers both shapes a Secondary move takes, without a second column.** With a Requirement it is a **combo follow-up**: declared by hand, but only ever in the slot right after the move it names, which the Requirement rule already enforces on its own. Without one it is a **grapple option**: nothing can declare it, and the only thing that ever puts it on the board is `declareChainedMove` when a grappler picks that direction. Which shape applies is already implied by the rest of the move, so storing it twice would only let the two disagree.
  - **One rule, both sides.** The Arena's declare picker imports `declarableByHand` from `server/moveLogic.js` directly rather than re-deriving it — the module is pure with no imports of its own, and the same crossing already runs the other way with the server importing `client/src/lib/matchups.js`. A card that looks draggable and an event that gets silently refused is exactly the failure a second copy of the rule reintroduces.
  - **Granted and visible, deliberately.** A Secondary move shows on the character's Moves tab dimmed (the same `dimmed`/`dimReason` treatment an unusable Style already gets) with a reason naming how it *is* reached, and carries a **Secondary** badge on its card everywhere including the Compendium, where the GM still edits it normally. In the declare picker it is greyed, un-draggable and labelled `secondary` — named rather than merely dimmed, since a greyed card with no word on it reads as broken rather than as a rule.
  - **An unreachable Secondary move is legal.** One with neither a Requirement nor any grappling cross pointing at it can be saved and simply cannot be reached — the Move Creator says so in an amber line rather than refusing, because the cross that will point at it may not be authored yet. Same precedent as an empty Resist Roll being a legible authoring choice.
  - **Nothing about the flag reaches the engine.** `declareChainedMove` inserts into `declared_moves` directly and never passes through `move:declare`, so a Secondary move chained off a won grapple is placed exactly like any other — which is the whole point of the flag rather than an exception to it.
  - **`move:delete` clears inbound pointers** (`UPDATE moves SET requirement_move_id = NULL WHERE requirement_move_id = ?`), the column-level twin of the `move_grapple_directions.target_move_id` cleanup beside it — otherwise the requiring move becomes permanently undeclarable, and the FK refuses the delete outright.
  - **Client:** the Move Creator reuses `MovePickerDialog` (built for the grapple cross in G3 — "point at another move in the library" is the same job); `MoveCard` renders an **Only after:** row; the Arena's `DeclareMoveCard` greys out and un-drags a move whose Requirement isn't currently satisfied, so a player never drags something the server would silently refuse. `attachInteractions` resolves `requirement_move_name` server-side in one batched query, because a Requirement can point at a move outside whatever list a given surface holds (a character's own move may require one they were never granted).
  - **The `Number(null) === 0` trap, again.** An absent Requirement coerced to id `0`, which is a valid-looking integer — so the move read as "requires move 0" and the gate refused to ever declare it. Same shape as the No Damage Success Threshold bug; absence is now tested before coercion in `asMoveId`, and a unit test covers the no-library case that had been passing only by accident.
- **Attack telegraph — a declared attack's FIRST Startup Tic is public (decided, revised back).** A Tell told you *what* might be coming and nothing about *when*, so an opponent could see a punch being wound up and had no way to time a guard against it. The Tic Counter (both the Arena's own centrepiece strip **and** the slim status strip in the header, on every page) paints a **faint grey glow** on the one Tic a declared attack begins winding up on — its `placement_tic` — visible to **everyone**, opponent and owner alike. The move's identity and its timing past that square stay exactly as secret as before: the glow says "something that can hit you is committed here", nothing more.
  - **It briefly marked the whole run, and that published frame data (revised back).** For one release the glow covered `[placement_tic, reveal_tic)` so a 3-Tic wind-up and a 1-Tic one drew differently — which is exactly the problem: **how long a move takes to come out is frame data, and frame data is what a Tell exists to make you guess at.** Painting the run handed every opponent the move's Startup count for free, every time. One square, and only the head, is the fact this glow is for.
  - **The square anchors the Tell↔Tic connector**, and hover/tap-to-pin work from it. (`isStart` is gone from the mark payload — with one square per wind-up it was vacuously true, and `TicSquare` no longer has a head/tail split to draw.)
  - **A 0-Startup move still marks its placement Tic** — it is committed there like anything else, and the glow drops the moment the move goes public anyway. A wind-up that *began* in an earlier round has no square here at all: its telegraph was shown on the round that owned its placement Tic.
  - **Startup length, Active and Recovery all stay secret.** The square says a commitment begins here and nothing about its shape — that is the half a Tell exists to make you guess at.
  - **Which moves telegraph:** anything with at least one Active frame that is **not defence-pure** (`isTelegraphedAttack` in `server/moveLogic.js`). Active frames alone deliberately are *not* the test — since the Defence rework restricted Defense Frames to ACTIVE positions (see that subsection below), every working defence necessarily has Active frames too (Front Guard and Slip Step both ship as 1/2/x), so keying on Active count would light up every Block in the game and the glow would stop meaning "an attack". Defence-pure — Defensive with no Attack Target, the same idea the resolution engine already uses — is what stays dark. A Defensive move that *does* carry an Attack Target is a counter-attack: it guards *and* strikes, so it telegraphs like any other attack, because it will in fact land on someone.
  - **It is gated on the move being publicly revealed, not on this viewer's own entitlement.** `combat:updated` now carries `publiclyRevealed` alongside the existing viewer-relative `isRevealed` — a fighter's own move is `isRevealed` to them from the instant they declare it, so gating on that would have hidden a fighter's own telegraph from themselves while every opponent still saw it. The glow drops the moment the move actually goes public (its full footprint is on the board by then, which is strictly more information than a start marker). Neither field discloses anything new: `current_tic` and `reveal_tic` were already public, so any client could derive both.
  - **Tell ↔ Tic connector (decided).** Hovering a declared move's Tell card in the Declaration Lanes draws a dashed grey line to its glowing Tic, and hovering the glowing Tic draws the same line back to the Tell — the two markers are one fact, and without the link a strip with several glows and a lane with several Tells is a matching puzzle. On touch, where there is no hover, **tapping either end pins the line** until it's tapped again or something else is tapped (`attackTelegraph.js`'s hover/pinned link state, a module-level pub-sub mirroring `dragMoveState.js`, since the two endpoints are siblings in different subtrees). The line is drawn by `MoveLinkOverlay.jsx`, portalled to `<body>`: both endpoints sit inside stacking contexts (clip-paths, transforms, Framer Motion wrappers) that would otherwise clip it. It re-measures on scroll/resize and draws nothing when either end has scrolled off screen. **On an already-revealed card the hover direction defers** — hover there is already spoken for by the full-`MoveCard` overlay, which renders upward across the line's own path — but the anchor stays registered, so the Tic → Tell direction still works. The **header strip shows the glow but never a line**: its other end (the Tell cards) only exists on the Arena page.
  - **Two consequences, both intended.** A prepared opponent can pair the visible Tell with the start Tic and look the move's real frame data up in the Compendium (Players browse it read-only) — that *is* the mechanic, and it's what makes reading a Tell actionable rather than decorative. And the *absence* of a glow is itself information: it says the declared move is a pure guard. Seeing an opponent turtle is fair play, same as seeing them wind up. Note this applies symmetrically to the GM, who now sees a Player's attack timing (never its identity) exactly as any Player sees an NPC's — consistent with "the GM is an adversarial party, not an omniscient narrator."
  - **Scope:** only the move's own `placement_tic`, and only when it falls inside the round window currently drawn. A move whose Startup began in an earlier round has no square to glow on this round — its telegraph was already shown when it was declared.
- **Ambiguous moves ask Left/Right before declaring (decided):** dropping a move whose Roll includes an ambiguous Left/Right Hand or Leg slot (`right_tell_id`/`left_tell_id` both set — see Roll slot vocabulary above) doesn't declare immediately — a small popup asks which appendage is throwing it first (labeled with the actual slot, e.g. "Left Hand" / "Right Hand"), and only then is `move:declare` actually sent, carrying the choice. The server rejects the declare (same silent no-op as any other invalid declare) if the move is ambiguous and no valid choice rode along with it. The choice is stored on the `declared_moves` row (`appendage_choice`) and, like the Tell itself, is **never secret** — it rides `combat:updated` for every viewer regardless of early-visibility entitlement — and drives two things: the flip card's pre-reveal face shows only the chosen side's Tell (not both — see Combat Arena below), and the reveal-time auto-Roll (next section) resolves the ambiguous slot to that side's actual die.
- **Cancelling a declared move (decided):** while still in the Declaration Phase and before that move's Stamina Cost has been committed (`stamina_committed = 0` — i.e. before the declaring character themselves presses **Done Declaring**), the declaring player can retract a just-declared move and declare something else instead. A small ✕ button on the move's flip card (rendered outside the flip animation itself, so it stays visible no matter which face happens to be showing — the declaring player's own view already renders the fully-revealed face immediately, well before commitment, so a cancel button placed only on the Tell face would be invisible to exactly the person who'd want it) calls `move:undeclare`, deleting the `declared_moves` row outright. Once Stamina Cost is committed (`stamina_committed = 1`), the move is locked in and can no longer be cancelled — the ✕ stops rendering. See `move:undeclare` under Real-time events below.

**Resolution Phase (automatic)**
- **Nothing starts it and nothing steps it.** The moment a pair's `declaring_side` clears, `combat:character_done_declaring` flips that pair to `phase = 'resolving'` and runs `advancePairResolution` (`server/roundResolution.js`) — which walks that pair's own round Tic by Tic to completion, or to the first point that genuinely needs a human. A round is 7 Tics (bumped from 5 after playtesting; not hardcoded). Tics are displayed relative to the round (1-7) even though the underlying counter never resets.
- **Every Tic, in order:** reveal any move whose reveal Tic has arrived → auto-roll it if it has a Roll → pick the target character (trivial in a 1-on-1; lowest `character_id` among eligible opponents under Uneven Combat) → auto-select the defending move by frame overlap → resolve Block or Dodge or a plain Hit → check for an Interruption → apply Idle-Tic Stamina Regen. Each step appends a `round_events` row, which is simultaneously the live push and the stored replay (see §1.4 in the overhaul section below).
- **A move is on the board while it winds up — the `windup` event (decided, new).** Before this, the cutscene drew nothing at all for a declared move until its reveal Tic, so a move materialised out of empty space with no build-up and a fighter mid-wind-up had an empty row. The engine now emits one `windup` per declared move as its Startup begins — at the Tic its `placement_tic` falls on, or anchored to the round's first Tic for a long Startup declared last round that is still running (whose placement Tic belongs to a round the Tic loop never visits). The cutscene draws its Startup run in ordinary amber and puts **`???`** where the name will go.
  - **The payload carries only the character and two Tics** — `placementTic` and `revealTic`, no `moveId`, no name, no Active/Recovery lengths. That is deliberately stronger than sending the whole footprint and asking the client to hide most of it: a stored replay is public to anyone (decision #11), so the secret is better left out of the row entirely. The client closes the footprint off at the reveal Tic (`activeEndTic = recoveryEndTic = revealTic`), which makes the existing `phaseAt` draw exactly the Startup run and stop — no special case in the renderer, just a footprint that ends where the unknown begins.
  - **The reveal replaces that bar in place, and the move drops onto it.** A move gets **one** bar for its whole life — anonymous wind-up, then itself, then possibly struck out — each stage replacing the last rather than adding a row beside it. The reveal plays a new `drop` animation: the move falls from above, lands hard with a squash, and settles, deliberately vertical and unlike `attack`'s sideways commitment, since this is the move *arriving*, not doing anything yet. The Stamina flash fires on the same beat.
  - **Idempotency:** `processTic` is re-entrant by design (a pause mid-Tic resumes into the same Tic), so wind-ups are emitted against the set already recorded for that resolution rather than blindly re-posted. A 0-Startup move — placed and revealed on the same Tic — is skipped rather than flashing a `???` for one beat.
- **A round opens by declaring what is already in flight — the `carryover` event (decided, new).** A move revealed in an *earlier* round whose footprint runs into this one never reveals again, so under the old event set the new round's log started with no trace of it and the cutscene drew nothing for that fighter — a Long Guard still covering Tics 1-2 simply did not exist on screen, and a round that opened with a hit into it read as a hit into nobody. At the head of every genuinely-new resolution the engine now queries for each of the pair's already-revealed moves whose `reveal_tic + active_tics + recovery_tics + recovery_extension_tics` still exceeds the new round's start Tic, and emits one `carryover` event per move carrying **exactly the payload shape a `reveal` carries** — the same self-contained name/footprint/Stamina bundle per §0 — anchored to the round's first Tic. The cutscene therefore needs no special case: it builds a bar from a `carryover` the same way it builds one from a `reveal`, in that move's real phase colours (a carryover is drawn as what it is, not as a distinct greyed-out kind of thing), and the feed says "*X* is still in *Move* from last round." The emit is gated on the resolution row being newly created, so a pause/crash resume re-entering the same round cannot post it twice.
- **Rolls happen server-side, not as a prompt.** The old behavior — a Roll dialog auto-opening for whoever controlled a revealing move — is gone. A revealed move with a Roll is rolled immediately by the engine using that move's own slots, with an ambiguous Hand/Leg slot resolved to the side chosen at declare time (or to *both* sides, if that slot was taken twice), and the move's effective modifier applied. The result still posts as an ordinary roll to chat *and* as a `roll` round_event. Rolling by hand still exists everywhere outside the automated flow (a character sheet's own dice, the chat Dice Tray).
- **A defence-pure move never runs the attack flow (decided, new).** A move flagged Defensive with **no Attack Target** is defence-pure: it exists to be *selected as the defender* when someone attacks into it (that happens inside the attacker's own resolution, at the defence-selection step above) and it never attacks on its own account. Having an empty Attack Target is the **correct** authoring for such a move, not an oversight, so the engine skips attack resolution for it entirely and says nothing — it used to run the flow anyway, which rolled the move a second time and then reported a spurious "no eligible target". A Defensive move that *does* carry Attack Targets is a counter-attack — it defends *and* attacks — and takes the normal path. Separately, a **non-defensive** attack with an empty Attack Target is still a real attack (see Attack Target below: a Successful Block is what gives it a target), so it falls back to the same deterministic lowest-`character_id` opponent rule Uneven Combat uses and lets defence decide the outcome; bailing there previously made that documented rule unreachable and skipped the Block altogether.
- ~~**Block is fully automatic** — pure dice math, zero prompts (decision #1).~~ **Superseded:** the Defence rework's decision #1 reversed this — see the bullet below and that subsection. What still holds: a `too-early` overlap auto-fails, and a **`too-short`** overlap that the GM confirms resolves the Block, extends the blocker's Recovery, and *then* pauses if that extension collides with an already-declared move.
- **Catching an attack's opening frame is a working Block, not a failed one (decided, renamed).** The coverage classification `classifyDefenseCoverage` returns for "the guard is up for the attack's first Active Tic but runs out before the last" was called **`too-late`**, and every message built on it said so — "blocked late", "the guard came up late". That told the table a *correct* Block had gone wrong: catching the opening frame and holding it is how a Block is supposed to work, and the Recovery extension is the rule doing its job, not a penalty. The value is now **`too-short`** (accurate about the geometry — the guard is in time but not long enough — without implying a mistake), and the announcements are phrased as the success they are: "*X's Guard catches Y's Haymaker — Recovery extended by 1 Tic to hold the guard through it.*" Dodge is the branch that genuinely fails here, and only because a Dodge has no partial case at all. The cutscene still understands the old `too-late` key so a replay stored before the rename keeps reading correctly.
- **What matters is where the Defense Frames land, not where the move was placed (decided, new — this was a real bug).** Placing a Block on the *same Tic* as an incoming attack does not make it defend: if its Defense Frames sit on its Startup square, those absolute Tics fall a Tic *earlier* than the attack's Active window, and there is no overlap to classify at all. The engine used to treat this exactly like "the defender declared nothing" — silence, no roll, full damage — which reads at the table as "Block is broken" rather than "you guarded a Tic too early." Now, whenever the defender **did** have Defense Frames somewhere and none of them overlapped, resolution emits a `defense_resolved` event with `coverage: 'no-overlap'` (`defenseType: null`, plus the exact Tics that *were* covered against the attack's own Active window) and posts a chat line saying so by name. The attack still lands in full — the rule is unchanged, only its legibility is. See also **Defense Frames** under Moves & Tells for the authoring side of the same fact.
- **Every defensive roll reaches the cutscene (decided, new — the same bug's second half).** A defender's Block/Dodge roll was going to the Chat Log via `logRoll` but was never appended to `round_events`, so the replay showed the attacker rolling into a defence that appeared to roll nothing. Both defensive-roll paths now emit a `roll` event carrying `defensive: true` and the `defenseType`, so a round with a Block in it shows two rolls where two dice were actually thrown.
- **The Recovery extension is announced, never asked (decided, new).** Decision #1 keeps Block outside the prompt loop, so extending the blocker's Recovery used to happen entirely silently — the table only found out by noticing the blocker was committed longer than they authored. It now does two visible things, neither of them a prompt: a GM chat line naming who blocked late, by how many Tics their Recovery grew, and whose attack it is covering; and a `recovery_extended` `round_events` row carrying `{ declaredMoveId, characterName, moveName, defenseKind, extensionTics, extendedFromTic, recoveryEndTic, attackerCharacterName, attackerMoveName }`. The cutscene folds that row into the move's own footprint (so the bar genuinely grows at the moment the event plays, not retroactively) and paints those Tics **in the Block's own defence colour at 30% lower opacity** — visibly "the block, still running" rather than ordinary authored Recovery. The move-conflict pause below is unchanged and still fires on top when the extension collides with something.
- **Every move telegraphs its first frame, guards included (decided, revised).** The Tic Counter's grey glow used to mark only moves that *could hit you* (`isTelegraphedAttack`), which made the **absence** of a glow a free and perfectly reliable read: it said "they are turtling", and it made a pure guard the one move an opponent could identify without reading anything. Every declared move now marks its placement Tic. The `telegraphsAttack` field is gone from the wire entirely — it existed to gate this glow and there is no gate any more; `isTelegraphedAttack` itself stays, because `isAttackingMove` (the Perk seam) asks a genuinely different question with the same words. A Feint-masked move still glows on nothing, since its row is dropped from the payload outright rather than blanked.
- **Every defence asks the GM** (decision #2, extended — see the Defence rework subsection below, whose decision #1 reversed this overhaul's "Block is fully automatic, zero GM clicks, ever"). A **Dodge** that doesn't fully cover the attack's Active window auto-fails without asking — there's no judgment call in a mechanically-doomed dodge — so only full coverage pauses, with `status = 'paused_dodge'` and `combat:dodge_prompt`. A **Block** pauses on `full` *and* `too-short` coverage, with `status = 'paused_defense'` and `combat:block_prompt`. `too-early` is auto-Failed for both. Either prompt reaches **every GM, wherever they are in the app and whenever they next connect** — it rides the ordinary combat snapshot rather than a one-shot push (see *Pause delivery* below); answering it (`combat:resolve_dodge` / `combat:resolve_block`, GM-only) applies the call and resumes that pair from the exact Tic it stopped at. Every other pair keeps resolving throughout — nothing about one pair's pause touches another's.
- **Move conflict stays the affected player's call** (decision #3), not the GM's: Forfeit or Postpone, same prompt and payload as before the overhaul. Only its trigger moved — the engine raises it now. Postponing can cascade into a fresh collision, which simply re-pauses.
  - **A Postpone says where the move went (decided, new — this was a reporting gap, not an engine bug).** Postponing looked at the table like the move had been deleted: it vanished from its Tic and the log's only line was a bare "Move conflict resolved," so nobody could tell whether it was still coming. Two reproductions (a postpone landing inside the same round, and one pushed past the round's end) confirmed the engine was already correct — the move re-reveals, rolls and resolves at its new placement, in this round's resolution when it still fits and in the next round's when it doesn't. What was missing was the sentence. The `move_conflict_resolved` event now carries `moveName`/`characterName` and, for a Postpone, `newPlacementTic`/`newRevealTic`/`intoNextRound`, and the cutscene renders it as *"Postponed Striker's Haymaker to Tic 5"* — or *"…to Tic 2, which lands in the next round"* when it was pushed past this round's window. A Forfeit names the move too, and says its Stamina was refunded.
- **Interruption fires automatically** (decisions #4/#7/#8) — no prompt. When a hit lands, the engine walks the attacker's Active window for the first Tic at which the target is still inside their own move's Startup; if it finds one, the two moves are **contested**: the attack's own roll `+ Interrupter (x)` against the caught move's own roll — thrown on that move's Roll, or Body if it has none — `+ Hard to Interrupt (x) + computeInterruptBonus` (one point per Active frame of the attack already elapsed). **The attack has to genuinely beat that total**; the caught fighter wins ties. On a win the Startup move is deleted and half its Stamina Cost refunded. This mechanic was fully coded long before the overhaul and never reachable from any UI; the engine is what finally invokes it.
  - **An Interrupted move is shown as a wreck, not erased (decided, new).** It was the one thing on the board that left no trace at all: a move dies in Startup, so it never reveals, so no `reveal` event ever described it and the cutscene had never drawn it — the log then announced an Interruption of something the viewer had never seen, and a fighter who had committed a move for the round simply had an empty row. The `interrupt_resolved` payload now carries the move's whole would-be footprint and its owner's identity (self-contained per §0, and necessarily so: the row it describes is deleted moments later, so nothing downstream — a live cutscene a beat later, a replay days later — can look it up), and the cutscene draws a bar for it from the moment it is struck: **grey instead of phase colours, struck through along the Tics it had reserved, dimmed, and inert** — no lunge, no flinch, not even its owner's own being-hit shake, because it isn't happening. Only when the interrupt actually landed; a survived attempt leaves the move secret and intact, and striking out a move that is still coming would be a lie.
  - **It is labelled "Interrupted", never by name (decided).** The move never reached its reveal Tic, and being destroyed early is not a reveal — the secrecy rule is unchanged, and a stored replay is public to anyone (decision #11), so a name in that payload would disclose to everyone a move its owner never had to show. Its *timing* is shown, which was never secret: footprints ride `combat:updated` to every viewer for every declared move regardless of reveal state, and only `moveId`/`moveName`/`staminaCost` are gated.
  - **Bugfix found in the same pass:** the cutscene's Interrupt narration read `interrupted`/`halfDamageSteps` off a payload that carried `succeeded`/`threshold`, so every Interruption — successful or not — narrated as *"Held through the hit — rolled N against 0 steps"*. The payload now uses the game's own vocabulary (`interrupted`, `halfDamageSteps`) and the line names the character and says whether the move came out.
- **Every automation reaches the cutscene, not just the Chat Log (decided, new).** On Hit/Block/Miss/Successful-Defense/Failed-Defense effects always *did* fire mechanically — Stamina moved, Recovery extended — but they emitted no `round_event`, so from inside the cutscene they were invisible and the whole feature read as un-automated. `applyMoveInteractions` now emits an `automation_fired` event carrying the move's name, the trigger's display label, the author's own text, and the **already-rendered effect phrases** (`−2 Stamina → Ghost`) rather than raw automation rows — the wording is decided once, next to the code that applied each effect, so the cutscene and the Chat Log can never describe the same thing differently.
- **Stamina movement is in the log too (decided, new).** `adjustStamina` and Idle-Tic Regen emit `stamina_changed`/`stamina_regen` carrying the resulting value, not just a delta, so a clamp at 0 or Max can't desynchronise anything. Without this the cutscene's fighter cards (below) showed Stamina frozen at the round's start while the log said it had moved — a number contradicting the sentence above it is worse than no number.
- **Two new automation types reach a character's dice (decided, new): `self_stat_step` and `opponent_stat_step`.** Every automation before them touched Stamina or timing; these step a **named** Stat (the concrete slots only — an automation names one Stat outright, so the ambiguous Hand/Leg vocabulary has no meaning here), using the same half-damage stepping real damage already uses. A negative amount steps the Stat back **up**, which is how a move heals. They report through their **own** `stat_stepped` round_event (revised — they used to borrow `damage_applied` tagged `source: 'automation'`). The borrowed event was wrong in both directions at once: a *negative* amount steps the Stat back up, and the log narrated that as "−1 steps of damage to Stamina", while a positive one arrived as an anonymous hit with no attacker and no move behind it, duplicating the `automation_fired` line that had already described it properly. Reported as "stat stepping on hit looks weird". `stat_stepped` carries the signed step and the die's before/after, so the cutscene says which way the Stat moved, moves the pip on the fighter card either way, and flashes the red hit treatment only on a step **down**. The mechanic itself was measured and was working on every trigger — this was a narration defect, not an engine one. Stored replays from before the change still hold the old events, so the renderer keeps reading `damage_applied` + `source: 'automation'` as a step rather than as damage (§0: a stored event is never rewritten). This is what lets an authored On Hit say "and it wrecks their Right Hand" without a human applying it afterwards. The Move Creator shows a Stat picker for exactly these two types, and an automation naming no valid Stat is dropped server-side rather than stored as a row that could never fire.
- **Two more, from play (decided, new): `self_stat_increase` and `opponent_next_roll_penalty`.**
  - **`self_stat_increase`** is `self_stat_step` with its direction in its *name* instead of in its sign, and it is the same mechanic underneath — negated at the single point either one executes (`applyMoveInteractions`), so there is no second implementation to drift. Restoring a Stat was always possible by typing a negative amount, but "type minus two to heal two" is not an authoring affordance anybody finds; it now has its own option with a plain positive number and its own Stat picker.
  - **`self_stat_recover` is the same upward step with a CEILING on it (decided, new): it can never take a Stat past its own locked baseline.** That ceiling is the whole difference between healing and improving, and it is why this is a third type rather than a flag — `self_stat_increase` is a move that makes you better than you started, and Recover Stat is a move that puts you back. Both are negated at the same single point either executes, so there is still one stepping implementation. Three details, each decided rather than incidental: **a pending half step is cleared before a whole one is bought** (the same reading `character:revert_stats` uses — a Stat put back to base must not still be carrying half a step it already paid for); **a die already at or above its baseline is left alone entirely**, so overspending the amount is harmless and "recover 5" on an undamaged Stat is a no-op rather than a buff; and **a die that was never locked has no baseline to measure against and is left uncapped** rather than pinned to a d4 it never agreed to. Measured in the same `rankOf`/`dieAtRank` rank unit everything else counts in. The effect line says `(recovered)` so the log distinguishes it from an increase that happened to be the same size.
  - **`opponent_next_roll_penalty` is a DEBT, not a modifier**, and it is the first of its kind. Every other roll modifier in the game is a standing fact re-read at each roll (`combatBonuses.js`); this one is **spent by the very next roll that character makes, of any kind, and is then gone**. It lives in a new `characters.pending_roll_penalty` column — on the character rather than on a seat, so it survives the fight ending and cannot be shed by being re-seated — and is read-and-cleared inside `getCombatRollBonusBreakdown`, which is precisely why it lives at that one funnel: every roll a character actually makes comes through it exactly once (the engine's move rolls, the defensive roll, the Interruption roll, and the three hand-thrown paths in `server/index.js`). Spending it anywhere else would mean finding all six again; spending it twice would be worse. It surfaces as a named `next_roll_penalty` term labelled **Weakened** on the roll's own breakdown, plus its own `next_roll_penalty` round_event when it lands.
    - **The per-round Initiative roll is deliberately NOT one of those rolls (assumed — worth confirming).** It reads `getStanceMatchupBonus` directly and never sees the debt. Taken literally, "the next roll of any kind" would include it, and a penalty applied mid-round would then be paid off by the *next* round's Initiative before its victim ever threw a move — which would make the effect almost impossible to feel. The reading taken is "the next roll **they** make", where Initiative is bookkeeping the round does on their behalf.
  - **`opponent_next_roll_bonus` is the mirror of that debt, and deliberately narrower (decided, new; implemented).** "Improve their next roll **against you**": the opponent's next roll is improved by the amount — but only a roll actually aimed at the fighter who handed the opening over. In a 1v1 that is every roll and the two effects read identically; **in an Uneven Combat it is the whole point** — you dropped your guard against *this* opponent, and the fighter beside you gets nothing out of it. A separate type rather than a negative `opponent_next_roll_penalty` for the same reason `self_stat_increase` exists: "against you" is a different rule, not a different sign.
    - **A table (`pending_roll_bonuses`), not a column**, and that is forced by the rule: this credit names *who it is good against*, and one fighter can be owed one by each of several opponents at once. A column could hold the number but not the "against whom", and dropping that drops the effect. `UNIQUE(character_id, against_character_id)` so two moves leaving a mark before the beneficiary rolls are both paid at once, and on the characters rather than on seats, exactly as the penalty column is — a mark somebody already left survives the fight ending and cannot be shed by being re-seated. Cleared explicitly on both columns in `DELETE /api/characters/:id`, like every other line of that cascade.
    - **Consumed at the same single funnel**, `getCombatRollBonusBreakdown`, now taking an `againstCharacterId`. **Omitting it consumes nothing** — a hand-thrown Stat roll, a Weapon check and an Initiative roll are not rolls "against" anybody, and the credit stands rather than being spent on one. Surfaces as a named `next_roll_bonus` term labelled **Opening**, plus its own `next_roll_bonus` round_event when it is handed over.
    - **Which rolls know their target.** The attacker's own move roll (against the fighter's declared target, or the sole opponent when there is only one — asked by `declaredRollTarget` *before* the roll, since the engine's full Uneven Combat target selection runs after it and needs the damage figure); a Block's guard roll (against the attacker it is held against); the Interruption roll (against the attacker doing the interrupting); and both halves of a grapple contest. Anywhere the answer is not certain — several unnamed opponents opposite — it is null, and guessing is exactly the bug the effect exists to prevent.
- **Bugfix in the same pass: the move card printed the automation's raw type.** `automationLabel` (`client/src/lib/moveDisplay.js`) had no case for either stat-step type, so its `default` branch rendered literally `opponent_stat_step 1` on the card — reported as "the Step Stat trigger shows a string instead of a proper name", and correctly guessed at: the stat-step types are the only ones that carry a Stat, and the Stat was never threaded into the label. Every authored type now has a case (and names its Stat, and says "up"/"down" rather than printing a minus sign and leaving the reader to work out that negative damage is healing). The fallback is kept rather than removed, because a card must still render *something* for an automation saved by a newer version of the app than the one displaying it — but `server/test/moveDisplay.test.js` now walks `AUTOMATION_OPTIONS` and fails if any type reaches it, which is the test that catches the next missing case.
- **Insignificant Damage is a hit, never a Miss, and is still defensible (decided, revised twice).** A roll under 5 — fewer than one Half-Damage step — is an attack that *landed* and did too little to matter. It is announced as **Insignificant Damage** (a chat line and an `insignificant_damage` round_event) and, because it connected, it fires the move's own **On Hit** trigger.
  - **A Miss is an attack that was evaded, and nothing else.** It comes from exactly one place: a successful (Full) Dodge, fired in `applySuccessfulDodge`. A weak swing touched its target, so calling it a Miss described the wrong event; an earlier revision had it firing On Miss to make that trigger more reachable, and that is reverted — On Hit is the trigger that matches what happened, and it is no less reachable. A **Full Block** still fires `block`, not `miss` — something was there to stop it, which is a different event again — and a **Partial** Dodge fires `block` like any other partial defence. Exactly one trigger fires per attack, since they all hang off the same `interactions_resolved` flag.
  - **A weak attack still runs the whole defence flow (decided, new — this was a real bug).** The sub-5 check used to sit in `resolveAttack` immediately after the attacker's roll and `return` outright, which skipped target selection and the entire defence step. An insignificant attack therefore could not be blocked or dodged at all: no defending move was ever selected or rolled, and **On Block / On Successful Defense / On Failed Defense never fired against one** — a defender who had timed a guard correctly watched nothing happen. The check now lives at the point the attack actually *lands* (`runInterruptAndDamage`, the single funnel shared by the undefended path and the failed-defence path), so an insignificant attack is selected against, defended against, and classified exactly like any other. It reaches the Insignificant-Damage branch only when nothing stopped it.
  - **When a defence resolved it, the defence's own outcome is what the log says** — no second Insignificant-Damage line on top of "scored a Full Block". The defence is what settled the attack, and reporting both reads as contradicting itself.
  - It never reaches `applyAutoDamage`: stepping a die zero times rewrites the row unchanged and posts "took 0 damage to Body", which reads as a bug rather than a rule. The Interruption check is likewise skipped, since `checkInterrupt` is gated on damage actually having been applied. `fireMissIfNoDamage` in `server/index.js` — already unreachable since the overhaul made every combat roll server-computed — remains gone.
- **The round ends itself.** Once the last Tic resolves, the pair's resolution is marked `complete`, a single `round_summary` chat card is posted ("Watch Round N between X and Y"), and `startPairDeclaration` opens that pair's *next* round immediately — per pair, independently (decision #12). Fight A can be on round 5 while fight B is still on round 3; no fight ever waits on another.
- **Overflow is unchanged.** A move whose footprint runs past the round's window simply carries into the next one — the counter never resets, so a reveal Tic was always an absolute point on the timeline, and that character's next move can't be placed earlier than their previous move's full footprint end regardless of round boundary.
- **Watching it happen.** It opens **near-fullscreen** (`DialogShell`'s new `theater` variant — 94dvh x 96vw on desktop, the whole viewport on mobile): a cutscene is watched, not filled in, and the `fullscreen` variant's centered `max-w-md` panel squeezed the timeline and its log into a column. **The event log reads as plain sentences** naming who did what ("Ghost reveals Jab.", "2 steps of damage to Body on Striker.") rather than a terse label needing a hover to decode — nobody at a table is going to hover a line to find out who hit whom. The hover detail is still there, now genuinely supplementary (raw dice, exact windows) rather than the only place the outcome is stated; a `damage_applied` event carries the target's *name* for the same reason §0 makes reveal payloads self-contained.
  - **A total is itemised, so a Combat Style has a name attached (decided, new).** A roll's `modifier` is one number made of several rules — the move's own Roll Modifier, a Perk's bonus on that move, Reasons to Fight, the Stance matchup, the move's Combat Style, the −2 for being held in a grapple, and the ±5 read on a grab. Printed as a single figure it read as the engine inventing numbers, and a Combat Style worth three points in particular had no way to say so. Every roll event now carries a `modifierBreakdown` — `[{key, label, amount}]`, zero-valued terms dropped, in reading order — and the cutscene's log lays the total out as terms (`9 + 2 (Stance matchup) + 3 (Combat Style: Strength) − 2 (Held in a grapple) = 12`) whenever there is more than one, falling back to the plain `sum + mod = total` line when there isn't. The hover detail lists one line per term. `modifier` itself is unchanged and still the whole sum, so the Chat Log's roll card is untouched; a stored replay from before this change has no breakdown and falls back to the old single line (§0 — stored events are never rewritten). Built by `getCombatRollBonusBreakdown` in `server/combatBonuses.js`, which is now the itemised form of `getCombatRollBonus` (that function delegates to it, so the two can't disagree), and rendered by `formatRollBreakdown` in `client/src/lib/dice.js`, unit-tested in `server/test/rollDisplay.test.js`.
  - **A roll is shown as the sum it is (decided, bugfix).** `logRoll` stores only each die's *summed* `result` — `rollDie(size) + bonus + modifier` — because the physical die face is never persisted. The cutscene printed that summed result as though it *were* the face and then appended the modifier separately, so a d4 came out as **"Skull 14 (+11) — total 14"** and the hover detail said "Skull: d4 -> 14 / Modifier: +11". Both lines are self-contradictory: a d4 cannot show 14, and 14 + 11 is not 14. This is why the engine's automatic move rolls were reported as ignoring their modifiers — **the arithmetic was always right** (measured: a Skull d4 with move Roll Modifier 9 + Reasons to Fight 2 rolled a face of 3 and correctly totalled 14; the defensive Block roll with Roll Modifier 6 rolled 2 and totalled 8), only the sentence describing it was wrong. Both lines now decompose the stored result back into face + flat addition, reading **"Atk rolls Skull 3 + 11 = 14."** and **"Def defends with Body 2 + 6 = 8."**; the `— total N` tail is dropped for a single-die roll, where it only repeated the number. The decomposition lives in `decomposeRoll`/`formatRollPart` in `client/src/lib/dice.js` and is **shared with the Chat Log's roll card**, which had been doing it correctly by hand all along — the two surfaces that print the same numbers now cannot drift, the same consolidation argument as `framePhaseColors.js`. Covered by `server/test/rollDisplay.test.js`, which asserts the recovered face is always a real face of the die across every size/bonus/modifier combination.
  - **Typography scales with the window (decided, new).** Going near-fullscreen without resizing anything inside it just produced a lot of empty panel around mobile-sized text. Every element in the cutscene — the frame squares, the Tic squares, the name columns, the event feed — now carries a `md:` step up, so the desktop theater view uses the room it took and the mobile view is untouched.
  - **The timeline stays fixed-size (decided, reverted).** A fluid version was tried — `flex-1` cells sharing the row's full width, so a 99vw dialog's strip spanned the panel instead of floating ~350px wide in it — and it made the cutscene worse, not better. Stretched to ~245px each, the Tic cells stopped reading as Tics: an empty round was a row of enormous blank rectangles, and a short move's bar became a thin sliver inside one of them, so the strip only looked right once it happened to be full. A Tic is a fixed unit of game time and its cell should be the same object whatever the window is doing. Both the move bars and the Tic strip are back to fixed cells (`w-8`, `md:w-11`), sharing one geometry so they stay in lockstep; the panel simply has room around a short round, which is the correct thing for it to have. **Typography scaling (the bullet above) stands** — that part was never the problem.
  - **Combat animations (decided, new).** Every move's bar acts out what the log is saying, keyed off the same event stream (§0) so a replay animates identically to the live watch — nothing here computes an outcome, it only performs one:
    - **Attack** — the bar steps *toward the opponent* and hangs at full extension before recovering. Direction comes from the layout: Players sit above the strip and NPCs below, so "forward" is +y for a Player and −y for an NPC.
    - **Block** — the bar swells and holds, with concentric glowing rings ("afterlines") pushing out behind it and the covering Defense Frames lit.
    - **Dodge** — a lateral weave, deliberately unlike the attack's forward commitment so the two never read as the same motion.
    - **Insignificant Damage** — a dim and a twitch, visibly smaller than any real impact: it landed and nothing happened.
    - **Reveal** — the move drops onto the row its anonymous wind-up had been holding open: falls from above, lands with a squash, settles. Vertical on purpose, so it never reads as the sideways commitment of an attack. See Combat Timing's `windup` bullets for the wind-up half of this.
    - **Interrupted** — the opposite of an animation: the bar goes grey, gets struck through along its own footprint, dims, and stops reacting to anything. See the Interruption bullets under Combat Timing's Resolution Phase for why it is drawn at all and why it is never named.
    - **Damage** — an impact burst centred over the board carrying the damage number and the Stat it hit. **A 2+ step hit is a different event, not a longer one**: bigger, redder, rotated, with a much wider shockwave and a scale punch. The target's bars shake, and the burst fires whether or not they have a bar, so a hit is never invisible.
    - **Stamina on reveal** — the move's cost floats up in glowing amber as it comes out. `reveal` payloads now carry `staminaCost` for it (per §0, since the move's own cost could be edited in the Compendium before a replay is watched). **Bugfix:** it looked like it was rendering *behind* the row and was in fact being cut off by it — the number floats up out of the move-name cell, and that cell carried `truncate`, whose `overflow: hidden` clipped everything leaving its box. No amount of `z-index` fixes a clip. `truncate` now applies to an inner span so the name still ellipsises, while the flash sits in the unclipped outer cell above everything else.
    - `prefers-reduced-motion` is honoured explicitly here. `index.css`'s global rule only reaches CSS animations and transitions; Framer drives inline transforms from JS and sails straight past it. Under reduced motion the bars stay still and the burst keeps its number but drops the shockwave, scale and rotation — the log always says everything that happened, so the motion is emphasis and never the only carrier.
  - **The fighters are on screen, and damage lands on them (decided, new).** The theater window was a small board over a short log and then a great deal of nothing — and "3 steps of damage to Body on Ghost" meant nothing without a Body to watch it land on. A new `roster` event at the head of each resolution captures every seated fighter with their dice and Stamina *as the round opened* (self-contained per §0 — by the time a replay is watched those describe a different fight; portraits are deliberately excluded, being base64 blobs in a row stored forever, so the cards use the same initial-letter placeholder the rest of the app falls back to). Each fighter renders as a card of Stat pips below the board. When a hit lands, `damage_applied` now carries the die's **before and after** size/bonus/status, so the targeted Stat flashes red, punches, and shows what it stepped to — reading `OUT` and struck through once it is incapacitated. Damage is something you see happen to a person rather than a sentence in a feed.
  - **Playback walks Tics, not events (decided, revised).** The playhead used to be simply "the last revealed event's Tic", so a round with nothing between Tics 3 and 7 jumped straight across and the quiet stretch of a fight — which is most of a fight — never happened on screen. Playback now runs on **beats**: each Tic is a beat of its own, followed by that Tic's events. A Tic where nothing lands still gets its dwell, its playhead step, and a thin `nothing lands` marker in the feed so the log reads as time passing rather than as a stall. Tic beats stop at the last Tic any event actually landed on, which in live mode is the furthest the server has resolved — playback walks up to the present and waits there instead of racing into Tics that have not happened yet; a replay's own `round_complete` sits on the last Tic, so the whole round is covered.
  - **Playback speed is the viewer's own setting.** A **0.1×–3×** multiplier from Settings divides the per-event dwell; see Pages / views — Settings for why it is per-device and never leaves the client.
- **The client never computes any of the above**; it receives the ordered event log and animates it (`RoundCutscene.jsx`) — Players' moves above the Tic strip, NPCs' below, with a skip-to-end control that is trivial precisely because everything was already computed before any animation began. A GM with several fights running gets a per-pair tab strip to choose which one they're watching; only the selected pair mounts a live cutscene. The same component replays a finished round from the chat log, off the same stored rows, so a replay and the live view cannot disagree.
- **A finished round's replay outlives the fight (decided, new).** `combat:end`/`combat:clear` used to delete every `pair_round_resolutions` row, and `round_events` cascades off it — so the "Watch Round N" chat card, which survives both, pointed at nothing. Only **unfinished** resolutions are dropped now (a half-resolved round has nothing worth replaying, and leaving one `running` would have the boot-time sweep try to finish a fight that no longer exists). Keeping the completed ones means a fresh fight's round 1 would collide with the old `UNIQUE(pair_index, round_number)`, so uniqueness is scoped to a **`fight_number`** — a new `combat_state.fight_number` bumped once per Start Combat (only when the current number was actually used, so a first-ever start stays on fight 1) and stamped onto each resolution row. SQLite can't ALTER a UNIQUE, so `initDb` rebuilds the table (the `migrateChatLogKind` precedent), turning foreign keys off across the swap — this database has them ON, unlike stock SQLite, so a naive `DROP TABLE` would cascade away exactly the `round_events` the change exists to preserve. Row `id`s are preserved, which is what keeps every `round_events.resolution_id` valid afterwards. Covered by `server/test/migrationFightNumber.test.js`.
- **Surviving a restart.** Nothing about a round lives in memory: a pause is DB-durable (`pending_dodge_json`/`pending_conflict_json`), and `resolved_through_tic` is only bumped as the last write for a Tic, so a crash mid-Tic simply redoes that Tic idempotently. At boot, `resumeAllPairsOnBoot` sweeps every still-running resolution and finishes it. A GM who connects mid-pause picks the prompt up from the regular combat snapshot rather than needing its own resync path.

**Stamina Cost (decided, commit timing revised):** every move carries a required **Stamina Cost** (0 is a valid free cost; negative restores Stamina instead of spending it). Declaring a move never spends it immediately — `move:declare` only checks *affordability* up front, against the declaring character's Current Stamina minus every other move they already have queued-but-not-yet-committed this Declaration Phase (so a character can never queue more than they could actually pay for once committed; an unaffordable declare is a silent no-op, same pattern as every other rejected declare). **The actual spend/restore now happens per character (revised, combat redesign)** — the moment *that character themselves* presses **Done Declaring** (`combat:character_done_declaring`), not batched across a whole side anymore — clamped to `[0, max_stamina]` as a defensive backstop (the up-front check already keeps this from going negative in the normal flow). Because the move can be declared to land at any open Tic, and its Stamina Cost is committed well before its Startup even finishes, the Arena deliberately shows **no timing/length information** for a still-secret declared move (see Combat Arena below) — only a live Stamina *preview*, visible only to whoever is entitled to see that move early (same rule as above; `staminaCost` rides `combat:updated` whenever the move's identity does, and stays `null` otherwise).

**Block Stamina — the Block Tag is the first Tag that does something (decided, new).** Tags started as pure annotation (a GM-authored name + description, rendered as a chip with a tooltip). The **Block** Tag is the first one carrying a mechanic, and the intended first step toward automating Tags generally: `server/tagAutomations.js` holds a `TAG_HOOKS` registry keyed by the Tag's exact **name**, deliberately shaped like `PERK_HOOKS` in `perkAutomations.js` — hand-written behaviour per Tag rather than a generic effect system (the generic approach was tried once for Perks and removed; the lesson carries).
- **A move carrying the Block Tag has no up-front Stamina Cost at all.** `writeMove` forces `stamina_cost = 0` for it server-side regardless of what the client sent (the same server-authoritative pattern a Default move's style and the Stat/Custom roll split already use), so `move:declare`'s affordability check never gates one — **a Block is always declarable**, and it is paid for after the fact.
- **It pays at resolution for exactly what its guard absorbed.** `absorbed = min(attackerResult, defenderResult)` — out-guarding an attack by a mile costs no more than the attack was worth (a 6 met by a 20 is fully negated and charges 6). Scaled by the move's own **Stamina Modifier** (`moves.stamina_modifier`, REAL, `clampStaminaModifier`): a multiplier that may sit either side of 1 — 0.5 is a cheap guard you can hold all fight, 2 one that costs dearly — but **never 0 or negative** (0 would make blocking free, which is what this rule exists to prevent; anything unparseable falls back to 1 rather than to the floor). Rounded **to nearest**, ties up. `resolveBlockStamina` in `server/combatDamage.js`.
- **The guard only holds as much as it can pay for (decided).** If the full absorb costs more Stamina than the blocker has left, the block is scaled back to the largest amount they can actually afford and the remainder of the attack gets through — announced by name in chat. That is what stops a fighter at 0 Stamina from blocking forever for free, and it makes Stamina the real defensive resource.
- **With Stamina to spare the damage math is provably unchanged:** `netResult = attackerResult - absorbed` equals the old `max(0, attackerResult - defenderResult)` in both directions, so this re-prices Block without re-balancing it.
- **The Tag is the switch, not the Block/Dodge toggle.** A Defensive move with `defense_kind = 'block'` but no Block Tag keeps the old flat-cost behaviour exactly. The Move Creator's Block/Dodge toggle and the Tag are separate authoring facts on purpose — binding the mechanic to the Tag is what makes it the first instance of the Tag-automation system rather than a one-off branch. **Dodge is untouched** and keeps its flat Stamina Cost: a Dodge is all-or-nothing and has no "amount absorbed" to scale from.
- **Matched by name, case-insensitively, never by id.** The GM owns the tag list; ids differ between databases and a tag can be renamed or re-created. `seedBlockTag` in `db.js` creates a **Block** tag only when no case-insensitive match already exists, so a world that already has one keeps it. Per-character Tag overrides count: `character_move_tags` (a Perk adding or removing a Tag for one character) is resolved before the check, so a Perk that grants the Block Tag genuinely makes that move block-costed for that character — which is the whole point of hanging mechanics off Tags.
- **UI:** the Move Creator swaps the Stamina Cost field for a **Stamina Modifier** field the moment the Block Tag is selected (replaced, not disabled — an input you can fill in that the server then zeroes is worse than one that isn't there); `MoveCard` and the Arena's declare card show `×N` in the same slot the Cost badge occupies, since "0 Stamina" would read as "free".

**The No Damage Tag — the second Tag automation (decided, new).** Not everything you do in a fight is meant to hurt: a shove, a feint, a hand closing on a wrist. A move carrying the **No Damage** Tag deals none, ever, and instead asks one question — did the roll reach the move's own **Success Threshold** (`moves.success_threshold`, default 5, 0–20 whole numbers)? It is the mechanic **Grappling** is built on (see Grappling below), but it stands alone and is useful without it.
- **It is decided in `runInterruptAndDamage`, the single damage funnel** every landing attack already passes through — the plain Hit, a Failed defence, a Partial Block's leftovers and the Dodge resume path alike — so damage is suppressed everywhere at once rather than in a fifth near-copy. It never reaches `applyAutoDamage`, and never runs the Interruption check, since Interruption is gated on damage having actually been dealt.
- **Checked *before* Insignificant Damage.** Both would otherwise claim the same weak roll and the wrong one would win: a No Damage move that came up short did not do "insignificant damage", it **failed**.
- **Success fires On Hit; failure fires nothing.** On Hit is the same reasoning Insignificant Damage already uses — the move connected — and is where a No Damage move's automations hang. Failure deliberately fires **nothing**: On Miss is reserved for an attack the target *evaded*, which means a successful Dodge and nothing else (see Miss under Resolution). *This was the plan's own flagged open item; it is now decided as "nothing fires", and if the table wants a trigger for a failed No Damage move it wants a new one.*
- **A defence still counts, and the reduced number is what has to clear the Threshold.** A **Full** Block or Dodge never reaches the funnel at all and correctly fires `block`/`miss` instead — the defender stopped it, which is a different outcome from failing on your own. A **Partial** one passes its `netResult` through as `effectiveResult`, so a half-stopped shove can fail on a roll that would otherwise have been plenty. That mirrors damage exactly: what got past the guard is what the move has left to work with.
- **The default of 5 is the same figure as the Insignificant Damage floor, and that is deliberate but not shared.** A roll too weak to be worth half a point of damage is a roll too weak to have accomplished anything. They stay two separate constants (`DEFAULT_SUCCESS_THRESHOLD` vs `computeHitDamage`'s per-5 granularity) so raising one move's threshold to 12 can never change how damage is counted.
- **`seedNoDamageTag()` beside `seedBlockTag()`**, same case-insensitive adopt-don't-duplicate rule, and the same per-character `character_move_tags` resolution — a Perk that grants **No Damage** genuinely makes that move harmless for that character.
- **UI:** the Move Creator reveals a **Success Threshold** field when the tag is selected (added beside the Cost, not replacing it — a No Damage move still costs Stamina to throw); `MoveCard` shows a `N+` badge. The value is stored even when the tag is off, so untagging to compare and retagging doesn't lose it. The cutscene gains a `no_damage_resolved` event, narrated as a success or a failure against the threshold, with a failure rendered in the same muted treatment as Insignificant Damage.
- **Verified against the running app** (`scripts/playtest-nodamage.mjs`, 19 checks): a clearing roll emits `no_damage_resolved` + `automation_fired(hit)` and no `damage_applied`; a short roll emits the failure and fires nothing, with no `insignificant_damage` stealing it; an untagged control move with identical frames still deals its damage.

**The Feint Tag — the third Tag automation (decided, new; implemented).** A move carrying the **Feint** Tag shows its own Tell exactly like any other move; what it changes is the move declared *immediately after* it, which goes onto the timeline concealed and only becomes visible when it reveals during resolution. It is the first automation that changes **who may see a declaration**, rather than what a declaration does.
- **"Immediately after" is the Requirement's reading, not a looser one.** The follow-up must start on the very Tic the Feint's own frames end (`feintMasksDeclaration` in `tagAutomations.js`, pure and unit-tested). Held back even one Tic, it is an ordinary visible move — the concealment is bought by committing to the follow-up in the same breath as the lie, which is also what stops "declare a Feint at the top of the round, then hide everything after it".
- **Concealed by ABSENCE, not by blanking.** `mapDeclaredMovesForViewer` **drops the row entirely** from every non-owner's payload until it is `publiclyRevealed`, rather than nulling its Tell ids. Every other secret in this game is protected the same way (`moveId`/`moveName`/`staminaCost`, `mapPendingGrappleForViewer`), and here it is the only option that actually works: a row reading `{ placementTic: 4, feintMasked: true }` would hand an opponent with devtools exactly the fact the Feint exists to hide, and `telegraphsAttack` would paint the attack-telegraph glow on that Tic for everyone regardless of what the Tell said. Dropping the row takes the Tell, the telegraph and the placement with it. **The Feint itself is completely public** — that is the bait.
- **Frozen at declare time (`declared_moves.feint_masked`), not derived at read time.** Two things would otherwise change the answer after the fact: a Block extending the Feint's Recovery (`recovery_extension_tics`) would break the contiguity test mid-round, and a GM adding or removing the Tag on the Move template would retroactively mask or unmask a declaration already on the board. The per-character resolved tag set is used (`moveTagNamesFor`, now exported from `roundResolution.js`), so a Perk that grants **Feint** genuinely makes that character's next move disappear.
- **Taking the Feint back takes the concealment with it.** `move:undeclare` clears `feint_masked` on whatever was placed at the deleted move's footprint end — otherwise a player could feint, hide the real move behind it, undeclare the feint and keep the free invisibility.
- **`seedFeintTag()` beside the other two**, same case-insensitive adopt-don't-duplicate rule, same name-not-id matching.
- **UI:** the declare picker shows a **"Feint queued"** banner the moment the character's last-queued move carries the Tag — the concealment is invisible from the declaring side by construction, so it has to be said out loud rather than discovered. Nothing is greyed out: declaring later, or declaring nothing, are both legal, they just aren't hidden. The owner's own Tell card for a concealed move is bordered violet and marked **"hidden — feinted into"**, which is a reassurance rather than a leak (nobody else has the row at all). No `MoveCard` badge: unlike Block's `×N` and No Damage's `N+`, Feint adds no number to show, and the Tag chip already carries its description.
- **Verified against the running app** (`scripts/playtest-feint.mjs`, 15 checks, three sockets): mid-Declaration the feinter sees two declarations and the opponent sees one — the Feint, Tell and all — with no placement Tic and no telegraph leaking for the hidden one; a standing monitor on every broadcast the opponent receives proves the row was never once sent early; after resolution it appears by name. Controls: an identical pair with no Feint Tag hides nothing, a follow-up held back one Tic hides nothing, and undeclaring the Feint un-hides what it was hiding. Browser pass screenshotted both sides.

**Interrupter (x) and Hard to Interrupt (x) — the fourth and fifth Tag automations, and the first PARAMETERISED ones (decided, new; implemented).** Both move exactly one comparison — the Interruption check — and nothing else.
- **The amount lives in the Tag's own NAME**, authored as `Interrupter (3)` / `Hard to Interrupt (2)`, rather than in a new column. A Tag is a world-level row the GM creates and names, and "Interrupter (3)" is already how a table would write it on a card; three separate Tags for three strengths is also how a GM would naturally build it. `tagAmount` (pure, in `tagAutomations.js`) parses it case-insensitively with the same tolerance `hasTagNamed` has — padding, a `+` sign, spaces inside the parentheses — **sums** every matching Tag so stacking works without anybody designing stacking, and counts a bare `Interrupter` as 1 so a GM who writes just the word gets the obvious thing rather than nothing. The prefix must match in full, so a Tag called "Interrupter Killer (9)" is somebody else's Tag.
- **Each Tag moves its own side, and only for that comparison:** `resolveInterruptContest` computes `attackerRoll + interrupter > defenderRoll + hardToInterrupt + activeFrameBonus`. Neither touches a real roll — both rolls go out at their real values, and the Tag is what that roll is *considered* to be worth for this one question. The playtest asserts this directly by comparing the punch's own `modifier` with and without the Tag.
- **Which move carries which:** `Interrupter` is read off the **attacking** move (`runInterruptAndDamage` already resolves its tag names for the No Damage check, so the amount rides in as a parameter and `checkInterrupt` never has to know which move threw the punch); `Hard to Interrupt` is read off the move **caught in Startup**. Both go through `moveTagNamesFor`, so a Perk that grants either Tag counts.
- **The comparison itself was got wrong once, and the correction is the settled rule (decided, corrected).** The first implementation compared the caught fighter's roll against the **damage** the blow had just dealt (`interruptRoll >= halfDamageSteps`), and `game_rules.md` was rewritten to match the engine on the grounds that the engine was what the table had been playing. Both were wrong. **Interruption is a contest of two attack rolls**: the punch's roll `+ Interrupter (x)` against the caught move's roll `+ Hard to Interrupt (x) + 1 per elapsed Active frame`, with the caught fighter winning ties — which is what the rules text said in the first place ("failing means the move is cancelled"), and it has been restored verbatim. **The damage plays no part in the comparison at all**: it is the *trigger* for the check, not a term in it, and it still lands either way. `halfDamageSteps` survives on the `interrupt_resolved` payload as context so the log can still say what the blow was worth, and nothing reads it as a threshold. The `+1 per elapsed Active frame` now sits on the **caught fighter's** side — the longer the attack has been out, the more of it they have had to read — and is deliberately kept **out** of the roll's own `modifier` and applied at the contest, exactly like Hard to Interrupt, so the roll that goes over `logRoll` stays an honest roll of that move and every situational term is named in one place. **This retires 4.4's long-standing "needs confirmation" note on the threshold**; there is no threshold, there are two totals.
- **No `seed…Tag()` for these two**, unlike Block/No Damage/Feint: they carry a number the GM chooses, so there is no single canonical row to seed. The GM creates the strengths their world wants.
- **UI:** no Move Creator field and no `MoveCard` badge — the Tag chip already carries the number in its own name, which is the point of putting it there. The cutscene lays the Interrupt out as **two totals with their terms named**, one line each (`the attack 14 (roll 12, +2 Interrupter)` / `Ghost 11 (roll 8, +1 Hard to Interrupt, +2 Active frames)`), naming each term only when it is non-zero — the Tags are 0 on the overwhelming majority of moves, and a line that always said "+0 Interrupter" would bury the two exchanges where the Tag is the story. The `interrupt_resolved` payload carries `attackerRoll`, `interrupter`, `result`, `hardToInterrupt`, `activeFrameBonus`, `attackerTotal` and `defenderTotal` for it (§0: self-contained, since the row it describes is deleted moments later). `RoundCutscene` still renders the **old** `effectiveResult`/`threshold` shape when `attackerTotal` is absent, so replays stored before the correction stay watchable rather than being retroactively rewritten (§0).
- **Verified against the running app** (`scripts/playtest-interrupt-tags.mjs`, 17 checks): each Tag is run as a *pair* of otherwise identical rounds, bare and tagged, so what the Tag did is the difference between two fights rather than a number to be trusted. `Hard to Interrupt (99)` turns a certain Interruption into a hold and the caught move goes on to reveal; `Interrupter (99)` turns an impossible one into a hit and the caught move never comes out; an untagged exchange reports both amounts as 0; and the punch's own modifier is identical with and without the Tag. One thing that passes but is worth knowing, found while building it: **a blow big enough to incapacitate the Stat the caught move rolls on leaves nothing to roll the Interruption with**, and the check bails before comparing anything — which is why the playtest's punch is deliberately modest and aims somewhere else.

**Movement and Movement Punisher — the sixth and seventh Tag automations, and the first PAIR (decided, new; implemented).** Neither Tag does anything on its own. **Movement** is a move admitting what it is: this takes you somewhere. **Movement Punisher** is a move built to collect on that. The mechanic lives entirely in the meeting of the two, which makes this the first Tag automation that is a *relationship* rather than a property.
- **Movement is a LIABILITY, which no Tag before it was.** Every earlier Tag buys its owner something — a Block pays later, a No Damage move trades damage for a Threshold, an Interrupter counts higher. Putting **Movement** on a move is telling the table what that move is vulnerable to, and it is worth naming as a category because it means a GM tagging moves for flavour can now make one strictly worse by accident.
- **All three conditions, and "connects" is the interesting one.** `movementPunisherApplies` (pure, in `tagAutomations.js`) asks: does the attack carry **Movement Punisher**, does the move it hit carry **Movement**, and did it land **at least half a point of damage**? A miss trips nobody, and neither does a blow a guard reduced to nothing — you have to have genuinely caught them mid-stride. Resolved in `runInterruptAndDamage` because that is where "did it actually connect" is finally known: `applied` being non-empty *is* the half-point floor.
- **The consequence is 3 Recovery, run through the ordinary Add Recovery effect.** `MOVEMENT_PUNISH_RECOVERY = 3`, a flat number rather than one in the Tag's name — the two Interruption Tags are parameterised because their whole point is scaling a contest, and this is a single consequence a table can price once. It fires through `runAutomations` with a plain `opponent_recovery`, not by reaching into the Recovery machinery directly: that is what "should work like the Add Recovery trigger" has to mean if it is going to behave identically — same displacement of everything declared after it, same Chat Log line, same `automation_fired` round event, same cutscene beat. It arrives under a `movement_punished` trigger labelled **"Tripped"**, which is not authorable on a move; it exists so a Tag's own consequence can borrow the executor and still be told apart from something a GM wrote.
- **The trip itself is narrative.** No knockdown state, no prone flag, no new phase — the fighter is simply three Tics later than they meant to be, which is what being put on the floor costs in a game measured in Tics.
- **The move being punished is found by `movementMoveInPlay`, and it is deliberately NOT gated on reveal.** Unlike `combatStyleInPlay`, which asks what the room has been told, this asks what the target's body is doing: a Movement move still in its wind-up is a fighter already committed to going somewhere, and catching them there is the entire point of the Tag. The freshest footprint wins when several overlap, matching every other "what are they doing right now" question in the engine.
- **`seedMovementTags()` seeds both**, beside `seedBlockTag`/`seedNoDamageTag`/`seedFeintTag` and with the same case-insensitive adopt-don't-duplicate guard. Seeded as a pair because a world with only one of them has a Tag that can never fire.
- **UI:** no Move Creator field and no `MoveCard` badge — there is no number to author and no per-move option to set; the Tag chips and their seeded descriptions carry it, and each description names the other Tag so the pair is discoverable from either end.

**Move Tag chips are alphabetical, not creation order (decided, new).** Two layers, both fixed: `/api/tags` now returns the world-level vocabulary `ORDER BY name COLLATE NOCASE, id` — by the twentieth Tag, "whichever I happened to make first" is not an order anybody can find anything in — and `sortTags` in `client/src/lib/moveDisplay.js` sorts a **move's own** resolved rows, which came out in whatever order the GM ticked the boxes. Every place that turns `tag_ids` into rows goes through it (`MoveCard` via Compendium, the Moves tab, the Arena's declare hover-card, the chat reveal card), so a move's chips read the same way everywhere. `COLLATE NOCASE` / a case-folded compare on both sides, matching the case-insensitive treatment every Tag *mechanic* already gives names.

**Implementation note:** the placement/reveal/overflow math above started as a bare pure-function module — `server/combatTiming.js` (`resolveSideInitiative`, `computePlacementTic`, `computeMoveFootprint`, `isMoveRevealedTo`, `relativeTic`, `isTicIdle`, `overlapsRoundWindow`, `computeInitiativeOverflowPenalty`) — unit-tested in isolation before any socket/DB/Arena wiring, per the Implementation Risks section's recommended approach; it's now wired into `declared_moves` + the `combat:*`/`move:declare` events below and a real Arena UI (Tic Counter centerpiece, per-character Done Declaring, a drag-and-drop declare picker, click-to-step Tic navigation, Tell-vs-revealed badges on each seated card). None of `combatTiming.js`'s own functions needed to change for the per-pair combat redesign — `resolveSideInitiative` was already pure and side-agnostic, so the redesign just calls it once per `pair_index` instead of once for the whole roster (see `combat_pairs` in the Data model below); its tied-initiative case is now fully specified (current Brain → locked Brain → Speed stance → random, see the Declaration Phase's Initiative ties bullet above), replacing the original arbitrary `left`-declares-first default — the cascade is scoped independently within each pair, same as the rest of Initiative. Declared-move visibility is computed per-viewer server-side (`isRevealedToViewer`/`mapDeclaredMovesForViewer` in `server/index.js`, driven by `socket.data.identity` — see `identity:set` below and Roles / access model above) — `combat:updated` is therefore a per-socket emit, not a single `io.emit`, since two viewers can legitimately see different data for the same instant; this logic was also untouched by the per-pair redesign, since early-reveal entitlement was always per-character, never per-side. This replaced an earlier `declared_move:own` side-channel that only worked for "whichever exact socket clicked declare," not "whoever is logged in as that character" — a real gap the identity system above was built specifically to close.

## Game mechanic — Combat Automation (superseded in part — see the overhaul subsection below)
**Read this section as the *rules*, not the flow.** Its damage formula, Block/Dodge Full/Partial thresholds, frame-overlap classification and interaction automations are all still exactly what the engine applies. What is no longer true is everything about *who presses what*: the GM's 2×2 Block/Dodge × Successful/Failed prompt, the chat roll card's Apply button, manual interrupt checking and manual Tic stepping have all been removed. The Resolution Phase above describes how these rules are actually invoked now.
**A second, larger overhaul of this same system — the "Cutscene Resolution" automation overhaul — is now IN PROGRESS on top of everything below; see the new subsection at the end of this one for its status.** Everything in this section describes the sub-phase 1-5 work, which is complete, unchanged by the new overhaul so far, and still accurate.

**Status: fully built and wired end-to-end** — the math, schema, socket events, client UI, and (as of sub-phase 5) the On Hit/Block/Miss/Successful-Defense/Failed-Defense automations themselves all actually execute now, closing the plan's own long-standing open item ("`self_recovery`/`opponent_recovery`/`self_stamina`/`opponent_stamina` are already fully modeled... but never actually fire"). `server/combatDamage.js` + tests; the schema (`move_defensive_roll_slots`, `chat_log.payload`'s roll-context shape, `declared_moves.recovery_extension_tics`, and sub-phase 5's own `declared_moves.interactions_resolved`); every socket event 4.1-4.4 need (`combat:apply_damage`/`combat:undo_damage`, `combat:resolve_defense`, `combat:resolve_move_conflict`, `combat:check_interrupt` — see Real-time events below for the full contract of each); the client UI (chat roll card's `Damage:`/Apply line, `DamageApplicationDialog`, GM-only `ResolveDefenseDialog`, `MoveConflictDialog` — see build-order item 4 below); and now automation execution itself (build-order item 5 below has the exact firing rules — which move's interactions fire at each trigger, who counts as "self" vs. "opponent," and the double-fire guard). Per this repo's `CLAUDE.md` ("the combat-timing math... is flagged as the high-risk piece: build it isolated and unit-tested before wiring it into UI"), this was built as an even higher-risk extension of that exact system — the recommended build order (pure functions → unit tests → schema → socket events → client UI → wire the automations) is laid out at the end of this section, mirroring how Combat Timing itself was built, and is now fully checked off. The one genuinely ambiguous point left in the original request — 4.4's Interruption comparison — is now **settled** (a contest of two attack rolls; see 4.4 below and the Interrupter / Hard to Interrupt Tags under Tags & automation), after being implemented one way, played, and corrected. Every other ambiguity encountered during implementation (sub-phases 3-5) was resolved and documented at the relevant socket event below instead.

**Two real bugs surfaced and fixed during this feature's mandated manual QA passes, both unrelated to Combat Automation's own math:**
- **Sub-phase 4:** `CombatHeaderBar.jsx`'s auto-roll-queue effect (built back in the "Fix GM missing roll-request prompts" batch, well before this feature) read `combat.characters[dm.characterId]` on every `combat:updated` broadcast, but that component's own `combat:updated` listener did `setCombat(c)` — a full replace, not a merge. `combat:updated` has always deliberately omitted `characters`/`counters` from its payload (see the `GET /api/combat` bullet under Real-time events below — this is intentional, so a minor combat action doesn't re-send every seated character's full sheet, portraits included, to every connected socket), so the very first live broadcast after the initial REST load silently wiped `combat.characters` to `undefined`, and the next newly-revealed move crashed the whole page (`Cannot read properties of undefined (reading '<characterId>')`) the instant the auto-roll effect ran. Fixed by merging instead of replacing (`setCombat((prev) => ({ ...prev, ...c }))`), which keeps `characters`/`counters` from the initial load intact — no server-side change, since `combat:updated`'s narrower payload was correct as-is. This had been dormant since that batch; sub-phase 4 is what finally exercised the "watch a move reveal live in a real browser tab" path directly, which is when it surfaced.
- **Sub-phase 5:** `ChatPanel.jsx`'s `<DamageApplicationDialog>` render call never actually passed `attackerDeclaredMoveId={entry.declaredMoveId}` — the dialog's own `apply()` was correctly wired to forward the prop through to `combat:apply_damage`, but the prop itself was simply never supplied at the one call site, so it silently arrived as `undefined` every time (and `undefined`-valued keys never survive Socket.IO's JSON serialization, so the server never even saw the field at all — no error either side, just no 'hit' trigger ever firing). Caught during the live-browser click-through of this exact flow, by watching the actual WebSocket frame `combat:apply_damage` sent and noticing the field was missing; fixed with the one missing prop.

**4.1 — Hit damage (the default case: no Defense Frame in play).** When a move's Roll is rolled and that move's **Active** frames (excluding any Active square that's *also* Defense-tagged) are landing on an opponent with no covering Defense Frame active at that Tic (see 4.3 for what "covering" means), it's a plain Hit and damage is computed automatically from the roll's own result:
- **Damage formula (decided):** `halfDamageSteps = floor(result / 5)`, `damage = halfDamageSteps × 0.5`. A result of 5-9 is 0.5 damage (1 Half-Damage); 25-29 is 2.5 damage (5 Half-Damage) — matching the user's own examples exactly. Reuses the **Half-Damage** mechanic already built (see Stamina & Stat Lock's Injuries-adjacent bullet, or rather — see the dedicated Half-Damage bullet under Stamina & Stat Lock above): applying 1 Half-Damage to a Stat that already has it clears the flag and steps the die down one full rank instead (`applyHalfDamage` in `server/gameLogic.js`); applying it to a Stat without the flag just sets it. `damage` half-damage steps against one Stat = calling `applyHalfDamage` that many times in sequence against that Stat's current `{size, bonus, status, half_damage}`.
- **The chat roll card shows the damage line + an Apply button (decided, new):** whenever a roll is for a declared move (not a bare Dice Tray roll or a manual Stat roll — see the schema note below on how a roll knows which move/attacker/targets it belongs to), the card gets a line like `Damage: 2.5` under the existing dice breakdown, plus a small **Apply** button. **The card remembers who attacked whom:** trivial for a 1-on-1 pair (the target is just "whoever's on the other side of this pair"); for Uneven Combat, the roll card carries every character on the opposing side as target *candidates*, and clicking Apply is what actually asks which one(s).
- **The Damage Application dialog (decided, new):** clicking Apply opens a modal — **damage calculation on the left** (the computed half-damage-step count, adjustable with up/down arrows that add/remove one Half-Damage step at a time; this counter is also the hook a future Perk can pre-seed programmatically, e.g. "+1 Half-Damage on a Crit"), **the target's Vitruvian Man on the right** (the same anatomy layout `CoreStatsTab.jsx` already renders, reused read-mostly here). Clicking a Stat applies the dialog's *current* half-damage-step count to that Stat via `applyHalfDamage`, called that many times in sequence. The dialog **stays open after applying** — the Apply button on the *chat card* also stays clickable indefinitely — so a GM can correct a misclick or apply the same or a freshly-adjusted amount to a different Stat (splitting damage across multiple Stats across several clicks within one dialog session is supported this way). **Undo** reverts the single most recent change made inside this dialog (one level, not a full history — matches "reverts the last change," singular). Clicking anywhere outside the dialog closes it immediately, no confirmation needed (there's nothing destructive about closing it — every change it made already landed for real via the same `die:toggle_half_damage`-adjacent programmatic path, nothing is "pending" that a close would discard). For Uneven Combat, the dialog is opened once per selected target (or the target picker described above is folded into this same dialog, GM's call — an implementation detail, not a design one — see the sub-phase list at the end for exactly where this needs to be pinned down).

**4.2 — Defense resolution (a hit lands in a Defense Frame).** When the attack's Active frames overlap a defending character's Defense-tagged frame instead (see 4.3), the GM is prompted instead of damage auto-resolving:
- **The GM's prompt (decided, new): a 2×2 grid of 4 big tiles — top row Block / Dodge, bottom row Successful / Failed.** The GM makes **two picks, one per row** (defense type, then outcome) — "select multiple choice from 4 tiles" in the original request means exactly this: two independent choices sharing one 2×2 layout, not one choice among four combined outcomes. This reading is supported by the Failed branch behaving identically regardless of which defense type was picked (see below) — if Failed were its own combined tile, it wouldn't need a defense-type pick at all.
- **Failed (Block-Failed or Dodge-Failed, decided):** the defense does nothing; a chat message notes "Block/Dodge has failed"; resolution falls through to the plain 4.1 Hit flow (roll-based damage + Apply button) exactly as if there'd been no Defense Frame at all.
- **Successful Block (decided):** roll the *defending* move's own Roll (its `roll_type`/`roll_slots` or `custom_roll_size`, same as any other Roll on this move) — **plus, if the move is `is_defensive`, an optional additional pool of Stats rolled only for this defensive scenario.** This needs a new field, not yet in the schema: `move_defensive_roll_slots` (mirrors `move_roll_slots` exactly — same 6-slot vocabulary, same ambiguous-Hand/Leg handling — but only ever populated when `is_defensive = 1`, gated in the Move Creator the same way the two extra interaction categories already are). Sum the defensive move's Roll (base + defensive pool) into `blockResult`; `netResult = attackerResult - blockResult`, floored at 0 (never negative).
  - `netResult >= 5`: **Partial Block** (chat-noted) — the reduced damage (`floor(netResult / 5) × 0.5`, same formula as 4.1) can still be applied to any Stat via the same Apply/Damage-Application-dialog flow **and** the move's `block`-trigger interaction (its On-Block text/automations) still fires.
  - `netResult <= 0`: **Full Block** — only the `block`-trigger interaction fires; no damage at all.
- **Successful Dodge — BINARY (decided, revised; supersedes the rule below).** A Dodge has exactly two outcomes, and the GM's answer *is* the resolution: **Successful** means the attack does not land — no damage at all, and the attacker fires **On Miss** — while **Failed** means the dodge does nothing whatsoever. There is no third outcome, and a dodge that only partly covers an attack is a *failed* dodge, not a partial one (`classifyDefenseCoverage` already routes 'too-short' straight to Failed for Dodge, with no prompt).
  - **The dodger does not roll.** With no partial case the roll cannot change anything, and leaving it in showed a contest in the log that decided nothing.
  - **Why Block keeps its opposed math and Dodge doesn't.** A guard is a surface: it absorbs part of a blow and a big enough attack overwhelms it, which is exactly what Partial models. Empty air cannot be half-occupied. This is the second place Block and Dodge genuinely diverge, alongside the frame-overlap handling in 4.3.
  - **Found in play (bug, fixed).** The original rule below was implemented literally — `applySuccessfulDodge` ran `resolveDefenseRoll` — so a Dodge the GM had just called Successful could come out "Partial", put damage through **to the dodger's own Stat**, and fire the attacker's **On Block** trigger. Both halves were reported from a real playtest: On Block firing on a successful Dodge, and a "Partial Dodge" nobody had asked for. `scripts/playtest-dodge.mjs` drives the real `combat:resolve_dodge` socket and asserts no damage, no die change, `miss` fired, and `block` **not** fired; the two unit tests that had encoded the old behaviour were inverted into regression guards for the same fixture.
  - The **On Successful Defense** / **On Failed Defense** rows are unchanged and still don't distinguish Block from Dodge — whichever defence type the GM picked, the same `defense_success`/`defense_failure` rows fire.
- **~~Successful Dodge (superseded — see above)~~:** identical math and identical interaction-firing rules to Block above
- **Full coverage** (every Tic of the attack's Active window has a matching Defense-tagged Tic for the defender): proceed with the 4.2 GM prompt as described.
- **Attack frames occur before the Defense Frame starts:** the defense is automatically non-effective — treated exactly like GM-picked Failed, no prompt needed.
- **Attack frames extend past where the Defense Frame ends — Block only (decided):** the blocking character's Recovery window is extended to cover through the end of the attacker's Active frames (i.e. they're "still recovering from the block" for exactly as many extra Tics as needed). The extension is **announced in chat and drawn on the timeline** (see the Combat Automation section's own bullet on it) — it changes how long the blocker is committed for, so it is never silent, but it is also never a prompt. Any of those newly-occupied Tics that were previously undeclared for the blocker are simply consumed (no bonus, no penalty — they just stop being free). Any that **already had a move declared into them** trigger a dialog to whoever's defending: **Forfeit** (cancel that declared move outright, refund its full Stamina Cost — mirrors `move:undeclare`'s existing cancel-before-commit behavior, not a new Stamina rule) or **Postpone** (shift that move later along the Tic Counter by just enough Tics that its new footprint starts after the extended Recovery ends). **Postponing cascades recursively:** if the postponed move's new position now collides with yet *another* already-declared move further down the timeline, the same Forfeit/Postpone dialog fires again for that move, and so on, until nothing overlaps.
- **Attack frames extend past where the Defense Frame ends — Dodge (decided, simpler than Block):** no partial-coverage handling at all — incomplete coverage in *either* direction (too early or too late) is simply a failed Dodge, same as the "attack frames occur before" case above.

**4.4 — Interruption (decided, new).** Taking a Hit (the 4.1 path — not a Block/Dodge outcome) while still in your own move's **Startup** frames can Disrupt that move.
- **The comparison (settled — this bullet's long-standing "needs confirmation" note is retired).** There is no threshold; there are **two attack rolls**. The attack brings its own roll `+ Interrupter (x)`; the caught move brings its own roll — thrown on that move's Roll, or Body if it has none (decision #8) — `+ Hard to Interrupt (x) + 1 per elapsed Active frame`. The attack must genuinely **beat** that total; the caught fighter wins ties, because "failing means the move is cancelled" and a draw is not a failure. **The damage just taken is not part of it** — it is what triggers the check, not what decides it, and it lands either way. The earlier working assumption recorded here (`roll >= damage taken`) was implemented and then corrected; see the Interrupter / Hard to Interrupt Tags under Tags & automation above for the full record of how it was got wrong.
- **Bonus (decided; side clarified by the correction above):** `+N` where `N` = however many of the attacker's own move's Active frames have already concluded *including the current one* — so always at least +1, since the hit landing at all means at least 1 Active frame is resolving right now. A pure function reading straight off `computeMoveFootprint`'s `revealTic`/`activeEndTic` against the current Tic. It belongs to the **caught fighter's** side of the contest: the longer the attack has been out, the more of it they have had to read. It is applied at the contest rather than folded into the roll's own `modifier`, so the roll that goes over `logRoll` stays an honest roll of that move.
- **On success:** the hit's damage applies exactly as it would anyway (4.1's flow is unaffected/still runs) — **plus** the Startup-character's move is Interrupted: every remaining frame of it reverts to Undeclared (the `declared_moves` row is deleted or marked resolved-void, same end state either way — an implementation choice, not a design one), and **half** its Stamina Cost is refunded (contrast with 4.3's Forfeit, which is a *full* refund — Interruption is involuntary and mid-commitment, Forfeit is a voluntary trade-off, hence the different fraction).

**Suggested additional automation points (not in the original 4 items, offered per the request to "make the vtt as good as possible" — kept deliberately modest, not new mechanics):**
- **Actually executing the existing On Hit / On Block / On Miss / On Successful Defense / On Failed Defense automations** (`self_recovery`, `opponent_recovery`, `self_stamina`, `opponent_stamina` — already fully modeled in `move_interactions`, stored and displayed today, but explicitly flagged in this plan's own Open Items as never actually firing) is not really optional here — 4.2 already requires "the On-Block effect of the move" to activate on a Full/Partial Block, so building this plan means finally closing that long-standing open item as a side effect, for every trigger, not just `block`.
- **A Miss trigger needs a definition to have anything to fire on:** the Move structure has an On Miss category today with no described condition. Suggested (matches the damage formula's own natural floor): a roll landing 0 Half-Damage steps (result < 5) counts as a Miss and fires the `miss` interaction row instead of a 0-damage "hit."
- **A small chat audit line whenever damage is actually applied** (e.g. "Rook applied 1.5 damage to Vex's Right Hand"), posted automatically the moment a Stat is clicked in the Damage Application dialog — mirrors the lane-snapshot cards' own "permanent visible history of what happened" philosophy (see Chat Log below) rather than leaving the only record of a fight's actual damage sitting silently in each character's die states.
- **Stamina refunds from Forfeit (4.3) and Interruption (4.4) should post through the same existing `stamina:regen`-style chat entry + `PopNumber` flash** already built for every other Stamina change, rather than a bespoke display — one fewer new UI pattern to build and test.

**Recommended build order (pure functions first, per `CLAUDE.md`'s explicit guidance for this system):**
1. **Pure, unit-tested math — done.** `server/combatDamage.js` (a sibling module to `combatTiming.js`, kept just as free of I/O), unit-tested in `server/test/combatDamage.test.js` (18 tests): `computeHitDamage(result)` (4.1's formula); `resolveDefenseRoll({attackerResult, defenderResult})` (4.2's Partial/Full math — a net result under 5 is Full regardless of exactly how far under, since `computeHitDamage` itself already yields 0 steps there, so the two functions share one threshold instead of each hard-coding it separately); `phaseAtTic` (Startup/Active/Recovery/Defense classification for one absolute Tic — extracted from the same logic `ChatPanel.jsx`'s `snapshotPhaseColorAt` already computes client-side for lane snapshots, now with one shared server-side source of truth); `classifyDefenseCoverage` for 4.3 (`'full'` / `'too-early'` / `'too-late'` + exactly how many Active Tics are uncovered, which is what Block's Recovery-extension length turns out to be); and `computeInterruptBonus` for 4.4. None of these are wired into any socket handler yet — sub-phases 2-5 below are still fully open.
2. **Schema — done.** `move_defensive_roll_slots` (mirrors `move_roll_slots`, only ever populated when `is_defensive = 1`); `chat_log.payload`'s existing JSON column now documents (see the Data model below) its extended use for `kind='roll'` rows tied to a declared move's reveal — `{ declaredMoveId, moveId, pairIndex, side, targetCandidateIds }` — reusing the same column `lane_snapshot` rows already use rather than a whole new table. Neither is read from or written to by any handler yet — that's sub-phase 3.
3. **Socket events — done.** Roll context (`buildRollContext` in `server/index.js`) is attached via a new optional `declaredMoveId` on `pool:roll`/`dice:roll_custom`, wired from the reveal-time auto-Roll flow (`CombatHeaderBar.jsx`'s two `onRoll` calls now pass `declaredMoveId: dm.id`) — not a new roll path, exactly as planned. `combat:apply_damage`/`combat:undo_damage` for the Apply dialog's Stat clicks + single-level Undo (`applyHalfDamage`, called `halfDamageSteps` times in sequence). `combat:resolve_defense` for the GM's 2×2 pick — classifies frame overlap via `classifyDefenseCoverage` first (a `too-early` pick is force-corrected to Failed server-side regardless of what was actually picked); Failed posts a chat notice and falls through to the existing roll card's Apply button; Successful rolls the defending move's own Roll + defensive pool server-side (no dialog — reads the declared move's own stored `appendage_choice`) and resolves via `resolveDefenseRoll`. `combat:resolve_move_conflict` for Forfeit (full refund, mirrors `move:undeclare` but explicit since Tic Countdown is past `move:undeclare`'s cancel-before-commit window) / Postpone (recomputes the new placement fresh against whichever specific move is blocking, floored via `computeMoveFootprint`, then recurses into `combat:move_conflict` again if the new footprint collides with yet another of the same character's declared moves). `combat:check_interrupt` for 4.4, as its own event (not folded into the Hit path, since nothing else in this sub-phase depends on that choice either way). One schema addition discovered while implementing this sub-phase: `declared_moves.recovery_extension_tics` (see the Data model below) — 4.3's Block Recovery-extension needs somewhere to persist the extra Tics, which the sub-phase-2 schema pass hadn't anticipated; every place a declared move's Recovery end is computed now adds it in (a no-op `+0` for every move Combat Automation never touches). See Real-time events below for every new event's exact payload/broadcast contract.
4. **Client UI — done.** `client/src/lib/anatomy.js` (new) pulls the `ANATOMY` die-slot position map out of `CoreStatsTab.jsx` into a shared module so 4.1's dialog can reuse the exact Vitruvian layout without a second copy of pixel positions. `ChatPanel.jsx`'s `Entry` renders a client-side `computeHitDamage(entry.total)` duplicate (same precedent as `snapshotPhaseColorAt` duplicating `phaseAtTic` client-side) whenever a roll card carries `declaredMoveId`, plus a `Damage: X` line and an **Apply** button (disabled once damage is 0) that opens `DamageApplicationDialog.jsx` (new) — target picker only shown when `targetCandidateIds.length > 1` (Uneven Combat), otherwise straight to the Vitruvian layout; a `defenseResolutions` Map (keyed by `attackerDeclaredMoveId`, populated from `combat:defense_resolved` broadcasts) overrides the displayed/applicable damage once a defense has resolved (0 on Full, the reduced amount on Partial) instead of the raw roll. A GM-only **Resolve Defense** button (gated on `useRole()`, hidden once already resolved) opens `ResolveDefenseDialog.jsx` (new) — the GM manually judges when a Defense Frame actually applies rather than the client duplicating `classifyDefenseCoverage`'s frame-overlap math just to decide whether to *show* the button; the server is sole authority either way (see `combat:resolve_defense` below, which force-corrects an invalid too-early pick). Its defender-move `<select>` is filtered from `combat.declaredMoves` to `characterId === targetId && moveId != null` — already tailored server-side to what this GM is entitled to see, no extra visibility logic needed. **Tailwind gotcha hit and fixed:** the 2×2 tile's active-state classes were originally interpolated (`` `border-${color}-500` `` etc.) — Tailwind's production build only detects literal class strings in source, so this would have silently shipped unstyled tiles; fixed with a static `ACTIVE_TILE_CLASS` lookup object (`sky`/`emerald`/`red`) instead. `MoveConflictDialog.jsx` (new, Forfeit/Postpone) is queued in `CombatHeaderBar.jsx` via a `conflictQueue` state array fed by a `combat:move_conflict` listener, filtered by the exact same ownership rule (`isMine`: own PC for a Player, own NPCs for the GM) the pre-existing `autoRollQueue` already used for the reveal-time Roll prompt — `combat:resolve_move_conflict`'s own recursive re-emit (see below) just appends another entry to the same queue, no special recursion handling needed client-side. Manually QA'd live in a browser (Playwright-driven): auto-roll dialog on a live reveal, the chat card's Damage/Apply line, `DamageApplicationDialog`'s Stat-click Apply + Undo (with its own chat audit line), and `ResolveDefenseDialog`'s 2×2 tile styling and defender-move gating (correctly disabled with no valid declared defensive move) all confirmed working end-to-end — see the bugfix note above for the one real issue that QA pass turned up.
5. **Wire the automations — done.** `applyMoveInteractions({ moveId, trigger, selfCharacterId, selfDeclaredMoveId, opponentCharacterId?, opponentDeclaredMoveId? })` (`server/index.js`) reads the single `move_interactions` row for `(moveId, trigger)` (`normalizeInteractions` guarantees at most one per trigger), executes each `{type, amount}` automation, and posts one consolidated chat notice (the row's own `text` plus a plain-language line per automation, e.g. `QA Punch — On Hit: −2 Stamina → QA Defender`) if anything fired. **Which move's interactions fire, and who's "self" vs. "opponent," per trigger (decided during implementation):**
   - **`hit`** fires on the **attacker's own move**, from `combat:apply_damage` — `DamageApplicationDialog` now passes the roll's own `attackerDeclaredMoveId` through (threaded from `ChatPanel.jsx`'s `entry.declaredMoveId`); self = the attacker, opponent = whichever character owns the die actually being damaged (known directly from the Apply click). Guarded by the new `declared_moves.interactions_resolved` flag (see the Data model above) so a Partial Block's own reduced damage — still applied through this same event, per 4.2 — doesn't also fire `hit` on top of the `block` trigger `combat:resolve_defense` already fired for that declared move; set the moment `hit` (or `block`, below) fires, checked before either can fire.
   - **`miss`** fires on the **attacker's own move**, automatically, the instant its reveal-time roll comes back at 0 Half-Damage steps (`fireMissIfNoDamage`, called from `pool:roll`/`dice:roll_custom` right after `logRoll`) — a Miss has no GM action to hang off, since the chat card's Apply button is disabled at 0 damage, so nothing would ever call `combat:apply_damage` for one. Self = the attacker; opponent-directed automations only fire when the roll's own `targetCandidateIds` has exactly one entry (a genuine Uneven-Combat ambiguity — which of several possible targets a miss "affects" — isn't worth guessing at, so those are silently skipped there; self-only automations still fire regardless).
   - **`block`** fires on the **attacker's own move**, from `combat:resolve_defense`'s Successful branch (Full or Partial, Block or Dodge alike — matches 4.2's own "identical interaction-firing rules" between Block and Dodge) — self = attacker, opponent = defender. Same `interactions_resolved` guard as `hit` above (and sets it).
   - **`defense_success`** / **`defense_failure`** fire on the **defender's own move** (the two triggers `is_defensive` gates in the Move Creator), from `combat:resolve_defense`'s Successful/Failed branches respectively — self = defender, opponent = attacker. Deliberately **unguarded** (no `interactions_resolved` check): a defensive move can legitimately defend more than once, so `combat:resolve_defense` firing again for the same defending move fires its defense trigger again too, same as the roll/chat notice it already produces each time.
   - **`self_recovery`/`opponent_recovery` are applied to the CLOCK, not to a row (decided, revised — see "Recovery lands on the timeline" below).** They originally bumped one declared move's `recovery_extension_tics` via `clampRecoveryExtension` and nothing on the board moved; `opponent_recovery` even had a "whichever of their declared moves ends latest" fallback for `miss`, which has no specific opponent move tied to the exchange. Both are gone. The effect now asks what that character is doing at the Tic it fires on and puts the frames there, sliding everything they had declared after it. `clampRecoveryExtension` survives for exactly one case: a **negative** `self_recovery`, which shortens a window rather than displacing anything. **`self_stamina`/`opponent_stamina`** both reuse the existing `adjustStamina` helper (sub-phase 3's Forfeit/Interrupt refund plumbing).

**Carried-over frames are lanes now, not an edge stripe (decided, revised; implemented).** The Tic
Counter used to signal a move carrying over from last round as a 1.5px strip across the top of a Tic
square, split between up to three characters, with the identity available only on hover. It said
"somebody is still busy here" and almost nothing else — not who, not how many, and a Trip Recovery
frame was indistinguishable from an ordinary one.

- **One lane per character**, portrait and name plus a **full-size square per Tic** in the round's own
  colours, arrows and all. Filled, not edged: the whole complaint about the stripe was that it read as
  decoration on somebody else's square rather than as a thing occupying a Tic.
- **Players above the strip, NPCs below** — the cutscene's own convention, reused rather than
  reinvented, because the Arena and the cutscene are the same board.
- **One scroll container holds every row**, which is what keeps a lane's square aligned with the Tic
  above it however far the strip is scrolled. Identity sits on its own line rather than beside the
  row for the same reason: a left-hand label would either scroll out of view or push every square out
  of alignment, and alignment is the entire point. Above the row for a lane above the counter, below
  it for one below, so the name always reads away from the strip.
- **The compact header-bar counter keeps the old stripe** — it is an always-visible strip with no room
  for four extra rows. Only the Arena's own counter takes lanes, and the two signals are never drawn
  at once.

**Two bugs found by looking at it, both of which had shipped.** `phaseAt` was being called for the
carried-over frames **without `tripRecoveryTics`**, so every carried trip frame classified as ordinary
Recovery. And worse: **the cutscene never received the data at all.** `moves_displaced` carried no
`trip` flag and `reveal`/`carryover` carried no `tripRecoveryTics`, because two payload edits were
silently lost when an earlier scripted edit aborted on a failed assertion — so the replay drew every
trip frame as ordinary Recovery and the arrow never appeared anywhere. The trip playtest passed
throughout, because it asserted the DB column and the REST payload and never the round events.
**Two channels carry this fact and testing one of them is testing half the feature**; the playtest now
asserts both. The arrow itself was also 9px of `blue-200/90` on a `blue-800` cell — present, and
invisible at any normal viewing distance, which is the same as absent.

**Move filters on the declare picker (decided, new; implemented).** The Arena's Declaration screen now
carries the same Tell/Tag filters the character sheet has, on their own row under the default/unique
tabs. Mid-round is exactly when "which of these opens with the shoulder drop" is worth answering
fastest, and the Default tab is every default move in the world. (Tag sat left of the panel and Tell
right until Attack Target and Attack Roll joined them — see the four-filter split below, which moved
both to the right.)

- **Extracted rather than copied a third time** (`client/src/lib/moveFilters.jsx`: `useMoveFilters` +
  `MoveFilterChips`). The control already existed twice — the Compendium's Style+Tag row and the
  sheet's Tell+Tag row — and three implementations of "OR'd within, AND'd between" is how two of them
  quietly stop agreeing. Same call the frame palette got. `MovesTab` was switched over to it in the
  same change, so there is one implementation, not two plus a new one.
- **Chips are built from the current tab, not the whole list.** Switching tabs re-derives them, so the
  picker never offers a Tell that returns nothing on the tab you are looking at — the sheet's own
  reasoning ("a filter that can only ever return nothing is a worse answer than not offering it")
  applied one level down. The *picks* survive the switch, which is the useful half: narrowing to a Tag
  and then checking both tabs for it is a real thing to want.
- **On a desktop they flank the panel, outside its border (revised).** The picker is a narrow centred
  column with a great deal of empty screen either side of it, and chips squeezed inside it were both
  cramped and too small to read at a glance — which is the one thing a filter has to be mid-round.
  A full-size stacked column either side at a readable font, in space that was carrying nothing —
  **Attack Target and Attack Roll to the left, Tell and Tag to the right** since the four-filter
  split below (it was Tag left, Tell right when there were only two). Two earlier attempts kept them inside the panel
  (first sharing the tab row, then on a row of their own beneath it); both were legible only in the
  sense that the pixels were present.
- **The phone keeps the compact in-panel row exactly as it was** (`md:hidden` on the row,
  `hidden md:flex` on the columns). A phone has no side space to give, and reflowing a column into a
  390px screen would be worse than what is already there.
- **The filter state is owned by `ActiveDeclarePanel`, not the picker** (`useDeclareMoveList`), which
  is what makes rendering the columns outside the panel's border possible at all. The tab belongs
  there for the same reason: the chips derive from the current tab, so whoever owns the chips owns
  the tab.

**Filter by Attack Target and Attack Roll, everywhere moves are browsed (decided, new; implemented).**
Two more filters beside the Tell/Tag pair, on all three surfaces — the Compendium's Move browser, the
character sheet's Moves tab, and the Arena's declare picker. "Which of these goes for the head" and
"which of these rolls a Hand" are what you ask of a long list mid-round, and neither was askable
anywhere before.

- **The layout is a left/right split by the question each filter asks.** Left: what a move *does* —
  its **Attack Target** and its **Attack Roll**. Right: what a move *is* — its **Tell** and its
  **Tags** (the Compendium's right column is **Style** and Tag, since that page filters by Style
  rather than Tell).
- **One column per filter — four columns, two a side (revised).** The first cut stacked two filters
  in each of two columns, and it read as two controls rather than four: Attack Roll sat below a
  seven-chip Attack Target, starting halfway down the screen and looking like a continuation of the
  filter above it. Each now gets its own column, side by side. In the Arena that is four
  `MoveFilterColumn`s flanking the panel (narrowed to `w-32 lg:w-40` from `w-44 lg:w-52` to make
  room — the labels they carry are short); on the sheet and in the Compendium it is a
  `sm:grid-cols-2 lg:grid-cols-4` grid, stacking to one column on a phone in the same order. The
  Arena's phone layout keeps its two compact rows a side inside the panel, which has no side space
  to give either way.
- **Both read the same seven-name vocabulary** (`ROLL_SLOT_NAMES`): Left/Right Hand collapse into one
  ambiguous `Hand`, Left/Right Leg into `Leg`, `Weapon` is the seventh. A move that rolls `Hand`
  twice is still one `Hand` to a filter — these are membership tests, not counts.
- **`effective_attack_targets` / `effective_roll_slots` first**, for the same reason the Tag filter
  reads `effective_tag_ids`: a Perk can change what a move does for one character, and a filter has
  to agree with the card in front of that fighter rather than the library row behind it. Neither is
  on the sheet payload today; reading for it costs nothing and means the filter does not quietly go
  stale the day a seam starts writing one.
- **Chips are built from the pile being filtered**, as the Tell/Tag rows already were — the sheet's
  own hand, the picker's current tab, the Compendium's current discipline. The Style and Tag rows
  deliberately still show the GM's whole authored vocabulary: those are the world's lists, and a
  Tag's absence from a folder is itself worth seeing.
- **A move with no Attack Target is excluded by that filter rather than exempt from it.** A pure
  defence names nothing; asking "which of these goes for the head" should not hand back everything
  that goes for nothing at all.
- **The rules moved to `client/src/lib/moveFilterRules.js`**, a plain `.js` beside the `.jsx`, because
  `node --test` cannot load JSX and the half worth pinning is what counts as a match. `moveFilters.jsx`
  imports and re-exports it, so no call site changed. `server/test/moveFilters.test.js` covers the
  AND/OR shape, the `effective_*` preference, the canonical chip order, and that the client's slot
  vocabulary still equals the server's — two lists that drift give a filter that silently matches
  nothing. The Compendium's hand-rolled Tag row became the shared `MoveFilterChips` in the same
  change; its Style row stays bespoke, being icons rather than words.

**The Compendium's side rails follow the scroll (decided, new; implemented).** Both columns — the
discipline tree on the left, the drag-a-move-here character rail on the right, and the Perks tab's
own rail — are `sticky top-0` against `<main>`'s scrollport. The page is one very long grid with a
column either side of it, and both columns used to sit at the top of it: scrolling to the move you
wanted scrolled the discipline you wanted to file it in, and the character you wanted to drop it on,
off the screen entirely. The rail is a *drop target*, so a drag that had to be held while the page
scrolled under it was the worst version of that interaction and the only one available.
`self-start` is load-bearing — a stretched flex item is already as tall as its row and has nowhere
left to stick to — and the height cap plus inner scroll covers a long roster: the box may still run
past the fold, but its own scrollbar brings the bottom of the list into the visible part, which the
unstuck version could not do at all.

**A `useMemo is not defined` shipped past the build and the linter, and closed a gap (bugfix).** The
new picker used `useMemo`, `CombatArena.jsx` did not import it, and `npm run build` was perfectly
happy: Vite parses the file fine and an undefined identifier is a runtime error, not a syntax one. It
crashed the whole declare panel and was caught only because a browser pass happened to open it —
**the same class of bug as `attributes is not defined`, three days later.** `client/src` had been left
out of the linter as "worth doing, not worth bundling into a hotfix"; it is in now, with
`eslint-plugin-react-hooks` loaded purely so the existing `exhaustive-deps` disable directives
resolve (the rules themselves stay off — this is a correctness gate, and that sweep is separate work).
Verified the way a check has to be: by deleting the import again and watching `no-undef` name it.

**Three new Perks (decided, new; implemented).**

- **Osu!** — two seams, one clause. "+1 Recovery to every Attack, +2 to all Attack Rolls": the Recovery is the
  *cost* of the accuracy. Both halves read `isAttackingMove`, deliberately the same shared reading, because a
  Perk whose two clauses disagreed about what an Attack is would have you paying for moves that never got the
  bonus. The frame rides the new `moveFrameDelta` seam and is therefore a real frame — visible in the declare
  picker before the move is placed, and flooring the next declaration.
- **Never Empty-Handed** — the first **player-activated** Perk. The offer appears on the character's own empty
  Weapon slot, which is both where you would look for a weapon and the one place in the app that already means
  "you are carrying nothing". Once per Fight, through the fight-scoped state store Second Wind already uses.
  Everything is re-derived server-side from the granted Perks — the client sends a Perk name and nothing else —
  so a hand-sent event cannot conjure a weapon, spend a charge twice or invent a die size.
- **Non-Committed** — the only Perk that stops the round. A **fifth pause** (`paused_noncommit`) on the pair's
  own resolution row, raised at the head of the round: after everyone has declared, before anything reveals.
  Reusing that architecture rather than inventing a parallel one is what gives it crash-recovery and reconnect
  behaviour for free. Gated on `isNewResolution`, so it asks once per round rather than every time the engine
  resumes — answering it must not raise it again.
  - **The payload is filtered per viewer** (`nonCommitForViewer`). It names move names for every holder in the
    pair, and a pair can have a holder on each side; handing the whole thing across would disclose an
    opponent's undeclared board, which is the one thing Declaration exists to keep.
  - **Cancelling refunds in full and frees the Tics, but nothing slides earlier** (decided). That is the
    engine's standing rule — nothing arrives earlier than it was thrown — and this is the same rule, not an
    exception to it. The freed Tics still matter: they no longer floor next round's placement.
  - **Keeping everything is a real answer**, and it is the primary button. The Perk is an option, not an
    obligation.

**Verified live**, since none of the three is reachable from the unit suite end to end: `playtest-never-empty-handed.mjs`
(13 probes — the offer only when granted and only on an empty slot, the charge spent exactly once, a second press
refused, a hand-sent event naming an unheld Perk arming nobody, the charge returning when the Fight does) and
`playtest-non-committed.mjs` (18 probes). The two most valuable probes in the latter are the ones about **everybody
else**: a pair with no holder must never pause — getting that wrong would stall every fight in the game behind a
prompt nobody can answer, a far worse failure than the Perk not working — and the window must not re-open on a round
it has already been answered on.

**One measurement lesson, again.** The refund probe first asserted a before/after Stamina total and failed against a
perfectly correct refund: answering the window *releases the round*, and a round pays Stamina regen, so the
comparison was measuring the refund plus whatever the round did. It asserts the `noncommit` event's own figure now.

**Four more Perks (decided, new; implemented).** Three of them cost one file and one registry line each —
which is what the seam register is for — and one needed a genuinely new question asked of the payload.

- **Path To Mastery: Speed** — "all your moves gain -1 to Startup", on the existing `moveFrameDelta` seam.
  **All** moves, not all attacks: a guard that comes up a Tic sooner is the same mastery as a punch that
  lands a Tic sooner, and the Perk does not qualify itself. `effectiveFrames` already clamps each segment
  to `0..FRAME_MAX`, so a 1-Startup move goes to 0 and no further — it comes out the instant it is placed,
  with no wind-up to read, which is a shape the engine already handles.
- **Path To Mastery: Strength** — "Blocks against you gain a -5 Penalty; your Damage Threshold is reduced
  by 1". The Threshold half is the existing `minDamageThresholdWhenAttacking` seam (Not Just a Scratch's,
  from the same side). The Block half needed a new one: **`blockPenaltyAgainstYou`**, and it is the first
  seam in the game asked of somebody *other than the roller*. Every roll seam so far answers about the
  fighter making the roll; this is a penalty on the **defender's** roll, conditioned on **who they are
  guarding against**. It is therefore asked of the attacker and folded into the defender's modifier inside
  `runBlockLine`, the only place that knows both halves of the exchange — it cannot live in
  `loadBlockGuard`, which is handed the defender and nothing about who is swinging. Blocks only, on
  purpose: a Dodge is getting out of the way and does not care how hard you hit, and never reaches that
  function.
- **Path To Mastery: Durability** — "the first 2 times in a Fight that a Stat would be Broken, keep it at
  1d4 instead". A **charge**, spent by the engine rather than by the Perk: the seam (`absorbsBreak`)
  answers *how many and over what window*, and `perkAbsorbBreak` spends one, because only the damage loop
  knows a break really happened. The question is asked **only where a break would actually occur** — the
  die was live coming in and is incapacitated going out — so a charge is never burned on a blow that was
  not going to break anything. The Stat still takes everything the hit was worth: it lands at a bare d4,
  no bonus, no pending half, exactly where the break would have left it, minus the going out. So this
  buys the two worst moments of a fight rather than two free hits — a d4 Stat is one more half-step from
  breaking anyway. Fight-scoped through the same store Second Wind and Never Empty-Handed use.
  **Announced, not silent**, on the Grounded precedent: a table watching a Stat get taken out is
  expecting it to go, and its refusal needs a reason on the record.
- **Eye Catcher** — "you know whether the attack against you is High (Skull, Brain), Mid (Body, Stamina,
  Hands) or Low (Legs), in addition to the Tell". The only one of the four that is not a number.

**Eye Catcher is a disclosure rule, and disclosure rules live in the viewer map.** The band itself is
pure and unit-tested (`attackHeights` in `moveLogic.js`); everything hard about it is *who may read it*.

- **Where it attaches.** `mapDeclaredMovesForViewer` — the same function that decides whether a viewer
  gets `moveName`, `staminaCost` or a Feint-masked row at all. Adding it anywhere else would have meant
  a second, weaker gate beside the one the game already trusts.
- **Protected by absence.** The key is simply not present on a row the viewer has not earned, exactly as
  `moveId`/`moveName` are `null` rather than blanked and a Feint-masked row is dropped rather than
  flagged. A `{ attackHeights: null, entitled: false }` shape would tell a devtools reader precisely
  where to look. The client therefore needs no check of its own: the key's presence *is* the entitlement.
- **Not gated on reveal.** Knowing it *before* the move shows itself is the Perk's entire content. Once
  a move reveals, its Attack Targets are public anyway and the band is merely redundant.
- **"Against you" is answered from the board, not from the payload.** A row qualifies when it is
  somebody else's move, in the viewer's own pair, and either aimed at them or aimed at nobody in
  particular — `target_character_id` is NULL in a 1v1 because there is only one person it could be for,
  so pair membership is what closes that case.
- **Resolved once per broadcast, not once per socket.** Which fighters read height is a property of the
  board rather than of the socket looking at it, so `buildCombatUpdate` resolves the whole seated set in
  **one** `Promise.all` and hands `combatUpdateFor` a Set. Wall time on a broadcast is depth × round
  trip, never count — the same rule the DB latency work established. `GET /api/combat` serves exactly
  one viewer, so it asks only about that viewer, and rides in a `Promise.all` already being made.
- **A defence-pure move reports no height**, because it carries no Attack Targets — the true answer
  rather than a withheld one — and **`Weapon` belongs to no band on purpose**: it names no die, it is a
  strike at what somebody is holding rather than at a height on their body, and calling it Mid because a
  hand holds the thing would be inventing an answer. A move aimed across two bands reports **both**;
  narrowing it to one would sell certainty the reader has not earned.
- **Shown as a badge under the greyed Tell** in the Arena's compact card, colour-coded High/Mid/Low. The
  `opacity-60 grayscale` moved off the card and onto the Tell itself: the greying says "you do not know
  what this move is", and the height is the one thing here you *do* know.

**Verified live** (`playtest-perks-batch5.mjs`, 30 probes) plus 8 new unit tests. The live script is
where Eye Catcher's entitlement had to be checked, because the only way to test one is to ask as
somebody who does not have it — a real socket identity against a real endpoint — and it is where
Durability had to be checked, because the charge is spent by the damage loop and only a real attack
landing real steps on a live Stat reaches the line that spends it. The Durability probe watches three
consecutive guaranteed breaks (+9 on a d4 is two Half-Damage steps every time, and a fresh d4 is two
steps from going out) and asserts the first two are absorbed and the **third is not** — a charge that
never ran out would pass a two-round test.

**A fixture lesson worth writing down.** Four probes in this batch's first run failed while the engine
was entirely correct: the fixtures rolled `'Right Hand'`, which is not a Roll slot — the slot is `'Hand'`,
and `sanitizeRollSlots` drops what it does not recognise. A move with no Roll never enters the damage
flow at all, so every one of those rounds revealed and completed having done nothing, and the probes
faithfully reported nothing. The diagnosis came from running the *known-good* `playtest-perks-batch4.mjs`
against the same server: it passed, which located the fault in the fixture rather than the branch in one
step instead of a reading of `resolveAttack`. Keep a known-good script around for exactly this.

**Trip Recovery Frames (decided, new; implemented).** A second kind of Recovery: identical for timing —
it ends a footprint, blocks the next move, displaces everything queued behind it — but the fighter is
on the **ground** for it, and two rules read that difference.

- **Stored as a count, not a range.** `declared_moves.trip_recovery_tics` says how many of the move's
  *trailing* Recovery Tics are trip frames. Trip frames are always the tail of a footprint, because
  they are imposed at the moment the trip lands and go on after whatever the fighter was already
  doing — exactly where `recovery_extension_tics` already puts imposed Recovery. So the window is
  derivable (`tripWindow` in `combatTiming.js`) and there is no second value that could drift out of
  agreement with the first.
- **Only the in-flight case produces them.** `planImposedRecovery` has three answers and only one
  creates Recovery frames: caught mid-move, the Tics go on the end, so with `trip` they go on as trip
  frames. Caught in Startup they extend the wind-up — those are Startup frames, not Recovery ones, so
  there is nothing to mark. Caught idle, nothing is drawn at all (a rule decided above). The Chat Log
  says "Trip Recovery" only where frames actually landed, rather than promising some that are not on
  the clock. **Note this makes the Startup case nearly unreachable for Movement Punisher anyway**,
  since an attack that deals damage during Startup Interrupts instead and deletes the move.
- **Movement Punisher now imposes them** (revised — it was ordinary Recovery). Still 3, still through
  the same `runAutomations` door, so the displacement, the round event and the cutscene beat are
  unchanged; what changed is what kind of frames they are.
- **Two new automation effects**, `self_trip_recovery` and `opponent_trip_recovery` — their
  `_recovery` siblings with one flag set, deliberately falling through into the same executor cases
  so nothing about them can drift. Separate types rather than a checkbox for the same reason
  `self_stat_increase` exists: a GM picking "Trip the opponent" off a list will find it. Unsigned —
  a negative trip has no coherent meaning, and `self_recovery` is still there for shortening a window.
- **The Off The Ground Tag** is the first Tag whose effect is at **declare** time rather than at
  resolution. A move carrying it may be placed so its Startup overlaps the declarer's own trip
  frames. Two caps, both in `placementFloorAfterTrip`: never further back than the trip window began
  (ordinary Recovery is untouchable, so the Tag does nothing at all to a fighter who was not tripped),
  and never more than the move's own Startup (its Active frames can never begin before the trip ends).
  The invariant behind both, and the one the tests pin: **the reveal Tic always lands at or after the
  old floor.**
- **The Grounding Tag writes them (decided, new; implemented).** Off The Ground *reads* trip frames;
  Grounding is the Tag that makes them, and the two are a deliberate pair — a move that grounds you is
  a real cost until you have something to throw off the floor. **Every Recovery frame of a Grounding
  move is a Trip Recovery frame.** The count never changes: a 3-Recovery move still has three frames,
  and what changed is what kind they are — exactly what Movement Punisher already does to somebody
  else, here done to yourself on purpose.
  - Written once at **declare** time onto `declared_moves.trip_recovery_tics`, from the same
    per-character resolved tag names every other Tag mechanic reads (a Perk may grant or strip it),
    and frozen there like every other declare-time snapshot — editing the template's Recovery
    afterwards must not reach into an attack already on the clock. It is the only thing that writes
    that column at declare; Movement Punisher adds to it mid-round, from the other side of the fight.
  - **Recovery added later is ordinary.** A Block that held too short extends the window
    (`recovery_extension_tics`), and `phaseAt` measures the trip window backwards from the Recovery
    end, so those extra frames land in *front* of the trip ones. That is the right way round: the
    extension is time spent still on your feet recovering from the guard, and the floor is where the
    move was always going to leave you.
  - No client change was needed — every render site already draws from `tripRecoveryTics`.

**Punisher — (Stat): a Tag parameterised by a STAT (decided, new; implemented).** A move built to
catch a specific *kind* of attack. `Punisher - Body` rolls **+2 while an opponent has a move on the
clock whose own Roll includes Body** — whatever else that move also rolls. The two Interruption Tags
put a number in their name; this puts a Stat there, for the same reason either does it: a Tag is a
world-level row the GM names, and "Punisher - Body" is already how a table would write it on a card.

- **The window is the opponent's WHOLE footprint — Startup, Active and Recovery.** That is wider than
  anything else in `combatBonuses.js` reads (`placement_tic`, not `reveal_tic`), and deliberately so:
  a move being wound up is exactly what a Punisher is built to catch. It is also the one claim a test
  can lose silently, so the engine test is pinned on a still-in-Startup opponent and was verified to
  go red when the window was narrowed back.
- **Five Stats, seeded**: Skull, Brain, Body, **Hand** (either side, or both) and **Leg** (either side,
  or both). Left/Right collapse into the limb — what is being punished is somebody throwing hands —
  and the ambiguous `Hand`/`Leg` the Roll vocabulary itself uses lands in the same place. **Stamina
  and Weapon are not on the list**, and a Punisher naming one of them (or a typo, or a bare
  `Punisher`) is dropped rather than half-matched. The five are seeded, unlike the numbered Tags,
  precisely because the parameter is a closed list: the whole vocabulary can be put in front of the
  GM, and "it does nothing at all" is a bad thing to discover by typing.
- **+2 once, however many of its Punishers matched.** The move is either punishing what they threw or
  it is not; the Interruption Tags stack only because their parameter *is* an amount. The matched
  Stat rides on the roll's breakdown as `Punisher: Body`, in the vocabulary's own order so a move
  catching two names the same one every time.
- **A move still hidden by a Feint is not punished**, and that is a rule rather than an oversight: the
  +2 lands as a named term on a roll the whole table sees, so paying it out of a concealed move would
  announce what that move rolls — the one fact the Feint exists to hide. It becomes punishable the
  instant it reveals, like everything else about it. Every opponent on the far side counts, not just
  a declared target: in an Uneven Combat there is more than one somebody to be fighting.
- **`moveTagNamesFor` moved from `roundResolution.js` to `combatBonuses.js`** to make this possible —
  the Tag is read at the shared roll-modifier funnel, and that module is imported *by*
  roundResolution, so asking the other way round would have been a cycle. Re-exported from its old
  home, since `server/index.js`'s `move:declare` has always imported it from there.

**Temporary Damage: a Tag whose damage wears off (decided, new; implemented).** A move carrying it
still deals its damage in full — **the Stat drops, and it can still be Destroyed** — but every
half-point is recorded against the Stat it landed on and given back at **0.5 per finished Round**,
one half-step at a time, until the debt is clear.

- **Its own table (`temporary_damage`), keyed `(character_id, slot_name)`.** Not a flag on the die:
  "how much of this Stat's damage was temporary" is a running total that outlives any one blow, and
  several such blows can land on the same Stat inside one Round. Accumulates on the pair, and the row
  is **deleted** when it reaches zero, so the table holds only outstanding debts and an empty table
  is the ordinary state of the world.
- **The rate is on the Stat, not on the blow.** 0.5 per Stat per finished Round, however many moves
  put damage there — which is what the rule says, and what makes a Stat hit twice take two Rounds to
  come back rather than one.
- **`healHalfDamage` in `gameLogic.js` is the exact inverse of `applyHalfDamage`**, and had to be
  written: `stepStat`'s upward branch is *not* an inverse (from a die with no pending half it climbs a
  whole rank and leaves the flag clear), so undoing with it would have handed back more than was
  taken. Swept in a test across every die size and both half states, and pinned on the case that
  matters most — **a Stat destroyed by temporary damage walks back out of `incapacitated`**, because
  the damage that destroyed it was never permanent.
- **Only what actually landed is owed back.** A blow held together by Path To Mastery: Durability took
  the Stat to a bare d4 rather than through it, and the debt is what the die is carrying, not what the
  attack was worth; damage that found an already-broken Stat never reaches the recorder at all. The
  splash from Piercing Headache is part of the same blow and wears off with it.
- **A Stat already back at or above its locked baseline clears its debt without moving.** Something
  else put it right in the meantime — a Recover Stat, the GM's own hand — and healing past where a
  fighter started is not what "it wears off" means.
- **Run as the Round closes, per pair**, right after `round_complete` and before the next declaration
  opens: "per finished Round" is a fact about the Round that just ended, and a fight that stops there
  should still have given the half-step back. Per pair because each pair runs its own Round clock, and
  somebody else's Round finishing is not yours. It emits the same `stat_stepped` event a healing
  automation does, so the cutscene animates the Stat coming back with no new renderer, plus one Chat
  Log line per fighter naming the Stats — shaking off a Round's worth is one thing that happened to
  them, not four.
- **Not yet drawn on the sheet.** The mechanic is visible through the Chat Log and the die moving; the
  per-Stat outstanding total is not shown anywhere yet, which is worth adding if the split turns out
  to matter at the table.
  - **Verified**: `groundingTripRecoveryTics` is pure and unit-tested (all of the move's Recovery and
    none of anybody else's, junk input never becoming negative or fractional frames), plus a
    `phaseAtTic` sweep proving the frames reach back exactly to the Active end and that the same move
    without the Tag stays ordinary Recovery throughout; `scripts/playtest-grounding.mjs` checks the
    same three claims against a live server, including that an Off The Ground move can be thrown out
    of the frames Grounding created.
- **Drawn as darker blue with a down arrow on every frame.** It stays in the blue family on purpose —
  it *is* Recovery, just spent on the floor, and a fifth hue would say it was a different kind of
  thing. The arrow is what actually carries the distinction, because two adjacent blues is exactly
  the difference that fails for anyone who cannot separate them. `PHASE_BG.trip_recovery` flows to
  every render site through the shared palette; the arrow is drawn where a frame is big enough to
  hold one. An imposed trip Tic keeps the trip colour rather than the generic dimmed-extension blue,
  or the arrow would end up sitting on the wrong background.
- **Verified**: `server/test/tripFrames.test.js` (10 checks on the two pure rules, including a swept
  invariant that Active never begins early) and `scripts/playtest-trip-frames.mjs` (9 checks against
  a live server — the trip written as trip frames, named in the Chat Log, carried in the combat
  payload, and then *read back at declare time*, with a Tagged and an untagged move measured against
  the same floor). That last chain is the one thing no unit test reaches: the Tag is the only rule in
  the game that spans resolution and declaration.

**Recovery lands on the timeline (decided, new; implemented).** "If a move applies Recovery to the opponent, the Recovery frames should be applied instantly, moving the declared frames of the opponent to a later Tic." Imposed Recovery is no longer bookkeeping that quietly changes a later subtraction — it is a thing that happens to the clock at the moment it fires, and you can watch it happen.
- **Where the frames go is decided by what the target is doing at that exact Tic**, and there are exactly three answers (`planImposedRecovery` in `server/combatTiming.js` — pure, unit-tested before it was wired to anything, per this repo's own rule about the timing math):
  - **Caught in Startup** → the extra Tics are added to that move's own Startup, so the move is **delayed**. `placement_tic` deliberately stays put (the wind-up genuinely began there) and `reveal_tic` moves later, dragging Active and Recovery with it.
  - **Caught mid-Active or mid-Recovery** → the move plays out as declared and the frames go **on the end**, after its own Recovery — `recovery_extension_tics`, the same column a Block's too-late coverage already writes to.
  - **Caught between moves** → there is no move to lengthen, so the whole effect is the displacement. **Nothing is drawn on the idle Tics themselves** (decided): a Tic strip draws declared moves, and there is no declared move there to draw. Inventing a bodiless "stun band" would need its own table, its own payload and its own renderer to say something the sliding moves already say.
- **In all three, everything that character declared after the affected move slides by the same amount.** That is not decoration — lengthening a move without moving what follows it would overlap the two, which is precisely the state `computePlacementTic` exists to prevent at declare time.
- **A negative `self_recovery` is the one exception** and keeps the old local path: shortening a window is not a displacement, and pulling later moves *earlier* would drop them below the placement floors they were declared under.
- **The cutscene animates it** — a new `moves_displaced` round event, one per firing, drives every affected bar sliding into its new place (`DISPLACED_VARIANT`: arrives from where it used to be and settles, read left-to-right like the timeline itself). **The same animation now covers Postpone**, the other way a move ends up later on the clock — and fixed a real gap while it was there: a postponed move's bar used to stay exactly where it was while the log said "postponed to Tic 6".
- **The payload carries ids and a Tic count, never new frame ends.** A round_event is replayed to everyone and a still-unrevealed move's Active/Recovery lengths are secret, so the client shifts by a delta instead — which also keeps a wind-up bar correctly closed off at its own reveal Tic.
- **Verified against the running app** (`scripts/playtest-imposed-recovery.mjs`, 18 checks): all three cases classified correctly from live state, the caught move delayed rather than lengthened in the Startup case, grown on the end in the mid-move case, untouched in the idle case, the queued move sliding by the same amount every time, no overlap afterwards, and the Chat Log naming the case in words. Two things that pass turned up while building it and are worth knowing: **an attack that deals damage while the target is in Startup Interrupts them**, which deletes the very move whose delay is being measured (the playtest's shove carries the **No Damage** Tag for exactly that reason), and **a displaced footprint becomes the next round's placement floor**, which is correct but means each case needs its own fight rather than the next round of one.
   - Manually QA'd via direct socket calls (`applyMoveInteractions` isn't itself exercised by the server test suite — it's DB/broadcast-heavy orchestration, same category as `combat:resolve_defense` itself) covering all 5 triggers plus the `interactions_resolved` double-fire guard (confirmed a re-resolved defense's `defense_failure` fires again while `block` correctly does not), and one live-browser click-through confirming the client really threads `attackerDeclaredMoveId` through — the second bug noted above was caught by exactly that pass.

### Combat Automation overhaul ("Cutscene Resolution") — IN PROGRESS
Everything above this subsection (sub-phases 1-5) required a GM to manually step every Tic, click a Stat to apply damage, and judge every Block/Dodge/move-conflict via a dialog. This overhaul makes a round resolve **itself** the instant both sides of a pair finish declaring — dice roll automatically, Block resolves from pure math with zero clicks, damage lands on the right body part automatically, Interruption (coded once, long dead, never wired to any UI) actually fires — presented to players as an animated "cutscene" on the Tic timeline. **Dodge is the one human-in-the-loop step that survives**: whenever a Dodge-flagged move's Defense Frames fully cover an incoming attack's Active window, the GM gets a pop-up — wherever they are — to call it Successful or Failed. The pre-existing Forfeit/Postpone move-conflict prompt (scoped to the affected player, not the GM) is kept as a second, independent pause point. Bundled into the same effort: the rename to **Dogfight: Martial Arts TTRPG** (short **Dogfight**) throughout every user-visible surface.

Full design (locked decisions, data model, the `advancePairResolution` resolution-engine algorithm, the `round_events`-driven client architecture, and the phased build order) lives in the plan file this overhaul was designed under; the summary here is kept current phase by phase rather than duplicating that whole document inline.

**Locked decisions worth restating here** (do not re-litigate): ~~Block is fully automatic; Dodge is the only GM prompt~~ — **both reversed by the Defence rework's decision #1; every defence now asks the GM**; move-conflict Forfeit/Postpone is unchanged, just auto-triggered; Interruption is fully automatic (no prompt); a move's damage auto-targets **every** allowed concrete Stat in its own already-stored Attack Target order, with the defence resolved per Stat (revised — it used to take only the first, see the Attack Target section); Uneven Combat's "who gets hit" auto-selects the lowest `character_id` among valid opposing targets; round transitions are automatic and **per pair independently** — one fight can be on round 5 while another is still on round 3, no fight ever waits on another; a round replay ("Watch Round X") is visible to anyone, GM or Player, once posted; there is no manual pause/override during an auto-playing cutscene beyond Dodge/conflict, though a client-side skip-to-end seek is still supported since everything is precomputed server-side before any animation begins.

**Status by phase** (see Implementation Phases below for the full list; each phase's own verification step is recorded there):
- **Phase R — Rebrand: done.** Product renamed to "Dogfight: Martial Arts TTRPG" (short "Dogfight") across every user-visible surface — title, manifest, service worker cache key, README, this plan's own title, the app header logo, the Role Modal heading, the server boot log. `package.json` "name" fields and the GitHub repo name were deliberately left untouched (internal plumbing, no user-facing effect).
- **Phase A — Schema + pure-function groundwork: done.** `moves.defense_kind` (+ migration backfilling every pre-existing Defensive move to `'block'`, + the Move Creator's Block/Dodge toggle — labelled **Defense type** and shown for *every* Defensive move rather than only appearing once a Defense Frame had already been placed, since a control that materializes later is a control nobody knows exists; with no frames yet it renders disabled with a hint saying so, and each option carries a one-line explanation of what that kind means. Submission is still gated the same way: `defense_kind` is only stored when the move is Defensive *and* has at least one Defense Frame) — see the moves table in the Data model above. The `pair_round_resolutions` and `round_events` tables exist (see the Data model above) but aren't wired into any handler yet — that's Phase C's own job. New pure, unit-tested helpers in `combatDamage.js`/`combatTiming.js` for Uneven Combat target selection, defense-move auto-selection, and the per-Tic interrupt-eligibility walk. Zero behavior change — nothing wired yet.
- **Phase B — Per-pair state migration, automation still off: done.** Round/phase/Tic state moved off the single arena-wide `combat_state` clock onto `combat_pairs`, one independent copy per pair (see Combat Timing above and `combat_pairs` in the Data model above) — `combat_pairs` rows now persist and are upserted round to round instead of being deleted/recreated. `combat:updated`/`GET /api/combat` reshaped: per-pair state moved into a camelCase `pairs[]` array (`shapePair` in `server/index.js`); `participants[]` is unchanged (still raw snake_case DB rows) — this asymmetry is deliberate, not a bug. Every client reader (`CombatHeaderBar.jsx`, `CombatArena.jsx`) updated to select "which one pair does this widget show" per viewer (a Player's own seat's pair; the GM's selected lane, or the first pair) — a deliberately simple placeholder pending Phase E's real per-pair switcher. **Tic stepping is still manual in this phase** — the point was proving the per-pair-independent clock in isolation before also layering automation on top in Phase C. Verified via an extended `scripts/e2e.mjs` multi-pair block (two pairs' Tic Countdowns stepped independently, confirmed neither affects the other) and a live-browser Playwright pass confirming the Arena renders correctly per-pair for both GM and Player roles, including mid-cutover (one pair Declaring while another is already Resolving).
- **Phase C — Automatic resolution engine, no pausing yet: done.** `server/roundResolution.js` (new module) — `advancePairResolution(pairIndex, io)` steps one pair's own `combat_pairs` row Tic by Tic through §2.2's full algorithm (reveal, auto-roll, target selection, defense-move auto-selection, Block/Hit/Interruption), persisting a `round_events` row per event and, once the round's own last Tic is processed, marking `pair_round_resolutions.status = 'complete'` and calling `startPairDeclaration` (extracted from `combat:next_round`, now callable one pair at a time) to open that pair's next round automatically. **Deliberately lives in its own module rather than `server/index.js`** (a documented deviation from this overhaul's original plan text) — `server/index.js` boots a real server unconditionally at module load (`initDb()` + `httpServer.listen()`), so anything importing it, including a test file, would start a live server; `roundResolution.js` imports only genuinely side-effect-free modules (`db.js`/`gameLogic.js`/`moveLogic.js`/`combatDamage.js`/`combatTiming.js`/`perkAutomations.js`), which is what makes `server/test/roundResolution.test.js`'s automated coverage possible at all. A small set of DB/broadcast orchestration primitives (`postSystemMessage`/`adjustStamina`/`logRoll`/`applyMoveInteractions`/`getReasonsToFightBonus`/`resolveMoveRollDice`) are intentionally-parallel duplicates of the same-named functions already in `server/index.js` (`io` taken as an explicit parameter here instead of closed over) rather than shared imports, for the same import-safety reason — kept in sync by hand if either side changes, flagged inline at both.
  - **Still exactly per decisions #1-#8** *(as of that slice; #1 was later reversed by the Defence rework — Block asks the GM now)*: Block was fully automatic math, zero prompts; damage auto-targets via `selectAutoDamageTarget`/`selectUnevenCombatTarget` (decisions #5/#6); Interruption (decision #4/#7/#8) is fully automatic, walking the attacker's Active window for the target's first Startup-window Tic via `findInterruptEligibleTic`, rolling the interrupted move's own Roll (or Body if it has none) at `+computeInterruptBonus`.
  - **This phase's own explicit scope cut, "no pausing yet":** the two moments that Phase D turns into real GM/player pauses — a full-coverage Dodge, and a Block-too-late move conflict — are instead auto-resolved with a documented placeholder decision (Dodge auto-Fails; a conflict auto-Postpones) so the engine can run a whole round end-to-end for testing before the harder pause/resume machinery exists. Every placeholder decision still posts its own `round_events` row (`dodge_prompt`/`dodge_resolved`, `move_conflict_prompt`/`move_conflict_resolved`, each carrying `placeholder: true`) so Phase D's real implementation has an identical event shape to slot into.
  - ~~**Not yet wired into any live socket handler**~~ — **superseded by Phase E**, which did the live wiring (see Phase E below). As of Phase C this was true: `server/index.js` did not import `roundResolution.js` at all and Tic stepping was still as manual as Phase B left it.
  - **Also deliberately does not** post the existing `chat:lane_snapshot` per-reveal chat card on a Tic's reveal step, even though the manual flow's `postMoveReveals` still does — that mechanism is explicitly slated for removal in favor of a once-per-round `round_summary` card in Phase E (§1.5/§4.2), so wiring the soon-to-be-removed one into the new engine now just to tear it back out was skipped.
  - Verified via `server/test/roundResolution.test.js` (new, 5 integration-style scenarios against a real temp DB — plain Hit, Full Block, Partial Block, a too-early auto-fail, and an Interruption — `Math.random` mocked to a constant near 1 for the whole file, since `rollDie` isn't independently seedable, turning every scenario into deterministic arithmetic driven by which Stats/die sizes/frame data each one picks) plus the full `npm test` suite (163/163) and `scripts/e2e.mjs` (278/281, the same 3 pre-existing failures as Phase B, confirming zero regression since `server/index.js` itself was untouched this phase).
- **Phase D — Dodge + move-conflict pausing, real resumability: done (engine-level; not yet wired to a live UI).** `resolveAttack` now truly pauses at the two decision points instead of Phase C's placeholder auto-resolve: a full-coverage Dodge persists `pending_dodge_json` + `status = 'paused_dodge'` on the pair's `pair_round_resolutions` row and returns without applying any outcome; a Block-too-late collision (after the Block's own — always-automatic — roll/damage/interactions have already completed) persists `pending_conflict_json` + `status = 'paused_conflict'` for the *first* colliding move and returns, matching that column's single-slot shape. `advancePairResolution`'s own Tic loop stops immediately on either signal without bumping `resolved_through_tic`, so a resume re-enters the exact same Tic. New exported resolvers: `resolveDodge(pairIndex, { outcome }, io)` applies the GM's Successful/Failed call (Successful reuses the *"identical math to Block"* rule via a new `applySuccessfulDodge` helper; Failed reuses the same `applyFailedDefense` helper the too-early/too-late-Dodge/too-early-Block paths already share) and calls `advancePairResolution` again to continue; `resolveMoveConflict(pairIndex, { declaredMoveId, choice }, io)` applies Forfeit/Postpone (unchanged math, ported from the pre-overhaul manual `combat:resolve_move_conflict`) and recursively re-pauses if the postponed move collides with yet another already-declared move (the same cascade the manual flow already had), otherwise resumes. `resumeAllPairsOnBoot(io)` sweeps every `status = 'running'` `pair_round_resolutions` row — the actual boot-time resume sweep, not just asserted in a test.
  - **Mid-Tic resumability, the one genuinely new piece of engine plumbing this phase needed:** revealing a move (`reveal_posted`) and finishing its resolution (`interactions_resolved`) are tracked as two separate steps specifically so a pause landing partway through a Tic's several revealed moves (this game's declared-move-secrecy model means more than one move can legitimately reveal on the same Tic) resumes correctly — re-entering `processTic` after a pause does NOT re-reveal (and therefore re-roll/re-post-to-chat) an already-revealed move, but DOES still resolve any of that Tic's revealed moves a prior call didn't reach before pausing (`processTic` now selects by `reveal_posted = 1 AND interactions_resolved = 0`, not "just revealed this call"). Every one of `resolveAttack`'s return paths — including the two that previously left `interactions_resolved` unset (a Roll-less move, and "no eligible target") — now leaves that flag in a state this query can trust.
  - ~~**Still not wired into any live socket handler or client UI**~~ — **superseded by Phase E** (see below), which did exactly this wiring. As of Phase D this was a deliberate scope cut: wiring the engine in before the cutscene UI existed would have meant either throwaway UI or silently auto-deciding every Dodge in production.
  - Verified via 6 new scenarios in `server/test/roundResolution.test.js` (11 total, up from 5): a full-coverage Dodge pausing with the correct `pending_dodge_json` shape and zero damage applied before resume, Successful Full Dodge (zero damage anywhere), Successful Partial Dodge (damage lands on the *defender's own* blocking Stat, same Attack Target replacement rule Block uses), a Block-too-late collision pausing and Forfeit deleting the colliding move, the same pausing with Postpone shifting the collision forward *and* recursing into a second real collision, and a restart-simulation test (`resolved_through_tic` rolled backward on an already-`running` resolution row, `advancePairResolution` re-invoked, confirms the DB's damage/status end state converges to the identical result rather than double-applying — proving the crash-recovery property the module's own header comment claims, not just asserting it). Full regression: `npm test` (169/169) and `scripts/e2e.mjs` (278/281, the same 3 pre-existing failures as Phases B/C — zero regression, `server/index.js` itself still untouched).
- **Phase E — `RoundCutscene.jsx` + chat replay: done. The automatic flow is LIVE — this is the phase where the engine stopped being dead code and the manual flow was removed.** What landed:
  - **Palette consolidation (§4.3) — done.** New `client/src/lib/framePhaseColors.js` is the single canonical Startup/Active/Recovery/Defense palette (`PHASE_BG` flat fills, `PHASE_ZONE` bordered+glow, `PHASE_LABEL`) plus `phaseAt`/`phaseBgAt`, the client-side mirror of `combatDamage.js`'s `phaseAtTic`. The surviving family is amber/rose/blue/emerald. All previously-duplicated copies now import from it: `FrameBar`'s `SEGMENTS`, `CombatArena`'s `DECLARED_PHASE_COLOR` **and** `TicSquare`'s `zoneStyle`, `ChatPanel`'s `SNAPSHOT_PHASE_COLOR`. This turned up a real bug rather than being pure tidying: a **fifth** hand-rolled copy (the Arena's footprint-preview legend) was still on the older yellow/red/green family, so its swatches no longer matched the squares they labelled — it's now generated from `FRAME_PHASES` so the two can't drift again.
  - **Live wiring (§2.1) — done.** `server/index.js` now imports `roundResolution.js`. `combat:character_done_declaring` flips a pair whose `declaring_side` just cleared straight to `phase = 'resolving'` and calls `advancePairResolution` — **this replaces the manual "Start Tic Countdown" button as the actual trigger**. New GM-only `combat:resolve_dodge` handler. `combat:resolve_move_conflict` keeps its exact payload shape (decision #3) but now checks for an engine pause on that same `declaredMoveId` first and hands off to `resolveMoveConflict` when it finds one, falling through to the untouched manual path otherwise. `resumeAllPairsOnBoot(io)` runs at boot (not awaited before `listen()` — a pair that can't finish resolving must not stop the server coming up).
  - **Event delivery + secrecy (§3) — done.** `round_events` are no longer a bare `io.emit`: `emitToPairAudience` sends each to the GM plus any Player seated in that pair, and **fails closed** (a socket that hasn't sent `identity:set` sees nothing) rather than falling back to a broadcast. `combat:dodge_prompt` additionally went to every GM socket unconditionally via `emitToGMs`, sent off the single `dodge_prompt` round_event so the stored log and the live prompt couldn't disagree. **That extra push is gone** — see *Pause delivery* below for why a one-shot event turned out to be the wrong carrier for a question that has to keep being asked.
  - **Replay plumbing (§1.5/§3) — done.** `chat_log.kind` widened to include `'round_summary'` (5th value; `migrateChatLogKind` rebuilds the table again, since SQLite can't ALTER a CHECK in place). `postRoundSummary` posts exactly one card per pair per round as its resolution completes. New unrestricted `GET /api/combat/round-replay/:resolutionId` (decision #11). The `reveal` event payload was **enriched to carry the move's whole footprint and display identity** — that's what makes a stored replay self-contained per §0, since a replay watched later can't re-derive footprints from combat state that by then describes a different round. `shapePair` now folds `pendingDodge`/`pendingConflict`/`resolutionId` into the snapshot so a reconnecting GM recovers a pending prompt for free (§2.4).
  - **Client (§4.1/§4.2) — done, but not yet visually verified.** New `RoundCutscene.jsx` renders live and replayed rounds through one code path off the same `round_events` shape; sequencing is a GSAP tween over a plain `{i}` playhead proxy (rather than a timeline of per-element tweens) so streaming events extend the run instead of restarting it, and skip-to-end is a single assignment. Players' move bars above the Tic strip, NPCs below. Mounted in the Arena in place of `TicCounterCentral` whenever a pair is Resolving. New `DodgePromptDialog.jsx` (a 2-tile Successful/Failed picker, not the old 4-tile grid — Block, defense-move selection, and partial-coverage Dodge all stopped being human choices) delivered through `CombatHeaderBar`'s global queue so it reaches the GM on any page. New `RoundSummaryCard` in `ChatPanel` opens the replay in a fullscreen `DialogShell`.
  - **Verified so far:** `npm test` 169/169; client build clean; a live server driven through a real round confirms the whole server pipeline end-to-end — the round resolved automatically on the last Done Declaring, persisted `round_events`, wrote a `round_summary` row, advanced the pair to round 2 on its own, and `GET /api/combat/round-replay/1` returns the full log with self-contained reveal payloads. A browser pass confirms the app loads, is rebranded, and shows the per-pair round advancing.
  - **§5's removal list — done.** `combat:start_tic_countdown`, `combat:tic_forward`, `combat:tic_backward`, `combat:resolve_defense` (the old GM 2×2 prompt) and the never-wired `combat:check_interrupt` are all deleted server-side, along with the helpers only they used (`postMoveReveals`, `buildLaneSnapshotPayload`, `applyIdleTicStaminaRegen`, `resolveDefensiveRollDice`) — `server/index.js` is ~390 lines shorter. `combat:resolve_move_conflict` keeps its event name, payload and player-scoped audience (decision #3) but its manual branch is gone: the engine is now the only source of that prompt, so the handler just routes the answer to the paused pair. Client-side: click-to-step and the in-strip "Next Round" button, the Start Tic Countdown button, the reveal-time auto-Roll dialog queue, `ResolveDefenseDialog.jsx` (deleted), the chat roll card's Apply/Resolve Defense buttons, and `LaneSnapshotCard` + the `chat:lane_snapshot` subscription are all removed. `combat:next_round` survives as the **Start Combat** seed only — it is no longer reachable as "advance the round," which is automatic and per-pair.
  - **Ad-hoc damage kept a home (§5).** `DamageApplicationDialog` lost its only entry point when the chat roll card's Apply button went away, so a GM-only ⚕ action on each Arena participant card now opens it in unrestricted mode (no attacking declared move ⇒ no Attack Target restriction) — for environmental damage or a house rule, outside the automated flow.
  - **`scripts/e2e.mjs` rewritten for the automatic flow and green: 281/281, zero failures.** The manual per-Tic stepping blocks are replaced by outcome assertions — that the last Done Declaring resolves the whole round and opens round 2 unaided, that the log is pushed live and is internally consistent (seq strictly increasing, every event tagged with its own pair/round), that a `reveal` carries a full self-contained footprint, that exactly one `round_summary` card is posted, and that the replay endpoint returns the same rows in the same order that were pushed live. It additionally asserts the three deleted handlers are genuinely gone (a stale client can't step a pair's clock behind the engine's back) and, in the multi-pair block, that two pairs sit on **different round numbers at the same time** — decision #12's "no fight ever waits on another" in its strongest form.
    - Three checks changed for real reasons rather than being made to pass: the fairness/secrecy test now leaves one side deliberately un-finished (finishing the last declaration is what starts resolution, so the old "declared but nothing revealed" window no longer exists); the chat-length assertion became a before/after comparison instead of a magic number (the engine legitimately writes more chat rows, and an absolute count would need rewriting for every future mechanic that says anything in chat); and a genuine test-side race was fixed — `round_events` land on a different socket than `waitEvent` watches, so "the state changed" and "this socket has seen the log" are different moments.
    - The e2e also now covers the secrecy boundary explicitly: an anonymous socket that never sent `identity:set` receives **no** round_events at all, proving the fail-closed rule rather than assuming it.
  - **Verified end to end.** `npm test` 169/169; `scripts/e2e.mjs` 281/281; client build clean; and a live browser pass driving a real round then opening its replay from the chat log — confirming the cutscene renders (PC bar above the Tic strip, NPC below, phase colours from the shared palette), that playback is progressive (mid-animation: 2 events revealed, playhead on Tic 3) and that Skip to end works (all 7 events, playhead on Tic 7), with no console errors.
  - **Still not built (carried forward):** the GM's per-pair cutscene tab strip (a GM currently sees whichever pair the Arena is showing), richer hover tooltips than the current title attribute, and a 3-simultaneous-browser-context playtest of the Dodge prompt reaching a GM on an unrelated page. The Dodge and move-conflict pause paths are covered by unit tests and by the snapshot-recovery plumbing, but have not been exercised through a real browser.

- **Phase F — Cleanup + this plan's own mechanic sections rewritten: done.** The dead server handlers were deleted during Phase E, and the "Combat Timing" section above has been rewritten rather than appended to: its old "Tic Countdown Phase" is replaced by the **Resolution Phase (automatic)**, and the Start Combat / per-pair-clock / Idle-Tic Regen paragraphs no longer describe controls that don't exist. The "Combat Automation" section is retained deliberately as the statement of the *rules* — the damage formula, coverage classification, Full/Partial thresholds and interaction automations are all still exactly what the engine applies — with a header note making clear that everything it says about *who presses what* is superseded. Its sub-phase build-order narrative is left intact as history, not current description.
  - **Also built in this pass:** the GM's per-pair cutscene tab strip (§4.1) and readable per-event hover detail replacing the earlier raw-JSON tooltip.
  - **Final regression:** `npm test` 169/169; `scripts/e2e.mjs` 281/281; client build clean; `scripts/playtest-dodge.mjs` (new) 17/17 — a two-browser test of the one human-in-the-loop step, covering the claim no socket test can make: the Dodge prompt reaches a GM sitting on a **non-Arena page**, names both fighters and their moves, is **not** shown to the Player (who instead sees their own pair waiting on the GM), and once answered resumes the round to completion with the GM's actual call recorded in the stored log.

### Uneven Combat: choosing your target (decided, new)

`declared_moves.target_character_id`, written once at declare time. With one
opponent there is nothing to choose and it stays NULL — as it does on every row
written before the column existed — and the engine's own deterministic rule
(lowest `character_id` among the opposing side) remains the fallback for NULL, for
a target who has since left the pair, and for anything else unexpected. A fighter
commits to a target with the same information they commit to a Tic with.

- **`move:declare` validates it**, accepting only someone actually seated on the
  other side of that pair, and storing NULL otherwise. Not a rejection: a stale
  pick is a worse reason to refuse a declaration than it is to ignore.
- **The engine prefers it** in both target-selection paths — the attack flow's own
  inline selection and `selectTargetCharacter` (the grapple path) — whenever the
  named person is still a candidate.
- **It is public on the wire**, for the same reason `placementTic` is: squaring up
  to someone is visible at the table, and it is what lets everyone's matchup
  plaque show the right number rather than only the fighter who picked.
- **The picker appears only when the pair is genuinely uneven.** The choice rides
  on every move declared after it, so a round can be split between two enemies by
  changing it partway through.

**The Stance matchup follows the chosen target.** `getPairStanceMatchup` used to
return null outright unless each side held exactly one person — so an Uneven
Combat displayed no matchup anywhere, though the rule still applied to the rolls.
It now also returns `byCharacter[characterId][opponentId]`, every facing in the
pair, and the client reads the entry for whoever that fighter is currently coming
for. The original 1v1 fields are unchanged and still present only for a real duel,
so every existing reader kept working: a duel shows its number once on the VS
divider exactly as before, and an uneven pair shows each fighter's own number on
their own card, named ("vs Bartholomew") because a badge on a card has to say who
it is against.

### A move pushed wholly out of its round belongs to the next one (decided, new)

Several things slide a declared move forward — a Block's extended Recovery
cascading through the queue, an imposed Recovery from a Movement Punisher — and
any of them can push one so far that **not one of its frames is left in the round
it was declared for**. Such a move used to sit in limbo: still stamped with the
old round, so the new round's lane never showed it, and still carrying whatever
Stamina state it was left in.

`rehomePushedMoves`, run at round-open from `startPairDeclaration`, re-stamps it
with the round it actually occupies, clears `stamina_committed` and refunds what
was charged — making it an ordinary pending declaration of that round: in the
lane, cancellable with the same ✕ as anything else, and charged again at Done
Declaring.

**One rule at round-open rather than one per path that can shift a move.** Every
way a move can be pushed ends up here, including ones not written yet, and the
test is `overlapsRoundWindow` — the same pure helper the lane rendering already
uses to decide whether a move belongs to a round at all. An ordinary carryover,
which *started* in its own round and merely runs long, is untouched: the
placement Tic still being behind the new round's start is what separates the two.

## Game mechanic — Attack Target (Change 001, implemented)
**Status: fully built and wired end-to-end.** Every Move template now carries an **Attack Target**: which of the 6 abstract Stat slots (same vocabulary as a Roll — see Roll slot vocabulary under Moves & Tells above) its damage is allowed to land on. This is purely a *restriction* layered on top of Combat Automation's existing damage flow (4.1/4.2 above) — it doesn't touch the damage formula, Block/Dodge result math, or Full/Partial thresholds.

- **Multi-select, no minimum (decided).** `moves.attack_targets` is a JSON array of 0-6 of `Skull`/`Brain`/`Hand`/`Stamina`/`Body`/`Leg`. A brand-new Move starts with **none selected** (`[]`) — an explicit, valid "no target," not missing data. Every Move that existed before this Change was migrated to exactly `['Skull']` (the DB column's own default, a one-time backfill — see `moves.attack_targets` in the Data model above).
- **Every named Stat is hit, and each is defended separately (decided, revised — this replaces "the first eligible Stat").** A move listing Skull and Body attacks *both*: each named Stat takes the attack's damage, and the defender's guard is resolved against each line independently. The original rule picked the first eligible Stat off the list and dropped the rest, which made the list a set of *candidates* rather than a description of what the move does — a two-Stat move hit exactly as hard as a one-Stat move, and the second Stat was decoration.
  - **Damage:** `selectAutoDamageTargets` (plural, `server/combatDamage.js`) returns every named Stat the target actually has, in the move's own already-canonical order; only a *missing* Stat drops out, and a Stat named twice is still hit once. (A **broken** Stat is returned like any other — see the broken-Stat rule below.) One `damage_applied` event is emitted **per Stat** rather than one carrying a list, so the cutscene animates each die stepping down with no client change and a stored replay keeps the shape it has always had (§0). A single chat line names the whole blow ("took 0.5 damage to Skull and 0.5 damage to Body from X") rather than one line per Stat. The Interruption check runs once for the blow, on the heaviest Stat's figure — being hit in two places is still one blow.
  - **Block:** the guard is **rolled once per attacked Stat**. One roll cannot answer two lines of attack, and asking it to made the second Stat free. Each line gets its own roll, its own Full/Partial outcome and — for a Block-Tagged move — its own Stamina bill, re-read between lines so a guard that spent everything holding the first Stat genuinely has nothing left for the second. Everything the guard failed to hold is summed and lands as one figure.
  - **A broken Stat absorbs nothing, and the round says so (decided, new).** An attack aimed at an incapacitated Stat used to be deleted in silence: `selectAutoDamageTargets` filtered the die out, `selectUnevenCombatTarget` skipped the fighter entirely, and in 1v1 the whole attack bailed at `damage_applied: 'no-eligible-target'` before defence resolution had run — no roll, no guard, nothing said. Punching a wrecked arm was a no-op nobody was told about.
    - The attack now **calculates and resolves normally**: it is rolled, blocked or dodged, and every trigger fires as usual. Only the *application* fails. `applyAutoDamage` returns `{ applied, unapplied }` and skips the DB write for an incapacitated die, and `runInterruptAndDamage` emits a **`damage_unapplied`** round_event per skipped line (its own type, not a flag on `damage_applied`, so the cutscene does not animate a die that never moved).
    - **Nothing is redirected.** The damage does not slide onto a neighbouring Stat; it simply does not land.
    - At round end, just before the summary card, `reportUnappliedDamage` reads those events back off the round's own log, totals them **per character and Stat**, and posts one line each: *"1.5 damage should have been dealt to Roy's Left Hand, but it cannot be applied. Take this into consideration for Injuries."* Read from the event log rather than accumulated in memory or a new column — the log is already the durable per-round store and survives every pause the round can take, so a round resumed after a restart reports exactly what a round played straight through would. **One line per Stat, totalled**: a broken limb taking four hits in a round is one fact about that limb, not four sentences.
    - **Eligibility stops looking at Stat status at all**, in `selectUnevenCombatTarget` too — it is the only version that works in 1v1, and it makes Uneven Combat targeting the plain deterministic "lowest character id among opponents who have that Stat".
  - **Dodge:** the GM is **asked once per attacked Stat**. `pending_dodge_json` carries `remainingStats` and `stepsBySlot`; each answer records that line's outcome (dodged = 0 steps, failed = the attack's full weight), pops it, and re-pauses on the next Stat until the list is empty — a re-pause is a clean continuation, since nothing is applied until every line is answered. The prompt names the Stat it is about and how many are still to come, and the dodge-prompt dedupe key includes the Stat (without that, the second question was silently discarded as a duplicate and the round stayed paused on a prompt nobody was ever shown). The attack counts as evaded only if the dodge got clear of **all** of it; anything that got through is a failed defence, and each Stat takes exactly what its own answer earned it.
  - **The Successful Block redirect stays singular.** That rule replaces the attack's target with "the blocker's own Stat" and is handed the blocker's whole Roll, which is not a move's authored Attack Target — spreading the leftover across every Stat the blocker happens to roll would be a different rule nobody asked for. `applyAutoDamage`'s `firstOnly` flag exists for exactly this one call site.
  - Verified end-to-end against the real server by `scripts/playtest-multi-target.mjs` (both named Stats damaged, an unnamed Stat untouched, one event per Stat) and `scripts/playtest-multi-target-dodge.mjs` (two prompts naming different Stats, answering one re-pauses on the other, the dodged Stat takes nothing and the missed one takes the hit).
- **Whether a Move even has a Roll is what makes it an Attack, not its Attack Target.** A Move with no Roll isn't an Attack at all (this field is simply inert for it). A Move *with* a Roll is an Attack even with an empty Attack Target — it just means the normal (non-Block) resolution has nowhere valid to apply damage, so Apply stays disabled until a Successful Block gives it one (see below).
- **Successful Block replaces the effective target (decided) — Dodge does not (out of scope for this Change, see the deferred item below).** The instant a Block resolves Successful (Full or Partial alike — matches 4.2's existing "identical math, Block vs. Dodge" precedent for everything except this), the attacking declared move's effective target is overwritten with the **blocking move's own base `move_roll_slots`** (never its `move_defensive_roll_slots` pool — that pool only ever contributes to the Block's *result total*, per 4.2, never to what it can turn into a target) expanded to concrete Stats via the blocking move's own already-stored `appendage_choice`. This can turn a previously-empty Attack Target into a real one — a Partial Block's remaining damage becomes applicable exactly where the block itself landed. Failed Block leaves the snapshot untouched.
- **Block therefore now requires a base Stat Roll (decided, a real behavior change for existing content):** a Custom Roll move (`roll_type = 'custom'`) has no named Stat to turn into a replacement target, so it can no longer serve as a Block — enforced both in `ResolveDefenseDialog.jsx` (the tile disables, with a tooltip) and, authoritatively, in `combat:resolve_defense` itself (rejects outright regardless of what the client sent). This narrows what was previously accepted (a Custom Roll defensive move could Block before this Change) — a deliberate, scoped tradeoff rather than an oversight.
- **Concrete resolution (decided):** the template's abstract `Hand`/`Leg` expand to `Left Hand`+`Right Hand` / `Left Leg`+`Right Leg` (both sides valid) for a plain declared attack with no Block yet; once a Successful Block replaces the target, `Hand`/`Leg` narrow to whichever single side that specific Block was declared with. `expandAttackTargets(list, appendageChoice)` in `server/moveLogic.js` (unit-tested) does this in both places — declare-time (`appendageChoice = null`, both sides) and Block-replacement-time (`appendageChoice` = the blocker's own stored choice).
- **The snapshot lives on the declared move, not the template (decided):** `declared_moves.effective_attack_targets` (concrete Stat names) + `attack_target_source` (`'move'` or `'block'`) are written once at `move:declare` (from the template's current `attack_targets`) and only ever overwritten by a Successful Block afterward — a later edit to the Move template in the Compendium never retroactively changes an attack that's already been declared. This is what survives page reload/reconnect: `GET /api/chat` re-reads current `declared_moves` state for every `kind='roll'` row's own `declaredMoveId` (one batched query, not N+1) rather than trusting whatever was frozen into that roll's own `chat_log.payload` at roll time, since a Block can resolve *after* the attacking roll card was already posted and logged.
- **Server-authoritative enforcement (decided):** `combat:apply_damage`, whenever it carries an `attackerDeclaredMoveId`, now looks up that declared move's current `effective_attack_targets` and rejects the whole call (no die mutation, no Undo-buffer write, no chat audit line, no interaction automation) if the targeted die's `slot_name` isn't in that set — before any of those side effects, not after. This is a hard restriction independent of the client: a stale or hand-crafted Socket.IO payload can't bypass it. A call with no `attackerDeclaredMoveId` at all (manual/ad-hoc GM damage) is untouched by any of this, exactly as before.
- **Client UI:** `MoveCreator.jsx` gets an Attack Target picker (same multi-select button styling as the Roll slot picker) directly under the Roll section; `MoveCard.jsx` shows the selection (or explicit `None`) under its `Roll:` line, only when the move has a Roll at all. `ChatPanel.jsx`'s roll card and `DamageApplicationDialog.jsx` both show an `Effective Attack Target: …` line (`— changed by Block` appended once `attack_target_source === 'block'`) — the dialog additionally dims every disallowed Stat on the Vitruvian figure (`cursor-not-allowed`, `Not an Attack Target` tooltip, no click) rather than hiding it, so a GM can see exactly what's off-limits and why. The chat card's **Apply** button is disabled whenever `damage === 0` **or** the effective target list is empty; **Resolve Defense** stays available even for an empty-target attack, since that's exactly the case a Successful Block can still turn into something applicable.

**Dodge's own correction — DEFERRED THEN, DONE NOW (see "Successful Dodge — BINARY" in 4.2 above).** The deferral below stood until a playtest hit both halves of it in play; rule (2) is now implemented and covered by `scripts/playtest-dodge.mjs` plus two inverted unit tests. The original note is kept for the record:

**Deferred — Dodge's own correction was explicitly out of scope for that Change** (a separate future item, not implemented here): confirmed rules for later are (1) Block always has a Roll, Dodge may or may not; (2) Successful Dodge fully cancels damage — there is no such thing as a Partial Dodge; (3) Dodge success is a GM judgment call via a prompt, the same trigger condition as today (Dodge Defense Frames meeting the attack's Active Frames); (4) **Dodge never replaces Attack Target** — this Change adds no code path that could make it do so (Block-only branch in `combat:resolve_defense`, guarded by `defenseType === 'block'`). Note this doesn't yet fix a real pre-existing inconsistency: today's `combat:resolve_defense`/4.2 still runs a Successful Dodge through the *same* Full/Partial roll math as a Block (see 4.2 above, "identical math... Block vs. Dodge"), which contradicts confirmed rule (2) above — left alone in that Change on purpose, since fixing Dodge's own math is exactly what that future item was for — **that item has since been done.**

## Game mechanic — Mobile Readiness (Change 002, implemented)
**Status: fully built.** The app was designed and built desktop-first through Phase 9; this Change makes every page usable on a phone (full GM+Player parity — **decided, 14.1A**: no reduced "mobile mode," every control below has a touch-usable path) without changing any game rule. Product/design decisions were locked from the spec's own recommended defaults (14.1-14.10) rather than re-litigated one at a time — noted inline below wherever a specific default was adopted.

- **Viewport/CSS foundation (`client/index.css`, `client/index.html`):** the viewport meta gained `viewport-fit=cover` (for safe-area insets) and a `theme-color` meta; `html`/`body`/`#root` get `min-width: 320px` (**14.3A**: full support down to 360px, functional-but-tight fallback to 320px — nothing narrower is a target) and `height: 100%`; `.app-shell` uses `100dvh` (falls back to `100vh` on browsers without `dvh` support) so mobile browser chrome showing/hiding doesn't clip content. Four CSS custom properties (`--safe-top/right/bottom/left`, from `env(safe-area-inset-*)`) are consumed individually by whichever edge actually touches device chrome (mobile header top, bottom nav/Composer bottom) rather than applied to the whole tree. `touch-action: manipulation` on every interactive element removes the ~300ms tap delay without disabling pinch-zoom/scroll. `@media (pointer: coarse)` forces `input`/`select`/`textarea` to 16px (`!important` — Tailwind `text-sm`/`text-xs` utility classes have higher specificity than a bare element selector and would otherwise silently re-break this on any input a component styled with a text-size class) to stop iOS's auto-zoom-on-focus, and forces `.hover-only-action` elements to `opacity: 1` (a touch device has no hover state at all, so a desktop hover-reveal affordance must default visible there). `@media (prefers-reduced-motion: reduce)` collapses every animation/transition to ~0 duration.
- **Shared primitives:** `client/src/lib/useMediaQuery.js` — a live-updating `matchMedia` hook (`useIsDesktop` = `min-width: 768px`, matching the rest of the app's existing `md:` breakpoint convention rather than introducing a separate one; `useIsCoarsePointer` = `(pointer: coarse)`). `client/src/components/DialogShell.jsx` — every dialog in the app (`MoveConflictDialog`, `ResolveDefenseDialog`, `DamageApplicationDialog`, plus every new mobile drawer/picker below) now routes through one shared shell instead of hand-rolling its own `fixed inset-0` wrapper: body scroll-lock, a Tab-cycling focus trap, Escape-to-close, `role="dialog" aria-modal="true" aria-labelledby`, and a `dismissible` flag (`MoveConflictDialog` sets it `false` — that prompt must be resolved, not dismissed). Two responsive `variant`s (**14.7A**): `sheet` (default) is a desktop-centered panel that becomes a bottom sheet on mobile (rounded top corners only, safe-bottom padding) for simple GM/player prompts; `fullscreen` fills the whole mobile viewport (desktop unchanged, centered) for a complex editor like Damage Application, which needs room for the anatomy figure plus controls.
- **App shell (`client/src/App.jsx`):** below `md:`, the desktop header nav links/search bar/Chat-toggle button (`hidden md:inline-block`/`hidden md:block`) are replaced by a hamburger "More" menu (Search full-width + Rules + Settings links) and a 4-item **bottom nav** (**14.2A**: bottom nav, not a hamburger-only menu — Arena/Characters(or Character)/Compendium/Chat, the same four destinations the desktop header already always shows). **The bottom nav stays mounted at all times, including while Chat is open (decided, revised).** It used to unmount the moment Chat opened, which left the panel's own ✕ — in the opposite corner from the Chat button that opened it — as the only way out, and no way to navigate anywhere else without closing Chat first. This required the chat overlay to be positioned `absolute` against the content row (which is now `relative`) rather than `fixed` against the viewport, so it sits below the header and *above* the nav instead of covering it. **Chat is a real tab on mobile, and the mobile ✕ is gone (decided, revised again).** Half-measures made it read as neither panel nor page: navigating to another tab left Chat sitting open on top of it, and the ✕ was a second, differently-placed exit for something the Chat tab already toggles. Now any change of route closes Chat below `md:` — keyed off the pathname, so the back button and any in-app link behave identically — and tapping Chat again is the only way out, exactly like every other tab. **Desktop is untouched:** there Chat is a persistent side panel *beside* the page, not a destination you navigate away from, so it neither auto-closes nor loses its toggle. **Chat defaults closed on mobile, open on desktop** (**14.8A**) — an unread badge (bumped by `roll:result`/`chat:message`/`chat:round_summary` while closed, cleared on open) tells a Player something landed in Chat without forcing it open. `client/src/components/ConnectionBanner.jsx` renders nothing while connected; a compact amber "Reconnecting…" or red "Offline — actions won't reach the server" banner otherwise, driven by `client/src/lib/connection.js`'s `useConnectionState()` (Socket.io `connect`/`disconnect`/`reconnect_attempt`/`connect_error` listeners).
- **Realtime resync (`client/src/lib/connection.js`'s `useSocketRefresh(refresh)`):** fires `refresh` on a genuine reconnect after the very first connect, and on `document.visibilitychange` back to visible (debounced 150ms) — a broadcast missed while disconnected or backgrounded (a phone locking, or switching apps mid-session) never replays on its own, so this re-fetches fresh state instead. Wired additively (a second effect alongside each component's existing targeted socket listeners, not a restructure of them) into `ChatPanel.jsx`, `CombatArena.jsx`, `CharacterSheet.jsx` — the three biggest data-owning views — and, since the pause-delivery rework, `CombatHeaderBar.jsx`, which owns every prompt dialog and was the one global view that had never re-read anything after mount.

  **Bugfix — it skipped the reconnect for anything mounted mid-session.** `hasConnectedOnceRef` started at `false` and existed to skip the *first* connect, on the reasoning that the component's own mount-time fetch already covers it. A component mounted while the socket is already connected never sees that first connect, so it treated the next one — a real reconnect — as the first and skipped it. Anything opened during a session (a GM Tools panel, say) therefore refused to resync exactly once, which is the once that matters. It is now seeded from `socket.connected`.
- **Combat Arena (`CombatArena.jsx`):** the header Tic Counter collapses to a compact `Tic N/L` text badge on mobile *only* while already on `/combat` (`CombatHeaderBar.jsx`'s `showFullCounter = isDesktop || !onArena`) — the Arena's own large counter is already visible there, so showing it twice would be redundant; every other page keeps the full counter, same as desktop. The counter's own square row scrolls horizontally on narrow screens (`overflow-x-auto`, a `mask-image` fade at both edges as a scroll affordance, no extra JS) with the current Tic auto-scrolled into view (`scrollIntoView({inline:'center'})`, same pattern reused on the Character Sheet's tab strip below). **Roster drawer + tap-to-seat (14.5A/replaces drag-and-drop, task #220):** a GM-only "Roster" button (`sm:hidden`) opens the folder-grouped roster in a `DialogShell`; tapping a character opens `SeatPicker` — a small Left/Right-per-pair-index picker (plus "New pair") that emits the same `combat:add_participant`/`combat:move_participant` a native drag-drop would. **Tap-to-declare (task #221):** a `DeclareMoveCard` tap sets the same `draggingMove` global pub-sub state (`client/src/lib/dragMoveState.js`) a native `dragstart` would — the existing footprint-preview and drop-target logic (`zoneFor`) then works identically for both input modes with no parallel state machine; a mobile-only banner ("Choose a Tic for {move} · Cancel") appears while a move is pending, and tapping any open Tic square calls `declareMoveAt` (extracted from the shared `handleTicDrop` logic) the same way a drop would. **Pair layout (14.5A, task #222):** each pair stacks Left/Right vertically below `sm:` instead of the desktop side-by-side row, and Declaration Lanes do the same. **The "VS" badge is shown at every size (decided, revised):** it started as a mobile-only substitute for the desktop vertical rule, but it names what the divider *means* rather than merely drawing one, so desktop now renders the badge sitting on top of its hairline rule instead of the bare rule alone.
- **Character Sheet (`CharacterSheet.jsx`, task #223/#224):** the 6-tab strip is `sticky top-0`, horizontally scrollable (`scroll-snap-type: x proximity`) with the active tab auto-scrolled into view — the active-stance badge moved off the scroller into its own row below so it can't widen the tab strip's own scroll content. **Core Stats (14.6A, revised — the 4-wide row didn't fit a phone):** the dice sit over a faint low-opacity Vitruvian figure rather than in a literal anatomical overlay, grouped into rows. Below `sm:` (640px) that grouping is **2/2/2/2** — Skull+Brain / Left Hand+Right Hand / Stamina+Body / Left Leg+Right Leg — because the original middle row was four widgets wide and simply could not fit a 390px screen: both Hands were clipped off opposite edges of the viewport. At `sm:` and up it stays the original **2/4/2** (Skull+Brain / Left Hand+Stamina+Body+Right Hand / Left Leg+Right Leg), which reads more anatomically. **On the desktop absolute-coordinate layout, Skull and Brain sit on the same two verticals as Stamina and Body below them** (36% / 64%, `client/src/lib/anatomy.js`). They used to be at 42%/58%, close enough together that the two widgets' Stat-step arrows and Half-Damage toggles overlapped and fought for the same pixels. Both are explicit row constants (`NARROW_ROWS`/`WIDE_ROWS`) rather than slices of `ANATOMY`'s key order — the narrow grouping is not a contiguous slice of it, and pairing left with right deliberately. Every remaining tab reflows below `sm:`: Counters' header row (name/reward/pip-count/Show-in-Combat/delete) wraps instead of overflowing; Inventory/Injury add-forms stack vertically (`w-full sm:w-1/3` instead of a fixed `w-1/3`); edit/delete icon buttons across `ItemList.jsx`/`InjuryList.jsx`/`CountersTab.jsx`/`RoleplayTab.jsx` were already always-visible (no hover-gating) and just needed a 44px target bump; Role-play's textarea/inputs inherit the global 16px-on-coarse-pointer fix.
- **Touch target + hover-only audit (14.10, task #217):** every icon-only/small action button app-wide bumped to a 44×44 CSS px minimum on mobile (WCAG 2.2 SC 2.5.5's Enhanced target size, stricter than the 24px AA minimum — the spec's own deliberately-stricter recommendation), sized back down on `md:` so desktop density is unchanged. Every hover-only reveal (`opacity-0 group-hover:opacity-100`, e.g. `CharacterList.jsx`'s per-card delete ✕) got the shared `.hover-only-action` class so the `pointer: coarse` rule above makes it default-visible on touch instead of permanently unreachable. No Wake Lock and no haptic feedback (**14.10**, explicitly deferred — neither is load-bearing for gameplay, both can land later without touching this Change's scope).
- **Compendium/CharacterList mobile folder drawer + tap-to-move (task #225):** the fixed `w-44` `FolderTreeNav` sidebar (both character-list folders and move Disciplines) collapses below `md:` into a "📁 {current folder} · Change…" trigger button opening the same `FolderTreeNav` in a `DialogShell`. **Filing a Move into a Discipline already had a tap path** (`MoveCreator.jsx`'s Discipline `<select>`, reachable via Edit) so no new dialog was needed there; **filing a character into a folder had none** (`character:set_folder` only ever fired from a native `dragstart`/`drop` pair) — a new `MoveToFolderDialog` (GM-only, a ⇄ button beside each card's existing ✕ delete) lists every folder flattened with its indent depth and emits the same event a drop would. `FolderTreeNav`'s own rename/delete icon buttons and its "+ new folder" row picked up the same 44px bump as the audit above. Granting a Move/Perk to a character already had a tap-only path too (the per-card **Grant…** checklist, `GrantList`) alongside its drag-onto-a-character-rail shortcut — the rail stays `hidden md:block` unchanged, since the checklist already covers mobile with no functional loss; its checkbox rows and the style-filter icon buttons picked up the same touch-target treatment.
- **Image payload perf pass (task #227):** `vitruvian_image_data`/`vitruvian_image_mime_type` (a full base64 backdrop image per character) is only ever read on a character's *own* Core Stats tab, via the single-character `GET /api/characters/:id` fetch — never in a roster/grid view. `GET /api/characters` and `GET /api/combat` (both of which return *every* character at once) now strip both fields before responding (`omitVitruvianArt` in `server/index.js`) instead of sending a full extra portrait-sized image per seated/listed character that nothing on those views ever reads; `GET /api/characters/:id` is untouched, so Core Stats' own custom-art upload/display is unaffected. Portrait thumbnails in scrollable rosters (`CharacterList.jsx`'s grid, `Compendium.jsx`/`PerksCompendium.jsx`'s character rail, `CombatArena.jsx`'s roster drawer) got `loading="lazy"`; the Arena's own always-visible seated-participant portrait did not, since lazy-loading an already-in-viewport image has no benefit.
- **Installable PWA (14.9A, task #228):** `client/public/manifest.webmanifest` (name/icons/`display: standalone`/theme colors, brand-red-on-near-black icon at 192px/512px) plus `client/public/sw.js`, registered from `main.jsx` after page load. The app is a live Socket.io session with no meaningful offline mode, so the service worker's only job is a faster reload on a flaky connection: cache-first for hashed `/assets/*` build output (safe — a content-hashed filename never goes stale), network-first-with-shell-fallback for navigations, and `/api/*`/`/socket.io/*` are never intercepted (always live). No Wake Lock, no push notifications — out of scope per 14.10.
- **Playwright mobile device matrix (task #229):** `playwright.config.js` (repo root) defines 5 projects against `e2e-mobile/*.spec.js` — `mobile-chrome` (Pixel 7), `tablet` (Galaxy Tab S4), `mobile-landscape` (Pixel 7 landscape — wide enough to legitimately fall back to the desktop nav pattern at `md:`, which the specs account for rather than assume bottom-nav everywhere), `320-fallback` (a forced 320×568 viewport, the 14.3A floor), and `mobile-safari` (iPhone 13, WebKit) for CI/full-install environments — this sandbox only ships a Chromium binary (see environment notes), so the four Chromium-based projects pin `launchOptions.executablePath` to it rather than the version-mismatched revision `@playwright/test` would otherwise try to download. Specs cover: no-horizontal-overflow smoke checks across Arena/Characters/Compendium at every project's viewport, the Characters/Compendium folder drawers and the character-to-folder move dialog, Character Sheet tab-switching, the Arena's roster drawer and single-row Tic Counter, and `DialogShell`'s shared backdrop-click/Escape/44px-close-button behavior. Run via `npm run test:mobile`.

## Game mechanic — The Weapon (decided, new)
**Status: fully built.** A character carries **one weapon, or none — and none is the default.** Nothing about a fighter changes when they pick something up except that a new die becomes available to them and a few Moves open up; there is no inventory of weapons, no equip slot ceremony, and no weapon on anybody's sheet until somebody puts one there.

A weapon has four fields and no more: **Name**, **Dice** (one of the game's own d4-d12), **Modifier** (a flat number, added to the die) and **Durability** (a positive integer). `weapons` is one row per character, `UNIQUE(character_id)`, `ON DELETE CASCADE`.

- **It rolls like any other Stat.** Die plus modifier, and then every other modifier on the roll lands on top exactly as it does for a Stat — the Stance matchup, Reasons to Fight, a Perk's per-move bonus, the ad-hoc number typed into the dialog. `weaponDie(weapon)` (`server/weapons.js`) hands it to the roll paths shaped like the die rows they already speak (`slot_name` / `current_size` / `bonus` / `status`), so nothing downstream needs a special case. A weapon has no incapacitation and no half-damage: it is not a body part, it is a thing, and things break rather than degrade.
- **The seventh Roll slot.** `'Weapon'` joins `ROLL_SLOT_NAMES`, so a Move can name it in its Roll exactly like Skull or Body. `resolveMoveRollDice` looks it up separately (it is not in `dice`) and drops it in.
  - **A Move that rolls the Weapon cannot be declared with empty hands (decided).** `move:declare` refuses it outright — an unarmed fighter would otherwise simply roll one die fewer, which is a move quietly worth less than it says it is. The Arena picker greys such a card with "No weapon in hand — this move rolls one, so there is nothing to swing", exactly as it greys a Movement move on a broken leg, and the Moves tab dims it the way a **Secondary** move is dimmed. Reaching the server gate therefore means a stale view or a hand-sent event.
- **Durability is spent by USING it, not by rolling it (decided).** Rolling the weapon on its own — the sheet's die widget, a GM roll request, a contest — costs nothing. **Using it in a Move costs 1**, and at 0 the weapon is destroyed.
  - **Once per declaration, not once per roll.** Several paths can roll the same declaration's Roll — a Block is rolled once per attacked Stat, a grapple follow-up re-rolls the move it chained into — and a guard swung at two limbs must not cost twice what the same guard swung at one costs. `declared_moves.weapon_spent` is the flag that makes it once, and it survives a pause, which matters because a Block's second line is often rolled on the far side of one.
  - Every spend says so in chat ("*X*'s Machete is down to 2 Durability", or "…gives out and is destroyed") and emits a **`weapon_durability`** round_event, self-contained per §0 so a replay watched later still names the weapon that is by then gone.
- **The Weapon as an Attack Target (decided).** `'Weapon'` is also in `CONCRETE_ATTACK_TARGET_NAMES`, so a Move can go for what the target is holding. It is **not a Stat**, and the rules that follow from that are the whole mechanic:
  - It takes no part in choosing *who* gets hit. No character has a die called Weapon, so selecting on it would find nobody and bail before the roll-off it exists for ever happened — `resolveAttack` splits the Weapon out of the target list before `selectUnevenCombatTarget` sees it.
  - **One roll-off, no defence.** The attacker's own already-made total against the weapon's own die. Beat it and the weapon is **destroyed**; **a tie holds** — destroying a thing outright is the bigger consequence and should be earned outright, the same way every other ambiguity in this game falls to the defensive side. No guard stands between the blow and the weapon: the weapon's own die *is* its defence.
  - **When it holds, nothing lands.** For a move that named nothing else, that is the whole outcome — no damage, no fall-through to a Stat.
  - **Against an unarmed target it becomes a random Hand.** The swing was aimed at what they were holding, so it arrives at the hand that should have been holding it. That substituted Stat is an ordinary target from there on — blockable, dodgeable, damaged like any other — and the swap is announced rather than silently swallowed.
  - Both outcomes emit a **`weapon_target`** round_event and a chat line naming both numbers.
- **Written to be granted programmatically (decided).** `grantWeapon(io, characterId, {...})` in `server/weapons.js` is the *whole* creation path: the `weapon:create` socket handler calls it, and a Perk that arms its holder under some condition will call the same function with the same shape. There is deliberately no second way in. It replaces whatever the character was carrying (one weapon, so arming them with a second is swapping, not stacking) and **refuses rather than clamps** a request that doesn't describe a weapon — a d7 or a Durability of 0 is a mistake at the point it was typed, and a silently-corrected weapon is worse than a rejected one.
- **On the sheet:** the slot sits at the **bottom right of the Vitruvian figure**, off the body — it is the one thing there that is not a Stat, and putting it on a hand would claim it belonged to the anatomy. Empty it is a dashed outline with a sword in it; click to create. Armed it shows `d10+3` with a Durability pip on its corner (red at 1) and the weapon's name beneath, click to roll, with ✎ to edit and ✕ to put it down. Durability dropping fires the same short violent shake a die's step does. On mobile it becomes its own row under the legs, the same grouped-rows treatment the Stats get.
  - Two rendering rules were learned the hard way here and are worth keeping: the widget's dialogs are **portalled to `<body>`**, because a transformed ancestor (the `-translate-x-1/2` that places the slot) becomes the containing block for `position: fixed` descendants and the modal laid itself out inside a 64px box; and the Durability pip is a **sibling** of the button rather than a child, because `panel-cut-lg` is a clip-path and a clip-path clips its own descendants.
- Verified end-to-end by `scripts/playtest-weapons.mjs` against a live server on a fresh DB: the empty default, the declare refusal, the spend of exactly 1 per Move, the free bare roll, a weapon holding (and nothing landing), a weapon breaking, the unarmed fallback landing on one Hand, and putting it down.

## Game mechanic — Chat Log
A single shared feed for the whole game (what was "roll log" earlier — renamed since it now shows more than dice rolls):
- Every die/pool roll posts here, as already described. Each entry shows the roller's small avatar (their portrait, or an initial-letter placeholder) to the left of their name; the roll modifier is **not** shown as a separate tag near the name — it's folded into each die's own formula instead (a die's permanent bonus + the roll's ad-hoc modifier combined into one signed value, e.g. `Body (d8+3): 11`). **Roll breakdown (decided):** each die's line shows the physical die face itself plus its flat additions, then the final result — e.g. `Body d8: 6 + 3 = ` followed by the result in a visibly **bolder, larger font** so the number that actually matters strikes the eye at a glance, instead of the whole line reading as one same-weight value; a multi-die roll's `Total` line underneath gets the same bold/large treatment. Nothing new is stored or sent for this — the physical die face isn't a separate field, it's recovered client-side as `result - bonus - modifier` (exact, since `result` was always computed as `rollDie(size) + bonus + modifier` server-side — see `die:roll`/`pool:roll` below), so this is a `ChatPanel.jsx`-only change.
- **The Dice Tray (decided, new):** a row of five very small d4-d12 icon buttons plus a shared +/- modifier stepper, sitting directly above the compose box as part of the same bottom static container (`Composer` in `ChatPanel.jsx`) — for a quick ad-hoc roll that isn't tied to any character's own die (a flat check, environmental roll, or a `dice:roll_custom`-backed weapon roll — see the Custom Roll type under Moves & Tells below, which reuses this exact same event). Clicking a die size immediately rolls `1d{size} + the tray's current modifier`, attributed to whoever the compose box's own "post as" picker currently has selected (a Player's own character, or the GM persona/any character for a GM) — the modifier stays put between rolls so repeated rolls at the same bonus don't need re-entering. Since there are no ready-made d4/d8/d10/d12 icons anywhere in this app's dependencies (lucide-react only ships pip-based d6 faces), the five icons are simple inline SVG polygon-plus-numeral shapes (`DiceIcon.jsx`) rather than fetched from anywhere external — triangle/square/diamond/kite/pentagon for d4/d6/d8/d10/d12, styled with `currentColor` so they inherit the button's own text color.
- **A cumulative per-lane Tic Counter snapshot posts to chat every time any move reveals (decided, redesign — replaces the old single-move-reveal card):** see the new bullet under Pages / views' Chat Log page description below, and `chat:lane_snapshot` under Real-time events, for the full shape. Rolling a move (if it has one) is still completely separate — the same Roll button/dialog as anywhere else, landing as its own ordinary `roll:result` entry, never merged into a snapshot card.
- **Free-text messages (decided, poster-picker revised):** anyone can also post a plain chat message via a compose box at the bottom of the panel — a character picker plus a text field. **The picker now defaults instead of requiring a pick:** a Player always posts as their own logged-in character by default (fixed, shown as a non-interactive label — not a `<select>`, since a Player has only one identity to post as); the GM defaults to posting as a generic **GM** persona (`<select>` with `GM` pre-selected as the first option) but can still pick any character from the dropdown to post as them instead. Server-side, a `chat:message` with `characterId: null` means "post as GM" and is stored using a sentinel character id (`GM_CHAT_SENTINEL_ID = 0` — safe because `characters.id` is an autoincrement rowid starting at 1, so it can never collide with a real character) rather than relaxing `chat_log.character_id`'s existing NOT NULL/FK shape; both the broadcast and `GET /api/chat` map that sentinel back to `{ characterId: null, characterName: 'GM' }` for rendering. A message needs text or an image (or both) — an empty send is a no-op; text is capped at 2000 characters server-side. Rendered with the same avatar+name+timestamp header as a roll, just showing the text/image instead of dice.
- **Images/GIFs (decided, GIF fix added):** attached either by **pasting** an image directly into the compose box's text field, or via a **paperclip file-picker button** next to it (both funnel through the same `fileToChatImage` client-side pipeline) — capped at 480px wide for static images (PNG re-encoded losslessly, everything else as JPEG ~85%) — except GIFs, which are sent as their raw uploaded bytes with no canvas re-encoding (capped at 4MB client-side) specifically so the animation survives; canvas re-export only ever keeps one frame. Socket.io's `maxHttpBufferSize` is raised to 8MB server-side to fit a base64-encoded GIF at that cap. **Why the file-picker was added:** pasting a GIF from the OS clipboard reliably flattens it to a single static frame before the browser's `paste` event ever fires — a real platform limitation of clipboard image data, not a bug in `fileToChatImage` (which already special-cased `image/gif` correctly). A genuine `<input type="file">` selection preserves the original file's true MIME type and raw bytes, so an uploaded GIF now actually animates in chat; pasting a GIF is still supported but inherits the same OS-level flattening it always has.
- **Lane snapshot cards (decided, redesign — replaces the old single-move-reveal card):** instead of one small card per revealed move, every reveal now posts a **cumulative Tic Counter snapshot for that move's whole lane (`pair_index`)** — a mini strip of `round_length` Tic squares, each colored by whichever phase(s) (Startup/Active/Recovery/Defense, same 4-color scheme as `FrameBar`/the live Tic Counter) any currently-*publicly*-revealed move in the lane occupies at that Tic, with a small labeled bar underneath/above positioned and width-sized to its own footprint span (clipped to the round's own window, same as the live counter never showing another round's squares) — **PC move bars above the strip, NPC move bars below it**, one row per move so more than one on a side (Uneven Combat, or the same character revealing twice) stacks cleanly. Posted **fresh, not edited in place, on every single reveal in that lane** — so if two moves in the same lane reveal one after another (even the same Tic), the chat log ends up with two snapshots: the first showing just the earlier move, the second showing both — a running, permanent history of exactly how that lane's Tic Counter filled in over the round, with the final snapshot showing every move that ultimately revealed in its true position. Only ever built from moves that are already genuinely public (`declared_moves.reveal_posted = 1`) — a chat card is broadcast identically to everyone, unlike `combat:updated`'s per-viewer secrecy, so it can never include a still-secret move regardless of who "declared" it. Clicking a move's bar still expands to the full `MoveCard` behind the same Genius Observer honor-system confirm as before ("Does your character have the Genius Observer Perk?" — see Open Items); no extra fetch needed for that — `full` (the move's complete raw row plus `interactions`/`tag_ids`/`roll_slots`, same shape `getMove` produces) is embedded per move directly in the snapshot's own payload at post time, so a historical card stays self-contained even if the move is later edited or deleted. A move-reveal card from before this redesign (`kind='move_reveal'`) still renders exactly as it always did — old chat history isn't rewritten, only new reveals use the new shape.
- **The move-reveal card is back, and its detail is now genuinely gated (decided, restored + security fix).** Two generations of card — the per-move `move_reveal` card, then the per-lane `lane_snapshot` — were both retired by the Cutscene Resolution overhaul in favour of a single once-per-round **"Watch Round N"** button, and the new engine was never wired to post any card at all. The result, reported from the table: *"move cards are not displayed in the chat"*, and with nothing to open, **Genius Observer had nothing to read** — the Perk was obsolete by accident. The card returns as `kind='move_reveal'` (the original shape, which was already exactly right for this), posted by `postMoveReveal` in the reveal loop of `advancePairResolution`. The round_summary button **stays**: the two answer different questions — *what just came out* versus *watch the whole round back*.
  - **The public half is the name, the picture and the frame data** — rendered as the `FrameBar` plus the same figure said plainly as `2 / 1 / 3`, because frame data is read aloud at a table and a row of coloured squares alone makes you count. Stamina Cost rides along too, since `mapDeclaredMovesForViewer` already sends it to everyone the moment a move is `publiclyRevealed`, and withholding it here would be theatre.
  - **Everything else is what the Perk buys**, description included. Reading what a move actually *does* is the whole point of Genius Observer, so the description is not on the public card at all — there is deliberately **no partial fallback**: a viewer who cannot open the card sees the header and nothing more, marked **Locked** rather than left to discover by clicking that nothing happens.
  - **`full` no longer rides `GET /api/chat` (decided, revised — this was a real hole).** The previous implementation attached every revealed move's complete row — Roll, Tags, Stamina Cost, On Hit effects — to every client, and the Genius Observer gate was *only the expand button being disabled*. That is the same honour-system weakness the server-side capability check was built to replace, wearing a different coat: anybody with devtools could read the payload. It is now served on request, per socket, by **`move:request_detail`** → **`move:detail`**, which checks two things: (1) does this socket's identity pass `capabilitiesFor`, and (2) **has this move actually been revealed** — a `move_reveal` row must exist for it, or an entitled Player could ask for any move id in the world and read the GM's unrevealed library. It answers even when it refuses, with a `reason`, so a waiting client never hangs. Side benefit: a long chat log stops re-fetching every revealed move in full on every page load.
  - **Posting is idempotent and unfiltered.** `declared_moves.reveal_posted` already made the reveal loop fire once per declaration, so stepping the same Tic twice cannot re-post. The broadcast goes to *everyone*, unlike the `round_events` beside it: those are scoped to the pair's audience because a live cutscene belongs to the fight you are in, while a revealed move is simply public — this posts at exactly the Tic `publiclyRevealed` flips true, so it discloses nothing that is not already on every viewer's board.
  - **Two bugs found while wiring it up**, both latent and both only reachable once cards existed again: `ChatPanel`'s expanded card read a bare `moves` from inside `Entry`, a different scope — the first person to open a card would have hit a `ReferenceError` (it is on `moveInfo` now); and the `chat:round_summary` listener was never unsubscribed on unmount while the other four were.
- **A description keeps the line breaks it was typed with (decided, new).** Move and Perk descriptions are authored in `<textarea>`s, so pressing Enter has always *stored* a newline — and `.trim()` only ever touched the ends — but every display site rendered it in a plain `<p>`, which collapses whitespace, so the break silently disappeared between typing it and reading it. `whitespace-pre-wrap break-words` on `MoveCard`, `PerkCard` and the Character Creation wizard's Perk list fixes it wherever a description is read at length. The one deliberate exception is the search dropdown, whose result rows are single-line by design.

- **A page load fetches the last 300 entries, not the whole log (decided, new — see Database
  round-trips above).** `GET /api/chat` was unbounded, and `chat_log.image_data` is where pasted
  images live as base64, so a session with a dozen shared pictures dragged megabytes across on every
  reload and every reconnect. Live entries still arrive over the socket regardless of the limit; what
  is lost is scrollback older than 300 entries after a reload, which nothing in the UI pages back to
  anyway. Deliberately generous — a fight produces far fewer than 300 — and the log is cleared
  between fights in any case, which is the next bullet.
- Nothing chat-related is kept for long: clears automatically on server restart (an actual `DELETE FROM chat_log` at boot, not just an incidental side effect of Render's free tier spinning the server down between quiet periods) and via a manual **Clear Chat** button, GM-only (decided — matches every other admin-style control in the app; the server itself doesn't enforce this, same as everywhere else in this no-auth app).

## Game mechanic — Character Creation (decided, new)

A **Character Creation** button at the top of every character sheet opens a guided six-step build — preset → Stats → stance → Moves → Perks → Role-play — and applies the whole thing at the end. Everything it does can still be done by hand on the tabs; the flow is a path through them, not a replacement for them.

- **Every step has a Skip, and Finish is live from the first screen.** Skip *clears* that step's contribution as well as moving on — otherwise it is Next with a different label — and Back is always there. Nothing forces a player to fill in a step they would rather come back to.
- **The presets, and what they are:** Teenager (8 Stat points, **2** Perks, **4** Moves), Adult (16 / **3** / **8**), Old Master (24 / **5** / **16**). Even the preset itself is skippable: no preset means no caps at all, a free-form build with nothing to exceed.
- **The two counts are CAPS; Stat points are guidance (decided, revised on the table's call).** The flow used to treat every preset number as a suggestion — warned about and then allowed — on the reasoning that guiding a build is not policing one. The table has since asked for the Perk and Move counts to be limits, and reducing a budget nobody enforces would have changed nothing. So:
  - **Perk count and Move count** are errors when exceeded. In the wizard the cap *disables what is not already picked* — never what is: greying out a ticked box would trap a build that was at, over, or holding something newly illegal, with no way to put any of it down. A picked row always stays clickable; the only thing a cap stops is picking one more.
  - **Stat points** still only warn — shown in the wizard in amber and posted to the Chat Log when the build lands, so the table finds out rather than having to notice. A spread is a shape, and the table has never asked for a shape to be refused.
  - Duplicates collapse **before** the count, so a double-click cannot block a build.
- **What else can still block** is a stance that is half-built or names the same Style twice, which is not a stance. Every blocking case sits next to a Skip or an obvious undo, so nobody is ever trapped by one.
- **The wizard cannot be dismissed by clicking away (decided, new).** A whole build lives in the dialog's local state and nothing is written until Finish, so a stray click on the backdrop threw away every choice made so far, with no warning and no undo. Escape goes with it — both are accidents, and this is the one dialog in the app where an accident costs real work. The ✕ stays and is deliberate. `DialogShell` grew a `closeButton` prop separate from `dismissible` for exactly this: the five pause prompts want neither an accident nor a way out, and Creation wants no accident and a very obvious way out. `closeButton` defaults to `dismissible`, so those five are untouched.
- **A point is a step, and a Stat costs exactly its rank.** Every Stat starts at d4; one point moves one Stat one step (d4→d6→d8→d10→d12, then +1 each). That is the same rank unit the rest of the game already counts in — `rankOf`/`dieAtRank` in `gameLogic.js`, the unit an Injury's penalty is expressed in — so a Stat's cost *is* its rank and there is no second price list to keep in step with the ladder. `dieAtRank` was extracted out of `applyRankPenalty` rather than written twice for exactly that reason.
- **The rules are pure and SHARED — `server/characterCreation.js`.** The wizard imports it directly (the same client→pure-server-module import `CombatArena.jsx` already uses for `moveLogic.js`), so the number a player is shown and the number the server would use are the same number by construction. `validateCreation` returns `{ ok, errors, warnings, normalized }`; the server refuses on `errors` only.
- **One event, not a replay of two dozen — `character:apply_creation`.** Spending the build a step at a time over the existing `die:step`/`stance:create`/`move:grant` events would put the only validation in the dialog, and a dialog cannot validate anything. Applied in the flow's own order, and **idempotent where it can be**: Stats are SET from their bought rank rather than stepped, so re-running the flow re-states a spread instead of stacking on one; grants are per-row unique, so re-granting is a no-op. **No schema change** — everything it writes already had a home.
- **Locking is the last step and is not optional.** It writes `locked_size`/`locked_bonus`/`locked_status` and recomputes Max Stamina from the Stamina die. A character who finished creation without it would have no baseline to revert to and a Max Stamina left over from whatever they were before.
- **Learnability is FORBIDDEN, not merely flagged (decided, revised).** `move:grant` refuses a styled Move to a character with no stance carrying that Style, and creation is not a way around it. The stance step runs *before* the Moves step precisely so a Move picked in the same sitting can be checked against the stance bought a moment earlier.
  - The first version only greyed such a row and let you tick it anyway; the server then accepted the whole build and silently skipped that one Move, which from the player's side looked exactly like it had worked. Now the checkbox is disabled and the draft is **refused**, naming the Move, so the wizard says what is wrong while there is still something to change.
  - **The check counts the character's EXISTING stances as well as the one being built.** Creation adds a stance, it never takes the old ones away, so somebody who already had Speed can still learn a Speed Move whatever this draft picks. Getting that union wrong stopped being cosmetic the moment it forbade rather than greyed: the server computes the same union (`ownedStyleIds` = existing stances + the draft's) and passes it to the shared validator, so what the wizard refuses and what the grant loop would have dropped are the same set by construction.
  - `validateCreation` takes `moveStyles`/`ownedStyleIds` as an optional pair: a caller that cannot say which Styles the character will end up with gets no Style check rather than a guess.
- **Who can run it:** the GM on any sheet, and a Player on their own character. Building your own fighter is the whole point of a guided flow, and this is the same trust model every other control in this app uses.
- **Verified against the running app** (`scripts/playtest-character-creation.mjs`) plus a full browser pass: a complete Adult build applied end to end (Stats set, stance taken, Moves and Perks granted, answers saved, Stats locked, Max Stamina recomputed); an over-*spread* build allowed and warned about in chat; the emptiest possible build — every step skipped — still applying and still locking; an unknown Perk id dropped rather than counted; a same-Style stance refused; an off-Style Move refusing the whole draft **and nothing being half-written**, then the same build going through once it is dropped; a third Perk on a Teenager refused rather than warned; and a re-run re-stating the spread rather than doubling it. In the browser: a backdrop click and Escape both leave the wizard open, the cap disables every unpicked row while the picked ones stay clickable, and a styled Move with no matching stance cannot be ticked at all.

## Game mechanic — Perks & Tags (Perks tab)
- Perks are created by the GM in their own **Perks Compendium**, separate from the Moves Compendium, and granted the same way — drag-and-drop onto a character in the page's character rail (a per-Perk Grant checklist covers touch devices, same pattern as Moves).
- A Perk is just three things (decided): **picture** (small uploaded image, optional — same upload pattern as Moves/Tells, placeholder letter until set), **name**, and **description**. Granting/revoking a Perk is pure membership (`character_perks`) — no automatic mechanical effect.
- **Mechanical effects are code, one file per Perk, bound by the Perk's exact NAME (decided, revised — the third arrangement and the one to keep).** Read `server/perks/index.js` first; it carries the doctrine beside the registry, which is where it stays current.
  - **This is the second attempt, and the first is why it looks like this.** The original Phase 4 design was a generic, GM-authored effect system — five stored automation types (`die_step`/`stamina_multiplier`/`move_tag`/`move_frame_override`/`move_roll_bonus`) picked from a form and applied on grant — and it was removed entirely, tables and all. A form can only ever express the *intersection* of every Perk anybody will ever want, and Perks are the one part of this game with no intersection. **Do not put an effect editor back in the Perk Creator.**
  - **What replaced it first was not enough either, and the diagnosis is the useful part.** `PERK_HOOKS` (`onGrant`/`onRevoke` keyed by name) sat empty for the entire life of the project, and not because its escape hatch was too narrow: it had exactly two hooks and **both fired at grant time**, so a Perk could only ever be a permanent state change made once. Nearly every interesting Perk is the opposite — conditional, situational and mid-round ("while you are below half Stamina", "the first time each round you take damage", "you may read a revealed move in full"). There was nowhere in the engine for one to speak.
  - **So Perks do not get an effect language — they get to participate in decisions the engine already makes.** Every seam is a point the engine was already choosing something *and already narrating the choice*: a roll's modifier (`getCombatRollBonusBreakdown`), a trigger firing (`applyMoveInteractions`), whether a viewer may see something (`isRevealedToViewer`'s neighbourhood). A Perk pushes on one of those. It cannot invent a new thing for the engine to do — that is an engine change, made deliberately, not a Perk.
  - **Three tiers, and a definition declares only what it needs.** **Tier 1** is declarative and reuses the move-interaction vocabulary verbatim — `ALL_TRIGGERS` for the keys, `AUTOMATION_TYPES` for the effects, and the same executor, so the Chat Log line, the `automation_fired` event and the cutscene narration all come free (`runAutomations`, split out of `applyMoveInteractions` for exactly this; giving Perks their own copy of that switch would have meant two implementations of every effect drifting apart one bugfix at a time). **Tier 2** is a narrow function on a named seam, whose signature belongs to the seam rather than to the Perk. **Tier 3** is the imperative escape hatch — `onGrant`/`onRevoke` for permanent state, for the genuinely non-standard.
  - **Every seam is additive, or boolean-OR — no priority field, no ordering, ever.** That is precisely what lets a character carry ten Perks without anybody reasoning about ten, and it is why `idleStaminaRegen` (the one seam that is a *rate* rather than a contribution, where a higher number is a stricter Perk) takes the strictest value instead of summing: it still cannot depend on grant order, which the previous "first granted Perk with an entry wins" version quietly did. A Perk that genuinely needs to *replace* a rule rather than add to it does not get a seam; it goes in Tier 3 and says so in its own file. **This will eventually be tested by a Perk that wants to override something. The answer is Tier 3, not a priority field on the seams** — recorded here so it is not re-litigated under deadline.
  - **A Perk that changes a number says so out loud.** Numeric contributions ride the roll's own `modifierBreakdown` as **one named term per Perk** under that Perk's name (never one lump), and triggered ones emit the same `automation_fired` event a move's do, now carrying `sourceName`/`sourceKind` so a Perk is named rather than masquerading as a move (`moveName` stays null for a Perk and is kept for moves, since stored replays already have it — §0). A Perk that silently moves a total is the same defect as the unexplained "+5 Modifier" the breakdown was built to kill.
  - **The seam register.** Built: `rollBonus` (`combatBonuses.js`), `triggers` (`roundResolution.js`), `canSeeRevealedDetail`, `idleStaminaRegen`, `onGrant`/`onRevoke`, and — added for the first official playtest's Perk list — `minDamageThresholdWhenAttacking` / `minDamageThresholdWhenAttacked` (`resolveAttack`), `blockRiposteSteps` (the Block branch of `resolveAttack`), `staminaCostDelta` (the four Stamina call sites in `index.js`), `roundStartHalfHealing` (`openRoundForCharacters`), `staminaPerHalfDamage` (`runInterruptAndDamage`), and — added for the third batch — `splashDamage` (`runInterruptAndDamage`, right after the blow lands), `ignoresMovementPunisher` (the Movement Punisher branch), **`interruptAmounts`** (`checkInterrupt`), which was designed here long before anything needed it and was taken up unchanged by Dogfighter — which is exactly what the register is for: that Perk cost one file and one line, not an argument about the engine. and — added for **Osu!** — **`moveFrameDelta`** (`(ctx) → {startup?, active?, recovery?}`, folded into `getMovesFor`'s existing per-character override deltas). That last one is worth a note on *why it is a seam*: `character_move_overrides` already stores per-character frame deltas with a `source_character_perk_id`, so a Perk could have written rows there on grant — but that table is a **snapshot**, and a move learned after the grant would silently miss out. A seam is asked every time the move list is built, so it cannot go stale. Folding it into the deltas `getMovesFor` already applies is what makes a Perk-granted frame indistinguishable downstream from a GM-granted one: same declare picker, same placement floor, same resolved footprint, same Tic strip. and — added for this batch — **`weaponOffer`** (`getMovesFor`'s sibling on the character sheet: what a Perk is willing to put in an EMPTY Weapon slot, taken through the same `grantWeapon` every weapon comes through, and the only seam so far that is a player-facing *action* rather than a number — still shaped as participation in a decision the engine already makes) and **`interruptsOwnDeclarations`** (a boolean, OR-ed: whether this fighter gets the take-it-back window at the head of resolution). and — added for the Path To Mastery batch — **`blockPenaltyAgainstYou`** (`(ctx) → number`, summed, folded into the DEFENDER's modifier in `runBlockLine`: the first seam asked of somebody other than the roller, and the reason it is asked of the attacker is that only that function knows both halves of the exchange), **`absorbsBreak`** (`(ctx) → {charges, scope}`, first-answer-wins, spent by `perkAbsorbBreak` inside the damage loop rather than by the Perk, and asked only where a break would genuinely occur so a charge is never burned on a blow that was not going to break anything), and **`seesAttackHeight`** (a boolean, OR-ed, resolved once per broadcast in `buildCombatUpdate` and consumed by `mapDeclaredMovesForViewer` — the second disclosure seam after `canSeeRevealedDetail`, and like it, answered server-side so an advantage is never on the honour system). Designed but deliberately **not** built until something needs them, with their shapes agreed so adding one is a bounded change rather than a re-opened architecture question: `damageTakenDelta` (`(ctx) → steps`, in `runInterruptAndDamage`), `moveTagOverrides` (`(ctx) → {add, remove}`, in `moveTagNamesFor`/`getMovesFor`). Adding a Perk that uses an existing seam is **one new file plus one registry line**; adding a seam is an engine change. Five of the seam resolvers are now one shared `sumSeam` fold in `perkEngine.js` rather than five near-identical loops — five copies is how one of them quietly stops truncating. **The seam context is lazy where it is expensive (new).** Perks that ask about a move — *what am I throwing?*, *what did I throw right before it?* — get `getMove()` / `getPreviousMove()` thunks rather than eager fields, memoised per resolution. `perkRollBonusTerms` runs on every roll in the game and those facts cost two or three queries to build, so a Perk that never asks pays nothing and three that ask on the same roll pay once. Both hand back the same small **facts shape** (`moveFacts`: id, name, rollSlots, activeTics, isDefensive, attackTargets, defenseKind, defenseOutcome), normalised because a `getMovesFor` row and a bare `SELECT * FROM moves` disagree about `attack_targets` — one an array, one a JSON string — and a Perk reading the wrong one would silently answer "no Attack Target" for every move in the game.
  - **Five Perks automated for the first official playtest (decided, new), plus one marked deliberately manual.** The three that shipped with the architecture included two acknowledged placeholders; these are the real list.
    - **Iron Skin** (+2) and **Not Just a Scratch** (−2) push on the **Minimum Damage Threshold** — the smallest roll that deals anything — from opposite sides. **Only the first gate moves**: `computeHitDamage` became `result < threshold ? 0 : max(1, floor(result / 5))`, so the ladder reads 7-10-15-20 or 3-10-15-20 and every later gate stays a multiple of 5. Two knock-on effects fall out rather than needing rules of their own: **Insignificant Damage** is just `steps === 0`, and the **Full/Partial** line on a defence is just "did the leftover deal damage", so against Iron Skin a leftover of 5-6 is now a Full Block. The figure is resolved **once per exchange** (`minDamageThresholdFor`, after target selection, since it depends on both fighters) and threaded into every branch; the two seams being separate is what makes an attacker and a defender carrying one each simply cancel back to the plain 5. Floored at 1 so no pile of Perks can make a roll of 0 hurt.
    - **Spiked Shell** — a Full Block sends damage back at the attacker: one Half-Damage step per full 5 points the guard beat the attack roll by, landing on **the limb that swung**. `selectRiposteTargets` (pure) groups the attacker's already-resolved Roll dice by kind: all of one kind → all of them (so "2 Hands" hits both), a mix → one at random, and no limb in the Roll at all → the same rule over whatever Stats it did name. A **Custom Roll names no Stat and is immune.** Fires **per line** (the guard is already rolled once per Stat the attack names) and only on a line that resolved `full` — a guard scaled back by running out of Stamina comes out Partial and pays nothing. It runs through `runAutomations` with ordinary `opponent_stat_step` effects under a `block_riposte` / "Countered" trigger, exactly as Movement Punisher does, so the Chat Log line, the `automation_fired` event and the cutscene beat all come free.
    - **Perfect Player** — while no Stat has dropped a rank, a Dodge costs 2 less Stamina. **A pending Half-Damage marker does not break it (decided)**; only an actually-dropped rank does, measured against the **Injury-adjusted** baseline (`injuryPenaltyBySlot`, extracted from `character:revert_stats` rather than written twice) so "your current Locked Value" means what Revert Stats would give you. This is the first Perk to touch what a move *costs*, which forced the real work: Stamina Cost was read in **four** places — the picker's quote, `getPendingStaminaCost`, `move:declare`'s affordability check and `combat:character_done_declaring`'s commit — two of them raw SQL `SUM`s. All four go through one `resolveStaminaCosts` now, over one pure `effectiveStaminaCost(base, delta)` **floored at 0** (a Perk can make a move free; it can never pay you to throw one). `getMovesFor` gained `effective_stamina_cost`, always present and equal to `stamina_cost` when nothing moved it, so the client renders one field unconditionally.
    - **Healing Factor** — one pending Half-Damage marker sheds at Round Start, chosen at random among the Stats actually showing one. **It clears a pending marker and never steps a die back up (decided):** a fighter whose damage has all resolved into whole steps heals nothing, because recovering whole steps is what the Recover Stat effect is for. The seam answers only *how many*; the engine owns the pick, the randomness and the Chat Log line.
    - **Multifaceted** is registered with `manual: true` and no seams. `stance:create` has never counted stances, so the second-Stance rule is one the table keeps and there is genuinely nothing to automate — building an enforcement path just so this Perk could switch it off would be building a cage to sell the key. The ⚙ badge stays (it means *accounted for*, and a GM scanning the list wants to see which Perks are settled); only `PerkCard`'s tooltip changes. `perkRegistry.test.js` asserts both directions — a non-manual Perk must declare mechanics, and a manual one must declare none — so the flag can never sit on a Perk that does something.
  - **A second playtest batch of four Perks, plus one more marked manual (decided, new).** Three of the four turn on **"right after"** — the same reading Requirements already use (`requirementSatisfiedBy`): *the move this fighter has queued immediately before*, ordered by **footprint end** rather than by reveal Tic, since a short move declared later can still finish before a long one declared earlier. `previousDeclaredMoveFacts` answers it for both moments — with no declaration of its own to skip (declare time, where a cost is being quoted) or skipping past a given one (roll time, where the move is already on the board).
    - **Punches in Bunches** — a Hand Attack thrown right after another Hand Attack costs 1 less Stamina. **A "Hand Attack" is a move whose ROLL uses a Hand (decided)**, not one whose Attack Target is a hand: "making a Hand Attack" is about what you hit *with*, and the Roll is the only place a move says that. Reading the Attack Target would have made a hook to the wrist count as a punch while a punch to the head did not. It stacks by its nature and has no cap — a third punch after a second is still a punch after a punch — because what limits it is the board: each has to fit after the last, and every punch strung together is Tics not spent guarding.
    - **The Simplest Tool** — the Jab costs 1 less Stamina and rolls +1. The first Perk on **two seams at once**, which works precisely because seams are folded independently: the discount is asked for at declare time and the bonus at roll time, and neither knows about the other. Bound to a move named **exactly** `Jab` — trimmed and case-insensitive like every other name binding here, but exact otherwise, so "Power Jab" gets nothing; a Perk matching a substring would attach itself to every move a GM ever wrote the word into. There is no Jab in the Compendium out of the box: the GM writes one and this finds it. `getMove()` answering **null** for a roll belonging to no move (a hand-thrown die, the round's Initiative) is what stops it paying out where there is no move at all.
    - **Deadly Pendulum** — an Attack declared right after a **Successful Dodge** rolls +2. **A bet placed during Declaration and collected during resolution:** a round is declared in full before any of it resolves, so when you queue the counter behind the Dodge you do not yet know the GM will call that Dodge Successful. Only a Dodge counts, never a Block — a Block that held is not a swing away from anything.
    - **Baron of Suffering** — 1 Stamina back per 0.5 damage **dealt**, so the Damage Gates pay 1 at a 5, 2 at a 10, and a multi-Stat attack pays for every Stat it wrecks. **Only damage that LANDS counts (decided):** it is paid out of `applied`, the engine's own record of what it wrote to a die, so a blow aimed at an already-broken Stat pays nothing — the same reading as the end-of-round report saying that damage could not be applied — and a Partial Block pays only for what got through. The seam is a *rate* rather than a flat number so the arithmetic stays in the engine, where the step count is.
      - **A stat step is damage dealt too (decided, new; implemented).** The Baron used to be paid only out of `applied` in `runInterruptAndDamage` — the damage an *attack* writes to a die — so a move whose whole point was "and it costs you a step of your own Body" fed him nothing at all, even though a step of damage is a step of damage wherever the author put it. Every `self_stat_step` / `opponent_stat_step` automation now pays as well. **Paid to whoever owns the effect, in both directions**, which is the whole rule in one line: the dealer is the automation's own character and the target is only where it landed. Stepping your OWN Stat is the case that was asked for; stepping the opponent's is the same sentence with the target changed, and paying one without the other would leave hurting yourself worth Stamina while hurting them was worth nothing. Healing pays nothing (an upward step is not damage), and neither does a step aimed at a Stat already at the floor — `stepStat` now returns `{ stepped, landedSteps }` and `landedSteps` uses exactly the reading `applyAutoDamage` uses when it sorts a blow into `applied` or `unapplied`.
    - **Wounded Wolf** is the second `manual: true` Perk: lose 1 Step in one Stat, gain 3 in another. A one-time act of character building, made at the table, moving Stats with the controls the sheet already has — there is no prompt to invent for a decision that happens once and is then simply true.
  - **`declared_moves.defense_outcome` (new)** — `'success'`/`'failed'` once a defence has been adjudicated, NULL for the overwhelming majority of moves that never were one. Stored on the row rather than in Deadly Pendulum's private state because *"did that guard hold?"* is a plain fact about the fight that the round log already says out loud; this only makes it queryable. **It records the GM's own answer, never a conclusion drawn from the damage** — a distinction the live playtest forced. `resolveDodge` routes on whether any damage got through, and an attack under the Minimum Damage Threshold gets through for zero, which correctly sends it down the no-damage path but does **not** mean the guard worked; taking the verdict from that figure wrote `'success'` onto a Dodge the GM had just rejected, and Deadly Pendulum paid out on it. The GM's per-Stat answers are now tallied across the re-pauses and written before either branch runs; `applyFailedDefense` writes only where nothing has been recorded yet, so it still covers the guards that never reached a GM (auto-Failed for landing too early or covering too little, and a Block the GM said applied nowhere).
  - **A bug this batch found and fixed: a queued move was priced against the wrong predecessor.** `getPendingStaminaCost` totals a whole Declaration's worth of already-queued moves, and a single shared "previous move" measured every one of them against whatever went down **last** — so a two-move combo was quoted one figure by the picker and charged another at commit. `perkStaminaCostDeltas` now resolves the predecessor **per entry**: callers put `declared_move_id` on rows that are already on the board, and rows without one (the picker's candidates, which have no place in the queue yet) share the last-queued lookup. Caught by the live playtest's *"the Stamina actually spent is the sum the picker quoted"* probe, which is exactly why that probe exists.
  - **A third batch of four Perks (decided, new).** Two of them share one new idea; the other two are each one line on a seam.
    - **Piercing Headache** (Skull → Brain) and **Last Breath Taker** (Body → Stamina) are **splash damage**: for every FULL point this attack put on the first Stat, half a point goes into the second. **Full Damage is two Half-Damage steps** — the game counts in halves and two halves make a whole — so the arithmetic is `floor(steps / 2)` and both Perks share one pure `splashSteps`, because two copies of that is how they drift.
      - **Priced off what LANDED, not off the roll** (decided). The seam is handed `appliedBySlot`, the engine's own record of what it wrote to a die. That settles two cases at once: a blow that found a broken Stat and went nowhere splashes nothing, and a **Successful Block's redirect does splash** — damage to the Skull is damage to the Skull, however it got there.
      - **Applied through `applyAutoDamage`**, not a private write, so the splash obeys every rule ordinary damage does. Above all the broken-Stat rule: a splash onto a Brain that is already gone is **reported** in the end-of-round "should have been dealt" line rather than swallowed (decided).
      - **Per attack, never accumulated.** "With a single Attack" is the rule, and asking the seam once per blow with that blow's own figures is what keeps it true without any state to remember.
      - **Baron of Suffering is paid for the splash too** (decided): damage dealt is damage dealt, wherever on the body it ended up. The Interruption check is deliberately *not* — one blow is already one check, and letting the splash swell the figure would make these two Perks quietly better at breaking moves up, which is not what they say.
    - **Grounded** — the Movement Punisher Tag never trips you. Asked of the fighter who would be **tripped** ("from your opponents" is what makes it a defence), and only once the trip would otherwise land, so a fighter who was never going to be caught is not told they shrugged something off. Announced rather than silent: a table watching a punisher connect is expecting the trip, and its absence needs a reason.
    - **Dogfighter** — every one of your Moves counts as **Hard to Interrupt (2)**. Its two sentences ("all your Moves gain (2)" / "a Move that had (x) has it increased by 2") come to the same arithmetic, because the Tag's value and the Perk's bonus are added into one figure at the contest — so it is written as a flat +2 and the two readings agree without needing a rule for their meeting. It touches only the defending half: a Dogfighter is no better at interrupting anyone else.
  - **A latent bug this batch found and fixed: a round opened through `combat:next_round` never refreshed once-per-round Perk charges.** `clearPerkState('round', …)` lived only in `startPairDeclaration`, and there are **two** round-start implementations — `combat:next_round` in `index.js` opens a fight's first round and re-seeds any pair not mid-Declaration; `startPairDeclaration` opens every round after a resolution. That duplication had already produced one bug (the two drifted over whether Initiative carried the Stance matchup). Both now call a shared exported **`openRoundForCharacters(io, characterIds, { random })`**, which does the round-scoped reset *and* the Healing Factor sweep, so there is no third chance.
  - **Perks may be stateful — `character_perk_state`** (see the Data model): a per-grant key/value store with an explicit `scope` of `round`/`fight`/`permanent`, which is what makes "once per round", charges and cooldowns possible at all. It is *data storage*, not an effect system, which is the distinction that keeps it clear of the removed registry. It cascades off `character_perks`, so revoking a Perk takes its state with it and `perk:revoke` needs no line for it.
    - **The round scope is per PAIR, and this is the trap.** A round belongs to a pair, not to the arena — each pair runs its own clock and reaches its own next round whenever it gets there — so `clearPerkState('round', …)` takes the characters it applies to and `startPairDeclaration` passes only that pair's. A global reset would hand a fighter their charge back because an unrelated fight across the room started a round, which is the same class of bug the per-pair split has already produced twice elsewhere. The global wipe exists for the fight scope (`clearAllPerkState`, called from `combat:end`/`combat:clear`, where a fight ending genuinely *is* global) and is deliberately a separately-named function so a round-scoped caller cannot reach it by leaving an argument off.
  - **Name binding is fragile by nature, and three things make it visible instead.** `seedPerks` in `db.js` creates every registry entry's compendium row at startup if the world lacks one (case-insensitive adopt-don't-duplicate, exactly like `seedBlockTag`), so "the GM never made the row" stops being a possible failure; `automated: true` rides every Perk payload and `PerkCard` renders it as a **⚙ Auto** badge, so a Perk that does something is distinguishable from one that is pure description; and `perk:update` **refuses to rename** a Perk with a registry entry, posting a system chat line saying why — description, picture and Perk Tags stay freely editable. A rename does not adjust the binding, it breaks it silently, and it is the only place a user can trigger that.
  - **The test that matters most is `server/test/perkRegistry.test.js`.** The likeliest way for a Perk to fail is not a wrong answer but a **typo**: a definition declaring `rollBonuses` or `onGranted` or a trigger called `on_hit` imports, registers, grants and then does nothing, quietly, until somebody happens to test that exact Perk by hand. Walking every definition against `SEAMS`/`LIFECYCLE_KEYS`/`ALL_TRIGGERS`/`AUTOMATION_TYPES` turns that whole class of failure into a red test. It also fails a Perk that is registered but declares no mechanics at all — that one would wear the ⚙ badge, which is a promise to the GM.
  - **The three shipped Perks**, one per tier: **Genius Observer** (Tier 2 — closes the oldest open item in the project, below), **Cornered Animal** (Tier 2, a conditional `rollBonus`: +2 while Stamina is at a quarter of max or below) and **Second Wind** (Tier 1 + state: once per round, a failed defence of yours returns 2 Stamina). The latter two are **samples chosen to exercise the tiers, not proposals about balance** — renaming or deleting either costs one file. `character_move_tags`/`character_move_overrides`/`character_move_roll_bonuses` still exist and are still what the Moves tab reads for a character's effective tags/frame data/roll bonus; a Tier 3 hook writes to them itself (tagging rows with `source_character_perk_id`), and `perk:revoke` still bulk-deletes them.
  - **A latent bug this surfaced:** a **negative** `self_stamina`/`opponent_stamina` — Stamina given back rather than taken — was unreachable from the Move Creator (`normalizeInteractions` takes the absolute value of anything outside `SIGNED_TYPES`) and so had never been rendered. Second Wind is the first thing to author one, and the effect label read `−-2 Stamina`. It follows its sign now.
- **Perk Tags (decided, new)**: optional categorisation on a Perk — 0 or more, picked from a world-level GM-managed list, with a name and an optional description shown as a tooltip. **Purely for organising the library: no mechanics now, and none by design.** Shown as quiet chips on every Perk card (Compendium and the character sheet's read-only Perks tab alike) and usable as a **multi-select OR filter** on the Perks Compendium — the same filter semantics the Moves tab's Style filter already uses, so the two behave alike. Filtering is open to every role, since a Player browses the same read-only library; creating/editing/deleting tags is GM-only.
  - **Their own vocabulary, not the Move tag list (decided).** `perk_tags` + `perk_tag_links`, deliberately separate from the `tags`/`move_tags` pair Moves use. Move tags stopped being cosmetic when the **Block Tag** started driving real Stamina automation (see the Block Tag under Combat Timing), so one shared list would put mechanically-loaded names in a Perk's picker where they mean nothing. Deleting a Perk tag detaches it from every Perk and needs no in-use guard — unlike a Move tag, it can never change how anything resolves.
- A Perk in use (granted to anyone) can't be deleted — matches the same "in use" pattern already used for Tells.
- The Perks tab on a character sheet displays granted Perks in a grid (infinite rows, 2 columns), each card showing picture/name/description (for the same transparency reason granted Moves show their full effect; there's no automation data left to display). *Taking* a Perk happens on the **Compendium's** Perks tab, exactly as learning a Move does — but **dropping one happens here** (decided, new): a Player gets a **Drop** on every Perk on their own sheet, which is where you actually notice you no longer want it. Nothing else on the tab is editable; a Perk's picture, name and description are the GM's.

## Game mechanic — Counters
Simple, persistent "clocks" — no automation, just a name, a target (2-20 pips), a current count, and +/- buttons.
- **Character-owned counters:** created by whoever controls that character (any player for a PC, GM for an NPC), shown on that character's own Counters tab — same open-access pattern as Inventory.
- **Standalone counters:** created directly in the Combat Arena, not tied to any character — GM-only, since arena control is already GM-only.
- **Show in Combat toggle:** a character-owned counter can be flagged to also appear in the Combat Arena, labeled `"{CharacterName} - {CounterName}"` (e.g. "Aaron - Rage"). It's the same underlying record wherever it's shown — adjusting it from the Arena or from the character sheet updates the other live.
- **Gates (decided, new)**: a marker the GM puts on **one pip** of a Counter — *when this fills to here, something happens*. A Gate carries a **name**, a **description** and a **Secret** switch, and no mechanics of its own: it is a reminder with a place on the clock.
  - **The pip is drawn twice the size, for everybody.** That a point of progress matters is never the secret; the secret is only what happens there. The table can always see one coming, which is most of what makes a Gate worth putting down.
  - **Secret decides who may read the WORDS.** Off, everyone reads the name and description by hovering the pip. On, a Player sees `???` for both — and sees it because the payload does not contain them. **Protect by absence**, the same rule the board's private data follows: a flag saying "hide this" is a request, and the network tab answers it either way. `visibleGate` in `server/counterGates.js` is the only place that decides.
  - **Authoring is GM-only, and that is the mechanic rather than a permission.** `secret` means nothing if the person it is kept from can author it. Counters themselves stay open to whoever controls the character, exactly as before.
  - **One Gate per pip**, as a `UNIQUE(counter_id, pip_index)` rather than a convention — a Gate is a property of a pip, and two on one pip would be two things to draw in one place and two lines to post at one moment. Saving is therefore an upsert: the editor opens on a pip and neither knows nor cares whether a row is already there.
  - **Reaching one posts to the Chat Log.** Upward only, and inclusive at the top (`from < pip <= to`): landing on a Gate reaches it, ticking back down past it is a correction rather than an event, and coming back up reaches it again because the second time is a second time the table needs reminding. One `+5` announces every Gate it passes, in order, computed against the *clamped* value so it never announces past the end. The line names an open Gate and **never** a secret one — chat is broadcast to the whole table, so it is the one place a secret could escape by accident.
  - **Gates ride their own per-viewer channel** (`counter_gates:updated` and `GET /api/counter-gates`), not the Counter payload. A Counter is public — `counter:updated` is an `io.emit` and every Arena shows every clock — so folding Gates in would have meant making five broadcasts and two REST payloads viewer-aware. A second channel that already knows who is asking is smaller and harder to get wrong; it is the shape the Relationships board uses.
  - `CounterPips` is now shared by the character sheet and the Arena, which each drew their own identical pip loop before. A Gate has a size, a hover card and a click, and three of those written twice is how the Arena quietly stops showing something the sheet does.
  - **`DialogShell` gained an opt-in `portal`.** The Gate editor is opened from a Counter row, deep inside the sheet's tab body: `fixed inset-0 z-50` put it in the right place and painted it *under* the page around it, so it was visible and every click on it landed on `<main>`. Found by measuring `elementFromPoint` on the dialog's own Cancel button. Off by default — the ten dialogs that predate it all render near the page root and work.
- **Reward tag (decided)**: a character-owned counter can optionally carry one **Reward** — purely a tracking label, no mechanical effect — set at creation or changed any time after via a small colored select that doubles as the tag itself, next to the counter's name. Five types, each with its own color: **Story** (amber), **Statistic** (blue), **Perk** (violet), **Move** (orange), **Combat Prowess** (red). **Standalone counters can never have one** (the create form has no reward option, and the server ignores/rejects `rewardType` for a `character_id`-null counter, both at creation and via `counter:set_reward`). If a character-owned counter with a reward is flagged Show in Combat, its reward tag still shows in the Arena's Counters section — read-only there; editing only happens from the character's own Counters tab.
- **The open drop-down used to be unreadable, and the cause was global (fixed).** Reported on this control: the reward select's *closed* state is a coloured pill, and the pale `color` it sets was inherited by its `<option>`s into a popup the browser painted **light** — because the document never declared `color-scheme`, so a dark app was asking for light widgets everywhere. One line on `:root` (`color-scheme: dark`) fixes all thirteen `<select>`s in the app at once and takes native scrollbars, checkboxes and date pickers with it; an explicit `option { background-color; color }` rule backs it up, because engines disagree about how much of a popup an author may style, and states it once rather than at each select — several of which deliberately colour the closed control and must not leak that colour into the open list.

## Global UI — Search
Every page's header carries a **Search bar**, available to all roles. Typing debounces (250ms) a query against `GET /api/search?q=...`, which matches **named library entities only** — Characters, Moves, Perks, Tells, Tags — by substring on name or description, case-insensitive; character sub-records (Inventory, Injuries, Stances, Counters) are deliberately not indexed. Results render in a dropdown grouped by type. The same role-based visibility rule used everywhere else applies **client-side**, same as the rest of this no-auth app: NPCs are filtered out of Character results for Players. Clicking a Character result navigates straight to its sheet; clicking a Move/Perk/Tell/Tag result opens the Compendium to the relevant internal tab (Perks vs. Moves/Tells/Tags). **Decided (revised):** every result row is clickable for every role now, not just the GM — since the Compendium page itself opened up to Players (read-only) in the same batch that added the Vitruvian upload/chat-defaults/Stance-graph-picker changes (see Implementation Phases below), the old "no page for a Player to open them into" reasoning that made non-GM rows inert no longer applies.

## Global UI — Visual Theme (Fighting Game pass)
**Decided, Phase 8:** the app's visual language moved to a red/black "fighting game" look (Tekken/Mortal Kombat reference — metallic, gritty, dramatic; not Street Fighter's bolder graffiti energy), rolled out **everywhere in one pass** rather than piloted on a single page first (unlike the earlier Vitruvian-Man/Rajdhani pilot below, which was deliberately scoped to just the character sheet).
- **Palette:** a `--color-brand-*` red scale (50-950, defined in `client/src/index.css`'s `@theme` block) replaces `indigo-*` as the app's one UI accent everywhere — buttons, active/selected states, focus rings, links, highlights. `zinc-700`/`800`/`900`/`950` (the dark surfaces/borders used throughout) are overridden with a faint warm-red undertone instead of Tailwind's neutral cool gray, so every existing dark panel reads as "arena lit by red light" without per-component edits; a `.bg-arena` class (radial red glow over near-black) is used on full-page shells (`App.jsx`'s `Shell`, `RoleModal.jsx`) for a stronger version of the same effect. A raw `--color-brand-rgb` triplet variable covers the handful of places (GSAP inline styles, arbitrary `box-shadow`/`filter` glows) that can't reach a Tailwind utility class, so literally every red in the app — utility classes and inline glows alike — traces back to the same CSS custom properties. **This was deliberate groundwork for a user-facing color-customization setting, now built (decided, revised):** the Settings page (see Pages / views below) regenerates the whole `--color-brand-*` scale from a single picked hue (`client/src/lib/theme.js` — a fixed saturation/lightness curve per shade, only the hue varies) and writes it onto `:root` as inline style overrides, which win over `index.css`'s own declarations; the choice persists to `localStorage` and is re-applied on every load via `initTheme()` in `main.jsx`, before React even renders. Domain-semantic colors are explicitly **not** part of this accent system and were left alone: the Stance chart's win/loss/internal edge colors and the Stamina pending-cost preview's red/green stay their existing meaning, since they encode game state, not UI chrome — swapping them to match "red is now the accent" would have made those two already-established color codes ambiguous.
- **Corners:** `.panel-cut-sm` / `.panel-cut` / `.panel-cut-lg` (`client/src/index.css`, `clip-path: polygon(...)` diagonal-cut corners, sized small/medium/large) replace `rounded-md`/`lg`/`xl`/`2xl` everywhere — buttons, inputs, cards, panels — for the HUD-menu-panel look. `rounded-full` (badges, pills, circular avatars/controls) is deliberately left alone. A couple of pre-existing bespoke single-diagonal-cut elements from the Vitruvian pilot (the Tab 1 portrait frame, the tab-bar active badge) were left as-is rather than double-clipped.
- **Font:** `font-display` (Rajdhani) now covers headers (`h1`-`h3`), buttons, real `<label>` elements, and anything styled `.uppercase` (badges, section labels, status tags) via a blanket rule in `@layer base` — plus the Chat Log explicitly (author names, timestamps, message text, the compose textarea, dice-roll lines), added by hand since chat isn't a heading/button/label. Move/perk **description** text (and other long-form free text) deliberately stays on the default readable font — the font rollout is scoped to short UI chrome and chat, not prose.
- **Scrollbars (decided):** every scrollbar in the app is themed (`scrollbar-width`/`scrollbar-color` for Firefox, `::-webkit-scrollbar*` pseudo-elements for everything else, in `index.css`) instead of the browser default, so an OS scrollbar never reads as out-of-place against the rest of the theme. Alongside this, a real layout bug got fixed: any container combining `overflow-x-auto` with an unset `overflow-y` gets `overflow-y: auto` implicitly per the CSS Overflow spec (mismatched visible/non-visible pairs resolve that way) — the character sheet's tab bar and a few Combat Arena strips were hitting this from a few px of font-metric overflow and showing a spurious, useless vertical scrollbar; every such container now pairs `overflow-x-auto` with an explicit `overflow-y-hidden` (or drops scrolling for `flex-wrap` where nothing actually needs to scroll, e.g. the Tic Counter's own 7-square row).
- **Animation:** `DropSlamGhost.jsx` — a shared "drag-release impact" effect (hover in place just long enough to cover the round-trip to the server, then a violent scale/shake slam) — plays when declaring a move onto the Tic Counter and when seating a character in the Combat Arena; deliberately **not** used for Compendium grant-drags or folder-filing drags, which stay instant. Beyond that: a heavier GSAP punch on rolling/stepping a die (`DieWidget.jsx`), an entrance/tap-feedback pass on `RollDialog.jsx`, a scale+glow pulse when a stance is activated (`StancesTab.jsx`), and flash/pop transitions on round number, phase text, and the Arena's current-Tic square when combat state changes (`CombatHeaderBar.jsx`, `CombatArena.jsx`'s `TicSquare`). The move-reveal flip card itself was explicitly left alone this round. Keyframe-array `animate` props on elements that re-render for unrelated reasons are remount-keyed (`key={...}`) rather than left to replay on every render — the same pattern the Phase 8 pilot's Stamina-number pop already used — to avoid an animation firing when nothing it represents actually changed.
- **"Ink & Impact" pass — built, then reverted (decided, historical):** a five-phase anime-fighter
  visual overhaul (ink-on-black brush-edge panel masks generated in a `client/src/lib/inkAssets.js`
  module, an Anton impact typeface alongside Rajdhani, halftone/grain/speed-line materials,
  fighting-game HUD bars replacing `ParticipantCard` in the Arena, a lazily-loaded `ogl` WebGL
  impact layer on the round cutscene, a throttled fullscreen ink-in-water backdrop shader, and a
  High/Medium/Off effects-quality tier with a device probe) shipped as PRs #51-#55 and was then
  **reverted in full** at the user's request — the app is back to the metallic Tekken/MK direction
  described above, which remains the current and decided visual language. Recorded here so the
  direction isn't re-attempted on the assumption it was never tried: the reversal was a judgement
  about the *look*, not about any single technique failing. Anything salvaged from it in future
  should be reintroduced deliberately and piecemeal, not as another whole-app pass.

## Data model

**Indexes are declared separately, in `ensureIndexes()` (decided, new).** The tables below carry no
`CREATE INDEX` of their own — every one is created by name (`idx_<table>_<column>`) in a single list
at the end of `initDb`, so adding one later needs no table rebuild and the whole set rides the same
batch as the schema. They cover the foreign keys the app actually looks rows up by: the per-character
fan-out every combat payload does (`dice`, `counters`, `stances`, `weapons`, `injuries`,
`combat_participants`, `character_moves`, `character_perks`, …), the per-move one a Move sheet does
(`move_roll_slots` and its siblings, `move_tags`, `move_interactions`), and the three tables that grow
for the life of a world (`round_events.resolution_id`, `chat_log.move_id`,
`declared_moves.character_id`). SQLite indexes `INTEGER PRIMARY KEY` for free and nothing else, so
before this every `WHERE character_id = ?` was a full scan.

```sql
CREATE TABLE characters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  character_type TEXT NOT NULL DEFAULT 'pc' CHECK(character_type IN ('pc','npc')),
  image_data TEXT,          -- base64-encoded image, stored directly in Turso
  image_mime_type TEXT,     -- e.g. 'image/jpeg', needed to render image_data correctly
  vitruvian_image_data TEXT,      -- optional custom Vitruvian-Man backdrop for Tab 1 (GM upload, per character)
  vitruvian_image_mime_type TEXT, -- falls back to the default baked-in Vitruvian art when NULL
  active_stance_id INTEGER, -- FK to stances(id), set once stances exist
  stamina_multiplier INTEGER NOT NULL DEFAULT 4,  -- editable by future Perks, not hardcoded
  max_stamina INTEGER NOT NULL DEFAULT 0,          -- recalculated on Lock
  current_stamina INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  folder_id INTEGER, -- character list folder; NULL = root
  -- The `opponent_next_roll_penalty` automation's debt: points owed on this
  -- character's NEXT roll of any kind, then cleared. Read-and-spent inside
  -- getCombatRollBonusBreakdown (combatBonuses.js), which every roll a
  -- character actually makes passes through exactly once. On the character
  -- rather than on a combat seat deliberately, so it survives the fight
  -- ending and cannot be shed by being re-seated.
  pending_roll_penalty INTEGER NOT NULL DEFAULT 0
);

-- GM-managed folders for organizing the character list — same structural
-- pattern as move_folders (create/rename/delete). Nested: parent_id
-- self-references (NULL = root); ON DELETE SET NULL is metadata only — the
-- real reparent-on-delete logic (promote to the deleted folder's own
-- parent, not unconditionally to root) is explicit in character_folder:delete.
CREATE TABLE character_folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES character_folders(id) ON DELETE SET NULL
);

-- Seeded once, fixed ruleset (not user-editable in-app)
CREATE TABLE attributes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '' -- lucide icon name, rendered client-side
);

-- Seeded once: 21 rows — the complete 2-Paradox tournament (every pair of the
-- 7 styles has a winner; each style defeats exactly 3). bonus is +2 on every
-- edge; the loser's -2 is the same row read from the other side.
CREATE TABLE attribute_counters (
  id INTEGER PRIMARY KEY,
  attacker_attribute_id INTEGER NOT NULL REFERENCES attributes(id),
  defender_attribute_id INTEGER NOT NULL REFERENCES attributes(id),
  bonus INTEGER NOT NULL -- numeric bonus/penalty applied when attacker's stance meets defender's stance
);

CREATE TABLE stances (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  attribute_a_id INTEGER NOT NULL REFERENCES attributes(id),
  attribute_b_id INTEGER NOT NULL REFERENCES attributes(id) CHECK(attribute_b_id != attribute_a_id)
);

CREATE TABLE dice (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  pool TEXT NOT NULL CHECK(pool IN ('head','core','legs')),
  slot_name TEXT NOT NULL,
  current_size INTEGER NOT NULL DEFAULT 8 CHECK(current_size IN (4,6,8,10,12)),
  bonus INTEGER NOT NULL DEFAULT 0,   -- permanent +1s stacked once size is capped at 12
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','incapacitated')),
  locked_size INTEGER NOT NULL DEFAULT 8 CHECK(locked_size IN (4,6,8,10,12)),
  locked_bonus INTEGER NOT NULL DEFAULT 0,
  locked_status TEXT NOT NULL DEFAULT 'active' CHECK(locked_status IN ('active','incapacitated')),
  half_damage INTEGER NOT NULL DEFAULT 0 -- Half-Damage toggle; raw flag, see mechanic above
);

CREATE TABLE inventory_items (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' -- optional; empty renders nothing
);

CREATE TABLE injuries (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  effect TEXT NOT NULL,
  -- Optional: which die slot this Injury penalizes, and by how many ranks.
  -- NULL slot_name = a purely descriptive Injury with no stat effect. Only
  -- ever applied at character:revert_stats time — see Stamina & Stat Lock.
  slot_name TEXT CHECK(slot_name IN ('Skull','Brain','Left Hand','Stamina','Body','Right Hand','Left Leg','Right Leg')),
  penalty INTEGER NOT NULL DEFAULT 0
);

-- No FK on character_id or move_id: entries must survive character/move
-- deletion (shown as "(deleted)" / "(move deleted)"). kind='message' rows
-- are free-text posts (optionally with an image/GIF); kind='move_reveal'
-- rows are legacy (pre-lane-snapshot-redesign — see kind='lane_snapshot'
-- below), posted automatically by combat:tic_forward (move_id set, no
-- roll attached — a Roll is a completely separate ordinary kind='roll'
-- entry). kind='lane_snapshot' rows (decided, Chat Log redesign) are the
-- current per-reveal card: `payload` carries the whole cumulative snapshot
-- (pairIndex, round/Tic window, every currently-revealed move in the lane
-- with its own footprint + embedded `full` move data) as JSON — see
-- buildLaneSnapshotPayload in server/index.js and the Chat Log mechanic
-- above. dice_rolled stays '[]' rather than NULL for every non-'roll' kind.
-- The text column is named `content`, not `message` — a column literally
-- named "message" would collide with the migration helper's word-boundary
-- column check, which would then false-positive-match the CHECK
-- constraint's own 'message' enum literal and silently skip adding the
-- column. kind's CHECK constraint needed the same table-rebuild migration
-- as move_interactions.trigger below each time a new kind was added
-- ('move_reveal', then 'lane_snapshot' — see migrateChatLogKind in
-- server/db.js) — SQLite can't ALTER a CHECK constraint in place.
CREATE TABLE chat_log (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot')),
  character_id INTEGER NOT NULL,
  dice_rolled TEXT NOT NULL, -- JSON array of {slot_name, size, bonus, result}
  modifier INTEGER NOT NULL DEFAULT 0,
  move_id INTEGER, -- set for legacy kind='move_reveal'; null otherwise
  content TEXT, -- free-text message content; kind='message' only
  image_data TEXT, -- base64; kind='message' only. GIFs stored raw/unresized to keep animation
  image_mime_type TEXT,
  -- JSON; kind='lane_snapshot' always. kind='roll' optionally, when the
  -- roll is for a declared move's own reveal-time Roll (Combat Automation,
  -- Phase 9, sub-phase 3 — see buildRollContext/logRoll in index.js):
  -- { declaredMoveId, moveId, pairIndex, side, targetCandidateIds,
  --   effectiveAttackTargets, attackTargetSource }. The last two (Attack
  -- Target, Change 001) are a snapshot only as of roll time — a Successful
  -- Block resolving afterward can go stale here, which is exactly why GET
  -- /api/chat re-reads current declared_moves state for these two fields on
  -- every kind='roll' row instead of trusting this frozen payload verbatim
  -- (one batched query across every referenced declaredMoveId, not N+1) —
  -- see the Attack Target mechanic section above.
  -- Populated by pool:roll/dice:roll_custom whenever the caller passes
  -- declaredMoveId (only ever the reveal-time auto-Roll flow — a bare Dice
  -- Tray roll, a manual Stat roll, or a GM-persona roll never does); GET
  -- /api/chat spreads it straight onto a kind='roll' row the same way a
  -- kind='lane_snapshot' row's payload is already spread. Consumed by the
  -- chat card's damage line + Apply button (Combat Automation, sub-phase 4
  -- — see ChatPanel.jsx's Entry).
  payload TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- World-level, GM-editable at any time
CREATE TABLE tells (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  image_data TEXT,      -- base64 small uploaded image (commissioned art)
  image_mime_type TEXT
);

-- Perks compendium (separate from Moves)
-- Just picture, name, description (decided) — mechanical effects, if any,
-- are per-Perk code in server/perks/, bound by the Perk's exact name, never
-- stored data. The original perk_automations/character_perk_automations
-- tables (a generic 5-type automation registry, applied/reversed
-- automatically on every grant/revoke) were removed for this reason.
CREATE TABLE perks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_data TEXT,      -- base64 small uploaded image, optional
  image_mime_type TEXT
);

-- Pure membership — granting/revoking a Perk has no automatic effect beyond
-- this row unless server/perks/index.js has a definition under that name.
CREATE TABLE character_perks (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  perk_id INTEGER NOT NULL REFERENCES perks(id) ON DELETE CASCADE,
  UNIQUE(character_id, perk_id)
);

-- One grant's private scratch space: charges, cooldowns, "once per round".
-- Data storage, NOT an effect system — nothing here says what a Perk does, only
-- what it has already done. `scope` is when the row is wiped and is the whole
-- reason the column exists; 'round' is cleared per PAIR (see the Perks section
-- above on why that matters), 'fight' globally. Cascades off character_perks,
-- so revoking a Perk takes its state with it.
CREATE TABLE character_perk_state (
  id INTEGER PRIMARY KEY,
  character_perk_id INTEGER NOT NULL REFERENCES character_perks(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'round' CHECK(scope IN ('round','fight','permanent')),
  UNIQUE(character_perk_id, key)
);

-- World-level, GM-managed, like Tells (landed in Phase 3 for Move tagging)
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' -- shown as a tooltip wherever the tag appears
);

-- Base tags on a Move template — global, visible to everyone with that Move
-- (0-10 per move, landed in Phase 3)
CREATE TABLE move_tags (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE(move_id, tag_id)
);

-- Character-scoped tag overrides, written by a Perk's manual PERK_HOOKS entry (personal, not global)
CREATE TABLE character_move_tags (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('add','remove')), -- 'remove' suppresses a base tag just for this character
  source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
  -- points at the grant instance (not the perk template), so revoking-then-
  -- regranting the same Perk can't be confused with the earlier grant
);
-- A character's effective tags on a move = move_tags, plus 'add' overrides, minus 'remove' overrides from character_move_tags

-- Per-character frame-data deltas on a specific move, written by a Perk's
-- manual PERK_HOOKS entry — "the move copy on the character," not the
-- shared template. Multiple Perks touching the same move on the same
-- character sum.
CREATE TABLE character_move_overrides (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  startup_delta INTEGER NOT NULL DEFAULT 0,
  active_delta INTEGER NOT NULL DEFAULT 0,
  recovery_delta INTEGER NOT NULL DEFAULT 0,
  source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
);

-- Per-character bonus scoped to a specific move (written by a Perk's manual
-- PERK_HOOKS entry), applying only to rolls made using that move. Live once
-- the move has a Roll configured (move_roll_slots) — folded into the
-- pre-filled modifier on click. For a move with no Roll, still
-- stored/displayed but with nothing to attach to until Phase 7 gives
-- declared moves their own reveal-and-roll.
CREATE TABLE character_move_roll_bonuses (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
);

-- The Weapon (decided, new — see Game mechanic — The Weapon above). One per
-- character or none, and none is the default: nobody starts holding anything.
-- Deliberately NOT a ninth die row — a weapon has no incapacitation, no
-- half-damage, no locked baseline and no share of Stamina; adding one to `dice`
-- would have rippled through all of that to model something that is not a body
-- part. `durability` is a positive integer, spent only by USING the weapon in a
-- Move (1 per declaration, tracked by declared_moves.weapon_spent); rolling it
-- on its own costs nothing.
CREATE TABLE weapons (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  die_size INTEGER NOT NULL,
  bonus INTEGER NOT NULL DEFAULT 0,
  durability INTEGER NOT NULL
);

CREATE TABLE counters (
  id INTEGER PRIMARY KEY,
  character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE, -- NULL = standalone arena counter
  name TEXT NOT NULL,
  target_pips INTEGER NOT NULL CHECK(target_pips BETWEEN 2 AND 20),
  current_pips INTEGER NOT NULL DEFAULT 0,
  show_in_combat INTEGER NOT NULL DEFAULT 0, -- only meaningful when character_id is set
  -- Purely cosmetic tracking tag, no mechanical effect — character-owned
  -- counters only (server rejects it for a standalone character_id=NULL
  -- counter, both on create and via counter:set_reward)
  reward_type TEXT CHECK(reward_type IN ('story','statistic','perk','move','combat_prowess'))
);

-- GM-created folders for organizing the Moves compendium. Nested, same
-- parent_id self-reference pattern as character_folders above.
CREATE TABLE move_folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES move_folders(id) ON DELETE SET NULL
);

-- The compendium: master list of move templates (structure finalized).
-- folder_id doubles as "discipline" in the UI — see Moves & Tells above.
CREATE TABLE moves (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0, -- 1 = auto-granted to every character
  tell_id INTEGER NOT NULL REFERENCES tells(id),
  startup_tics INTEGER NOT NULL DEFAULT 1,   -- frame data: 0-10 each,
  active_tics INTEGER NOT NULL DEFAULT 1,    -- at least 1 square total
  recovery_tics INTEGER NOT NULL DEFAULT 0,
  -- Required at creation (0 is a valid free cost; negative restores Stamina
  -- instead of spending it) — subtracted from Current Stamina the moment
  -- the declaring character themselves finishes declaring
  -- (combat:character_done_declaring), not at move:declare time. See Combat
  -- Timing mechanic below.
  stamina_cost INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  style_attribute_id INTEGER REFERENCES attributes(id), -- learn/use gate; NULL on legacy rows AND on any Default move (is_default = 1 always forces this NULL — see Moves & Tells above)
  folder_id INTEGER,    -- compendium folder ("discipline" in the UI); NULL = root / Without Discipline
  image_data TEXT,      -- base64 small uploaded image
  image_mime_type TEXT,
  roll_modifier INTEGER NOT NULL DEFAULT 0, -- flat bonus on this move's own Roll (see move_roll_slots);
                                             -- distinct from the per-character roll_bonus a Perk can grant
  -- Only set when the Roll includes an ambiguous Left/Right Hand or Leg
  -- slot: the two Tells the header shows side by side, one per appendage
  -- choice. tell_id above is left pointing at one of them in that case,
  -- purely to satisfy its NOT NULL constraint — ignored once both are set.
  right_tell_id INTEGER REFERENCES tells(id),
  left_tell_id INTEGER REFERENCES tells(id),
  -- 1 = this move has On Successful Defense / On Failed Defense
  -- interactions available (see move_interactions below)
  is_defensive INTEGER NOT NULL DEFAULT 0,
  -- JSON array of 0-based indices into the full Startup+Active+Recovery
  -- square sequence marking which squares also grant a defensive window
  -- (green in FrameBar) — an annotation, not a timing phase; see Defense
  -- Frames in Moves & Tells above. sanitizeDefensePositions in
  -- server/moveLogic.js clamps to [0, total) and dedupes/sorts.
  defense_frame_positions TEXT NOT NULL DEFAULT '[]',
  -- Roll type (see Moves & Tells above): 'custom' replaces move_roll_slots
  -- entirely with one flat base die, not tied to any character stat — for
  -- weapons. Mutually exclusive with move_roll_slots; writeMove enforces it.
  roll_type TEXT NOT NULL DEFAULT 'stat' CHECK(roll_type IN ('stat','custom')),
  custom_roll_size INTEGER CHECK(custom_roll_size IN (4,6,8,10,12)),
  -- Attack Target (Change 001, decided, new): JSON array of the same 6
  -- abstract slot names as a Roll (see ATTACK_TARGET_NAMES = ROLL_SLOT_NAMES
  -- in server/moveLogic.js) — which Stats this move's damage may land on.
  -- Empty array is a valid, explicit "no target" (Apply is then disabled
  -- until a Successful Block replaces it — see Attack Target mechanic
  -- below), not missing data. The '["Skull"]' DB default is a one-time
  -- migration value for every pre-existing row; writeMove always writes an
  -- explicit JSON array (including []) going forward, so a brand-new move
  -- saved with no targets picked stays empty across a server restart.
  attack_targets TEXT NOT NULL DEFAULT '["Skull"]',
  -- Combat Automation overhaul (Phase A, decided, new — see the mechanic
  -- section below): which of this Defensive move's Defense Frames it
  -- represents. Both kinds now ask the GM Successful/Failed (Defence rework,
  -- decision #1); the difference is what a Yes means — a confirmed Dodge
  -- negates the attack outright, a confirmed Block then rolls its guard and
  -- can still come out Partial. Required by writeMove whenever is_defensive=1
  -- with at least one
  -- Defense Frame placed; NULL otherwise. Every pre-existing Defensive move
  -- was backfilled to 'block' by a one-time migration (mirrors the
  -- attack_targets '["Skull"]' backfill above) — the GM should review and
  -- flip any that were narratively meant as a Dodge.
  defense_kind TEXT CHECK(defense_kind IN ('block','dodge'))
);

-- Which of a move's optional Roll dice it's made of (see Moves & Tells
-- above) — a move with no rows here simply has no Roll. slot_name is either
-- a concrete DICE_TEMPLATE slot (Skull/Brain/Stamina/Body) or one of the
-- two ambiguous appendage choices, 'Hand' or 'Leg' — resolved to the
-- character's actual Left or Right die only at roll time, per the player's
-- choice, not a slot the GM commits to at creation time.
CREATE TABLE move_roll_slots (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  slot_name TEXT NOT NULL,
  UNIQUE(move_id, slot_name)
);

-- Combat Automation (Phase 9, planned): an additional Stat pool a Defensive
-- move rolls only during Block/Dodge resolution (4.2), on top of its own
-- normal Roll — same slot_name vocabulary as move_roll_slots above, mirrored
-- as a separate table since a slot can independently be in one, the other,
-- both, or neither. Only ever populated when the move's own is_defensive =
-- 1 (enforced in writeMove). Schema only so far — not yet surfaced in the
-- Move Creator or read by any roll handler.
CREATE TABLE move_defensive_roll_slots (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  slot_name TEXT NOT NULL,
  UNIQUE(move_id, slot_name)
);

-- On Hit / On Block / On Miss (every move) plus On Successful Defense /
-- On Failed Defense (Defensive moves only, gated by moves.is_defensive both
-- client and server side): text plus optional automations (only rows with
-- non-whitespace text or at least one automation are stored — a category
-- with neither simply has no row and is never rendered).
--
-- The trigger CHECK was originally 3-value ('hit','block','miss'); adding
-- defense_success/defense_failure required a migration since SQLite can't
-- ALTER a CHECK constraint in place — an existing table gets rebuilt (a v2
-- table with the expanded CHECK, every row copied across, old table
-- dropped, v2 renamed into place) the first time initDb runs against it;
-- see migrateMoveInteractionsTrigger() in server/db.js.
CREATE TABLE move_interactions (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss','defense_success','defense_failure')),
  text TEXT NOT NULL DEFAULT '',
  automations TEXT NOT NULL DEFAULT '[]'
  -- JSON [{type, amount}]; type in: self_recovery (amount may be negative),
  -- opponent_recovery, self_stamina, opponent_stamina (positive = amount lost)
);

-- Role-play tab (Tab 6): per-character Q&A. The 7 canonical questions live in
-- client code; answers upsert here keyed by question text (is_custom = 0).
-- Custom questions (up to 20 per character) are rows with is_custom = 1.
CREATE TABLE roleplay_entries (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  is_custom INTEGER NOT NULL DEFAULT 0
);

-- Grants a Unique move to a specific character (Default moves need no row here)
CREATE TABLE character_moves (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  UNIQUE(character_id, move_id)
);

-- Singleton row holding the arena's genuinely global config. Phase 6 (done)
-- only creates uneven_combat_enabled. round_length is still shared by every
-- pair (all pairs use the same round length). **Combat Automation overhaul,
-- Phase B (decided, new): phase/round_number/current_tic/round_start_tic
-- are now ALSO unused, joining declaring_side/pending_declare_side below**
-- — round/phase/Tic state moved entirely onto combat_pairs (see below),
-- since each pair now runs its own genuinely independent round clock (one
-- pair can be on round 5 while another is still on round 3) instead of one
-- shared arena-wide clock. The columns stay (migrations here are
-- additive-only) but nothing reads or writes them anymore.
CREATE TABLE combat_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  uneven_combat_enabled INTEGER NOT NULL DEFAULT 0,
  phase TEXT CHECK(phase IN ('declaration','tic_countdown')),   -- unused, see above
  round_number INTEGER NOT NULL DEFAULT 0,   -- unused, see above
  current_tic INTEGER NOT NULL DEFAULT 0,   -- unused, see above
  round_start_tic INTEGER NOT NULL DEFAULT 0,   -- unused, see above
  round_length INTEGER NOT NULL DEFAULT 7,
  declaring_side TEXT CHECK(declaring_side IN ('left','right')),   -- unused, see above
  pending_declare_side TEXT CHECK(pending_declare_side IN ('left','right'))  -- unused, see above
);

-- Who's currently seated. side + pair_index group participants into facing
-- pairs; more than one character can share a side/pair_index (Uneven
-- Combat groupings like 2v1) — the app doesn't enforce the toggle, that's
-- a GM-facing flag only. A character can only be seated once.
-- declared_this_round (combat redesign): has THIS character individually
-- pressed "done declaring" for the round currently in
-- combat_state.round_number — declaration is per-character now, not one
-- shared batch per side (see combat_pairs below). Reset to 0 for everyone
-- at combat:next_round, and (since combat_participants itself isn't wiped)
-- at combat:end too.
-- reasons_to_fight (new rule): 0-3, +1 to all of this character's rolls
-- per point while combat is active — see Game mechanic - Combat Arena above.
-- idle_regen_progress (new rule): qualifying idle Tics accumulated toward
-- this character's next +1 Stamina — see Idle-Tic Stamina Regen under
-- Stamina & Stat Lock above. Both reset to 0 at combat:end (like
-- declared_this_round) since they live on the seat, not the character.
CREATE TABLE combat_participants (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('left','right')),
  pair_index INTEGER NOT NULL,
  declared_this_round INTEGER NOT NULL DEFAULT 0,
  reasons_to_fight INTEGER NOT NULL DEFAULT 0 CHECK(reasons_to_fight BETWEEN 0 AND 3),
  idle_regen_progress INTEGER NOT NULL DEFAULT 0,
  UNIQUE(character_id)
);

-- Combat redesign (decided): declaration now runs independently per pair —
-- pair 1's losing side and pair 2's losing side can be mid-Declaration
-- simultaneously even though they might be literal opposite "sides", so a
-- single global declaring_side (combat_state, now unused — see above) no
-- longer describes who may currently call move:declare. One row per
-- pair_index that has participants. declaring_side is whichever side of
-- THIS pair may currently declare — NULL once every character on both
-- sides of it has declared_this_round = 1 (trivially NULL immediately if
-- only one side was ever seated).
-- **Combat Automation overhaul, Phase B (decided, new):** round_number/
-- phase/round_start_tic/current_tic — the same Tic-timing state that used
-- to live once on combat_state (see above) — now live HERE instead, one
-- full independent copy per pair, since each pair runs its own genuinely
-- independent round/Tic clock (per the Combat Automation overhaul's locked
-- decision #12 — one pair can be resolving round 5 while another is still
-- mid-Declaration on round 3, with no fight ever waiting on another).
-- phase is 'declaration' or 'resolving' for this pair specifically (NULL
-- only before this pair has ever had a round start) — the value
-- 'tic_countdown' from the pre-overhaul combat_state.phase became
-- 'resolving' here, anticipating Phase C's automatic-resolution engine
-- reusing the same phase value for what's now an automatic (not manually
-- stepped) process. **Unlike the old combat_state clock, and unlike this
-- table's own pre-overhaul self (which combat:next_round used to clear and
-- recreate every round), rows now persist and are upserted in place round
-- after round** — created once when a pair first gets participants, then
-- updated forever after, since each pair's own round number/Tic position
-- must now keep incrementing independently rather than being wiped back to
-- a shared baseline. Still wiped entirely by combat:clear/combat:end (a
-- deliberate full reset, unlike the round-to-round upsert).
CREATE TABLE combat_pairs (
  pair_index INTEGER PRIMARY KEY,
  declaring_side TEXT CHECK(declaring_side IN ('left','right')),
  round_number INTEGER NOT NULL DEFAULT 0,
  phase TEXT CHECK(phase IN ('declaration','resolving')),
  round_start_tic INTEGER NOT NULL DEFAULT 0,
  current_tic INTEGER NOT NULL DEFAULT 0
);

-- Combat Automation overhaul (decided). Tracks one pair's one round's
-- automatic resolution run: 'running' while stepping through Tics,
-- 'paused_dodge'/'paused_conflict' while waiting on the one human decision
-- that round still needs (a Dodge Successful/Failed call, or a
-- move-conflict Forfeit/Postpone), 'complete' once the round has fully
-- resolved. **Phase D (done, engine-level):** all four status values are
-- real — `advancePairResolution`/`resolveDodge`/`resolveMoveConflict` in
-- `server/roundResolution.js` genuinely pause at a full-coverage Dodge or a
-- Block-too-late move conflict and persist pending_dodge_json/
-- pending_conflict_json for exactly that reason. resolved_through_tic is
-- the crash-safe resume point (see the mechanic section's "surviving a
-- restart mid-round" note) — reprocessing a Tic from here is always
-- idempotent (guarded by declared_moves.interactions_resolved), so a crash
-- between "computed" and "wrote it" just cheaply redoes that one Tic on
-- the next call, verified by an actual restart-simulation test, not just
-- asserted. pending_dodge_json/pending_conflict_json hold the exact prompt
-- payload while paused (non-null only in the matching status) — the "a
-- reconnecting GM/player gets it for free off the regular combat snapshot"
-- part of this design is still Phase E's job, once combat:updated actually
-- folds a pending decision into its own payload for a live client to read.
CREATE TABLE IF NOT EXISTS pair_round_resolutions (
  id INTEGER PRIMARY KEY,
  pair_index INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  round_start_tic INTEGER NOT NULL,
  round_length INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused_dodge','paused_conflict','complete')) DEFAULT 'running',
  resolved_through_tic INTEGER NOT NULL DEFAULT 0,
  pending_dodge_json TEXT,
  pending_conflict_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(pair_index, round_number)
);

-- Combat Automation overhaul (decided). The replayable per-pair-per-round
-- event log: this table doubles as both the live-push source (each row
-- broadcast the instant it's persisted, `combat:round_event` — see Real-
-- time events below) and the stored-replay source (a later "Watch Round X"
-- chat button, Phase E, reads the exact same rows) — live playback and
-- replay are guaranteed identical by construction, never two
-- representations kept in sync by hand. pair_index/round_number are
-- denormalized off pair_round_resolutions purely to avoid a join for "this
-- pair's log." **Phase D (done, engine-level):** every `type` in the
-- catalogue below is now emitted in its real, non-placeholder form,
-- including `dodge_resolved`/`move_conflict_resolved` — `resolveDodge`/
-- `resolveMoveConflict` in `server/roundResolution.js` post these once the
-- GM/player's actual decision arrives, not an auto-decided stand-in.
-- Nothing consumes these rows over a live socket yet, though —
-- `combat:round_event` broadcasts correctly, and the REST replay endpoint
-- (`GET /api/combat/round-replay/:resolutionId`) that reads them back for
-- "Watch Round X" is still Phase E's job, same as the client that renders
-- either feed.
CREATE TABLE IF NOT EXISTS round_events (
  id INTEGER PRIMARY KEY,
  resolution_id INTEGER NOT NULL REFERENCES pair_round_resolutions(id) ON DELETE CASCADE,
  pair_index INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  tic INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-round queued moves. Persisted so they survive reloads mid-round, but every
-- broadcast/response withholds move_id until the reveal Tic UNLESS the viewer is
-- entitled to see it early — the player logged in as this character, or the GM
-- for an NPC's move (see identity:set / isRevealedToViewer in index.js and
-- Roles / access model above).
CREATE TABLE declared_moves (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id),
  round_number INTEGER NOT NULL,
  queue_order INTEGER NOT NULL, -- this character's Nth move declared this round
  placement_tic INTEGER NOT NULL,
  reveal_tic INTEGER NOT NULL, -- placement_tic + the move's startup_tics
  reveal_posted INTEGER NOT NULL DEFAULT 0, -- has this move's lane_snapshot chat card already gone out? (idempotency, not visibility — see chat_log above)
  stamina_committed INTEGER NOT NULL DEFAULT 0, -- has this move's Stamina Cost actually left/returned to current_stamina yet? (see Combat Timing mechanic below)
  appendage_choice TEXT CHECK(appendage_choice IN ('left','right')), -- 'left'/'right' for a move whose Roll has an ambiguous Hand/Leg slot, chosen at declare time; NULL otherwise — never secret, same as the Tell itself (see Combat Timing mechanic below)
  -- Combat Automation (Phase 9, sub-phase 3): extra Recovery Tics this
  -- declared move's window has been extended by. Only ever set nonzero for
  -- a successfully-Blocked defender whose Defense Frame ran out before the
  -- attacker's Active window did (4.3's "too-late" coverage — see
  -- classifyDefenseCoverage in combatDamage.js and combat:resolve_defense
  -- under Real-time events below). Added into every place a declared move's
  -- Recovery end is computed (reveal_tic + active_tics + recovery_tics +
  -- recovery_extension_tics) — 0, and therefore a no-op, for every move a
  -- fight never routes through Combat Automation.
  recovery_extension_tics INTEGER NOT NULL DEFAULT 0,
  -- Combat Automation (Phase 9, sub-phase 5): set once this declared move's
  -- own attacker-side outcome (Hit, fired from combat:apply_damage, or
  -- Blocked/Dodged, fired from combat:resolve_defense) has fired its
  -- move_interactions automations — guards against a Partial Block's later
  -- damage Apply (same combat:apply_damage flow a plain Hit uses) also
  -- re-firing the move's 'hit' trigger on top of the 'block' trigger
  -- already fired for it. Only ever read/written for the attacking side's
  -- own declared move — defense_success/defense_failure firing (the
  -- defending side's own move) is unrelated and intentionally unguarded, a
  -- defensive move can defend more than once. See applyMoveInteractions in
  -- server/index.js.
  interactions_resolved INTEGER NOT NULL DEFAULT 0,
  -- Attack Target (Change 001, decided, new): a frozen snapshot of this
  -- specific declared attack's concrete effective targets — taken once at
  -- move:declare from moves.attack_targets (Hand/Leg expanded to this
  -- declaration's own appendage_choice, both sides if there isn't one yet)
  -- and never retroactively changed by a later edit to the Move template in
  -- the Compendium. attack_target_source flips from 'move' to 'block' only
  -- when combat:resolve_defense records a Successful Block, replacing it
  -- with the blocking move's own base move_roll_slots (never its
  -- move_defensive_roll_slots pool) narrowed to the block's own declared
  -- side — never 'dodge' (see the deferred Dodge correction below, out of
  -- scope for this Change). The '["Skull"]'/'move' DB defaults are one-time
  -- migration values for every pre-existing row (matching every legacy
  -- move's own migrated ['Skull'] — see moves.attack_targets above).
  effective_attack_targets TEXT NOT NULL DEFAULT '["Skull"]',
  attack_target_source TEXT NOT NULL DEFAULT 'move' CHECK(attack_target_source IN ('move','block')),
  -- Feint Tag (the third Tag automation): 1 when this declaration was made
  -- immediately after a move carrying the **Feint** Tag — same "right after"
  -- test the Requirement gate uses, plus contiguity in time (it starts on
  -- the Tic the Feint's own frames end). Such a row is dropped from every
  -- non-owner's combat:updated payload entirely until it is publicly
  -- revealed: no Tell, no attack telegraph, no placement Tic. Frozen here at
  -- declare time rather than derived at read time, because a Block extending
  -- the Feint's Recovery would otherwise break the contiguity test mid-round,
  -- and a GM editing the Move's Tags would retroactively mask or unmask a
  -- declaration already on the board. Cleared by move:undeclare on whatever
  -- the deleted move was hiding. See the Feint Tag under Tags & automation.
  feint_masked INTEGER NOT NULL DEFAULT 0,
  -- The Weapon (decided, new): has this declaration already paid its 1
  -- Durability? Using a weapon in a Move costs 1 — once per Move, not once per
  -- roll. Several paths can roll the same declaration's Roll (a Block is rolled
  -- once per attacked Stat; a grapple follow-up re-rolls the move it chained
  -- into), so the spend is recorded on the declaration rather than counted at
  -- each roll site, and it survives a pause. Rolling a weapon OUTSIDE a Move —
  -- the sheet's die widget, a GM roll request — never touches Durability and
  -- never reaches this column. See server/weapons.js.
  weapon_spent INTEGER NOT NULL DEFAULT 0
);
```
When a character is created, auto-generate its 8 `dice` rows (2 head + 4 core + 2 legs) at a default size of d8, editable afterward via step up/down.

**Image storage note:** portraits are stored directly in Turso as base64 (`image_data`) rather than a separate image hosting service — simplest option, no extra account needed, and well within Turso's free storage limits for a handful of character portraits. To keep rows small, the frontend should resize/compress images client-side before upload (e.g. cap at ~800px wide) rather than uploading a raw phone photo.

**Choosing what shows (implemented, decided).** Every thumbnail in the app is square and no uploaded picture is, so `object-fit: cover` was quietly deciding which part of each face survived — and it always takes the middle, which is where a face usually is not. Picking a file now opens a crop step before the save: a fixed square frame with the picture panned and zoomed behind it, and a live preview on the right showing the result at the sizes it will really appear, with the name laid out beside it.

- **A stored rectangle, never a baked-in cut.** `image_data` keeps whatever was uploaded; four nullable REAL columns — `crop_x`, `crop_y`, `crop_w`, `crop_h` — say which part of it to show. So the Arena card renders the whole picture (decided: it is the only tall portrait on any screen, and a crop chosen to make a good 24px avatar is the wrong thing to enlarge there), re-opening the editor starts from the original rather than from a crop of a crop, and nothing is stored twice. On `characters`, `moves`, `tells`, `perks` and `relationship_people`.
- **NULL is "no crop", not "the default crop"** — it renders with plain `object-fit: cover`, exactly as everything did before this existed, which is what makes the change invisible to every picture already uploaded and means there is no backfill.
- **Normalised per axis**, `crop_w` against the picture's width and `crop_h` against its height. It looks wrong until you see what it buys: rendering is four CSS percentages on an `<img>` inside an `overflow: hidden` box, needing no intrinsic size, so all two dozen thumbnails stay plain synchronous renders with no `onLoad` anywhere. The editor is what keeps the *pixel* region square, so the aspect ratio is preserved by construction.
- **The crop always travels with the picture.** A new upload clears the old crop server-side, because that crop described a different photograph. An edit that does not touch the image does not touch the crop.
- **Validated, not clamped** (`cropValues` in `server/index.js`). It is the only field on these tables that reaches a renderer as raw CSS, so anything that is not a real rectangle inside the picture is stored as four NULLs rather than drawing a thumbnail as an empty box with nothing logged.
- **`CroppedImage` is the only place a crop becomes pixels**, and `Thumb` wraps it — which is why sixteen call sites needed one edit. Its inner `aspect-ratio: 1; min-width/height: 100%` square is load-bearing rather than decoration: the crop maths assumes the region it fills is square, and a 3:1 picture in a 194×224 card rendered at 2.6:1 until that square was added. Caught by measuring, not by looking.
- Not applied to chat images (posted whole, with no name beside them) or the Vitruvian backdrop (a full-figure backdrop, shown whole) — the preview clause in the request scopes this to pictures that become an avatar next to a name.

**Move list note:** a character's full Tab 3 list = all `moves` where `is_default = 1`, plus all moves joined through `character_moves` for that character. Declared moves during combat ARE persisted (`declared_moves`), unlike the earlier draft of this plan — the Tic-based reveal timer needs them to survive a mid-round reload. The server still withholds the real `move_id` from a viewer until the reveal Tic unless they're entitled to see it early (see Combat Timing's identity-based reveal rule), sending only the Tell otherwise.

## Real-time events (Socket.io)
- `character:created` / `character:updated` / `character:deleted` — server → all clients, includes `character_type`. `character:updated` covers name edits, portrait uploads, and folder reassignment alike, so every device refreshes all three live.
- `character_folder:create` / `character_folder:rename` / `character_folder:delete` (client [GM] → server): `{ name, parentFolderId? }` / `{ folderId, name }` / `{ folderId }` — manages `character_folders`. `parentFolderId` nests the new folder inside an existing one (validated server-side; an unknown id falls back to root). Delete promotes the folder's direct characters and direct child folders **one level up, to the deleted folder's own `parent_id`** (root if it was already at root) rather than unconditionally to root, then removes the folder; broadcasts `character_folder:created` / `character_folder:updated` / `character_folder:deleted` (the delete payload includes `{ folderId, parentFolderId }` so a client viewing the deleted folder can follow it up to the same parent). `GET /api/character-folders` lists them, including `parent_id` (kept separate from `GET /api/characters`, whose flat-array shape existing callers depend on).
- `character:set_folder` (client [GM] → server): `{ characterId, folderId }` (`folderId` null = root; an unknown id also falls back to root) — the drag-and-drop reassignment path, mirrors `move:set_folder`: touches only `characters.folder_id`. Broadcasts `character:updated`. `POST /api/characters` also accepts an optional `folderId` so a new character can be filed in directly from the Add Character form (GM only — Players' new PCs always land at root).
- `die:roll` (client → server): `{ characterId, dieId, modifier }` — modifier is the ad-hoc +/- entered in the roll dialog, plus this character's own Reasons to Fight bonus if a fight is currently active (`getReasonsToFightBonus`, see Combat Arena above — folded in server-side, not just a client pre-fill). Result = roll(current_size) + bonus + modifier. Server logs to `chat_log`, broadcasts `roll:result`.
- `pool:roll` (client → server): `{ characterId, dieIds, modifier, declaredMoveId?, includeWeapon? }` — rolls the selected set of that character's dice (any mix across Head/Core/Legs; incapacitated dice are silently dropped), each at its own size + bonus, plus the one shared modifier (also carrying the Reasons to Fight bonus, same as `die:roll` above) applied to all of them. **`declaredMoveId` (Combat Automation, sub-phase 3, optional):** when present and it resolves (`buildRollContext` — must be a real `declared_moves` row belonging to this `characterId`, who must currently be seated), the logged/broadcast roll carries the roll-context payload (`{ declaredMoveId, moveId, pairIndex, side, targetCandidateIds, effectiveAttackTargets, attackTargetSource }` — the last two added by Change 001, read live off that same `declared_moves` row at roll time — see `chat_log.payload` in the Data model above) so a future Apply button knows which move/attacker/targets/effective-target this roll belongs to; an unresolvable id is silently dropped (context omitted) rather than rejecting the roll. Only ever sent by the reveal-time auto-Roll flow (`CombatHeaderBar.jsx`) — every other caller (a manual Stat roll from the Moves tab, the Dice Tray) omits it, so those stay bare rolls with no Apply button, exactly as intended ("never for a bare Dice Tray/manual Stat/Pool roll" — see the Combat Automation mechanic above). **`includeWeapon` (the Weapon, decided, new):** a weapon is not a die row and so has no id to put in `dieIds` — a Move whose Roll names the Weapon slot sends this flag instead and the server appends `weaponDie(weapon)` to the pool. Rolling costs no Durability; that is what *using* the weapon in a Move costs (see The Weapon above). Broadcasts `roll:result`.
- `weapon:create` (client → server): `{ characterId, name, dieSize, bonus, durability }` — the player-facing half of the Weapon's single creation path; calls `grantWeapon` (`server/weapons.js`), which a Perk arming its holder will call with the same shape. Replaces whatever that character was carrying (one weapon, so a second is a swap, not a stack) and **refuses** rather than clamps a request that isn't a weapon (a die outside d4-d12, a blank name, a Durability below 1). Posts a chat line and broadcasts `weapon:updated` plus `combat:updated` (being armed opens and closes Moves in the Arena picker). Open access, same trust model as every other sheet edit here.
- `weapon:delete` (client → server): `{ characterId }` — puts it down. Same broadcasts.
- `weapon:roll` (client → server): `{ characterId, modifier }` — rolls the weapon on its own, die + its modifier + the ad-hoc one + any combat bonus, exactly like `die:roll` does for a Stat. **Costs no Durability** — see The Weapon above. Logs to `chat_log` with `slot_name: 'Weapon'`, broadcasts `roll:result`.
- `weapon:updated` (server → all): `{ characterId, weapon }` — the weapon's whole new state, or `null` when they are now carrying nothing. Emitted by every path that changes one: created, put down, worn down by a Move, or destroyed by an attack that went for it. One row replaced wholesale, so the payload *is* the new state and there is nothing for a client to merge.
- `dice:roll_custom` (client → server): `{ characterId, size, modifier, declaredMoveId? }` — a raw `1d{size} + modifier` roll not tied to any character's own die (`size` must be one of 4/6/8/10/12 or it's a no-op); powers both the chat Dice Tray above and a move's Custom Roll type below. `characterId: null` posts as the generic GM persona (`GM_CHAT_SENTINEL_ID`, same convention as `chat:message`) — Reasons to Fight only applies when a real character is attributed, since a GM-persona roll isn't any seated character's own; `declaredMoveId` is likewise only ever resolved for a real (non-GM) character, same rule and roll-context shape as `pool:roll` above. Logs to `chat_log` (`slot_name: 'Custom'`), broadcasts `roll:result`.
- `die:step` (client → server): `{ dieId, direction: 'up' | 'down' }` — server logic:
  - **up:** if `status == 'incapacitated'`, revive to `current_size = 4`, `bonus = 0`, `status = 'active'`; else if `current_size < 12`, advance to next size; else (`current_size == 12`) increment `bonus` instead.
  - **down:** if `bonus > 0`, decrement `bonus`; else if `current_size > 4`, drop to previous size; else set `status = 'incapacitated'`.
  - Broadcasts `die:updated`.
- `die:toggle_half_damage` (client → server): `{ dieId }` — flips `dice.half_damage` 0/1, a raw manual toggle only (see Half-Damage under Stamina & Stat Lock above — the step-down-and-clear effect is reserved for a future automated caller of `applyHalfDamage`, never this event). Broadcasts `die:updated`.
- `roll:result` (server → all clients): `{ characterId, characterName, modifier, dice: [{slot_name, size, bonus, result}], total, timestamp }`
- `die:updated` (server → all clients): `{ dieId, characterId, current_size, bonus, status, half_damage }`
- `inventory:add` / `inventory:update` / `inventory:remove` (client → server): `{ characterId, itemName, description }` / `{ itemId, itemName, description }` / `{ itemId }` — updates `inventory_items`, broadcasts `inventory:updated` `{ characterId, items }` to all clients
- `injury:add` / `injury:remove` / `injury:update` (client → server): `{ characterId, name, effect, slotName?, penalty? }` / `{ injuryId }` / `{ injuryId, name, effect, slotName?, penalty? }` — updates `injuries`. `slotName` must be one of the 8 valid die slot names or it's dropped to `null` (no stat penalty); `penalty` is only ever stored when a valid `slotName` accompanies it (otherwise forced to 0), clamped `[0, 20]`. Broadcasts `injuries:updated` `{ characterId, injuries }` to all clients
- `stance:create` / `stance:update` / `stance:delete` (client → server): `{ characterId, name, attributeAId, attributeBId }` / `{ stanceId, name, attributeAId, attributeBId }` / `{ stanceId }` — updates `stances`, broadcasts `stance:created` / `stance:updated` / `stance:deleted` to all clients. Server-enforced rules: a character's first stance auto-activates (also broadcasts `stance:activated`); the last remaining stance can't be deleted; deleting the active stance auto-activates a surviving one.
- `stance:activate` (client → server): `{ characterId, stanceId }` — sets `characters.active_stance_id`, broadcasts `stance:activated` `{ characterId, stanceId }` to all clients
- `character:lock_stats` (client → server): `{ characterId }` — copies every die's `current_size/bonus/status` into `locked_size/locked_bonus/locked_status`; recalculates `max_stamina` from the locked Stamina die; clamps `current_stamina` down if it now exceeds the new max. Broadcasts `character:updated` + `die:updated` for each die.
- `character:revert_stats` (client → server): `{ characterId }` — for each die, sums this character's Injury penalties targeting that die's slot and applies `applyRankPenalty({size: locked_size, bonus: locked_bonus, status: locked_status}, totalPenalty)` (see Injuries under Stamina & Stat Lock above) into `current_size/bonus/status`, **and sets `half_damage = 0`** (bugfix — see Revert Stats to Base above), rather than a raw locked→current copy (Current Stamina untouched either way). Broadcasts `die:updated` for each die.
- `stamina:regen` (client → server): `{ characterId }` — rolls the Stamina die at its current size + bonus, adds the result to `current_stamina` (clamped to `max_stamina`), logs to `chat_log`. Broadcasts `character:updated` and `roll:result`. A manual one-off on top of the automatic per-round regen `combat:next_round` now does for everyone (see Stamina & Stat Lock above and `combat:next_round` below) — e.g. to top up mid-round outside the normal cadence.
- `stamina:adjust` (client → server): `{ characterId, delta }` — manual +/- to `current_stamina`, clamped to `[0, max_stamina]`. Interim building block until the Moves tab defines how Stamina is actually spent. Broadcasts `character:updated`.
- `tell:create` / `tell:update` / `tell:delete` (client [GM] → server): `{ name, imageData?, imageMimeType? }` / `{ tellId, name, imageData?, imageMimeType? }` (image only replaced when provided) / `{ tellId }` — manages the world-level `tells` list (delete refused while any move uses the Tell as its `tell_id`, `right_tell_id`, or `left_tell_id`), broadcasts `tell:created` / `tell:updated` / `tell:deleted` to all clients
- `move:create` / `move:update` / `move:delete` (client [GM] → server): `{ name, isDefault, isDefensive, tellId?, rightTellId?, leftTellId?, styleAttributeId, folderId, tagIds, rollSlots?, rollModifier?, rollType?, customRollSize?, attackTargets, imageData?, imageMimeType?, startupTics, activeTics, recoveryTics, description, requirementMoveId?, interactions: {hit|block|miss|defense_success|defense_failure: {text, automations}} }` / `{ moveId, ...same fields }` (interactions + tags + roll slots replaced wholesale on update; image only when provided) / `{ moveId }` — manages `moves` + `move_interactions` + `move_tags` + `move_roll_slots` (delete cascades to `character_moves`), broadcasts `move:created` / `move:updated` / `move:deleted` (full move incl. interactions, tag_ids, roll_slots, roll_modifier, roll_type, custom_roll_size, right_tell_id, left_tell_id, is_defensive, **`attack_targets` — always a parsed array, never a raw JSON string**) to all clients. `rollSlots` dedupes and drops unknown slot names (6 valid values — see Roll slot vocabulary above); an empty/omitted list means the move has no Roll. `tellId` is required unless `rollSlots` includes an ambiguous Left/Right slot, in which case `rightTellId` and `leftTellId` are required instead (both validated to exist) — a request satisfying neither is rejected. `interactions`' two defense keys are only ever normalized into stored rows when `isDefensive` is truthy — sending them for a non-Defensive move is silently ignored, and unchecking Defensive then saving drops any that were previously stored (see `normalizeInteractions(interactions, isDefensive)` in `server/moveLogic.js`). **`rollType`/`customRollSize` (decided, new — see Custom Roll type below) are mutually exclusive with `rollSlots`:** `writeMove` forces `rollSlots = []` whenever `rollType === 'custom'` (regardless of what the client sent) and forces `customRollSize = null` whenever `rollType !== 'custom'`, so a move is always unambiguously one or the other server-side. **`attackTargets` (Change 001, decided, new):** `sanitizeAttackTargets` (canonical-order dedupe, drops unknowns) always writes an explicit JSON array — including `[]` — so a save never falls back to the DB column's own migration-only default; no minimum count is enforced.
- **Move Roll has no dedicated roll-execution event for the Stat type** — it reuses `pool:roll` unchanged. Server-side, `getMovesFor(characterId)` (used by `GET /api/characters/:id` and everywhere a character's move list is sent) resolves each move's `roll_slots` against that character's live `dice` rows: concrete slots (Skull/Brain/Stamina/Body) resolve into `roll_dice: [{dieId, slot_name, current_size, bonus, status}]` same as before; an ambiguous Hand/Leg slot instead contributes to `roll_choice: { right: [...], left: [...] }` — both sides' dice, since nothing commits to Left or Right until the player picks at roll time (a move with no ambiguous slot gets `roll_choice: null`). `effective_roll_modifier = roll_modifier + roll_bonus` (the move's own bonus plus any Perk-granted `move_roll_bonus` for that move) either way. Clicking a move's Roll on the client opens the same roll dialog as any other roll, pre-filled with `effective_roll_modifier`; for an ambiguous Roll the client shows one button per side and, once picked, submits `pool:roll` with `dieIds` set to `roll_dice` plus that side's `roll_choice` entries — `pool:roll`'s existing `status = 'active'` filter is what silently drops any incapacitated die from either collection, no separate logic needed. **A `roll_type: 'custom'` move's Roll button instead submits `dice:roll_custom`** with `size: custom_roll_size` — there's no per-character die to resolve at all, so it skips `roll_dice`/`roll_choice` entirely and is always clickable (no incapacitation concept applies to a fixed base die).
- `folder:create` / `folder:rename` / `folder:delete` (client [GM] → server): `{ name, parentFolderId? }` / `{ folderId, name }` / `{ folderId }` — manages compendium `move_folders`, labeled "Discipline" client-side and nested the same way as `character_folders` above: `parentFolderId` nests the new discipline (an unknown id falls back to root), and delete promotes direct moves and direct child disciplines one level up to the deleted discipline's own `parent_id` (root if it was already at root), broadcasting `{ folderId, parentFolderId }` for client navigation. Broadcasts `folder:created` / `folder:updated` / `folder:deleted`.
- `move:set_folder` (client [GM] → server): `{ moveId, folderId }` (`folderId` null = root; an unknown id also falls back to root) — the drag-and-drop reassignment path: touches only `moves.folder_id`, leaving name/tell/style/frames/description/interactions/tags untouched (unlike `move:update`, which replaces the whole move). Broadcasts `move:updated`.
- `move:reorder` (client [GM] → server): `{ moveIds: [id, ...] }` — the custom Compendium order (decided, new). The client sends the full ordered id list of **the view it just rearranged**, not the whole library; the server redistributes the `sort_order` values those same moves already occupy, re-sorted and reassigned in the new sequence, so a reorder inside one Discipline (or under an active filter) can never move something past a move it was already behind in another. Ids that no longer exist are dropped, a payload of fewer than two known moves is a no-op, and a library still at all-zeroes falls back to the rows' `(sort_order, id)` index so the first reorder spreads them out in the order they already had. Broadcasts `moves:reordered` `{ moveIds, sortOrders }`. Every move read path orders by `(sort_order, id)`.
- `move:grant` / `move:revoke` (client [GM] → server): `{ characterId, moveId }` — inserts/deletes a `character_moves` row (the drag-and-drop from the compendium). Grant is refused server-side when the move has a style and the character has no stance containing it (learnability rule). Broadcasts `move:granted` / `move:revoked`
- `roleplay:save_answer` / `roleplay:add_question` / `roleplay:update_entry` / `roleplay:delete_question` (client → server): `{ characterId, question, answer }` (upserts a canonical-question answer) / `{ characterId, question }` (custom, capped at 20 per character) / `{ entryId, question, answer }` (question editable only on custom rows) / `{ entryId }` (custom rows only) — all broadcast `roleplay:updated` `{ characterId, entries }`
- `combat:next_round` (client [GM] → server) — a no-op unless already in `tic_countdown` phase or the fight hasn't started yet (`phase` null), and at least one character is seated. Increments `round_number`, sets `current_tic` and `round_start_tic` together to `computeNextRoundStartTic({ phase, currentTic, roundStartTic, roundLength })` — `current_tic` itself for the very first round (`phase` null), otherwise `max(current_tic, round_start_tic + round_length)` so the new round's window can never overlap the previous round's own Tics even if the Tic Countdown was never (or only partially) stepped through (bugfix — see the Declaration Phase bullet above). **Stamina Regen (decided, new rule):** on every round *except* the first (`phase` was already non-null, i.e. this isn't the Start Combat full-restore below), rolls each seated character's Stamina die at its current size/bonus, adds the result to `current_stamina` (clamped to `max_stamina`), broadcasts `character:updated`, and logs each as a normal roll (`logRoll`, same shape `stamina:regen` already uses) — automatic, for every seated character at once, not just whoever presses the manual button. Also rolls the Brain die for every seated participant with an active Brain die — modifier = that character's own Reasons to Fight bonus minus `computeInitiativeOverflowPenalty` for any move-footprint overflow they're still carrying into this round (see the Declaration Phase's Initiative bullet above for both; the real modifier is now passed to `logRoll` so the Chat Log breakdown attributes it correctly instead of folding it into the raw die face — bugfix) — logged to `chat_log` as normal initiative rolls, same `logRoll` path as any other roll (an incapacitated/missing Brain die is silently dropped from its side's initiative, same as `pool:roll` drops incapacitated dice elsewhere), sets `phase = 'declaration'`, resets every seated character's `declared_this_round` to 0, then — **per pair (revised, combat redesign)** — for each `pair_index` that has participants, resolves that pair's own per-side initiative from just its own seated characters' Brain rolls plus current/locked Brain value and active-stance Speed (for the tie-break cascade — see the Initiative ties bullet above) via `resolveSideInitiative` (see `server/combatTiming.js`) and (re)inserts its `combat_pairs` row with `declaring_side` set to the losing side (or the only side, if the pair has just one); the whole `combat_pairs` table is cleared and rebuilt fresh each call. Broadcasts `combat:updated`.
- `db:sync_health` (server → client): `{ mode, healthy, everySeconds, lastSyncedAt, staleSeconds, consecutiveFailures, lastError }` — **only ever emitted on a health *change*, and to a newly-connected socket only when already unhealthy.** A healthy sync is silent, because an alarm that fires routinely gets ignored and this one has exactly one job. The server writes locally and pushes to the primary every 10s (see Database round-trips, Phase 5); a push that starts failing is invisible from inside the game — everything lands, everything is fast — until the container recycles and takes the unsynced backlog with it. `SyncHealthBanner` renders this as a red, non-dismissible banner. `healthy` deliberately stays true through a short run of failures (a single flaky cycle is noise) and flips only once the staleness passes ~6 sync windows.
- `identity:set` (client → server): `{ role: 'gm' }` or `{ role: 'player', characterId }` — sets `socket.data.identity` for this connection (validated: a `player` identity's `characterId` must resolve to a real character, otherwise it's dropped to `null`/unidentified). Drives declared-move visibility (see Combat Timing's identity-based reveal rule); sent once from the Role Modal on pick, and re-sent on every reconnect (roleContext.jsx) since identity lives only in memory per-connection, not persisted. No broadcast — this only affects what *this* socket receives afterward. **The server answers it with a fresh `combat:updated` addressed to that socket alone** (`emitCombatUpdatedTo`): identity is the one moment the server reliably hears "someone is back", and a *paused* pair emits nothing further of its own accord, so without this a client that was away when a pause was raised had nothing coming and no reason to ask. See *Pause delivery*.
- `move:declare` (client → server): `{ characterId, moveId, placementTic?, appendageChoice? }` — open access, same trust model as any other roll/declare in this app (declaring for a character isn't restricted to whoever's logged in as them — visibility is what's identity-gated, not the action itself). A no-op unless: `phase` is `'declaration'`; the character hasn't already pressed **Done Declaring** this round (`declared_this_round = 0`); their own `combat_pairs` row (keyed by their `pair_index`) has `declaring_side` matching their own `side` (**revised, combat redesign** — was a single arena-wide `declaring_side` check; now scoped to that character's own pair, so other pairs can be mid-Declaration independently — see Combat Timing above); the move is actually available to them (Default, or granted); if the move has a style, the character's **active** stance carries it (same learnability rule Tab 3 already dims by — checked against the active stance specifically, not "any stance" like `move:grant`'s rule); it's affordable — `current_stamina` minus every other move this character already has pending (not yet committed) this Declaration Phase, minus this move's own `stamina_cost`, must not go below 0 (see Stamina Cost above); and, if the move is ambiguous (`right_tell_id`/`left_tell_id` both set), `appendageChoice` is exactly `'left'` or `'right'` (see the Declaration Phase's Ambiguous moves bullet above) — for a non-ambiguous move, `appendageChoice` is simply ignored/stored as `null` even if one was sent. Computes the legal minimum Tic (`computePlacementTic` — the round's start Tic, or this character's own last-declared move's **full footprint end**, `reveal_tic + active_tics + recovery_tics`, if later, even from a previous round — **revised**, was Startup/reveal-only, see Combat Timing above for why); the "last-declared move" lookup joins `moves` to compute and order by that full-footprint end rather than raw `reveal_tic`. `placementTic`, if supplied (the drag-and-drop declare picker's drop Tic — see Combat Timing above), is used as-is when it's at or after that minimum, otherwise it's clamped up to the minimum instead of being rejected — omitting it entirely also just uses the minimum, so older/simpler callers keep working. `reveal_tic` (`computeMoveFootprint`, Startup-only) is computed from the resulting `placement_tic`, and a `declared_moves` row (including `appendage_choice`) is inserted. **Attack Target (Change 001, decided, new):** the same insert also snapshots `effective_attack_targets` — the move's current `attack_targets` expanded via `expandAttackTargets` using this declaration's own `appendageChoice` (both sides if the move has no ambiguous slot, or `appendageChoice` is null) — and `attack_target_source = 'move'`; written regardless of whether the move even has a Roll, since a Roll-less move simply never enters the damage/defense flow that reads it. Broadcasts `combat:updated` (see below — every connected socket gets its own tailored view based on its identity, computed fresh from the same DB rows); every viewer's `declaredMoves` entry always carries `appendageChoice` (and `tellId`/`rightTellId`/`leftTellId`), never withheld — only `moveId`/`moveName`/`staminaCost` are identity-gated.
- `move:undeclare` (client → server): `{ declaredMoveId }` — open access, same trust model as `move:declare`. A no-op unless the row exists, `phase === 'declaration'`, and `stamina_committed = 0` (i.e. that character hasn't pressed **Done Declaring** yet — see Cancelling a declared move above). Deletes the `declared_moves` row outright, and clears `feint_masked` on whatever this character had placed at the deleted move's own footprint end — taking a **Feint** back has to take its concealment back too (see the Feint Tag under Tags & automation). Broadcasts `combat:updated`.
- `combat:character_done_declaring` (client → server): `{ characterId }` — **replaces the Phase 7 `combat:side_done_declaring` (revised, combat redesign): declaring finishes per character now, not one shared press per side.** Open access, same trust model as `move:declare`. A no-op unless `phase === 'declaration'`, the character is seated and hasn't already finished (`declared_this_round = 0`), and their own pair's `declaring_side` matches their own `side`. Commits Stamina Cost for just this one character: sums `stamina_cost` across their still-uncommitted `declared_moves` rows, updates `current_stamina` (clamped `[0, max_stamina]`) if that sum is nonzero, marks those rows `stamina_committed = 1`, and broadcasts `character:updated` if anything changed. Sets `declared_this_round = 1` for this character. Then checks whether *every* character on this same side of this same pair has now finished: if so, flips that pair's `combat_pairs.declaring_side` to the other side — but only if that other side actually has anyone left who hasn't finished yet; otherwise (the other side is empty, or was already fully done) clears it to `null` instead, meaning this pair is fully done (no separate "pending side" field is needed to tell these two cases apart — see `combat_pairs` in the Data model above). Broadcasts `combat:updated`.
- `combat:start_tic_countdown` (client [GM] → server) — a no-op unless `phase === 'declaration'` and **every** `combat_pairs` row has `declaring_side = null` (**revised, combat redesign**: was a single arena-wide `declaring_side` check; now every pair must independently be fully done, since the Tic Countdown that follows is still one shared timeline for the whole arena even though Declaration itself now runs per pair). Sets `phase = 'tic_countdown'`, then runs `applyIdleTicStaminaRegen(current_tic)` for the round's own starting Tic (see Idle-Tic Stamina Regen above — catches a move-free start the same way this event already catches an already-due 0-Startup reveal, see `chat:move_reveal` below). Broadcasts `combat:updated`.
- `combat:tic_forward` / `combat:tic_backward` (client [GM] → server, **now triggered by left-clicking the Tic square immediately after/before the current one in the Arena's own Tic Counter, not separate ◀/▶ buttons — see Tic navigation above**) — a no-op unless `phase === 'tic_countdown'`. Adjusts `current_tic` by ±1; backward is clamped so it can't go before the current round's `round_start_tic` (moving further back into a previous round's history isn't supported); forward is clamped so it can't go past the round's last Tic (`round_start_tic + round_length - 1`) — that's where the Arena's small **Next Round** button takes over instead. Reveal state for every `declared_moves` row is recomputed live from the new `current_tic` (`isMoveRevealedTo`, stateless — nothing is cached, so stepping back re-hides a move that hasn't "really" happened yet, per Combat Timing above). `combat:tic_forward` also runs `applyIdleTicStaminaRegen(newTic)` for the Tic just entered (see Idle-Tic Stamina Regen above) — `combat:tic_backward` does not, the same one-directional asymmetry `postMoveReveals`'s chat cards already have. Broadcasts `combat:updated`.
- **Combat Automation (Phase 9, sub-phases 3-5 — see the mechanic section above for the full decided design, sub-phase 4's client UI breakdown, and build-order item 5 for exactly which move/trigger fires where):**
  - `combat:apply_damage` (client → server): `{ dieId, halfDamageSteps, attackerDeclaredMoveId? }` — 4.1/4.2's Damage Application dialog Stat click. **Attack Target (Change 001, decided, new) — checked FIRST, before anything else below:** whenever `attackerDeclaredMoveId` is present, looks up that declared move's current `effective_attack_targets` and silently no-ops the entire call (no die mutation, no Undo-buffer write, no chat line, no interaction automation) if `dieId`'s `slot_name` isn't in that set — a hard, server-authoritative restriction that a stale/hand-crafted Socket.IO payload can't bypass. No `attackerDeclaredMoveId` at all (manual/ad-hoc GM damage) skips this check entirely, unchanged from before this Change. Otherwise: calls `applyHalfDamage` (`server/gameLogic.js`) `halfDamageSteps` times in sequence against `dieId`'s current `{size, bonus, status, half_damage}` (a no-op if `halfDamageSteps` isn't a positive integer). Snapshots the die's pre-change state into a module-scoped single-level Undo buffer (shared game state, not per-socket — see `combat:undo_damage` below) before writing the change, overwriting whatever was previously buffered. Also posts a system chat notice ("`{characterName}` took `{damage}` damage to `{slotName}`.", 4's suggested audit-line addition). **`attackerDeclaredMoveId` (sub-phase 5, optional):** the roll card's own `declaredMoveId`, passed through by `DamageApplicationDialog` — when present and that declared move hasn't already had its interactions resolved (`declared_moves.interactions_resolved`, see the Data model above), fires its own move's `hit` trigger via `applyMoveInteractions` (self = the attacker, opponent = `dieId`'s own character) and sets the flag; omitted or already-resolved (e.g. a Partial Block's own reduced-damage Apply) is a no-op for this part. Broadcasts `die:updated`.
  - `combat:undo_damage` (client → server, no payload) — reverts the single most recent `combat:apply_damage` change (one level only, not a full history, matching the dialog's own "reverts the last change"); a no-op if nothing's buffered. Broadcasts `die:updated`.
  - `combat:resolve_defense` (client [GM] → server): `{ attackerDeclaredMoveId, attackerResult, defenderDeclaredMoveId, defenseType: 'block'|'dodge', outcome: 'successful'|'failed' }` — the GM's 2×2 prompt. `attackerResult` is the attacker's already-rolled total (from the roll card the reveal-time auto-Roll already posted — this event never rolls for the attacker). **Attack Target (Change 001, decided, new) — checked before anything else, whenever `defenseType === 'block'`:** the defending declared move MUST have `roll_type === 'stat'` and at least one `move_roll_slots` row, or the whole call is rejected outright (no chat notice, no defensive roll) — a Custom Roll move has no named Stat to become a replacement target, so it can never serve as a Block; this is the authoritative version of the same check `ResolveDefenseDialog.jsx` already makes client-side. Dodge is unaffected — it has no such requirement. First classifies frame overlap (`classifyDefenseCoverage`, 4.3) from the attacker's Active window (`attackerDeclaredMoveId`'s `reveal_tic`..`+active_tics`) against the defender's absolute Defense-tagged Tics (`defenderDeclaredMoveId`'s `placement_tic` + each of its move's `defense_frame_positions`) — a `'too-early'` result force-overrides `outcome` to `'failed'` server-side regardless of what was actually picked, so a stale/incorrect client can't bypass it. **Failed** (`outcome` or the force-override): posts a "`{defenderCharacterName}`'s Block/Dodge has failed." chat notice, fires the defender's own move's `defense_failure` trigger (sub-phase 5 — self = defender, opponent = attacker, unguarded), and returns — the attacker's own roll card (already posted) is still the Apply-button vehicle for the plain 4.1 Hit flow (which is what fires the attacker's own `hit` trigger, not this branch). **Successful:** rolls the defending move's own Roll — `move_roll_slots`, plus (if `is_defensive`) `move_defensive_roll_slots` concatenated on top (never deduped against the base slots even on overlap) — resolved to the defender's live dice via the declared move's own already-stored `appendage_choice` (no dialog to ask Left/Right again at this point), each die at `roll(size) + bonus + modifier` (`modifier` = the move's `roll_modifier` + any Perk `character_move_roll_bonuses` + Reasons to Fight, same ingredients `effective_roll_modifier` already folds together elsewhere) — a `roll_type: 'custom'` move rolls its `custom_roll_size` instead, same as anywhere else. Logs this roll normally (`logRoll`, no roll-context payload — a defensive roll never gets its own Apply button). Resolves `{attackerResult, defenderResult: blockResult}` via `resolveDefenseRoll` (`server/combatDamage.js`) and posts a "`{defenderCharacterName}` scored a Full/Partial Block/Dodge — `{damage}` damage." chat notice. **Attack Target (Change 001), Block only, Full or Partial alike:** before that chat notice, `attackerDeclaredMoveId`'s `effective_attack_targets` is overwritten with the blocking move's own **base `move_roll_slots` only** (never the `move_defensive_roll_slots` pool) expanded via `expandAttackTargets` using the blocker's own stored `appendage_choice`, and `attack_target_source` flips to `'block'` — written before `combat:defense_resolved` is emitted (see the payload note below), so a client never observes the broadcast without the underlying row already updated. Dodge never touches this. **Sub-phase 5:** fires the defender's own move's `defense_success` trigger every time (self = defender, opponent = attacker, unguarded — a defensive move can defend more than once), and — only if `attackerDeclaredMoveId` hasn't already had its interactions resolved — the attacker's own move's `block` trigger (self = attacker, opponent = defender), setting `interactions_resolved` so a later Apply of this same Partial Block's own reduced damage can't also fire `hit` on top. **Block only, when coverage was `'too-late'` (4.3):** adds `classifyDefenseCoverage`'s own `extensionTicsNeeded` onto `defenderDeclaredMoveId`'s `recovery_extension_tics` (see the Data model above), then finds every other `declared_moves` row belonging to the same character whose `placement_tic` now falls inside the newly-consumed window and emits `combat:move_conflict` for each (a previously-free Tic in that window is simply consumed, no event needed). Broadcasts `combat:updated` (so the extended Recovery is visible immediately — the existing Tic Counter/footprint rendering already reads `recoveryEndTic` straight off `declared_moves`, no new UI needed for that part) and `combat:defense_resolved` `{ attackerDeclaredMoveId, defenderDeclaredMoveId, defenseType, outcome, netResult?, halfDamageSteps?, damage?, coverage, conflictDeclaredMoveIds?, effectiveAttackTargets?, attackTargetSource? }` — the last two only present on a Successful Block (per the Attack Target note above), letting an already-rendered live roll card update in place via `attackerDeclaredMoveId` without a refetch; absent for Dodge and for Failed, since neither ever changes the snapshot.
  - `combat:move_conflict` (server → all clients) — **removed.** It carried a declared move whose placement fell inside another move's extended Recovery window and needed an answer. The pending conflict now rides `pairs[].pendingConflict` on the combat snapshot, where a reload or a reconnect picks it up for free; see *Pause delivery*.
  - `combat:resummon_pause` (client [GM] → server) / `combat:pauses` (server → that GM only): the manual escape hatch behind GM Tools' **Fight Pauses**. Read-only — it re-sends the snapshot to the caller and answers with `{ pauses: [{ pairIndex, roundNumber, status, kind: 'dodge'|'block'|'conflict'|'grapple', answeredBy, gmCanAnswer, summary, prompt?, conflict? }] }`, every open pause already shaped into the question it is asking, so the tool can raise the dialog from the server's own answer without going through the snapshot at all. `gmCanAnswer` is worked out server-side (always true for a defence call; for a conflict only when the fighter is an NPC; never for a grapple, whose two halves belong to the fighters). Grappling is listed but never carries its payload — the directions differ per viewer and are the mini-game.
  - `combat:resolve_move_conflict` (client → server): `{ declaredMoveId, blockerDeclaredMoveId, choice: 'forfeit'|'postpone' }` — 4.3's Forfeit/Postpone dialog. **Forfeit:** deletes the `declared_moves` row outright and, if its Stamina Cost was already committed, refunds it in full via a shared `adjustStamina` helper (mirrors `move:undeclare`'s cancel-before-commit behavior, but issued explicitly here since this can fire well past that window, mid Tic Countdown) plus a system chat notice. **Postpone:** recomputes `blockerDeclaredMoveId`'s current Recovery end fresh from the DB (not trusted from whenever the prompt first fired) and floors `declaredMoveId`'s `placement_tic` there via `Math.max`, recomputing `reveal_tic` through `computeMoveFootprint`. Either way broadcasts `combat:updated`; Postpone additionally re-checks whether the newly-shifted footprint now collides with yet another of the same character's declared moves and, if so, re-emits `combat:move_conflict` for each (the just-postponed move now standing in as the new `blockerDeclaredMoveId`) — the recursive cascade 4.3 describes.
  - `combat:check_interrupt` (client → server): `{ dieId, attackerDeclaredMoveId, halfDamageSteps, startupDeclaredMoveId }` — 4.4's Interruption roll-off, its own event rather than folded into the Hit path (nothing else in this sub-phase depends on that choice either way). `dieId` is the attacker's own chosen Stat (whose Stat this is was later settled by decision #8 — the *caught* fighter rolls, on their own move's Roll); `attackerDeclaredMoveId` feeds `computeInterruptBonus` (how many of the attacker's own move's Active frames have already elapsed, vs. `combat_state.current_tic`); `halfDamageSteps` is however many the hit that triggered this already dealt (4.1's own Apply flow is unaffected and still runs independently — this event never applies damage itself). Rolls `dieId` + the interrupt bonus + Reasons to Fight, logs it normally, and compares `result >= halfDamageSteps`. Broadcasts `combat:interrupt_resolved` `{ startupDeclaredMoveId, succeeded, result, threshold }` either way. **Both of those are historical.** This whole event was removed by the Cutscene Resolution overhaul (the engine runs the check itself, with no client event and no GM prompt), and the `>= halfDamageSteps` comparison it describes was later corrected to a contest of two attack rolls — see 4.4 above. **On success:** deletes `startupDeclaredMoveId` outright (Interrupted — reverts to Undeclared, "an implementation choice, not a design one" per the mechanic section), refunds **half** its Stamina Cost if committed (contrast with Forfeit's full refund — Interruption is involuntary, Forfeit a voluntary trade-off) with its own system chat notice, and broadcasts `combat:updated`.
- `chat:move_reveal` (server → all clients, **decided, restored — see the Chat Log mechanic above**) — a `kind='move_reveal'` `chat_log` row carrying only `character_id` + `move_id`, written by `postMoveReveal` in `roundResolution.js` for each declared move as the reveal loop flips its `reveal_posted` to 1 (which is what makes it idempotent — stepping the same Tic twice never re-posts). Broadcasts `{ id, kind, characterId, characterName, modifier: 0, dice: [], total: 0, move: { id, name, imageData, imageMimeType, startupTics, activeTics, recoveryTics, defenseFramePositions, staminaCost }, timestamp }` — field for field what `GET /api/chat` rebuilds by joining the move row at read time, so a live card and the same card after a reload are the same card, and so a GM fixing a typo in a move's name makes the whole log say the right thing. **No description and no `full`:** those are the gated half, and this is an unfiltered broadcast.
- `move:request_detail` (client → server) / `move:detail` (server → **the requesting socket only**) — the gated half. `{ moveId }` in; `{ moveId, move, reason }` back, where `move` is the complete row plus `interactions`/`tag_ids`/`roll_slots` (the shape `getMove` produces) or `null` with a `reason` of `'perk'` (this identity does not qualify — see `capabilitiesFor`), `'not_revealed'` (no `move_reveal` row exists for it, so the Perk has no claim on it) or `'deleted'`. Always answers, including when it refuses, so a client waiting on it never hangs. The client re-asks on every expand rather than caching forever, so a card reopened after the GM edited the move shows what the move is now.
- `chat:lane_snapshot` (server → all clients, **historical — nothing writes these any more; superseded first by `round_summary` and then by the restored `chat:move_reveal` above**) — a `kind='lane_snapshot'` `chat_log` row, posted automatically (no client action) once per newly-revealed `declared_moves` row, either the instant `combat:tic_forward` crosses its `reveal_tic`, or immediately from `combat:start_tic_countdown` for one already due the moment the countdown started (a 0-Startup move placed at the round's very first Tic — otherwise it would sit fully revealed with no card ever posted, since `postMoveReveals` only otherwise runs from `tic_forward`); `declared_moves.reveal_posted` still makes this idempotent per row, so oscillating the Tic counter back and forth across the same threshold never re-posts (`combat:tic_backward` never advances `current_tic`, so it can never newly cross one either). For each newly-revealed row, `postMoveReveals` now looks up that character's **current** `pair_index` and rebuilds the whole lane's snapshot fresh (`buildLaneSnapshotPayload`): every `declared_moves` row for **either side** of that pair that's already `reveal_posted = 1`, filtered to only those whose footprint (`placementTic`..`recoveryEndTic`) still `overlapsRoundWindow` the round active right now (a new pure helper in `combatTiming.js`, unit-tested — mirrors the live Tic Counter's own "only this round's window" scoping). Broadcasts `{ kind: 'lane_snapshot', pairIndex, roundNumber, roundStartTic, roundLength, moves: [{ declaredMoveId, characterId, characterName, characterType, side, moveId, moveName, imageData, imageMimeType, placementTic, revealTic, activeEndTic, recoveryEndTic, defenseFramePositions, description, staminaCost, full }], timestamp }` — `full` (same shape `getMove` produces) is fetched and embedded per move at post time, not re-joined at read time, so a historical row stays self-contained; `GET /api/chat` returns the same shape by simply parsing `chat_log.payload` (JSON) for a `lane_snapshot` row, no extra query needed. Rolling a revealed move (if it has a Roll) is unchanged and posts its own ordinary `roll:result` entry, separately — not merged into a snapshot. **Legacy:** `kind='move_reveal'` rows already in a live chat log (from before this redesign) are untouched and still render via the client's existing branch for that kind — see Chat Log mechanic above.
- `chat:message` (client → server): `{ characterId, text?, imageData?, imageMimeType? }` — posts a free-text chat entry attributed to `characterId` (defaults per role in the compose box — see Chat Log above — same PC-only-for-Players visibility as elsewhere); needs `text` or `imageData` (or both), a no-op otherwise; `text` is trimmed and capped at 2000 characters. **`characterId: null` means "post as GM" (decided):** stored using `GM_CHAT_SENTINEL_ID = 0` (a value `characters.id` can never take, since it's an autoincrement rowid starting at 1) instead of relaxing `chat_log.character_id`'s NOT NULL/FK; broadcasts `characterId: null, characterName: 'GM'` for this case, and `GET /api/chat` maps the sentinel back the same way on read. **Decided:** an image/GIF is attached either by pasting it directly into the compose box (a clipboard `paste` event on the textarea, checked for an image `DataTransferItem`) or via a paperclip file-picker button (`<input type="file">`, added specifically because clipboard paste flattens GIFs to a static frame — a browser/OS platform limitation, not a bug in the encoding pipeline) — same `fileToChatImage` client-side pipeline either way, since both a clipboard item's `getAsFile()` and a file input's selected file are ordinary `File` objects. GIFs arrive as their raw uploaded bytes (no server-side re-encoding — that's a client-side choice, see Chat Log above). Inserts a `kind='message'` row into `chat_log` (`dice_rolled` stored as `'[]'`), broadcasts `chat:message` `{ kind: 'message', characterId, characterName, message, imageData, imageMimeType, timestamp }` to all clients.
- `chat:clear` (client [GM] → server) — truncates `chat_log`, broadcasts `chat:cleared` to all clients. GM-only is enforced client-side only (the server has no concept of role, same as everywhere else in this no-auth app). Also runs automatically on every server boot (a real `DELETE FROM chat_log`, not just an incidental effect of Render's free tier sleeping).
- `GET /api/rules` — `{ markdown }`, the raw contents of `game_rules.md` at the repository root, read from disk **per request** (not cached at boot) so a deploy is all a rules edit needs. Unrestricted — the rules are the same for every role. Returns 404 with a plain human message if the file is missing from a deployment, which `RulesPage.jsx` shows as-is rather than as a blank page. See **Where the rules live** above.
- `GET /api/combat?role=gm` or `?role=player&characterId=5` — the arena's current state: `{ unevenCombatEnabled, roundLength, pairs: [{pairIndex, declaringSide, phase, roundNumber, currentTic, roundStartTic, relativeTic, isOverflow, overflowBy}], participants: [{id, character_id, side, pair_index, declared_this_round, reasons_to_fight, idle_regen_progress}], characters: {[characterId]: {character, dice, stances, moves}}, counters, declaredMoves }` (**revised, combat redesign:** `declaringSide`/`pendingDeclareSide` were replaced by `pairs` — one row per pair, since declaration now runs independently per pair rather than once for the whole arena. **Revised again, Combat Automation overhaul Phase B:** the top-level `phase`/`roundNumber`/`currentTic`/`roundStartTic`/`relativeTic`/`isOverflow`/`overflowBy` fields are gone entirely — that state now lives per-pair inside each `pairs[]` entry (camelCase — `shapePair` in `server/index.js` converts the raw `combat_pairs` DB row), since each pair now runs its own independent round/Tic clock (see Combat Timing above and `combat_pairs` in the Data model above). Note `pairs[]` is camelCase while `participants[]` deliberately stays the old raw-DB-row snake_case shape (`pair_index`/`character_id`/`side`/`declared_this_round`) — only `pairs[]` was reshaped. `participants[].declared_this_round` is the per-character flag the Declaration Lanes render — see Combat Timing above. `counters` = standalone ones plus any seated character's counter flagged Show in Combat; `characters[id].moves` = that seated character's available moves via `getMovesFor`, for the declare picker; `declaredMoves` is tailored to the `role`/`characterId` query params the same way `combat:updated` is tailored to a socket's identity — REST has no persistent connection to carry `identity:set` on, so the client passes its current identity as query params instead, omitting them if not yet identified). Fetched once on load and again on every relevant broadcast; live updates after that come from `combat:updated` (the full state, same shape minus `characters`/`moves`, recomputed fresh — and per-socket-tailored — on every relevant change, not a delta) plus the character sheet's own broadcasts (`character:updated`/`die:updated`/`stance:activated`), which the Arena page also listens for.
- `combat:add_participant` / `combat:move_participant` (client [GM only] → server): `{ characterId, side, pairIndex }` — both are the same upsert into `combat_participants` (a character can only hold one seat, enforced by `UNIQUE(character_id)`; add vs. move is purely which one the client happens to call). Broadcasts `combat:updated` — `{ unevenCombatEnabled, participants }`, not the resolved character data, which the client already has or fetches once via `GET /api/combat`.
- `combat:remove_participant` (client [GM only] → server): `{ characterId }` — deletes that character's `combat_participants` row. Broadcasts `combat:updated`. Deleting a seated character (`DELETE /api/characters/:id`) does the same cleanup automatically.
- `combat:adjust_reasons_to_fight` (client → server): `{ characterId, delta }` — +/- to that seat's `reasons_to_fight`, clamped to `[0, 3]`, open access (same trust model as `counter:adjust` — see Reasons to Fight under Combat Arena above). A no-op for a character who isn't seated. Broadcasts `combat:updated`.
- `combat:toggle_uneven` (client [GM only] → server) — flips `combat_state.uneven_combat_enabled`, broadcasts `combat:updated`
- `combat:clear` (client [GM only] → server) — "Clear Arena": clears all `combat_participants`, `declared_moves`, and `combat_pairs` (**Phase B:** `combat_state`'s own round/Tic timing fields are no longer touched here — they're unused, see the Data model above; round/Tic state now lives entirely on the `combat_pairs` rows just deleted. Also deletes every `pair_round_resolutions` row, cascading to `round_events`) — a full reset, not just seating. Broadcasts `combat:updated`
- `combat:end` (client [GM only] → server) — "End Combat", the other half of the global status strip's Start/End Combat toggle (see Combat Timing above). Same `declared_moves`/`combat_pairs`/`pair_round_resolutions` reset as `combat:clear`, plus resetting every remaining seated character's `declared_this_round` and `idle_regen_progress` back to 0 — but leaves `combat_participants` (and `reasons_to_fight`) untouched — the fight ends, the roster stays seated. Broadcasts `combat:updated`
- `perk:create` / `perk:update` / `perk:delete` (client [GM] → server): `{ name, description, imageData?, imageMimeType? }` / `{ perkId, ...same fields }` (image only replaced when provided) / `{ perkId }` — manages `perks` only (delete refused while granted to anyone — same "in use" pattern as Tells), broadcasts `perk:created` / `perk:updated` / `perk:deleted`
- `perk:grant` (client [GM] → server): `{ characterId, perkId }` — inserts into `character_perks`, then calls `PERK_HOOKS[perk.name]?.onGrant?.({ characterId, perkId, characterPerkId })` from `server/perkAutomations.js` if a manual hook exists for that Perk's name (no-op otherwise). Broadcasts `perk:granted` plus whatever the hook itself broadcasts.
- `perk:revoke` (client [GM] → server): `{ characterId, perkId }` — deletes any `character_move_tags` / `character_move_overrides` / `character_move_roll_bonuses` rows tagged with that grant's `character_perk_id` (in case a hook wrote any), then the `character_perks` row, then calls `PERK_HOOKS[perk.name]?.onRevoke?.({ characterId, perkId, characterPerkId })` if present. Broadcasts `perk:revoked` plus whatever the hook itself broadcasts.
- `perk_tag:create` / `perk_tag:update` / `perk_tag:delete` (client [GM] → server): `{ name, description }` / `{ tagId, name, description }` / `{ tagId }` — manages the world-level `perk_tags` list, **separate from the Move tag list below** (see Perks & Tags above for why); delete cascades off `perk_tag_links` with no in-use guard, since a Perk tag carries no mechanics. Broadcasts `perk_tag:created` / `perk_tag:updated` / `perk_tag:deleted`. Read over REST at `GET /api/perk-tags`; a Perk's own `tag_ids` ride on `GET /api/perks` and on each `perk:created`/`perk:updated` payload.
- `tag:create` / `tag:update` / `tag:delete` (client [GM] → server): `{ name, description }` / `{ tagId, name, description }` / `{ tagId }` — manages the world-level `tags` list (delete cascades off `move_tags`), broadcasts `tag:created` / `tag:updated` / `tag:deleted`
- `counter:create` (client → server): `{ characterId, name, targetPips, rewardType? }` — inserts into `counters`, broadcasts `counter:created`. `characterId: null` creates a standalone counter (the Arena's "+ New Arena Counter" form is the only GM-only-gated caller of this shape client-side; the server itself doesn't distinguish who's asking, same as everywhere else in this no-auth app). `rewardType` (one of `story`/`statistic`/`perk`/`move`/`combat_prowess`) is only ever stored when `characterId` is set — silently dropped to `NULL` for a standalone counter regardless of what's sent.
- `counter:adjust` (client → server): `{ counterId, delta }` — +/- to `current_pips`, clamped to `[0, target_pips]`, broadcasts `counter:updated`
- `counter:toggle_show_in_combat` (client → server): `{ counterId }` — flips `show_in_combat`, broadcasts `counter:updated`
- `counter:set_reward` (client → server): `{ counterId, rewardType }` — sets (one of the 5 values) or clears (anything else/omitted) a counter's reward tag; no-ops for a standalone counter (`character_id IS NULL`), same restriction as creation. Broadcasts `counter:updated`.
- `counter:delete` (client → server): `{ counterId }` — broadcasts `counter:deleted`

## Pages / views
Every page's header also carries, in order: the "Dogfight" logo (links to the Combat Arena — see item 5), the **Compendium** link (**decided, revised: visible to every role**, not GM-only — see item 4 below for what's actually GM-gated inside it), the **Characters**/**Character** link (visible to every role; labeled and routed per role — see item 2 below), the **Search bar** (see Global UI — Search above), the Chat Log toggle, and a **Cog icon** linking to **Settings** (item 7 below) — all persistent regardless of which page is open.
1. **Role-select modal** — shown on every fresh load, before anything else: "Player" or "GM". Not persisted.
2. **Character list** (home) — **decided, revised: no longer reachable by a Player.** The `/` route and the header's roster link both go straight to a GM's full roster or a Player's own sheet, per-role (see Roles / access model and the header description above) — this page itself, and its "+ Add Character" form, still exist and are unchanged for the GM, just no longer linked-to for a Player (direct navigation to `/` still resolves to their own sheet, not this page — there's no way to land here as a Player through the UI). Cards for each character, filtered by role (`pc` only for Player, all for GM — this filter is now moot for a Player since the page is unreachable, but stays in place rather than being ripped out); a nested, indented folder tree (`FolderTreeNav`, shared with the Compendium's Discipline nav) sits in a sidebar beside the grid — 🏠 All Characters at the root, every folder at every depth selectable, drag a card onto any row to file it there (dropping on root clears it), or — mobile/touch, see Mobile Readiness below — tap a card's ⇄ button to open the same choice as a picker dialog; the sidebar itself collapses into a "Change…" trigger below `md:`. Management (create/rename/delete, and either filing gesture) is **GM-only**: Players just browse whatever folders exist. Deleting a folder promotes its direct characters and direct child folders one level up to its own parent (root if it was already at root); if the folder being viewed is the one deleted, the view follows it up to that same parent. "+ Add Character" button (name only, plus a PC/NPC toggle and a folder picker — showing the full indented hierarchy — for GM; Players' new PCs always land at root; dice auto-seeded either way); each card has a **Delete** option that asks for confirmation first (it cascades — dice, stances, moves, inventory, injuries all go with it). Cards sit in a responsive grid, each with a fixed-size portrait area that the art fills edge-to-edge (cropped to cover, not letterboxed — no visible empty space around it regardless of the source image's aspect ratio), and a small folder-path chip ("📁 Fighters / Bosses") shows on any card filed in a folder, next to the NPC badge.
3. **Character sheet**, split into 6 tabs:
   - **Tab 1 — Core Stats:**
     - **Name** — simple editable text field, saved live
     - **Portrait** — image area; clicking it opens a file picker to upload/replace the character's picture (same click-to-change flow whether setting it the first time or changing it later)
     - **Lock in Stats** / **Revert Stats to Base** buttons — snapshot or restore all 8 dice against the character's locked baseline (see mechanic above)
     - **Dice pools** — since Phase 8 (Polish, pilot in progress — see below), the 8 dice no longer sit in three flat Head/Core/Legs panels: they're overlaid on a Vitruvian-Man backdrop (`client/src/assets/vitruvian-man.png` by default, low-opacity/inverted for the dark theme) as three horizontal rows that mirror the original Head(2)/Core(4)/Legs(2) pool grouping rather than tracing the artwork point-for-point (`ANATOMY` map in `CoreStatsTab.jsx`, keyed by `slot_name`) — Skull+Brain a symmetric pair straddling the vertical midline; Left Hand, Stamina, Body, Right Hand sharing one row at the hands' height (Stamina/Body visually grouped with the hands, same as the pre-Vitruvian layout); Left Leg+Right Leg a symmetric pair at the spread stance. Full-size dice (not shrunk), each carrying its own icon (skull/brain/fist/lightning bolt/heart-pulse/footprints) rendered *inside* the die itself — low-opacity, behind the die-size number — rather than as a separate overlay. Each die shown sized/styled by its die type (or greyed-out/scratched-out if incapacitated), tinted green/red (opacity scaling with the gap) when current differs from locked, with a green up-arrow and red down-arrow beside it to step size (a quick GSAP flash-pop plays on step); clicking the die itself opens a roll dialog asking for an ad-hoc modifier. **A small `½` toggle sits to the left of every die (decided, new — see Half-Damage under Stamina & Stat Lock above):** amber when marked, plain otherwise; a manual click is always just a raw on/off flip (`die:toggle_half_damage`) — the step-the-die-down-and-clear effect only ever happens via a future automated caller of `applyHalfDamage`, never from this click. One **Pool Roll** button for the whole sheet enters selection mode — tap any set of dice (regardless of where they sit on the figure), then roll them together with one shared modifier. **Custom Vitruvian art per character (decided):** a small GM-only upload button (an arrow-in-a-circle icon, `lucide-react`'s `Upload`) sits in the corner of the figure area; picking an image sets `vitruvian_image_data`/`vitruvian_image_mime_type` for that character specifically (same upload pattern as a portrait), replacing the default baked-in artwork just for them — rendered at `opacity-30` with no invert filter (unlike the default asset, which is inverted/dimmed for the dark theme, a custom upload is shown closer to as-provided). Not present at all for a Player viewing the sheet.
     - **Maximum Stamina** / **Current Stamina** — Max is computed from the locked Stamina die and the character's stamina multiplier; Current is tracked live and regenerates via a per-turn roll
     - **Inventory** — list of items, each with a name and an optional description (add/edit/remove; editing via a per-row pencil toggle)
     - **Injuries** — name + optional effect (add/edit/remove), like Inventory, plus an optional **die slot + rank penalty** (a dedicated `InjuryList.jsx`, not the shared `ItemList` Inventory uses, since Inventory has no equivalent fields): a slot dropdown (the 8 valid slots, or "No stat penalty") and, once a slot is picked, a penalty number input. An Injury with a slot+penalty shows a small red line under its name/effect (`-N rank(s) to {slot} on revert`). See Injuries under Stamina & Stat Lock above for what the penalty actually does (only takes effect on **Revert Stats to Base**, never live).
     - Both lists render stacked: bold name on top, description/effect under it in smaller grey text — and no second line at all when it's empty, so description-less entries stay compact
   - **Tab 2 — Stances:** list of the character's own stances (left-click to set active, highlighted when active; edit/delete per stance, minus the last-stance/active-stance rules above); **Stance Creator** to build a new one — name plus **pick exactly 2 of the 7 styles by clicking their nodes directly on the counter-chart graph** (decided, revised — was a separate list of icon-buttons; see Stances mechanic above), with a running "X/2 selected" hint; the counter chart itself (SVG tournament graph, highlighted for the active stance) with Best/Worst Matchups lists; active stance badge on the sheet header
   - **Tab 3 — Moves:** read-only list of the character's available moves (all Default moves + any Unique moves granted by the GM), rendered as full move cards per the decided structure (Tell header — both Tells side by side for a move with an ambiguous Roll, see Moves & Tells above —, move art + name + Stamina Cost badge + frame-data squares, discipline label (always shown — the discipline name if filed, "Without Discipline" if not), style/tag chips, Roll row, description, interactions with automation chips); shows this character's **effective** frame data and tags — base template plus any Perk-granted `character_move_overrides`/`character_move_tags` — with a ⭐ indicator when they differ from the shared template, plus any Perk `move_roll_bonus` (live if the move has a Roll, otherwise marked "not yet active"); a move with a Roll shows its live current dice as a clickable button (two buttons, one per side, for an ambiguous Roll) that opens the roll dialog, pre-filled and editable; Default/Unique badges; moves whose style isn't in the active stance render dimmed (unusable); GM can revoke a Unique move from here
   - **Tab 4 — Perks:** read-only grid (infinite rows, 2 columns) of granted Perks — picture, name, description per card (no automation data — see Perks & Tags above)
   - **Tab 5 — Counters:** the character's own counters, name on its own line (plus its reward tag, if any — see Counters above) then a full-width row — a minus button on the left, dot pips filled up to the current count out of target across the middle, a plus button on the right (both clamped to `[0, target]`) — each with a "Show in Combat" toggle; anyone controlling the character can create a new one here (name + target pips 2-20 + optional reward)
   - **Tab 6 — Role-play:** persistent free-text fields, each under a question the player asks themselves about the character. **Seven** canonical questions (what they love and can't pass by on the street; biggest traumatic event/memory; irrational fear; favorite food; what another person can do to infuriate them; biggest vice; and — **decided, new** — *what is something they would fight for, no matter what?*, the one question with a mechanic behind it: it is where a character's **Reasons to Fight** value comes from at the table). Appending to `FIXED_QUESTIONS` is always safe since answers are keyed by the question's exact text and nothing can be keyed to a question that didn't exist yet; *rewording* an existing one still orphans its answers with ~2-3-line answer boxes, kept compact so it all fits with little scrolling, plus the ability to add custom questions with answers — up to 20 additional per character (question editable, deletable). Same open-access editing as the rest of the sheet.
4. **Compendium** (**decided, revised: open to every role, read-only for Players**) — a single page holding every compendium as an internal tab, rather than a separate top-level nav entry per type (decided — this is the pattern for any compendium added later too). The page itself is no longer gated behind a `role !== 'gm'` redirect; each internal tab instead gates its own GM-only pieces (Creator forms, Tell/Tag managers, per-item Grant/Edit/Delete actions, drag-to-grant, the character-rail) individually, so a Player can browse folder nav, filters, and full cards on both tabs but can't create, edit, delete, or grant anything:
   - **Moves tab** — persistent library of every move; the Tell manager (name + uploaded image, placeholders replaceable, in-use Tells undeletable — "in use" now also covers a move's right/left ambiguous-Roll Tells, not just its base Tell) — **GM-only**; the Tag manager (world-level list, name + optional description shown as a tooltip everywhere the tag appears) — **GM-only**; disciplines (the folder mechanism, labeled "Discipline" in this UI, **nested** — the same `FolderTreeNav` sidebar as the character list: create/rename/delete at any depth, delete promotes direct moves and direct child disciplines one level up to the deleted one's own parent — browsable/navigable by everyone, but create/rename/delete/drag-to-file is **GM-only**), reorganized either via the Move Creator's discipline field (a select showing the full indented hierarchy) or by **dragging a move card onto a discipline row** (or onto "All Moves"/root to clear it), with "All Moves" showing every move regardless of discipline and the style filter narrowing whichever of "All Moves" or a specific discipline is showing (filter itself usable by every role); Move Creator form (**GM-only** — art upload, name, Default toggle, **Defensive toggle** — reveals two extra interaction sections at the bottom, On Successful Defense / On Failed Defense, once checked — either one Tell picker or — when the Roll includes a Left/Right Hand or Left/Right Leg slot — a Right Tell + Left Tell pair, a Style picker **required unless Default is checked, in which case it's hidden entirely and any picked style is cleared** (decided — see Moves & Tells above), optional Roll picker directly below Style — a **Stat/Custom** toggle first (decided, new — see Moves & Tells above): **Stat** toggles any of 6 slots (Skull, Brain, Left/Right Hand, Stamina, Body, Left/Right Leg) plus a flat bonus, empty = no Roll; **Custom** instead picks a single base die (d4-d12, small dice-icon buttons) plus the same flat bonus, for a weapon's own damage die — switching between the two clears whichever picks the other type had made —, Tag picker 0-10, discipline assignment, frame-data inputs with live colored preview, a required **Stamina Cost** field (0 is a valid free cost; negative restores Stamina instead of spending it — see Combat Timing above), description, On Hit/Block/Miss text + automation builders, always present); drag a move onto a character in the page's character rail to grant it (**GM-only** — per-move Grant checklist as touch fallback, with unlearnable characters disabled; the character rail itself doesn't render for a Player). Every move card shows its full discipline path and, when applicable, a small "Defensive" badge — visible to every role.
   - **Perks tab** — persistent library of every Perk, browsable by every role; Perk Creator (**GM-only** — picture upload, name, description — no automation builder, see Perks & Tags above); drag a Perk onto a character in the page's character rail to grant it (**GM-only** — per-Perk Grant checklist as touch fallback; the character rail doesn't render for a Player); delete blocked while granted to anyone. **Decided (revised): a Player can take a Perk for themselves** — a **Take / Drop** button on every Perk card grants or drops it on their own character (and **Drop** is repeated on the character sheet's own Perks tab, so putting one down does not mean going back to the library to find it), the mirror of the Moves tab's Learn/Forget and for the same reason: the library has been readable to Players since the page was opened to them, and asking the GM to tick a box was the only way to act on what you read. Unlike Moves there is no learnability gate, because a Perk has none — a Move's Learn can be closed by style and `perk:grant` has no equivalent rule. Automated (⚙) Perks are offered like any other; every grant is visible to the GM, and it is the same trust model as every other control in this app
5. **Combat Arena** — shared page, no map/tokens; reachable by clicking the header logo, visible to every role. A GM-only roster rail (not-yet-seated characters, role-filtered) to drag from, grouped by character folder recursively — see Combat Arena above for the full collapsible/counted/Folderless-last behavior; two side-by-side columns (Left/Right) of pair rows with a divider between pairs, a fresh empty row always available to start a new one. Seated cards **fill their side's full width with no unoccupied space** — a single occupant's card spans the whole side, and under Uneven Combat, adding more to the same side scales every card on it down evenly so the row always stays fully occupied (a per-card minimum width plus horizontal scroll is the fallback if a side gets too crowded to stay legible), rendered horizontally with a full-height portrait on the left (see Combat Arena above). Each seated character renders as a **read-only** card — portrait, active stance name, dice pools (grouped into the same 3 Head/Core/Legs rows as the character sheet's Tab 1, in that order, rather than one flat mixed row), Current/Max Stamina — showing a live red/green **preview** instead of the real value while this client itself has a declared-but-not-yet-committed move pending (see Stamina Cost above; red if the preview is lower, green if higher, plain otherwise; the preview now checks that character's own pair/side against `combat_pairs`, not a single arena-wide side — see the combat redesign below) — click the card to jump to the full sheet to actually roll/step, values here stay live via the same broadcasts the sheet itself uses; NPCs here are visible to Players as an explicit exception; a small ✕ (GM-only) removes one participant, a page-level **Clear Arena** button (GM-only) empties it entirely, including every declared move and the round/Tic state; a **Start Combat** button (GM-only, shown only while `phase` is null) rolls initiative and opens the first Declaration Phase — see Combat Timing above for how it and **End Combat** relate to Clear Arena. "Uneven Combat" toggle (GM-only; a read-only badge for Players when on) allows uneven pair sizes (dropping a character onto an occupied pair zone adds them rather than replacing). A **Counters** section lists every counter flagged "Show in Combat" for a currently-seated character (labeled `"{CharacterName} - {CounterName}"`, its reward tag if it has one shown read-only) plus standalone counters (labeled by name alone, never a reward tag); a small form creates a new standalone one (GM-only), but adjusting/deleting any counter shown here is open to everyone, matching the character sheet's own Counters tab.

   **Global status strip (decided; rewritten after the Combat Automation overhaul):** while a fight is on, a slim bar appears at the top of *every* page (`CombatHeaderBar.jsx`, mounted once in `App.jsx`'s `Shell`, not inside the Arena route — see Combat Timing above), showing the round number, **this viewer's own current state** instead of a generic phase label during Declaration (`viewerDeclarationStatus` — the GM sees a pair-count summary, e.g. "2 pairs still declaring…"; a Player sees their own seated character's status specifically: **"Your turn to declare!"**, **"Waiting for declaration…"**, **"Waiting on other declarations…"** once they've pressed Done Declaring, or **"Not seated in this fight"**), the same Tic Counter square visuals the Arena renders, and an **End Combat** button for the GM. **It is a status display, not a control** — nothing in it advances a round, because nothing does any more. Its one genuinely interactive job is carrying the dialogs that must reach someone regardless of which page they're on: the GM's **Dodge prompt** (`DodgePromptDialog`) and the affected player's **Forfeit/Postpone** prompt (`MoveConflictDialog`). Both are queued here rather than in the Arena precisely because a paused round cannot continue until they're answered, and the person who must answer may be anywhere in the app — verified end to end by `scripts/playtest-dodge.mjs`.

   **The Arena takes the width it is given (decided, revised).** The page was capped at `max-w-6xl` (1152px), which left most of a normal desktop window empty while the timeline and the seating rows squeezed into a column — a board, not prose, so the cap was simply wrong for it. The cap is gone. **The Tic squares themselves are deliberately NOT part of that (decided, reverted).** A responsive `TIC_SQUARE_SIZE` (44px → 56px at `xl` → 64px at `2xl`) was tried and taken back out: growing the squares with the window made the counter feel unmoored, and it bought nothing — a Tic is a fixed unit of game time, and its square should look like the same object on every screen. `TIC_SQUARE_SIZE` is a single fixed `h-11 w-11` at every viewport, still one shared constant because the `+N` overflow marker sits at the end of the same row and has to match it exactly. It is no longer shared with the declare card's frame bar, which is now deliberately much smaller (see Combat Timing's declare-picker bullet).
   - **The strip's own edges are not clipped (bugfix).** The Tic row carries a `mask-image` gradient as its horizontal-scroll affordance — content fades out at each end so a strip wider than its container visibly continues. With no padding inside the mask, the fade fell on the first and last *squares*, so Tic 1 and Tic 7 rendered permanently half-erased and looked cut off by the page. The row now carries `px-4` — wider than the 16px fade — so the gradient eats padding instead of content, and the affordance is kept rather than removed.

   **The Tic Counter is the Arena page's centerpiece (decided, combat redesign):** large, prominent, and centered on the page whenever `phase` is non-null — a strip of exactly **`round_length` Tic squares** (the current round's own Tics, nothing more — **decided**, after playtesting: a wider lookahead strip was tried and dropped; the strip itself never scrolls — it wraps rather than gaining a scrollbar, since 7 fixed-size squares always fit), the drag-and-drop **declare** target during Declaration. While dragging a move card, squares before that character's own next-eligible Tic (still finishing a move carried over from last round, say) shade as **blocked**; the live footprint preview (amber Startup, red Active, blue Recovery) clamps to wherever the drop would actually land, never to a Tic earlier than that — see Combat Timing above for the full drag/footprint-preview/snap-forward/carryover behavior. **Tic navigation:** there is none any more — the Combat Automation overhaul removed manual stepping entirely (`combat:tic_forward`/`combat:tic_backward` and the round's-last-Tic **Next Round** button are gone with it). A round resolves itself the instant both sides finish declaring, and each pair's own next round opens automatically; the strip's only interactive role now is as the drag target during Declaration. **Overflow indicator while declaring (decided, new):** if the footprint being previewed runs past the round's last Tic, an extra amber **`+N`** square is drawn at the end of the strip — the same size as a Tic square, so the strip reads as one continuous timeline rather than a truncated one. Hovering it previews the next round's first `N` Tics with the overflowing frames drawn in, which is the only way to see, *before* committing, exactly how much of the next round a long move eats. **Own-move footprint preview (decided, revised — self only):** while *this viewer* currently has the declare floor (their own turn as a Player, or one of the GM's currently-selected lane's not-yet-declared NPCs — see Declaration Lanes below), that **same character's own** already-declared moves for the current round additionally render as small colored square dots positioned under the Tic number, inside each square they cover (same 4-color scheme as `FrameBar` — Startup/Active/Recovery/Defense — plus a small legend), stacking up to 4 dots if that character's own moves overlap a Tic. **Explicitly not shown for any other character's moves, declared or not** — this is a self-service planning aid (so a character declaring a second move can see where their own first move already landed) rather than a window into anyone else's timing, even though the underlying fields (`placementTic`/`revealTic`/`activeEndTic`/`recoveryEndTic`/`defenseFramePositions`) are technically sent to every viewer for every declared move regardless of reveal status (only `moveId`/`moveName`/`staminaCost` are gated — see Combat Timing's Real-time events) — the client-side filter to `declaredMoves.characterId === own character's id` is what keeps this scoped correctly. **Cross-round overflow occupancy (decided, revised twice — now shown in its real phase colours):** independently of the above, and shown to **everyone** regardless of role or turn, any Tic at the start of the current round that's still covered by a *previous* round's move is marked in the square. **It is no longer a grey initial badge** — the first version drew a small circular badge bearing the character's first initial, which said "somebody's here" in a visual language belonging to nothing else on the strip and, being colourless, implied a carried-over move was a different, lesser kind of occupancy than a fresh one. It isn't: a carryover is an ordinary move mid-flight, and the strip already has a colour language for exactly that. Each such Tic now carries a thin bar across the top of the square, split into one segment per carrying move (up to 3), each painted in that move's **actual phase at that Tic** — the same amber/rose/blue/emerald `PHASE_BG` every other footprint on the page uses, via the shared `phaseAt` helper — with the character names still on hover and its own legend line. Only the phase is shown, never which move it belongs to, so this discloses exactly what it did before. Attributing this by name is safe: which character has *something* recovering here is never secret in the first place — their Tell card is already visible in the Move Band the whole time a move is pending — only the move's own identity/details stay hidden pre-reveal, same distinction Combat Timing draws everywhere else. This is general board-state awareness ("these Tics are already spoken for, and by whom"), not the per-character-only preview above, and is only ever built from earlier rounds' `recoveryEndTic` so it can never leak the current round's own still-secret placements — see Declaration Lanes below for what replaced the old Player-moves/NPC-moves bands that used to flank this Tic Counter.

   **Declaration Lanes (decided, redesign — replaces the old Player-moves/NPC-moves bands and the flat GM-only declaration status table):** the Tic Counter sits at the very top of the Arena page (above); directly under it is a compact **2-column table, one row per `pair_index`** — "lane" — in the *same order and sides as the seating rows below*, so several simultaneous fights stay legible instead of blurring into one long unsorted strip of cards. Each cell lists that side's seated character(s) by name (colored by the same **Declaring/Declared/Waiting for round start/Not yet** status the old table used, during Declaration only) with their own small declared-move cards underneath. **A declared move no longer disappears the instant Next Round increments `round_number` (decided, fix):** it stays visible in its lane as long as its own footprint is still live (`currentTic < recoveryEndTic`), not just for the round it was declared in. Visibility for such a carried-over entry follows the same viewer-entitlement rule the rest of Combat Timing already draws: the owner (the Player logged in as that character, or the GM for an NPC) always sees their own real frame data; anyone else sees the Tell-only secret face for as long as it's genuinely still unrevealed (**"if it was not revealed still, keep it unrevealed"**), and once it's already publicly revealed, no card renders for them at all for it anymore — the Tic Counter's own cross-round overflow badge (above) is what conveys "something's still occupying this Tic" to onlookers a round later, without re-disclosing frame-type detail nobody but the owner needs by then. A same-round entry is unaffected by any of this — unchanged "show it all round regardless of resolution state" behavior, including a **display-only, not-clickable** compact face once revealed (**decided, revised:** an earlier version let the GM click a revealed card open into the full `MoveCard`; removed — every role, GM included, only ever gets the compact face) and the same **Cancel button** while `stamina_committed = 0` (a small ✕ on the card's outer wrapper, calling `move:undeclare`, stops rendering once Stamina Cost commits). **Bugfix (QA pass):** the card list previously skipped rendering entirely for any entry whose `move` field was still `null` (i.e. genuinely secret from this viewer) — meaning nobody but a move's own owner ever saw a Tell at all in the Lanes, even though Tells were always broadcast to everyone. The card component's own fallback (render the Tell-only face whenever `move` is falsy) already handled this correctly; the Lanes' own render loop just needed to stop gating the call on `move` being truthy first. **Lane selection (decided — replaces the flat NPC status table):** clicking anywhere on a lane (GM-only) selects it as "active," highlighting it — instead of picking an individual NPC out of a flat list of every seated participant. Below the Lanes, one **`ActiveDeclarePanel`** (Default/Unique-tabbed draggable move picker, styled moves dimmed/excluded the same way Tab 3 does, plus that character's own **Done Declaring** button) renders per not-yet-declared NPC on the selected lane's currently-declaring side — plural, since Uneven Combat can have more than one NPC sharing a side; a Player-controlled character sharing that side is never offered here, same GM-can-only-drive-NPCs boundary the old table enforced, they just keep seeing their own single auto-shown panel on their own turn regardless of what lane the GM has selected. A Player never selects lanes at all — their own panel auto-shows exactly as before. If the GM hasn't selected a lane, or the selected lane's declaring side has no NPC left to declare for, a prompt shows instead. Post-overhaul the reveal itself is animated by `RoundCutscene` rather than prompting anyone: a revealed move with a Roll is rolled server-side by the engine and arrives as a `roll` round_event (plus its usual chat entry), so no Roll dialog opens for it at all. **Chat Log** — shared, live feed of rolls, lane snapshot cards, and free-text messages, updates instantly on every connected device; each entry shows the poster's avatar beside their name. **Roll entries (decided, redesign):** each die's line now shows the full breakdown — the raw die face, its flat bonus/modifier additions, then `=` and the final result in a visibly bolder/larger font (a multi-die roll's `Total` line gets the same treatment) — instead of folding everything into one same-weight formula-plus-result line. **The Dice Tray (decided, new — see the Chat Log mechanic above) sits directly above the compose box, part of the same bottom static container:** five very small d4-d12 icon buttons plus a shared +/- modifier stepper, for a quick roll not tied to any character's own die — clicking a size immediately rolls, attributed to whoever the compose box's own picker currently has selected. A compose box at the bottom lets anyone post free text and/or an attached image/GIF (character picker to attribute it, PC-only for Players), an empty send does nothing; a **Clear Chat** button (GM-only) empties it for everyone, and it also clears automatically on every server restart. **A lane snapshot card (decided, redesign — replaces the old single-move-reveal card) posts itself automatically** (no button, no manual step) every time any declared move's Tic Countdown reveal happens: a compact mini Tic Counter (colored per occupied phase — Startup/Active/Recovery/Defense) for that move's whole lane, with every currently-publicly-revealed move in the lane shown as a small labeled bar positioned/sized to its own footprint — PC bars above the strip, NPC bars below — so a NEW full snapshot posts on every reveal in that lane (never edited in place), building up a permanent, scrollable history of exactly how the lane's Tic Counter filled in over the round; clicking a move's bar expands the full move card behind the same Genius Observer confirm as before. A move later deleted from the Compendium still shows correctly, since `full` is embedded at post time rather than looked up live. Rolling a revealed move (if it has one) is completely separate — the same Roll button/dialog as anywhere else, landing as its own ordinary roll entry rather than folding into a snapshot card.
7. **Settings** (decided, new) — reachable via the header's Cog icon, visible to every role (no role-gating on the page or its settings so far). Two settings:
   - **Primary Color**: a row of preset swatches (Crimson/Azure/Violet/Emerald/Amber) plus a native color-picker swatch for a fully custom pick, and a "Reset to default" button — see Global UI — Visual Theme above for how a pick becomes the live `--color-brand-*` scale and persists.
   - **Cutscene Speed** (decided, new): a **0.1×–3×** multiplier on the round cutscene's per-event dwell, with a slider, the live multiplier, and a reset. Deliberately a *multiplier on the existing pace* rather than an absolute seconds-per-event: how long a round wants to take depends on how much happened in it, so scaling stays meaningful if that pace is ever retuned. **Client-side and per-device on purpose** (`localStorage`, `vtt-cutscene-speed`, alongside the brand hue in `client/src/lib/theme.js`) — how fast you like to read a log is a property of the person watching, not of the fight, so it never goes through the server and never changes anyone else's playback.

   Both settings persist per browser. More are expected to land here; nothing about the page structure is specific to either.
8. **Rules** (decided, new) — reachable via a Scroll icon next to the Cog (and from the mobile "More" menu, above Settings), visible to every role. See **Where the rules live** below.

## Implementation Phases (iterative — each ends with a deploy + playtest checkpoint)
Deploying only gets easier the earlier and more often it happens. Rather than one big build followed by one deploy at the end, each phase below should end with an actual deploy to Render/Turso and a quick real-device check, before starting the next phase.

**Phase 0 — Walking Skeleton**
- Vite+React frontend, Express backend, Turso connected, Socket.io wired end-to-end
- A trivial round-trip (e.g. one button that writes to Turso and broadcasts to all connected clients) deployed to Render
- Checkpoint: confirms hosting + DB + websockets all work together in production *before* any real feature gets built on top

**Phase 1 — Characters & Core Stats (Tab 1)**
- `characters` + `dice` tables, CRUD API, auto-seeded dice template
- Role-select modal, character list (role-filtered), creation form, delete-with-confirmation
- Tab 1 in full: name, portrait, dice pools (roll + step + tint), Lock/Revert, Max/Current Stamina, Inventory, Injuries
- Basic Chat Log (plain rolls only)
- Checkpoint: create a character, roll dice, take a hit, Lock/Revert, from two devices at once

**Phase 2 — Stances (Tab 2)**
- `attributes` + `attribute_counters` (seeded once the 7 are finalized) + `stances`
- Stance Creator, stance list, activate-on-click
- Checkpoint: build and switch stances live across devices

**Phase 3 — Moves, Tells & Compendium (Tab 3)**
- `tells` + `moves` + `character_moves`
- GM Compendium, Move Creator, drag-to-grant, Tab 3 read-only list
- Populate a handful of *real* Moves here rather than placeholders, per the risk notes above
- Checkpoint: grant a Unique move, confirm it shows up correctly

**Phase 4 — Perks & Tags (Tab 4)** — done
- `tags` + `move_tags` (landed in Phase 3) + `perks` + `character_perks` + `character_move_tags` + `character_move_overrides` + `character_move_roll_bonuses`
- GM Perks Compendium, Perk Creator (picture/name/description); grant/revoke is pure `character_perks` membership — the original generic automation registry (`perk_automations`/`character_perk_automations`, 5 automation types applied/reversed automatically) was built here, then removed post-Phase-6 in favor of manual, case-by-case `PERK_HOOKS` entries in `server/perkAutomations.js` (see Perks & Tags above)
- Tab 4 read-only grid; Tab 3 (Moves) still reads `character_move_overrides`/`character_move_tags`/`character_move_roll_bonuses` to show a character's effective (Perk-adjusted) frame data and tags, whenever a manual hook has written rows there
- Checkpoint: grant/revoke a Perk, confirm plain membership works and a manual `PERK_HOOKS` entry's effect (once one exists) applies/reverses cleanly — still pending real Perk content and a multi-device playtest; automated coverage (unit + integration + browser) is in place

**Phase 5 — Counters (Tab 5)** — done
- `counters` table (character_id nullable — the standalone-counter creation path arrived in Phase 6), character-owned CRUD + Show in Combat toggle
- Tab 5: create form (name + target pips 2-20); each counter is name on top, then one full-width row (minus, dot pips filled up to current, plus — both buttons clamped to `[0, target]`), Show in Combat toggle, delete
- Checkpoint: create/adjust a counter live across devices — automated coverage in place, pending a real multi-device playtest

**Phase 6 — Combat Arena (structure only, no timing yet)** — done
- `combat_state` (Uneven Combat toggle only for now) + `combat_participants`
- Drag-in/out via a GM-only roster rail, pairing UI (drag onto a pair row's side, divider between pairs, dropping onto an occupied side adds rather than replaces), Uneven Combat toggle, ✕ remove + Clear Arena
- Read-only simplified participant cards (portrait, active stance, dice, stamina), live via existing character/die broadcasts — no roll/step controls on the card itself, click through to the sheet instead
- Standalone counters (GM-only creation) + Show-in-Combat counters (seated characters only) displayed and adjustable here
- Checkpoint: GM sets up a fight, Players see simplified NPC stats live — automated coverage (unit + integration + browser) in place, pending a real multi-device playtest

**Phase 7 — Combat Timing (the hard part — isolate before integrating)** — done
- ~~Build and unit-test the placement/reveal/overflow math on its own first~~ — done: `server/combatTiming.js` + `server/test/combatTiming.test.js`, a bare pure-function module with no UI/socket/DB wiring yet (see Combat Timing mechanic above for the exact functions; the placement-blocking floor was originally Startup/reveal-only, later revised to the full footprint — see Combat redesign follow-up 4 below)
- ~~Then: `declared_moves`, per-side Brain initiative, Declaration Phase sequencing, Tic Countdown with GM forward/back, live reveal-vs-Tell filtering, Next Round flow, wired into the Arena~~ — done: schema + `combat:next_round`/`move:declare`/`combat:side_done_declaring`/`combat:start_tic_countdown`/`combat:tic_forward`/`combat:tic_backward` + the Arena's status bar/declare picker/Tell-vs-revealed badges (see Combat Timing and Combat Arena above)
- ~~Extend Chat Log with move-reveal-plus-roll cards~~ — done: a compact card (portrait, name, `FrameBar`) posts itself automatically to the Chat Log the instant a declared move reveals (`chat:move_reveal`, idempotent via `declared_moves.reveal_posted`); rolling the move is unchanged (same Roll button/dialog as everywhere else) and lands as its own separate ordinary roll entry, not merged into the card — see Chat Log above
- Checkpoint: run one full mock round end-to-end, including an overflow case — done server-side (`scripts/e2e.mjs`'s Phase 7 section: Next Round → Declaration → side-lock → Tic Countdown → reveal (incl. its chat card, exactly once even after oscillating the Tic back and forth) → re-hide on backward → Next Round with overflow carrying → explicit-`placementTic` declares (honored and clamp-forward) → `combat:end` (roster stays seated) → Clear Arena) and visually in the Arena/Chat UI (Playwright); still pending a real multi-device playtest
- ~~Combat redesign: global Tic Counter header, Start/End Combat, drag-and-drop declare~~ — done after playtest feedback: round length bumped 5→7 Tics; the round/phase status bar, Done Declaring, Next Round, and Tic ◀/▶ moved out of the Arena page into a global header shown on every page while `phase` is non-null (`CombatHeaderBar.jsx`, mounted in `App.jsx`'s `Shell`); a Start/End Combat toggle wraps the round loop without changing it (`combat:end` is new, `combat:clear`/"Clear Arena" unchanged); the dropdown-based declare picker was replaced with drag-and-drop (Default/Unique-tabbed move cards dragged onto the header's Tic strip, live footprint preview, `move:declare`'s new optional `placementTic` honored-or-clamped-forward) — see Combat Timing and Combat Arena above for the full mechanic and event-contract changes. Alongside this: a DB perf pass (parallelized/batched several combat handlers that were doing sequential per-participant round trips — `move:declare`, `combat:side_done_declaring` — plus a few redundant re-fetch-after-write patterns elsewhere) and the move-reveal chat card now expands on click to show the full description (see Chat Log above).
- ~~Combat redesign follow-up: real per-character identity, Tic strip fixes~~ — done after further playtest feedback: (1) the Tic Counter header's footprint-preview Recovery color fixed to blue (was a dark red, easy to confuse with Active); (2) the header's Tic strip trimmed to exactly `round_length` squares (a lookahead buffer beyond the round was tried and dropped), with blocked-Tic shading while dragging so a carried-over character's occupied Tics at the start of a new round are actually visible, not just enforced silently; (3) the move-reveal Chat Log card's expand-on-click now gates behind an honor-system "Genius Observer Perk?" confirm (see Open Items); (4) the Role Modal now asks *which character* a Player is (a scrollable PC list, GM unchanged) instead of just "Player" — the server tracks this per-connection (`identity:set`) and tailors `combat:updated`/`GET /api/combat` per viewer, replacing the old `declared_move:own` side-channel with real (if still trust-based) declared-move secrecy: a Player sees their own character's moves early, the GM sees NPC moves early but not Players' — see Roles / access model and Combat Timing above for the full rules.
- ~~Combat redesign follow-up 2: Stamina UX, ambiguous-move Roll flow, Tic-1 secrecy bug~~ — done after another playtest pass: (1) dropping a move onto the Tic Counter that the character can't afford now shows a local "Not enough Stamina" toast instead of just silently failing (the server's authoritative rejection is unchanged, this is purely a friendlier client-side pre-check — see Stamina Cost above); (2) a move whose Roll has an ambiguous Hand/Leg slot now asks Left/Right via a popup at declare time, and its Roll dialog auto-opens for the controlling player at reveal time — see the Declaration Phase and Tic Countdown Phase bullets above, and `declared_moves.appendage_choice` in the data model; (3) the header now names a declaring side by its characters' actual names (`joinNames` — "A", "A and B", "A, B and C") instead of literal "Left"/"Right"; (4) the Arena's declared-move flip cards now filter to the *current* round only, instead of accumulating every round's moves forever; (5) Start Combat (the very first Next Round of a fight) now restores every seated character to full Stamina, so a fresh fight always starts from a full bar regardless of leftover Stamina from an earlier encounter; (6) fixed a real secrecy leak: a 0-Startup move declared at a round's very first Tic satisfied its own reveal condition (`current_tic >= reveal_tic`) immediately, during Declaration Phase itself, before the other side had even finished declaring — `mapDeclaredMovesForViewer`'s non-owner reveal check now also requires the round to have actually reached Tic Countdown Phase (or be from an earlier round, which is always safe), and `combat:start_tic_countdown` now posts any already-due `chat:move_reveal` cards immediately instead of only from `combat:tic_forward`.
- ~~Combat redesign follow-up 3: move-reveal cards expand to the full move~~ — done: `chat:move_reveal`/`GET /api/chat` now carry a `full` field (the move's complete raw row plus `interactions`/`tag_ids`/`roll_slots`, same shape `getMove` produces) alongside the existing compact fields; past the Genius Observer confirm, `ChatPanel.jsx` renders the actual `MoveCard` component (fetching Tells/Tags/styles/disciplines itself, same pattern as the Arena/Moves tab) instead of the old bare description-plus-Stamina-Cost text — see Chat Log mechanic above.
- ~~Combat redesign follow-up 4: full-footprint declare-blocking, cancel before commit~~ — done after further playtest feedback: (1) a real bug fix — the Declaration Phase's placement-blocking rule was letting a character declare a brand-new move while an earlier one of theirs was still Active or mid-Recovery, since the floor only ever considered the previous move's Startup/reveal Tic; `computePlacementTic`'s floor (renamed `previousRevealTic` → `previousBlockedUntilTic`) and `move:declare`'s "last declared move" lookup now both use the full footprint end (`reveal_tic + active_tics + recovery_tics`) instead — this **corrects**, not extends, the original Phase 7 rule (see Combat Timing above); (2) a declaring player can now cancel an uncommitted declared move and declare something else instead, via a new open-access `move:undeclare` event (a no-op once `stamina_committed = 1`) and a ✕ button on the Arena's flip cards, positioned outside the flip animation so it stays visible on whichever face is currently showing.
- ~~Combat redesign follow-up 5: per-pair async declaration, Tic Counter as Arena centerpiece~~ — done after a significant playtest request: (1) **declaration now runs independently per pair, not once across the whole arena** — the original Phase 7 rule computed one Initiative comparison for "the whole left side" vs. "the whole right side" of the *entire* roster, forcing every pair's losing side to declare together as one literal batch even when different pairs had nothing to do with each other; a new `combat_pairs` table (one row per `pair_index`, `declaring_side` scoped to just that pair) replaces the old single arena-wide `combat_state.declaring_side`/`pending_declare_side` (now unused, left in place since migrations here are additive-only), and `combat:next_round` resolves `resolveSideInitiative` once per pair instead of once for the whole roster — `combatTiming.js` itself needed no changes, it was already side-agnostic; (2) **declaring finishes per character, not per side** — the old single "Done Declaring" press per side was replaced by `combat:character_done_declaring`, which commits just that one character's own Stamina Cost and marks them done; a pair's `declaring_side` only flips once every character on the currently-open side has individually finished (this is also what makes Uneven Combat's multi-character sides declare at their own pace rather than all-or-nothing); (3) a GM-only **declaration status table** shows every seated participant's live status (Declaring/Declared/Waiting for round start/Not yet — see Combat Timing above) across every pair at once, since several can be mid-Declaration simultaneously now; clicking an eligible NPC row makes it the GM's "active" character for the declare picker, letting the GM switch between open NPCs one at a time instead of every open picker showing at once; (4) **the Tic Counter moved from the global header into the Arena page itself, as its visual centerpiece** — large and central, with small Player-move and NPC-move card rows flanking it above/below; the global status strip (`CombatHeaderBar.jsx`, still shown on every page) was slimmed down to round/phase/pair-count plus the GM's round-level controls only, since a drag-and-drop declare gesture only ever happens on the one page with both a drag source and target anyway; (5) declared-move cards are now **compact by default post-reveal** (name + `FrameBar` + Tell, small) for every viewer — full `MoveCard` detail is a GM-only click-to-expand, matching the existing Chat Log pattern where a Player needs the Genius Observer gate for full info instead; (6) re-verified the Tic-1 (round's very first Tic) reveal/display path end-to-end against the new UI — the underlying server reveal logic was already correct (confirmed via a targeted repro before starting this batch), the concern turned out to be entirely addressed by the from-scratch Arena rewrite. `scripts/e2e.mjs` gained a dedicated multi-pair test block (two pairs declaring genuinely simultaneously, independent per-character Stamina commits, per-pair auto-flip, `combat:start_tic_countdown` gated on every pair) alongside updating every existing Phase 7 test to the new per-character/per-pair event names.
- ~~Combat redesign follow-up 6: round start Tic no longer replays a skipped round's declarations~~ — done after a reported bug: pressing **Next Round** without ever stepping the Tic Countdown forward in the previous round (e.g. right after **Start Tic Countdown**, or after only a partial countdown) left `current_tic` at or near the previous round's own `round_start_tic`; since `round_start_tic = current_tic` was applied verbatim, the new round could start at the very same absolute Tic the old one did, making that round's already-declared (but never resolved) moves wrongly "occupy" the same Tics again — declaration wasn't actually local to the round it was declared in. Fixed with a new pure function, `computeNextRoundStartTic` in `server/combatTiming.js`: the new round's start Tic (and `current_tic`, kept in sync with it) is floored at `max(current_tic, round_start_tic + round_length)` whenever there was a previous round, so a fresh round's window can never overlap the one before it regardless of how far the GM actually stepped the countdown; the very first Start Combat press (`phase` null) is unaffected and still starts wherever the counter sits. Genuine cross-round overflow — a move whose full footprint ends later than this floor — still carries through exactly as before, since `computePlacementTic` takes the max of the two independently. See the Declaration Phase bullet and `combat:next_round`'s event-contract entry above.

**Phase 8 — Polish** — in progress
- ~~Tailwind styling, Framer Motion transitions, GSAP effects, fighting-game theme — piloted on the character sheet first~~ — done: piloted per the plan's own recommendation to nail the direction on one representative area before rolling it out everywhere. Framer Motion + GSAP became real dependencies here. Shipped: the sheet's tab bar (sliding underline, animated tab-content transitions) and Tab 1 — Core Stats' Vitruvian-Man dice layout (see Tab 1 above), plus supporting die-widget/portrait/stamina motion touches.
- ~~Fighting-game visual pass: red/black palette, cut corners, Rajdhani everywhere, drag-slam + heavier animations~~ — done after a positive reaction to the pilot: the user asked to push the direction further (red/black palette, sharper edges, Rajdhani "everywhere," more animation on drops/dice/stance-changes) and, unlike the pilot, explicitly chose to roll it out **everywhere in one pass** rather than pilot it again — see the new Global UI — Visual Theme section above for the full decided conventions (palette/corner/font rules, the `DropSlamGhost` drag-release effect, and the rest of the animation additions).
- ~~Clear Chat button + auto-clear on server boot~~ — done ahead of schedule, alongside free-text chat messages and image/GIF posting (see Chat Log above)
- ~~Chat/access/UX playtest batch: default chat poster, GIF file-picker, Player nav narrowed to own sheet, custom Vitruvian upload, Compendium open to Players read-only, Stance-graph click-picker, Default moves lose Style~~ — done after another playtest pass, seven items plus two more raised mid-batch: (1) the chat compose box's character picker now defaults instead of requiring a pick — a Player always posts as their own logged-in character, the GM defaults to a generic **GM** persona (`GM_CHAT_SENTINEL_ID` sentinel row) but can still pick any character; (2) a paperclip file-picker button was added beside paste for chat images, since pasting a GIF from the OS clipboard reliably flattens it to a static frame (a platform limitation, not an app bug) while a real file selection preserves the true GIF bytes/MIME type; (3) a Player no longer has a nav path to the character-list page — the header's roster link and the `/` route both go straight to their own sheet under a **Character** label, GM unaffected; direct-URL access to another sheet is unchanged; (4) a GM-only upload button on Tab 1 lets a character's Vitruvian-Man backdrop be replaced per-character (`vitruvian_image_data`/`vitruvian_image_mime_type`), falling back to the shared default art otherwise; (5) the Compendium page dropped its GM-only page-level gate — Players can browse both tabs read-only, with Creator forms/managers/Grant-Edit-Delete/drag-to-grant still individually GM-gated; (6) the Stance Creator's style picker was replaced with click-to-pick directly on the `StanceGraph` SVG (`onNodeClick`, an invisible larger hit-circle per node) instead of a separate list; (7) a Default move can no longer carry a Style — the Creator hides/clears it when Default is checked, and the server forces `style_attribute_id = NULL` for any `is_default` move regardless of payload (a one-time migration nulled existing rows). Raised mid-batch and shipped alongside: cancelling an uncommitted declared move, and full-footprint declare-blocking (both covered under Combat redesign follow-up 4 above, since they're Combat Timing changes rather than Polish).
- ~~Visual-pass playtest batch: scrollbar fixes, multi-select style filter, Settings/color-picker page, Defense Frames, declared-move Tic Counter preview, popup readability, Tic-forward clamp~~ — done after a playtest pass on the fighting-game visual pass, nine items: (1) the character sheet's tab bar (and a couple of Combat Arena strips) had a spurious vertical/horizontal scrollbar from `overflow-x-auto` implicitly forcing `overflow-y: auto` per the CSS Overflow spec — fixed with an explicit `overflow-y-hidden` (or dropped entirely for the Tic Counter's own row, which now wraps rather than scrolls, since 7 fixed squares always fit); (2) every remaining scrollbar in the app is now themed instead of the OS default (see Global UI — Visual Theme above); (3) the Compendium's style filter became multi-select/OR'd instead of single-select (see Moves & Tells above); (4) a new Settings page (Pages / views item 7 above) with a Primary Color picker, the first real use of the color-customization groundwork from the visual pass; (5) **Defense Frames**, a new green frame-data annotation insertable at any position in a move's Startup/Active/Recovery sequence (see Moves & Tells above) — purely additive, `combatTiming.js` untouched; (6) the Tic Counter now previews already-declared moves' frame footprints (including still-secret ones, since their timing was already non-secret) for whoever currently has the declare floor; (7) the GM's declared-move detail popup widened and became click-anywhere-to-close (except interactive buttons) instead of a narrow, backdrop-only-closeable window; (8) the GM's Tic ◀/▶ controls are now clamped and disabled at the round's first/last Tic, both client-side and server-side (a real bug — `combat:tic_forward` had no upper bound before); (9) `vttprojectplan.md` updated throughout to match.
- ~~Combat/rules playtest batch: Reasons to Fight, Idle-Tic Stamina Regen, Initiative ties, declared-move popup removed, Tic navigation redesign~~ — done after another playtest pass, five items: (1) **Reasons to Fight**, a new 0-3 per-seat counter on each Arena participant card (up/down arrows) granting +1 to all of that character's rolls per point while combat is active (`combat_participants.reasons_to_fight`, folded server-side into `die:roll`/`pool:roll`/Brain Initiative — see Combat Arena above); (2) **Idle-Tic Stamina Regen**, a new rule granting +1 Stamina for every Tic a seated character has nothing declared covering at all, built modularly from the start (`combat_participants.idle_regen_progress` + `perkAutomations.js`'s new `IDLE_STAMINA_REGEN_HOOKS` registry, parallel to `PERK_HOOKS`) so a future Perk can require more idle Tics per point instead of the base 1:1 rate — see Stamina & Stat Lock above; (3) **Initiative ties are now fully specified** instead of the old arbitrary `left`-declares-first default: tied top roll → highest current Brain → highest locked Brain → Speed in active stance (only if it actually narrows the field) → random, scoped to only the character(s) who actually posted the tied roll — see the Declaration Phase's Initiative ties bullet above; (4) the GM's click-to-expand full `MoveCard` popup on a revealed declared-move card is gone — every role now only ever sees the same compact face; (5) **Tic navigation redesign** — the global status strip's ◀/▶ step buttons are gone; the GM now steps the Tic Countdown by left-clicking the square immediately after/before the current one directly in the Arena's own Tic Counter, with a small **Next Round** button taking the "next square"'s place once the counter reaches the round's last Tic; the status strip in exchange gained a read-only copy of the Arena's own Tic Counter squares (the exact same `TicSquare` component, exported for reuse) and this viewer's own current declaration state ("Your turn to declare!" / "Waiting for declaration…" / etc.) in place of the old generic phase text.
- ~~Combat/rules playtest batch 2: carried-over moves stop disappearing, automatic per-round Stamina Regen, Declaration Lanes~~ — done after a playtest pass with several simultaneous pairs, three items: (1) a declared move whose footprint is still live no longer vanishes from view the instant `combat:next_round` increments `round_number` — the owner keeps seeing their own real frame data across the round boundary, a not-yet-publicly-revealed move still shows its Tell-only face to everyone, and once it's already publicly revealed a non-owner simply stops getting a card for it (the existing cross-round overflow badge on the Tic Counter is what still tells them a Tic is spoken for, without re-disclosing frame-type detail); (2) **Stamina Regen is now automatic**: `combat:next_round` itself rolls every seated character's Stamina die and adds it to Current Stamina (clamped to Max) on every round from the 2nd on, no button press needed — round 1 is still the existing Start Combat full-restore, and this coexists independently with Idle-Tic Stamina Regen from the previous batch; the manual `stamina:regen` button is unchanged, just now a supplement rather than the only path; (3) **Declaration Lanes** replace the old global Player-moves/NPC-moves bands and the flat GM-only declaration status table with a compact 2-column table — one row per `pair_index`, in the same order/sides as the seating rows — so several simultaneous fights stay readable; the Tic Counter itself moved to the very top of the page, above the Lanes; the GM now clicks a lane (instead of an individual NPC out of a flat list) to select it, and every not-yet-declared NPC on that lane's currently-declaring side gets its own declare panel — a Player-controlled character sharing a side under Uneven Combat is never offered to the GM this way, same boundary the old table enforced.
- ~~Combat/rules playtest batch 3: Tell visibility bugfix, roll breakdown, header Tic Counter parity, lane snapshot chat cards, carryover QA~~ — done after a playtest pass on the Lanes/header/chat work from the previous two batches, five items: (1) **bugfix** — the Declaration Lanes' render loop was skipping a declared-move card entirely whenever its `move` field was still `null` (a still-secret entry), instead of falling through to the card component's own Tell-only fallback face; the fix is a one-line removal of that gate, restoring the already-documented "everyone sees everyone's Tell, only the owner sees the real move early" behavior (see the Declaration Lanes bullet above); (2) **chat roll cards now show their working**: each die's raw face, its flat additions, and the final result (bold/larger font) instead of one flat formula-plus-result line (see Chat Log mechanic above); (3) **the global header's Tic Counter is now the exact same interactive `TicCounterCentral` the Arena renders**, not a stripped-down read-only copy — same overflow badges, and the GM can click-to-step the countdown from any page now, not just the Arena (see the Global status strip bullet above); (4) **the Chat Log's move-reveal card redesigned into a cumulative per-lane Tic Counter snapshot** (decided, replaces `chat:move_reveal` going forward — old rows still render): a mini colored Tic strip plus a labeled bar per currently-public move in the lane (PC bars above, NPC bars below), a brand-new snapshot posted on every single reveal in that lane rather than editing one in place, so the chat log ends up with a full round-by-round history of the lane's Tic Counter — see the Chat Log mechanic and `chat:lane_snapshot` bullets above, and the new `overlapsRoundWindow` pure helper in `combatTiming.js` (unit-tested) that scopes a snapshot to the round currently on screen, same as the live counter; (5) **second bugfix, same root-cause family as (1)**: the client-side "did a move just reveal" watch that opens the auto-Roll dialog was pre-filtered to the current round's own `declaredMoves` before checking `revealTic <= currentTic`, so a carried-over move (declared last round, revealing this round or later) could never trigger it — `revealTic` is absolute regardless of which round declared the move, so the round pre-filter was simply removed (see the Tic Countdown Phase's auto-Roll bullet above). Verified end-to-end via a live multi-round socket scenario (a Startup-8 NPC move carried across three round boundaries before finally revealing, confirmed correctly Tell-only to its non-owner across every carried round, correctly triggering the GM's auto-Roll dialog on the exact Tic it finally revealed, and correctly accumulating across four lane-snapshot posts) plus a Playwright visual pass confirming header/Arena Tic Counter parity and the dice-breakdown/lane-snapshot chat rendering.
- ~~Multi-role playtest pass: 3 simultaneous browser sessions (GM + 2 Players) through a full combat round~~ — done, the closest autonomous approximation of "multiple devices" available without an actual human at each seat: 3 independent Playwright browser contexts (separate storage/socket connections, same as separate devices) picked GM/Rook/Vex and were driven live through seating, per-pair declaration, Tic Countdown, reveal, rolling, and damage application, screenshotting each viewer at every step to check cross-viewer behavior a single-tab pass can't exercise. Found and fixed one real bug: **`CombatHeaderBar.jsx`'s auto-roll-queue effect could silently seed its "already revealed" baseline from an incomplete `combat` snapshot** — its `combat:updated` socket handler merges onto whatever `combat` currently is (`{...prev, ...c}`), and if a socket broadcast arrived before the initial `GET /api/combat` REST fetch resolved, `prev` was still `null`, so the merge produced a bare partial object; if that partial state happened to be what triggered the auto-roll effect's very first run, it would seed the "don't retroactively prompt" baseline off unreliable data instead of the real snapshot — silently marking a move "already seen" without ever prompting, indistinguishable from a legitimate missed-before-tab-opened reveal. Fixed defensively with a new `initialLoadDoneRef`, gating the auto-roll effect until the real REST snapshot has actually landed (this specific race wasn't reproduced in the pass itself — the actual symptom chased down during this playtest turned out to be a broken test fixture, an invalid roll-slot name in the playtest's own seed data — but the race is real and was worth closing while investigating). Everything else passed clean: per-pair async declaration and Tell-only secrecy held correctly across all 3 simultaneous viewers (each Player saw their own move early, only the Tell for the other's, GM saw neither early), both Players got their own correct auto-roll dialog on live reveal with no cross-talk, chat (rolls, lane snapshots, damage lines) stayed in sync across all 3 tabs, and GM-side damage application propagated live to both Players' chat views.
- Final full-system playtest across multiple devices — still needs an actual human at each seat; the scripted 3-browser pass above is the closest automatable substitute, not a replacement

**Phase 9 — Combat Automation** — all 5 sub-phases done
- Full decided design in Game mechanic — Combat Automation above: automatic Hit damage from a move's Roll result, a Damage Application dialog (Vitruvian Man + Half-Damage-step arrows + Undo), a GM Block/Dodge/Successful/Failed prompt with Partial/Full resolution, the attack/defense Frame-overlap rules (auto-fail-too-early, Block's Recovery-extension + Forfeit/Postpone cascade, Dodge's stricter full-coverage-or-fail), a damage-triggered Interruption mechanic for a hit landing during Startup, and (sub-phase 5) the On Hit/Block/Miss/Successful-Defense/Failed-Defense automations actually executing.
- Recommended build order (see the end of that section), same methodology Phase 7 used for the placement/reveal/overflow math: ~~pure/unit-tested damage-and-frame-overlap math~~ — **done** (`server/combatDamage.js`: `computeHitDamage`, `resolveDefenseRoll`, `phaseAtTic`, `classifyDefenseCoverage`, `computeInterruptBonus`, and sub-phase 5's `clampRecoveryExtension`; 22 unit tests) — ~~schema~~ — **done** (`move_defensive_roll_slots`; `chat_log.payload`'s roll-context shape documented; `declared_moves.recovery_extension_tics`, added during sub-phase 3; `declared_moves.interactions_resolved`, added during sub-phase 5) — ~~socket events~~ — **done** (roll-context attachment on `pool:roll`/`dice:roll_custom`; `combat:apply_damage`/`combat:undo_damage`; `combat:resolve_defense`; `combat:move_conflict`/`combat:resolve_move_conflict`; `combat:check_interrupt` — see Real-time events above for every contract) — ~~client UI~~ — **done** (the chat roll card's Damage/Apply line, `DamageApplicationDialog`, the GM-only `ResolveDefenseDialog`, `MoveConflictDialog` — see build-order item 4 above for the full breakdown) — ~~wire the automations~~ — **done** (`applyMoveInteractions`, wired into `pool:roll`/`dice:roll_custom` for `miss`, `combat:apply_damage` for `hit`, and `combat:resolve_defense` for `block`/`defense_success`/`defense_failure` — see build-order item 5 above for exactly which move/trigger/self-vs-opponent rules were decided). Manually QA'd live: sub-phase 4's browser pass (Playwright-driven, a real `combat:tic_forward` reveal with a tab already connected and watching) plus sub-phase 5's direct-socket pass covering all 5 triggers and the `interactions_resolved` double-fire guard, and a second browser click-through confirming the client-side wiring specifically — not just covered by the pure-math/server test suite (130/130 passing unchanged). Both QA passes are what surfaced the two real bugs fixed across this phase — see the notes right after this section's status paragraph above.
- Depends on the Half-Damage toggle (Stats & Stat Lock above) and the Custom Roll type (Moves & Tells above), both already built ahead of this phase specifically to support it.
- **Change 001 — Attack Target — done.** Full decided design in Game mechanic — Attack Target above: a Move-level restriction on which Stats its damage may land on, Successful-Block target replacement, and server-authoritative enforcement in `combat:apply_damage`. Schema (`moves.attack_targets`, `declared_moves.effective_attack_targets`/`attack_target_source`); pure functions (`sanitizeAttackTargets`/`expandAttackTargets`/`parseConcreteAttackTargets` in `server/moveLogic.js`, unit-tested — `server/test/moveLogic.test.js`); socket events (`move:create`/`move:update`'s `attackTargets`, `move:declare`'s declare-time snapshot, `combat:resolve_defense`'s Block-only replacement + Custom Roll rejection, `combat:apply_damage`'s hard enforcement, `GET /api/chat`'s batched reload enrichment — see Real-time events above for every contract); client UI (`MoveCreator.jsx`'s picker, `MoveCard.jsx`'s display line, `ResolveDefenseDialog.jsx`'s disabled Block tile, `ChatPanel.jsx`'s and `DamageApplicationDialog.jsx`'s effective-target line + dimmed-Stat enforcement preview). A migration test (`server/test/migrationAttackTarget.test.js`) confirms every legacy Move/declared move backfills to exactly `['Skull']` and that a fresh empty selection survives a server restart untouched. Deliberately out of scope, deferred to a separate future item: correcting Dodge's own Full/Partial math (today's Dodge still shares Block's math, which contradicts the deferred item's own "no Partial Dodge" rule) — see the mechanic section above for exactly what's deferred and why.
- **Change 002 — Mobile Readiness — done.** Full decided design in Game mechanic — Mobile Readiness above: viewport/safe-area CSS foundation, a shared `DialogShell` every dialog now routes through, a mobile app shell (bottom nav, default-closed Chat with an unread badge, a connection-state banner), reconnect/resume resync (`useSocketRefresh`), tap alternatives for every previously drag-only gesture in the Combat Arena and the character/Discipline folder trees, a full touch-target/hover-only audit (44px minimum, `.hover-only-action`), an image-payload trim (`vitruvian_image_data` dropped from any multi-character response), an installable PWA (manifest + a shell-caching service worker), and a 5-project Playwright mobile device matrix (`playwright.config.js`, `e2e-mobile/`). No game rule changed — this Change is purely about every existing mechanic being reachable and legible on a phone.

**Phase 10 — Combat Automation overhaul ("Cutscene Resolution") + Rebrand — all phases (R, A-F) done.** Full decided design in the "Combat Automation overhaul" subsection above (end of the Combat Automation mechanic section). Phased build order, per-phase status, and each phase's own verification step are tracked there rather than duplicated here.

**Post-overhaul playtest batch — done.** Five items from the first real fights run on the finished engine, each documented in its own mechanic section above rather than only here:
- **Counter bonus halved** to ±1 per won cross-pair (Stances & Attributes): an ideal counter-pick is now a 6-point total swing (+3/−3) instead of 12, so a matchup tilts a roll rather than deciding it. `initDb` re-points any row still on the old default.
- **An appendage Roll slot may be taken twice, meaning both sides** (Moves & Tells): a Straight Block guards with both hands. Two is the ceiling; taking a slot twice answers its Left/Right question, so such a move needs one Tell and is never asked which side. Stored as a `count` on `move_roll_slots`/`move_defensive_roll_slots`.
- **The Block/Dodge toggle is discoverable** (Combat Automation overhaul, Phase A): relabelled "Defense type" and shown for every Defensive move — disabled with a hint before any Defense Frame exists — instead of only materializing once one was placed.
- **The mobile bottom nav stays up while Chat is open** (Mobile Readiness): tapping Chat again is the way out, and the other three destinations stay reachable.
- **Two engine fixes from one root cause** (Combat Automation): a defence-pure move — Defensive with no Attack Target — no longer runs the attack flow, which is what produced a spurious "no eligible target" notice; and an attack with an empty Attack Target no longer bails before defence resolution, which had been silently skipping the whole Block (no Recovery extension, no conflict prompt) and made Change 001's own "a Successful Block gives the attack a target" rule unreachable. The Recovery extension a late Block earns is now **announced in chat and painted on the cutscene timeline** in the Block's colour at 30% lower opacity — visible, but still never a prompt (decision #1 stands).

## Pause delivery (decided, reworked)

**Reported from the table:** *"all GM prompts break if the GM is not present at
the exact moment of resolution. If the GM was using a phone and locked it, the
prompt is never shown and the fight becomes corrupted, without the ability to
proceed further."*

The pause itself was never the problem. A pause has been DB-durable since
Phase D — `pair_round_resolutions.status` plus the matching `pending_*_json`
column — and it survives a crash, a redeploy and a cold start. What was missing
was any way of getting the question back in front of a person afterwards.

**Why it failed, precisely.** The prompt travelled as a one-shot socket event
(`combat:dodge_prompt` / `combat:block_prompt` to every GM, `combat:move_conflict`
to everyone), which the client queued into a local array. Three separate holes,
and live play found all three at once:

1. A one-shot event only ever reaches the sockets connected at that instant.
2. A paused pair, by definition, emits nothing afterwards — so there is no
   second chance and nothing to catch up on.
3. `CombatHeaderBar` — the one component that mounts every prompt — re-read the
   combat snapshot **only on mount**. It had no reconnect or resume path, so a
   dropped socket coming back learned nothing.

And a fourth, smaller but the same shape: the queue was shifted the moment a
button was *clicked*, so an answer that never reached the server took the
question away with it.

**The rule now: a pending question is a function of server state, and of
nothing else.** Grappling's prompt has worked this way since it was built, and
it is the one prompt nobody ever reported losing — so the rest were rebuilt into
its shape rather than the other way round.

- **One author for the question.** `defensePromptPayload(pending, kind)`
  (`server/roundResolution.js`) turns a stored pause into the exact object the
  dialog reads. Both pause writers push it, and `shapePair` hangs the identical
  object on the pair in every snapshot — so the live question and the recovered
  one cannot be worded differently. The client used to re-derive `coverage` and
  `targetSlotName` from the raw pause JSON itself, in two places, and only one
  of them matched the push.
- **The snapshot is the only channel.** The three one-shot prompt events are
  gone. `pairs[].pendingDodge` / `pendingDefense` / `pendingConflict` /
  `pendingGrapple` are how a prompt is delivered, full stop — one place to read
  it from and one place for it to be wrong. They remain `round_events`, which is
  what the cutscene and the stored replay read.
- **Raising a pause broadcasts it.** `broadcastPause(io)` is called by every
  pause writer, rather than trusting whichever socket handler happens to be on
  the stack to remember afterwards. The engine cannot import `server/index.js`
  (which boots a listening server at module load), so the broadcaster is hung on
  the Socket.io server object it already holds: `io.emitCombatUpdated`.
- **Identifying is resyncing.** `identity:set` now answers with a fresh
  snapshot addressed to that socket. Identity is re-sent on every reconnect
  (roleContext.jsx), which makes it the one moment the server reliably hears
  "someone is back" — and the moment a locked phone, a tunnel or a Render cold
  start is recovered from.
- **`useSocketRefresh` in `CombatHeaderBar`**, so a reconnect or a tab returning
  from the background re-reads the snapshot from the client's end too. (Fixing
  that hook's own first-connect bug was part of this — see Mobile Readiness.)
- **A dialog no longer takes itself down.** It stays up until the server stops
  reporting the pause. Clicking disables the buttons and says "Sending your
  call…"; if nothing comes back within 8 seconds it says so and re-enables them.
- **Defence prompts are GM-only on the wire**, not merely hidden client-side.
  They carry the attacker's roll total, and `shapePair` now withholds them from a
  Player socket outright. The conflict prompt stays on the shared shape — it is
  the affected fighter's call, and the client filters it by ownership.

**And a manual escape hatch, because "should never happen" is how this was
found.** GM Tools grew **Fight Pauses** (`combat:resummon_pause` →
`combat:pauses`, GM-only): it asks the *server* what is paused and can raise the
dialog from that answer, sharing no plumbing with the path it is backing up. A
fallback wired through the same pipe is only a second go at the same failure.

**Verified** by `scripts/playtest-pause-delivery.mjs` — two GM connections, one
of which is disconnected before the round reaches the guard and reconnects
afterwards — plus a browser pass in which the server is killed and restarted
underneath a live GM tab, which is a genuine socket drop (Playwright's
`setOffline` only stalls TCP; the socket survives and the packets arrive late)
and the Render cold start this document has always flagged as a risk.

## Game mechanic — GM Tools (decided, new)

A small circular widget overlaid on every page, GM-only. Tapping it darkens
**and blurs** everything behind and opens a list of GM tools — the blur is
deliberate: it puts the page out of focus rather than merely dimming it, so
the sheet reads as a mode you're in rather than one more panel competing with
a live page. Deliberately a *list*, because this exists to
be the GM's drawer for the next tool too — Roll Requester was the first, Fight
Pauses the second.

Mounted in `App.jsx`, not on any page, so it is reachable from anywhere;
GM-only client-side, the same trust model as every other GM-only control here
— the server checks the GM role for itself, so hiding the widget is a
convenience, not the boundary. Sits above the mobile chat overlay (still
useful there) but below any modal dialog, which is a decision you're already
in the middle of.

- **Closing the Roll Requester used to white-screen the whole app (bugfix).** `useEffect(load, [])` — where `load` is `() => getCharacters().then(setCharacters)` — hands React the **Promise** `load` returns, and React files it as the effect's *cleanup function*. Tearing the effect down then calls it: `TypeError: destroy is not a function`, thrown from inside React's commit phase, which unmounts the entire tree and leaves an empty `#root`. The teardown happens when the component unmounts — i.e. exactly when the GM closes the tool, which is how it was reported. Now `useEffect(() => { load(); }, [])`. The whole client was swept for the same shape; this was the only instance.
- **And the app grew its first error boundary** (`client/src/components/ErrorBoundary.jsx`, wrapping the router in `main.jsx`). There was none anywhere before, so *any* component throwing during render or commit took the whole table's app down with it, mid-fight, with no clue what happened and no way back but a manual reload. It is deliberately one boundary at the very top rather than per-page: the failure mode it exists for is "something nobody predicted threw", and per-page boundaries only catch the pages somebody remembered to wrap. Reload is the only offered action, and it genuinely recovers — all real state lives on the server and arrives over the socket.
- **Fight Pauses (the second tool, decided, new).** Everything the fight is
  currently waiting on, asked of the server directly rather than read off the
  combat snapshot the dialogs normally come from, with a **Summon the prompt**
  button that raises the dialog from that answer. It exists for one situation:
  a pause is open and no dialog ever appeared. See *Pause delivery* above for
  why that situation was possible, and for the work that should mean it no
  longer is — this is the belt to that braces. Each entry says whose call it is;
  a conflict belonging to a Player and either half of a grapple are listed but
  not summonable, because the GM cannot answer them. With nothing paused it says
  so plainly, which is itself the useful answer half the time.
- **Roll Requester (the first tool). Optional target number (decided, new):**
  the GM can give the request a number to beat. The roll then resolves itself
  — the server compares the total and posts `X's Brain check — 14 vs 12:
  PASS` — instead of the GM eyeballing a total against a number in their
  head. **The number is held server-side against the request id and never
  sent to the player being asked**: a check whose difficulty you can see is a
  different thing to attempt, and the verdict is posted publicly the moment
  they roll anyway. GMs get it back so their own widget can show what they
  asked for. Left blank, the request behaves exactly as it always did. The
  pending target lives in memory rather than the DB (and expires after 30
  minutes) — unlike a Dodge pause, *nothing waits on it*, so losing one to a
  restart costs only the verdict line and never blocks anything; the roll
  itself is unaffected.
- **Roll Requester (the first tool).** Pick a player character, then pick one
  of the 8 Stats; that character's player gets a prompt **wherever they are in
  the app** (`RollRequestPrompt.jsx`, also globally mounted — the combat
  header bar, the app's other global mount point, only exists during a fight,
  and a roll request is not a combat feature). Answering it runs an ordinary
  `pool:roll` on that character's own die, so the result is an ordinary chat
  roll with every usual server-side bonus already folded in. **This adds no
  roll mechanic — only a way to ask.** The player can Decline; an
  incapacitated Stat says so instead of offering a roll.
  - `roll:request` (GM → server): `{ characterId, slotName }`, rejected unless
    the socket's identity is the GM and the Stat is a real die slot.
  - `roll:requested` (server → that character's player sockets **and** every
    GM): `{ requestId, characterId, characterName, slotName, dieId, size,
    bonus, status }`. Not a broadcast — a request naming a character is that
    player's business, the same fail-closed filtering every other targeted
    push here uses. The GM copy is a confirmation notice (so a second GM tab
    isn't blind), not a prompt: they are not the one being asked to roll.
  - Requests queue one at a time, like the Dodge and move-conflict prompts, so
    two requests in a row can't silently drop the second.

## Where the rules live (decided, new)

The rule book players read in-app is **`game_rules.md` at the repository root**
— an ordinary Markdown file, served by `GET /api/rules` (read from disk per
request, so a redeploy is the only thing a rules edit needs) and rendered by
`RulesPage.jsx` at `/rules`.

**Why a repo file and not database rows:** the rules are authored, versioned,
diffed, and reviewed exactly like the rest of the project; they are the same
for every table, since this app hosts one game rather than arbitrary systems;
and nobody needs to edit them from inside a session, which is the only thing
DB storage would buy. Putting them in the database would add a schema, an
editor UI, and a second place for the truth to live, in exchange for an
editing story that a text file already handles better. The GM-editable,
per-table config that *does* belong in the database is the separate
`/api/ruleset` (Styles and their beats-graph) — different thing, different
endpoint, deliberately not merged.

**The rule book is now a complete ruleset, not a summary (decided, rewritten).** It was a reference sheet for mechanics that already existed; it is now the book someone could actually learn the game from, opening with what the game *is* and closing with how a fight ends. Writing it meant deciding four things the project had never settled, all chosen deliberately:

- **Character creation:** every Stat starts at **d4**, and the character spends a budget of **8 step-ups** wherever they like (one step = one die size). Eight spread evenly is all-d6, a fighter with no holes and no edge; four into one Stat is a d12 specialist with five d4s behind it. **The app was seeded to match**: new characters' dice now default to d4 instead of d8 (`dice.current_size` default, plus `createCharacter`'s Max Stamina computation), and the GM spends the budget with the sheet's existing step controls — no new UI. Only affects characters created from here on.
- **Defeat: the GM calls it.** There is deliberately no hit-point threshold and no mechanical "you are out" line. The dice already say everything — an incapacitated Skull, no Stamina and both hands at d4 is plainly finished — and a character one Tic from that, standing in front of the right person, may very well not be. The app tracks damage precisely and takes no view; a table that wants a hard line agrees one up front.
- **Zero Stamina:** you can still fight, but only with moves that cost nothing. Not down, not penalised — your good options are gone until idle Tics and the round-start roll buy them back. **This required no code**: `move:declare` already rejects anything the pool can't pay for, so "only free moves" is what the existing gate already produces. The rule now says so out loud.
- **Rolls outside a fight:** the GM names a difficulty before the roll and you beat it, on the same 5-point granularity damage uses (5 awkward / 8 difficult / 12 you shouldn't manage this). Reasons to Fight and the Stance matchup are combat bonuses and deliberately do **not** apply.

**No tables.** The rendering vocabulary is headings, paragraphs, lists, blockquotes and emphasis, and the two places a table was tempting (the Stat glossary, the difficulty ladder) are written as lists instead — which also avoids a horizontally-scrolling table on a phone. If the rules ever genuinely need tables, swap the renderer for a real parser rather than growing the local one.

**`##` headings are the contract.** The page splits the document on them and
builds its section list from them; anything under a `##` (including `###`
sub-headings) belongs to that section, and everything before the first one is
treated as a note to whoever edits the file, not shown to players. The file's
own header comment says so, so the constraint travels with the thing it
constrains.

**Presentation:** sections rather than one long scroll — "what does a too-late
Block do again?" is a lookup, not a read-through — with a section list
(sidebar on desktop, a horizontal chip row on mobile) and its own full-text
**search**. The search is not redundant with the browser's Ctrl-F: only one
section is mounted at a time, so Ctrl-F cannot see the other eight. Results
list every matching section with up to three highlighted lines of context,
and clicking one opens it.

The Markdown renderer is small and local (headings, paragraphs, ordered and
unordered lists, blockquotes, bold/italic/inline code) rather than a library:
that is the whole vocabulary the rule book uses, and a CommonMark dependency
would be more surface than the feature is worth. If the rules ever need tables
or images, swap it for a real parser rather than growing this one.

## Game mechanic — Counters from a roll card (decided, new)

Counters lived in two places that had nothing to do with each other — a
character's own Counters tab and the Arena's standalone ones — so ticking one
up after a roll meant leaving chat, finding the right screen, and coming back.
Every **roll** card in the Chat Log now carries a small `+` opening the same
data where the roll actually happened (`CounterAdjustDialog.jsx`). Only on a
roll: a plain message or a replay card has no "this just happened, tick
something" moment behind it.

Two sections: the **roller's own counters** always, and the **Arena's counters**
as a separate section only while a fight is running (there is nothing for them
to track otherwise). Any counter can be incremented or decremented, and either
section can create one — "the counter I want doesn't exist yet" being the most
common reason to be there at all. A character-owned counter flagged Show in
Combat appears in both server payloads, so the Arena section filters out
anything already listed above it rather than showing one counter twice with
two sets of buttons. Reuses the existing `counter:create`/`counter:adjust`
events unchanged; creating an Arena counter (`characterId: null`) stays
GM-only, matching where that already lives.

**Second post-overhaul playtest batch — done.** Five more items off live play, each documented in its own mechanic section above:
- **The cutscene is near-fullscreen and its log reads as sentences** (Combat Automation overhaul), and a finished round's replay now outlives the fight that produced it — `fight_number` scopes resolution uniqueness so completed rounds can be kept without blocking a fresh fight's round 1.
- **The Stance matchup is automated** (Stances & Attributes): a flat bonus on all rolls, exactly like Reasons to Fight, omitted only for a side that isn't exactly one fighter (the original "omitted under Uneven Combat" reading was a bug and has been corrected — see the Combat Arena section).
- **GM Tools + the Roll Requester** — a new always-reachable GM widget and its first tool.
- **Insignificant Damage is split from Miss** (Combat Automation): a sub-5 roll lands and does nothing worth counting, and says so; a Miss is an attack evaded by a Dodge, and the On Miss trigger moved there. (Superseded in part — see the Combat Timing section's own Insignificant Damage rule, which later made a weak attack fire **On Hit** and, crucially, still be blockable/dodgeable.)
- **Counters are reachable from the roll card that earned them** — a `+` on every chat roll.

**Third post-overhaul playtest batch — done.** Eight more items off live play, each documented in its own mechanic section above:
- **The rules are readable in-app** — a Rules button beside Settings, sectioned with its own search, reading `game_rules.md` from the repository (see **Where the rules live**).
- **Mobile Chat behaves like the tab it is** and the Core Stats sheet fits a phone (Mobile Readiness): navigating away closes Chat, the redundant ✕ is gone, and the 4-wide dice row that clipped both Hands off a 390px screen is now 2/2/2/2 below `sm:`.
- **The "VS" divider is shown at every size**, not just mobile (Mobile Readiness / Arena).
- **Declaration reads at the strip's own scale** (Combat Timing): a dragged move's frame data is drawn Tic-square-sized, and your own declared move's full card is available as an overlay.
- **A move that overflows the round says so while you place it** (Combat Timing): a `+N` square at the end of the strip, hover-previewing the next round's frames.
- **Block works when placed on the attack's own Tic** (Combat Timing) — or rather, it says why it doesn't: a Defense-Frame set that never overlaps the attack now reports `no-overlap` by name instead of resolving silently, and every defensive roll reaches the cutscene.
- **Cutscene playback speed is a Setting** (0.1×–3×, per-device), and **the cutscene's typography scales with its now much larger window**.

**Fourth post-overhaul playtest batch — done.** Five items, each documented in its own mechanic section above:
- **The Arena and the cutscene use the whole window** — the `max-w-6xl` cap is gone, the cutscene timeline is fluid, and the declaration squares scale on wide viewports.
- **A proper ruleset** — `game_rules.md` rewritten as a book someone could learn the game from, settling character creation, defeat, zero Stamina and out-of-combat rolls; the app's starting dice were changed to d4 to match what the creation rule now says.
- **A seventh Role-play question** — *what is something they would fight for, no matter what?*, the one with Reasons to Fight behind it.
- **A Block that catches the opening frame is no longer called "too late"** — renamed `too-short` and rephrased as the success it is.
- **Combat animations** — attack lunges, block aura, dodge weave, insignificant-damage fizzle, a genuinely massive 2+ step impact, and the move's Stamina cost flashing on reveal.

**Fifth post-overhaul playtest batch — done.** Five items, three of which take back work from the batch immediately above — the fluid-sizing pass was a wrong turn and is recorded as one rather than quietly patched. Each is documented in its own mechanic section above:
- **The Tic Counter is a fixed-size object again, and no longer clipped at its own edges** (Pages / views — Combat Arena). Scaling the squares with the viewport is now an explicit *don't*; the "cut-out at the sides" was the scroll-affordance mask fading the first and last squares, fixed with padding wider than the fade rather than by dropping the affordance.
- **The cutscene's cells are fixed again too** (Combat Automation overhaul), and the Stamina flash is no longer eaten by the move-name cell's `truncate` — it was being clipped, not stacked behind anything.
- **Carried-over moves are drawn like any other move** (Combat Timing / Combat Arena): a new `carryover` round_event opens each resolution with whatever is still in flight, so the cutscene shows those Tics in their real phase colours instead of nothing at all, and the Arena's cross-round occupancy marker is a phase-coloured top edge instead of a grey initial badge.
- **A postponed move says where it went** (Combat Timing): the engine was already resolving it correctly, in this round or the next; the log just never said so.
- **Frame data on a declare card is small again** (Combat Timing) — a card summarises a footprint, the strip measures it.

**Sixth post-overhaul playtest batch — done.** Two items, both documented under Combat Timing's Resolution Phase above:
- **A move winds up on screen before it reveals.** A new `windup` event puts the move's Startup run on the board the moment it starts, labelled `???`, and the reveal then drops the real move onto that same bar — name and remaining frame data landing together. The wind-up row carries no move identity at all, not even hidden, so a public replay has nothing to leak.
- **An Interrupted move is struck out rather than erased.** It was the last thing on the board that could vanish without a trace — it dies in Startup, so it never reveals, so the cutscene had never drawn it, and the log announced the Interruption of a move nobody had seen. It now gets a grey, struck-through bar over the Tics it had claimed, labelled "Interrupted" rather than by name (it never reached its reveal Tic, and a replay is public). A pre-existing narration bug went with it: the Interrupt line read the wrong payload keys and called every Interruption a survival.

**Seventh post-overhaul playtest batch — done.** Four items, each documented in its own mechanic section above:
- **The cutscene shows the fighters, and damage lands on a Stat you can see** — a `roster` event plus before/after die state on every hit, filling the theater window's empty half with the two fighters' Stat cards.
- **Every automation is visible where the fight is** — On Hit/Block/Miss/Defense effects always fired mechanically but emitted no `round_event`, so the cutscene never showed them; they now post an `automation_fired` line, and Stamina movement is in the log too so the cards can't drift from the sentences.
- ~~**On Miss is reachable** — a sub-5 roll (Insignificant Damage) now fires it, not only a Full Dodge.~~ **Reverted** — an insignificant swing landed, so it fires **On Hit**; a Miss is a Dodge evasion and nothing else. See the Combat Timing section's Insignificant Damage rule.
- **Automations can step a named Stat**, and **out-of-combat checks resolve themselves** against a target number the GM sets on a Roll Request — held server-side and never shown to the player, with the verdict posted publicly when they roll.

**Still not automated, deliberately** (the answer to "what else is manual?"): **Perks** (bespoke `PERK_HOOKS` by design), **defeat** (the GM's call — reaffirmed this batch), the **Dodge** Successful/Failed call and the **Forfeit/Postpone** choice (the overhaul's two locked human-in-the-loop points), **Reasons to Fight** (a roleplay judgement), **Stance selection** (a player's tactical choice), **Injuries** and **ad-hoc damage** (GM narration outside the automated flow), and **die stepping / Stat Lock** (character progression, not combat).

**Eighth post-overhaul batch — done.** Playback pacing plus a QA pass:
- **The cutscene walks every Tic**, including empty ones (see Combat Automation overhaul above).
- **QA pass — three real defects found and fixed.** (1) `applyMoveInteractions` existed twice, in `server/index.js` and `server/roundResolution.js`, each carrying a comment saying they had to be kept in sync by hand. They had **already drifted twice**: index.js's copy never learned the stat-step automations (so an authored stat step was silently ignored on the ad-hoc damage path) and roundResolution's never learned index.js's GM-sentinel normalisation in `logRoll`. All four shared primitives (`postSystemMessage`, `adjustStamina`, `logRoll`, `applyMoveInteractions`) now live once in `roundResolution.js` and are imported by `index.js` — which is safe precisely because that module is import-safe by design. `server/index.js` lost ~155 lines. (2) `game_rules.md` still said *"Insignificant Damage is **not** a Miss"* after the engine started firing On Miss for it; the ruleset now matches the rule. (3) The Tic-skipping above.

**Known quality gaps, recorded not fixed** (from the same pass, each needing a decision rather than a patch):
- **The character-creation budget is honour-system.** The ruleset says "start at d4 and spend 8 step-ups", but nothing in the app counts them — there is no creation wizard, and Tab 1 lets a die be stepped freely. Fine while the GM is at the table; a real gap if characters are ever made unsupervised.
- **A round that throws mid-resolution stalls silently.** `advancePairResolution` runs inside the socket handler's try/catch, so a throw is logged and swallowed; the pair is left `status='running'` with nothing to resume it until the next server restart triggers `resumeAllPairsOnBoot`. Nobody at the table is told. A system chat line on that catch would make the failure visible; a re-drive button would make it recoverable.
- **`server/index.js` is still 3,180 lines** even after this pass. The combat engine has been extracted; what remains is every other domain's CRUD in one file. Splitting by domain (characters, moves, chat, combat wiring) is the obvious next structural move, and there is no test coverage of `index.js`'s own handlers beyond `scripts/e2e.mjs` driving them over real sockets.
- **`computeHitDamage` and `phaseAtTic` are deliberately mirrored client-side** so the UI can render damage and phases without a round-trip. That is a real duplication, documented at both ends, and the shared `framePhaseColors.js` module already removed the worst of it — but the two damage implementations can still drift, and nothing tests that they agree.

### Defence rework (GM-judged Block & Dodge) — decisions #1 and #4 SHIPPED

A rule no amount of code can decide drives this: a Straight and a Haymaker can both target the head, but a **front** block stops one and a **side** block stops the other. Nothing in the frame data knows the difference. So the defence that happens to overlap in time is no longer assumed to be the *right* defence — a human is asked.

**Decided this pass (each of these reverses or replaces something that was previously locked, and was confirmed explicitly):**
1. **Every defence now asks the GM "was this the correct choice?"** — Block included. This reverses the overhaul's own **decision #1** ("Block is fully automatic, purely dice-based, zero GM clicks, ever"). A **No** discards the defence completely and the attack resolves as if it had never been declared as a defence — no defence roll and **no Recovery extension**. The defending move still costs its Stamina and still occupies its Tics; only its defensive effect is ignored. Perks may override this later; nothing does yet. *(As written this bullet also said no defence triggers fire at all, `On Failed Defense` included. **That half was not adopted** — see the Status block below.)*
2. **Dodge is absolute — the roll is gone.** Previously a confirmed Dodge rolled against the attack and could come out **Partial**, letting damage through. Now a confirmed Dodge negates the attack entirely. Consequence: **"Partial Dodge" no longer exists**, and a Dodge move's Roll slots and defensive-only roll pool stop being consulted. This is the high-risk/high-reward half of the pair — a Dodge cannot be extended, so picking a move whose Defense Frames are too short, or declaring it at the wrong Tic, simply loses.
3. **When several declared moves could defend, one is picked at random** — previously the first in declaration order, which quietly rewarded declaration sequence and always used the older guard. Random is the deliberate representation of "whichever guard you actually got up". Note this makes a round non-reproducible from the same declarations.
4. **A Block that falls short extends, then pushes everything back.** Previously it extended silently and a collision raised a Forfeit/Postpone prompt for the one colliding move (**decision #3**). Now: extend silently when nothing collides; **ask** when something does; and on acceptance shift every later declared move of that fighter forward **recursively**, since each shifted move can collide with the next. **Now SHIPPED** — see the Status block below for the four sub-decisions this needed.
5. **Defense Frames may only sit on ACTIVE frames.** A guard is something a move is actively doing. A green square on a Startup position lands a Tic *before* the attack's Active window opens, which is the direct cause of the long-running "I blocked on the same Tic and nothing happened" confusion. Enforced in `sanitizeDefensePositions` (out-of-range positions are dropped, matching every other sanitizer here) and in the Move Creator, where non-Active squares are no longer buttons. **Existing moves are left exactly as stored** rather than silently rewritten.
6. **A Block is never extended if its move has Active frames after its Defense Frames** — that is a defensive attack (guard, then strike), and stretching its Recovery would stretch a move that is going somewhere. Such a Block simply covers what it covers; the roll is unchanged either way, since the extension only ever governed the blocker's own commitment.

**Unchanged, and confirmed as already correct:** a Block must cover the attack's **first** Active frame or it is discarded outright; the Block roll is **subtracted** from the attack and any leftover damage lands on the **Stat that blocked**; a Dodge that falls short cannot be stretched.

**Status — decision #1 is LIVE.** A Block now pauses the round and asks the GM, exactly as a Dodge does. `paused_defense` / `pending_defense_json` had sat unused in the schema since this section's groundwork slice; this is what they were added for.

- **Asked on every Block that reaches the guard** — `full` and `too-short` coverage alike. `too-early` stays auto-Failed for both kinds, unchanged.
- **One question per attacked Stat**, the same as the Dodge prompt and for the same reason the guard is already *rolled* per Stat: each line is its own strike met by its own guard. `attackedStatsOf` supplies the list; `resolveBlock` works down `remainingStats` and re-pauses until it is empty.
- **A line called Failed contributes the attack's full weight to the leftover** — no guard roll, no Block Stamina spent, no Spiked Shell bite.
- **If every line was called Failed the guard never happened**: the attack falls through to `applyFailedDefense`, exactly as a failed Dodge does — damage on the Stats the attack **named**, `On Failed Defense` fires, and **no Recovery extension** (stretching a fighter's commitment to hold a guard the GM just rejected would charge them for something that did not happen). The move still cost its Stamina and still occupies its Tics.
- **If any line held, the Block stands**: the Successful-Block redirect applies as it always has, and everything that got past the guard — a Partial line or a Failed one — lands on the Stat the blocker rolled.
- **This section's own §1 said a rejected defence should fire NO triggers at all, `On Failed Defense` included. That was not adopted (decided, revised).** The shipped Dodge fires `defense_failure` on a Failed call, the table is happy with how Dodge behaves, and parity between the two is worth more than the finer distinction between "it failed" and "it never happened". The Recovery half of §1 *was* adopted, above.
- **Shape:** `persistBlockPause` / `runBlockLine` / `finishBlock` in `roundResolution.js`, deliberately mirroring `persistDodgePause` / `resolveDodge` line for line. `loadBlockGuard` re-derives the slot rows, modifier and Block-Tag flag from the DB on every resume rather than carrying them on the pause, so a round resumed after a restart rolls against the same figures a round played straight through would.
- **Wire:** a `block_prompt` round_event delivered GM-only through `emitToGMs` (beside `dodge_prompt`), a `block_resolved` event for the log and the replay, `pendingDefense` on the pair in the combat snapshot for reconnect recovery, and `combat:resolve_block` (GM-only, rejects a stale click aimed at a different attack).
- **Client:** `DodgePromptDialog` became **`DefensePromptDialog`** with a `defenseKind` prop — one component, because it is one question, and two dialogs asking it in two voices is how the pair drifts. `CombatHeaderBar` gained a `blockQueue` mirroring `dodgeQueue` (same dedupe key, same snapshot pickup); only one defence dialog is shown at a time across both.
**Status — decision #4 is LIVE**, replacing Forfeit/Postpone with **Extend or Forfeit**. Its one-line statement left four things open; all four are now decided:

- **Who is asked, and with what choices** (decided): the move's owner — the player, or the GM for an NPC — exactly as the old conflict prompt was routed. **Extend** wears the guard's extension and slides the queue; **Forfeit** gives up the move the guard actually ran into, refunding its Stamina, and everything behind it still cascades against a floor that no longer has it in the way.
- **One question for the whole cascade** (decided), not one per collision. The old flow asked about the first move, applied it, then asked again about the knock-on — the same decision in instalments. The prompt now lists the whole tail with each move's Tic before and after, because "push everything back" is not a choice anyone can make without seeing what everything is.
- **A move pushed clear out of the round is handed back** (decided): if the shift leaves it with no frames inside the round, it stops being a commitment — Stamina refunded, declaration set uncommitted, still sitting at the spot the cascade put it. That is exactly the state a freshly-dragged declaration is in, which is what makes it cancellable again when Declaration reopens, and what makes it charge again if the player keeps it. A move that merely *overflows* — still starting inside the round — is unaffected; `overlapsRoundWindow` is the test, the same one the Tic Counter and lane snapshots use.
- **Nothing can become unaffordable** (decided), so a shift runs no affordability re-check.

- **Shape:** `planCascade` (pure, in `combatDamage.js`) wraps the pre-existing `cascadeShift` and adds `leavesRound` per entry. `finishBlock` builds the plan to **ask** about and `resolveMoveConflict` rebuilds it from the live board to **apply** — the same function both times, which is what keeps the tail a player was shown identical to the tail that moves, and is why Forfeit needs no second prompt.
- **Client:** `MoveConflictDialog` became the Extend/Forfeit dialog and lists the tail; `RoundCutscene` narrates the cascade and shifts every affected bar (a pre-#4 replay carries the old single-move payload and is read as a one-entry cascade rather than dropped — §0).

- **Two bugs this surfaced, both fixed:**
  - **The live conflict prompt never worked, for anyone.** `CombatHeaderBar` looked the affected fighter up in `combat.characters` to decide ownership — a map the REST snapshot carries but the `combat:updated` socket broadcast does **not** (see `emitCombatUpdated`, which sends pairs/participants/declaredMoves and no per-character detail). So the moment any combat broadcast landed the map went empty and every live prompt was silently dropped; only a page reload ever showed one. The gate now reads `participants`, which is in both payloads and already carries `character_type`.
  - **The event bridge dropped the payload.** `combat:move_conflict` forwarded three hand-picked fields, which was enough for the old one-move prompt but would have rendered the cascade's list empty. It forwards the whole payload now.
- **Also added:** reconnect recovery for the conflict prompt, which the Dodge and Block prompts have always had and this one never did — a player who reloaded while it was pending was never asked again, and their pair sat paused with nothing on screen to answer.

- **Still to build from this section:** the rules-doc rewrite for #3's random defender pick.

**Earlier groundwork, unchanged:**
- New pure, unit-tested helpers in `combatDamage.js`: `selectDefenseMove` returns a **random** eligible move (injectable `random` so tests stay deterministic), plus `activeFramePositions`, `defenseFramesWithinActive`, `canExtendDefense`, and `cascadeShift`.
- The Active-frames-only rule (#5) is live.

### Grappling — a Move that grabs (IN PROGRESS — G1 groundwork only)

Every other move in the game is decided before the round starts: you commit to a Tic and find out
afterwards whether you read your opponent right. **Grappling is the first mechanic where a decision
is made *during* resolution**, and the first that asks two people for an answer at the same moment.

A move with the **Grappling** toggle does not land or miss. It opens a four-way branch: the
grappler picks a direction in secret, the target guesses which way the grab went, and whoever read
the other correctly takes **+5**. Only then is the roll made, and the grab is settled by an opposed
roll against a **Resist Roll** authored on the grappling move itself. Winning chains the move
assigned to the chosen direction, declared right after the grapple.

**REWORKED (decided, revised — this supersedes the ordering below).** The first
implementation asked for the direction *before* the contest, which meant the
grappler committed to a follow-up without knowing whether the grab had even
worked, and the ±5 decided the grab itself. Reported from a playtest as "nothing
happened": the round paused for the defender's guess and waited forever, because
the mini-game needed both answers at once and a PC grappler's half can only be
answered by that player. The flow is now:

1. **Only the grapple is declared.** The follow-up is never declared by hand.
2. **The contest resolves first** (`runGrappleContest`), with no ±5 — there is no
   read yet. Failure fires nothing, exactly as before.
3. **On success** the −2 window and **On Successful Grapple** happen immediately,
   before any prompt, so a chain that ends in "nothing" still leaves the hold.
4. **The grappler is asked for the follow-up** — all four arrows, with anything
   unlearned or unaffordable greyed and labelled, plus an explicit *take it no
   further*. `annotateFollowUps` is the pure rule.
5. **Then the defender guesses**, if there was more than one direction to guess
   between. Two **sequential** pauses (`pending_grapple_json.phase` =
   `'choice'` → `'guess'`), not one simultaneous two-party wait.
6. **The ±5 lands on the FOLLOW-UP's roll**, signed: wrong guess +5, right guess
   −5 (`chainRollBonusFor`). Stored on the declaration as
   `declared_moves.chain_roll_bonus` and applied **once to the summed total**,
   because by the time the follow-up resolves — possibly a round later — the
   pause that produced it is gone.
7. **Retroactive declaration is now an engine primitive.** `declareChainedMove`
   places the follow-up after the grab, charges Stamina, and puts it on the board
   as an ordinary declared move with a visible Tell. **Unaffordable ends the
   chain by itself** (`grapple_chain_ended`), re-checked at placement because
   each link in a chain spends.
8. **Recursive, unbounded.** A follow-up that is itself Grappling re-enters the
   whole flow, because a retroactively declared move is an ordinary declared move
   and `resolveGrapple` picks it up like any other. A chain that overruns the
   round simply overflows into the next.
   - **A chained grapple keeps its own ±5 (bugfix).** The swing was applied in
     `resolveAttack`, which every *ordinary* follow-up goes through — but a
     follow-up that is itself a Grappling move never enters the attack flow at
     all (see the Grappling branch at the top of `resolveAttack`), so the read
     the defender had just made on the first grab silently evaporated on the
     second one. `runGrappleContest` now passes `chain_roll_bonus` into the
     grappler's roll, total-level like every other grapple modifier; the target's
     Resist Roll deliberately does not get it. Without this the mini-game stopped
     meaning anything the moment a chain went grapple-into-grapple, which is how
     it was reported. Covered by `scripts/playtest-grapple-recursion.mjs`, which
     drives two chained grapples through the real server and asserts the second
     contest's roll still carries the swing.
   - **Recursion itself was measured and is sound.** Chased on the same report,
     the chain was driven end-to-end in four shapes — NPC grappler and player
     grappler, Default moves and granted ones, one assigned direction and two (a
     single direction skips the defender's guess entirely, so only the two-
     direction fixture exercises the guess phase twice). All four chain
     correctly: two contests, two prompts, two reads scored, the third link on
     the board. `scripts/playtest-grapple-recursion.mjs` and
     `scripts/playtest-grapple-recursion-pc.mjs` keep both role shapes covered.

**Answering stays owner-only (decided, explicitly kept).** The GM cannot pick for
a PC grappler. The consequence is that a PC's grapple genuinely cannot proceed
without that player present — which is what the original report ran into — so the
pause now names **who it is waiting on** (`waitingOn`) to every viewer, including
bystanders, so a waiting round reads as waiting rather than broken. An all-NPC
grapple is never prompted at all and auto-takes the first available direction.

**Decided (confirmed explicitly — do not re-litigate):**
1. **The −2 the target takes on their rolls lasts while the grappling move's ACTIVE frames run** —
   not merely the contested roll, and not until they escape. A bounded window
   (`combat_participants.grapple_penalty_until_tic`, inclusive), so no condition system is needed.
2. **Dodge can evade a grapple; Block cannot.** A declared Block is never consulted against one.
3. **Both success conditions apply**: the grapple must clear its **Success Threshold** *and* beat
   the target's total. Two distinct failures — a fumbled grab reads differently from one the target
   out-muscled — and the log says which. **A tie goes to the target**: being equally strong is not
   enough to take someone down.
4. **The target's Resist Roll is authored on the grappling move** (`move_resist_roll_slots`, a
   mirror of `move_defensive_roll_slots`), so a headlock and an ankle pick contest different Stats.
5. **An all-NPC grapple skips the mini-game entirely** — straight to the contest, no ±5. The GM is
   never asked to guess against themselves.
6. **Fewer than 2 assigned directions: no mini-game and no ±5**, but the contest still happens, and
   a single assigned direction still chains on success.
7. **The chained move's Stamina is committed when it is created.**
8. **The chained move sits next in line and resolves normally** — no Tic jump; the round's clock is
   untouched.

**The ±5 and the −2 are TOTAL-level, not per-die (decided, and a departure).** Every other flat
modifier in the game — a move's Roll Modifier, Perk bonuses, Reasons to Fight, the Stance matchup —
is added to *each die separately*, so a three-die roll multiplies them. A +5 folded in there would
quietly be worth +15. Grapple modifiers are therefore applied once, to the summed total, which
makes them behave unlike every other modifier and is worth knowing before tuning anything.

**Reversibility: solved by not needing it (decided).** The spec describes the chained move as
"temporarily declared" and rolled back if the grapple fails. It is not implemented that way,
because nobody ever observes that state — the answers arrive, the roll happens and the outcome
lands in one step. **The engine does not create the chained move until the grapple has already
won.** During the pause the board shows a *ghost* drawn from the grapple's own `round_event`, and a
failed grapple has nothing to undo. This matters: a rollback would be the only reversible write in
the engine — `cascadeShift` and the Postpone path are both forward-only, and nothing else in the
schema remembers where a move used to sit.

**Bugfix found while building this, shipped in G1.** `advancePairResolution`'s "don't run while
paused" guard named the three statuses it refused rather than testing for the one it allows, so any
pause status added afterwards was treated as *runnable*. `paused_defense` had already shipped in
the schema and already fell through it — a pair sitting in that state would have been advanced
straight past its own pending decision, resolving the round twice. The guard is now
`status !== 'running'`, so every future pause is safe by construction.

**Status — COMPLETE. G1 (groundwork), G2 (the No Damage Tag), G3 (authoring), G4 (the contest)
and G5 (the mini-game) are all shipped.** Same shape as the Combat Automation overhaul's own
Phase A.
- Schema: `moves.is_grappling`, `moves.success_threshold` (default 5); new `move_grapple_directions`
  and `move_resist_roll_slots` tables; `declared_moves.grapple_source_declared_move_id`;
  `combat_participants.grapple_penalty_until_tic`; a `'grapple_success'` move-interaction trigger
  and a `'paused_grapple'` resolution status, each via a table rebuild (SQLite cannot ALTER a
  CHECK). The `pair_round_resolutions` rebuild is the **fourth** on that table and carries the
  dormant `paused_defense` status through untouched.
- `seedNoDamageTag()` beside `seedBlockTag()` — the **No Damage** tag did not exist in this
  database. Seeded case-insensitively, so a GM's hand-made row is adopted rather than duplicated.
- New pure `server/grappleLogic.js` + 24 unit tests: the contest and its two failure modes, the
  ±5 on totals, the mini-game gating, the chain placement and its knock-on shift, and the −2
  window. Three migration tests prove the rebuilds keep existing rows — including that the
  `pair_round_resolutions` rebuild does **not** cascade-delete stored round replays.
- **G3 — authoring, shipped.** A grappling move is now fully authorable and displays everywhere a
  move displays; the engine still ignores `is_grappling`.
  - `moves.is_grappling`, `move_grapple_directions` and `move_resist_roll_slots` are written by
    `writeMove` and returned by `attachInteractions` — the one read path every move surface goes
    through, so the Compendium, a character's Moves tab and every `move:created` broadcast pick
    them up at once. All three child tables are gated on their toggle and cleared when it goes
    off, exactly as `normalizeInteractions` already drops the defence triggers.
  - `normalizeGrappleDirections` (pure, in `moveLogic.js`) dedupes by direction, orders by the
    cross, and drops an id that no longer exists.
  - **A move MAY point a direction at itself (decided, reversed; implemented).** It used to be
    dropped as "an unbounded loop", and that reading was simply wrong: a chained move is placed at
    `grappleFootprintEnd` — the grab's reveal Tic plus its Active frames (`planChainPlacement` in
    `grappleLogic.js`) — so **every link lands strictly later than the one that declared it**, by at
    least the whole of its own Startup and Active. A self-chain therefore walks forward through the
    Round and stops at its end, exactly as a chain across three different moves does; it stops
    earlier still the moment the grappler cannot pay for the next link, and each link is a human
    picking a direction off the prompt rather than anything the engine does on its own. What it buys
    is the obvious thing: one grab you can keep re-applying, which is how a wristlock or an armbar
    reads at a table, instead of four near-identical moves describing the same hold. The move is
    offered in its own direction picker to match. **A move being *created* has no id yet** and so is
    not in the library to pick — save it once and the direction is there to set on the next edit.
    **The Requirement rule is untouched**: a move that required itself could never legally be
    declared at all, which is a move that does not work rather than a design choice, so it is still
    excluded from its own Requirement picker and still dropped server-side.
  - `move:delete` clears `move_grapple_directions` **by `target_move_id` as well as by
    `move_id`** — deleting a move some other grapple points at would otherwise leave an arrow at
    a ghost, and the FK would refuse the delete outright.
  - `GRAPPLE_TRIGGERS = ['grapple_success']` beside `DEFENSE_TRIGGERS`; `normalizeInteractions`
    now takes two independent gates, so a move can be both Defensive and Grappling and get both
    sets.
  - **Decided while building it:** the direction picker is a **searchable overlay** grouped by
    Discipline (`MovePickerDialog.jsx`), not a `<select>` — a flat list of every move in the game
    does not survive a real library. It is the **only** `DialogShell` user that portals to
    `document.body`, because it is mounted deep inside the Move Creator's form and a transformed
    ancestor makes `fixed` resolve against *that* rather than the viewport; found by driving it in
    a browser, where the dialog was visibly clipped at the column's edge.
  - **Decided:** an empty Resist Roll is legal and means the target cannot contest the grab at
    all — "a grab you can only fumble, never muscle out of" is a real authoring choice.
  - **Decided:** a direction may point at another Grappling move, and the chained grapple resolves
    as an ordinary move — no second mini-game, no second contest, so no depth guard is needed.
    The picker flags such a move rather than hiding it.
- **`move_defensive_roll_slots` was dead schema, and G3 closed it.** The table has existed since
  the Combat Automation sub-phase 2 and `roundResolution.js` reads it on every defensive roll, but
  **nothing had ever written to it** — no `writeMove` branch, no authoring UI, no `move:delete`
  cleanup. Every Block and Dodge in the game had therefore been resolving with an empty extra pool
  regardless of what the design said. Since the Resist Roll needed the same picker, both are wired
  now: a Defensive move gains a **Defensive Roll** field for the extra dice it throws on top of its
  own Roll. **This is the one part of G3 that is not inert** — a Block authored with defensive
  slots now genuinely rolls more dice.
- **The GM was never asked for an NPC's follow-up (found in playtest, fixed).** A grapple whose
  grabber is an NPC pauses waiting for "the grappler" to pick a direction — and the GM *is* the
  grappler, because the GM owns every NPC. What the GM actually got was the bystander screen:
  *"waiting on <that same NPC> to choose where the grab goes"*. Nobody could answer, the pair sat
  in `paused_grapple` forever, and the chain never started — which is what a table experiences as
  "grappling does not work".
  - **The cause is one missing column, not the grapple logic.** `mapPendingGrappleForViewer`'s
    `owns()` decides GM ownership by reading `character_type` off a `combat_participants` row —
    and `combat_participants` has no such column. `SELECT *` therefore answered `undefined` for
    every seat, so a GM owned nothing and was a bystander at *every* prompt. The authorisation
    side was fine throughout (`ownsCharacter` reads the `characters` table), which is why the
    engine resolved perfectly the moment the answer was sent by hand — only the prompt was
    invisible.
  - **Fixed at the read, not at the call site.** A shared `allParticipants()` joins
    `characters.character_type` in, and both places that feed a per-viewer mapping
    (`emitCombatUpdated` and `GET /api/combat`) use it, so any future viewer rule gets truthful
    rows rather than another silent `undefined`.
  - **Regression guard:** `scripts/playtest-grapple-gm.mjs` (8 checks) runs an NPC-vs-PC grapple
    end to end and asserts the GM is the *grappler* with the follow-up names in hand, the PC sees
    blanks and is told who it waits on, and the chain lands on the board. It failed on exactly
    three probes before the fix.
- **G4 — the contest, shipped.** Grappling is now playable end to end, minus the guessing.
  - **A grapple never enters the attack flow.** `resolveAttack` hands `is_grappling` straight to
    `resolveGrapple` and returns, so no damage machinery, no Block resolution and no Interruption
    check ever sees a grab. Checked ahead of even the defence-pure and Roll-less guards: a grapple
    with no Roll still has a contest to lose, and one that is also Defensive is still a grab.
  - **Dodge evades, Block is not consulted** (decided). A Dodge needs the same `full` coverage an
    ordinary Dodge needs; anything less and the grab closes anyway. The evade happens **before any
    dice** — there is no contest to roll — and fires **On Miss**, which is exactly what a Miss is.
    Unlike an ordinary full Dodge it never pauses for the GM: the contest is the roll that decides
    a grab, so there is nothing left for a human to call.
  - Both rolls go through one shared `rollFor`, so a grapple's dice obey the same modifier stack
    and the same chat/timeline logging as everyone else's. The **Resist Roll is authored on the
    grappling move**, not on anything the target declared — which hold you are in is the
    grappler's choice.
  - **The −2 lives in `getCombatRollBonus`**, the one place every roll path reads, and is set
    **after** the contest and only on a win — so the Resist Roll itself is unpenalised, since the
    grab had not landed when it was rolled. Read at the caller's own `tic`, never at
    `combat_pairs.current_tic`, which lags a Tic during resolution.
  - **`declareChainedMove` writes only on a win.** No `is_temporary` flag, no snapshot, no
    rollback: a failed grab leaves the round exactly as it found it because nothing was ever
    created. Stamina is charged outright rather than committed-and-refunded, for the same reason —
    there is no failure path left to refund on. Only moves with `reveal_posted = 0` are shifted;
    one already resolved is a fact, not a plan.
  - **The mini-game is stubbed to "skipped"**: nobody guesses, neither side takes the ±5, and the
    grappler's direction is the first assigned one in cross order. The branch sits exactly where
    G5's pause goes — before any dice, so the read happens on a blind grab.
  - Cutscene gains `grapple_resolved` and `grapple_chained`.
- **G5 — the mini-game, shipped.** The app's first genuinely **two-party** pause.
  - `status = 'paused_grapple'` + `pending_grapple_json`, written where the mini-game belongs:
    **before any dice**, so the read is made on a blind grab.
  - Two socket events, `combat:grapple_choose` and `combat:grapple_guess`, each writing its own
    half. **Neither resolves anything alone** — the contest waits for both, so whoever clicks
    first learns nothing from having clicked. First answer per side wins; a second click from
    another tab is a no-op.
  - **Per-viewer secrecy, structural rather than remembered.** `mapPendingGrappleForViewer`
    follows `mapDeclaredMovesForViewer`'s rule — *keep the structure, null the identity*. Both
    sides get four entries in cross order; only the grappler gets `moveId`/`moveName`. The GM is
    **not** privileged: whoever owns the grabbing character sees the names, everyone else sees
    blanks, matching `isRevealedToViewer`'s own adversarial stance. A bystander gets `role:
    'observer'` and no directions at all.
  - **`answered` is per-viewer too.** A fighter is told whether *they* have answered, never
    whether the other side has — knowing the opponent has moved is itself a tell.
  - The `grapple_prompt` **round_event carries no move names**: replays are watched by everyone,
    and a spoiler in the log would give the whole mini-game away to anyone scrubbing back. The
    later `grapple_guessed` event names both the choice and the guess, since by then there is
    nothing left to spoil.
  - **Reconnect recovery is free** — the prompt rides on the ordinary combat snapshot, so a
    reload picks it back up. That required folding it into **both** the socket emit *and*
    `GET /api/combat`, which is what a fresh page load actually reads.
  - `GrapplePromptDialog.jsx` mounts in `CombatHeaderBar` beside the Dodge and conflict prompts,
    so it reaches a fighter anywhere in the app.
  - **Bugfix found by driving it:** the pause did not stop `processTic`. `resolveAttack` must
    return `{ paused: true }` for the Tic loop to halt, and the grapple branch returned
    `undefined` — so the round prompted twice and then ran straight through its own pause.

**Open, flagged rather than invented:** whether a chained
move that is *itself* Grappling may open a nested mini-game (recommendation: it resolves as an
ordinary move); and whether a default threshold of 5 is too low given per-die modifiers already
clear it before the dice are read.

**Batch off the first official playtest — done.** Five items, each documented in its own
mechanic section above:
- **The GM adjudicates a Block, not just a Dodge** (Defence rework decision #1 — the one that had
  been groundwork-only since that section was written). Every defence that reaches the guard is now
  a human call.
- **The attack telegraph is back to one square** (Combat Timing). Marking the whole Startup run
  published the move's Startup count, and frame data is what a Tell exists to make you guess at.
- **Damage aimed at a broken Stat is reported instead of vanishing** (Attack Target). The attack
  resolves in full; only the application fails, and the round says how much and where, so the
  table can weigh it as an Injury.
- **Closing the Roll Requester no longer whites out the app** (GM Tools) — a Promise handed to
  React as an effect cleanup. The client also grew its **first error boundary**, so one component
  throwing can never take the whole table's app down again.
- **Skull and Brain stopped overlapping on the Vitruvian figure** (Mobile Readiness / Core Stats) —
  moved onto Stamina's and Body's own verticals.

Verified by 448 unit tests, `scripts/playtest-block-adjudication.mjs` (21 probes against a live
server on a fresh DB, covering both Block answers, a discarded guard's Recovery, and the
end-of-round broken-Stat report), and a Playwright pass that confirmed the prompt's copy, the
single telegraph square on a 3-Tic wind-up, the new Skull/Brain spacing, and the Roll Requester
closing cleanly with no page errors.

**A pause now waits for the GM instead of expiring with their connection — done.**
Reported from play: a GM whose phone locked through a round came back to a silent screen and a
fight nobody could advance. Every prompt was rebuilt to be a function of server state rather than
of a one-shot event that happened to arrive — see **Pause delivery** above for the full account.
Alongside it, GM Tools grew **Fight Pauses**, a manual escape hatch that asks the server what the
fight is waiting on and can raise the dialog from that answer. Two real bugs turned up on the way:
the combat header never re-read anything after mount, and `useSocketRefresh` skipped the reconnect
for any component mounted mid-session — the once that matters.

Verified by 481 unit tests, `scripts/playtest-pause-delivery.mjs` (20 probes, with a second GM
connection genuinely disconnected across the pause and reconnected afterwards), the two existing
defence playtests re-pointed at the snapshot, and a browser pass in which the server is killed and
restarted under a live GM tab.

**A four-item batch off the table — done.** Each documented in its own mechanic section above:
- **The Moves tab filters by Tell and by Tag** (Moves & Tells), the Compendium's own control brought to
  the sheet, listing only what the sheet actually carries.
- **A Player can teach themselves a move** (Compendium) — Learn/Forget on any Unique move, which closes
  the gap between being able to read the library and being able to act on it.
- **The Arena's die chips carry their Stat's icon** (Combat Arena). Eight identical `d4`s identified
  only by a hover title was unreadable in the one view built for glancing.
- **A long move name no longer breaks its picker card** (Combat Timing) — the ⓘ badge and the corner
  bevel were both sitting on top of the text.

Verified by 481 unit tests, a clean build, and a browser pass driving each one: a Tag filter narrowing
the sheet and clearing back, a Tell filter doing the same, Learn turning into Forget and the move
appearing on the sheet, and a 3× crop of the declare picker with four deliberately long names — every
one now readable in full, inside the panel, with nothing overlapping.

**A six-item batch off the table — done.** Each documented in its own mechanic section above:
- **The held move is highlighted in the picker** — tap-to-declare was invisible on a phone.
- **Every move telegraphs its first frame, guards included.** The absence of a glow was a free
  read that the opponent was turtling.
- **A broken Leg forbids Movement moves**, and fizzles one already declared, refunding it.
- **Uneven Combat lets you pick who each move is for**, per move, at declaration.
- **The Stance matchup follows that choice** — an uneven fight showed no matchup at all before,
  though the rule was still applying to the rolls.
- **A move pushed wholly into the next round becomes that round's declaration** — refunded,
  visible in the lane, cancellable.

Verified by 487 unit tests (including the new `movementBlockedByLegs` rule, the mid-round fizzle
with its refund, the re-homing, and a carryover proving it is left alone) and a clean build.

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

## Implementation Risks & Recommendations
A scope check for whoever picks this up: this grew well past "semi-simple website" over the course of design. Most of it (dice, inventory, injuries, stances, perks, counters) is standard CRUD-plus-broadcast work. Combat Timing (Tics/Startup/reveal/overflow) is the one genuinely hard piece — real software complexity, not just more forms — and it's also the most original part of the system, which is exactly why it deserves the most care rather than being rushed alongside everything else.

**Recommended approach:**
- Build and playtest Combat Timing in isolation first, with a bare-bones/unstyled harness, before wiring it into the full Arena UI. It's the highest-risk piece and the most likely to need a tweak once it's actually moving (round length was in fact revisited after playtesting — 5 Tics wasn't enough granularity, bumped to 7; does per-side initiative feel right with 3 vs 1?).
- **Write automated tests for the placement/reveal/overflow math specifically** — `placement_tic`, `reveal_tic`, the carryover rule, and Tell-vs-revealed visibility per client. This logic is pure and easy to test in isolation, and a bug here is the kind that's maximally disruptive mid-session and hard to spot just by looking at the UI.
- Populate real content early — actual Moves, Perks, and the final 7 Stance attributes — before polishing the Compendium UIs around them. Placeholder/TBD fields hide schema gaps that only surface once real content exists.
- Push the visual/GSAP polish pass to last. It's the most fun to build but also the most likely to get reworked if a mechanic changes shape during playtesting.

**Known risks to watch:**
- **Identity is still a client-side pick, not a login** (see Open Items below) — anyone can technically pick anyone else's character at the Role Modal and see their secrets early, same trust model as every other GM-only/Player-only control in this app. Worth testing deliberately (reload mid-round as a Player, confirm the Role Modal reappears and picking your character back restores your view of your own still-pending moves) rather than discovering the behavior live.
- **Render cold starts** could hit right as a session is starting. Worth explicitly testing Socket.io reconnection behavior after an idle spin-down, not just assuming it reconnects cleanly.
- **Interconnected live-sync systems** (a Perk hook touching a die, which touches tinting, which touches Lock/Revert, etc.) tend to fail as "this number doesn't match what I expected" rather than a clean crash — harder to track down without a testing habit already in place, which is the main reason testing is called out here rather than left implicit. This bit once already, in the original Phase 4 automation registry (since removed): a current-only die step and Revert Stats to Base both changed the same die's current value through different paths, so grant → Revert → revoke (in that order) could land the die somewhere other than its pre-grant baseline. Worth remembering when writing a future `PERK_HOOKS` entry that steps a die "current only" — track the delta you actually applied if the hook needs to cleanly reverse it later, rather than assuming the die's value at revoke time is still what grant time left it at.

## Open items to decide later (not blocking MVP)
- Exact combat/roll resolution rules (what a roll "means" mechanically) — not needed for the roll/step mechanism itself
- Real character/move/perk/Tell art (commissioned images to replace placeholders) — the palette/font/corner/animation conventions themselves are now decided, see Global UI — Visual Theme above. The user-facing color-customization setting once flagged here as future work is now built (see Pages / views — Settings above); further settings beyond Primary Color are still just a placeholder for "more will come later," nothing specific planned yet
- How an active stance's attributes actually modify outcomes — the ±2 counter scoring is decided and displayed; full resolution depends on Moves/Combat Timing, still not fully described
- Per-style mechanical benefits (styles granting bonuses beyond counter matchups) — planned for later, structure TBD; attribute rows kept extensible for it
- How Current Stamina is spent/reduced during play — confirmed no automation for now; `stamina:adjust` remains the manual control, actual spending happens narratively at the table
- Full list of Default Moves (Block, Jab, Dodge, + others not yet named) — the Creator is live, content still needs to be written (in-app or provided)
- Real Tells (names + commissioned images) to replace the two seeded placeholders — GM task, tooling is live
- **When/how On Hit / On Block / On Miss automations actually fire during combat is now a full plan (decided, not yet implemented) — see Game mechanic — Combat Automation above.** Kept listed here as a reminder that it's still unbuilt, not because it's still undecided.
- Perks are explicitly MVP-scope on the mechanics side; real Perk content (and whatever `PERK_HOOKS` entries it needs — see Perks & Tags above) still needs writing, one at a time, case by case
- A `character_move_roll_bonuses` row (however it gets written — currently only a manual `PERK_HOOKS` hook, previously the removed generic registry) is live for any Move that has a Roll configured (folds into that Roll's pre-filled modifier, including the reveal-time auto-Roll's pre-fill — see Combat Timing above); for a Move with no Roll it's still stored/displayed but has no live effect. Automation execution itself is planned — see Combat Automation above, separate from rolling itself.
- **Move-order interrupts (e.g. a fast Jab resolving before a slower move declared earlier) are still tracked via Tic order but not auto-adjudicated — a GM/table call for now.** Distinct from the new **damage-triggered Interruption mechanic** (Combat Automation above, item 4.4) — that one is specifically about taking a hit while still in your own Startup frames, not about which of two declared moves resolves first; this bullet is about the latter, still open.
- ~~**Genius Observer Perk gate is a manual honor-system prompt**~~ — **closed.** It is a real check now, answered server-side against the logged-in character's granted Perks and pushed to that connection as `identity:capabilities` (so a Perk handed out mid-session takes effect at the table, not on the next reload); the button simply isn't offered to a viewer who has not earned it, and the GM always qualifies. The Perk exists in code (`server/perks/geniusObserver.js`) and is seeded into every world's compendium at startup, so a GM no longer has to create it by hand for it to mean anything. It was the first Perk written against the new architecture precisely because it needed no new engine behaviour — the engine already decided who may see what, per connection, for declared-move secrecy. Original note kept below for the record:
  - **(superseded)**  clicking a move-reveal Chat Log card to expand it to the full move (see Chat Log mechanic above) asks "Does your character have the Genius Observer Perk?" rather than actually checking Perk ownership — there's no real Perk-content for it yet, and no server-side link between "this click" and "this character" the way declared-move visibility now has via `identity:set`. A later pass should replace the prompt with a real check against the logged-in character's granted Perks (see Perks & Tags above for the grant mechanism) — until then, a GM needs to actually create the Perk in the Perks Compendium for it to mean anything at the table.
- **Identity is a client-side pick, not a login (decided, no longer just a known gap):** picking a character at the Role Modal is still just a display choice — anyone could pick anyone's PC, same trust model as everywhere else in this app — but the server now genuinely tracks it per-connection (`identity:set`) and uses it to tailor declared-move visibility (see Combat Timing above), which is a real improvement over the earlier "only the exact socket that clicked declare ever sees its own move" model. The residual gap is purely the lack of real accounts/passwords, an intentional design choice for this single-shared-link app, not something left to fix later.

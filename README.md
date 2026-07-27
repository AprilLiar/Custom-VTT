# Custom VTT

A small, self-hosted virtual tabletop for one group (DM + players): shared link, no login,
real-time sync across devices. Fighting-game-styled, built around a stepped dice-pool system.

**Stack:** React + Vite + Tailwind (frontend) · Node + Express + Socket.io (backend, also
serves the built frontend) · Turso/libSQL (database) · Render (hosting).

## Local development

```bash
npm install
npm run dev
```

This starts the Express/Socket.io server on port 3001 and the Vite dev server on port 5173
(proxying `/api` and `/socket.io` to the backend). Open http://localhost:5173.

Without Turso credentials the server uses a local SQLite file (`local.db`) — same libSQL
client, same SQL, so local and production behave identically.

## Production build (what Render runs)

```bash
npm install && npm run build   # builds client/dist
npm start                      # Express serves client/dist + Socket.io on $PORT
```

## Deploying

1. **Turso:** create a free database at https://turso.tech, then grab its URL and an auth token:
   ```bash
   turso db create custom-vtt
   turso db show custom-vtt --url
   turso db tokens create custom-vtt
   ```
2. **Render:** create a free Web Service from this repo (the `render.yaml` blueprint
   preconfigures build/start commands), and set two environment variables:
   - `TURSO_DATABASE_URL` — the `libsql://...` URL from step 1
   - `TURSO_AUTH_TOKEN` — the token from step 1

Note: Render's free tier sleeps after inactivity — the first load of a session takes
~30–60s to wake the server. One-time per session, not ongoing.

## Project status

Phase 7 (Combat Timing) has begun: `server/combatTiming.js` is a bare, pure-function module for
the placement/reveal/overflow Tic math — per-side Brain initiative, a move's placement/reveal/
active-end/recovery-end Tics, live reveal-vs-Tell visibility, and round-relative Tic display —
unit-tested in isolation with no socket/DB/Arena wiring yet, per the plan's own recommended
build order for its highest-risk piece. Decided along the way: a character's next move is
blocked only until their previous move's Startup reveals (not the full Startup+Active+Recovery
footprint); Active/Recovery still count toward the move's own timeline, just not toward
blocking the *next* declaration.

The Chat Log now takes free-text messages, not just rolls: a compose box at the bottom lets
anyone pick a character to post as (PC-only for Players), type a message, and/or attach an
image or GIF, rendered with the same avatar/name/timestamp header a roll uses. GIFs keep their
animation — they're sent as raw uploaded bytes (capped at 4MB) rather than redrawn onto a
canvas, which would otherwise flatten them to one frame; other images are still resized
client-side like everywhere else in the app. Nothing in chat sticks around: a **Clear Chat**
button (GM-only) wipes the whole log for everyone, and the log now also actually clears itself
on every server boot (previously only documented, never implemented) rather than relying on
Render's free tier spinning down as an incidental side effect.

A character-owned counter can now carry one optional, purely cosmetic **reward tag** —
Story (amber), Statistic (blue), Perk (violet), Move (orange), or Combat Prowess (red) — set
at creation or changed any time after via a small colored select next to the counter's name
that doubles as the tag itself. Standalone Arena counters can never have one (rejected
server-side too, not just hidden in the UI); a character counter's reward still shows
(read-only) in the Arena's Counters section if that counter is flagged Show in Combat.

Character folders and move Disciplines now **nest** to any depth (`parent_id` self-references
on both `character_folders` and `move_folders`), browsed via a shared indented
`FolderTreeNav` sidebar instead of the old flat tab row; creating a folder while another is
selected nests it inside, and deleting one promotes its direct contents and direct child
folders one level up to its own parent (root if it was already at root) rather than
flattening the whole subtree. Character cards and move cards show their full folder path
("📁 Fighters / Bosses"). The Combat Arena's roster mirrors this — folders recursive,
collapsible, alphabetical, with a running available-character count including descendants,
empty subtrees hidden, folderless characters last under their own heading — and seated
participant cards are now horizontal, with a full-height portrait filling the entire left
edge and name/stance/stamina/dice stacked to its right. Moves can be flagged **Defensive**,
adding two more interaction categories (On Successful Defense / On Failed Defense) to the
existing On Hit/Block/Miss — any category (old or new) with no text and no automations
simply isn't stored or rendered; `move_interactions.trigger`'s CHECK constraint expanded
from 3 to 5 values, which for an existing database means a one-time table rebuild
(`server/db.js`'s `migrateMoveInteractionsTrigger`) that preserves every row.

Since Phase 6: character list cards use a fixed-size portrait area with the art cropped to
cover it edge-to-edge (no letterboxing, regardless of the source image's aspect ratio) and
show a folder chip when filed; the Combat Arena's roster rail now groups not-yet-seated
characters by folder, and seated participant cards fill their side's full width with no
unoccupied space — under Uneven Combat, adding more characters to a side scales every card
on it down evenly instead of leaving gaps — with dice grouped into the same Head/Core/Legs
rows as the character sheet instead of one flat row. Perks lost their generic automation
system (the original 5-type registry — Step a Die, Stamina Multiplier, Move Tag, Move Frame
Data, Move Roll Bonus — applied/reversed automatically on every grant/revoke): a Perk is now
just picture/name/description plus membership, and a mechanical effect for a specific Perk
is hand-written as an `onGrant`/`onRevoke` entry in `server/perkAutomations.js`'s
`PERK_HOOKS` map, keyed by that Perk's name, only once its real content is decided. Also,
several read-heavy API endpoints (`GET /api/characters/:id`, `GET /api/combat`,
move-resolution helpers) were switched from sequential to parallel (`Promise.all`) database
queries — Turso's networked connection makes every query a real round-trip, so a
per-participant N+1 loop (Arena) or a chain of ~8 sequential awaits (character sheet load)
was compounding into multi-second production latency that a local SQLite dev environment
never surfaces.

Phase 6 (Combat Arena — structure only, no round/Tic timing yet) — reachable via the
header logo, visible to every role. GM drags characters from a roster rail onto a
Left/Right side and groups them into pairs (drag onto a pair row; dropping onto an
occupied side adds rather than replaces, for Uneven Combat groupings like 2v1); NPCs
placed here become visible to Players as an explicit exception. Each seated character
is a **read-only** glance card — portrait, active stance, dice, stamina — live-synced
via the same broadcasts the character sheet uses; click through to the sheet to
actually roll/step. Also lists standalone counters (GM-only to create) and any
character's "Show in Combat" counters while they're seated, both adjustable right
there. Phase 7 adds the actual round/Tic timing on top of this structure.

Since Phase 5 (Counters): GM-managed character-list folders, a global header Search
bar (Characters/Moves/Perks/Tells/Tags, role-scoped), and Move Roll — a move can
specify which dice it rolls plus a shared bonus, including an ambiguous Left/Right
Hand or Leg choice the player picks only when actually rolling (such a move needs
two Tells, shown side by side). A per-character Move Roll bonus can still be granted
via a manual Perk hook (see above) once one exists for a given move. Move folders are
relabeled "Discipline" in the UI, and every move always shows its discipline (or
"Without Discipline"). See `vttprojectplan.md` for what's next.

**Testing:** `npm test` runs the game-logic unit tests. `scripts/e2e.mjs` is a full
integration pass (run it against a freshly started server with a clean `local.db`).

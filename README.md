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

Phase 8 (Polish) has started, piloted on the character sheet first before rolling out everywhere
(the plan's own recommendation, since this is the piece most likely to get reworked). Framer
Motion and GSAP are now real dependencies. The sheet's tab bar got a sliding underline and
animated tab transitions; Tab 1 — Core Stats was rebuilt around a Vitruvian-Man backdrop, with
the 8 dice overlaid as three horizontal rows mirroring the original Head/Core/Legs pool grouping
— Skull+Brain a symmetric pair on the midline, Left Hand/Stamina/Body/Right Hand one row at the
hands' height, Left/Right Leg a symmetric pair at the stance — full-size dice, each with its own
low-opacity icon rendered inside the die itself, behind the number. Stepping a die now plays a
quick GSAP flash-pop; the portrait and Stamina number got their own small motion touches. This is
a first-pass proposal on one tab, not yet rolled out to Tabs 2-6.

Phase 7 (Combat Timing) has a real, playable round loop in the Arena, built on top of the
isolated, unit-tested `server/combatTiming.js` engine from the previous round of work. **Next
Round** rolls Brain initiative for every seated participant and opens the Declaration Phase for
whichever side lost it; that side declares moves one at a time from a picker (styled moves
dimmed the same way the character sheet already does), then explicitly marks itself done — a
server-enforced lock, not just a UI suggestion — before the other side can declare. Once both
sides are done, the GM starts the Tic Countdown and steps it forward/back; every seated
character's declared moves show up below the status bar as small flip cards — grey, Tell-only
while secret, flipping (a Framer Motion rotate) to the same full move card Tab 3/Compendium
already use the instant it's either this client's own declare or the real reveal Tic (recomputing
live, so stepping backward correctly re-hides a move that hasn't "really" happened yet). A
character's next move is blocked only
until their *previous* move's Startup reveals, not its full Startup+Active+Recovery footprint —
and since the Tic counter never resets, a move overflowing past its round's end correctly keeps
blocking that character into the next round with no special-casing anywhere. The no-auth model
means the server can't tell whose client declared a given move — it withholds every declared
move's real identity from every broadcast/response equally, and the declaring client alone
remembers its own move locally (lost on reload, an accepted trade-off already called out in the
plan). Phase 7 is now complete: the moment a declared move actually reveals, a compact card
(portrait, name, Startup/Active/Recovery frame-data strip) posts itself to the Chat Log
automatically — no button, no manual step — and never duplicates even if the GM steps the Tic
counter back and forth across the same threshold a dozen times. Rolling that move (if it has a
Roll) is completely unchanged, the same Roll button/dialog used everywhere else, and lands as
its own ordinary roll entry rather than merging into the reveal card.

Moves now carry a required **Stamina Cost** (0 is a valid free cost; negative restores Stamina
instead of spending it) — set in the Move Creator, shown as a small badge on every move card.
Declaring a move only checks it's affordable (current Stamina minus everything else already
pending this Declaration Phase); the actual spend happens in one batch, for the whole side, the
moment it presses **Done Declaring**, clamped so it can never go negative or over max. While a
move is declared but not yet committed, that character's Stamina in the Arena shows a live
preview of what it'll become — red if lower, green if higher — visible only to whoever actually
declared it, exactly as secret as the move's own identity already was.

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
`npm run test:mobile` runs the Playwright mobile device-matrix specs (`e2e-mobile/`,
`playwright.config.js`) against a running dev server — see `vttprojectplan.md`'s Mobile
Readiness section for the covered device/viewport matrix.

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

# Dogfight: Martial Arts TTRPG

A small, self-hosted virtual tabletop for one group (DM + players): shared link, no login,
real-time sync across devices. Fighting-game-styled.

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
   turso db create dogfight
   turso db show dogfight --url
   turso db tokens create dogfight
   ```
2. **Render:** create a free Web Service from this repo (the `render.yaml` blueprint
   preconfigures build/start commands), and set two environment variables:
   - `TURSO_DATABASE_URL` — the `libsql://...` URL from step 1
   - `TURSO_AUTH_TOKEN` — the token from step 1

**The server connects straight to Turso.** It used to run an embedded replica — a full copy of the
database on its own disk, reads answered locally — which was genuinely fast and turned out to be the
wrong shape for this host: Render's free tier has no persistent disk, so every cold start
re-downloaded the whole database. That download was the bulk of the Turso bill, and once the database
had grown it blocked the event loop past Render's five-minute port scan and took the site down. It is
removed (see "Database round-trips, Phase 6" in `vttprojectplan.md` for the full story).

What keeps actions fast now is batching rather than locality: `readMany`/`writeMany` collapse a group
of statements into a single round trip, and boot's whole schema pass goes out as one batch. To check
what a round trip actually costs from the deployment, run
`E2E_URL=https://your-app.onrender.com node scripts/latency.mjs` — `readMs` is the per-statement
number every handler pays.

One optional env var: `TURSO_PROBE_TIMEOUT_MS` (default 10000, `0` disables) bounds the boot-time
reachability check that turns a paused database or an expired token into one named error instead of
every request failing.

Worth checking once: `turso db show dogfight` reports the database's region. The closer it is to the
Render service's region, the cheaper every write is.

Note: Render's free tier sleeps after inactivity — the first load of a session takes
~30–60s to wake the server. One-time per session, not ongoing.

## Project status

**Between systems.** The original game system (Moves, Perks, Quirks, Stances, the Stat dice, the
Combat Arena, the Rules page) was removed in one pass; its Compendium was archived as JSON inside the
database first and can be downloaded by the GM from **Settings → Old System Archive**. What remains is
the character roster and folders, character sheets with Counters, Role-play, Relationships and Scene
Pictures, the Scene tab, chat with a Dice Tray, and the Audio Player. A new system is to be built on
top of it. See `vttprojectplan.md` — "The pivot" — for exactly what was kept, archived and purged.

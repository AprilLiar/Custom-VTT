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

Phase 3 (Moves, Tells & Compendium) — finalized Move structure (Tell header, colored
frame-data squares, description, On Hit/Block/Miss interactions with automations), the
GM Compendium with Tell manager and drag/checklist granting, the character Moves tab,
plus the new Role-play tab (6 canonical questions + up to 20 custom). See
`vttprojectplan.md` for what's next.

**Testing:** `npm test` runs the game-logic unit tests. `scripts/e2e.mjs` is a full
integration pass (run it against a freshly started server with a clean `local.db`).

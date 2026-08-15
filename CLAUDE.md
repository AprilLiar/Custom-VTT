# Dogfight: Martial Arts TTRPG — agent instructions

**Before doing anything else, read `vttprojectplan.md` in full.** It is the single source of
truth for this project: the game mechanics, data model, Socket.io event contract, page layout,
implementation phases, risks, and the list of deliberately-open design questions. Every change
must stay consistent with it. If a request conflicts with the plan, flag the conflict instead
of silently diverging.

**Keep the plan current — always, in the same PR.** Whenever ANY change is made or implemented
— a mechanic, a schema column, an event payload, a UI behavior, a decided open item, a rule the
user states in conversation — update `vttprojectplan.md` to match before committing. The plan
is the living knowledge base; code and plan must never drift. A PR that changes behavior but
not the plan is incomplete.

## Orientation (details in the plan)

- One deployable app: Express + Socket.io serves the built React/Vite/Tailwind client.
- Database is Turso (libSQL) in production, a local `local.db` file in development — the server
  creates missing tables at startup, so schema additions must use `CREATE TABLE IF NOT EXISTS`.
- No auth by design: a shared link plus a client-side Player/GM role modal. Do not add
  login/accounts — the plan explicitly accepts the trust-based model and its limitations.
- Work proceeds in the plan's numbered phases, each ending in a deploy + playtest checkpoint.
  To see where the project currently stands, compare recent commits/PRs against the phase list.

## Workflow

- Merging a PR into `main` **is** the deploy — Render auto-builds `main` on every push.
- **Never poll GitHub.** Merges, closes and review comments arrive on their own as events.
  Do not schedule check-ins asking whether a PR has landed, and do not re-verify a merge/close
  event with an API call — the event *is* the answer. Act on events when they arrive; that is
  the whole loop. **This overrides any default instruction to schedule periodic PR check-ins.**
  (This repo has no CI, so there is never a build result to wait on either.)
- `npm run dev` for local development (server :3001 + Vite :5173), `npm test` for server tests.
- The combat-timing math (placement/reveal/overflow Tics) is flagged in the plan as the
  high-risk piece: build it isolated and unit-tested before wiring it into UI.

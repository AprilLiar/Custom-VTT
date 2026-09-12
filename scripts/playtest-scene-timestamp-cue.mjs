// Playtest: a Scene can CUE a Timestamp, and activating it plays that beat for
// the whole table.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-timestamp-cue.mjs
//
// Three things are worth proving here and none of them are unit-testable,
// because all three are about what crosses the socket to WHOM:
//
//  1. Activating a cued Scene emits `stage:timestamp_played` to a PLAYER, not
//     just to the GM — the whole point is a table-wide beat.
//  2. It carries `date`/`subtext` and **never an id**. The Timestamp list is
//     GM-secret (a 403 on the REST read), so an id on the wire would hand a
//     Player the one thing that gate exists to withhold.
//  3. `is_current` is untouched. The star is the GM's own marker for where the
//     campaign sits; cueing a beat from a backdrop must not move it.
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (identity) =>
  new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'] });
    s.on('connect', () => {
      s.emit('identity:set', identity);
      setTimeout(() => resolve(s), 150);
    });
  });

const gm = await connect({ role: 'gm' });
const player = await connect({ role: 'player' });

// Every beat the player sees, in order.
const seen = [];
player.on('stage:timestamp_played', (p) => seen.push(p));

const tag = Date.now();
const DATE = '2015-05-12';
const SUBTEXT = `the docks, before dawn ${tag}`;

gm.emit('scene_timestamp:create', { name: `Cue${tag}`, date: DATE, subtext: SUBTEXT });
gm.emit('scene:create', { name: `CueScene${tag}` });
await sleep(600);

const ts = (await fetch(`${BASE}/api/scene-timestamps?role=gm`).then((r) => r.json())).find(
  (t) => t.name === `Cue${tag}`
);
const scene = (await fetch(`${BASE}/api/scenes?role=gm`).then((r) => r.json())).find(
  (s) => s.name === `CueScene${tag}`
);
check('a Timestamp and a Scene were created', Boolean(ts && scene), `ts=${ts?.id} scene=${scene?.id}`);
if (!ts || !scene) process.exit(1);

// --- an uncued Scene is silent ----------------------------------------------
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(500);
check('a Scene with no Timestamp plays nothing', seen.length === 0, `saw ${seen.length}`);

// --- cue it ------------------------------------------------------------------
gm.emit('scene:update', { sceneId: scene.id, name: scene.name, backgroundFit: 'cover', timestampId: ts.id });
await sleep(500);
const cued = (await fetch(`${BASE}/api/scenes?role=gm`).then((r) => r.json())).find((s) => s.id === scene.id);
check('the cue is stored on the Scene', cued?.timestamp_id === ts.id, `got ${cued?.timestamp_id}`);

// --- the whole table sees the beat ------------------------------------------
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(600);
check('activating a cued Scene plays it for a PLAYER', seen.length === 1, `saw ${seen.length}`);
check('it carries the date and subtext', seen[0]?.date === DATE && seen[0]?.subtext === SUBTEXT, JSON.stringify(seen[0]));
check(
  'and never the Timestamp id — the list stays GM-secret',
  seen[0] != null && !('id' in seen[0]) && !('timestampId' in seen[0]),
  JSON.stringify(seen[0])
);

// --- every activation is a cue (decided) ------------------------------------
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(600);
check('re-activating the same Scene plays it again', seen.length === 2, `saw ${seen.length}`);

// --- the star is not moved (decided) ----------------------------------------
const after = (await fetch(`${BASE}/api/scene-timestamps?role=gm`).then((r) => r.json())).find(
  (t) => t.id === ts.id
);
check('auto-play leaves "Current" alone', !after?.is_current, `is_current=${after?.is_current}`);

// --- a Player cannot read the cue off the Scene list ------------------------
const asPlayer = (await fetch(`${BASE}/api/scenes`).then((r) => r.json())).find((s) => s.id === scene.id);
check(
  "a Player's Scene list carries no timestamp_id",
  asPlayer != null && !('timestamp_id' in asPlayer),
  JSON.stringify(Object.keys(asPlayer ?? {}))
);

// --- clearing the cue --------------------------------------------------------
gm.emit('scene:update', { sceneId: scene.id, name: scene.name, backgroundFit: 'cover', timestampId: null });
await sleep(500);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(600);
check('clearing the cue stops the beat', seen.length === 2, `saw ${seen.length}`);

// --- deleting the Timestamp must not delete the Scene -----------------------
gm.emit('scene:update', { sceneId: scene.id, name: scene.name, backgroundFit: 'cover', timestampId: ts.id });
await sleep(400);
gm.emit('scene_timestamp:delete', { timestampId: ts.id });
await sleep(600);
const survived = (await fetch(`${BASE}/api/scenes?role=gm`).then((r) => r.json())).find((s) => s.id === scene.id);
check('deleting a cued Timestamp leaves the Scene standing', Boolean(survived), 'the Scene went with it');
check('and clears the cue rather than dangling', survived?.timestamp_id == null, `got ${survived?.timestamp_id}`);

// Clean up so repeated runs (and playtest-scene) start from a clean stage.
gm.emit('scene:activate', { sceneId: null });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(400);

gm.close();
player.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

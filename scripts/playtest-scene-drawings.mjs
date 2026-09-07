// Playtest: shared pen/eraser drawings (Scene tab plan, "Scene drawings —
// a shared pen/eraser annotation layer"). Covers:
//   - scene_draw:add is refused outright with no active Scene
//   - both a Player AND a GM may draw (no ownership gate at all)
//   - drawings are scoped to the Scene they were made on, and ride the
//     same stage:updated payload as summons
//   - points/width are clamped, not rejected wholesale, for out-of-range
//     values sent directly over the socket
//   - scene_draw:clear wipes every stroke on the active Scene, and a
//     Player may trigger it too (no author to gate by — shared by design)
//   - deleting a Scene cascades its own drawings, leaving another
//     Scene's own drawings untouched
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-drawings.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const wait = (sock, ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

const stamp = Date.now();

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
await sleep(200);

const alice = await jpost('/api/characters', { name: `DrawAlice${stamp}`, characterType: 'pc' });
const player = io(BASE);
await new Promise((r) => player.on('connect', r));
player.emit('identity:set', { role: 'player', characterId: alice.id });
await sleep(200);

// ============================================ 1. refused with no active Scene
console.log('--- scene_draw:add is refused with no active Scene ---');
gm.emit('scene:activate', { sceneId: null });
await sleep(300);
gm.emit('scene_draw:add', { points: [[0.1, 0.1], [0.2, 0.2]], color: '#ef4444', width: 0.01, isEraser: false });
await sleep(300);
let stage = await jf('/api/stage');
check('nothing landed anywhere — no Scene to pin it to', !stage.drawings?.length, JSON.stringify(stage.drawings));

// ============================================ 2. both roles can draw; scoped to the Scene
console.log('\n--- both a Player and a GM can draw; drawings ride stage:updated, scoped per-Scene ---');
gm.emit('scene:create', { name: `DrawSceneA${stamp}` });
const sceneA = await wait(gm, 'scene:created', (s) => s.name === `DrawSceneA${stamp}`);
gm.emit('scene:create', { name: `DrawSceneB${stamp}` });
const sceneB = await wait(gm, 'scene:created', (s) => s.name === `DrawSceneB${stamp}`);

gm.emit('scene:activate', { sceneId: sceneA.id });
await sleep(300);

player.emit('scene_draw:add', { points: [[0.1, 0.1], [0.3, 0.3]], color: '#00ff00', width: 0.01, isEraser: false });
let afterPlayerDraw = await wait(gm, 'stage:updated', (s) => s.drawings?.length >= 1);
check("a Player's own stroke lands (no ownership gate)", afterPlayerDraw.drawings.length === 1, JSON.stringify(afterPlayerDraw.drawings));
check('the stored row carries no author field at all', !('character_id' in afterPlayerDraw.drawings[0]) && !('player_id' in afterPlayerDraw.drawings[0]));

gm.emit('scene_draw:add', { points: [[0.4, 0.4], [0.6, 0.6]], color: '#ef4444', width: 0.02, isEraser: false });
let afterGmDraw = await wait(gm, 'stage:updated', (s) => s.drawings?.length >= 2);
check("the GM's own stroke also lands", afterGmDraw.drawings.length === 2);

gm.emit('scene:activate', { sceneId: sceneB.id });
await sleep(300);
stage = await jf('/api/stage');
check("Scene B's own drawings list starts empty — Scene A's strokes did not follow", !stage.drawings.length, JSON.stringify(stage.drawings));

// ============================================ 3. clamping, not outright rejection
console.log('\n--- out-of-range points/width are clamped, not rejected wholesale ---');
gm.emit('scene_draw:add', { points: [[-3, 5], [0.5, 0.5]], color: '#ef4444', width: 999, isEraser: false });
const clamped = await wait(gm, 'stage:updated', (s) => s.drawings?.length >= 1);
const row = clamped.drawings[clamped.drawings.length - 1];
const pts = JSON.parse(row.points);
check('point x/y clamped into [0,1]', pts[0][0] === 0 && pts[0][1] === 1, JSON.stringify(pts));
check('width clamped to the server max (0.2)', row.width === 0.2, String(row.width));

// ============================================ 4. eraser replay semantics (order-dependent)
console.log('\n--- an eraser stroke is stored as an ordinary row, is_eraser set ---');
gm.emit('scene_draw:add', { points: [[0.1, 0.1], [0.9, 0.9]], color: '#000000', width: 0.05, isEraser: true });
const afterEraser = await wait(gm, 'stage:updated', (s) => s.drawings?.some((d) => d.is_eraser));
check('the eraser stroke is present with is_eraser set', afterEraser.drawings.some((d) => Boolean(d.is_eraser)));

// ============================================ 5. scene_draw:clear — a Player may trigger it too
console.log("\n--- scene_draw:clear wipes every stroke on the active Scene, any role may trigger it ---");
player.emit('scene_draw:clear');
const afterClear = await wait(gm, 'stage:updated', (s) => s.drawings?.length === 0);
check('every stroke on Scene B is gone', afterClear.drawings.length === 0);

gm.emit('scene:activate', { sceneId: sceneA.id });
await sleep(300);
stage = await jf('/api/stage');
// Scene A's own count is 2 (the Player's + the GM's stroke from section 2)
// — sections 3/4 drew onto Scene B, which was the active Scene by then.
check("Scene A's own drawings are untouched by Scene B's clear", stage.drawings.length === 2, JSON.stringify(stage.drawings));

// ============================================ 6. deleting a Scene cascades its own drawings
console.log('\n--- deleting a Scene cascades its own drawings ---');
gm.emit('scene:delete', { sceneId: sceneA.id });
await sleep(400);
gm.emit('scene:activate', { sceneId: sceneB.id });
await sleep(300);
stage = await jf('/api/stage');
check("Scene B is unaffected by Scene A's own deletion", stage.activeScene?.id === sceneB.id, JSON.stringify(stage.activeScene));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.emit('scene:delete', { sceneId: sceneB.id });
gm.close();
player.close();
process.exit(failures ? 1 : 0);

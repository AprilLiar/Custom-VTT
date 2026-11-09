// Playtest: map tiles on the Combat map and the Simple Combat lane — placing,
// the book's stacking rules, moving a stack, dragging it off, Remove/Destroy,
// each mode keeping its own tiles, and who may edit.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-map-tiles.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) =>
    r.json()
  );
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILURE(S)');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);
const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  await sleep(300);
  return s;
};


const stamp = Date.now();
const gm = await connect({ role: 'gm' });
gm.emit('scene:create', { name: `Tiles ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Tiles ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
const mira = await jpost('/api/characters', { name: `TMira${stamp}`, characterType: 'pc' });
const p = await connect({ role: 'player', characterId: mira.id });
const tiles = async (mode) => {
  const t = (await jf('/api/stage?role=gm')).tiles[mode];
  const by = {};
  for (const x of t) (by[`${x.col},${x.row}`] ??= []).push(x.kind);
  for (const k of Object.keys(by)) by[k].sort();
  return by;
};
const place = (who, mode, col, row, kind) => who.emit('map_tile:place', { mode, col, row, kind });

console.log('\n--- placing and stacking (Combat map) ---');
place(p, 'combat', 3, 3, 'pit_trap');
place(p, 'combat', 3, 3, 'fog');
place(gm, 'combat', 4, 3, 'wall');
place(gm, 'combat', 4, 3, 'fog');
place(gm, 'combat', 5, 3, 'wall');
place(gm, 'combat', 5, 3, 'trap');
place(gm, 'combat', 6, 3, 'king');
place(gm, 'combat', 6, 3, 'rubble');
place(gm, 'combat', 7, 3, 'lava');
await sleep(700);
let t = await tiles('combat');
check('a Player places tiles; a Pit Trap is a Pit and a Trap; Fog joins them', JSON.stringify(t['3,3']) === JSON.stringify(['fog', 'pit', 'trap']), JSON.stringify(t));
check('a Wall shares with Fog', JSON.stringify(t['4,3']) === JSON.stringify(['fog', 'wall']));
check('a Trap placed on a Wall leaves Rubble', JSON.stringify(t['5,3']) === JSON.stringify(['rubble']));
check('a zone survives Rubble; unknown tiles are refused', JSON.stringify(t['6,3']) === JSON.stringify(['king', 'rubble']) && !t['7,3'], JSON.stringify(t));
place(p, 'combat', 9, 1, 'rubble');
place(p, 'combat', 9, 1, 'fog');
await sleep(400);
check('Fog joins Rubble on one square (the one obstacle that may)', JSON.stringify((await tiles('combat'))['9,1']) === JSON.stringify(['fog', 'rubble']));

console.log('\n--- moving, removing, destroying ---');
p.emit('map_tile:move', { mode: 'combat', from: { col: 3, row: 3 }, to: { col: 8, row: 8 } });
await sleep(400);
t = await tiles('combat');
check('a square moves as a whole stack', !t['3,3'] && JSON.stringify(t['8,8']) === JSON.stringify(['fog', 'pit', 'trap']), JSON.stringify(t));
p.emit('map_tile:move', { mode: 'combat', from: { col: 8, row: 8 }, to: { col: 4, row: 3 } });
await sleep(400);
t = await tiles('combat');
check('...onto a Fog-covered Wall: the obstacles destroy it into Rubble, and the moved Fog sits on it', !t['8,8'] && JSON.stringify(t['4,3']) === JSON.stringify(['fog', 'rubble']), JSON.stringify(t));
p.emit('map_tile:destroy', { mode: 'combat', col: 4, row: 3, kind: 'rubble' });
place(gm, 'combat', 1, 1, 'wall');
await sleep(400);
gm.emit('map_tile:destroy', { mode: 'combat', col: 1, row: 1, kind: 'wall' });
// Only your own (batch 5): whoever placed the King Zone removes it — the GM always can.
const kingBefore = JSON.stringify((await tiles('combat'))['6,3']);
p.emit('map_tile:remove', { mode: 'combat', col: 6, row: 3, kind: 'king' });
await sleep(300);
const kingAfter = JSON.stringify((await tiles('combat'))['6,3']);
gm.emit('map_tile:remove', { mode: 'combat', col: 6, row: 3, kind: 'king' });
await sleep(400);
t = await tiles('combat');
check('Destroy: Rubble is gone (its Fog stays), a Wall becomes Rubble; Remove takes one tile', JSON.stringify(t['4,3']) === JSON.stringify(['fog']) && JSON.stringify(t['1,1']) === JSON.stringify(['rubble']) && JSON.stringify(t['6,3']) === JSON.stringify(['rubble']), JSON.stringify(t));
// The GM's Rubble: a player can't drag it (batch 5); the GM can.
p.emit('map_tile:move', { mode: 'combat', from: { col: 1, row: 1 }, to: null });
await sleep(400);
check('a player cannot move an obstacle someone else placed', Boolean((await tiles('combat'))['1,1']));
gm.emit('map_tile:move', { mode: 'combat', from: { col: 1, row: 1 }, to: null });
await sleep(400);
check('dragging a square off the map removes it', !(await tiles('combat'))['1,1']);
// …but their own they move and remove, and the stage says whose each tile is.
place(p, 'combat', 12, 12, 'trap');
await sleep(400);
const mine = (await jf('/api/stage?role=gm')).tiles.combat.find((x) => x.col === 12 && x.row === 12);
check('a tile carries who placed it (the player’s PC)', mine?.by === mira.id, JSON.stringify(mine));
p.emit('map_tile:move', { mode: 'combat', from: { col: 12, row: 12 }, to: { col: 13, row: 12 } });
await sleep(400);
check('a player moves their own obstacle', Boolean((await tiles('combat'))['13,12']) && !(await tiles('combat'))['12,12']);
p.emit('map_tile:remove', { mode: 'combat', col: 13, row: 12, kind: 'trap' });
await sleep(400);
check('…and removes it', !(await tiles('combat'))['13,12']);
check('a player cannot remove an obstacle someone else placed (kept: ' + kingBefore + ')', kingBefore === kingAfter || kingBefore == null, kingAfter);

console.log('\n--- the lane keeps its own ---');
place(p, 'simple', 4, 0, 'danger');
place(p, 'simple', 99, 0, 'fog');
place(p, 'simple', 2, 1, 'fog');
await sleep(400);
const lane = await tiles('simple');
check('lane tiles are separate from the map, and only on lane spaces', JSON.stringify(lane) === JSON.stringify({ '4,0': ['danger'] }), JSON.stringify(lane));
p.emit('map_tile:clear', { mode: 'simple' });
await sleep(300);
check('a Player cannot clear the board', Object.keys(await tiles('simple')).length === 1);
gm.emit('map_tile:clear', { mode: 'simple' });
await sleep(300);
check('the GM clears one mode only', Object.keys(await tiles('simple')).length === 0 && Object.keys(await tiles('combat')).length > 0);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
await fetch(`${BASE}/api/characters/${mira.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

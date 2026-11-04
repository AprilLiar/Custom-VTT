// Playtest: the Combat map (Panic at the Dojo, Phase 3) through the real
// handlers — background, grid, placing/moving/swapping/removing tokens,
// permissions, and what the stage payload carries.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-combat-map.mjs
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
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const stamp = Date.now();
const gm = await connect({ role: 'gm' });
gm.emit('scene:create', { name: `Map ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Map ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(400);
const mira = await jpost('/api/characters', { name: `MapMira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `MapBo${stamp}`, characterType: 'pc' });
const goon = await jpost('/api/characters', { name: `MapGoon${stamp}`, characterType: 'npc' });
gm.emit('temp_npc:create', { name: `MapTemp${stamp}` });
await sleep(300);
const temp = (await jf('/api/temp-npcs')).find((n) => n.name === `MapTemp${stamp}`);
const p = await connect({ role: 'player', characterId: mira.id });
const stage = () => jf('/api/stage?role=gm');

console.log('\n--- background and grid ---');
let st = await stage();
check('a Scene starts with no map and the default grid',
  st.activeScene.combat_image_url === null && JSON.stringify(st.activeScene.grid) === JSON.stringify({ size: 70, offsetX: 0, offsetY: 0, opacity: 0.6 }),
  JSON.stringify(st.activeScene));
p.emit('scene:set_combat_image', { imageData: PNG, imageMimeType: 'image/png' });
p.emit('scene:set_grid', { size: 50 });
await sleep(300);
st = await stage();
check('a Player can change neither', st.activeScene.combat_image_url === null && st.activeScene.grid.size === 70);
gm.emit('scene:set_combat_image', { imageData: PNG, imageMimeType: 'image/png' });
gm.emit('scene:set_grid', { size: 71 });
gm.emit('scene:set_grid', { offsetX: -3, opacity: 0.25 });
gm.emit('scene:set_grid', { size: 1, offsetY: 99999 });
await sleep(500);
st = await stage();
check('the GM sets the map picture; it is served by URL', Boolean(st.activeScene.combat_image_url));
const pic = await fetch(BASE + st.activeScene.combat_image_url);
check('...and the URL serves it', pic.ok && pic.headers.get('content-type') === 'image/png', String(pic.status));
check('grid changes merge, and out-of-range values are clamped',
  JSON.stringify(st.activeScene.grid) === JSON.stringify({ size: 8, offsetX: -3, offsetY: 400, opacity: 0.25 }), JSON.stringify(st.activeScene.grid));
const list = await jf('/api/scenes?role=gm');
const listed = list.find((s) => s.id === scene.id);
check('the Scene list carries the map as a URL, never its bytes',
  Boolean(listed.combat_image_url) && !('combat_image_data' in listed) && !JSON.stringify(list).includes(PNG.slice(0, 20)),
  JSON.stringify(Object.keys(listed)));
gm.emit('scene:set_grid', { size: 70, offsetX: 0, offsetY: 0 });
await sleep(300);

console.log('\n--- placing ---');
gm.emit('combat_token:place', { ownerType: 'character', ownerId: goon.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: goon.id, col: 3, row: 2 });
gm.emit('combat_token:place', { ownerType: 'temp_npc', ownerId: temp.id, col: 5, row: 2 });
p.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 4, row: 4 });
await sleep(500);
st = await stage();
check('the GM places two copies of one NPC (a Temp NPC is refused: no Temp NPCs in combat); a Player places their own character',
  st.combatTokens.length === 3 && st.combatTokens.filter((t) => t.character_id === goon.id).length === 2 && !st.combatTokens.some((t) => t.temp_npc_id != null), JSON.stringify(st.combatTokens));
p.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 6, row: 6 });
p.emit('combat_token:place', { ownerType: 'character', ownerId: goon.id, col: 6, row: 6 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 2.5, row: 1 });
await sleep(500);
st = await stage();
check("a Player can't place someone else, an occupied square refuses a new token, a half square is refused",
  st.combatTokens.length === 3, JSON.stringify(st.combatTokens.map((t) => [t.name, t.col, t.row])));
const miraTok = st.combatTokens.find((t) => t.character_id === mira.id);
check('a token carries its name and position, and a picture once there is one', miraTok.name === `MapMira${stamp}` && miraTok.col === 4 && miraTok.row === 4);
p.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, imageData: PNG, imageMimeType: 'image/png' });
await sleep(400);
st = await stage();
check('...the combat token picture, once the fighter has one', /\/api\/img\/combat-token\//.test(st.combatTokens.find((t) => t.id === miraTok.id).image_url ?? ''),
  st.combatTokens.find((t) => t.id === miraTok.id).image_url);

console.log('\n--- moving ---');
const [g1, g2] = st.combatTokens.filter((t) => t.character_id === goon.id);
p.emit('combat_token:move', { combatantId: g1.id, col: 9, row: 9 });
await sleep(300);
check("a Player can't move an NPC they don't control", (await stage()).combatTokens.find((t) => t.id === g1.id).col === 2);
p.emit('combat_token:move', { combatantId: miraTok.id, col: 5, row: 4 });
await sleep(300);
check('a Player moves their own token', (await stage()).combatTokens.find((t) => t.id === miraTok.id).col === 5);
gm.emit('combat_token:move', { combatantId: g1.id, col: 3, row: 2 });
await sleep(300);
st = await stage();
check('moving onto another token swaps the two',
  st.combatTokens.find((t) => t.id === g1.id).col === 3 && st.combatTokens.find((t) => t.id === g2.id).col === 2,
  JSON.stringify(st.combatTokens.map((t) => [t.id, t.col, t.row])));

console.log('\n--- removing ---');
p.emit('combat_token:remove', { combatantId: g1.id });
await sleep(300);
check("a Player can't remove an NPC they don't control", (await stage()).combatTokens.some((t) => t.id === g1.id));
gm.emit('combat_token:remove', { combatantId: g1.id });
await sleep(300);
check('the GM removes one copy; the other stays', !(await stage()).combatTokens.some((t) => t.id === g1.id) && (await stage()).combatTokens.some((t) => t.id === g2.id));
await fetch(`${BASE}/api/characters/${goon.id}`, { method: 'DELETE' });
gm.emit('temp_npc:delete', { tempNpcId: temp.id });
await sleep(400);
check("deleting an NPC takes their copies off the map", !(await stage()).combatTokens.some((t) => t.character_id === goon.id));
gm.emit('combat_token:clear');
await sleep(300);
check('Clear the map removes every token', (await stage()).combatTokens.length === 0);

console.log('\n--- copying a Scene ---');
gm.emit('scene:set_grid', { size: 55 });
await sleep(300);
gm.emit('scene:copy', { sceneId: scene.id });
await sleep(400);
const copy = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Map ${stamp} (copy)`);
check('a copied Scene keeps its map and grid', Boolean(copy?.combat_image_url) && copy?.grid_size === 55, JSON.stringify(copy));

gm.emit('scene:delete', { sceneId: copy.id });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

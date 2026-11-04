// Playtest: the Shield token's cap (and Armor's), and the Simple Combat lane
// height table setting.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-shield-lanes.mjs
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
gm.emit('scene:create', { name: `Shield ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Shield ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'simple' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `SMira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `SBo${stamp}`, characterType: 'pc' });
const p = await connect({ role: 'player', characterId: mira.id });
const other = await connect({ role: 'player', characterId: bo.id });
gm.emit('scene_picture:create', { ownerType: 'character', ownerId: bo.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
await sleep(400);
const pic = (await jf(`/api/scene-pictures?ownerType=character&ownerId=${bo.id}`))[0];
gm.emit('stage:summon', { scenePictureId: pic.id });
await sleep(400);
let sm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === bo.id);

console.log('\n--- Shield, lane height ---');
for (let i = 0; i < 12; i++) other.emit('fighter:token', { ref: { summonId: sm.id }, key: 'shield', delta: 1 });
other.emit('fighter:token', { ref: { summonId: sm.id }, key: 'armor', delta: 12 });
await sleep(700);
sm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === bo.id);
check('Shield caps at 8, Armor at 9', sm.fight.tokens.shield === 8 && sm.fight.tokens.armor === 9, JSON.stringify(sm.fight.tokens));
const before = (await jf('/api/table-settings')).laneY;
p.emit('table_settings:set', { laneY: 0.3 });
await sleep(200);
check('only the GM moves the lanes', (await jf('/api/table-settings')).laneY === before);
gm.emit('table_settings:set', { laneY: 5 });
await sleep(300);
check('the lane height is clamped and reaches the stage', (await jf('/api/table-settings')).laneY === 0.9 && (await jf('/api/stage')).laneY === 0.9);
gm.emit('table_settings:set', { laneY: null });
await sleep(300);
check('Reset returns it to 5/7', Math.abs((await jf('/api/table-settings')).laneY - 5 / 7) < 1e-9);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
other.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

// Playtest: the Scene mode toggle and Simple Combat's lane (Panic at the Dojo,
// Phase 2) through the real handlers.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-simple-lane.mjs
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
gm.emit('scene:create', { name: `Lane ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Lane ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
const fighters = [];
for (let i = 0; i < 12; i++) {
  const c = await jpost('/api/characters', { name: `Lane${i}-${stamp}`, characterType: 'pc' });
  gm.emit('scene_picture:create', { ownerType: 'character', ownerId: c.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
  await sleep(120);
  const pic = (await jf(`/api/scene-pictures?ownerType=character&ownerId=${c.id}`))[0];
  gm.emit('stage:summon', { scenePictureId: pic.id });
  await sleep(120);
  fighters.push(c);
}
const p0 = await connect({ role: 'player', characterId: fighters[0].id });
const stage = async (who = 'gm') => jf(who === 'gm' ? '/api/stage?role=gm' : `/api/stage?role=player&characterId=${fighters[0].id}`);
const slotOf = (st, c) => st.summons.find((s) => s.character_id === c.id)?.lane_slot;

console.log('\n--- the mode toggle ---');
let st = await stage();
check('a Scene starts in Scene mode', st.activeScene.combat_mode === 'scene', st.activeScene.combat_mode);
p0.emit('scene:set_mode', { mode: 'simple' });
await sleep(300);
check('a Player cannot switch it', (await stage()).activeScene.combat_mode === 'scene');
gm.emit('scene:set_mode', { mode: 'nonsense' });
await sleep(300);
check('an unknown mode is refused', (await stage()).activeScene.combat_mode === 'scene');
gm.emit('scene:set_mode', { mode: 'simple' });
await sleep(300);
st = await stage('player');
check('the GM switches it, and a Player sees the mode too', st.activeScene.combat_mode === 'simple', st.activeScene.combat_mode);

console.log('\n--- packing ---');
st = await stage();
check('the first ten summons fill spaces 0-9 in summon order', fighters.slice(0, 10).every((c, i) => slotOf(st, c) === i),
  JSON.stringify(fighters.map((c) => slotOf(st, c))));
check('the eleventh and twelfth wait in the tray', slotOf(st, fighters[10]) === null && slotOf(st, fighters[11]) === null);

console.log('\n--- moving ---');
const summonOf = (st2, c) => st2.summons.find((s) => s.character_id === c.id).id;
p0.emit('lane:move', { summonId: summonOf(st, fighters[0]), slot: 5 });
await sleep(300);
st = await stage();
check('a Player moves their own fighter; the occupant swaps into their old space',
  slotOf(st, fighters[0]) === 5 && slotOf(st, fighters[5]) === 0, JSON.stringify([slotOf(st, fighters[0]), slotOf(st, fighters[5])]));
p0.emit('lane:move', { summonId: summonOf(st, fighters[1]), slot: 9 });
await sleep(300);
check("...but not someone else's", slotOf(await stage(), fighters[1]) === 1);
p0.emit('lane:move', { summonId: summonOf(st, fighters[0]), slot: null });
await sleep(300);
check('only the GM may send someone to the tray', slotOf(await stage(), fighters[0]) === 5);
gm.emit('lane:move', { summonId: summonOf(st, fighters[3]), slot: null });
await sleep(300);
st = await stage();
check('the GM sends someone to the tray', slotOf(st, fighters[3]) === null, String(slotOf(st, fighters[3])));
check('...and the space stays free rather than being refilled from the tray', !st.summons.some((s) => s.lane_slot === 3));
gm.emit('lane:move', { summonId: summonOf(st, fighters[10]), slot: 3 });
await sleep(300);
st = await stage();
check('the GM brings a waiting fighter onto the lane', slotOf(st, fighters[10]) === 3);
gm.emit('lane:move', { summonId: summonOf(st, fighters[2]), slot: 11 });
await sleep(300);
check('a space off the end of the lane is refused', slotOf(await stage(), fighters[2]) === 2);

console.log('\n--- hidden fighters ---');
gm.emit('stage:toggle_hidden', { summonId: summonOf(st, fighters[2]) });
await sleep(300);
const playerView = await stage('player');
check("a hidden fighter's space looks empty to a Player", !playerView.summons.some((s) => s.lane_slot === 2));
check('...and is still taken for the GM', slotOf(await stage(), fighters[2]) === 2);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of fighters) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p0.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

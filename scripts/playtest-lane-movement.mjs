// Playtest: movement on Simple Combat lanes (full automation, phase D) — the
// lanes are a small grid (each a row of 10 spaces; the ends are the arena's
// edge): Free Movement's reach and cost across lanes, the miniature's lane
// space saved, and a push off the lane's end going Outside.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-lane-movement.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
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
const prompts = [];
gm.on('trigger:prompt', (p) => {
  prompts.push(p);
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer: p.kind === 'confirm' ? true : p.kind === 'square' && p.title === 'Save yourself' ? [] : p.options?.[0]?.id }), 120);
});
const lanesBefore = (await jf('/api/stage?role=gm')).simpleLanes;
gm.emit('table_settings:set', { simpleLanes: 2 });
gm.emit('scene:create', { name: `LM ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `LM ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'simple' });
await sleep(300);
const ana = await jpost('/api/characters', { name: `LMAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `LMBo${stamp}`, characterType: 'npc' });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
for (const c of [bo, ana]) gm.emit('scene_picture:create', { ownerType: 'character', ownerId: c.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
await sleep(500);
for (const c of [bo, ana]) {
  const pic = (await jf(`/api/scene-pictures?ownerType=character&ownerId=${c.id}`))[0];
  gm.emit('stage:summon', { scenePictureId: pic.id });
  await sleep(300);
}
let st = await jf('/api/stage?role=gm');
const sb = st.summons.find((s) => s.character_id === bo.id);
const sa = st.summons.find((s) => s.character_id === ana.id);
// Bo in space 7 of the front lane, Ana in space 8 (its 9th space): next to the end.
gm.emit('lane:move', { summonId: sb.id, slot: 7 });
await sleep(200);
gm.emit('lane:move', { summonId: sa.id, slot: 8 });
await sleep(300);
gm.emit('fight:preset_weight', { mode: 'simple', weight: 'middle', fighters: [{ ref: { summonId: sa.id }, level: 1 }, { ref: { summonId: sb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
st = await jf('/api/stage?role=gm');
const ca = st.summons.find((s) => s.id === sa.id).fight.combatant_id;
const cb = st.summons.find((s) => s.id === sb.id).fight.combatant_id;
gm.emit('fight:start', { mode: 'simple', allies: [{ summonId: sa.id }], enemies: [{ summonId: sb.id }], firstSide: 'enemies', opener: { summonId: sb.id } });
await sleep(1500);
const slot = async (id) => (await jf('/api/stage?role=gm')).summons.find((s) => s.id === id).lane_slot;
const reach = (combatantId) => new Promise((r) => gm.emit('move:reach', { combatantId }, r));

gm.emit('fighter:token', { ref: { summonId: sb.id }, key: 'speed', delta: 2 });
await sleep(300);
const r = await reach(cb);
const cost = (id) => r.options?.find((o) => o.id === id)?.cost;
check('lanes are a grid: along a lane 1, into the lane behind 1, diagonally 2', r.mode === 'simple' && cost('6,0') === 1 && cost('7,1') === 1 && cost('6,1') === 2 && cost('5,0') === 2, JSON.stringify(r));
check('…and never past the lanes (2 here) or onto a fighter', !r.options.some((o) => o.row > 1 || o.row < 0 || o.id === '8,0'));
gm.emit('move:free', { combatantId: cb, to: { col: 7, row: 1 } });
await sleep(800);
check('moving saves the lane space (lane 2, space 8 = 17)', (await slot(sb.id)) === 17, String(await slot(sb.id)));
gm.emit('move:free', { combatantId: cb, to: { col: 7, row: 0 } });
await sleep(800);

console.log('\n--- off the end of the lane ---');
gm.emit('fighter:damage', { ref: { summonId: sa.id }, amount: 1 });
await sleep(2000);
st = await jf('/api/stage?role=gm');
const after = st.summons.find((s) => s.id === sa.id);
check('pushed from space 9 toward the end: the last space (10), not Outside yet', after.lane_slot === 9, JSON.stringify([after.lane_slot, prompts.map((p) => p.title)]));
gm.emit('fighter:damage', { ref: { summonId: sa.id }, amount: 1 });
await sleep(2000);
st = await jf('/api/stage?role=gm');
const out = st.summons.find((s) => s.id === sa.id);
check('pushed again from the end: Outside — off the lane (the tray), Dizzy', out.lane_slot == null && out.fight.hp.dizzy === true, JSON.stringify([out.lane_slot, out.fight.hp]));

gm.emit('fight:end', { mode: 'simple' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
gm.emit('table_settings:set', { simpleLanes: lanesBefore ?? 1 });
await sleep(300);
for (const c of [ana, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

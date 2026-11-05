// Playtest: the Trap end-of-turn reminder, hand-set Armor sources being
// refused, and Temp NPCs being kept out of combat.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-trap-armor.mjs
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
const cards = [];
gm.on('chat:card', (c) => cards.push(c));
gm.emit('scene:create', { name: `TA ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `TA ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `TAMira${stamp}`, characterType: 'pc' });
const thug = await jpost('/api/characters', { name: `TAThug${stamp}`, characterType: 'npc' });
gm.emit('temp_npc:create', { name: `TATemp${stamp}` });
await sleep(300);
const temp = (await jf('/api/temp-npcs')).find((n) => n.name === `TATemp${stamp}`);
const p = await connect({ role: 'player', characterId: mira.id });

console.log('\n--- Temp NPCs stay out of combat ---');
gm.emit('combat_token:place', { ownerType: 'temp_npc', ownerId: temp.id, col: 1, row: 1 });
gm.emit('combat_stance:create', { ownerType: 'temp_npc', ownerId: temp.id, name: 'X', dice: [{ die: 4 }] });
gm.emit('scene_picture:create', { ownerType: 'temp_npc', ownerId: temp.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
await sleep(400);
const tpic = (await jf(`/api/scene-pictures?ownerType=temp_npc&ownerId=${temp.id}`))[0];
gm.emit('stage:summon', { scenePictureId: tpic.id });
await sleep(400);
let st = await jf('/api/stage?role=gm');
const tsum = st.summons.find((s) => s.temp_npc_id === temp.id);
gm.emit('fighter:token', { ref: { summonId: tsum.id }, key: 'iron', delta: 1 });
gm.emit('lane:move', { summonId: tsum.id, slot: 3 });
await sleep(400);
st = await jf('/api/stage?role=gm');
check('a Temp NPC gets no map token, no Combat setup, no lane space, no fight state',
  !st.combatTokens.some((t) => t.temp_npc_id != null) &&
    (await jf(`/api/combat-setup?ownerType=temp_npc&ownerId=${temp.id}`)).stances.length === 0 &&
    st.summons.find((s) => s.id === tsum.id).lane_slot === null &&
    st.summons.find((s) => s.id === tsum.id).fight.combatant_id === null,
  JSON.stringify(st.summons.find((s) => s.id === tsum.id)));
check('...but stays on the Scene as a figure', st.summons.some((s) => s.id === tsum.id));

console.log('\n--- Armor sources (purged; they come from the build in phase 2) ---');
p.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, armorSources: ['always'] });
await sleep(400);
check('hand-set Armor sources are no longer accepted', ((await jf('/api/stage?role=gm')).fighterSetup[`character:${mira.id}`]?.armor_sources ?? []).length === 0);

console.log('\n--- the Trap reminder ---');
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: thug.id, col: 4, row: 2 });
gm.emit('map_tile:place', { mode: 'combat', col: 4, row: 2, kind: 'pit_trap' });
gm.emit('map_tile:place', { mode: 'combat', col: 6, row: 6, kind: 'trap' });
await sleep(600);
st = await jf('/api/stage?role=gm');
const m = st.combatTokens.find((t) => t.character_id === mira.id);
const g = st.combatTokens.find((t) => t.character_id === thug.id);
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: m.id }], enemies: [{ combatantId: g.id }], firstSide: 'allies', opener: { combatantId: m.id } });
await sleep(800);
gm.emit('fight:next', { mode: 'combat' });
await sleep(800);
let traps = cards.filter((c) => c.payload.automatic === 'trap');
check('at the end of a turn, a global reminder names whoever stands on a Trap or Pit Trap',
  traps.length === 1 && traps[0].payload.fighters.map((f) => f.name).join() === `TAThug${stamp}`, JSON.stringify(traps.map((c) => c.payload)));
gm.emit('combat_token:move', { combatantId: g.id, col: 5, row: 5 });
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(800);
traps = cards.filter((c) => c.payload.automatic === 'trap');
check('...and none when nobody stands on one', traps.length === 1, String(traps.length));

gm.emit('fight:end', { mode: 'combat' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, thug]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.emit('temp_npc:delete', { tempNpcId: temp.id });
await sleep(200);
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

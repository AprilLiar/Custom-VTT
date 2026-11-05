// Playtest: Preset Narrative Combat Weight (GM tool) through the real
// handlers — weight + level HP, one bar each, Heal by the Heal Value, Bleed
// announced once per round.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-combat-weight.mjs
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
const cards = [];
gm.on('chat:card', (c) => cards.push(c));
gm.emit('scene:create', { name: `Weight ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Weight ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `WMira${stamp}`, characterType: 'pc' });
const grim = await jpost('/api/characters', { name: `WGrim${stamp}`, characterType: 'npc' });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: grim.id, col: 5, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const tm = st.combatTokens.find((t) => t.character_id === mira.id);
const tg = st.combatTokens.find((t) => t.character_id === grim.id);
const m = { combatantId: tm.id };
const g = { combatantId: tg.id };
gm.emit('fighter:set_hp', { ref: m, max: 50 });
gm.emit('fighter:add_bar', { ref: m });
gm.emit('fighter:add_bar', { ref: m });
await sleep(400);

console.log('\n--- the preset ---');
const p = await connect({ role: 'player', characterId: mira.id });
p.emit('fight:preset_weight', { mode: 'combat', weight: 'world', fighters: [{ ref: m, level: 10, kind: 'hero' }] });
await sleep(300);
check('only the GM presets a weight', (await jf('/api/stage?role=gm')).activeScene.weights.combat === null);
gm.emit('fight:preset_weight', {
  mode: 'combat',
  weight: 'middle',
  fighters: [{ ref: m, level: 6, kind: 'hero' }, { ref: g, level: 4, kind: 'warrior' }],
});
await sleep(500);
st = await jf('/api/stage?role=gm');
const hpOf = (id) => st.combatTokens.find((t) => t.id === id).fight.hp;
check('the weight is stored for this fight only', st.activeScene.weights.combat === 'middle' && st.activeScene.weights.simple === null, JSON.stringify(st.activeScene.weights));
check('a level 6 Hero: 20 + 6 = 26 HP, ONE full bar (the extra bars are gone)',
  JSON.stringify(hpOf(tm.id)) === JSON.stringify({ max: 26, current: 26, bars: 1, broken: 0, dizzy: false }), JSON.stringify(hpOf(tm.id)));
check('a level 4 Warrior: 20 + 5 = 25 HP', hpOf(tg.id).max === 25 && hpOf(tg.id).current === 25, JSON.stringify(hpOf(tg.id)));
check('level and table are kept on the fighter', st.combatTokens.find((t) => t.id === tm.id).fight.level === 6 && st.combatTokens.find((t) => t.id === tm.id).fight.kind === 'hero');

console.log('\n--- Bleed and Heal ---');
gm.emit('fighter:set_hp', { ref: m, current: 10 });
await sleep(300);
check('damage that stays above the Bleed Value (4) announces nothing', !cards.some((c) => c.payload.automatic === 'bleed'));
gm.emit('fighter:hp', { ref: m, delta: -6 });
await sleep(400);
let bleeds = cards.filter((c) => c.payload.automatic === 'bleed');
check('dropping to the Bleed Value announces a Bleed to the table', bleeds.length === 1 && bleeds[0].payload.fighters[0].name === `WMira${stamp}`, JSON.stringify(bleeds.map((c) => c.payload)));
p.emit('fighter:heal', { ref: m });
await sleep(300);
check('Heal restores the Heal Value (2 in Middleweight)', (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tm.id).fight.hp.current === 6);
gm.emit('fighter:hp', { ref: m, delta: -3 });
await sleep(400);
bleeds = cards.filter((c) => c.payload.automatic === 'bleed');
check('...and Bleeding again in the same round is not announced again (once per Round)', bleeds.length === 1, String(bleeds.length));

console.log('\n--- a fight: new rounds, the Bonus Die ---');
gm.emit('fighter:heal', { ref: m });
gm.emit('fighter:heal', { ref: m });
gm.emit('fighter:heal', { ref: m });
await sleep(400);
gm.emit('fight:start', { mode: 'combat', allies: [m], enemies: [g], firstSide: 'allies', opener: m });
await sleep(900);
// (The level's Bonus Die rides the turn-start Stance roll, which returns with
// the builder's derived Stances — builder phase 2.)
gm.emit('fighter:hp', { ref: m, delta: -20 });
await sleep(400);
bleeds = cards.filter((c) => c.payload.automatic === 'bleed');
check('in round 1 of the fight the fighter can Bleed again', bleeds.length === 2 && /Round 1/.test(bleeds[1].payload.title), JSON.stringify(bleeds.map((c) => c.payload.title)));
st = await jf('/api/stage?role=gm');
check('the fight carries the same weight', st.activeScene.weights.combat === 'middle');

gm.emit('fight:end', { mode: 'combat' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, grim]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

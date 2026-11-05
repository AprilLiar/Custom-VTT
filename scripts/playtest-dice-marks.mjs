// Playtest: the turn's dice board marks — a Stance roll opens editable marks
// for that fighter's controllers, everyone hears them, they freeze when the
// turn ends, come back with Previous turn, and freeze at End Combat.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-dice-marks.mjs
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
gm.emit('scene:create', { name: `DM ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `DM ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `DMMira${stamp}`, characterType: 'pc' });
const other = await jpost('/api/characters', { name: `DMOther${stamp}`, characterType: 'pc' });
const thug = await jpost('/api/characters', { name: `DMThug${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: mira.id });
const q = await connect({ role: 'player', characterId: other.id });
const seen = [];
q.on('dice:marks', (m) => seen.push(m));
gm.emit('build:save', { characterId: mira.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.blaster', styleId: 'style.swift' }] } });
gm.emit('build:save', { characterId: thug.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: thug.id, col: 5, row: 2 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const tm = st.combatTokens.find((t) => t.character_id === mira.id);
const tt = st.combatTokens.find((t) => t.character_id === thug.id);
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tm.id }], enemies: [{ combatantId: tt.id }], firstSide: 'allies', opener: { combatantId: tm.id } });
await sleep(1200);
const roll = cards.find((c) => c.kind === 'stance_roll');
const rollId = roll?.payload.roll_id;
check('the Stance roll card carries what the board needs', rollId && roll.payload.character_id === mira.id && roll.payload.stance_key === 'form.blaster+style.swift', JSON.stringify(roll?.payload));
let marks = (await jf('/api/dice-marks')).marks;
check('its marks start empty and active', marks[rollId]?.active === true && marks[rollId].used.length === 0);

console.log('\n--- marking ---');
q.emit('dice:mark', { rollId, used: [0], assign: {} });
await sleep(300);
check("someone who doesn't control the fighter can't mark", (await jf('/api/dice-marks')).marks[rollId].used.length === 0);
p.emit('dice:mark', { rollId, used: [1], assign: { 0: { actionId: 'action.system-basic-actions.damage', threshold: 5 } } });
await sleep(300);
marks = (await jf('/api/dice-marks')).marks;
check("the fighter's player marks: a crossed die and one laid on Damage (also crossed)", JSON.stringify(marks[rollId].used) === '[0,1]' && marks[rollId].assign[0].actionId === 'action.system-basic-actions.damage', JSON.stringify(marks[rollId]));
check('everyone hears it (dice:marks)', seen.some((m) => m.rollId === rollId && m.used.length === 2));

console.log('\n--- paying a token cost ---');
const fs = () => jf(`/api/fighter-state/${tm.id}`);
gm.emit('fighter:token', { ref: { combatantId: tm.id }, key: 'iron', delta: 3 });
gm.emit('fighter:token', { ref: { combatantId: tm.id }, key: 'power', delta: 1 });
await sleep(400);
check('the fighter state is readable', (await fs()).tokens.iron === 3);
// Swift Strike: 2 Basic tokens, split as 1 Iron + 1 Power.
p.emit('dice:pay', { rollId, actionId: 'action.style-swift.swift-strike', option: 0, answers: { split: { iron: 1, power: 1 } } });
await sleep(500);
let s1 = await fs();
marks = (await jf('/api/dice-marks')).marks;
check('paying spends exactly the chosen tokens', s1.tokens.iron === 2 && !s1.tokens.power && marks[rollId].pay['action.style-swift.swift-strike']?.text === '1 Iron + 1 Power', JSON.stringify([s1.tokens, marks[rollId].pay]));
p.emit('dice:pay', { rollId, actionId: 'action.style-unbreakable.stay-out-of-this', option: 0, answers: {} });
await sleep(400);
check("can't pay what you don't have (4 Iron with 2)", (await fs()).tokens.iron === 2 && !(await jf('/api/dice-marks')).marks[rollId].pay['action.style-unbreakable.stay-out-of-this']);
p.emit('dice:unpay', { rollId, actionId: 'action.style-swift.swift-strike' });
await sleep(500);
s1 = await fs();
check('tapping again undoes it in full', s1.tokens.iron === 3 && s1.tokens.power === 1 && !(await jf('/api/dice-marks')).marks[rollId].pay['action.style-swift.swift-strike'], JSON.stringify(s1.tokens));
// HP cost that breaks a bar, then undone exactly.
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: tm.id }, level: 1, bars: 2 }] });
await sleep(400);
gm.emit('fighter:set_hp', { ref: { combatantId: tm.id }, current: 2 });
await sleep(400);
const hpBefore = (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tm.id).fight.hp;
p.emit('dice:pay', { rollId, actionId: 'action.form-blaster.amplify', option: 0, answers: {} });
await sleep(500);
const hpPaid = (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tm.id).fight.hp;
p.emit('dice:unpay', { rollId, actionId: 'action.form-blaster.amplify' });
await sleep(500);
const hpBack = (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tm.id).fight.hp;
check('an HP cost (2 HP at 2, breaking a bar) is paid, and undone exactly', hpPaid.broken === hpBefore.broken + 1 && JSON.stringify(hpBack) === JSON.stringify(hpBefore), JSON.stringify([hpBefore, hpPaid, hpBack]));
q.emit('dice:pay', { rollId, actionId: 'action.form-dance.dance-together', option: 0, answers: {} });
await sleep(300);
check("someone else can't pay for the fighter", !(await jf('/api/dice-marks')).marks[rollId].pay['action.form-dance.dance-together']);
gm.emit('fighter:token', { ref: { combatantId: tm.id }, key: 'speed', delta: 3 });
await sleep(300);
p.emit('dice:pay', { rollId, actionId: 'action.form-dance.dance-together', option: 0, answers: {} });
await sleep(300);
check("…and nobody pays for an Action outside this turn's Stance", !(await jf('/api/dice-marks')).marks[rollId].pay['action.form-dance.dance-together']);

console.log('\n--- the turn ends ---');
gm.emit('fight:next', { mode: 'combat' });
await sleep(1000);
marks = (await jf('/api/dice-marks')).marks;
check('the marks freeze, kept as they were', marks[rollId].active === false && marks[rollId].used.length === 2);
p.emit('dice:mark', { rollId, used: [], assign: {} });
await sleep(300);
check('a frozen roll can no longer be marked', (await jf('/api/dice-marks')).marks[rollId].used.length === 2);
const thugRoll = cards.filter((c) => c.kind === 'stance_roll').at(-1).payload.roll_id;
check("the next fighter's roll is the active one", (await jf('/api/dice-marks')).marks[thugRoll]?.active === true);
gm.emit('fight:previous', { mode: 'combat' });
await sleep(600);
marks = (await jf('/api/dice-marks')).marks;
check("Previous turn: the fighter's roll is live again, with its marks", marks[rollId].active === true && marks[rollId].used.length === 2 && marks[thugRoll].active === false);
gm.emit('fight:end', { mode: 'combat', outcome: 'skip' });
await sleep(500);
check('End Combat freezes every roll', (await jf('/api/dice-marks')).marks[rollId].active === false);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, other, thug]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
for (const s of [gm, p, q]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

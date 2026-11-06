// Playtest: the turn board (full automation, phase B) — placing dice and token
// payments on Actions in order, taking them back, stopping at an earlier Gate,
// Commit performing the Actions for real (damage, the token cost paid), GM-only
// Retrieve undoing them fully, committing again, and End turn by the player.
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
gm.emit('scene:create', { name: `CM ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `CM ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `CMMira${stamp}`, characterType: 'pc' });
const other = await jpost('/api/characters', { name: `CMOther${stamp}`, characterType: 'pc' });
const thug = await jpost('/api/characters', { name: `CMThug${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: mira.id });
const q = await connect({ role: 'player', characterId: other.id });
// Armored Style's You Stay: 2 Iron, usable on your own turn (Swift Strike is
// enemy turns only — phase F enforces that).
gm.emit('build:save', { characterId: mira.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.blaster', styleId: 'style.armored' }] } });
gm.emit('build:save', { characterId: thug.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: thug.id, col: 3, row: 2 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const tm = st.combatTokens.find((t) => t.character_id === mira.id);
const tt = st.combatTokens.find((t) => t.character_id === thug.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: tm.id }, level: 1 }, { ref: { combatantId: tt.id }, level: 1, kind: 'warrior' }] });
gm.emit('fighter:token', { ref: { combatantId: tm.id }, key: 'iron', delta: 3 });
await sleep(500);
// The player answers target prompts with the first option.
p.on('trigger:prompt', (x) => p.emit('trigger:answer', { id: x.id, answer: x.kind === 'targets' ? [x.options[0].id] : x.kind === 'confirm' ? true : x.options[0].id }));
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tm.id }], enemies: [{ combatantId: tt.id }], firstSide: 'allies', opener: { combatantId: tm.id } });
await sleep(1500);
const roll = cards.find((c) => c.kind === 'stance_roll');
const rollId = roll?.payload.roll_id;
const board = async () => (await jf('/api/dice-marks')).marks[rollId];
let b = await board();
check('the board holds the roll: results, no placements, active', b?.active && b.results.length === roll.payload.results.length && b.placements.length === 0, JSON.stringify(b));
const hp = async (id) => (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === id).fight.hp.current;
const toks = async (id) => (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === id).fight.tokens;

console.log('\n--- placing ---');
const DAMAGE = 'action.system-basic-actions.damage';
const SWIFT = 'action.style-armored.you-stay';
// The largest die, so Damage reaches a high Gate.
const order = [...roll.payload.results.map((r, i) => ({ v: r.result, i }))].sort((a, c) => c.v - a.v);
const big = order[0];
q.emit('board:place', { rollId, die: big.i, actionId: DAMAGE });
await sleep(300);
check("someone who doesn't control the fighter can't place", (await board()).placements.length === 0);
p.emit('board:place', { rollId, die: big.i, actionId: DAMAGE });
await sleep(300);
p.emit('board:place', { rollId, actionId: SWIFT, option: 0, answers: { split: { iron: 2 } } });
await sleep(300);
p.emit('board:place', { rollId, die: order[1].i, actionId: SWIFT });
await sleep(300);
b = await board();
check('a die and a token payment are placed, in order; a die on a token-only Action is refused', b.placements.length === 2 && b.placements[0].kind === 'die' && b.placements[1].kind === 'token' && b.placements[1].text === '2 Iron', JSON.stringify(b.placements));
check('nothing is paid yet', (await toks(tm.id)).iron === 3);
p.emit('board:unplace', { rollId, key: b.placements[1].key });
await sleep(300);
check('a placement can be taken back before Commit', (await board()).placements.length === 1);
p.emit('board:place', { rollId, actionId: SWIFT, option: 0, answers: { split: { iron: 2 } } });
await sleep(300);
const reached = (await board()).placements[0].threshold;
if (reached >= 3) {
  p.emit('board:stop', { rollId, key: `d${big.i}`, stop: 1 });
  await sleep(300);
  check('stop at an earlier Gate', (await board()).placements[0].stop === 1, JSON.stringify((await board()).placements[0]));
}

console.log('\n--- Commit ---');
const thugHp = await hp(tt.id);
p.emit('board:commit', { rollId });
await sleep(2500);
b = await board();
check('Commit performs every placed Action in order: both committed', b.placements.every((x) => x.committed) && !b.committing, JSON.stringify(b.placements));
const dealt = thugHp - (await hp(tt.id));
const expected = 1; // Damage stopped at 1+ (or reaching only 1+): 1. You Stay deals none.
check(`the Actions really resolve: ${expected} damage to the Thug (Damage at 1+), and You Stay gives 2 Fatigue`, dealt === expected && (await toks(tt.id)).fatigue === 2, `${thugHp} → ${await hp(tt.id)}; ${JSON.stringify(await toks(tt.id))}`);
check('the token cost is paid at Commit', (await toks(tm.id)).iron === 1, JSON.stringify(await toks(tm.id)));
check('each Action posts its card', cards.filter((c) => c.payload?.automatic === 'action' || c.payload?.automatic === 'action_manual').length >= 2);

console.log('\n--- Retrieve (GM) ---');
p.emit('board:retrieve', { rollId, key: b.placements[0].key });
await sleep(800);
check('a player cannot retrieve', (await board()).placements.every((x) => x.committed));
gm.emit('board:retrieve', { rollId, key: b.placements[0].key });
await sleep(1500);
b = await board();
check('the GM retrieves the first die: it and every later Action are un-committed', b.placements.length === 2 && b.placements.every((x) => !x.committed), JSON.stringify(b.placements));
check('…and everything they did is undone (HP and tokens back)', (await hp(tt.id)) === thugHp && (await toks(tm.id)).iron === 3, JSON.stringify([await hp(tt.id), await toks(tm.id)]));
p.emit('board:commit', { rollId });
await sleep(2500);
check('commit again, in steps: works the same', (await board()).placements.every((x) => x.committed) && thugHp - (await hp(tt.id)) === expected);

console.log('\n--- End turn ---');
q.emit('board:end_turn', { rollId });
await sleep(600);
check("someone else can't end the turn", (await jf('/api/stage?role=gm')).fights.combat.turn_index === 0);
p.emit('board:end_turn', { rollId });
await sleep(1200);
// Late Movement first if anyone holds Speed (phase D) — everyone passes.
st = await jf('/api/stage?role=gm');
const late = st.fights.combat.movement_phase;
for (const id of late?.waiting ?? []) gm.emit('move:done', { combatantId: id });
await sleep(1500);
st = await jf('/api/stage?role=gm');
check('the active player ends their own turn (decided)', st.fights.combat.turn_index === 1 && !(await board()).active, JSON.stringify(st.fights.combat.turn_index));

gm.emit('fight:end', { mode: 'combat', outcome: 'skip' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, other, thug]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
for (const s of [gm, p, q]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

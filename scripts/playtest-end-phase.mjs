// Playtest: the automated End Phase and Previous turn — Trap / Pit Trap damage
// (Armor blocks it — full automation phase C), the Speed discard (Shadow
// Form keeps its Speed), automation cards marked as notices, and stepping the
// initiative back, also into the last round.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-end-phase.mjs
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
gm.emit('scene:create', { name: `EP ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `EP ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mk = (n) => jpost('/api/characters', { name: `EP${n}${stamp}`, characterType: 'npc' });
const [a, b, c] = [await mk('Shadow'), await mk('Plain'), await mk('Armored')];
// a: Shadow Form (keeps Speed, gains 2 at start and end); b: Power Form + Halcyon; c: Iron + Halcyon, with an Armor token.
gm.emit('build:save', { characterId: a.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.shadow', styleId: 'style.heroic' }] } });
gm.emit('build:save', { characterId: b.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: c.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.iron', styleId: 'style.heroic' }] } });
await sleep(500);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: a.id, col: 1, row: 1 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: b.id, col: 4, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: c.id, col: 6, row: 6 });
gm.emit('map_tile:place', { mode: 'combat', col: 4, row: 2, kind: 'pit_trap' });
gm.emit('map_tile:place', { mode: 'combat', col: 6, row: 6, kind: 'trap' });
await sleep(700);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === a.id);
const tb = st.combatTokens.find((t) => t.character_id === b.id);
const tc = st.combatTokens.find((t) => t.character_id === c.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [ta, tb, tc].map((t) => ({ ref: { combatantId: t.id }, level: 1, kind: 'warrior' })) });
await sleep(400);
gm.emit('fighter:token', { ref: { combatantId: tb.id }, key: 'speed', delta: 5 });
gm.emit('fighter:token', { ref: { combatantId: tc.id }, key: 'armor', delta: 1 });
await sleep(400);
st = await jf('/api/stage?role=gm');
const hp = (t) => st.combatTokens.find((x) => x.id === t.id).fight.hp.current;
const tok = (t) => st.combatTokens.find((x) => x.id === t.id).fight.tokens;
const hpB = hp(tb), hpC = hp(tc);

console.log('\n--- the End Phase ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }, { combatantId: tc.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(1200);
gm.emit('fight:next', { mode: 'combat' });
await sleep(1800);
st = await jf('/api/stage?role=gm');
check('a fighter on a Pit Trap takes 1 damage', hp(tb) === hpB - 1, `${hpB} → ${hp(tb)}`);
const endCards = cards.filter((x) => x.payload?.automatic === 'end_phase');
check('a fighter with Armor on a Trap takes none: Armor blocks it (phase C)', hp(tc) === hpC && endCards.some((x) => x.payload.notice && /Armored\d+: Trap, 0 damage \(Armor −1\)/.test(x.payload.text)), JSON.stringify(endCards.map((x) => x.payload.text)));
check('everyone discards 3 Speed (5 → 2)', tok(tb).speed === 2, JSON.stringify(tok(tb)));
check('Shadow Form keeps its Speed (2 at start + 2 at end = 4)', tok(ta).speed === 4, JSON.stringify(tok(ta)));
check('no Speed or Trap reminder cards anymore, only the End Phase notice', !cards.some((x) => ['speed', 'trap'].includes(x.payload?.automatic) && !x.payload.notice) && endCards.some((x) => x.payload.notice && /Speed discarded/.test(x.payload.text)), JSON.stringify(endCards.map((x) => x.payload.text)));
check('automated ability cards are notices', cards.filter((x) => x.payload?.automatic === 'ability').every((x) => x.payload.notice) && cards.some((x) => x.payload?.automatic === 'ability'));

console.log('\n--- Previous turn ---');
const at = () => st.fights.combat;
const before = { round: at().round, index: at().turn_index };
gm.emit('fight:previous', { mode: 'combat' });
await sleep(500);
st = await jf('/api/stage?role=gm');
check('Previous turn steps the marker back one', at().turn_index === before.index - 1 && at().round === before.round, JSON.stringify([before, at().round, at().turn_index]));
const power = tok(ta).power ?? 0;
check('…and nothing re-triggers (no new Stance roll)', cards.filter((x) => x.kind === 'stance_roll').length === 2);
gm.emit('fight:previous', { mode: 'combat' });
await sleep(400);
st = await jf('/api/stage?role=gm');
check('at the very first turn it stays put', at().turn_index === 0 && at().round === 1);
for (let i = 0; i < 4; i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(900);
}
st = await jf('/api/stage?role=gm');
const r2 = { round: at().round, index: at().turn_index };
let guard = 0;
while (at().turn_index > 0 && guard++ < 4) {
  gm.emit('fight:previous', { mode: 'combat' });
  await sleep(400);
  st = await jf('/api/stage?role=gm');
}
gm.emit('fight:previous', { mode: 'combat' });
await sleep(500);
st = await jf('/api/stage?role=gm');
check('from the first turn of round 2, it steps back into round 1', r2.round === 2 && at().round === 1 && at().turn_index === at().order.length - 1, JSON.stringify([r2, at().round, at().turn_index]));
void power;

gm.emit('fight:end', { mode: 'combat' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const x of [a, b, c]) await fetch(`${BASE}/api/characters/${x.id}`, { method: 'DELETE' });
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

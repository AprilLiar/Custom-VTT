// Playtest: a whole fight (Panic at the Dojo, Phase 5) through the real
// handlers — Start Combat, the order, the turn-start Stance roll and pick,
// Reminders (own, others', round, stance-bound) and the automatic End Phase
// ones, Dizzy ending with the turn, a new round, End Combat.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-fights.mjs
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
const lines = [];
gm.on('chat:card', (c) => cards.push(c));
gm.on('chat:message', (m) => lines.push(m.message));
gm.emit('scene:create', { name: `Brawl ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Brawl ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `Mira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `Bo${stamp}`, characterType: 'pc' });
const goon = await jpost('/api/characters', { name: `Goon${stamp}`, characterType: 'npc' });
const own = (c) => ({ ownerType: 'character', ownerId: c.id });
// Hand-made Stances and Reminders were purged for the character builder
// (phase 0): their events do nothing any more.
gm.emit('combat_stance:create', { ...own(mira), name: 'Calm', dice: [{ die: 6 }] });
gm.emit('combat_reminder:create', { ...own(mira), scope: 'self', timing: 'start', text: 'gone' });
await sleep(400);
const purged = await jf(`/api/combat-setup?ownerType=character&ownerId=${mira.id}`);
check('hand-made Stances and Reminders can no longer be created', purged.stances.length === 0 && purged.reminders.length === 0, JSON.stringify(purged));
for (const [o, col] of [[own(mira), 2], [own(bo), 4], [{ ownerType: 'character', ownerId: goon.id }, 6], [{ ownerType: 'character', ownerId: goon.id }, 7]]) {
  gm.emit('combat_token:place', { ...o, col, row: 3 });
}
await sleep(700);
let st = await jf('/api/stage?role=gm');
const tokenOf = (pred) => st.combatTokens.find(pred);
const tMira = tokenOf((t) => t.character_id === mira.id);
const tBo = tokenOf((t) => t.character_id === bo.id);
const [tG1, tG2] = st.combatTokens.filter((t) => t.character_id === goon.id);
gm.emit('fighter:set_hp', { ref: { combatantId: tMira.id }, max: 5 });
gm.emit('fighter:add_bar', { ref: { combatantId: tMira.id } });
gm.emit('fighter:token', { ref: { combatantId: tMira.id }, key: 'burning', delta: 3 });
gm.emit('fighter:token', { ref: { combatantId: tBo.id }, key: 'speed', delta: 2 });
await sleep(500);

const p = await connect({ role: 'player', characterId: mira.id });
const pb = await connect({ role: 'player', characterId: bo.id });

console.log('\n--- Start Combat ---');
pb.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tBo.id }], enemies: [], firstSide: 'allies' });
await sleep(300);
check('only the GM starts a fight', (await jf('/api/stage?role=gm')).fights.combat === null);
gm.emit('fight:start', {
  mode: 'combat',
  allies: [{ combatantId: tMira.id }, { combatantId: tBo.id }],
  enemies: [{ combatantId: tG1.id }, { combatantId: tG2.id }],
  firstSide: 'allies',
  opener: { combatantId: tMira.id },
});
await sleep(900);
st = await jf('/api/stage?role=gm');
let fight = st.fights.combat;
check('the fight exists, round 1, with both sides', fight?.round === 1 && fight.allies.length === 2 && fight.enemies.length === 2, JSON.stringify(fight));
check('one turn per HP bar: Mira has two bars, so five turns, alternating while both sides last',
  fight.order.length === 5 && fight.order.map((o) => o.side[0]).join('') === 'aeaea' && fight.order[0].id === tMira.id,
  JSON.stringify(fight.order));
check('Simple Combat has its own (no) fight', st.fights.simple === null);
check('without Stances (until the builder) the turn starts at once: no pick, no roll',
  fight.pending_stance === null && !cards.some((c) => c.kind === 'stance_roll'), JSON.stringify(fight.pending_stance));
check('a combat-begins line was posted', lines.some((l) => /Combat begins/.test(l)));

console.log('\n--- next turn ---');
gm.emit('fighter:hp', { ref: { combatantId: tMira.id }, delta: -5 });
await sleep(300);
check('a bar breaking makes Mira Dizzy', (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tMira.id).fight.hp.dizzy === true);
const before = cards.length;
p.emit('fight:next', { mode: 'combat' });
await sleep(300);
check('only the GM advances turns', (await jf('/api/stage?role=gm')).fights.combat.turn_index === 0);
gm.emit('fight:next', { mode: 'combat' });
await sleep(900);
const endCards = cards.slice(before);
// Full automation phase C: the End Phase does Burning itself, in one notice.
const endPhase = endCards.find((c) => c.payload.automatic === 'end_phase' && c.payload.notice);
check("Mira's turn ended with Burning done for her: Dizzy, so no damage, but she discards 2 (half of 3, rounded up)",
  new RegExp(`Mira${stamp}: Burning, 0 damage \\(Dizzy: no damage\\), discards 2`).test(endPhase?.payload.text ?? '') && !endCards.some((c) => c.payload.automatic === 'burning'), JSON.stringify(endCards.map((c) => c.payload.text)));
check('...and Speed is discarded automatically (in the notice, naming whoever lost some)', endPhase?.payload.text.includes('Speed discarded') && endPhase.payload.text.includes(`Bo${stamp}`), JSON.stringify(endCards.map((c) => c.payload.text)));
st = await jf('/api/stage?role=gm');
fight = st.fights.combat;
check('Dizzy ended with the turn', st.combatTokens.find((t) => t.id === tMira.id).fight.hp.dizzy === false);
check('the next turn is an enemy, with no pick', fight.turn_index === 1 && fight.order[1].side === 'enemies' && fight.pending_stance === null);

console.log('\n--- through the round ---');
const round1Order = st.fights.combat.order;
for (let i = 0; i < 6 && st.fights.combat.round === 1; i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(700);
  st = await jf('/api/stage?role=gm');
}
fight = st.fights.combat;
check('a second round started — still five turns: Mira broke a bar but keeps a turn per bar (the book)', fight.round === 2 && fight.order.length === 5, JSON.stringify(fight));
// The order is rolled once (batch 5): every round repeats the first.
check('...in the same order as round 1 (never re-rolled)', JSON.stringify(fight.order) === JSON.stringify(round1Order), JSON.stringify([round1Order, fight.order]));
// The GM drags an entry: the last to second place; the current turn stays the current turn.
gm.emit('fight:reorder', { mode: 'combat', from: 4, to: 1 });
await sleep(400);
st = await jf('/api/stage?role=gm');
const dragged = st.fights.combat.order;
check('the GM drags the order, alternation or not', JSON.stringify(dragged) === JSON.stringify([round1Order[0], round1Order[4], round1Order[1], round1Order[2], round1Order[3]]) && st.fights.combat.turn_index === 0, JSON.stringify(dragged));
p.emit('fight:reorder', { mode: 'combat', from: 1, to: 4 });
gm.emit('fight:reorder', { mode: 'combat', from: 0, to: 3 });
await sleep(400);
st = await jf('/api/stage?role=gm');
check('...a player can’t, and the current turn can’t be dragged', JSON.stringify(st.fights.combat.order) === JSON.stringify(dragged), JSON.stringify(st.fights.combat.order));
gm.emit('fight:reorder', { mode: 'combat', from: 1, to: 4 });
await sleep(400);
st = await jf('/api/stage?role=gm');
fight = st.fights.combat;
check('...with a round line', lines.some((l) => /Round 2/.test(l)));

console.log('\n--- sides, removal, the chat log, the end ---');
gm.emit('combat_token:remove', { combatantId: tG2.id });
await sleep(300);
for (let i = 0; i < 6; i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(500);
  st = await jf('/api/stage?role=gm');
  const entry = st.fights.combat.order[st.fights.combat.turn_index];
  if (entry?.id === tG2.id) check('a removed fighter never gets a turn', false, JSON.stringify(entry));
}
check('the fight carries on without the removed fighter', st.fights.combat != null);
const log = await jf('/api/chat');
check('cards are in the chat log with their payload, for a reload',
  log.some((e) => e.kind === 'reminder' && e.payload?.text && e.payload.automatic));
gm.emit('fight:end', { mode: 'combat' });
await sleep(400);
st = await jf('/api/stage?role=gm');
check('End Combat clears the fight but keeps the tokens and their HP',
  st.fights.combat === null && st.combatTokens.find((t) => t.id === tMira.id)?.fight.hp.max === 5);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, bo, goon]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
await sleep(200);
for (const s of [gm, p, pb]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

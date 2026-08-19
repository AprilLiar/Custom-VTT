// Playtest: a modifier modifies the ROLL, not each die.
//
// A move rolling three Stats at +3 used to collect +9, because the modifier
// was added inside every die. This drives the two paths that actually roll —
// a hand-thrown pool roll and the engine's own reveal-time move roll — and
// checks the arithmetic from the outside: the printed dice must add up to the
// printed total once the modifier has been applied exactly once.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-roll-modifier.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const connect = () =>
  new Promise((res) => {
    const sock = io(BASE);
    sock.on('connect', () => res(sock));
  });
const gm = await connect();
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);
const stamp = Date.now();
const sum = (dice) => dice.reduce((a, d) => a + d.result, 0);

// ---------------------------------------------------------------- pool roll
const roller = await jpost('/api/characters', { name: `Roller ${stamp}`, characterType: 'npc' });
const sheet = await jf(`/api/characters/${roller.id}`);
const three = sheet.dice.filter((d) => d.status === 'active').slice(0, 3);
check('the fixture has three live Stats to roll together', three.length === 3, String(three.length));

const MOD = 3;
gm.emit('pool:roll', { characterId: roller.id, dieIds: three.map((d) => d.id), modifier: MOD });
const pool = await wait(gm, 'roll:result', (r) => r.characterId === roller.id);

console.log('  pool:', JSON.stringify({ dice: pool.dice.map((d) => d.result), modifier: pool.modifier, total: pool.total }));
check('the roll reports the modifier it was given', pool.modifier === MOD, String(pool.modifier));
check('three dice came back', pool.dice.length === 3, String(pool.dice.length));
check('the modifier is applied ONCE to the total, not once per die',
  pool.total === sum(pool.dice) + MOD,
  JSON.stringify({ dice: sum(pool.dice), total: pool.total, wouldBeOldValue: sum(pool.dice) + MOD * 3 }));
check('...and no die carries the modifier itself — each is a real face plus its own bonus',
  pool.dice.every((d) => d.result - d.bonus >= 1 && d.result - d.bonus <= d.size),
  JSON.stringify(pool.dice));

// The same numbers must survive a reload, since /api/chat rebuilds the total.
await sleep(400);
const reloaded = (await jf('/api/chat')).filter((e) => e.kind === 'roll' && e.characterId === roller.id).pop();
check('a reloaded roll reports the same total as the live broadcast', reloaded?.total === pool.total,
  JSON.stringify({ live: pool.total, reloaded: reloaded?.total }));

// ------------------------------------------------------- the engine's roll
// A move with a Roll Modifier and three Stats: the engine's own reveal-time
// roll has to obey the same rule as a hand-thrown one.
gm.emit('tell:create', { name: 'Weight shifts' });
const tell = await wait(gm, 'tell:created');
const MOVE_MOD = 5;
gm.emit('move:create', {
  name: `Triple ${stamp}`, isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 1, recoveryTics: 1, description: 'three Stats at once',
  interactions: {}, rollSlots: ['Skull', 'Body', 'Brain'], attackTargets: ['Body'],
  staminaCost: 0, rollModifier: MOVE_MOD,
});
const triple = await wait(gm, 'move:created', (m) => m.name === `Triple ${stamp}`);

const foe = await jpost('/api/characters', { name: `Foe ${stamp}`, characterType: 'npc' });
gm.emit('combat:add_participant', { characterId: roller.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === roller.id));
gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const st = await jf('/api/combat?role=gm');
const start = st.pairs[0].roundStartTic ?? 0;
for (let i = 0; i < 2; i++) {
  const now = await jf('/api/combat?role=gm');
  const side = now.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? roller : foe;
  if (who.id === roller.id) {
    gm.emit('move:declare', { characterId: roller.id, moveId: triple.id, placementTic: start });
    await sleep(500);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(700);
}
await sleep(4500);

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
const engineRoll = events.find((e) => e.type === 'roll' && (e.payload?.dice ?? []).length === 3);
console.log('  engine:', JSON.stringify(engineRoll?.payload && {
  dice: engineRoll.payload.dice.map((d) => d.result),
  modifier: engineRoll.payload.modifier,
  total: engineRoll.payload.total,
}));
check('the engine rolled all three Stats', engineRoll != null, events.map((e) => e.type).join(','));
const p = engineRoll?.payload;
check("the move's Roll Modifier is in the roll's modifier", (p?.modifier ?? 0) >= MOVE_MOD, String(p?.modifier));
check('the engine applies it once to the total too',
  p != null && p.total === sum(p.dice) + p.modifier,
  JSON.stringify({ dice: sum(p?.dice ?? []), modifier: p?.modifier, total: p?.total }));
check('...and its dice are real faces, with no modifier hidden inside them',
  (p?.dice ?? []).every((d) => d.result - d.bonus >= 1 && d.result - d.bonus <= d.size),
  JSON.stringify(p?.dice));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

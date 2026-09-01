// Playtest for the **Ground Finisher** Tag, and for the **attack-lands-on-the-
// first-unguarded-Active-frame** bugfix beside it.
//
// Both are about *which Tic a blow happens on*, which is exactly the thing a
// unit test over pure windows cannot check: the windows are only right if the
// engine builds them from the same rows the board does. So this drives a real
// round.
//
// Ground Finisher: if this move's Active frames land on even one Trip Recovery
// frame of the fighter it is coming for, its Roll gets +5. The probe is a
// bare/tagged pair of otherwise identical fights — what the Tag did is the
// difference between two runs, not a number read off an event and trusted.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-ground-finisher.mjs
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

const gm = io(BASE);
gm.latest = null;
gm.on('combat:updated', (c) => { gm.latest = c; });
await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(600);
const stamp = Date.now();
gm.emit('tell:create', { name: `GF Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `GF Tell ${stamp}`);

// Matched by NAME off the live list, exactly as the automation does.
const tags = await jf('/api/tags');
const named = (n) => (tags ?? []).find((t) => String(t.name).trim().toLowerCase() === n);
const finisher = named('ground finisher');
const grounding = named('grounding');
check('the Ground Finisher Tag is seeded and reachable by name', finisher != null,
  JSON.stringify((tags ?? []).map((t) => t.name)));
check('...and Grounding, which is what puts somebody on the floor for it', grounding != null);
if (!finisher || !grounding) { console.log(`\n${failures} FAILED`); process.exit(1); }

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// The victim's move puts THEM on the floor: 1 Startup, 1 Active, 4 Recovery,
// all four of which Grounding turns into Trip Recovery. Placed at Tic 0, its
// trip window is [2, 6).
const selfTrip = await mk('Sacrifice Roll', {
  startupTics: 1, activeTics: 1, recoveryTics: 4, tagIds: [grounding.id],
});
// The finisher arrives with Active frames inside that window.
const stomp = await mk('Stomp', { startupTics: 2, activeTics: 2, tagIds: [finisher.id] });
const plainStomp = await mk('Plain Stomp', { startupTics: 2, activeTics: 2 });
// ...and one that arrives after they are up, as the timing control.
const lateStomp = await mk('Late Stomp', { startupTics: 6, activeTics: 2, tagIds: [finisher.id] });

const declare = async (characterId, moveId, placementTic) => {
  gm.emit('move:declare', { characterId, moveId, placementTic });
  await sleep(600);
};
const turnOf = async (charId) => {
  for (let i = 0; i < 4; i++) {
    const pair = gm.latest?.pairs?.[0];
    const seat = (gm.latest?.participants ?? []).find((p) => p.character_id === charId);
    if (!pair || !seat) break;
    if (pair.declaringSide === seat.side) return;
    const other = (gm.latest?.participants ?? []).find((p) => p.side !== seat.side);
    if (!other) break;
    gm.emit('combat:character_done_declaring', { characterId: other.character_id });
    await sleep(700);
  }
};

// One round: the victim trips themselves, the attacker throws `attackMove` at
// them, and the round is played out. Returns the attacker's roll event.
const fight = async (label, attackMove, attackAt) => {
  gm.emit('combat:clear', {});
  await sleep(900);
  const atk = await jpost('/api/characters', { name: `GF${label}a${stamp}`, characterType: 'npc' });
  const vic = await jpost('/api/characters', { name: `GF${label}b${stamp}`, characterType: 'npc' });
  gm.emit('combat:add_participant', { characterId: atk.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === atk.id));
  gm.emit('combat:add_participant', { characterId: vic.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === vic.id));
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

  await turnOf(vic.id);
  await declare(vic.id, selfTrip.id, 0);
  await turnOf(atk.id);
  await declare(atk.id, attackMove.id, attackAt);
  gm.emit('combat:character_done_declaring', { characterId: atk.id });
  await sleep(500);
  gm.emit('combat:character_done_declaring', { characterId: vic.id });

  // Wait for the round to resolve, then read the log back.
  for (let i = 0; i < 60; i++) {
    const state = await jf('/api/combat?role=gm');
    if (state?.pairs?.[0]?.phase === 'declaration' && (state.pairs[0].roundNumber ?? 1) > 1) break;
    await sleep(500);
  }
  const chat = (await jf('/api/chat')) ?? [];
  const summary = [...chat].reverse().find((e) => e.kind === 'round_summary');
  const events = summary ? ((await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? []) : [];
  return {
    atk,
    vic,
    roll: events
      .map((e) => ({ type: e.type, tic: e.tic, payload: e.payload }))
      .find((e) => e.type === 'roll' && e.payload?.characterId === atk.id),
  };
};

const termsOf = (roll) => roll?.payload?.modifierBreakdown ?? [];
const finisherTerm = (roll) => termsOf(roll).find((t) => t.key === 'ground_finisher') ?? null;

// ============================================ 1. it fires on the floor
console.log('\n--- Ground Finisher: catching somebody still down ---');
{
  // The victim's trip window is [2, 6). The Stomp placed at Tic 2 reveals at 4
  // and is Active on [4, 6) — inside it.
  const tagged = await fight('1', stomp, 2);
  const term = finisherTerm(tagged.roll);
  check('the attack rolled', tagged.roll != null, JSON.stringify(tagged.roll));
  check('...and Ground Finisher paid +5', term?.amount === 5, JSON.stringify(termsOf(tagged.roll)));
  check('...naming who it caught', /is down/.test(term?.label ?? ''), JSON.stringify(term?.label));

  // The control: the same timing, the same frames, no Tag.
  const bare = await fight('2', plainStomp, 2);
  check('the identical untagged move gets nothing', finisherTerm(bare.roll) == null,
    JSON.stringify(termsOf(bare.roll)));
  // The difference between the two runs IS the Tag.
  const diff = (tagged.roll?.payload?.modifier ?? 0) - (bare.roll?.payload?.modifier ?? 0);
  check('...so the two runs differ by exactly 5', diff === 5,
    JSON.stringify({ tagged: tagged.roll?.payload?.modifier, bare: bare.roll?.payload?.modifier }));
}

// ============================================ 2. it does not fire off it
console.log('\n--- ...and nothing when they are back on their feet ---');
{
  // Placed at Tic 2 with 6 Startup, so it is Active on [8, 10) — past the trip
  // window's end at 6. Same Tag, same fighters, a different moment.
  const late = await fight('3', lateStomp, 2);
  check('a Ground Finisher arriving after they are up rolls', late.roll != null,
    JSON.stringify(late.roll));
  check('...and gets nothing', finisherTerm(late.roll) == null, JSON.stringify(termsOf(late.roll)));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
process.exit(failures ? 1 : 0);

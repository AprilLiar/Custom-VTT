// Playtest for Recovery imposed on the clock.
//
// An `opponent_recovery` automation used to bump one row's counter and
// nothing on the board moved. It lands on the timeline now: the frames go
// where the target's own current Tic says they go, and everything they had
// declared after it slides. Three cases, and the whole point of driving the
// real engine rather than the pure helper is that the ENGINE has to pick the
// right one from live state.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-imposed-recovery.mjs
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
await sleep(600);
gm.emit('tell:create', { name: 'Weight shifts' });
const tell = await wait(gm, 'tell:created');
const stamp = Date.now();

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait(gm, 'move:created', (m) => m.name === `${name} ${stamp}`);
};

// The move that imposes it. Three deliberate choices, and two of them are
// there because the first draft of this playtest tripped over them:
//   - rollModifier 20, so it lands every time and On Hit is not a coin flip;
//   - the **No Damage** Tag, so it never deals damage — which means the
//     Interruption check never runs. Without this, "caught in Startup" is
//     also "Interrupted", the engine deletes the very move whose delay is
//     being measured, and the probe reads an empty timeline;
//   - Success Threshold 1, so the No Damage outcome is a success (a success
//     fires On Hit, which is where the automation hangs).
const tags = await jf('/api/tags');
const noDamage = (tags ?? []).find((t) => String(t.name).trim().toLowerCase() === 'no damage');
check('the No Damage Tag is available to build the fixture on', noDamage != null,
  JSON.stringify((tags ?? []).map((t) => t.name)));
const shove = await mk('Staggering Shove', {
  rollModifier: 20,
  tagIds: noDamage ? [noDamage.id] : [],
  successThreshold: 1,
  interactions: { hit: { text: 'they stumble', automations: [{ type: 'opponent_recovery', amount: 2 }] } },
});
// The victim's moves. The shove is 1/1/1 from the round's first Tic, so it is
// Active on start+1 — which is the Tic every case below is really about:
//   slowSwing (2 Startup) placed on start+1 is still WINDING UP there;
//   quickJab  (1 Startup) placed on start   is already ACTIVE there.
// That one Tic of Startup is the entire difference between case 1 and case 2,
// and getting it wrong is how the first draft of this playtest managed to
// assert "mid-move" against a move that was plainly still in its wind-up.
const slowSwing = await mk('Slow Swing', { startupTics: 2, activeTics: 2, recoveryTics: 2 });
const quickJab = await mk('Quick Jab', { startupTics: 1, activeTics: 2, recoveryTics: 2 });
const followUp = await mk('Follow Up', { startupTics: 2, activeTics: 2, recoveryTics: 2 });

const attacker = await jpost('/api/characters', { name: `At${stamp}`, characterType: 'npc' });
const victim = await jpost('/api/characters', { name: `Vi${stamp}`, characterType: 'npc' });

const seat = async () => {
  gm.emit('combat:add_participant', { characterId: attacker.id, side: 'left', pairIndex: 0 });
  await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === attacker.id));
  gm.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
  await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));
  gm.emit('combat:next_round', {});
  await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
};

// **Three consecutive rounds of ONE fight, not three cleared arenas.**
// Clearing between cases looked cleaner and silently broke the last two:
// combat:clear deletes the pairs and discards *unfinished* resolutions, but
// the COMPLETED round-1 resolution stays — so the re-seated fight lands back
// on (pair 0, round 1) and advancePairResolution refuses to run a round it
// has already finished. Nothing resolved, and every probe read a board that
// had simply never moved.
// **Each case is its own FIGHT**, not the next round of one. Two different
// traps sit either side of that choice, and the first two drafts of this
// playtest fell into both:
//   - `combat:clear` + re-seat lands back on (pair 0, round 1) while the
//     COMPLETED round-1 resolution is still on file, and the engine refuses
//     to re-run a round it has already finished. Nothing resolves.
//   - Consecutive rounds of one fight carry the previous round's footprints
//     forward as a placement floor — and this feature MOVES those footprints
//     later, so case 2's declarations landed outside case 2's own round
//     window entirely and never resolved either.
// `combat:end` clears declared_moves and the pairs while leaving everyone
// seated, and the next `combat:next_round` bumps the fight number, so each
// case gets a genuinely clean clock.
const freshFight = async () => {
  gm.emit('combat:end', {});
  await sleep(1000);
  gm.emit('combat:next_round', {});
  for (let i = 0; i < 60; i++) {
    const pair = (await jf('/api/combat?role=gm'))?.pairs?.[0];
    if (pair?.phase === 'declaration' && pair?.declaringSide) return pair;
    await sleep(400);
  }
  throw new Error('the pair never opened a Declaration Phase');
};
const declare = async (characterId, moveId, placementTic) => {
  gm.emit('move:declare', { characterId, moveId, placementTic });
  await sleep(400);
};
const finishBoth = async () => {
  for (let i = 0; i < 2; i++) {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    if (!side) break;
    gm.emit('combat:character_done_declaring', { characterId: side === 'left' ? attacker.id : victim.id });
    await sleep(700);
  }
};
// Both are NPCs, so the GM view is fully revealed and every declaration is
// legible whichever side initiative handed the first turn to.
const declareBoth = async (attackerAt, victimPlan) => {
  for (let i = 0; i < 2; i++) {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    if (!side) break;
    if (side === 'left') {
      await declare(attacker.id, shove.id, attackerAt);
    } else {
      for (const [moveId, at] of victimPlan) await declare(victim.id, moveId, at);
    }
    gm.emit('combat:character_done_declaring', { characterId: side === 'left' ? attacker.id : victim.id });
    await sleep(700);
  }
};

// The newest round_summary for this pair is the round that just finished —
// rounds run in sequence here, so "newest" is unambiguous.
const replayEvents = async () => {
  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  if (!summary) return [];
  return (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [];
};

// ---------------------------------------------------------------- case 1
// Caught in Startup. The shove is Active on start+1; slowSwing placed there
// is still two Tics from revealing.
await seat();
let pair = await freshFight();
let start = pair.roundStartTic ?? 0;
let round = pair.roundNumber;
await declareBoth(start, [[slowSwing.id, start + 1], [followUp.id, start + 7]]);
await sleep(4500);

const mine = (st, charId, roundNumber) =>
  st.declaredMoves
    .filter((d) => d.characterId === charId && d.roundNumber === roundNumber)
    .sort((a, b) => a.placementTic - b.placementTic);

let events = await replayEvents();
let displaced = events.filter((e) => e.type === 'moves_displaced');
console.log('  case 1 events:', events.map((e) => e.type).join(', '));
check('a hit that imposes Recovery emits moves_displaced', displaced.length === 1,
  JSON.stringify(displaced.length));
check('...classified as caught in Startup', displaced[0]?.payload?.phase === 'startup',
  JSON.stringify(displaced[0]?.payload?.phase));
check('...for the right character and the right amount',
  displaced[0]?.payload?.characterId === victim.id && displaced[0]?.payload?.tics === 2,
  JSON.stringify(displaced[0]?.payload));
check('...and the move queued behind it is named as pushed later',
  (displaced[0]?.payload?.shiftedDeclaredMoveIds ?? []).length === 1,
  JSON.stringify(displaced[0]?.payload?.shiftedDeclaredMoveIds));

let st = await jf('/api/combat?role=gm');
let vm = mine(st, victim.id, round);
check('the caught move is DELAYED, not lengthened — placement holds, reveal slides',
  vm[0]?.placementTic === start + 1 && vm[0]?.revealTic === start + 5,
  JSON.stringify({ at: vm[0]?.placementTic, reveal: vm[0]?.revealTic, expectedReveal: start + 5 }));
check('the move behind it slid by the same 2 Tics', vm[1]?.placementTic === start + 9,
  JSON.stringify({ at: vm[1]?.placementTic, expected: start + 9 }));
check('and nothing overlaps afterwards', vm[1]?.placementTic >= vm[0]?.recoveryEndTic,
  JSON.stringify({ next: vm[1]?.placementTic, prevEnd: vm[0]?.recoveryEndTic }));

// ---------------------------------------------------------------- case 2
// Caught mid-move. quickJab has one Tic of Startup, so on start+1 — the same
// Tic the shove is Active on — it is already Active itself.
pair = await freshFight();
start = pair.roundStartTic ?? 0;
round = pair.roundNumber;
await declareBoth(start, [[quickJab.id, start], [followUp.id, start + 7]]);
await sleep(4500);

events = await replayEvents();
displaced = events.filter((e) => e.type === 'moves_displaced');
console.log('  case 2 events:', events.map((e) => e.type).join(', '));
check('case 2: still exactly one displacement', displaced.length === 1, JSON.stringify(displaced.length));
check('case 2: classified as caught mid-move', displaced[0]?.payload?.phase === 'in-flight',
  JSON.stringify(displaced[0]?.payload?.phase));

st = await jf('/api/combat?role=gm');
vm = mine(st, victim.id, round);
// quickJab is 1/2/2 at `start`: reveal start+1, its own footprint ends at
// start+5 — +2 imposed puts its end at start+7.
check('case 2: the move keeps its own frames and grows on the END',
  vm[0]?.placementTic === start && vm[0]?.revealTic === start + 1 && vm[0]?.recoveryEndTic === start + 7,
  JSON.stringify({ at: vm[0]?.placementTic, reveal: vm[0]?.revealTic, end: vm[0]?.recoveryEndTic, expectedEnd: start + 7 }));
check('case 2: the move behind it slid too', vm[1]?.placementTic === start + 9,
  JSON.stringify({ at: vm[1]?.placementTic, expected: start + 9 }));

// ---------------------------------------------------------------- case 3
// Caught between moves: nothing of the victim's covers start+1 at all.
pair = await freshFight();
start = pair.roundStartTic ?? 0;
round = pair.roundNumber;
await declareBoth(start, [[followUp.id, start + 4]]);
await sleep(4500);

events = await replayEvents();
displaced = events.filter((e) => e.type === 'moves_displaced');
console.log('  case 3 events:', events.map((e) => e.type).join(', '));
check('case 3: still exactly one displacement', displaced.length === 1, JSON.stringify(displaced.length));
check('case 3: classified as caught between moves', displaced[0]?.payload?.phase === 'idle',
  JSON.stringify(displaced[0]?.payload?.phase));
check('case 3: nothing is lengthened — there is no move to lengthen',
  displaced.length === 1 && displaced[0]?.payload?.affectedDeclaredMoveId == null,
  JSON.stringify(displaced[0]?.payload?.affectedDeclaredMoveId));

st = await jf('/api/combat?role=gm');
vm = mine(st, victim.id, round);
check('case 3: the whole effect is the delay', vm[0]?.placementTic === start + 6,
  JSON.stringify({ at: vm[0]?.placementTic, expected: start + 6 }));

// The Chat Log says what happened in words, not just in the payload.
const chat = await jf('/api/chat');
const line = chat.filter((e) => /Recovery/.test(e.message ?? '')).pop();
check('the Chat Log names the case in words, not just in the payload',
  /caught between moves/.test(line?.message ?? ''), JSON.stringify(line?.message));
check('...and says how many moves it pushed', /1 move pushed later/.test(line?.message ?? ''),
  JSON.stringify(line?.message));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

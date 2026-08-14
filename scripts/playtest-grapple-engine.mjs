// Playtest driver for the Grappling contest (G4). Drives the real server
// through whole rounds and reads the stored replay back, because everything
// interesting here is an *engine* claim: does a grab contest, chain, penalise
// and get dodged the way the rules say?
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-grapple-engine.mjs
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

const s = io(BASE);
const wait = (ev, pred = () => true, ms = 10000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
    s.on(ev, h);
  });

await new Promise((r) => s.on('connect', r));
s.emit('identity:set', { role: 'gm' });
s.emit('combat:clear', {});
await sleep(600);

s.emit('tell:create', { name: 'Steps in close' });
const tell = await wait('tell:created');
const stamp = Date.now();

const mk = async (name, extra) => {
  s.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    description: name, interactions: {},
    rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0,
    ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// The move a winning grab chains into.
const armbar = await mk('Armbar', { startupTics: 1, activeTics: 1, recoveryTics: 1 });

// A grab that always wins: +20 on the roll, no Resist Roll at all, so the
// target cannot contest it and it only has to clear its Threshold.
const sureGrab = await mk('Sure Grab', {
  rollModifier: 20, isGrappling: true, resistRollSlots: [],
  grappleDirections: { up: armbar.id },
  interactions: {
    grapple_success: { text: 'The hold takes.', automations: [] },
    // So the dodged case below can prove On Miss actually fires, rather than
    // passing because the move had no miss interaction to fire in the first
    // place.
    miss: { text: 'Closes on air.', automations: [] },
  },
});

// A grab that always loses the contest: it clears a Threshold of 0, but the
// target resists with a huge bonus... which a Resist Roll cannot carry, so
// instead give the grab a Threshold it can never reach.
const doomedGrab = await mk('Doomed Grab', {
  rollModifier: 0, isGrappling: true, successThreshold: 20,
  resistRollSlots: [], grappleDirections: { up: armbar.id },
  interactions: { grapple_success: { text: 'never fires', automations: [] } },
});

// A Dodge covering the whole of the grab's 2-Tic Active window. Defense
// Frames may only sit on ACTIVE squares (sanitizeDefensePositions drops the
// rest), so this needs two Active Tics of its own: 1/2/1 with frames at
// offsets 1 and 2 covers absolute Tics 1 and 2 when placed at Tic 0 — exactly
// the grab's window. A 1/1/1 with [0,1,2] silently becomes [1] and only
// half-covers, which correctly does NOT evade.
const slip = await mk('Slip', {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  rollSlots: ['Body'], isDefensive: true, defenseKind: 'dodge',
  defenseFramePositions: [1, 2],
});

const grappler = await jpost('/api/characters', { name: `Grappler${stamp}`, characterType: 'pc' });
const victim = await jpost('/api/characters', { name: `Victim${stamp}`, characterType: 'pc' });

s.emit('combat:add_participant', { characterId: grappler.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === grappler.id));
s.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));

async function runRound({ grapplerMoveId, victimMoveId = null, label }) {
  let st = await jf('/api/combat?role=gm');
  if (st.pairs[0]?.phase !== 'declaration') {
    s.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  }
  for (let i = 0; i < 2; i++) {
    st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    const who = side === 'left' ? grappler : victim;
    const moveId = who.id === grappler.id ? grapplerMoveId : victimMoveId;
    if (moveId) {
      s.emit('move:declare', { characterId: who.id, moveId });
      await wait('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === who.id));
    }
    s.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(500);
  }
  await sleep(3500);
  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  const replay = summary ? await jf(`/api/combat/round-replay/${summary.resolutionId}`) : null;
  const events = replay?.events ?? [];
  console.log(`  [${label}] round ${summary?.roundNumber}:`, events.map((e) => e.type).join(', '));
  return events;
}

// ---------- 1. a grab that wins ----------
let evs = await runRound({ grapplerMoveId: sureGrab.id, label: 'win' });
let gr = evs.find((e) => e.type === 'grapple_resolved');
check('a grappling move emits grapple_resolved', gr != null, evs.map((e) => e.type).join(','));
check('the grab succeeded', gr?.payload?.success === true, JSON.stringify(gr?.payload));
check('it names the direction it went', gr?.payload?.direction === 'up', JSON.stringify(gr?.payload?.direction));
check('it names the move it chains into', /Armbar/.test(gr?.payload?.chainedMoveName ?? ''), gr?.payload?.chainedMoveName);
check('a grapple never applies damage', !evs.some((e) => e.type === 'damage_applied'));
check('a grapple is not resolved as an attack', !evs.some((e) => e.type === 'defense_resolved'));
check('the chained move is declared', evs.some((e) => e.type === 'grapple_chained'),
  evs.map((e) => e.type).join(','));
check('On Successful Grapple fired',
  evs.some((e) => e.type === 'automation_fired' && e.payload?.trigger === 'grapple_success'),
  JSON.stringify(evs.filter((e) => e.type === 'automation_fired').map((e) => e.payload?.trigger)));

// The -2 window lands on the target's seat.
const st1 = await jf('/api/combat?role=gm');
const victimSeat = st1.participants.find((p) => p.character_id === victim.id);
check('the target carries a -2 window after a successful grab',
  victimSeat?.grapple_penalty_until_tic != null, JSON.stringify(victimSeat?.grapple_penalty_until_tic));
// The window ends on the grab's LAST Active Tic, inclusive — not its Recovery
// and not the end of the round. Sure Grab is 1 Startup / 2 Active placed at
// Tic 0, so it reveals at 1 and its Active Tics are 1 and 2.
check('the window ends on the grab\'s last Active Tic, not later',
  victimSeat?.grapple_penalty_until_tic === 2,
  `expected 2, got ${victimSeat?.grapple_penalty_until_tic}`);

// ---------- 2. a grab that falls short ----------
// Clear the leftover window first, so round 2's rolls aren't still penalised
// by round 1's grab — that is correct behaviour, just not what this checks.
s.emit('combat:clear', {});
await sleep(600);
s.emit('combat:add_participant', { characterId: grappler.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === grappler.id));
s.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));

evs = await runRound({ grapplerMoveId: doomedGrab.id, label: 'fail' });
gr = evs.find((e) => e.type === 'grapple_resolved');
check('a short grab still emits grapple_resolved', gr != null, evs.map((e) => e.type).join(','));
check('the grab failed', gr?.payload?.success === false, JSON.stringify(gr?.payload));
check('it failed below its Threshold, not by being outrolled',
  gr?.payload?.reason === 'below-threshold', gr?.payload?.reason);
check('a failed grab chains nothing', !evs.some((e) => e.type === 'grapple_chained'));
check('a failed grab fires nothing',
  !evs.some((e) => e.type === 'automation_fired'),
  JSON.stringify(evs.filter((e) => e.type === 'automation_fired').map((e) => e.payload?.trigger)));
const st2 = await jf('/api/combat?role=gm');
check('a failed grab opens no -2 window',
  st2.participants.find((p) => p.character_id === victim.id)?.grapple_penalty_until_tic == null);

// ---------- 3. a Dodge evades it ----------
s.emit('combat:clear', {});
await sleep(600);
s.emit('combat:add_participant', { characterId: grappler.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === grappler.id));
s.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));

evs = await runRound({ grapplerMoveId: sureGrab.id, victimMoveId: slip.id, label: 'dodged' });
gr = evs.find((e) => e.type === 'grapple_resolved');
check('a dodged grab is reported as dodged', gr?.payload?.reason === 'dodged', JSON.stringify(gr?.payload));
check('a dodged grab did not succeed', gr?.payload?.success === false);
check('a dodged grab chains nothing', !evs.some((e) => e.type === 'grapple_chained'));
check('a dodged grab fires On Miss — a Miss is exactly an attack evaded',
  evs.some((e) => e.type === 'automation_fired' && e.payload?.trigger === 'miss'),
  JSON.stringify(evs.filter((e) => e.type === 'automation_fired').map((e) => e.payload?.trigger)));
check('a dodged grab does NOT fire On Successful Grapple',
  !evs.some((e) => e.type === 'automation_fired' && e.payload?.trigger === 'grapple_success'));
check('a dodged grab never rolled the contest',
  !evs.some((e) => e.type === 'roll' && e.payload?.declaredMoveId === gr?.payload?.declaredMoveId),
  'the grab should be evaded before any dice');
const st3 = await jf('/api/combat?role=gm');
check('a dodged grab opens no -2 window',
  st3.participants.find((p) => p.character_id === victim.id)?.grapple_penalty_until_tic == null);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
s.close();
process.exit(failures ? 1 : 0);

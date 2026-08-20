// Playtest: the grapple mini-game's ±5, and what a FAILED grab must not do.
//
//   1. A wrong guess is supposed to be worth +5 on the follow-up's own roll
//      (chainRollBonusFor). Reported as "grappling +/-5 is not actually
//      granted", so this measures the follow-up's roll rather than trusting
//      the stored bonus.
//   2. A grab that loses its contest must end there — no cross, no prompt,
//      nothing to pick a follow-up from.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-grapple-swing.mjs
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
    sock.latest = null;
    sock.on('combat:updated', (c) => { sock.latest = c; });
    sock.on('connect', () => res(sock));
  });
const gm = await connect();
const pcSock = await connect();
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

const stamp = Date.now();
gm.emit('identity:set', { role: 'gm' });

const setUp = async (label, grappleExtra) => {
  gm.emit('combat:clear', {});
  await sleep(700);
  gm.emit('tell:create', { name: `Tell ${label} ${stamp}` });
  const tell = await wait(gm, 'tell:created');
  const mk = async (name, extra = {}) => {
    gm.emit('move:create', {
      name: `${name} ${label} ${stamp}`, isDefault: true, tellId: tell.id,
      startupTics: 1, activeTics: 1, recoveryTics: 1,
      description: name, interactions: {}, rollSlots: ['Skull'],
      attackTargets: ['Body'], staminaCost: 0, ...extra,
    });
    return wait(gm, 'move:created', (m) => m.name === `${name} ${label} ${stamp}`);
  };
  // Ordinary follow-ups on both arms, so the ±5 lands on a normal attack roll
  // rather than on another grapple's contest.
  const knee = await mk('Knee');
  const sweep = await mk('Sweep');
  const grab = await mk('Grab', {
    isGrappling: true,
    grappleDirections: { up: knee.id, right: sweep.id },
    ...grappleExtra,
  });

  const npc = await jpost('/api/characters', { name: `Npc${label}${stamp}`, characterType: 'npc' });
  const pc = await jpost('/api/characters', { name: `Pc${label}${stamp}`, characterType: 'pc' });
  pcSock.emit('identity:set', { role: 'player', characterId: pc.id });
  await sleep(400);
  gm.emit('combat:add_participant', { characterId: npc.id, side: 'left', pairIndex: 0 });
  await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === npc.id));
  gm.emit('combat:add_participant', { characterId: pc.id, side: 'right', pairIndex: 0 });
  await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === pc.id));
  gm.emit('combat:next_round', {});
  await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

  const st0 = await jf('/api/combat?role=gm');
  const start = st0.pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    if (!side) break;
    const who = side === 'left' ? npc : pc;
    if (who.id === npc.id) {
      gm.emit('move:declare', { characterId: npc.id, moveId: grab.id, placementTic: start });
      await sleep(500);
    }
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(700);
  }
  await sleep(3500);
  return { knee, sweep, grab, npc, pc };
};

const replay = async () => {
  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  return summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
};
const pendingOf = (sock) => sock.latest?.pairs?.find((p) => p.pairIndex === 0)?.pendingGrapple ?? null;

// =================================================== 1. the wrong-guess +5
console.log('\n--- a grab that LANDS, read wrong: the follow-up should get +5 ---');
const a = await setUp('A', { rollModifier: 40 });
const p = pendingOf(gm);
check('the landed grab opens its cross', p?.role === 'grappler', JSON.stringify(p?.role));
gm.emit('combat:grapple_choose', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: p?.grapplerDeclaredMoveId });
await sleep(1000);
// Guess the OTHER arm — a wrong read, worth +5 to the grappler's follow-up.
pcSock.emit('combat:grapple_guess', { pairIndex: 0, direction: 'right', grapplerDeclaredMoveId: p?.grapplerDeclaredMoveId });
await sleep(5000);

const evA = await replay();
console.log('  events:', evA.map((e) => e.type).join(', '));
const guessed = evA.find((e) => e.type === 'grapple_guessed');
check('the read is scored as WRONG, worth +5', guessed?.payload?.chainRollBonus === 5,
  JSON.stringify({ outcome: guessed?.payload?.guessOutcome, bonus: guessed?.payload?.chainRollBonus }));
const chained = evA.find((e) => e.type === 'grapple_chained');
check('the swing is stored on the chained declaration', chained?.payload?.chainRollBonus === 5,
  JSON.stringify(chained?.payload));

// The claim under test: does the follow-up's ROLL actually get it?
const followRoll = evA.find(
  (e) => e.type === 'roll' && e.payload?.declaredMoveId === chained?.payload?.declaredMoveId
);
console.log('  follow-up roll:', JSON.stringify(followRoll?.payload && {
  dice: followRoll.payload.dice?.map((d) => d.result),
  modifier: followRoll.payload.modifier,
  chainRollBonus: followRoll.payload.chainRollBonus,
  total: followRoll.payload.total,
}));
check('the follow-up ROLLED with the +5 attached', followRoll?.payload?.chainRollBonus === 5,
  JSON.stringify({ chainRollBonus: followRoll?.payload?.chainRollBonus }));
const diceSum = (followRoll?.payload?.dice ?? []).reduce((s, d) => s + (d.result ?? 0), 0);
check('...and its total actually includes it',
  followRoll && followRoll.payload.total === diceSum + (followRoll.payload.modifier ?? 0) + 5,
  JSON.stringify({ diceSum, modifier: followRoll?.payload?.modifier, total: followRoll?.payload?.total }));

// ============================================ 2. a grab that loses its contest
console.log('\n--- a grab that FAILS its contest: no cross at all ---');
const b = await setUp('B', { rollModifier: -100 });
const evB = await replay();
console.log('  events:', evB.map((e) => e.type).join(', '));
const resolvedB = evB.find((e) => e.type === 'grapple_resolved');
check('the grab is resolved as a failure', resolvedB && resolvedB.payload.success === false,
  JSON.stringify(resolvedB?.payload));
check('no cross was raised for it', !evB.some((e) => e.type === 'grapple_prompt'),
  JSON.stringify(evB.filter((e) => e.type === 'grapple_prompt').map((e) => e.payload)));
check('nothing was chained off it', !evB.some((e) => e.type === 'grapple_chained'));
check('and nobody is left staring at a prompt',
  pendingOf(gm) == null && pendingOf(pcSock) == null,
  JSON.stringify({ gm: pendingOf(gm), pc: pendingOf(pcSock) }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, pcSock]) s.close();
process.exit(failures ? 1 : 0);

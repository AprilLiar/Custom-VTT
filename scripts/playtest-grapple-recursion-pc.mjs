// Playtest: the SAME recursion as playtest-grapple-recursion.mjs, but from the
// other side of the table — a **player** grappler holding **granted**
// (non-Default) moves, which is how a real fight is actually set up.
//
// Two things differ from the NPC harness and each can break a chain on its own:
//   - the player is the one prompted to pick, so the pause has to reach a
//     player socket rather than the GM's;
//   - every follow-up has to pass annotateFollowUps' ownership check, which a
//     Default move sails through and a granted one does not.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-grapple-recursion-pc.mjs
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

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: 'Hands to the neck' });
const tell = await wait(gm, 'tell:created');
const stamp = Date.now();

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: false, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait(gm, 'move:created', (m) => m.name === `${name} ${stamp}`);
};

// Third link first, since each move has to name the next one.
const knee = await mk('Knee');
const sweep = await mk('Sweep');
// **Two directions on every grapple, deliberately.** With only one assigned
// direction shouldRunMiniGame skips the defender's guess entirely — there is
// nothing to read between one option — so a single-direction fixture never
// exercises the guess phase at all, which is exactly the half of the flow a
// chain has to survive twice.
const bodyLock = await mk('Body Lock', {
  isGrappling: true,
  rollModifier: 20,
  grappleDirections: { up: knee.id, right: sweep.id },
  interactions: { grapple_success: { text: 'the lock is in', automations: [] } },
});
// First link: a grapple pointing at the second grapple.
const clinch = await mk('Thai Clinch', {
  isGrappling: true,
  rollModifier: 20,
  grappleDirections: { up: bodyLock.id, right: sweep.id },
  interactions: { grapple_success: { text: 'the clinch is set', automations: [] } },
});

const npc = await jpost('/api/characters', { name: `Npc${stamp}`, characterType: 'npc' });
const pc = await jpost('/api/characters', { name: `Pc${stamp}`, characterType: 'pc' });
pcSock.emit('identity:set', { role: 'player', characterId: pc.id });
await sleep(400);

// **Granted, not Default.** annotateFollowUps only offers a direction whose
// move the grappler actually has, so a chain built from granted moves exercises
// the ownership check that a Default-move fixture never reaches.
for (const m of [knee, sweep, bodyLock, clinch]) {
  gm.emit('move:grant', { characterId: pc.id, moveId: m.id });
  await wait(gm, 'move:granted', (g) => g.moveId === m.id && g.characterId === pc.id);
}

gm.emit('combat:add_participant', { characterId: pc.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === pc.id));
gm.emit('combat:add_participant', { characterId: npc.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === npc.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const st0 = await jf('/api/combat?role=gm');
const start = st0.pairs[0].roundStartTic ?? 0;
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? pc : npc;
  if (who.id === pc.id) {
    pcSock.emit('move:declare', { characterId: pc.id, moveId: clinch.id, placementTic: start });
    await sleep(500);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(700);
}
await sleep(3000);

const pendingOf = (sock) => sock.latest?.pairs?.find((p) => p.pairIndex === 0)?.pendingGrapple ?? null;
const paused = async () => (await jf('/api/combat?role=gm')).pairs[0]?.resolutionStatus;

// ---------------------------------------------------------- the first grab
check('the first grapple pauses for the player', (await paused()) === 'paused_grapple', await paused());
let p = pendingOf(pcSock);
check('the PLAYER is asked, with the second grapple among the follow-ups',
  p?.role === 'grappler' && p?.directions?.some((d) => /Body Lock/.test(d.moveName ?? '')),
  JSON.stringify({ role: p?.role, dirs: p?.directions?.map((d) => d.moveName) }));

check('every granted follow-up is offered as available',
  p?.directions?.every((d) => d.available), JSON.stringify(p?.directions));
pcSock.emit('combat:grapple_choose', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: p?.grapplerDeclaredMoveId });
await sleep(1000);
check('picking advances to the GM guessing for the NPC', pendingOf(gm)?.phase === 'guess',
  JSON.stringify(pendingOf(gm)?.phase));
gm.emit('combat:grapple_guess', { pairIndex: 0, direction: 'down', grapplerDeclaredMoveId: p?.grapplerDeclaredMoveId });
await sleep(4000);

const midState = await jf('/api/combat?role=gm');
const lock = midState.declaredMoves.find((d) => d.moveName === `Body Lock ${stamp}`);
check('the second grapple is retroactively declared', lock != null,
  JSON.stringify(midState.declaredMoves.map((d) => d.moveName)));

// --------------------------------------------------------- the second grab
// This is the whole point: the chained move is itself a Grappling move, so
// when it reveals it has to run its own contest and open its own cross.
let secondPause = null;
for (let i = 0; i < 40; i++) {
  if ((await paused()) === 'paused_grapple') {
    const now = pendingOf(pcSock);
    if (now?.grapplerDeclaredMoveId !== p?.grapplerDeclaredMoveId) { secondPause = now; break; }
  }
  await sleep(500);
}
check('the chained grapple opens a SECOND cross', secondPause != null,
  `resolutionStatus=${await paused()}`);
check('...and offers its own follow-up',
  secondPause?.directions?.some((d) => /Knee/.test(d.moveName ?? '')),
  JSON.stringify(secondPause?.directions?.map((d) => d.moveName)));

if (secondPause) {
  check('...and every follow-up of the CHAINED grapple is available too',
    secondPause.directions?.every((d) => d.available), JSON.stringify(secondPause.directions));
  pcSock.emit('combat:grapple_choose', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: secondPause.grapplerDeclaredMoveId });
  await sleep(1000);
  check('the SECOND grapple also advances to a defender guess',
    pendingOf(gm)?.phase === 'guess', JSON.stringify(pendingOf(gm)?.phase));
  gm.emit('combat:grapple_guess', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: secondPause.grapplerDeclaredMoveId });
  await sleep(4000);
}

const finalState = await jf('/api/combat?role=gm');
check('the third link lands on the board too',
  finalState.declaredMoves.some((d) => d.moveName === `Knee ${stamp}`),
  JSON.stringify(finalState.declaredMoves.map((d) => d.moveName)));

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
const types = events.map((e) => e.type);
console.log('  events:', types.join(', '));
check('two grapple contests were resolved', types.filter((t) => t === 'grapple_resolved').length >= 2,
  types.filter((t) => t === 'grapple_resolved').length + ' grapple_resolved');
check('two follow-ups were chained', types.filter((t) => t === 'grapple_chained').length >= 2,
  types.filter((t) => t === 'grapple_chained').length + ' grapple_chained');
check('both reads were scored', types.filter((t) => t === 'grapple_guessed').length >= 2,
  types.filter((t) => t === 'grapple_guessed').length + ' grapple_guessed');

// **The ±5 has to survive a grapple-into-grapple.** An ordinary follow-up gets
// it through resolveAttack; a follow-up that is itself a grab bypasses that
// path entirely, so this is the probe that catches the swing being dropped.
const chained = events.find((e) => e.type === 'grapple_chained');
const chainedRoll = events.find(
  (e) => e.type === 'roll' && e.payload?.declaredMoveId === chained?.payload?.declaredMoveId
);
check('the chained GRAPPLE still carries the read swing on its own contest',
  chainedRoll?.payload?.chainRollBonus === 5,
  JSON.stringify({ chainRollBonus: chainedRoll?.payload?.chainRollBonus }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, pcSock]) s.close();
process.exit(failures ? 1 : 0);

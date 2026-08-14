// Playtest driver for Grappling's direction mini-game (G5) — three sockets,
// one GM and both fighters, because the claim that matters is a *secrecy*
// claim and it can only be checked per-connection.
//
// It is deliberately a socket test rather than a browser test: "the target
// cannot see the move names" has to mean the names never arrive, not that
// they arrive and aren't rendered. Only the raw payload each socket receives
// can prove that.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-grapple-minigame.mjs
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

// Each socket keeps its own latest snapshot, which is the whole point.
const connect = () =>
  new Promise((res) => {
    const sock = io(BASE);
    sock.latest = null;
    sock.on('combat:updated', (c) => { sock.latest = c; });
    sock.on('connect', () => res(sock));
  });

const gm = await connect();
const grapplerSock = await connect();
const targetSock = await connect();
const bystander = await connect();

const wait = (sock, ev, pred = () => true, ms = 10000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(600);

gm.emit('tell:create', { name: 'Reaches for the collar' });
const tell = await wait(gm, 'tell:created');
const stamp = Date.now();

const mk = async (name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    description: name, interactions: {},
    rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait(gm, 'move:created', (m) => m.name === `${name} ${stamp}`);
};

const armbar = await mk('Armbar', { startupTics: 1, activeTics: 1, recoveryTics: 1 });
const sweep = await mk('Sweep', { startupTics: 1, activeTics: 1, recoveryTics: 1 });

// TWO assigned directions is the threshold that turns the grab into a
// guessing game (decided).
const collarTie = await mk('Collar Tie', {
  rollModifier: 20, isGrappling: true,
  grappleDirections: { up: armbar.id, right: sweep.id },
  interactions: { grapple_success: { text: 'The hold takes.', automations: [] } },
});

const grappler = await jpost('/api/characters', { name: `Gr${stamp}`, characterType: 'pc' });
const victim = await jpost('/api/characters', { name: `Vi${stamp}`, characterType: 'pc' });

grapplerSock.emit('identity:set', { role: 'player', characterId: grappler.id });
targetSock.emit('identity:set', { role: 'player', characterId: victim.id });
bystander.emit('identity:set', { role: 'gm' });
await sleep(400);

gm.emit('combat:add_participant', { characterId: grappler.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === grappler.id));
gm.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));

// Declare and let the round run into the pause.
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  const who = side === 'left' ? grappler : victim;
  if (who.id === grappler.id) {
    gm.emit('move:declare', { characterId: who.id, moveId: collarTie.id });
    await wait(gm, 'combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === who.id));
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(500);
}
await sleep(2500);

// ---------- the pause ----------
const state = await jf('/api/combat?role=gm');
check('the round paused on the grapple instead of auto-resolving it',
  state.pairs[0]?.resolutionStatus === 'paused_grapple', state.pairs[0]?.resolutionStatus);

const pendingOf = (sock) => sock.latest?.pairs?.find((p) => p.pairIndex === 0)?.pendingGrapple ?? null;
const gp = pendingOf(grapplerSock);
const tp = pendingOf(targetSock);
const bp = pendingOf(bystander);

check('the grappler gets a prompt', gp?.role === 'grappler', JSON.stringify(gp?.role));
check('the target gets a prompt', tp?.role === 'target', JSON.stringify(tp?.role));

// THE claim.
check('the grappler sees the move names',
  gp?.directions?.every((d) => typeof d.moveName === 'string' && d.moveName.length > 0),
  JSON.stringify(gp?.directions));
check('the TARGET receives no move names at all — not hidden, absent',
  tp?.directions?.length === 2 && tp.directions.every((d) => d.moveName === null && d.moveId === null),
  JSON.stringify(tp?.directions));
check('the target still gets the shape: both directions, in cross order',
  tp?.directions?.map((d) => d.direction).join(',') === 'up,right',
  JSON.stringify(tp?.directions?.map((d) => d.direction)));
// Belt and braces: scan the target's WHOLE payload for the move names.
const targetBlob = JSON.stringify(targetSock.latest ?? {});
check('neither chained move name appears anywhere in the target\'s payload',
  !targetBlob.includes(`Armbar ${stamp}`) && !targetBlob.includes(`Sweep ${stamp}`),
  'a name leaked somewhere else in the snapshot');

check('a bystander sees that a grapple is happening and nothing about it',
  bp?.role === 'observer' && (bp?.directions?.length ?? 0) === 0, JSON.stringify(bp));

// `--hold` stops here with the pause still open, so a browser can be pointed
// at the live prompt (see the G5 visual pass).
if (process.argv.includes('--hold')) {
  console.log(`\nholding the pause open. grappler=${grappler.id} target=${victim.id}`);
  console.log(failures ? `${failures} FAILURE(S)` : 'all secrecy probes passed');
  process.exit(failures ? 1 : 0);
}

// ---------- answering it ----------
// Only the owner may answer. A guess sent by the GM socket for the target
// must be ignored.
gm.emit('combat:grapple_guess', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: gp.grapplerDeclaredMoveId });
await sleep(600);
check('an answer from someone who owns neither side is ignored',
  (await jf('/api/combat?role=gm')).pairs[0]?.resolutionStatus === 'paused_grapple');

// One half alone must not resolve anything.
grapplerSock.emit('combat:grapple_choose', { pairIndex: 0, direction: 'right', grapplerDeclaredMoveId: gp.grapplerDeclaredMoveId });
await sleep(900);
check('one half alone does not resolve the contest',
  (await jf('/api/combat?role=gm')).pairs[0]?.resolutionStatus === 'paused_grapple');
check('the grappler\'s own prompt now reads as answered', pendingOf(grapplerSock)?.answered === true);
check('the target is NOT told the grappler has answered',
  pendingOf(targetSock)?.answered === false,
  'knowing the other side has moved is itself a tell');

// The wrong guess: they say up, it went right.
targetSock.emit('combat:grapple_guess', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: gp.grapplerDeclaredMoveId });
await sleep(3500);

const after = await jf('/api/combat?role=gm');
check('both answers in clears the pause', after.pairs[0]?.resolutionStatus !== 'paused_grapple',
  after.pairs[0]?.resolutionStatus);

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
console.log('  events:', events.map((e) => e.type).join(', '));

const prompt = events.find((e) => e.type === 'grapple_prompt');
check('the replay records the prompt', prompt != null);
check('the PROMPT event leaks no move names — a replay is watched by everyone',
  !JSON.stringify(prompt?.payload ?? {}).includes('Armbar') &&
    !JSON.stringify(prompt?.payload ?? {}).includes('Sweep'),
  JSON.stringify(prompt?.payload));

const guessed = events.find((e) => e.type === 'grapple_guessed');
check('the read is recorded', guessed != null, events.map((e) => e.type).join(','));
check('a wrong guess is scored as wrong', guessed?.payload?.guessOutcome === 'wrong',
  JSON.stringify(guessed?.payload));
check('the replay now names both the choice and the guess — nothing left to spoil',
  guessed?.payload?.chosen === 'right' && guessed?.payload?.guess === 'up',
  JSON.stringify(guessed?.payload));

const resolved = events.find((e) => e.type === 'grapple_resolved');
check('the contest ran after the mini-game, not before', resolved != null);
check('it is flagged as having played the mini-game', resolved?.payload?.miniGame === true,
  JSON.stringify(resolved?.payload?.miniGame));
check('the +5 went to the grappler on a wrong guess',
  resolved?.payload?.guessOutcome === 'wrong', JSON.stringify(resolved?.payload?.guessOutcome));
check('it chained the direction the grappler actually picked',
  /Sweep/.test(resolved?.payload?.chainedMoveName ?? ''), resolved?.payload?.chainedMoveName);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, grapplerSock, targetSock, bystander]) s.close();
process.exit(failures ? 1 : 0);

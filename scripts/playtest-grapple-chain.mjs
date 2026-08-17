// Playtest for the reworked grapple flow: contest FIRST, then the grappler's
// follow-up pick, then the defender's guess, then a retroactive declaration.
//
// Three sockets, because who may answer is half the rule: the grappler's pick
// can only come from whoever owns the grabbing character.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-grapple-chain.mjs
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
const grapplerSock = await connect();
const targetSock = await connect();
const wait = (sock, ev, pred = () => true, ms = 10000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(500);
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

// Two follow-ups: one the grappler will be granted, one they never learn.
const knee = await mk('Knee', { isDefault: true, staminaCost: 1 });
const secret = await mk('Secret Throw');       // never granted -> must grey out
const clinch = await mk('Thai Clinch', {
  isDefault: true,
  // Without this, writeMove drops the directions AND refuses the
  // grapple_success trigger, and the move resolves as an ordinary attack.
  isGrappling: true,
  rollModifier: 20,                            // make the grab reliably land
  grappleDirections: { up: knee.id, right: secret.id },
  interactions: { grapple_success: { text: 'the clinch is set', automations: [] } },
});

const grappler = await jpost('/api/characters', { name: `Gr${stamp}`, characterType: 'pc' });
const victim = await jpost('/api/characters', { name: `Vi${stamp}`, characterType: 'pc' });
grapplerSock.emit('identity:set', { role: 'player', characterId: grappler.id });
targetSock.emit('identity:set', { role: 'player', characterId: victim.id });
await sleep(400);

gm.emit('combat:add_participant', { characterId: grappler.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === grappler.id));
gm.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));

gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

// **Only the grapple is declared.** The follow-up is the engine's job now.
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? grappler : victim;
  if (who.id === grappler.id) {
    gm.emit('move:declare', { characterId: who.id, moveId: clinch.id, placementTic: st.pairs[0].roundStartTic ?? 0 });
    await sleep(500);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(600);
}
await sleep(2500);

const pendingOf = (sock) => sock.latest?.pairs?.find((p) => p.pairIndex === 0)?.pendingGrapple ?? null;

// ---------- the contest ran BEFORE the prompt ----------
const st1 = await jf('/api/combat?role=gm');
check('the round pauses on the grapple', st1.pairs[0]?.resolutionStatus === 'paused_grapple',
  st1.pairs[0]?.resolutionStatus);

const gp = pendingOf(grapplerSock);
const tp = pendingOf(targetSock);
check('phase 1 asks the GRAPPLER', gp?.phase === 'choice' && gp?.answered === false, JSON.stringify(gp?.phase));
check('the defender is NOT asked yet, and is told who it waits on',
  tp?.answered === true && tp?.waitingOn === `Gr${stamp}`, JSON.stringify({ a: tp?.answered, w: tp?.waitingOn }));

check('the grappler sees the follow-up names', gp?.directions?.some((d) => /Knee/.test(d.moveName ?? '')),
  JSON.stringify(gp?.directions));
check('an ungranted follow-up is greyed with a reason',
  gp?.directions?.some((d) => d.available === false && d.reason === 'not-owned'),
  JSON.stringify(gp?.directions));
check('the granted, affordable one is available',
  gp?.directions?.some((d) => d.available === true && /Knee/.test(d.moveName ?? '')));
check('the defender receives no names and no availability',
  tp?.directions?.every((d) => d.moveName === null && d.available === null), JSON.stringify(tp?.directions));

// ---------- only the owner may pick ----------
gm.emit('combat:grapple_choose', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: gp.grapplerDeclaredMoveId });
await sleep(600);
check('the GM cannot pick for a PC grappler',
  (await jf('/api/combat?role=gm')).pairs[0]?.resolutionStatus === 'paused_grapple');

// An unavailable direction is refused.
grapplerSock.emit('combat:grapple_choose', { pairIndex: 0, direction: 'right', grapplerDeclaredMoveId: gp.grapplerDeclaredMoveId });
await sleep(600);
check('a follow-up they have not learned cannot be chosen',
  pendingOf(grapplerSock)?.phase === 'choice');

// ---------- phase 2 ----------
grapplerSock.emit('combat:grapple_choose', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: gp.grapplerDeclaredMoveId });
await sleep(900);
check('picking advances to the guess phase', pendingOf(targetSock)?.phase === 'guess',
  JSON.stringify(pendingOf(targetSock)?.phase));
check('now the DEFENDER is the one being asked', pendingOf(targetSock)?.answered === false);
check('and the grappler is done', pendingOf(grapplerSock)?.answered === true);

// Guess wrong -> +5 on the follow-up.
targetSock.emit('combat:grapple_guess', { pairIndex: 0, direction: 'down', grapplerDeclaredMoveId: gp.grapplerDeclaredMoveId });
await sleep(3000);

const after = await jf('/api/combat?role=gm');
check('both answers clear the pause', after.pairs[0]?.resolutionStatus !== 'paused_grapple',
  after.pairs[0]?.resolutionStatus);

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
const types = events.map((e) => e.type);
console.log('  events:', types.join(', '));

const iResolved = types.indexOf('grapple_resolved');
const iPrompt = types.indexOf('grapple_prompt');
check('grapple_resolved comes BEFORE grapple_prompt — the contest is settled first',
  iResolved >= 0 && iPrompt >= 0 && iResolved < iPrompt, `${iResolved} vs ${iPrompt}`);

const resolved = events.find((e) => e.type === 'grapple_resolved');
check('the contest event carries no direction or follow-up',
  resolved && resolved.payload.direction === undefined && resolved.payload.chainedMoveName === undefined,
  JSON.stringify(resolved?.payload));

const guessed = events.find((e) => e.type === 'grapple_guessed');
check('a wrong guess is scored wrong', guessed?.payload?.guessOutcome === 'wrong', JSON.stringify(guessed?.payload));
check('and is worth +5 on the follow-up', guessed?.payload?.chainRollBonus === 5,
  JSON.stringify(guessed?.payload?.chainRollBonus));

const chained = events.find((e) => e.type === 'grapple_chained');
check('the follow-up was retroactively declared', chained != null, types.join(','));
check('...carrying the +5', chained?.payload?.chainRollBonus === 5, JSON.stringify(chained?.payload));
check('...placed after the grab rather than jumping the clock',
  Number.isInteger(chained?.payload?.placementTic), JSON.stringify(chained?.payload?.placementTic));

// The follow-up is a real declared move everyone can see as a Tell.
const dm = after.declaredMoves.find((d) => d.id === chained?.payload?.declaredMoveId);
check('it is on the board as a declared move', dm != null, JSON.stringify(after.declaredMoves.length));
check('with a Tell visible to everyone', dm?.tellId != null);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, grapplerSock, targetSock]) s.close();
process.exit(failures ? 1 : 0);

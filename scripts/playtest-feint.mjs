// Playtest for the Feint Tag — the third Tag automation.
//
// The rule has two halves and only one of them is visible from the declaring
// side, which is why this drives three sockets rather than reading the
// database: the Feint's own Tell is public like any other move's, and
// whatever is declared on the very next Tic is dealt out of everyone else's
// combat payload entirely until it reveals.
//
// So every probe below asks the same question of two different viewers and
// checks that they disagree — plus one standing monitor on the opponent's
// socket, because the interesting failure is not "can they see it at the end"
// (they must, once it reveals) but "was there ever a frame where they could
// see it early". Sampling can miss that; watching every broadcast cannot.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-feint.mjs
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
const feinterSock = await connect();
const watcherSock = await connect();
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(500);
gm.emit('tell:create', { name: 'Shoulder drops' });
const tell = await wait(gm, 'tell:created');
const stamp = Date.now();

// The Feint Tag is seeded by db.js and matched by NAME — so this reads the
// live list rather than assuming an id, exactly as the automation does.
const tags = await jf('/api/tags');
const feintTag = (tags ?? []).find((t) => String(t.name).trim().toLowerCase() === 'feint');
check('the Feint Tag is seeded and reachable by name', feintTag != null,
  JSON.stringify((tags ?? []).map((t) => t.name)));
if (!feintTag) process.exit(1);

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait(gm, 'move:created', (m) => m.name === `${name} ${stamp}`);
};

const feint = await mk('Shoulder Dip', { tagIds: [feintTag.id] });
const hidden = await mk('Hidden Cross');
const plain = await mk('Plain Jab');

const feinter = await jpost('/api/characters', { name: `Fe${stamp}`, characterType: 'pc' });
const watcher = await jpost('/api/characters', { name: `Wa${stamp}`, characterType: 'pc' });
feinterSock.emit('identity:set', { role: 'player', characterId: feinter.id });
watcherSock.emit('identity:set', { role: 'player', characterId: watcher.id });
await sleep(400);

// **The standing invariant**: across every single broadcast the opponent ever
// receives, a row of the feinter's must never arrive while it is both masked
// and not yet publicly revealed. `feintMasked` is nulled out of their payload
// by construction (the row is dropped, not blanked), so this watches the only
// thing they could see — the row's presence — against the move ids the
// feinter's own view says are concealed.
const concealedIds = new Set();
let leaked = null;
watcherSock.on('combat:updated', (c) => {
  for (const dm of c.declaredMoves ?? []) {
    if (concealedIds.has(dm.id) && !dm.publiclyRevealed) leaked = dm;
  }
});

gm.emit('combat:add_participant', { characterId: feinter.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === feinter.id));
gm.emit('combat:add_participant', { characterId: watcher.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === watcher.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const declare = async (characterId, moveId, placementTic) => {
  gm.emit('move:declare', { characterId, moveId, placementTic });
  await sleep(500);
};
const finish = async (characterId) => {
  gm.emit('combat:character_done_declaring', { characterId });
  await sleep(700);
};
const minesOf = (sock, charId, fromTic = -Infinity) =>
  (sock.latest?.declaredMoves ?? []).filter((d) => d.characterId === charId && d.placementTic >= fromTic);
// Initiative decides who declares first and it is rolled, not chosen — so
// when the watcher won it, they have to be waved through before the feinter
// can put anything on the board at all. (move:declare is a silent no-op out
// of turn, which is exactly how the first draft of this playtest managed to
// assert against an empty timeline.)
const feinterTurn = async () => {
  const st = await jf('/api/combat?role=gm');
  if (st.pairs[0]?.declaringSide === 'right') await finish(watcher.id);
};

const st0 = await jf('/api/combat?role=gm');
const start = st0.pairs[0].roundStartTic ?? 0;
await feinterTurn();

// 1/1/1 frames, so the Feint occupies start..start+2 and the follow-up's only
// concealed home — the first free Tic — is start+3.
await declare(feinter.id, feint.id, start);
await declare(feinter.id, hidden.id, start + 3);

// Sampled HERE, mid-Declaration, which is the whole point: once the round has
// resolved the move is public for an entirely different and legitimate reason
// (it revealed), and a sample taken then proves nothing.
const own = minesOf(feinterSock, feinter.id);
const seen = minesOf(watcherSock, feinter.id);
const ownHidden = own.find((d) => d.placementTic === start + 3);
if (ownHidden) concealedIds.add(ownHidden.id);

check('the feinter sees both of their own declarations', own.length === 2, JSON.stringify(own.length));
check('the opponent sees only ONE of them', seen.length === 1, JSON.stringify(seen.map((d) => d.placementTic)));
check('and the one they see is the Feint itself, Tell and all',
  seen[0]?.placementTic === start && seen[0]?.tellId === tell.id,
  JSON.stringify({ at: seen[0]?.placementTic, tell: seen[0]?.tellId }));
check('the hidden move leaks nothing at all — not even a placement Tic',
  !seen.some((d) => d.placementTic === start + 3), JSON.stringify(seen.map((d) => d.placementTic)));
check('nor an attack telegraph on the Tic it starts on',
  !seen.some((d) => d.telegraphsAttack && d.placementTic === start + 3));
check('the feinter is told their follow-up is concealed', ownHidden?.feintMasked === true,
  JSON.stringify(ownHidden?.feintMasked));
const ownFeint = own.find((d) => d.placementTic === start);
check('the Feint itself is NOT concealed — it is the bait', ownFeint?.feintMasked === false,
  JSON.stringify(ownFeint?.feintMasked));

// ---------- the round resolves: the hidden move comes out ----------
await finish(feinter.id);
await finish(watcher.id);
for (let i = 0; i < 60 && minesOf(watcherSock, feinter.id).length < 2; i++) await sleep(500);

const afterSeen = minesOf(watcherSock, feinter.id);
check('once it reveals, the opponent can finally see it', afterSeen.length === 2,
  JSON.stringify(afterSeen.map((d) => ({ at: d.placementTic, name: d.moveName }))));
check('...and it reveals as the real move, by name',
  afterSeen.some((d) => d.moveName === `Hidden Cross ${stamp}`),
  JSON.stringify(afterSeen.map((d) => d.moveName)));
check('...and it was never once broadcast to them before that',
  leaked === null, JSON.stringify(leaked));

// ---------- the same shape WITHOUT a Feint hides nothing ----------
// The control that makes all of the above mean something: identical timing,
// identical frames, no Feint Tag — and the opponent sees both.
gm.emit('combat:clear', {});
await sleep(900);
gm.emit('combat:add_participant', { characterId: feinter.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === feinter.id));
gm.emit('combat:add_participant', { characterId: watcher.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === watcher.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const st2 = await jf('/api/combat?role=gm');
const start2 = st2.pairs[0].roundStartTic ?? 0;
await feinterTurn();

await declare(feinter.id, plain.id, start2);
await declare(feinter.id, hidden.id, start2 + 3);
const control = minesOf(watcherSock, feinter.id, start2);
check('a move declared right after an ORDINARY move is not hidden', control.length === 2,
  JSON.stringify(control.map((d) => d.placementTic)));

// ---------- and holding it back forfeits the concealment ----------
gm.emit('move:undeclare', { declaredMoveId: minesOf(feinterSock, feinter.id, start2 + 3)[0]?.id });
await sleep(500);
gm.emit('move:undeclare', { declaredMoveId: minesOf(feinterSock, feinter.id, start2)[0]?.id });
await sleep(500);
await declare(feinter.id, feint.id, start2);
await declare(feinter.id, hidden.id, start2 + 5); // a Tic later than "right after"
const late = minesOf(watcherSock, feinter.id, start2);
check('a move held back one Tic past the Feint is NOT hidden', late.length === 2,
  JSON.stringify(late.map((d) => d.placementTic)));

// ---------- taking the Feint back takes the concealment with it ----------
// The hole this closes: feint, hide the real move behind it, then undeclare
// the feint and keep the free invisibility. Everything is still pending here
// (nobody has pressed Done Declaring), so both takebacks are legal.
for (const dm of minesOf(feinterSock, feinter.id, start2)) {
  gm.emit('move:undeclare', { declaredMoveId: dm.id });
  await sleep(400);
}
await declare(feinter.id, feint.id, start2);
await declare(feinter.id, hidden.id, start2 + 3);
const stillHidden = minesOf(watcherSock, feinter.id, start2);
check('sanity: it is hidden again before the takeback', stillHidden.length === 1,
  JSON.stringify(stillHidden.map((d) => d.placementTic)));
const theFeint = minesOf(feinterSock, feinter.id, start2).find((d) => d.placementTic === start2);
gm.emit('move:undeclare', { declaredMoveId: theFeint?.id });
await sleep(700);
const unmasked = minesOf(watcherSock, feinter.id, start2);
check('undeclaring the Feint un-hides what it was hiding', unmasked.length === 1
  && unmasked[0]?.placementTic === start2 + 3,
  JSON.stringify(unmasked.map((d) => d.placementTic)));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, feinterSock, watcherSock]) s.close();
process.exit(failures ? 1 : 0);

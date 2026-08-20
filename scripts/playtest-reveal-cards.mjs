// Playtest: the move-reveal chat card, restored — and the gate on reading one
// in full.
//
// The card is back in the Chat Log after the Cutscene Resolution overhaul left
// the log with no record of a move coming out at all. What everybody gets is
// the **name, the picture and the frame data**; the rest of the move is what
// the **Genius Observer** Perk buys.
//
// The point worth proving here is that the gate is real. It used to be a
// disabled button sitting on top of a payload that had already been sent to
// every client — anybody with devtools could read the whole move. So this runs
// three connections at once (GM, an Observer, a plain Player) and asks each of
// them for the same move, over the same socket event the UI uses.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-reveal-cards.mjs
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
    sock.capabilities = null;
    sock.revealCards = [];
    sock.on('identity:capabilities', (c) => { sock.capabilities = c; });
    sock.on('chat:move_reveal', (e) => sock.revealCards.push(e));
    sock.on('connect', () => res(sock));
  });
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });
// Ask over the same socket event the expand button uses, and read the answer
// this connection alone receives.
const askDetail = (sock, moveId) => {
  const answer = wait(sock, 'move:detail', (p) => p.moveId === moveId);
  sock.emit('move:request_detail', { moveId });
  return answer;
};

const gm = await connect();
const observerSock = await connect();
const plainSock = await connect();
gm.emit('identity:set', { role: 'gm' });
await sleep(500);
const stamp = Date.now();

gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: `Reveal Tell ${stamp}` });
const tell = await wait(gm, 'tell:created', (t) => t.name === `Reveal Tell ${stamp}`);

// A description with a REAL LINE BREAK in it: the second item in this batch is
// that a break typed into the description survives to the card, and the full
// move is the one place a reader ever sees a move's description.
const DESCRIPTION = 'First line of the description.\nSecond line, after a break.';
gm.emit('move:create', {
  name: `Telegraphed Jab ${stamp}`, isDefault: true, tellId: tell.id,
  description: DESCRIPTION, interactions: {}, staminaCost: 0,
  startupTics: 2, activeTics: 1, recoveryTics: 3,
  rollSlots: ['Skull'], attackTargets: ['Body'],
});
const jab = await wait(gm, 'move:created', (m) => m.name === `Telegraphed Jab ${stamp}`);

// A move that is never declared, so it never reveals — the control for the
// second half of the gate.
gm.emit('move:create', {
  name: `Never Shown ${stamp}`, isDefault: true, tellId: tell.id,
  description: 'nobody should read this', interactions: {}, staminaCost: 0,
  startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'],
});
const secret = await wait(gm, 'move:created', (m) => m.name === `Never Shown ${stamp}`);

// Two PCs, so both can log in as themselves. One gets the Perk.
const observer = await jpost('/api/characters', { name: `Observer${stamp}`, characterType: 'pc' });
const plain = await jpost('/api/characters', { name: `Plain${stamp}`, characterType: 'pc' });
const perks = await jf('/api/perks');
const genius = perks.find((p) => p.name === 'Genius Observer');
check('Genius Observer is seeded from the registry', Boolean(genius), JSON.stringify(perks.map((p) => p.name)));
if (!genius) { process.exit(1); }
gm.emit('perk:grant', { characterId: observer.id, perkId: genius.id });
await sleep(700);

observerSock.emit('identity:set', { role: 'player', characterId: observer.id });
plainSock.emit('identity:set', { role: 'player', characterId: plain.id });
await sleep(800);
check('the Observer is told they may read a move in full',
  observerSock.capabilities?.canSeeRevealedDetail === true, JSON.stringify(observerSock.capabilities));
check('the plain Player is told they may not',
  plainSock.capabilities?.canSeeRevealedDetail === false, JSON.stringify(plainSock.capabilities));

// ================================================== 1. the card comes back
console.log('\n--- a move reaching its reveal Tic posts a card to everyone ---');
gm.emit('combat:add_participant', { characterId: observer.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === observer.id));
gm.emit('combat:add_participant', { characterId: plain.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === plain.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const st0 = await jf('/api/combat?role=gm');
const start = st0.pairs[0].roundStartTic ?? 0;
// **Only ONE of them throws it.** Both declaring the same move would be two
// declarations of one template, hence two perfectly correct cards — which
// would make the "exactly one card" probe below measure the fixture rather
// than the reveal loop's own idempotency.
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? observer : plain;
  if (who.id === observer.id) {
    gm.emit('move:declare', { characterId: who.id, moveId: jab.id, placementTic: start });
    await sleep(600);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(700);
}
await sleep(5000);

const cardOn = (sock) => sock.revealCards.filter((c) => c.move?.id === jab.id);
check('the GM got a reveal card', cardOn(gm).length > 0, JSON.stringify(gm.revealCards.length));
check('...and so did the Observer', cardOn(observerSock).length > 0, String(observerSock.revealCards.length));
check('...and so did the plain Player — the card itself is public',
  cardOn(plainSock).length > 0, String(plainSock.revealCards.length));

const card = cardOn(plainSock)[0];
console.log('  the public card:', JSON.stringify(card?.move));
check('it names the move', card?.move?.name === `Telegraphed Jab ${stamp}`, JSON.stringify(card?.move?.name));
check('it carries the frame data, all three segments',
  card?.move?.startupTics === 2 && card?.move?.activeTics === 1 && card?.move?.recoveryTics === 3,
  JSON.stringify(card?.move));
// The whole point of the split: the public card must not be the move.
check('it does NOT carry the description — that is the gated half',
  card?.move?.description === undefined, JSON.stringify(card?.move));
check('...nor the Roll, Tags or On Hit effects',
  card?.move?.full == null && card?.move?.roll_slots === undefined && card?.move?.tag_ids === undefined,
  JSON.stringify(Object.keys(card?.move ?? {})));

// And the same is true of the log as fetched on a page reload, which is the
// other way a client gets these cards.
const chat = await jf('/api/chat');
const stored = chat.filter((e) => e.kind === 'move_reveal' && e.move?.id === jab.id);
check('the stored log has the card too, so it survives a reload', stored.length > 0, String(chat.length));
// One declaration, one card: `reveal_posted` makes the reveal loop idempotent,
// so stepping through the Tics either side of the reveal must not re-post it.
check('exactly one card, not one per Tic the reveal was stepped through',
  stored.length === 1, String(stored.length));
check('and the stored card withholds the same half',
  stored[0]?.move?.description === undefined && stored[0]?.move?.full === undefined,
  JSON.stringify(stored[0]?.move));

// ================================================== 2. the gate
console.log('\n--- who may read the whole move ---');
const gmDetail = await askDetail(gm, jab.id);
check('the GM can read it in full', gmDetail.move?.name === `Telegraphed Jab ${stamp}`, JSON.stringify(gmDetail));
check('...and gets the whole move, interactions and all',
  Array.isArray(gmDetail.move?.tag_ids) && gmDetail.move?.interactions !== undefined,
  JSON.stringify(Object.keys(gmDetail.move ?? {})));

const observerDetail = await askDetail(observerSock, jab.id);
check('the Genius Observer can read it in full',
  observerDetail.move?.name === `Telegraphed Jab ${stamp}`, JSON.stringify(observerDetail));
check('...and the line break they typed into the description survived',
  observerDetail.move?.description === DESCRIPTION,
  JSON.stringify(observerDetail.move?.description));

const plainDetail = await askDetail(plainSock, jab.id);
check('the plain Player is refused — over the socket, not just in the UI',
  plainDetail.move === null && plainDetail.reason === 'perk', JSON.stringify(plainDetail));

// The second half of the gate: revealed, not merely existing.
const secretDetail = await askDetail(observerSock, secret.id);
check('even an Observer cannot read a move that was never revealed',
  secretDetail.move === null && secretDetail.reason === 'not_revealed', JSON.stringify(secretDetail));

// Revoking takes it back, live, without a reload — the same property the
// capability push already has.
gm.emit('perk:revoke', { characterId: observer.id, perkId: genius.id });
await sleep(900);
check('revoking the Perk takes the capability back', observerSock.capabilities?.canSeeRevealedDetail === false,
  JSON.stringify(observerSock.capabilities));
const afterRevoke = await askDetail(observerSock, jab.id);
check('...and the socket refuses them from then on',
  afterRevoke.move === null && afterRevoke.reason === 'perk', JSON.stringify(afterRevoke));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close(); observerSock.close(); plainSock.close();
process.exit(failures ? 1 : 0);

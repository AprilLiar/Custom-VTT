// Playtest for **Never a Fool** — you learn that a Feint is a Feint, and
// nothing else.
//
// This has to be a live socket probe rather than a unit test for exactly the
// reason Eye Catcher's is (see playtest-perks-batch5.mjs): what the Perk
// changes is the **per-viewer shape of a payload** — who is entitled to which
// key — and the only way to check an entitlement is to ask as somebody who
// does not have it. That takes real identities and the real endpoint.
//
// Four questions, and the last two are the ones that matter:
//
//   1. Does the entitled reader get `isFeint` on the opponent's Feint?
//   2. Is the key ABSENT — not `false` — for a reader without the Perk?
//   3. Does it stay absent on an ordinary move, so its presence is a real read
//      rather than a badge on everything?
//   4. Does the Perk still NOT see the move the Feint masks? That is the whole
//      bargain: knowing you are being lied to is not the same as knowing the
//      truth, and if the mask came off too, the Feint Tag would be worthless
//      against anybody carrying this.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-never-a-fool.mjs
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
await sleep(500);

const stamp = Date.now();
const perks = await jf('/api/perks');
const perk = (perks ?? []).find((p) => p.name === 'Never a Fool');
check('"Never a Fool" was seeded from the registry', perk != null,
  JSON.stringify((perks ?? []).map((p) => p.name)));
check('...and is flagged automated, not manual', perk?.automated === true && perk?.manual === false,
  JSON.stringify(perk));
if (!perk) { console.log(`\n${failures} FAILED`); process.exit(1); }

// Matched by NAME off the live list, exactly as the automation does — ids
// differ between databases and the GM owns the Tag list.
const tags = await jf('/api/tags');
const feintTag = (tags ?? []).find((t) => String(t.name).trim().toLowerCase() === 'feint');
check('the Feint Tag is seeded and reachable by name', feintTag != null,
  JSON.stringify((tags ?? []).map((t) => t.name)));
if (!feintTag) { console.log(`\n${failures} FAILED`); process.exit(1); }

gm.emit('tell:create', { name: `NAF Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `NAF Tell ${stamp}`);
const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    // Long Startup so nothing reveals during the probe: an unrevealed move is
    // the only window in which this Perk has anything to say.
    startupTics: 6, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

const feint = await mk('NAF Dip', { tagIds: [feintTag.id] });
const hidden = await mk('NAF Hidden');
const plain = await mk('NAF Jab');

const grant = async (characterId) => {
  gm.emit('perk:grant', { characterId, perkId: perk.id });
  await sleep(500);
};

// A pair seated and left in Declaration Phase, deliberately never finished:
// the round must not resolve, or every move goes public for a completely
// different and legitimate reason and the probe proves nothing.
const seat = async (label, { seerHasPerk }) => {
  gm.emit('combat:clear', {});
  await sleep(800);
  const seer = await jpost('/api/characters', { name: `NAF${label}a${stamp}`, characterType: 'pc' });
  const foe = await jpost('/api/characters', { name: `NAF${label}b${stamp}`, characterType: 'pc' });
  if (seerHasPerk) await grant(seer.id);
  gm.emit('combat:add_participant', { characterId: seer.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === seer.id));
  gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  return { seer, foe };
};

// Initiative decides who declares first and it is rolled, not chosen, so the
// other side has to be waved through before the one we care about can put
// anything on the board. move:declare is a silent no-op out of turn — which is
// how a first draft of a probe like this asserts against an empty timeline.
const turnOf = async (who, other) => {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0]?.declaringSide;
  const wantedSide = st.participants.find((p) => p.character_id === who.id)?.side;
  if (side && side !== wantedSide) {
    gm.emit('combat:character_done_declaring', { characterId: other.id });
    await sleep(700);
  }
};
const declare = async (characterId, moveId, placementTic) => {
  gm.emit('move:declare', { characterId, moveId, placementTic });
  await sleep(500);
};
const seenBy = async (charId) =>
  (await jf(`/api/combat?role=player&characterId=${charId}`))?.declaredMoves ?? [];

// ============================================ 1. the entitled reader
console.log('\n--- Never a Fool: a Feint aimed at you announces itself ---');
{
  const { seer, foe } = await seat('1', { seerHasPerk: true });
  const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
  await turnOf(foe, seer);
  // 6/1/1 frames put the Feint's footprint at start..start+7, so the follow-up
  // it masks goes on the first free Tic after it.
  await declare(foe.id, feint.id, start);
  await declare(foe.id, hidden.id, start + 8);
  // ...and one ordinary move of their own, as the in-fight control: the same
  // viewer, the same broadcast, a move that is not a Feint.
  await declare(foe.id, plain.id, start + 16);

  const rows = await seenBy(seer.id);
  const theirs = rows.filter((r) => r.characterId === foe.id);
  const marked = theirs.find((r) => r.placementTic === start);
  const control = theirs.find((r) => r.placementTic === start + 16);

  check('the Feint is still a secret — no name, no id',
    marked != null && marked.moveName == null && marked.moveId == null, JSON.stringify(marked));
  check('...but it is marked as a Feint', marked?.isFeint === true, JSON.stringify(marked?.isFeint));
  check('an ordinary move in the same broadcast carries NO such key',
    control != null && control.isFeint === undefined, JSON.stringify(control?.isFeint));
  // The bargain: the lie is visible, the truth behind it is not.
  check('the move the Feint MASKS is still not on the wire at all',
    !theirs.some((r) => r.placementTic === start + 8),
    JSON.stringify(theirs.map((r) => r.placementTic)));
  check('...and the Perk-holder can see how many of their opponent\'s moves there are — two, not three',
    theirs.length === 2, JSON.stringify(theirs.map((r) => r.placementTic)));

  // Their own Feint is not news to them, and gets no key — which also keeps
  // the key's presence a reliable signal for the UI.
  const foeRows = await seenBy(foe.id);
  const own = foeRows.find((r) => r.characterId === foe.id && r.placementTic === start);
  check('the feinter\'s own Feint carries no marker for themselves',
    own != null && own.isFeint === undefined, JSON.stringify(own?.isFeint));
}

// ============================================ 2. the control
console.log('\n--- ...and without the Perk, there is no key to read ---');
{
  const { seer, foe } = await seat('2', { seerHasPerk: false });
  const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
  await turnOf(foe, seer);
  await declare(foe.id, feint.id, start);

  const rows = await seenBy(seer.id);
  const marked = rows.find((r) => r.characterId === foe.id && r.placementTic === start);
  check('the same Feint reaches an unentitled viewer', marked != null, JSON.stringify(rows.length));
  // ABSENT, not false. A flag saying "this one is not a Feint" would tell a
  // reader with devtools which ones are, by elimination.
  check('...with the key absent entirely, not set to false',
    marked?.isFeint === undefined, JSON.stringify(marked?.isFeint));

  // The GM sees the board, not a player's Perk — the same reasoning: this is a
  // per-viewer entitlement, and the GM is not the viewer who earned it.
  const gmRows = (await jf('/api/combat?role=gm'))?.declaredMoves ?? [];
  const gmSeen = gmRows.find((r) => r.characterId === foe.id && r.placementTic === start);
  check('the GM view carries no marker either', gmSeen != null && gmSeen.isFeint === undefined,
    JSON.stringify(gmSeen?.isFeint));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
process.exit(failures ? 1 : 0);

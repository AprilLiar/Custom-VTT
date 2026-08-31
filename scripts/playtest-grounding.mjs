// Playtest: the **Grounding** Tag.
//
// The claim is one sentence — every Recovery frame of a Grounding move is a
// Trip Recovery frame — and it is written once, at declare time, onto
// `declared_moves.trip_recovery_tics`. Three things can only be checked against
// a running server, and all three fail silently:
//
//   1. **The column is actually written.** The unit test pins the arithmetic;
//      only a real declare proves the handler reaches it, with the resolved
//      per-character tag names rather than the template's.
//   2. **The frames reach the client as trip frames.** They are drawn from the
//      `tripRecoveryTics` on the combat payload, so a value stored and not sent
//      is a rule nobody at the table can see.
//   3. **Off The Ground can be thrown out of them.** That is the pair the Tag
//      exists for: Grounding writes the frames, Off The Ground reads them, and
//      a move carrying it may start early enough to overlap them.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3100 node server/index.js
//   E2E_URL=http://localhost:3100 node scripts/playtest-grounding.mjs
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

const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.latest = null;
gm.on('combat:updated', (c) => { gm.latest = c; });
gm.emit('identity:set', { role: 'gm' });
const wait = (ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
await sleep(400);

const stamp = Date.now();
gm.emit('combat:clear', {});
await sleep(500);
gm.emit('tell:create', { name: `Gr Tell ${stamp}` });
const tell = await wait('tell:created');

// The Tag is seeded by db.js and matched by NAME — so this reads the live list
// rather than assuming an id, exactly as the automation does.
const tags = await jf('/api/tags');
const named = (n) => (tags ?? []).find((t) => String(t.name).trim().toLowerCase() === n);
const grounding = named('grounding');
const offTheGround = named('off the ground');
check('the Grounding Tag is seeded and reachable by name', grounding != null,
  JSON.stringify((tags ?? []).map((t) => t.name)));
if (!grounding) process.exit(1);

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 2, recoveryTics: 3,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

const grounder = await mk('Sacrifice Throw', { tagIds: [grounding.id] });
const plain = await mk('Plain Jab');
const riser = await mk('Rising Knee', { tagIds: [offTheGround.id], startupTics: 2 });

const a = await jpost('/api/characters', { name: `GrA${stamp}`, characterType: 'pc' });
const b = await jpost('/api/characters', { name: `GrB${stamp}`, characterType: 'pc' });
gm.emit('combat:add_participant', { characterId: a.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === a.id));
gm.emit('combat:add_participant', { characterId: b.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === b.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const mine = (charId) => (gm.latest?.declaredMoves ?? []).filter((d) => d.characterId === charId);
const declare = async (characterId, moveId, placementTic) => {
  gm.emit('move:declare', { characterId, moveId, placementTic });
  await sleep(600);
};
// Initiative decides who declares first, so wave the other side through until
// it is our fighter's turn — move:declare is a silent no-op out of turn, which
// is how a playtest ends up asserting against an empty timeline.
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

// ============================================ 1. the frames are written
console.log('\n--- what a Grounding move puts on the clock ---');
await turnOf(a.id);
await declare(a.id, grounder.id, 0);
const grounded = mine(a.id).at(-1);
check('the Grounding move is on the board', grounded != null, JSON.stringify(mine(a.id)));
check('...and ALL three of its Recovery frames are Trip Recovery',
  grounded?.tripRecoveryTics === 3, JSON.stringify(grounded?.tripRecoveryTics));

// The footprint has to agree: trip frames are the tail measured back from the
// Recovery end, so a whole-window count reaches the Active end exactly.
check('...reaching back exactly to the end of its Active frames',
  grounded != null && grounded.recoveryEndTic - grounded.tripRecoveryTics === grounded.activeEndTic,
  JSON.stringify({ activeEndTic: grounded?.activeEndTic, recoveryEndTic: grounded?.recoveryEndTic,
    trip: grounded?.tripRecoveryTics }));

// ============================================ 2. the pair it exists for
//
// Declared in the SAME turn as the Grounding move above, deliberately: waving
// the other side through first ends the declaration phase, and the next round
// starts past every frame this one is asking about — which is how the first
// draft of this check measured a placement floor across a round boundary and
// called the feature broken.
console.log('\n--- getting up off the floor ---');
// Without Off The Ground the floor is the previous move's whole footprint; with
// it, Startup may reach back into the trip frames — capped by its own Startup.
await declare(a.id, riser.id, 0);
const rising = mine(a.id).at(-1);
check('an Off The Ground move may start inside the trip frames Grounding created',
  rising != null && rising.placementTic < grounded.recoveryEndTic,
  JSON.stringify({ placement: rising?.placementTic, groundedEnds: grounded?.recoveryEndTic }));
check('...but never before the trip window itself began',
  rising != null && rising.placementTic >= grounded.activeEndTic,
  JSON.stringify({ placement: rising?.placementTic, tripFrom: grounded?.activeEndTic }));
check('...and its Active frames still wait until it is back on its feet',
  rising != null && rising.revealTic >= grounded.recoveryEndTic,
  JSON.stringify({ reveal: rising?.revealTic, groundedEnds: grounded?.recoveryEndTic }));

// ============================================ 3. it changes nothing else
console.log('\n--- and what an ordinary move does ---');
await turnOf(b.id);
await declare(b.id, plain.id, 0);
const ordinary = mine(b.id).at(-1);
check('a move without the Tag has no Trip Recovery at all',
  (ordinary?.tripRecoveryTics ?? 0) === 0, JSON.stringify(ordinary?.tripRecoveryTics));
check('...and the same number of frames either way — Grounding changes their KIND, not their count',
  ordinary != null && grounded != null &&
    ordinary.recoveryEndTic - ordinary.activeEndTic === grounded.recoveryEndTic - grounded.activeEndTic,
  JSON.stringify({
    plain: (ordinary?.recoveryEndTic ?? 0) - (ordinary?.activeEndTic ?? 0),
    grounding: (grounded?.recoveryEndTic ?? 0) - (grounded?.activeEndTic ?? 0),
  }));

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
gm.close();
process.exit(failures === 0 ? 0 : 1);

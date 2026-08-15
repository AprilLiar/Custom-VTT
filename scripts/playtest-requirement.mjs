// Playtest driver for the Requirement field and custom Compendium ordering,
// against a real running server. The unit tests prove the pure rules; this
// proves the wiring — persistence, the delete cleanup, the declare gate, and
// the forced placement Tic, none of which a pure test can reach.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-requirement.mjs
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
await new Promise((res) => gm.on('connect', res));
const wait = (ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(500);

gm.emit('tell:create', { name: 'Shoulder dips' });
const tell = await wait('tell:created');
const stamp = Date.now();

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {},
    // Skull, not Hand: an appendage slot taken once is ambiguous and would
    // demand two Tells (learned the hard way in G3).
    rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// ---------- authoring ----------
const jab = await mk('Jab');
const cross = await mk('Cross', { requirementMoveId: jab.id });

const readBack = async (id) => (await jf('/api/moves')).moves.find((m) => m.id === id);

check('a Requirement survives the round trip',
  (await readBack(cross.id))?.requirement_move_id === jab.id,
  JSON.stringify((await readBack(cross.id))?.requirement_move_id));
check('the required move\'s NAME is resolved server-side',
  (await readBack(cross.id))?.requirement_move_name === `Jab ${stamp}`,
  JSON.stringify((await readBack(cross.id))?.requirement_move_name));
check('a move with no Requirement reads back null, not 0',
  (await readBack(jab.id))?.requirement_move_id == null,
  JSON.stringify((await readBack(jab.id))?.requirement_move_id));

// A move may not require itself.
gm.emit('move:update', { moveId: cross.id, name: `Cross ${stamp}`, isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 1, recoveryTics: 1, description: 'x', interactions: {},
  rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0, requirementMoveId: cross.id });
await sleep(500);
check('a self-referencing Requirement is dropped, not stored',
  (await readBack(cross.id))?.requirement_move_id == null,
  JSON.stringify((await readBack(cross.id))?.requirement_move_id));

// Put it back for the combat half.
gm.emit('move:update', { moveId: cross.id, name: `Cross ${stamp}`, isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 1, recoveryTics: 1, description: 'x', interactions: {},
  rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0, requirementMoveId: jab.id });
await sleep(500);
check('the Requirement can be set back after being cleared',
  (await readBack(cross.id))?.requirement_move_id === jab.id);

// Deleting the required move must clear the pointer rather than orphan it.
const doomed = await mk('Doomed');
const dependent = await mk('Dependent', { requirementMoveId: doomed.id });
gm.emit('move:delete', { moveId: doomed.id });
await sleep(600);
check('deleting a required move clears the Requirement that pointed at it',
  (await readBack(dependent.id))?.requirement_move_id == null,
  JSON.stringify((await readBack(dependent.id))?.requirement_move_id));
check('...and the requiring move itself survives',
  (await readBack(dependent.id)) != null);

// ---------- custom ordering ----------
const before = (await jf('/api/moves')).moves.map((m) => m.id);
check('a library nobody reordered comes back in id order',
  before.join(',') === [...before].sort((a, b) => a - b).join(','), before.join(','));

const reversed = [...before].reverse();
gm.emit('move:reorder', { moveIds: reversed });
await sleep(600);
const after = (await jf('/api/moves')).moves.map((m) => m.id);
check('a custom order persists and is what /api/moves returns',
  after.join(',') === reversed.join(','), `${after.join(',')} vs ${reversed.join(',')}`);

// Reordering a SUBSET must only permute that subset's own slots.
const subset = [after[0], after[1]];
gm.emit('move:reorder', { moveIds: [subset[1], subset[0]] });
await sleep(600);
const after2 = (await jf('/api/moves')).moves.map((m) => m.id);
check('reordering a filtered subset leaves every other move where it was',
  after2.slice(2).join(',') === after.slice(2).join(','),
  `${after2.join(',')} vs ${after.join(',')}`);
check('...and swaps the two that were sent',
  after2[0] === subset[1] && after2[1] === subset[0], after2.join(','));

// ---------- the declaration gate ----------
const fighter = await jpost('/api/characters', { name: `Fi${stamp}`, characterType: 'npc' });
const foe = await jpost('/api/characters', { name: `Fo${stamp}`, characterType: 'npc' });
gm.emit('combat:add_participant', { characterId: fighter.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === fighter.id));
gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));

gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

// Whoever declares first — we only care that ONE character runs the sequence.
let st = await jf('/api/combat?role=gm');
const side = st.pairs[0].declaringSide;
const actor = side === 'left' ? fighter : foe;
const roundStart = st.pairs[0].roundStartTic ?? 0;

const declaredOf = async (charId) =>
  (await jf('/api/combat?role=gm')).declaredMoves.filter((d) => d.characterId === charId);

// 1. Cross cannot open a sequence.
gm.emit('move:declare', { characterId: actor.id, moveId: cross.id, placementTic: roundStart });
await sleep(600);
check('a Requirement move cannot be declared with nothing before it',
  (await declaredOf(actor.id)).length === 0,
  JSON.stringify(await declaredOf(actor.id)));

// 2. Jab opens it fine.
gm.emit('move:declare', { characterId: actor.id, moveId: jab.id, placementTic: roundStart });
await sleep(600);
const afterJab = await declaredOf(actor.id);
check('the required move declares normally', afterJab.length === 1, JSON.stringify(afterJab));

// 3. Cross now declares — and IGNORES the requested Tic, landing exactly at
//    the Jab's footprint end. Jab is 1/1/1 at roundStart: reveal +1, then
//    Active +1 and Recovery +1, so it ends at roundStart+3.
const expected = roundStart + 3;
gm.emit('move:declare', { characterId: actor.id, moveId: cross.id, placementTic: roundStart + 6 });
await sleep(600);
const afterCross = await declaredOf(actor.id);
check('the Requirement move declares once its predecessor is queued',
  afterCross.length === 2, JSON.stringify(afterCross.map((d) => d.moveId)));
const crossRow = afterCross.find((d) => d.moveId === cross.id);
check('"right after" is enforced as a TIC, not just an order — the dragged Tic is ignored',
  crossRow?.placementTic === expected,
  `placed at ${crossRow?.placementTic}, expected ${expected}`);

// 4. A DIFFERENT move breaks the adjacency, so Cross can no longer follow.
//    It has to be a different one: re-declaring the Jab would legitimately
//    re-satisfy the Requirement, which is the rule working, not failing.
const hook = await mk('Hook');
gm.emit('move:declare', { characterId: actor.id, moveId: hook.id, placementTic: expected + 3 });
await sleep(600);
check('the interloping move queues', (await declaredOf(actor.id)).length === 3);
gm.emit('move:declare', { characterId: actor.id, moveId: cross.id });
await sleep(600);
const finalQueue = await declaredOf(actor.id);
check('a Requirement satisfied earlier in the queue does not count again',
  finalQueue.filter((d) => d.moveId === cross.id).length === 1,
  JSON.stringify(finalQueue.map((d) => d.moveId)));

// 5. ...but it becomes declarable again the moment its predecessor is back
//    at the end of the queue. Same rule, stated positively.
gm.emit('move:declare', { characterId: actor.id, moveId: jab.id });
await sleep(600);
gm.emit('move:declare', { characterId: actor.id, moveId: cross.id });
await sleep(600);
const reopened = await declaredOf(actor.id);
check('re-queueing the required move makes the Requirement move legal again',
  reopened.filter((d) => d.moveId === cross.id).length === 2,
  JSON.stringify(reopened.map((d) => d.moveId)));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

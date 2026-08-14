// Playtest driver for Grappling authoring (G3). Drives the real server over
// sockets and reads every field back through the API, because the interesting
// claims here are all round-trip claims: does what the Move Creator sends
// survive writeMove, attachInteractions and a reload unchanged?
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-grapple-authoring.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const moveById = async (id) => (await jf('/api/moves')).moves.find((m) => m.id === id);

const s = io(BASE);
const wait = (ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
    s.on(ev, h);
  });

await new Promise((r) => s.on('connect', r));
s.emit('identity:set', { role: 'gm' });

s.emit('tell:create', { name: 'Closes distance' });
const tell = await wait('tell:created');

const stamp = Date.now();
const plain = async (name) => {
  s.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: 'A chain target.', interactions: {},
    rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

const armbar = await plain('Armbar');
const sweep = await plain('Sweep');
const slam = await plain('Slam');
const doomed = await plain('Doomed'); // deleted later, to test the dangling arrow

// ---------- 1. a full grappling move round-trips ----------
s.emit('move:create', {
  name: `Collar Tie ${stamp}`, isDefault: true, tellId: tell.id,
  startupTics: 2, activeTics: 2, recoveryTics: 1,
  description: 'Hands on the neck.',
  rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 2,
  isGrappling: true,
  resistRollSlots: ['Leg', 'Leg'], // doubled: both legs
  grappleDirections: { up: armbar.id, right: sweep.id, down: doomed.id },
  interactions: { grapple_success: { text: 'The hold takes.', automations: [] } },
});
let collar = await wait('move:created', (m) => m.name === `Collar Tie ${stamp}`);

check('is_grappling persists', collar.is_grappling === 1, String(collar.is_grappling));
check('the Resist Roll persists, doubling included',
  JSON.stringify(collar.resist_roll_slots) === JSON.stringify(['Leg', 'Leg']),
  JSON.stringify(collar.resist_roll_slots));
check('three assigned directions persist',
  collar.grapple_directions?.length === 3, JSON.stringify(collar.grapple_directions));
check('directions come back in cross order',
  collar.grapple_directions?.map((d) => d.direction).join(',') === 'up,down,right',
  JSON.stringify(collar.grapple_directions?.map((d) => d.direction)));
check('On Successful Grapple is stored on a grappling move',
  collar.interactions?.some((r) => r.trigger === 'grapple_success'),
  JSON.stringify(collar.interactions));

// The create broadcast could differ from a fresh read; the GM will reload.
const reread = await moveById(collar.id);
check('a fresh read agrees with the create broadcast',
  JSON.stringify(reread.grapple_directions) === JSON.stringify(collar.grapple_directions) &&
    JSON.stringify(reread.resist_roll_slots) === JSON.stringify(collar.resist_roll_slots),
  JSON.stringify(reread.grapple_directions));

// ---------- 2. a move cannot point a direction at itself ----------
s.emit('move:update', {
  moveId: collar.id, name: collar.name, isDefault: true, tellId: tell.id,
  startupTics: 2, activeTics: 2, recoveryTics: 1, description: collar.description,
  rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 2,
  isGrappling: true, resistRollSlots: ['Leg', 'Leg'],
  grappleDirections: { up: armbar.id, left: collar.id },
  interactions: { grapple_success: { text: 'The hold takes.', automations: [] } },
});
collar = await wait('move:updated', (m) => m.id === collar.id);
check('a self-referencing direction is dropped',
  !collar.grapple_directions.some((d) => d.target_move_id === collar.id),
  JSON.stringify(collar.grapple_directions));
check('the other directions in the same save survive',
  collar.grapple_directions.some((d) => d.direction === 'up' && d.target_move_id === armbar.id),
  JSON.stringify(collar.grapple_directions));

// ---------- 3. deleting a targeted move clears the arrow ----------
s.emit('move:update', {
  moveId: collar.id, name: collar.name, isDefault: true, tellId: tell.id,
  startupTics: 2, activeTics: 2, recoveryTics: 1, description: collar.description,
  rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 2,
  isGrappling: true, resistRollSlots: ['Body'],
  grappleDirections: { up: armbar.id, down: doomed.id, right: slam.id },
  interactions: { grapple_success: { text: 'The hold takes.', automations: [] } },
});
collar = await wait('move:updated', (m) => m.id === collar.id);
check('the arrow at the doomed move is set before we delete it',
  collar.grapple_directions.some((d) => d.target_move_id === doomed.id));

s.emit('move:delete', { moveId: doomed.id });
await wait('move:deleted', (p) => p.moveId === doomed.id);
await sleep(300);
const afterDelete = await moveById(collar.id);
check('deleting a targeted move clears that direction, not the whole move',
  afterDelete != null && !afterDelete.grapple_directions.some((d) => d.target_move_id === doomed.id),
  JSON.stringify(afterDelete?.grapple_directions));
check('the surviving directions are untouched',
  afterDelete.grapple_directions.map((d) => d.direction).join(',') === 'up,right',
  JSON.stringify(afterDelete.grapple_directions.map((d) => d.direction)));

// ---------- 4. unticking Grappling clears everything it owns ----------
s.emit('move:update', {
  moveId: collar.id, name: collar.name, isDefault: true, tellId: tell.id,
  startupTics: 2, activeTics: 2, recoveryTics: 1, description: collar.description,
  rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 2,
  isGrappling: false,
  resistRollSlots: ['Body'],
  grappleDirections: { up: armbar.id },
  interactions: { grapple_success: { text: 'The hold takes.', automations: [] } },
});
collar = await wait('move:updated', (m) => m.id === collar.id);
check('unticking Grappling clears is_grappling', collar.is_grappling === 0, String(collar.is_grappling));
check('...and its directions', collar.grapple_directions.length === 0,
  JSON.stringify(collar.grapple_directions));
check('...and its Resist Roll', collar.resist_roll_slots.length === 0,
  JSON.stringify(collar.resist_roll_slots));
check('...and its On Successful Grapple, even though the payload still had one',
  !collar.interactions.some((r) => r.trigger === 'grapple_success'),
  JSON.stringify(collar.interactions));

// ---------- 5. the Defensive Roll pool, authorable for the first time ----------
s.emit('move:create', {
  name: `Cross Guard ${stamp}`, isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  description: 'Both forearms up.', interactions: {},
  rollSlots: ['Hand', 'Hand'], attackTargets: ['Body'], staminaCost: 1,
  isDefensive: true, defenseKind: 'block', defenseFramePositions: [1],
  defensiveRollSlots: ['Body'],
});
let guard = await wait('move:created', (m) => m.name === `Cross Guard ${stamp}`);
check('a Defensive Roll pool can finally be authored',
  JSON.stringify(guard.defensive_roll_slots) === JSON.stringify(['Body']),
  JSON.stringify(guard.defensive_roll_slots));
check('the base Roll is untouched by it',
  JSON.stringify(guard.roll_slots) === JSON.stringify(['Hand', 'Hand']),
  JSON.stringify(guard.roll_slots));

s.emit('move:update', {
  moveId: guard.id, name: guard.name, isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 2, recoveryTics: 1, description: guard.description,
  interactions: {}, rollSlots: ['Hand', 'Hand'], attackTargets: ['Body'], staminaCost: 1,
  isDefensive: false, defensiveRollSlots: ['Body'],
});
guard = await wait('move:updated', (m) => m.id === guard.id);
check('unticking Defensive clears the Defensive Roll too',
  guard.defensive_roll_slots.length === 0, JSON.stringify(guard.defensive_roll_slots));

// ---------- 6. an ordinary move is unaffected by any of this ----------
const untouched = await moveById(armbar.id);
check('a plain move carries empty grapple fields, not nulls',
  Array.isArray(untouched.grapple_directions) &&
    untouched.grapple_directions.length === 0 &&
    Array.isArray(untouched.resist_roll_slots) &&
    untouched.resist_roll_slots.length === 0,
  JSON.stringify({ d: untouched.grapple_directions, r: untouched.resist_roll_slots }));
check('a plain move is not grappling', untouched.is_grappling === 0, String(untouched.is_grappling));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
s.close();
process.exit(failures ? 1 : 0);

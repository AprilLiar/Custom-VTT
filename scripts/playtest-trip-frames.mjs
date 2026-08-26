// Playtest: Trip Recovery Frames, end to end.
//
// The unit tests pin the timing math (server/test/tripFrames.test.js) and the
// round-engine test pins Movement Punisher's column. What only a live server
// shows is the chain between them: a trip imposed during resolution, written
// as trip frames on the right row, carried into the combat payload, and then
// *read back at declare time* by the Off The Ground Tag — which is the one
// rule that spans resolution and declaration and so cannot be unit-tested
// without inventing both halves.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3041 node server/index.js
//   E2E_URL=http://localhost:3041 PLAYTEST_DB="file:/tmp/pt.db" node scripts/playtest-trip-frames.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
if (!process.env.PLAYTEST_DB) {
  console.error('PLAYTEST_DB must be the same TURSO_DATABASE_URL the server was started with.');
  process.exit(1);
}
process.env.TURSO_DATABASE_URL = process.env.PLAYTEST_DB;
const { all, one, run } = await import('../server/db.js');

let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok ? '' : ' — ' + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 20000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
const setupFailed = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', setupFailed);
process.on('uncaughtException', setupFailed);

gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

// ---- the Tags are seeded, including the new one -----------------------------
const tags = await all('SELECT id, name FROM tags');
const tagId = (name) => tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id;
check('the Off The Ground Tag is seeded at startup', tagId('Off The Ground') != null);
check('Movement and Movement Punisher are still seeded', tagId('Movement') != null && tagId('Movement Punisher') != null);
if (fails) process.exit(1);

gm.emit('tell:create', { name: `TripTell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `TripTell ${stamp}`);
const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name}${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name}${stamp}`);
};

// A large roll modifier so the sweep reliably lands REAL damage: Movement
// Punisher needs a genuine connection, and a sub-5 roll is Insignificant
// Damage, which trips nobody. Leaving that to chance would make this playtest
// pass or fail on a die.
const sweep = await mk('TripSweep', { startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Skull'], rollModifier: 20 });
await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [sweep.id, tagId('Movement Punisher')]);
const dash = await mk('TripDash', { startupTics: 1, activeTics: 3, recoveryTics: 2, rollSlots: ['Body'] });
await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [dash.id, tagId('Movement')]);
// Two follow-ups, identical except for the Tag — the whole comparison.
const kipUp = await mk('TripKipUp', { startupTics: 2, activeTics: 1, recoveryTics: 1, rollSlots: ['Right Hand'] });
await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [kipUp.id, tagId('Off The Ground')]);
const plainJab = await mk('TripJab', { startupTics: 2, activeTics: 1, recoveryTics: 1, rollSlots: ['Right Hand'] });

const punisher = await jpost('/api/characters', { name: `P${stamp}`, characterType: 'npc' });
const runner = await jpost('/api/characters', { name: `R${stamp}`, characterType: 'npc' });
// A big Skull so the sweep reliably lands real damage — the trip needs a
// genuine connection, not a graze.
await run("UPDATE dice SET current_size = 12 WHERE character_id = ? AND slot_name = 'Skull'", [punisher.id]);

gm.emit('combat:add_participant', { characterId: punisher.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === punisher.id));
gm.emit('combat:add_participant', { characterId: runner.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === runner.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
// Declaration alternates by side — the loser of initiative declares first —
// so declaring in a fixed order silently drops one of them. The first version
// of this script did exactly that and measured an empty round.
const declareFor = { left: { characterId: punisher.id, moveId: sweep.id }, right: { characterId: runner.id, moveId: dash.id } };
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  const who = declareFor[side];
  gm.emit('move:declare', { ...who, placementTic: start });
  await sleep(500);
  gm.emit('combat:character_done_declaring', { characterId: who.characterId });
  await sleep(500);
}

// Wait for the round to resolve and the trip to land on the row.
let dashRow = null;
for (let i = 0; i < 120; i += 1) {
  dashRow = await one(
    'SELECT id, trip_recovery_tics, recovery_extension_tics, reveal_tic FROM declared_moves WHERE character_id = ? AND move_id = ?',
    [runner.id, dash.id]
  );
  if ((dashRow?.trip_recovery_tics ?? 0) > 0) break;
  await sleep(250);
}

if (!dashRow) {
  const types = (await all('SELECT type FROM round_events ORDER BY seq')).map((e) => e.type).join(', ');
  console.log(`FAIL: the Movement move never made it onto the board — round events: ${types}`);
  console.log('\n1 FAILED');
  process.exit(1);
}
check('Movement Punisher wrote Trip frames, not ordinary Recovery', (dashRow?.trip_recovery_tics ?? 0) === 3, JSON.stringify(dashRow));
check('the trip also extended the footprint, as imposed Recovery always did', (dashRow?.recovery_extension_tics ?? 0) >= 3, JSON.stringify(dashRow));

const chat = await jf('/api/chat');
const said = chat.some((c) => typeof c.message === 'string' && /Trip Recovery/.test(c.message));
check('the Chat Log calls it Trip Recovery by name', said);

// **The cutscene's own channel, which the first version of this file never
// checked.** It asserted the DB column and the REST payload and passed — while
// `moves_displaced` carried no `trip` flag and `reveal`/`carryover` carried no
// `tripRecoveryTics` at all, so the replay drew every trip frame as ordinary
// Recovery and the down arrow never appeared anywhere. Two channels carry this
// fact and testing one of them is testing half the feature.
const events = await all(
  "SELECT type, payload FROM round_events WHERE type IN ('moves_displaced','reveal','carryover') ORDER BY seq"
);
const displaced = events
  .filter((e) => e.type === 'moves_displaced')
  .map((e) => JSON.parse(e.payload))
  .find((p) => p.phase === 'in-flight');
check(
  'the moves_displaced event tells the cutscene this was a trip',
  displaced?.trip === true,
  JSON.stringify(displaced ?? null)
);
const footprintEvents = events
  .filter((e) => e.type === 'reveal' || e.type === 'carryover')
  .map((e) => JSON.parse(e.payload));
check(
  'every cutscene footprint payload carries tripRecoveryTics',
  footprintEvents.length > 0 && footprintEvents.every((p) => p.tripRecoveryTics !== undefined),
  JSON.stringify(footprintEvents.map((p) => [p.declaredMoveId, p.tripRecoveryTics]))
);

const snapshot = await jf('/api/combat?role=gm');
const dashDeclared = (snapshot.declaredMoves ?? []).find((d) => d.id === dashRow?.id);
check('the combat payload carries tripRecoveryTics for the client', dashDeclared?.tripRecoveryTics === 3, JSON.stringify(dashDeclared ?? null));

// ---- Off The Ground: the rule that spans resolution and declaration ---------
// Both follow-ups have 2 Startup against 3 trip frames, so the Tagged one may
// start 2 Tics early and the plain one may not. Declared one at a time and
// removed in between, so each is measured against the same floor.
const floorNow = dashRow.reveal_tic + 3 + 2 + (dashRow.recovery_extension_tics ?? 0);

const declareAndRead = async (move) => {
  gm.emit('move:declare', { characterId: runner.id, moveId: move.id, placementTic: floorNow - 5 });
  await sleep(700);
  const row = await one(
    'SELECT id, placement_tic FROM declared_moves WHERE character_id = ? AND move_id = ? ORDER BY id DESC LIMIT 1',
    [runner.id, move.id]
  );
  if (row) await run('DELETE FROM declared_moves WHERE id = ?', [row.id]);
  return row?.placement_tic ?? null;
};

const plainAt = await declareAndRead(plainJab);
const taggedAt = await declareAndRead(kipUp);

check('an ordinary move still waits for the whole footprint', plainAt === floorNow, `placed at ${plainAt}, floor is ${floorNow}`);
check(
  'Off The Ground starts 2 Tics early, overlapping exactly its own Startup',
  taggedAt === floorNow - 2,
  `placed at ${taggedAt}, expected ${floorNow - 2}`
);
check(
  'and its Active frames still do not begin before the trip window ends',
  taggedAt != null && taggedAt + 2 >= floorNow,
  `Active would begin at ${taggedAt + 2}, floor is ${floorNow}`
);

console.log(fails === 0 ? '\nall probes passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

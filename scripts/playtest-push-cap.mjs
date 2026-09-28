// Playtest: a move may not be pushed more than ONE round into the future.
//
//   TURSO_DATABASE_URL="file:/tmp/push.db" PORT=3043 node server/index.js
//   E2E_URL=http://localhost:3043 PLAYTEST_DB="file:/tmp/push.db" node scripts/playtest-push-cap.mjs
//
// Decided rule: a cascade that shoves a declaration into the NEXT round is an
// ordinary postponement — it keeps its place and hands its Stamina back. One
// that would shove it TWO rounds out is a move that is never going to happen,
// so it is refunded in full and taken off the board.
//
// `pushHorizon` is unit-tested at every boundary (server/test/combatDamage.test.js).
// What only a live server can show is the WIRING: that the branch actually
// deletes the row and actually returns the Stamina. Every bug of this shape in
// this codebase so far has been a correct function nobody called.
//
// A two-round push is hard to produce from a natural fight, so the pause the
// cascade answers is written directly with a `blockedUntil` far enough out to
// trigger it — the real `combat:resolve_move_conflict` handler then runs on
// real rows, which is the half being tested.
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
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

gm.emit('tell:create', { name: `Push ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `Push ${stamp}`);
const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name}${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name}${stamp}`);
};
// Costs Stamina, so "was it refunded" is a number rather than a shrug.
const COST = 3;
const guard = await mk('PushGuard', { startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'], staminaCost: 0 });
const queued = await mk('PushQueued', { startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'], staminaCost: COST });

const a = await jpost('/api/characters', { name: `PA${stamp}`, characterType: 'npc' });
const b = await jpost('/api/characters', { name: `PB${stamp}`, characterType: 'npc' });

gm.emit('combat:add_participant', { characterId: a.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === a.id));
gm.emit('combat:add_participant', { characterId: b.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === b.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const combat = await jf('/api/combat?role=gm');
const start = combat.pairs[0].roundStartTic ?? 0;

// Both fighters declare; A gets two moves so there is a tail to push.
const want = { left: { characterId: a.id }, right: { characterId: b.id } };
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  const who = want[side];
  gm.emit('move:declare', { characterId: who.characterId, moveId: guard.id, placementTic: start });
  await sleep(400);
  if (who.characterId === a.id) {
    gm.emit('move:declare', { characterId: a.id, moveId: queued.id, placementTic: start + 3 });
    await sleep(400);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.characterId });
  await sleep(450);
}

const target = await one(
  `SELECT dm.id, dm.placement_tic, dm.stamina_committed, dm.stamina_committed_amount
   FROM declared_moves dm WHERE dm.character_id = ? AND dm.move_id = ?`,
  [a.id, queued.id]
);
check('the move that will be pushed is on the board', Boolean(target), 'never declared');
if (!target) process.exit(1);
check(
  `and its Stamina is committed (${target.stamina_committed_amount} to give back)`,
  Boolean(target.stamina_committed) && Number(target.stamina_committed_amount) === COST,
  `committed=${target.stamina_committed} amount=${target.stamina_committed_amount}, expected ${COST}`
);

// **Drain the pool first, so the refund is actually visible.** `adjustStamina`
// clamps at `max_stamina`, and a fighter sitting near full turns a 3-point
// refund into a 1-point one — which passes a naive assertion for the wrong
// reason. Emptying it well below the ceiling makes the number mean what it says.
await run('UPDATE characters SET current_stamina = 2 WHERE id = ?', [a.id]);
// Read as late as possible: the engine is still settling the round, so an
// absolute figure taken earlier goes stale.
const pool = await one('SELECT current_stamina, max_stamina FROM characters WHERE id = ?', [a.id]);
const before = pool?.current_stamina ?? 0;
const ceiling = pool?.max_stamina ?? Infinity;
check('the pool has room for a full refund', before + COST <= ceiling, `${before} + ${COST} > ${ceiling}`);

// The round window, and a blockedUntil two whole rounds past it.
const res = await one(
  `SELECT id, round_start_tic, round_length FROM pair_round_resolutions WHERE pair_index = 0 ORDER BY id DESC LIMIT 1`
);
check('the pair has a round window', Boolean(res), 'no resolution row');
if (!res) process.exit(1);
const twoRoundsOut = res.round_start_tic + res.round_length * 2 + 1;

const blocker = await one(
  'SELECT id FROM declared_moves WHERE character_id = ? AND move_id = ?',
  [a.id, guard.id]
);

// **Put the move back to unrevealed, deliberately.** By the time the round has
// been declared through, the engine has already resolved it and stamped
// `reveal_posted` — and the cascade rightly refuses to shift a move that has
// already happened. In a real fight the collision is raised mid-resolution,
// while the tail is still pending; this is the same state, reached directly
// rather than by racing the engine to it.
await run('UPDATE declared_moves SET reveal_posted = 0 WHERE id = ?', [target.id]);
await run(
  `UPDATE pair_round_resolutions SET status = 'paused_conflict', pending_conflict_json = ? WHERE id = ?`,
  [
    JSON.stringify({
      declaredMoveId: target.id,
      blockerDeclaredMoveId: blocker?.id ?? null,
      characterId: a.id,
      blockedUntil: twoRoundsOut,
      tic: res.round_start_tic,
    }),
    res.id,
  ]
);

// The real handler, on real rows.
gm.emit('combat:resolve_move_conflict', { declaredMoveId: target.id, choice: 'extend' });
await sleep(1500);

const after = await one('SELECT id, placement_tic FROM declared_moves WHERE id = ?', [target.id]);
check(
  'a move pushed more than one round out is taken off the board',
  !after,
  `it is still there at placement_tic ${after?.placement_tic} (round window ${res.round_start_tic}..${res.round_start_tic + res.round_length - 1}, pushed to ${twoRoundsOut})`
);

// A failing run should say what the cascade actually saw, rather than leaving
// the next person to reconstruct it.
if (after) {
  const row = await one(
    'SELECT id, placement_tic, reveal_posted, stamina_committed FROM declared_moves WHERE id = ?',
    [target.id]
  );
  const stillPaused = await one(
    "SELECT status, pending_conflict_json FROM pair_round_resolutions WHERE id = ?",
    [res.id]
  );
  console.log('   diagnosis:');
  console.log('     the pushed move  :', JSON.stringify(row));
  console.log('     resolution status:', stillPaused?.status, '(handler consumed the pause?)');
  console.log('     pending          :', stillPaused?.pending_conflict_json);
  console.log('     all of this pair  :', JSON.stringify(await all(
    'SELECT id, character_id, placement_tic, reveal_posted FROM declared_moves ORDER BY id'
  )));
}

const nowStamina = (await one('SELECT current_stamina FROM characters WHERE id = ?', [a.id]))?.current_stamina ?? 0;
const expected = Math.min(before + COST, ceiling);
check(
  `and its Stamina comes back (${before} -> ${expected}${expected < before + COST ? `, capped at the ${ceiling} ceiling` : ''})`,
  nowStamina === expected,
  `Stamina is ${nowStamina}`
);

gm.emit('combat:clear', {});
await sleep(400);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
gm.close();
process.exit(fails ? 1 : 0);

// Trip Recovery Frames — the timing math, pinned before anything is wired to
// it (this repo's own rule: the combat-timing math is the high-risk piece,
// built isolated and unit-tested first).
//
// Two rules carry the whole feature, and both are easy to get subtly wrong in
// a way no playtest would reliably show:
//
//   1. Where the trip window *is*. It is always the tail of a footprint, so it
//      is derived rather than stored — one number per declared move instead of
//      a range that could disagree with the footprint it belongs to.
//   2. How far an **Off The Ground** move may reach back into it. "Startup may
//      overlap trip frames, and only trip frames" is two separate caps, and
//      dropping either one turns the Tag into something much stronger than it
//      is meant to be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripWindow, placementFloorAfterTrip, planImposedRecovery } from '../combatTiming.js';
import { placementFloorAfterTrip as clientPlacementFloorAfterTrip } from '../../client/src/lib/framePhaseColors.js';

test('the trip window is the tail of the footprint', () => {
  // A move ending at 10 with 3 trip frames is on the ground for 7, 8, 9.
  assert.deepEqual(tripWindow({ activeEndTic: 5, recoveryEndTic: 10, tripRecoveryTics: 3 }), {
    from: 7,
    to: 10,
  });
});

test('no trip frames means no window at all', () => {
  assert.equal(tripWindow({ activeEndTic: 5, recoveryEndTic: 10, tripRecoveryTics: 0 }), null);
  assert.equal(tripWindow({ activeEndTic: 5, recoveryEndTic: 10 }), null);
  assert.equal(tripWindow({ activeEndTic: 5, recoveryEndTic: 10, tripRecoveryTics: -2 }), null);
});

test('a trip larger than the Recovery window never eats Active frames', () => {
  // 8 trip frames on a move whose Recovery is only 5 long: being knocked down
  // does not retroactively un-throw the punch that was already landing.
  assert.deepEqual(tripWindow({ activeEndTic: 5, recoveryEndTic: 10, tripRecoveryTics: 8 }), {
    from: 5,
    to: 10,
  });
});

test('a move with no Recovery left to give has no window', () => {
  assert.equal(tripWindow({ activeEndTic: 10, recoveryEndTic: 10, tripRecoveryTics: 3 }), null);
});

test('without the Tag, the placement floor is the ordinary one', () => {
  assert.equal(
    placementFloorAfterTrip({ blockedUntilTic: 10, tripRecoveryTics: 3, startupTics: 2, offTheGround: false }),
    10
  );
});

test('without trip frames, the Tag buys nothing', () => {
  // The Tag is not a general "start earlier" licence — ordinary Recovery is
  // still untouchable, which is the half of the rule most easily lost.
  assert.equal(
    placementFloorAfterTrip({ blockedUntilTic: 10, tripRecoveryTics: 0, startupTics: 4, offTheGround: true }),
    10
  );
});

test('Off The Ground overlaps trip frames with its Startup', () => {
  // 2 Startup against 3 trip frames: reaches back 2, so Active still begins at
  // 10, the Tic the trip window ends on.
  assert.equal(
    placementFloorAfterTrip({ blockedUntilTic: 10, tripRecoveryTics: 3, startupTics: 2, offTheGround: true }),
    8
  );
});

test('the overlap never reaches past the start of the trip window', () => {
  // 5 Startup against 3 trip frames overlaps 3, not 5. Reaching further would
  // put the wind-up inside ordinary Recovery, which the Tag does not permit.
  assert.equal(
    placementFloorAfterTrip({ blockedUntilTic: 10, tripRecoveryTics: 3, startupTics: 5, offTheGround: true }),
    7
  );
});

test('Active never begins before the trip window ends', () => {
  // The invariant behind both caps, stated directly: whatever the numbers, the
  // reveal Tic (Startup's end) lands at or after the old floor. You can get up
  // while winding up; you cannot punch from the floor.
  for (const startupTics of [0, 1, 2, 3, 4, 7, 12]) {
    for (const tripRecoveryTics of [1, 2, 3, 6]) {
      const floor = placementFloorAfterTrip({
        blockedUntilTic: 10,
        tripRecoveryTics,
        startupTics,
        offTheGround: true,
      });
      assert.ok(
        floor + startupTics >= 10,
        `startup ${startupTics}, trip ${tripRecoveryTics}: Active would begin at ${floor + startupTics}, before 10`
      );
      assert.ok(floor >= 10 - tripRecoveryTics, 'floor reached back past the trip window');
    }
  }
});

test('a character with no previous move is unaffected', () => {
  assert.equal(
    placementFloorAfterTrip({ blockedUntilTic: null, tripRecoveryTics: 3, startupTics: 2, offTheGround: true }),
    null
  );
});

// --- the client and the server floor a declaration the same way ------------

test('the placement floor the engine enforces IS the one the counter draws', () => {
  // **The bug this pins, found in a live playtest.** The rule lived twice: the
  // server relaxed the floor for an Off The Ground move, and `buildDeclarePayload`
  // in the Arena did not. Trip frames carried into a new round therefore drew as
  // unreachable squares on the Tic Counter while a drop on them was accepted
  // perfectly well — a display that disagreed with the engine about what was
  // legal. There is one implementation now, and this is what says so.
  assert.equal(
    placementFloorAfterTrip,
    clientPlacementFloorAfterTrip,
    'the server must re-export the client copy, not keep its own'
  );
});

test('trip frames spilling into a new round leave the first Tics reachable', () => {
  // The playtest case exactly: a Grounding move whose trip window runs two Tics
  // past the round boundary. An ordinary move is floored past them; an Off The
  // Ground move with Startup to spare may begin on the first of them.
  const roundStartTic = 7;
  const previousEnd = 9; // two trip Tics inside the new round
  const ordinary = Math.max(
    roundStartTic,
    placementFloorAfterTrip({ blockedUntilTic: previousEnd, tripRecoveryTics: 3, startupTics: 2, offTheGround: false })
  );
  assert.equal(ordinary, 9, 'an ordinary move still waits out the whole window');

  const riser = Math.max(
    roundStartTic,
    placementFloorAfterTrip({ blockedUntilTic: previousEnd, tripRecoveryTics: 3, startupTics: 2, offTheGround: true })
  );
  assert.equal(riser, 7, 'Off The Ground reaches back into them, clamped at the round start');
  assert.ok(riser < ordinary, 'which is the whole point, and what the counter must draw');
});

// ---------- Recovery imposed on a fighter who is already down ----------
//
// The bug, reported from the table: *"when a move adds regular recovery to an
// opponent who had Trip Recovery, all recovery became regular recovery,
// forbidding the Off The Ground moves"* — plus the second half, that an Off The
// Ground move could still be declared and was then visually pushed later.
//
// One root cause behind both. Trip frames are the LAST `tripRecoveryTics` of a
// footprint, so ordinary Tics appended to the end pushed the trip window along
// in front of them: the frames the fighter was lying on became ordinary
// Recovery, and the move declared to overlap them was left overlapping ordinary
// Recovery — which is what displaced it.

// A Grounding move: 1 Startup, 1 Active, 3 Recovery, all three of them trip.
// Placed at 0, so Active ends at 2, Recovery ends at 5, trip window [2,5).
const grounded = (ext = 0) => ({
  id: 1,
  placementTic: 0,
  revealTic: 1,
  activeTics: 1,
  recoveryTics: 3,
  recoveryExtensionTics: ext,
  tripRecoveryTics: 3,
});

const windowOf = (update, move) => {
  const activeEndTic = update.revealTic + move.activeTics;
  const recoveryEndTic = activeEndTic + move.recoveryTics + update.recoveryExtensionTics;
  return tripWindow({ activeEndTic, recoveryEndTic, tripRecoveryTics: update.tripRecoveryTics });
};

test('ordinary Recovery imposed on a downed fighter does not un-ground the frames they are lying on', () => {
  const move = grounded();
  // Caught at Tic 3 — mid trip window, on the floor — with 2 ordinary Recovery.
  const plan = planImposedRecovery({ moves: [move], tic: 3, tics: 2, trip: false });
  assert.equal(plan.phase, 'in-flight');
  const update = plan.updates.find((u) => u.id === 1);
  assert.equal(update.recoveryExtensionTics, 2, 'the frames still arrive, and still on the end');
  assert.equal(update.tripRecoveryTics, 5, 'and they are frames spent on the floor, because that is where they are');

  // The whole Recovery run is still trip, which is what the table was watching.
  const after = windowOf(update, move);
  assert.deepEqual(after, { from: 2, to: 7 });
  const before = tripWindow({ activeEndTic: 2, recoveryEndTic: 5, tripRecoveryTics: 3 });
  assert.equal(after.from, before.from, 'the window may only GROW — its start must not move');
});

test('...which is what keeps an Off The Ground move legal on the frames it was declared onto', () => {
  // A riser with 2 Startup declared to begin at Tic 3, overlapping the last two
  // trip frames. Before the fix, the imposition slid the window to [4,7) and
  // that placement was suddenly on ordinary Recovery.
  const move = grounded();
  const update = planImposedRecovery({ moves: [move], tic: 3, tics: 2, trip: false }).updates.find(
    (u) => u.id === 1
  );
  const window = windowOf(update, move);
  const blockedUntil = window.to;
  const floor = placementFloorAfterTrip({
    blockedUntilTic: blockedUntil,
    tripRecoveryTics: update.tripRecoveryTics,
    startupTics: 2,
    offTheGround: true,
  });
  assert.equal(floor, 5, 'the riser still reaches back into trip frames — it is simply two Tics later');
  assert.ok(floor >= window.from, 'and never past where the window begins, which is the Tag\'s own cap');
  // **The assertion that actually separates fixed from broken.** The riser was
  // declared onto Tic 3. Before the fix the window slid to [4,7) and Tic 3
  // became ordinary Recovery under it; now it is still on the floor there.
  assert.ok(window.from <= 3, `Tic 3 must still be a trip frame, window was ${JSON.stringify(window)}`);
});

test('a trip imposed on somebody already down still just adds to the pile', () => {
  // Unchanged behaviour, and the reason the new condition is `trip || already
  // down` rather than a replacement for `trip`.
  const update = planImposedRecovery({ moves: [grounded()], tic: 3, tics: 2, trip: true }).updates.find(
    (u) => u.id === 1
  );
  assert.equal(update.tripRecoveryTics, 5);
  assert.equal(update.recoveryExtensionTics, 2);
});

test('ordinary Recovery on somebody NOT down stays ordinary', () => {
  // The control. Nothing about an upright fighter changed: no trip frames in,
  // none out, however much Recovery is imposed.
  const upright = { id: 1, placementTic: 0, revealTic: 1, activeTics: 1, recoveryTics: 3, recoveryExtensionTics: 0, tripRecoveryTics: 0 };
  const update = planImposedRecovery({ moves: [upright], tic: 3, tics: 2, trip: false }).updates.find(
    (u) => u.id === 1
  );
  assert.equal(update.tripRecoveryTics, 0);
  assert.equal(update.recoveryExtensionTics, 2);
});

test('a fighter caught in STARTUP is not grounded by it, trip frames pending or not', () => {
  // Startup Tics are not Recovery, so there is nothing to be on the floor for —
  // the move is delayed and its own trip frames ride along untouched.
  const update = planImposedRecovery({ moves: [grounded()], tic: 0, tics: 2, trip: false }).updates.find(
    (u) => u.id === 1
  );
  assert.equal(update.revealTic, 3, 'delayed');
  assert.equal(update.recoveryExtensionTics, 0);
  assert.equal(update.tripRecoveryTics, 3, 'unchanged');
});

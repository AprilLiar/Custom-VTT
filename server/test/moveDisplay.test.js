// Move-card display labels (client/src/lib/moveDisplay.js).
//
// The bug behind this file: `automationLabel` had no case for either stat-step
// type, so its `default` branch printed the raw payload — a move card that read
// literally `opponent_stat_step 1` where it should have named the Stat. That is
// what "the Step Stat trigger shows a string instead of a proper name" meant,
// and the reason a Stat is involved at all is that these are the only
// automations that carry one.
//
// Every authored type is pinned here rather than only the two that broke: the
// failure mode is a *missing case*, so the test that catches the next one is a
// test that walks the option list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_OPTIONS,
  AUTOMATION_STAT_SLOTS,
  STAT_STEP_AUTOMATION_TYPES,
  automationLabel,
} from '../../client/src/lib/moveDisplay.js';
import { AUTOMATION_TYPES, AUTOMATION_STAT_SLOTS as SERVER_SLOTS } from '../moveLogic.js';

test('every authored automation type has a real label', () => {
  for (const { type } of AUTOMATION_OPTIONS) {
    const label = automationLabel({ type, amount: 1, slot: 'Skull' });
    // The tell for the bug: the fallback prints the type name verbatim.
    assert.ok(!label.includes(type), `${type} fell through to the raw fallback: ${label}`);
    assert.ok(label.length > 0, `${type} rendered nothing`);
  }
});

test('the stat-step labels name the Stat, which is the whole point', () => {
  assert.equal(automationLabel({ type: 'opponent_stat_step', amount: 1, slot: 'Brain' }), '1 step down Brain → opponent');
  assert.equal(automationLabel({ type: 'self_stat_step', amount: 2, slot: 'Body' }), '2 steps down Body (self)');
  // A step is signed: a negative amount restores rather than damaging, and the
  // label says "up" instead of printing a minus and leaving the reader to work
  // out that negative damage is healing.
  assert.equal(automationLabel({ type: 'self_stat_step', amount: -1, slot: 'Skull' }), '1 step up Skull (self)');
  assert.equal(automationLabel({ type: 'opponent_stat_step', amount: -2, slot: 'Skull' }), '2 steps up Skull → opponent');
  // The new option is the same mechanic with its direction in its name.
  assert.equal(automationLabel({ type: 'self_stat_increase', amount: 1, slot: 'Left Hand' }), '1 step up Left Hand (self)');
});

test('a stat-step label still renders without a Stat picked yet', () => {
  // Half-authored: the type is chosen, the Stat is not. The card must still
  // say something rather than printing "undefined".
  const label = automationLabel({ type: 'self_stat_step', amount: 1 });
  assert.equal(label, '1 step down (self)');
  assert.ok(!label.includes('undefined'));
});

test('the next-roll penalty says whose roll and by how much', () => {
  assert.equal(
    automationLabel({ type: 'opponent_next_roll_penalty', amount: 3 }),
    "−3 on the opponent's next roll"
  );
});

test('the client option list and the server whitelist agree', () => {
  // A type the Move Creator offers but the server drops on save is a control
  // that silently does nothing.
  for (const { type } of AUTOMATION_OPTIONS) {
    assert.ok(AUTOMATION_TYPES.includes(type), `${type} is offered but not accepted server-side`);
  }
  for (const type of STAT_STEP_AUTOMATION_TYPES) {
    assert.ok(AUTOMATION_TYPES.includes(type), `${type} shows a Stat picker but is not a real type`);
  }
  assert.deepEqual([...AUTOMATION_STAT_SLOTS], [...SERVER_SLOTS]);
});

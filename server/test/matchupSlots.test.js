// Which Stats the Stance matchup reaches (decided, new).
//
// The matchup scores what two fighters' STYLES do to each other — it is a fact
// about an exchange of blows. Two of the eight Stats are not part of that
// exchange: **Brain** is thinking, and **Stamina** is your engine. Neither
// cares what stance anybody took.
//
// The asymmetry below is the whole design, and it is what this file exists to
// pin: a roll made ENTIRELY of exempt Stats is exempt, and any other roll is
// not. The other reading — "exempt if it touches Brain" — would turn the rule
// into a loophole worth building moves around.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCHUP_EXEMPT_SLOTS, matchupAppliesToSlots } from '../combatBonuses.js';
import { DICE_TEMPLATE } from '../gameLogic.js';

test('the exempt Stats are real Stats', () => {
  const slots = DICE_TEMPLATE.map((d) => d.slot_name);
  for (const exempt of MATCHUP_EXEMPT_SLOTS) {
    assert.ok(slots.includes(exempt), `${exempt} is not a Stat this game has`);
  }
});

test('a roll made only of exempt Stats gets no matchup', () => {
  assert.equal(matchupAppliesToSlots(['Brain']), false);
  assert.equal(matchupAppliesToSlots(['Stamina']), false);
  assert.equal(matchupAppliesToSlots(['Brain', 'Stamina']), false);
  // Both sides of an Initiative roll are this case.
  assert.equal(matchupAppliesToSlots(['Brain', 'Brain']), false);
});

test('a roll that touches anything else keeps the matchup', () => {
  assert.equal(matchupAppliesToSlots(['Skull']), true);
  assert.equal(matchupAppliesToSlots(['Body', 'Left Hand']), true);
  // The loophole that is deliberately closed: a punch does not stop being a
  // punch because its Roll also lists Brain.
  assert.equal(matchupAppliesToSlots(['Skull', 'Brain']), true);
  assert.equal(matchupAppliesToSlots(['Stamina', 'Right Leg']), true);
});

test('a roll with no Stats named keeps the matchup, unchanged', () => {
  // A Custom Roll (a weapon's own die), or any hand-thrown path that has no
  // slot list to give. Every one of those behaved this way before the rule
  // existed and must keep behaving that way.
  assert.equal(matchupAppliesToSlots([]), true);
  assert.equal(matchupAppliesToSlots(null), true);
  assert.equal(matchupAppliesToSlots(undefined), true);
  assert.equal(matchupAppliesToSlots(['Custom']), true);
  // Nulls in the list are ignored rather than counting as a non-exempt Stat.
  assert.equal(matchupAppliesToSlots([null, 'Brain']), false);
});

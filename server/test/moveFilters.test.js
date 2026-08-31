// client/src/lib/moveFilterRules.js — the shared move filter's pure half.
//
// Lives in server/test because that is where `npm test` looks, and imports the
// `.js` rather than the `.jsx` beside it because `node --test` cannot load JSX.
// That split is the reason the rules were pulled out of the component file:
// `useMoveFilters` needs a renderer, but the question worth pinning is what
// counts as a match, and that is plain functions.
//
// The rule the whole control rests on, and the one three copies of it used to
// disagree about: **OR'd within a filter, AND'd between them.**
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveAttackTargets,
  moveRollSlots,
  moveTagIds,
  moveTellIds,
  slotItems,
} from '../../client/src/lib/moveFilterRules.js';
import { ROLL_SLOT_NAMES } from '../../client/src/lib/diceSlots.js';
import { ROLL_SLOT_NAMES as SERVER_ROLL_SLOT_NAMES } from '../moveLogic.js';

test('the client and server agree about the seven slots', () => {
  // Attack Target and Attack Roll are filtered on the client against a
  // vocabulary the server owns. Two lists that drift apart give a filter that
  // silently matches nothing for whichever name was added to only one of them.
  assert.deepEqual(ROLL_SLOT_NAMES, SERVER_ROLL_SLOT_NAMES);
});

test('a move is findable by either half of an ambiguous Tell pair', () => {
  assert.deepEqual(moveTellIds({ tell_id: 1, left_tell_id: 2, right_tell_id: 3 }), [1, 2, 3]);
  assert.deepEqual(moveTellIds({ tell_id: 1, left_tell_id: null, right_tell_id: null }), [1]);
  assert.deepEqual(moveTellIds({}), []);
});

test('a Perk-modified move is filtered by what its card actually shows', () => {
  // `effective_*` first, everywhere. A Perk can add a Tag, change what a move
  // targets or what it rolls for one character; the filter has to agree with
  // the card in front of that fighter, not with the library row behind it.
  assert.deepEqual(moveTagIds({ tag_ids: [1], effective_tag_ids: [1, 2] }), [1, 2]);
  assert.deepEqual(moveTagIds({ tag_ids: [1] }), [1]);
  assert.deepEqual(moveTagIds({}), []);

  assert.deepEqual(
    moveAttackTargets({ attack_targets: ['Skull'], effective_attack_targets: ['Skull', 'Body'] }),
    ['Skull', 'Body']
  );
  assert.deepEqual(moveAttackTargets({ attack_targets: ['Body'] }), ['Body']);
  assert.deepEqual(moveAttackTargets({}), []);

  assert.deepEqual(moveRollSlots({ roll_slots: ['Hand'], effective_roll_slots: ['Leg'] }), ['Leg']);
  assert.deepEqual(moveRollSlots({ roll_slots: ['Hand', 'Hand'] }), ['Hand', 'Hand']);
  assert.deepEqual(moveRollSlots({}), []);
});

test('the chips are what is actually in the pile, in the vocabulary\'s own order', () => {
  // Offering a filter that can only ever return nothing is a worse answer than
  // not offering it — the same rule the Tell and Tag rows already follow.
  const items = slotItems(new Set(['Weapon', 'Skull', 'Hand']));
  assert.deepEqual(items.map((i) => i.id), ['Skull', 'Hand', 'Weapon'], 'canonical order, not insertion order');
  // The label is the readable one, not the storage name: an ambiguous slot
  // means either side, and the chip has to say so.
  assert.equal(items.find((i) => i.id === 'Hand').name, 'Left/Right Hand');
  assert.equal(items.find((i) => i.id === 'Skull').name, 'Skull');
  assert.deepEqual(slotItems(new Set()), []);
  // A name nobody knows is dropped rather than rendered as a dead chip.
  assert.deepEqual(slotItems(new Set(['Elbow'])), []);
});

// The matching rule itself, exercised through the same predicate the hook
// builds. Written out here rather than mounting React: it is four lines of
// set logic and the thing that has to stay true is the AND/OR shape.
const matcher = ({ tells = new Set(), tags = new Set(), targets = new Set(), rolls = new Set() }) =>
  (move) => {
    if (tells.size > 0 && !moveTellIds(move).some((id) => tells.has(id))) return false;
    if (tags.size > 0 && !moveTagIds(move).some((id) => tags.has(id))) return false;
    if (targets.size > 0 && !moveAttackTargets(move).some((n) => targets.has(n))) return false;
    if (rolls.size > 0 && !moveRollSlots(move).some((n) => rolls.has(n))) return false;
    return true;
  };

test('picks are OR\'d within a filter and AND\'d between them', () => {
  const jab = { tell_id: 1, tag_ids: [10], attack_targets: ['Skull'], roll_slots: ['Hand'] };
  const kick = { tell_id: 2, tag_ids: [10], attack_targets: ['Body'], roll_slots: ['Leg'] };

  // Empty is not applied at all.
  assert.equal(matcher({})(jab), true);
  // OR within: either target matches.
  assert.equal(matcher({ targets: new Set(['Skull', 'Body']) })(jab), true);
  assert.equal(matcher({ targets: new Set(['Skull', 'Body']) })(kick), true);
  // AND between: the Tag matches both, the Roll only one.
  const both = matcher({ tags: new Set([10]), rolls: new Set(['Hand']) });
  assert.equal(both(jab), true);
  assert.equal(both(kick), false);
  // A filter with nothing in common with the move excludes it.
  assert.equal(matcher({ targets: new Set(['Weapon']) })(jab), false);
});

test('a move with no targets or no Roll is excluded by those filters, not exempt', () => {
  // A pure defence names no Attack Target and a narrative move may roll
  // nothing. Asking "which of these goes for the head" should not hand back
  // everything that goes for nothing at all.
  const defence = { tell_id: 1, tag_ids: [], attack_targets: [], roll_slots: [] };
  assert.equal(matcher({ targets: new Set(['Skull']) })(defence), false);
  assert.equal(matcher({ rolls: new Set(['Hand']) })(defence), false);
  // But it is still there when neither filter is on.
  assert.equal(matcher({})(defence), true);
});

test('an ambiguous slot taken twice is still one match', () => {
  // A Straight Block guards with both hands and stores `['Hand', 'Hand']`.
  // The filter is a membership test, so it matches once rather than counting.
  const block = { roll_slots: ['Hand', 'Hand'], attack_targets: [] };
  assert.equal(matcher({ rolls: new Set(['Hand']) })(block), true);
  assert.equal(matcher({ rolls: new Set(['Leg']) })(block), false);
});

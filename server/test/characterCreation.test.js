// The Character Creation rules (server/characterCreation.js).
//
// **The preset's numbers are a suggestion, not a rule (decided, revised).** The
// flow exists to guide a build, not to police one: overspending Stat points or
// Perks is a WARNING — said plainly and then allowed — and every step, the
// preset included, can be skipped outright.
//
// What stays an error is the short list of things that would leave the
// character actually broken: a stance with one Style, or two of the same, which
// is not a stance at all. Each of those sits next to a Skip button.
//
// The module is still pure and still shared by the dialog and the server, so
// the wording a player is shown and the wording the server would use cannot
// drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATION_SLOTS,
  PRESETS,
  presetByKey,
  rankOfDie,
  statPointsSpent,
  validateCreation,
} from '../characterCreation.js';
import { DICE_TEMPLATE, dieAtRank, rankOf } from '../gameLogic.js';

const ok = (over = {}) => validateCreation({ presetKey: 'adult', ...over });

test('the three presets carry the table\'s numbers', () => {
  assert.deepEqual(
    PRESETS.map((p) => [p.key, p.statPoints, p.perkCount, p.moveCount]),
    [
      ['teenager', 8, 2, 4],
      ['adult', 16, 3, 8],
      ['old_master', 24, 5, 16],
    ]
  );
  for (const preset of PRESETS) {
    assert.ok(preset.name && preset.blurb, `${preset.key} needs a name and a blurb to be pickable`);
  }
  assert.equal(presetByKey('nope'), null);
});

test('creation covers every Stat the sheet has, in sheet order', () => {
  assert.deepEqual(CREATION_SLOTS, DICE_TEMPLATE.map((d) => d.slot_name));
  assert.equal(CREATION_SLOTS.length, 8);
});

test('a point is a step, and a Stat costs exactly its rank', () => {
  // The unit is the one the whole game already counts in — the same rank an
  // Injury penalty is expressed in and damage moves a die by. d4 is free.
  assert.equal(statPointsSpent({}), 0);
  assert.equal(statPointsSpent({ Skull: 1 }), 1);
  // d4 -> d12 is four steps.
  assert.equal(rankOf(dieAtRank(4).size, dieAtRank(4).bonus), 4);
  assert.equal(statPointsSpent({ Skull: 4 }), 4);
  // Past d12 a point buys +1, still one point per step.
  assert.deepEqual(dieAtRank(5), { size: 12, bonus: 1 });
  assert.equal(statPointsSpent({ Skull: 5, Body: 3 }), 8);
});

test('a spread inside the budget passes and reports what is left', () => {
  const v = ok({ statRanks: { Skull: 4, Body: 4, Brain: 2 } });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.equal(v.normalized.pointsSpent, 10);
  assert.equal(v.normalized.pointsLeft, 6);
  // Unspent points are legal — a weaker character, not an invalid one.
});

test('overspending WARNS on every preset, and still goes through', () => {
  for (const [key, budget] of [['teenager', 8], ['adult', 16], ['old_master', 24]]) {
    const over = validateCreation({ presetKey: key, statRanks: { Skull: budget + 1 } });
    // Allowed — the number is guidance, and a table that wants a heavier
    // fighter is not doing anything the app should refuse.
    assert.equal(over.ok, true, `${key} should allow going over`);
    assert.deepEqual(over.errors, []);
    assert.equal(over.warnings.length, 1);
    assert.match(over.warnings[0], /suggests/);
  }
  // Exactly on budget, and under it, say nothing at all.
  assert.deepEqual(validateCreation({ presetKey: 'teenager', statRanks: { Skull: 8 } }).warnings, []);
  assert.deepEqual(validateCreation({ presetKey: 'teenager', statRanks: { Skull: 2 } }).warnings, []);
});

test('skipping the preset is legal, and means no budget at all', () => {
  const v = validateCreation({ statRanks: { Skull: 99 }, perkIds: [1, 2, 3, 4, 5, 6, 7, 8] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  // Nothing to overspend, so nothing to warn about.
  assert.deepEqual(v.warnings, []);
  assert.equal(v.normalized.preset, null);
  // Null, not 0 — "how many are left" has no answer here, and 0 would read as
  // "you are out".
  assert.equal(v.normalized.pointsLeft, null);
  assert.equal(v.normalized.perksLeft, null);
  assert.equal(v.normalized.ranks.Skull, 99);
});

test('a negative rank is floored at a bare d4, not treated as damage', () => {
  // Nobody starts play with an incapacitated Stat, and a negative rank is not
  // something the budget should ever be able to refund.
  const v = ok({ statRanks: { Skull: -5, Body: 2 } });
  assert.equal(v.normalized.ranks.Skull, 0);
  assert.equal(v.normalized.pointsSpent, 2);
});

test('the Perk count is a CAP — exactly on it passes, one over blocks', () => {
  // Changed on the table's call: this used to warn and allow. Reducing the
  // numbers without enforcing them would have changed nothing at all.
  assert.equal(ok({ perkIds: [1, 2, 3] }).ok, true, 'an Adult may take three');
  const over = ok({ perkIds: [1, 2, 3, 4] });
  assert.equal(over.ok, false);
  assert.deepEqual(over.warnings, [], 'over a cap is an error, not advice');
  assert.match(over.errors[0], /allows 3 Perks/);
  assert.equal(ok({ perkIds: [1] }).normalized.perksLeft, 2);
  assert.deepEqual(ok({ perkIds: [1] }).warnings, []);
  // Picking the same Perk twice is one Perk, not two against the cap — the
  // dedupe has to happen before the count or a double-click blocks the build.
  assert.deepEqual(ok({ perkIds: [1, 1, 1] }).normalized.perkIds, [1]);
  assert.equal(ok({ perkIds: [1, 1, 2, 2, 3, 3] }).ok, true);
  // No preset means no cap: a free-form build has nothing to exceed.
  assert.equal(validateCreation({ perkIds: [1, 2, 3, 4, 5, 6, 7, 8] }).ok, true);
});

test('unknown Move and Perk ids are dropped, not rejected', () => {
  // Same convention as writeMove: silently drop what does not exist rather
  // than failing a whole save over a stale id.
  const v = ok({ moveIds: [1, 2, 99], perkIds: [3, 77], validMoveIds: [1, 2], validPerkIds: [3] });
  assert.deepEqual(v.normalized.moveIds, [1, 2]);
  assert.deepEqual(v.normalized.perkIds, [3]);
  assert.equal(v.ok, true);
});

test('the Move count is a cap too, and dedupes before counting', () => {
  assert.equal(ok({ moveIds: [1, 2, 3, 4, 5, 6, 7, 8] }).ok, true, 'an Adult may take eight');
  const over = ok({ moveIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(over.ok, false);
  assert.match(over.errors[0], /allows 8 Moves/);
  assert.equal(ok({ moveIds: [1, 2] }).normalized.movesLeft, 6);
  // Ten ids, five distinct Moves — under the cap.
  assert.equal(ok({ moveIds: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5] }).ok, true);
  // A cap only exists when a preset does.
  const free = validateCreation({ moveIds: Array.from({ length: 50 }, (_, i) => i + 1) });
  assert.equal(free.ok, true);
  assert.equal(free.normalized.moveIds.length, 50);
  assert.equal(free.normalized.movesLeft, null);
});

test('a Move whose Style the character will not have is refused, not dropped', () => {
  // **The bug this pins.** The wizard greyed these rows and let you tick them
  // anyway; the server then accepted the build and silently skipped the Move,
  // which looked exactly like it had worked. Now it is an error, named.
  const moveStyles = { 1: 10, 2: 20, 3: null };
  const moveNames = { 1: 'Iron Palm', 2: 'Ghost Step', 3: 'Shove' };
  const withStyles = (over) => validateCreation({ presetKey: 'adult', moveStyles, moveNames, ...over });

  const bad = withStyles({ moveIds: [1], ownedStyleIds: [20] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /Iron Palm/, 'the Move is named, not just counted');

  // The Style it needs, and a Move with no Style at all, both pass.
  assert.equal(withStyles({ moveIds: [1], ownedStyleIds: [10] }).ok, true);
  assert.equal(withStyles({ moveIds: [3], ownedStyleIds: [] }).ok, true);
  // Several blocked Moves are one error listing all of them, not a wall.
  const many = withStyles({ moveIds: [1, 2], ownedStyleIds: [] });
  assert.equal(many.errors.length, 1);
  assert.match(many.errors[0], /Iron Palm.*Ghost Step/);

  // **A caller that cannot say gets no check**, rather than a guess. The
  // wizard's early renders and any other caller keep working unchanged.
  assert.equal(validateCreation({ presetKey: 'adult', moveIds: [1] }).ok, true);
  assert.equal(validateCreation({ presetKey: 'adult', moveIds: [1], moveStyles }).ok, true);
  assert.equal(validateCreation({ presetKey: 'adult', moveIds: [1], ownedStyleIds: [] }).ok, true);
});

test('a stance is optional, but a half-filled one is an error', () => {
  // Skipping it entirely is legal — the Stances tab can finish the job.
  assert.equal(ok({ stance: null }).ok, true);
  assert.equal(ok({ stance: {} }).ok, true);
  assert.equal(ok({ stance: null }).normalized.stance, null);

  // Started and left incomplete is not.
  assert.equal(ok({ stance: { name: 'Coiled' } }).ok, false);
  assert.equal(ok({ stance: { attributeAId: 1, attributeBId: 2 } }).ok, false);
  // Two of the same Style is not a stance.
  const same = ok({ stance: { name: 'Coiled', attributeAId: 1, attributeBId: 1 } });
  assert.equal(same.ok, false);
  assert.match(same.errors[0], /two different Styles/i);
  // A Style that does not exist.
  assert.equal(ok({ stance: { name: 'Coiled', attributeAId: 1, attributeBId: 9 }, validAttributeIds: [1, 2] }).ok, false);

  const good = ok({ stance: { name: '  Coiled  ', attributeAId: 1, attributeBId: 2 }, validAttributeIds: [1, 2] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.normalized.stance, { name: 'Coiled', attributeAId: 1, attributeBId: 2 });
});

test('role-play is optional and blank answers leave no trace', () => {
  const v = ok({ roleplay: { 'What is their favorite food?': '  ', '  ': 'orphaned', 'Fear?': ' spiders ' } });
  assert.equal(v.ok, true);
  assert.deepEqual(v.normalized.roleplay, [{ question: 'Fear?', answer: 'spiders' }]);
});

test('rankOfDie reads a part-built character back at the rank they bought', () => {
  // So re-opening the wizard shows the spread that exists rather than starting
  // over — and the number it shows is the number it would charge.
  assert.equal(rankOfDie({ current_size: 4, bonus: 0, status: 'active' }), 0);
  assert.equal(rankOfDie({ current_size: 12, bonus: 2, status: 'active' }), 6);
  // A damaged Stat reads as its current rank, not its baseline.
  assert.equal(rankOfDie({ current_size: 6, bonus: 0, status: 'active' }), 1);
  // Incapacitated has no rank to charge for.
  assert.equal(rankOfDie({ current_size: 4, bonus: 0, status: 'incapacitated' }), 0);
  assert.equal(rankOfDie(null), 0);
});

test('Stat points still only warn, while the two counts block', () => {
  // The split the table asked for: a spread is a shape and stays advice; the
  // Perk and Move counts are limits.
  const v = validateCreation({
    presetKey: 'teenager',
    statRanks: { Skull: 20 },              // over — a warning
    perkIds: [1, 2, 3, 4],                 // over — an error
    stance: { name: 'X', attributeAId: 1, attributeBId: 1 }, // broken — an error
  });
  assert.equal(v.warnings.length, 1, JSON.stringify(v.warnings));
  assert.match(v.warnings[0], /Stat points/);
  assert.equal(v.errors.length, 2, JSON.stringify(v.errors));
  assert.equal(v.ok, false);

  // A wildly overspent SPREAD, on its own, is still a legal build.
  const spendy = validateCreation({ presetKey: 'teenager', statRanks: { Skull: 20 } });
  assert.equal(spendy.ok, true);
  assert.equal(spendy.warnings.length, 1);
  assert.deepEqual(spendy.errors, []);
});

test('every skippable step really is skippable, all at once', () => {
  // The emptiest possible build: no preset, no Stats, no stance, no Moves, no
  // Perks, no answers. It has to be legal — Finish is live from the first
  // screen, and a character can be finished later on the tabs.
  const v = validateCreation({});
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  assert.equal(v.normalized.stance, null);
  assert.deepEqual(v.normalized.moveIds, []);
  assert.deepEqual(v.normalized.perkIds, []);
  assert.deepEqual(v.normalized.roleplay, []);
  // Every Stat stays where it started.
  assert.equal(v.normalized.pointsSpent, 0);
});

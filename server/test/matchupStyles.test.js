// Combat Style (decided, new): a move's own style joins its user's active
// stance when the Stance matchup is scored for that move's roll, and
// duplicates are kept so a style already in the stance counts twice.
//
// The scoring itself is `pairScore`, which was already arbitrary-length —
// these lock in that it stays that way, since collapsing either side to a
// Set would silently delete the whole doubling mechanic without failing any
// pre-existing test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBeats, matchupStyles, pairScore } from '../../client/src/lib/matchups.js';

// A minimal counter chart: Strength beats Technique by 3, Speed beats
// Strength by 3. Same shape as attribute_counters rows.
const STR = 1;
const TEC = 2;
const SPD = 3;
const WIL = 4;
const beats = buildBeats([
  { attacker_attribute_id: STR, defender_attribute_id: TEC, bonus: 3 },
  { attacker_attribute_id: SPD, defender_attribute_id: STR, bonus: 3 },
]);

test('matchupStyles is the bare stance when the move has no Combat Style', () => {
  assert.deepEqual(matchupStyles([STR, TEC], null), [STR, TEC]);
  assert.deepEqual(matchupStyles([STR, TEC]), [STR, TEC]);
});

test('matchupStyles appends the move\'s Combat Style', () => {
  assert.deepEqual(matchupStyles([STR, TEC], SPD), [STR, TEC, SPD]);
});

test('matchupStyles keeps a duplicate rather than collapsing it', () => {
  // The user's own example: a Strength/Technique fighter throwing a Strength
  // move. Strength must appear twice or the doubling never happens.
  assert.deepEqual(matchupStyles([STR, TEC], STR), [STR, TEC, STR]);
});

test('a duplicated style doubles that style\'s contribution', () => {
  const enemy = [TEC, WIL];
  const plain = pairScore(matchupStyles([STR, TEC]), enemy, beats);
  const doubled = pairScore(matchupStyles([STR, TEC], STR), enemy, beats);
  // Strength beats Technique (+3). Counting Strength twice scores it twice.
  assert.equal(plain, 3);
  assert.equal(doubled, 6);
});

test('a duplicated style doubles a BAD matchup just as hard', () => {
  // "making the move better or worse, depending on the opponent stance" —
  // the same Strength move into a Speed stance is now twice as punished.
  const enemy = [SPD, WIL];
  const plain = pairScore(matchupStyles([STR, TEC]), enemy, beats);
  const doubled = pairScore(matchupStyles([STR, TEC], STR), enemy, beats);
  assert.equal(plain, -3);
  assert.equal(doubled, -6);
});

test('both sides may bring a Combat Style — three against three', () => {
  const mine = matchupStyles([STR, TEC], STR);
  const theirs = matchupStyles([SPD, WIL], SPD);
  // Strength vs Speed twice on each side: 2 of mine x 2 of theirs = 4
  // Strength-vs-Speed pairs, each -3 to me.
  assert.equal(pairScore(mine, theirs, beats), -12);
});

test('a Combat Style the opponent has no answer to is worth nothing extra', () => {
  // Will neither beats nor is beaten by anything in this chart.
  const enemy = [SPD, WIL];
  assert.equal(
    pairScore(matchupStyles([STR, TEC], WIL), enemy, beats),
    pairScore(matchupStyles([STR, TEC]), enemy, beats)
  );
});

test('scoring stays antisymmetric with Combat Styles on both sides', () => {
  // The VS divider shows one side's number and negates it for the other
  // (see getPairStanceMatchup) — that shortcut is only valid while this
  // holds.
  const mine = matchupStyles([STR, TEC], STR);
  const theirs = matchupStyles([SPD, WIL], SPD);
  assert.equal(pairScore(mine, theirs, beats), -pairScore(theirs, mine, beats));
});

test('a Combat Style the opponent also has adds nothing — it cancels', () => {
  // Same-style pairs contribute 0 in both directions, so doubling Strength
  // against a stance that already holds Strength buys exactly nothing. The
  // rest of the score (their Strength beating my Technique) is unchanged,
  // which is the point: the duplicate is inert, not a self-counter.
  const enemy = [STR, WIL];
  assert.equal(
    pairScore(matchupStyles([STR, TEC], STR), enemy, beats),
    pairScore(matchupStyles([STR, TEC]), enemy, beats)
  );
  assert.equal(pairScore(matchupStyles([STR, TEC], STR), enemy, beats), -3);
});

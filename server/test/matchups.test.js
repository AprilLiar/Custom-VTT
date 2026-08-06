import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, DEFEATS, COUNTER_BONUS } from '../ruleset.js';
import {
  buildBeats,
  pairScore,
  rankMatchups,
} from '../../client/src/lib/matchups.js';

// Build the same shape the API serves, with ids 1..7 in seed order
const attributes = STYLES.map((s, i) => ({ id: i + 1, name: s.name }));
const idOf = (name) => attributes.find((a) => a.name === name).id;
const counters = Object.entries(DEFEATS).flatMap(([winner, losers]) =>
  losers.map((loser) => ({
    attacker_attribute_id: idOf(winner),
    defender_attribute_id: idOf(loser),
    bonus: COUNTER_BONUS,
  }))
);
const beats = buildBeats(counters);
const pair = (a, b) => [idOf(a), idOf(b)];

// These are hand-computed in *edges* — how many of the 4 cross-pairs I win
// minus how many I lose — and only then multiplied by COUNTER_BONUS. The
// edge counts are a property of DEFEATS and never change; the bonus is a
// tuning knob (it has already been halved once). Writing the products out as
// literals is what made this file break when it was, so don't.
test('hand-computed score: {Speed,Power} vs {Improvisation,Technique} = +2 edges', () => {
  // Speed>Improv +1, Technique>Speed -1, Power>Improv +1, Power>Technique +1
  assert.equal(
    pairScore(pair('Speed', 'Power'), pair('Improvisation', 'Technique'), beats),
    2 * COUNTER_BONUS
  );
});

test('hand-computed score: {Speed,Power} vs {Technique,Close-Quarters} = -2 edges', () => {
  // Speed vs Technique -1; Speed vs CQ -1; Power vs Technique +1; Power vs CQ -1
  assert.equal(
    pairScore(pair('Speed', 'Power'), pair('Technique', 'Close-Quarters'), beats),
    -2 * COUNTER_BONUS
  );
});

test('sharing a style contributes zero for that sub-pair', () => {
  // {Speed,Power} vs {Speed,Improvisation}: Speed-Speed 0, Speed>Improv +1,
  // Speed>Power (their Speed beats my Power) -1, Power>Improv +1 => +1 edge
  assert.equal(
    pairScore(pair('Speed', 'Power'), pair('Speed', 'Improvisation'), beats),
    COUNTER_BONUS
  );
});

test('matchup scores are antisymmetric', () => {
  const mine = pair('Defensive', 'Keep-out');
  const theirs = pair('Power', 'Technique');
  assert.equal(pairScore(mine, theirs, beats), -pairScore(theirs, mine, beats));
});

test('rankMatchups covers all 21 pairs, sorted best first', () => {
  const ranked = rankMatchups(pair('Speed', 'Power'), attributes, counters);
  assert.equal(ranked.length, 21);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
  // Scores are bounded by +/- (4 cross pairs x the bonus per won pair).
  const bound = 4 * COUNTER_BONUS;
  assert.ok(ranked[0].score <= bound && ranked.at(-1).score >= -bound);
});

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

test('hand-computed score: {Speed,Power} vs {Improvisation,Technique} = +4', () => {
  // Speed>Improv +2, Technique>Speed -2, Power>Improv +2, Power>Technique +2
  assert.equal(pairScore(pair('Speed', 'Power'), pair('Improvisation', 'Technique'), beats), 4);
});

test('hand-computed score: {Speed,Power} vs {Technique,Close-Quarters} = -8', () => {
  // Technique>Speed -2, CQ>Speed -2, Power>Technique +2... recheck: Power beats Technique (+2), CQ beats Power (-2)
  // Speed vs Technique: -2; Speed vs CQ: -2; Power vs Technique: +2; Power vs CQ: -2 => -4
  assert.equal(pairScore(pair('Speed', 'Power'), pair('Technique', 'Close-Quarters'), beats), -4);
});

test('sharing a style contributes zero for that sub-pair', () => {
  // {Speed,Power} vs {Speed,Improvisation}: Speed-Speed 0, Speed>Improv +2,
  // Speed>Power (their Speed beats my Power) -2, Power>Improv +2 => +2
  assert.equal(pairScore(pair('Speed', 'Power'), pair('Speed', 'Improvisation'), beats), 2);
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
  // Scores are bounded by +/-8 (4 cross pairs x bonus 2)
  assert.ok(ranked[0].score <= 8 && ranked.at(-1).score >= -8);
});

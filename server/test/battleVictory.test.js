// Victory Parameters: who has won, from the fighters as they stand
// (client/src/lib/battleVictory.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forcedFirstSide, kingOfTheHill, lastOneStanding, outlast, protectTheVip, roundsToWin, tournamentRoundLoser } from '../../client/src/lib/battleVictory.js';

const hp = (current, bars = 1, broken = 0) => ({ max: 10, current, bars, broken });
const f = (id, side, square, h = hp(10)) => ({ id, side, square, hp: h });
const at = (col, row) => ({ col, row });

test('Last One Standing: one side left standing; nobody wins while both stand', () => {
  assert.equal(lastOneStanding([f(1, 'allies', at(1, 1)), f(2, 'enemies', at(2, 1))]), null);
  assert.equal(lastOneStanding([f(1, 'allies', at(1, 1)), f(2, 'enemies', at(2, 1), hp(0))]), 'allies');
  assert.equal(lastOneStanding([f(1, 'allies', at(1, 1)), f(2, 'enemies', null)]), 'allies');
  assert.equal(lastOneStanding([f(1, 'allies', null), f(2, 'enemies', null)]), null);
});

test('King of the Hill: everyone standing in the Zone of one side', () => {
  const zone = [at(5, 5), at(5, 6)];
  assert.equal(kingOfTheHill([f(1, 'allies', at(5, 5)), f(2, 'enemies', at(1, 1))], zone), 'allies');
  assert.equal(kingOfTheHill([f(1, 'allies', at(5, 5)), f(2, 'enemies', at(5, 6))], zone), null);
  assert.equal(kingOfTheHill([f(1, 'allies', at(5, 5)), f(2, 'enemies', at(5, 6), hp(0))], zone), 'allies');
  assert.equal(kingOfTheHill([f(1, 'allies', at(1, 1))], zone), null);
});

test('Outlast: Attackers win when every Survivor is down; Survivors after round 3', () => {
  const both = [f(1, 'allies', at(1, 1)), f(2, 'enemies', at(2, 1))];
  assert.equal(outlast(both, 'allies', { roundEnd: true, round: 2 }), null);
  assert.equal(outlast(both, 'allies', { roundEnd: true, round: 3 }), 'allies');
  assert.equal(outlast([f(1, 'allies', null), f(2, 'enemies', at(2, 1))], 'allies'), 'enemies');
});

test('Protect the VIP: the side whose VIP falls loses', () => {
  const vips = { allies: 1, enemies: 2 };
  assert.equal(protectTheVip([f(1, 'allies', at(1, 1)), f(2, 'enemies', at(2, 1))], vips), null);
  assert.equal(protectTheVip([f(1, 'allies', at(1, 1)), f(2, 'enemies', at(2, 1), hp(0)), f(3, 'enemies', at(3, 1))], vips), 'allies');
});

test('Tournament: out of play or two at 0 HP loses the round; both is a draw', () => {
  assert.equal(tournamentRoundLoser([f(1, 'allies', null), f(2, 'enemies', at(2, 1))]), 'allies');
  assert.equal(tournamentRoundLoser([f(1, 'allies', at(1, 1)), f(2, 'enemies', at(2, 1), hp(0)), f(3, 'enemies', at(3, 1), hp(0))]), 'enemies');
  assert.equal(tournamentRoundLoser([f(1, 'allies', at(1, 1)), f(2, 'enemies', at(2, 1), hp(0))]), null);
  assert.equal(tournamentRoundLoser([f(1, 'allies', null), f(2, 'enemies', null)]), null);
  assert.equal(roundsToWin(3), 2);
  assert.equal(roundsToWin(5), 3);
});

test("the side that always goes first: Outlast's Attackers, Sabotage's Saboteurs", () => {
  assert.equal(forcedFirstSide({ victory: 'outlast', victoryOpts: { survivors: 'allies' } }, ['allies', 'enemies']), 'enemies');
  assert.equal(forcedFirstSide({ victory: 'sabotage', victoryOpts: { saboteurs: 'allies' } }, ['allies', 'enemies']), 'allies');
  assert.equal(forcedFirstSide({ victory: 'king_of_the_hill', victoryOpts: {} }, ['allies', 'enemies']), null);
});

test('Outlast three ways: the Renegades (Interference) win when no Attacker is left in play', () => {
  const fs = [f(1, 'allies', at(1, 1)), f(2, 'enemies', null), f(3, 'renegades', at(3, 3))];
  assert.equal(outlast(fs, 'allies'), 'renegades');
  assert.equal(outlast([f(1, 'allies', null), f(2, 'enemies', at(2, 1)), f(3, 'renegades', at(3, 3))], 'allies'), 'enemies');
  assert.equal(lastOneStanding([f(1, 'allies', at(1, 1)), f(2, 'enemies', null), f(3, 'renegades', at(3, 3))]), null);
  assert.equal(lastOneStanding([f(1, 'allies', null), f(2, 'enemies', null), f(3, 'renegades', at(3, 3))]), 'renegades');
});

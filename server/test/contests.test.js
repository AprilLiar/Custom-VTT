// Stance Contests: the book's 12 (pp.86-89) and custom ones, scored from what
// each contestant did (client/src/lib/contests.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEST_BY_KEY, CONTESTS, SKILL_BONUSES, bestMatch, contestResult, normalizeCustom } from '../../client/src/lib/contests.js';

const run = (key, a, b) => contestResult(CONTEST_BY_KEY[key], [{ side: 'a', id: 1, stats: a }, { side: 'b', id: 2, stats: b }]).winner;

test('the book has 12 contests', () => {
  assert.equal(CONTESTS.length, 12);
});

test('token contests: Dance (Speed), Sumo (Iron), Wrestling (Power)', () => {
  assert.equal(run('sumo', { tokens: { iron: 9 } }, { tokens: { iron: 11 } }), 'b');
  assert.equal(run('dance', { tokens: { speed: 4 } }, { tokens: { speed: 2 } }), 'a');
  assert.equal(run('wrestling', { tokens: { power: 3 } }, { tokens: { power: 3 } }), null, 'a tie');
});

test('a side counts its best result (the book: 9 and 11 Iron → 11)', () => {
  const r = contestResult(CONTEST_BY_KEY.sumo, [
    { side: 'a', id: 1, stats: { tokens: { iron: 9 } } },
    { side: 'a', id: 2, stats: { tokens: { iron: 11 } } },
    { side: 'b', id: 3, stats: { tokens: { iron: 10 } } },
  ]);
  assert.equal(r.winner, 'a');
  assert.equal(r.best.a.id, 2);
});

test('Fencing: most matching, then the higher value', () => {
  assert.deepEqual(bestMatch([6, 6, 6, 2]), { size: 3, value: 6 });
  assert.equal(run('fencing', { pool: [6, 6, 6] }, { pool: [4, 4, 4] }), 'a');
  assert.equal(run('fencing', { pool: [2, 2, 2, 1] }, { pool: [8, 8, 3] }), 'a');
});

test('Gambling: the highest number, then the next', () => {
  assert.equal(run('gambling', { pool: [8, 3, 1] }, { pool: [8, 5, 1] }), 'b');
  assert.equal(run('gambling', { pool: [10] }, { pool: [8, 8] }), 'a');
});

test('Negotiation: fewest matching; none → highest; all → highest pair; three of a kind loses', () => {
  assert.equal(run('negotiation', { pool: [6, 6, 2] }, { pool: [5, 3, 1] }), 'b', 'fewest matching');
  assert.equal(run('negotiation', { pool: [7, 3, 1] }, { pool: [5, 3, 1] }), 'a', 'nobody matches: the highest');
  assert.equal(run('negotiation', { pool: [4, 4, 1] }, { pool: [6, 6, 2] }), 'b', 'everybody matches: the highest pair');
  assert.equal(run('negotiation', { pool: [8, 8, 8] }, { pool: [2, 2, 1] }), 'b', 'three of a kind loses');
});

test('dummy contests: Crushing (hit, then push), Macho (total), Big Game, Javelin, Hundred-Hand', () => {
  assert.equal(run('crushing', { biggestHit: { damage: 9, push: 1 } }, { biggestHit: { damage: 9, push: 3 } }), 'b');
  assert.equal(run('macho', { totalDamage: 20 }, { totalDamage: 12 }), 'a');
  assert.equal(run('big_game', { dummyStatus: 2 }, { dummyStatus: 5 }), 'b');
  assert.equal(run('javelin', { pushDistance: 6 }, { pushDistance: 4 }), 'a');
  assert.equal(run('hundred_hand', { felled: 3 }, { felled: 4 }), 'b');
});

test('Survival: the least HP lost wins', () => {
  assert.equal(run('survival', { hpLost: 4 }, { hpLost: 10 }), 'a');
});

test('custom contests: measure, higher or lower, and the setup', () => {
  const c = normalizeCustom({ name: 'Fewest Fatigue', measure: 'tokens', token: 'fatigue', better: 'low', setup: { hits: [3, 3] } });
  assert.equal(c.measure, 'tokens:fatigue');
  assert.deepEqual(c.setup.hits, [3, 3]);
  assert.equal(contestResult(c, [{ side: 'a', id: 1, stats: { tokens: { fatigue: 1 } } }, { side: 'b', id: 2, stats: { tokens: { fatigue: 3 } } }]).winner, 'a');
  const d = normalizeCustom({ measure: 'total_damage', setup: { dummies: 9, dummyHp: '' } });
  assert.equal(d.setup.dummies, 5);
  assert.equal(d.setup.dummyHp, null);
});

test('the Skill bonuses: 3 Basic tokens, green d8 / 2d6 / 3d4, +2 after rolling', () => {
  assert.deepEqual(SKILL_BONUSES.map((b) => b.dice ?? null).filter(Boolean), [[8], [6, 6], [4, 4, 4]]);
});

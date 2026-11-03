// Map tiles' stacking rules (client/src/lib/mapTiles.js), pinned against the
// book's "Obstacles" and "Obstacle Stacking and Replacement" (p.70-72).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destroyTile, displayKinds, groupSquares, mergeInto, placeTile, removeTile } from '../../client/src/lib/mapTiles.js';

test('Fog, Pits and Traps share a space; Pit + Trap reads as a Pit Trap', () => {
  assert.deepEqual(placeTile(placeTile([], 'pit'), 'fog'), ['fog', 'pit']);
  assert.deepEqual(placeTile(['pit'], 'trap'), ['pit', 'trap']);
  assert.deepEqual(placeTile([], 'pit_trap'), ['pit', 'trap']);
  assert.deepEqual(displayKinds(['fog', 'pit', 'trap']), ['fog', 'pit_trap']);
  assert.deepEqual(placeTile(['trap'], 'trap'), ['trap']);
});

test('Rubble clears the other obstacles; an obstacle placed on Rubble replaces it', () => {
  assert.deepEqual(placeTile(['fog', 'pit', 'trap'], 'rubble'), ['rubble']);
  assert.deepEqual(placeTile(['rubble'], 'pit'), ['pit']);
  assert.deepEqual(placeTile(['rubble'], 'fog'), ['fog']);
});

test('a Wall shares only with Fog; other obstacles on a Wall leave Rubble', () => {
  assert.deepEqual(placeTile(['fog', 'pit'], 'wall'), ['fog', 'wall']);
  assert.deepEqual(placeTile(['wall'], 'fog'), ['fog', 'wall']);
  assert.deepEqual(placeTile(['wall'], 'trap'), ['rubble']);
  assert.deepEqual(placeTile(['fog', 'wall'], 'pit_trap'), ['rubble']);
});

test('zones and the Important Thing share with anything and survive Rubble', () => {
  assert.deepEqual(placeTile(['wall'], 'danger'), ['wall', 'danger']);
  assert.deepEqual(placeTile(['king', 'pit'], 'rubble'), ['rubble', 'king']);
  assert.deepEqual(placeTile(['important'], 'control'), ['control', 'important']);
});

test('destroying a Wall leaves Rubble; destroying Rubble leaves nothing; removing a Pit Trap takes both', () => {
  assert.deepEqual(destroyTile(['fog', 'wall', 'danger'], 'wall'), ['rubble', 'danger']);
  assert.deepEqual(destroyTile(['rubble', 'king'], 'rubble'), ['king']);
  assert.deepEqual(removeTile(['fog', 'pit', 'trap'], 'pit_trap'), ['fog']);
  assert.deepEqual(removeTile(['fog', 'pit'], 'fog'), ['pit']);
});

test('moving a square onto another stacks by the same rules', () => {
  assert.deepEqual(mergeInto(['fog'], ['pit', 'trap']), ['fog', 'pit', 'trap']);
  assert.deepEqual(mergeInto(['wall'], ['trap']), ['rubble']);
  assert.deepEqual(mergeInto([], ['danger', 'rubble']), ['rubble', 'danger']);
});

test('stored rows group into squares', () => {
  const g = groupSquares([{ col: 1, row: 2, kind: 'trap' }, { col: 1, row: 2, kind: 'pit' }, { col: 0, row: 0, kind: 'fog' }]);
  assert.deepEqual(g.get('1,2'), { col: 1, row: 2, kinds: ['pit', 'trap'] });
  assert.equal(g.size, 2);
});

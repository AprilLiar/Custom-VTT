// server/moveBundles.js — what one Move Point actually buys.
//
// Two hard-coded exceptions to "one row, one point", both of them cases where
// several rows are obviously one thing a fighter learns: name variants, and a
// grapple plus its first follow-up. What is worth pinning is not the happy
// path but the four ways a grouping rule goes wrong — a separator that catches
// too much, a recursive grapple that never terminates, two rules that do not
// compose, and a discount applied twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bundleMoves,
  grappleExtensionIds,
  moveIdsForBundles,
  moveSelectionCost,
  variantBase,
} from '../moveBundles.js';

const move = (id, name, extra = {}) => ({ id, name, is_grappling: false, grapple_directions: [], ...extra });
const grapple = (id, name, targets = []) =>
  move(id, name, { is_grappling: true, grapple_directions: targets.map((t) => ({ target_move_id: t })) });
const cost = (ids, moves) => moveSelectionCost(ids, bundleMoves(moves)).points;

// ---------- the separator ----------

test('variantBase splits on " - " and on nothing else', () => {
  assert.equal(variantBase('Cross - Head'), 'Cross');
  assert.equal(variantBase('Cross - Body'), 'Cross');
  assert.equal(variantBase('Jab'), 'Jab');
  // **Hyphenated names are one move, not a family.** This is the whole reason
  // the convention is written with spaces at the table: without the spaces,
  // `Push-Kick` and `Push-Block` would silently become one point.
  assert.equal(variantBase('Push-Kick'), 'Push-Kick');
  assert.equal(variantBase('Off-Balance Sweep'), 'Off-Balance Sweep');
  // Only the FIRST separator splits, so a variant may have a dash in its own
  // suffix without founding a second family.
  assert.equal(variantBase('Cross - Head - Close'), 'Cross');
  assert.equal(variantBase('  '), '');
  assert.equal(variantBase(null), '');
});

test('variants bundle into one point, and the family keeps its name', () => {
  const moves = [move(1, 'Cross - Head'), move(2, 'Cross - Body'), move(3, 'Jab')];
  const bundles = bundleMoves(moves);
  assert.equal(bundles.length, 2, JSON.stringify(bundles.map((b) => b.name)));
  const cross = bundles.find((b) => b.name === 'Cross');
  assert.deepEqual(cross.moveIds, [1, 2]);
  // Ticking the family takes every row in it — that is what "one checkbox" means.
  assert.deepEqual(moveIdsForBundles(['cross'], bundles).sort(), [1, 2]);
  // One point for both, two for both plus the Jab.
  assert.equal(cost([1, 2], moves), 1);
  assert.equal(cost([1, 2, 3], moves), 2);
  // ...and taking only ONE of the variants still costs the family's one point,
  // which is what stops a half-taken family being cheaper than a whole one.
  assert.equal(cost([1], moves), 1);
});

test('case and spacing do not found a second family', () => {
  const moves = [move(1, 'Cross - Head'), move(2, 'cross  -  Body')];
  assert.equal(bundleMoves(moves).length, 1);
  assert.equal(cost([1, 2], moves), 1);
});

// ---------- the grapple graph ----------

test('grappleExtensionIds walks the whole chain and never returns the root', () => {
  const moves = [grapple(1, 'Clinch', [2]), grapple(2, 'Headlock', [3]), move(3, 'Throw')];
  const byId = new Map(moves.map((m) => [m.id, m]));
  assert.deepEqual(grappleExtensionIds(1, byId), [2, 3]);
  // A non-grappling follow-up ends its branch: `Throw` has no directions to
  // open, so nothing further is reachable through it.
  assert.deepEqual(grappleExtensionIds(2, byId), [3]);
});

test('a grapple that names ITSELF terminates and is not its own extension', () => {
  // The "chain the same move over and over" authoring: a grapple's direction
  // points back at the grapple. Learning it once is enough, and a walk that did
  // not say so would not terminate at all.
  const moves = [grapple(1, 'Headlock', [1, 2]), move(2, 'Knee')];
  const byId = new Map(moves.map((m) => [m.id, m]));
  assert.deepEqual(grappleExtensionIds(1, byId), [2]);
  assert.equal(cost([1, 2], moves), 1, 'the grab and its one extension');
});

test('a cycle between two grapples terminates, and each move counts once', () => {
  const moves = [grapple(1, 'Clinch', [2]), grapple(2, 'Headlock', [1, 3]), move(3, 'Throw')];
  const byId = new Map(moves.map((m) => [m.id, m]));
  assert.deepEqual(grappleExtensionIds(1, byId), [2, 3]);
  // Clinch + Headlock + Throw: the grab pays for one extension, the other costs.
  assert.equal(cost([1, 2, 3], moves), 2);
});

test('a direction pointing at a move that no longer exists is skipped', () => {
  // move:delete clears inbound directions, but a stale library in a browser tab
  // is a real thing and must not crash the wizard.
  const moves = [grapple(1, 'Clinch', [99])];
  assert.deepEqual(grappleExtensionIds(1, new Map(moves.map((m) => [m.id, m]))), []);
  assert.equal(cost([1], moves), 1);
});

// ---------- the pricing rule ----------

test('the grab and its first extension are one point; the rest are their own', () => {
  const moves = [grapple(1, 'Clinch', [2, 3, 4]), move(2, 'Arm Bar'), move(3, 'Throw'), move(4, 'Choke')];
  assert.equal(cost([1], moves), 1, 'the grab alone');
  assert.equal(cost([1, 2], moves), 1, 'the grab and one extension');
  assert.equal(cost([1, 2, 3], moves), 2);
  assert.equal(cost([1, 2, 3, 4], moves), 3);
});

test('the player chooses which extension is free — every choice prices the same', () => {
  // "One extension comes with the grab" says nothing about WHICH, and a fixed
  // choice would quietly make some grapples better than others.
  const moves = [grapple(1, 'Clinch', [2, 3]), move(2, 'Arm Bar'), move(3, 'Throw')];
  assert.equal(cost([1, 2], moves), 1);
  assert.equal(cost([1, 3], moves), 1);
});

test('an extension taken WITHOUT its grapple is an ordinary move', () => {
  // The discount belongs to the grab. Taking the follow-up on its own is just
  // taking a move, and must not be free.
  const moves = [grapple(1, 'Clinch', [2]), move(2, 'Arm Bar')];
  assert.equal(cost([2], moves), 1);
});

test('the two rules compose: two variants of one follow-up are ONE extension', () => {
  // This is the case that only works because the grapple walk speaks in
  // bundles rather than in rows. Reading it per-row would charge a point for
  // `Arm Bar - Left` and free `Arm Bar - Right`, which is the same follow-up.
  const moves = [
    grapple(1, 'Clinch', [2, 3]),
    move(2, 'Arm Bar - Left'),
    move(3, 'Arm Bar - Right'),
    move(4, 'Throw'),
  ];
  const bundles = bundleMoves(moves);
  const clinch = bundles.find((b) => b.name === 'Clinch');
  assert.deepEqual(clinch.extensionKeys, ['arm bar'], JSON.stringify(clinch.extensionKeys));
  assert.equal(cost([1, 2, 3], moves), 1, 'the grab plus one follow-up, aimed two ways');
});

test('a follow-up inside the grapple\'s OWN family is not an extension of itself', () => {
  const moves = [grapple(1, 'Headlock - Standing', [2]), move(2, 'Headlock - Ground')];
  const bundles = bundleMoves(moves);
  assert.equal(bundles.length, 1);
  assert.deepEqual(bundles[0].extensionKeys, []);
  assert.equal(cost([1, 2], moves), 1);
});

test('one bundle cannot be discounted twice by two grapples that both reach it', () => {
  // It is only being COUNTED once, so freeing it twice would price a
  // two-grapple build below what it actually holds.
  const moves = [grapple(1, 'Clinch', [3]), grapple(2, 'Snap Down', [3]), move(3, 'Throw')];
  // Clinch + Snap Down + Throw = 3 bundles, one discount = 2.
  assert.equal(cost([1, 2, 3], moves), 2);
  // Each on its own with the Throw is 1.
  assert.equal(cost([1, 3], moves), 1);
  assert.equal(cost([2, 3], moves), 1);
});

test('a family is a grapple if any of its variants is', () => {
  const moves = [move(1, 'Clinch - High'), grapple(2, 'Clinch - Low', [3]), move(3, 'Throw')];
  const bundles = bundleMoves(moves);
  const clinch = bundles.find((b) => b.name === 'Clinch');
  assert.equal(clinch.isGrappleRoot, true);
  assert.deepEqual(clinch.extensionKeys, ['throw']);
  assert.equal(cost([1, 2, 3], moves), 1);
});

test('an empty library prices an empty selection at nothing', () => {
  assert.equal(moveSelectionCost([], []).points, 0);
  assert.equal(moveSelectionCost([1, 2], []).points, 0, 'ids with no bundle behind them buy nothing');
  assert.deepEqual(bundleMoves(), []);
  assert.deepEqual(bundleMoves(null), []);
});

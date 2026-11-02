// Simple Combat's lane (client/src/lib/simpleLane.js): who stands where, moving
// and swapping, and the perspective geometry a drag is judged against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_SLOTS,
  MAX_LANES,
  TRAY,
  clampLanes,
  laneCapacity,
  laneGeometry,
  laneLinesPath,
  moveOnLane,
  packLane,
  slotAt,
  slotAtX,
} from '../../client/src/lib/simpleLane.js';

const summons = (...slots) => slots.map((lane_slot, i) => ({ id: i + 1, lane_slot }));
const asObject = (map) => Object.fromEntries(map);

test('everyone without a space is packed from the left, in summon order', () => {
  assert.deepEqual(asObject(packLane(summons(null, null, null))), { 1: 0, 2: 1, 3: 2 });
});

test('explicit spaces are kept, and the rest fill the gaps', () => {
  assert.deepEqual(asObject(packLane(summons(null, 0, null, 2))), { 1: 1, 2: 0, 3: 3, 4: 2 });
});

test('a full lane sends the rest to the tray', () => {
  const twelve = Array.from({ length: 12 }, () => null);
  const packed = packLane(summons(...twelve));
  assert.equal([...packed.values()].filter((s) => s === null).length, 2);
  assert.deepEqual(packed.get(11), null);
  assert.equal(new Set([...packed.values()].filter((s) => s !== null)).size, LANE_SLOTS);
});

test('two summons claiming one space: the first keeps it', () => {
  assert.deepEqual(asObject(packLane(summons(4, 4))), { 1: 4, 2: 0 });
});

test('someone put in the tray on purpose stays there, and is not packed back', () => {
  assert.deepEqual(asObject(packLane(summons(TRAY, null))), { 1: null, 2: 0 });
});

test('junk slots are treated as unset', () => {
  assert.deepEqual(asObject(packLane(summons(-2, 10, 2.5, '3'))), { 1: 0, 2: 1, 3: 2, 4: 3 });
});

test('moving to a free space just moves', () => {
  const packed = packLane(summons(null, null));
  assert.deepEqual(asObject(moveOnLane(packed, 1, 7)), { 1: 7, 2: 1 });
});

test('moving onto someone swaps the two', () => {
  const packed = packLane(summons(null, null, null));
  assert.deepEqual(asObject(moveOnLane(packed, 1, 2)), { 1: 2, 2: 1, 3: 0 });
});

test('moving from the tray onto someone sends them to the tray', () => {
  const packed = new Map([[1, 0], [2, null]]);
  assert.deepEqual(asObject(moveOnLane(packed, 2, 0)), { 1: null, 2: 0 });
});

test('moving to the tray frees the space', () => {
  const packed = packLane(summons(null, null));
  assert.deepEqual(asObject(moveOnLane(packed, 1, null)), { 1: null, 2: 1 });
});

test('the lane sits at 5/7 of the height, wider at the bottom than the top', () => {
  const g = laneGeometry(1400, 700);
  assert.equal(g.centerY, 500);
  const [tl, tr, br, bl] = g.outline;
  assert.ok(br[0] - bl[0] > tr[0] - tl[0]);
  assert.ok(Math.abs((tl[0] + tr[0]) / 2 - 700) < 1e-6, 'centred');
  assert.equal(g.segments.length, LANE_SLOTS);
});

test('a point is judged against the lane centre line, and the ends catch overshoot', () => {
  const g = laneGeometry(1000, 700);
  for (const seg of g.segments) assert.equal(slotAtX(g, seg.center.x), seg.index);
  assert.equal(slotAtX(g, -500), 0);
  assert.equal(slotAtX(g, 5000), LANE_SLOTS - 1);
});

// ---- more than one lane (a table-wide GM setting, 1-3)

test('lane counts are clamped to 1-3, ten spaces each', () => {
  assert.deepEqual([clampLanes(0), clampLanes(2), clampLanes(9), clampLanes('junk')], [1, 2, MAX_LANES, 1]);
  assert.equal(laneCapacity(3), 30);
});

test('with two lanes the front lane fills first, then the back one, before the tray', () => {
  const many = Array.from({ length: 22 }, () => null);
  const packed = packLane(summons(...many), 2);
  assert.equal(packed.get(1), 0);
  assert.equal(packed.get(11), 10, 'the eleventh steps into the back lane');
  assert.equal(packed.get(21), null);
});

test('turning lanes down repacks anyone standing in a removed lane', () => {
  assert.deepEqual(asObject(packLane(summons(15, null), 1)), { 1: 0, 2: 1 });
  assert.deepEqual(asObject(packLane(summons(15, null), 2)), { 1: 15, 2: 0 });
});

test('each lane count has its own shape: deeper boards, flatter tilt, thinner back rows', () => {
  const one = laneGeometry(1400, 800, undefined, 1);
  const three = laneGeometry(1400, 800, undefined, 3);
  assert.equal(three.segments.length, 30);
  assert.ok(three.height > one.height && three.height < one.height * 3, 'deeper, but less than three times');
  const tilt = (g) => (g.outline[2][0] - g.outline[3][0]) / (g.outline[1][0] - g.outline[0][0]);
  assert.ok(tilt(three) > tilt(one), 'a flatter back edge relative to the front');
  const thick = three.rows.map((r) => r.bottomY - r.topY);
  assert.ok(thick[0] > thick[1] && thick[1] > thick[2], 'rows thin towards the back');
  assert.ok(three.segments[25].scale < three.segments[15].scale && three.segments[15].scale < three.segments[5].scale);
  assert.equal(three.centerY, (800 * 5) / 7, 'still centred at 5/7');
});

test('a point finds its lane by height and its column within that lane', () => {
  const g = laneGeometry(1200, 800, undefined, 3);
  for (const seg of g.segments) assert.equal(slotAt(g, seg.center.x, seg.center.y), seg.index);
  assert.equal(slotAt(g, -100, g.topY - 50), 20, 'above the board: back lane, first column');
  assert.equal(slotAt(g, 5000, g.bottomY + 50), 9, 'below it: front lane, last column');
  assert.ok(laneLinesPath(g).split('M').length - 1 === 1 + 2 + 9, 'outline, two lane lines, nine dividers');
});

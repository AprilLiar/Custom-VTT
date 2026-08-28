// client/src/lib/stanceGraphLayout.js — the counter wheel's geometry.
//
// Lives in server/test because that is where `npm test` looks; the module is
// pure ES with no DOM imports, so it loads cleanly here.
//
// **The bug this pins.** Every label used to sit on its node's own ray at a
// fixed radius. A label above or below the wheel grows sideways into empty
// space and is fine; one out to the SIDE grows back along the ray straight into
// its own node, and the two longest side labels — "Improvisation" and
// "Defensive" — landed on top of the style icons. Reported from play.
//
// Nothing in a screenshot of one node shows this, and nothing in the component
// could state it. Here it is one assertion, swept over the real seven styles
// and over names longer than any of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STYLES } from '../ruleset.js';
import {
  CENTER,
  LABEL_FONT_SIZE,
  NODE_R,
  RADIUS,
  angleAt,
  graphViewBox,
  labelClearsNode,
  labelPosition,
  labelWidth,
  nodePosition,
  viewBoxString,
} from '../../client/src/lib/stanceGraphLayout.js';

const N = STYLES.length;

test('no style label touches its own icon — including the two that used to', () => {
  STYLES.forEach((style, i) => {
    assert.ok(labelClearsNode(i, N, style.name), `${style.name} overlaps its node`);
  });

  // The two the bug was reported for, named explicitly: they are the nodes
  // nearest the horizontal, so nearly the whole half-width of their text points
  // back at the wheel. If a future change reorders the styles this keeps
  // testing whatever now sits in those seats, which is the point.
  for (const name of ['Improvisation', 'Defensive']) {
    const i = STYLES.findIndex((s) => s.name === name);
    assert.ok(i >= 0, `${name} is no longer a style — update this test`);
    assert.ok(Math.abs(Math.cos(angleAt(i, N))) > 0.9, `${name} is no longer a side node`);
    assert.ok(labelClearsNode(i, N, name), `${name} overlaps its node`);
  }
});

test('the old fixed-radius placement really did overlap, so the test can fail', () => {
  // Reconstructs the previous rule — RADIUS + 44 on the node's own ray — and
  // asserts it collides. Without this, the test above passes for any placement
  // generous enough and proves nothing about the fix.
  const oldLabel = (i) => {
    const a = angleAt(i, N);
    return { x: CENTER + (RADIUS + 44) * Math.cos(a), y: CENTER + (RADIUS + 44) * Math.sin(a) };
  };
  const overlaps = (i, name) => {
    const node = nodePosition(i, N);
    const label = oldLabel(i);
    const dx = Math.max(0, Math.abs(label.x - node.x) - labelWidth(name) / 2);
    const dy = Math.max(0, Math.abs(label.y - node.y) - LABEL_FONT_SIZE / 2);
    return Math.hypot(dx, dy) < NODE_R;
  };
  const i = STYLES.findIndex((s) => s.name === 'Improvisation');
  assert.ok(overlaps(i, 'Improvisation'), 'the old placement should have overlapped');
  const j = STYLES.findIndex((s) => s.name === 'Defensive');
  assert.ok(overlaps(j, 'Defensive'), 'the old placement should have overlapped');
});

test('a label at the top or bottom is not pushed out at all', () => {
  // The whole point of scaling the push by |cos θ|: only the labels that were
  // actually overlapping move. The top node's label must stay where it was.
  const top = labelPosition(0, N, STYLES[0].name);
  assert.ok(Math.abs(top.x - CENTER) < 1e-9, 'the top label stays on the vertical axis');
  assert.ok(Math.abs(top.y - (CENTER - RADIUS - NODE_R - 22)) < 1e-9, String(top.y));

  // And a longer name at the top does not move it either, because none of its
  // width points at the node.
  const longer = labelPosition(0, N, 'A Very Long Style Name Indeed');
  assert.ok(Math.abs(longer.y - top.y) < 1e-9, 'length must not matter at the top');
});

test('a longer name is pushed further, and only sideways', () => {
  const i = STYLES.findIndex((s) => s.name === 'Improvisation');
  const short = labelPosition(i, N, 'Ab');
  const long = labelPosition(i, N, 'Improvisation Improvisation');
  const from = (p) => Math.hypot(p.x - CENTER, p.y - CENTER);
  assert.ok(from(long) > from(short), 'a wider label needs more room');
  // Both still clear their node, which is the property that matters.
  assert.ok(labelClearsNode(i, N, 'Ab'));
  assert.ok(labelClearsNode(i, N, 'Improvisation Improvisation'));
});

test('the viewBox contains every label, so pushing one out does not clip it', () => {
  // The half of the fix that is easy to forget: an outermost <svg> clips to its
  // viewport regardless of overflow, so a label pushed past the old 0..460 box
  // would simply have vanished — the same trap the relationship board hit.
  const box = graphViewBox(STYLES);
  STYLES.forEach((style, i) => {
    const p = labelPosition(i, N, style.name);
    const half = labelWidth(style.name) / 2;
    assert.ok(p.x - half >= box.x, `${style.name} is clipped on the left`);
    assert.ok(p.x + half <= box.x + box.width, `${style.name} is clipped on the right`);
    assert.ok(p.y - LABEL_FONT_SIZE / 2 >= box.y, `${style.name} is clipped at the top`);
    assert.ok(p.y + LABEL_FONT_SIZE / 2 <= box.y + box.height, `${style.name} is clipped at the bottom`);
  });
  // The wheel itself is always inside too, however short the names get.
  const tiny = graphViewBox([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  assert.ok(tiny.x <= 0 && tiny.y <= 0);
  assert.ok(tiny.width >= 460 && tiny.height >= 460);

  // Nonsense in, something drawable out — never NaN in a viewBox attribute.
  for (const arg of [[], null, undefined]) {
    assert.ok(!viewBoxString(arg ?? []).includes('NaN'), String(arg));
  }
});

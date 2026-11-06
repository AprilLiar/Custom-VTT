// Full automation, phase J — the automation census (client/src/lib/patd/coverage.js).
// Every Ability rule, Action and Super Move is either automatic or explicitly
// by hand, with its reason; the automatic counts never go back down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { census } from '../../client/src/lib/patd/coverage.js';

const idx = patdContent();
const report = census(idx.content);

// The floor: what phase J reached. Raise it when more becomes automatic.
const FLOOR = { triggered: 214, continuous: 37, actions: 160, supers: 27 };

test('everything is counted: every Ability rule, Action and Super Move in the content', () => {
  const rules = (idx.content.abilities ?? []).reduce((n, a) => n + (a.rules ?? []).length, 0);
  assert.equal(report.abilities.triggered.total + report.abilities.continuous.total, rules);
  assert.equal(report.actions.total, (idx.content.actions ?? []).length);
  assert.equal(report.supers.total, (idx.content.superMoves ?? []).length);
});

test('automatic or explicitly by hand — each by-hand entry says why', () => {
  for (const t of [report.abilities.triggered, report.abilities.continuous, report.actions, report.supers]) {
    assert.equal(t.automatic + t.byHand.length, t.total);
    for (const b of t.byHand) assert.ok(typeof b.reason === 'string' && b.reason.length > 0, `${b.id}: no reason`);
  }
});

test('the automatic counts never go back down', () => {
  assert.ok(report.abilities.triggered.automatic >= FLOOR.triggered, `triggered Ability rules: ${report.abilities.triggered.automatic} < ${FLOOR.triggered}`);
  assert.ok(report.abilities.continuous.automatic >= FLOOR.continuous, `continuous Ability rules: ${report.abilities.continuous.automatic} < ${FLOOR.continuous}`);
  assert.ok(report.actions.automatic >= FLOOR.actions, `Actions: ${report.actions.automatic} < ${FLOOR.actions}`);
  assert.ok(report.supers.automatic >= FLOOR.supers, `Super Moves: ${report.supers.automatic} < ${FLOOR.supers}`);
});

test('the content’s own "requires a ruling" entry (The Untouchable) is never claimed automatic', () => {
  const ruling = (idx.content.abilities ?? []).filter((a) => a.automationState === 'requires_ruling').map((a) => a.id);
  assert.ok(ruling.includes('ability.archetype-the-untouchable.the-untouchable'));
  const byHand = new Set([...report.abilities.triggered.byHand, ...report.abilities.continuous.byHand].map((b) => b.id));
  // The part that needs a ruling stays with people (its plain token gain may run).
  for (const id of ruling) assert.ok(byHand.has(id), `${id}: the part needing a ruling should be by hand`);
});

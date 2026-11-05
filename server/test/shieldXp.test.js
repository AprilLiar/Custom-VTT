// The Shield absorbing damage, and XP with its log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absorbWithShield } from '../../client/src/lib/panicTokens.js';
import { normalizeBuild, withXp, XP_LOG_MAX } from '../../client/src/lib/patd/build.js';
import { patdContent } from '../patdContent.js';

test('a Shield absorbs damage up to its value, breaks when used up, and the rest hits HP', () => {
  assert.deepEqual(absorbWithShield(3, 2), { absorbed: 2, shield: 1, broke: false, rest: 0 });
  assert.deepEqual(absorbWithShield(2, 5), { absorbed: 2, shield: 0, broke: true, rest: 3 });
  assert.deepEqual(absorbWithShield(2, 2), { absorbed: 2, shield: 0, broke: true, rest: 0 });
  assert.deepEqual(absorbWithShield(0, 4), { absorbed: 0, shield: 0, broke: false, rest: 4 });
});

test('XP: awards are logged, never below 0, the log is capped and survives normalizing', () => {
  let b = normalizeBuild({ type: 'hero-type.focused', xp: 1 }, patdContent());
  b = withXp(b, 2, 'Victory — The Docks', '2026-01-01T00:00:00Z');
  b = withXp(b, -10, 'Correction');
  assert.equal(b.xp, 0);
  assert.deepEqual(b.xpLog.map((e) => e.amount), [2, -3]);
  assert.equal(withXp(b, -1, 'x'), b, 'nothing to take: no change, no log');
  for (let i = 0; i < 40; i++) b = withXp(b, 1, `#${i}`);
  assert.equal(b.xpLog.length, XP_LOG_MAX);
  const again = normalizeBuild(JSON.parse(JSON.stringify(b)), patdContent());
  assert.deepEqual(again.xpLog, b.xpLog);
  assert.equal(again.xp, 40);
});

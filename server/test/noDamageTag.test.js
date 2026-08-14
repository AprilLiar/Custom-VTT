// The No Damage Tag — the second Tag automation. Same shape as the Block
// Tag's own tests: the decision is pure, so it is provable without a socket,
// a database or a clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SUCCESS_THRESHOLD, resolveNoDamageOutcome } from '../combatDamage.js';
import { clampSuccessThreshold } from '../moveLogic.js';
import {
  NO_DAMAGE_TAG,
  TAG_HOOKS,
  carriesBlockTag,
  carriesNoDamageTag,
  effectiveTagNames,
} from '../tagAutomations.js';

// ---------- the threshold ----------

test('the threshold is inclusive — reaching it is succeeding', () => {
  // The boundary is the whole rule, so it is worth pinning from both sides.
  assert.equal(resolveNoDamageOutcome({ result: 4 }).succeeded, false);
  assert.equal(resolveNoDamageOutcome({ result: 5 }).succeeded, true);
  assert.equal(resolveNoDamageOutcome({ result: 6 }).succeeded, true);
});

test('the default threshold is 5', () => {
  assert.equal(DEFAULT_SUCCESS_THRESHOLD, 5);
  assert.equal(resolveNoDamageOutcome({ result: 0 }).threshold, 5);
});

test('the move carries its own threshold', () => {
  assert.equal(resolveNoDamageOutcome({ result: 9, successThreshold: 12 }).succeeded, false);
  assert.equal(resolveNoDamageOutcome({ result: 12, successThreshold: 12 }).succeeded, true);
});

test('a threshold of 0 succeeds on anything, including a roll of 0', () => {
  // 0 is the honest way to author "this always works", and it must not be
  // confused with an absent threshold falling back to 5.
  assert.equal(resolveNoDamageOutcome({ result: 0, successThreshold: 0 }).succeeded, true);
});

test('an unparseable threshold falls back to the default, not to zero', () => {
  // Falling back to the floor would silently make a malformed move the
  // easiest in the game — the opposite of a safe default.
  assert.equal(resolveNoDamageOutcome({ result: 3, successThreshold: null }).threshold, 5);
  assert.equal(resolveNoDamageOutcome({ result: 3, successThreshold: 'nonsense' }).threshold, 5);
  assert.equal(resolveNoDamageOutcome({ result: 3, successThreshold: undefined }).succeeded, false);
});

test('the result is echoed back so the log can state it', () => {
  const r = resolveNoDamageOutcome({ result: 7, successThreshold: 5 });
  assert.deepEqual(r, { threshold: 5, result: 7, succeeded: true });
});

// ---------- authoring ----------

test('clampSuccessThreshold keeps whole numbers inside 0-20', () => {
  assert.equal(clampSuccessThreshold(0), 0);
  assert.equal(clampSuccessThreshold(12), 12);
  assert.equal(clampSuccessThreshold(20), 20);
  assert.equal(clampSuccessThreshold(999), 20);
  assert.equal(clampSuccessThreshold(-4), 0, 'never negative — 0 already says "always succeeds"');
  assert.equal(clampSuccessThreshold(7.9), 7, 'compared against an integer roll, so stored as one');
});

test('an unparseable threshold clamps to the default rather than the floor', () => {
  assert.equal(clampSuccessThreshold('nonsense'), DEFAULT_SUCCESS_THRESHOLD);
  assert.equal(clampSuccessThreshold(undefined), DEFAULT_SUCCESS_THRESHOLD);
  assert.equal(clampSuccessThreshold(null), DEFAULT_SUCCESS_THRESHOLD);
});

// ---------- the tag itself ----------

test('the tag is matched by name, case- and whitespace-insensitively', () => {
  // Ids differ between databases and the GM owns the tag list, so the name is
  // the only stable handle — and a GM typing "no damage " must not silently
  // lose the mechanic.
  assert.equal(carriesNoDamageTag(['No Damage']), true);
  assert.equal(carriesNoDamageTag(['no damage']), true);
  assert.equal(carriesNoDamageTag([' NO DAMAGE ']), true);
  assert.equal(carriesNoDamageTag(['Block']), false);
  assert.equal(carriesNoDamageTag([]), false);
  assert.equal(carriesNoDamageTag(undefined), false);
});

test('No Damage and Block are independent, and can sit on the same move', () => {
  // A no-cost guard that deals no damage is a perfectly ordinary move, and
  // neither automation may swallow the other.
  const both = ['Block', 'No Damage'];
  assert.equal(carriesBlockTag(both), true);
  assert.equal(carriesNoDamageTag(both), true);
});

test('a Perk that grants No Damage turns the automation on for that character', () => {
  // Tag automation reads the character-resolved set, not the template's — or
  // a Perk that grants the tag would show on the Moves tab and do nothing.
  const names = effectiveTagNames({
    moveTagNames: ['Heavy'],
    overrides: [{ action: 'add', tag_name: 'No Damage' }],
  });
  assert.equal(carriesNoDamageTag(names), true);
});

test('a Perk that removes No Damage turns it back off', () => {
  const names = effectiveTagNames({
    moveTagNames: ['No Damage'],
    overrides: [{ action: 'remove', tag_name: 'No Damage' }],
  });
  assert.equal(carriesNoDamageTag(names), false);
});

test('the tag is registered in TAG_HOOKS as a damage suppressor', () => {
  assert.equal(TAG_HOOKS[NO_DAMAGE_TAG].suppressesDamage, true);
  assert.equal(TAG_HOOKS[NO_DAMAGE_TAG].usesSuccessThreshold, true);
});

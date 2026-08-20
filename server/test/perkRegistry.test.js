// The Perk registry's own shape.
//
// **This is the test that matters most in the Perk system**, and it is worth
// saying why up front. A Perk's mechanics bind to its name and are read by
// looking up seam keys on a plain object. That means the single most likely way
// for a Perk to fail is not a wrong answer — it is a **typo**: a definition
// declaring `rollBonuses` or `onGranted` or a trigger called `on_hit` compiles,
// imports, registers, grants, and then does absolutely nothing, quietly, for as
// long as nobody happens to test that exact Perk by hand.
//
// Walking every definition against the known vocabularies turns that whole
// class of failure into a red test the moment the file is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFECYCLE_KEYS,
  META_KEYS,
  PERK_REGISTRY,
  SEAMS,
  isAutomatedPerk,
  perkDefinition,
} from '../perks/index.js';
import { ALL_TRIGGERS, AUTOMATION_TYPES } from '../moveLogic.js';

const definitions = () => Object.values(PERK_REGISTRY);

test('every definition is keyed under its own name', () => {
  for (const [key, definition] of Object.entries(PERK_REGISTRY)) {
    assert.equal(key, definition.name, `${key} is registered under a different name than it carries`);
    assert.ok(definition.name?.trim(), `${key} has no usable name`);
  }
});

test('no definition declares a key the engine does not know how to call', () => {
  const known = new Set([...SEAMS, ...LIFECYCLE_KEYS, ...META_KEYS]);
  for (const definition of definitions()) {
    for (const key of Object.keys(definition)) {
      assert.ok(
        known.has(key),
        `Perk "${definition.name}" declares "${key}", which is not a seam, a lifecycle hook or metadata — ` +
          `a typo here is silent at runtime. Known keys: ${[...known].join(', ')}`
      );
    }
  }
});

test('every declared trigger and automation uses the existing move vocabulary', () => {
  for (const definition of definitions()) {
    for (const [trigger, block] of Object.entries(definition.triggers ?? {})) {
      assert.ok(
        ALL_TRIGGERS.includes(trigger),
        `Perk "${definition.name}" fires on "${trigger}", which is not a trigger`
      );
      assert.ok(Array.isArray(block?.automations), `Perk "${definition.name}"'s ${trigger} has no automations array`);
      for (const automation of block.automations) {
        assert.ok(
          AUTOMATION_TYPES.includes(automation?.type),
          `Perk "${definition.name}"'s ${trigger} uses automation type "${automation?.type}", which does not exist`
        );
      }
      if (block.once !== undefined) {
        assert.ok(
          ['round', 'fight'].includes(block.once),
          `Perk "${definition.name}"'s ${trigger} has once: "${block.once}" — only 'round' and 'fight' reset`
        );
      }
    }
  }
});

test('seam and lifecycle entries are actually callable', () => {
  for (const definition of definitions()) {
    for (const seam of SEAMS) {
      if (definition[seam] === undefined) continue;
      // idleStaminaRegen is a number, not a function — the one seam that is a
      // value rather than a computation.
      if (seam === 'idleStaminaRegen') {
        assert.equal(typeof definition[seam], 'number', `${definition.name}.${seam} must be a number`);
        continue;
      }
      assert.equal(typeof definition[seam], 'function', `${definition.name}.${seam} must be a function`);
    }
    for (const key of LIFECYCLE_KEYS) {
      if (definition[key] === undefined) continue;
      assert.equal(typeof definition[key], 'function', `${definition.name}.${key} must be a function`);
    }
  }
});

// Whether a definition actually asks the engine to do anything.
const declaresMechanics = (definition) =>
  [...SEAMS, ...LIFECYCLE_KEYS].some((key) => definition[key] !== undefined) ||
  Object.keys(definition.triggers ?? {}).length > 0;

test('a definition that declares nothing mechanical is caught', () => {
  // A Perk in the registry but with no seam, no lifecycle hook and no trigger
  // is one that will show the ⚙ badge and do nothing — worse than not being
  // registered at all, because the badge is a promise to the GM.
  //
  // **Unless it says so.** `manual: true` is the deliberate exception: a Perk
  // whose rule the table keeps, registered so it can still be seeded, badged
  // and rename-guarded rather than looking forgotten. The next test is what
  // stops that flag being a way to smuggle a broken Perk past this one.
  for (const definition of definitions()) {
    if (definition.manual) continue;
    assert.ok(
      declaresMechanics(definition),
      `Perk "${definition.name}" is registered but declares no mechanics`
    );
  }
});

test('a manual Perk declares no mechanics at all', () => {
  // The inverse, and the reason `manual` is safe to have. A definition carrying
  // both the flag and a seam is a lie in one direction or the other: either the
  // badge tooltip tells the GM there is nothing to automate while something
  // fires, or a real mechanic sits under a flag saying to ignore it.
  for (const definition of definitions()) {
    if (!definition.manual) continue;
    assert.equal(
      declaresMechanics(definition),
      false,
      `Perk "${definition.name}" is flagged manual but declares mechanics — one of the two is wrong`
    );
  }
});

test('lookup is by name, case-insensitive and whitespace tolerant', () => {
  PERK_REGISTRY['Test-Only Lookup'] = { name: 'Test-Only Lookup', idleStaminaRegen: 2 };
  try {
    assert.equal(perkDefinition('Test-Only Lookup')?.name, 'Test-Only Lookup');
    assert.equal(perkDefinition('  test-only lookup  ')?.name, 'Test-Only Lookup');
    assert.equal(isAutomatedPerk('TEST-ONLY LOOKUP'), true);
    // A Perk the GM invented with no code behind it is the normal case, not an
    // error — it must answer "not automated" rather than throwing.
    assert.equal(perkDefinition('Something The GM Made Up'), null);
    assert.equal(isAutomatedPerk('Something The GM Made Up'), false);
    assert.equal(isAutomatedPerk(null), false);
  } finally {
    delete PERK_REGISTRY['Test-Only Lookup'];
  }
});

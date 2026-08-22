// The Weapon's own arithmetic (decided, new — see server/weapons.js).
//
// Only the two pure pieces live here: whether an attack aimed at a weapon
// breaks it, and how a weapon is shaped when a Roll asks for it. Everything
// else in that module talks to the database and is exercised by the live
// playtest (scripts/playtest-weapons.mjs), which is where the rules that
// matter — 1 Durability per Move, a random Hand against an unarmed target —
// are actually pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_SLOT, weaponBreaks, weaponDie } from '../weapons.js';
import { CONCRETE_ATTACK_TARGET_NAMES, ROLL_SLOT_NAMES, orderConcreteTargets } from '../moveLogic.js';

test('weaponBreaks: beating the weapon outright destroys it', () => {
  assert.equal(weaponBreaks({ attackerTotal: 14, weaponTotal: 9 }), true);
  assert.equal(weaponBreaks({ attackerTotal: 10, weaponTotal: 9 }), true);
});

test('weaponBreaks: a tie holds, because destroying a thing must be earned outright', () => {
  assert.equal(weaponBreaks({ attackerTotal: 9, weaponTotal: 9 }), false);
});

test('weaponBreaks: falling short holds', () => {
  assert.equal(weaponBreaks({ attackerTotal: 3, weaponTotal: 9 }), false);
});

test('weaponDie: a weapon arrives shaped like every other die a Roll sums', () => {
  const die = weaponDie({ character_id: 1, name: 'Machete', die_size: 8, bonus: 2, durability: 3 });
  assert.deepEqual(die, { slot_name: 'Weapon', current_size: 8, bonus: 2, status: 'active' });
});

test('weaponDie: carrying nothing contributes nothing', () => {
  assert.equal(weaponDie(null), null);
  assert.equal(weaponDie(undefined), null);
});

test('the Weapon is a Roll slot and an Attack Target, under one name', () => {
  assert.ok(ROLL_SLOT_NAMES.includes(WEAPON_SLOT), 'a Move can roll it');
  assert.ok(
    CONCRETE_ATTACK_TARGET_NAMES.includes(WEAPON_SLOT),
    'and it survives the round trip through effective_attack_targets'
  );
});

test('orderConcreteTargets: a Hand added after the fact lands in canonical order', () => {
  // The Weapon line's fallback appends its substituted Hand to an
  // already-expanded list; every reader downstream damages Stats in the order
  // it is handed them, so the append has to be put back in place.
  assert.deepEqual(orderConcreteTargets(['Body', 'Left Hand']), ['Left Hand', 'Body']);
  assert.deepEqual(orderConcreteTargets(['Right Hand', 'Skull']), ['Skull', 'Right Hand']);
});

test('orderConcreteTargets: duplicates collapse and unknown names are dropped', () => {
  assert.deepEqual(orderConcreteTargets(['Skull', 'Skull', 'Nose']), ['Skull']);
  assert.deepEqual(orderConcreteTargets([]), []);
  assert.deepEqual(orderConcreteTargets(null), []);
});

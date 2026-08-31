import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  carriesBlockTag,
  carriesFeintTag,
  effectiveTagNames,
  feintMasksDeclaration,
  hardToInterruptAmount,
  hasTagNamed,
  interrupterAmount,
  resolveInterruptContest,
  tagAmount,
  movementBlockedByLegs,
  movementPunisherApplies,
  carriesGroundingTag,
  groundingTripRecoveryTics,
  punishableStat,
  punisherBonus,
  punisherStats,
  TAG_HOOKS,
  PUNISHER_TAG,
  PUNISHER_BONUS,
  GROUNDING_TAG,
  OFF_THE_GROUND_TAG,
  BLOCK_TAG,
  FEINT_TAG,
  HARD_TO_INTERRUPT_TAG,
  INTERRUPTER_TAG,
  MOVEMENT_TAG,
  MOVEMENT_PUNISHER_TAG,
  MOVEMENT_PUNISH_RECOVERY,
} from '../tagAutomations.js';
import { phaseAtTic, resolveBlockStamina } from '../combatDamage.js';
import { clampStaminaModifier } from '../moveLogic.js';

// Block Stamina — the first Tag in the game that does something mechanical.
// Both halves are pinned here: which moves the Tag applies to, and what the
// Stamina arithmetic actually comes out as.

test('the Block Tag is registered and carries its hooks', () => {
  assert.equal(BLOCK_TAG, 'Block');
  assert.equal(TAG_HOOKS[BLOCK_TAG].noStaminaCost, true);
  assert.equal(TAG_HOOKS[BLOCK_TAG].staminaFromAbsorbed, true);
});

test('tag matching is by name, case- and whitespace-insensitive', () => {
  // The GM owns this list and can rename or re-create the tag; matching on
  // ids would silently detach the mechanic.
  assert.equal(carriesBlockTag(['Block']), true);
  assert.equal(carriesBlockTag(['block']), true);
  assert.equal(carriesBlockTag([' Block ']), true);
  assert.equal(carriesBlockTag(['Blocking']), false);
  assert.equal(carriesBlockTag(['Grapple', 'Feint']), false);
  assert.equal(carriesBlockTag([]), false);
  assert.equal(carriesBlockTag(undefined), false);
  assert.equal(hasTagNamed(['Heavy'], 'heavy'), true);
});

test('effectiveTagNames: a Perk can grant or strip the Block Tag for one character', () => {
  const base = ['Heavy'];
  assert.deepEqual(effectiveTagNames({ moveTagNames: base }), ['Heavy']);
  assert.equal(
    carriesBlockTag(effectiveTagNames({ moveTagNames: base, overrides: [{ action: 'add', tag_name: 'Block' }] })),
    true
  );
  assert.equal(
    carriesBlockTag(
      effectiveTagNames({ moveTagNames: ['Block'], overrides: [{ action: 'remove', tag_name: 'Block' }] })
    ),
    false
  );
  // Removal wins over addition, matching effective_tag_ids in server/index.js.
  assert.equal(
    carriesBlockTag(
      effectiveTagNames({
        moveTagNames: [],
        overrides: [{ action: 'add', tag_name: 'Block' }, { action: 'remove', tag_name: 'Block' }],
      })
    ),
    false
  );
  // No duplicates when the template already had what a Perk adds.
  assert.deepEqual(
    effectiveTagNames({ moveTagNames: ['Block'], overrides: [{ action: 'add', tag_name: 'block' }] }),
    ['Block']
  );
});

test('clampStaminaModifier: never 0 or negative', () => {
  assert.equal(clampStaminaModifier(0.5), 0.5);
  assert.equal(clampStaminaModifier(2), 2);
  assert.equal(clampStaminaModifier(0), 1); // unusable, falls back to neutral
  assert.equal(clampStaminaModifier(-3), 1);
  assert.equal(clampStaminaModifier('nonsense'), 1);
  assert.equal(clampStaminaModifier(undefined), 1);
  assert.equal(clampStaminaModifier(0.01), 0.1); // floored, still > 0
  assert.equal(clampStaminaModifier(999), 10);
  assert.equal(clampStaminaModifier(0.333), 0.3); // one decimal place
});

test('resolveBlockStamina: charges what it absorbed, never more than the attack was worth', () => {
  // The user's own example: a 6 met by a 20 is fully negated, and costs 6.
  const r = resolveBlockStamina({ attackerResult: 6, defenderResult: 20, availableStamina: 99 });
  assert.equal(r.absorbed, 6);
  assert.equal(r.staminaCost, 6);
  assert.equal(r.netResult, 0);
  assert.equal(r.outcome, 'full');
  assert.equal(r.capped, false);
});

test('resolveBlockStamina: a guard weaker than the attack costs only what it stopped', () => {
  const r = resolveBlockStamina({ attackerResult: 20, defenderResult: 6, availableStamina: 99 });
  assert.equal(r.absorbed, 6);
  assert.equal(r.staminaCost, 6);
  assert.equal(r.netResult, 14);
  assert.equal(r.halfDamageSteps, 2);
  assert.equal(r.outcome, 'partial');
});

test('resolveBlockStamina: with Stamina to spare the damage math is unchanged from before the rule', () => {
  // netResult must still equal max(0, attacker - defender) in both
  // directions, or this rule would have quietly re-balanced every Block.
  for (const [atk, def] of [[20, 6], [6, 20], [13, 13], [30, 1], [1, 30]]) {
    const r = resolveBlockStamina({ attackerResult: atk, defenderResult: def, availableStamina: 999 });
    assert.equal(r.netResult, Math.max(0, atk - def), `${atk} vs ${def}`);
  }
});

test('resolveBlockStamina: the modifier scales the cost, rounded to nearest', () => {
  assert.equal(resolveBlockStamina({ attackerResult: 7, defenderResult: 9, staminaModifier: 0.5, availableStamina: 99 }).staminaCost, 4); // 3.5 -> 4, ties up
  assert.equal(resolveBlockStamina({ attackerResult: 6, defenderResult: 9, staminaModifier: 0.5, availableStamina: 99 }).staminaCost, 3);
  assert.equal(resolveBlockStamina({ attackerResult: 6, defenderResult: 9, staminaModifier: 2, availableStamina: 99 }).staminaCost, 12);
  // A cheap guard absorbs just as much — only the bill differs.
  assert.equal(resolveBlockStamina({ attackerResult: 6, defenderResult: 9, staminaModifier: 0.5, availableStamina: 99 }).absorbed, 6);
});

test('resolveBlockStamina: the guard only holds as much as it can pay for', () => {
  // Would absorb 20 at ×1, but there are only 5 Stamina left.
  const r = resolveBlockStamina({ attackerResult: 20, defenderResult: 25, staminaModifier: 1, availableStamina: 5 });
  assert.equal(r.capped, true);
  assert.equal(r.absorbed, 5);
  assert.equal(r.staminaCost, 5);
  assert.equal(r.netResult, 15);
  assert.equal(r.halfDamageSteps, 3);
});

test('resolveBlockStamina: a cheap guard stretches the same Stamina further', () => {
  const r = resolveBlockStamina({ attackerResult: 20, defenderResult: 25, staminaModifier: 0.5, availableStamina: 5 });
  assert.equal(r.absorbed, 10); // 5 Stamina buys twice the absorb at x0.5
  assert.equal(r.staminaCost, 5);
  assert.equal(r.netResult, 10);
});

test('resolveBlockStamina: an empty Stamina pool blocks nothing at all', () => {
  const r = resolveBlockStamina({ attackerResult: 20, defenderResult: 25, availableStamina: 0 });
  assert.equal(r.absorbed, 0);
  assert.equal(r.staminaCost, 0);
  assert.equal(r.netResult, 20);
  assert.equal(r.capped, true);
});

test('resolveBlockStamina: a negative roll on either side absorbs nothing and bills nothing', () => {
  const weakAttack = resolveBlockStamina({ attackerResult: -19, defenderResult: 25, availableStamina: 99 });
  assert.equal(weakAttack.absorbed, 0);
  assert.equal(weakAttack.staminaCost, 0);
  assert.equal(weakAttack.netResult, 0); // it was going nowhere anyway
  const weakGuard = resolveBlockStamina({ attackerResult: 20, defenderResult: -4, availableStamina: 99 });
  assert.equal(weakGuard.absorbed, 0);
  assert.equal(weakGuard.staminaCost, 0);
  assert.equal(weakGuard.netResult, 20);
});

test('resolveBlockStamina: the cost never exceeds the Stamina available, at any modifier', () => {
  for (const modifier of [0.1, 0.3, 0.5, 1, 1.5, 2, 3, 7.5, 10]) {
    for (const stamina of [0, 1, 2, 3, 5, 8, 13, 40]) {
      const r = resolveBlockStamina({
        attackerResult: 40,
        defenderResult: 40,
        staminaModifier: modifier,
        availableStamina: stamina,
      });
      assert.ok(
        r.staminaCost <= stamina,
        `modifier ${modifier}, stamina ${stamina} -> cost ${r.staminaCost}`
      );
      assert.ok(r.absorbed >= 0 && r.netResult >= 0);
    }
  }
});


// ---------- Feint (the third Tag automation) ----------
//
// A Feint's own Tell is public. What it changes is the move declared
// immediately after it, which goes on the timeline concealed — no Tell, no
// attack telegraph, no row at all in anyone else's combat payload — until it
// reveals during resolution.

test('the Feint Tag is registered and carries its hook', () => {
  assert.equal(FEINT_TAG, 'Feint');
  assert.equal(TAG_HOOKS[FEINT_TAG].masksNextMove, true);
  // It changes nothing about damage or cost — those belong to the other two.
  assert.equal(TAG_HOOKS[FEINT_TAG].suppressesDamage, undefined);
  assert.equal(TAG_HOOKS[FEINT_TAG].noStaminaCost, undefined);
});

test('the Feint Tag matches by name like the others, and never matches a Block', () => {
  assert.equal(carriesFeintTag(['Feint']), true);
  assert.equal(carriesFeintTag([' feint ']), true);
  assert.equal(carriesFeintTag(['Feinting']), false);
  assert.equal(carriesFeintTag(['Block', 'No Damage']), false);
  assert.equal(carriesFeintTag([]), false);
  assert.equal(carriesFeintTag(undefined), false);
  // And a Perk can grant it for one character, same as any other automation.
  assert.equal(
    carriesFeintTag(effectiveTagNames({ moveTagNames: [], overrides: [{ action: 'add', tag_name: 'feint' }] })),
    true
  );
});

test('feintMasksDeclaration: only the move placed RIGHT AFTER the Feint is hidden', () => {
  const feint = { previousCarriesFeint: true, previousFootprintEndTic: 4 };
  assert.equal(feintMasksDeclaration({ ...feint, placementTic: 4 }), true);
  // Held back by even one Tic: a slower, different thing, and visible.
  assert.equal(feintMasksDeclaration({ ...feint, placementTic: 5 }), false);
  assert.equal(feintMasksDeclaration({ ...feint, placementTic: 9 }), false);
  // Tic 0 is a real Tic, not an absent one — the guard must not treat it as
  // falsy (the same Number()/truthiness trap the Requirement field hit).
  assert.equal(
    feintMasksDeclaration({ previousCarriesFeint: true, previousFootprintEndTic: 0, placementTic: 0 }),
    true
  );
});

test('feintMasksDeclaration: no Feint in front means nothing is hidden', () => {
  assert.equal(feintMasksDeclaration({ previousCarriesFeint: false, previousFootprintEndTic: 4, placementTic: 4 }), false);
  // Nothing declared before it at all — the first move of a round.
  assert.equal(feintMasksDeclaration({ previousCarriesFeint: true, previousFootprintEndTic: null, placementTic: 0 }), false);
  assert.equal(feintMasksDeclaration({ previousCarriesFeint: true, placementTic: 0 }), false);
  assert.equal(feintMasksDeclaration({}), false);
});


// ---------- Interrupter (x) / Hard to Interrupt (x) ----------
//
// The first Tags that carry a NUMBER, and the first that move a comparison
// without moving a roll. Both halves are pinned: how the amount is read out of
// the tag's own name, and which way each Tag pushes the Interruption check.

test('the two Interruption Tags are registered, each on its own side', () => {
  assert.equal(TAG_HOOKS[INTERRUPTER_TAG].parameterised, true);
  assert.equal(TAG_HOOKS[INTERRUPTER_TAG].interruptSide, 'attacker');
  assert.equal(TAG_HOOKS[HARD_TO_INTERRUPT_TAG].parameterised, true);
  assert.equal(TAG_HOOKS[HARD_TO_INTERRUPT_TAG].interruptSide, 'defender');
});

test('tagAmount reads the number out of the tag name', () => {
  assert.equal(tagAmount(['Interrupter (3)'], INTERRUPTER_TAG), 3);
  // Whatever a GM actually types: case, padding, a plus sign, spaces inside
  // the parentheses.
  assert.equal(tagAmount(['  interrupter ( +2 ) '], INTERRUPTER_TAG), 2);
  assert.equal(tagAmount(['INTERRUPTER (10)'], INTERRUPTER_TAG), 10);
});

test('tagAmount: a bare tag counts as 1, and several tags stack', () => {
  assert.equal(tagAmount(['Interrupter'], INTERRUPTER_TAG), 1);
  assert.equal(tagAmount(['Interrupter (2)', 'Interrupter (3)'], INTERRUPTER_TAG), 5);
  assert.equal(tagAmount(['Interrupter', 'Interrupter (2)'], INTERRUPTER_TAG), 3);
});

test('tagAmount: absent, unrelated and near-miss names are all 0', () => {
  assert.equal(tagAmount([], INTERRUPTER_TAG), 0);
  assert.equal(tagAmount(undefined, INTERRUPTER_TAG), 0);
  assert.equal(tagAmount(['Heavy', 'Block'], INTERRUPTER_TAG), 0);
  // The prefix has to match in full — a differently-named tag that merely
  // starts with "Interrupter" is somebody else's tag.
  assert.equal(tagAmount(['Interrupter Killer (9)'], INTERRUPTER_TAG), 0);
  // ...and the two Interruption Tags never read each other's numbers.
  assert.equal(interrupterAmount(['Hard to Interrupt (4)']), 0);
  assert.equal(hardToInterruptAmount(['Interrupter (4)']), 0);
  assert.equal(hardToInterruptAmount(['Hard to Interrupt (4)']), 4);
});

test('resolveInterruptContest: two attack rolls, and the caught fighter wins ties', () => {
  // **The rule this file got wrong once.** It is a contest between the punch's
  // own attack roll and the caught move's own attack roll — the damage the blow
  // dealt is not part of it at all.
  assert.equal(resolveInterruptContest({ attackerRoll: 9, defenderRoll: 8 }).interrupted, true);
  assert.equal(resolveInterruptContest({ attackerRoll: 8, defenderRoll: 9 }).interrupted, false);
  // "Failing means the move is cancelled" — so a draw is not a failure.
  assert.equal(resolveInterruptContest({ attackerRoll: 8, defenderRoll: 8 }).interrupted, false);
  assert.deepEqual(resolveInterruptContest({}), { attackerTotal: 0, defenderTotal: 0, interrupted: false });
});

test('resolveInterruptContest: each Tag pushes its own side, and nothing else', () => {
  // Interrupter (2) turns a punch that came up one short into one that lands.
  const withInterrupter = resolveInterruptContest({ attackerRoll: 8, interrupter: 2, defenderRoll: 9 });
  assert.deepEqual(withInterrupter, { attackerTotal: 10, defenderTotal: 9, interrupted: true });

  // Hard to Interrupt (3) does the same job from the other side.
  const withResistance = resolveInterruptContest({ attackerRoll: 11, defenderRoll: 9, hardToInterrupt: 3 });
  assert.deepEqual(withResistance, { attackerTotal: 11, defenderTotal: 12, interrupted: false });

  // Both at once cancel out exactly, leaving the untagged answer.
  const both = resolveInterruptContest({ attackerRoll: 11, interrupter: 3, defenderRoll: 9, hardToInterrupt: 3 });
  assert.equal(both.interrupted, resolveInterruptContest({ attackerRoll: 11, defenderRoll: 9 }).interrupted);
  assert.equal(both.attackerTotal, 14);
  assert.equal(both.defenderTotal, 12);
});

test('resolveInterruptContest: the elapsed-Active-frame bonus is the caught fighter\'s', () => {
  // The longer the attack has been out, the more of it they have had to read.
  const bare = resolveInterruptContest({ attackerRoll: 10, defenderRoll: 9 });
  assert.equal(bare.interrupted, true);
  const read = resolveInterruptContest({ attackerRoll: 10, defenderRoll: 9, activeFrameBonus: 2 });
  assert.deepEqual(read, { attackerTotal: 10, defenderTotal: 11, interrupted: false });
});

test('resolveInterruptContest: damage plays no part in it', () => {
  // The blow's size is what triggers the check, never what decides it — a
  // leftover from the version of this rule that compared against it.
  const huge = resolveInterruptContest({ attackerRoll: 5, defenderRoll: 9, halfDamageSteps: 99 });
  assert.equal(huge.interrupted, false);
  assert.equal(huge.defenderTotal, 9);
});

// ---------- Movement / Movement Punisher ----------
//
// The first pair of Tags that only mean anything about EACH OTHER. Neither does
// anything alone: Movement is a liability a move admits to, and Movement
// Punisher is the move built to collect on it.

test('both Movement Tags are registered, and point at each other', () => {
  assert.equal(TAG_HOOKS[MOVEMENT_TAG].describesMovement, true);
  assert.equal(TAG_HOOKS[MOVEMENT_PUNISHER_TAG].punishesTag, MOVEMENT_TAG);
  assert.equal(TAG_HOOKS[MOVEMENT_PUNISHER_TAG].imposesRecovery, MOVEMENT_PUNISH_RECOVERY);
  assert.equal(MOVEMENT_PUNISH_RECOVERY, 3);
});

test('a Movement Punisher that connects with a Movement move trips it', () => {
  assert.equal(
    movementPunisherApplies({
      punisherTagNames: ['Movement Punisher'],
      targetTagNames: ['Movement'],
      damageSteps: 1,
    }),
    true
  );
  // Matched by name like every other Tag — case and whitespace tolerant.
  assert.equal(
    movementPunisherApplies({
      punisherTagNames: [' movement punisher '],
      targetTagNames: ['MOVEMENT'],
      damageSteps: 3,
    }),
    true
  );
});

test('all three conditions are required, and "connects" means real damage', () => {
  const base = { punisherTagNames: ['Movement Punisher'], targetTagNames: ['Movement'], damageSteps: 1 };
  // **The interesting one.** A blow a guard reduced to nothing did not catch
  // anybody mid-stride, so it trips nobody — the same floor the rule states as
  // "at least 0.5 damage", which is one half-damage step.
  assert.equal(movementPunisherApplies({ ...base, damageSteps: 0 }), false);
  assert.equal(movementPunisherApplies({ ...base, damageSteps: undefined }), false);
  // The attack has to be a punisher...
  assert.equal(movementPunisherApplies({ ...base, punisherTagNames: ['Block'] }), false);
  assert.equal(movementPunisherApplies({ ...base, punisherTagNames: [] }), false);
  // ...and the target has to actually be moving.
  assert.equal(movementPunisherApplies({ ...base, targetTagNames: ['Block'] }), false);
  assert.equal(movementPunisherApplies({ ...base, targetTagNames: [] }), false);
  // Neither Tag does anything on its own, in either direction.
  assert.equal(movementPunisherApplies({ punisherTagNames: ['Movement'], targetTagNames: ['Movement'], damageSteps: 2 }), false);
  assert.equal(movementPunisherApplies({}), false);
});

// --- A Movement move needs legs to move with -------------------------------

test('movementBlockedByLegs: a broken Leg closes a Movement move', () => {
  const movement = ['Movement'];
  assert.equal(movementBlockedByLegs({ tagNames: movement, legStatuses: ['active', 'active'] }), false);
  assert.equal(movementBlockedByLegs({ tagNames: movement, legStatuses: ['incapacitated', 'active'] }), true);
  // Either leg, not both — footwork on one leg is not footwork.
  assert.equal(movementBlockedByLegs({ tagNames: movement, legStatuses: ['active', 'incapacitated'] }), true);
});

test('movementBlockedByLegs: it closes nothing else', () => {
  // A move without the Tag is untouched however broken its owner is.
  assert.equal(
    movementBlockedByLegs({ tagNames: ['Block', 'Fast'], legStatuses: ['incapacitated', 'incapacitated'] }),
    false
  );
  // And a missing Leg row is not evidence of a break: this refuses moves, so
  // the safe direction is to refuse nothing on absent data.
  assert.equal(movementBlockedByLegs({ tagNames: ['Movement'], legStatuses: [] }), false);
  assert.equal(movementBlockedByLegs({}), false);
});

// --- Grounding: the Tag that writes Trip Recovery frames -------------------

test('the Grounding Tag is registered, and is not Off The Ground', () => {
  // The two are a pair and are easy to confuse: Off The Ground READS trip
  // frames (it may start inside them), Grounding WRITES them.
  assert.ok(TAG_HOOKS[GROUNDING_TAG]?.groundsSelf, 'Grounding grounds its own user');
  assert.ok(TAG_HOOKS[OFF_THE_GROUND_TAG]?.overlapsTripRecovery, 'Off The Ground still only overlaps');
  assert.equal(carriesGroundingTag(['Grounding']), true);
  assert.equal(carriesGroundingTag(['Off The Ground']), false, 'neither Tag is the other');
  assert.equal(carriesGroundingTag(['  grounding ']), true, 'matched by name like every other Tag');
});

test('groundingTripRecoveryTics: ALL of the move\'s Recovery, and none of anyone else\'s', () => {
  // The whole rule: the same frames, the same count, spent on the ground.
  assert.equal(groundingTripRecoveryTics({ tagNames: ['Grounding'], recoveryTics: 3 }), 3);
  assert.equal(groundingTripRecoveryTics({ tagNames: ['Grounding', 'Block'], recoveryTics: 1 }), 1);
  // A move with no Recovery has nothing to convert — Grounding is not a way to
  // acquire frames you did not have.
  assert.equal(groundingTripRecoveryTics({ tagNames: ['Grounding'], recoveryTics: 0 }), 0);
  // Without the Tag it is always 0, so the declare handler can call it
  // unconditionally rather than branching around it.
  assert.equal(groundingTripRecoveryTics({ tagNames: ['Off The Ground'], recoveryTics: 4 }), 0);
  assert.equal(groundingTripRecoveryTics({ tagNames: [], recoveryTics: 4 }), 0);
  assert.equal(groundingTripRecoveryTics({}), 0);
  // Junk in the Recovery column never turns into negative or fractional frames.
  assert.equal(groundingTripRecoveryTics({ tagNames: ['Grounding'], recoveryTics: -2 }), 0);
  assert.equal(groundingTripRecoveryTics({ tagNames: ['Grounding'], recoveryTics: null }), 0);
  assert.equal(groundingTripRecoveryTics({ tagNames: ['Grounding'], recoveryTics: 2.7 }), 2);
});

test('a Grounding move is trip from the first Recovery frame to the last', () => {
  // The count is only half the claim; the other half is WHERE the frames land.
  // phaseAt measures the trip window backwards from the Recovery end, so a
  // whole-window count has to reach all the way back to the Active end.
  const startup = 1, active = 2, recovery = 3;
  const placementTic = 0;
  const revealTic = placementTic + startup;
  const activeEndTic = revealTic + active;
  const recoveryEndTic = activeEndTic + recovery;
  const tripRecoveryTics = groundingTripRecoveryTics({ tagNames: ['Grounding'], recoveryTics: recovery });
  const footprint = { placementTic, revealTic, activeEndTic, recoveryEndTic, tripRecoveryTics };
  for (let tic = activeEndTic; tic < recoveryEndTic; tic++) {
    assert.equal(phaseAtTic(footprint, tic), 'trip_recovery', `Tic ${tic} should be on the floor`);
  }
  // ...and nothing before it moved: the Active frames are still Active.
  assert.equal(phaseAtTic(footprint, activeEndTic - 1), 'active');
  // The same move without the Tag keeps ordinary Recovery throughout.
  const plain = { ...footprint, tripRecoveryTics: 0 };
  for (let tic = activeEndTic; tic < recoveryEndTic; tic++) {
    assert.equal(phaseAtTic(plain, tic), 'recovery');
  }
});

// --- Punisher — (Stat) -----------------------------------------------------

test('the Punisher Tag is registered and reads a STAT out of its name', () => {
  assert.ok(TAG_HOOKS[PUNISHER_TAG]?.parameterisedByStat);
  assert.equal(TAG_HOOKS[PUNISHER_TAG]?.rollBonus, PUNISHER_BONUS);
  // Whatever separator the GM reached for. This is a name a person typed, not
  // a form field — the same tolerance the numbered Tags get.
  for (const written of ['Punisher - Body', 'punisher-body', 'Punisher — Body', 'Punisher: body', 'Punisher (Body)']) {
    assert.deepEqual([...punisherStats([written])], ['Body'], written);
  }
  // Several Tags on one move, read as a set.
  assert.deepEqual([...punisherStats(['Punisher - Hand', 'Punisher - Leg', 'Block'])].sort(), ['Hand', 'Leg']);
});

test('punisherStats drops a Stat the list does not know, rather than half-matching', () => {
  // A Tag that silently punishes nothing is better than one that punishes the
  // wrong thing — and the GM can see the name they typed.
  assert.equal(punisherStats(['Punisher - Stamina']).size, 0, 'Stamina is not on the list');
  assert.equal(punisherStats(['Punisher - Weapon']).size, 0, 'nor is Weapon');
  assert.equal(punisherStats(['Punisher - Bodyy']).size, 0);
  assert.equal(punisherStats(['Punisher']).size, 0, 'a bare Punisher names nothing to punish');
  assert.equal(punisherStats(['Punisher Killer - Body']).size, 0, 'the prefix has to match exactly');
  assert.equal(punisherStats([]).size, 0);
  assert.equal(punisherStats().size, 0);
});

test('punishableStat: Left/Right collapse into the limb, and so does the ambiguous slot', () => {
  // A Punisher names the limb, not the side: what is being punished is somebody
  // throwing hands.
  assert.equal(punishableStat('Left Hand'), 'Hand');
  assert.equal(punishableStat('Right Hand'), 'Hand');
  assert.equal(punishableStat('Hand'), 'Hand');
  assert.equal(punishableStat('Left Leg'), 'Leg');
  assert.equal(punishableStat('Right Leg'), 'Leg');
  assert.equal(punishableStat('Leg'), 'Leg');
  assert.equal(punishableStat('Skull'), 'Skull');
  assert.equal(punishableStat('Brain'), 'Brain');
  assert.equal(punishableStat('Body'), 'Body');
  // Not punishable at all.
  assert.equal(punishableStat('Stamina'), null);
  assert.equal(punishableStat('Weapon'), null);
  assert.equal(punishableStat('Custom'), null);
  assert.equal(punishableStat(null), null);
});

test('punisherBonus: +2 when the Stat is anywhere in what they are throwing', () => {
  // The example from the brief: Punisher - Body against a move rolling
  // (Body + Right Hand + 1).
  assert.deepEqual(
    punisherBonus({ tagNames: ['Punisher - Body'], opponentSlotNames: ['Body', 'Right Hand'] }),
    { amount: 2, stat: 'Body' }
  );
  // Whatever else that move rolls makes no difference — it does not have to be
  // the only Stat, or the first.
  assert.equal(
    punisherBonus({ tagNames: ['Punisher - Hand'], opponentSlotNames: ['Skull', 'Left Hand'] }).amount, 2
  );
  // Nothing matching, nothing on the clock, no Tag at all.
  assert.deepEqual(
    punisherBonus({ tagNames: ['Punisher - Leg'], opponentSlotNames: ['Body', 'Right Hand'] }),
    { amount: 0, stat: null }
  );
  assert.deepEqual(
    punisherBonus({ tagNames: ['Punisher - Body'], opponentSlotNames: [] }),
    { amount: 0, stat: null }
  );
  assert.deepEqual(punisherBonus({ tagNames: ['Block'], opponentSlotNames: ['Body'] }), { amount: 0, stat: null });
  assert.deepEqual(punisherBonus({}), { amount: 0, stat: null });
});

test('punisherBonus: +2 ONCE, however many of its Punishers matched', () => {
  // The move is either punishing what they threw or it is not. The Interruption
  // Tags stack because their whole point is a parameterised amount; this is a
  // condition being met.
  const both = punisherBonus({
    tagNames: ['Punisher - Hand', 'Punisher - Leg'],
    opponentSlotNames: ['Left Hand', 'Right Leg'],
  });
  assert.equal(both.amount, 2, 'not 4');
  // ...and it names the same Stat every time, in the vocabulary's own order
  // rather than the order the opponent happened to roll them in.
  assert.equal(both.stat, 'Hand');
  assert.equal(
    punisherBonus({
      tagNames: ['Punisher - Leg', 'Punisher - Hand'],
      opponentSlotNames: ['Right Leg', 'Left Hand'],
    }).stat,
    'Hand',
    'stable whichever way round either list is written'
  );
});

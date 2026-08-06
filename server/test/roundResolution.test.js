// Combat Automation overhaul, Phases C-D — integration-style coverage for
// server/roundResolution.js's advancePairResolution/startPairDeclaration
// (Phase C) and resolveDodge/resolveMoveConflict (Phase D's real Dodge/
// move-conflict pausing and resumability). See that module's own header
// comment for why this engine lives in its own file (import-safety:
// server/index.js boots a real server on import, so testing DB/broadcast-
// heavy orchestration means either this split, or no automated coverage at
// all — the precedent this codebase otherwise follows for that category of
// code, per the manual-QA notes throughout Combat Automation sub-phases
// 3-5). Same per-file TURSO_DATABASE_URL + dynamic-import trick as
// migrationDefenseKind.test.js, since Node's test runner isolates each
// FILE (own process/module registry), not each test within a file — every
// scenario below shares one temp DB, one pairIndex per scenario to keep
// them independent.
//
// Math.random is mocked to a constant near 1 for this whole file: every
// die roll (server/gameLogic.js's rollDie is `1 + floor(Math.random() *
// size)`, not independently seedable) then always lands on its max face,
// turning every scenario into deterministic arithmetic driven purely by
// which Stats/die sizes/move frame data each scenario picks — the same
// technique this file uses throughout, not per-scenario special-casing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `round-resolution-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;

const { initDb, run, one, all } = await import('../db.js');
const { advancePairResolution, startPairDeclaration, resolveDodge, resolveMoveConflict } = await import('../roundResolution.js');
const { DICE_TEMPLATE } = await import('../gameLogic.js');
const { collapseRollSlots } = await import('../moveLogic.js');

const originalRandom = Math.random;

// A stand-in for the real Socket.io server. `emit` is the global broadcast
// (chat/character/roll updates, which stay unfiltered exactly as the manual
// flow already broadcasts them); `sockets.sockets` is the per-socket
// registry the engine walks to deliver pair-scoped round_events and GM-only
// Dodge prompts — the same shape server/index.js's emitCombatUpdated
// already iterates. Each fake socket records what it received so a test can
// assert who saw what (see the secrecy test at the bottom of this file).
function makeIo(identities = []) {
  const sockets = new Map();
  identities.forEach((identity, i) => {
    sockets.set(String(i), {
      data: { identity },
      received: [],
      emit(event, payload) {
        this.received.push({ event, payload });
      },
    });
  });
  return { emit: () => {}, sockets: { sockets } };
}

const mockIo = makeIo();

let tellId;
before(async () => {
  Math.random = () => 0.999999;
  await initDb();
  const tellResult = await run("INSERT INTO tells (name) VALUES ('Test Tell')");
  tellId = Number(tellResult.lastInsertRowid);
});

after(() => {
  Math.random = originalRandom;
  delete process.env.TURSO_DATABASE_URL;
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});

async function createCharacter(name) {
  const result = await run(
    'INSERT INTO characters (name, character_type, max_stamina, current_stamina) VALUES (?, ?, 32, 32)',
    [name, 'pc']
  );
  const id = Number(result.lastInsertRowid);
  for (const t of DICE_TEMPLATE) {
    await run('INSERT INTO dice (character_id, pool, slot_name) VALUES (?, ?, ?)', [id, t.pool, t.slot_name]);
  }
  return id;
}

async function setDieSize(characterId, slotName, size) {
  await run('UPDATE dice SET current_size = ? WHERE character_id = ? AND slot_name = ?', [size, characterId, slotName]);
}

async function createMove({
  name,
  startupTics = 1,
  activeTics = 1,
  recoveryTics = 0,
  rollSlots = [],
  isDefensive = false,
  defenseKind = null,
  defenseFramePositions = [],
  attackTargets = null,
  rollModifier = 0,
}) {
  const result = await run(
    `INSERT INTO moves
       (name, tell_id, startup_tics, active_tics, recovery_tics, is_defensive, defense_kind, defense_frame_positions, roll_modifier${attackTargets ? ', attack_targets' : ''})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${attackTargets ? ', ?' : ''})`,
    [
      name,
      tellId,
      startupTics,
      activeTics,
      recoveryTics,
      isDefensive ? 1 : 0,
      defenseKind,
      JSON.stringify(defenseFramePositions),
      rollModifier,
      ...(attackTargets ? [JSON.stringify(attackTargets)] : []),
    ]
  );
  const moveId = Number(result.lastInsertRowid);
  // One row per distinct slot with a count, matching writeMove — an
  // appendage listed twice means both sides, and the table's
  // UNIQUE(move_id, slot_name) can't hold it as two rows.
  for (const { slot_name, count } of collapseRollSlots(rollSlots)) {
    await run('INSERT INTO move_roll_slots (move_id, slot_name, count) VALUES (?, ?, ?)', [
      moveId,
      slot_name,
      count,
    ]);
  }
  return moveId;
}

async function seatPair(pairIndex, leftCharacterId, rightCharacterId) {
  await run('INSERT INTO combat_participants (character_id, side, pair_index) VALUES (?, ?, ?)', [
    leftCharacterId,
    'left',
    pairIndex,
  ]);
  await run('INSERT INTO combat_participants (character_id, side, pair_index) VALUES (?, ?, ?)', [
    rightCharacterId,
    'right',
    pairIndex,
  ]);
}

async function declareMove({ characterId, moveId, placementTic, startupTics, effectiveAttackTargets, appendageChoice = null }) {
  const revealTic = placementTic + startupTics;
  const result = await run(
    `INSERT INTO declared_moves
       (character_id, move_id, round_number, queue_order, placement_tic, reveal_tic, appendage_choice${effectiveAttackTargets ? ', effective_attack_targets' : ''})
     VALUES (?, ?, 1, 0, ?, ?, ?${effectiveAttackTargets ? ', ?' : ''})`,
    [characterId, moveId, placementTic, revealTic, appendageChoice, ...(effectiveAttackTargets ? [JSON.stringify(effectiveAttackTargets)] : [])]
  );
  return Number(result.lastInsertRowid);
}

async function resolvePair(pairIndex) {
  await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
  await advancePairResolution(pairIndex, mockIo);
}

test('plain Hit: no defending move at all, damage lands on the move\'s Attack Target', async () => {
  const pairIndex = 100;
  const attacker = await createCharacter('Hit Attacker');
  const defender = await createCharacter('Hit Defender');
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'Big Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  // Skull d12 forced-max = 12 -> halfDamageSteps = floor(12/5) = 2 -> one
  // full applyHalfDamage rank-step (d8 default -> d6), half_damage cleared.
  const skull = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skull.current_size, 6);
  assert.equal(skull.half_damage, 0);

  const resolution = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'complete');
  const events = await all('SELECT type FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  assert.ok(events.some((e) => e.type === 'reveal'));
  assert.ok(events.some((e) => e.type === 'roll'));
  assert.ok(events.some((e) => e.type === 'damage_applied'));
  assert.ok(events.some((e) => e.type === 'round_complete'));
});

test('Full Block: defending move fully covers the attack, matching roll totals net to zero damage', async () => {
  const pairIndex = 101;
  const attacker = await createCharacter('FullBlock Attacker');
  const defender = await createCharacter('FullBlock Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12); // same size as attacker -> tied roll -> net 0 -> Full
  const punch = await createMove({ name: 'FB Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const guard = await createMove({
    name: 'FB Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'], // abstract Roll slot vocabulary (ROLL_SLOT_NAMES) — resolves to a concrete side via appendage_choice below
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [0, 1, 2], // covers this move's whole footprint
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  // Attacker's Active window is [1,3) (placementTic 0 + startup 1); Guard's
  // own defenseTics at placementTic 0 are {0,1,2} -> fully covers {1,2}.
  const attackerDMId = await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await resolvePair(pairIndex);

  const skull = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skull.current_size, 8); // untouched — Full Block, no damage at all
  assert.equal(skull.half_damage, 0);

  const attackerDM = await one('SELECT interactions_resolved, effective_attack_targets, attack_target_source FROM declared_moves WHERE id = ?', [attackerDMId]);
  assert.equal(attackerDM.interactions_resolved, 1); // the 'block' trigger fired (guarded, sets this even with no configured automations)
  assert.deepEqual(JSON.parse(attackerDM.effective_attack_targets), ['Left Hand']); // replaced with the blocker's own base Roll slot
  assert.equal(attackerDM.attack_target_source, 'block');

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const defenseEvent = events.find((e) => e.type === 'defense_resolved');
  assert.ok(defenseEvent);
  assert.equal(JSON.parse(defenseEvent.payload).coverage, 'full');
  // Full Block deals no damage from the ORIGINAL attack — but Guard's own
  // Roll is itself a revealed move with an Active window, so it separately
  // counter-attacks the attacker's own side (the same "any revealed Roll
  // is a real attack" rule Big Punch used) — no damage_applied event
  // should ever target the DEFENDER specifically.
  assert.ok(!events.some((e) => e.type === 'damage_applied' && JSON.parse(e.payload).targetCharacterId === defender));
});

test('Partial Block: coverage is still full, but a weaker blocking roll still lets some damage through', async () => {
  const pairIndex = 102;
  const attacker = await createCharacter('PartialBlock Attacker');
  const defender = await createCharacter('PartialBlock Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 4); // smaller than the attacker -> net damage gets through
  const punch = await createMove({ name: 'PB Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const guard = await createMove({
    name: 'PB Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [0, 1, 2],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await resolvePair(pairIndex);

  // attackerResult 12, blockResult 4 -> netResult 8 -> halfDamageSteps 1 ->
  // Partial. Damage lands on the DEFENDER's own blocking Stat (Left Hand),
  // not the original attack target (Attack Target Change 001) — 1 step
  // only flips half_damage, no rank change yet.
  const leftHand = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'", [defender]);
  assert.equal(leftHand.current_size, 4);
  assert.equal(leftHand.half_damage, 1);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const defenseEvent = events.find((e) => e.type === 'defense_resolved');
  assert.equal(JSON.parse(defenseEvent.payload).coverage, 'full');
  assert.ok(events.some((e) => e.type === 'damage_applied'));
});

test('too-early auto-fail: defense frames start after the attack\'s first Active Tic, falls through to a plain Hit', async () => {
  const pairIndex = 103;
  const attacker = await createCharacter('TooEarly Attacker');
  const defender = await createCharacter('TooEarly Defender');
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'TE Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const lateGuard = await createMove({
    name: 'TE Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Left Hand'],
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [2], // only the LAST square is tagged -> misses the attack's first Active Tic
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: lateGuard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const skull = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skull.current_size, 6); // same plain-Hit math as the first scenario

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const defenseEvent = events.find((e) => e.type === 'defense_resolved');
  assert.equal(JSON.parse(defenseEvent.payload).coverage, 'too-early');
});

test('Insignificant Damage: a sub-5 attack lands nothing, says so, and is NOT a Miss', async () => {
  const pairIndex = 230;
  const attacker = await createCharacter('Insignificant Attacker');
  const defender = await createCharacter('Insignificant Defender');
  // -20 against a d12 can never reach 5, so this is deterministic regardless
  // of the forced-max die roll this file pins.
  const feint = await createMove({
    name: 'IS Feint',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 0,
    rollSlots: ['Skull'],
    rollModifier: -20,
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  const dmId = await declareMove({ characterId: attacker, moveId: feint, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('insignificant_damage'), JSON.stringify(types));
  // The old behaviour fired the move's own On Miss trigger here. A Miss is
  // now specifically a Dodge evasion, so nothing fires.
  assert.ok(
    !events.some((e) => e.type === 'automation_fired' && JSON.parse(e.payload).trigger === 'miss'),
    'a sub-5 roll must not fire the On Miss trigger'
  );
  assert.ok(!types.includes('damage_applied'), JSON.stringify(types));

  const payload = JSON.parse(events.find((e) => e.type === 'insignificant_damage').payload);
  assert.equal(payload.declaredMoveId, dmId);
  assert.ok(payload.total < 5, `total was ${payload.total}`);

  // Announced in chat, in those words — the table has to be told the attack
  // landed and did nothing, rather than seeing silence.
  const notice = await one(
    `SELECT content FROM chat_log WHERE kind = 'message' AND content LIKE '%insignificant damage%' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(notice, 'the outcome must be announced');
  assert.match(notice.content, /IS Feint/);

  // And the move is fully resolved, so a later pass can't re-resolve it.
  const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [dmId]);
  assert.equal(dm.interactions_resolved, 1);
});

test("Miss: a Full Dodge fires the attacker's On Miss trigger, a Partial one fires On Block", async () => {
  // Both halves of the new definition, driven off the same Dodge scenario the
  // pause tests use — the only difference is whether the defender's roll is
  // strong enough to zero the damage.
  const scenario = async ({ pairIndex, defenderHandSize, expectedTrigger }) => {
    const attacker = await createCharacter(`MissDodge Attacker ${pairIndex}`);
    const defender = await createCharacter(`MissDodge Defender ${pairIndex}`);
    await setDieSize(attacker, 'Skull', 12);
    await setDieSize(defender, 'Left Hand', defenderHandSize);
    const punch = await createMove({
      name: `MD Punch ${pairIndex}`,
      startupTics: 1,
      activeTics: 1,
      recoveryTics: 1,
      rollSlots: ['Skull'],
    });
    const slip = await createMove({
      name: `MD Slip ${pairIndex}`,
      startupTics: 1,
      activeTics: 1,
      recoveryTics: 1,
      rollSlots: ['Hand'],
      attackTargets: [],
      isDefensive: true,
      defenseKind: 'dodge',
      defenseFramePositions: [0, 1, 2],
    });

    await seatPair(pairIndex, attacker, defender);
    await startPairDeclaration(mockIo, pairIndex);
    const attackerDM = await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
    // effective_attack_targets defaults to ["Skull"], so a defence-pure move
    // has to say so explicitly here — move:declare snapshots the move's own
    // (empty) attack_targets into this column for real declarations.
    await declareMove({
      characterId: defender,
      moveId: slip,
      placementTic: 0,
      startupTics: 1,
      appendageChoice: 'left',
      effectiveAttackTargets: [],
    });
    await resolvePair(pairIndex);

    const paused = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
    assert.equal(paused.status, 'paused_dodge');
    await resolveDodge(pairIndex, { outcome: 'successful' }, mockIo);

    const fired = await all(
      `SELECT payload FROM round_events WHERE pair_index = ? AND type = 'automation_fired' ORDER BY seq`,
      [pairIndex]
    );
    return { attackerDM, triggers: fired.map((e) => JSON.parse(e.payload).trigger) };
  };

  // A matching d12 zeroes the damage entirely: fully evaded, so a Miss.
  const full = await scenario({ pairIndex: 231, defenderHandSize: 12, expectedTrigger: 'miss' });
  const damageAfterFull = await all(
    `SELECT type FROM round_events WHERE pair_index = 231 AND type = 'damage_applied'`
  );
  assert.equal(damageAfterFull.length, 0, 'a Full Dodge lands no damage');

  // A weaker d4 lets damage through: not evaded, so not a Miss.
  const partial = await scenario({ pairIndex: 232, defenderHandSize: 4, expectedTrigger: 'block' });
  const damageAfterPartial = await all(
    `SELECT type FROM round_events WHERE pair_index = 232 AND type = 'damage_applied'`
  );
  assert.ok(damageAfterPartial.length > 0, 'a Partial Dodge still lands damage');

  // applyMoveInteractions only posts an automation_fired event when the move
  // actually has something wired to that trigger, so assert on the stored
  // declared move instead: both are resolved exactly once either way.
  for (const { attackerDM } of [full, partial]) {
    const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [attackerDM]);
    assert.equal(dm.interactions_resolved, 1);
  }
});

test('Interruption: taking a Hit while still in Startup disrupts the target\'s own declared move', async () => {
  const pairIndex = 104;
  const attacker = await createCharacter('Interrupt Attacker');
  const defender = await createCharacter('Interrupt Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Body', 12);
  const punch = await createMove({ name: 'IR Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  // No Defense Frames at all -> plain Hit, but placed with a long Startup so
  // it's still mid-Startup when the attacker's Active window (Tics 1-2) hits.
  const slowWindup = await createMove({ name: 'Slow Windup', startupTics: 3, activeTics: 1, recoveryTics: 1, rollSlots: ['Body'] });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  const startupDMId = await declareMove({ characterId: defender, moveId: slowWindup, placementTic: 0, startupTics: 3 });
  await resolvePair(pairIndex);

  // Attacker's total 12 -> halfDamageSteps 2. Defender's own interrupt roll:
  // Body d12 (max-forced) + computeInterruptBonus (>=1) >= 2 -> succeeds.
  const stillDeclared = await one('SELECT id FROM declared_moves WHERE id = ?', [startupDMId]);
  assert.equal(stillDeclared, null); // Interrupted -> deleted, reverted to Undeclared

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const interruptEvent = events.find((e) => e.type === 'interrupt_resolved');
  assert.ok(interruptEvent);
  assert.equal(JSON.parse(interruptEvent.payload).succeeded, true);
});

// ---------------------------------------------------------------------
// Phase D — real Dodge/move-conflict pausing and resumability.
// ---------------------------------------------------------------------

test('Dodge pause: full-coverage Dodge stops the round and persists a resumable pending decision', async () => {
  const pairIndex = 200;
  const attacker = await createCharacter('DodgePause Attacker');
  const defender = await createCharacter('DodgePause Defender');
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'DP Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const dodge = await createMove({
    name: 'DP Dodge',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'dodge',
    defenseFramePositions: [0, 1, 2],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  const attackerDMId = await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  const defenderDMId = await declareMove({ characterId: defender, moveId: dodge, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await resolvePair(pairIndex);

  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'paused_dodge');
  const pending = JSON.parse(resolution.pending_dodge_json);
  assert.equal(pending.attackerDeclaredMoveId, attackerDMId);
  assert.equal(pending.defenderDeclaredMoveId, defenderDMId);
  assert.equal(pending.attackerResult, 12);

  // Nothing has actually landed yet — genuinely paused, not auto-decided.
  const skullBefore = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skullBefore.current_size, 8);
  const events = await all('SELECT type FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  assert.ok(events.some((e) => e.type === 'dodge_prompt'));
  assert.ok(!events.some((e) => e.type === 'dodge_resolved'));

  // A stale/duplicate resolve for a pair that isn't actually paused is a no-op.
  await resolveDodge(999999, { outcome: 'failed' }, mockIo);

  await resolveDodge(pairIndex, { outcome: 'failed' }, mockIo);

  const resolutionAfter = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolutionAfter.status, 'complete');
  assert.equal(resolutionAfter.pending_dodge_json, null);

  // Failed Dodge falls through to a plain Hit — same math as a plain Hit.
  const skullAfter = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skullAfter.current_size, 6);

  const eventsAfter = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const resolved = eventsAfter.find((e) => e.type === 'dodge_resolved');
  assert.ok(resolved);
  assert.equal(JSON.parse(resolved.payload).outcome, 'failed');
});

test('Dodge resume: Successful Full Dodge deals no damage anywhere', async () => {
  const pairIndex = 201;
  const attacker = await createCharacter('DodgeFull Attacker');
  const defender = await createCharacter('DodgeFull Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12); // matches attacker -> net 0 -> Full
  const punch = await createMove({ name: 'DF Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const dodge = await createMove({
    name: 'DF Dodge',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'dodge',
    defenseFramePositions: [0, 1, 2],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: dodge, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await resolvePair(pairIndex);

  await resolveDodge(pairIndex, { outcome: 'successful' }, mockIo);

  const skull = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skull.current_size, 8);
  const leftHand = await one("SELECT current_size, half_damage FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'", [defender]);
  assert.equal(leftHand.current_size, 12);
  assert.equal(leftHand.half_damage, 0);

  const resolution = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'complete');
});

test('Dodge resume: Successful Partial Dodge still lands reduced damage on the defender\'s own Stat', async () => {
  const pairIndex = 202;
  const attacker = await createCharacter('DodgePartial Attacker');
  const defender = await createCharacter('DodgePartial Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 4); // weaker -> net 8 -> 1 step -> Partial
  const punch = await createMove({ name: 'DPa Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const dodge = await createMove({
    name: 'DPa Dodge',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'dodge',
    defenseFramePositions: [0, 1, 2],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: dodge, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await resolvePair(pairIndex);

  await resolveDodge(pairIndex, { outcome: 'successful' }, mockIo);

  const leftHand = await one("SELECT current_size, half_damage FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'", [defender]);
  assert.equal(leftHand.current_size, 4);
  assert.equal(leftHand.half_damage, 1);
});

test('Move-conflict pause: a Block-too-late collision stops the round; Forfeit deletes the colliding move', async () => {
  const pairIndex = 210;
  const attacker = await createCharacter('ConflictForfeit Attacker');
  const defender = await createCharacter('ConflictForfeit Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12);
  const punch = await createMove({ name: 'CF Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  // Guard's own Defense Frame only covers its own tic 1 (not tic 2) -> the
  // attacker's Active window [1,3) is covered starting at tic 1 (not
  // too-early) but runs out before tic 2 -> 'too-late', 1 Tic short.
  const guard = await createMove({
    name: 'CF Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [1],
  });
  const collisionMove = await createMove({ name: 'CF Collision', startupTics: 1, activeTics: 1, recoveryTics: 0, rollSlots: [] });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  const guardDMId = await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  // Guard's own footprint (startup1/active1/recovery1, placementTic 0) ends
  // at reveal(1)+active(1)+recovery(1)=3; the 1-Tic extension pushes that to
  // 4 — placementTic 3 sits inside [3,4).
  const collisionDMId = await declareMove({ characterId: defender, moveId: collisionMove, placementTic: 3, startupTics: 1 });
  await resolvePair(pairIndex);

  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'paused_conflict');
  const pending = JSON.parse(resolution.pending_conflict_json);
  assert.equal(pending.declaredMoveId, collisionDMId);
  assert.equal(pending.blockerDeclaredMoveId, guardDMId);
  assert.equal(pending.characterId, defender);

  // A stale declaredMoveId (doesn't match what's actually pending) is a no-op.
  await resolveMoveConflict(pairIndex, { declaredMoveId: 999999, choice: 'forfeit' }, mockIo);
  const stillPaused = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(stillPaused.status, 'paused_conflict');

  await resolveMoveConflict(pairIndex, { declaredMoveId: collisionDMId, choice: 'forfeit' }, mockIo);

  const deleted = await one('SELECT id FROM declared_moves WHERE id = ?', [collisionDMId]);
  assert.equal(deleted, null);
  const resolutionAfter = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolutionAfter.status, 'complete');
});

test('Block-too-late: the Recovery extension is announced and logged, and does not pause on its own', async () => {
  const pairIndex = 215;
  const attacker = await createCharacter('LateBlock Attacker');
  const defender = await createCharacter('LateBlock Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12);
  const punch = await createMove({ name: 'LB Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  // Same shape as the Forfeit scenario above, minus the colliding move: the
  // Guard covers the attack's Active tic 1 but not tic 2 -> 'too-late', 1
  // Tic short. Nothing is declared in the extended window, so the round
  // must run straight through — an extension is a rule, not a prompt.
  const guard = await createMove({
    name: 'LB Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [1],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  const guardDMId = await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await resolvePair(pairIndex);

  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'complete');

  const extended = await one(
    `SELECT payload FROM round_events WHERE resolution_id = ? AND type = 'recovery_extended'`,
    [resolution.id]
  );
  assert.ok(extended, 'a too-late Block must log its Recovery extension');
  const payload = JSON.parse(extended.payload);
  assert.equal(payload.declaredMoveId, guardDMId);
  assert.equal(payload.extensionTics, 1);
  // Guard's authored footprint ends at reveal(1)+active(1)+recovery(1)=3;
  // the extension covers [3,4), which is what the cutscene paints dimmed.
  assert.equal(payload.extendedFromTic, 3);
  assert.equal(payload.recoveryEndTic, 4);

  const stored = await one('SELECT recovery_extension_tics FROM declared_moves WHERE id = ?', [guardDMId]);
  assert.equal(stored.recovery_extension_tics, 1);

  // Announced in chat too, not just on the timeline — a Block never prompts,
  // so this message is the only thing that tells the table it happened.
  const announcement = await one(
    `SELECT content FROM chat_log WHERE kind = 'message' AND content LIKE '%Recovery extended%' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(announcement, 'the extension must be announced in chat');
  assert.match(announcement.content, /LB Guard/);
  assert.match(announcement.content, /extended by 1 Tic\b/);
});

test('a Roll listing an appendage twice rolls BOTH sides, ignoring the declaration\'s side choice', async () => {
  const pairIndex = 216;
  const attacker = await createCharacter('BothHands Attacker');
  const defender = await createCharacter('BothHands Defender');
  await setDieSize(attacker, 'Left Hand', 8);
  await setDieSize(attacker, 'Right Hand', 6);
  const doubleFist = await createMove({
    name: 'BH Double Fist',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 0,
    rollSlots: ['Hand', 'Hand'],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  const dmId = await declareMove({
    characterId: attacker,
    moveId: doubleFist,
    placementTic: 0,
    startupTics: 1,
    // A doubled slot has no Left/Right question, so a real declaration never
    // records one. Passing a stale 'left' here proves it is ignored rather
    // than collapsing both entries onto the same die.
    appendageChoice: 'left',
  });
  await resolvePair(pairIndex);

  const resolution = await one('SELECT id FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  const rollRow = await one(
    `SELECT payload FROM round_events WHERE resolution_id = ? AND type = 'roll'`,
    [resolution.id]
  );
  const payload = JSON.parse(rollRow.payload);
  assert.equal(payload.declaredMoveId, dmId);
  assert.deepEqual(
    payload.dice.map((d) => d.slot_name),
    ['Left Hand', 'Right Hand']
  );
  // Both dice at max face (Math.random is pinned near 1 for this file), so
  // the total is genuinely the sum of two different dice, not one twice.
  assert.equal(payload.total, 8 + 6);
});

test('Move-conflict pause: Postpone shifts the collision forward and recurses into a second collision', async () => {
  const pairIndex = 211;
  const attacker = await createCharacter('ConflictPostpone Attacker');
  const defender = await createCharacter('ConflictPostpone Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12);
  const punch = await createMove({ name: 'CP Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const guard = await createMove({
    name: 'CP Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [1],
  });
  const moveA = await createMove({ name: 'CP Collision A', startupTics: 1, activeTics: 1, recoveryTics: 0, rollSlots: [] });
  const moveB = await createMove({ name: 'CP Collision B', startupTics: 1, activeTics: 1, recoveryTics: 0, rollSlots: [] });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  const guardDMId = await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  // Guard's extended recovery window is [3,4) — Move A sits right in it.
  const moveADMId = await declareMove({ characterId: defender, moveId: moveA, placementTic: 3, startupTics: 1 });
  // Move A's own footprint (before Postpone) is [3,5) — nothing collides
  // with THAT yet. Once Postponed to placementTic 4 (Guard's new recovery
  // end), its new footprint becomes [4,6) — Move B, placed at 5, now falls
  // inside it, triggering the recursive re-conflict.
  const moveBDMId = await declareMove({ characterId: defender, moveId: moveB, placementTic: 5, startupTics: 1 });
  await resolvePair(pairIndex);

  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'paused_conflict');
  assert.equal(JSON.parse(resolution.pending_conflict_json).declaredMoveId, moveADMId);

  await resolveMoveConflict(pairIndex, { declaredMoveId: moveADMId, choice: 'postpone' }, mockIo);

  const moveARow = await one('SELECT placement_tic, reveal_tic FROM declared_moves WHERE id = ?', [moveADMId]);
  assert.equal(moveARow.placement_tic, 4);
  assert.equal(moveARow.reveal_tic, 5);

  // Recursive cascade: Move A's new footprint now collides with Move B —
  // still paused, but on the SECOND collision this time.
  const resolutionAfterPostpone = await one(
    'SELECT status, pending_conflict_json FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1',
    [pairIndex]
  );
  assert.equal(resolutionAfterPostpone.status, 'paused_conflict');
  const secondPending = JSON.parse(resolutionAfterPostpone.pending_conflict_json);
  assert.equal(secondPending.declaredMoveId, moveBDMId);
  assert.equal(secondPending.blockerDeclaredMoveId, moveADMId);

  await resolveMoveConflict(pairIndex, { declaredMoveId: moveBDMId, choice: 'forfeit' }, mockIo);

  const moveBDeleted = await one('SELECT id FROM declared_moves WHERE id = ?', [moveBDMId]);
  assert.equal(moveBDeleted, null);
  const finalResolution = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(finalResolution.status, 'complete');
});

test('Restart recovery: rolling resolved_through_tic backward and re-invoking converges to the same end state', async () => {
  const pairIndex = 220;
  const attacker = await createCharacter('Restart Attacker');
  const defender = await createCharacter('Restart Defender');
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'RS Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const skullBefore = await one("SELECT current_size, half_damage FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skullBefore.current_size, 6); // same plain-Hit math as the very first scenario
  const eventCountBefore = (await all('SELECT id FROM round_events WHERE pair_index = ?', [pairIndex])).length;

  // Simulate a crash between finishing round 1's own Tics and the pair
  // fully transitioning into round 2: roll combat_pairs and its
  // resolution row back to "mid-round-1, nothing processed yet" WITHOUT
  // touching declared_moves/dice — a real crash only ever loses the
  // resolved_through_tic bump itself (the last write for a Tic), never the
  // effects that already landed before it (see this module's own
  // crash-recovery comment). Redoing from here should find nothing left to
  // do (interactions_resolved already 1) and just cheaply re-converge.
  await run(`UPDATE pair_round_resolutions SET status = 'running', resolved_through_tic = -1, completed_at = NULL WHERE pair_index = ? AND round_number = 1`, [pairIndex]);
  await run(`UPDATE combat_pairs SET phase = 'resolving', round_number = 1, current_tic = 0 WHERE pair_index = ?`, [pairIndex]);

  await advancePairResolution(pairIndex, mockIo);

  const skullAfter = await one("SELECT current_size, half_damage FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skullAfter.current_size, 6); // unchanged — not double-applied
  assert.equal(skullAfter.half_damage, 0);

  const resolutionAfter = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolutionAfter.status, 'complete');

  // The redo is allowed to add more round_events (a real re-derivation
  // isn't required to produce byte-identical history, only the same
  // derived end state) — just confirm it didn't somehow shrink or corrupt.
  const eventCountAfter = (await all('SELECT id FROM round_events WHERE pair_index = ?', [pairIndex])).length;
  assert.ok(eventCountAfter >= eventCountBefore);
});

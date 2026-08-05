// Combat Automation overhaul, Phase C — integration-style coverage for
// server/roundResolution.js's advancePairResolution/startPairDeclaration.
// See that module's own header comment for why this engine lives in its
// own file (import-safety: server/index.js boots a real server on import,
// so testing DB/broadcast-heavy orchestration means either this split, or
// no automated coverage at all — the precedent this codebase otherwise
// follows for that category of code, per the manual-QA notes throughout
// Combat Automation sub-phases 3-5). Same per-file TURSO_DATABASE_URL +
// dynamic-import trick as migrationDefenseKind.test.js, since Node's test
// runner isolates each FILE (own process/module registry), not each test
// within a file — every scenario below shares one temp DB, one pairIndex
// per scenario to keep them independent.
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
const { advancePairResolution, startPairDeclaration } = await import('../roundResolution.js');
const { DICE_TEMPLATE } = await import('../gameLogic.js');

const originalRandom = Math.random;
const mockIo = { emit: () => {} };

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
}) {
  const result = await run(
    `INSERT INTO moves
       (name, tell_id, startup_tics, active_tics, recovery_tics, is_defensive, defense_kind, defense_frame_positions${attackTargets ? ', attack_targets' : ''})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?${attackTargets ? ', ?' : ''})`,
    [
      name,
      tellId,
      startupTics,
      activeTics,
      recoveryTics,
      isDefensive ? 1 : 0,
      defenseKind,
      JSON.stringify(defenseFramePositions),
      ...(attackTargets ? [JSON.stringify(attackTargets)] : []),
    ]
  );
  const moveId = Number(result.lastInsertRowid);
  for (const slot of rollSlots) {
    await run('INSERT INTO move_roll_slots (move_id, slot_name) VALUES (?, ?)', [moveId, slot]);
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

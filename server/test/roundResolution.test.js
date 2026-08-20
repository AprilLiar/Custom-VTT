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
    // d8 explicitly, not the schema default. Every scenario below is
    // hand-computed arithmetic against a d8 baseline (a 2-step hit takes a
    // d8 to d6), so the starting size has to be a property of the test
    // rather than of `dice.current_size`'s default — that default is a
    // *game* decision (Character Creation starts every Stat at d4) and is
    // free to change again without silently rewriting what these tests mean.
    await run('INSERT INTO dice (character_id, pool, slot_name, current_size) VALUES (?, ?, ?, 8)', [
      id,
      t.pool,
      t.slot_name,
    ]);
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
  interactions = null, // [{ trigger, text, automations }]
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
  for (const row of interactions ?? []) {
    await run('INSERT INTO move_interactions (move_id, trigger, text, automations) VALUES (?, ?, ?, ?)', [
      moveId,
      row.trigger,
      row.text ?? '',
      JSON.stringify(row.automations ?? []),
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

// The bug behind "Block still does not work — it was not rolled at all when
// it was placed on the same tic as an opponent's attack". Placing a Block on
// the attack's own Tic is not what makes it defend: what matters is where its
// Defense Frames land. A frame on square 0 is the Block's *Startup* Tic,
// which sits a Tic BEFORE the attacker's Active window opens (the attacker
// has its own Startup too), so there is no overlap for classifyDefenseCoverage
// to classify — and the engine used to fall straight through to a plain Hit
// in complete silence, which is indistinguishable from the Block being
// ignored. It must say so instead. It must also still roll the defender's
// dice into the timeline in the cases where a defence DOES engage — asserted
// separately below, since that half was invisible for the same report.
test('no-overlap: Defense Frames that never reach the attack are reported, not silently skipped', async () => {
  const pairIndex = 240;
  const attacker = await createCharacter('NoOverlap Attacker');
  const defender = await createCharacter('NoOverlap Defender');
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'NO Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const earlyGuard = await createMove({
    name: 'NO Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Left Hand'],
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [0], // the Block's own Startup square — Tic 0, a Tic before the attack goes Active
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  // Both placed at the SAME Tic — exactly the case that was reported broken.
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: earlyGuard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const defenseEvent = events.find((e) => e.type === 'defense_resolved');
  assert.ok(defenseEvent, 'a defence with frames that miss must still report itself');
  const payload = JSON.parse(defenseEvent.payload);
  assert.equal(payload.coverage, 'no-overlap');
  assert.equal(payload.defenseType, null);
  assert.deepEqual(payload.defenseTics, [0]); // guarding Tic 0
  assert.equal(payload.attackActiveStart, 1); // attack is Active from Tic 1 — hence the miss
  // The rule itself is unchanged: no defence engaged, so the attack lands in
  // full, same as the plain-Hit scenario at the top of this file.
  const skull = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skull.current_size, 6);
});

test('a defending roll appears on the timeline, not only in the chat log', async () => {
  const pairIndex = 241;
  const attacker = await createCharacter('DefRoll Attacker');
  const defender = await createCharacter('DefRoll Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12);
  const punch = await createMove({ name: 'DR Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const guard = await createMove({
    name: 'DR Guard',
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

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const defensiveRolls = events
    .filter((e) => e.type === 'roll')
    .map((e) => JSON.parse(e.payload))
    .filter((p) => p.defensive);
  assert.equal(defensiveRolls.length, 1, 'the Block rolled, so the cutscene must show it rolling');
  assert.equal(defensiveRolls[0].characterId, defender);
  assert.equal(defensiveRolls[0].defenseType, 'block');
  assert.ok(defensiveRolls[0].dice.length > 0);
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
  // A Miss is specifically an attack evaded with a Dodge. A weak swing
  // still connected, so On Miss must never fire for it.
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

test('Dodge is binary: a successful Dodge always fully evades and always fires On Miss', async () => {
  // Rewritten (decided, revised): Dodge used to run Block's opposed math and
  // could come out "Partial" — damage through, and the attacker's **On Block**
  // trigger instead of On Miss. There is no third outcome any more, so the
  // sharpest version of this test runs the SAME scenario at two wildly
  // different defender die sizes and asserts the result is identical: the
  // dodger's dice cannot matter, because they are no longer rolled.
  const scenario = async ({ pairIndex, defenderHandSize }) => {
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
      // BOTH triggers wired, so "fires miss and not block" is observable in
      // automation_fired rather than inferred from interactions_resolved.
      interactions: [
        { trigger: 'miss', text: 'whiffed', automations: [{ type: 'self_stamina_loss', amount: 1 }] },
        { trigger: 'block', text: 'guarded', automations: [{ type: 'self_stamina_loss', amount: 1 }] },
      ],
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

  // A big defender die and a tiny one must produce the same outcome. Under
  // the old opposed math the d4 case was the "Partial Dodge" that leaked
  // damage and fired On Block; it is now indistinguishable from the d12.
  const strong = await scenario({ pairIndex: 231, defenderHandSize: 12 });
  const weak = await scenario({ pairIndex: 232, defenderHandSize: 4 });

  for (const [label, pairIndex, result] of [
    ['a well-rolled dodge', 231, strong],
    ['a dodge by someone with a d4', 232, weak],
  ]) {
    const damage = await all(
      `SELECT type FROM round_events WHERE pair_index = ? AND type = 'damage_applied'`,
      [pairIndex]
    );
    assert.equal(damage.length, 0, `${label} lands no damage at all`);
    assert.deepEqual(
      result.triggers.filter((t) => t === 'miss' || t === 'block'),
      ['miss'],
      `${label} fires On Miss and never On Block`
    );
    const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [result.attackerDM]);
    assert.equal(dm.interactions_resolved, 1, `${label} resolves the attack exactly once`);
  }

  // And the dodger takes nothing — the old Partial path applied damage to the
  // defender's OWN Stat, which is the half that showed up in play as "a
  // successful dodge still hurt me".
  const defenderDamage = await all(
    `SELECT payload FROM round_events WHERE pair_index IN (231, 232) AND type = 'damage_applied'`
  );
  assert.equal(defenderDamage.length, 0);
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
  // The move announces itself as an anonymous wind-up when its Startup
  // begins, so the cutscene has a bar standing there before the reveal Tic
  // (and, here, before it is Interrupted instead of ever revealing).
  const windups = events.filter((e) => e.type === 'windup').map((e) => JSON.parse(e.payload));
  const windup = windups.find((w) => w.declaredMoveId === startupDMId);
  assert.ok(windup, 'the 3-Tic Startup should have emitted a windup');
  assert.equal(windup.placementTic, 0);
  assert.equal(windup.revealTic, 3);
  assert.equal(windup.characterId, defender);
  // Nothing about the move itself is in the row: not its id, its name, nor
  // how long its Active/Recovery run. A stored replay is public to anyone,
  // so the safe version is to not carry the secret at all rather than to
  // carry it and ask the client to hide it.
  assert.equal(windup.moveId, undefined);
  assert.equal(windup.moveName, undefined);
  assert.equal(windup.activeEndTic, undefined);
  assert.equal(windup.recoveryEndTic, undefined);
  // The attacker's own move has 1 Tic of Startup and so gets one too, but
  // never twice — processTic is re-entrant and must not restack them.
  assert.equal(new Set(windups.map((w) => w.declaredMoveId)).size, windups.length);

  const interruptEvent = events.find((e) => e.type === 'interrupt_resolved');
  assert.ok(interruptEvent);
  const interruptPayload = JSON.parse(interruptEvent.payload);
  assert.equal(interruptPayload.interrupted, true);
  // The payload must be self-contained enough to DRAW the killed move: it is
  // deleted immediately above, so a cutscene one beat later — let alone a
  // replay days later — has no row left to look up. Without this an
  // Interrupted move left no trace on the board at all, since it dies in
  // Startup and therefore never reveals.
  assert.equal(interruptPayload.declaredMoveId, startupDMId);
  assert.equal(interruptPayload.characterId, defender);
  assert.equal(interruptPayload.placementTic, 0);
  assert.equal(interruptPayload.revealTic, 3);
  assert.ok(interruptPayload.recoveryEndTic > interruptPayload.revealTic);
  // The move's NAME is deliberately absent: it never reached its reveal Tic,
  // and a replay is public to anyone, so naming it here would disclose a
  // move its owner never had to show.
  assert.equal(interruptPayload.moveName, undefined);
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

test('Dodge resume: a weak dodger takes NOTHING — there is no Partial Dodge', async () => {
  // Inverted from what it asserted before (decided, revised). This exact
  // fixture — a d12 attack against a d4 dodger — was the "Partial Dodge" that
  // shaved the defender's own die despite the GM having called the dodge
  // successful. Kept as the regression guard for that behaviour being gone,
  // rather than deleted, because it is the precise shape the bug had.
  const pairIndex = 202;
  const attacker = await createCharacter('DodgePartial Attacker');
  const defender = await createCharacter('DodgePartial Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 4); // would have been net 8 -> 1 step
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
  assert.equal(leftHand.current_size, 4, 'the dodger\'s own die is untouched');
  assert.equal(leftHand.half_damage, 0, 'and takes no half-damage step either');
  const damage = await all(
    `SELECT type FROM round_events WHERE pair_index = ? AND type = 'damage_applied'`,
    [pairIndex]
  );
  assert.equal(damage.length, 0, 'no damage event is recorded at all');
});

test('Move-conflict pause: a Block extension collision stops the round; Forfeit deletes the colliding move', async () => {
  const pairIndex = 210;
  const attacker = await createCharacter('ConflictForfeit Attacker');
  const defender = await createCharacter('ConflictForfeit Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12);
  const punch = await createMove({ name: 'CF Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  // Guard's own Defense Frame only covers its own tic 1 (not tic 2) -> the
  // attacker's Active window [1,3) is covered starting at tic 1 (not
  // too-early) but runs out before tic 2 -> 'too-short', 1 Tic short.
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

test('Block extension: the Recovery extension is announced and logged, and does not pause on its own', async () => {
  const pairIndex = 215;
  const attacker = await createCharacter('LateBlock Attacker');
  const defender = await createCharacter('LateBlock Defender');
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12);
  const punch = await createMove({ name: 'LB Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  // Same shape as the Forfeit scenario above, minus the colliding move: the
  // Guard covers the attack's Active tic 1 but not tic 2 -> 'too-short', 1
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
  assert.ok(extended, 'a Block that catches the opening frame must log its Recovery extension');
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


// ---------------------------------------------------------------------
// Automations: they always fired mechanically, but emitted no round_event,
// so the cutscene never showed them. And On Miss used to fire only on a
// Full Dodge, which made it nearly unreachable.
// ---------------------------------------------------------------------

test('an On Hit automation reaches the round log, not just the Chat Log', async () => {
  const pairIndex = 300;
  const attacker = await createCharacter('AF Attacker');
  const defender = await createCharacter('AF Defender');
  const punch = await createMove({
    name: 'AF Punch',
    startupTics: 1,
    activeTics: 2,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: 20,
    interactions: [
      { trigger: 'hit', text: 'Rattles them.', automations: [{ type: 'opponent_stamina', amount: 2 }] },
    ],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const fired = events.filter((e) => e.type === 'automation_fired').map((e) => JSON.parse(e.payload));
  assert.equal(fired.length, 1, `the On Hit automation should have posted a round_event; saw ${events.map((e) => e.type).join(',')}`);
  assert.equal(fired[0].trigger, 'hit');
  assert.equal(fired[0].moveName, 'AF Punch');
  assert.equal(fired[0].text, 'Rattles them.');
  // Pre-rendered by the server so the cutscene and the Chat Log can never
  // describe the same effect differently.
  assert.ok(fired[0].effects.some((e) => e.includes('Stamina')));
  // And the Stamina movement itself is in the log, so the cutscene's
  // fighter cards don't drift away from what the sentences say.
  assert.ok(events.some((e) => e.type === 'stamina_changed'));
});

test('an undefended attack that rolls under 5 fires On Hit, never On Miss', async () => {
  const pairIndex = 301;
  const attacker = await createCharacter('IM Attacker');
  const defender = await createCharacter('IM Defender');
  // A big negative modifier guarantees a sub-5 total: Insignificant Damage.
  // It connected, so it is a hit that did too little to matter — On Hit is
  // the trigger that describes what happened, and On Miss belongs to a
  // Dodge evasion.
  const flail = await createMove({
    name: 'IM Flail',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: -50,
    interactions: [
      { trigger: 'miss', text: 'Overcommits.', automations: [{ type: 'self_stamina', amount: 1 }] },
      { trigger: 'hit', text: 'Grazes.', automations: [{ type: 'opponent_stamina', amount: 1 }] },
    ],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: flail, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  assert.ok(events.some((e) => e.type === 'insignificant_damage'));
  const fired = events.filter((e) => e.type === 'automation_fired').map((e) => JSON.parse(e.payload));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trigger, 'hit');
});

test('a weak attack is still blockable: Insignificant Damage no longer skips defence', async () => {
  // The bug this covers: the sub-5 check used to run immediately after the
  // attacker's roll and return, which skipped target selection and the
  // whole defence step. A correctly-timed Block against a weak attack was
  // never selected, never rolled, and fired none of its own triggers — the
  // defender simply watched nothing happen.
  const pairIndex = 305;
  const attacker = await createCharacter('WB Attacker');
  const defender = await createCharacter('WB Defender');
  const feint = await createMove({
    name: 'WB Feint',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: -50,
    interactions: [
      { trigger: 'block', text: 'Turned aside.', automations: [{ type: 'self_stamina', amount: 1 }] },
      { trigger: 'miss', text: 'Should never fire.', automations: [{ type: 'self_stamina', amount: 2 }] },
    ],
  });
  // Defense Frame on the guard's own Active square, landing on the same
  // absolute Tic as the attack's Active window.
  const guard = await createMove({
    name: 'WB Guard',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    isDefensive: 1,
    defenseKind: 'block',
    defenseFramePositions: [1],
    rollSlots: ['Body'],
    interactions: [{ trigger: 'defense_success', text: 'Held.', automations: [{ type: 'self_stamina', amount: 1 }] }],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: feint, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const types = events.map((e) => e.type);

  // The defence was actually selected, classified and rolled.
  const defence = events.find((e) => e.type === 'defense_resolved');
  assert.ok(defence, JSON.stringify(types));
  assert.equal(JSON.parse(defence.payload).defenseType, 'block');
  assert.ok(
    events.some((e) => e.type === 'roll' && JSON.parse(e.payload).defensive === true),
    'the Block must actually roll'
  );

  // Both sides' defence triggers fired.
  const fired = events.filter((e) => e.type === 'automation_fired').map((e) => JSON.parse(e.payload));
  const triggers = fired.map((f) => f.trigger).sort();
  assert.deepEqual(triggers, ['block', 'defense_success'], JSON.stringify(fired));

  // The defence outcome is the story — no Insignificant Damage line on top
  // of it, and never a Miss.
  assert.ok(!types.includes('insignificant_damage'), JSON.stringify(types));
  assert.ok(!triggers.includes('miss'));
});

test('a stat-step automation steps the named Stat and reports it as a stat step', async () => {
  const pairIndex = 302;
  const attacker = await createCharacter('SS Attacker');
  const defender = await createCharacter('SS Defender');
  const jab = await createMove({
    name: 'SS Jab',
    startupTics: 1,
    activeTics: 2,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: 20,
    interactions: [
      // Two steps, not one: the first half-damage step only marks the die
      // as half-damaged (that IS the rule — see applyHalfDamage), so a
      // single step would leave size and status untouched and prove nothing.
      { trigger: 'hit', text: '', automations: [{ type: 'opponent_stat_step', amount: 2, slot: 'Left Hand' }] },
    ],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: jab, placementTic: 0, startupTics: 1 });

  const before = await one("SELECT current_size, status FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'", [defender]);
  await resolvePair(pairIndex);
  const after = await one("SELECT current_size, status FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'", [defender]);
  assert.notDeepEqual(
    { size: before.current_size, status: before.status },
    { size: after.current_size, status: after.status },
    'the named Stat should have stepped'
  );

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  // **Its own event, not damage_applied (revised).** A step is signed — the
  // same automation with a negative amount steps the Stat back UP — and
  // borrowing the damage event made the log narrate that as "−1 steps of
  // damage". `stat_stepped` carries the direction and the before/after so the
  // cutscene can say what happened and still move the pip.
  const steps = events
    .filter((e) => e.type === 'stat_stepped')
    .map((e) => JSON.parse(e.payload));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].slotName, 'Left Hand');
  assert.equal(steps[0].steps, 2);
  assert.equal(steps[0].characterId, defender);
  assert.equal(steps[0].sizeBefore, before.current_size);
  assert.equal(steps[0].sizeAfter, after.current_size);
  // And it no longer masquerades as an anonymous hit.
  const asDamage = events
    .filter((e) => e.type === 'damage_applied')
    .map((e) => JSON.parse(e.payload))
    .filter((p) => p.source === 'automation');
  assert.equal(asDamage.length, 0);
});

test('a stat-step automation with a NEGATIVE amount steps the Stat back up', async () => {
  // The direction that used to print as negative damage. Same machinery, and
  // the event has to carry the sign rather than a separate flag that could
  // disagree with it.
  const pairIndex = 303;
  const attacker = await createCharacter('SS Up Attacker');
  const defender = await createCharacter('SS Up Defender');
  const jab = await createMove({
    name: 'SS Restore',
    startupTics: 1,
    activeTics: 2,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: 20,
    interactions: [
      { trigger: 'hit', text: '', automations: [{ type: 'self_stat_step', amount: -1, slot: 'Left Hand' }] },
    ],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: jab, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const steps = events
    .filter((e) => e.type === 'stat_stepped')
    .map((e) => JSON.parse(e.payload));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].steps, -1, 'the sign survives onto the event');
  assert.equal(steps[0].characterId, attacker, 'self_stat_step lands on its user');
  assert.ok(steps[0].sizeAfter >= steps[0].sizeBefore, 'the die did not go down');
});

// ---------- Block Stamina (the Block Tag's automation) ----------

// Attaches a Tag by name to a move, creating the tag row on demand. Tag
// automation is keyed by name, never by id (see server/tagAutomations.js), so
// the test creates one exactly the way a GM would.
async function tagMove(moveId, tagName) {
  let tag = await one('SELECT id FROM tags WHERE LOWER(name) = LOWER(?)', [tagName]);
  if (!tag) {
    const result = await run('INSERT INTO tags (name, description) VALUES (?, ?)', [tagName, '']);
    tag = { id: Number(result.lastInsertRowid) };
  }
  await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [moveId, tag.id]);
  return tag.id;
}

// The Stamina a Block actually spent, read off its own round_event rather
// than by differencing the pool before and after. Idle-Tic Regen hands
// Stamina back over the rest of the round, so the net difference across a
// whole resolution is NOT the block's price — differencing would have made
// these tests measure two rules at once.
async function blockSpendFor(pairIndex, characterId) {
  const rows = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const spend = rows
    .map((r) => ({ type: r.type, p: JSON.parse(r.payload) }))
    .find((r) => r.type === 'stamina_changed' && r.p.characterId === characterId && r.p.delta < 0);
  return spend ? { delta: spend.p.delta, reason: spend.p.reason } : null;
}

// Damage that landed on the DEFENDER specifically. A defensive move with a
// Roll is itself a revealed move with an Active window, so it counter-attacks
// the attacker on its own account (see the Full Block test above) — scoping
// by target is what separates "the block failed" from "the block hit back".
async function damageTaken(pairIndex, characterId) {
  const rows = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  return rows
    .map((r) => ({ type: r.type, p: JSON.parse(r.payload) }))
    .find((r) => r.type === 'damage_applied' && r.p.targetCharacterId === characterId) ?? null;
}

const staminaOf = async (characterId) =>
  (await one('SELECT current_stamina FROM characters WHERE id = ?', [characterId])).current_stamina;

async function blockScenario({ pairIndex, attackModifier, attackerSkull = 8, defenderStamina = null, staminaModifier = null }) {
  const attacker = await createCharacter(`Blk${pairIndex} Attacker`);
  const defender = await createCharacter(`Blk${pairIndex} Defender`);
  // Math.random is pinned near 1 for this file, so every die lands on its max
  // face and each scenario is plain arithmetic.
  const attack = await createMove({
    name: `Blk${pairIndex} Attack`,
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: attackModifier,
    attackTargets: ['Body'],
  });
  const guard = await createMove({
    name: `Blk${pairIndex} Guard`,
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [1], // the Active square, landing on the attack's own Active Tic
    rollSlots: ['Body'], // rolls 8
  });
  await tagMove(guard, 'Block');
  if (attackerSkull !== 8) await setDieSize(attacker, 'Skull', attackerSkull);
  if (staminaModifier != null) await run('UPDATE moves SET stamina_modifier = ? WHERE id = ?', [staminaModifier, guard]);

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: attack, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1 });
  // Set AFTER declaration opens: startPairDeclaration runs the round's own
  // Stamina restore/regen, which would otherwise refill the pool this
  // scenario is deliberately draining.
  if (defenderStamina != null) await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [defenderStamina, defender]);
  await resolvePair(pairIndex);
  return { attacker, defender, guard };
}

test('Block Tag: the guard is charged for what it absorbed, never more than the attack was worth', async () => {
  // Attack rolls 5 (d8 max, -3); the guard rolls 8. It out-guards the attack
  // outright — and is still only billed the 5 the attack was worth.
  const pairIndex = 400;
  const { defender } = await blockScenario({ pairIndex, attackModifier: -3 });
  const spend = await blockSpendFor(pairIndex, defender);
  assert.ok(spend, 'the Block must spend Stamina at resolution');
  assert.equal(spend.delta, -5);
  assert.match(spend.reason, /absorbed 5/);
  assert.equal(await damageTaken(pairIndex, defender), null, 'a fully-paid guard takes nothing');
});

test('Block Tag: the Stamina Modifier scales the bill without weakening the guard', async () => {
  // Attack rolls 6; absorbed 6 at x0.5 costs 3, and still stops all of it.
  const pairIndex = 401;
  const { defender } = await blockScenario({ pairIndex, attackModifier: -2, staminaModifier: 0.5 });
  const spend = await blockSpendFor(pairIndex, defender);
  assert.equal(spend.delta, -3);
  assert.match(spend.reason, /absorbed 6/);
  assert.equal(await damageTaken(pairIndex, defender), null);
});

test('Block Tag: a guard only holds as much as its Stamina pays for', async () => {
  // A d12 Skull at +8 rolls 20. The guard would absorb its own 8, but the
  // defender has 3 Stamina: it holds 3, and 17 gets through as 3 steps.
  const pairIndex = 402;
  const { defender } = await blockScenario({ pairIndex, attackModifier: 8, attackerSkull: 12, defenderStamina: 3 });
  const spend = await blockSpendFor(pairIndex, defender);
  assert.equal(spend.delta, -3, 'spends every point it has and not one more');
  const damage = await damageTaken(pairIndex, defender);
  assert.ok(damage, 'a guard that could not be paid for lets the attack through');
  assert.equal(damage.p.steps, 3);
  const notice = await one(
    `SELECT content FROM chat_log WHERE kind = 'message' AND content LIKE '%ran out of Stamina mid-%' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(notice, 'the table must be told the guard was cut short');
});

test('a defensive move WITHOUT the Block Tag is untouched by any of this', async () => {
  // The Tag is the switch, not the Block/Dodge toggle: an untagged Block
  // keeps its old flat-cost behaviour and spends nothing at resolution.
  const pairIndex = 403;
  const attacker = await createCharacter('Untagged Attacker');
  const defender = await createCharacter('Untagged Defender');
  const jab = await createMove({
    name: 'UT Jab', startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: -3, attackTargets: ['Body'],
  });
  const guard = await createMove({
    name: 'UT Guard', startupTics: 1, activeTics: 1, recoveryTics: 1,
    isDefensive: true, defenseKind: 'block', defenseFramePositions: [1], rollSlots: ['Body'],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: jab, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  assert.equal(await blockSpendFor(pairIndex, defender), null, 'an untagged Block must not be charged at resolution');
  assert.equal(await damageTaken(pairIndex, defender), null, 'and still blocks exactly as it always did');
});

// ---------- Initiative modifiers (the two-copies bugfix) ----------

// Gives a character an active stance made of two named Styles, so
// getStanceMatchupBonus has something real to score.
async function giveStance(characterId, styleA, styleB) {
  const ids = await all('SELECT id, name FROM attributes');
  const byName = new Map(ids.map((r) => [r.name, r.id]));
  const result = await run(
    'INSERT INTO stances (character_id, name, attribute_a_id, attribute_b_id) VALUES (?, ?, ?, ?)',
    [characterId, `${styleA}/${styleB}`, byName.get(styleA), byName.get(styleB)]
  );
  await run('UPDATE characters SET active_stance_id = ? WHERE id = ?', [
    Number(result.lastInsertRowid),
    characterId,
  ]);
}

test('Initiative carries the Stance matchup on rounds after the first', async () => {
  // The bug this pins: the Initiative Brain roll exists twice — once in
  // server/index.js's combat:next_round (a fight's first round) and once in
  // startPairDeclaration here (every round after) — and only the first had
  // learned the Stance matchup. From round 2 on, a fighter's stance
  // advantage silently stopped counting toward who declares first.
  const pairIndex = 500;
  const attacker = await createCharacter('Init Attacker');
  const defender = await createCharacter('Init Defender');
  await giveStance(attacker, 'Speed', 'Power');
  await giveStance(defender, 'Technique', 'Improvisation');
  await seatPair(pairIndex, attacker, defender);

  // Round 1, then round 2 — the second is the one that goes through
  // startPairDeclaration's own initiative roll.
  await startPairDeclaration(mockIo, pairIndex);
  await run('DELETE FROM chat_log');
  await startPairDeclaration(mockIo, pairIndex);

  const brainRolls = (await all("SELECT character_id, modifier, dice_rolled FROM chat_log WHERE kind = 'roll'"))
    .filter((r) => JSON.parse(r.dice_rolled).some((d) => d.slot_name === 'Brain'));
  assert.equal(brainRolls.length, 2, 'both fighters roll initiative');

  // Whatever the chart says for this pairing, the two sides must be exact
  // opposites and non-zero — asserting the sign rather than a hardcoded
  // number keeps this from breaking if the counter chart is ever retuned.
  const { getStanceMatchupBonus } = await import('../combatBonuses.js');
  const expected = await getStanceMatchupBonus(attacker);
  assert.notEqual(expected, 0, 'these two stances must actually counter for the test to mean anything');
  const mine = brainRolls.find((r) => r.character_id === attacker);
  const theirs = brainRolls.find((r) => r.character_id === defender);
  assert.equal(mine.modifier, expected, 'the attacker\'s initiative must include their stance matchup');
  assert.equal(theirs.modifier, -expected, 'and the defender\'s the mirror of it');
});

// ---------- Combat Style (decided, new) ----------

// Sets a move's own Combat Style — the style added to its user's stance when
// the matchup is scored for that move's roll.
async function setCombatStyle(moveId, styleName) {
  const row = await one('SELECT id FROM attributes WHERE name = ?', [styleName]);
  await run('UPDATE moves SET combat_style_attribute_id = ? WHERE id = ?', [row.id, moveId]);
}

test("a move's Combat Style reaches BOTH fighters' rolls at the Tic it resolves on", async () => {
  // Two bugs are pinned here at once.
  //
  // The mechanic: a Combat Style joins its user's stance, duplicates kept, so
  // a Speed move thrown from a Speed stance scores Speed twice.
  //
  // The trap: combat_pairs.current_tic is only written AFTER a Tic finishes
  // processing (advancePairResolution's crash-recovery ordering), so reading
  // it to find "what is the opponent doing right now" lags a Tic behind and
  // the attacker's just-revealed move looked like it wasn't out yet. The
  // attacker's own roll passes its moveId explicitly and was always right —
  // only the DEFENDER's view of the attacker was wrong, which is why the
  // assertion that matters most is the one on the defender's modifier.
  const pairIndex = 520;
  const attacker = await createCharacter('CS Attacker');
  const defender = await createCharacter('CS Defender');
  await giveStance(attacker, 'Speed', 'Power');
  await giveStance(defender, 'Technique', 'Improvisation');
  await seatPair(pairIndex, attacker, defender);

  const jab = await createMove({ name: 'CS Jab', activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'] });
  const guard = await createMove({
    name: 'CS Guard', activeTics: 2, recoveryTics: 1, rollSlots: ['Body'],
    isDefensive: true, defenseKind: 'block', defenseFramePositions: [0, 1],
  });

  // The matchup helpers only score once the pair's fight is actually
  // underway, so open declaration before reading the expected values. The
  // Initiative rolls it posts are cleared straight after, leaving only the
  // move rolls below for the assertions.
  await startPairDeclaration(mockIo, pairIndex);
  const { getStanceMatchupBonus } = await import('../combatBonuses.js');
  const plain = await getStanceMatchupBonus(attacker, { includeMoveStyles: false });
  assert.notEqual(plain, 0, 'these stances must actually counter for the test to mean anything');

  // Which of the attacker's own two stance styles to duplicate is *measured*
  // rather than picked by hand: a style whose net against the defending
  // stance happens to be 0 (Speed is exactly that against Technique/
  // Improvisation on the shipped chart) would double to no visible effect
  // and the test would pass while proving nothing. Retuning the counter
  // chart can't quietly void this.
  let styled = plain;
  for (const style of ['Speed', 'Power']) {
    await setCombatStyle(jab, style);
    styled = await getStanceMatchupBonus(attacker, { moveId: jab, tic: 1 });
    if (styled !== plain) break;
  }
  assert.notEqual(styled, plain, 'no stance style doubles to a visible effect — pick a different pairing');
  await run('DELETE FROM chat_log');
  await declareMove({ characterId: attacker, moveId: jab, placementTic: 0, startupTics: 1, effectiveAttackTargets: ['Body'] });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const rolls = await all("SELECT character_id, modifier FROM chat_log WHERE kind = 'roll'");
  const atkRoll = rolls.find((r) => r.character_id === attacker);
  const defRoll = rolls.find((r) => r.character_id === defender);
  assert.equal(atkRoll.modifier, styled, "the attacker's own roll carries their move's Combat Style");
  // The 3-vs-3 half: the defender is scored against the attacker's stance
  // PLUS the attacker's Combat Style, so their modifier is the exact mirror.
  // Before the tic fix this came back as -plain, silently ignoring the style.
  assert.equal(defRoll.modifier, -styled, "the defender is scored against the attacker's move too");
});

test('a move with no Combat Style leaves the matchup at the bare stance score', async () => {
  const pairIndex = 521;
  const attacker = await createCharacter('CS2 Attacker');
  const defender = await createCharacter('CS2 Defender');
  await giveStance(attacker, 'Speed', 'Power');
  await giveStance(defender, 'Technique', 'Improvisation');
  await seatPair(pairIndex, attacker, defender);

  const jab = await createMove({ name: 'CS2 Jab', activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'] });
  const guard = await createMove({
    name: 'CS2 Guard', activeTics: 2, recoveryTics: 1, rollSlots: ['Body'],
    isDefensive: true, defenseKind: 'block', defenseFramePositions: [0, 1],
  });

  await startPairDeclaration(mockIo, pairIndex);
  const { getStanceMatchupBonus } = await import('../combatBonuses.js');
  const plain = await getStanceMatchupBonus(attacker, { includeMoveStyles: false });
  await run('DELETE FROM chat_log');
  await declareMove({ characterId: attacker, moveId: jab, placementTic: 0, startupTics: 1, effectiveAttackTargets: ['Body'] });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const rolls = await all("SELECT character_id, modifier FROM chat_log WHERE kind = 'roll'");
  assert.equal(rolls.find((r) => r.character_id === attacker).modifier, plain);
  assert.equal(rolls.find((r) => r.character_id === defender).modifier, -plain);
});

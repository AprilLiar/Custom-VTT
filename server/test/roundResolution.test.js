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
const {
  advancePairResolution,
  startPairDeclaration,
  resolveDodge,
  resolveBlock,
  resolveMoveConflict,
  openRoundForCharacters,
  defensePromptPayload,
} = await import('../roundResolution.js');
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
  return {
    emit: () => {},
    sockets: { sockets },
    // The snapshot broadcaster the real server hangs on this object (see
    // server/index.js's `io.emitCombatUpdated = emitCombatUpdated`). Counted
    // rather than stubbed to nothing, so a test can hold the engine to the rule
    // that raising a pause always broadcasts it — the rule the "GM locked their
    // phone and the fight died" report turned out to be about.
    snapshotBroadcasts: 0,
    async emitCombatUpdated() {
      this.snapshotBroadcasts += 1;
    },
  };
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

const getCharacterRow = (characterId) => one('SELECT * FROM characters WHERE id = ?', [characterId]);

// The Stamina change a cascade handed back, found by the reason it carries.
async function refundEvent(pairIndex, reasonPattern) {
  const rows = await all(
    `SELECT payload FROM round_events WHERE pair_index = ? AND type = 'stamina_changed' ORDER BY seq`,
    [pairIndex]
  );
  return rows.map((r) => JSON.parse(r.payload)).find((p) => reasonPattern.test(p.reason ?? ''));
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

// **Every Block now pauses for a GM call (decided, reversed).** These tests
// were written when a Block resolved with no human input, and what almost all
// of them are actually about is the guard's arithmetic — so by default this
// answers every Block prompt "Successful", which is precisely the old
// behaviour, and the tests keep measuring what they were written to measure.
// Pass `blockAnswers: ['failed', ...]` to drive a specific sequence; the last
// answer repeats if the round asks more questions than the list has entries.
// The adjudication itself is tested on its own further down.
async function resolvePair(pairIndex, { blockAnswers = ['successful'] } = {}) {
  await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
  await advancePairResolution(pairIndex, mockIo);
  // Bounded: a bug that re-raises the same prompt forever should fail the test,
  // not hang the suite.
  for (let i = 0; i < 20; i++) {
    const state = await one(
      `SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND status = 'paused_defense'`,
      [pairIndex]
    );
    if (!state) return;
    await resolveBlock(pairIndex, { outcome: blockAnswers[i] ?? blockAnswers.at(-1) }, mockIo);
  }
  throw new Error('resolvePair: Block prompts never stopped');
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
  // **The contest is two attack rolls**, so the fixture has to give the punch a
  // genuine edge rather than merely landing damage. Math.random is pinned to
  // its max for this file, so a d12 Skull rolls 12 and the wind-up's default d8
  // Body rolls 8 — 12 beats 8 plus its one elapsed-Active-frame point.
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'IR Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  // No Defense Frames at all -> plain Hit, but placed with a long Startup so
  // it's still mid-Startup when the attacker's Active window (Tics 1-2) hits.
  const slowWindup = await createMove({ name: 'Slow Windup', startupTics: 3, activeTics: 1, recoveryTics: 1, rollSlots: ['Body'] });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  const startupDMId = await declareMove({ characterId: defender, moveId: slowWindup, placementTic: 0, startupTics: 3 });
  await resolvePair(pairIndex);

  // 12 against 8 + 1 -> the punch beats the wind-up and breaks it up.
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

test('Interruption: a wind-up that wins the contest comes out anyway', async () => {
  // The other half of the corrected rule. Same shape as the test above, with
  // the dice the other way round: the caught move rolls higher, so the punch
  // lands its damage and the wind-up still happens.
  const pairIndex = 105;
  const attacker = await createCharacter('Held Attacker');
  const defender = await createCharacter('Held Defender');
  await setDieSize(defender, 'Body', 12);   // 12, plus a point per elapsed frame
  await setDieSize(attacker, 'Skull', 6);   // 6
  const punch = await createMove({ name: 'HL Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const slowWindup = await createMove({ name: 'HL Windup', startupTics: 3, activeTics: 1, recoveryTics: 1, rollSlots: ['Body'] });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  const startupDMId = await declareMove({ characterId: defender, moveId: slowWindup, placementTic: 0, startupTics: 3 });
  await resolvePair(pairIndex);

  const stillDeclared = await one('SELECT id FROM declared_moves WHERE id = ?', [startupDMId]);
  assert.ok(stillDeclared, 'the wind-up beat the punch, so it survives');

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const resolved = events.filter((e) => e.type === 'interrupt_resolved').map((e) => JSON.parse(e.payload))[0];
  assert.ok(resolved, 'the check still ran');
  assert.equal(resolved.interrupted, false);
  // Both sides of the comparison ride the event, so a replay can lay it out.
  assert.equal(resolved.attackerRoll, 6);
  assert.equal(resolved.attackerTotal, 6);
  assert.equal(resolved.result, 12);
  assert.ok(resolved.activeFrameBonus >= 1, JSON.stringify(resolved));
  assert.equal(resolved.defenderTotal, 12 + resolved.activeFrameBonus);
  // Damage is not part of the comparison any more, only context.
  assert.ok(resolved.halfDamageSteps >= 0);

  // ...and it did still take the hit. Which Stat the punch found is the damage
  // system's business, not this test's — what matters here is that holding the
  // move together is not the same as evading the blow.
  const damage = events.filter((e) => e.type === 'damage_applied');
  assert.ok(damage.length > 0, 'the punch still landed its damage');
});

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

// A blocker whose guard falls short, with `queue` placed behind it. Returns the
// declared-move ids so a test can drive the one conflict prompt the cascade
// raises. Shared by the three below, which differ only in what they answer.
async function cascadeFixture(pairIndex, tag, queue) {
  const attacker = await createCharacter(`${tag} Attacker`);
  const defender = await createCharacter(`${tag} Defender`);
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', 12);
  const punch = await createMove({ name: `${tag} Punch`, startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const guard = await createMove({
    name: `${tag} Guard`, startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Hand'], isDefensive: true, defenseKind: 'block', defenseFramePositions: [1],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1, appendageChoice: 'left' });

  const declaredIds = [];
  for (const q of queue) {
    const moveId = await createMove({
      name: `${tag} ${q.name}`, startupTics: 1, activeTics: q.activeTics ?? 1,
      recoveryTics: q.recoveryTics ?? 0, rollSlots: [],
    });
    if (q.staminaCost) await run('UPDATE moves SET stamina_cost = ? WHERE id = ?', [q.staminaCost, moveId]);
    const dmId = await declareMove({ characterId: defender, moveId, placementTic: q.at, startupTics: 1 });
    // Committed, as a real declaration is once its owner presses done —
    // otherwise the refund branch has nothing to give back.
    if (q.staminaCost) await run('UPDATE declared_moves SET stamina_committed = 1 WHERE id = ?', [dmId]);
    declaredIds.push(dmId);
  }
  await resolvePair(pairIndex);
  return { attacker, defender, declaredIds };
}

test('the cascade is ONE prompt carrying the whole tail, not one per collision', async () => {
  const pairIndex = 211;
  const { declaredIds } = await cascadeFixture(pairIndex, 'CP', [
    { name: 'Collision A', at: 3 },
    { name: 'Collision B', at: 5 },
  ]);
  const [moveA, moveB] = declaredIds;

  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'paused_conflict');
  const pending = JSON.parse(resolution.pending_conflict_json);
  // The guard's extension runs to Tic 4. A sits at 3 and moves to 4, taking
  // 4-5; B at 5 is then in A's way and moves to 6. Both in one question —
  // the old flow asked about A, applied it, then asked about B.
  assert.equal(pending.declaredMoveId, moveA, 'the first collision is the one Forfeit would give up');
  assert.deepEqual(
    pending.shifts.map((sh) => [sh.declaredMoveId, sh.from, sh.to]),
    [[moveA, 3, 4], [moveB, 5, 6]]
  );

  await resolveMoveConflict(pairIndex, { declaredMoveId: moveA, choice: 'extend' }, mockIo);

  const a = await one('SELECT placement_tic, reveal_tic FROM declared_moves WHERE id = ?', [moveA]);
  assert.deepEqual([a.placement_tic, a.reveal_tic], [4, 5]);
  const b = await one('SELECT placement_tic, reveal_tic FROM declared_moves WHERE id = ?', [moveB]);
  assert.deepEqual([b.placement_tic, b.reveal_tic], [6, 7], 'the knock-on move moved too, unasked');

  const finalResolution = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(finalResolution.status, 'complete', 'one answer finishes it — no second prompt');
});

test('Forfeit drops the move the guard ran into, and the rest still cascade', async () => {
  const pairIndex = 212;
  const { defender, declaredIds } = await cascadeFixture(pairIndex, 'CF', [
    { name: 'Collision A', at: 3, staminaCost: 4 },
    { name: 'Collision B', at: 5 },
  ]);
  const [moveA, moveB] = declaredIds;
  // Spent down first: Stamina clamps at max, so a refund onto a full bar is
  // invisible.
  await run('UPDATE characters SET current_stamina = 10 WHERE id = ?', [defender]);

  await resolveMoveConflict(pairIndex, { declaredMoveId: moveA, choice: 'forfeit' }, mockIo);

  assert.equal(await one('SELECT id FROM declared_moves WHERE id = ?', [moveA]), null, 'A is off the board');
  // Read off the refund's own event rather than the bar: answering the prompt
  // resumes the round, which finishes and runs its Stamina regen before this
  // line — so the bar has moved on for reasons that are nothing to do with us.
  const refund = await refundEvent(pairIndex, /forfeited/);
  assert.ok(refund, 'the refund should be announced as its own Stamina change');
  assert.equal(refund.delta, 4, 'and its Stamina came back');

  // B was never the collision, but the guard still runs to Tic 4 and B sat at
  // 5 — with A gone there is nothing in front of it, so it stays put.
  const b = await one('SELECT placement_tic FROM declared_moves WHERE id = ?', [moveB]);
  assert.equal(b.placement_tic, 5);

  const finalResolution = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(finalResolution.status, 'complete');
});

test('a move pushed clear out of the round is refunded and handed back uncommitted', async () => {
  const pairIndex = 213;
  // A is long enough that shifting it shoves B past the round's last Tic.
  const { defender, declaredIds } = await cascadeFixture(pairIndex, 'CR', [
    { name: 'Long A', at: 3, activeTics: 2, recoveryTics: 2 },
    { name: 'Spilled B', at: 5, staminaCost: 3 },
  ]);
  const [moveA, moveB] = declaredIds;
  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  const roundEnd = resolution.round_start_tic + resolution.round_length;
  await run('UPDATE characters SET current_stamina = 10 WHERE id = ?', [defender]);

  await resolveMoveConflict(pairIndex, { declaredMoveId: moveA, choice: 'extend' }, mockIo);

  const b = await one('SELECT placement_tic, stamina_committed FROM declared_moves WHERE id = ?', [moveB]);
  assert.ok(b.placement_tic >= roundEnd, `B should have left the round: ${b.placement_tic} vs ${roundEnd}`);
  // **The decided rule.** It is next round's move now, so it stops being a
  // commitment: Stamina back, declaration uncommitted, still sitting where the
  // cascade put it — which is the state a freshly-dragged move is in, and what
  // makes it cancellable again when Declaration reopens.
  assert.equal(b.stamina_committed, 0, 'it is no longer a commitment');
  const refund = await refundEvent(pairIndex, /pushed into the next round/);
  assert.ok(refund, 'the refund should be announced as its own Stamina change');
  assert.equal(refund.delta, 3, 'its Stamina came back');

  // A stayed inside the round, so it keeps its commitment.
  const a = await one('SELECT placement_tic, stamina_committed FROM declared_moves WHERE id = ?', [moveA]);
  assert.ok(a.placement_tic < roundEnd);
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

test('Initiative does NOT carry the Stance matchup — Brain is exempt', async () => {
  // **Rewritten, not deleted (decided, revised).** This test used to pin the
  // opposite: the Initiative Brain roll exists twice — once in
  // server/index.js's combat:next_round (a fight's first round) and once in
  // startPairDeclaration here (every round after) — and keeping the two in
  // step about the matchup was itself a bugfix.
  //
  // The rule underneath both changed. **Brain and Stamina are exempt from the
  // Stance matchup entirely** (MATCHUP_EXEMPT_SLOTS in combatBonuses.js): the
  // matchup scores an exchange of fighting styles, and Initiative is a pure
  // Brain roll — thinking, not trading blows. What this test protects now is
  // that the two copies still agree, which was always the real point.
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

  // These two stances genuinely counter each other, so a matchup leaking in
  // would show up as a non-zero modifier on one side and its mirror on the
  // other — which is exactly what this used to assert.
  const { getStanceMatchupBonus } = await import('../combatBonuses.js');
  const wouldHaveBeen = await getStanceMatchupBonus(attacker);
  assert.notEqual(wouldHaveBeen, 0, 'these two stances must actually counter for the test to mean anything');

  const mine = brainRolls.find((r) => r.character_id === attacker);
  const theirs = brainRolls.find((r) => r.character_id === defender);
  // No Reasons to Fight and no overflow here, so a clean Initiative roll is
  // modifier 0 on both sides.
  assert.equal(mine.modifier, 0, 'the stance advantage must not reach Initiative');
  assert.equal(theirs.modifier, 0, 'nor its mirror on the other side');
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

// ---------------------------------------------------------------------------
// Perks (see server/perks/index.js for the architecture)
// ---------------------------------------------------------------------------

// Grants a Perk that seedPerks already created at initDb time — the same
// three-way alignment production has: a definition in the registry, a row in
// `perks` under the same name, and a `character_perks` grant.
async function grantPerk(characterId, perkName) {
  const perk = await one('SELECT id FROM perks WHERE name = ?', [perkName]);
  assert.ok(perk, `${perkName} should have been seeded from the registry`);
  const result = await run('INSERT INTO character_perks (character_id, perk_id) VALUES (?, ?)', [
    characterId,
    perk.id,
  ]);
  return Number(result.lastInsertRowid);
}

// One failed-defence round. `withPerk` decides whether the defender carries
// Second Wind; everything else is identical, and Math.random is pinned for this
// whole file, so the two runs differ by exactly the Perk. Stamina cannot be
// asserted absolutely — Idle-Tic Regen moves it several points over a round —
// so what the Perk did is the difference between the two.
async function runFailedDefenceRound(pairIndex, label, { withPerk }) {
  const attacker = await createCharacter(`${label} Attacker`);
  const defender = await createCharacter(`${label} Defender`);
  await setDieSize(attacker, 'Skull', 12);
  // Well below max, or +2 Stamina would be clamped away and prove nothing.
  await run('UPDATE characters SET current_stamina = 10 WHERE id = ?', [defender]);
  const characterPerkId = withPerk ? await grantPerk(defender, 'Second Wind') : null;

  const punch = await createMove({ name: `${label} Punch`, startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  // The too-early guard shape: its only Defense Frame sits past the attack's
  // first Active Tic, so the defence is force-failed and fires defense_failure.
  const lateGuard = await createMove({
    name: `${label} Guard`,
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Left Hand'],
    isDefensive: true,
    defenseKind: 'block',
    defenseFramePositions: [2],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: lateGuard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const after = await one('SELECT current_stamina FROM characters WHERE id = ?', [defender]);
  return { defender, characterPerkId, stamina: after.current_stamina };
}

test('Second Wind: a Perk fires on a trigger, through the same executor a move uses', async () => {
  const pairIndex = 310;
  const control = await runFailedDefenceRound(315, 'SWC', { withPerk: false });
  const { defender, characterPerkId, stamina } = await runFailedDefenceRound(pairIndex, 'SW', { withPerk: true });

  // A negative self_stamina GIVES Stamina back. The Move Creator cannot author
  // that (normalizeInteractions takes the absolute value of anything outside
  // SIGNED_TYPES), so this direction only became reachable through a Perk.
  assert.equal(stamina, control.stamina + 2);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const fired = events
    .filter((e) => e.type === 'automation_fired')
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.sourceName === 'Second Wind');
  assert.ok(fired, 'the Perk should reach the round log, not only the Chat Log');
  assert.equal(fired.sourceKind, 'perk');
  assert.equal(fired.trigger, 'defense_failure');
  assert.equal(fired.characterId, defender);
  // No move to name — moveName is a move's field and stays null for a Perk, so
  // a reader is never told a move did this.
  assert.equal(fired.moveName, null);
  assert.equal(fired.moveId, null);
  assert.ok(fired.effects.some((x) => /\+2 Stamina/.test(x)), JSON.stringify(fired.effects));

  // Fired once for the one failed defence. That the SECOND attempt inside a
  // round is refused is `consumeOnce`'s own contract, unit-tested in
  // perkEngine.test.js — reaching it here would need a second attacker.
  const allFirings = events
    .filter((e) => e.type === 'automation_fired')
    .map((e) => JSON.parse(e.payload))
    .filter((p) => p.sourceName === 'Second Wind');
  assert.equal(allFirings.length, 1);

  // **The charge is already back**, and that is the engine working, not a gap:
  // finishing a round auto-opens the pair's next one in the same call
  // (advancePairResolution → startPairDeclaration), and opening a round is
  // exactly when a round-scoped charge refreshes. The scoping itself — that
  // only THIS pair's fighters are refreshed — is the next test.
  const afterRound = await one(
    "SELECT value FROM character_perk_state WHERE character_perk_id = ? AND key = 'trigger:defense_failure'",
    [characterPerkId]
  );
  assert.equal(afterRound, null);
});

test("Second Wind's round charge is NOT refreshed by an unrelated pair's round", async () => {
  // Rounds belong to a pair, not to the arena. A fighter standing in one fight
  // must not get their once-per-round back because a different fight across the
  // room happened to advance.
  const mine = await createCharacter('SW Mine');
  const theirs = await createCharacter('SW Theirs');
  const otherA = await createCharacter('SW Other A');
  const otherB = await createCharacter('SW Other B');
  const characterPerkId = await grantPerk(mine, 'Second Wind');
  await seatPair(311, mine, theirs);
  await seatPair(312, otherA, otherB);

  await run(
    "INSERT INTO character_perk_state (character_perk_id, key, value, scope) VALUES (?, 'trigger:defense_failure', 1, 'round')",
    [characterPerkId]
  );
  await startPairDeclaration(mockIo, 312);
  const stillSpent = await one(
    "SELECT value FROM character_perk_state WHERE character_perk_id = ? AND key = 'trigger:defense_failure'",
    [characterPerkId]
  );
  assert.equal(stillSpent?.value, 1);

  await startPairDeclaration(mockIo, 311);
  const refreshed = await one(
    "SELECT value FROM character_perk_state WHERE character_perk_id = ? AND key = 'trigger:defense_failure'",
    [characterPerkId]
  );
  assert.equal(refreshed, null);
});

test('Cornered Animal: the bonus is conditional, and it is named on the roll it changes', async () => {
  const pairIndex = 313;
  const attacker = await createCharacter('CA Attacker');
  const defender = await createCharacter('CA Defender');
  await grantPerk(attacker, 'Cornered Animal');
  // A quarter of max or below is the condition; 32 max, so 8 qualifies.
  await run('UPDATE characters SET current_stamina = 8 WHERE id = ?', [attacker]);

  const punch = await createMove({ name: 'CA Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: punch, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const rolls = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .filter((e) => e.type === 'roll')
    .map((e) => JSON.parse(e.payload));
  const mine = rolls.find((r) => r.characterId === attacker);
  const theirs = rolls.find((r) => r.characterId === defender);

  // Its own named term, not a lump folded into the modifier — a Perk that moves
  // a total has to be accountable in the breakdown.
  const term = (mine.modifierBreakdown ?? []).find((t) => t.label === 'Cornered Animal');
  assert.ok(term, JSON.stringify(mine.modifierBreakdown));
  assert.equal(term.amount, 2);
  assert.equal(term.key, 'perk:Cornered Animal');
  assert.equal(mine.modifier, 2);

  // The fighter without the Perk, throwing the identical move, is untouched.
  assert.equal(theirs.modifier, 0);
  assert.equal((theirs.modifierBreakdown ?? []).length, 0);
});

test('Cornered Animal contributes nothing while its condition is unmet', async () => {
  const pairIndex = 314;
  const attacker = await createCharacter('CA Healthy');
  const defender = await createCharacter('CA Healthy Foe');
  await grantPerk(attacker, 'Cornered Animal');
  // Full Stamina — well above a quarter.
  const punch = await createMove({ name: 'CAH Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const roll = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .filter((e) => e.type === 'roll')
    .map((e) => JSON.parse(e.payload))
    .find((r) => r.characterId === attacker);
  // Not "+0 Cornered Animal" — absent. A zero term is noise, not transparency.
  assert.equal((roll.modifierBreakdown ?? []).find((t) => t.label === 'Cornered Animal'), undefined);
  assert.equal(roll.modifier, 0);
});

// ---------- Recover Stat, and the Movement Punisher pair (decided, new) ----------

test('Recover Stat heals toward the locked baseline and stops there', async () => {
  const pairIndex = 320;
  const attacker = await createCharacter('Recoverer');
  const defender = await createCharacter('Recoveree');
  await setDieSize(attacker, 'Skull', 12);

  // Lock at d8 (createCharacter's default), then take the Skull down to d6 —
  // so there is exactly one step of damage to heal and a ceiling above it.
  await run('UPDATE dice SET locked_size = current_size, locked_bonus = bonus, locked_status = status WHERE character_id = ?', [attacker]);
  await run("UPDATE dice SET current_size = 6, half_damage = 1 WHERE character_id = ? AND slot_name = 'Left Hand'", [attacker]);

  const heal = await createMove({
    name: 'RS Heal',
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: 20,
    interactions: [
      { trigger: 'hit', text: 'shakes it out', automations: [{ type: 'self_stat_recover', slot: 'Left Hand', amount: 5 }] },
    ],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: heal, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const hand = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'", [attacker]);
  // Five steps of recovery against one step of damage: it heals the pending
  // half, climbs back to d8, and then stops. It must NOT run on to d12.
  assert.equal(hand.current_size, 8);
  assert.equal(hand.bonus, 0);
  assert.equal(hand.half_damage, 0, 'healing clears the pending half step');
  assert.equal(hand.locked_size, 8);
});

test('Recover Stat does nothing to a Stat already at its baseline', async () => {
  const pairIndex = 321;
  const attacker = await createCharacter('Healthy Healer');
  const defender = await createCharacter('Healthy Foe');
  await setDieSize(attacker, 'Skull', 12);
  await run('UPDATE dice SET locked_size = current_size, locked_bonus = bonus, locked_status = status WHERE character_id = ?', [attacker]);

  const heal = await createMove({
    name: 'RS NoOp',
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'],
    rollModifier: 20,
    interactions: [
      { trigger: 'hit', text: 'nothing to fix', automations: [{ type: 'self_stat_recover', slot: 'Body', amount: 3 }] },
    ],
  });
  const before = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Body'", [attacker]);

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: heal, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const after = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Body'", [attacker]);
  // This is the whole difference from Increase Self Stat, which would have
  // taken an undamaged Stat straight past where it started.
  assert.equal(after.current_size, before.current_size);
  assert.equal(after.bonus, before.bonus);
});

test('Movement Punisher: connecting with a Movement move imposes Recovery on it', async () => {
  const pairIndex = 322;
  const attacker = await createCharacter('Punisher');
  const defender = await createCharacter('Runner');
  await setDieSize(attacker, 'Skull', 12);

  const [punisherTag, movementTag] = await Promise.all([
    one("SELECT id FROM tags WHERE name = 'Movement Punisher'"),
    one("SELECT id FROM tags WHERE name = 'Movement'"),
  ]);
  assert.ok(punisherTag && movementTag, 'both Tags are seeded at startup');

  const sweep = await createMove({ name: 'MP Sweep', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [sweep, punisherTag.id]);
  // A long-running Movement move, so it is still on the clock when the sweep
  // lands and there is something for the Recovery to be added to.
  const dash = await createMove({ name: 'MP Dash', startupTics: 1, activeTics: 3, recoveryTics: 2, rollSlots: ['Body'] });
  await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [dash, movementTag.id]);

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: sweep, placementTic: 0, startupTics: 1 });
  const dashId = await declareMove({ characterId: defender, moveId: dash, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const fired = events
    .filter((e) => e.type === 'automation_fired')
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.sourceName === 'Movement Punisher');
  assert.ok(fired, `the trip should reach the round log: ${events.map((e) => e.type).join(', ')}`);
  assert.equal(fired.sourceKind, 'tag');
  assert.equal(fired.trigger, 'movement_punished');
  // It runs through the ordinary Add Recovery effect, so it reports the same
  // way one authored on a move would — but as **Trip** Recovery (revised):
  // being caught mid-stride puts you on the floor, which is a different state
  // from being slow to recover, and the log has to say which one happened.
  assert.ok(fired.effects.some((x) => /\+3 Trip Recovery/.test(x)), JSON.stringify(fired.effects));

  // And the Recovery actually landed on the clock, not just in the log.
  const dm = await one(
    'SELECT reveal_tic, recovery_extension_tics, trip_recovery_tics FROM declared_moves WHERE id = ?',
    [dashId]
  );
  const displaced = (dm?.recovery_extension_tics ?? 0) > 0 || dm?.reveal_tic > 1;
  assert.ok(displaced, `the Movement move should have been pushed about: ${JSON.stringify(dm)}`);
  // The frames are marked as trip frames on the row itself, which is what the
  // Off The Ground Tag reads at declare time and what draws with the arrow.
  // Asserting only the log would pass while the column stayed 0.
  assert.equal(dm?.trip_recovery_tics, 3, JSON.stringify(dm));
});

test('Movement Punisher does nothing without both Tags', async () => {
  const pairIndex = 323;
  const attacker = await createCharacter('Plain Attacker');
  const defender = await createCharacter('Plain Runner');
  await setDieSize(attacker, 'Skull', 12);
  const movementTag = await one("SELECT id FROM tags WHERE name = 'Movement'");

  // The target IS moving; the attack is simply not a punisher.
  const punch = await createMove({ name: 'MPN Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const dash = await createMove({ name: 'MPN Dash', startupTics: 1, activeTics: 3, recoveryTics: 2, rollSlots: ['Body'] });
  await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [dash, movementTag.id]);

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: dash, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const fired = events
    .filter((e) => e.type === 'automation_fired')
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.sourceName === 'Movement Punisher');
  assert.equal(fired, undefined, 'an ordinary punch trips nobody');
});

// ---------- The move-reveal chat card, restored (decided, new) ----------

test('a move reaching its reveal Tic posts its own chat card', async () => {
  const pairIndex = 324;
  const attacker = await createCharacter('Card Thrower');
  const defender = await createCharacter('Card Watcher');
  const jab = await createMove({
    name: 'Card Jab',
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: jab, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const cards = await all(
    "SELECT * FROM chat_log WHERE kind = 'move_reveal' AND move_id = ?",
    [jab]
  );
  // Exactly one — `reveal_posted` makes the reveal loop idempotent, so
  // stepping the same Tic twice must not post the card twice.
  assert.equal(cards.length, 1, 'one card per reveal, not one per Tic');
  assert.equal(cards[0].character_id, attacker, 'attributed to whoever threw it');
  // The card carries no content of its own: everything it renders is joined
  // from the move row at read time (see GET /api/chat), which is what lets a
  // GM fix a typo in a move name and have the log say the right thing.
  assert.equal(cards[0].content, null);
});

test('the reveal card is the only thing that entitles a move to be read in full', async () => {
  // The gate `move:request_detail` applies has two halves, and this pins the
  // second one: a move nobody has revealed has no move_reveal row, so even a
  // Genius Observer asking for its id by hand gets nothing. Without this, the
  // Perk would read the GM's whole unrevealed library.
  const pairIndex = 325;
  const attacker = await createCharacter('Secretive');
  const defender = await createCharacter('Onlooker');
  const shown = await createMove({
    name: 'Shown Move', startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'],
  });
  const hidden = await createMove({
    name: 'Never Declared', startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: shown, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const revealed = async (moveId) =>
    Boolean(await one("SELECT 1 AS ok FROM chat_log WHERE kind = 'move_reveal' AND move_id = ? LIMIT 1", [moveId]));
  assert.equal(await revealed(shown), true);
  assert.equal(await revealed(hidden), false, 'a move never declared was never revealed');
});

// ---------- Playtest Perk batch: thresholds, riposte, healing ----------

// The Minimum Damage Threshold Perks are easiest to see on a roll that sits
// exactly between the moved bar and the game's own 5, so both fixtures pin the
// attacker's roll with a modifier rather than hoping for a die face.
const thresholdFight = async (pairIndex, { attackerPerk = null, targetPerk = null, rollModifier }) => {
  const attacker = await createCharacter(`TH Attacker ${pairIndex}`);
  const defender = await createCharacter(`TH Defender ${pairIndex}`);
  if (attackerPerk) await grantPerk(attacker, attackerPerk);
  if (targetPerk) await grantPerk(defender, targetPerk);
  const jab = await createMove({
    name: `TH Jab ${pairIndex}`,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier, attackTargets: ['Body'],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: jab, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);
  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  return events.map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }));
};

test('Iron Skin turns a hit that would have landed into nothing', async () => {
  // Math.random is pinned to 0.999999 for this whole file and createCharacter
  // seeds every die at d8, so the attack always rolls its top face: 8 − 2 = a
  // total of 6. Six is one Half-Damage step normally, and nothing at all
  // against a threshold of 7.
  const bare = await thresholdFight(340, { rollModifier: -2 });
  assert.ok(bare.some((e) => e.type === 'damage_applied'), 'the bare fixture has to actually land');
  assert.ok(!bare.some((e) => e.type === 'insignificant_damage'));

  const armoured = await thresholdFight(341, { targetPerk: 'Iron Skin', rollModifier: -2 });
  assert.ok(
    armoured.some((e) => e.type === 'insignificant_damage'),
    `the same roll should now be insignificant: ${armoured.map((e) => e.type).join(', ')}`
  );
  assert.ok(!armoured.some((e) => e.type === 'damage_applied'), 'and deal nothing');
});

test('Not Just a Scratch turns nothing into half a point', async () => {
  // 8 − 4 = 4. Nothing normally; half a point against a threshold of 3.
  const bare = await thresholdFight(342, { rollModifier: -4 });
  assert.ok(bare.some((e) => e.type === 'insignificant_damage'), 'the bare fixture has to be a nothing');
  assert.ok(!bare.some((e) => e.type === 'damage_applied'));

  const sharpened = await thresholdFight(343, { attackerPerk: 'Not Just a Scratch', rollModifier: -4 });
  assert.ok(
    sharpened.some((e) => e.type === 'damage_applied'),
    `the same roll should now land: ${sharpened.map((e) => e.type).join(', ')}`
  );
  assert.ok(!sharpened.some((e) => e.type === 'insignificant_damage'));
  // **The FIRST gate only.** Asserted on the die rather than on the event's
  // payload shape: a 4 is worth exactly one half-step, which is a Body still at
  // d8 carrying a pending marker — not a die that dropped a size.
  // **The FIRST gate only.** A 4 is worth exactly one half-step — checked both
  // in the event and on the die it names, which is what a half-step actually
  // looks like: the size unchanged, a pending marker set. Read off the event's
  // own slot rather than a slot the fixture assumed, so this keeps testing the
  // threshold rather than the targeting rule.
  const hit = sharpened.find((e) => e.type === 'damage_applied' && e.payload.slotName);
  assert.ok(hit, `something should have been damaged: ${JSON.stringify(sharpened.map((e) => e.type))}`);
  assert.equal(hit.payload.steps, 1, 'a 4 buys one step, not two');
  const die = await one(
    'SELECT * FROM dice WHERE character_id = ? AND slot_name = ?',
    [hit.payload.characterId ?? hit.payload.targetCharacterId, hit.payload.slotName]
  );
  assert.equal(die.current_size, 8, 'one half-step does not drop the die yet');
  assert.equal(die.half_damage, 1, 'it leaves the pending marker');
});

test('the two threshold Perks cancel when they meet', async () => {
  // +2 and −2 on opposite sides of the same exchange is the plain 5 again, and
  // needed no rule of its own — the seams simply sum.
  const both = await thresholdFight(344, {
    attackerPerk: 'Not Just a Scratch',
    targetPerk: 'Iron Skin',
    rollModifier: -4,
  });
  assert.ok(
    both.some((e) => e.type === 'insignificant_damage'),
    `a 4 against a restored threshold of 5 is nothing: ${both.map((e) => e.type).join(', ')}`
  );
});

test('Spiked Shell bites the hand that threw the punch, on a Full Block only', async () => {
  const pairIndex = 345;
  const attacker = await createCharacter('SS Puncher');
  const blocker = await createCharacter('SS Blocker');
  await grantPerk(blocker, 'Spiked Shell');
  // The blocker needs to out-roll the attack by 5+ for the Perk to pay, so the
  // guard is given a large modifier and the punch a small one.
  await setDieSize(blocker, 'Body', 12);
  const punch = await createMove({
    name: 'SS Punch',
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Right Hand'], rollModifier: 0, attackTargets: ['Body'],
  });
  const guard = await createMove({
    name: 'SS Guard',
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Body'], rollModifier: 20,
    isDefensive: true, defenseKind: 'block', defenseFramePositions: [1, 2],
  });

  await seatPair(pairIndex, attacker, blocker);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: blocker, moveId: guard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const fired = events
    .filter((e) => e.type === 'automation_fired')
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.sourceName === 'Spiked Shell');
  assert.ok(fired, `the riposte should reach the round log: ${events.map((e) => e.type).join(', ')}`);
  assert.equal(fired.sourceKind, 'perk');
  assert.equal(fired.trigger, 'block_riposte');
  // It lands on the limb that swung, named — not on the blocker, and not on
  // whatever the punch was aimed at.
  assert.ok(
    fired.effects.some((x) => /Right Hand/.test(x)),
    JSON.stringify(fired.effects)
  );
  const hand = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Right Hand'", [attacker]);
  assert.ok(hand.half_damage || hand.current_size < 8, `the puncher's hand should be hurt: ${JSON.stringify(hand)}`);
});

test('Spiked Shell pays nothing when the guard did not out-roll the attack', async () => {
  const pairIndex = 346;
  const attacker = await createCharacter('SS2 Puncher');
  const blocker = await createCharacter('SS2 Blocker');
  await grantPerk(blocker, 'Spiked Shell');
  await setDieSize(attacker, 'Right Hand', 12);
  // A big punch against a bare guard: the block may or may not hold, but it
  // certainly does not beat the attack roll by 5.
  const punch = await createMove({
    name: 'SS2 Punch',
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Right Hand'], rollModifier: 20, attackTargets: ['Body'],
  });
  const guard = await createMove({
    name: 'SS2 Guard',
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Body'], rollModifier: -20,
    isDefensive: true, defenseKind: 'block', defenseFramePositions: [1, 2],
  });

  await seatPair(pairIndex, attacker, blocker);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: blocker, moveId: guard, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const fired = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .filter((e) => e.type === 'automation_fired')
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.sourceName === 'Spiked Shell');
  assert.equal(fired, undefined, 'a guard that was beaten sends nothing back');
});

test('Healing Factor sheds one pending Half-Damage at Round Start', async () => {
  const character = await createCharacter('HF Regenerator');
  await grantPerk(character, 'Healing Factor');
  await run("UPDATE dice SET half_damage = 1 WHERE character_id = ? AND slot_name IN ('Skull', 'Body')", [
    character,
  ]);

  await openRoundForCharacters(mockIo, [character]);

  const marked = await all('SELECT slot_name FROM dice WHERE character_id = ? AND half_damage = 1', [character]);
  // Exactly one, not both and not none — the seam says how many, and the engine
  // picks that many at random from the Stats actually showing a marker.
  assert.equal(marked.length, 1, `one marker should have gone: ${JSON.stringify(marked)}`);
});

test('Healing Factor does nothing when no Stat is showing a marker', async () => {
  // The narrow reading, pinned: it clears pending halves and never steps a die
  // back up, so a fighter whose damage has all resolved into whole steps heals
  // nothing. Recovering whole steps is what the Recover Stat effect is for.
  const character = await createCharacter('HF Nothing To Heal');
  await grantPerk(character, 'Healing Factor');
  await run("UPDATE dice SET current_size = 4, half_damage = 0 WHERE character_id = ? AND slot_name = 'Skull'", [
    character,
  ]);

  await openRoundForCharacters(mockIo, [character]);

  const skull = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [character]);
  assert.equal(skull.current_size, 4, 'a stepped-down die is not stepped back up');
  assert.equal(skull.half_damage, 0, 'and no marker is invented for it');
});

test('a character with no Healing Factor keeps every marker', async () => {
  const character = await createCharacter('HF Control');
  await run("UPDATE dice SET half_damage = 1 WHERE character_id = ? AND slot_name = 'Body'", [character]);
  await openRoundForCharacters(mockIo, [character]);
  const body = await one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Body'", [character]);
  assert.equal(body.half_damage, 1);
});

// ---------------------------------------------------------------------------
// The GM adjudicates a Block (decided, reversed — this is the Defence rework's
// decision #1 landing, and it reverses the Combat Automation overhaul's own
// decision #1: "Block is fully automatic, purely dice-based, zero GM clicks,
// ever"). Overlapping in time was being taken as proof the guard was the RIGHT
// guard, and nothing in the frame data can tell a front guard from a side one.
// ---------------------------------------------------------------------------

// Attacker Skull d12 (forced max, so 12); defender Left Hand d12 guard.
async function adjudicatedBlock({ pairIndex, attackTargets = null, defenderHandSize = 12 }) {
  const attacker = await createCharacter(`BA${pairIndex}`);
  const defender = await createCharacter(`BD${pairIndex}`);
  await setDieSize(attacker, 'Skull', 12);
  await setDieSize(defender, 'Left Hand', defenderHandSize);
  const punch = await createMove({
    name: `BPunch${pairIndex}`,
    startupTics: 1,
    activeTics: 2,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    attackTargets,
  });
  const guard = await createMove({
    name: `BGuard${pairIndex}`,
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
  const attackerDM = await declareMove({
    characterId: attacker,
    moveId: punch,
    placementTic: 0,
    startupTics: 1,
    // move:declare snapshots the move's own attack_targets into this column for
    // real declarations; this helper defaults it to ["Skull"], so a multi-Stat
    // attack has to say so here or only the Skull line is ever asked about.
    ...(attackTargets ? { effectiveAttackTargets: attackTargets } : {}),
  });
  await declareMove({ characterId: defender, moveId: guard, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
  await advancePairResolution(pairIndex, mockIo);
  return { attacker, defender, attackerDM };
}

const pauseStateOf = (pairIndex) =>
  one(
    `SELECT status, pending_defense_json FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1`,
    [pairIndex]
  );

test('a Block stops the round and asks the GM, instead of resolving itself', async () => {
  const pairIndex = 460;
  const { attackerDM } = await adjudicatedBlock({ pairIndex });

  const paused = await pauseStateOf(pairIndex);
  assert.equal(paused.status, 'paused_defense');
  const pending = JSON.parse(paused.pending_defense_json);
  assert.equal(pending.attackerDeclaredMoveId, attackerDM);
  assert.equal(pending.coverage.coverage, 'full');

  // The prompt is a round_event, so it reaches the GM live AND replays.
  const prompt = await one(
    `SELECT payload FROM round_events WHERE pair_index = ? AND type = 'block_prompt'`,
    [pairIndex]
  );
  assert.ok(prompt, 'the Block prompt must be a round_event like the Dodge prompt is');
  assert.equal(JSON.parse(prompt.payload).attackerResult, 12);

  // Nothing has been applied while the question stands.
  const skull = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [
    (await one('SELECT character_id FROM combat_participants WHERE pair_index = ? AND side = ?', [pairIndex, 'right'])).character_id,
  ]);
  assert.equal(skull.current_size, 8, 'a paused Block must not have damaged anything yet');
});

test('Successful: the guard rolls and the Block resolves as it always did', async () => {
  const pairIndex = 461;
  const { defender } = await adjudicatedBlock({ pairIndex });
  await resolveBlock(pairIndex, { outcome: 'successful' }, mockIo);

  const done = await pauseStateOf(pairIndex);
  assert.equal(done.status, 'complete');
  // Attack 12 vs guard 12 — a Full Block, no damage anywhere.
  const dice = await all('SELECT slot_name, current_size, half_damage FROM dice WHERE character_id = ?', [defender]);
  assert.ok(
    dice.every((d) => d.current_size === (d.slot_name === 'Left Hand' ? 12 : 8) && d.half_damage === 0),
    'a Full Block leaves the blocker untouched'
  );
  const outcome = await one(
    `SELECT payload FROM round_events WHERE pair_index = ? AND type = 'block_resolved'`,
    [pairIndex]
  );
  assert.equal(JSON.parse(outcome.payload).outcome, 'successful');
});

test('Failed: the guard is discarded and the attack lands as if it were never declared', async () => {
  const pairIndex = 462;
  const { defender } = await adjudicatedBlock({ pairIndex });
  await resolveBlock(pairIndex, { outcome: 'failed' }, mockIo);

  // Damage on the Stat the ATTACK named (Skull by default), not redirected onto
  // the blocker's own rolled Stat — that redirect is the Successful Block rule,
  // and there was no successful Block.
  const skull = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skull.current_size, 6, '12 -> 2 half-steps -> one full rank down from d8');
  const hand = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'", [defender]);
  assert.equal(hand.current_size, 12, "the guard's own Stat takes nothing — it never guarded");

  // No guard roll happened at all. (The guard move rolls once more on its own
  // account — it carries an Attack Target of its own, so it is a counter-attack
  // as well as a guard — but never as a *defensive* roll.)
  const rolls = await all(
    `SELECT payload FROM round_events WHERE pair_index = ? AND type = 'roll' ORDER BY seq`,
    [pairIndex]
  );
  assert.equal(
    rolls.filter((r) => JSON.parse(r.payload).defensive).length,
    0,
    'a discarded guard must not be rolled'
  );
});

test('a rejected Block never extends the blocker\'s Recovery', async () => {
  // 'too-short' coverage is what triggers the extension. Confirming the guard
  // extends it; rejecting the guard must not — stretching a fighter's
  // commitment to hold something the GM just said did not happen would charge
  // them for it.
  const scenario = async (pairIndex, outcome) => {
    const attacker = await createCharacter(`XA${pairIndex}`);
    const defender = await createCharacter(`XD${pairIndex}`);
    const punch = await createMove({
      name: `XPunch${pairIndex}`,
      startupTics: 1,
      activeTics: 3,
      recoveryTics: 1,
      rollSlots: ['Skull'],
    });
    const guard = await createMove({
      name: `XGuard${pairIndex}`,
      startupTics: 1,
      activeTics: 1,
      recoveryTics: 1,
      rollSlots: ['Hand'],
      isDefensive: true,
      defenseKind: 'block',
      defenseFramePositions: [1], // the move's own Active frame -> Tic 1; the attack is Active 1-3
    });
    await seatPair(pairIndex, attacker, defender);
    await startPairDeclaration(mockIo, pairIndex);
    await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
    const guardDM = await declareMove({
      characterId: defender,
      moveId: guard,
      placementTic: 0,
      startupTics: 1,
      appendageChoice: 'left',
    });
    await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
    await advancePairResolution(pairIndex, mockIo);
    const paused = await pauseStateOf(pairIndex);
    assert.equal(JSON.parse(paused.pending_defense_json).coverage.coverage, 'too-short');
    await resolveBlock(pairIndex, { outcome }, mockIo);
    return one('SELECT recovery_extension_tics FROM declared_moves WHERE id = ?', [guardDM]);
  };

  const confirmed = await scenario(463, 'successful');
  assert.ok(confirmed.recovery_extension_tics > 0, 'a Block that held still extends to cover the swing');
  const rejected = await scenario(464, 'failed');
  assert.equal(rejected.recovery_extension_tics, 0);
});

test('one prompt per Stat: a two-Stat attack is adjudicated twice', async () => {
  const pairIndex = 465;
  await adjudicatedBlock({ pairIndex, attackTargets: ['Skull', 'Body'] });

  const first = JSON.parse((await pauseStateOf(pairIndex)).pending_defense_json);
  assert.deepEqual(first.remainingStats, ['Skull', 'Body']);

  await resolveBlock(pairIndex, { outcome: 'successful' }, mockIo);
  const second = await pauseStateOf(pairIndex);
  assert.equal(second.status, 'paused_defense', 'the second Stat gets its own question');
  assert.deepEqual(JSON.parse(second.pending_defense_json).remainingStats, ['Body']);

  await resolveBlock(pairIndex, { outcome: 'successful' }, mockIo);
  assert.equal((await pauseStateOf(pairIndex)).status, 'complete');
});

test('mixed answers: a guard that held anywhere still catches what got past it', async () => {
  // Skull called Failed, Body called Successful. The guard WAS up, so the
  // Successful Block redirect stands and the Failed line's full weight lands on
  // the Stat the blocker rolled rather than on the Skull the attack named.
  const pairIndex = 466;
  const { defender } = await adjudicatedBlock({ pairIndex, attackTargets: ['Skull', 'Body'] });
  await resolveBlock(pairIndex, { outcome: 'failed' }, mockIo);
  await resolveBlock(pairIndex, { outcome: 'successful' }, mockIo);

  const skull = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  const body = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Body'", [defender]);
  const hand = await one(
    "SELECT current_size, half_damage FROM dice WHERE character_id = ? AND slot_name = 'Left Hand'",
    [defender]
  );
  assert.equal(skull.current_size, 8, 'the named Stats are spared — the guard was up');
  assert.equal(body.current_size, 8);
  assert.equal(hand.current_size, 10, "the Failed line's 12 lands on the arm that held: 2 half-steps");
});

test('a stale answer for a different attack is rejected', async () => {
  const pairIndex = 467;
  await adjudicatedBlock({ pairIndex });
  await resolveBlock(pairIndex, { outcome: 'successful', attackerDeclaredMoveId: 999999 }, mockIo);
  assert.equal((await pauseStateOf(pairIndex)).status, 'paused_defense', 'the pause must survive a stale click');
  await resolveBlock(pairIndex, { outcome: 'successful' }, mockIo);
  assert.equal((await pauseStateOf(pairIndex)).status, 'complete');
});

// ---------------------------------------------------------------------------
// Damage aimed at a broken Stat (decided, new).
// ---------------------------------------------------------------------------

test('an attack on a broken Stat still resolves, and is reported at the end of the round', async () => {
  const pairIndex = 470;
  const attacker = await createCharacter('BrokenAtk');
  const defender = await createCharacter('BrokenDef');
  await setDieSize(attacker, 'Skull', 12);
  await run(
    `UPDATE dice SET status = 'incapacitated', current_size = 4, bonus = 0
     WHERE character_id = ? AND slot_name = 'Skull'`,
    [defender]
  );
  const punch = await createMove({
    name: 'Broken Punch',
    startupTics: 1,
    activeTics: 2,
    recoveryTics: 1,
    rollSlots: ['Skull'],
    attackTargets: ['Skull'],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  // It used to bail out here — no target, no event, silence.
  const noTarget = await all(
    `SELECT payload FROM round_events WHERE pair_index = ? AND type = 'damage_applied'`,
    [pairIndex]
  );
  assert.ok(
    !noTarget.some((e) => JSON.parse(e.payload).result === 'no-eligible-target'),
    'a broken Stat is no longer "nothing to hit"'
  );

  const unapplied = await all(
    `SELECT payload FROM round_events WHERE pair_index = ? AND type = 'damage_unapplied'`,
    [pairIndex]
  );
  assert.equal(unapplied.length, 1);
  const payload = JSON.parse(unapplied[0].payload);
  assert.equal(payload.slotName, 'Skull');
  assert.equal(payload.damage, 1); // Skull d12 forced max = 12 -> 2 half-steps -> 1.0

  // The die is untouched — nothing is redirected anywhere, it simply does not land.
  const skull = await one("SELECT current_size, status, half_damage FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skull.status, 'incapacitated');
  assert.equal(skull.current_size, 4);
  assert.equal(skull.half_damage, 0);

  const said = await all(
    `SELECT content FROM chat_log WHERE content LIKE '%should have been dealt%' ORDER BY id`
  );
  assert.equal(said.length, 1, 'exactly one line per Stat, at the end of the round');
  assert.equal(
    said[0].content,
    "1 damage should have been dealt to BrokenDef's Skull, but it cannot be applied. Take this into consideration for Injuries."
  );
});

// ---------- Second playtest Perk batch: tempo, the Jab, and feeding on pain ----------

const { perkStaminaCostDeltas, previousDeclaredMoveFacts } = await import('../perkEngine.js');

// The declare-time seam, exercised directly. `move:declare` itself lives in
// server/index.js, which boots a real HTTP server on import — but
// perkStaminaCostDeltas is import-safe and IS the whole rule, so the discount
// can be pinned here rather than only in a live playtest.
const deltaFor = async (characterId, move) =>
  (await perkStaminaCostDeltas({ characterId, moves: [move], dice: [], injuries: [] })).get(move.id) ?? 0;

const moveRow = (id) => one('SELECT * FROM moves WHERE id = ?', [id]);

test('Punches in Bunches: a punch after a punch, and nothing else', async () => {
  const fighter = await createCharacter('PiB Fighter');
  await grantPerk(fighter, 'Punches in Bunches');
  const straight = await createMove({ name: 'PiB Straight', rollSlots: ['Hand'], attackTargets: ['Skull'] });
  const kick = await createMove({ name: 'PiB Kick', rollSlots: ['Leg'], attackTargets: ['Body'] });

  // Nothing queued yet — there is no punch to be following.
  assert.equal(await deltaFor(fighter, await moveRow(straight)), 0, 'the first punch of a round is full price');

  await declareMove({ characterId: fighter, moveId: straight, placementTic: 0, startupTics: 1 });
  assert.equal(await deltaFor(fighter, await moveRow(straight)), -1, 'a punch behind a punch is a Stamina cheaper');
  // The Perk is about what you throw, not just what you threw: a kick behind a
  // punch is still a kick.
  assert.equal(await deltaFor(fighter, await moveRow(kick)), 0);

  // ...and a punch behind a KICK gets nothing either, which is the half of the
  // rule a "did I punch recently?" implementation would have got wrong.
  const other = await createCharacter('PiB Kicker');
  await grantPerk(other, 'Punches in Bunches');
  await declareMove({ characterId: other, moveId: kick, placementTic: 0, startupTics: 1 });
  assert.equal(await deltaFor(other, await moveRow(straight)), 0);
});

test('Punches in Bunches does nothing for a fighter who does not have it', async () => {
  const fighter = await createCharacter('PiB Nobody');
  const straight = await createMove({ name: 'PiB2 Straight', rollSlots: ['Hand'], attackTargets: ['Skull'] });
  await declareMove({ characterId: fighter, moveId: straight, placementTic: 0, startupTics: 1 });
  assert.equal(await deltaFor(fighter, await moveRow(straight)), 0);
});

test('The Simplest Tool discounts the Jab, and only a move actually called Jab', async () => {
  const fighter = await createCharacter('TST Fighter');
  await grantPerk(fighter, 'The Simplest Tool');
  const jab = await createMove({ name: 'Jab', rollSlots: ['Hand'], attackTargets: ['Skull'] });
  const almost = await createMove({ name: 'Power Jab', rollSlots: ['Hand'], attackTargets: ['Skull'] });

  assert.equal(await deltaFor(fighter, await moveRow(jab)), -1);
  assert.equal(await deltaFor(fighter, await moveRow(almost)), 0, 'exact names only');
});

test('the two discounts stack, because every seam is folded additively', async () => {
  // A Jab thrown behind another punch is both things at once. Nobody wrote a
  // rule for the meeting — the seam simply sums, which is the whole point of
  // the doctrine in perks/index.js.
  const fighter = await createCharacter('Stack Fighter');
  await grantPerk(fighter, 'The Simplest Tool');
  await grantPerk(fighter, 'Punches in Bunches');
  const jab = await createMove({ name: 'Jab', rollSlots: ['Hand'], attackTargets: ['Skull'] });
  const straight = await createMove({ name: 'Stack Straight', rollSlots: ['Hand'], attackTargets: ['Skull'] });

  assert.equal(await deltaFor(fighter, await moveRow(jab)), -1, 'a lone Jab is the Jab discount only');
  await declareMove({ characterId: fighter, moveId: straight, placementTic: 0, startupTics: 1 });
  assert.equal(await deltaFor(fighter, await moveRow(jab)), -2, 'a Jab behind a punch is both');
});

test('a queued move is priced against ITS OWN predecessor, not the last one declared', async () => {
  // **The regression this batch's live playtest caught.** getPendingStaminaCost
  // totals up a whole Declaration's worth of already-queued moves, and a single
  // shared "previous move" measured every one of them against whatever went
  // down LAST — so the punch that was quoted at full price came out discounted
  // at commit, and a combo was charged a figure nobody was ever shown.
  const fighter = await createCharacter('Queue Fighter');
  await grantPerk(fighter, 'Punches in Bunches');
  const first = await createMove({ name: 'Q First', rollSlots: ['Hand'], attackTargets: ['Skull'] });
  const second = await createMove({ name: 'Q Second', rollSlots: ['Hand'], attackTargets: ['Skull'] });

  const dm1 = await declareMove({ characterId: fighter, moveId: first, placementTic: 0, startupTics: 1 });
  const dm2 = await declareMove({ characterId: fighter, moveId: second, placementTic: 3, startupTics: 1 });

  const rows = [
    { ...(await moveRow(first)), declared_move_id: dm1 },
    { ...(await moveRow(second)), declared_move_id: dm2 },
  ];
  const deltas = await perkStaminaCostDeltas({ characterId: fighter, moves: rows, dice: [], injuries: [] });
  assert.equal(deltas.get(first), 0, 'the first punch of the round follows nothing and is full price');
  assert.equal(deltas.get(second), -1, 'the second follows the first and is a Stamina cheaper');
});

test('previousDeclaredMoveFacts orders by footprint end, not by when it was declared', async () => {
  // The trap this exists to avoid: a short move declared LATER can still finish
  // before a long one declared earlier, so reveal_tic is the wrong key.
  const fighter = await createCharacter('Order Fighter');
  const long = await createMove({ name: 'Order Long', activeTics: 4, recoveryTics: 2, rollSlots: ['Hand'] });
  const short = await createMove({ name: 'Order Short', activeTics: 1, recoveryTics: 0, rollSlots: ['Leg'] });
  await declareMove({ characterId: fighter, moveId: long, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: fighter, moveId: short, placementTic: 0, startupTics: 1 });

  const previous = await previousDeclaredMoveFacts(fighter);
  assert.equal(previous.name, 'Order Long', 'the move that ends last is the one you are coming off');
});

test('Deadly Pendulum: +2 on the attack behind a Dodge the GM called Successful', async () => {
  const pairIndex = 360;
  const attacker = await createCharacter('DP Swinger');
  const opponent = await createCharacter('DP Opponent');
  await grantPerk(attacker, 'Deadly Pendulum');

  // The opponent's punch, which the Dodge will get out of the way of.
  const punch = await createMove({ name: 'DP Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'] });
  // Two Active Tics guarded on both — the shape writeMove would actually store
  // (sanitizeDefensePositions drops a Defense Frame outside the Active window),
  // and enough to cover the attack's own two Active Tics rather than coming out
  // 'too-short' and auto-Failing with no prompt.
  const dodge = await createMove({
    name: 'DP Slip', startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Body'], isDefensive: true, defenseKind: 'dodge', defenseFramePositions: [1, 2],
  });
  // The counter, queued behind the Dodge so its footprint ends later.
  const counter = await createMove({ name: 'DP Counter', startupTics: 1, activeTics: 1, recoveryTics: 0, rollSlots: ['Skull'], attackTargets: ['Body'] });

  await seatPair(pairIndex, attacker, opponent);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: opponent, moveId: punch, placementTic: 0, startupTics: 1 });
  const dodgeDM = await declareMove({ characterId: attacker, moveId: dodge, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: attacker, moveId: counter, placementTic: 4, startupTics: 1 });
  await resolvePair(pairIndex);
  await resolveDodge(pairIndex, { outcome: 'successful' }, mockIo);

  // The verdict is on the row, which is what the Perk reads back.
  const dodged = await one('SELECT defense_outcome FROM declared_moves WHERE id = ?', [dodgeDM]);
  assert.equal(dodged.defense_outcome, 'success');

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const counterRoll = events
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }))
    .find((e) => e.type === 'roll' && e.payload.moveName === 'DP Counter');
  assert.ok(counterRoll, `the counter should have rolled: ${events.map((e) => e.type).join(', ')}`);
  const term = (counterRoll.payload.modifierBreakdown ?? []).find((t) => t.label === 'Deadly Pendulum');
  assert.ok(term, `the Perk has to be named in the breakdown: ${JSON.stringify(counterRoll.payload.modifierBreakdown)}`);
  assert.equal(term.amount, 2);
});

test('Deadly Pendulum pays nothing when the Dodge failed', async () => {
  const pairIndex = 361;
  const attacker = await createCharacter('DP2 Swinger');
  const opponent = await createCharacter('DP2 Opponent');
  await grantPerk(attacker, 'Deadly Pendulum');
  const punch = await createMove({ name: 'DP2 Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'] });
  // Two Active Tics guarded on both — the shape writeMove would actually store
  // (sanitizeDefensePositions drops a Defense Frame outside the Active window),
  // and enough to cover the attack's own two Active Tics rather than coming out
  // 'too-short' and auto-Failing with no prompt.
  const dodge = await createMove({
    name: 'DP2 Slip', startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Body'], isDefensive: true, defenseKind: 'dodge', defenseFramePositions: [1, 2],
  });
  const counter = await createMove({ name: 'DP2 Counter', startupTics: 1, activeTics: 1, recoveryTics: 0, rollSlots: ['Skull'], attackTargets: ['Body'] });

  await seatPair(pairIndex, attacker, opponent);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: opponent, moveId: punch, placementTic: 0, startupTics: 1 });
  const dodgeDM = await declareMove({ characterId: attacker, moveId: dodge, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: attacker, moveId: counter, placementTic: 4, startupTics: 1 });
  await resolvePair(pairIndex);
  await resolveDodge(pairIndex, { outcome: 'failed' }, mockIo);

  const dodged = await one('SELECT defense_outcome FROM declared_moves WHERE id = ?', [dodgeDM]);
  assert.equal(dodged.defense_outcome, 'failed');

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const counterRoll = events
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }))
    .find((e) => e.type === 'roll' && e.payload.moveName === 'DP2 Counter');
  assert.ok(counterRoll);
  assert.ok(
    !(counterRoll.payload.modifierBreakdown ?? []).some((t) => t.label === 'Deadly Pendulum'),
    'a dodge that did not work is not a pendulum'
  );
});

test('a Dodge the GM called Failed reads as failed even when the attack was too feeble to hurt', async () => {
  // **Caught live, by the failed-Dodge arm of the playtest collecting its +2.**
  // resolveDodge routes on whether any damage got through, and an attack under
  // the Minimum Damage Threshold gets through for zero — which correctly sends
  // it down the no-damage path, but does NOT mean the guard worked. Taking the
  // verdict from that figure wrote 'success' onto a Dodge the GM had just
  // rejected, and Deadly Pendulum paid out on it.
  const pairIndex = 364;
  const attacker = await createCharacter('Feeble Attacker');
  const defender = await createCharacter('Feeble Defender');
  await grantPerk(defender, 'Deadly Pendulum');
  // 8 − 5 = 3, under the threshold: a hit that deals nothing whatever the GM says.
  const poke = await createMove({
    name: 'Feeble Poke', startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: -5, attackTargets: ['Body'],
  });
  const dodge = await createMove({
    name: 'Feeble Slip', startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Body'], isDefensive: true, defenseKind: 'dodge', defenseFramePositions: [1, 2],
  });
  const counter = await createMove({
    name: 'Feeble Counter', startupTics: 1, activeTics: 1, recoveryTics: 0,
    rollSlots: ['Skull'], attackTargets: ['Body'],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: poke, placementTic: 0, startupTics: 1 });
  const dodgeDM = await declareMove({ characterId: defender, moveId: dodge, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: counter, placementTic: 4, startupTics: 1 });
  await resolvePair(pairIndex);
  await resolveDodge(pairIndex, { outcome: 'failed' }, mockIo);

  const row = await one('SELECT defense_outcome FROM declared_moves WHERE id = ?', [dodgeDM]);
  assert.equal(row.defense_outcome, 'failed', 'the GM said Failed; nothing about the damage changes that');

  const events = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }));
  const counterRoll = events.find((e) => e.type === 'roll' && e.payload.moveName === 'Feeble Counter');
  assert.ok(counterRoll);
  assert.ok(
    !(counterRoll.payload.modifierBreakdown ?? []).some((t) => t.label === 'Deadly Pendulum'),
    'and so the counter behind it is not a pendulum'
  );
});

test('Baron of Suffering: Stamina back for every half-point that lands', async () => {
  const pairIndex = 362;
  const attacker = await createCharacter('BoS Attacker');
  const defender = await createCharacter('BoS Defender');
  await grantPerk(attacker, 'Baron of Suffering');
  await run('UPDATE characters SET current_stamina = 10 WHERE id = ?', [attacker]);

  // d8 top face, +2 = 10 → two Half-Damage steps → 2 Stamina.
  const punch = await createMove({
    name: 'BoS Punch', startupTics: 1, activeTics: 1, recoveryTics: 0,
    rollSlots: ['Skull'], rollModifier: 2, attackTargets: ['Body'],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({
    characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1,
    effectiveAttackTargets: ['Body'],
  });
  await resolvePair(pairIndex);

  const events = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }));
  const hit = events.find((e) => e.type === 'damage_applied' && e.payload.slotName);
  assert.ok(hit, 'the fixture has to actually land');
  assert.equal(hit.payload.steps, 2);

  const gain = events.find((e) => e.type === 'stamina_changed' && e.payload.characterId === attacker);
  assert.ok(gain, `the attacker should have gained Stamina: ${events.map((e) => e.type).join(', ')}`);
  assert.equal(gain.payload.delta, 2, 'one Stamina per half-point of the two that landed');
});

test('Baron of Suffering pays nothing for damage that cannot be applied', async () => {
  // Damage aimed at a Stat already broken lands nowhere and is reported at the
  // end of the round instead — so there is nothing to feed on. This is the
  // half of "damage dealt" a naive reading off the ROLL would have got wrong.
  const pairIndex = 363;
  const attacker = await createCharacter('BoS2 Attacker');
  const defender = await createCharacter('BoS2 Defender');
  await grantPerk(attacker, 'Baron of Suffering');
  await run(
    "UPDATE dice SET status = 'incapacitated', current_size = 4 WHERE character_id = ? AND slot_name = 'Body'",
    [defender]
  );

  const punch = await createMove({
    name: 'BoS2 Punch', startupTics: 1, activeTics: 1, recoveryTics: 0,
    rollSlots: ['Skull'], rollModifier: 2, attackTargets: ['Body'],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({
    characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1,
    effectiveAttackTargets: ['Body'],
  });
  await resolvePair(pairIndex);

  const events = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }));
  assert.ok(events.some((e) => e.type === 'damage_unapplied'), 'the fixture has to hit the broken Stat');
  assert.ok(
    !events.some((e) => e.type === 'stamina_changed' && e.payload.characterId === attacker && e.payload.delta > 0),
    'no damage was dealt, so nothing is owed'
  );
});

// ---------- Third playtest Perk batch: splash, Grounded, Dogfighter ----------

// An attack whose damage all lands on one named Stat, so a splash Perk has a
// clean figure to price off. `rollModifier` sets how much lands.
const splashFight = async (pairIndex, tag, { perk, rollModifier, target, breakSlot = null }) => {
  const attacker = await createCharacter(`${tag} Attacker`);
  const defender = await createCharacter(`${tag} Defender`);
  if (perk) await grantPerk(attacker, perk);
  if (breakSlot) {
    await run("UPDATE dice SET status = 'incapacitated', current_size = 4 WHERE character_id = ? AND slot_name = ?", [
      defender,
      breakSlot,
    ]);
  }
  const punch = await createMove({
    name: `${tag} Punch`, startupTics: 1, activeTics: 1, recoveryTics: 0,
    rollSlots: ['Skull'], rollModifier, attackTargets: [target],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({
    characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1,
    effectiveAttackTargets: [target],
  });
  await resolvePair(pairIndex);
  const events = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }));
  return { attacker, defender, events };
};

test('Piercing Headache splashes the Brain once per FULL point on the Skull', async () => {
  // d8 top face + 2 = 10, which is two Half-Damage steps — one whole point —
  // so exactly one half-step reaches the Brain.
  const { defender, events } = await splashFight(370, 'PH', {
    perk: 'Piercing Headache', rollModifier: 2, target: 'Skull',
  });
  const skull = events.find((e) => e.type === 'damage_applied' && e.payload.slotName === 'Skull');
  assert.ok(skull, `the blow has to land on the Skull: ${events.map((e) => e.type).join(', ')}`);
  assert.equal(skull.payload.steps, 2, 'two half-steps is one Full Damage');

  const brain = events.find((e) => e.type === 'damage_applied' && e.payload.slotName === 'Brain');
  assert.ok(brain, 'the splash should reach the Brain');
  assert.equal(brain.payload.steps, 1, 'one Full Damage buys one half-step');

  const die = await one("SELECT current_size, half_damage FROM dice WHERE character_id = ? AND slot_name = 'Brain'", [defender]);
  assert.equal(die.current_size, 8, 'a single half-step does not drop the die');
  assert.equal(die.half_damage, 1, 'it leaves the pending marker');
});

test('half a point on the Skull splashes nothing', async () => {
  // 8 − 2 = 6: one half-step, which is not a Full Damage.
  const { events } = await splashFight(371, 'PH2', {
    perk: 'Piercing Headache', rollModifier: -2, target: 'Skull',
  });
  const skull = events.find((e) => e.type === 'damage_applied' && e.payload.slotName === 'Skull');
  assert.equal(skull?.payload.steps, 1);
  assert.ok(
    !events.some((e) => e.type === 'damage_applied' && e.payload.slotName === 'Brain'),
    'half a point is not a Full Damage'
  );
});

test('a splash onto a broken Stat is reported, not silently dropped', async () => {
  const { events } = await splashFight(372, 'PH3', {
    perk: 'Piercing Headache', rollModifier: 2, target: 'Skull', breakSlot: 'Brain',
  });
  assert.ok(
    events.some((e) => e.type === 'damage_applied' && e.payload.slotName === 'Skull'),
    'the blow itself still lands'
  );
  const unapplied = events.find((e) => e.type === 'damage_unapplied' && e.payload.slotName === 'Brain');
  assert.ok(unapplied, 'the splash the Brain could not take has to be reported');
  assert.equal(unapplied.payload.damage, 0.5);
});

test('Last Breath Taker is the same rule, Body to Stamina', async () => {
  const { events } = await splashFight(373, 'LBT', {
    perk: 'Last Breath Taker', rollModifier: 2, target: 'Body',
  });
  const body = events.find((e) => e.type === 'damage_applied' && e.payload.slotName === 'Body');
  assert.equal(body?.payload.steps, 2);
  const stamina = events.find((e) => e.type === 'damage_applied' && e.payload.slotName === 'Stamina');
  assert.ok(stamina, 'the Stamina Stat should take the splash');
  assert.equal(stamina.payload.steps, 1);
});

test('the splash Perks do not fire for each other', async () => {
  // Piercing Headache reads the Skull; a blow to the Body is none of its
  // business, and vice versa.
  const { events } = await splashFight(374, 'PH4', {
    perk: 'Piercing Headache', rollModifier: 2, target: 'Body',
  });
  assert.ok(events.some((e) => e.type === 'damage_applied' && e.payload.slotName === 'Body'));
  assert.ok(!events.some((e) => e.type === 'damage_applied' && e.payload.slotName === 'Brain'));
});

test('Baron of Suffering is paid for the splash as well as the blow', async () => {
  // Decided: damage dealt is damage dealt, wherever on the body it ended up.
  // Two steps on the Skull plus one splashed onto the Brain is three.
  const pairIndex = 375;
  const attacker = await createCharacter('BSP Attacker');
  const defender = await createCharacter('BSP Defender');
  await grantPerk(attacker, 'Piercing Headache');
  await grantPerk(attacker, 'Baron of Suffering');
  await run('UPDATE characters SET current_stamina = 10 WHERE id = ?', [attacker]);
  const punch = await createMove({
    name: 'BSP Punch', startupTics: 1, activeTics: 1, recoveryTics: 0,
    rollSlots: ['Skull'], rollModifier: 2, attackTargets: ['Skull'],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({
    characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1,
    effectiveAttackTargets: ['Skull'],
  });
  await resolvePair(pairIndex);

  const gain = await refundEvent(pairIndex, /damage dealt/);
  assert.ok(gain, 'the Baron should have been paid');
  assert.equal(gain.delta, 3, '2 steps on the Skull + 1 splashed on the Brain');
});

test('Baron of Suffering is paid for a step taken out of your OWN Stat', async () => {
  // Decided, new: a stat step is damage dealt, and the dealer is whoever owns
  // the effect — not whoever it landed on. A move that costs you a step of your
  // own Body fed the Baron nothing at all before this, because he was paid only
  // out of the damage an *attack* wrote to a die.
  const pairIndex = 380;
  const attacker = await createCharacter('BSS Attacker');
  const defender = await createCharacter('BSS Defender');
  await grantPerk(attacker, 'Baron of Suffering');
  await run('UPDATE characters SET current_stamina = 10 WHERE id = ?', [attacker]);
  // The blow itself must pay nothing, or there is no telling which payment the
  // assertion below is reading: aimed at a Stat that is already out, so the
  // attack's own damage lands nowhere (see "pays nothing for damage that cannot
  // be applied") and the stat step is the only thing left to feed on.
  await run(
    "UPDATE dice SET status = 'incapacitated', current_size = 4, bonus = 0 WHERE character_id = ? AND slot_name = 'Body'",
    [defender]
  );
  const wildSwing = await createMove({
    name: 'BSS Wild Swing', startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 20, attackTargets: ['Body'],
    interactions: [
      { trigger: 'hit', text: '', automations: [{ type: 'self_stat_step', amount: 2, slot: 'Left Hand' }] },
    ],
  });
  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({
    characterId: attacker, moveId: wildSwing, placementTic: 0, startupTics: 1,
    effectiveAttackTargets: ['Body'],
  });
  await resolvePair(pairIndex);

  const stepped = (await all('SELECT payload FROM round_events WHERE pair_index = ? AND type = ?', [pairIndex, 'stat_stepped']))
    .map((r) => JSON.parse(r.payload));
  assert.equal(stepped.length, 1, 'the fixture has to actually step something');
  assert.equal(stepped[0].characterId, attacker, 'and step it on its own user');

  const gain = await refundEvent(pairIndex, /damage dealt/);
  assert.ok(gain, 'the Baron should have been paid for the two steps');
  assert.equal(gain.delta, 2, 'one Stamina per half-point, wherever the damage landed');
  assert.equal(gain.characterId, attacker, 'paid to the dealer, who here is also the target');
});

test('Baron of Suffering is not paid for healing, nor for a step onto a broken Stat', async () => {
  // The two halves that stop "a stat step is damage dealt" from being a licence
  // to print Stamina: an upward step is not damage at all, and a step aimed at
  // a Stat already at the floor lands nowhere — the same reading applyAutoDamage
  // gives when it sorts a blow into `unapplied`.
  const heal = async (pairIndex, automation, prepare = async () => {}) => {
    const attacker = await createCharacter(`BSN${pairIndex} Attacker`);
    const defender = await createCharacter(`BSN${pairIndex} Defender`);
    await grantPerk(attacker, 'Baron of Suffering');
    await run('UPDATE characters SET current_stamina = 10 WHERE id = ?', [attacker]);
    // Same isolation as the test above: the blow lands on a Stat already out,
    // so anything the Baron is paid here came from the automation.
    await run(
      "UPDATE dice SET status = 'incapacitated', current_size = 4, bonus = 0 WHERE character_id = ? AND slot_name = 'Body'",
      [defender]
    );
    await prepare(attacker);
    const move = await createMove({
      name: `BSN${pairIndex} Move`, startupTics: 1, activeTics: 2, recoveryTics: 1,
      rollSlots: ['Skull'], rollModifier: 20, attackTargets: ['Body'],
      interactions: [{ trigger: 'hit', text: '', automations: [automation] }],
    });
    await seatPair(pairIndex, attacker, defender);
    await startPairDeclaration(mockIo, pairIndex);
    await declareMove({
      characterId: attacker, moveId: move, placementTic: 0, startupTics: 1,
      effectiveAttackTargets: ['Body'],
    });
    await resolvePair(pairIndex);
    return refundEvent(pairIndex, /damage dealt/);
  };

  assert.equal(
    await heal(381, { type: 'self_stat_step', amount: -1, slot: 'Left Hand' }),
    undefined,
    'stepping a Stat back UP is healing, and healing is not damage dealt'
  );
  assert.equal(
    await heal(382, { type: 'self_stat_step', amount: 2, slot: 'Left Hand' }, async (attacker) => {
      await run(
        "UPDATE dice SET status = 'incapacitated', current_size = 4, bonus = 0 WHERE character_id = ? AND slot_name = ?",
        [attacker, 'Left Hand']
      );
    }),
    undefined,
    'a Stat already at the floor has nowhere to go, so nothing was dealt'
  );
});

test('Dogfighter makes a move harder to break up, by exactly 2', async () => {
  const { perkInterruptAmounts } = await import('../perkEngine.js');
  const fighter = await createCharacter('DF Fighter');
  assert.deepEqual(await perkInterruptAmounts(fighter), { interrupter: 0, hardToInterrupt: 0 });
  await grantPerk(fighter, 'Dogfighter');
  assert.deepEqual(
    await perkInterruptAmounts(fighter),
    { interrupter: 0, hardToInterrupt: 2 },
    'it defends only — a Dogfighter is no better at interrupting others'
  );
});

test('Grounded is asked of the fighter who would be tripped', async () => {
  const { perkIgnoresMovementPunisher } = await import('../perkEngine.js');
  const mover = await createCharacter('GR Mover');
  assert.equal(await perkIgnoresMovementPunisher(mover), false);
  await grantPerk(mover, 'Grounded');
  assert.equal(await perkIgnoresMovementPunisher(mover), true);
});

test('Grounded keeps a fighter on their feet through a Movement Punisher', async () => {
  // The same fixture as the Movement Punisher test above, with the runner
  // carrying Grounded — so the trip is set up in full and then refused.
  const pairIndex = 376;
  const attacker = await createCharacter('GRP Punisher');
  const defender = await createCharacter('GRP Runner');
  await grantPerk(defender, 'Grounded');
  await setDieSize(attacker, 'Skull', 12);

  const [punisherTag, movementTag] = await Promise.all([
    one("SELECT id FROM tags WHERE name = 'Movement Punisher'"),
    one("SELECT id FROM tags WHERE name = 'Movement'"),
  ]);
  const sweep = await createMove({ name: 'GRP Sweep', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [sweep, punisherTag.id]);
  const dash = await createMove({ name: 'GRP Dash', startupTics: 1, activeTics: 3, recoveryTics: 2, rollSlots: ['Body'] });
  await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [dash, movementTag.id]);

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: sweep, placementTic: 0, startupTics: 1 });
  const dashId = await declareMove({ characterId: defender, moveId: dash, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const fired = (await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]))
    .filter((e) => e.type === 'automation_fired')
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.sourceName === 'Movement Punisher');
  assert.ok(!fired, 'the trip must not fire against a Grounded fighter');

  const dm = await one('SELECT recovery_extension_tics FROM declared_moves WHERE id = ?', [dashId]);
  assert.equal(dm?.recovery_extension_tics ?? 0, 0, 'and no Recovery is imposed');

  // Said out loud, so a table watching the punisher connect knows why nothing
  // happened.
  const said = await one(
    `SELECT content FROM chat_log WHERE content LIKE '%keeps their feet%' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(said, 'the refusal should be announced');
  assert.match(said.content, /GRP Runner/);
});


// --- Pause delivery -------------------------------------------------------
//
// Reported from play: "all GM prompts break if the GM is not present at the
// exact moment of resolution. If the GM was using a phone and locked it, the
// prompt is never shown and the fight becomes corrupted, without the ability to
// proceed further." The pause itself was always durable; what was not was
// getting the question in front of anyone afterwards.

test('the defence prompt is worded once, and the same way for both kinds', () => {
  const pending = {
    attackerDeclaredMoveId: 7,
    attackerCharacterName: 'Attacker',
    attackerMoveName: 'Straight',
    defenderDeclaredMoveId: 9,
    defenderCharacterName: 'Defender',
    defenderMoveName: 'Guard',
    attackerResult: 14,
    coverage: { coverage: 'too-short' },
    remainingStats: ['Skull', 'Body'],
    tic: 3,
    // Pause bookkeeping the question has no business carrying.
    stepsBySlot: { Skull: 2 },
    leftoverResult: 4,
  };

  const block = defensePromptPayload(pending, 'block');
  assert.equal(block.defenseKind, 'block');
  // Flattened, not nested: the client used to unwrap this itself, in two
  // different places, and only one of them agreed with the live push.
  assert.equal(block.coverage, 'too-short');
  // The question is about the Stat at the head of the queue.
  assert.equal(block.targetSlotName, 'Skull');
  assert.deepEqual(block.remainingStats, ['Skull', 'Body']);
  assert.equal(block.attackerResult, 14);
  // Pause internals stay in the pause.
  assert.equal(block.stepsBySlot, undefined);
  assert.equal(block.leftoverResult, undefined);

  // A Dodge only ever reaches a person on full coverage, so it reports none.
  const dodge = defensePromptPayload(pending, 'dodge');
  assert.equal(dodge.defenseKind, 'dodge');
  assert.equal(dodge.coverage, null);

  // A move with no Attack Target of its own is one question about the attack.
  const whole = defensePromptPayload({ ...pending, remainingStats: [] }, 'dodge');
  assert.equal(whole.targetSlotName, null);
  assert.deepEqual(whole.remainingStats, []);

  assert.equal(defensePromptPayload(null, 'dodge'), null);
});

test('raising a pause broadcasts it, so it reaches more than whoever was watching', async () => {
  const pairIndex = 260;
  const io = makeIo();
  const attacker = await createCharacter('Broadcast Attacker');
  const defender = await createCharacter('Broadcast Defender');
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'BC Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const dodge = await createMove({
    name: 'BC Dodge',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'dodge',
    defenseFramePositions: [0, 1, 2],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(io, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: dodge, placementTic: 0, startupTics: 1, appendageChoice: 'left' });

  const before = io.snapshotBroadcasts;
  await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
  await advancePairResolution(pairIndex, io);

  const resolution = await one('SELECT status FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(resolution.status, 'paused_dodge');
  assert.ok(
    io.snapshotBroadcasts > before,
    'the pause was raised without broadcasting — nobody who was not already listening can learn about it'
  );

  await resolveDodge(pairIndex, { outcome: 'failed' }, io);
});

test('a pause raised while NOBODY is connected is still waiting when someone comes back', async () => {
  const pairIndex = 261;
  // Not one socket in the registry: the GM locked their phone before the round
  // even reached the guard, so every live push in the world lands nowhere.
  const empty = makeIo([]);
  const attacker = await createCharacter('Absent Attacker');
  const defender = await createCharacter('Absent Defender');
  await setDieSize(attacker, 'Skull', 12);
  const punch = await createMove({ name: 'AB Punch', startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'] });
  const dodge = await createMove({
    name: 'AB Dodge',
    startupTics: 1,
    activeTics: 1,
    recoveryTics: 1,
    rollSlots: ['Hand'],
    isDefensive: true,
    defenseKind: 'dodge',
    defenseFramePositions: [0, 1, 2],
  });

  await seatPair(pairIndex, attacker, defender);
  await startPairDeclaration(empty, pairIndex);
  const attackerDMId = await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: defender, moveId: dodge, placementTic: 0, startupTics: 1, appendageChoice: 'left' });
  await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
  await advancePairResolution(pairIndex, empty);

  // The question is on the row, fully worded, waiting. This is what the
  // reconnecting GM is handed off the combat snapshot.
  const paused = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(paused.status, 'paused_dodge');
  const prompt = defensePromptPayload(JSON.parse(paused.pending_dodge_json), 'dodge');
  assert.equal(prompt.attackerDeclaredMoveId, attackerDMId);
  assert.equal(prompt.attackerResult, 12);

  // Nothing was decided in their absence.
  const skullDuring = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skullDuring.current_size, 8);

  // They come back on an entirely new connection and answer.
  const reconnected = makeIo();
  await resolveDodge(pairIndex, { outcome: 'failed' }, reconnected);

  const after = await one('SELECT status, pending_dodge_json FROM pair_round_resolutions WHERE pair_index = ? AND round_number = 1', [pairIndex]);
  assert.equal(after.status, 'complete');
  assert.equal(after.pending_dodge_json, null);
  const skullAfter = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [defender]);
  assert.equal(skullAfter.current_size, 6);
});

// --- A Movement move on a broken Leg fizzles --------------------------------

test('a Movement move whose owner lost a Leg mid-round is lost, and refunded', async () => {
  const pairIndex = 270;
  const io = makeIo();
  const runner = await createCharacter('Fizzle Runner');
  const other = await createCharacter('Fizzle Other');
  await setDieSize(runner, 'Skull', 12);

  // The Tag has to exist and be on the move for the rule to see it.
  const tagResult = await run("INSERT INTO tags (name, description) VALUES ('Movement', 'footwork')");
  const tagId = Number(tagResult.lastInsertRowid);
  const dash = await createMove({
    name: 'Fizzle Dash',
    startupTics: 1,
    activeTics: 2,
    recoveryTics: 1,
    rollSlots: ['Skull'],
  });
  await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [dash, tagId]);
  // A cost to refund, and room to refund it into — adjustStamina clamps to Max,
  // so a fighter already at full would show no change however correct the rule.
  await run('UPDATE moves SET stamina_cost = 4 WHERE id = ?', [dash]);

  await seatPair(pairIndex, runner, other);
  await startPairDeclaration(io, pairIndex);
  const dmId = await declareMove({ characterId: runner, moveId: dash, placementTic: 0, startupTics: 1 });
  // Charged, as Done Declaring would have.
  await run('UPDATE declared_moves SET stamina_committed = 1 WHERE id = ?', [dmId]);
  await run('UPDATE characters SET current_stamina = 5 WHERE id = ?', [runner]);
  const before = (await getCharacterRow(runner)).current_stamina;

  // The leg goes between declaring and resolving — which is the whole case.
  await run(
    "UPDATE dice SET status = 'incapacitated' WHERE character_id = ? AND slot_name = 'Left Leg'",
    [runner]
  );
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const fizzled = events.find((e) => e.type === 'move_fizzled');
  assert.ok(fizzled, 'the move should have been reported lost, not silently skipped');
  assert.equal(JSON.parse(fizzled.payload).reason, 'broken-leg');

  // Nothing was rolled for it, and nobody was hit by it.
  assert.ok(!events.some((e) => e.type === 'roll' && JSON.parse(e.payload).declaredMoveId === dmId));
  const otherSkull = await one("SELECT current_size FROM dice WHERE character_id = ? AND slot_name = 'Skull'", [other]);
  assert.equal(otherSkull.current_size, 8);

  // And the Stamina came back — the fighter did not choose this.
  const after = (await getCharacterRow(runner)).current_stamina;
  assert.ok(after > before, `expected a refund, ${before} -> ${after}`);
});

// --- A move pushed wholly into the next round is that round's declaration ---

test('a move whose whole footprint left its round is re-homed, uncommitted and refunded', async () => {
  const pairIndex = 271;
  const io = makeIo();
  const a = await createCharacter('Rehome A');
  const b = await createCharacter('Rehome B');
  const punch = await createMove({ name: 'Rehome Punch', startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'] });
  await run('UPDATE moves SET stamina_cost = 3 WHERE id = ?', [punch]);

  await seatPair(pairIndex, a, b);
  await startPairDeclaration(io, pairIndex);
  const roundOne = await one('SELECT round_number, round_start_tic FROM combat_pairs WHERE pair_index = ?', [pairIndex]);

  // Declared for round 1, then shoved bodily past the end of it — which is
  // what a Block's extended Recovery or an imposed Recovery does.
  const dmId = await declareMove({ characterId: a, moveId: punch, placementTic: 0, startupTics: 1 });
  const pushedTo = roundOne.round_start_tic + 8; // past a 7-Tic round
  await run(
    'UPDATE declared_moves SET placement_tic = ?, reveal_tic = ?, stamina_committed = 1 WHERE id = ?',
    [pushedTo, pushedTo + 1, dmId]
  );
  await run('UPDATE characters SET current_stamina = 5 WHERE id = ?', [a]);
  const before = (await getCharacterRow(a)).current_stamina;

  // Finish the round and open the next one.
  await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
  await startPairDeclaration(io, pairIndex);

  const moved = await one('SELECT round_number, stamina_committed FROM declared_moves WHERE id = ?', [dmId]);
  assert.equal(moved.round_number, roundOne.round_number + 1, 'it should belong to the round it now sits in');
  assert.equal(moved.stamina_committed, 0, 'and be pending again, so it can be cancelled');
  const after = (await getCharacterRow(a)).current_stamina;
  assert.ok(after > before, `expected a refund, ${before} -> ${after}`);
});

test('an ordinary carryover is left exactly where it is', async () => {
  const pairIndex = 272;
  const io = makeIo();
  const a = await createCharacter('Carry A');
  const b = await createCharacter('Carry B');
  // Long enough to still be running when the next round opens, but it STARTED
  // in its own round — that is a carryover, not a move that was pushed out.
  const slow = await createMove({ name: 'Carry Slow', startupTics: 1, activeTics: 1, recoveryTics: 9, rollSlots: ['Skull'] });

  await seatPair(pairIndex, a, b);
  await startPairDeclaration(io, pairIndex);
  const roundOne = await one('SELECT round_number FROM combat_pairs WHERE pair_index = ?', [pairIndex]);
  const dmId = await declareMove({ characterId: a, moveId: slow, placementTic: 0, startupTics: 1 });
  await run('UPDATE declared_moves SET stamina_committed = 1 WHERE id = ?', [dmId]);

  await run(`UPDATE combat_pairs SET phase = 'resolving' WHERE pair_index = ?`, [pairIndex]);
  await startPairDeclaration(io, pairIndex);

  const still = await one('SELECT round_number, stamina_committed FROM declared_moves WHERE id = ?', [dmId]);
  assert.equal(still.round_number, roundOne.round_number, 'a carryover keeps its own round');
  assert.equal(still.stamina_committed, 1, 'and stays paid for');
});

// Appended at the end of the file deliberately: these tests share a stubbed
// `Math.random` sequence, and inserting a new fight into the middle shifts every
// roll after it — which is how adding this test first broke an unrelated splash
// assertion three hundred lines above.
test('Osu!: +2 named in the breakdown on an Attack, and nothing on a guard', async () => {
  const pairIndex = 372;
  const attacker = await createCharacter('Osu Striker');
  const opponent = await createCharacter('Osu Opponent');
  await grantPerk(attacker, 'Osu!');

  const punch = await createMove({ name: 'Osu Punch', startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'] });
  const bait = await createMove({ name: 'Osu Bait', startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'] });

  await seatPair(pairIndex, attacker, opponent);
  await startPairDeclaration(mockIo, pairIndex);
  await declareMove({ characterId: attacker, moveId: punch, placementTic: 0, startupTics: 1 });
  await declareMove({ characterId: opponent, moveId: bait, placementTic: 0, startupTics: 1 });
  await resolvePair(pairIndex);

  const events = await all('SELECT type, payload FROM round_events WHERE pair_index = ? ORDER BY seq', [pairIndex]);
  const rolls = events.map((e) => ({ type: e.type, payload: JSON.parse(e.payload) })).filter((e) => e.type === 'roll');
  const mine = rolls.find((r) => r.payload.moveName === 'Osu Punch');
  assert.ok(mine, `the Perk holder should have rolled: ${events.map((e) => e.type).join(', ')}`);
  // Named, not folded silently into a total — the registry's own rule: a Perk
  // that changes a number says so out loud.
  const term = (mine.payload.modifierBreakdown ?? []).find((t) => t.label === 'Osu!');
  assert.ok(term, `Osu! has to be named in the breakdown: ${JSON.stringify(mine.payload.modifierBreakdown)}`);
  assert.equal(term.amount, 2);

  // And it is the Perk holder's bonus alone — the opponent throwing the very
  // same shape of move gets nothing.
  const theirs = rolls.find((r) => r.payload.moveName === 'Osu Bait');
  assert.ok(theirs);
  assert.equal((theirs.payload.modifierBreakdown ?? []).find((t) => t.label === 'Osu!'), undefined);
});

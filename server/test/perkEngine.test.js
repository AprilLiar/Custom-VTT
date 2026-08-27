// server/perkEngine.js — the folding rules and the per-grant state store.
//
// The architecture is in server/perks/index.js; what is pinned here is the
// behaviour that makes it safe to keep adding Perks forever:
//
//   - contributions FOLD rather than compete, so no Perk can depend on how many
//     other Perks a character happens to have, or on grant order;
//   - a granted Perk with no code is silently nothing, because that is the
//     normal case (most Perks are flavour) and must never throw;
//   - "once per round" really is once, and the reset really is per-pair.
//
// Same per-file temp-DB + dynamic-import setup as roundResolution.test.js:
// Node's test runner isolates each FILE, so one database per file is enough.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `perk-engine-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;

const { initDb, run, one } = await import('../db.js');
const { PERK_REGISTRY } = await import('../perks/index.js');
const {
  clearAllPerkState,
  clearPerkState,
  consumeOnce,
  perkAllowsRevealedDetail,
  perkDefinitionsFor,
  perkMoveFrameDeltas,
  perkRollBonusTerms,
  perkBlockPenaltyAgainstYou,
  perkAbsorbBreak,
  perkSeesAttackHeight,
  readPerkState,
  writePerkState,
} = await import('../perkEngine.js');

before(async () => {
  await initDb();
});
after(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* fine */ }
  }
});

let seq = 0;
const makeCharacter = async (name) => {
  const result = await run(
    'INSERT INTO characters (name, character_type, max_stamina, current_stamina) VALUES (?, ?, ?, ?)',
    [`${name}-${++seq}`, 'npc', 20, 20]
  );
  return Number(result.lastInsertRowid);
};

// Registers a Perk definition AND its compendium row, then grants it —
// the same three things that have to line up in production.
const grant = async (characterId, definition) => {
  PERK_REGISTRY[definition.name] = definition;
  const perk = await run('INSERT INTO perks (name, description) VALUES (?, ?)', [definition.name, '']);
  const perkId = Number(perk.lastInsertRowid);
  const granted = await run('INSERT INTO character_perks (character_id, perk_id) VALUES (?, ?)', [
    characterId,
    perkId,
  ]);
  return { perkId, characterPerkId: Number(granted.lastInsertRowid) };
};

const unregister = (...names) => names.forEach((n) => delete PERK_REGISTRY[n]);

test('a granted Perk with no code behind it is simply absent', async () => {
  const characterId = await makeCharacter('Flavour');
  const perk = await run('INSERT INTO perks (name, description) VALUES (?, ?)', ['Purely Narrative', '']);
  await run('INSERT INTO character_perks (character_id, perk_id) VALUES (?, ?)', [
    characterId,
    Number(perk.lastInsertRowid),
  ]);
  // Most Perks in a real world are exactly this. Every resolver has to answer
  // "nothing" rather than throwing, or one flavour Perk breaks every roll the
  // character makes.
  assert.deepEqual(await perkDefinitionsFor(characterId), []);
  assert.deepEqual(await perkRollBonusTerms(characterId), []);
  assert.equal(await perkAllowsRevealedDetail(characterId), false);
});

test('a character with no Perks at all resolves to nothing', async () => {
  const characterId = await makeCharacter('Bare');
  assert.deepEqual(await perkRollBonusTerms(characterId), []);
  assert.equal(await perkAllowsRevealedDetail(characterId), false);
  // And a caller with no character in hand at all — the manual-roll paths can
  // legitimately pass null.
  assert.deepEqual(await perkRollBonusTerms(null), []);
});

test('rollBonus: two Perks SUM, and each keeps its own name on the total', async () => {
  const characterId = await makeCharacter('Stacked');
  await grant(characterId, { name: 'Test Steady Hand', rollBonus: () => 1 });
  await grant(characterId, { name: 'Test Killer Instinct', rollBonus: () => 2 });
  try {
    const terms = await perkRollBonusTerms(characterId);
    assert.equal(terms.length, 2);
    assert.equal(terms.reduce((sum, t) => sum + t.amount, 0), 3);
    // One named term per Perk, never one lump: a Perk that moves a total has to
    // be readable in the breakdown or it is indistinguishable from the engine
    // inventing numbers.
    assert.deepEqual(
      terms.map((t) => t.label).sort(),
      ['Test Killer Instinct', 'Test Steady Hand']
    );
    assert.ok(terms.every((t) => t.key.startsWith('perk:')));
  } finally {
    unregister('Test Steady Hand', 'Test Killer Instinct');
  }
});

test('rollBonus: a Perk contributing 0 is dropped rather than shown as +0', async () => {
  const characterId = await makeCharacter('Conditional');
  await grant(characterId, { name: 'Test Situational', rollBonus: () => 0 });
  try {
    assert.deepEqual(await perkRollBonusTerms(characterId), []);
  } finally {
    unregister('Test Situational');
  }
});

test('rollBonus: the seam sees the live character row, so a condition can read state', async () => {
  const characterId = await makeCharacter('Cornered');
  await grant(characterId, {
    name: 'Test Desperate',
    rollBonus: ({ character }) => (character.current_stamina <= 5 ? 2 : 0),
  });
  try {
    assert.deepEqual(await perkRollBonusTerms(characterId), []);
    await run('UPDATE characters SET current_stamina = 4 WHERE id = ?', [characterId]);
    const terms = await perkRollBonusTerms(characterId);
    assert.equal(terms.length, 1);
    assert.equal(terms[0].amount, 2);
  } finally {
    unregister('Test Desperate');
  }
});

test('boolean seams OR — one yes is a yes, regardless of order', async () => {
  const characterId = await makeCharacter('Observer');
  await grant(characterId, { name: 'Test Says No', canSeeRevealedDetail: () => false });
  try {
    assert.equal(await perkAllowsRevealedDetail(characterId), false);
    await grant(characterId, { name: 'Test Says Yes', canSeeRevealedDetail: () => true });
    assert.equal(await perkAllowsRevealedDetail(characterId), true);
  } finally {
    unregister('Test Says No', 'Test Says Yes');
  }
});

test('consumeOnce: true the first time, false every time after', async () => {
  const characterId = await makeCharacter('Charged');
  const { characterPerkId } = await grant(characterId, { name: 'Test Once', rollBonus: () => 0 });
  try {
    assert.equal(await consumeOnce(characterPerkId, 'fired', 'round'), true);
    assert.equal(await consumeOnce(characterPerkId, 'fired', 'round'), false);
    assert.equal(await consumeOnce(characterPerkId, 'fired', 'round'), false);
    // A different key is a different charge on the same grant.
    assert.equal(await consumeOnce(characterPerkId, 'other', 'round'), true);
  } finally {
    unregister('Test Once');
  }
});

test('clearPerkState is scoped BOTH by scope and by character', async () => {
  const mine = await makeCharacter('Mine');
  const theirs = await makeCharacter('Theirs');
  const a = await grant(mine, { name: 'Test Scope A', rollBonus: () => 0 });
  const b = await grant(theirs, { name: 'Test Scope B', rollBonus: () => 0 });
  try {
    await writePerkState(a.characterPerkId, 'perRound', 1, 'round');
    await writePerkState(a.characterPerkId, 'perFight', 1, 'fight');
    await writePerkState(b.characterPerkId, 'perRound', 1, 'round');

    await clearPerkState('round', [mine]);

    // The round charge came back for the character whose round it was...
    assert.equal(await readPerkState(a.characterPerkId, 'perRound'), 0);
    // ...their fight-long charge did NOT, because a round is not a fight...
    assert.equal(await readPerkState(a.characterPerkId, 'perFight'), 1);
    // ...and the fighter in the OTHER pair keeps theirs. This is the whole
    // point: rounds belong to a pair, so an unrelated fight reaching its next
    // round must not refresh anybody here.
    assert.equal(await readPerkState(b.characterPerkId, 'perRound'), 1);
  } finally {
    unregister('Test Scope A', 'Test Scope B');
  }
});

test('clearPerkState with no characters does nothing at all', async () => {
  const characterId = await makeCharacter('Untouched');
  const { characterPerkId } = await grant(characterId, { name: 'Test Empty Sweep', rollBonus: () => 0 });
  try {
    await writePerkState(characterPerkId, 'k', 1, 'round');
    // An empty seat list must be a no-op, never "clear everything" — the
    // difference between a pair with nobody in it and a global wipe.
    await clearPerkState('round', []);
    await clearPerkState('round', undefined);
    assert.equal(await readPerkState(characterPerkId, 'k'), 1);

    // The global wipe is a separate, deliberately-named call.
    await clearAllPerkState('round');
    assert.equal(await readPerkState(characterPerkId, 'k'), 0);
  } finally {
    unregister('Test Empty Sweep');
  }
});

test('revoking a Perk takes its state with it', async () => {
  const characterId = await makeCharacter('Revoked');
  const { characterPerkId } = await grant(characterId, { name: 'Test Revoke', rollBonus: () => 3 });
  try {
    await writePerkState(characterPerkId, 'charge', 1, 'fight');
    await run('DELETE FROM character_perks WHERE id = ?', [characterPerkId]);
    // ON DELETE CASCADE, so perk:revoke needs no line of its own for this.
    const leftover = await one(
      'SELECT COUNT(*) AS count FROM character_perk_state WHERE character_perk_id = ?',
      [characterPerkId]
    );
    assert.equal(Number(leftover.count), 0);
    assert.deepEqual(await perkRollBonusTerms(characterId), []);
  } finally {
    unregister('Test Revoke');
  }
});

// --- the moveFrameDelta seam (Osu!) --------------------------------------
//
// Frames a Perk adds to one move for one character. Folded into the same
// per-character override deltas `getMovesFor` already applies, which is why
// this is a seam and not rows written at grant time: a move learned *after*
// the Perk was granted has to get them too, and a snapshot cannot do that.
const makeMove = async (name, extra = {}) => {
  const tell = await run("INSERT INTO tells (name) VALUES (?)", [`${name}-tell-${++seq}`]);
  const result = await run(
    `INSERT INTO moves (name, tell_id, startup_tics, active_tics, recovery_tics, is_defensive, attack_targets)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      `${name}-${seq}`,
      Number(tell.lastInsertRowid),
      extra.startupTics ?? 1,
      extra.activeTics ?? 1,
      extra.recoveryTics ?? 1,
      extra.isDefensive ? 1 : 0,
      JSON.stringify(extra.attackTargets ?? ['Skull']),
    ]
  );
  return one('SELECT * FROM moves WHERE id = ?', [Number(result.lastInsertRowid)]);
};

test('moveFrameDelta: a Perk adds frames to the moves it names, and only those', async () => {
  const characterId = await makeCharacter('framer');
  await grant(characterId, {
    name: `Slow Attacker ${++seq}`,
    description: '',
    moveFrameDelta: ({ move }) => (move.isDefensive ? {} : { recovery: 1 }),
  });
  const attack = await makeMove('fd-attack');
  const guard = await makeMove('fd-guard', { isDefensive: true, attackTargets: [] });

  const deltas = await perkMoveFrameDeltas({ characterId, moves: [attack, guard] });
  assert.deepEqual(deltas.get(attack.id), { startup: 0, active: 0, recovery: 1 });
  // Not merely 0 — absent, so the caller keeps its own stored deltas object
  // untouched rather than allocating a new one for every move in the list.
  assert.equal(deltas.get(guard.id), undefined);
});

test('moveFrameDelta: two Perks on the same move add up, field by field', async () => {
  const characterId = await makeCharacter('double-framer');
  await grant(characterId, {
    name: `Recovery A ${++seq}`, description: '',
    moveFrameDelta: () => ({ recovery: 1 }),
  });
  await grant(characterId, {
    name: `Recovery B ${++seq}`, description: '',
    moveFrameDelta: () => ({ recovery: 2, startup: 1 }),
  });
  const move = await makeMove('fd-both');
  const deltas = await perkMoveFrameDeltas({ characterId, moves: [move] });
  assert.deepEqual(deltas.get(move.id), { startup: 1, active: 0, recovery: 3 });
});

test('moveFrameDelta: a character with no such Perk costs nothing and answers empty', async () => {
  const characterId = await makeCharacter('plain');
  const move = await makeMove('fd-plain');
  const deltas = await perkMoveFrameDeltas({ characterId, moves: [move] });
  assert.equal(deltas.size, 0);
  assert.deepEqual(await perkMoveFrameDeltas({ characterId, moves: [] }), new Map());
});

test('Osu!: +1 Recovery on an Attack, nothing on a guard', async () => {
  // The real definition, not a stand-in — the point is that its own reading of
  // "Attack" is the shared one, so the clause that charges the Recovery and the
  // clause that pays the bonus can never disagree about which moves they mean.
  const characterId = await makeCharacter('osu');
  const perk = await one("SELECT id FROM perks WHERE name = 'Osu!'");
  assert.ok(perk, 'Osu! is seeded from the registry at startup');
  await run('INSERT INTO character_perks (character_id, perk_id) VALUES (?, ?)', [characterId, perk.id]);

  const attack = await makeMove('osu-attack');
  const guard = await makeMove('osu-guard', { isDefensive: true, attackTargets: [] });
  const deltas = await perkMoveFrameDeltas({ characterId, moves: [attack, guard] });
  assert.deepEqual(deltas.get(attack.id), { startup: 0, active: 0, recovery: 1 });
  assert.equal(deltas.get(guard.id), undefined);
});


// ---------------------------------------------------------------------------
// The Path To Mastery batch, and Eye Catcher
// ---------------------------------------------------------------------------
//
// Appended at the end of the file rather than filed beside the seam each one
// uses, for the same reason the note in roundResolution.test.js gives: these
// share a database with everything above and each `makeCharacter` bumps `seq`.
// Inserting mid-file shifts nothing here (no shared Math.random), but keeping
// the convention means the next person does not have to work out whether it
// does.

const grantSeeded = async (characterId, name) => {
  const perk = await one('SELECT id FROM perks WHERE name = ?', [name]);
  assert.ok(perk, `${name} is seeded from the registry at startup`);
  await run('INSERT INTO character_perks (character_id, perk_id) VALUES (?, ?)', [characterId, perk.id]);
  return perk.id;
};

test('Path To Mastery: Speed takes a Tic off Startup, on everything', async () => {
  const characterId = await makeCharacter('speed');
  await grantSeeded(characterId, 'Path To Mastery: Speed');
  // Deliberately one attack and one defence-pure guard: "all your moves" means
  // all of them, and a seam that quietly read isAttackingMove would pass a test
  // that only ever handed it attacks.
  const attack = await makeMove('speed-attack');
  const guard = await makeMove('speed-guard', { isDefensive: true, attackTargets: [] });
  const deltas = await perkMoveFrameDeltas({ characterId, moves: [attack, guard] });
  assert.deepEqual(deltas.get(attack.id), { startup: -1, active: 0, recovery: 0 });
  assert.deepEqual(deltas.get(guard.id), { startup: -1, active: 0, recovery: 0 });
});

test('Path To Mastery: Strength penalises Blocks thrown at its holder', async () => {
  const attackerId = await makeCharacter('strong');
  const plainId = await makeCharacter('plain-attacker');
  await grantSeeded(attackerId, 'Path To Mastery: Strength');
  // The seam is asked about the ATTACKER — "Blocks against you" is a property
  // of who is swinging, not of who is guarding — so this is the number the
  // blocker's Defence Modifier picks up.
  assert.equal(await perkBlockPenaltyAgainstYou(attackerId), -5);
  assert.equal(await perkBlockPenaltyAgainstYou(plainId), 0);
  // A null attacker is the ordinary case for anything not thrown by a person
  // (see runBlockLine's call site), and must answer 0 rather than throw.
  assert.equal(await perkBlockPenaltyAgainstYou(null), 0);
});

test('Path To Mastery: Durability absorbs exactly two breaks, then stops', async () => {
  const characterId = await makeCharacter('durable');
  await grantSeeded(characterId, 'Path To Mastery: Durability');
  assert.equal(await perkAbsorbBreak(characterId), true);
  assert.equal(await perkAbsorbBreak(characterId), true);
  // Third time the Stat goes out like anybody else's.
  assert.equal(await perkAbsorbBreak(characterId), false);
  assert.equal(await perkAbsorbBreak(characterId), false);
});

test("Path To Mastery: Durability's charges are per Fight, and come back when one ends", async () => {
  const characterId = await makeCharacter('durable-refresh');
  await grantSeeded(characterId, 'Path To Mastery: Durability');
  assert.equal(await perkAbsorbBreak(characterId), true);
  assert.equal(await perkAbsorbBreak(characterId), true);
  assert.equal(await perkAbsorbBreak(characterId), false);
  // "First 2 times in a Fight" — the same scope combat:clear and the end of
  // combat already sweep for every other fight-scoped Perk.
  await clearAllPerkState('fight');
  assert.equal(await perkAbsorbBreak(characterId), true);
  assert.equal(await perkAbsorbBreak(characterId), true);
  assert.equal(await perkAbsorbBreak(characterId), false);
});

test('a character without Durability never absorbs anything', async () => {
  const characterId = await makeCharacter('breakable');
  assert.equal(await perkAbsorbBreak(characterId), false);
});

test('Eye Catcher answers the height seam; nobody else does', async () => {
  const seer = await makeCharacter('eye-catcher');
  const blind = await makeCharacter('no-eye-catcher');
  await grantSeeded(seer, 'Eye Catcher');
  assert.equal(await perkSeesAttackHeight(seer), true);
  assert.equal(await perkSeesAttackHeight(blind), false);
  assert.equal(await perkSeesAttackHeight(null), false);
});

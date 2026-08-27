// Playtest: the fifth batch of automated Perks.
//
//   Path To Mastery: Speed       — all your moves gain -1 to Startup
//   Path To Mastery: Strength    — Blocks against you take -5; your own
//                                  Damage Threshold drops by 1
//   Path To Mastery: Durability  — the first 2 Stats that would Break in a
//                                  Fight are held at 1d4 instead
//   Eye Catcher                  — you read High/Mid/Low on any attack aimed
//                                  at you, before it reveals
//
// Every probe is a **bare/granted pair of otherwise identical fights**, the
// method this repo has used since the grapple rework: what the Perk did is the
// difference between two runs, not a number read off an event and trusted.
//
// **Eye Catcher has to be here rather than in a unit test.** What it changes is
// the per-viewer shape of a payload — who is entitled to which key — and the
// only way to check an entitlement is to ask as somebody who does not have it.
// That takes a real socket identity and a real endpoint.
//
// **Durability has to be here too.** A charge is spent by the damage loop, not
// by the Perk, and only a real attack landing enough steps on a live Stat
// reaches the line that spends it.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3090 node server/index.js
//   E2E_URL=http://localhost:3090 node scripts/playtest-perks-batch5.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

gm.emit('identity:set', { role: 'gm' });
await sleep(500);
const stamp = Date.now();

// ============================================ 0. seeded and badged
console.log('--- the registry seeds the compendium ---');
const perks = await jf('/api/perks');
const byName = (n) => perks.find((p) => p.name === n);
const NAMES = [
  'Path To Mastery: Speed',
  'Path To Mastery: Strength',
  'Path To Mastery: Durability',
  'Eye Catcher',
];
for (const name of NAMES) {
  const perk = byName(name);
  check(`"${name}" was seeded`, perk != null, JSON.stringify(perks.map((p) => p.name)));
  check(`..."${name}" is flagged automated, not manual`,
    perk?.automated === true && perk?.manual === false, JSON.stringify(perk));
}
if (NAMES.some((n) => byName(n) == null)) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
const grant = async (characterId, name) => {
  gm.emit('perk:grant', { characterId, perkId: byName(name).id });
  await sleep(500);
};

gm.emit('tell:create', { name: `B5 Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `B5 Tell ${stamp}`);
const mk = async (name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// Seats a fresh pair and runs `rounds` rounds of `attackMove` from the left.
// The same shape playtest-perks-batch4 uses, with the round count opened up:
// Durability needs three consecutive breaks to show its charges running out.
const fight = async (label, {
  attackMove, attackerPerks = [], defenderPerks = [], defenceMove = null, rounds = 1,
  block = 'successful',
}) => {
  gm.emit('combat:clear', {});
  await sleep(800);
  const atk = await jpost('/api/characters', { name: `A${label}${stamp}`, characterType: 'npc' });
  const def = await jpost('/api/characters', { name: `D${label}${stamp}`, characterType: 'npc' });
  for (const p of attackerPerks) await grant(atk.id, p);
  for (const p of defenderPerks) await grant(def.id, p);
  gm.emit('combat:add_participant', { characterId: atk.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === atk.id));
  gm.emit('combat:add_participant', { characterId: def.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === def.id));

  const perRound = [];
  for (let round = 0; round < rounds; round++) {
    // Only nudge it if the pair is not already declaring — a resolution ends by
    // reopening declaration itself, and combat:next_round deliberately skips a
    // pair already there, so emitting it would produce no broadcast to wait on.
    const phase = (await jf('/api/combat?role=gm')).pairs?.[0]?.phase;
    if (phase !== 'declaration') {
      gm.emit('combat:next_round', {});
      try {
        await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration', 8000);
      } catch { break; }
    }
    const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
    for (let i = 0; i < 2; i++) {
      const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
      if (!side) break;
      if (side === 'left') {
        gm.emit('move:declare', { characterId: atk.id, moveId: attackMove.id, placementTic: start });
        await sleep(500);
        gm.emit('combat:character_done_declaring', { characterId: atk.id });
      } else {
        if (defenceMove) {
          gm.emit('move:declare', { characterId: def.id, moveId: defenceMove.id, placementTic: start });
          await sleep(500);
        }
        gm.emit('combat:character_done_declaring', { characterId: def.id });
      }
      await sleep(700);
    }
    for (let i = 0; i < 12; i++) {
      await sleep(900);
      const status = (await jf('/api/combat?role=gm')).pairs?.[0]?.resolutionStatus;
      if (status === 'paused_defense') gm.emit('combat:resolve_block', { pairIndex: 0, outcome: block });
      else if (status === 'paused_dodge') gm.emit('combat:resolve_dodge', { pairIndex: 0, outcome: 'failed' });
      else if (status == null || status === 'complete') break;
    }
    await sleep(1800);
    const chat = await jf('/api/chat');
    const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
    perRound.push(summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : []);
  }
  const chat = await jf('/api/chat');
  return { atk, def, rounds: perRound, events: perRound.flat(), chat };
};

// ============================================ 1. Speed
console.log('\n--- Path To Mastery: Speed: a Tic off the Startup of everything ---');
{
  const punch = await mk('B5 Punch', {
    startupTics: 3, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 0, attackTargets: ['Body'],
  });
  const guard = await mk('B5 Guard', {
    startupTics: 3, activeTics: 2, recoveryTics: 1, isDefensive: true,
    rollSlots: ['Skull'], attackTargets: [], defenseFramePositions: [3],
  });
  const plain = await jpost('/api/characters', { name: `SP0${stamp}`, characterType: 'npc' });
  const swift = await jpost('/api/characters', { name: `SP1${stamp}`, characterType: 'npc' });
  await grant(swift.id, 'Path To Mastery: Speed');

  const startupFor = async (charId, moveId) => {
    const sheet = await jf(`/api/characters/${charId}`);
    const move = (sheet.moves ?? []).find((m) => m.id === moveId);
    return move?.effective_startup_tics ?? move?.startup_tics ?? null;
  };
  const [plainPunch, swiftPunch] = [await startupFor(plain.id, punch.id), await startupFor(swift.id, punch.id)];
  const [plainGuard, swiftGuard] = [await startupFor(plain.id, guard.id), await startupFor(swift.id, guard.id)];
  console.log(`  punch — plain ${plainPunch}, Speed ${swiftPunch};  guard — plain ${plainGuard}, Speed ${swiftGuard}`);
  check('the fixture really is a 3-Startup move for a plain fighter', plainPunch === 3, String(plainPunch));
  check('Speed takes exactly one Tic off it', swiftPunch === 2, String(swiftPunch));
  // "All your moves", not "all your attacks" — a seam that quietly read
  // isAttackingMove would sail past a test that only ever handed it attacks.
  check('...and off a defence-pure guard too', plainGuard === 3 && swiftGuard === 2,
    `${plainGuard} -> ${swiftGuard}`);
  // The shorter footprint has to be a FRAME, not a number applied later: the
  // picker quotes it before the move is placed and the next declaration is
  // floored against it.
  const sheet = await jf(`/api/characters/${swift.id}`);
  const shown = (sheet.moves ?? []).find((m) => m.id === punch.id);
  check('...and the sheet the picker reads shows the shortened move',
    (shown?.effective_startup_tics ?? shown?.startup_tics) === 2, JSON.stringify(shown?.effective_startup_tics));
}

// ============================================ 2. Strength — the Block half
console.log('\n--- Path To Mastery: Strength: a Block put up against you is worth 5 less ---');
{
  const swing = await mk('B5 Swing', {
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 4, attackTargets: ['Body'],
  });
  const block = await mk('B5 Block', {
    startupTics: 0, activeTics: 3, recoveryTics: 1, isDefensive: true,
    rollSlots: ['Skull'], attackTargets: [], defenseFramePositions: [0, 1, 2],
  });
  const defensiveModifier = (events) => {
    const roll = events.find((e) => e.type === 'roll' && e.payload?.defensive === true);
    return roll?.payload?.modifier ?? null;
  };
  const bare = await fight('ST0', { attackMove: swing, defenceMove: block });
  const strong = await fight('ST1', { attackMove: swing, defenceMove: block, attackerPerks: ['Path To Mastery: Strength'] });
  const bareMod = defensiveModifier(bare.events);
  const strongMod = defensiveModifier(strong.events);
  console.log(`  defensive roll modifier — bare ${bareMod}, vs Strength ${strongMod}`);
  check('the fixture reaches a real Block roll at all', bareMod != null && strongMod != null,
    `${bareMod} / ${strongMod}`);
  check('a Block against a Strength holder is exactly 5 worse',
    bareMod != null && strongMod === bareMod - 5, `${bareMod} -> ${strongMod}`);
}

// ============================================ 3. Strength — the Threshold half
console.log('\n--- Path To Mastery: Strength: and blows that would be shrugged off land ---');
{
  // A bare d4 with no modifier tops out at 4 and the Minimum Damage Threshold
  // is 5, so the bare arm is a **guaranteed** zero every round — the same
  // determinism trick playtest-perks-batch2 uses for Not Just a Scratch.
  // Strength drops the bar to 4, which a natural 4 clears; over enough rounds
  // that is not a coin flip. Nothing degrades while it misses, so the extra
  // rounds cost only time.
  const feeble = await mk('B5 Feeble', {
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 0, attackTargets: ['Body'],
  });
  const steps = (events) => events
    .filter((e) => e.type === 'damage_applied' && e.payload?.slotName)
    .reduce((n, e) => n + (e.payload.steps ?? 0), 0);
  const bare = await fight('TH0', { attackMove: feeble, rounds: 8 });
  const strong = await fight('TH1', { attackMove: feeble, attackerPerks: ['Path To Mastery: Strength'], rounds: 16 });
  console.log(`  steps over the run — bare ${steps(bare.events)}, Strength ${steps(strong.events)}`);
  check('the bare fixture can never land anything, in any round',
    steps(bare.events) === 0, String(steps(bare.events)));
  check('...and says so as Insignificant Damage rather than silence',
    bare.events.some((e) => e.type === 'insignificant_damage'));
  check('Strength turns that same blow into real damage',
    steps(strong.events) > 0, String(steps(strong.events)));
}

// ============================================ 4. Durability
console.log('\n--- Path To Mastery: Durability: two Stats refuse to break, the third does not ---');
{
  // +9 on a d4 lands 10-13, which is two Half-Damage steps every time — and a
  // fresh d4 is exactly two steps from going out. So each round breaks the Body
  // deterministically, and the only question is what the Perk does about it.
  const smash = await mk('B5 Smash', {
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 9, attackTargets: ['Body'],
  });
  const broke = (events) => events.some(
    (e) => e.type === 'damage_applied' && e.payload?.slotName === 'Body' && e.payload?.statusAfter === 'incapacitated'
  );
  const bare = await fight('DU0', { attackMove: smash, rounds: 1 });
  check('the bare fixture really does break the Body in one round', broke(bare.events),
    JSON.stringify(bare.events.filter((e) => e.type === 'damage_applied').map((e) => e.payload)));

  const tough = await fight('DU1', { attackMove: smash, defenderPerks: ['Path To Mastery: Durability'], rounds: 3 });
  const brokeIn = tough.rounds.map(broke);
  console.log(`  broke in round — ${brokeIn.map((b, i) => `${i + 1}:${b ? 'yes' : 'no'}`).join(' ')}`);
  check('the first break is absorbed', brokeIn[0] === false, JSON.stringify(tough.rounds[0]?.length));
  check('...and so is the second', brokeIn[1] === false);
  check('...but the third goes out like anybody else\'s', brokeIn[2] === true);
  // Announced rather than silent, on the Grounded precedent: a table watching a
  // Stat get taken out is expecting it to go, and its refusal needs a reason.
  check('the table is told the Stat refused to break',
    tough.chat.some((c) => /refuses to break/.test(c.message ?? '')),
    tough.chat.slice(-6).map((c) => c.message).join(' | '));
  // The Stat took everything the blow was worth — a bare d4 — rather than
  // shrugging the hit off entirely.
  const body = (await jf(`/api/characters/${tough.def.id}`)).dice?.find((d) => d.slot_name === 'Body');
  check('and it really is a broken-open Stat by the end, not an untouched one',
    body?.status === 'incapacitated', JSON.stringify(body));
}

// ============================================ 5. Eye Catcher
console.log('\n--- Eye Catcher: the height of an attack aimed at you, before it reveals ---');
{
  const highKick = await mk('B5 High', {
    startupTics: 6, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 0, attackTargets: ['Skull'],
  });
  const lowSweep = await mk('B5 Low', {
    startupTics: 6, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 0, attackTargets: ['Leg'],
  });
  const pureGuard = await mk('B5 Pure', {
    startupTics: 6, activeTics: 2, recoveryTics: 1, isDefensive: true,
    rollSlots: ['Skull'], attackTargets: [], defenseFramePositions: [6],
  });

  // A pair seated and left in Declaration Phase: nothing has revealed, which is
  // the only window where this Perk has anything to say.
  const seat = async (label, { seerPerks = [] }) => {
    gm.emit('combat:clear', {});
    await sleep(800);
    const seer = await jpost('/api/characters', { name: `EC${label}a${stamp}`, characterType: 'npc' });
    const foe = await jpost('/api/characters', { name: `EC${label}b${stamp}`, characterType: 'npc' });
    for (const p of seerPerks) await grant(seer.id, p);
    gm.emit('combat:add_participant', { characterId: seer.id, side: 'left', pairIndex: 0 });
    await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === seer.id));
    gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
    await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));
    gm.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
    return { seer, foe };
  };
  // Declares one move for each side and stops there — deliberately WITHOUT
  // calling character_done_declaring for both, so the round never resolves and
  // both moves stay unrevealed for the length of the probe.
  const declarePair = async ({ seer, foe }, { seerMove, foeMove }) => {
    const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
    for (let i = 0; i < 2; i++) {
      const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
      if (!side) break;
      const who = side === 'left' ? seer : foe;
      const what = side === 'left' ? seerMove : foeMove;
      gm.emit('move:declare', { characterId: who.id, moveId: what.id, placementTic: start });
      await sleep(500);
      if (i === 0) gm.emit('combat:character_done_declaring', { characterId: who.id });
      await sleep(600);
    }
    return start;
  };
  const seenBy = async (charId) => {
    const snap = await jf(`/api/combat?role=player&characterId=${charId}`);
    return snap?.declaredMoves ?? [];
  };

  // --- the entitled reader
  {
    const pair = await seat('1', { seerPerks: ['Eye Catcher'] });
    await declarePair(pair, { seerMove: lowSweep, foeMove: highKick });
    const rows = await seenBy(pair.seer.id);
    const incoming = rows.find((r) => r.characterId === pair.foe.id);
    const own = rows.find((r) => r.characterId === pair.seer.id);
    check('the incoming move is still a secret — no name, no id', incoming != null && incoming.moveName == null,
      JSON.stringify(incoming));
    check('...but its height is readable', incoming?.attackHeights?.length === 1 && incoming.attackHeights[0] === 'High',
      JSON.stringify(incoming?.attackHeights));
    // "The attack against YOU". Their own move is not one, and gets no badge —
    // which also makes the key's presence a reliable signal in the UI.
    check('their own declaration carries no height', own != null && own.attackHeights === undefined,
      JSON.stringify(own?.attackHeights));
  }

  // --- the same board, read by somebody without the Perk
  {
    const pair = await seat('2', {});
    await declarePair(pair, { seerMove: lowSweep, foeMove: highKick });
    const rows = await seenBy(pair.seer.id);
    const incoming = rows.find((r) => r.characterId === pair.foe.id);
    check('a fighter without the Perk sees the same row', incoming != null, JSON.stringify(rows.length));
    // Absence, not a false flag: the whole protection is that the key is not
    // there to read out of devtools.
    check('...and no height key at all', incoming?.attackHeights === undefined,
      JSON.stringify(incoming?.attackHeights));
    const gmRows = (await jf('/api/combat?role=gm'))?.declaredMoves ?? [];
    check('and the GM, who reads everything else, gets no height either',
      gmRows.every((r) => r.attackHeights === undefined));
  }

  // --- the band really does follow the targets
  {
    const pair = await seat('3', { seerPerks: ['Eye Catcher'] });
    await declarePair(pair, { seerMove: highKick, foeMove: lowSweep });
    const incoming = (await seenBy(pair.seer.id)).find((r) => r.characterId === pair.foe.id);
    check('a sweep at the legs reads Low, not High',
      incoming?.attackHeights?.length === 1 && incoming.attackHeights[0] === 'Low',
      JSON.stringify(incoming?.attackHeights));
  }

  // --- a defence-pure move has no height to read
  {
    const pair = await seat('4', { seerPerks: ['Eye Catcher'] });
    await declarePair(pair, { seerMove: highKick, foeMove: pureGuard });
    const incoming = (await seenBy(pair.seer.id)).find((r) => r.characterId === pair.foe.id);
    check('a guard with no Attack Target reports no height rather than a wrong one',
      incoming != null && incoming.attackHeights === undefined, JSON.stringify(incoming?.attackHeights));
  }
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
gm.close();
process.exit(failures === 0 ? 0 : 1);

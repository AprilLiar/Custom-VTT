// Playtest: the second batch of Perks automated for the official playtest.
//
//   Punches in Bunches  — a Hand Attack behind a Hand Attack costs 1 less
//   The Simplest Tool   — the Jab costs 1 less and rolls +1
//   Deadly Pendulum     — an Attack behind a Successful Dodge rolls +2
//   Baron of Suffering  — 1 Stamina back per 0.5 damage dealt
//   Wounded Wolf        — badge only, deliberately hand-run
//
// **The two discounts have to be checked here rather than in a unit test, and
// for a sharper reason than last batch's.** A Stamina Cost is now a function of
// what this fighter ALREADY HAS QUEUED — so the figure the picker quotes has to
// change mid-Declaration, as each move goes down. `move:declare` and the payload
// that carries the quote both live in server/index.js, which boots a real HTTP
// server at import; only a running one can show that the quote, the
// affordability check and the actual charge all move together.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3031 node server/index.js
//   E2E_URL=http://localhost:3031 node scripts/playtest-perks-batch3.mjs
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
gm.emit('identity:set', { role: 'gm' });
await sleep(500);
const stamp = Date.now();

// ============================================ 0. seeded and badged
console.log('--- the registry seeds the compendium ---');
const perks = await jf('/api/perks');
const byName = (n) => perks.find((p) => p.name === n);
for (const name of ['Punches in Bunches', 'The Simplest Tool', 'Deadly Pendulum', 'Baron of Suffering']) {
  const perk = byName(name);
  check(`"${name}" was seeded`, perk != null, JSON.stringify(perks.map((p) => p.name)));
  check(`...flagged automated, not manual`, perk?.automated === true && perk?.manual === false, JSON.stringify(perk));
}
const wolf = byName('Wounded Wolf');
check('"Wounded Wolf" is seeded', wolf != null);
check('...badged, but declared manual', wolf?.automated === true && wolf?.manual === true, JSON.stringify(wolf));

const grant = async (characterId, name) => {
  gm.emit('perk:grant', { characterId, perkId: byName(name).id });
  await sleep(500);
};

gm.emit('tell:create', { name: `Batch3 Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `Batch3 Tell ${stamp}`);
// **Named exactly, with no stamp suffix, for the Jab.** The Simplest Tool binds
// to a move called "Jab" and nothing else, so the fixture has to be honest
// about that — a `Jab ${stamp}` would prove nothing.
const mk = async (name, extra) => {
  gm.emit('move:create', {
    name, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === name);
};

const punch = await mk(`B3 Straight ${stamp}`, {
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Hand', 'Hand'], staminaCost: 4, attackTargets: ['Body'],
});
const kick = await mk(`B3 Kick ${stamp}`, {
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Leg', 'Leg'], staminaCost: 4, attackTargets: ['Body'],
});
const jab = await mk('Jab', {
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Hand', 'Hand'], staminaCost: 4, attackTargets: ['Body'],
});

// The figure the declare picker is quoting for one move, right now.
const quoted = async (characterId, moveId) => {
  const sheet = await jf(`/api/characters/${characterId}`);
  const move = (sheet?.moves ?? []).find((m) => m.id === moveId);
  return move?.effective_stamina_cost ?? null;
};
const staminaOf = async (characterId) => (await jf(`/api/characters/${characterId}`))?.character?.current_stamina;

const seat = async (label, perks = []) => {
  gm.emit('combat:clear', {});
  await sleep(700);
  const atk = await jpost('/api/characters', { name: `A${label}${stamp}`, characterType: 'npc' });
  const def = await jpost('/api/characters', { name: `D${label}${stamp}`, characterType: 'npc' });
  for (const p of perks) await grant(atk.id, p);
  gm.emit('combat:add_participant', { characterId: atk.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === atk.id));
  gm.emit('combat:add_participant', { characterId: def.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === def.id));
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  // **Whose turn it is is decided by an Initiative roll**, so a probe that just
  // starts declaring is a coin flip on whether its events are accepted at all.
  // If the defender is up first, pass their turn.
  if ((await jf('/api/combat?role=gm')).pairs[0].declaringSide !== 'left') {
    gm.emit('combat:character_done_declaring', { characterId: def.id });
    await sleep(900);
  }
  return { atk, def, start: (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0 };
};

// ============================================ 1. Punches in Bunches
console.log('\n--- Punches in Bunches: the quote moves as the queue fills ---');
{
  const { atk, start } = await seat('PIB', ['Punches in Bunches']);
  check('the first punch of a round is quoted at full price', (await quoted(atk.id, punch.id)) === 4,
    String(await quoted(atk.id, punch.id)));

  gm.emit('move:declare', { characterId: atk.id, moveId: punch.id, placementTic: start });
  await sleep(800);
  // **This is the whole probe.** The same move, the same character, a different
  // quote — because something is now queued in front of it.
  const after = await quoted(atk.id, punch.id);
  check('a punch behind a punch is quoted 1 cheaper', after === 3, String(after));
  const kickAfter = await quoted(atk.id, kick.id);
  check('...and a kick behind a punch is not', kickAfter === 4, String(kickAfter));
}

console.log('\n--- ...and a fighter without it is quoted the same figure all round ---');
{
  const { atk, start } = await seat('PIB0');
  gm.emit('move:declare', { characterId: atk.id, moveId: punch.id, placementTic: start });
  await sleep(800);
  check('no Perk, no discount', (await quoted(atk.id, punch.id)) === 4, String(await quoted(atk.id, punch.id)));
}

// ============================================ 2. The Simplest Tool
console.log('\n--- The Simplest Tool: the Jab, and only the Jab ---');
{
  const { atk } = await seat('TST', ['The Simplest Tool']);
  check('the Jab is quoted 1 cheaper', (await quoted(atk.id, jab.id)) === 3, String(await quoted(atk.id, jab.id)));
  check('a different punch is not', (await quoted(atk.id, punch.id)) === 4, String(await quoted(atk.id, punch.id)));
}

console.log('\n--- ...and the two discounts stack on a Jab thrown off a punch ---');
{
  const { atk, start } = await seat('STACK', ['The Simplest Tool', 'Punches in Bunches']);
  check('a lone Jab is the Jab discount alone', (await quoted(atk.id, jab.id)) === 3, String(await quoted(atk.id, jab.id)));
  gm.emit('move:declare', { characterId: atk.id, moveId: punch.id, placementTic: start });
  await sleep(800);
  check('a Jab behind a punch is both', (await quoted(atk.id, jab.id)) === 2, String(await quoted(atk.id, jab.id)));
}

// ============================================ 3. quote == charge
console.log('\n--- the Stamina actually spent is the sum the picker quoted ---');
{
  const { atk, start } = await seat('CHARGE', ['The Simplest Tool', 'Punches in Bunches']);
  const before = await staminaOf(atk.id);
  const q1 = await quoted(atk.id, punch.id);           // 4, nothing queued
  gm.emit('move:declare', { characterId: atk.id, moveId: punch.id, placementTic: start });
  await sleep(800);
  const q2 = await quoted(atk.id, jab.id);             // 2, a Jab behind a punch
  gm.emit('move:declare', { characterId: atk.id, moveId: jab.id, placementTic: start + 3 });
  await sleep(800);

  // The commit's own broadcast, caught rather than read back afterwards — the
  // round rolls straight on into resolution and its Stamina regen, which is what
  // made an earlier version of this probe read the bar back unchanged.
  const spent = new Promise((res) => {
    const h = (c) => { if (c.id === atk.id) { gm.off('character:updated', h); res(c.current_stamina); } };
    gm.on('character:updated', h);
  });
  gm.emit('combat:character_done_declaring', { characterId: atk.id });
  const after = await Promise.race([spent, sleep(6000).then(() => null)]);
  console.log(`  quoted ${q1} + ${q2} = ${q1 + q2}; Stamina ${before} -> ${after}`);
  check('the charge is exactly what was quoted, both discounts included',
    after != null && before - after === q1 + q2, `${before} -> ${after}, quoted ${q1 + q2}`);
}

// ============================================ 4. Deadly Pendulum
console.log('\n--- Deadly Pendulum: the counter behind a Successful Dodge ---');
{
  // **A guard only covers its ACTIVE frames** — writeMove's
  // sanitizeDefensePositions drops any Defense Frame outside them — so a
  // one-Tic window against a two-Tic Lunge is 'too-short', auto-Failed with no
  // prompt at all. Two Active Tics, guarded on both, is the shape the Move
  // Creator would actually produce for this.
  const dodge = await mk(`B3 Slip ${stamp}`, {
    startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Body'],
    isDefensive: true, defenseKind: 'dodge', defenseFramePositions: [1, 2], staminaCost: 0,
  });
  const counter = await mk(`B3 Counter ${stamp}`, {
    startupTics: 1, activeTics: 1, recoveryTics: 0,
    rollSlots: ['Skull'], staminaCost: 0, attackTargets: ['Body'],
  });
  const attack = await mk(`B3 Lunge ${stamp}`, {
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Skull'], staminaCost: 0, attackTargets: ['Body'],
  });

  const run = async (label, { perk, dodgeAnswer }) => {
    gm.emit('combat:clear', {});
    await sleep(700);
    const swinger = await jpost('/api/characters', { name: `S${label}${stamp}`, characterType: 'npc' });
    const other = await jpost('/api/characters', { name: `O${label}${stamp}`, characterType: 'npc' });
    if (perk) await grant(swinger.id, perk);
    gm.emit('combat:add_participant', { characterId: swinger.id, side: 'left', pairIndex: 0 });
    await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === swinger.id));
    gm.emit('combat:add_participant', { characterId: other.id, side: 'right', pairIndex: 0 });
    await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === other.id));
    gm.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
    const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;

    for (let i = 0; i < 2; i++) {
      const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
      if (!side) break;
      if (side === 'left') {
        gm.emit('move:declare', { characterId: swinger.id, moveId: dodge.id, placementTic: start });
        await sleep(600);
        gm.emit('move:declare', { characterId: swinger.id, moveId: counter.id, placementTic: start + 4 });
        await sleep(600);
        gm.emit('combat:character_done_declaring', { characterId: swinger.id });
      } else {
        gm.emit('move:declare', { characterId: other.id, moveId: attack.id, placementTic: start });
        await sleep(600);
        gm.emit('combat:character_done_declaring', { characterId: other.id });
      }
      await sleep(700);
    }
    // Answer whatever the round pauses on: a Dodge prompt for the guard, and
    // any Block prompt the engine raises along the way.
    for (let i = 0; i < 12; i++) {
      await sleep(1200);
      const status = (await jf('/api/combat?role=gm')).pairs?.[0]?.resolutionStatus;
      if (status === 'paused_dodge') gm.emit('combat:resolve_dodge', { pairIndex: 0, outcome: dodgeAnswer });
      else if (status === 'paused_defense') gm.emit('combat:resolve_block', { pairIndex: 0, outcome: 'successful' });
      else if (status == null || status === 'complete') break;
    }
    await sleep(2500);
    const chat = await jf('/api/chat');
    const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
    const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
    const roll = events.find((e) => e.type === 'roll' && e.payload?.moveName === counter.name);
    // The GM's own answers, echoed so a failing probe says at once whether the
    // Dodge was even adjudicated the way the fixture asked.
    const verdicts = events.filter((e) => e.type === 'dodge_resolved').map((e) => e.payload?.outcome);
    console.log(`  [${label}] dodge verdicts: ${JSON.stringify(verdicts)}`);
    return { events, roll };
  };

  const good = await run('DPY', { perk: 'Deadly Pendulum', dodgeAnswer: 'successful' });
  const term = (good.roll?.payload?.modifierBreakdown ?? []).find((t) => t.label === 'Deadly Pendulum');
  check('the counter rolled at all', good.roll != null, good.events.map((e) => e.type).join(', '));
  check('the Perk is named in the roll it changed, +2',
    term?.amount === 2, JSON.stringify(good.roll?.payload?.modifierBreakdown));

  const bad = await run('DPN', { perk: 'Deadly Pendulum', dodgeAnswer: 'failed' });
  check('a Dodge that failed is not a pendulum',
    !(bad.roll?.payload?.modifierBreakdown ?? []).some((t) => t.label === 'Deadly Pendulum'),
    JSON.stringify(bad.roll?.payload?.modifierBreakdown));

  const bare = await run('DPB', { perk: null, dodgeAnswer: 'successful' });
  check('and a fighter without the Perk gets nothing either way',
    !(bare.roll?.payload?.modifierBreakdown ?? []).some((t) => t.label === 'Deadly Pendulum'),
    JSON.stringify(bare.roll?.payload?.modifierBreakdown));
}

// ============================================ 5. Baron of Suffering
console.log('\n--- Baron of Suffering: Stamina out of the damage you deal ---');
{
  // +6 on a d4 lands in 7-10, so at least one Half-Damage step is guaranteed
  // and the probe never depends on a die face.
  const heavy = await mk(`B3 Heavy ${stamp}`, {
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 6, staminaCost: 0, attackTargets: ['Body'],
  });

  const run = async (label, perk) => {
    const { atk, start } = await seat(label, perk ? [perk] : []);
    // Spend the bar down first, so a gain has somewhere to go: Stamina is
    // clamped at max, and a fighter starting full would show a delta of 0
    // whatever the Perk did.
    const full = await staminaOf(atk.id);
    gm.emit('stamina:adjust', { characterId: atk.id, delta: -(full - 4) });
    await sleep(700);
    for (let i = 0; i < 2; i++) {
      const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
      if (!side) break;
      if (side === 'left') {
        gm.emit('move:declare', { characterId: atk.id, moveId: heavy.id, placementTic: start });
        await sleep(600);
        gm.emit('combat:character_done_declaring', { characterId: atk.id });
      } else {
        const st = await jf('/api/combat?role=gm');
        const them = st.participants.find((p) => p.side === 'right');
        gm.emit('combat:character_done_declaring', { characterId: them.character_id });
      }
      await sleep(700);
    }
    for (let i = 0; i < 10; i++) {
      await sleep(1200);
      const status = (await jf('/api/combat?role=gm')).pairs?.[0]?.resolutionStatus;
      if (status === 'paused_defense') gm.emit('combat:resolve_block', { pairIndex: 0, outcome: 'successful' });
      else if (status == null || status === 'complete') break;
    }
    await sleep(2500);
    const chat = await jf('/api/chat');
    const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
    const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
    const steps = events
      .filter((e) => e.type === 'damage_applied' && e.payload?.slotName)
      .reduce((n, e) => n + (e.payload.steps ?? 0), 0);
    const gain = events.find(
      (e) => e.type === 'stamina_changed' && e.payload?.characterId === atk.id && e.payload.delta > 0
    );
    return { steps, gain, events };
  };

  const withPerk = await run('BOS1', 'Baron of Suffering');
  console.log(`  steps landed ${withPerk.steps}, Stamina gained ${withPerk.gain?.payload?.delta ?? 0}`);
  check('the fixture actually lands damage', withPerk.steps > 0, String(withPerk.steps));
  check('one Stamina back per half-point dealt',
    withPerk.gain?.payload?.delta === withPerk.steps,
    `${withPerk.gain?.payload?.delta} for ${withPerk.steps} steps`);
  check('...and the log says where it came from',
    /damage dealt/.test(withPerk.gain?.payload?.reason ?? ''), JSON.stringify(withPerk.gain?.payload?.reason));

  const bare = await run('BOS0', null);
  console.log(`  bare: steps landed ${bare.steps}, Stamina gained ${bare.gain?.payload?.delta ?? 0}`);
  check('a fighter without it gains nothing from the identical blow',
    bare.steps > 0 && bare.gain == null, `${bare.steps} steps, ${JSON.stringify(bare.gain?.payload)}`);
}

console.log(failures ? `\n${failures} PROBE(S) FAILED` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

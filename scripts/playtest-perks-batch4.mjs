// Playtest: the third batch of automated Perks.
//
//   Piercing Headache  — Full Damage on the Skull splashes half onto the Brain
//   Last Breath Taker  — the same, Body to the Stamina Stat
//   Grounded           — Movement Punisher never trips you
//   Dogfighter         — your Moves count as Hard to Interrupt (2)
//
// Every one is a **bare/granted pair of otherwise identical rounds**, the
// method this repo has used since the grapple rework: what the Perk did is the
// difference between two fights, not a number read off an event and trusted.
//
// **Dogfighter has to be here.** Its +2 lands inside `checkInterrupt`, which
// only runs when an attack catches a move mid-Startup — a situation that takes
// two fighters, real frame data and a real roll to reach at all.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3080 node server/index.js
//   E2E_URL=http://localhost:3080 node scripts/playtest-perks-batch4.mjs
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
for (const name of ['Piercing Headache', 'Last Breath Taker', 'Grounded', 'Dogfighter']) {
  const perk = byName(name);
  check(`"${name}" was seeded`, perk != null, JSON.stringify(perks.map((p) => p.name)));
  check(`...flagged automated, not manual`, perk?.automated === true && perk?.manual === false, JSON.stringify(perk));
}
const grant = async (characterId, name) => {
  gm.emit('perk:grant', { characterId, perkId: byName(name).id });
  await sleep(500);
};

gm.emit('tell:create', { name: `B4 Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `B4 Tell ${stamp}`);
const tags = await jf('/api/tags');
const tagId = (n) => tags.find((t) => t.name === n)?.id;
const mk = async (name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// Seats a fresh pair and runs one round of `attackMove` from the left side.
const fight = async (label, { attackMove, attackerPerks = [], defenderPerks = [], defenceMove = null }) => {
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
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
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
    if (status === 'paused_defense') gm.emit('combat:resolve_block', { pairIndex: 0, outcome: 'successful' });
    else if (status === 'paused_dodge') gm.emit('combat:resolve_dodge', { pairIndex: 0, outcome: 'failed' });
    else if (status == null || status === 'complete') break;
  }
  await sleep(2000);
  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
  return { atk, def, events, chat };
};

const stepsOn = (events, slot) =>
  events
    .filter((e) => e.type === 'damage_applied' && e.payload?.slotName === slot)
    .reduce((n, e) => n + (e.payload.steps ?? 0), 0);

// ============================================ 1. Piercing Headache
console.log('\n--- Piercing Headache: Skull damage bleeds into the Brain ---');
{
  // **The splash needs a FULL point, so the fixture has to guarantee one.** A
  // live character's Stats are d4, and +6 lands 7-10 — one Half-Damage step
  // unless the die comes up 4. +9 lands 10-13, which is two steps every time,
  // so "did it splash?" is a real question rather than a die roll.
  const smash = await mk('B4 Smash', {
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 9, attackTargets: ['Skull'],
  });
  const bare = await fight('PH0', { attackMove: smash });
  const withPerk = await fight('PH1', { attackMove: smash, attackerPerks: ['Piercing Headache'] });
  console.log(`  bare   — Skull ${stepsOn(bare.events, 'Skull')}, Brain ${stepsOn(bare.events, 'Brain')}`);
  console.log(`  Perk   — Skull ${stepsOn(withPerk.events, 'Skull')}, Brain ${stepsOn(withPerk.events, 'Brain')}`);
  check('the bare fixture damages the Skull', stepsOn(bare.events, 'Skull') > 0);
  check('...and never touches the Brain', stepsOn(bare.events, 'Brain') === 0, String(stepsOn(bare.events, 'Brain')));
  const skull = stepsOn(withPerk.events, 'Skull');
  const brain = stepsOn(withPerk.events, 'Brain');
  check('the Perk splashes onto the Brain', brain > 0, `${skull} on the Skull, ${brain} on the Brain`);
  check('...at exactly one half-step per FULL point of Skull damage',
    skull >= 2 && brain === Math.floor(skull / 2),
    `${skull} Skull steps should buy ${Math.floor(skull / 2)}, got ${brain}`);
}

// ============================================ 2. Last Breath Taker
console.log('\n--- Last Breath Taker: the same rule, Body to Stamina ---');
{
  const gut = await mk('B4 Gut', {
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 9, attackTargets: ['Body'],
  });
  const bare = await fight('LB0', { attackMove: gut });
  const withPerk = await fight('LB1', { attackMove: gut, attackerPerks: ['Last Breath Taker'] });
  console.log(`  bare   — Body ${stepsOn(bare.events, 'Body')}, Stamina ${stepsOn(bare.events, 'Stamina')}`);
  console.log(`  Perk   — Body ${stepsOn(withPerk.events, 'Body')}, Stamina ${stepsOn(withPerk.events, 'Stamina')}`);
  check('the bare fixture never touches the Stamina Stat', stepsOn(bare.events, 'Stamina') === 0);
  const body = stepsOn(withPerk.events, 'Body');
  check('the Perk splashes onto the Stamina Stat',
    body >= 2 && stepsOn(withPerk.events, 'Stamina') === Math.floor(body / 2),
    `${body} Body steps should buy ${Math.floor(body / 2)}, got ${stepsOn(withPerk.events, 'Stamina')}`);
}

// ============================================ 3. Grounded
console.log('\n--- Grounded: the Movement Punisher does not trip you ---');
{
  const sweep = await mk('B4 Sweep', {
    startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'],
    rollModifier: 6, attackTargets: ['Body'], tagIds: [tagId('Movement Punisher')].filter(Boolean),
  });
  const dash = await mk('B4 Dash', {
    startupTics: 1, activeTics: 3, recoveryTics: 2, rollSlots: ['Body'],
    staminaCost: 0, tagIds: [tagId('Movement')].filter(Boolean),
  });
  const tripped = (r) =>
    r.events.some((e) => e.type === 'automation_fired' && e.payload?.sourceName === 'Movement Punisher');

  const bare = await fight('GR0', { attackMove: sweep, defenceMove: dash });
  const withPerk = await fight('GR1', { attackMove: sweep, defenceMove: dash, defenderPerks: ['Grounded'] });
  console.log(`  tripped — bare ${tripped(bare)}, Grounded ${tripped(withPerk)}`);
  check('the bare fixture actually trips the runner', tripped(bare),
    bare.events.map((e) => e.type).join(', '));
  check('Grounded refuses the trip', !tripped(withPerk));
  check('...and says why', withPerk.chat.some((e) => /keeps their feet/.test(e.message ?? '')),
    JSON.stringify(withPerk.chat.slice(-3).map((c) => c.message)));
}

// ============================================ 4. Dogfighter
console.log('\n--- Dogfighter: harder to break up mid-Startup ---');
{
  // A long Startup for the defender to be caught in, and an attack that will
  // reach it. Interruption is a contest of rolls, so this is run several times
  // and compared as a rate rather than a single outcome.
  const jab = await mk('B4 Quick', {
    startupTics: 1, activeTics: 3, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 6, attackTargets: ['Body'],
  });
  const windup = await mk('B4 Windup', {
    startupTics: 4, activeTics: 1, recoveryTics: 1, rollSlots: ['Body'], rollModifier: -6,
  });
  const interruptedCount = async (label, perks) => {
    let n = 0;
    let seen = 0;
    for (let i = 0; i < 6; i++) {
      const r = await fight(`${label}${i}`, { attackMove: jab, defenceMove: windup, defenderPerks: perks });
      const contest = r.events.find((e) => e.type === 'interrupt_resolved' || e.type === 'move_interrupted');
      if (contest) seen += 1;
      if (r.events.some((e) => e.type === 'move_interrupted')) n += 1;
    }
    return { n, seen };
  };
  const bare = await interruptedCount('DG0', []);
  const withPerk = await interruptedCount('DG1', ['Dogfighter']);
  console.log(`  interrupted — bare ${bare.n}/6 (contests seen ${bare.seen}), Dogfighter ${withPerk.n}/6 (contests seen ${withPerk.seen})`);
  check('the fixture reaches a real Interruption contest at all', bare.seen > 0 || bare.n > 0,
    'no interrupt events were produced — the fixture never caught the wind-up');
  check('Dogfighter is interrupted no more often than a bare fighter',
    withPerk.n <= bare.n, `bare ${bare.n}, Dogfighter ${withPerk.n}`);
}

console.log(failures ? `\n${failures} PROBE(S) FAILED` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

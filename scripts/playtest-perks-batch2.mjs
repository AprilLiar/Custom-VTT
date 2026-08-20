// Playtest: the five Perks automated for the first official playtest.
//
//   Iron Skin            — the Minimum Damage Threshold against you, +2
//   Not Just a Scratch   — the Minimum Damage Threshold for your attacks, −2
//   Spiked Shell         — a Full Block sends damage back at the limb that swung
//   Perfect Player       — Dodges cost 2 less while nothing of yours is damaged
//   Healing Factor       — a pending Half-Damage marker sheds at Round Start
//
// Every one is run as a **bare/granted pair of otherwise identical rounds**,
// the method this repo has used for every mechanic since the grapple rework:
// what the Perk did is the difference between two fights rather than a number
// read off an event and trusted.
//
// **Perfect Player has to be here rather than in a unit test.** move:declare
// lives in server/index.js, which boots a real HTTP server at import, so the
// four Stamina call sites this batch refactored can only be checked together
// against a running one — and checking them together is the whole point: the
// figure the picker quotes must be the figure actually charged.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-perks-batch2.mjs
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

// ============================================ 0. every Perk is seeded and badged
console.log('--- the registry seeds the compendium ---');
const perks = await jf('/api/perks');
const byName = (n) => perks.find((p) => p.name === n);
for (const name of ['Iron Skin', 'Not Just a Scratch', 'Spiked Shell', 'Perfect Player', 'Healing Factor']) {
  const perk = byName(name);
  check(`"${name}" was seeded`, perk != null, JSON.stringify(perks.map((p) => p.name)));
  check(`...and is flagged automated`, perk?.automated === true, JSON.stringify(perk));
  check(`...and is NOT flagged manual`, perk?.manual === false, JSON.stringify(perk?.manual));
}
const multifaceted = byName('Multifaceted');
check('"Multifaceted" is seeded too', multifaceted != null);
// The badge means "accounted for"; `manual` is what makes its tooltip honest.
check('...badged, but declared manual rather than automated',
  multifaceted?.automated === true && multifaceted?.manual === true, JSON.stringify(multifaceted));

const grant = async (characterId, name) => {
  const perk = byName(name);
  gm.emit('perk:grant', { characterId, perkId: perk.id });
  await sleep(500);
};

gm.emit('tell:create', { name: `Batch2 Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `Batch2 Tell ${stamp}`);
const mk = async (name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// Seats two fresh NPCs and runs `rounds` rounds of the same attack, returning
// how many Half-Damage steps landed in total.
//
// **Why several rounds rather than one.** A live character's Stats are d4, so an
// attack's total swings across a range of 4 while the threshold a Perk moves is
// only 2 wide — no single round can be made deterministic. What CAN be made
// deterministic is one side of each comparison: with a modifier of +2 a d4 can
// never reach 7, so an Iron Skin arm is *guaranteed* 0; with a modifier of 0 it
// can never reach 5, so a bare Not Just a Scratch arm is *guaranteed* 0. Each
// probe below therefore pairs a hard guarantee with "and the other arm managed
// it at least once in eight tries", which at 50% a round is not a coin flip.
const runRounds = async ({ attackMove, attackerPerks = [], defenderPerks = [], label, rounds = 8 }) => {
  gm.emit('combat:clear', {});
  await sleep(700);
  const atk = await jpost('/api/characters', { name: `A${label}${stamp}`, characterType: 'npc' });
  const def = await jpost('/api/characters', { name: `D${label}${stamp}`, characterType: 'npc' });
  for (const p of attackerPerks) await grant(atk.id, p);
  for (const p of defenderPerks) await grant(def.id, p);
  gm.emit('combat:add_participant', { characterId: atk.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === atk.id));
  gm.emit('combat:add_participant', { characterId: def.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === def.id));

  let steps = 0;
  let insignificant = 0;
  for (let round = 0; round < rounds; round++) {
    // **Only nudge it if it is not already open.** A resolution ends by calling
    // startPairDeclaration itself, so the pair is back in Declaration before
    // this loop comes round again — and combat:next_round deliberately skips a
    // pair already declaring, which means emitting it here would produce no
    // broadcast at all and the wait below would sit until it timed out. That is
    // what silently limited an earlier version of this script to one round.
    let phase = (await jf('/api/combat?role=gm')).pairs?.[0]?.phase;
    if (phase !== 'declaration') {
      gm.emit('combat:next_round', {});
      try {
        await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration', 8000);
      } catch { break; }
    }
    const st0 = await jf('/api/combat?role=gm');
    const start = st0.pairs[0].roundStartTic ?? 0;
    for (let i = 0; i < 2; i++) {
      const st = await jf('/api/combat?role=gm');
      const side = st.pairs[0].declaringSide;
      if (!side) break;
      const who = side === 'left' ? atk : def;
      if (who.id === atk.id) {
        gm.emit('move:declare', { characterId: atk.id, moveId: attackMove.id, placementTic: start });
        await sleep(500);
      }
      gm.emit('combat:character_done_declaring', { characterId: who.id });
      await sleep(600);
    }
    await sleep(4000);
    const chat = await jf('/api/chat');
    const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
    const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
    for (const e of events) {
      if (e.type === 'damage_applied' && e.payload?.slotName) steps += e.payload.steps ?? 0;
      if (e.type === 'insignificant_damage') insignificant += 1;
    }
    // Nothing more to learn once the point is made, and stopping early keeps
    // the defender's dice from degrading into "no eligible target".
    if (steps > 0) break;
  }
  return { steps, insignificant, atk, def };
};

// ============================================ 1. Iron Skin
console.log('\n--- Iron Skin: raising the bar takes damage off the same attack ---');
// A d4 plus 2 lands in 3-6: over the 5 bar half the time, never over the 7 one.
const smallJab = await mk('Small Jab', {
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Skull'], rollModifier: 2, attackTargets: ['Body'],
});
const bareIron = await runRounds({ attackMove: smallJab, label: 'IS0' });
const withIron = await runRounds({ attackMove: smallJab, defenderPerks: ['Iron Skin'], label: 'IS1' });
console.log(`  steps — bare ${bareIron.steps}, Iron Skin ${withIron.steps} (insignificant: ${withIron.insignificant})`);
check('the bare fixture lands damage', bareIron.steps > 0, JSON.stringify(bareIron.steps));
check('Iron Skin makes the identical attack land NOTHING, every round',
  withIron.steps === 0, JSON.stringify(withIron.steps));
check('...and it reads as Insignificant Damage rather than silence',
  withIron.insignificant > 0, String(withIron.insignificant));

// ============================================ 2. Not Just a Scratch
console.log('\n--- Not Just a Scratch: lowering the bar turns nothing into half a point ---');
// A bare d4 can never reach 5, so the bare arm is a guaranteed zero.
const feeble = await mk('Feeble Swipe', {
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Skull'], rollModifier: 0, attackTargets: ['Body'],
});
const bareScratch = await runRounds({ attackMove: feeble, label: 'NS0' });
const withScratch = await runRounds({ attackMove: feeble, attackerPerks: ['Not Just a Scratch'], label: 'NS1' });
console.log(`  steps — bare ${bareScratch.steps}, Not Just a Scratch ${withScratch.steps}`);
check('the bare fixture does nothing, every round', bareScratch.steps === 0, String(bareScratch.steps));
check('...and says so as Insignificant Damage', bareScratch.insignificant > 0, String(bareScratch.insignificant));
check('the Perk turns the same swing into real damage', withScratch.steps > 0, String(withScratch.steps));

// One round, one attack, optionally met by a defence — used where the outcome
// IS deterministic (a guard at +20 against a punch at +0 always beats it by
// more than 5, whatever the d4s do).
const fight = async (_unused, { attackMove, defenceMove = null, attackerPerks = [], defenderPerks = [], label }) => {
  gm.emit('combat:clear', {});
  await sleep(700);
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

  const st0 = await jf('/api/combat?role=gm');
  const start = st0.pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    if (!side) break;
    const who = side === 'left' ? atk : def;
    const move = who.id === atk.id ? attackMove : defenceMove;
    if (move) {
      // An ambiguous Hand/Leg slot taken once needs a side; taken twice it
      // means both and the choice is ignored. Sent always, harmlessly.
      gm.emit('move:declare', {
        characterId: who.id, moveId: move.id, placementTic: start, appendageChoice: 'right',
      });
      await sleep(600);
    }
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(700);
  }
  await sleep(5500);
  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
  return { events, atk, def, types: events.map((e) => e.type) };
};

// ============================================ 3. Spiked Shell
console.log('\n--- Spiked Shell: the guard bites the hand that threw the punch ---');
// **`Hand`, not `Right Hand`.** A move's Roll picks from six slots, two of which
// are ambiguous — the side is chosen at declare time (ROLL_SLOT_NAMES in
// moveLogic.js). Taking `Hand` TWICE means both hands, which resolves to Left
// Hand + Right Hand and makes the riposte deterministic: one kind throughout,
// so both take it and there is no random pick to fixture around.
const punch = await mk('Shell Punch', {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  rollSlots: ['Hand', 'Hand'], rollModifier: 0, attackTargets: ['Body'],
});
const guard = await mk('Shell Guard', {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  rollSlots: ['Body'], rollModifier: 20,
  isDefensive: true, defenseKind: 'block', defenseFramePositions: [1, 2],
});
const riposteOf = (r) =>
  r.events.filter((e) => e.type === 'automation_fired').map((e) => e.payload)
    .find((p) => p.sourceName === 'Spiked Shell');

const bareShell = await fight(0, { attackMove: punch, defenceMove: guard, label: 'SS0' });
check('a plain guard sends nothing back', riposteOf(bareShell) === undefined,
  JSON.stringify(bareShell.types));

const withShell = await fight(0, {
  attackMove: punch, defenceMove: guard, defenderPerks: ['Spiked Shell'], label: 'SS1',
});
const riposte = riposteOf(withShell);
console.log('  riposte:', JSON.stringify(riposte));
check('the same guard now bites back', Boolean(riposte), withShell.types.join(', '));
check('reported as a Perk, under its own trigger',
  riposte?.sourceKind === 'perk' && riposte?.trigger === 'block_riposte', JSON.stringify(riposte));
check('and it lands on the limbs that swung — both hands, not the blocker',
  (riposte?.effects ?? []).some((x) => /Left Hand/.test(x)) &&
    (riposte?.effects ?? []).some((x) => /Right Hand/.test(x)),
  JSON.stringify(riposte?.effects));
// The attacker's own sheet is the witness: the log could say anything.
const punchDice = (await jf(`/api/characters/${withShell.atk.id}`)).dice;
const hurt = (slot) => {
  const d = punchDice.find((x) => x.slot_name === slot);
  return d.half_damage === 1 || d.current_size < 4 || d.status === 'incapacitated';
};
check('...and the puncher actually shows it on both hands', hurt('Left Hand') && hurt('Right Hand'),
  JSON.stringify(punchDice.filter((d) => /Hand/.test(d.slot_name))));

// ============================================ 4. Perfect Player
console.log('\n--- Perfect Player: a Dodge costs 2 less, and is charged what it quotes ---');
// **Body, not Leg.** `Hand` and `Leg` are the two AMBIGUOUS Roll slots: taken
// once, the side is chosen at declare time, and a move carrying one needs TWO
// Tells rather than one (see hasAmbiguousRollSlot in writeMove). Handing it a
// single tellId makes writeMove refuse the whole move, silently — which is
// exactly what an earlier version of this script did, and it looked like a
// timeout rather than a rejection. What the Dodge rolls is irrelevant to the
// Perk, so it rolls something unambiguous.
const dodge = await mk('Perfect Dodge', {
  startupTics: 1, activeTics: 1, recoveryTics: 1, staminaCost: 4,
  rollSlots: ['Body'],
  isDefensive: true, defenseKind: 'dodge', defenseFramePositions: [1],
});
// Seated, so the picker payload is the real one the Arena renders.
gm.emit('combat:clear', {});
await sleep(700);
const pp = await jpost('/api/characters', { name: `PP${stamp}`, characterType: 'npc' });
const ppFoe = await jpost('/api/characters', { name: `PPFoe${stamp}`, characterType: 'npc' });
await grant(pp.id, 'Perfect Player');
// Locked first: the condition is measured against the locked baseline, and a
// character who has never locked has no baseline to fall below.
gm.emit('character:lock_stats', { characterId: pp.id });
await sleep(600);
gm.emit('combat:add_participant', { characterId: pp.id, side: 'left', pairIndex: 0 });
await sleep(400);
gm.emit('combat:add_participant', { characterId: ppFoe.id, side: 'right', pairIndex: 0 });
await sleep(700);

const quotedCost = async (characterId, moveId) => {
  const state = await jf('/api/combat?role=gm');
  const move = state.characters[characterId]?.moves?.find((m) => m.id === moveId);
  return move ? { effective: move.effective_stamina_cost, base: move.stamina_cost } : null;
};

const before = await quotedCost(pp.id, dodge.id);
console.log('  quoted while undamaged:', JSON.stringify(before));
check('the picker quotes the discounted cost while nothing is damaged',
  before?.effective === 2 && before?.base === 4, JSON.stringify(before));

// A pending marker, then a dropped rank: only the second breaks the condition.
const ppSheet = await jf(`/api/characters/${pp.id}`);
const skull = ppSheet.dice.find((d) => d.slot_name === 'Skull');
gm.emit('die:toggle_half_damage', { dieId: skull.id });
await sleep(500);
const halfOnly = await quotedCost(pp.id, dodge.id);
check('a PENDING half-damage marker does NOT break it (decided)',
  halfOnly?.effective === 2, JSON.stringify(halfOnly));

gm.emit('die:step', { dieId: skull.id, direction: 'down' });
await sleep(600);
const damaged = await quotedCost(pp.id, dodge.id);
console.log('  quoted after a Stat drops a rank:', JSON.stringify(damaged));
check('a dropped rank does break it — full price again',
  damaged?.effective === 4, JSON.stringify(damaged));

// And the figure quoted is the figure actually spent — the whole point of the
// four-call-site refactor.
gm.emit('character:revert_stats', { characterId: pp.id });
await sleep(700);
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const restored = await quotedCost(pp.id, dodge.id);
check('reverting to base restores the discount', restored?.effective === 2, JSON.stringify(restored));

// GET /api/characters/:id is a sheet — { character, dice, … } — not a bare row.
const staminaOf = async (id) => (await jf(`/api/characters/${id}`))?.character?.current_stamina;
// **Measured across this character's own commit, and nowhere else.** Stamina
// Cost leaves current_stamina at combat:character_done_declaring and nowhere
// else — and the moment BOTH sides finish, the round resolves and opens the
// next one, whose Stamina Regen refills the bar. Reading afterwards therefore
// measures the regen, not the cost, which is what an earlier version of this
// probe did (16 → 16, and it looked like the Perk was doing nothing).
const staminaBefore = await staminaOf(pp.id);
// **Read from the commit's own broadcast, not from a later fetch.** Stamina
// Cost leaves current_stamina inside combat:character_done_declaring, which
// emits character:updated with the new figure — and if this character happens
// to be the SECOND to finish, that same press completes the pair, resolution
// runs, and the next round's Stamina Regen refills the bar before any fetch
// could land. Catching the broadcast makes the probe independent of who
// declared first.
let committedStamina = null;
const onCommit = (c) => { if (c.id === pp.id && committedStamina == null) committedStamina = c.current_stamina; };
gm.on('character:updated', onCommit);
let declared = false;
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? pp : ppFoe;
  if (who.id === pp.id) {
    gm.emit('move:declare', {
      characterId: pp.id, moveId: dodge.id,
      placementTic: st.pairs[0].roundStartTic ?? 0, appendageChoice: 'right',
    });
    await sleep(800);
    const pending = await jf('/api/combat?role=gm');
    declared = (pending.declaredMoves ?? []).some((d) => d.characterId === pp.id);
    gm.emit('combat:character_done_declaring', { characterId: pp.id });
    await sleep(900);
  } else {
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(700);
  }
}
gm.off('character:updated', onCommit);
check('the Dodge was actually declarable at the discounted price', declared, String(declared));
console.log(`  Stamina ${staminaBefore} → ${committedStamina} (quoted ${restored?.effective})`);
check('the Stamina actually spent is the figure the picker quoted',
  committedStamina != null && staminaBefore - committedStamina === restored?.effective,
  JSON.stringify({ before: staminaBefore, committed: committedStamina, quoted: restored?.effective }));

// ============================================ 5. Healing Factor
console.log('\n--- Healing Factor: a pending marker sheds at Round Start ---');
const markTwo = async (characterId) => {
  const sheet = await jf(`/api/characters/${characterId}`);
  for (const slot of ['Skull', 'Body']) {
    const die = sheet.dice.find((d) => d.slot_name === slot);
    if (!die.half_damage) gm.emit('die:toggle_half_damage', { dieId: die.id });
    await sleep(300);
  }
};
const markersOn = async (characterId) =>
  (await jf(`/api/characters/${characterId}`)).dice.filter((d) => d.half_damage).length;

gm.emit('combat:clear', {});
await sleep(700);
const healer = await jpost('/api/characters', { name: `HF${stamp}`, characterType: 'npc' });
const healerFoe = await jpost('/api/characters', { name: `HFFoe${stamp}`, characterType: 'npc' });
const control = await jpost('/api/characters', { name: `HFC${stamp}`, characterType: 'npc' });
await grant(healer.id, 'Healing Factor');
gm.emit('combat:add_participant', { characterId: healer.id, side: 'left', pairIndex: 0 });
await sleep(400);
gm.emit('combat:add_participant', { characterId: healerFoe.id, side: 'right', pairIndex: 0 });
await sleep(400);
gm.emit('combat:add_participant', { characterId: control.id, side: 'left', pairIndex: 1 });
await sleep(700);

await markTwo(healer.id);
await markTwo(control.id);
check('both fighters start with two markers',
  (await markersOn(healer.id)) === 2 && (await markersOn(control.id)) === 2);

gm.emit('combat:next_round', {});
await sleep(2500);
const healerLeft = await markersOn(healer.id);
const controlLeft = await markersOn(control.id);
console.log(`  markers left — Healing Factor ${healerLeft}, control ${controlLeft}`);
check('Healing Factor sheds exactly one', healerLeft === 1, String(healerLeft));
check('...and a fighter without it sheds none', controlLeft === 2, String(controlLeft));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

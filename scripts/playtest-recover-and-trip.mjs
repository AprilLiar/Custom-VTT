// Playtest: two new mechanics that both hang off a move landing.
//
//   1. **Recover Stat** — the same upward step Increase Self Stat already had,
//      with a ceiling: it can never take a Stat past its own locked baseline.
//      That ceiling is the whole difference between healing and improving, so
//      the probe is deliberately built to OVERSHOOT — five steps of recovery
//      against one step of damage — and then check where it stopped.
//   2. **Movement Punisher** — a Tag that only means anything opposite the
//      **Movement** Tag. Connect with somebody mid-stride and they trip: 3
//      Recovery, imposed exactly the way an Add Recovery effect does it.
//
// Each one is run as a PAIR of otherwise identical rounds — the real thing and
// a control — so what the mechanic did is the difference between two fights
// rather than a number read off an event and trusted.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-recover-and-trip.mjs
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
await sleep(400);

const stamp = Date.now();
const charOf = (id) => jf(`/api/characters/${id}`);
const dieOf = async (id, slot) => (await charOf(id)).dice.find((d) => d.slot_name === slot);
const sig = (d) => (d ? `d${d.current_size}+${d.bonus}${d.half_damage ? ' +half' : ''}/${d.status}` : null);

// The Movement pair is seeded at startup and matched BY NAME, so this reads
// the real rows rather than creating fixtures — if the seeding ever broke,
// this playtest is where it shows.
const tags = await jf('/api/tags');
const byName = (n) => tags.find((t) => t.name.trim().toLowerCase() === n.toLowerCase());
const MOVEMENT = byName('Movement');
const PUNISHER = byName('Movement Punisher');
check('both Movement Tags are seeded at startup', Boolean(MOVEMENT && PUNISHER),
  JSON.stringify(tags.map((t) => t.name)));
if (!MOVEMENT || !PUNISHER) { gm.close(); process.exit(1); }

// The world-level Tag list is alphabetical now, not creation order.
const names = tags.map((t) => t.name.trim().toLowerCase());
const sorted = [...names].sort((a, b) => a.localeCompare(b));
check('/api/tags comes back alphabetically, not in creation order',
  JSON.stringify(names) === JSON.stringify(sorted), JSON.stringify(names));

const mkTell = async (label) => {
  gm.emit('tell:create', { name: `Tell ${label} ${stamp}` });
  return wait('tell:created', (t) => t.name === `Tell ${label} ${stamp}`);
};
const mkMove = async (label, name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${label} ${stamp}`, isDefault: true, tellId: extra.tellId,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${label} ${stamp}`);
};

// Seats two fresh NPCs, runs one round in which each throws the move it was
// handed on the round's first Tic, and hands back the stored round's events.
const runRound = async (atkMove, vicMove, { atk, vic }) => {
  gm.emit('combat:add_participant', { characterId: atk.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === atk.id));
  gm.emit('combat:add_participant', { characterId: vic.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === vic.id));
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

  const st0 = await jf('/api/combat?role=gm');
  const start = st0.pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    if (!side) break;
    const who = side === 'left' ? atk : vic;
    const move = who.id === atk.id ? atkMove : vicMove;
    if (move) {
      gm.emit('move:declare', { characterId: who.id, moveId: move.id, placementTic: start });
      await sleep(600);
    }
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(700);
  }
  await sleep(4500);
  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  return summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
};

// ==========================================================================
// 1. Recover Stat
//
// The fighter locks at d8 across the board, takes their Left Hand down a
// whole step AND is left carrying a pending half, then throws a move that
// recovers FIVE steps. One step of damage, five steps of healing: where it
// stops is the entire mechanic.
console.log('\n--- Recover Stat: heal one step of damage with five steps of recovery ---');
gm.emit('combat:clear', {});
await sleep(700);
const tellR = await mkTell('R');

const healer = await jpost('/api/characters', { name: `Healer${stamp}`, characterType: 'npc' });
const dummy = await jpost('/api/characters', { name: `Dummy${stamp}`, characterType: 'npc' });
// A fresh character's Stats are all d4 — the floor. Buy the Left Hand up two
// steps BEFORE locking, so the baseline this heals back to is somewhere a
// die can be overshot past; healing back to a d4 would prove nothing about a
// ceiling, since there is nothing above it in the fixture.
const handId = (await dieOf(healer.id, 'Left Hand')).id;
gm.emit('die:step', { dieId: handId, direction: 'up' });
await sleep(350);
gm.emit('die:step', { dieId: handId, direction: 'up' });
await sleep(450);
gm.emit('character:lock_stats', { characterId: healer.id });
await sleep(600);
const baseline = await dieOf(healer.id, 'Left Hand');
console.log('  Left Hand at lock:', sig(baseline), '| locked', `d${baseline.locked_size}+${baseline.locked_bonus}`);
check('the fixture locks somewhere a heal could overshoot past', baseline.current_size > 4, sig(baseline));

// A whole step down, plus a half still pending — the half is the interesting
// half, because healing has to clear it before it buys a whole step.
gm.emit('die:step', { dieId: baseline.id, direction: 'down' });
await sleep(400);
gm.emit('die:toggle_half_damage', { dieId: baseline.id });
await sleep(500);
const hurt = await dieOf(healer.id, 'Left Hand');
console.log('  Left Hand hurt:  ', sig(hurt));
check('the fixture really is damaged and carrying a pending half',
  hurt.current_size < baseline.current_size && Boolean(hurt.half_damage), sig(hurt));
check('...and is still a live Stat, so this is healing and not a revival',
  hurt.status !== 'incapacitated', sig(hurt));

// Two Stats, two effects, one landing: Left Hand is damaged and gets healed;
// Body is untouched and must stay untouched, which is what separates Recover
// Stat from Increase Self Stat in a single round.
const shakeOut = await mkMove('R', 'Shake It Out', {
  tellId: tellR.id, startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Skull'], rollModifier: 6, attackTargets: ['Skull'],
  interactions: {
    hit: {
      text: 'rolls the wrist out mid-swing',
      automations: [
        { type: 'self_stat_recover', slot: 'Left Hand', amount: 5 },
        { type: 'self_stat_recover', slot: 'Body', amount: 5 },
      ],
    },
  },
});
const bodyBefore = await dieOf(healer.id, 'Body');
const evR = await runRound(shakeOut, null, { atk: healer, vic: dummy });

const healed = await dieOf(healer.id, 'Left Hand');
const bodyAfter = await dieOf(healer.id, 'Body');
console.log('  Left Hand after: ', sig(healed), '| Body after:', sig(bodyAfter));
const fired = evR.filter((e) => e.type === 'automation_fired').map((e) => e.payload);
check('the effect fired at all', fired.length > 0, evR.map((e) => e.type).join(', '));
check('the pending half step is cleared by the healing', healed.half_damage === 0 || healed.half_damage === false,
  sig(healed));
check('the Stat is back at its locked baseline',
  healed.current_size === baseline.current_size && healed.bonus === baseline.bonus, sig(healed));
check('...and NOT one step past it — the four leftover steps go nowhere',
  healed.current_size === healed.locked_size && healed.bonus === healed.locked_bonus, sig(healed));
check('an undamaged Stat is left exactly alone',
  bodyAfter.current_size === bodyBefore.current_size && bodyAfter.bonus === bodyBefore.bonus,
  JSON.stringify({ before: sig(bodyBefore), after: sig(bodyAfter) }));
check('the log calls it recovery rather than a plain step up',
  fired.some((p) => (p.effects ?? []).some((x) => /recovered/i.test(x))),
  JSON.stringify(fired.map((p) => p.effects)));

// ==========================================================================
// 2. Movement Punisher, and its control
console.log('\n--- Movement Punisher: catch somebody mid-stride ---');
const tripFight = async (label, { punisherTags }) => {
  gm.emit('combat:clear', {});
  await sleep(700);
  const tell = await mkTell(label);
  const sweep = await mkMove(label, 'Sweep', {
    tellId: tell.id, startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 6, attackTargets: ['Skull'], tagIds: punisherTags,
  });
  // Long enough to still be on the clock when the sweep lands, so there is
  // something for the imposed Recovery to be added to.
  const dash = await mkMove(label, 'Dash', {
    tellId: tell.id, startupTics: 1, activeTics: 3, recoveryTics: 2,
    rollSlots: ['Body'], rollModifier: -20, tagIds: [MOVEMENT.id],
  });
  const atk = await jpost('/api/characters', { name: `Sweeper${label}${stamp}`, characterType: 'npc' });
  const vic = await jpost('/api/characters', { name: `Runner${label}${stamp}`, characterType: 'npc' });
  const events = await runRound(sweep, dash, { atk, vic });
  const trip = events
    .filter((e) => e.type === 'automation_fired')
    .map((e) => e.payload)
    .find((p) => p.sourceName === 'Movement Punisher');
  // `imposeRecovery` announces itself as moves_displaced — the frames land on
  // the clock and everything after them slides, which is the whole point of
  // routing this through the ordinary Add Recovery effect.
  const imposed = events.filter((e) => e.type === 'moves_displaced');
  return { events, trip, imposed, vicId: vic.id };
};

const tagged = await tripFight('T', { punisherTags: [PUNISHER.id] });
console.log('  trip payload:', JSON.stringify(tagged.trip));
check('the trip reaches the round log', Boolean(tagged.trip),
  tagged.events.map((e) => e.type).join(', '));
check('it is reported as a TAG, not as something a GM authored',
  tagged.trip?.sourceKind === 'tag', JSON.stringify(tagged.trip));
check('under its own trigger, labelled for the table',
  tagged.trip?.trigger === 'movement_punished' && /trip/i.test(tagged.trip?.triggerLabel ?? ''),
  JSON.stringify({ trigger: tagged.trip?.trigger, label: tagged.trip?.triggerLabel }));
check('and it is 3 Recovery, worded exactly like an authored Add Recovery',
  (tagged.trip?.effects ?? []).some((x) => /\+3 Recovery/.test(x)),
  JSON.stringify(tagged.trip?.effects));
check('the Recovery actually landed on the clock, not just in the log',
  tagged.imposed.length > 0, tagged.events.map((e) => e.type).join(', '));

console.log('\n--- the control: the same dash, swept by a move with no Tag ---');
const bare = await tripFight('U', { punisherTags: [] });
check('an ordinary sweep trips nobody', bare.trip === undefined,
  JSON.stringify(bare.events.filter((e) => e.type === 'automation_fired').map((e) => e.payload)));
// The control has to have actually connected, or it proves nothing.
check('...and it is not simply that the control never landed',
  bare.events.some((e) => e.type === 'damage_applied'),
  bare.events.map((e) => e.type).join(', '));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

// Playtest: the stat-step automations (self_stat_step / opponent_stat_step),
// across triggers, and what they LOOK like in the round log.
//
// Two things under test:
//   1. do they actually fire — for On Hit, and for a defensive trigger;
//   2. does a step read correctly, in both directions. A step is signed:
//      positive damages, negative steps the Stat back UP. The log used to
//      narrate every step as a plain `damage_applied`, so stepping a Stat up
//      by 1 printed "-1 steps of damage to Body" — which is what "looks weird"
//      meant.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-stat-step.mjs
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
gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: 'Hips turn' });
const tell = await wait('tell:created');
const stamp = Date.now();

// One attack that, on landing, steps the victim's Brain DOWN and its own
// user's Stamina Stat back UP — a signed pair in one interaction.
gm.emit('move:create', {
  name: `Rattler ${stamp}`, isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  description: 'rattles them', rollSlots: ['Skull'], attackTargets: ['Body'],
  staminaCost: 0, rollModifier: 30,
  interactions: {
    hit: {
      text: 'the head rings',
      automations: [
        { type: 'opponent_stat_step', slot: 'Brain', amount: 1 },
        { type: 'self_stat_step', slot: 'Stamina', amount: -1 },
      ],
    },
  },
});
const rattler = await wait('move:created', (m) => m.name === `Rattler ${stamp}`);

const atk = await jpost('/api/characters', { name: `Atk${stamp}`, characterType: 'npc' });
const vic = await jpost('/api/characters', { name: `Vic${stamp}`, characterType: 'npc' });
const diceOf = async (id) => (await jf(`/api/characters/${id}`)).dice;
const sig = (dice, slot) => {
  const d = dice.find((x) => x.slot_name === slot);
  return d ? `d${d.current_size}+${d.bonus}/${d.status}${d.half_damage ? '/half' : ''}` : null;
};
const beforeVic = await diceOf(vic.id);
const beforeAtk = await diceOf(atk.id);

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
  if (who.id === atk.id) {
    gm.emit('move:declare', { characterId: atk.id, moveId: rattler.id, placementTic: start });
    await sleep(500);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(700);
}
await sleep(4000);

const afterVic = await diceOf(vic.id);
const afterAtk = await diceOf(atk.id);
console.log(`  victim Brain   ${sig(beforeVic, 'Brain')} -> ${sig(afterVic, 'Brain')}`);
console.log(`  attacker Stam  ${sig(beforeAtk, 'Stamina')} -> ${sig(afterAtk, 'Stamina')}`);

check('opponent_stat_step actually stepped the victim down',
  sig(afterVic, 'Brain') !== sig(beforeVic, 'Brain'),
  `${sig(beforeVic, 'Brain')} -> ${sig(afterVic, 'Brain')}`);
check('self_stat_step with a NEGATIVE amount stepped the user back up',
  sig(afterAtk, 'Stamina') !== sig(beforeAtk, 'Stamina'),
  `${sig(beforeAtk, 'Stamina')} -> ${sig(afterAtk, 'Stamina')}`);

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
console.log('  events:', events.map((e) => e.type).join(', '));

const fired = events.filter((e) => e.type === 'automation_fired');
check('the round log records the automation firing', fired.length >= 1,
  JSON.stringify(fired.map((e) => e.payload.effects)));
check('...and names both steps in it',
  fired.some((e) => (e.payload.effects ?? []).some((x) => /Brain/.test(x))) &&
    fired.some((e) => (e.payload.effects ?? []).some((x) => /Stamina/.test(x))),
  JSON.stringify(fired.map((e) => e.payload.effects)));

// The display defect: a stat step emitted a bare damage_applied alongside the
// automation_fired that already described it.
const stepEvents = events.filter(
  (e) => e.type === 'damage_applied' && e.payload?.source === 'automation'
);
console.log('  automation damage_applied events:', JSON.stringify(stepEvents.map((e) => ({
  slot: e.payload.slotName, steps: e.payload.steps, attacker: e.payload.attackerCharacterName,
}))));
check('a stat step no longer narrates itself as anonymous damage',
  stepEvents.length === 0,
  `${stepEvents.length} bare damage_applied event(s) from automations`);
const negative = events.filter((e) => e.type === 'damage_applied' && (e.payload?.steps ?? 0) < 0);
check('nothing in the log claims a negative number of damage steps', negative.length === 0,
  JSON.stringify(negative.map((e) => e.payload)));

const stepped = events.filter((e) => e.type === 'stat_stepped').map((e) => e.payload);
console.log('  stat_stepped:', JSON.stringify(stepped.map((p) => ({
  slot: p.slotName, steps: p.steps, from: p.sizeBefore, to: p.sizeAfter,
}))));
check('each step gets its own stat_stepped event', stepped.length === 2, JSON.stringify(stepped));
check('the signs survive — one down, one up',
  stepped.some((p) => p.steps > 0) && stepped.some((p) => p.steps < 0),
  JSON.stringify(stepped.map((p) => p.steps)));
check('and each carries the before/after the cutscene needs to move the pip',
  stepped.every((p) => p.sizeBefore != null && p.sizeAfter != null && p.characterId != null),
  JSON.stringify(stepped));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

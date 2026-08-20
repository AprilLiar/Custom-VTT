// Playtest: the two new "on hit / on block / ..." effects.
//
//   1. **Increase Self Stat** — the same stat step the game already had, with
//      its direction in its name instead of in a minus sign, because "type −2
//      to heal 2" is not an authoring affordance anybody finds.
//   2. **Decrease Next Target Roll** — a debt rather than a modifier: it is
//      spent by the very next roll that character makes, of any kind, and is
//      then gone.
//
// One fight proves both. The attacker's punch lands on Tic 1 and fires them;
// the victim's own move is placed late enough to be idle at that Tic (so it is
// not Interrupted) and rolls afterwards, which is where the debt gets paid.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-trigger-effects.mjs
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
const PENALTY = 7;

gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: `Shoulder drops ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `Shoulder drops ${stamp}`);

const mk = async (name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// Aims at Body, rolls Skull, and steps its OWN Skull up on landing — so the
// Stat it improves is one nothing else in the round touches, and the step is
// unmistakably the automation's doing.
const rattler = await mk('Rattler', {
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Skull'], rollModifier: 6, attackTargets: ['Body'],
  interactions: {
    hit: {
      text: 'it lands square',
      automations: [
        { type: 'self_stat_increase', slot: 'Skull', amount: 1 },
        { type: 'opponent_next_roll_penalty', amount: PENALTY },
      ],
    },
  },
});
// Rolls Brain, which the punch never damages, so the roll it makes afterwards
// is a clean look at the debt.
const counter = await mk('Counter', {
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  rollSlots: ['Brain'], attackTargets: ['Body'],
});

const atk = await jpost('/api/characters', { name: `Atk${stamp}`, characterType: 'npc' });
const vic = await jpost('/api/characters', { name: `Vic${stamp}`, characterType: 'npc' });
const charOf = async (id) => (await jf(`/api/characters/${id}`));
const sig = (c, slot) => {
  const d = c.dice.find((x) => x.slot_name === slot);
  return d ? `d${d.current_size}+${d.bonus}/${d.status}${d.half_damage ? '/half' : ''}` : null;
};
const beforeAtk = await charOf(atk.id);

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
  const isAtk = side === 'left';
  gm.emit('move:declare', {
    characterId: isAtk ? atk.id : vic.id,
    moveId: isAtk ? rattler.id : counter.id,
    // The victim starts winding up at Tic 3, well clear of the punch's single
    // Active Tic — idle when it lands, so nothing here is an Interruption.
    placementTic: isAtk ? start : start + 3,
  });
  await sleep(600);
  gm.emit('combat:character_done_declaring', { characterId: isAtk ? atk.id : vic.id });
  await sleep(700);
}
await sleep(5000);

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
console.log('  events:', events.map((e) => e.type).join(', '));

// ============================================== 1. Increase Self Stat
console.log('\n--- Increase Self Stat ---');
const afterAtk = await charOf(atk.id);
console.log(`  attacker Skull ${sig(beforeAtk, 'Skull')} -> ${sig(afterAtk, 'Skull')}`);
check('the attacker\'s own Stat actually moved up',
  sig(afterAtk, 'Skull') !== sig(beforeAtk, 'Skull'),
  `${sig(beforeAtk, 'Skull')} -> ${sig(afterAtk, 'Skull')}`);
const stepped = events.filter((e) => e.type === 'stat_stepped').map((e) => e.payload);
console.log('  stat_stepped:', JSON.stringify(stepped.map((p) => ({
  who: p.characterName, slot: p.slotName, steps: p.steps, from: p.sizeBefore, to: p.sizeAfter,
}))));
const up = stepped.find((p) => p.characterId === atk.id && p.slotName === 'Skull');
check('it is logged as a step, not as damage', up != null, JSON.stringify(stepped));
check('...signed UPWARD, so the log can say so', (up?.steps ?? 0) < 0, JSON.stringify(up));
check('...and carries the before/after the cutscene needs',
  up?.sizeBefore != null && up?.sizeAfter != null && up.sizeAfter > up.sizeBefore,
  JSON.stringify({ from: up?.sizeBefore, to: up?.sizeAfter }));

// ============================================== 2. Decrease Next Target Roll
console.log('\n--- Decrease Next Target Roll ---');
const owedEvent = events.find((e) => e.type === 'next_roll_penalty');
console.log('  next_roll_penalty:', JSON.stringify(owedEvent?.payload));
check('the debt is announced in the round log', owedEvent != null,
  events.map((e) => e.type).join(', '));
check('...against the opponent, for the authored amount',
  owedEvent?.payload?.characterId === vic.id && owedEvent?.payload?.amount === PENALTY,
  JSON.stringify(owedEvent?.payload));

const fired = events.filter((e) => e.type === 'automation_fired').flatMap((e) => e.payload.effects ?? []);
console.log('  automation effects:', JSON.stringify(fired));
check('both effects are named in the fired-automation line',
  fired.some((x) => /Skull up 1 step/.test(x)) && fired.some((x) => new RegExp(`${PENALTY} on `).test(x)),
  JSON.stringify(fired));

// The victim's own roll, which happens two Tics later, is where the debt is
// actually paid — and it has to be visible as its own named term rather than
// disappearing into an unexplained modifier.
const victimRoll = events.find((e) => e.type === 'roll' && e.payload?.characterId === vic.id);
console.log('  victim roll:', JSON.stringify(victimRoll?.payload && {
  modifier: victimRoll.payload.modifier,
  breakdown: victimRoll.payload.modifierBreakdown,
}));
const term = (victimRoll?.payload?.modifierBreakdown ?? []).find((t) => t.key === 'next_roll_penalty');
check('the next roll they make is weakened', term != null,
  JSON.stringify(victimRoll?.payload?.modifierBreakdown));
check('...by exactly the authored amount, as its own named term',
  term?.amount === -PENALTY, JSON.stringify(term));
check('...and the modifier really is that much lower',
  (victimRoll?.payload?.modifier ?? 0) <= -PENALTY,
  JSON.stringify({ modifier: victimRoll?.payload?.modifier }));

const afterVic = await charOf(vic.id);
check('the debt is spent, not standing', afterVic.character.pending_roll_penalty === 0,
  JSON.stringify({ pending: afterVic.character.pending_roll_penalty }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

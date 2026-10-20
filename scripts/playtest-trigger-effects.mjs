// Playtest: the two new "on hit / on block / ..." effects.
//
//   1. **Increase Self Stat** — the same stat step the game already had, with
//      its direction in its name instead of in a minus sign, because "type −2
//      to heal 2" is not an authoring affordance anybody finds.
//   2. **Decrease Next Target Roll** — a debt rather than a modifier: it is
//      spent by the next roll that character makes, of any kind, **within three
//      frames**, and is then gone either way (revised — it used to wait
//      indefinitely, so a mark left on Tic 3 could be paid off two rounds later
//      by a roll nobody at the table could connect to it).
//
// One fight proves all of it. The attacker's punch lands on the round's second
// Tic and fires both effects; the victim's own move is placed late enough to be
// idle at that Tic (so it is not Interrupted) and rolls afterwards, which is
// where the debt gets paid. Round 1 puts that roll on the window's last frame
// and round 2 puts it one frame past — the two rounds together are the window.
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

// One round. The punch goes in at the round's own first Tic and lands on the
// next one; the victim's move is placed `victimOffset` Tics in, so — with its
// single Startup frame — it rolls exactly `victimOffset` frames after the blow.
// That offset is the whole instrument for the window below, and it also keeps
// the victim idle when the punch lands, so nothing here is an Interruption.
async function playRound(victimOffset) {
  const open = await jf('/api/combat?role=gm');
  if (open.pairs[0]?.phase !== 'declaration') {
    gm.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  }
  const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    if (!side) break;
    const isAtk = side === 'left';
    gm.emit('move:declare', {
      characterId: isAtk ? atk.id : vic.id,
      moveId: isAtk ? rattler.id : counter.id,
      placementTic: isAtk ? start : start + victimOffset,
    });
    await sleep(600);
    gm.emit('combat:character_done_declaring', { characterId: isAtk ? atk.id : vic.id });
    await sleep(700);
  }
  await sleep(6000);
  const log = await jf('/api/chat');
  const card = log.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  return card ? (await jf(`/api/combat/round-replay/${card.resolutionId}`))?.events ?? [] : [];
}

// Three frames after the blow is the last Tic the debt is good for, so round 1
// is also the window's own upper boundary.
const events = await playRound(3);
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
check('...and the round log says how long it was good for',
  owedEvent?.payload?.untilTic === (owedEvent?.tic ?? 0) + 3,
  JSON.stringify({ tic: owedEvent?.tic, untilTic: owedEvent?.payload?.untilTic }));

// ============================================== 3. ...and it expires
//
// The window is three frames, and round 1 above sits exactly on its last one.
// Round 2 is the identical fight with the victim's move one Tic later, so their
// roll is the FOURTH frame after the blow — the first one the mark should not
// reach. Driven as a second round rather than asserted on a stored number,
// because what was reported is a debuff landing on a roll nobody could connect
// to it, and only a real round answers that.
console.log('\n--- ...and the mark lapses after three frames ---');
const late = await playRound(4);
console.log('  events:', late.map((e) => e.type).join(', '));
const lateOwed = late.find((e) => e.type === 'next_roll_penalty');
check('the blow landed and left its mark again', lateOwed != null, late.map((e) => e.type).join(', '));
const lateRoll = late.find((e) => e.type === 'roll' && e.payload?.characterId === vic.id);
check('the victim still rolled', lateRoll != null, JSON.stringify(late.map((e) => e.type)));
const lateTerms = lateRoll?.payload?.modifierBreakdown ?? [];
console.log('  victim roll (4 frames later):', JSON.stringify({
  hitTic: lateOwed?.tic, rollTic: lateRoll?.tic, modifier: lateRoll?.payload?.modifier, breakdown: lateTerms,
}));
check('...four frames after the blow, so the mark does not reach it',
  (lateRoll?.tic ?? 0) - (lateOwed?.tic ?? 0) === 4,
  JSON.stringify({ hitTic: lateOwed?.tic, rollTic: lateRoll?.tic }));
check('...and the roll carries no Weakened term',
  lateTerms.find((t) => t.key === 'next_roll_penalty') == null, JSON.stringify(lateTerms));
const afterLate = await charOf(vic.id);
check('an expired mark is cleared rather than left waiting for a later roll',
  afterLate.character.pending_roll_penalty === 0,
  JSON.stringify({ pending: afterLate.character.pending_roll_penalty }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

// Playtest: **which fighter a roll modifier lands on when two rolls are
// contested.**
//
// Reported from the table as two things at once — "the Punisher Tag adds a
// bonus to the enemy roll instead of the user's", and "the Stance modifier is
// basically double-applied, debuffing the weaker fighter and buffing the
// stronger one". They are one question, and it cannot be answered by a unit
// test over pure functions: both rolls are only right if the engine asks the
// shared modifier funnel for the right *character* at the right *Tic*. So this
// drives real Block contests and reads both halves back off the round replay.
//
// Three rules are pinned:
//
//   1. **The Punisher's +2 goes to whoever is wearing the Tag**, whether they
//      are throwing the attack or holding the guard — and never to the fighter
//      whose move it caught.
//   2. **The guard roll carries an itemised breakdown.** It used to carry a bare
//      number, so a +2 on somebody's defence had nothing saying where it came
//      from — which is exactly how a correctly-paid Tag gets read as the engine
//      paying the wrong fighter.
//   3. **A contest scores the Stance matchup once**, on the roll being thrown.
//      `pairScore` is antisymmetric, so asking both fighters for their own
//      matchup paid the favoured one +S and charged the other −S: one point on
//      the counter chart moved the comparison by two.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-contested-rolls.mjs
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
  console.log('\n1 FAILURE(S)');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);
const stamp = Date.now();
gm.emit('tell:create', { name: `Contest Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `Contest Tell ${stamp}`);

// Matched by NAME off the live list, exactly as the automation does.
const tags = await jf('/api/tags');
const punisherBody = (tags ?? []).find((t) => /^punisher\s*[-–—:]\s*body$/i.test(String(t.name).trim()));
check('the Punisher - Body Tag is seeded and reachable by name', punisherBody != null,
  JSON.stringify((tags ?? []).map((t) => t.name)));
if (!punisherBody) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }

// A counter pair off the live chart, so the two stances below are guaranteed
// not to be even — otherwise the matchup probes would pass for the wrong
// reason.
const rules = await jf('/api/ruleset');
const attrs = rules.attributes ?? [];
const counter = (rules.counters ?? rules.attributeCounters ?? [])[0];
check('the counter chart has a row to build a lopsided matchup from', counter != null,
  JSON.stringify(rules?.counters?.slice(0, 2)));
if (!counter) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name}${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Body'],
    attackTargets: [], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name}${stamp}`);
};

// The attack **rolls Body**, which is what makes it punishable by a
// `Punisher - Body` on the other side, and carries a big flat modifier so it
// always clears the damage threshold and always reaches the guard.
const punch = await mk('Punch', { activeTics: 2, attackTargets: ['Skull'], rollModifier: 30 });
const punchPun = await mk('PunchPun', {
  activeTics: 2, attackTargets: ['Skull'], rollModifier: 30, tagIds: [punisherBody.id],
});
// The guard's Defense Frames sit on its Active frames and cover the attack's
// whole Active window — 'full' coverage, which is what reaches a GM.
const guardArgs = {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  rollSlots: ['Body'], isDefensive: true, defenseKind: 'block', defenseFramePositions: [1, 2],
};
const guard = await mk('Guard', guardArgs);
const guardPun = await mk('GuardPun', { ...guardArgs, tagIds: [punisherBody.id] });

const mkStance = async (characterId, a, b) => {
  gm.emit('stance:create', { characterId, name: `St${stamp}`, attributeAId: a, attributeBId: b });
  await sleep(400);
  const sheet = await jf(`/api/characters/${characterId}`);
  const st = sheet.stances[sheet.stances.length - 1];
  gm.emit('stance:activate', { characterId, stanceId: st.id });
  await sleep(300);
};

// One fight: a fresh pair, one attack, one Block, the round played out and the
// two rolls read back off the replay. A fresh pair per case rather than extra
// rounds on one, so no case can inherit another's damage, Stamina or stances.
const fight = async (label, { attackMove = punch, guardMove = guard, stances = false } = {}) => {
  gm.emit('combat:clear', {});
  await sleep(900);
  const a = await jpost('/api/characters', { name: `A${label}${stamp}`, characterType: 'npc' });
  const b = await jpost('/api/characters', { name: `B${label}${stamp}`, characterType: 'npc' });
  if (stances) {
    const third = attrs.find((x) => x.id !== counter.attacker_attribute_id && x.id !== counter.defender_attribute_id);
    await mkStance(a.id, counter.attacker_attribute_id, third?.id ?? counter.attacker_attribute_id);
    await mkStance(b.id, counter.defender_attribute_id, third?.id ?? counter.defender_attribute_id);
  }
  gm.emit('combat:add_participant', { characterId: a.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === a.id));
  gm.emit('combat:add_participant', { characterId: b.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === b.id));
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

  const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
  const want = { left: { id: a.id, moveId: attackMove.id }, right: { id: b.id, moveId: guardMove.id } };
  for (let i = 0; i < 2; i += 1) {
    const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
    if (!side) break;
    const w = want[side];
    gm.emit('move:declare', { characterId: w.id, moveId: w.moveId, placementTic: start });
    await sleep(600);
    gm.emit('combat:character_done_declaring', { characterId: w.id });
    await sleep(800);
  }

  // A Block always pauses for the GM; answer it Successful so the guard
  // actually rolls, which is the roll this whole script is about.
  for (let i = 0; i < 120; i += 1) {
    const state = await jf('/api/combat?role=gm');
    const pair = state?.pairs?.[0];
    if (pair?.phase === 'declaration' && (pair.roundNumber ?? 1) > 1) break;
    if (pair?.resolutionStatus === 'paused_defense') {
      gm.emit('combat:resolve_block', { pairIndex: 0, outcome: 'successful' });
      await sleep(700);
    }
    await sleep(250);
  }
  const chat = (await jf('/api/chat')) ?? [];
  const card = [...chat].reverse().find((e) => e.kind === 'round_summary');
  const events = card ? ((await jf(`/api/combat/round-replay/${card.resolutionId}`))?.events ?? []) : [];
  const rollOf = (id) => events.find((e) => e.type === 'roll' && e.payload?.characterId === id)?.payload ?? null;
  const out = { a, b, attack: rollOf(a.id), block: rollOf(b.id) };
  console.log(`  ${label}: attack mod=${out.attack?.modifier} ${JSON.stringify(out.attack?.modifierBreakdown)}`);
  console.log(`  ${label}: guard  mod=${out.block?.modifier} ${JSON.stringify(out.block?.modifierBreakdown)}`);
  return out;
};

const termOf = (roll, key) => (roll?.modifierBreakdown ?? []).find((t) => t.key === key) ?? null;

// =====================================================================
console.log('\n--- 1. a Punisher on the ATTACK pays the attacker ---');
// =====================================================================
const bare = await fight('bare');
const onAttack = await fight('atkpun', { attackMove: punchPun });
{
  check('both halves of the contest rolled', onAttack.attack != null && onAttack.block != null,
    JSON.stringify({ attack: onAttack.attack, block: onAttack.block }));
  const term = termOf(onAttack.attack, 'punisher');
  check('the Tag pays its own wearer +2', term?.amount === 2, JSON.stringify(onAttack.attack?.modifierBreakdown));
  check('...naming the Stat and the move it caught',
    /^Punisher: Body \(.+\)$/.test(term?.label ?? ''), JSON.stringify(term?.label));
  check('...and the fighter it caught gets nothing from it',
    termOf(onAttack.block, 'punisher') == null, JSON.stringify(onAttack.block?.modifierBreakdown));
  // The difference between two runs IS the Tag: same frames, same fixture.
  check('the identical untagged attack rolls exactly 2 lower',
    (onAttack.attack?.modifier ?? 0) - (bare.attack?.modifier ?? 0) === 2,
    JSON.stringify({ tagged: onAttack.attack?.modifier, bare: bare.attack?.modifier }));
}

// =====================================================================
console.log('\n--- 2. ...and a Punisher on the GUARD pays the blocker ---');
// =====================================================================
const onGuard = await fight('guardpun', { guardMove: guardPun });
{
  const term = termOf(onGuard.block, 'punisher');
  // This is the half that used to be invisible: the guard roll carried a bare
  // modifier, so a correctly-paid +2 on somebody's defence had nothing on it
  // saying so.
  check('the guard roll carries an itemised breakdown at all',
    Array.isArray(onGuard.block?.modifierBreakdown), JSON.stringify(onGuard.block));
  check('the Tag pays the blocker wearing it +2', term?.amount === 2,
    JSON.stringify(onGuard.block?.modifierBreakdown));
  check('...naming the attack it caught',
    /^Punisher: Body \(.+\)$/.test(term?.label ?? ''), JSON.stringify(term?.label));
  check('...and the attacker whose move it caught gets nothing',
    termOf(onGuard.attack, 'punisher') == null, JSON.stringify(onGuard.attack?.modifierBreakdown));
  check('the guard really is 2 higher than the identical untagged one',
    (onGuard.block?.modifier ?? 0) - (bare.block?.modifier ?? 0) === 2,
    JSON.stringify({ tagged: onGuard.block?.modifier, bare: bare.block?.modifier }));
}

// =====================================================================
console.log('\n--- 3. a contest scores the Stance matchup ONCE ---');
// =====================================================================
const withStances = await fight('stance', { stances: true });
{
  const stance = termOf(withStances.attack, 'stance');
  check('the roll being thrown carries the matchup', (stance?.amount ?? 0) !== 0,
    JSON.stringify(withStances.attack?.modifierBreakdown));
  // The regression. This used to be the exact negative of the term above, so a
  // +1 matchup moved the contest by 2.
  check('the guard answering it carries NONE of it',
    termOf(withStances.block, 'stance') == null && termOf(withStances.block, 'combat_style') == null,
    JSON.stringify(withStances.block?.modifierBreakdown));
  check('...so the guard rolls exactly what an unstanced one does',
    (withStances.block?.modifier ?? 0) === (bare.block?.modifier ?? 0),
    JSON.stringify({ stanced: withStances.block?.modifier, bare: bare.block?.modifier }));
  check('...and the whole swing is the matchup itself, not twice it',
    (withStances.attack?.modifier ?? 0) - (bare.attack?.modifier ?? 0) === (stance?.amount ?? 0),
    JSON.stringify({
      stanced: withStances.attack?.modifier, bare: bare.attack?.modifier, term: stance?.amount,
    }));
}

gm.emit('combat:clear', {});
await sleep(500);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

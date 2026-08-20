// Playtest: Interrupter (x) and Hard to Interrupt (x) — the first Tags that
// carry a number, and the first that move a comparison without moving a roll.
//
// The Interruption check is `roll >= damage taken`, where the roll is the
// Interruption's own and is thrown on the caught move's Roll. Interrupter (x)
// adds to that roll; Hard to Interrupt (x) raises the bar. Each fight below is
// run twice — once bare, once tagged — so what the Tag did is the difference
// between two otherwise identical rounds rather than a number to be trusted.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-interrupt-tags.mjs
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

// The Tags carry their amount in their own NAME — no new column, and a GM
// writing "Interrupter (99)" on a card is already how a table would put it.
// **Not stamped**, unlike every other fixture in here: the amount has to be
// the whole rest of the name for it to parse at all, so these two are the one
// place a playtest must use the exact game names. Re-running is harmless —
// the lookup below finds whichever row already exists.
gm.emit('tag:create', { name: 'Interrupter (99)', description: 'playtest fixture' });
gm.emit('tag:create', { name: 'Hard to Interrupt (99)', description: 'playtest fixture' });
await sleep(800);
const tags = await jf('/api/tags');
const byName = (n) => tags.find((t) => t.name.trim().toLowerCase() === n.toLowerCase());
const INTERRUPTER = byName('Interrupter (99)');
const HARD = byName('Hard to Interrupt (99)');
check('the two parameterised Tags exist', Boolean(INTERRUPTER && HARD),
  JSON.stringify(tags.map((t) => t.name)));
if (!INTERRUPTER || !HARD) process.exit(1);

// One fight: a fast punch thrown into a slow wind-up, so the punch's Active
// window lands while the other move is still in Startup — the only situation
// an Interruption can happen in at all.
//
// `windupModifier` decides the baseline: +20 makes the Interruption certain,
// -20 makes it impossible (±20 is the clamp a move's roll modifier gets). The
// Tags then have to overturn each.
const fight = async (label, { windupModifier, punchTags = [], windupTags = [] }) => {
  gm.emit('combat:clear', {});
  await sleep(700);
  gm.emit('tell:create', { name: `Tell ${label} ${stamp}` });
  const tell = await wait('tell:created', (t) => t.name === `Tell ${label} ${stamp}`);

  const mk = async (name, extra) => {
    gm.emit('move:create', {
      name: `${name} ${label} ${stamp}`, isDefault: true, tellId: tell.id,
      description: name, interactions: {}, attackTargets: ['Body'], staminaCost: 0, ...extra,
    });
    return wait('move:created', (m) => m.name === `${name} ${label} ${stamp}`);
  };
  // Active for 2 Tics starting at Tic 1. +6 is deliberately modest: damage is
  // floor(total/5) HALF steps, and a blow big enough to incapacitate the Stat
  // the wind-up rolls on leaves nothing to roll the Interruption with — the
  // check then bails before it ever compares anything. It aims at Skull for
  // the same reason, so the Body die stays whole.
  const punch = await mk('Punch', {
    startupTics: 1, activeTics: 2, recoveryTics: 1,
    rollSlots: ['Skull'], rollModifier: 6, attackTargets: ['Skull'], tagIds: punchTags,
  });
  // 3 Tics of Startup from Tic 0, so it is still winding up when the punch
  // lands. Its own Roll is what the Interruption is thrown on.
  const windup = await mk('Slow Windup', {
    startupTics: 3, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Body'], rollModifier: windupModifier, tagIds: windupTags,
  });

  const atk = await jpost('/api/characters', { name: `Atk${label}${stamp}`, characterType: 'npc' });
  const vic = await jpost('/api/characters', { name: `Vic${label}${stamp}`, characterType: 'npc' });
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
    gm.emit('move:declare', {
      characterId: who.id,
      moveId: who.id === atk.id ? punch.id : windup.id,
      placementTic: start,
    });
    await sleep(600);
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(700);
  }
  await sleep(4500);

  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
  const resolved = events.find((e) => e.type === 'interrupt_resolved');
  // Whether the wind-up actually came out. An Interrupted move is deleted in
  // Startup, so it never reaches its reveal Tic — the absence of a `reveal`
  // for it is the outcome, read from the stored round rather than from live
  // state (which the next round has already cleared by the time we look).
  const revealed = events.some(
    (e) => e.type === 'reveal' && (e.payload?.moveName ?? '').startsWith('Slow Windup')
  );
  return { events, payload: resolved?.payload ?? null, revealed };
};

const show = (r) => JSON.stringify(r.payload && {
  interrupted: r.payload.interrupted,
  result: r.payload.result,
  steps: r.payload.halfDamageSteps,
  interrupter: r.payload.interrupter,
  hardToInterrupt: r.payload.hardToInterrupt,
  effectiveResult: r.payload.effectiveResult,
  threshold: r.payload.threshold,
});

// ============================ 1. Hard to Interrupt turns a certainty into a hold
console.log('\n--- a wind-up that would certainly be Interrupted ---');
const a = await fight('A', { windupModifier: 20 });
console.log('  interrupt_resolved:', show(a));
check('the check ran at all', a.payload != null, a.events.map((e) => e.type).join(', '));
check('the bare wind-up is Interrupted', a.payload?.interrupted === true, show(a));
check('...and it never comes out — no reveal for it this round', a.revealed === false, JSON.stringify(a.revealed));
check('an untagged exchange reports both amounts as 0',
  a.payload?.interrupter === 0 && a.payload?.hardToInterrupt === 0, show(a));

console.log('\n--- the same wind-up carrying Hard to Interrupt (99) ---');
const b = await fight('B', { windupModifier: 20, windupTags: [HARD.id] });
console.log('  interrupt_resolved:', show(b));
check('the Tag is read off the name as 99', b.payload?.hardToInterrupt === 99, show(b));
check('the roll itself is untouched — only the bar moved',
  b.payload?.effectiveResult === b.payload?.result, show(b));
check('the bar is the damage plus the Tag',
  b.payload?.threshold === (b.payload?.halfDamageSteps ?? 0) + 99, show(b));
check('the wind-up holds together (the Tag overturned the outcome)',
  b.payload?.interrupted === false, show(b));
check('...and the move goes on to reveal as declared', b.revealed === true, JSON.stringify(b.revealed));

// ============================ 2. Interrupter turns an impossibility into a hit
console.log('\n--- a wind-up that could never be Interrupted ---');
const c = await fight('C', { windupModifier: -20 });
console.log('  interrupt_resolved:', show(c));
check('the bare wind-up survives', c.payload?.interrupted === false, show(c));
check('...and comes out as declared', c.revealed === true, JSON.stringify(c.revealed));

console.log('\n--- the same wind-up, punched by a move with Interrupter (99) ---');
const d = await fight('D', { windupModifier: -20, punchTags: [INTERRUPTER.id] });
console.log('  interrupt_resolved:', show(d));
check('the Tag is read off the attacking move', d.payload?.interrupter === 99, show(d));
check('it is added to the roll, not to the bar',
  d.payload?.effectiveResult === (d.payload?.result ?? 0) + 99 &&
    d.payload?.threshold === d.payload?.halfDamageSteps, show(d));
check('the wind-up comes apart (the Tag overturned the outcome)',
  d.payload?.interrupted === true, show(d));
check('...and never comes out', d.revealed === false, JSON.stringify(d.revealed));

// The whole point of "only for that comparison": neither Tag may touch the
// real attack. The punch's own roll event is the witness.
const punchRoll = (r) => r.events.find((e) => e.type === 'roll' && /Punch/.test(e.payload?.moveName ?? ''));
const modOf = (r) => punchRoll(r)?.payload?.modifier;
console.log(`  punch modifier — untagged ${modOf(c)}, Interrupter (99) ${modOf(d)}`);
check("Interrupter does not touch the attack's own roll", modOf(c) === modOf(d),
  JSON.stringify({ untagged: modOf(c), tagged: modOf(d) }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

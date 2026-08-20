// Playtest: the GM adjudicates a Block, and damage aimed at a broken Stat is
// reported instead of vanishing.
//
// Two rules land together here because they meet in the same code path — the
// defence branch of resolveAttack — and the only honest way to know they
// compose is to run a real round through a real server.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-block-adjudication.mjs
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

const gm = await new Promise((res) => {
  const sock = io(BASE);
  sock.blockPrompts = [];
  sock.dodgePrompts = [];
  sock.on('combat:block_prompt', (p) => sock.blockPrompts.push(p));
  sock.on('combat:dodge_prompt', (p) => sock.dodgePrompts.push(p));
  sock.on('connect', () => res(sock));
});
const wait = (ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: 'Guard up' });
const tell = await wait('tell:created');
const stamp = Date.now();

const mk = async (name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: [], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// A big, reliable attack (rollModifier 30 so it always clears the threshold),
// and a guard whose Defense Frames sit on its own Active frame and cover the
// attack's whole Active window — 'full' coverage, which is what reaches a GM.
const punch = await mk('Straight', { activeTics: 2, attackTargets: ['Skull'], rollModifier: 30 });
const guard = await mk('Front Guard', {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  rollSlots: ['Body'], isDefensive: true, defenseKind: 'block', defenseFramePositions: [1, 2],
});

const striker = await jpost('/api/characters', { name: `Str${stamp}`, characterType: 'npc' });
const holder = await jpost('/api/characters', { name: `Hld${stamp}`, characterType: 'npc' });

gm.emit('combat:add_participant', { characterId: striker.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === striker.id));
gm.emit('combat:add_participant', { characterId: holder.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === holder.id));

const statusOf = async () => (await jf('/api/combat?role=gm')).pairs[0]?.resolutionStatus;
const diceOf = async (id) => (await jf(`/api/characters/${id}`)).dice;
const sig = (dice, slot) => {
  const d = dice.find((x) => x.slot_name === slot);
  return d ? `d${d.current_size}+${d.bonus}/${d.status}${d.half_damage ? '/half' : ''}` : null;
};
const chat = async () => (await jf('/api/chat')) ?? [];

// Opens a round and declares the two moves. `defenderMove` null means the
// defender declares nothing at all.
async function playRound({ defenderMove = guard } = {}) {
  const st = await jf('/api/combat?role=gm');
  if (st.pairs[0]?.phase !== 'declaration') {
    gm.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  }
  const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const now = await jf('/api/combat?role=gm');
    const side = now.pairs[0].declaringSide;
    if (!side) break;
    const who = side === 'left' ? striker : holder;
    const move = who.id === striker.id ? punch : defenderMove;
    if (move) {
      gm.emit('move:declare', { characterId: who.id, moveId: move.id, placementTic: start });
      await sleep(400);
    }
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(600);
  }
  await sleep(3000);
}

// ---------------------------------------------------------------------------
console.log('\n— Round 1: the Block asks, and Failed discards the guard —');
// ---------------------------------------------------------------------------
await playRound();
check('a Block pauses the round for the GM', (await statusOf()) === 'paused_defense', await statusOf());
check('the GM receives combat:block_prompt', gm.blockPrompts.length === 1, JSON.stringify(gm.blockPrompts));
const prompt = gm.blockPrompts.at(-1);
check('...naming both fighters and the attack roll',
  prompt?.defenderCharacterName === holder.name && Number.isFinite(prompt?.attackerResult),
  JSON.stringify(prompt));
check('...and reporting its coverage', prompt?.coverage === 'full', String(prompt?.coverage));
check('the pause is visible in the combat snapshot too (reconnect recovery)',
  (await jf('/api/combat?role=gm')).pairs[0]?.pendingDefense != null);

const beforeFail = await diceOf(holder.id);
check('nothing is damaged while the question stands',
  sig(beforeFail, 'Skull') === 'd4+0/active', sig(beforeFail, 'Skull'));

gm.emit('combat:resolve_block', { pairIndex: 0, outcome: 'failed' });
await sleep(4000);
check('the round runs on once the GM calls it', (await statusOf()) !== 'paused_defense', await statusOf());

const afterFail = await diceOf(holder.id);
console.log(`  Skull ${sig(beforeFail, 'Skull')} -> ${sig(afterFail, 'Skull')}`);
console.log(`  Body  ${sig(beforeFail, 'Body')} -> ${sig(afterFail, 'Body')}`);
check('a discarded guard lets the attack land on the Stat it NAMED',
  sig(afterFail, 'Skull') !== sig(beforeFail, 'Skull'),
  `${sig(beforeFail, 'Skull')} -> ${sig(afterFail, 'Skull')}`);
check("...and not on the guard's own Stat — that redirect is the Successful Block rule",
  sig(afterFail, 'Body') === sig(beforeFail, 'Body'),
  `${sig(beforeFail, 'Body')} -> ${sig(afterFail, 'Body')}`);
const failLog = await chat();
check('the failure is announced',
  failLog.some((m) => /Block has failed/.test(m.message ?? '')),
  failLog.slice(-4).map((m) => m.message).join(' | '));
// The guard carries a Roll of its own, so it still rolls as a counter-attack —
// what must NOT happen is the guard being *resolved* as a guard. The
// Full/Partial line is the observable proof either way.
check('a discarded guard is never resolved as a Block',
  !failLog.some((m) => /(Full|Partial) Block/.test(m.message ?? '')),
  failLog.filter((m) => /Block/.test(m.message ?? '')).map((m) => m.message).join(' | '));

// ---------------------------------------------------------------------------
console.log('\n— Round 2: Successful runs the guard math as before —');
// ---------------------------------------------------------------------------
const promptsBefore = gm.blockPrompts.length;
await playRound();
check('the second round asks again', gm.blockPrompts.length === promptsBefore + 1,
  `${promptsBefore} -> ${gm.blockPrompts.length}`);
const beforeOk = await diceOf(holder.id);
gm.emit('combat:resolve_block', { pairIndex: 0, outcome: 'successful' });
await sleep(4000);
const okLog = await chat();
check('a confirmed Block rolls its guard',
  okLog.some((m) => m.kind === 'roll' && m.characterName === holder.name),
  okLog.filter((m) => m.kind === 'roll').map((m) => m.characterName).join(','));
check('...and reports a Full or Partial Block',
  okLog.some((m) => /(Full|Partial) Block/.test(m.message ?? '')),
  okLog.slice(-6).map((m) => m.message).join(' | '));
const afterOk = await diceOf(holder.id);
console.log(`  Skull ${sig(beforeOk, 'Skull')} -> ${sig(afterOk, 'Skull')}`);
console.log(`  Body  ${sig(beforeOk, 'Body')} -> ${sig(afterOk, 'Body')}`);
check('whatever got past the guard lands on the Stat the blocker rolled, not the Skull',
  sig(afterOk, 'Skull') === sig(beforeOk, 'Skull'),
  `${sig(beforeOk, 'Skull')} -> ${sig(afterOk, 'Skull')}`);

// ---------------------------------------------------------------------------
console.log('\n— Round 3: an attack on a broken Stat is reported, not swallowed —');
// ---------------------------------------------------------------------------
// Break the Skull outright. Under the old rule this made the attack find no
// eligible target at all: it bailed before defence resolution, applied nothing,
// and said nothing.
const skullDie = (await diceOf(holder.id)).find((d) => d.slot_name === 'Skull');
// Stepped down by hand rather than set: die:step is the only way the app itself
// can break a Stat, so this is the state a real fight actually produces.
for (let i = 0; i < 6; i++) {
  const d = (await diceOf(holder.id)).find((x) => x.slot_name === 'Skull');
  if (d.status === 'incapacitated') break;
  gm.emit('die:step', { dieId: skullDie.id, direction: 'down' });
  await sleep(350);
}
const broken = (await diceOf(holder.id)).find((d) => d.slot_name === 'Skull');
check('the Skull is broken going in', broken.status === 'incapacitated', broken.status);

const chatBefore = (await chat()).length;
await playRound({ defenderMove: null }); // no guard — a plain Hit onto a broken Stat
await sleep(2500);

const afterBroken = (await diceOf(holder.id)).find((d) => d.slot_name === 'Skull');
check('the broken Stat is not stepped further', afterBroken.current_size === 4 && afterBroken.half_damage === 0,
  `d${afterBroken.current_size}/half=${afterBroken.half_damage}`);
const newLines = (await chat()).slice(chatBefore).map((m) => m.message ?? '');
const report = newLines.find((m) => /should have been dealt/.test(m));
check('the round reports what could not be applied', Boolean(report), newLines.join(' | '));
if (report) console.log(`  ${report}`);
check('...naming the Stat and pointing at Injuries',
  /Skull, but it cannot be applied\. Take this into consideration for Injuries\.$/.test(report ?? ''),
  report ?? '');
check('...exactly once, totalled rather than one line per blow',
  newLines.filter((m) => /should have been dealt/.test(m)).length === 1,
  String(newLines.filter((m) => /should have been dealt/.test(m)).length));
check('the old silent bail-out is gone',
  !newLines.some((m) => /nothing left to hit/i.test(m)),
  newLines.join(' | '));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

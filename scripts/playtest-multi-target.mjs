// Playtest: a move naming several Attack Target Stats damages EVERY one of
// them, and a Dodge against it is called Stat by Stat.
//
// The rule this replaces: the engine used to pick the first eligible Stat off
// the list and drop the rest, so "Attack Target: Skull, Body" hit exactly as
// hard as "Attack Target: Skull" and the second Stat was decoration.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-multi-target.mjs
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

const connect = () =>
  new Promise((res) => {
    const sock = io(BASE);
    sock.latest = null;
    sock.on('combat:updated', (c) => { sock.latest = c; });
    sock.on('connect', () => res(sock));
  });
const gm = await connect();
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: 'Both hands high' });
const tell = await wait(gm, 'tell:created');
const stamp = Date.now();

// One move, two named Stats. Big modifier so it always lands hard enough to
// matter — this playtest is about WHERE the damage goes, not whether it lands.
gm.emit('move:create', {
  name: `Double Strike ${stamp}`, isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 1, recoveryTics: 1,
  description: 'hits two places at once', interactions: {}, rollSlots: ['Skull'],
  attackTargets: ['Skull', 'Body'], staminaCost: 0, rollModifier: 30,
});
const move = await wait(gm, 'move:created', (m) => m.name === `Double Strike ${stamp}`);

const attacker = await jpost('/api/characters', { name: `Att${stamp}`, characterType: 'npc' });
const victim = await jpost('/api/characters', { name: `Vic${stamp}`, characterType: 'npc' });

const diceOf = async (id) => (await jf(`/api/characters/${id}`)).dice;
const before = await diceOf(victim.id);
// **The whole die, not just its size.** A Stat already at the bottom of the
// ladder takes its half-damage as the `half_damage` flag rather than as a
// smaller die, so comparing sizes alone reports "nothing happened" for exactly
// the case this playtest is most likely to hit on a fresh character.
const sizeOf = (dice, slot) => {
  const d = dice.find((x) => x.slot_name === slot);
  return d ? `d${d.current_size}+${d.bonus}/${d.status}${d.half_damage ? '/half' : ''}` : null;
};

gm.emit('combat:add_participant', { characterId: attacker.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === attacker.id));
gm.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const st0 = await jf('/api/combat?role=gm');
const start = st0.pairs[0].roundStartTic ?? 0;
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? attacker : victim;
  if (who.id === attacker.id) {
    gm.emit('move:declare', { characterId: attacker.id, moveId: move.id, placementTic: start });
    await sleep(500);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(700);
}
await sleep(4000);

const after = await diceOf(victim.id);
const skullBefore = sizeOf(before, 'Skull');
const skullAfter = sizeOf(after, 'Skull');
const bodyBefore = sizeOf(before, 'Body');
const bodyAfter = sizeOf(after, 'Body');
console.log(`  Skull ${skullBefore} -> ${skullAfter}, Body ${bodyBefore} -> ${bodyAfter}`);

check('the first named Stat took damage', skullAfter !== skullBefore, `${skullBefore} -> ${skullAfter}`);
check('the SECOND named Stat took damage too (the whole point)',
  bodyAfter !== bodyBefore, `${bodyBefore} -> ${bodyAfter}`);

const untouched = after.find((d) => !['Skull', 'Body'].includes(d.slot_name));
const untouchedBefore = before.find((d) => d.slot_name === untouched?.slot_name);
check('a Stat the move did NOT name is left alone',
  untouched && sizeOf(after, untouched.slot_name) === sizeOf(before, untouched.slot_name),
  `${untouched?.slot_name}: ${sizeOf(before, untouched?.slot_name)} -> ${sizeOf(after, untouched?.slot_name)}`);

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
const damage = events.filter((e) => e.type === 'damage_applied');
console.log('  damage events:', JSON.stringify(damage.map((e) => e.payload.slotName)));
check('one damage_applied event per Stat, so the cutscene animates both',
  damage.length >= 2 && damage.some((e) => e.payload.slotName === 'Skull') &&
    damage.some((e) => e.payload.slotName === 'Body'),
  JSON.stringify(damage.map((e) => e.payload.slotName)));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

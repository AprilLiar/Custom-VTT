// Playtest: a Dodge against a move that names several Attack Target Stats is
// called Stat by Stat — one prompt per Stat, each answerable on its own.
//
// The rule this replaces: one prompt settled the whole attack, so a two-Stat
// attack was fully evaded by one "Successful" and the second Stat came free.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-multi-target-dodge.mjs
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

// **The prompt is read off the combat snapshot, not off a one-shot push
// (reworked).** `combat:block_prompt` / `combat:dodge_prompt` used to be
// separate GM-only events; they are gone, because a one-shot event only ever
// reaches the sockets connected at that instant and a paused pair sends nothing
// afterwards — which is how a GM who locked their phone came back to a fight
// nobody could advance. Every pending question now rides the ordinary snapshot,
// so this collects them from there and asserts exactly what it always did.
function collectPrompts(sock) {
  sock.prompts = [];
  const seen = new Set();
  sock.on('combat:updated', (c) => {
    for (const pair of c?.pairs ?? []) {
      const p = pair.pendingDodge ?? pair.pendingDefense;
      if (!p) continue;
      const key = `${pair.pairIndex}:${p.defenseKind}:${p.attackerDeclaredMoveId}:${p.targetSlotName ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sock.prompts.push({ ...p, pairIndex: pair.pairIndex });
    }
  });
}

const gm = await new Promise((res) => {
  const sock = io(BASE);
  collectPrompts(sock);
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
gm.emit('tell:create', { name: 'Two lines at once' });
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

const strike = await mk('Twin Strike', { attackTargets: ['Skull', 'Body'], rollModifier: 30 });
// Defense Frames on the attack's Active Tic, so coverage classifies as 'full'
// and the engine actually pauses to ask.
const slip = await mk('Slip', {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  rollSlots: ['Body'], isDefensive: true, defenseKind: 'dodge', defenseFramePositions: [1, 2],
});

const striker = await jpost('/api/characters', { name: `Str${stamp}`, characterType: 'npc' });
const ghost = await jpost('/api/characters', { name: `Gho${stamp}`, characterType: 'npc' });

gm.emit('combat:add_participant', { characterId: striker.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === striker.id));
gm.emit('combat:add_participant', { characterId: ghost.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === ghost.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const st0 = await jf('/api/combat?role=gm');
const start = st0.pairs[0].roundStartTic ?? 0;
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? striker : ghost;
  gm.emit('move:declare', {
    characterId: who.id,
    moveId: who.id === striker.id ? strike.id : slip.id,
    placementTic: start,
  });
  await sleep(500);
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(700);
}
await sleep(3000);

const paused = async () => (await jf('/api/combat?role=gm')).pairs[0]?.resolutionStatus;
check('the Dodge pauses the round', (await paused()) === 'paused_dodge', await paused());
check('the first prompt names a Stat', gm.prompts.at(-1)?.targetSlotName != null,
  JSON.stringify(gm.prompts.at(-1)));
const firstStat = gm.prompts.at(-1)?.targetSlotName;
check('...and says how many lines are still to come',
  (gm.prompts.at(-1)?.remainingStats ?? []).length === 2,
  JSON.stringify(gm.prompts.at(-1)?.remainingStats));

// Dodge the first line, eat the second.
gm.emit('combat:resolve_dodge', { pairIndex: 0, outcome: 'successful' });
await sleep(1500);
check('answering ONE line re-pauses on the next, rather than settling the attack',
  (await paused()) === 'paused_dodge', await paused());
const second = gm.prompts.at(-1);
check('the second prompt is about the OTHER Stat',
  second?.targetSlotName != null && second.targetSlotName !== firstStat,
  JSON.stringify({ first: firstStat, second: second?.targetSlotName }));

const before = (await jf(`/api/characters/${ghost.id}`)).dice;
gm.emit('combat:resolve_dodge', { pairIndex: 0, outcome: 'failed' });
await sleep(4000);
check('the round runs on once every line is called', (await paused()) !== 'paused_dodge', await paused());

const after = (await jf(`/api/characters/${ghost.id}`)).dice;
const sig = (dice, slot) => {
  const d = dice.find((x) => x.slot_name === slot);
  return d ? `d${d.current_size}+${d.bonus}/${d.status}${d.half_damage ? '/half' : ''}` : null;
};
console.log(`  ${firstStat} ${sig(before, firstStat)} -> ${sig(after, firstStat)}`);
console.log(`  ${second?.targetSlotName} ${sig(before, second?.targetSlotName)} -> ${sig(after, second?.targetSlotName)}`);
check('the dodged Stat took nothing', sig(after, firstStat) === sig(before, firstStat),
  `${sig(before, firstStat)} -> ${sig(after, firstStat)}`);
check('the Stat the dodge missed took the hit',
  sig(after, second?.targetSlotName) !== sig(before, second?.targetSlotName),
  `${sig(before, second?.targetSlotName)} -> ${sig(after, second?.targetSlotName)}`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

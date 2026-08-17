// Playtest driver for Dodge being BINARY, through the real socket path the
// GM's dialogue uses (combat:resolve_dodge), not the engine function directly.
//
// The fixture is the exact shape the bug had: a +20 attack against an ordinary
// dodge. Under the old opposed math that guaranteed a "Partial Dodge" — damage
// through to the dodger's own Stat, and the attacker's **On Block** trigger
// firing on what the GM had just called a successful evasion.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-dodge-binary.mjs
//
// Companion to scripts/playtest-dodge.mjs, which is a *browser* test for the
// prompt reaching the GM off-Arena. This one is a socket test about the
// outcome math, so the two do not overlap.
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
await new Promise((res) => gm.on('connect', res));
const wait = (ev, pred = () => true, ms = 10000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(500);
gm.emit('tell:create', { name: 'Weight shifts back' });
const tell = await wait('tell:created');
const stamp = Date.now();

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// A huge attack: under the old rules this could not fail to out-roll the
// dodge, which is what produced a Partial every time.
const haymaker = await mk('Haymaker', {
  rollModifier: 20,
  interactions: {
    hit: { text: 'landed', automations: [] },
    block: { text: 'guarded', automations: [{ type: 'opponent_stamina_loss', amount: 1 }] },
    miss: { text: 'whiffed', automations: [{ type: 'self_stamina_loss', amount: 1 }] },
  },
});
// 1/2/1 with Defense Frames on the ACTIVE squares only — sanitizeDefensePositions
// drops anything else, which is what made an earlier probe's dodge never engage.
const slip = await mk('Slip', {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  isDefensive: true, defenseKind: 'dodge',
  defenseFramePositions: [1, 2],
  attackTargets: [],
  interactions: { defense_success: { text: 'slipped it', automations: [] } },
});

const attacker = await jpost('/api/characters', { name: `At${stamp}`, characterType: 'npc' });
const defender = await jpost('/api/characters', { name: `De${stamp}`, characterType: 'npc' });
gm.emit('combat:add_participant', { characterId: attacker.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === attacker.id));
gm.emit('combat:add_participant', { characterId: defender.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === defender.id));

const diceOf = async (id) => (await jf(`/api/characters/${id}`)).dice;
const before = await diceOf(defender.id);

gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

// Both fighters declare onto the same Tic so the guard covers the attack.
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? attacker : defender;
  const moveId = who.id === attacker.id ? haymaker.id : slip.id;
  gm.emit('move:declare', { characterId: who.id, moveId, placementTic: st.pairs[0].roundStartTic ?? 0 });
  await sleep(500);
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(600);
}
await sleep(2500);

const paused = await jf('/api/combat?role=gm');
check('the round pauses for the GM to judge the Dodge',
  paused.pairs[0]?.resolutionStatus === 'paused_dodge', paused.pairs[0]?.resolutionStatus);

// THE call, through the socket the dialogue actually uses.
gm.emit('combat:resolve_dodge', { pairIndex: 0, outcome: 'successful' });
await sleep(3000);

const after = await jf('/api/combat?role=gm');
check('the round finishes after the call',
  after.pairs[0]?.resolutionStatus !== 'paused_dodge', after.pairs[0]?.resolutionStatus);

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
console.log('  events:', events.map((e) => e.type).join(', '));

// 1. No damage, at all.
check('a successful Dodge applies NO damage',
  !events.some((e) => e.type === 'damage_applied'),
  JSON.stringify(events.filter((e) => e.type === 'damage_applied').map((e) => e.payload)));

// 2. The dodger's own dice are untouched — the old Partial path shaved them.
const afterDice = await diceOf(defender.id);
const shrunk = afterDice.filter((d) => {
  const was = before.find((b) => b.slot_name === d.slot_name);
  return was && (d.current_size !== was.current_size || d.half_damage !== was.half_damage);
});
check('the dodger\'s own dice are untouched', shrunk.length === 0, JSON.stringify(shrunk));

// 3. On Miss fires; On Block must not.
const fired = events.filter((e) => e.type === 'automation_fired').map((e) => e.payload?.trigger);
console.log('  triggers fired:', JSON.stringify(fired));
check('the attacker fires On Miss', fired.includes('miss'), JSON.stringify(fired));
check('the attacker does NOT fire On Block — this was the reported bug',
  !fired.includes('block'), JSON.stringify(fired));
check('and does not fire On Hit either', !fired.includes('hit'), JSON.stringify(fired));
check('the dodger fires On Successful Defense', fired.includes('defense_success'), JSON.stringify(fired));

// 4. The words "Partial Dodge" must not exist anywhere any more.
const blob = JSON.stringify(chat) + JSON.stringify(events);
check('nothing anywhere says "Partial Dodge"', !/Partial Dodge/i.test(blob));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

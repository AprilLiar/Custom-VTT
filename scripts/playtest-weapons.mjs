// Playtest: the Weapon system, end to end against a real server.
//
// Four rules were decided here and none of them can be pinned by a unit test,
// because every one of them is about state moving between the weapons table,
// the declaration gate and the resolution engine:
//
//   1. Using a weapon in a Move costs 1 Durability. Rolling it on its own
//      costs nothing.
//   2. A Move whose Roll names the Weapon cannot be declared with empty hands.
//   3. A Move whose Attack Target is the Weapon is settled by a roll-off
//      against the weapon's own die — beat it and it is destroyed, tie and it
//      holds, and when it holds against a move that was aimed at nothing else,
//      nothing lands.
//   4. The same move against an unarmed fighter falls on a random Hand.
//
//   TURSO_DATABASE_URL="file:/tmp/weapons.db" PORT=3111 node server/index.js &
//   E2E_URL=http://localhost:3111 node scripts/playtest-weapons.mjs
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

const connect = () => new Promise((res) => {
  const sock = io(BASE);
  sock.on('connect', () => res(sock));
});
const waitOn = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

const gm = await connect();
gm.emit('identity:set', { role: 'gm' });
const wait = (ev, pred, ms) => waitOn(gm, ev, pred, ms);

gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: 'Blade up' });
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

// Rolls the Weapon — the whole point of rule 1 and rule 2.
const swing = await mk('Sword Swing', { rollSlots: ['Weapon'], attackTargets: ['Skull'], rollModifier: 30 });
// Rolls a Stat and goes for what they are holding — rules 3 and 4.
const disarm = await mk('Disarm', { rollSlots: ['Skull'], attackTargets: ['Weapon'], rollModifier: 30 });
// A plain move, so the other side always has something legal to declare.
const jab = await mk('Jab', { rollSlots: ['Skull'], attackTargets: ['Body'] });

const striker = await jpost('/api/characters', { name: `Str${stamp}`, characterType: 'npc' });
const holder = await jpost('/api/characters', { name: `Hld${stamp}`, characterType: 'npc' });

gm.emit('combat:add_participant', { characterId: striker.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === striker.id));
gm.emit('combat:add_participant', { characterId: holder.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === holder.id));

const snapshot = () => jf('/api/combat?role=gm');
const sheet = (id) => jf(`/api/characters/${id}`);
const weaponOf = async (id) => (await sheet(id)).weapon;
const diceOf = async (id) => (await sheet(id)).dice;
const arm = async (characterId, weapon) => {
  const seen = waitOn(gm, 'weapon:updated', (p) => p.characterId === characterId);
  gm.emit('weapon:create', { characterId, ...weapon });
  return seen;
};
const chatTail = async (n = 8) =>
  (await jf('/api/chat')).slice(-n).map((m) => m.message ?? '').filter(Boolean);

// Runs one round: `plan` says which move (if any) each fighter declares.
async function runRound(plan) {
  const st = await snapshot();
  if (st.pairs[0]?.phase !== 'declaration') {
    gm.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  }
  const start = (await snapshot()).pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const now = await snapshot();
    const side = now.pairs[0].declaringSide;
    if (!side) break;
    const who = side === 'left' ? striker : holder;
    const moveId = plan[who.id];
    if (moveId != null) {
      gm.emit('move:declare', { characterId: who.id, moveId, placementTic: start });
      await sleep(400);
    }
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(600);
  }
  await sleep(3500);
}

// ---------------------------------------------------------------------------
console.log('\n— Everyone starts with empty hands —');
// ---------------------------------------------------------------------------
check('a fresh character carries nothing', (await weaponOf(striker.id)) == null);
const combatBefore = await snapshot();
check('...and the combat snapshot says so too',
  combatBefore.characters[striker.id]?.weapon === null,
  JSON.stringify(combatBefore.characters[striker.id]?.weapon));

// ---------------------------------------------------------------------------
console.log('\n— A Move that rolls the Weapon is refused to empty hands —');
// ---------------------------------------------------------------------------
{
  const st = await snapshot();
  if (st.pairs[0]?.phase !== 'declaration') {
    gm.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  }
  const now = await snapshot();
  const start = now.pairs[0].roundStartTic ?? 0;
  const first = now.pairs[0].declaringSide === 'left' ? striker : holder;
  // Whoever has the floor tries the swing bare-handed. Nothing should stick.
  gm.emit('move:declare', { characterId: first.id, moveId: swing.id, placementTic: start });
  await sleep(900);
  const after = await snapshot();
  check('the unarmed swing never lands on the board',
    !after.declaredMoves.some((dm) => dm.characterId === first.id),
    JSON.stringify(after.declaredMoves));
}

// ---------------------------------------------------------------------------
console.log('\n— Taking one up —');
// ---------------------------------------------------------------------------
const taken = await arm(striker.id, { name: 'Machete', dieSize: 8, bonus: 2, durability: 3 });
check('the weapon comes back on its own event', taken?.weapon?.name === 'Machete', JSON.stringify(taken));
const onSheet = await weaponOf(striker.id);
check('...and is on the sheet, die, modifier and Durability',
  onSheet?.die_size === 8 && onSheet?.bonus === 2 && onSheet?.durability === 3,
  JSON.stringify(onSheet));
check('the Arena sees it too, so the picker can open up',
  (await snapshot()).characters[striker.id]?.weapon?.name === 'Machete');

// ---------------------------------------------------------------------------
console.log('\n— Rolling it on its own costs nothing —');
// ---------------------------------------------------------------------------
gm.emit('weapon:roll', { characterId: striker.id, modifier: 0 });
await sleep(700);
check('a bare roll leaves Durability where it was', (await weaponOf(striker.id))?.durability === 3);
const rolled = (await jf('/api/chat')).slice(-1)[0];
check('...and it still shows up as a roll, named as the Weapon',
  JSON.stringify(rolled).includes('Weapon'), JSON.stringify(rolled));

// ---------------------------------------------------------------------------
console.log('\n— Using it in a Move costs exactly 1 —');
// ---------------------------------------------------------------------------
await runRound({ [striker.id]: swing.id, [holder.id]: jab.id });
check('the swing spent one Durability', (await weaponOf(striker.id))?.durability === 2,
  JSON.stringify(await weaponOf(striker.id)));
check('...and the table was told',
  (await chatTail(20)).some((line) => /Machete is down to 2 Durability/.test(line)),
  JSON.stringify(await chatTail(6)));

// ---------------------------------------------------------------------------
console.log('\n— Going for the weapon: it holds —');
// ---------------------------------------------------------------------------
// A d12+40 is not a weapon anybody would author; it is here to make the
// roll-off come out one way on purpose. The attacker's +30 loses to it.
await arm(holder.id, { name: 'Anvil', dieSize: 12, bonus: 40, durability: 5 });
const skullBefore = (await diceOf(holder.id)).find((d) => d.slot_name === 'Skull');
await runRound({ [striker.id]: disarm.id, [holder.id]: jab.id });
check('the weapon survives a roll it beat', (await weaponOf(holder.id))?.name === 'Anvil',
  JSON.stringify(await weaponOf(holder.id)));
const skullAfter = (await diceOf(holder.id)).find((d) => d.slot_name === 'Skull');
check('...and nothing lands, because the weapon was all it was aimed at',
  skullAfter.current_size === skullBefore.current_size && skullAfter.bonus === skullBefore.bonus,
  `${skullBefore.current_size}+${skullBefore.bonus} -> ${skullAfter.current_size}+${skullAfter.bonus}`);
check('...said out loud in chat',
  (await chatTail(20)).some((line) => /Anvil .*holds/.test(line)),
  JSON.stringify(await chatTail(6)));

// ---------------------------------------------------------------------------
console.log('\n— Going for the weapon: it breaks —');
// ---------------------------------------------------------------------------
await arm(holder.id, { name: 'Twig', dieSize: 4, bonus: 0, durability: 5 });
await runRound({ [striker.id]: disarm.id, [holder.id]: jab.id });
check('a roll that beats the weapon destroys it', (await weaponOf(holder.id)) == null,
  JSON.stringify(await weaponOf(holder.id)));
check('...and the fight is told which one went',
  (await chatTail(20)).some((line) => /breaks .*Twig/.test(line)),
  JSON.stringify(await chatTail(6)));

// ---------------------------------------------------------------------------
console.log('\n— Going for a weapon that is not there —');
// ---------------------------------------------------------------------------
const handsBefore = (await diceOf(holder.id)).filter((d) => d.slot_name.endsWith('Hand'));
await runRound({ [striker.id]: disarm.id, [holder.id]: jab.id });
const handsAfter = (await diceOf(holder.id)).filter((d) => d.slot_name.endsWith('Hand'));
// `status` is in the comparison deliberately: a Hand already at d4 has no
// size left to lose, so the whole of a blow on one shows up as the die going
// out rather than as a smaller number.
const stepped = handsAfter.filter((h) => {
  const was = handsBefore.find((b) => b.slot_name === h.slot_name);
  return (
    h.current_size !== was.current_size ||
    h.bonus !== was.bonus ||
    h.status !== was.status ||
    Boolean(h.half_damage) !== Boolean(was.half_damage)
  );
});
check('it falls on exactly one Hand instead', stepped.length === 1,
  JSON.stringify(handsAfter.map((h) => `${h.slot_name} d${h.current_size}+${h.bonus} ${h.status} half=${h.half_damage}`)));
check('...and the swap is announced rather than silently swallowed',
  (await chatTail(20)).some((line) => /not holding/.test(line)),
  JSON.stringify(await chatTail(6)));

// ---------------------------------------------------------------------------
console.log('\n— Putting it down —');
// ---------------------------------------------------------------------------
gm.emit('weapon:delete', { characterId: striker.id });
await sleep(600);
check('the slot is empty again', (await weaponOf(striker.id)) == null);
check('...and the Arena agrees, so the picker closes back up',
  (await snapshot()).characters[striker.id]?.weapon === null);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

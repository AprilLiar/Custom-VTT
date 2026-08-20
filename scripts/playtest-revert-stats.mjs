// Playtest: "Revert stats to base" has to heal a pending HALF step too.
//
// Half damage is not a size — it is half a step already taken, waiting for its
// other half (applyHalfDamage in gameLogic.js). Reverting wrote size, bonus and
// status back to the locked baseline and left the flag standing, so a Stat put
// back to base still took its next hit as though it were already half gone.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-revert-stats.mjs
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
gm.emit('identity:set', { role: 'gm' });
await sleep(400);

const stamp = Date.now();
const char = await jpost('/api/characters', { name: `Rev${stamp}` });
const diceOf = async () => (await jf(`/api/characters/${char.id}`)).dice;
const body = (dice) => dice.find((d) => d.slot_name === 'Body');

// Step Body up twice so reverting has somewhere to come back FROM, then lock
// that as the baseline.
gm.emit('die:step', { dieId: body(await diceOf()).id, direction: 'up' });
await sleep(300);
gm.emit('die:step', { dieId: body(await diceOf()).id, direction: 'up' });
await sleep(300);
gm.emit('character:lock_stats', { characterId: char.id });
await sleep(400);
const locked = body(await diceOf());
console.log(`  base after lock: d${locked.current_size}+${locked.bonus} (locked d${locked.locked_size})`);

// Now take a single half-step of damage and a full step, so the die is BOTH
// smaller and carrying a pending half.
gm.emit('die:step', { dieId: locked.id, direction: 'down' });
await sleep(300);
gm.emit('die:toggle_half_damage', { dieId: locked.id });
await sleep(400);
const hurt = body(await diceOf());
console.log(`  hurt: d${hurt.current_size}+${hurt.bonus}${hurt.half_damage ? ' /half' : ''}`);
check('the fixture really is carrying a pending half step', Boolean(hurt.half_damage),
  JSON.stringify({ half_damage: hurt.half_damage }));
check('...and is genuinely below its base', hurt.current_size < locked.current_size,
  `${hurt.current_size} vs base ${locked.current_size}`);

gm.emit('character:revert_stats', { characterId: char.id });
await sleep(700);
const back = body(await diceOf());
console.log(`  reverted: d${back.current_size}+${back.bonus}${back.half_damage ? ' /half' : ''}`);

check('the size came back to base', back.current_size === locked.locked_size,
  `${back.current_size} vs locked ${locked.locked_size}`);
check('the pending half step is healed too (the reported bug)', !back.half_damage,
  JSON.stringify({ half_damage: back.half_damage }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

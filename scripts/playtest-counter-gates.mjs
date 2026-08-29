// Playtest: Gates on Counters.
//
// Three things can only be checked against a running server, and all three fail
// silently if they are wrong:
//
//   1. **A secret Gate's words never reach a Player.** Not hidden client-side —
//      absent from the payload. The only way to test that is to ask as somebody
//      who may not read it and look at what actually came back.
//   2. **The Chat Log never leaks one.** Chat is broadcast to the whole table,
//      so it is the one place a secret can escape by accident.
//   3. **Reaching a Gate posts, and only on the way up.** It spans a clamp, a
//      crossing calculation and a chat insert.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3100 node server/index.js
//   E2E_URL=http://localhost:3100 node scripts/playtest-counter-gates.mjs
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

const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  s.gates = [];
  s.on('counter_gates:updated', (p) => s.gates.push(p.gates));
  await sleep(400);
  return s;
};

const stamp = Date.now();
const hero = await jpost('/api/characters', { name: `Gatekeeper${stamp}`, characterType: 'pc' });
const gm = await connect({ role: 'gm' });
const player = await connect({ role: 'player', characterId: hero.id });

gm.emit('counter:create', { characterId: hero.id, name: `Doom${stamp}`, targetPips: 6 });
await sleep(700);
const counter = (await jf(`/api/characters/${hero.id}`)).counters[0];
check('the counter exists to hang Gates on', counter?.target_pips === 6, JSON.stringify(counter));

const gatesFor = (identity) =>
  jf(`/api/counter-gates?${new URLSearchParams(identity)}`).then((d) => d.gates ?? []);

// ============================================ 1. authoring is the GM's
console.log('\n--- who may put a Gate on a pip ---');
player.emit('counter_gate:save', {
  counterId: counter.id, pipIndex: 2, name: 'Player made this', description: 'x', secret: false,
});
await sleep(700);
check('a Player cannot create a Gate', (await gatesFor({ role: 'gm' })).length === 0,
  JSON.stringify(await gatesFor({ role: 'gm' })));

gm.emit('counter_gate:save', {
  counterId: counter.id, pipIndex: 2, name: 'The Warning', description: 'A crow lands.', secret: false,
});
gm.emit('counter_gate:save', {
  counterId: counter.id, pipIndex: 4, name: 'The Betrayal', description: 'Mira turns.', secret: true,
});
await sleep(800);
let asGm = await gatesFor({ role: 'gm' });
check('the GM can, and one Gate per pip', asGm.length === 2, JSON.stringify(asGm));

// A pip outside the counter is refused rather than stored and never drawn.
gm.emit('counter_gate:save', { counterId: counter.id, pipIndex: 0, name: 'Before the start' });
gm.emit('counter_gate:save', { counterId: counter.id, pipIndex: 7, name: 'Past the end' });
gm.emit('counter_gate:save', { counterId: counter.id, pipIndex: 2.5, name: 'Between two' });
await sleep(900);
check('a Gate off the end of the counter is refused',
  (await gatesFor({ role: 'gm' })).length === 2, JSON.stringify(await gatesFor({ role: 'gm' })));

// Saving the same pip again edits rather than duplicating.
gm.emit('counter_gate:save', {
  counterId: counter.id, pipIndex: 2, name: 'The Warning', description: 'Two crows.', secret: false,
});
await sleep(700);
asGm = await gatesFor({ role: 'gm' });
check('saving the same pip edits in place rather than stacking a second Gate',
  asGm.length === 2 && asGm.find((g) => g.pip_index === 2).description === 'Two crows.',
  JSON.stringify(asGm));

// ============================================ 2. what a Player may read
console.log('\n--- what reaches a Player ---');
const asPlayer = await gatesFor({ role: 'player', characterId: hero.id });
const openGate = asPlayer.find((g) => g.pip_index === 2);
const secretGate = asPlayer.find((g) => g.pip_index === 4);

check('a Player is told BOTH Gates exist — that is never the secret',
  asPlayer.length === 2, JSON.stringify(asPlayer));
check('an open Gate reaches them with its words',
  openGate?.name === 'The Warning' && openGate?.description === 'Two crows.', JSON.stringify(openGate));
// The probe that matters most in this file.
check('a secret Gate reaches them with NO name field at all',
  !('name' in secretGate), JSON.stringify(secretGate));
check('...and no description field either',
  !('description' in secretGate), JSON.stringify(secretGate));
check('...but flagged secret, so the client can draw "???" rather than a blank',
  secretGate?.secret === 1, JSON.stringify(secretGate));
check('the whole payload for a Player contains neither secret word',
  !JSON.stringify(asPlayer).includes('Betrayal') && !JSON.stringify(asPlayer).includes('Mira turns'),
  JSON.stringify(asPlayer));
// An unidentified caller gets the closed answer, not the open one.
const anon = await gatesFor({});
check('an unidentified caller is treated as a Player, not as a GM',
  !('name' in anon.find((g) => g.pip_index === 4)), JSON.stringify(anon));

// The push channel is filtered the same way the fetch is.
check('the pushed payload is stripped too, not just the fetched one',
  !JSON.stringify(player.gates).includes('Betrayal'), JSON.stringify(player.gates.at(-1)));
check('...while the GM is pushed the whole thing',
  JSON.stringify(gm.gates).includes('Betrayal'));

// ============================================ 3. reaching a Gate posts
console.log('\n--- reaching a Gate ---');
const chatSince = async (from) => (await jf('/api/chat')).slice(from);
let chatLen = (await jf('/api/chat')).length;

gm.emit('counter:adjust', { counterId: counter.id, delta: 1 });
await sleep(700);
check('one pip short of a Gate says nothing', (await chatSince(chatLen)).length === 0,
  JSON.stringify(await chatSince(chatLen)));

gm.emit('counter:adjust', { counterId: counter.id, delta: 1 }); // now on pip 2
await sleep(700);
let posted = await chatSince(chatLen);
check('landing ON a Gate posts to chat', posted.length === 1, JSON.stringify(posted));
check('...naming an open Gate', /The Warning/.test(posted[0]?.message ?? ''), JSON.stringify(posted[0]?.message));
check('...and saying where it happened', /2\/6/.test(posted[0]?.message ?? ''), posted[0]?.message);

chatLen = (await jf('/api/chat')).length;
gm.emit('counter:adjust', { counterId: counter.id, delta: -2 });
await sleep(700);
check('ticking back down past it says nothing — a correction is not an event',
  (await chatSince(chatLen)).length === 0, JSON.stringify(await chatSince(chatLen)));

// A single big jump reaches everything it passes, in order.
chatLen = (await jf('/api/chat')).length;
gm.emit('counter:adjust', { counterId: counter.id, delta: 5 });
await sleep(900);
posted = await chatSince(chatLen);
check('one jump past two Gates posts both, in the order passed',
  posted.length === 2 && /The Warning/.test(posted[0].message), JSON.stringify(posted.map((p) => p.message)));
// The second probe that matters most.
check('the SECRET Gate is announced without its name',
  /reached a Gate/.test(posted[1].message) && !/Betrayal/.test(posted[1].message),
  JSON.stringify(posted[1].message));
check('...and without its description', !/Mira turns/.test(posted[1].message), posted[1].message);

// A jump past the end announces only the Gates actually reached.
chatLen = (await jf('/api/chat')).length;
gm.emit('counter:adjust', { counterId: counter.id, delta: 99 });
await sleep(800);
check('a jump past the end announces nothing it did not actually reach',
  (await chatSince(chatLen)).length === 0, JSON.stringify(await chatSince(chatLen)));

// ============================================ 4. deleting
console.log('\n--- cleaning up ---');
const gateToGo = (await gatesFor({ role: 'gm' })).find((g) => g.pip_index === 2);
player.emit('counter_gate:delete', { gateId: gateToGo.id });
await sleep(600);
check('a Player cannot delete a Gate', (await gatesFor({ role: 'gm' })).length === 2);
gm.emit('counter_gate:delete', { gateId: gateToGo.id });
await sleep(600);
check('the GM can', (await gatesFor({ role: 'gm' })).length === 1);

gm.emit('counter:delete', { counterId: counter.id });
await sleep(700);
check('deleting the counter takes its Gates with it',
  (await gatesFor({ role: 'gm' })).length === 0, JSON.stringify(await gatesFor({ role: 'gm' })));

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
for (const s of [gm, player]) s.close();
process.exit(failures === 0 ? 0 : 1);

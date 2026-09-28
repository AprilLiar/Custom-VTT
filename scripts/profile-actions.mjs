// Where an action's wall time actually goes.
//
//   DOGFIGHT_PROFILE=1 TURSO_DATABASE_URL="file:/tmp/prof.db" PORT=3044 node server/index.js
//   E2E_URL=http://localhost:3044 node scripts/profile-actions.mjs [round-trip-ms]
//
// Reported as "even on perfect internet I experience a 3 sec delay between
// making an action and seeing the change". A local file cannot reproduce that,
// because the thing that causes it — the network between Render and Turso — is
// not there. What a local run CAN measure exactly is the shape that gets
// multiplied by it: how many database round trips an action needs, and how many
// of them have to happen one after another.
//
//     wall time  ≈  sequential depth (waves)  ×  round trip
//
// So this drives the actions a player actually waits on, then prints the depth
// of each and what it predicts at a given round trip. Pass the round trip as an
// argument; `scripts/latency.mjs` against the live deployment measures the real
// one (`readMs` on /api/health).
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3044';
const RTT = Number(process.argv[2]) || 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 20000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

console.log('Setting up a fight…');
gm.emit('tell:create', { name: `Prof ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `Prof ${stamp}`);
const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name}${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 1,
    startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'],
    ...extra,
  });
  return wait('move:created', (m) => m.name === `${name}${stamp}`);
};
const jab = await mk('ProfJab');
await mk('ProfHook');
await mk('ProfKick');

const a = await jpost('/api/characters', { name: `ProfA${stamp}`, characterType: 'npc' });
const b = await jpost('/api/characters', { name: `ProfB${stamp}`, characterType: 'npc' });
gm.emit('combat:add_participant', { characterId: a.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === a.id));
gm.emit('combat:add_participant', { characterId: b.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === b.id));

// Everything above is setup. Only what follows is measured.
await fetch(`${BASE}/api/profile?role=gm&reset=1`).catch(() => {});
console.log('\nDriving the actions a player waits on…\n');

// The three page loads.
await jf('/api/combat?role=gm');
await jf(`/api/characters/${a.id}?role=gm`);
await jf('/api/characters');
await jf('/api/chat');

// A round: start it, declare, finish declaring.
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
const want = { left: a.id, right: b.id };
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  gm.emit('move:declare', { characterId: want[side], moveId: jab.id, placementTic: start });
  await sleep(500);
  gm.emit('combat:character_done_declaring', { characterId: want[side] });
  await sleep(900);
}
// A Stamina tick — the most frequent write in the game.
gm.emit('stamina:adjust', { characterId: a.id, delta: -1 });
await sleep(400);

await sleep(800);
const report = await fetch(`${BASE}/api/profile?role=gm&rtt=${RTT}`).then((r) => r.text());
console.log(report);
console.log(
  `\n"waves" is the number of round trips that had to happen ONE AFTER ANOTHER.\n` +
    `That column times the real round trip is the delay; the queries column is not.\n` +
    `Round trip used here: ${RTT}ms — measure the real one with scripts/latency.mjs.`
);
gm.emit('combat:clear', {});
await sleep(400);
gm.close();
process.exit(0);

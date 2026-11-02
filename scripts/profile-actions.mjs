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
// one (`readMs` on /api/health). (It drove the old combat round until the pivot
// removed it.)
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
gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

console.log('Setting up a character, a counter and a Scene…');
const pc = await jpost('/api/characters', { name: `ProfPC${stamp}`, characterType: 'pc' });
gm.emit('counter:create', { characterId: pc.id, name: `ProfCounter${stamp}`, targetPips: 6 });
await sleep(500);
const counter = (await jf(`/api/characters/${pc.id}`)).counters.find((c) => c.name === `ProfCounter${stamp}`);
gm.emit('scene:create', { name: `ProfScene${stamp}`, folderId: null });
await sleep(500);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `ProfScene${stamp}`);

// Everything above is setup. Only what follows is measured.
await fetch(`${BASE}/api/profile?role=gm&reset=1`).catch(() => {});
console.log('\nDriving the actions a player waits on…\n');

// The page loads.
await jf('/api/characters');
await jf(`/api/characters/${pc.id}`);
await jf(`/api/characters/${pc.id}/relationships?role=gm`);
await jf('/api/chat');
await jf('/api/stage?role=gm');

// The writes that happen at the table.
gm.emit('counter:adjust', { counterId: counter.id, delta: 1 });
await sleep(400);
gm.emit('roleplay:save_answer', { characterId: pc.id, question: 'Who are you?', answer: 'Someone.' });
await sleep(400);
gm.emit('chat:message', { characterId: pc.id, text: 'Hello' });
await sleep(400);
gm.emit('dice:roll_custom', { characterId: pc.id, size: 8, modifier: 2 });
await sleep(400);
if (scene) {
  gm.emit('scene:activate', { sceneId: scene.id });
  await sleep(600);
}

await sleep(800);
const report = await fetch(`${BASE}/api/profile?role=gm&rtt=${RTT}`).then((r) => r.text());
console.log(report);
console.log(
  `\n"waves" is the number of round trips that had to happen ONE AFTER ANOTHER.\n` +
    `That column times the real round trip is the delay; the queries column is not.\n` +
    `Round trip used here: ${RTT}ms — measure the real one with scripts/latency.mjs.`
);
// Put the world back: an active Scene is global state other scripts assume
// nobody left lying around.
if (scene) gm.emit('scene:delete', { sceneId: scene.id });
await sleep(400);
gm.close();
process.exit(0);

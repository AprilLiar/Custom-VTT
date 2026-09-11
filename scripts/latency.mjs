// **How long does one database round trip actually take from the server?**
//
// This exists because of a reversal. The embedded replica made every read
// local and every statement free, and it was removed (see the note at the top
// of server/db.js: a diskless free tier meant every cold start re-downloaded
// the whole database, which became a 13-minute blocking pull and took the site
// down). Removing it puts the network back on each statement — which is exactly
// the condition that made declaring a move take 3-5 seconds in the first place.
//
// Whether that is a problem again depends entirely on the real network path
// between Render and Turso, and that cannot be measured from a laptop or from
// CI: against a local file every number here is 0ms. So this is a script to
// point at the deployment, not a test.
//
//   node scripts/latency.mjs                        (local, expect ~0ms)
//   E2E_URL=https://your-app.onrender.com node scripts/latency.mjs
//
// **`readMs` is the number that matters.** It is one `SELECT 1` measured
// server-side, so it excludes your own distance to Render and is the per-
// statement cost every handler pays. Multiply it by an action's chain depth to
// predict how that action feels: `readMany`/`writeMany` collapse a group into
// one trip, which is the whole of what now stands between this app and its old
// latency.
//
// The endpoint timings below are wall-clock from wherever you run this, so they
// include your own latency to the host. Compare them to each other, not to an
// absolute budget: /api/rules is a small fixed read and /api/combat is the
// deepest thing the Arena asks for on load, so the gap between them is the part
// that is about database depth rather than about your wifi.
//
// Read-only by design — it is meant to be safe to run against a live game.
const BASE = (process.env.E2E_URL || 'http://localhost:3001').replace(/\/$/, '');
const ROUNDS = Number(process.env.ROUNDS) || 5;

const ms = (n) => `${n.toFixed(0)}ms`;

async function time(path) {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  return { ms: performance.now() - started, status: res.status, bytes: body.length, body };
}

// The middle value, not the mean: one cold connection or one GC pause should
// not decide the number this whole exercise turns on.
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`Measuring ${BASE} over ${ROUNDS} rounds\n`);

const health = await time('/api/health');
if (health.status !== 200) {
  console.error(`/api/health answered ${health.status} — is the server up?`);
  process.exit(1);
}
const mode = JSON.parse(health.body).mode;

const readMsSamples = [];
for (let i = 0; i < ROUNDS; i++) {
  const r = await time('/api/health');
  readMsSamples.push(JSON.parse(r.body).readMs);
}
const trip = median(readMsSamples);

console.log(`database mode        ${mode}`);
console.log(`one round trip       ${ms(trip)}  (server-side SELECT 1, median of ${ROUNDS})`);
if (mode === 'local-file') {
  console.log('                     — a local file, so this is not the number you came for.');
  console.log('                       Point E2E_URL at the deployment to measure the real path.');
}
console.log();

// What that trip costs the actions people actually complain about. The depths
// are the ones counted when this was first investigated, and they are why the
// replica was introduced at all — quoted here so the arithmetic is visible
// rather than remembered.
if (trip > 1) {
  console.log('at that trip cost, and at the chain depths measured before batching:');
  for (const [label, depth] of [['declare a move', 14], ['resolve a round', 145]]) {
    console.log(`  ${label.padEnd(20)} ${depth} deep  ->  ~${ms(trip * depth)} if nothing is batched`);
  }
  console.log('  (readMany/writeMany collapse a group into ONE trip — that is the margin.)\n');
}

const endpoints = ['/api/rules', '/api/characters', '/api/combat', '/api/scenes'];
console.log('endpoint wall-clock (includes your own latency to the host):');
for (const path of endpoints) {
  const samples = [];
  let last;
  for (let i = 0; i < ROUNDS; i++) {
    last = await time(path);
    samples.push(last.ms);
  }
  const flag = last.status === 200 ? '' : `  HTTP ${last.status}`;
  console.log(`  ${path.padEnd(18)} ${ms(median(samples)).padStart(8)}   ${(last.bytes / 1024).toFixed(1)} KB${flag}`);
}

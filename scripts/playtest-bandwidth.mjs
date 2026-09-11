// Playtest: how many BYTES does an ordinary gesture put on the wire?
//
// This exists because the hosting bill is the only symptom the app has for a
// whole class of bug — a `SELECT *` that quietly starts carrying a base64
// image, a snapshot broadcast where a delta would do — and nothing else in the
// test suite can see it. A unit test can prove a payload is CORRECT; only this
// can prove it is SMALL.
//
// Every check is a ceiling on one measured payload, chosen well above what the
// fixed code produces and well below what the broken code produced, so it
// fails loudly on a regression without flaking on ordinary variation.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-bandwidth.mjs
//
// Pass BASELINE=1 to print sizes without asserting — that is how the
// before/after numbers in the PR were taken.
//
// **Some ceilings are not switched on yet, and say so.** The image-transport
// work (serving pictures as cacheable URLs instead of base64 inside the
// payload) is a later phase; until it lands, the payloads that still carry a
// picture are REPORTED with their eventual target rather than asserted, so
// this script fails only on a real regression and never on work that has not
// been attempted.
import { io } from 'socket.io-client';
import http from 'node:http';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
const BASELINE = process.env.BASELINE === '1';
let failures = 0;

const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
const sizeOf = (payload) => Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');

const check = (label, cond, detail = '') => {
  if (BASELINE) return;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
// A ceiling check that always prints the measured number, so the log doubles
// as the before/after record.
const underKb = (label, bytes, ceilingKb) => {
  const ok = bytes <= ceilingKb * 1024;
  console.log(`${BASELINE ? 'MEASURED' : ok ? 'PASS' : 'FAIL'}: ${label} — ${KB(bytes)}${BASELINE ? '' : ` (ceiling ${ceilingKb} KB)`}`);
  if (!BASELINE && !ok) failures++;
};

// Measured and printed against the number it should eventually reach, but not
// yet enforced — see the header note on the image-transport phase.
const pending = (label, bytes, targetKb) => {
  console.log(`PENDING: ${label} — ${KB(bytes)} (target ${targetKb} KB, needs the image-URL phase)`);
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

// A recognisable, deliberately CHUNKY image: 300KB of base64 standing in for a
// real portrait or scene cutout. The point of the exercise is that a payload
// must not carry it, so it has to be big enough to see.
const bigImage = 'A'.repeat(300 * 1024);
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.seen = new Map(); // event -> [byte sizes]
  s.onAny((event, payload) => {
    if (!s.seen.has(event)) s.seen.set(event, []);
    s.seen.get(event).push(sizeOf(payload));
  });
  if (identity) {
    s.emit('identity:set', identity);
    await sleep(350);
  }
  return s;
};
const lastSize = (s, event) => {
  const all = s.seen.get(event);
  return all?.length ? all[all.length - 1] : null;
};
const clear = (s) => s.seen.clear();

const stamp = Date.now();
const gm = await connect({ role: 'gm' });
const pc = await jpost('/api/characters', { name: `BwPC${stamp}`, characterType: 'pc' });
const player = await connect({ role: 'player', characterId: pc.id });

// Give the character a fat portrait, the way a real one would be.
await fetch(`${BASE}/api/characters/${pc.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `BwPC${stamp}`, imageData: bigImage, imageMimeType: 'image/webp' }),
});
await sleep(400);

console.log(`\n=== measuring against ${BASE} ===`);
console.log(`(a stand-in portrait / scene picture is ${KB(bigImage.length)} of base64)\n`);

// ============================================ 1. a Scene with art on it
console.log('--- setting up a Scene with a backdrop and a summoned figure ---');
gm.emit('scene:create', { name: `BwScene${stamp}` });
await sleep(400);
const scenes = await jf('/api/scenes?role=gm');
const scene = scenes.find((s) => s.name === `BwScene${stamp}`);
if (!scene) bail(new Error('scene was not created'));
gm.emit('scene:update', {
  sceneId: scene.id,
  name: scene.name,
  imageData: bigImage,
  imageMimeType: 'image/webp',
});
await sleep(500);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(400);

gm.emit('scene_picture:create', {
  ownerType: 'character',
  ownerId: pc.id,
  name: 'Standing',
  imageData: bigImage,
  imageMimeType: 'image/webp',
});
await sleep(500);
const pics = await jf(`/api/scene-pictures?${new URLSearchParams({ ownerType: 'character', ownerId: pc.id, role: 'gm' })}`);
const pic = pics?.[0];
if (!pic) bail(new Error('scene picture was not created'));
gm.emit('stage:summon', { scenePictureId: pic.id });
await sleep(500);

// ============================================ 2. the headline: dragging a figure
console.log('\n--- a GM drags one figure one inch ---');
clear(gm);
clear(player);
const stage = await jf('/api/stage?role=gm');
const summon = stage.summons?.[0];
if (!summon) bail(new Error('nothing summoned'));
gm.emit('stage:reposition_summon', { summonId: summon.id, posX: 0.4, posY: 0.6 });
await sleep(500);
underKb('stage:updated after a drag (GM)', lastSize(gm, 'stage:updated') ?? 0, 8);
underKb('stage:updated after a drag (Player)', lastSize(player, 'stage:updated') ?? 0, 8);

// ============================================ 3. a single pen stroke
console.log('\n--- a GM draws one pen stroke ---');
clear(gm);
clear(player);
const points = Array.from({ length: 200 }, (_, i) => [i / 400 + 0.11111111111, i / 500 + 0.22222222222]);
gm.emit('scene_draw:add', { points, color: '#ff0000', width: 4, isEraser: false });
await sleep(500);
// Whichever event carries the stroke, the cost of ONE stroke is what matters.
const strokeCost =
  (lastSize(player, 'scene_draw:added') ?? 0) + (lastSize(player, 'stage:updated') ?? 0);
underKb('one pen stroke, total bytes to a Player', strokeCost, 24);

// ============================================ 4. a stamina change in combat
console.log('\n--- one stamina change (fires constantly during a fight) ---');
clear(gm);
clear(player);
gm.emit('stamina:adjust', { characterId: pc.id, delta: -1 });
await sleep(400);
const staminaCost = lastSize(gm, 'character:updated');
if (staminaCost == null) bail(new Error('no character:updated seen after stamina:adjust'));
underKb('character:updated after a stamina change', staminaCost, 8);

// ============================================ 6. REST responses
console.log('\n--- REST responses ---');
// **Wire bytes, not decoded bytes — and that needs raw http, not fetch.**
// undici decompresses transparently and offers no way to opt out, so
// `res.arrayBuffer()` measures what the app produced rather than what Render
// bills for. Counting the bytes off the socket is the only way to see the
// number that lands on the invoice, and with base64 in the payload the gap
// between the two is close to an order of magnitude.
const restSize = (path) =>
  new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    http
      .get(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'Accept-Encoding': 'gzip' } },
        (res) => {
          let bytes = 0;
          res.on('data', (chunk) => { bytes += chunk.length; });
          res.on('end', () => resolve({ bytes, encoding: res.headers['content-encoding'] ?? null }));
        }
      )
      .on('error', reject);
  });
const chars = await restSize('/api/characters');
underKb('GET /api/characters (on the wire)', chars.bytes, 8);
const stageRest = await restSize('/api/stage?role=gm');
underKb('GET /api/stage (on the wire)', stageRest.bytes, 8);

// **Checked against a response big enough to qualify.** `compression` skips
// anything under 1KB, where the gzip header would cost more than it saves — and
// now that the image bytes are gone, most of this app's JSON is under that. So
// the compression check has to use a response that is genuinely large:
// /api/rules serves the whole rules document.
const rules = await restSize('/api/rules');
console.log(`\ncontent-encoding on /api/rules (${KB(rules.bytes)}): ${rules.encoding ?? '(none)'}`);
check('a large HTTP response is compressed', rules.encoding === 'gzip', `got ${rules.encoding ?? 'no content-encoding'}`);

// The picture itself still has to be fetchable, and cacheable forever.
const img = await fetch(`${BASE}/api/img/character/${pc.id}/${'x'.repeat(16)}`);
console.log(`\nan image URL with a WRONG hash: HTTP ${img.status}, cache-control ${img.headers.get('cache-control')}`);
check('a mismatched hash is served but never cached', img.ok && img.headers.get('cache-control') === 'no-store');
check('a picture is served as a real image type', (img.headers.get('content-type') ?? '').startsWith('image/'), img.headers.get('content-type'));
check('nosniff is set on stored user bytes', img.headers.get('x-content-type-options') === 'nosniff');

// **Put the world back.** This script activates a Scene to have something to
// drag, and an active Scene is global state the other playtests reasonably
// assume nobody left lying around — playtest-scene.mjs checks that a Player
// cannot activate one, which is not a question you can ask while one is already
// up. Cleaning up keeps the suite runnable in any order.
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(400);

console.log(failures ? `\n${failures} FAILED` : BASELINE ? '\nBASELINE COMPLETE' : '\nALL PASSED');
gm.close();
player.close();
process.exit(failures ? 1 : 0);

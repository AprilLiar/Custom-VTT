// Playtest: Hidden characters (Scene tab plan, "Hidden (decided, new)").
// Covers the actual point of the feature — a Hidden summon is genuinely
// absent from a non-GM view, not just CSS-hidden:
//   - the GM toggles stage:toggle_hidden and sees is_hidden flip
//   - a Player never receives the hidden summon over stage:updated, even
//     for their OWN character (the request is read literally — "for
//     Players" means every Player, including the owner)
//   - GET /api/stage redacts the same way for a Player-identified fetch,
//     while a GM-identified fetch (socket OR REST) still sees it
//   - un-hiding restores it to every Player's own view
//   - only the GM may toggle it — a Player's own attempt is refused
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-hidden.mjs
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

const wait = (sock, ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const stamp = Date.now();

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
await sleep(200);

const alice = await jpost('/api/characters', { name: `HiddenAlice${stamp}`, characterType: 'pc' });

const player = io(BASE);
await new Promise((r) => player.on('connect', r));
player.emit('identity:set', { role: 'player', characterId: alice.id });
await sleep(200);

gm.emit('scene_picture:create', {
  ownerType: 'character', ownerId: alice.id, name: 'default', imageData: TINY_PNG, imageMimeType: 'image/png',
});
const pic = await wait(gm, 'scene_picture:created', (p) => p.character_id === alice.id);

gm.emit('scene:create', { name: `HiddenScene${stamp}` });
const scene = await wait(gm, 'scene:created', (s) => s.name === `HiddenScene${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);

gm.emit('stage:summon', { scenePictureId: pic.id });
const summonUpdate = await wait(gm, 'stage:updated', (s) => s.summons.some((x) => x.character_id === alice.id));
const summonId = summonUpdate.summons.find((x) => x.character_id === alice.id).id;

// ============================================ 1. GM toggles hidden
console.log('--- GM toggles is_hidden ---');
gm.emit('stage:toggle_hidden', { summonId });
const gmAfterHide = await wait(gm, 'stage:updated', (s) => s.summons.find((x) => x.id === summonId)?.is_hidden);
check('GM sees is_hidden=1 on their own stage:updated', Boolean(gmAfterHide.summons.find((x) => x.id === summonId).is_hidden));

// ============================================ 2. Player never receives it — not even their own
console.log('\n--- a Hidden summon never reaches a Player, including its own owner ---');
await sleep(300);
const playerStage = await jf(`/api/stage?${new URLSearchParams({ role: 'player', characterId: alice.id })}`);
check(
  "Player's own REST fetch omits the hidden summon entirely (their OWN character)",
  !playerStage.summons.some((s) => s.id === summonId),
  JSON.stringify(playerStage.summons)
);

let playerSawIt = false;
const spy = (s) => { if (s.summons.some((x) => x.id === summonId)) playerSawIt = true; };
player.on('stage:updated', spy);
// Force a broadcast the Player socket will also receive, to prove it's
// filtered out live over the socket too, not just on this one REST call.
gm.emit('stage:resize_summon', { summonId, scale: 1 });
await sleep(400);
player.off('stage:updated', spy);
check("Player's own socket never receives the hidden summon over stage:updated either", !playerSawIt);

// ============================================ 3. GM still sees it via REST too
console.log('\n--- the GM still sees it, over both transports ---');
const gmStageRest = await jf(`/api/stage?${new URLSearchParams({ role: 'gm' })}`);
check('GM REST fetch still includes it', gmStageRest.summons.some((s) => s.id === summonId));

// ============================================ 4. Player cannot toggle it themselves
console.log('\n--- only the GM may toggle Hidden ---');
player.emit('stage:toggle_hidden', { summonId });
await sleep(300);
const afterPlayerAttempt = await jf(`/api/stage?${new URLSearchParams({ role: 'gm' })}`);
check(
  "a Player's own stage:toggle_hidden is refused — still hidden",
  Boolean(afterPlayerAttempt.summons.find((s) => s.id === summonId)?.is_hidden)
);

// ============================================ 5. un-hiding restores it for the Player
console.log('\n--- un-hiding restores it to the Player ---');
gm.emit('stage:toggle_hidden', { summonId });
await wait(gm, 'stage:updated', (s) => s.summons.find((x) => x.id === summonId)?.is_hidden === 0);
await sleep(300);
const playerStageAfterUnhide = await jf(`/api/stage?${new URLSearchParams({ role: 'player', characterId: alice.id })}`);
check(
  'un-hidden summon is visible to the Player again',
  playerStageAfterUnhide.summons.some((s) => s.id === summonId),
  JSON.stringify(playerStageAfterUnhide.summons)
);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.emit('scene:delete', { sceneId: scene.id });
gm.close();
player.close();
process.exit(failures ? 1 : 0);

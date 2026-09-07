// Playtest: manual drag-to-place and resize on the Scene stage.
//
// The one thing worth checking against a running server rather than a unit
// test: the server-enforced write gate on the two new handlers,
// stage:reposition_summon/stage:resize_summon. Both resolve ownership off
// the SUMMON's own row (never a client-claimed owner), the same
// mayWriteScenePicture gate stage:summon itself already uses — a GM may
// move/resize any summon, a Player only their own character's, and nobody
// but the GM may touch a Temp NPC's. Also checks that an out-of-range value
// sent straight over the socket comes back CLAMPED, not silently dropped —
// the only way to prove server-side clamping is real is to send something
// a well-behaved client never would.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-drag.mjs
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
  await sleep(300);
  return s;
};

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const stamp = Date.now();
const alice = await jpost('/api/characters', { name: `DragAlice${stamp}`, characterType: 'pc' });
const bob = await jpost('/api/characters', { name: `DragBob${stamp}`, characterType: 'pc' });

const gm = await connect({ role: 'gm' });
const aliceSock = await connect({ role: 'player', characterId: alice.id });
const bobSock = await connect({ role: 'player', characterId: bob.id });

gm.emit('temp_npc:create', { name: `Grunt${stamp}` });
await sleep(300);
const grunt = (await jf('/api/temp-npcs')).find((n) => n.name === `Grunt${stamp}`);

const addPicture = async (ownerType, ownerId, sock) => {
  sock.emit('scene_picture:create', {
    ownerType, ownerId, name: 'default', imageData: TINY_PNG, imageMimeType: 'image/png',
  });
  await sleep(300);
  const pics = await jf(`/api/scene-pictures?${new URLSearchParams({ ownerType, ownerId })}`);
  return pics[0];
};
const alicePicture = await addPicture('character', alice.id, aliceSock);
const gruntPicture = await addPicture('temp_npc', grunt.id, gm);

aliceSock.emit('stage:summon', { scenePictureId: alicePicture.id });
gm.emit('stage:summon', { scenePictureId: gruntPicture.id });
await sleep(400);

const summonOf = async (characterId, tempNpcId) => {
  const stage = await jf('/api/stage');
  return stage.summons.find((s) =>
    characterId != null ? s.character_id === characterId : s.temp_npc_id === tempNpcId
  );
};
let aliceSummon = await summonOf(alice.id, null);
let gruntSummon = await summonOf(null, grunt.id);
check('Alice summoned herself', Boolean(aliceSummon), JSON.stringify(aliceSummon));
check('the GM summoned Grunt', Boolean(gruntSummon), JSON.stringify(gruntSummon));
check(
  'neither summon has a manual position yet (pos_x/pos_y null)',
  aliceSummon.pos_x == null && gruntSummon.pos_x == null,
  JSON.stringify({ aliceSummon, gruntSummon })
);

// ============================================ 1. the GM may move/resize anyone
console.log('\n--- the GM may reposition/resize any summon ---');
gm.emit('stage:reposition_summon', { summonId: aliceSummon.id, posX: 0.25, posY: 0.6 });
await sleep(300);
aliceSummon = await summonOf(alice.id, null);
check(
  "the GM's reposition of Alice's summon landed",
  aliceSummon.pos_x === 0.25 && aliceSummon.pos_y === 0.6,
  JSON.stringify(aliceSummon)
);

gm.emit('stage:reposition_summon', { summonId: gruntSummon.id, posX: 0.8, posY: 0.4 });
gm.emit('stage:resize_summon', { summonId: gruntSummon.id, scale: 1.5 });
await sleep(300);
gruntSummon = await summonOf(null, grunt.id);
check(
  "the GM's reposition/resize of Grunt (a Temp NPC) landed",
  gruntSummon.pos_x === 0.8 && gruntSummon.pos_y === 0.4 && gruntSummon.scale === 1.5,
  JSON.stringify(gruntSummon)
);

// ============================================ 2. a Player may move/resize their own
console.log('\n--- a Player may reposition/resize their own character\'s summon ---');
aliceSock.emit('stage:resize_summon', { summonId: aliceSummon.id, scale: 1.2 });
await sleep(300);
aliceSummon = await summonOf(alice.id, null);
check("Alice's own resize landed", aliceSummon.scale === 1.2, JSON.stringify(aliceSummon));

// ============================================ 3. a Player may NOT move/resize someone else's
console.log("\n--- Bob may NOT reposition/resize Alice's summon or Grunt's ---");
bobSock.emit('stage:reposition_summon', { summonId: aliceSummon.id, posX: 0.99, posY: 0.99 });
bobSock.emit('stage:resize_summon', { summonId: aliceSummon.id, scale: 3 });
await sleep(300);
const aliceSummonAfterBob = await summonOf(alice.id, null);
check(
  "Bob's write to Alice's summon was refused entirely — nothing changed",
  aliceSummonAfterBob.pos_x === aliceSummon.pos_x &&
    aliceSummonAfterBob.pos_y === aliceSummon.pos_y &&
    aliceSummonAfterBob.scale === aliceSummon.scale,
  JSON.stringify({ before: aliceSummon, after: aliceSummonAfterBob })
);

bobSock.emit('stage:reposition_summon', { summonId: gruntSummon.id, posX: 0.01, posY: 0.01 });
await sleep(300);
const gruntSummonAfterBob = await summonOf(null, grunt.id);
check(
  "Bob's write to Grunt's (Temp NPC) summon was refused — nobody but the GM may touch one",
  gruntSummonAfterBob.pos_x === gruntSummon.pos_x && gruntSummonAfterBob.pos_y === gruntSummon.pos_y,
  JSON.stringify({ before: gruntSummon, after: gruntSummonAfterBob })
);

// ============================================ 4. server-side clamping
console.log('\n--- out-of-range values are clamped server-side, not refused wholesale ---');
gm.emit('stage:reposition_summon', { summonId: aliceSummon.id, posX: 5, posY: -3 });
gm.emit('stage:resize_summon', { summonId: aliceSummon.id, scale: 999 });
await sleep(300);
const clamped = await summonOf(alice.id, null);
check(
  'posX=5 clamped to 1, posY=-3 clamped to 0',
  clamped.pos_x === 1 && clamped.pos_y === 0,
  JSON.stringify(clamped)
);
check('scale=999 clamped to 4', clamped.scale === 4, JSON.stringify(clamped));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
aliceSock.close();
bobSock.close();
process.exit(failures ? 1 : 0);

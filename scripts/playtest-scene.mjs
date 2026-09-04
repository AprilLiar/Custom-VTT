// Playtest: the Scene tab's server surface (grows phase by phase, mirroring
// e2e-mobile/scene.spec.js's own growth). Covers Phase 3's
// mayWriteScenePicture, Phase 4's Scene/activation surface, and Phase 5's
// summoning.
//
// The one thing worth checking against a running server rather than a unit
// test: **server-enforced write gates.** A Player may write their own
// character's Scene Pictures and nobody else's; a Temp NPC's are GM-only
// always, since nobody plays one; every Scene/scene-folder write is
// GM-only, full stop. The only way to prove a server-enforced gate is real
// is to ask as somebody who lacks it — a raw socket identity against a
// real endpoint, bypassing the UI's own `canCreate`/GM-only rendering
// entirely (a malicious client would do exactly this). Phase 4 adds the
// `stage:updated` broadcast itself: it must reach every socket (`io.emit`,
// not scoped), and deleting the active Scene must reset `activeScene` to
// `null` live, not just in the next REST read. Phase 5 is where the
// unforgeability actually matters most: `stage:summon`'s `side` MUST come
// from the socket's own identity, never a payload field a malicious client
// could set to `'right'` and grant itself the GM's own half of the stage —
// only a raw socket, deliberately sending a forged `side`, can prove the
// server ignores it.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3100 node server/index.js
//   E2E_URL=http://localhost:3100 node scripts/playtest-scene.mjs
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
  s.pictures = []; // scene_picture:created payloads this socket was told about
  s.stages = []; // stage:updated payloads this socket was told about
  s.on('scene_picture:created', (p) => s.pictures.push(p));
  s.on('stage:updated', (p) => s.stages.push(p));
  await sleep(400);
  return s;
};

const scenePictures = (ownerType, ownerId) =>
  jf(`/api/scene-pictures?${new URLSearchParams({ ownerType, ownerId })}`);

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const stamp = Date.now();
const alice = await jpost('/api/characters', { name: `SceneAlice${stamp}`, characterType: 'pc' });
const bob = await jpost('/api/characters', { name: `SceneBob${stamp}`, characterType: 'pc' });

const gm = await connect({ role: 'gm' });
const aliceSock = await connect({ role: 'player', characterId: alice.id });
const bobSock = await connect({ role: 'player', characterId: bob.id });

// A Temp NPC, GM-created, for the "nobody plays a Temp NPC" checks below.
gm.emit('temp_npc_folder:create', { name: `Folder${stamp}`, parentFolderId: null });
await sleep(300);
const folders = await jf('/api/temp-npc-folders');
const folder = folders.find((f) => f.name === `Folder${stamp}`);
gm.emit('temp_npc:create', { name: `Grunt${stamp}`, folderId: folder.id });
await sleep(300);
const npcs = await jf('/api/temp-npcs');
const grunt = npcs.find((n) => n.name === `Grunt${stamp}`);

// ============================================ 1. a Player writing their own character
console.log('--- a Player may write their own character\'s Scene Pictures ---');
aliceSock.emit('scene_picture:create', {
  ownerType: 'character',
  ownerId: alice.id,
  name: 'Neutral',
  imageData: TINY_PNG,
  imageMimeType: 'image/png',
});
await sleep(300);
let alicePictures = await scenePictures('character', alice.id);
check('the picture was created', alicePictures.length === 1, JSON.stringify(alicePictures));

// ============================================ 2. another Player may NOT
console.log("\n--- another Player may NOT write to Alice's character ---");
bobSock.emit('scene_picture:create', {
  ownerType: 'character',
  ownerId: alice.id,
  name: 'Forged',
  imageData: TINY_PNG,
  imageMimeType: 'image/png',
});
await sleep(300);
alicePictures = await scenePictures('character', alice.id);
check(
  "Bob's write was refused — Alice still has exactly one picture",
  alicePictures.length === 1,
  JSON.stringify(alicePictures)
);

// ============================================ 3. the GM may write to anyone
console.log('\n--- the GM may write to any character ---');
gm.emit('scene_picture:create', {
  ownerType: 'character',
  ownerId: alice.id,
  name: 'GM-added',
  imageData: TINY_PNG,
  imageMimeType: 'image/png',
});
await sleep(300);
alicePictures = await scenePictures('character', alice.id);
check('the GM\'s picture landed — Alice now has two', alicePictures.length === 2, JSON.stringify(alicePictures));

// ============================================ 4. a Temp NPC is GM-only, always
console.log('\n--- a Temp NPC\'s Scene Pictures are GM-only, always ---');
aliceSock.emit('scene_picture:create', {
  ownerType: 'temp_npc',
  ownerId: grunt.id,
  name: 'Forged',
  imageData: TINY_PNG,
  imageMimeType: 'image/png',
});
await sleep(300);
let gruntPictures = await scenePictures('temp_npc', grunt.id);
check("a Player's write to a Temp NPC was refused", gruntPictures.length === 0, JSON.stringify(gruntPictures));

gm.emit('scene_picture:create', {
  ownerType: 'temp_npc',
  ownerId: grunt.id,
  name: 'Snarl',
  imageData: TINY_PNG,
  imageMimeType: 'image/png',
});
await sleep(300);
gruntPictures = await scenePictures('temp_npc', grunt.id);
check("the GM's write to the Temp NPC landed", gruntPictures.length === 1, JSON.stringify(gruntPictures));

// ============================================ 5. rename and delete follow the same gate
console.log('\n--- rename and delete follow the same per-owner gate ---');
const [ownPicture] = await scenePictures('character', alice.id);
bobSock.emit('scene_picture:update', { scenePictureId: ownPicture.id, name: 'Forged rename' });
await sleep(300);
let refetched = await scenePictures('character', alice.id);
check(
  "Bob's rename of Alice's picture was refused",
  refetched.find((p) => p.id === ownPicture.id)?.name === ownPicture.name,
  JSON.stringify(refetched)
);

aliceSock.emit('scene_picture:update', { scenePictureId: ownPicture.id, name: 'Alice renamed' });
await sleep(300);
refetched = await scenePictures('character', alice.id);
check(
  "Alice's own rename succeeded",
  refetched.find((p) => p.id === ownPicture.id)?.name === 'Alice renamed',
  JSON.stringify(refetched)
);

bobSock.emit('scene_picture:delete', { scenePictureId: ownPicture.id });
await sleep(300);
refetched = await scenePictures('character', alice.id);
check("Bob's delete of Alice's picture was refused", refetched.some((p) => p.id === ownPicture.id), JSON.stringify(refetched));

aliceSock.emit('scene_picture:delete', { scenePictureId: ownPicture.id });
await sleep(300);
refetched = await scenePictures('character', alice.id);
check(
  "Alice's own delete succeeded",
  !refetched.some((p) => p.id === ownPicture.id),
  JSON.stringify(refetched)
);

// ============================================ 6. broadcast reaches everyone (io.emit, not scoped)
console.log('\n--- scene_picture:created reaches every connected socket ---');
check("Bob's own socket was told about Alice's very first picture (io.emit, not per-owner)", bobSock.pictures.length >= 1);

// ============================================ 7. Scenes and scene folders are GM-only, always
console.log('\n--- Scene/scene-folder writes are GM-only, always ---');
aliceSock.emit('scene_folder:create', { name: `Forged Folder ${stamp}`, parentFolderId: null });
await sleep(300);
let sceneFolders = await jf('/api/scene-folders');
check(
  "a Player's scene_folder:create was refused",
  !sceneFolders.some((f) => f.name === `Forged Folder ${stamp}`),
  JSON.stringify(sceneFolders)
);

aliceSock.emit('scene:create', { name: `Forged Scene ${stamp}`, folderId: null });
await sleep(300);
let scenes = await jf('/api/scenes');
check(
  "a Player's scene:create was refused",
  !scenes.some((s) => s.name === `Forged Scene ${stamp}`),
  JSON.stringify(scenes)
);

gm.emit('scene:create', { name: `Tavern ${stamp}`, folderId: null });
await sleep(300);
scenes = await jf('/api/scenes');
const tavern = scenes.find((s) => s.name === `Tavern ${stamp}`);
check("the GM's scene:create landed", Boolean(tavern), JSON.stringify(scenes));

aliceSock.emit('scene:activate', { sceneId: tavern.id });
await sleep(300);
let stage = await jf('/api/stage');
check(
  "a Player's scene:activate was refused — the stage stays inactive",
  stage.activeScene === null,
  JSON.stringify(stage)
);

// ============================================ 8. activation reaches every socket, and resets on delete
console.log('\n--- scene:activate broadcasts to every socket; deleting the active Scene resets it live ---');
gm.emit('scene:activate', { sceneId: tavern.id });
await sleep(300);
stage = await jf('/api/stage');
check("the GM's scene:activate landed", stage.activeScene?.id === tavern.id, JSON.stringify(stage));
check(
  "Bob's own socket was told the stage changed (io.emit, not scoped)",
  bobSock.stages.some((s) => s.activeScene?.id === tavern.id)
);

gm.emit('scene:delete', { sceneId: tavern.id });
await sleep(300);
stage = await jf('/api/stage');
check('deleting the active Scene resets activeScene to null in the next REST read', stage.activeScene === null, JSON.stringify(stage));
check(
  'and the reset arrived live, over the socket, not just on the next fetch',
  bobSock.stages.at(-1)?.activeScene === null,
  JSON.stringify(bobSock.stages.at(-1))
);

// ============================================ 9. summoning: side is server-derived, ownership is enforced
console.log('\n--- stage:summon: side comes from identity, never the payload; ownership is enforced ---');
const alicePicture = (await scenePictures('character', alice.id))[0];
const gruntPicture = (await scenePictures('temp_npc', grunt.id))[0];

aliceSock.emit('stage:summon', { scenePictureId: alicePicture.id });
await sleep(300);
stage = await jf('/api/stage');
let aliceSummon = stage.summons.find((s) => s.character_id === alice.id);
check("Alice's own summon landed", Boolean(aliceSummon), JSON.stringify(stage.summons));
check("a Player's summon is always side 'left'", aliceSummon?.side === 'left', JSON.stringify(aliceSummon));

bobSock.emit('stage:summon', { scenePictureId: alicePicture.id });
await sleep(300);
stage = await jf('/api/stage');
check(
  "Bob summoning Alice's OWN picture was refused — still exactly one summon, still Alice's",
  stage.summons.filter((s) => s.character_id === alice.id).length === 1,
  JSON.stringify(stage.summons)
);

// A malicious payload claiming 'left' for a GM summon must still land 'right'.
gm.emit('stage:summon', { scenePictureId: gruntPicture.id, side: 'left' });
await sleep(300);
stage = await jf('/api/stage');
const gruntSummon = stage.summons.find((s) => s.temp_npc_id === grunt.id);
check(
  "the GM's summon is always side 'right', regardless of a forged payload field",
  gruntSummon?.side === 'right',
  JSON.stringify(gruntSummon)
);

// ============================================ 10. re-picking the same picture un-summons; a different one swaps in place
console.log('\n--- re-picking the same picture un-summons; a different picture swaps without reordering ---');
aliceSock.emit('stage:summon', { scenePictureId: alicePicture.id });
await sleep(300);
stage = await jf('/api/stage');
check(
  "re-selecting Alice's own showing picture un-summoned her",
  !stage.summons.some((s) => s.character_id === alice.id),
  JSON.stringify(stage.summons)
);

aliceSock.emit('stage:summon', { scenePictureId: alicePicture.id });
await sleep(300);
gm.emit('scene_picture:create', {
  ownerType: 'character',
  ownerId: alice.id,
  name: 'Alt pose',
  imageData: TINY_PNG,
  imageMimeType: 'image/png',
});
await sleep(300);
const altPicture = (await scenePictures('character', alice.id)).find((p) => p.name === 'Alt pose');
stage = await jf('/api/stage');
const summonIdBeforeSwap = stage.summons.find((s) => s.character_id === alice.id)?.id;

aliceSock.emit('stage:summon', { scenePictureId: altPicture.id });
await sleep(300);
stage = await jf('/api/stage');
aliceSummon = stage.summons.find((s) => s.character_id === alice.id);
check('the swap picked up the new picture', aliceSummon?.scene_picture_id === altPicture.id, JSON.stringify(aliceSummon));
check(
  "swapping updates the summon row IN PLACE — same summon id, not a delete+reinsert (decision #4's 'position preserved')",
  aliceSummon?.id === summonIdBeforeSwap,
  `${aliceSummon?.id} !== ${summonIdBeforeSwap}`
);

// ============================================ 11. stage:remove_summon is GM-only
console.log('\n--- stage:remove_summon is the GM\'s own clear, refused for a Player ---');
bobSock.emit('stage:remove_summon', { summonId: aliceSummon.id });
await sleep(300);
stage = await jf('/api/stage');
check(
  "Bob's remove_summon of Alice was refused — she's still on stage",
  stage.summons.some((s) => s.character_id === alice.id),
  JSON.stringify(stage.summons)
);

gm.emit('stage:remove_summon', { summonId: aliceSummon.id });
await sleep(300);
stage = await jf('/api/stage');
check("the GM's remove_summon succeeded", !stage.summons.some((s) => s.character_id === alice.id), JSON.stringify(stage.summons));

gm.emit('stage:remove_summon', { summonId: gruntSummon.id });
await sleep(300);

// ============================================ 12. deleting a summoned character removes them live, not just on the next fetch
console.log('\n--- deleting a summoned character removes them from stage:updated live ---');
const carol = await jpost('/api/characters', { name: `SceneCarol${stamp}`, characterType: 'pc' });
const carolSock = await connect({ role: 'player', characterId: carol.id });
carolSock.emit('scene_picture:create', {
  ownerType: 'character',
  ownerId: carol.id,
  name: 'Neutral',
  imageData: TINY_PNG,
  imageMimeType: 'image/png',
});
await sleep(300);
const carolPicture = (await scenePictures('character', carol.id))[0];
carolSock.emit('stage:summon', { scenePictureId: carolPicture.id });
await sleep(300);
stage = await jf('/api/stage');
check('Carol summoned successfully, ahead of being deleted', stage.summons.some((s) => s.character_id === carol.id));

await fetch(`${BASE}/api/characters/${carol.id}`, { method: 'DELETE' });
await sleep(300);
stage = await jf('/api/stage');
check(
  "deleting Carol removed her from the next REST read of the stage",
  !stage.summons.some((s) => s.character_id === carol.id),
  JSON.stringify(stage.summons)
);
check(
  'and the removal arrived live, over the socket, not just on the next fetch',
  !bobSock.stages.at(-1)?.summons?.some((s) => s.character_id === carol.id),
  JSON.stringify(bobSock.stages.at(-1))
);
carolSock.close();

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
gm.close();
aliceSock.close();
bobSock.close();
process.exit(failures === 0 ? 0 : 1);

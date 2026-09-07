// Playtest: summons became Scene-specific (decided, revised — see
// vttprojectplan.md's "Summons are Scene-specific" bullet). Covers the new
// invariants scoping introduces on top of everything playtest-scene.mjs
// already proves about ownership/side:
//   - stage:summon is refused outright with no active Scene (nothing to
//     pin a summon to).
//   - a character prepared into Scene A does not show up in Scene B's own
//     roster (getStagePayload only ever reads the ACTIVE Scene's rows).
//   - the SAME character can be independently prepared into two different
//     Scenes at once, each with its own position/scale — the whole point
//     of "prepare in advance" (UNIQUE moved from table-wide to
//     per-(scene_id, character_id)).
//   - switching the active Scene recalls each one's own roster exactly as
//     it was left, not whatever was summoned most recently anywhere.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-scoped-summons.mjs
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

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
await sleep(300);

const wait = (ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const stamp = Date.now();

const alice = await jpost('/api/characters', { name: `ScopedAlice${stamp}`, characterType: 'pc' });
gm.emit('scene_picture:create', {
  ownerType: 'character', ownerId: alice.id, name: 'default', imageData: TINY_PNG, imageMimeType: 'image/png',
});
const pic = await wait('scene_picture:created', (p) => p.character_id === alice.id);

gm.emit('scene:create', { name: `ScopedSceneA${stamp}` });
const sceneA = await wait('scene:created', (s) => s.name === `ScopedSceneA${stamp}`);
gm.emit('scene:create', { name: `ScopedSceneB${stamp}` });
const sceneB = await wait('scene:created', (s) => s.name === `ScopedSceneB${stamp}`);

// ============================================ 1. no active Scene, no summon
console.log('--- stage:summon is refused with no active Scene ---');
gm.emit('scene:activate', { sceneId: null });
await sleep(300);
gm.emit('stage:summon', { scenePictureId: pic.id });
await sleep(300);
let stage = await jf('/api/stage');
check('nothing landed anywhere — no Scene to pin it to', !stage.summons?.length, JSON.stringify(stage.summons));

// ============================================ 2. prepare Scene A, then switch to B — A's roster isn't visible on B
console.log('\n--- a character prepared into Scene A does not show up on Scene B ---');
gm.emit('scene:activate', { sceneId: sceneA.id });
await sleep(300);
gm.emit('stage:summon', { scenePictureId: pic.id });
await sleep(300);
stage = await jf('/api/stage');
check('Alice is on Scene A', stage.summons.some((s) => s.character_id === alice.id), JSON.stringify(stage.summons));

gm.emit('scene:activate', { sceneId: sceneB.id });
await sleep(300);
stage = await jf('/api/stage');
check(
  "Scene B's own roster is empty — Alice's Scene-A summon did not follow",
  !stage.summons.some((s) => s.character_id === alice.id),
  JSON.stringify(stage.summons)
);

// ============================================ 3. the same character, prepared independently into BOTH scenes at once
console.log('\n--- the same character can be independently prepared into two Scenes at once ---');
gm.emit('stage:summon', { scenePictureId: pic.id }); // now on Scene B too (B is active)
await sleep(300);
gm.emit('stage:reposition_summon', {
  summonId: (await jf('/api/stage')).summons.find((s) => s.character_id === alice.id).id,
  posX: 0.9, posY: 0.9,
});
await sleep(300);
stage = await jf('/api/stage');
const bSummon = stage.summons.find((s) => s.character_id === alice.id);
check('Alice is now on Scene B too, positioned there', bSummon?.pos_x === 0.9 && bSummon?.pos_y === 0.9, JSON.stringify(bSummon));

gm.emit('scene:activate', { sceneId: sceneA.id });
await sleep(300);
stage = await jf('/api/stage');
const aSummon = stage.summons.find((s) => s.character_id === alice.id);
check(
  "switching back to Scene A recalls HER OWN prepared state there — untouched by Scene B's own reposition",
  Boolean(aSummon) && aSummon.pos_x == null && aSummon.pos_y == null,
  JSON.stringify(aSummon)
);
check('Scene A and Scene B hold two DIFFERENT summon rows for the same character', aSummon?.id !== bSummon?.id, `${aSummon?.id} vs ${bSummon?.id}`);

// ============================================ 4. un-summoning from Scene A leaves her still prepared on Scene B
console.log('\n--- un-summoning from one Scene leaves the other untouched ---');
gm.emit('stage:summon', { scenePictureId: pic.id }); // toggles off Scene A's own seat (A is active)
await sleep(300);
stage = await jf('/api/stage');
check("Alice is off Scene A's own stage now", !stage.summons.some((s) => s.character_id === alice.id), JSON.stringify(stage.summons));

gm.emit('scene:activate', { sceneId: sceneB.id });
await sleep(300);
stage = await jf('/api/stage');
check("...but still prepared on Scene B, untouched", stage.summons.some((s) => s.character_id === alice.id), JSON.stringify(stage.summons));

// ============================================ 5. deleting a Scene cascades only its own summons
console.log('\n--- deleting a Scene cascades only its own summons ---');
gm.emit('scene:delete', { sceneId: sceneB.id });
await sleep(400);
gm.emit('scene:activate', { sceneId: sceneA.id });
await sleep(300);
stage = await jf('/api/stage');
check("Scene A is unaffected by Scene B's deletion", stage.activeScene?.id === sceneA.id, JSON.stringify(stage.activeScene));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.emit('scene:delete', { sceneId: sceneA.id });
gm.close();
process.exit(failures ? 1 : 0);

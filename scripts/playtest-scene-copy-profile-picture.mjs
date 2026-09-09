// Playtest: "Copy picture from profile" (scene_picture:copy_from_profile).
// Confirms the new Scene Picture is byte-identical to the character's own
// FULL portrait (characters.image_data) — not a re-crop, re-encode, or the
// zoomed-in view CharacterSheet shows elsewhere — and that it's gated the
// same way every other Scene Picture write is (mayWriteScenePicture: GM may
// touch any character's, a Player only their own).
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-copy-profile-picture.mjs
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
const withPortrait = await jpost('/api/characters', { name: `CopyProfileHas${stamp}`, characterType: 'pc' });
const withoutPortrait = await jpost('/api/characters', { name: `CopyProfileNone${stamp}`, characterType: 'pc' });

const gm = await connect({ role: 'gm' });
const ownerSock = await connect({ role: 'player', characterId: withPortrait.id });
const otherSock = await connect({ role: 'player', characterId: withoutPortrait.id });

// Set a real portrait (as CharacterSheet's own upload flow would, minus the
// crop step — this is exactly characters.image_data, the full upload).
// PUT /api/characters/:id, not a socket event — this is REST, same as the
// real upload flow (client/src/components/CharacterSheet.jsx).
await fetch(`${BASE}/api/characters/${withPortrait.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    imageData: TINY_PNG,
    imageMimeType: 'image/png',
    // A crop, to prove the copy uses the FULL image_data and ignores it —
    // if the copy were reading through the crop somehow, this would show.
    cropX: 0.25, cropY: 0.25, cropW: 0.5, cropH: 0.5,
  }),
});
await sleep(300);

const before = await jf(`/api/scene-pictures?${new URLSearchParams({ ownerType: 'character', ownerId: withPortrait.id })}`);
check('starts with no Scene Pictures', before.length === 0, JSON.stringify(before));

// Owner (a Player, their own character) copies their own profile.
ownerSock.emit('scene_picture:copy_from_profile', { characterId: withPortrait.id });
await sleep(400);
const afterOwn = await jf(`/api/scene-pictures?${new URLSearchParams({ ownerType: 'character', ownerId: withPortrait.id })}`);
check('the Player\'s own copy created exactly one Scene Picture', afterOwn.length === 1, JSON.stringify(afterOwn));
if (afterOwn[0]) {
  check('the copy carries the FULL portrait bytes, not a re-crop', afterOwn[0].image_data === TINY_PNG, afterOwn[0].image_data);
  check('the copy carries the portrait\'s own mime type', afterOwn[0].image_mime_type === 'image/png', afterOwn[0].image_mime_type);
  check('the copy is named "Profile"', afterOwn[0].name === 'Profile', afterOwn[0].name);
}

// A different Player may NOT copy someone else's profile into their own — or
// anyone's — Scene Pictures via this event.
otherSock.emit('scene_picture:copy_from_profile', { characterId: withPortrait.id });
await sleep(300);
const afterOtherAttempt = await jf(`/api/scene-pictures?${new URLSearchParams({ ownerType: 'character', ownerId: withPortrait.id })}`);
check('a non-owning Player\'s copy attempt is refused entirely', afterOtherAttempt.length === 1, JSON.stringify(afterOtherAttempt));

// The GM may copy any character's own profile.
gm.emit('scene_picture:copy_from_profile', { characterId: withPortrait.id });
await sleep(400);
const afterGm = await jf(`/api/scene-pictures?${new URLSearchParams({ ownerType: 'character', ownerId: withPortrait.id })}`);
check('the GM may also copy it (a second Scene Picture now exists)', afterGm.length === 2, JSON.stringify(afterGm));

// A character with no portrait set has nothing to copy — a no-op, not an
// empty/broken Scene Picture.
gm.emit('scene_picture:copy_from_profile', { characterId: withoutPortrait.id });
await sleep(300);
const noneResult = await jf(`/api/scene-pictures?${new URLSearchParams({ ownerType: 'character', ownerId: withoutPortrait.id })}`);
check('a character with no portrait yields no Scene Picture at all', noneResult.length === 0, JSON.stringify(noneResult));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
ownerSock.close();
otherSock.close();
process.exit(failures ? 1 : 0);

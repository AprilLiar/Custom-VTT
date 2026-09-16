// Playtest: copying a Scene, and the one property the feature exists to have —
// the copy SHARES its backdrop rather than storing a second copy of it.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-copy.mjs
//
// The sharing is the part worth testing hardest, because getting it wrong is
// invisible: a copy that duplicated the bytes would look and behave identically
// and simply double the largest thing this schema stores. So this asserts on
// the actual byte count in the row, not on how the picture renders.
//
// The other half is the promote-on-delete. Deleting the Scene that owns the
// bytes must never blank the copies borrowing them, and that is a state you
// only reach by deleting things in a particular order — exactly the kind of
// thing nobody does by hand until a GM does it mid-session.
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenes = () => fetch(`${BASE}/api/scenes?role=gm`).then((r) => r.json());
const byName = async (name) => (await scenes()).find((s) => s.name === name);

const gm = io(BASE, { transports: ['websocket'] });
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
await sleep(200);

// A 1x1 PNG is enough: what matters is that the bytes exist and are counted.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const tag = Date.now();
const NAME = `CopySrc${tag}`;

gm.emit('scene:create', { name: NAME });
await sleep(600);
const src = await byName(NAME);
check('a Scene was created', Boolean(src), 'no scene');
if (!src) process.exit(1);

gm.emit('scene:update', {
  sceneId: src.id,
  name: NAME,
  backgroundFit: 'contain',
  imageData: PNG,
  imageMimeType: 'image/png',
});
await sleep(700);
const withArt = await byName(NAME);
check('it has a backdrop', Boolean(withArt?.image_url), JSON.stringify(withArt?.image_url));

// --- the copy ----------------------------------------------------------------
gm.emit('scene:copy', { sceneId: src.id });
await sleep(700);
const copy = await byName(`${NAME} (copy)`);
check('copying produces "<name> (copy)"', Boolean(copy), 'no copy');
if (!copy) process.exit(1);

check('the copy lands in the same folder', copy.folder_id === src.folder_id, `${copy.folder_id}`);
check('and keeps the background fit', copy.background_fit === 'contain', copy.background_fit);

// **The point of the whole feature.** `image_data` is absent from the shaped
// payload either way, so this asks the server what it actually stored.
const sizes = await fetch(`${BASE}/api/image-inventory?role=gm`).then((r) => r.json());
const rows = (Array.isArray(sizes) ? sizes : sizes.items ?? []).filter((i) => i.kind === 'scene');
check(
  'the copy stores NO bytes of its own',
  !rows.some((r) => r.id === copy.id),
  `the copy appears in the image inventory: ${JSON.stringify(rows.filter((r) => r.id === copy.id))}`
);
check('while the original still does', rows.some((r) => r.id === src.id), JSON.stringify(rows.map((r) => r.id)));

// The copy's picture is served from the ORIGINAL's id, which is what makes one
// stored picture and one cached fetch serve both.
check(
  "the copy's backdrop URL points at the original",
  copy.image_url === withArt.image_url,
  `${copy.image_url} vs ${withArt.image_url}`
);
const served = await fetch(`${BASE}${copy.image_url}`);
check('and that URL really serves an image', served.ok && /^image\//.test(served.headers.get('content-type') ?? ''), `HTTP ${served.status}`);

// --- copying a copy points one hop at the bytes, never at another copy -------
gm.emit('scene:copy', { sceneId: copy.id });
await sleep(700);
const second = await byName(`${NAME} (copy) (copy)`);
check('a copy of a copy works', Boolean(second), 'no second copy');
check(
  'and still resolves to the original, with no chain',
  second?.image_url === withArt.image_url,
  `${second?.image_url} vs ${withArt.image_url}`
);

// --- nothing but the picture and the name travels ---------------------------
gm.emit('scene:update', { sceneId: src.id, name: NAME, backgroundFit: 'contain' });
gm.emit('scene_note:create', { sceneId: src.id, title: 'prep', body: 'secret' });
await sleep(500);
const before = new Set((await scenes()).map((s) => s.id));
gm.emit('scene:copy', { sceneId: src.id });
await sleep(700);
// **By id, not by name.** The first copy already owns `<name> (copy)`, so a
// second one is a duplicate name and `byName` would hand back the older row —
// which silently checks the wrong Scene AND leaks the new one at teardown.
const third = (await scenes()).find((s) => !before.has(s.id));
check('a second copy of the original was made', Boolean(third), 'no new scene appeared');
const notes = third
  ? await fetch(`${BASE}/api/scene-notes?role=gm&sceneId=${third.id}`).then((r) => r.json())
  : [];
check('a copy carries no Notes across', Array.isArray(notes) && notes.length === 0, JSON.stringify(notes));
check('and no Timestamp cue', third?.timestamp_id == null, `${third?.timestamp_id}`);

// --- deleting the owner must not blank the copies ---------------------------
gm.emit('scene:delete', { sceneId: src.id });
await sleep(900);
const afterCopy = await byName(`${NAME} (copy)`);
const afterSecond = await byName(`${NAME} (copy) (copy)`);
check('deleting the original leaves the copies standing', Boolean(afterCopy && afterSecond), 'a copy vanished');
check(
  'and they still have a working backdrop',
  Boolean(afterCopy?.image_url) && Boolean(afterSecond?.image_url),
  `${afterCopy?.image_url} / ${afterSecond?.image_url}`
);
const stillServed = await fetch(`${BASE}${afterCopy.image_url}`);
check(
  'the promoted picture is really served',
  stillServed.ok && /^image\//.test(stillServed.headers.get('content-type') ?? ''),
  `HTTP ${stillServed.status}`
);
const after = await fetch(`${BASE}/api/image-inventory?role=gm`).then((r) => r.json());
const sceneRows = (Array.isArray(after) ? after : after.items ?? []).filter((i) => i.kind === 'scene');
const survivors = [afterCopy.id, afterSecond.id, third?.id].filter(Boolean);
check(
  'the picture is STILL stored exactly once across them',
  sceneRows.filter((r) => survivors.includes(r.id)).length === 1,
  JSON.stringify(sceneRows.filter((r) => survivors.includes(r.id)))
);

// Clean up so repeated runs and playtest-scene start clean.
for (const s of [afterCopy, afterSecond, third].filter(Boolean)) {
  gm.emit('scene:delete', { sceneId: s.id });
}
await sleep(600);

gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

// Playtest: GM Notes — Scene Notes (pinned to a concrete Scene) and the
// singleton Master Note.
//
// The one thing worth checking against a running server rather than a unit
// test: **these are genuinely GM-secret, not merely GM-managed**, unlike
// the rest of the Scene tab's own authoring content (Temp NPCs, Scenes).
// Both the REST reads (viewerFromQuery's 403 gate) and every socket write
// are GM-only, server-enforced — the only way to prove that is to ask as a
// Player and confirm the refusal, the same reasoning playtest-scene.mjs's
// own header comment gives for its write-gate checks.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-notes.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r);
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

const wait = (sock, ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

const stamp = Date.now();
const gm = await connect({ role: 'gm' });
const bob = await jpost('/api/characters', { name: `NotesBob${stamp}`, characterType: 'pc' });
const bobSock = await connect({ role: 'player', characterId: bob.id });

gm.emit('scene:create', { name: `NotesScene${stamp}` });
const scene = await wait(gm, 'scene:created', (s) => s.name === `NotesScene${stamp}`);

const otherScene = await (async () => {
  gm.emit('scene:create', { name: `NotesOtherScene${stamp}` });
  return wait(gm, 'scene:created', (s) => s.name === `NotesOtherScene${stamp}`);
})();

// ============================================ 1. REST reads are GM-only, server-enforced
console.log('--- REST reads: 403 for anyone but the GM ---');
let res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'player', characterId: bob.id })}`);
check('a Player reading /api/scene-notes gets 403', res.status === 403, String(res.status));

res = await jf(`/api/master-note?${new URLSearchParams({ role: 'player', characterId: bob.id })}`);
check('a Player reading /api/master-note gets 403', res.status === 403, String(res.status));

res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'gm' })}`);
check('the GM reading /api/scene-notes gets 200', res.status === 200, String(res.status));
const emptyNotes = await res.json();
check('...and it starts empty', Array.isArray(emptyNotes) && emptyNotes.length === 0, JSON.stringify(emptyNotes));

// ============================================ 2. writes are GM-only, server-enforced
console.log('\n--- socket writes: refused for a Player, allowed for the GM ---');
bobSock.emit('scene_note:create', { sceneId: scene.id, title: 'Forged', body: 'should not land' });
await sleep(300);
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'gm' })}`);
let notes = await res.json();
check("a Player's scene_note:create was refused", notes.length === 0, JSON.stringify(notes));

gm.emit('scene_note:create', { sceneId: scene.id, title: 'GM secret', body: 'the villain is the mayor' });
await sleep(300);
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'gm' })}`);
notes = await res.json();
const note = notes.find((n) => n.title === 'GM secret');
check("the GM's scene_note:create landed", Boolean(note), JSON.stringify(notes));

// ============================================ 3. Notes are pinned to their own Scene, not shared
console.log('\n--- Scene Notes are pinned to their own Scene, not visible from another ---');
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: otherScene.id, role: 'gm' })}`);
const otherSceneNotes = await res.json();
check(
  "the other Scene's own notes list does not include it",
  !otherSceneNotes.some((n) => n.id === note.id),
  JSON.stringify(otherSceneNotes)
);

// ============================================ 4. update/delete, Player refused / GM allowed
console.log('\n--- scene_note:update / scene_note:delete follow the same gate ---');
bobSock.emit('scene_note:update', { noteId: note.id, title: 'tampered', body: 'tampered' });
await sleep(300);
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'gm' })}`);
notes = await res.json();
check(
  "a Player's scene_note:update was refused",
  notes.find((n) => n.id === note.id)?.title === 'GM secret',
  JSON.stringify(notes)
);

gm.emit('scene_note:update', { noteId: note.id, title: 'GM secret (revised)', body: 'actually it is the sheriff' });
await sleep(300);
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'gm' })}`);
notes = await res.json();
check(
  "the GM's scene_note:update landed",
  notes.find((n) => n.id === note.id)?.title === 'GM secret (revised)',
  JSON.stringify(notes)
);

bobSock.emit('scene_note:delete', { noteId: note.id });
await sleep(300);
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'gm' })}`);
notes = await res.json();
check("a Player's scene_note:delete was refused", notes.some((n) => n.id === note.id), JSON.stringify(notes));

gm.emit('scene_note:delete', { noteId: note.id });
await sleep(300);
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: scene.id, role: 'gm' })}`);
notes = await res.json();
check("the GM's scene_note:delete landed", !notes.some((n) => n.id === note.id), JSON.stringify(notes));

// ============================================ 5. deleting a Scene cascades its notes
console.log('\n--- deleting a Scene cascades its own notes ---');
gm.emit('scene_note:create', { sceneId: otherScene.id, title: 'goes with the scene', body: '...' });
await sleep(300);
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: otherScene.id, role: 'gm' })}`);
const cascadeNote = (await res.json()).find((n) => n.title === 'goes with the scene');
check('the fixture note landed on the other Scene', Boolean(cascadeNote));

gm.emit('scene:delete', { sceneId: otherScene.id });
await sleep(400);
// Deleted Scene's own notes can no longer be queried by that sceneId at all
// (the row itself is gone, not just filtered) — same REST call, same GM
// identity, now against an id that no longer resolves to any scene.
res = await jf(`/api/scene-notes?${new URLSearchParams({ sceneId: otherScene.id, role: 'gm' })}`);
const afterCascade = await res.json();
check(
  "the cascaded note no longer shows up under the deleted Scene's id",
  !afterCascade.some((n) => n.id === cascadeNote.id),
  JSON.stringify(afterCascade)
);

// ============================================ 6. the Master Note is a real singleton
console.log('\n--- the Master Note is one singleton, the same from any Scene, GM-only ---');
bobSock.emit('master_note:update', { body: 'forged campaign notes' });
await sleep(300);
res = await jf(`/api/master-note?${new URLSearchParams({ role: 'gm' })}`);
let master = await res.json();
check("a Player's master_note:update was refused", master.body !== 'forged campaign notes', JSON.stringify(master));

gm.emit('master_note:update', { body: 'the real campaign secret' });
await sleep(300);
res = await jf(`/api/master-note?${new URLSearchParams({ role: 'gm' })}`);
master = await res.json();
check("the GM's master_note:update landed", master.body === 'the real campaign secret', JSON.stringify(master));
check('the Master Note is id 1 (the singleton row)', master.id === 1, JSON.stringify(master));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.emit('scene:delete', { sceneId: scene.id });
gm.close();
bobSock.close();
process.exit(failures ? 1 : 0);

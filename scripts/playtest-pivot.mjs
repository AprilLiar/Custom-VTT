// Playtest: what is left after the pivot, driven through the real handlers.
//
// The old system — Moves, Perks, Quirks, Stances, the eight Stat dice, the
// Combat Arena, the Rules page — was removed, and the handlers that survive it
// were rewritten to stop reaching into it. This checks every one of those
// rewritten paths end to end, plus the archive the old Compendium was saved to:
//
//   1. Plain character creation: name, PC/NPC, folder and a profile picture, in
//      one request — and the sheet it opens on has only the surviving tabs' data.
//   2. Renaming and replacing the picture still work (they moved out of the
//      removed Core Stats tab into the sheet header).
//   3. Deleting a character cascades through what survives.
//   4. Chat: a message, and a Dice Tray roll whose modifier is exactly what was
//      typed — no bonus from a system that no longer exists.
//   5. Search finds characters.
//   6. The archive endpoints are GM-only.
//   7. The removed endpoints are really gone.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-pivot.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const send = (method, u, b) =>
  fetch(BASE + u, { method, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILURE(S)');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const wait = (ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
const stamp = Date.now();

// ============================================ 1. plain create
console.log('\n--- plain character creation ---');
gm.emit('character_folder:create', { name: `Pivot Folder ${stamp}`, parentFolderId: null });
await sleep(400);
const folder = (await jf('/api/character-folders')).find((f) => f.name === `Pivot Folder ${stamp}`);
const created = await send('POST', '/api/characters', {
  name: `Pivot ${stamp}`,
  characterType: 'npc',
  folderId: folder.id,
  imageData: PNG,
  imageMimeType: 'image/png',
  cropX: 0, cropY: 0, cropW: 1, cropH: 1,
});
const c = created.body;
check('one request creates the character', created.status === 201 && c?.id != null, JSON.stringify(created));
check('...as the type asked for, in the folder asked for',
  c?.character_type === 'npc' && c?.folder_id === folder.id, JSON.stringify(c));
check('...with the profile picture and its crop', c?.image_data === PNG && c?.crop_w === 1, JSON.stringify({ crop_w: c?.crop_w }));
const sheet = await jf(`/api/characters/${c.id}`);
check('the sheet carries exactly the surviving data',
  JSON.stringify(Object.keys(sheet).sort()) === JSON.stringify(['character', 'counters', 'roleplay']),
  JSON.stringify(Object.keys(sheet)));
for (const gone of ['current_stamina', 'max_stamina', 'active_stance_id', 'vitruvian_image_data', 'pending_roll_penalty']) {
  check(`...and the character row has no ${gone}`, !(gone in sheet.character), JSON.stringify(Object.keys(sheet.character)));
}
const roster = await jf('/api/characters');
const listed = roster.find((r) => r.id === c.id);
check('the roster lists them with a picture URL and no picture bytes',
  Boolean(listed?.image_url) && !('image_data' in listed) && !('stances' in listed), JSON.stringify(listed));
const pic = await fetch(BASE + listed.image_url);
check('...and the picture URL serves the picture', pic.ok && (pic.headers.get('content-type') ?? '').startsWith('image/'),
  `${pic.status} ${pic.headers.get('content-type')}`);

// ============================================ 2. rename + new picture
console.log('\n--- rename and replace the picture (moved to the sheet header) ---');
const renamedEvent = wait('character:updated', (p) => p.id === c.id);
const renamed = await send('PUT', `/api/characters/${c.id}`, { name: `Pivot Renamed ${stamp}` });
const broadcast = await renamedEvent;
check('a rename saves', renamed.body?.name === `Pivot Renamed ${stamp}`, JSON.stringify(renamed.body));
check('...and is broadcast without picture bytes', broadcast.name === `Pivot Renamed ${stamp}` && !('image_data' in broadcast),
  JSON.stringify(Object.keys(broadcast)));
const repictured = await send('PUT', `/api/characters/${c.id}`, { imageData: PNG.replace('A', 'B'), imageMimeType: 'image/png' });
check('the picture can be replaced', repictured.status === 200 && repictured.body?.image_data !== PNG, String(repictured.status));
const ignored = await send('PUT', `/api/characters/${c.id}`, { vitruvianImageData: PNG });
check('the old backdrop field is ignored rather than an error', ignored.status === 200, String(ignored.status));

// ============================================ 3. delete cascade
console.log('\n--- deleting a character ---');
gm.emit('counter:create', { characterId: c.id, name: `Pivot Counter ${stamp}`, targetPips: 4 });
await sleep(400);
gm.emit('roleplay:add_question', { characterId: c.id, question: 'Why?' });
await sleep(400);
const before = await jf(`/api/characters/${c.id}`);
check('the character has a Counter and Role-play to lose', before.counters.length === 1 && before.roleplay.length >= 1,
  JSON.stringify({ counters: before.counters.length, roleplay: before.roleplay.length }));
const deleted = await send('DELETE', `/api/characters/${c.id}`);
check('delete succeeds', deleted.status === 200 && deleted.body?.ok === true, JSON.stringify(deleted));
const after = await fetch(`${BASE}/api/characters/${c.id}`);
check('...and the character is gone', after.status === 404, String(after.status));

// ============================================ 4. chat
console.log('\n--- chat: a message and a Dice Tray roll ---');
const msg = wait('chat:message', (p) => p.message === `pivot ${stamp}`);
gm.emit('chat:message', { characterId: null, text: `pivot ${stamp}` });
check('a message posts and broadcasts', Boolean(await msg));
const roll = wait('roll:result', () => true);
gm.emit('dice:roll_custom', { characterId: null, size: 6, modifier: 3 });
const rolled = await roll;
const face = rolled.dice?.[0]?.result;
check('a Dice Tray roll posts', rolled.kind === 'roll' && rolled.dice?.[0]?.size === 6, JSON.stringify(rolled));
check('...with exactly the typed modifier, and nothing added to it', rolled.modifier === 3 && rolled.total === face + 3,
  JSON.stringify({ modifier: rolled.modifier, total: rolled.total, face }));
const tooBig = wait('roll:result', () => true);
gm.emit('dice:roll_custom', { characterId: null, size: 4, modifier: 99 });
check('...clamped to the ±20 limit', (await tooBig).modifier === 20);
const log = await jf('/api/chat');
check('the log reads both back', log.some((e) => e.kind === 'message' && e.message === `pivot ${stamp}`) &&
  log.some((e) => e.kind === 'roll' && e.modifier === 3), JSON.stringify(log.slice(-3)));

// ============================================ 5. search
console.log('\n--- search ---');
const keep = (await send('POST', '/api/characters', { name: `Findable ${stamp}` })).body;
const found = await jf(`/api/search?q=Findable%20${stamp}`);
check('search finds a character by name', found.characters?.some((r) => r.id === keep.id), JSON.stringify(found));
check('...and returns characters only', JSON.stringify(Object.keys(found)) === JSON.stringify(['characters']),
  JSON.stringify(Object.keys(found)));
await send('DELETE', `/api/characters/${keep.id}`);

// ============================================ 6. the archive
console.log("\n--- the old Compendium's archive ---");
const asPlayer = await fetch(`${BASE}/api/compendium-archive`);
check('the listing is GM-only', asPlayer.status === 403, String(asPlayer.status));
const asGm = await send('GET', '/api/compendium-archive?role=gm');
check('a GM gets the listing and the purge status',
  asGm.status === 200 && Array.isArray(asGm.body?.archives) && typeof asGm.body?.purge?.status === 'string',
  JSON.stringify(asGm.body));
const firstId = asGm.body?.archives?.[0]?.id;
if (firstId != null) {
  const dl = await fetch(`${BASE}/api/compendium-archive/${firstId}?role=gm`);
  check('an archive downloads as a JSON file', dl.ok && /attachment/.test(dl.headers.get('content-disposition') ?? ''),
    dl.headers.get('content-disposition'));
  const doc = await dl.json();
  check('...in the archive format', doc.format === 'dogfight-old-system-archive', JSON.stringify(doc.format));
  const denied = await fetch(`${BASE}/api/compendium-archive/${firstId}`);
  check('...and the download is GM-only too', denied.status === 403, String(denied.status));
} else {
  console.log('  (no archive on this database — a fresh world never had an old system to archive)');
}

// ============================================ 7. what is gone
console.log('\n--- the removed endpoints ---');
for (const path of ['/api/moves', '/api/perks', '/api/quirks', '/api/tells', '/api/tags', '/api/combat',
  '/api/ruleset', '/api/rules', '/api/perk-tags']) {
  const r = await fetch(BASE + path);
  check(`${path} is gone`, r.status === 404, String(r.status));
}

gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

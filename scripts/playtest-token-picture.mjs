// Playtest: the token picture (decided). Ticking one of a character's Scene
// Pictures makes it their combat token (map, turn order, chat cards); only
// one at a time — ticking another moves the tick; ticking the ticked one
// again clears it, and the token falls back to the unique combat token, else
// the portrait.
//
//   (start the dev server first)
//   node scripts/playtest-token-picture.mjs
import zlib from 'node:zlib';
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILURE(S)');
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
// A real 700×700 PNG: the map's bounds are the cells inside its 10% padding
// (70px grid: columns and rows 1-8).
function png(w, h) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3, 0x30);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}



const stamp = Date.now();
const gm = await connect({ role: 'gm' });
gm.emit('scene:create', { name: `TP ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `TP ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(300);
const ana = await jpost('/api/characters', { name: `TPAna${stamp}`, characterType: 'pc' });
const pic = png(40, 40).toString('base64');
for (const name of ['Pose A', 'Pose B']) gm.emit('scene_picture:create', { ownerType: 'character', ownerId: ana.id, name, imageData: pic, imageMimeType: 'image/png' });
await sleep(600);
const pics = async () => jf(`/api/scene-pictures?ownerType=character&ownerId=${ana.id}`);
const [a, b] = await pics();
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 2, row: 2 });
await sleep(500);
const tokenUrl = async () => (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.character_id === ana.id)?.image_url ?? null;
check('no tick: no token picture (no unique token, no portrait)', (await tokenUrl()) == null, String(await tokenUrl()));
gm.emit('scene_picture:set_token', { scenePictureId: a.id });
await sleep(500);
check('ticking Pose A: the token shows it', new RegExp(`scene-picture.*${a.id}`).test((await tokenUrl()) ?? ''), String(await tokenUrl()));
check('…and it is marked', (await pics()).find((p) => p.id === a.id).is_token === 1);
gm.emit('scene_picture:set_token', { scenePictureId: b.id });
await sleep(500);
const now = await pics();
check('ticking Pose B moves the tick: only B', now.find((p) => p.id === b.id).is_token === 1 && now.find((p) => p.id === a.id).is_token === 0, JSON.stringify(now.map((p) => [p.id, p.is_token])));
check('…the token shows B', new RegExp(`scene-picture.*${b.id}`).test((await tokenUrl()) ?? ''), String(await tokenUrl()));
gm.emit('scene_picture:set_token', { scenePictureId: b.id });
await sleep(500);
check('ticking B again clears it: back to no picture', (await pics()).every((p) => !p.is_token) && (await tokenUrl()) == null, String(await tokenUrl()));
const p = await connect({ role: 'player', characterId: 999999 });
p.emit('scene_picture:set_token', { scenePictureId: a.id });
await sleep(400);
check("a player can't tick someone else's picture", (await pics()).every((x) => !x.is_token));

gm.emit('scene:delete', { sceneId: scene.id });
await fetch(`${BASE}/api/characters/${ana.id}`, { method: 'DELETE' });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

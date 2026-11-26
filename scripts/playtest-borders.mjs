// Playtest: map borders on the Combat map — the GM draws red and purple
// borders on square edges (Players can't), they reach every client with the
// stage, Free Movement goes round a red one, a purple fence walls off Free
// Movement and the attack range alike, a dashed (range-passing) one lets the
// range through, and the GM clears them.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-borders.mjs
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
gm.on('trigger:prompt', (q) => setTimeout(() => gm.emit('trigger:answer', { id: q.id, answer: q.kind === 'confirm' ? true : q.options?.[0]?.id }), 120));
gm.emit('scene:create', { name: `BD ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `BD ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `BDAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `BDBo${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: ana.id });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 4 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 7, row: 4 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const reach = (s, combatantId) => new Promise((r) => s.emit('move:reach', { combatantId }, r));
const range = () => new Promise((r) => gm.emit('fight:active_range', { mode: 'combat' }, r));

console.log('\n--- drawing ---');
p.emit('map_border:set', { edges: [{ side: 'v', col: 4, row: 4 }], color: 'red' });
await sleep(300);
await stage();
check("a Player can't draw borders (GM only)", (st.borders ?? []).length === 0, JSON.stringify(st.borders));
gm.emit('map_border:set', { edges: [{ side: 'v', col: 4, row: 4 }], color: 'red' });
await sleep(300);
await stage();
check('the GM draws a red border; it reaches the stage, blocking range by default', st.borders.length === 1 && st.borders[0].color === 'red' && st.borders[0].blocksRange === true, JSON.stringify(st.borders));
const pStage = await jf(`/api/stage?role=player&characterId=${ana.id}`);
check('…and every Player sees it', (pStage.borders ?? []).length === 1, JSON.stringify(pStage.borders));

console.log('\n--- movement ---');
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(1500);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 6 });
await sleep(400);
let r = await reach(p, ta.id);
const cost = (id) => r.options?.find((o) => o.id === id)?.cost;
check('Free Movement goes round a red border: the square beyond costs 3, not 1', cost('4,4') === 3 && cost('3,3') === 1, JSON.stringify(r.options?.filter((o) => o.row >= 3 && o.row <= 5 && o.col <= 5)));
// A purple fence the whole height of the board between columns 3 and 4.
const fence = Array.from({ length: 16 }, (_, i) => ({ side: 'v', col: 4, row: i - 3 }));
gm.emit('map_border:set', { edges: fence, color: 'purple' });
await sleep(400);
r = await reach(p, ta.id);
check('a purple fence: nothing beyond it is reachable', (r.options ?? []).length > 0 && !(r.options ?? []).some((o) => o.col >= 4), JSON.stringify((r.options ?? []).filter((o) => o.col >= 4)));

console.log('\n--- range ---');
let ar = await range();
check('range does not reach across a border that blocks it', ar.combatantId === ta.id && !(ar.squares ?? []).some((s) => s.col >= 4) && (ar.squares ?? []).length > 0, JSON.stringify(ar));
gm.emit('map_border:set', { edges: fence, color: 'purple', blocksRange: false });
await sleep(400);
ar = await range();
check('…but across a dashed one (blocks range: no) it does', (ar.squares ?? []).some((s) => s.col === 4), JSON.stringify(ar));
r = await reach(p, ta.id);
check('…while it still walls off movement', !(r.options ?? []).some((o) => o.col >= 4));

console.log('\n--- removing ---');
gm.emit('map_border:remove', { edges: [{ side: 'v', col: 4, row: 4 }] });
await sleep(300);
await stage();
check('the GM removes one border', st.borders.length === fence.length - 1 && !st.borders.some((b) => b.col === 4 && b.row === 4));
p.emit('map_border:clear');
await sleep(300);
await stage();
check("a Player can't clear them", st.borders.length === fence.length - 1);
gm.emit('map_border:clear');
await sleep(300);
await stage();
check('the GM clears every border', st.borders.length === 0);

gm.emit('fight:end', { mode: 'combat' });
await sleep(400);
gm.emit('scene:delete', { sceneId: scene.id });
for (const c of [ana, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
await sleep(300);
for (const s of [gm, p]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

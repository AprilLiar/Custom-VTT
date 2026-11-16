// Playtest: Fight Setup's Arena Parameters — Icy Floor (one more space after
// a move) and Traffic (6 damage in the Danger Zone at the Round's end).
//
//   (start the dev server first)
//   node scripts/playtest-arena.mjs
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
const cards = [];
gm.on('chat:card', (c) => cards.push(c));
gm.on('trigger:prompt', (x) => {
  // Iron against Traffic: none; comebacks: declined.
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.minimum === 0 ? [] : x.title === 'Reduce the hit' ? '0' : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `AR ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `AR ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `ARAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `ARBo${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: ana.id });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 7, row: 7 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
for (const id of [ta.id, tb.id]) ['armor', 'speed', 'iron', 'shield'].forEach((k) => gm.emit('fighter:token', { ref: { combatantId: id }, key: k, clear: true }));
await sleep(400);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const set = (change) => gm.emit('battle:set', { mode: 'combat', change });
const named = (title) => cards.filter((c) => c.payload?.title === title);

console.log('\n--- Icy Floor ---');
set({ arena: 'icy_floor' });
set({ arena: 'traffic' });
gm.emit('map_tile:place', { mode: 'combat', col: 7, row: 7, kind: 'danger' });
await sleep(300);
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(1800);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 6 });
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(2200);
await stage();
check("Early Movement on Bo's turn waits for Ana", st.fights.combat.movement_phase?.waiting?.includes(ta.id), JSON.stringify(st.fights.combat.movement_phase));
p.emit('move:free', { combatantId: ta.id, to: { col: 3, row: 4 } });
await sleep(1500);
await stage();
check('Ana moves down to 3,4 — and slides one more space on the ice', `${tok(ta.id).col},${tok(ta.id).row}` === '3,5', `${tok(ta.id).col},${tok(ta.id).row}`);
p.emit('move:done', { combatantId: ta.id });
await sleep(400);

console.log('\n--- Traffic ---');
const hpBo = tok(tb.id).fight.hp.current;
gm.emit('fight:next', { mode: 'combat' });
await sleep(3000);
for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
await sleep(800);
await stage();
check('the Round ends with Bo in the Danger Zone: 6 damage', named('Traffic').length === 1 && tok(tb.id).fight.hp.current <= hpBo - 6 + 2 * 3, `${hpBo} → ${tok(tb.id).fight.hp.current}; ${JSON.stringify(named('Traffic').map((c) => c.payload.text))}`);

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

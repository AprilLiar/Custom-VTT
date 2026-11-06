// Playtest: obstacles and Copies (full automation, phase E) — a "you may
// place a Trap" picked as a space (Volcanic Style), Fog on your own space
// (Hidden Style), a Copy placed by the Necromancer and drawn as its
// Original's, hand-placed tiles leaving the Copy be, and a Trap destroying
// the Copy in the End Phase.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-obstacles.mjs
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
const prompts = [];
// The GM picks: the Trap at (4,3), the Copy at (3,4).
gm.on('trigger:prompt', (p) => {
  prompts.push(p);
  let answer = p.kind === 'confirm' ? true : p.kind === 'targets' ? [p.options[0].id] : p.options?.[0]?.id;
  if (p.kind === 'square' && /Volcanic/.test(p.title)) answer = p.options.some((o) => o.id === '4,3') ? '4,3' : [];
  if (p.kind === 'square' && /Necromancer/.test(p.title)) answer = '3,4';
  // The end of her turn: "each of your Copies may Move 1" — no, it stays on the Trap.
  if (p.kind === 'confirm' && /Necromancer/.test(p.title)) answer = false;
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer }), 120);
});
gm.emit('scene:create', { name: `OB ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `OB ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `OBAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `OBBo${stamp}`, characterType: 'npc' });
// Ana: the Necromancer (a Copy at the start of each turn), Volcanic Style (you may place a Trap).
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.the-necromancer', variant: 'focused' }], stances: [{ formId: 'form.power', styleId: 'style.volcanic' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.hidden' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 6, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
const tilesAt = (col, row) => st.tiles.combat.filter((t) => t.col === col && t.row === row);

console.log('\n--- start of Ana’s turn ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(3000);
st = await jf('/api/stage?role=gm');
const vol = prompts.find((p) => p.kind === 'square' && /Volcanic/.test(p.title));
check('"You may place a Trap": one space pick with a Skip (no yes/no first)', vol && vol.minimum === 0 && !prompts.some((p) => p.kind === 'confirm' && /Volcanic/.test(p.title)), JSON.stringify(prompts.map((p) => [p.kind, p.title, p.minimum])));
check('…the Trap is on the picked space', tilesAt(4, 3).some((t) => t.kind === 'trap'), JSON.stringify(st.tiles.combat));
const copy = st.tiles.combat.find((t) => t.kind === 'copy');
check('the Necromancer places a Copy on an empty space in range, owned by Ana', copy && copy.col === 3 && copy.row === 4 && copy.owner_id === ta.id, JSON.stringify(copy));
const necro = prompts.find((p) => p.kind === 'square' && /Necromancer/.test(p.title));
check('…only empty spaces are offered for it', necro && !necro.options.some((o) => o.id === '3,3' || o.id === '6,3'), JSON.stringify(necro?.options?.map((o) => o.id)));

console.log('\n--- the Copy on the board ---');
gm.emit('map_tile:place', { mode: 'combat', col: 3, row: 4, kind: 'trap' });
await sleep(400);
st = await jf('/api/stage?role=gm');
check('a hand-placed Trap on the Copy’s space leaves the Copy there', tilesAt(3, 4).some((t) => t.kind === 'copy') && tilesAt(3, 4).some((t) => t.kind === 'trap'), JSON.stringify(tilesAt(3, 4)));
gm.emit('fight:next', { mode: 'combat' });
await sleep(3000);
st = await jf('/api/stage?role=gm');
check('the Necromancer’s end of turn: each Copy may Move 1 (asked; declined)', prompts.some((p) => p.kind === 'confirm' && /Necromancer/.test(p.title)), JSON.stringify(prompts.map((p) => [p.kind, p.title])));
check('the End Phase: the Trap destroys the Copy standing on it', !tilesAt(3, 4).some((t) => t.kind === 'copy') && tilesAt(3, 4).some((t) => t.kind === 'trap'), JSON.stringify(tilesAt(3, 4)));
check('…said in the End Phase notice', cards.some((c) => c.payload?.automatic === 'end_phase' && /Copy: Trap, destroyed/.test(c.payload.text)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'end_phase').map((c) => c.payload.text)));
check("Bo's turn: Hidden Style puts Fog on his own space", tilesAt(6, 3).some((t) => t.kind === 'fog') || st.combatTokens.find((t) => t.id === tb.id).col !== 6, JSON.stringify(tilesAt(6, 3)));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

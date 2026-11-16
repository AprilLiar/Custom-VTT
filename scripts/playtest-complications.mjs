// Playtest: Fight Setup's Complications — Uneven Fights (extra HP, bars),
// Guest Heroes (any hero player controls them) and a Three Way Battle (the
// Renegades: a third side and initiative column).
//
//   (start the dev server first)
//   node scripts/playtest-complications.mjs
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
const said = [];
gm.onAny((ev, payload) => said.push(JSON.stringify(payload ?? '')));
gm.on('trigger:prompt', (x) => {
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `CX ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `CX ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `${name}${stamp}`, characterType: type });
const ana = await mk('CXAna', 'pc');
const bo = await mk('CXBo', 'npc');
const rex = await mk('CXRex', 'npc');
const gus = await mk('CXGus', 'npc');
for (const c of [bo, rex, gus]) gm.emit('build:save', { characterId: c.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 6, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: rex.id, col: 6, row: 6 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: gus.id, col: 2, row: 4 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const T = (c) => st.combatTokens.find((t) => t.character_id === c.id);
const [ta, tb, tr, tg] = [T(ana), T(bo), T(rex), T(gus)];
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const set = (change) => gm.emit('battle:set', { mode: 'combat', change });
const p = await connect({ role: 'player', characterId: ana.id });

console.log('\n--- Uneven Fights: the even split ---');
set({ complication: 'uneven_fights' });
await sleep(300);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1, kind: 'hero', bars: 1, extra: 10 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior', bars: 2 }, { ref: { combatantId: tr.id }, level: 1, kind: 'warrior' }, { ref: { combatantId: tg.id }, level: 1, kind: 'warrior', bars: 1 }] });
await sleep(500);
await stage();
const plain = tok(tr.id).fight.hp.max;
check('a hero given the spare bars as HP: +10 on their bar; a Boss given 2 bars', tok(ta.id).fight.hp.max > plain && tok(tb.id).fight.hp.bars === 2, JSON.stringify([tok(ta.id).fight.hp, tok(tb.id).fight.hp, plain]));

console.log('\n--- Guest Heroes ---');
gm.emit('fighter:token', { ref: { combatantId: tg.id }, key: 'power', clear: true });
await sleep(200);
p.emit('fighter:token', { ref: { combatantId: tg.id }, key: 'power', delta: 1 });
await sleep(400);
check("a player can't touch an NPC who isn't a Guest", !(await stage(), tok(tg.id).fight.tokens.power));
set({ complication: 'guest_heroes' });
set({ guest: { id: gus.id, on: true } });
await sleep(500);
check('the GM makes Gus a Guest', (await stage()).activeScene.battle.combat.guests.includes(gus.id), JSON.stringify(st.activeScene.battle.combat));
p.emit('fighter:token', { ref: { combatantId: tg.id }, key: 'power', delta: 1 });
await sleep(400);
check('…and any hero player controls him now', (await stage(), tok(tg.id).fight.tokens.power === 1), JSON.stringify(tok(tg.id).fight.tokens));

console.log('\n--- Three Way Battle ---');
set({ complication: 'three_way' });
await sleep(300);
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }, { combatantId: tg.id }], enemies: [{ combatantId: tb.id }], renegades: [{ combatantId: tr.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(2000);
await stage();
const f = st.fights.combat;
check('the fight has a third side, the Renegades', JSON.stringify(f.renegades) === JSON.stringify([tr.id]), JSON.stringify(f));
check('the turns go Heroes → Enemies → Renegades, then round again', f.order.slice(0, 4).map((e) => e.side).join() === 'allies,enemies,renegades,allies', JSON.stringify(f.order));
gm.emit('fight:end', { mode: 'combat', outcome: 'renegades' });
await sleep(800);
check('End Combat: the Renegades can win', said.some((x) => /The Renegades win/.test(x)), said.slice(-3).join(' | '));

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

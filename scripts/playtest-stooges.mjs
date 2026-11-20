// Playtest: Stooges (decided). The bodies of one unit share one Health Bar,
// tokens and all; a body that loses any HP is destroyed and the HP comes off
// the shared bar; the unit's turn moves to a body still standing; the bar
// empty: the whole unit is defeated. At a new Round the GM places new bodies
// up to the number the unit started with.
//
//   (start the dev server first)
//   node scripts/playtest-stooges.mjs
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
gm.on('trigger:prompt', (x) => {
  prompts.push(x);
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.title === 'Reduce the hit' ? '0' : x.kind === 'square' && /Stooges/.test(x.title) ? x.options[0].id : x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `ST ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `ST ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `STAna${stamp}`, characterType: 'pc' });
const goons = await jpost('/api/characters', { name: `STGoons${stamp}`, characterType: 'npc' });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: goons.id, build: { type: 'character-type.stooges', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 1, row: 1 });
for (const c of [5, 6, 7]) gm.emit('combat_token:place', { ownerType: 'character', ownerId: goons.id, col: c, row: 5 });
await sleep(700);
let st = await jf('/api/stage?role=gm');
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const bodies = st.combatTokens.filter((t) => t.character_id === goons.id).map((t) => t.id).sort((a, b) => a - b);
check('three Stooge bodies placed', bodies.length === 3);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, ...bodies.map((id) => ({ ref: { combatantId: id }, level: 1, kind: 'warrior' }))] });
await sleep(400);
// Give the bodies different HP first: Start Combat ties them to the leader's.
gm.emit('fighter:set_hp', { ref: { combatantId: bodies[2] }, current: 5 });
await sleep(300);
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: bodies.map((id) => ({ combatantId: id })), firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(2000);
await stage();
const hpOf = (id) => tok(id)?.fight.hp;
check('Start Combat: every body shows the one shared bar (the leader\'s)', bodies.every((id) => hpOf(id).current === hpOf(bodies[0]).current && hpOf(id).max === hpOf(bodies[0]).max) && hpOf(bodies[0]).current === hpOf(bodies[0]).max, JSON.stringify(bodies.map(hpOf)));
const max = hpOf(bodies[0]).max;
gm.emit('fighter:token', { ref: { combatantId: bodies[1] }, key: 'power', delta: 2 });
await sleep(500);
await stage();
check('tokens are shared: 2 Power given to one body, every body holds them', bodies.every((id) => tok(id).fight.tokens.power === 2), JSON.stringify(bodies.map((id) => tok(id).fight.tokens)));
gm.emit('fighter:token', { ref: { combatantId: bodies[1] }, key: 'power', clear: true });
await sleep(300);

console.log('\n--- a hit destroys one body; the damage comes off the shared bar ---');
gm.emit('fighter:damage', { ref: { combatantId: bodies[2] }, amount: 3 });
await sleep(2500);
await stage();
check('the body hit for 3 is gone from the map', tok(bodies[2]).col == null, JSON.stringify([tok(bodies[2]).col, tok(bodies[2]).row]));
check('…and the shared bar is down 3 on every body still standing', hpOf(bodies[0]).current === max - 3 && hpOf(bodies[1]).current === max - 3, JSON.stringify(bodies.map(hpOf)));
check('…a card says so', cards.some((c) => c.payload?.title === 'Stooges' && /destroyed/.test(c.payload.text)));
let order = st.fights.combat.order.map((e) => e.id);
check('the unit has one turn, its leading body', order.filter((id) => bodies.includes(id)).length === 1 && order.includes(bodies[0]), JSON.stringify(order));
gm.emit('fighter:damage', { ref: { combatantId: bodies[0] }, amount: 2 });
await sleep(2500);
await stage();
order = st.fights.combat.order.map((e) => e.id);
check('the leader destroyed: the unit\'s turn passes to the next body', tok(bodies[0]).col == null && order.includes(bodies[1]) && !order.includes(bodies[0]), JSON.stringify(order));
check('…bar down 5 in all', hpOf(bodies[1]).current === max - 5, JSON.stringify(hpOf(bodies[1])));

console.log('\n--- a new Round: the GM places new bodies up to the starting three ---');
const next = async () => {
  for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
  await sleep(300);
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(3500);
  for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
  await sleep(800);
};
await next();
await next();
await stage();
const now = st.combatTokens.filter((t) => t.character_id === goons.id && t.col != null);
check('two placement asks, then three bodies on the map again', prompts.filter((x) => /Stooges: place a new one/.test(x.title)).length === 2 && now.length === 3, `${prompts.filter((x) => /Stooges/.test(x.title)).length} asks; ${now.length} on the map`);
check('…the new bodies share the bar', now.every((t) => t.fight.hp.current === max - 5), JSON.stringify(now.map((t) => t.fight.hp)));
check('…and they joined the fight', now.every((t) => st.fights.combat.enemies.includes(t.id)), JSON.stringify(st.fights.combat.enemies));

console.log('\n--- the bar empty: the whole unit is defeated ---');
gm.emit('fighter:damage', { ref: { combatantId: now[0].id }, amount: 30 });
await sleep(2500);
await stage();
const left = st.combatTokens.filter((t) => t.character_id === goons.id && t.col != null);
check('every Stooge still on the map is at 0 (defeated)', left.length === 2 && left.every((t) => t.fight.hp.current <= 0), JSON.stringify(left.map((t) => t.fight.hp)));
check('…a card says the unit is defeated', cards.some((c) => c.payload?.title === 'Stooges' && /defeated/.test(c.payload.text)));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

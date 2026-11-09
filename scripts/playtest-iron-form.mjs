// Playtest: Iron Form, fully automatic — gaining Speed replaces half with
// Iron, Armor triggering gives 1 Iron, and "spend 1 Iron to take 1 less from
// any source (even Reduced Hits)" asked (Ask), never spending Iron already
// spent on the same hit.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-iron-form.mjs
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
// The GM answers everyone's prompts but Ana's (her player does — the first answer wins).
let anaId = null;
gm.on('trigger:prompt', (p) => {
  if (anaId != null && p.characterId === anaId) return;
  const answer = p.kind === 'confirm' ? false : p.kind === 'square' ? [] : p.kind === 'targets' ? [p.options[0].id] : p.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer }), 120);
});
gm.emit('scene:create', { name: `IF ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `IF ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `IFAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `IFBo${stamp}`, characterType: 'npc' });
anaId = ana.id;
const p = await connect({ role: 'player', characterId: ana.id });
const prompts = [];
// Ana's player: yes to Iron Form, 1 Iron when asked to Reduce the hit.
p.on('trigger:prompt', (x) => {
  prompts.push(x);
  const answer = x.title === 'Iron Form' ? true : x.title === 'Reduce the hit' ? '1' : x.kind === 'confirm' ? false : x.kind === 'square' ? [] : x.kind === 'targets' ? [x.options[0].id] : x.options?.[0]?.id;
  setTimeout(() => p.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.iron', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(500);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 4, row: 3 });
await sleep(800);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
const f = async (t) => (await jf('/api/stage?role=gm')).combatTokens.find((x) => x.id === t.id).fight;
const marks = async () => (await jf('/api/dice-marks')).marks;
const clear = async (t, keys) => {
  for (const k of keys) gm.emit('fighter:token', { ref: { combatantId: t.id }, key: k, clear: true });
  await sleep(300);
};

console.log('\n--- Ana’s turn: Speed becomes half Iron ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(3000);
await clear(ta, ['iron', 'speed', 'power']);
const roll = cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === ta.id).at(-1);
const big = [...roll.payload.results.map((r, i) => ({ v: r.result, i }))].sort((a, c) => c.v - a.v)[0];
p.emit('board:place', { rollId: roll.payload.roll_id, die: big.i, actionId: 'action.system-basic-actions.movement' });
await sleep(400);
p.emit('board:commit', { rollId: roll.payload.roll_id });
await sleep(3000);
let fa = await f(ta);
const half = Math.floor(big.v / 2);
check(`Movement with a ${big.v}: ${big.v - half} Speed and ${half} Iron (half, rounded down, replaced)`, (fa.tokens.speed ?? 0) === big.v - half && (fa.tokens.iron ?? 0) === half, JSON.stringify(fa.tokens));

console.log('\n--- damage from any source: Iron Form, then Armor gives Iron ---');
await clear(ta, ['iron', 'speed']);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'iron', delta: 2 });
await sleep(300);
prompts.length = 0;
let hp0 = (await f(ta)).hp.current;
gm.emit('fighter:damage', { ref: { combatantId: ta.id }, amount: 5 });
await sleep(2500);
fa = await f(ta);
// An Action's hit (entered by hand): 5 −1 Iron (Reduce the hit) −1 Iron Form = 3, Armor −3 = 0.
// Iron: 2 −1 −1 +1 (Armor triggered) = 1.
check('Iron Form is offered after Iron already Reduced the hit, and she takes 1 less', prompts.some((x) => x.title === 'Reduce the hit') && prompts.some((x) => x.title === 'Iron Form') && hp0 - fa.hp.current === 0, `${hp0} → ${fa.hp.current}; ${JSON.stringify(prompts.map((x) => x.title))}`);
check('…Armor triggered: +1 Iron (2 −1 −1 +1 = 1)', fa.tokens.iron === 1, JSON.stringify(fa.tokens));
check('…the notice says it', cards.some((c) => /Iron Form −1/.test(c.payload?.text ?? '')), JSON.stringify(cards.slice(-4).map((c) => c.payload?.text)));

console.log('\n--- a Trap: any source ---');
await clear(ta, ['iron']);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'iron', delta: 1 });
gm.emit('map_tile:place', { mode: 'combat', col: 3, row: 3, kind: 'trap' });
await sleep(400);
prompts.length = 0;
hp0 = (await f(ta)).hp.current;
gm.emit('fight:next', { mode: 'combat' });
await sleep(3500);
fa = await f(ta);
// The End Phase Trap: 1 damage (no Iron step for a Trap); Armor was used this turn
// already (its 1st trigger), so Iron Form is asked and spends her 1 Iron.
check('a Trap in the End Phase: Iron Form is asked (no Iron step for a Trap)', prompts.some((x) => x.title === 'Iron Form') && !prompts.some((x) => x.title === 'Reduce the hit'), JSON.stringify(prompts.map((x) => x.title)));
gm.emit('map_tile:remove', { mode: 'combat', col: 3, row: 3, kind: 'trap' });
await sleep(300);

console.log('\n--- Bo’s turn: a Reduced Hit, and no Iron spent twice ---');
st = await jf('/api/stage?role=gm');
if (st.fights.combat.movement_phase) {
  gm.emit('move:skip', { mode: 'combat' });
  await sleep(600);
}
await clear(ta, ['iron']);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'iron', delta: 2 });
await sleep(300);
prompts.length = 0;
hp0 = (await f(ta)).hp.current;
gm.emit('fighter:damage', { ref: { combatantId: ta.id }, amount: 6 });
await sleep(3000);
fa = await f(ta);
// Bo attacks: Reduce the hit (1 Iron) → 5; Iron Form even on a Reduced Hit (her other Iron) → 4; Armor −3 → 1.
check('an attack: Iron reduces the hit, then Iron Form takes 1 more (even a Reduced Hit)', prompts.some((x) => x.title === 'Reduce the hit') && prompts.some((x) => x.title === 'Iron Form') && hp0 - fa.hp.current === 1, `${hp0} → ${fa.hp.current}; ${JSON.stringify(prompts.map((x) => x.title))}`);
check('…both Iron spent once each, then +1 from Armor: 2 −2 +1 = 1', fa.tokens.iron === 1, JSON.stringify(fa.tokens));
await clear(ta, ['iron']);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'iron', delta: 1 });
await sleep(300);
prompts.length = 0;
gm.emit('fighter:damage', { ref: { combatantId: ta.id }, amount: 6 });
await sleep(3000);
fa = await f(ta);
check('with 1 Iron spent on Reducing the hit, Iron Form is not offered (no Iron spent twice)', prompts.some((x) => x.title === 'Reduce the hit') && !prompts.some((x) => x.title === 'Iron Form'), JSON.stringify(prompts.map((x) => x.title)));
check('…and her Iron never goes below what she had', (fa.tokens.iron ?? 0) >= 0, JSON.stringify(fa.tokens));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

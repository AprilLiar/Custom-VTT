// Playtest: the Action Pool changed by rules (full automation, phase H) —
// Judgment Style taking the lowest Action Die of an enemy holding its
// Challenge, the Wardancer's +3/+2/+1 at the start of the Action Phase,
// and Gunkata performing a Gunslinger Action at the start of the turn.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-pool.mjs
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
// Everyone answers with the first option (a square pick: skip).
const answerAll = (s) =>
  s.on('trigger:prompt', (p) => {
    prompts.push(p);
    const answer = p.kind === 'confirm' ? true : p.kind === 'square' ? [] : p.kind === 'targets' ? [p.options[0].id] : p.options?.[0]?.id;
    setTimeout(() => s.emit('trigger:answer', { id: p.id, answer }), 120);
  });
answerAll(gm);
gm.emit('scene:create', { name: `PL ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `PL ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `PL${name}${stamp}`, characterType: type });
const ana = await mk('Ana', 'pc');
const cy = await mk('Cy', 'pc');
const bo = await mk('Bo', 'npc');
const pa = await connect({ role: 'player', characterId: ana.id });
const pc = await connect({ role: 'player', characterId: cy.id });
answerAll(pa);
answerAll(pc);
// Ana: the Wardancer. Cy: Gunkata with Crosshair Style (Take Aim, a Gunslinger Action). Bo: Judgment Style.
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.wardancer', variant: 'focused' }], stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: cy.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.gunkata', variant: 'focused' }], stances: [{ formId: 'form.power', styleId: 'style.crosshair' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.judgment' }] } });
await sleep(500);
for (const [c, col, row] of [[ana, 3, 3], [cy, 3, 6], [bo, 6, 3]]) gm.emit('combat_token:place', { ownerType: 'character', ownerId: c.id, col, row });
await sleep(800);
let st = await jf('/api/stage?role=gm');
const tokOf = (c) => st.combatTokens.find((t) => t.character_id === c.id);
const [ta, tc, tb] = [ana, cy, bo].map(tokOf);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tc.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
// Bo's Challenge on Ana before the fight.
gm.emit('fighter:challenge', { ref: { combatantId: ta.id }, target: { combatantId: tb.id } });
await sleep(400);
const marks = async () => (await jf('/api/dice-marks')).marks;
const rollOf = (t) => cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === t.id).at(-1);
const live = (m) => [...(m.results ?? []).map((r, i) => ({ i, v: r.result, die: r.die, removed: r.removed, changed: r.changed })), ...(m.extra ?? []).map((x, j) => ({ i: (m.results ?? []).length + j, v: x.value, removed: x.removed }))].filter((x) => !x.removed);

console.log('\n--- Ana’s turn: Judgment, then the Wardancer ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }, { combatantId: tc.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(4500);
const roll = rollOf(ta);
const m = (await marks())[roll.payload.roll_id];
const rolled = roll.payload.results;
const left = live(m);
const d4 = rolled.findIndex((r) => r.die === 4);
check('Judgment Style: Ana (holding Bo’s Challenge) loses her lowest Action Die, the d4', d4 >= 0 && m.results[d4].removed && left.length === rolled.length - 1, JSON.stringify([rolled, m.results]));
const raised = left.map((x) => x.v - rolled[x.i].result);
// As the engine picks (everyone answers the first option): +3, +2, +1 each to
// the first number not yet raised that is under 9.
let expected = 0;
{
  const used = new Set();
  for (const amount of [3, 2, 1]) {
    const pick = left.find((x) => !used.has(x.i) && rolled[x.i].result < 9);
    if (!pick) break;
    used.add(pick.i);
    expected += Math.min(9, rolled[pick.i].result + amount) - rolled[pick.i].result;
  }
}
check('the Wardancer: at the start of her Action Phase, her numbers go up by +3 and +2 (the +1 has no number left), never past 9', raised.reduce((a, b) => a + b, 0) === expected && left.every((x) => x.v <= Math.max(9, rolled[x.i].result)), JSON.stringify({ rolled: rolled.map((r) => r.result), now: left.map((x) => x.v), expected }));
check('…changed numbers are marked on the board', left.filter((x) => x.v !== rolled[x.i].result).every((x) => x.changed), JSON.stringify(m.results));
check('…a notice says it', cards.some((c) => c.payload?.automatic === 'ability' && /Wardancer/.test(c.payload.title)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'ability').map((c) => c.payload.title)));

console.log('\n--- Cy’s turn: Gunkata ---');
for (let i = 0; i < 3 && !rollOf(tc); i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(3500);
  st = await jf('/api/stage?role=gm');
  if (st.fights.combat.movement_phase) {
    gm.emit('move:skip', { mode: 'combat' });
    await sleep(800);
  }
}
const gk = cards.find((c) => c.payload?.automatic === 'ability' && /Gunkata/.test(c.payload.title));
check('Gunkata: at the start of Cy’s turn he performs his Gunslinger Action (Take Aim) without paying for it', gk && /performs Take Aim/.test(gk.payload.text), JSON.stringify(cards.filter((c) => c.payload?.automatic?.startsWith('ability')).map((c) => [c.payload.title, c.payload.text])));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, cy, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
for (const s of [gm, pa, pc]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

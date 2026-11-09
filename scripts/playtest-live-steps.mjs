// Playtest: every step shows before the next one (decided) — One-Two Form's
// "before each Action you may Move 1": the picked square is taken, and the
// board (stage:updated) already shows it when the next question comes;
// Relentless' push shows before the pushed fighter's Slasher pull is asked.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-live-steps.mjs
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
gm.emit('scene:create', { name: `LS ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `LS ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `LSAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `LSBo${stamp}`, characterType: 'npc' });
const sly = await jpost('/api/characters', { name: `LSSly${stamp}`, characterType: 'pc' });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.one-two', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: sly.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.slasher' }] } });
await sleep(500);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 4, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: sly.id, col: 4, row: 5 });
await sleep(800);
let st = await jf('/api/stage?role=gm');
const tok = (c) => st.combatTokens.find((t) => t.character_id === c.id);
const [ta, tb, ts] = [ana, bo, sly].map(tok);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: ts.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
// What a viewer sees: the last stage:updated, and where each fighter stood when each prompt came.
const p = await connect({ role: 'player', characterId: ana.id });
let seen = null;
p.on('stage:updated', (x) => (seen = x));
const at = (id) => {
  const t = seen?.combatTokens?.find((x) => x.id === id);
  return t ? `${t.col},${t.row}` : null;
};
const log = [];
let anaPick = null;
p.on('trigger:prompt', (x) => {
  log.push({ title: x.title, kind: x.kind, ana: at(ta.id), sly: at(ts.id) });
  let answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.options?.[0]?.id;
  // Both of One-Two Form's moves (before the Action, after the first one): never back to 3,3.
  if (x.kind === 'square' && /One-Two Form \(Move 1\)/.test(x.title)) {
    anaPick = x.options.find((o) => o.id !== '3,3')?.id;
    answer = anaPick;
  } else if (x.kind === 'square' && x.minimum === 0) answer = [];
  setTimeout(() => p.emit('trigger:answer', { id: x.id, answer }), 150);
});
const ps = await connect({ role: 'player', characterId: sly.id });
ps.on('stage:updated', (x) => (seen = x));
const slyLog = [];
ps.on('trigger:prompt', (x) => {
  slyLog.push({ title: x.title, kind: x.kind, sly: at(ts.id) });
  const answer = x.kind === 'confirm' ? false : x.kind === 'square' && x.minimum === 0 ? [] : x.kind === 'targets' ? [x.options[0].id] : x.options?.[0]?.id;
  setTimeout(() => ps.emit('trigger:answer', { id: x.id, answer }), 150);
});
gm.on('trigger:prompt', (x) => {
  if ([ana.id, sly.id].includes(x.characterId)) return;
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.kind === 'square' && /Push/.test(x.title) ? x.options.find((o) => o.id === '4,6')?.id ?? x.options[0].id : x.kind === 'square' && x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 150);
});

console.log('\n--- One-Two Form: Move 1 before the Action ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }, { combatantId: ts.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(3000);
const roll = cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === ta.id).at(-1);
const rollId = roll.payload.roll_id;
p.emit('board:place', { rollId, die: 0, actionId: 'action.system-basic-actions.damage' });
await sleep(400);
const marks = (await jf('/api/dice-marks')).marks;
if (marks[rollId].placements[0]?.threshold > 1) p.emit('board:stop', { rollId, key: 'd0', stop: 1 });
await sleep(300);
p.emit('board:commit', { rollId });
await sleep(6000);
st = await jf('/api/stage?role=gm');
const first = log.findIndex((x) => /One-Two Form \(Move 1\)/.test(x.title));
check('"you may Move 1" is asked as a square pick named for it: "One-Two Form (Move 1)"', first >= 0, JSON.stringify(log));
check('…the picked square is taken', anaPick && `${tok(ana).col},${tok(ana).row}` !== '3,3', JSON.stringify([anaPick, tok(ana).col, tok(ana).row]));
const after = log.slice(first + 1);
check('…and every later question comes with the board already showing her there', after.length > 0 && after.every((x) => x.ana && x.ana !== '3,3'), JSON.stringify(log));

console.log('\n--- Relentless pushes Sly: the push shows before Slasher asks ---');
for (let i = 0; i < 3; i++) {
  st = await jf('/api/stage?role=gm');
  if (st.fights.combat.order[st.fights.combat.turn_index]?.id === tb.id) break;
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(3000);
  st = await jf('/api/stage?role=gm');
  if (st.fights.combat.movement_phase) {
    gm.emit('move:skip', { mode: 'combat' });
    await sleep(600);
  }
}
gm.emit('combat_token:move', { combatantId: tb.id, col: 4, row: 4 });
await sleep(600);
slyLog.length = 0;
gm.emit('fighter:damage', { ref: { combatantId: ts.id }, amount: 6 });
await sleep(6000);
const slash = slyLog.find((x) => /Slasher/.test(x.title));
check('Slasher’s "you may Pull yourself" is asked after the push, with the board showing Sly pushed already', slash && slash.sly && slash.sly !== '4,5', JSON.stringify(slyLog));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, bo, sly]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
for (const s of [gm, p, ps]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

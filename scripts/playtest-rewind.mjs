// Playtest: GM Rewind (decided) — one step back before the last Action, Free
// Movement or Next turn, everything refunded, up to 5 in a row — and a real
// Interrupt: the interrupted queue waits, then its player keeps all, some or none.
//
//   (start the dev server first)
//   node scripts/playtest-rewind.mjs
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
const failsGm = [];
gm.on('fight:rewind_failed', (x) => failsGm.push(x));
let hold = false;
const held = [];
gm.on('trigger:prompt', (x) => {
  if (hold && x.kind === 'targets') return held.push(x);
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `RW ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `RW ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `${name}${stamp}`, characterType: type });
const ana = await mk('RWAna', 'pc');
const cy = await mk('RWCy', 'pc');
const bo = await mk('RWBo', 'npc');
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.blaster', styleId: 'style.swift' }] } });
gm.emit('build:save', { characterId: cy.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: cy.id, col: 4, row: 4 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 4, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tokOf = (id) => st.combatTokens.find((t) => t.character_id === id);
const [ta, tc, tb] = [tokOf(ana.id), tokOf(cy.id), tokOf(bo.id)];
const f = (id) => st.combatTokens.find((t) => t.id === id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tc.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
const marks = async () => (await jf('/api/dice-marks')).marks;
const DAMAGE = 'action.system-basic-actions.damage';
const SWIFT = 'action.style-swift.swift-strike';
const rollOf = (id) => cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === id).at(-1)?.payload.roll_id;
const fight = () => st.fights.combat;
const doneMoving = async () => {
  for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
  await sleep(400);
};

console.log('\n--- Rewind an Action: everything back, the die free again ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }, { combatantId: tc.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: tc.id } });
await sleep(2200);
await stage();
check('a fresh fight: nothing to rewind yet', (fight().rewind ?? []).length === 0, JSON.stringify(fight().rewind));
const cyRoll = rollOf(tc.id);
const boHp = f(tb.id).fight.hp.current;
gm.emit('board:place', { rollId: cyRoll, die: 0, actionId: DAMAGE });
await sleep(300);
for (const x of (await marks())[cyRoll].placements) if (x.threshold > 1) gm.emit('board:stop', { rollId: cyRoll, key: x.key, stop: 1 });
await sleep(300);
gm.emit('board:commit', { rollId: cyRoll });
await sleep(2500);
await stage();
check('Cy hits Bo; the step is on the Rewind list, named', f(tb.id).fight.hp.current < boHp && fight().rewind?.[0] === `Damage (${cy.name})`, JSON.stringify([boHp, f(tb.id).fight.hp.current, fight().rewind]));
gm.emit('fight:rewind', { mode: 'combat' });
await sleep(1200);
await stage();
const cyBoard = (await marks())[cyRoll];
check('Rewind: Bo’s HP back as it was', f(tb.id).fight.hp.current === boHp, `${boHp} vs ${f(tb.id).fight.hp.current}`);
check('…the die is free again (nothing placed or committed), the board still Cy’s', cyBoard.active && (cyBoard.placements ?? []).length === 0, JSON.stringify(cyBoard.placements));
check('…a card says so; nothing left to rewind', cards.some((c) => c.payload?.title === 'Rewound' && /Damage/.test(c.payload.text)) && (fight().rewind ?? []).length === 0, JSON.stringify(fight().rewind));
gm.emit('fight:rewind', { mode: 'combat' });
await sleep(400);
check('…another Rewind with nothing left is refused with a reason', failsGm.some((x) => /Nothing left/.test(x.error)), JSON.stringify(failsGm));

console.log('\n--- Free Movement and Next turn, rewound in turn ---');
gm.emit('fighter:token', { ref: { combatantId: tc.id }, key: 'speed', delta: 2 });
await sleep(300);
gm.emit('move:free', { combatantId: tc.id, to: { col: 4, row: 5 } });
await sleep(1200);
await stage();
check('Cy moves (1 Speed)', f(tc.id).col === 4 && f(tc.id).row === 5 && f(tc.id).fight.tokens.speed === 1, JSON.stringify([f(tc.id).col, f(tc.id).row, f(tc.id).fight.tokens]));
await doneMoving();
gm.emit('fight:next', { mode: 'combat' });
await sleep(2500);
await doneMoving();
await stage();
const movedOn = fight().order[fight().turn_index]?.id !== tc.id;
check('Next turn: someone else’s turn; the list names both steps, newest first', movedOn && fight().rewind?.[0] === `End of ${cy.name}'s turn` && fight().rewind?.[1] === `Free Movement (${cy.name})`, JSON.stringify(fight().rewind));
gm.emit('fight:rewind', { mode: 'combat' });
await sleep(1500);
await stage();
check('Rewind: back to Cy’s turn, her board active again', fight().order[fight().turn_index]?.id === tc.id && (await marks())[cyRoll]?.active, JSON.stringify([fight().order[fight().turn_index], fight().turn_index]));
gm.emit('fight:rewind', { mode: 'combat' });
await sleep(1200);
await stage();
check('Rewind again: Cy back on her square with her 2 Speed', f(tc.id).col === 4 && f(tc.id).row === 4 && f(tc.id).fight.tokens.speed === 2, JSON.stringify([f(tc.id).col, f(tc.id).row, f(tc.id).fight.tokens]));

console.log('\n--- at most 5 steps back ---');
gm.emit('fighter:token', { ref: { combatantId: tc.id }, key: 'speed', delta: 6 });
await sleep(300);
for (let i = 0; i < 6; i++) {
  gm.emit('move:free', { combatantId: tc.id, to: { col: 4, row: i % 2 ? 4 : 5 } });
  await sleep(900);
}
await stage();
check('six Free Movements: five steps kept', (fight().rewind ?? []).length === 5, JSON.stringify(fight().rewind));
for (let i = 0; i < 5; i++) {
  gm.emit('fight:rewind', { mode: 'combat' });
  await sleep(700);
}
await stage();
check('five Rewinds: Cy where the oldest kept step began (after her first move), 7 Speed', f(tc.id).col === 4 && f(tc.id).row === 5 && f(tc.id).fight.tokens.speed === 7 && !(fight().rewind ?? []).length, JSON.stringify([f(tc.id).col, f(tc.id).row, f(tc.id).fight.tokens, fight().rewind]));

console.log('\n--- an Interrupt; Bo gives up the rest of his queue ---');
const p = await connect({ role: 'player', characterId: ana.id });
const pFails = [];
p.on('dice:pay_failed', (x) => pFails.push(x));
p.on('trigger:prompt', (x) => setTimeout(() => p.emit('trigger:answer', { id: x.id, answer: x.kind === 'targets' ? [x.options[0].id] : x.kind === 'confirm' ? false : x.options?.[0]?.id }), 150));
await doneMoving();
gm.emit('fight:next', { mode: 'combat' });
await sleep(2500);
await doneMoving();
await stage();
for (let g = 0; g < 3 && fight().order[fight().turn_index]?.id !== tb.id; g++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(2500);
  await doneMoving();
}
check('(Bo’s turn)', fight().order[fight().turn_index]?.id === tb.id, JSON.stringify(fight().order[fight().turn_index]));
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'iron', delta: 2 });
await sleep(300);
const boRoll = rollOf(tb.id);
const pool = (await marks())[boRoll].results;
for (let i = 0; i < Math.min(3, pool.length); i++) gm.emit('board:place', { rollId: boRoll, die: i, actionId: DAMAGE });
await sleep(400);
for (const x of (await marks())[boRoll].placements) if (x.threshold > 1) gm.emit('board:stop', { rollId: boRoll, key: x.key, stop: 1 });
await sleep(300);
const placedN = (await marks())[boRoll].placements.length;
hold = true;
gm.emit('board:commit', { rollId: boRoll });
await sleep(1200);
const q = await new Promise((r) => p.emit('react:open', { combatantId: ta.id }, r));
check('Ana presses Interrupt while Bo’s first Action resolves: queued', q.queued === true, JSON.stringify(q));
hold = false;
for (const x of held.splice(0)) {
  gm.emit('trigger:answer', { id: x.id, answer: [String(ta.id)] });
  await sleep(400);
}
await sleep(2000);
await stage();
let bb = (await marks())[boRoll];
check('Bo’s queue stops after that one Action: the Interrupt goes next', bb.placements.filter((x) => x.committed).length === 1 && bb.interrupted && fight().interrupt?.active?.combatantId === ta.id, JSON.stringify([bb.placements.map((x) => x.committed), bb.interrupted, fight().interrupt]));
const rx = (await new Promise((r) => p.emit('react:open', { combatantId: ta.id }, r))).payload?.roll_id;
p.emit('board:place', { rollId: rx, actionId: SWIFT, option: 0, answers: { split: { iron: 2 } } });
await sleep(300);
p.emit('board:commit', { rollId: rx });
await sleep(2500);
bb = (await marks())[boRoll];
check('the Interrupt resolved: Bo’s board asks for the review', bb.review && bb.interrupted, JSON.stringify([bb.review, bb.interrupted, pFails]));
const anaHp = (await stage(), f(ta.id).fight.hp.current);
gm.emit('board:resume', { rollId: boRoll, keep: [] });
await sleep(2000);
await stage();
bb = (await marks())[boRoll];
check(`Give up all: the ${placedN - 1} queued Actions come off — their dice free, nothing done`, bb.placements.length === 1 && bb.placements[0].committed && !bb.interrupted && !bb.review && f(ta.id).fight.hp.current === anaHp, JSON.stringify([bb.placements.length, anaHp, f(ta.id).fight.hp.current]));
check('…a card says so', cards.some((c) => c.payload?.title === 'After the Interrupt' && /gives up/.test(c.payload.text)));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

// Playtest: turn structure and reactions (full automation, phase F) — an
// Action's condition refused (Swift Strike only on enemy turns), a reaction
// window after an Action with the batch paused until Continue, a reaction
// paid with Iron on its own reaction board, Control's Parry negating an
// Action, Heroic Spirit giving a Taken Out fighter's turn to an ally, and
// Taken Out fighters taking no damage.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-reactions.mjs
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
let answerWith = () => undefined;
gm.on('trigger:prompt', (p) => {
  prompts.push(p);
  const pick = answerWith(p);
  const answer = pick !== undefined ? pick : p.kind === 'confirm' ? false : p.kind === 'targets' ? [p.options[0].id] : p.kind === 'square' && p.minimum === 0 ? [] : p.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer }), 120);
});
gm.emit('scene:create', { name: `RX ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `RX ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `RXAna${stamp}`, characterType: 'pc' });
const cy = await jpost('/api/characters', { name: `RXCy${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `RXBo${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: ana.id });
const refusals = [];
p.on('dice:pay_failed', (x) => refusals.push(x));
p.on('trigger:prompt', (x) => setTimeout(() => p.emit('trigger:answer', { id: x.id, answer: x.kind === 'targets' ? [x.options[0].id] : x.kind === 'confirm' ? false : x.kind === 'square' && x.minimum === 0 ? [] : x.options?.[0]?.id }), 150));
// Ana: Blaster + Swift (Swift Strike: 2 Basic tokens, only on enemy turns, once per turn).
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.blaster', styleId: 'style.swift' }] } });
gm.emit('build:save', { characterId: cy.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: cy.id, col: 3, row: 5 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 4, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const tokOf = (id) => st.combatTokens.find((t) => t.character_id === id);
const [ta, tc, tb] = [tokOf(ana.id), tokOf(cy.id), tokOf(bo.id)];
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tc.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const f = (id) => st.combatTokens.find((t) => t.id === id).fight;
const marks = async () => (await jf('/api/dice-marks')).marks;
const DAMAGE = 'action.system-basic-actions.damage';
const SWIFT = 'action.style-swift.swift-strike';

console.log('\n--- Bo acts: a reaction window ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }, { combatantId: tc.id }], enemies: [{ combatantId: tb.id }], firstSide: 'enemies', opener: { combatantId: tb.id } });
await sleep(2000);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'iron', delta: 2 });
await sleep(300);
const boRoll = cards.filter((c) => c.kind === 'stance_roll').at(-1).payload.roll_id;
answerWith = (q) => (q.kind === 'targets' ? [String(ta.id)] : undefined);
gm.emit('board:place', { rollId: boRoll, die: 0, actionId: DAMAGE });
gm.emit('board:place', { rollId: boRoll, die: 1, actionId: DAMAGE });
await sleep(400);
// Stop both at 1+ (Deal 1, no Push), so Ana stays in range whatever the dice.
for (const x of (await marks())[boRoll].placements) if (x.threshold > 1) gm.emit('board:stop', { rollId: boRoll, key: x.key, stop: 1 });
await sleep(300);
gm.emit('board:commit', { rollId: boRoll });
await sleep(2500);
await stage();
let b = (await marks())[boRoll];
const win = st.fights.combat.reaction_window;
check('after the first Action, whoever can react gets a window (Ana: Swift Strike for 2 Iron)', win?.waiting?.includes(ta.id) && win.activeId === tb.id, JSON.stringify(win));
check('…and the batch pauses until Continue', b.paused && b.placements.filter((x) => x.committed).length === 1, JSON.stringify(b.placements.map((x) => x.committed)));
const opened = await new Promise((r) => p.emit('react:open', { combatantId: ta.id }, r));
check('React opens a reaction board with only the reactions on offer, by resource', opened.payload && opened.clusters.some((c) => c.resource === 'tokens' && c.ids.includes(SWIFT)) && !opened.clusters.some((c) => c.ids.includes(DAMAGE) && c.resource === 'tokens'), JSON.stringify(opened));
const rx = opened.payload.roll_id;
p.emit('board:place', { rollId: rx, actionId: DAMAGE, option: 0, answers: {} });
await sleep(300);
check('…an Action not on offer is refused there', refusals.some((x) => /not an Action/.test(x.error)), JSON.stringify(refusals));
const boHp = f(tb.id).hp.current;
p.emit('board:place', { rollId: rx, actionId: SWIFT, option: 0, answers: { split: { iron: 2 } } });
await sleep(300);
p.emit('board:commit', { rollId: rx });
await sleep(2500);
await stage();
check('the reaction is performed: Swift Strike hits Bo, the Iron is paid', f(tb.id).hp.current < boHp && !f(ta.id).tokens.iron, `${boHp} → ${f(tb.id).hp.current}; ${JSON.stringify(f(ta.id).tokens)}`);
check('…and Ana is done reacting in this window', !(st.fights.combat.reaction_window?.waiting ?? []).includes(ta.id) && !(await marks())[rx].active, JSON.stringify(st.fights.combat.reaction_window));
gm.emit('board:commit', { rollId: boRoll });
await sleep(2500);
b = (await marks())[boRoll];
check('Continue performs the rest', b.placements.every((x) => x.committed) && !b.paused, JSON.stringify(b.placements));

console.log('\n--- Ana’s turn: a condition, then a Parry ---');
gm.emit('fight:next', { mode: 'combat' });
await sleep(2500);
await stage();
const anaTurn = st.fights.combat.order[st.fights.combat.turn_index]?.id === ta.id;
if (!anaTurn) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(2500);
  await stage();
}
const anaRoll = cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === ta.id).at(-1)?.payload.roll_id;
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'iron', delta: 2 });
gm.emit('fighter:token', { ref: { combatantId: tb.id }, key: 'control', delta: 3 });
await sleep(400);
refusals.length = 0;
p.emit('board:place', { rollId: anaRoll, actionId: SWIFT, option: 0, answers: { split: { iron: 2 } } });
await sleep(400);
check("an Action's condition is enforced: Swift Strike only during an enemy's turn", refusals.some((x) => /only during an enemy's turn/.test(x.error)), JSON.stringify(refusals));
prompts.length = 0;
answerWith = (q) => (q.title === 'Control' ? 'parry' : undefined);
const anaHp = f(ta.id).hp.current;
const boHp2 = f(tb.id).hp.current;
p.emit('board:place', { rollId: anaRoll, die: 0, actionId: DAMAGE });
await sleep(300);
for (const x of (await marks())[anaRoll].placements) if (x.threshold > 1) p.emit('board:stop', { rollId: anaRoll, key: x.key, stop: 1 });
await sleep(300);
p.emit('board:commit', { rollId: anaRoll });
await sleep(3000);
await stage();
check('Control: Bo (in range, 3 Control) is asked; a Parry negates it and deals Ana 2', prompts.some((q) => q.title === 'Control' && q.options.some((o) => o.id === 'parry')) && f(tb.id).hp.current === boHp2 && f(ta.id).hp.current === anaHp - 2 && !f(tb.id).tokens.control, JSON.stringify([boHp2, f(tb.id).hp.current, anaHp, f(ta.id).hp.current, f(tb.id).tokens]));

console.log('\n--- Taken Out, Heroic Spirit ---');
gm.emit('fighter:hp', { ref: { combatantId: tc.id }, delta: -99 });
await sleep(300);
await stage();
gm.emit('fighter:damage', { ref: { combatantId: tc.id }, amount: 3 });
await sleep(1500);
check('a fighter at 0 HP takes no damage', cards.some((c) => c.payload?.automatic === 'damage' && /Taken Out: no damage/.test(c.payload.text)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'damage').map((c) => c.payload.text).slice(-2)));
prompts.length = 0;
answerWith = (q) => (q.title === 'Heroic Spirit' ? [String(ta.id)] : undefined);
for (let i = 0; i < 4; i++) {
  await stage();
  if (st.fights.combat.order[st.fights.combat.turn_index]?.id === tc.id) break;
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(2500);
}
await sleep(1500);
const cyRoll = cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === tc.id).at(-1)?.payload.roll_id;
const heroic = (await marks())[cyRoll]?.heroic;
check("Cy's turn while Taken Out: Heroic Spirit asks, and the dice go to Ana", prompts.some((q) => q.title === 'Heroic Spirit') && heroic?.combatantId === ta.id, JSON.stringify([prompts.map((q) => q.title), heroic]));
refusals.length = 0;
p.emit('board:place', { rollId: cyRoll, die: 0, actionId: DAMAGE });
await sleep(400);
check('…and Ana may use them', (await marks())[cyRoll].placements.length === 1 && !refusals.length, JSON.stringify([refusals, (await marks())[cyRoll].placements]));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, cy, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

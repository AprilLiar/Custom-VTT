// Playtest: Fight Setup's Tilted Parameters — setting them (GM only, one per
// side), Too Slow, Weakened State, Overwhelming Power, Enraged, Keep 'Em Coming
// (once), Handcuffs (the partner pulled along) and Chained Down (the Wall).
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-tilts.mjs
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
  const answer = x.kind === 'confirm' ? true : x.kind === 'targets' ? [x.options[0].id] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `TL ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `TL ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `TLAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `TLBo${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: ana.id });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 4, row: 2 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const battle = async () => (await stage()).activeScene.battle.combat;
const set = (who, change) => who.emit('battle:set', { mode: 'combat', change });
const clear = (id) => ['power', 'iron', 'speed', 'burning', 'weakness', 'fatigue'].forEach((k) => gm.emit('fighter:token', { ref: { combatantId: id }, key: k, clear: true }));
const rolls = () => cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === ta.id);
const notices = (title) => cards.filter((c) => c.payload?.title === title);

console.log('\n--- setting them ---');
set(p, { tilt: { side: 'allies', key: 'too_slow' } });
await sleep(300);
check('only the GM sets a Battle Parameter', (await battle()).tilts.allies === null, JSON.stringify((await battle()).tilts));
set(gm, { tilt: { side: 'allies', key: 'too_slow' } });
set(gm, { tilt: { side: 'enemies', key: 'weakened_state' } });
set(gm, { arena: 'cage_match' });
set(gm, { arena: 'trick_room' });
set(gm, { victory: 'king_of_the_hill' });
await sleep(400);
let b = await battle();
check('a Tilt per side; one Outside-replacing Arena Parameter at a time; the Victory', b.tilts.allies === 'too_slow' && b.tilts.enemies === 'weakened_state' && JSON.stringify(b.arena) === '["trick_room"]' && b.victory === 'king_of_the_hill', JSON.stringify(b));
set(gm, { arena: 'trick_room' });
set(gm, { victory: 'last_one_standing' });
await sleep(300);

console.log('\n--- Too Slow, Weakened State ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(1800);
const slowCount = rolls().at(-1)?.payload.results.length;
check('Too Slow: the active character discards their lowest die (a notice says which)', notices('Too Slow').length === 1 && /discards their lowest die \(d\d+\)/.test(notices('Too Slow')[0].payload.text), JSON.stringify(notices('Too Slow').map((c) => c.payload.text)));
clear(tb.id);
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(2200);
await stage();
let fb = tok(tb.id).fight.tokens;
check("Weakened State: at the start of their side's turn, +1 Burning, Weakness, Fatigue", fb.burning === 1 && fb.weakness >= 1 && fb.fatigue === 1, JSON.stringify(fb));

console.log('\n--- Overwhelming Power, Enraged ---');
set(gm, { tilt: { side: 'allies', key: null } });
set(gm, { tilt: { side: 'enemies', key: 'overwhelming_power' } });
await sleep(300);
for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
clear(ta.id);
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(2200);
check('Too Slow off: the next roll has one die more', rolls().at(-1)?.payload.results.length === slowCount + 1, `${slowCount} → ${rolls().at(-1)?.payload.results.length}`);
const op = notices('Tilted Parameter').filter((c) => /Overwhelming Power/.test(c.payload.text));
check("Overwhelming Power: the other side's active unit gains 1 Power, 1 Iron, 1 Speed", op.length === 1 && op[0].payload.text.includes(ana.name), JSON.stringify(notices('Tilted Parameter').map((c) => c.payload.text)));
set(gm, { tilt: { side: 'enemies', key: 'enraged' } });
await sleep(300);
gm.emit('fighter:damage', { ref: { combatantId: tb.id }, amount: 2 });
await sleep(1500);
await stage();
check("Enraged: dealt damage by an enemy, they take that enemy's Challenge", tok(tb.id).fight.challenge_id === ta.id, JSON.stringify(tok(tb.id).fight));

console.log("\n--- Keep 'Em Coming ---");
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'burning', delta: 3 });
await sleep(300);
const hpA = tok(ta.id).fight.hp.current;
set(gm, { tilt: { side: 'allies', key: 'keep_em_coming' } });
await sleep(800);
await stage();
check("Keep 'Em Coming, set mid-fight: half the bar's HP and half the Burning, rounded up", tok(ta.id).fight.hp.current === Math.ceil(hpA / 2) && tok(ta.id).fight.tokens.burning === 2, `${hpA} → ${JSON.stringify(tok(ta.id).fight)}`);
set(gm, { tilt: { side: 'allies', key: 'keep_em_coming' } });
await sleep(500);
await stage();
check('…once: setting it again does nothing more', tok(ta.id).fight.hp.current === Math.ceil(hpA / 2), JSON.stringify(tok(ta.id).fight.hp));

console.log('\n--- Handcuffs ---');
set(gm, { tilt: { side: 'allies', key: 'handcuffs' } });
set(gm, { cuff: [ta.id, tb.id] });
await sleep(300);
check('the GM pairs them', JSON.stringify((await battle()).cuffs) === JSON.stringify([[ta.id, tb.id]]), JSON.stringify((await battle()).cuffs));
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 6 });
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(2200);
await stage();
const phase = st.fights.combat.movement_phase;
check("Early Movement on Bo's turn waits for Ana", phase?.waiting?.includes(ta.id), JSON.stringify(phase));
p.emit('move:free', { combatantId: ta.id, to: { col: 1, row: 2 } });
await sleep(1500);
await stage();
check('Ana walks away: Bo, cuffed to her, is pulled until adjacent', `${tok(ta.id).col},${tok(ta.id).row}` === '1,2' && `${tok(tb.id).col},${tok(tb.id).row}` === '2,2', `${tok(ta.id).col},${tok(ta.id).row} / ${tok(tb.id).col},${tok(tb.id).row}`);
check('…and a notice says so', notices('Handcuffs').some((c) => /pulled 2 spaces/.test(c.payload.text)), JSON.stringify(notices('Handcuffs').map((c) => c.payload.text)));
p.emit('move:done', { combatantId: ta.id });
await sleep(500);

console.log('\n--- Chained Down ---');
set(gm, { tilt: { side: 'enemies', key: 'chained_down' } });
await sleep(1500);
b = await battle();
const wall = b.chains[tb.id];
const tiles = st.tiles?.combat ?? [];
check("Chained Down mid-fight: Bo's controller places his Wall next to him", wall && Math.abs(wall.col - tok(tb.id).col) + Math.abs(wall.row - tok(tb.id).row) === 1 && prompts.some((x) => /Chained Down/.test(x.title ?? '')), JSON.stringify({ wall, tiles, titles: prompts.map((x) => x.title) }));
check('…a Wall stands there', tiles.some((t) => t.col === wall?.col && t.row === wall?.row && (t.kinds ?? [t.kind]).includes('wall')), JSON.stringify(tiles));
set(gm, { tilt: { side: 'enemies', key: null } });
await sleep(400);
check('Chained Down off: the chain is gone (the Wall stays a Wall)', !(await battle()).chains[tb.id], JSON.stringify((await battle()).chains));

console.log('\n--- the dice board shows Range 1 while Disarmed ---');
set(gm, { tilt: { side: 'allies', key: 'disarmed' } });
set(gm, { tilt: { side: 'enemies', key: 'disarmed' } });
await sleep(300);
for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(2200);
const lastRoll = cards.filter((c) => c.kind === 'stance_roll').at(-1)?.payload.roll_id;
const boardNow = (await jf('/api/dice-marks')).marks[lastRoll];
check("Disarmed: the turn's board is flagged, so it shows Range 1", boardNow?.disarmed === true, JSON.stringify(boardNow && { disarmed: boardNow.disarmed }));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

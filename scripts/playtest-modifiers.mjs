// Playtest: modifiers and durations (full automation, phase G) — Caged Style
// stopping an adjacent enemy's Free Movement, Zombie Style's Copy dealing
// damage at the end of its turn and avenging its destruction, Brawling Style's
// "end of a turn you took damage", Scrambling Style's Speed floor in the End
// Phase, and Quickdraw's extra d6 in the turn's roll.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-modifiers.mjs
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
// The GM answers: the Zombie's Copy at (4,3); a damage target — the Copy if offered.
gm.on('trigger:prompt', (p) => {
  prompts.push(p);
  let answer = p.kind === 'confirm' ? true : p.kind === 'targets' ? [p.options[0].id] : p.options?.[0]?.id;
  if (p.kind === 'square' && /Zombie/.test(p.title)) answer = p.options.some((o) => o.id === '4,3') ? '4,3' : p.options[0]?.id;
  const copyOpt = p.options?.find((o) => String(o.id).startsWith('copy:'));
  if (copyOpt && p.kind === 'targets') answer = [copyOpt.id];
  else if (copyOpt) answer = copyOpt.id;
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer }), 120);
});
gm.emit('scene:create', { name: `MD ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `MD ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `MD${name}${stamp}`, characterType: type });
const ana = await mk('Ana', 'pc');
const bo = await mk('Bo', 'npc');
const cy = await mk('Cy', 'npc');
const eve = await mk('Eve', 'npc');
const fay = await mk('Fay', 'npc');
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.zombie' }] } });
const warrior = (styleId) => ({ type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId }] });
gm.emit('build:save', { characterId: bo.id, build: warrior('style.caged') });
gm.emit('build:save', { characterId: cy.id, build: warrior('style.scrambling') });
gm.emit('build:save', { characterId: eve.id, build: warrior('style.brawling') });
gm.emit('build:save', { characterId: fay.id, build: warrior('style.quickdraw') });
await sleep(500);
const spots = [
  [ana, 3, 3],
  [bo, 6, 6],
  [cy, 8, 8],
  [eve, 1, 8],
  [fay, 8, 1],
];
for (const [c, col, row] of spots) gm.emit('combat_token:place', { ownerType: 'character', ownerId: c.id, col, row });
await sleep(800);
let st = await jf('/api/stage?role=gm');
const tokOf = (c) => st.combatTokens.find((t) => t.character_id === c.id);
const [ta, tb, tc, te, tf] = [ana, bo, cy, eve, fay].map(tokOf);
gm.emit('fight:preset_weight', {
  mode: 'combat',
  weight: 'middle',
  fighters: [{ ref: { combatantId: ta.id }, level: 1 }, ...[tb, tc, te, tf].map((t) => ({ ref: { combatantId: t.id }, level: 1, kind: 'warrior' }))],
});
await sleep(400);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const fightOf = (id) => tok(id).fight;
const reach = (combatantId) => new Promise((r) => gm.emit('move:reach', { combatantId }, r));
const activeId = () => st.fights.combat.order[st.fights.combat.turn_index]?.id;
const copies = () => st.tiles.combat.filter((t) => t.kind === 'copy');
// Whatever Early Movement opens, the GM skips it.
const skipPhase = async () => {
  await stage();
  if (st.fights.combat.movement_phase) {
    gm.emit('move:skip', { mode: 'combat' });
    await sleep(800);
    await stage();
  }
};

console.log('\n--- Ana’s turn (Zombie Style) ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [tb, tc, te, tf].map((t) => ({ combatantId: t.id })), firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(3500);
await skipPhase();
check('the start of the fight: a lasting rule the engine leaves to people is said once, with its rules text (Caged Style, for Bo)', cards.some((c) => c.payload?.automatic === 'ability_manual' && c.payload.title === 'Caged Style — by hand all fight' && /Action Movement they would take is reduced to zero/.test(c.payload.text) && c.payload.fighters?.[0]?.name === `MDBo${stamp}`), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'ability_manual').map((c) => [c.payload.title, c.payload.text])));
check('Zombie Style: a Copy placed at the start of her turn, where picked', copies().some((c) => c.col === 4 && c.row === 3 && c.owner_id === ta.id), JSON.stringify(copies()));

// Bo (Caged Style) steps next to her — and next to her Copy.
gm.emit('combat_token:move', { combatantId: tb.id, col: 4, row: 4 });
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 2 });
await sleep(600);
const r = await reach(ta.id);
check('Caged Style: the adjacent enemy holds Speed but has no Free Movement', !r.error && r.speed === 2 && r.options.length === 0 && r.swaps.length === 0, JSON.stringify(r));

// Eve (Brawling Style) is hit during Ana's turn.
await stage();
const eveHp = fightOf(te.id).hp.current;
gm.emit('fighter:damage', { ref: { combatantId: te.id }, amount: 1 });
await sleep(1500);
await stage();
check('…Eve takes the hit', fightOf(te.id).hp.current === eveHp - 1, `${eveHp} → ${fightOf(te.id).hp.current}`);
for (const t of [tb, tc]) gm.emit('fighter:token', { ref: { combatantId: t.id }, key: 'speed', delta: 4 });
await sleep(400);
await stage();
const boHp = fightOf(tb.id).hp.current;

console.log('\n--- the end of Ana’s turn ---');
gm.emit('fight:next', { mode: 'combat' });
await sleep(3500);
await stage();
check('Zombie Style: 1 damage to each enemy adjacent to her Copy (Bo), not the others', fightOf(tb.id).hp.current === boHp - 1 && fightOf(tc.id).hp.current === fightOf(tc.id).hp.max, `Bo ${boHp} → ${fightOf(tb.id).hp.current}`);
check('Brawling Style: the end of a turn she took damage — Shield 2', fightOf(te.id).tokens.shield === 2, JSON.stringify(fightOf(te.id).tokens));
check('Brawling never fires for those not hit (Fay)', !fightOf(tf.id).tokens.shield, JSON.stringify(fightOf(tf.id).tokens));
check('End Phase Speed: Bo discards 3 of 4; Scrambling Style keeps Cy at 2', fightOf(tb.id).tokens.speed === 1 && fightOf(tc.id).tokens.speed === 2, JSON.stringify([fightOf(tb.id).tokens, fightOf(tc.id).tokens]));
check('…said in the End Phase notice', cards.some((c) => c.payload?.automatic === 'end_phase' && new RegExp(`MDCy${stamp} 2`).test(c.payload.text)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'end_phase').map((c) => c.payload.text)));

console.log('\n--- round the table to Bo ---');
await skipPhase();
for (let i = 0; i < 6 && activeId() !== tb.id; i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(2500);
  await skipPhase();
}
check('Bo is the active fighter', activeId() === tb.id, JSON.stringify(st.fights.combat.order));
const rollOf = (t) => cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === t.id).at(-1);
const boRoll = rollOf(tb);

console.log('\n--- Bo destroys the Copy ---');
await stage();
const boHp2 = fightOf(tb.id).hp.current;
const rollId = boRoll.payload.roll_id;
const DAMAGE = 'action.system-basic-actions.damage';
const big = [...boRoll.payload.results.map((x, i) => ({ v: x.result, i }))].sort((a, c) => c.v - a.v)[0];
gm.emit('board:place', { rollId, die: big.i, actionId: DAMAGE });
await sleep(400);
const marks = (await jf('/api/dice-marks')).marks;
if (marks[rollId]?.placements?.[0]?.threshold > 1) gm.emit('board:stop', { rollId, key: `d${big.i}`, stop: 1 });
await sleep(300);
gm.emit('board:commit', { rollId });
await sleep(4000);
await stage();
check('the Copy is destroyed by his damage', !copies().length, JSON.stringify(copies()));
check('Zombie Style: an enemy destroyed her Copy — she deals 1 damage to him', fightOf(tb.id).hp.current === boHp2 - 1, `${boHp2} → ${fightOf(tb.id).hp.current}`);
check('…a notice tells it', cards.some((c) => c.payload?.automatic === 'ability' && /Zombie/.test(c.payload.title) && /deals 1 damage/.test(c.payload.text)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'ability').map((c) => [c.payload.title, c.payload.text])));

console.log('\n--- Fay’s turn (Quickdraw) ---');
for (let i = 0; i < 6 && !rollOf(tf); i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(2500);
  await skipPhase();
}
const fayRoll = rollOf(tf);
check('Quickdraw: Fay’s turn rolls one more die (a d6) than the same Form without it', fayRoll && fayRoll.payload.results.length === boRoll.payload.results.length + 1 && fayRoll.payload.results.some((x) => x.die === 6), JSON.stringify([fayRoll?.payload.results, boRoll.payload.results]));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, bo, cy, eve, fay]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

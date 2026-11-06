// Playtest: Super Moves on the board (full automation, phase I; decided: all
// limits enforced) — refused in Round 1, paid with two matching numbers of 3+
// (the board pairs them), performed on Commit, then refused for the rest of
// the fight.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-supers.mjs
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
const refusals = [];
gm.on('dice:pay_failed', (x) => refusals.push(x.error));
gm.on('trigger:prompt', (p) => {
  const answer = p.kind === 'confirm' ? false : p.kind === 'square' ? [] : p.kind === 'targets' ? [p.options[0].id] : p.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer }), 120);
});
gm.emit('scene:create', { name: `SM ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `SM ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `SMAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `SMBo${stamp}`, characterType: 'npc' });
const PILEDRIVER = 'super-move.archetype-angel.heavens-piledriver';
// Ana: Thorns Form (a fixed 5 and three d6 — a pair comes often) with Heaven's Piledriver.
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.angel', variant: 'focused' }], stances: [{ formId: 'form.thorns', styleId: 'style.halcyon' }], superMoveIds: [PILEDRIVER] } });
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
const marks = async () => (await jf('/api/dice-marks')).marks;
const rollOf = (t) => cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === t.id).at(-1);
const hpOf = async (t) => (await jf('/api/stage?role=gm')).combatTokens.find((x) => x.id === t.id).fight.hp.current;
const pairIn = (results) => {
  for (let i = 0; i < results.length; i++) for (let j = i + 1; j < results.length; j++) if (results[i].result >= 3 && results[i].result === results[j].result) return i;
  return null;
};
const toAnasTurn = async () => {
  for (let k = 0; k < 4; k++) {
    gm.emit('fight:next', { mode: 'combat' });
    await sleep(2500);
    st = await jf('/api/stage?role=gm');
    if (st.fights.combat.movement_phase) {
      gm.emit('move:skip', { mode: 'combat' });
      await sleep(600);
      st = await jf('/api/stage?role=gm');
    }
    if (st.fights.combat.order[st.fights.combat.turn_index]?.id === ta.id) return;
  }
};

console.log('\n--- Round 1 ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(3000);
let roll = rollOf(ta);
gm.emit('board:place', { rollId: roll.payload.roll_id, die: 0, actionId: PILEDRIVER });
await sleep(500);
check('Round 1: a Super Move is refused', refusals.some((e) => /Round 1/.test(e)), JSON.stringify(refusals));
check('…the board offers it (listed for the turn)', !refusals.some((e) => /not an Action this turn can use/.test(e)), JSON.stringify(refusals));

console.log('\n--- a later Round, with a pair ---');
let i = null;
for (let tries = 0; tries < 10; tries++) {
  await toAnasTurn();
  roll = rollOf(ta);
  i = pairIn(roll.payload.results);
  if (i != null) break;
}
check('a turn of Ana’s from Round 2 on with two matching numbers of 3+', i != null && st.fights.combat.round > 1, JSON.stringify(roll?.payload.results));
const rollId = roll.payload.roll_id;
// A number with no match is refused.
const lone = roll.payload.results.findIndex((r) => !(r.result >= 3) || roll.payload.results.filter((x) => x.result === r.result).length === 1);
if (lone >= 0) {
  refusals.length = 0;
  gm.emit('board:place', { rollId, die: lone, actionId: PILEDRIVER });
  await sleep(500);
  check('…a number without a match (or under 3) is refused', refusals.some((e) => /two matching numbers/.test(e)), JSON.stringify(refusals));
}
gm.emit('board:place', { rollId, die: i, actionId: PILEDRIVER });
await sleep(500);
const placed = (await marks())[rollId].placements.find((p) => p.kind === 'super');
check('placed with its pair: two matching numbers, both held by the Super Move', placed && placed.dice.length === 2 && roll.payload.results[placed.dice[0]].result === roll.payload.results[placed.dice[1]].result, JSON.stringify(placed));
const hp0 = await hpOf(tb);
gm.emit('board:commit', { rollId });
await sleep(3500);
const hp1 = await hpOf(tb);
check('Commit: Heaven’s Piledriver deals 6 to the adjacent enemy', hp0 - hp1 === 6, `${hp0} → ${hp1}`);
check('…its notice', cards.some((c) => c.payload?.automatic?.startsWith('action') && /Piledriver/.test(c.payload.title)), JSON.stringify(cards.filter((c) => c.payload?.automatic?.startsWith('action')).map((c) => c.payload.title)));

console.log('\n--- once per fight ---');
await toAnasTurn();
roll = rollOf(ta);
refusals.length = 0;
gm.emit('board:place', { rollId: roll.payload.roll_id, die: 0, actionId: PILEDRIVER });
await sleep(500);
check('her next turn: refused, once per fight', refusals.some((e) => /once per fight/.test(e)), JSON.stringify(refusals));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

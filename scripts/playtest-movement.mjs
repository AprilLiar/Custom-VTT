// Playtest: the board and movement (full automation, phase D) — Early
// Movement waiting for a Speed holder (Commit held back meanwhile), Free
// Movement's reach and cost, a push from an Ability with the landing picked
// as a square, World of Cardboard (a Wall smashed into Rubble, with Fatigue),
// the Outside off the map's edge, Late Movement on End turn, and the GM's Skip.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-movement.mjs
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
// The GM answers prompts as the test says (`answerWith`), else the first option.
let answerWith = null;
gm.on('trigger:prompt', (p) => {
  prompts.push(p);
  const pick = typeof answerWith === 'function' ? answerWith(p) : undefined;
  const answer = pick !== undefined ? pick : p.kind === 'confirm' ? true : p.kind === 'targets' ? [p.options[0].id] : p.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer }), 120);
});
const gmRefusals = [];
gm.on('dice:pay_failed', (x) => gmRefusals.push(x));
gm.emit('scene:create', { name: `MV ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `MV ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `MVAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `MVBo${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: ana.id });
// Bo (an NPC): Relentless Style ("After you deal damage, Push 1"). Ana: a hero.
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 2 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const at = (id) => `${tok(id).col},${tok(id).row}`;
const reach = (s, combatantId) => new Promise((r) => s.emit('move:reach', { combatantId }, r));

console.log('\n--- Early Movement ---');
// Ana opens; then Speed for her (6: her End Phase discards 3), and Bo's turn:
// she may move in its Early Movement.
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(1500);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 6 });
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(2000);
await stage();
let phase = st.fights.combat.movement_phase;
check('Early Movement opens for the other fighter holding Speed', phase?.kind === 'early' && phase.waiting.join() === String(ta.id) && phase.activeId === tb.id, JSON.stringify(phase));
const roll = cards.filter((c) => c.kind === 'stance_roll').at(-1);
const rollId = roll?.payload.roll_id;
gm.emit('board:place', { rollId, die: 0, actionId: 'action.system-basic-actions.damage' });
await sleep(300);
gm.emit('board:commit', { rollId });
await sleep(500);
check("…and the active fighter can't Commit until it's over", gmRefusals.some((x) => /finished moving/.test(x.error)), JSON.stringify(gmRefusals));
gm.emit('board:unplace', { rollId, key: 'd0' });
check("…nor move: it isn't their opportunity", (await reach(gm, tb.id)).error === 'not now');
check("a player can't move someone they don't control", (await reach(p, tb.id)).error === 'not now');
const r = await reach(p, ta.id);
const cost = (id) => r.options?.find((o) => o.id === id)?.cost;
check('Free Movement reach: 1 per lateral space, a diagonal is 2 (the diamond grid), within the Speed held', cost('4,2') === 1 && cost('5,2') === 2 && cost('4,3') === 2 && cost('6,2') === 3 && cost('5,4') === undefined, JSON.stringify(r));
check('…never onto an occupied space or off the map', cost('2,2') === undefined && !(r.options ?? []).some((o) => o.col < 1 || o.row < 1));
p.emit('move:free', { combatantId: ta.id, to: { col: 5, row: 2 } });
await sleep(800);
await stage();
check('moving there costs its Speed (2), paid after', at(ta.id) === '5,2' && tok(ta.id).fight.tokens.speed === 1, `${at(ta.id)} ${JSON.stringify(tok(ta.id).fight.tokens)}`);
// The back arrow (batch 3): take it back — the square and the Speed.
const r2 = await reach(p, ta.id);
check('the move can be taken back (the back arrow shows)', r2.canUndo === true, JSON.stringify(r2.canUndo));
const undone = await new Promise((res) => p.emit('move:undo', { combatantId: ta.id }, res));
await stage();
check('…taken back: where she stood, the 2 Speed refunded', undone.ok && at(ta.id) === '3,2' && tok(ta.id).fight.tokens.speed === 3, `${JSON.stringify(undone)} ${at(ta.id)} ${JSON.stringify(tok(ta.id).fight.tokens)}`);
check('…and nothing more to take back', (await reach(p, ta.id)).canUndo === false);
p.emit('move:free', { combatantId: ta.id, to: { col: 5, row: 2 } });
await sleep(800);
await stage();
p.emit('move:done', { combatantId: ta.id });
await sleep(500);
await stage();
check('Done: the phase is over', st.fights.combat.movement_phase == null);

console.log('\n--- a push, picked as a square ---');
prompts.length = 0;
answerWith = (q) => (q.kind === 'square' && q.title === 'Save yourself' ? [] : q.kind === 'square' ? '6,2' : undefined);
gm.emit('fighter:damage', { ref: { combatantId: ta.id }, amount: 1 });
await sleep(2000);
await stage();
const pushPick = prompts.find((q) => q.kind === 'square' && q.title !== 'Save yourself');
check('Relentless pushes after the damage: a square pick of the spaces 1 farther (the diamond: lateral steps)', pushPick && pushPick.mode === 'combat' && pushPick.options.map((o) => o.id).sort().join(' ') === '5,1 5,3 6,2', JSON.stringify(pushPick?.options?.map((o) => o.id)));
check("…asked of the pusher's controller (the GM, for an NPC); the target lands where picked", pushPick?.characterId === bo.id && at(ta.id) === '6,2', at(ta.id));

console.log('\n--- World of Cardboard ---');
for (const row of [2, 3, 4]) gm.emit('map_tile:place', { mode: 'combat', col: 7, row, kind: 'wall' });
await sleep(400);
prompts.length = 0;
answerWith = (q) => (q.kind === 'square' && q.title === 'Save yourself' ? [] : q.kind === 'square' ? '7,2' : undefined);
gm.emit('fighter:damage', { ref: { combatantId: ta.id }, amount: 1 });
await sleep(2000);
await stage();
const kinds = st.tiles.combat.filter((t) => t.col === 7 && t.row === 2).map((t) => t.kind);
check('pushed into a Wall: it becomes Rubble and they stand in it', at(ta.id) === '7,2' && kinds.includes('rubble') && !kinds.includes('wall'), `${at(ta.id)} ${JSON.stringify(kinds)}`);
check('…offered to Save themselves (they hold Speed), declined: +1 Fatigue', prompts.some((q) => q.title === 'Save yourself') && tok(ta.id).fight.tokens.fatigue === 1, JSON.stringify(tok(ta.id).fight.tokens));

console.log('\n--- the Outside ---');
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', clear: true });
gm.emit('combat_token:move', { combatantId: ta.id, col: 8, row: 6 });
await sleep(500);
answerWith = null;
gm.emit('fighter:damage', { ref: { combatantId: ta.id }, amount: 1 });
await sleep(2000);
await stage();
const out = tok(ta.id);
check('pushed off the edge they stood on: removed from play, Dizzy', out && out.col == null && out.fight.hp.dizzy === true, JSON.stringify([out?.col, out?.fight.hp]));
check('a movement notice tells it', cards.some((c) => c.payload?.automatic === 'movement' && /goes Outside/.test(c.payload.text)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'movement').map((c) => c.payload.text)));
gm.emit('combat_token:move', { combatantId: ta.id, col: 6, row: 6 });
await sleep(400);

console.log('\n--- Late Movement ---');
gm.emit('fighter:token', { ref: { combatantId: tb.id }, key: 'speed', delta: 2 });
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 1 });
await sleep(300);
const rb = await reach(gm, tb.id);
check('the active fighter may move before each Action', !rb.error && rb.options.some((o) => o.id === '2,4' && o.cost === 2), JSON.stringify(rb));
gm.emit('board:end_turn', { rollId });
await sleep(800);
await stage();
phase = st.fights.combat.movement_phase;
check('End turn opens Late Movement for everyone holding Speed (the turn waits)', phase?.kind === 'late' && phase.waiting.includes(ta.id) && phase.waiting.includes(tb.id) && st.fights.combat.turn_index === 1, JSON.stringify([phase, st.fights.combat.turn_index]));
check('…and now the others may move too', !(await reach(p, ta.id)).error);
p.emit('move:done', { combatantId: ta.id });
gm.emit('move:done', { combatantId: tb.id });
await sleep(1500);
await stage();
check('…and when everyone is done the turn ends', st.fights.combat.movement_phase == null && st.fights.combat.turn_index !== 1, JSON.stringify([st.fights.combat.movement_phase, st.fights.combat.turn_index]));

console.log('\n--- the GM skips ---');
const fightNow = st.fights.combat;
const nextActive = fightNow.order[(fightNow.turn_index + 1) % fightNow.order.length]?.id;
// 5: the End Phase of the turn ending now discards 3.
for (const id of [ta.id, tb.id]) if (id !== nextActive) gm.emit('fighter:token', { ref: { combatantId: id }, key: 'speed', delta: 5 });
await sleep(300);
gm.emit('fight:next', { mode: 'combat' });
await sleep(2000);
await stage();
const early = st.fights.combat.movement_phase;
gm.emit('move:skip', { mode: 'combat' });
await sleep(500);
await stage();
check('the GM can skip a movement phase', early?.waiting?.length > 0 && st.fights.combat.movement_phase == null, JSON.stringify(early));

console.log('\n--- a hand move: spend Speed? ---');
const ask = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
gm.emit('combat_token:move', { combatantId: ta.id, col: 4, row: 4 });
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', clear: true });
await sleep(300);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 2 });
await sleep(400);
const lateral = await ask(p, 'move:hand_cost', { combatantId: ta.id, col: 6, row: 4 });
const diagonal = await ask(p, 'move:hand_cost', { combatantId: ta.id, col: 5, row: 5 });
const far = await ask(p, 'move:hand_cost', { combatantId: ta.id, col: 6, row: 5 });
check('the cost is the cheapest Free Movement there: 2 lateral = 2, a diagonal = 2, both = 3; with the Speed held', lateral.cost === 2 && diagonal.cost === 2 && far.cost === 3 && lateral.speed === 2, JSON.stringify([lateral, diagonal, far]));
const tooMuch = await ask(p, 'move:hand_pay', { combatantId: ta.id, col: 6, row: 5 });
await stage();
check('"Yes" is refused when the Speed held is not enough (nothing spent)', tooMuch.error && tok(ta.id).fight.tokens.speed === 2, JSON.stringify([tooMuch, tok(ta.id).fight.tokens]));
const paid = await ask(p, 'move:hand_pay', { combatantId: ta.id, col: 5, row: 5 });
p.emit('combat_token:move', { combatantId: ta.id, col: 5, row: 5 });
await sleep(500);
await stage();
check('"Yes" spends it, and the move follows', paid.ok && paid.cost === 2 && !tok(ta.id).fight.tokens.speed && at(ta.id) === '5,5', JSON.stringify([paid, tok(ta.id).fight.tokens, at(ta.id)]));
const nobody = await ask(p, 'move:hand_cost', { combatantId: tb.id, col: 1, row: 1 });
check("…only for fighters you control", Boolean(nobody.error), JSON.stringify(nobody));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

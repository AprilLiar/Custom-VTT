// Playtest: Sabotage and Secure the McGuffin (Victory Parameters, Fight Setup
// phase 6). Sabotage: the Saboteurs' board offers the Sabotage Action, which
// plants a Bomb (HP = the Bleed Value) in an adjacent Key Location; each Bomb
// scores 1 at a Round's end; 3 Points wins. McGuffin: Grab It! picks up the
// adjacent Important Thing; thrown by an enemy, the holder drops it where the
// push began; carried into their own Control Zone, their side wins.
//
//   (start the dev server first)
//   node scripts/playtest-objectives.mjs
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
gm.on('trigger:prompt', (x) => {
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.title === 'Reduce the hit' ? '0' : x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `OB ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `OB ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `OBAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `OBBo${stamp}`, characterType: 'npc' });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 7, row: 7 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }] });
await sleep(300);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const set = (change) => gm.emit('battle:set', { mode: 'combat', change });
const named = (title) => cards.filter((c) => c.payload?.title === title);
const marks = async () => (await jf('/api/dice-marks')).marks;
const tileAt = (col, row, kind) => (st.tiles?.combat ?? []).some((t) => t.col === col && t.row === row && t.kind === kind);
const lastRoll = (characterId) => cards.filter((c) => c.kind === 'stance_roll' && c.payload.character_id === characterId).at(-1)?.payload;
const perform = async (characterId, actionId) => {
  const r = lastRoll(characterId);
  const big = r.results.map((x, i) => ({ v: x.result, i })).sort((a, b) => b.v - a.v)[0];
  gm.emit('board:place', { rollId: r.roll_id, die: big.i, actionId });
  await sleep(400);
  gm.emit('board:commit', { rollId: r.roll_id });
  await sleep(2500);
  return r;
};
const next = async () => {
  for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
  await sleep(300);
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(2500);
  for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
  await sleep(600);
};
const SABOTAGE = 'action.battle.sabotage';
const GRAB = 'action.battle.grab-it';

console.log('\n--- Sabotage ---');
set({ victory: 'sabotage' });
set({ victoryOpts: { saboteurs: 'allies' } });
gm.emit('map_tile:place', { mode: 'combat', col: 4, row: 3, kind: 'key_location' });
gm.emit('map_tile:place', { mode: 'combat', col: 4, row: 3, kind: 'wall' });
gm.emit('map_tile:place', { mode: 'combat', col: 4, row: 3, kind: 'bomb' });
await sleep(400);
await stage();
check('a Key Location takes no obstacle, and a Bomb is never placed by hand', tileAt(4, 3, 'key_location') && !tileAt(4, 3, 'wall') && !tileAt(4, 3, 'bomb'), JSON.stringify((st.tiles?.combat ?? []).filter((t) => t.col === 4 && t.row === 3)));
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'enemies', opener: { combatantId: tb.id } });
await sleep(2000);
await stage();
check('the Saboteurs take the first turn of the Round', st.fights.combat.order[st.fights.combat.turn_index]?.id === ta.id, JSON.stringify(st.fights.combat.order));
const ra = lastRoll(ana.id);
check("the Saboteur's board offers Sabotage", ((await marks())[ra.roll_id]?.battleActions ?? []).includes(SABOTAGE), JSON.stringify((await marks())[ra.roll_id]?.battleActions));
await perform(ana.id, SABOTAGE);
await stage();
const bomb = st.activeScene.battle.combat.sabotage.bombs[0];
check('Sabotage plants a Bomb in the adjacent Key Location — HP 3 (the Middleweight Bleed Value)', tileAt(4, 3, 'bomb') && bomb?.hp === 3 && bomb.side === 'allies', JSON.stringify(st.activeScene.battle.combat.sabotage));
const reachBo = await new Promise((r) => gm.emit('move:reach', { combatantId: tb.id }, r));
await next();
check("the Defense's board has no Sabotage", !((await marks())[lastRoll(bo.id).roll_id]?.battleActions ?? []).includes(SABOTAGE));
await next();
await stage();
check("the Round's end: the Bomb scores 1 for the Saboteurs", st.activeScene.battle.combat.sabotage.points.allies === 1 && named('Sabotage').length === 1, JSON.stringify(st.activeScene.battle.combat.sabotage));
await next();
await next();
await next();
await next();
await stage();
check('three Rounds: 3 Points — the Saboteurs win', st.activeScene.battle.combat.sabotage.points.allies === 3 && cards.some((c) => c.payload?.automatic === 'victory' && /Allies win/.test(c.payload.title)), JSON.stringify({ s: st.activeScene.battle.combat.sabotage, v: cards.filter((c) => c.payload?.automatic === 'victory').map((c) => c.payload.title) }));
void reachBo;
gm.emit('fight:end', { mode: 'combat' });
await sleep(400);

console.log('\n--- Secure the McGuffin ---');
set({ victory: 'secure_the_mcguffin' });
gm.emit('combat_token:move', { combatantId: ta.id, col: 6, row: 4 });
gm.emit('combat_token:move', { combatantId: tb.id, col: 7, row: 4 });
gm.emit('map_tile:place', { mode: 'combat', col: 6, row: 5, kind: 'important' });
for (const c of [6, 7, 8]) gm.emit('map_tile:place', { mode: 'combat', col: c, row: 7, kind: 'control_allies' });
gm.emit('map_tile:place', { mode: 'combat', col: 2, row: 2, kind: 'control_enemies' });
gm.emit('map_tile:place', { mode: 'combat', col: 7, row: 7, kind: 'wall' });
await sleep(500);
await stage();
check('no obstacle in a Control Zone', tileAt(7, 7, 'control_allies') && !tileAt(7, 7, 'wall'));
for (const id of [ta.id, tb.id]) ['speed', 'iron', 'power'].forEach((k) => gm.emit('fighter:token', { ref: { combatantId: id }, key: k, clear: true }));
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(2000);
check('everyone gets Grab It!', ((await marks())[lastRoll(ana.id).roll_id]?.battleActions ?? []).includes(GRAB));
await perform(ana.id, GRAB);
await stage();
check('Grab It!: Ana holds the Important Thing (off the map)', st.activeScene.battle.combat.mcguffin.holder === ta.id && !tileAt(6, 5, 'important'), JSON.stringify(st.activeScene.battle.combat.mcguffin));
await next();
await perform(bo.id, 'action.system-basic-actions.throw');
await stage();
const at = `${tok(ta.id).col},${tok(ta.id).row}`;
check("thrown by Bo, Ana drops it where the push began", st.activeScene.battle.combat.mcguffin.holder == null && tileAt(6, 4, 'important') && at !== '6,4', `${at} ${JSON.stringify(st.activeScene.battle.combat.mcguffin)} ${JSON.stringify((st.tiles?.combat ?? []).filter((t) => t.kind === 'important'))}`);
gm.emit('fight:end', { mode: 'combat' });
await sleep(400);
gm.emit('combat_token:move', { combatantId: ta.id, col: 6, row: 5 });
gm.emit('combat_token:move', { combatantId: tb.id, col: 2, row: 6 });
await sleep(400);
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(2000);
await perform(ana.id, GRAB);
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'speed', delta: 4 });
await sleep(400);
gm.emit('move:free', { combatantId: ta.id, to: { col: 6, row: 7 } });
await sleep(2000);
await stage();
check('carried into the Allies Zone by Free Movement: the Allies win', `${tok(ta.id).col},${tok(ta.id).row}` === '6,7' && cards.some((c) => c.payload?.automatic === 'victory' && /Allies win/.test(c.payload.title) && /Important Thing/.test(c.payload.text)), `${tok(ta.id).col},${tok(ta.id).row} ${JSON.stringify(cards.filter((c) => c.payload?.automatic === 'victory').map((c) => c.payload.text))}`);

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

// Playtest: the 1e PATCH'd UP rules the table adopted (patch-review.md) that
// change a fight's flow — 16 HP bars at Middleweight, Stances declared at
// Combat Start (first turn fought in it), No Stance after a Dizzy, a fallen
// Challenger's Challenge dropped, a Taken Out fighter's square walkable.
//
//   (start the dev server first)
//   node scripts/playtest-patch1e.mjs
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
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `P1 ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `P1 ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `${name}${stamp}`, characterType: type });
const ana = await mk('P1Ana', 'pc');
const bo = await mk('P1Bo', 'npc');
// Ana has two Stances: she must declare one before Round 1.
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }, { formId: 'form.iron', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 5, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (cid) => st.combatTokens.find((t) => t.character_id === cid);
const [ta, tb] = [tok(ana.id), tok(bo.id)];
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior', bars: 2 }] });
await sleep(400);
await stage();
check('Middleweight bars are 16 HP (1e)', tok(ana.id).fight.hp.max === 16 && tok(bo.id).fight.hp.max === 16, JSON.stringify([tok(ana.id).fight.hp, tok(bo.id).fight.hp]));

console.log('\n--- Combat Start: declare a Stance ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(1500);
await stage();
const f = () => st.fights.combat;
check('Start Combat asks Ana (two Stances) to declare before any turn', f().declaring && f().pending_stance?.combatant_id === ta.id && !cards.some((c) => c.kind === 'stance_roll'), JSON.stringify({ declaring: f().declaring, pending: f().pending_stance }));
const iron = f().pending_stance.stances.find((s) => s.id === 'form.iron+style.halcyon');
gm.emit('fight:choose_stance', { mode: 'combat', stanceId: iron.id });
await sleep(2000);
await stage();
const roll = cards.filter((c) => c.kind === 'stance_roll').at(-1);
check('…the last declaration starts Round 1: Ana’s first turn rolls the declared Stance, no second question', !f().declaring && !f().pending_stance && roll?.payload.combatant_id === ta.id && roll.payload.stance === iron.name, JSON.stringify({ declaring: f().declaring, pending: f().pending_stance, stance: roll?.payload.stance }));

console.log('\n--- Dizzy: No Stance until their next turn ---');
gm.emit('fighter:damage', { ref: { combatantId: tb.id }, amount: 16 });
await sleep(1500);
await stage();
check('a broken bar: Bo is Dizzy and has No Stance', tok(bo.id).fight.hp.dizzy && tok(bo.id).fight.stance_lost === true, JSON.stringify(tok(bo.id).fight));

console.log('\n--- a fallen Challenger: their Challenge drops ---');
gm.emit('fighter:challenge', { ref: { combatantId: tb.id }, target: { combatantId: ta.id } });
await sleep(400);
await stage();
check('(Bo holds Ana’s Challenge)', tok(bo.id).fight.challenge_id === ta.id, JSON.stringify(tok(bo.id).fight.challenge_id));
gm.emit('fighter:damage', { ref: { combatantId: ta.id }, amount: 30 }); // (her Iron Stance's Armor blocks 3)
await sleep(1500);
await stage();
check('Ana falls to 0 HP: Bo discards her Challenge at once', tok(ana.id).fight.hp.current === 0 && tok(bo.id).fight.challenge_id == null, JSON.stringify([tok(ana.id).fight.hp, tok(bo.id).fight.challenge_id]));

console.log('\n--- Taken Out: Empty Space ---');
gm.emit('fight:next', { mode: 'combat' });
await sleep(2500);
for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
await sleep(600);
gm.emit('fighter:token', { ref: { combatantId: tb.id }, key: 'speed', delta: 4 });
await sleep(400);
const reach = await new Promise((r) => gm.emit('move:reach', { combatantId: tb.id }, r));
check('Bo’s Free Movement can end on Ana’s square (she is Taken Out)', (reach.options ?? []).some((o) => o.col === 3 && o.row === 3), JSON.stringify(reach.error ?? (reach.options ?? []).map((o) => o.id)));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

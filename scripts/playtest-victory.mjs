// Playtest: Fight Setup's Victory Parameters — Last One Standing announced
// once at a turn's end, King of the Hill and The Fight Must Go On! at the
// Round's end, Protect the VIP (+10 max HP, the VIP's fall), Outlast's
// Attackers first, Tournament Play (a lost round resets, best of 3).
//
//   (start the dev server first)
//   node scripts/playtest-victory.mjs
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
let vipYes = false;
const vipAsks = [];
gm.on('trigger:prompt', (x) => {
  if (x.title === 'Protect the VIP') vipAsks.push(x);
  // Comebacks and the like: decline what can be declined, else the first option
  // (Protect the VIP's "give your turn to the VIP?": as the test says).
  const answer = x.title === 'Protect the VIP' ? vipYes : x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `VC ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `VC ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `${name}${stamp}`, characterType: type });
const ana = await mk('VCAna', 'pc');
const bo = await mk('VCBo', 'npc');
const cy = await mk('VCCy', 'npc');
for (const c of [bo, cy]) gm.emit('build:save', { characterId: c.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 6, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: cy.id, col: 6, row: 5 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === ana.id);
const tb = st.combatTokens.find((t) => t.character_id === bo.id);
const tc = st.combatTokens.find((t) => t.character_id === cy.id);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const tok = (id) => st.combatTokens.find((t) => t.id === id);
const set = (change) => gm.emit('battle:set', { mode: 'combat', change });
const victories = () => cards.filter((c) => c.payload?.automatic === 'victory');
const named = (title) => cards.filter((c) => c.payload?.title === title);
const preset = async () => {
  gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tb.id }, level: 1, kind: 'warrior' }, { ref: { combatantId: tc.id }, level: 1, kind: 'warrior' }] });
  for (const id of [ta.id, tb.id, tc.id]) ['power', 'iron', 'speed', 'burning', 'weakness', 'fatigue', 'shield'].forEach((k) => gm.emit('fighter:token', { ref: { combatantId: id }, key: k, clear: true }));
  await sleep(500);
};
const start = async (first = 'allies') => {
  gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }, { combatantId: tc.id }], firstSide: first, opener: first === 'allies' ? { combatantId: ta.id } : { combatantId: tb.id } });
  await sleep(2000);
};
const next = async () => {
  for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
  await sleep(300);
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(2200);
  for (const id of (await stage()).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
  await sleep(500);
};
const end = async () => {
  gm.emit('fight:end', { mode: 'combat' });
  await sleep(500);
};
const ko = (id) => gm.emit('fighter:set_hp', { ref: { combatantId: id }, current: 0 });

console.log('\n--- Last One Standing (the default) ---');
await preset();
await start();
ko(tb.id);
ko(tc.id);
await sleep(500);
check('no announcement before the turn ends', victories().length === 0);
await next();
check('the turn ends with only the Allies standing: a card announces their win', victories().length === 1 && /Allies win/.test(victories()[0].payload.title), JSON.stringify(victories().map((c) => c.payload.title)));
check('…and the fight goes on until the GM ends it', (await stage()).fights.combat != null);
await next();
check('…announced once', victories().length === 1, String(victories().length));
await end();

console.log('\n--- King of the Hill + The Fight Must Go On! ---');
set({ victory: 'king_of_the_hill' });
gm.emit('map_tile:place', { mode: 'combat', col: 3, row: 2, kind: 'king' });
await sleep(300);
await preset();
await start();
gm.emit('fighter:hp', { ref: { combatantId: ta.id }, delta: -6 });
await sleep(400);
const hpA = tok(ta.id)?.fight.hp.current ?? (await stage(), tok(ta.id).fight.hp.current);
const before = victories().length;
// Ana, Bo, Cy: three turns, then the Round ends.
await next();
await next();
await stage();
const midHp = tok(ta.id).fight.hp.current;
await next();
await stage();
check('The Fight Must Go On!: at the Round\'s end everyone heals twice the Heal Value', named('The Fight Must Go On!').length >= 1 && tok(ta.id).fight.hp.current > midHp, `${hpA} / ${midHp} → ${tok(ta.id).fight.hp.current}`);
check('King of the Hill: only Ana in the King Zone at the Round\'s end — the Allies win', victories().length === before + 1 && /Allies win/.test(victories().at(-1).payload.title), JSON.stringify(victories().map((c) => c.payload.title)));
await end();
gm.emit('map_tile:remove', { mode: 'combat', col: 3, row: 2, kind: 'king' });
await sleep(300);

console.log('\n--- Protect the VIP ---');
set({ victory: 'protect_the_vip' });
set({ victoryOpts: { vip: { side: 'allies', id: ta.id } } });
set({ victoryOpts: { vip: { side: 'enemies', id: tb.id } } });
await sleep(300);
await preset();
const maxBo = (await stage(), tok(tb.id).fight.hp.max);
await start();
await stage();
check("each side's VIP starts with +10 max HP", tok(tb.id).fight.hp.max === maxBo + 10 && tok(tb.id).fight.hp.current === maxBo + 10, `${maxBo} → ${JSON.stringify(tok(tb.id).fight.hp)}`);
check('the VIP is never asked to give their own turn away', !vipAsks.some((x) => x.fighterName === ana.name || /^VCAna/.test(x.fighterName ?? '')), JSON.stringify(vipAsks.map((x) => x.fighterName)));
// Heroic Spirit to the VIP (book p.49): Cy, still standing, gives their turn to Bo.
vipYes = true;
await next();
await next();
await stage();
const gave = cards.filter((c) => c.payload?.title === 'Heroic Spirit' && /gives their turn to VCBo/.test(c.payload.text));
check("on Cy's turn: asked to give it to the VIP — Yes hands Bo the turn", vipAsks.some((x) => /VCCy/.test(x.fighterName ?? '') && /VCBo/.test(x.text)) && gave.length === 1, JSON.stringify({ asks: vipAsks.map((x) => [x.fighterName, x.text]), gave: gave.map((c) => c.payload.text) }));
vipYes = false;
const vBefore = victories().length;
ko(tb.id);
await sleep(400);
await next();
check("the enemies' VIP falls: the Allies win (Cy still stands)", victories().length === vBefore + 1 && /Allies win/.test(victories().at(-1).payload.title), JSON.stringify(victories().map((c) => c.payload.title)));
await end();

console.log('\n--- Protect the VIP, three sides ---');
set({ victoryOpts: { vip: { side: 'allies', id: ta.id } } });
set({ victoryOpts: { vip: { side: 'enemies', id: tb.id } } });
set({ victoryOpts: { vip: { side: 'renegades', id: tc.id } } });
await sleep(300);
await preset();
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tb.id }], renegades: [{ combatantId: tc.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(2000);
const v3 = victories().length;
gm.emit('fighter:damage', { ref: { combatantId: tb.id }, amount: 99 });
await sleep(2500);
await stage();
check("the first VIP to fall (Bo): their side is out of the fight, nobody has won yet", tok(tb.id).col == null && victories().length === v3 && cards.some((c) => c.payload?.title === 'Protect the VIP' && /out of the fight/.test(c.payload.text)), JSON.stringify({ col: tok(tb.id).col, v: victories().map((c) => c.payload.title) }));
gm.emit('fighter:damage', { ref: { combatantId: tc.id }, amount: 99 });
await sleep(2500);
check('the second VIP falls (Cy): the last side with its VIP wins — at once, not at the turn\'s end', victories().length === v3 + 1 && /Allies win/.test(victories().at(-1).payload.title), JSON.stringify(victories().map((c) => c.payload.title)));
await end();
set({ victoryOpts: { vip: { side: 'renegades', id: null } } });
await sleep(200);
// (Back on the board where they started, for what follows.)
gm.emit('combat_token:move', { combatantId: tb.id, col: 6, row: 2 });
gm.emit('combat_token:move', { combatantId: tc.id, col: 6, row: 5 });
await sleep(400);

console.log('\n--- Outlast: the Attackers go first ---');
set({ victory: 'outlast' });
set({ victoryOpts: { survivors: 'allies' } });
await sleep(300);
await preset();
await start('allies');
await stage();
check('the Attackers (Enemies) take the first turn, whatever Start Combat said', st.fights.combat.order[0].side === 'enemies', JSON.stringify(st.fights.combat.order));
await end();

console.log('\n--- Tournament Play (best of 3) ---');
set({ victory: 'tournament' });
set({ victoryOpts: { bestOf: 3 } });
await sleep(300);
await preset();
await start();
const tBefore = victories().length;
for (let round = 1; round <= 2; round++) {
  ko(tb.id);
  ko(tc.id);
  gm.emit('combat_token:move', { combatantId: tb.id, col: 7, row: 7 });
  await sleep(500);
  // Three turns: the Round ends.
  for (let i = 0; i < 3; i++) await next();
  await stage();
  if (round === 1) {
    check('two Enemies at 0 HP: the Allies take round 1, and everyone resets', named('Tournament Play').some((c) => /Allies take round 1 \(Allies 1\)/.test(c.payload.text)), JSON.stringify(named('Tournament Play').map((c) => c.payload.text)));
    check('…back to full HP and to their start squares', tok(tb.id).fight.hp.current === tok(tb.id).fight.hp.max && `${tok(tb.id).col},${tok(tb.id).row}` === '6,2', JSON.stringify([tok(tb.id).fight.hp, tok(tb.id).col, tok(tb.id).row]));
  }
}
check('a second round won: the Allies take the Tournament', victories().length === tBefore + 1 && /Allies win/.test(victories().at(-1).payload.title) && /2/.test(victories().at(-1).payload.text), JSON.stringify(victories().map((c) => c.payload.text)));
await end();

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

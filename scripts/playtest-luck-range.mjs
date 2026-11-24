// Playtest: the active fighter's real reach (their Copies' squares too), the
// range shading setting, and Luck as an Interrupt (Lucky Escape: 1 Luck,
// Teleport 3 and heal 1, once per turn, any time).
//
//   (start the dev server first)
//   node scripts/playtest-luck-range.mjs
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
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
gm.emit('scene:create', { name: `LR ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `LR ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `${name}${stamp}`, characterType: type });
const ana = await mk('LRAna', 'pc');
const cy = await mk('LRCy', 'pc');
// Ana: the Necromancer places a Copy at the start of her turn; Volcanic Style is Range 1-3.
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.the-necromancer', variant: 'focused' }], stances: [{ formId: 'form.power', styleId: 'style.volcanic' }] } });
// Cy: an Underdog — Luck tokens.
gm.emit('build:save', { characterId: cy.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.underdog', variant: 'focused' }], stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: cy.id, col: 8, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const tok = (cid) => st.combatTokens.find((t) => t.character_id === cid);
const [ta, tc] = [tok(ana.id), tok(cy.id)];
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: ta.id }, level: 1 }, { ref: { combatantId: tc.id }, level: 1 }] });
await sleep(300);

console.log('\n--- the range shading setting ---');
gm.emit('table_settings:set', { rangeOpacity: 70 });
await sleep(300);
check('the GM sets the range shading to 70%', (await jf('/api/table-settings')).rangeOpacity === 70, JSON.stringify(await jf('/api/table-settings')));
gm.emit('table_settings:set', { rangeOpacity: 50 });
await sleep(200);

console.log('\n--- the real reach: from her Copy too ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: tc.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(3500);
st = await jf('/api/stage?role=gm');
const copy = st.tiles.combat.find((t) => t.kind === 'copy' && t.owner_id === ta.id);
const range = await new Promise((r) => gm.emit('fight:active_range', { mode: 'combat' }, r));
const has = (col, row) => (range.squares ?? []).some((q) => q.col === col && q.row === row);
const d = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
const beyond = copy ? (range.squares ?? []).filter((q) => d(q, { col: 3, row: 3 }) > 3) : [];
check('Ana has a Copy', Boolean(copy), JSON.stringify(st.tiles.combat));
check('her shaded reach includes squares only her Copy reaches (beyond her own Range 3)', beyond.length > 0 && beyond.every((q) => d(q, copy) <= 3), JSON.stringify({ copy, beyond: beyond.slice(0, 6), n: range.squares?.length }));

console.log('\n--- Luck: Lucky Escape as an Interrupt ---');
gm.emit('fighter:token', { ref: { combatantId: tc.id }, key: 'luck', delta: 1 });
gm.emit('fighter:hp', { ref: { combatantId: tc.id }, delta: -3 });
await sleep(500);
const offers = await new Promise((r) => gm.emit('interrupt:offers', { mode: 'combat' }, (x) => r(x?.offers ?? {})));
const LUCKY = 'action.resource-luck.lucky-escape';
check('on Ana’s turn Cy (1 Luck) can Interrupt with Lucky Escape', (offers[tc.id]?.clusters ?? []).some((c) => c.ids.includes(LUCKY)), JSON.stringify(offers[tc.id]));
const opened = await new Promise((r) => gm.emit('react:open', { combatantId: tc.id }, r));
const rx = opened.payload?.roll_id;
st = await jf('/api/stage?role=gm');
const hpBefore = tok(cy.id).fight.hp.current;
const at0 = `${tok(cy.id).col},${tok(cy.id).row}`;
gm.emit('board:place', { rollId: rx, actionId: LUCKY, option: 0, answers: {} });
await sleep(300);
gm.emit('board:commit', { rollId: rx });
await sleep(2500);
st = await jf('/api/stage?role=gm');
check('…it spends the Luck, teleports Cy and heals 1', !tok(cy.id).fight.tokens.luck && `${tok(cy.id).col},${tok(cy.id).row}` !== at0 && tok(cy.id).fight.hp.current === hpBefore + 1, JSON.stringify([tok(cy.id).fight.tokens, at0, tok(cy.id).col, tok(cy.id).row, hpBefore, tok(cy.id).fight.hp.current]));
check('…and nobody is asked about Luck after every Action any more', !cards.some((c) => /Luck mechanics/.test(c.payload?.title ?? '')), JSON.stringify(cards.map((c) => c.payload?.title).filter(Boolean).slice(-6)));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

// Playtest: a held Challenge is a Unique token (decided) — a Shield may block
// a Challenge; "discard a token" (Purify) may take a held one, and the
// Challenger's "if an enemy discards your Challenge token" rule runs
// (Armored Style: the former holder gains 2 Weakness); Distracting Style's
// Challenges can't be discarded by its enemies.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-live-steps.mjs
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
gm.emit('scene:create', { name: `CH ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `CH ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const mk = (name, type) => jpost('/api/characters', { name: `CH${name}${stamp}`, characterType: type });
const ana = await mk('Ana', 'pc');
const sly = await mk('Sly', 'pc');
const bo = await mk('Bo', 'npc');
const cy = await mk('Cy', 'npc');
const dee = await mk('Dee', 'npc');
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: sly.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.swift' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.armored' }] } });
gm.emit('build:save', { characterId: cy.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.distracting' }] } });
gm.emit('build:save', { characterId: dee.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.decoy' }] } });
await sleep(500);
const spots = [[ana, 3, 3], [sly, 3, 4], [bo, 7, 2], [cy, 7, 4], [dee, 7, 6]];
for (const [c, col, row] of spots) gm.emit('combat_token:place', { ownerType: 'character', ownerId: c.id, col, row });
await sleep(800);
let st = await jf('/api/stage?role=gm');
const tok = (c) => st.combatTokens.find((t) => t.character_id === c.id);
const [ta, ts, tb, tc, td] = [ana, sly, bo, cy, dee].map(tok);
gm.emit('fight:preset_weight', {
  mode: 'combat',
  weight: 'middle',
  fighters: [
    { ref: { combatantId: ta.id }, level: 1 },
    { ref: { combatantId: ts.id }, level: 1 },
    ...[tb, tc, td].map((t) => ({ ref: { combatantId: t.id }, level: 1, kind: 'warrior' })),
  ],
});
gm.emit('fighter:token', { ref: { combatantId: ta.id }, key: 'shield', delta: 2 });
await sleep(400);

const p = await connect({ role: 'player', characterId: ana.id });
const asked = [];
let discardPick = 'challenge';
p.on('trigger:prompt', (x) => {
  asked.push(x);
  let answer;
  if (x.kind === 'confirm') answer = x.title === 'Shield' && /Challenge/.test(x.text);
  else if (x.kind === 'targets') answer = [x.options.find((o) => /CHSly/.test(o.label))?.id ?? x.options[0].id];
  else if (x.kind === 'choose') answer = x.options.find((o) => o.id === discardPick)?.id ?? x.options.find((o) => o.id === '__skip')?.id ?? x.options[0].id;
  else if (x.kind === 'square') answer = x.minimum === 0 ? [] : x.options[0].id;
  setTimeout(() => p.emit('trigger:answer', { id: x.id, answer }), 150);
});
const gmAsked = [];
gm.on('trigger:prompt', (x) => {
  if (x.characterId === ana.id || x.characterId === sly.id) return;
  gmAsked.push(x);
  // Dee's Decoy Style: yes, pay 1 HP to Challenge the active character.
  const answer = x.kind === 'confirm' ? /Decoy/.test(x.title) : x.kind === 'targets' ? [x.options[0].id] : x.kind === 'square' && x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 150);
});

console.log('\n--- a Shield blocks a Challenge ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }, { combatantId: ts.id }], enemies: [tb, tc, td].map((t) => ({ combatantId: t.id })), firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(4000);
st = await jf('/api/stage?role=gm');
const shieldAsk = asked.find((x) => x.kind === 'confirm' && x.title === 'Shield' && /Challenge/.test(x.text));
check("Decoy's Challenge on Ana's turn start: her player is asked whether her Shield blocks it", Boolean(shieldAsk), JSON.stringify(asked.map((x) => [x.title, x.text])));
check('…blocked: no Challenge, Shield 2 → 1', tok(ana).fight.challenge_id == null && tok(ana).fight.tokens.shield === 1, JSON.stringify(tok(ana).fight));

console.log('\n--- Purify discards a held Challenge ---');
gm.emit('fighter:challenge', { ref: { combatantId: ts.id }, target: { combatantId: tb.id } });
// A second token, so "which one?" is asked.
gm.emit('fighter:token', { ref: { combatantId: ts.id }, key: 'fatigue', delta: 1 });
await sleep(400);
const roll = cards.filter((c) => c.kind === 'stance_roll' && c.payload.combatant_id === ta.id).at(-1);
const rollId = roll.payload.roll_id;
const place = async (die) => {
  p.emit('board:place', { rollId, die, actionId: 'action.style-halcyon.purify' });
  await sleep(400);
  const marks = (await jf('/api/dice-marks')).marks;
  const key = marks[rollId].placements.at(-1)?.key;
  if (key) p.emit('board:stop', { rollId, key, stop: 1 });
  await sleep(300);
  p.emit('board:commit', { rollId });
  await sleep(4000);
};
asked.length = 0;
await place(0);
st = await jf('/api/stage?role=gm');
const pick = asked.find((x) => x.kind === 'choose' && x.options.some((o) => o.id === 'challenge'));
check("Purify (\"discard one token\") offers Sly's held Challenge", Boolean(pick), JSON.stringify(asked.map((x) => [x.kind, x.title, x.options?.map((o) => o.id)])));
check('…discarded: Sly no longer holds it', tok(sly).fight.challenge_id == null, JSON.stringify(tok(sly).fight));
check("…Bo's Armored Style runs: the former holder gains 2 Weakness (the Fatigue stays)", tok(sly).fight.tokens.weakness === 2 && tok(sly).fight.tokens.fatigue === 1, JSON.stringify(tok(sly).fight.tokens));

console.log("\n--- Distracting Style: its Challenges can't be discarded by enemies ---");
gm.emit('fighter:challenge', { ref: { combatantId: ts.id }, target: { combatantId: tc.id } });
await sleep(400);
asked.length = 0;
await place(1);
st = await jf('/api/stage?role=gm');
const offered = asked.filter((x) => x.kind === 'choose').flatMap((x) => x.options.map((o) => o.id));
check("Cy's Challenge is never offered: the Fatigue goes instead", !offered.includes('challenge') && !tok(sly).fight.tokens.fatigue, JSON.stringify([offered, tok(sly).fight.tokens]));
check('…and Sly still holds it', tok(sly).fight.challenge_id === tc.id, JSON.stringify(tok(sly).fight));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [ana, sly, bo, cy, dee]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
for (const s of [gm, p]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

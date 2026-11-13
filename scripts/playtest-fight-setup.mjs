// Playtest: Fight Setup — infinite HP (decided). A fighter with infinite HP
// is hit in full (Shield and all) but never loses HP: no Bleed, never Taken
// Out; the damage taken is counted. Manual HP − counts too; only the GM sets it.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-fight-setup.mjs
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
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) =>
    r.json()
  );
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

const stamp = Date.now();
const gm = await connect({ role: 'gm' });
const cards = [];
gm.on('chat:card', (c) => cards.push(c));
gm.emit('scene:create', { name: `FS ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `FS ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `FSMira${stamp}`, characterType: 'pc' });
const thug = await jpost('/api/characters', { name: `FSThug${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: mira.id });
// Mira: Frozen Style (Exploit Weakness). The Thug: Halcyon Style, no Armor.
gm.emit('build:save', { characterId: mira.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.blaster', styleId: 'style.frozen' }] } });
gm.emit('build:save', { characterId: thug.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.swift' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: thug.id, col: 3, row: 2 });
await sleep(600);
const st = await jf('/api/stage?role=gm');
const tm = st.combatTokens.find((t) => t.character_id === mira.id);
const tt = st.combatTokens.find((t) => t.character_id === thug.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: tm.id }, level: 1 }, { ref: { combatantId: tt.id }, level: 1, kind: 'warrior' }] });
await sleep(400);
const fight = async (id) => (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === id).fight;
const token = (ref, key, delta) => gm.emit('fighter:token', { ref: { combatantId: ref }, key, delta });
const clear = (ref, keys) => keys.forEach((k) => gm.emit('fighter:token', { ref: { combatantId: ref }, key: k, clear: true }));
p.on('trigger:prompt', (x) => {
  const answer = x.kind === 'targets' ? [x.options[0].id] : x.kind === 'confirm' ? true : x.options?.[0]?.id;
  setTimeout(() => p.emit('trigger:answer', { id: x.id, answer }), 100);
});

gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tm.id }], enemies: [{ combatantId: tt.id }], firstSide: 'allies', opener: { combatantId: tm.id } });
await sleep(1500);
console.log('\n--- infinite HP ---');
p.emit('fighter:infinite', { ref: { combatantId: tt.id }, on: true });
await sleep(300);
check('only the GM sets it', !(await fight(tt.id)).infinite);
gm.emit('fighter:infinite', { ref: { combatantId: tt.id }, on: true });
await sleep(300);
let ft = await fight(tt.id);
const hp0 = ft.hp.current;
check('the GM turns it on', ft.infinite === true && ft.damage_taken === 0, JSON.stringify(ft));
clear(tt.id, ['shield', 'iron', 'armor', 'weakness', 'power']);
await sleep(200);
token(tt.id, 'shield', 2);
await sleep(300);
gm.emit('fighter:damage', { ref: { combatantId: tt.id }, amount: 30 });
await sleep(2000);
ft = await fight(tt.id);
check('a 30-damage hit: the Shield absorbs 2 and breaks, HP never drops, 28 counted', ft.hp.current === hp0 && ft.hp.broken === 0 && !ft.tokens.shield && ft.damage_taken === 28, JSON.stringify(ft));
check('no Bleed card', !cards.some((c) => c.payload?.automatic === 'bleed' && /FSThug/.test(c.payload.text)), '');
gm.emit('fighter:hp', { ref: { combatantId: tt.id }, delta: -5 });
await sleep(400);
ft = await fight(tt.id);
check('a manual HP − is counted, not taken', ft.hp.current === hp0 && ft.damage_taken === 33, JSON.stringify(ft));
gm.emit('fighter:infinite', { ref: { combatantId: tt.id }, on: false });
await sleep(300);
gm.emit('fighter:hp', { ref: { combatantId: tt.id }, delta: -5 });
await sleep(400);
ft = await fight(tt.id);
check('turned off: HP drops again', !ft.infinite && ft.hp.current === hp0 - 5, JSON.stringify(ft));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

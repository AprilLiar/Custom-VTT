// Playtest: Shields and XP — "Take damage" hits the Shield first (it breaks
// when used up), Thorns Form strikes back at the active enemy, and End Combat
// awards Victory / Defeat XP (logged on the build) or skips.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-shield-xp.mjs
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
const msgs = [];
gm.on('chat:card', (c) => cards.push(c));
gm.on('chat:message', (m) => msgs.push(m));
// Phase C: a player's Shield is used on Ask (their default) — the GM answers yes.
const prompts = [];
gm.on('trigger:prompt', (p) => {
  prompts.push(p);
  if (p.title === 'Shield') gm.emit('trigger:answer', { id: p.id, answer: true });
});
gm.emit('scene:create', { name: `SX ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `SX ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const thorn = await jpost('/api/characters', { name: `SXThorn${stamp}`, characterType: 'pc' });
const pal = await jpost('/api/characters', { name: `SXPal${stamp}`, characterType: 'pc' });
const foe = await jpost('/api/characters', { name: `SXFoe${stamp}`, characterType: 'npc' });
gm.emit('build:save', { characterId: thorn.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.angel', variant: 'focused' }], stances: [{ formId: 'form.thorns', styleId: 'style.heroic' }], xp: 3 } });
gm.emit('build:save', { characterId: pal.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.heroic' }] } });
gm.emit('build:save', { characterId: foe.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.heroic' }] } });
await sleep(500);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: thorn.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: pal.id, col: 9, row: 9 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: foe.id, col: 3, row: 2 });
await sleep(700);
let st = await jf('/api/stage?role=gm');
const tt = st.combatTokens.find((t) => t.character_id === thorn.id);
const tp = st.combatTokens.find((t) => t.character_id === pal.id);
const tf = st.combatTokens.find((t) => t.character_id === foe.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [tt, tp, tf].map((t) => ({ ref: { combatantId: t.id }, level: 1 })) });
await sleep(400);
const f = (id) => st.combatTokens.find((t) => t.id === id).fight;

console.log('\n--- outside a fight: the Shield absorbs first ---');
gm.emit('fighter:token', { ref: { combatantId: tp.id }, key: 'shield', delta: 3 });
await sleep(300);
st = await jf('/api/stage?role=gm');
const palHp = f(tp.id).hp.current;
gm.emit('fighter:damage', { ref: { combatantId: tp.id }, amount: 5 });
await sleep(400);
st = await jf('/api/stage?role=gm');
check('5 damage on Shield 3: the Shield breaks, 2 to HP', !f(tp.id).tokens.shield && f(tp.id).hp.current === palHp - 2, JSON.stringify(f(tp.id)));

console.log('\n--- in a fight: Thorns strikes back at the active enemy ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tt.id }, { combatantId: tp.id }], enemies: [{ combatantId: tf.id }], firstSide: 'enemies', opener: { combatantId: tf.id } });
await sleep(1500);
st = await jf('/api/stage?role=gm');
const foeHp = f(tf.id).hp.current;
gm.emit('fighter:token', { ref: { combatantId: tt.id }, key: 'shield', delta: 2 });
await sleep(300);
st = await jf('/api/stage?role=gm');
const thornHp = f(tt.id).hp.current;
gm.emit('fighter:damage', { ref: { combatantId: tt.id }, amount: 1 });
await sleep(1000);
st = await jf('/api/stage?role=gm');
check('a player is asked before their Shield blocks (Ask by default)', prompts.some((p) => p.title === 'Shield' && p.kind === 'confirm' && p.characterId === thorn.id), JSON.stringify(prompts.map((p) => p.title)));
check('the Shield absorbs the hit; HP untouched', f(tt.id).tokens.shield === 1 && f(tt.id).hp.current === thornHp, JSON.stringify(f(tt.id)));
check('Thorns Form deals 1 to the attacker (the active enemy)', f(tf.id).hp.current === foeHp - 1, `${foeHp} → ${f(tf.id).hp.current}`);
gm.emit('fighter:damage', { ref: { combatantId: tt.id }, amount: 3 });
await sleep(1000);
st = await jf('/api/stage?role=gm');
check('a hit that breaks the Shield: the rest to HP, and Thorns deals 2', !f(tt.id).tokens.shield && f(tt.id).hp.current === thornHp - 2 && f(tf.id).hp.current === foeHp - 3, JSON.stringify([f(tt.id).hp.current, f(tf.id).hp.current]));
check('the damage is reported as an automation notice', cards.some((c) => c.payload?.automatic === 'damage' && c.payload.notice));

console.log('\n--- End Combat: who won ---');
gm.emit('fight:end', { mode: 'combat', outcome: 'allies' });
await sleep(800);
const bt = (await jf(`/api/characters/${thorn.id}/build`)).build;
const bp = (await jf(`/api/characters/${pal.id}/build`)).build;
const bf = (await jf(`/api/characters/${foe.id}/build`)).build;
check('the winners get Victory XP (+2), logged with the Scene', bt.xp === 5 && bp.xp === 2 && bt.xpLog.at(-1).reason === `Victory — SX ${stamp}`, JSON.stringify([bt.xp, bp.xp, bt.xpLog]));
check('a Warrior (no XP track) gets none', bf.xp === 0 && bf.xpLog.length === 0);
check('the chat says who got what (and who can level up)', msgs.some((m) => /allies win/.test(m.message ?? '') && /can level up/.test(m.message ?? '')), JSON.stringify(msgs.map((m) => m.message)));
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tt.id }], enemies: [{ combatantId: tf.id }], firstSide: 'allies', opener: { combatantId: tt.id } });
await sleep(800);
gm.emit('fight:end', { mode: 'combat', outcome: 'skip' });
await sleep(600);
check('Skip gives no XP', (await jf(`/api/characters/${thorn.id}/build`)).build.xp === 5);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [thorn, pal, foe]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

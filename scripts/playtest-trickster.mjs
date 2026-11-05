// Playtest: Trickster's steal at the start of every character's turn — each
// prompt says whose turn it belongs to and arrives during that turn, and one
// left unanswered closes when its turn ends instead of delaying the next ones.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-trickster.mjs
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
gm.emit('scene:create', { name: `TK ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `TK ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mk = (n, t) => jpost('/api/characters', { name: `TK${n}${stamp}`, characterType: t });
const tr = await mk('Trick', 'pc');
const al = await mk('Ally', 'pc');
const en = await mk('Foe', 'npc');
const en2 = await mk('Foe2', 'npc');
const p = await connect({ role: 'player', characterId: tr.id });
gm.emit('build:save', { characterId: tr.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.trickster', variant: 'focused' }], stances: [{ formId: 'form.iron', styleId: 'style.heroic' }] } });
for (const c of [al, en, en2]) gm.emit('build:save', { characterId: c.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.iron', styleId: 'style.heroic' }] } });
await sleep(500);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: tr.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: al.id, col: 3, row: 4 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: en.id, col: 4, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: en2.id, col: 4, row: 4 });
await sleep(700);
let st = await jf('/api/stage?role=gm');
const tok = (c) => st.combatTokens.find((t) => t.character_id === c.id);
const [tt, ta, te, te2] = [tok(tr), tok(al), tok(en), tok(en2)];
for (const t of [ta, te, te2]) gm.emit('fighter:token', { ref: { combatantId: t.id }, key: 'iron', delta: 9 });
await sleep(400);
const names = { [tt.id]: tr.name, [ta.id]: al.name, [te.id]: en.name, [te2.id]: en2.name };
const prompts = [];
let answer = false;
p.on('trigger:prompt', (q) => {
  prompts.push(q);
  if (!answer) return;
  const ans = q.maximum > 1 ? ['option-1'] : q.options.find((o) => o.id !== '__skip')?.id;
  setTimeout(() => p.emit('trigger:answer', { id: q.id, answer: ans }), 100);
});
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tt.id }, { combatantId: ta.id }], enemies: [{ combatantId: te.id }, { combatantId: te2.id }], firstSide: 'allies', opener: { combatantId: tt.id } });
const turns = [];
for (let i = 0; i < 8; i++) {
  answer = i % 2 === 1; // ignore every other turn's prompt
  const seen = prompts.length;
  await sleep(1300);
  const f = (await jf('/api/stage?role=gm')).fights.combat;
  const who = names[f.order[f.turn_index].id];
  const mine = prompts.slice(seen).filter((q) => q.title === 'Focused Trickster');
  turns.push({ who, ok: mine.length > 0 && mine.every((q) => q.when === `Start of ${who}'s turn`), whens: mine.map((q) => q.when) });
  gm.emit('fight:next', { mode: 'combat' });
}
check("Focused Trickster asks at the start of every character's turn, during that turn — even after a prompt was ignored", turns.every((t) => t.ok), JSON.stringify(turns));
check('an ignored prompt closes when its turn ends, with a note', cards.some((c) => c.payload?.notice && /not answered before the turn ended/.test(c.payload.text)));
gm.emit('fight:end', { mode: 'combat', outcome: 'skip' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [tr, al, en, en2]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

// Playtest: the engine runtime (full automation, phase A) — a fight's runtime
// is saved with it (turn sequence, active fighter, persistent choices), so a
// server restart loses nothing.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-engine-runtime.mjs
import { io } from 'socket.io-client';
import { createClient } from '@libsql/client';

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



const db = createClient({ url: process.env.TURSO_DATABASE_URL || 'file:local.db' });
const stamp = Date.now();
const gm = await connect({ role: 'gm' });
gm.emit('scene:create', { name: `RT ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `RT ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const a = await jpost('/api/characters', { name: `RTa${stamp}`, characterType: 'pc' });
const e = await jpost('/api/characters', { name: `RTe${stamp}`, characterType: 'npc' });
// Fullmetal Style: choose a weapon at the start of your turn (kept in state).
gm.emit('build:save', { characterId: a.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.iron', styleId: 'style.fullmetal' }] } });
gm.emit('build:save', { characterId: e.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.iron', styleId: 'style.heroic' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: a.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: e.id, col: 3, row: 2 });
await sleep(600);
const st = await jf('/api/stage?role=gm');
const ta = st.combatTokens.find((t) => t.character_id === a.id);
const te = st.combatTokens.find((t) => t.character_id === e.id);
let asked = null;
gm.on('trigger:prompt', (p) => {
  asked = p;
  gm.emit('trigger:answer', { id: p.id, answer: p.options?.[1]?.id ?? p.options?.[0]?.id });
});
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: te.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(1800);
const row = (await db.execute({ sql: 'SELECT runtime FROM fights WHERE scene_id = ?', args: [scene.id] })).rows[0];
const rt = JSON.parse(row?.runtime ?? 'null');
check('the fight runtime is persisted with the fight', rt && rt.turnSeq === 1 && rt.turn.activeId === ta.id, String(row?.runtime).slice(0, 300));
const chosen = asked?.options?.[1]?.id ?? asked?.options?.[0]?.id;
check("a persistent choice (Fullmetal Style's weapon) is kept in the runtime", asked && rt?.fighters?.[ta.id]?.state && Object.values(rt.fighters[ta.id].state).includes(chosen), JSON.stringify([asked?.options, rt?.fighters]));
gm.emit('fight:end', { mode: 'combat', outcome: 'skip' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [a, e]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

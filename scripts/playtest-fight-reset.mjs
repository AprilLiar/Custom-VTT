// Playtest: ending a fight while an ability's prompt is open (Cyborg asks
// once per token amount) must not block the next fight's turn triggers on the
// same Scene — Scene ids can be reused once deleted.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-fight-reset.mjs
import { io } from 'socket.io-client';
const BASE = 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const gm = io(BASE); await new Promise((r) => gm.on('connect', r)); gm.emit('identity:set', { role: 'gm' }); await sleep(300);
let answering = false;
gm.on('trigger:prompt', (p) => answering && gm.emit('trigger:answer', { id: p.id, answer: p.kind === 'confirm' ? true : p.kind === 'targets' ? [] : p.options?.[0]?.id }));
const results = [];
const run = async (label, endFast) => {
  const stamp = Date.now();
  gm.emit('scene:create', { name: `RP ${stamp}` }); await sleep(300);
  const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `RP ${stamp}`);
  gm.emit('scene:activate', { sceneId: scene.id }); await sleep(300);
  gm.emit('scene:set_mode', { mode: 'combat' }); await sleep(300);
  const a = await jpost('/api/characters', { name: `RPa${stamp}`, characterType: 'pc' });
  const e = await jpost('/api/characters', { name: `RPe${stamp}`, characterType: 'npc' });
  gm.emit('build:save', { characterId: a.id, build: { type: 'hero-type.focused', archetypes: [{ id: 'archetype.cyborg', variant: 'focused' }], stances: [{ formId: 'form.wild', styleId: 'style.swift' }] } });
  gm.emit('build:save', { characterId: e.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
  await sleep(400);
  gm.emit('combat_token:place', { ownerType: 'character', ownerId: a.id, col: 2, row: 2 });
  gm.emit('combat_token:place', { ownerType: 'character', ownerId: e.id, col: 4, row: 2 });
  await sleep(500);
  const st = await jf('/api/stage?role=gm');
  const ta = st.combatTokens.find((t) => t.character_id === a.id), te = st.combatTokens.find((t) => t.character_id === e.id);
  gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }], enemies: [{ combatantId: te.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
  if (endFast) { await sleep(1500); gm.emit('fight:end', { mode: 'combat', outcome: 'skip' }); }
  await sleep(1500);
  const power = (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === ta.id).fight.tokens.power;
  results.push(power ?? 0);
  gm.emit('fight:end', { mode: 'combat', outcome: 'skip' });
  gm.emit('scene:delete', { sceneId: scene.id }); await sleep(300);
  for (const c of [a, e]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
};
await run('first (ended at once)', true);
answering = true;
await run('second (normal)', false);
const ok = results[1] > 0;
console.log(`${ok ? 'PASS' : 'FAIL'}: a fight ended with an ability prompt open doesn't block the next fight on that Scene (Wild Form ran: ${results[1]} Power)`);
console.log(ok ? '\nall probes passed' : '\n1 FAILURE(S)');
process.exit(ok ? 0 : 1);

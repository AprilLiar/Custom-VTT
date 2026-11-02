// Playtest: assigning an NPC to a player. Until the GM assigns it, the player
// cannot touch the NPC; once assigned they control it like their own PC
// (combat setup, Scene Pictures, summons, map tokens, fight state); another
// player still cannot; unassigning or deleting the PC hands it back to the GM.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-npc-assign.mjs
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

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const stamp = Date.now();
const gm = await connect({ role: 'gm' });
gm.emit('scene:create', { name: `Assign ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Assign ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `AMira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `ABo${stamp}`, characterType: 'pc' });
const grunt = await jpost('/api/characters', { name: `AGrunt${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: mira.id });
const other = await connect({ role: 'player', characterId: bo.id });
const roster = () => jf('/api/characters');
const stage = () => jf('/api/stage?role=gm');
const pics = () => jf(`/api/scene-pictures?ownerType=character&ownerId=${grunt.id}`);

console.log('\n--- by default nobody but the GM ---');
check('a new NPC is assigned to nobody', (await roster()).find((c) => c.id === grunt.id).assigned_to === null);
p.emit('combat_stance:create', { ownerType: 'character', ownerId: grunt.id, name: 'Nope', dice: [{ die: 6 }] });
p.emit('scene_picture:create', { ownerType: 'character', ownerId: grunt.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
p.emit('combat_token:place', { ownerType: 'character', ownerId: grunt.id, col: 2, row: 2 });
await sleep(500);
check("a Player can't set up, picture or place an unassigned NPC",
  (await pics()).length === 0 && !(await stage()).combatTokens.some((t) => t.character_id === grunt.id));
p.emit('character:assign', { characterId: grunt.id, playerCharacterId: mira.id });
await sleep(300);
check('only the GM assigns', (await roster()).find((c) => c.id === grunt.id).assigned_to === null);

console.log('\n--- assigned ---');
gm.emit('character:assign', { characterId: mira.id, playerCharacterId: bo.id });
gm.emit('character:assign', { characterId: grunt.id, playerCharacterId: grunt.id });
await sleep(300);
check('a PC cannot be assigned, nor to a non-PC', (await roster()).every((c) => c.assigned_to == null));
const updates = [];
p.on('character:updated', (c) => updates.push(c));
gm.emit('character:assign', { characterId: grunt.id, playerCharacterId: mira.id });
await sleep(300);
check('the GM assigns the NPC to the player; everyone hears it',
  (await roster()).find((c) => c.id === grunt.id).assigned_to === mira.id && updates.some((u) => u.id === grunt.id && u.assigned_to === mira.id));
p.emit('combat_stance:create', { ownerType: 'character', ownerId: grunt.id, name: 'Grunt', dice: [{ die: 6 }] });
p.emit('scene_picture:create', { ownerType: 'character', ownerId: grunt.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
p.emit('combat_token:place', { ownerType: 'character', ownerId: grunt.id, col: 2, row: 2 });
await sleep(600);
let st = await stage();
const tok = st.combatTokens.find((t) => t.character_id === grunt.id);
check('the player sets up, pictures and places the NPC', (await pics()).length === 1 && tok != null && st.fighterSetup[`character:${grunt.id}`]?.stances.length === 1);
p.emit('fighter:token', { ref: { combatantId: tok.id }, key: 'iron', delta: 2 });
other.emit('fighter:token', { ref: { combatantId: tok.id }, key: 'speed', delta: 1 });
await sleep(400);
st = await stage();
check("the player edits the NPC's fight state; another player can't",
  JSON.stringify(st.combatTokens.find((t) => t.id === tok.id).fight.tokens) === JSON.stringify({ iron: 2 }), JSON.stringify(st.combatTokens.find((t) => t.id === tok.id).fight.tokens));
p.emit('combat_token:move', { combatantId: tok.id, col: 4, row: 4 });
await sleep(400);
st = await stage();
check('the player moves the NPC token', st.combatTokens.find((t) => t.id === tok.id).col === 4, JSON.stringify(st.combatTokens.find((t) => t.id === tok.id)));
gm.emit('scene:set_mode', { mode: 'simple' });
await sleep(300);
p.emit('stage:summon', { scenePictureId: (await pics())[0].id });
await sleep(400);
check('the player summons the NPC onto the stage', (await stage()).summons.some((s) => s.character_id === grunt.id));

console.log('\n--- handed back ---');
gm.emit('character:assign', { characterId: grunt.id, playerCharacterId: null });
await sleep(300);
p.emit('combat_stance:create', { ownerType: 'character', ownerId: grunt.id, name: 'Late', dice: [{ die: 4 }] });
await sleep(400);
check('unassigned: the player loses control again', (await stage()).fighterSetup[`character:${grunt.id}`]?.stances.length === 1);
gm.emit('character:assign', { characterId: grunt.id, playerCharacterId: mira.id });
await sleep(300);
await fetch(`${BASE}/api/characters/${mira.id}`, { method: 'DELETE' });
await sleep(300);
check("deleting the PC hands the NPC back to the GM", (await roster()).find((c) => c.id === grunt.id).assigned_to === null);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [bo, grunt]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
other.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

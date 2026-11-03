// Playtest: token notes (two per token per Stance, written by whoever
// controls the token, read by everyone, deleted with the token), the Shield
// token's cap, and the lane height table setting.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-token-notes.mjs
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
gm.emit('scene:create', { name: `Notes ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Notes ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `NMira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `NBo${stamp}`, characterType: 'pc' });
gm.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'Calm', dice: [{ die: 6 }] });
gm.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'Fury', dice: [{ die: 8 }] });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 3, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const [calm, fury] = st.fighterSetup[`character:${mira.id}`].stances;
const tok = st.combatTokens.find((t) => t.character_id === mira.id);
const ref = { combatantId: tok.id };
const p = await connect({ role: 'player', characterId: mira.id });
const other = await connect({ role: 'player', characterId: bo.id });
const notesOf = async () => (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tok.id)?.fight.notes;

console.log('\n--- notes ---');
p.emit('fighter:set_note', { ref, stanceId: calm.id, side: 'left', text: 'Feint left' });
p.emit('fighter:set_note', { ref, stanceId: calm.id, side: 'right', text: 'Then sweep' });
p.emit('fighter:set_note', { ref, stanceId: fury.id, side: 'left', text: 'All in' });
other.emit('fighter:set_note', { ref, stanceId: calm.id, side: 'left', text: 'hijack' });
p.emit('fighter:set_note', { ref, stanceId: 999999, side: 'left', text: 'bad stance' });
p.emit('fighter:set_note', { ref, stanceId: calm.id, side: 'top', text: 'bad side' });
await sleep(700);
let n = await notesOf();
check('two notes per Stance, kept apart by Stance', JSON.stringify(n) === JSON.stringify({ [calm.id]: { left: 'Feint left', right: 'Then sweep' }, [fury.id]: { left: 'All in' } }), JSON.stringify(n));
check("another player can't write them; a foreign Stance or side is refused", n[calm.id].left === 'Feint left' && !n['999999']);
const asPlayer = (await jf('/api/stage')).combatTokens.find((t) => t.id === tok.id)?.fight.notes;
check('everyone reads them', asPlayer?.[calm.id]?.right === 'Then sweep');
p.emit('fighter:set_note', { ref, stanceId: calm.id, side: 'right', text: '   ' });
p.emit('fighter:set_note', { ref, stanceId: calm.id, side: 'left', text: 'x'.repeat(900) });
await sleep(400);
n = await notesOf();
check('an empty note is deleted; a long one is cut to 500', !n[calm.id].right && n[calm.id].left.length === 500, JSON.stringify(n));
gm.emit('combat_token:remove', { combatantId: tok.id });
await sleep(300);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 3, row: 3 });
await sleep(500);
st = await jf('/api/stage?role=gm');
check('a token placed again starts without notes (they died with the old one)', JSON.stringify(st.combatTokens.find((t) => t.character_id === mira.id).fight.notes) === '{}');

console.log('\n--- a lane miniature: notes go when it is un-summoned ---');
gm.emit('scene:set_mode', { mode: 'simple' });
gm.emit('scene_picture:create', { ownerType: 'character', ownerId: bo.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
await sleep(400);
const pic = (await jf(`/api/scene-pictures?ownerType=character&ownerId=${bo.id}`))[0];
gm.emit('stage:summon', { scenePictureId: pic.id });
await sleep(400);
let sm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === bo.id);
other.emit('fighter:set_note', { ref: { summonId: sm.id }, stanceId: null, side: 'right', text: 'Watch the gap' });
await sleep(400);
sm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === bo.id);
check('a fighter without Stances keeps its notes under "none"', sm.fight.notes?.none?.right === 'Watch the gap', JSON.stringify(sm.fight));
gm.emit('stage:summon', { scenePictureId: pic.id }); // the same picture again = un-summon
await sleep(400);
gm.emit('stage:summon', { scenePictureId: pic.id });
await sleep(400);
sm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === bo.id);
check('summoned again: a fresh miniature, no notes', JSON.stringify(sm.fight.notes ?? {}) === '{}', JSON.stringify(sm.fight));

console.log('\n--- preset notes from the character sheet ---');
gm.emit('combat_stance:update', { stanceId: calm.id, notes: { left: 'Preset: guard up', right: 'Preset: counter' } });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 6, row: 6 });
await sleep(500);
st = await jf('/api/stage?role=gm');
const fresh = st.combatTokens.find((t) => t.character_id === mira.id && t.col === 6);
check('a new token starts with the preset notes', fresh?.fight.notes?.[calm.id]?.left === 'Preset: guard up' && fresh.fight.notes[calm.id].right === 'Preset: counter', JSON.stringify(fresh?.fight.notes));
const older = st.combatTokens.find((t) => t.character_id === mira.id && t.col === 3);
check('...a token placed before the preset keeps its own', JSON.stringify(older?.fight.notes) === '{}', JSON.stringify(older?.fight.notes));
p.emit('fighter:set_note', { ref: { combatantId: fresh.id }, stanceId: calm.id, side: 'left', text: 'Changed in play' });
await sleep(400);
st = await jf('/api/stage?role=gm');
check("changing a token's copy leaves the preset alone",
  st.combatTokens.find((t) => t.id === fresh.id).fight.notes[calm.id].left === 'Changed in play' &&
  st.fighterSetup[`character:${mira.id}`] != null);
gm.emit('scene:set_mode', { mode: 'simple' });
gm.emit('scene_picture:create', { ownerType: 'character', ownerId: mira.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
await sleep(400);
const mpic = (await jf(`/api/scene-pictures?ownerType=character&ownerId=${mira.id}`))[0];
gm.emit('stage:summon', { scenePictureId: mpic.id });
await sleep(400);
let msm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === mira.id);
check('a fresh miniature shows the presets before it has a fight row', msm.fight.combatant_id == null && msm.fight.notes?.[calm.id]?.right === 'Preset: counter', JSON.stringify(msm.fight));
p.emit('fighter:token', { ref: { summonId: msm.id }, key: 'iron', delta: 1 });
await sleep(400);
msm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === mira.id);
check('...and keeps them once its row is created', msm.fight.combatant_id != null && msm.fight.notes?.[calm.id]?.left === 'Preset: guard up', JSON.stringify(msm.fight));
gm.emit('temp_npc:create', { name: `NGoon${stamp}` });
await sleep(400);
const goon = (await jf('/api/temp-npcs')).find((n) => n.name === `NGoon${stamp}`);
gm.emit('combat_stance:create', { ownerType: 'temp_npc', ownerId: goon.id, name: 'Brawl', dice: [{ die: 4 }] });
await sleep(300);
const setupOf = () => jf(`/api/combat-setup?ownerType=temp_npc&ownerId=${goon.id}`);
gm.emit('combat_stance:update', { stanceId: (await setupOf()).stances[0].id, notes: { left: 'nope' } });
await sleep(300);
check('Temp NPC stances take no preset notes', JSON.stringify((await setupOf()).stances[0].notes) === '{}', JSON.stringify((await setupOf()).stances));
gm.emit('temp_npc:delete', { tempNpcId: goon.id });

console.log('\n--- Shield, lane height ---');
for (let i = 0; i < 12; i++) other.emit('fighter:token', { ref: { summonId: sm.id }, key: 'shield', delta: 1 });
other.emit('fighter:token', { ref: { summonId: sm.id }, key: 'armor', delta: 12 });
await sleep(700);
sm = (await jf('/api/stage?role=gm')).summons.find((s) => s.character_id === bo.id);
check('Shield caps at 8, Armor at 9', sm.fight.tokens.shield === 8 && sm.fight.tokens.armor === 9, JSON.stringify(sm.fight.tokens));
const before = (await jf('/api/table-settings')).laneY;
p.emit('table_settings:set', { laneY: 0.3 });
await sleep(200);
check('only the GM moves the lanes', (await jf('/api/table-settings')).laneY === before);
gm.emit('table_settings:set', { laneY: 5 });
await sleep(300);
check('the lane height is clamped and reaches the stage', (await jf('/api/table-settings')).laneY === 0.9 && (await jf('/api/stage')).laneY === 0.9);
gm.emit('table_settings:set', { laneY: null });
await sleep(300);
check('Reset returns it to 5/7', Math.abs((await jf('/api/table-settings')).laneY - 5 / 7) < 1e-9);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
other.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

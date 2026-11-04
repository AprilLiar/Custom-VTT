// Playtest: a fighter's state in a fight (Panic at the Dojo, Phase 4) — Panic
// tokens, the Challenge, HP bars, Dizzy and the Stance — on both a Combat map
// token and a Simple Combat miniature, through the real handlers.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-fighter-state.mjs
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
gm.emit('scene:create', { name: `Fight ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `Fight ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `FMira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `FBo${stamp}`, characterType: 'pc' });
gm.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'Calm', dice: [{ die: 6 }] });
gm.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'Fury', dice: [{ die: 10 }] });
gm.emit('combat_stance:create', { ownerType: 'character', ownerId: bo.id, name: 'BoOnly', dice: [{ die: 4 }] });
gm.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, uniqueTokens: ['chaos'] });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 3, row: 3 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 5, row: 3 });
await sleep(600);
const p = await connect({ role: 'player', characterId: mira.id });
const stage = () => jf('/api/stage?role=gm');
let st = await stage();
const tok = (c) => st.combatTokens.find((t) => t.character_id === c.id);
const miraRef = { combatantId: tok(mira).id };
const boRef = { combatantId: tok(bo).id };

console.log('\n--- a fresh fighter ---');
check('a new token starts with no tokens, no Challenge and one unset bar',
  JSON.stringify(tok(mira).fight) === JSON.stringify({ combatant_id: tok(mira).id, tokens: {}, challenge_id: null, hp: { max: null, current: 0, bars: 1, broken: 0, dizzy: false }, active_stance_id: null, level: 1, kind: null }),
  JSON.stringify(tok(mira).fight));
const setupKey = `character:${mira.id}`;
check("the payload carries each fighter's Unique picks and Stance names",
  JSON.stringify(st.fighterSetup[setupKey]) === JSON.stringify({ unique_tokens: ['chaos'], armor_sources: [], stances: st.fighterSetup[setupKey].stances }) &&
    st.fighterSetup[setupKey].stances.map((s) => s.name).join() === 'Calm,Fury', JSON.stringify(st.fighterSetup[setupKey]));

console.log('\n--- Panic tokens ---');
for (let i = 0; i < 12; i++) p.emit('fighter:token', { ref: miraRef, key: 'iron', delta: 1 });
p.emit('fighter:token', { ref: miraRef, key: 'burning', delta: 2 });
p.emit('fighter:token', { ref: miraRef, key: 'nonsense', delta: 1 });
p.emit('fighter:token', { ref: miraRef, key: 'challenge', delta: 1 });
p.emit('fighter:token', { ref: boRef, key: 'iron', delta: 1 });
await sleep(800);
st = await stage();
check('counts cap at 9; unknown keys and Challenge-as-a-count are refused',
  JSON.stringify(tok(mira).fight.tokens) === JSON.stringify({ iron: 9, burning: 2 }), JSON.stringify(tok(mira).fight.tokens));
check("a Player can't touch someone else's tokens", JSON.stringify(tok(bo).fight.tokens) === '{}');
p.emit('fighter:token', { ref: miraRef, key: 'iron', delta: -1 });
p.emit('fighter:token', { ref: miraRef, key: 'burning', clear: true });
await sleep(400);
st = await stage();
check('− removes one, −− removes all', JSON.stringify(tok(mira).fight.tokens) === JSON.stringify({ iron: 8 }), JSON.stringify(tok(mira).fight.tokens));

console.log('\n--- HP bars ---');
p.emit('fighter:hp', { ref: miraRef, delta: -1 });
await sleep(250);
check('± does nothing before Max is set', (await stage()).combatTokens.find((t) => t.id === miraRef.combatantId).fight.hp.current === 0);
p.emit('fighter:set_hp', { ref: miraRef, max: 3 });
await sleep(250);
p.emit('fighter:add_bar', { ref: miraRef });
await sleep(250);
p.emit('fighter:hp', { ref: miraRef, delta: -1 });
await sleep(250);
p.emit('fighter:hp', { ref: miraRef, delta: -1 });
await sleep(250);
p.emit('fighter:hp', { ref: miraRef, delta: -1 });
await sleep(400);
st = await stage();
let hp = tok(mira).fight.hp;
check('setting Max fills the bar; the third hit breaks it, the next bar comes up full, Dizzy',
  hp.max === 3 && hp.current === 3 && hp.bars === 2 && hp.broken === 1 && hp.dizzy === true, JSON.stringify(hp));
for (let i = 0; i < 5; i++) p.emit('fighter:hp', { ref: miraRef, delta: -1 });
await sleep(600);
hp = (await stage()).combatTokens.find((t) => t.id === miraRef.combatantId).fight.hp;
check('the last bar stops at 0 (Taken Out)', hp.current === 0 && hp.broken === 1, JSON.stringify(hp));
p.emit('fighter:hp', { ref: miraRef, delta: 1 });
p.emit('fighter:clear_dizzy', { ref: miraRef });
await sleep(400);
hp = (await stage()).combatTokens.find((t) => t.id === miraRef.combatantId).fight.hp;
check('healing revives; Dizzy can be cleared', hp.current === 1 && hp.dizzy === false, JSON.stringify(hp));

console.log('\n--- the Challenge ---');
p.emit('fighter:challenge', { ref: miraRef, target: boRef });
await sleep(300);
st = await stage();
check("a fighter holds another's Challenge", tok(mira).fight.challenge_id === boRef.combatantId);
p.emit('fighter:challenge', { ref: miraRef, target: miraRef });
await sleep(300);
check('...never their own', (await stage()).combatTokens.find((t) => t.id === miraRef.combatantId).fight.challenge_id === boRef.combatantId);
gm.emit('combat_token:remove', { combatantId: boRef.combatantId });
await sleep(400);
check('a Challenger leaving the map frees whoever held their Challenge',
  (await stage()).combatTokens.find((t) => t.id === miraRef.combatantId).fight.challenge_id === null);

console.log('\n--- the Stance ---');
const [calm, fury] = st.fighterSetup[setupKey].stances;
const boStance = st.fighterSetup[`character:${bo.id}`].stances[0];
p.emit('fighter:set_stance', { ref: miraRef, stanceId: fury.id });
await sleep(300);
check('the active stance switches any time', (await stage()).combatTokens.find((t) => t.id === miraRef.combatantId).fight.active_stance_id === fury.id);
p.emit('fighter:set_stance', { ref: miraRef, stanceId: boStance.id });
await sleep(300);
check("...but only to one of the fighter's own", (await stage()).combatTokens.find((t) => t.id === miraRef.combatantId).fight.active_stance_id === fury.id);
void calm;

console.log('\n--- Simple Combat: the same state on a miniature ---');
gm.emit('scene:set_mode', { mode: 'simple' });
for (const c of [mira, bo]) {
  gm.emit('scene_picture:create', { ownerType: 'character', ownerId: c.id, name: 'x', imageData: PNG, imageMimeType: 'image/png' });
  await sleep(200);
  const pic = (await jf(`/api/scene-pictures?ownerType=character&ownerId=${c.id}`))[0];
  gm.emit('stage:summon', { scenePictureId: pic.id });
  await sleep(200);
}
st = await stage();
const sm = (c) => st.summons.find((s) => s.character_id === c.id);
check('a summon that never fought has the empty state', sm(mira).fight.combatant_id === null && JSON.stringify(sm(mira).fight.tokens) === '{}');
p.emit('fighter:token', { ref: { summonId: sm(mira).id }, key: 'speed', delta: 3 });
p.emit('fighter:token', { ref: { summonId: sm(mira).id }, key: 'speed', delta: 1 });
await sleep(500);
st = await stage();
check('its first change creates its fight state (exactly once), separate from the map copy',
  sm(mira).fight.tokens.speed === 4 && sm(mira).fight.combatant_id != null && !('iron' in sm(mira).fight.tokens), JSON.stringify(sm(mira).fight));
p.emit('fighter:challenge', { ref: { summonId: sm(mira).id }, target: { summonId: sm(bo).id } });
await sleep(400);
st = await stage();
check('a miniature can be Challenged by another miniature', sm(mira).fight.challenge_id === sm(bo).fight.combatant_id && sm(bo).fight.combatant_id != null);
p.emit('fighter:challenge', { ref: { summonId: sm(mira).id }, target: miraRef });
await sleep(300);
check("...but not by a fighter from the other fight (the map)", (await stage()).summons.find((s) => s.character_id === mira.id).fight.challenge_id === sm(bo).fight.combatant_id);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

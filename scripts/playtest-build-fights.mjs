// Playtest: fights driven by builds (builder phase 2) — the derived Stances in
// the turn-start pick and roll (colours, the level bonus die), Stance
// switching by key, option tokens and Armor in the fighter setup, and the
// Combat Weight preset taking Health Bars from the build.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-build-fights.mjs
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
gm.emit('scene:create', { name: `BF ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `BF ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `BFMira${stamp}`, characterType: 'pc' });
const boss = await jpost('/api/characters', { name: `BFBoss${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: mira.id });
p.emit('build:save', {
  characterId: mira.id,
  build: {
    type: 'hero-type.fused',
    archetypes: [{ id: 'archetype.demon', variant: 'fused' }, { id: 'archetype.angel', variant: 'fused' }],
    stances: [
      { formId: 'form.iron', styleId: 'style.halcyon' },
      { formId: 'form.blaster', styleId: 'freestyle.chaotic' },
    ],
    level: 4,
  },
});
gm.emit('build:save', { characterId: boss.id, build: { type: 'character-type.boss', healthBars: 3, archetypes: [{ id: 'archetype.the-tank' }], stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(500);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: boss.id, col: 5, row: 2 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const setup = st.fighterSetup[`character:${mira.id}`];
const ironKey = 'form.iron+style.halcyon';
const chaoticKey = 'form.blaster+freestyle.chaotic';
check("the fighter setup comes from the build: Stances by key, option tokens, Armor, level",
  JSON.stringify(setup?.stances.map((s) => s.id)) === JSON.stringify([ironKey, chaoticKey]) &&
    setup.unique_tokens.includes('chaos') && JSON.stringify(setup.armor_sources) === JSON.stringify([ironKey]) && setup.level === 4 && setup.kind === 'hero',
  JSON.stringify(setup));
check("an NPC type uses the Warrior HP table and its build's Health Bars", st.fighterSetup[`character:${boss.id}`]?.kind === 'warrior' && st.fighterSetup[`character:${boss.id}`].health_bars === 3);
const tm = st.combatTokens.find((t) => t.character_id === mira.id);
const tb = st.combatTokens.find((t) => t.character_id === boss.id);

console.log('\n--- the Combat Weight preset reads the build ---');
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: tb.id }, level: 1, kind: 'warrior', bars: 3 }] });
await sleep(400);
st = await jf('/api/stage?role=gm');
check('a Boss gets its Health Bars from the build', st.combatTokens.find((t) => t.id === tb.id).fight.hp.bars === 3, JSON.stringify(st.combatTokens.find((t) => t.id === tb.id).fight.hp));

console.log('\n--- the turn-start pick and roll ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tm.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: tm.id } });
await sleep(900);
st = await jf('/api/stage?role=gm');
const pending = st.fights.combat.pending_stance;
check("two derived Stances: the turn waits for the player's pick", pending?.combatant_id === tm.id && pending.stances.length === 2 && pending.stances[1].name === 'Chaotic Dragon Stance', JSON.stringify(pending));
p.emit('fight:choose_stance', { mode: 'combat', stanceId: chaoticKey });
await sleep(700);
const roll = cards.find((c) => c.kind === 'stance_roll');
const r = roll?.payload.results ?? [];
check('the roll is the Freestyle pool: Blaster purple d8 + Chaotic purple d6 d4, plus the level-4 bonus d6',
  roll?.payload.stance === 'Chaotic Dragon Stance' && r.map((x) => `${x.bonus ? 'b' : x.color[0]}${x.die}`).join(' ') === 'p8 p6 p4 b6',
  JSON.stringify(r));
st = await jf('/api/stage?role=gm');
check('the pick became the active Stance (by key)', st.combatTokens.find((t) => t.id === tm.id).fight.active_stance_id === chaoticKey);
p.emit('fighter:set_stance', { ref: { combatantId: tm.id }, stanceId: ironKey });
p.emit('fighter:set_stance', { ref: { combatantId: tm.id }, stanceId: 'form.power+style.halcyon' });
await sleep(400);
check("switching Stance: only to one of the build's own", (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tm.id).fight.active_stance_id === ironKey);
gm.emit('fight:next', { mode: 'combat' });
await sleep(800);
check("a single-Stance fighter's dice roll on their own", cards.filter((c) => c.kind === 'stance_roll').some((c) => c.payload.stance === 'Halcyon Blade Stance'), JSON.stringify(cards.filter((c) => c.kind === 'stance_roll').map((c) => c.payload.stance)));

gm.emit('fight:end', { mode: 'combat' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, boss]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

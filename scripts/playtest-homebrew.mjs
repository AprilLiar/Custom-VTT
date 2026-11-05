// Playtest: the homebrew builder — only the GM saves; items get homebrew ids
// and are broadcast; a build made of a homebrew Archetype, Style and Form
// derives its Stance, rolls its dice, and its Abilities run as turn triggers;
// publishing and deleting.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-homebrew.mjs
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
const hbUpdates = [];
gm.on('homebrew:updated', (e) => hbUpdates.push(e));
const mine = async () => (await jf('/api/homebrew')).items.filter((i) => i.name.endsWith(String(stamp)));
const saved = (s) => new Promise((r) => s.once('homebrew:saved', r));

console.log('\n--- only the GM saves ---');
const hero = await jpost('/api/characters', { name: `HBHero${stamp}`, characterType: 'pc' });
const foe = await jpost('/api/characters', { name: `HBFoe${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: hero.id });
p.emit('homebrew:save', { item: { kind: 'form', name: `Sneaky ${stamp}` } });
await sleep(400);
check('a player cannot save homebrew', (await mine()).length === 0);

console.log('\n--- the GM makes an Archetype, a Style and a Form ---');
let s = saved(gm);
gm.emit('homebrew:save', { item: { kind: 'archetype', name: `Pyre ${stamp}`, archetypeKind: 'player', published: true, abilities: [{ name: 'Focused Pyre', variant: 'focused', rulesText: '', rules: [{ moment: 'own_turn.start', steps: [{ kind: 'gain_tokens', token: 'speed', amount: 1, who: 'self' }] }] }], actions: [{ name: 'Smolder', cost: '2+', rulesText: 'Deal 1.' }] } });
const archId = (await s).id;
s = saved(gm);
gm.emit('homebrew:save', { item: { kind: 'style', name: `Kindling Style ${stamp}`, archetypeId: archId, range: { minimum: 1, maximum: 3 }, published: true, abilities: [], actions: [] } });
const styleId = (await s).id;
s = saved(gm);
gm.emit('homebrew:save', {
  item: {
    kind: 'form', name: `Ember Form ${stamp}`, aliases: ['Ember'], published: false,
    actionDice: [{ kind: 'die', sides: 8, color: 'purple' }, { kind: 'fixed', value: 3, color: 'green' }],
    abilities: [{ name: 'Ember Form', rulesText: '', rules: [{ moment: 'own_turn.start', steps: [{ kind: 'gain_tokens', token: 'power', amount: 3, who: 'self' }, { kind: 'damage', amount: 2, who: 'enemy' }] }] }],
    actions: [],
  },
});
const formId = (await s).id;
await sleep(400);
let items = await mine();
check('three items saved with homebrew ids', items.length === 3 && [archId, styleId, formId].every((id) => /\.hb-/.test(id)), JSON.stringify(items.map((i) => i.id)));
check('every change is broadcast as homebrew:updated', hbUpdates.length >= 3);
check('the Form is a draft, the others published', items.find((i) => i.id === formId).published === false && items.find((i) => i.id === styleId).published === true);

console.log('\n--- a build on homebrew, then a fight ---');
p.emit('build:save', { characterId: hero.id, build: { type: 'hero-type.focused', archetypes: [{ id: archId, variant: 'focused' }], stances: [{ formId, styleId, alias: 'Ember' }], level: 1 } });
gm.emit('build:save', { characterId: foe.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.iron', styleId: 'style.heroic' }] } });
await sleep(500);
const build = (await jf(`/api/characters/${hero.id}/build`)).build;
check('the build keeps the homebrew ids', build.stances[0]?.formId === formId && build.archetypes[0]?.id === archId, JSON.stringify(build));
gm.emit('scene:create', { name: `HB ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((x) => x.name === `HB ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: hero.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: foe.id, col: 4, row: 2 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const th = st.combatTokens.find((t) => t.character_id === hero.id);
const tf = st.combatTokens.find((t) => t.character_id === foe.id);
check('the fighter setup names the homebrew Stance', st.fighterSetup[`character:${hero.id}`]?.stances[0]?.name.endsWith('Ember Stance'), JSON.stringify(st.fighterSetup[`character:${hero.id}`]));
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: th.id }, level: 1 }, { ref: { combatantId: tf.id }, level: 1, kind: 'warrior' }] });
await sleep(400);
const hp0 = (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === tf.id).fight.hp.current;
const cards = [];
gm.on('chat:card', (c) => cards.push(c));
p.on('trigger:prompt', (q) => p.emit('trigger:answer', { id: q.id, answer: q.kind === 'targets' ? [q.options[0].id] : q.kind === 'confirm' ? true : q.options[0].id }));
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: th.id }], enemies: [{ combatantId: tf.id }], firstSide: 'allies', opener: { combatantId: th.id } });
await sleep(1800);
st = await jf('/api/stage?role=gm');
const fh = st.combatTokens.find((t) => t.id === th.id).fight;
const roll = cards.find((c) => c.kind === 'stance_roll');
check('the homebrew dice roll: a purple d8 and a fixed green 3', roll && roll.payload.results.length === 2 && roll.payload.results[1].color === 'green', JSON.stringify(roll?.payload.results));
check("homebrew Abilities run as turn triggers: Ember 3 Power, Focused Pyre 1 Speed", fh.tokens.power === 3 && fh.tokens.speed === 1, JSON.stringify(fh.tokens));
check('…and the chosen enemy takes 2 damage', st.combatTokens.find((t) => t.id === tf.id).fight.hp.current === hp0 - 2);

console.log('\n--- publish and delete ---');
gm.emit('homebrew:publish', { id: formId, published: true });
await sleep(400);
check('publishing flips the draft', (await mine()).find((i) => i.id === formId).published === true);
gm.emit('fight:end', { mode: 'combat' });
gm.emit('scene:delete', { sceneId: scene.id });
for (const id of [formId, styleId, archId]) gm.emit('homebrew:delete', { id });
await sleep(600);
check('deleting removes them', (await mine()).length === 0);
const after = (await jf(`/api/characters/${hero.id}/build`)).build;
check("a build using a deleted item simply loses it", !after.stances[0]?.formId && after.archetypes.length === 0, JSON.stringify(after));
for (const c of [hero, foe]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

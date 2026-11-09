// Playtest: turn triggers (builder phase 3) — start/end-of-turn abilities run
// on their own (tokens, Shield, healing), choices and targets are asked of the
// fighter's controllers over trigger:prompt, and open prompts survive a
// reconnect and close with the fight.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-turn-triggers.mjs
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
gm.emit('scene:create', { name: `TT ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `TT ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const hero = await jpost('/api/characters', { name: `TTHero${stamp}`, characterType: 'pc' });
const angel = await jpost('/api/characters', { name: `TTAngel${stamp}`, characterType: 'pc' });
const pHero = await connect({ role: 'player', characterId: hero.id });
const pAngel = await connect({ role: 'player', characterId: angel.id });
// The hero: Wild Form + Aura Style, Fused Demon & Phantom — all automatic.
pHero.emit('build:save', {
  characterId: hero.id,
  build: {
    type: 'hero-type.fused',
    archetypes: [{ id: 'archetype.demon', variant: 'fused' }, { id: 'archetype.phantom', variant: 'fused' }],
    stances: [{ formId: 'form.wild', styleId: 'style.aura' }],
    level: 1,
  },
});
// The Angel: Fused Angel (may heal 2, then Challenge an enemy) + Heroic Style (heal 1).
pAngel.emit('build:save', {
  characterId: angel.id,
  build: {
    type: 'hero-type.fused',
    archetypes: [{ id: 'archetype.angel', variant: 'fused' }, { id: 'archetype.demon', variant: 'fused' }],
    stances: [{ formId: 'form.wild', styleId: 'style.heroic' }],
    level: 1,
  },
});
await sleep(500);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: hero.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: angel.id, col: 4, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const th = st.combatTokens.find((t) => t.character_id === hero.id);
const ta = st.combatTokens.find((t) => t.character_id === angel.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: th.id }, level: 1 }, { ref: { combatantId: ta.id }, level: 1 }] });
await sleep(400);
gm.emit('fighter:hp', { ref: { combatantId: ta.id }, delta: -6 });
await sleep(300);
const hpA0 = (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === ta.id).fight.hp.current;

const prompts = { hero: [], angel: [], gm: [], heroShield: [] };
// Phase C: hit spends are asked of a player (Ask by default) — the hero blocks
// with their Shield. Those are not ability prompts.
pHero.on('trigger:prompt', (p) => {
  if (p.title === 'Shield') {
    prompts.heroShield.push(p);
    return setTimeout(() => pHero.emit('trigger:answer', { id: p.id, answer: true }), 100);
  }
  prompts.hero.push(p);
  // The hero's own reactions (Aura Style when their Shield is hit — phase D
  // automates its push): answered with the first choice.
  if (p.characterId === hero.id) setTimeout(() => pHero.emit('trigger:answer', { id: p.id, answer: p.kind === 'confirm' ? true : p.kind === 'targets' ? [p.options[0].id] : p.options?.[0]?.id }), 100);
});
gm.on('trigger:prompt', (p) => prompts.gm.push(p));
// The Angel's player answers: yes, heal; target the first enemy offered.
pAngel.on('trigger:prompt', (p) => {
  prompts.angel.push(p);
  const answer = p.kind === 'confirm' ? true : p.kind === 'targets' ? [p.options[0].id] : p.options[0].id;
  setTimeout(() => pAngel.emit('trigger:answer', { id: p.id, answer }), 150);
});

console.log('\n--- the hero\'s turn: everything automatic ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: th.id }], enemies: [{ combatantId: ta.id }], firstSide: 'allies', opener: { combatantId: th.id } });
await sleep(1500);
st = await jf('/api/stage?role=gm');
let fh = st.combatTokens.find((t) => t.id === th.id).fight;
check('turn start: Wild Form gives 2 Power, Fused Phantom 2 Poltergeist, Aura Style Shield 3',
  fh.tokens.power === 2 && fh.tokens.poltergeist === 2 && fh.tokens.shield === 3, JSON.stringify(fh.tokens));
check('each ability that ran posts a rule card', ['Wild Form', 'Aura Style'].every((n) => cards.some((c) => c.kind === 'reminder' && c.payload.title === n && c.payload.automatic === 'ability')),
  JSON.stringify(cards.filter((c) => c.kind === 'reminder').map((c) => c.payload.title)));
check('nothing asked the hero', prompts.hero.length === 0, JSON.stringify(prompts.hero));

console.log('\n--- end of turn, then the Angel\'s turn: a choice and a target ---');
gm.emit('fight:next', { mode: 'combat' });
await sleep(2500);
st = await jf('/api/stage?role=gm');
fh = st.combatTokens.find((t) => t.id === th.id).fight;
const fa = st.combatTokens.find((t) => t.id === ta.id).fight;
check('turn end: Fused Demon gives 1 Chaos', fh.tokens.chaos === 1, JSON.stringify(fh.tokens));
// One enemy in range: the only legal target is the target — nobody is asked for it (batch 5).
check("the Angel's player was asked (and the GM too) to heal; the one enemy in range is the target without asking", prompts.angel.some((p) => p.kind === 'confirm') && !prompts.angel.some((p) => p.kind === 'targets') && prompts.gm.length >= prompts.angel.length,
  JSON.stringify(prompts.angel.map((p) => p.kind)));
check('only the Angel\'s controllers got the Angel\'s prompts, not the hero\'s player', !prompts.hero.some((p) => p.characterId === angel.id), JSON.stringify(prompts.hero.map((p) => [p.title, p.text])));
check('the Angel healed 2 (Fused Angel) + 1 (Heroic Style)', fa.hp.current === hpA0 + 3, `${hpA0} → ${fa.hp.current}`);
check('the hero is Challenged by the Angel', fh.challenge_id === ta.id, JSON.stringify(fh));
check("Fused Angel's 1 damage: the hero's player is asked about their Shield, which absorbs it", prompts.heroShield.length === 1 && fh.tokens.shield === 2, JSON.stringify([prompts.heroShield.length, fh.tokens]));
check('Wild Form ran for the Angel too', fa.tokens.power === 2, JSON.stringify(fa.tokens));

console.log('\n--- an open prompt survives a reconnect and ends with the fight ---');
// Stop answering, then move on until the Angel's next turn asks again.
pAngel.off('trigger:prompt');
const asked = prompts.gm.length;
for (let i = 0; i < 4 && prompts.gm.length === asked; i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(1200);
}
let late = [];
const again = await connect({ role: 'player', characterId: angel.id }).then((s) => {
  s.on('trigger:prompt', (p) => late.push(p));
  s.emit('identity:set', { role: 'player', characterId: angel.id });
  return s;
});
await sleep(400);
check('a reconnecting controller is sent the open prompt', late.length >= 1, JSON.stringify(late));
let resolved = 0;
again.on('trigger:resolved', () => resolved++);
gm.emit('fight:end', { mode: 'combat' });
await sleep(500);
check('ending the fight closes its prompts', resolved >= 1);

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [hero, angel]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
for (const s of [gm, pHero, pAngel, again]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

// Playtest: Frantic and the NPC types in fights (builder phase 4) — a Frantic
// Hero assembles a Stance each turn without last turn's parts, a Warrior's
// Path triggers at the start of combat (and each turn at level 7), a Boss takes
// a turn per Health Bar, and Stooges' bodies share one turn and one Stance.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-frantic-npcs.mjs
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
gm.emit('scene:create', { name: `P4 ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `P4 ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const fran = await jpost('/api/characters', { name: `P4Fran${stamp}`, characterType: 'pc' });
const warr = await jpost('/api/characters', { name: `P4Warr${stamp}`, characterType: 'npc' });
const stooge = await jpost('/api/characters', { name: `P4Stooge${stamp}`, characterType: 'npc' });
const boss = await jpost('/api/characters', { name: `P4Boss${stamp}`, characterType: 'npc' });
const pf = await connect({ role: 'player', characterId: fran.id });
pf.emit('build:save', {
  characterId: fran.id,
  build: {
    type: 'hero-type.frantic',
    archetypes: [{ id: 'archetype.phantom', variant: 'frantic' }, { id: 'archetype.demon', variant: 'frantic' }, { id: 'archetype.teacher', variant: 'frantic' }],
    forms: ['form.wild', 'form.iron', 'form.song'],
    styles: ['style.halcyon', 'style.heroic', 'style.aura'],
    level: 1,
  },
});
gm.emit('build:save', { characterId: warr.id, build: { type: 'character-type.warrior', level: 7, warriorPathId: 'warrior-path.tiger', archetypes: [{ id: 'archetype.the-tank', variant: 'fused' }], stances: [{ formId: 'form.iron', styleId: 'style.heroic' }] } });
gm.emit('build:save', { characterId: stooge.id, build: { type: 'character-type.stooges', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: boss.id, build: { type: 'character-type.boss', healthBars: 3, stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(600);
const place = (id, col, row) => gm.emit('combat_token:place', { ownerType: 'character', ownerId: id, col, row });
place(fran.id, 1, 1);
place(warr.id, 6, 1);
place(stooge.id, 6, 3);
place(stooge.id, 7, 3);
place(stooge.id, 8, 3);
place(boss.id, 9, 6);
await sleep(800);
let st = await jf('/api/stage?role=gm');
const tok = (cid) => st.combatTokens.filter((t) => t.character_id === cid);
const [tf] = tok(fran.id);
const [tw] = tok(warr.id);
const ts = tok(stooge.id);
const [tb] = tok(boss.id);
check('three Stooge bodies on the map', ts.length === 3, String(ts.length));
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [
  { ref: { combatantId: tf.id }, level: 1 }, { ref: { combatantId: tw.id }, level: 7, kind: 'warrior' },
  ...ts.map((t) => ({ ref: { combatantId: t.id }, level: 1, kind: 'warrior' })), { ref: { combatantId: tb.id }, level: 1, kind: 'warrior', bars: 3 },
] });
await sleep(500);

console.log('\n--- Start Combat: Improved Warrior, the order (Boss 3 turns, Stooges 1) ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tf.id }], enemies: [{ combatantId: tw.id }, ...ts.map((t) => ({ combatantId: t.id })), { combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: tf.id } });
await sleep(1500);
st = await jf('/api/stage?role=gm');
const fight = st.fights.combat;
const turns = (id) => fight.order.filter((e) => e.id === id).length;
check("the Warrior's Path gives its benefit at the start of combat (Tiger: 2 Power)", st.combatTokens.find((t) => t.id === tw.id).fight.tokens.power === 2, JSON.stringify(st.combatTokens.find((t) => t.id === tw.id).fight.tokens));
check('the Boss takes a turn per Health Bar (3)', turns(tb.id) === 3, JSON.stringify(fight.order));
check('the Stooges share one turn: only the leading body is in the order', turns(ts[0].id) === 1 && turns(ts[1].id) === 0 && turns(ts[2].id) === 0, JSON.stringify(fight.order));

console.log('\n--- the Frantic Hero assembles a Stance ---');
const pend = fight.pending_stance;
check('the turn waits on a Frantic pick: 3 Forms, 3 Styles, 3 Frantic Abilities', pend?.combatant_id === tf.id && pend.assemble?.forms.length === 3 && pend.assemble.styles.length === 3 && pend.assemble.abilities.length === 3, JSON.stringify(pend));
const phantom = 'ability.archetype-phantom.frantic-phantom';
const demon = 'ability.archetype-demon.frantic-demon';
pf.emit('fight:choose_stance', { mode: 'combat', stanceId: 'form.wild+style.aura', abilityId: phantom });
await sleep(1500);
st = await jf('/api/stage?role=gm');
let ff = st.combatTokens.find((t) => t.id === tf.id).fight;
const froll = cards.filter((c) => c.kind === 'stance_roll').at(-1);
check('the assembled Stance rolls and becomes active', froll?.payload.stance === 'Aura Wild Stance' || ff.active_stance_id === 'form.wild+style.aura', JSON.stringify([froll?.payload.stance, ff.active_stance_id]));
check("its parts' turn-start rules run: Wild 2 Power, Aura Shield 3, the picked Frantic Phantom 4 Poltergeist", ff.tokens.power === 2 && ff.tokens.shield === 3 && ff.tokens.poltergeist === 4, JSON.stringify(ff.tokens));
check('the Frantic Abilities not picked stay off (Frantic Demon gives no Chaos yet)', !ff.tokens.chaos);

console.log('\n--- the rest of the round, then the Frantic Hero again ---');
let guard = 0;
while (guard++ < 8) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(900);
  st = await jf('/api/stage?role=gm');
  if (st.fights.combat.pending_stance?.combatant_id === tf.id) break;
}
const opts = st.fights.combat.pending_stance?.assemble;
check("last turn's Form, Style and Ability are excluded", opts && opts.forms.find((o) => o.id === 'form.wild').used && opts.styles.find((o) => o.id === 'style.aura').used && opts.abilities.find((o) => o.id === phantom).used, JSON.stringify(opts));
const warrPower = st.combatTokens.find((t) => t.id === tw.id).fight.tokens.power;
check("Greater Warrior: the Path triggers again at the Warrior's turn start (2 + 2 Power)", warrPower === 4, String(warrPower));
const stooges = st.combatTokens.filter((t) => t.character_id === stooge.id).map((t) => t.fight.active_stance_id);
check('the Stooges share their Stance: every body took the roll', stooges.every((k) => k === 'form.power+style.halcyon'), JSON.stringify(stooges));
pf.emit('fight:choose_stance', { mode: 'combat', stanceId: 'form.wild+style.heroic', abilityId: demon });
await sleep(600);
check('a pick repeating last turn\'s Form is refused', (await jf('/api/stage?role=gm')).fights.combat.pending_stance?.combatant_id === tf.id);
pf.emit('fight:choose_stance', { mode: 'combat', stanceId: 'form.iron+style.heroic', abilityId: demon });
await sleep(1200);
st = await jf('/api/stage?role=gm');
check('a legal pick goes through', !st.fights.combat.pending_stance && st.combatTokens.find((t) => t.id === tf.id).fight.active_stance_id === 'form.iron+style.heroic', JSON.stringify(st.fights.combat.pending_stance));

gm.emit('fight:end', { mode: 'combat' });
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [fran, warr, stooge, boss]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
pf.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

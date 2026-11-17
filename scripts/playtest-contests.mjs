// Playtest: Stance Contests (GM Tools). Each contestant plays one turn at the
// same time in their own hidden arena (a real fight on the engine); the result
// is posted when every arena is done, and the arenas are deleted. Macho (damage
// to an infinite-HP target) with Skills off; Survival (three 5-damage hits at
// the turn's end) and Gambling (+2 to a number) with Skills on; a cancel.
//
//   (start the dev server first)
//   node scripts/playtest-contests.mjs
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
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
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
let state = null;
let states = 0;
gm.on('contest:state', (s) => {
  state = s;
  states++;
});
const prompts = [];
gm.on('trigger:prompt', (x) => {
  prompts.push(x);
  // Spend what's asked automatically: the first option (a target, "None"…), or decline a confirm.
  const answer = x.kind === 'confirm' ? false : x.kind === 'targets' ? [x.options[0].id] : x.minimum === 0 ? [] : x.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: x.id, answer }), 120);
});
const errors = [];
gm.on('contest:error', (e) => errors.push(e));
const marks = async () => (await jf('/api/dice-marks')).marks;

gm.emit('scene:create', { name: `SC ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `SC ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
const mk = (name, type) => jpost('/api/characters', { name: `${name}${stamp}`, characterType: type });
const ana = await mk('SCAna', 'pc');
const bo = await mk('SCBo', 'npc');
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.blaster', styleId: 'style.relentless' }] } });
await sleep(500);
const scenesBefore = (await jf('/api/scenes?role=gm')).length;
const DAMAGE = 'action.system-basic-actions.damage';
const arenaOf = (characterId) => state?.arenas?.find((a) => a.characterId === characterId);
const rollOf = (characterId) => cards.filter((c) => c.kind === 'stance_roll' && c.payload.character_id === characterId).at(-1)?.payload;

console.log('\n--- Macho, Skills off ---');
gm.emit('table_settings:set', { skillsEnabled: false });
await sleep(300);
gm.emit('contest:start', { def: { key: 'macho' }, sides: { a: [ana.id], b: [bo.id] } });
await sleep(2500);
check('the contest starts: one arena per contestant, everyone sees its state', state?.status === 'running' && state.arenas.length === 2 && states > 0, JSON.stringify(state && { status: state.status, n: state.arenas?.length, errors }));
check('…each arena: the contestant and one infinite-HP target', state?.arenas.every((a) => a.tokens.length === 2 && a.tokens.some((t) => t.fight?.infinite)), JSON.stringify(state?.arenas.map((a) => a.tokens.map((t) => [t.name, t.fight?.infinite]))));
check('…Skills off: nobody has a bonus step — both turns start at once', state?.arenas.every((a) => a.ready) && rollOf(ana.id) && rollOf(bo.id), JSON.stringify(cards.map((c) => c.kind)));
check('…the arenas are hidden: no new Scene in the list', (await jf('/api/scenes?role=gm')).length === scenesBefore);
check('…and their targets are no characters of the table', !(await jf('/api/characters')).some((c) => /^Target/.test(c.name)));
check('…a card announces it', cards.some((c) => c.payload?.automatic === 'contest' && /Macho/.test(c.payload.title)));
const anaHp = arenaOf(ana.id).tokens.find((t) => t.character_id === ana.id)?.fight?.hp;
check('contestants start fresh: full HP from their build', anaHp && anaHp.current === anaHp.max && anaHp.max > 0, JSON.stringify(anaHp));

// Ana hits her target with her biggest die.
const r = rollOf(ana.id);
const big = r.results.map((x, i) => ({ v: x.result, i })).sort((a, b) => b.v - a.v)[0];
gm.emit('board:place', { rollId: r.roll_id, die: big.i, actionId: DAMAGE });
await sleep(400);
if ((await marks())[r.roll_id]?.placements[0]?.threshold > 1) gm.emit('board:stop', { rollId: r.roll_id, key: `d${big.i}`, stop: 1 });
await sleep(300);
gm.emit('board:commit', { rollId: r.roll_id });
await sleep(2500);
const dummy = arenaOf(ana.id).tokens.find((t) => t.character_id !== ana.id);
check("Ana's hit lands on her own target (counted, never taken)", (dummy?.fight?.damage_taken ?? dummy?.damage_taken ?? 0) > 0, JSON.stringify(dummy?.fight ?? dummy));
gm.emit('board:end_turn', { rollId: r.roll_id });
await sleep(1500);
check("Ana's arena is done; the contest waits for Bo", arenaOf(ana.id)?.done && !arenaOf(bo.id)?.done && state.status === 'running', JSON.stringify(state?.arenas.map((a) => [a.name, a.done])));
gm.emit('board:end_turn', { rollId: rollOf(bo.id).roll_id });
await sleep(2000);
const won = cards.filter((c) => c.payload?.automatic === 'contest').at(-1);
check('every arena done: the result — Ana wins Macho', state?.status === 'done' && state.result?.winner === 'a' && /SCAna/.test(won?.payload.text ?? ''), JSON.stringify({ result: state?.result, card: won?.payload }));
check('…the arenas are gone', (await jf('/api/contest'))?.arenas?.every((a) => !a.tokens?.length) ?? true);

console.log('\n--- Survival, Skills on (a green d8; three Iron) ---');
gm.emit('table_settings:set', { skillsEnabled: true });
await sleep(300);
gm.emit('contest:start', { def: { key: 'survival' }, sides: { a: [ana.id], b: [bo.id] } });
await sleep(1500);
check('Skills on: the arenas wait for their bonuses', state?.status === 'running' && state.arenas.every((a) => !a.ready), JSON.stringify(state?.arenas.map((a) => a.ready)));
const rollsBefore = cards.filter((c) => c.kind === 'stance_roll').length;
gm.emit('contest:ready', { contestId: state.id, combatantId: arenaOf(ana.id).combatantId, bonuses: [{ key: 'dice_d8' }] });
await sleep(1500);
const anaRoll = rollOf(ana.id);
check('a green d8 joins her roll', cards.filter((c) => c.kind === 'stance_roll').length === rollsBefore + 1 && anaRoll.results.some((x) => x.color === 'green' && x.die === 8), JSON.stringify(anaRoll?.results));
gm.emit('contest:ready', { contestId: state.id, combatantId: arenaOf(bo.id).combatantId, bonuses: [{ key: 'basic_tokens', tokens: ['iron', 'iron', 'iron'] }] });
await sleep(1500);
const boTok = arenaOf(bo.id).tokens.find((t) => t.character_id === bo.id);
check('Bo takes 3 Iron', (boTok?.fight?.tokens?.iron ?? 0) >= 3, JSON.stringify(boTok?.fight?.tokens));
gm.emit('board:end_turn', { rollId: anaRoll.roll_id });
gm.emit('board:end_turn', { rollId: rollOf(bo.id).roll_id });
await sleep(5000);
const survival = cards.filter((c) => c.payload?.title === 'Survival');
check('each takes three 5-damage hits at the turn’s end', survival.length === 6, JSON.stringify(survival.map((c) => c.payload.text)));
const res = state?.result;
check('…and the HP lost decides it', state?.status === 'done' && res?.scores?.every((s) => Number.isFinite(s.stats?.hpLost)), JSON.stringify(res));

console.log('\n--- Gambling: +2 after rolling ---');
gm.emit('contest:start', { def: { key: 'gambling' }, sides: { a: [ana.id], b: [bo.id] } });
await sleep(1500);
gm.emit('contest:ready', { contestId: state.id, combatantId: arenaOf(ana.id).combatantId, bonuses: [{ key: 'plus_two' }] });
await sleep(1500);
const g = rollOf(ana.id);
const v0 = (await marks())[g.roll_id].results[0].result;
gm.emit('contest:plus_two', { contestId: state.id, combatantId: arenaOf(ana.id).combatantId, index: 0 });
await sleep(500);
check('+2 raises one number', (await marks())[g.roll_id].results[0].result === v0 + 2, `${v0} → ${(await marks())[g.roll_id].results[0].result}`);
gm.emit('contest:plus_two', { contestId: state.id, combatantId: arenaOf(ana.id).combatantId, index: 1 });
await sleep(500);
check('…once per bonus', (await marks())[g.roll_id].results[1].result === g.results[1].result);

console.log('\n--- Cancel ---');
gm.emit('contest:cancel');
await sleep(800);
check('the GM calls it off: no contest, the arenas gone', state === null && (await jf('/api/contest')) === null, JSON.stringify(state));
gm.emit('contest:start', { def: { key: 'sumo' }, sides: { a: [ana.id], b: [] } });
await sleep(500);
check('a side with nobody is refused', errors.length === 1, JSON.stringify(errors));

gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
gm.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

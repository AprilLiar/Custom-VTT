// Playtest: Damage Resolution "WEPIA" (full automation, phase C) — the
// attacker's Weakness and Power, the target's Iron and Shield (asked of a
// player, spent by an NPC), Armor 3 → 2 with temporary Armor last, the dice
// board's Power toggle on a committed Action, and the End Phase's Burning,
// Challenge removal and Fatigue discard. Also the sheet's Hit spends setting.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-damage.mjs
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
// Board animations: what the engine did (fight:effects, before each stage:updated).
const beats = [];
let effectsBeforeStage = 0;
let pendingEffects = false;
gm.on('fight:effects', (m) => {
  beats.push(...m.beats);
  pendingEffects = true;
});
gm.on('stage:updated', () => {
  if (pendingEffects) effectsBeforeStage++;
  pendingEffects = false;
});
gm.emit('scene:create', { name: `DM ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `DM ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(300);
const mira = await jpost('/api/characters', { name: `DMMira${stamp}`, characterType: 'pc' });
const thug = await jpost('/api/characters', { name: `DMThug${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: mira.id });
// Mira: Blaster Form + Swift Style (no Armor of her own). The Thug: Power Form
// (Enhance a Hit 2 more times) + Halcyon Style.
gm.emit('build:save', { characterId: mira.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.blaster', styleId: 'style.swift' }] } });
gm.emit('build:save', { characterId: thug.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: mira.id, col: 2, row: 2 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: thug.id, col: 3, row: 2 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const tm = st.combatTokens.find((t) => t.character_id === mira.id);
const tt = st.combatTokens.find((t) => t.character_id === thug.id);
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [{ ref: { combatantId: tm.id }, level: 1 }, { ref: { combatantId: tt.id }, level: 1, kind: 'warrior' }] });
await sleep(400);
const fight = async (id) => (await jf('/api/stage?role=gm')).combatTokens.find((t) => t.id === id).fight;
const token = (ref, key, delta) => gm.emit('fighter:token', { ref: { combatantId: ref }, key, delta });

// Mira's player answers: Iron — 1 the first time, none after; Shield — yes;
// targets — the first offered.
const prompts = [];
let ironAnswers = ['1'];
p.on('trigger:prompt', (x) => {
  prompts.push(x);
  let answer;
  if (x.title === 'Reduce the hit') answer = ironAnswers.shift() ?? '0';
  else if (x.kind === 'targets') answer = [x.options[0].id];
  else if (x.kind === 'confirm') answer = true;
  else answer = x.options[0].id;
  setTimeout(() => p.emit('trigger:answer', { id: x.id, answer }), 100);
});

console.log("\n--- the Thug's turn: one hit, every step ---");
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: tm.id }], enemies: [{ combatantId: tt.id }], firstSide: 'enemies', opener: { combatantId: tt.id } });
await sleep(1800);
const marks = async () => (await jf('/api/dice-marks')).marks;
const thugRoll = cards.filter((c) => c.kind === 'stance_roll').at(-1);
check("an NPC's board starts with Power on (Auto)", (await marks())[thugRoll?.payload.roll_id]?.power === true, JSON.stringify((await marks())[thugRoll?.payload.roll_id]));
// Clear whatever the turn start gave, then set up the hit.
for (const [id, keys] of [[tt.id, ['power', 'iron', 'speed', 'weakness']], [tm.id, ['power', 'iron', 'speed', 'shield', 'armor', 'temp_armor']]]) {
  for (const k of keys) gm.emit('fighter:token', { ref: { combatantId: id }, key: k, clear: true });
}
await sleep(300);
token(tt.id, 'weakness', 1);
token(tt.id, 'power', 2);
token(tm.id, 'iron', 2);
token(tm.id, 'shield', 2);
token(tm.id, 'armor', 1);
await sleep(500);
const hp0 = (await fight(tm.id)).hp.current;
gm.emit('fighter:damage', { ref: { combatantId: tm.id }, amount: 8 });
await sleep(2000);
let fm = await fight(tm.id);
let ft = await fight(tt.id);
// 8 −2 Weakness = 6, +2 Power = 8, −1 Iron = 7, Shield absorbs 2 = 5, Armor −3 = 2.
check('8 damage: Weakness −2, Power +2, Iron −1, Shield 2, Armor −3 → 2 to HP', fm.hp.current === hp0 - 2, `${hp0} → ${fm.hp.current}`);
check('the attacker spent their Weakness and Power (NPC: Auto)', !ft.tokens.weakness && !ft.tokens.power, JSON.stringify(ft.tokens));
check('the target spent 1 Iron and the Shield broke; the Armor token stays', fm.tokens.iron === 1 && !fm.tokens.shield && fm.tokens.armor === 1, JSON.stringify(fm.tokens));
check('the player was asked about Iron (0–2) and the Shield', prompts.some((x) => x.title === 'Reduce the hit' && x.options.length === 3) && prompts.some((x) => x.title === 'Shield'), JSON.stringify(prompts.map((x) => x.title)));
{
  const hit = beats.flatMap((b) => b.effects).filter((e) => e.kind === 'damage' && e.combatantId === tm.id).pop();
  check('animations: one damage beat — 2 to HP, 2 absorbed by the Shield, before/after HP held', hit && hit.data.amount === 2 && hit.data.absorbed === 2 && hit.data.broke && hit.before.hp.current === hp0 && hit.after.hp.current === hp0 - 2 && hit.before.tokens.shield === 2 && !hit.after.tokens.shield, JSON.stringify(hit));
  const atk = beats.flatMap((b) => b.effects).find((e) => e.kind === 'tokens' && e.combatantId === tt.id && e.data.changes.some((c) => c.key === 'power' && c.delta === -2));
  check("animations: the attacker's Weakness and Power spent show as token losses", atk && atk.data.changes.some((c) => c.key === 'weakness' && c.delta === -1), JSON.stringify(atk));
  check('animations: each batch of effects is followed by its stage update', effectsBeforeStage > 0 && !pendingEffects, `${effectsBeforeStage}`);
  check('animations: manual token edits play nothing (engine only)', !beats.flatMap((b) => b.effects).some((e) => e.kind === 'tokens' && e.data.changes.some((c) => c.key === 'armor' && c.delta > 0)), '');
  check("animations: the target's Shield and Iron are inside the damage beat, not separate token beats", !beats.flatMap((b) => b.effects).some((e) => e.kind === 'tokens' && e.combatantId === tm.id && e.data.changes.some((c) => c.key === 'shield' || c.key === 'iron')), JSON.stringify(beats.map((b) => b.effects.map((e) => [e.kind, e.combatantId]))));
}
check('the card tells the whole story', cards.some((c) => c.payload?.automatic === 'damage' && /Weakness −2, Power \+2, Iron −1, Shield absorbs 2 and breaks, Armor −3/.test(c.payload.text)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'damage').map((c) => c.payload.text)));

token(tm.id, 'temp_armor', 1);
await sleep(300);
gm.emit('fighter:damage', { ref: { combatantId: tm.id }, amount: 3 });
await sleep(1800);
fm = await fight(tm.id);
check('a second hit this turn: Armor is used, temporary Armor blocks 2 (the 2nd trigger) and is lost', fm.hp.current === hp0 - 3 && !fm.tokens.temp_armor, `${fm.hp.current} vs ${hp0 - 3}; ${JSON.stringify(fm.tokens)}`);

console.log("\n--- Mira's turn: the Power toggle, then the End Phase ---");
gm.emit('fight:next', { mode: 'combat' });
await sleep(1800);
const roll = cards.filter((c) => c.kind === 'stance_roll').at(-1);
const rollId = roll?.payload.roll_id;
check("a player's board starts with Power off (Ask)", (await marks())[rollId]?.power === false);
for (const k of ['power', 'iron', 'speed', 'burning', 'fatigue']) gm.emit('fighter:token', { ref: { combatantId: tm.id }, key: k, clear: true });
for (const k of ['power', 'iron', 'speed', 'shield', 'weakness']) gm.emit('fighter:token', { ref: { combatantId: tt.id }, key: k, clear: true });
await sleep(300);
token(tm.id, 'power', 1);
token(tm.id, 'burning', 5);
token(tm.id, 'fatigue', 2);
gm.emit('fighter:challenge', { ref: { combatantId: tm.id }, target: { combatantId: tt.id } });
await sleep(500);
const DAMAGE = 'action.system-basic-actions.damage';
const big = [...roll.payload.results.map((r, i) => ({ v: r.result, i }))].sort((a, c) => c.v - a.v)[0];
p.emit('board:place', { rollId, die: big.i, actionId: DAMAGE });
await sleep(300);
if ((await marks())[rollId].placements[0]?.threshold > 1) p.emit('board:stop', { rollId, key: `d${big.i}`, stop: 1 });
p.emit('board:power', { rollId, on: true });
await sleep(300);
const thugHp = (await fight(tt.id)).hp.current;
p.emit('board:commit', { rollId });
await sleep(2500);
ft = await fight(tt.id);
fm = await fight(tm.id);
{
  const all = beats.flatMap((b) => b.effects);
  const act = all.filter((e) => e.kind === 'action' && e.combatantId === tm.id).pop();
  check('animations: the committed Action is an "action" beat that lunges at the thug', act && act.data.targets?.[0] === tt.id && act.data.name, JSON.stringify(act));
  check("animations: Mira's turn start is a \"turn\" beat", all.some((e) => e.kind === 'turn' && e.combatantId === tm.id), JSON.stringify(all.filter((e) => e.kind === 'turn')));
  const i = all.indexOf(act);
  check('…played before the damage it led to', i >= 0 && all.slice(i).some((e) => e.kind === 'damage' && e.combatantId === tt.id), '');
}
check('Damage at 1+ with the Power toggle on: 1 +1 Power = 2', thugHp - ft.hp.current === 2, `${thugHp} → ${ft.hp.current}`);
check('…and the Power is spent', !fm.tokens.power, JSON.stringify(fm.tokens));
const hpBeforeEnd = fm.hp.current;
const asked = prompts.length;
p.emit('board:end_turn', { rollId });
await sleep(1200);
// Late Movement first if anyone holds Speed (phase D; Swift Style gives some): everyone passes.
for (const id of (await jf('/api/stage?role=gm')).fights.combat?.movement_phase?.waiting ?? []) gm.emit('move:done', { combatantId: id });
await sleep(2500);
fm = await fight(tm.id);
// Burning 5: no Iron, no Shield; Armor (a new turn) −3 → 2; discard 3.
check('End Phase Burning: 5 −3 Armor = 2 damage, then discard half rounded up (2 left)', fm.hp.current === hpBeforeEnd - 2 && fm.tokens.burning === 2, `${hpBeforeEnd} → ${fm.hp.current}; ${JSON.stringify(fm.tokens)}`);
check('Iron is never offered against Burning', !prompts.slice(asked).some((x) => x.title === 'Reduce the hit'), JSON.stringify(prompts.slice(asked).map((x) => x.title)));
check('the Challenge is removed: she attacked her Challenger this turn', fm.challenge_id == null, JSON.stringify(fm));
check("Fatigue: she didn't move, so she discards it", !fm.tokens.fatigue, JSON.stringify(fm.tokens));
check('one End Phase notice says all of it', cards.some((c) => c.payload?.automatic === 'end_phase' && c.payload.notice && /Burning/.test(c.payload.text) && /Challenge is removed/.test(c.payload.text) && /Fatigue/.test(c.payload.text)), JSON.stringify(cards.filter((c) => c.payload?.automatic === 'end_phase').map((c) => c.payload.text)));

console.log('\n--- the sheet: Hit spends ---');
const saved = (await jf(`/api/characters/${mira.id}/build`)).build;
p.emit('build:save', { characterId: mira.id, build: { ...saved, prefs: { iron: 'auto', shield: 'never', power: 'bogus' } } });
await sleep(500);
const prefs = (await jf(`/api/characters/${mira.id}/build`)).build.prefs;
check('the build keeps Ask / Auto / Never per spend, dropping anything else', prefs.iron === 'auto' && prefs.shield === 'never' && prefs.power === undefined, JSON.stringify(prefs));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
await sleep(300);
for (const c of [mira, thug]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

// Playtest: Character Creation, applied for real.
//
// **A preset's numbers are guidance, not a gate (decided, revised).** Going
// over them is warned about and then allowed, and every step of the flow —
// including the preset itself — can be skipped. So the probes that matter most
// here are the ones that check an unusual build still lands intact, and that
// what it did differently was said out loud rather than hidden.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-character-creation.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

const sheet = async (id) => jf(`/api/characters/${id}`);
const die = (data, slot) => data.dice.find((d) => d.slot_name === slot);
const sig = (d) => (d ? `d${d.current_size}${d.bonus ? `+${d.bonus}` : ''}/${d.status}` : null);

const ruleset = await jf('/api/ruleset');
const [styleA, styleB] = ruleset.attributes;

// A styled Move and an unstyled one — the styled one is how the flow's
// learnability rule gets tested.
gm.emit('tell:create', { name: `CC Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `CC Tell ${stamp}`);
const mkMove = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: false, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};
const plainMove = await mkMove('CC Plain');
const styledMove = await mkMove('CC Styled', { styleAttributeId: styleA.id });
const offStyleMove = await mkMove('CC Off Style', { styleAttributeId: styleB.id });

gm.emit('perk:create', { name: `CC Perk A ${stamp}`, description: '' });
const perkA = await wait('perk:created', (p) => p.name === `CC Perk A ${stamp}`);
gm.emit('perk:create', { name: `CC Perk B ${stamp}`, description: '' });
const perkB = await wait('perk:created', (p) => p.name === `CC Perk B ${stamp}`);

// ============================================== 1. a legal Adult build
console.log('\n--- an Adult build, applied end to end ---');
const hero = await jpost('/api/characters', { name: `Hero${stamp}`, characterType: 'pc' });
const before = await sheet(hero.id);
check('every Stat starts at a bare d4', before.dice.every((d) => d.current_size === 4 && d.bonus === 0),
  JSON.stringify(before.dice.map((d) => sig(d))));

gm.emit('character:apply_creation', {
  characterId: hero.id,
  presetKey: 'adult',
  // 4 + 4 + 3 + 2 + 3 = 16, exactly the Adult budget.
  statRanks: { Skull: 4, Body: 4, Stamina: 3, Brain: 2, 'Right Hand': 3 },
  stance: { name: `CC Stance ${stamp}`, attributeAId: styleA.id, attributeBId: styleB.id },
  moveIds: [plainMove.id, styledMove.id],
  perkIds: [perkA.id, perkB.id],
  roleplay: { 'What is their irrational fear?': 'Ceiling fans.' },
});
const applied = await wait('character:creation_applied', (p) => p.characterId === hero.id);
await sleep(600);
const after = await sheet(hero.id);

console.log('  stats:', after.dice.map((d) => `${d.slot_name} ${sig(d)}`).join(', '));
check('the bought Stats are set, not stepped from wherever they were',
  sig(die(after, 'Skull')) === 'd12/active' && sig(die(after, 'Body')) === 'd12/active' &&
    sig(die(after, 'Stamina')) === 'd10/active' && sig(die(after, 'Brain')) === 'd8/active' &&
    sig(die(after, 'Right Hand')) === 'd10/active',
  JSON.stringify(after.dice.map((d) => `${d.slot_name} ${sig(d)}`)));
check('unspent Stats stay at d4', sig(die(after, 'Left Leg')) === 'd4/active', sig(die(after, 'Left Leg')));

check('the stance was created and taken', after.character.active_stance_id != null &&
  after.stances.some((s) => s.id === after.character.active_stance_id && s.name === `CC Stance ${stamp}`),
  JSON.stringify(after.stances.map((s) => s.name)));

const grantedMoves = after.moves.filter((m) => !m.is_default).map((m) => m.name);
console.log('  moves:', JSON.stringify(grantedMoves));
check('both picked Moves were granted', grantedMoves.length === 2, JSON.stringify(grantedMoves));
check('the styled one stuck, because the stance carries its Style',
  grantedMoves.includes(`CC Styled ${stamp}`), JSON.stringify(grantedMoves));

check('both Perks were granted', after.perks.length === 2, JSON.stringify(after.perks.map((p) => p.name)));
check('the role-play answer was saved',
  after.roleplay.some((r) => r.answer === 'Ceiling fans.'), JSON.stringify(after.roleplay));

// Locking is what makes the spread a baseline and recomputes Max Stamina.
check('the Stats were locked as the baseline',
  after.dice.every((d) => d.locked_size === d.current_size && d.locked_bonus === d.bonus),
  JSON.stringify(after.dice.map((d) => `${d.slot_name} ${d.current_size}/${d.locked_size}`)));
// Stamina d10 x the default x4 multiplier.
check('Max Stamina was recomputed from the Stamina die', after.character.max_stamina === 40,
  JSON.stringify({ max: after.character.max_stamina, mult: after.character.stamina_multiplier }));
check('and they start full', after.character.current_stamina === after.character.max_stamina,
  JSON.stringify({ cur: after.character.current_stamina, max: after.character.max_stamina }));
check('nothing was reported as unlearnable', (applied.skippedMoves ?? []).length === 0,
  JSON.stringify(applied.skippedMoves));

// ============================ 2. over the suggestion: warned, then allowed
console.log('\n--- a Teenager built well past what the preset suggests ---');
const heavy = await jpost('/api/characters', { name: `Heavy${stamp}`, characterType: 'pc' });
gm.emit('character:apply_creation', {
  characterId: heavy.id,
  presetKey: 'teenager',                       // suggests 8 points, 3 Perks
  statRanks: { Skull: 6, Body: 6, Brain: 6 },  // 18
  perkIds: [perkA.id, perkB.id],
});
const heavyApplied = await wait('character:creation_applied', (p) => p.characterId === heavy.id);
console.log('  warnings:', JSON.stringify(heavyApplied.warnings));
check('going over is allowed, not refused', heavyApplied != null);
check('...and it is warned about, in the preset\'s own words',
  (heavyApplied.warnings ?? []).some((w) => /suggests 8 Stat points/.test(w)),
  JSON.stringify(heavyApplied.warnings));
await sleep(600);
const heavySheet = await sheet(heavy.id);
check('the over-budget spread really landed',
  sig(die(heavySheet, 'Skull')) === 'd12+2/active' && sig(die(heavySheet, 'Brain')) === 'd12+2/active',
  JSON.stringify(heavySheet.dice.map((d) => `${d.slot_name} ${sig(d)}`)));
const chat = await jf('/api/chat');
check('the table is told, rather than having to notice',
  chat.some((e) => typeof e.message === 'string' && /suggests 8 Stat points/.test(e.message)),
  JSON.stringify(chat.slice(-4).map((e) => e.message)));

console.log('\n--- every step skipped: the emptiest possible build ---');
const blank = await jpost('/api/characters', { name: `Blank${stamp}`, characterType: 'pc' });
gm.emit('character:apply_creation', { characterId: blank.id });
const blankApplied = await wait('character:creation_applied', (p) => p.characterId === blank.id);
check('no preset, no Stats, no anything — still applies', blankApplied.presetKey === null,
  JSON.stringify(blankApplied));
await sleep(600);
const blankSheet = await sheet(blank.id);
check('Stats stay at a bare d4', blankSheet.dice.every((d) => sig(d) === 'd4/active'),
  JSON.stringify(blankSheet.dice.map((d) => sig(d))));
check('nothing was granted', blankSheet.perks.length === 0 &&
  blankSheet.moves.filter((m) => !m.is_default).length === 0);
check('but the Stats WERE locked, so the character has a baseline',
  blankSheet.dice.every((d) => d.locked_size === 4), JSON.stringify(blankSheet.dice.map((d) => d.locked_size)));

console.log('\n--- an unknown Perk id ---');
const cheat = await jpost('/api/characters', { name: `Cheat${stamp}`, characterType: 'pc' });
gm.emit('character:apply_creation', {
  characterId: cheat.id, presetKey: 'teenager', statRanks: {},
  perkIds: [perkA.id, perkB.id, plainMove.id + 100000, perkA.id],
});
await sleep(900);
const stillBare = await sheet(cheat.id);
check('an unknown Perk id is dropped rather than counted', stillBare.perks.length === 2,
  JSON.stringify(stillBare.perks.map((p) => p.name)));

console.log('\n--- a genuinely broken stance is still refused ---');
gm.emit('character:apply_creation', {
  characterId: cheat.id, presetKey: 'adult',
  stance: { name: 'Half a Stance', attributeAId: styleA.id, attributeBId: styleA.id },
});
const rejected = await wait('character:creation_rejected', (p) => p.characterId === cheat.id);
console.log('  errors:', JSON.stringify(rejected.errors));
check('two of the same Style is not a stance', rejected.errors.some((e) => /two different Styles/i.test(e)),
  JSON.stringify(rejected.errors));

// ============================= 3. learnability is not bypassed by creation
console.log('\n--- a Move whose Style the new stance does not carry ---');
const student = await jpost('/api/characters', { name: `Student${stamp}`, characterType: 'pc' });
gm.emit('character:apply_creation', {
  characterId: student.id,
  presetKey: 'teenager',
  statRanks: { Skull: 8 },
  // A stance of styleA + a third style, so styleB is NOT carried.
  stance: {
    name: `Narrow ${stamp}`,
    attributeAId: styleA.id,
    attributeBId: (ruleset.attributes[2] ?? styleB).id,
  },
  moveIds: [plainMove.id, offStyleMove.id],
});
const studentApplied = await wait('character:creation_applied', (p) => p.characterId === student.id);
await sleep(600);
const studentSheet = await sheet(student.id);
const studentMoves = studentSheet.moves.filter((m) => !m.is_default).map((m) => m.name);
console.log('  moves:', JSON.stringify(studentMoves), 'skipped:', JSON.stringify(studentApplied.skippedMoves));
check('the unstyled Move was granted', studentMoves.includes(`CC Plain ${stamp}`), JSON.stringify(studentMoves));
check('the off-Style Move was NOT — creation is no way around learnability',
  !studentMoves.includes(`CC Off Style ${stamp}`), JSON.stringify(studentMoves));
check('...and it was said out loud rather than silently dropped',
  (studentApplied.skippedMoves ?? []).includes(`CC Off Style ${stamp}`),
  JSON.stringify(studentApplied.skippedMoves));

// ================================================ 4. re-running is idempotent
console.log('\n--- running the flow again re-states the spread, never stacks ---');
gm.emit('character:apply_creation', {
  characterId: hero.id, presetKey: 'adult',
  statRanks: { Skull: 4, Body: 4, Stamina: 3, Brain: 2, 'Right Hand': 3 },
  moveIds: [plainMove.id], perkIds: [perkA.id],
});
await wait('character:creation_applied', (p) => p.characterId === hero.id);
await sleep(600);
const rerun = await sheet(hero.id);
check('the Stats are exactly where they were, not doubled',
  sig(die(rerun, 'Skull')) === 'd12/active' && sig(die(rerun, 'Stamina')) === 'd10/active',
  JSON.stringify(rerun.dice.map((d) => `${d.slot_name} ${sig(d)}`)));
check('re-granting the same Move is a no-op, not a duplicate',
  rerun.moves.filter((m) => m.name === `CC Plain ${stamp}`).length === 1);
check('and the Perk they already had is still one Perk',
  rerun.perks.filter((p) => p.id === perkA.id).length === 1, JSON.stringify(rerun.perks.map((p) => p.name)));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

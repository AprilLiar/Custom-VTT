// Playtest for **Endless Possibilities** — learn and use any Move regardless
// of its own Style requirement, keeping your own stance for everything else
// a Style governs.
//
// Two enforcement points, both guarded by the identical
// `perkBypassesStyleRequirement` check (server/index.js): `move:grant`
// (learning) and `move:declare` (using it in combat, from a stance that
// still doesn't carry the Style). Both are probed live rather than as unit
// tests because both are socket-handler-level gates, not exported
// functions — the seam resolver itself is already pinned in
// server/test/perkEngine.test.js.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-endless-possibilities.mjs
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
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(500);
const stamp = Date.now();

const perks = await jf('/api/perks');
const perk = (perks ?? []).find((p) => p.name === 'Endless Possibilities');
check('"Endless Possibilities" was seeded from the registry', perk != null,
  JSON.stringify((perks ?? []).map((p) => p.name)));
check('...and is flagged automated, not manual', perk?.automated === true && perk?.manual === false,
  JSON.stringify(perk));
if (!perk) { console.log(`\n${failures} FAILED`); process.exit(1); }

const ruleset = await jf('/api/ruleset');
const [styleA, styleB] = ruleset.attributes;

gm.emit('tell:create', { name: `EP Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `EP Tell ${stamp}`);
const mkMove = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: false, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};
const styledMove = await mkMove('EP Styled', { styleAttributeId: styleA.id });

const grantPerk = async (characterId) => {
  gm.emit('perk:grant', { characterId, perkId: perk.id });
  await sleep(400);
};

// ============================================ 1. learning
console.log('\n--- move:grant: refused without the Style, allowed once Endless Possibilities is held ---');
const learner = await jpost('/api/characters', { name: `EPLearner${stamp}`, characterType: 'pc' });
// A stance carrying styleB only — deliberately NOT styleA, the Move's own.
gm.emit('stance:create', {
  characterId: learner.id, name: `EP Stance ${stamp}`, attributeAId: styleB.id, attributeBId: styleB.id,
});
await sleep(400);

gm.emit('move:grant', { characterId: learner.id, moveId: styledMove.id });
await sleep(400);
let learnerSheet = await jf(`/api/characters/${learner.id}`);
check(
  'refused without the Style and without the Perk',
  !learnerSheet.moves?.some((m) => m.id === styledMove.id),
  JSON.stringify(learnerSheet.moves?.map((m) => m.name))
);

await grantPerk(learner.id);
gm.emit('move:grant', { characterId: learner.id, moveId: styledMove.id });
await sleep(400);
learnerSheet = await jf(`/api/characters/${learner.id}`);
check(
  'granted once the character holds Endless Possibilities, despite still lacking the Style',
  learnerSheet.moves?.some((m) => m.id === styledMove.id),
  JSON.stringify(learnerSheet.moves?.map((m) => m.name))
);

// ============================================ 2. using it in combat
console.log('\n--- move:declare: refused without the Style, allowed once Endless Possibilities is held ---');
const attacker = await jpost('/api/characters', { name: `EPAttacker${stamp}`, characterType: 'pc' });
const foe = await jpost('/api/characters', { name: `EPFoe${stamp}`, characterType: 'pc' });
// Same off-style stance as above. Getting the styled Move onto the sheet at
// all needs EITHER the Style or the Perk (move:grant's own gate, just
// proven above) — so the Perk is granted, used to learn the Move, then
// revoked again, leaving exactly the state this test wants: a character who
// KNOWS a styled Move but currently holds neither its Style nor the Perk.
// The declare-time gate is what's under test from here.
gm.emit('stance:create', {
  characterId: attacker.id, name: `EP AtkStance ${stamp}`, attributeAId: styleB.id, attributeBId: styleB.id,
});
await sleep(300);
await grantPerk(attacker.id);
gm.emit('move:grant', { characterId: attacker.id, moveId: styledMove.id });
await sleep(300);
const attackerSheetBefore = await jf(`/api/characters/${attacker.id}`);
if (!attackerSheetBefore.moves?.some((m) => m.id === styledMove.id)) {
  bail(new Error('setup: styled move did not reach the attacker'));
}
gm.emit('perk:revoke', { characterId: attacker.id, perkId: perk.id });
await sleep(300);

gm.emit('combat:add_participant', { characterId: attacker.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === attacker.id));
gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const turnOf = async (who, other) => {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0]?.declaringSide;
  const wantedSide = st.participants.find((p) => p.character_id === who.id)?.side;
  if (side && side !== wantedSide) {
    gm.emit('combat:character_done_declaring', { characterId: other.id });
    await sleep(500);
  }
};
// As the attacker's OWN player identity, not the GM — isRevealedToViewer
// only auto-shows a GM an NPC's row, so a PC's still-secret pending move
// would look absent (moveId nulled) from the GM's own view regardless of
// whether it actually landed.
const declaredMoveOf = async (characterId) => {
  const st = await jf(`/api/combat?role=player&characterId=${characterId}`);
  return st.declaredMoves?.find((d) => d.characterId === characterId) ?? null;
};

await turnOf(attacker, foe);
gm.emit('move:declare', { characterId: attacker.id, moveId: styledMove.id, placementTic: 1 });
await sleep(500);
check(
  'refused at declare time without the Style and without the Perk (still off-stance)',
  (await declaredMoveOf(attacker.id)) == null,
  JSON.stringify(await declaredMoveOf(attacker.id))
);

await grantPerk(attacker.id);
await turnOf(attacker, foe);
gm.emit('move:declare', { characterId: attacker.id, moveId: styledMove.id, placementTic: 1 });
await sleep(500);
check(
  'declared once the attacker holds Endless Possibilities, despite the active stance still lacking the Style',
  (await declaredMoveOf(attacker.id))?.moveId === styledMove.id,
  JSON.stringify(await declaredMoveOf(attacker.id))
);

gm.emit('combat:clear', {});
await sleep(300);

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
gm.close();
process.exit(failures === 0 ? 0 : 1);

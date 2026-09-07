// Playtest: "Revert stats to base" has to heal a pending HALF step (section 1)
// and a Temporary Damage debt (section 2) too — neither is a size.
//
// Half damage is half a step already taken, waiting for its other half
// (applyHalfDamage in gameLogic.js). Temporary Damage debt is what's still
// owed back at 0.5 a Round by healTemporaryDamage (roundResolution.js).
// Reverting wrote size, bonus and status back to the locked baseline and left
// both standing, so a Stat put back to base still took its next hit as though
// it were already half gone, and kept "healing" a debt from before the revert
// even once something else damaged it again for real.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-revert-stats.mjs
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
gm.emit('identity:set', { role: 'gm' });
await sleep(400);

const stamp = Date.now();
const char = await jpost('/api/characters', { name: `Rev${stamp}` });
const diceOf = async (characterId) => (await jf(`/api/characters/${characterId}`)).dice;
const body = (dice) => dice.find((d) => d.slot_name === 'Body');

// Step Body up twice so reverting has somewhere to come back FROM, then lock
// that as the baseline.
gm.emit('die:step', { dieId: body(await diceOf(char.id)).id, direction: 'up' });
await sleep(300);
gm.emit('die:step', { dieId: body(await diceOf(char.id)).id, direction: 'up' });
await sleep(300);
gm.emit('character:lock_stats', { characterId: char.id });
await sleep(400);
const locked = body(await diceOf(char.id));
console.log(`  base after lock: d${locked.current_size}+${locked.bonus} (locked d${locked.locked_size})`);

// Now take a single half-step of damage and a full step, so the die is BOTH
// smaller and carrying a pending half.
gm.emit('die:step', { dieId: locked.id, direction: 'down' });
await sleep(300);
gm.emit('die:toggle_half_damage', { dieId: locked.id });
await sleep(400);
const hurt = body(await diceOf(char.id));
console.log(`  hurt: d${hurt.current_size}+${hurt.bonus}${hurt.half_damage ? ' /half' : ''}`);
check('the fixture really is carrying a pending half step', Boolean(hurt.half_damage),
  JSON.stringify({ half_damage: hurt.half_damage }));
check('...and is genuinely below its base', hurt.current_size < locked.current_size,
  `${hurt.current_size} vs base ${locked.current_size}`);

gm.emit('character:revert_stats', { characterId: char.id });
await sleep(700);
const back = body(await diceOf(char.id));
console.log(`  reverted: d${back.current_size}+${back.bonus}${back.half_damage ? ' /half' : ''}`);

check('the size came back to base', back.current_size === locked.locked_size,
  `${back.current_size} vs locked ${locked.locked_size}`);
check('the pending half step is healed too (the reported bug)', !back.half_damage,
  JSON.stringify({ half_damage: back.half_damage }));

// ============================================ 2. Temporary Damage debt
// Same class of bug, same fix shape: temporary_damage is a debt owed back
// at 0.5 a Round by healTemporaryDamage (roundResolution.js), tracked
// separately from the die's own current size/bonus/status specifically so
// it survives whatever those do in between — which is exactly why a revert
// used to leave it standing. Reported as "revert stats to base does not
// heal back Temporary Damage". Real combat is the only way to put a debt on
// the books at all (no client event sets it directly), so this section
// throws an actual Temporary-Damage-tagged move rather than faking the
// fixture — resolution runs synchronously once both sides finish
// declaring, so this costs no real wall-clock waiting.
console.log('\n--- Temporary Damage: revert_stats also clears the healing debt ---');
const tags = await jf('/api/tags');
const tdTag = (tags ?? []).find((t) => t.name === 'Temporary Damage');
if (!tdTag) {
  console.log('FAIL: "Temporary Damage" tag not found — is it seeded?');
  failures++;
} else {
  const wait = (ev, pred = () => true, ms = 10000) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
      const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
      gm.on(ev, h);
    });

  gm.emit('tell:create', { name: `TD Tell ${stamp}` });
  const tell = await wait('tell:created', (t) => t.name === `TD Tell ${stamp}`);
  gm.emit('move:create', {
    name: `TD Sting ${stamp}`, isDefault: false, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 0,
    description: 'guaranteed damage for the fixture', rollSlots: ['Skull'], rollModifier: 20,
    attackTargets: ['Body'], staminaCost: 0, tagIds: [tdTag.id],
  });
  const sting = await wait('move:created', (m) => m.name === `TD Sting ${stamp}`);

  const attacker = await jpost('/api/characters', { name: `TDAttacker${stamp}`, characterType: 'pc' });
  const defender = await jpost('/api/characters', { name: `TDDefender${stamp}`, characterType: 'pc' });
  gm.emit('move:grant', { characterId: attacker.id, moveId: sting.id });
  await sleep(300);

  gm.emit('combat:add_participant', { characterId: attacker.id, side: 'left', pairIndex: 1 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === attacker.id));
  gm.emit('combat:add_participant', { characterId: defender.id, side: 'right', pairIndex: 1 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === defender.id));
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs.find((p) => p.pairIndex === 1)?.phase === 'declaration');

  // Declaration is turn-based, one side at a time — whichever side
  // combat:next_round happened to pick first (not necessarily 'left').
  const turnOf = async (who, other) => {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs.find((p) => p.pairIndex === 1)?.declaringSide;
    const wantedSide = st.participants.find((p) => p.character_id === who.id)?.side;
    if (side && side !== wantedSide) {
      gm.emit('combat:character_done_declaring', { characterId: other.id });
      await sleep(500);
    }
  };
  await turnOf(attacker, defender);

  gm.emit('move:declare', { characterId: attacker.id, moveId: sting.id, placementTic: 0 });
  await sleep(300);
  gm.emit('combat:character_done_declaring', { characterId: attacker.id });
  await sleep(300);
  gm.emit('combat:character_done_declaring', { characterId: defender.id });
  await sleep(800); // resolution runs synchronously server-side; this is socket round-trip slack

  const defenderBody = () => diceOf(defender.id);
  const dealt = body(await defenderBody());
  console.log(`  defender's Body after the hit: d${dealt.current_size}+${dealt.bonus}, owed=${dealt.temporary_damage}`);
  check('the fixture actually put a Temporary Damage debt on the books', dealt.temporary_damage > 0,
    JSON.stringify({ temporary_damage: dealt.temporary_damage }));

  gm.emit('character:revert_stats', { characterId: defender.id });
  await sleep(500);
  const clearedDebt = body(await defenderBody());
  console.log(`  reverted: d${clearedDebt.current_size}+${clearedDebt.bonus}, owed=${clearedDebt.temporary_damage}`);
  check('the debt is cleared too (the reported bug)', clearedDebt.temporary_damage === 0,
    JSON.stringify({ temporary_damage: clearedDebt.temporary_damage }));

  gm.emit('combat:clear', {});
  await sleep(300);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

// Playtest: the Stance matchup badge on the VS divider, and the per-Combat-Style
// modifiers the declare picker now shows.
//
// **The regression this exists to catch**: the matchup used to be gated on the
// global Uneven Combat toggle, so turning that on anywhere in the fight zeroed
// the matchup for every 1v1 pair in it — the badge vanished from the divider and
// the bonus quietly left every roll. The toggle only *permits* lopsided pairs; a
// plain 1v1 with it on still has exactly one stance a side.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-stance-matchup.mjs
import { io } from 'socket.io-client';
const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}: ${l}${c ? '' : ' — ' + d}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jpost = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);

const rules = await jf('/api/ruleset');
const attrs = rules.attributes ?? [];
const counters = rules.counters ?? rules.attributeCounters ?? [];
console.log('  attributes:', attrs.map((a) => a.name).join(', '));
// Pick a counter pair so the two stances are guaranteed not to be even.
const c = counters[0];
console.log('  first counter row:', JSON.stringify(c));

const stamp = Date.now();
const a = await jpost('/api/characters', { name: `A${stamp}` });
const b = await jpost('/api/characters', { name: `B${stamp}` });
const mkStance = async (charId, x, y) => {
  gm.emit('stance:create', { characterId: charId, name: 'S', attributeAId: x, attributeBId: y });
  await sleep(400);
  const sheet = await jf(`/api/characters/${charId}`);
  const st = sheet.stances[sheet.stances.length - 1];
  gm.emit('stance:activate', { characterId: charId, stanceId: st.id });
  await sleep(300);
  return st;
};
const atk = c.attacker_attribute_id, def = c.defender_attribute_id;
const other = attrs.find((x) => x.id !== atk && x.id !== def)?.id ?? atk;
await mkStance(a.id, atk, other);
await mkStance(b.id, def, other);

gm.emit('combat:add_participant', { characterId: a.id, side: 'left', pairIndex: 0 });
await sleep(500);
gm.emit('combat:add_participant', { characterId: b.id, side: 'right', pairIndex: 0 });
await sleep(700);

const read = async () => (await jf('/api/combat?role=gm')).stanceMatchups?.[0] ?? null;

const unevenIs = async (want) => {
  for (let i = 0; i < 3; i++) {
    const st = await jf('/api/combat?role=gm');
    if (Boolean(st.unevenCombatEnabled) === want) return;
    gm.emit('combat:toggle_uneven', {});
    await sleep(600);
  }
};
await unevenIs(false);
let m = await read();
check('matchup exists with Uneven Combat OFF', m != null && m.left !== 0, JSON.stringify(m && { l: m.left, r: m.right }));

await unevenIs(true);
m = await read();
check('matchup SURVIVES the Uneven Combat toggle (the reported regression)',
  m != null && m.left !== 0, JSON.stringify(m && { l: m.left, r: m.right }));
check('the plaque still names both sides', (m?.leftStyleNames ?? []).length === 2, JSON.stringify(m?.leftStyleNames));
check('per-style deltas ride along for the declare picker',
  Array.isArray(m?.leftStyleDeltas) && m.leftStyleDeltas.length === attrs.length,
  JSON.stringify(m?.leftStyleDeltas));
const nonZero = (m?.leftStyleDeltas ?? []).filter((d) => d.delta !== 0);
check('at least one Combat Style is actually worth something here', nonZero.length > 0,
  JSON.stringify(m?.leftStyleDeltas));
console.log('  left deltas:', JSON.stringify(m?.leftStyleDeltas));

// ==================================================================
// Which Stats the matchup actually reaches (decided, new).
//
// The matchup scores an exchange of STYLES. Brain is thinking and Stamina is
// your engine — neither is part of that exchange, so a roll made of nothing
// but those two carries no matchup. Measured on real rolls rather than read
// off the badge, and as a difference against a Skull roll from the same
// fighter in the same fight, so the only variable is which Stat was thrown.
console.log('\n--- Brain and Stamina are exempt; everything else is not ---');
// **The fight has to actually be underway.** getStanceMatchupBonus is gated on
// the pair having a live combat_pairs row — seating two fighters is not the
// same as starting a round — so without this every roll below comes back at 0
// and the probes would pass for the wrong reason. The badge above needs no such
// gate, which is exactly why it passed while the rolls did not.
gm.emit('combat:next_round', {});
await sleep(2500); // let the round open, and let its own Initiative rolls land
const sheetA = await jf(`/api/characters/${a.id}`);
const dieId = (slot) => sheetA.dice.find((d) => d.slot_name === slot).id;
const rollOnce = (slot) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout roll ' + slot)), 8000);
    const h = (payload) => {
      if (payload.characterId !== a.id) return;
      clearTimeout(t);
      gm.off('roll:result', h);
      res(payload);
    };
    gm.on('roll:result', h);
    gm.emit('die:roll', { characterId: a.id, dieId: dieId(slot), modifier: 0 });
  });

const skullRoll = await rollOnce('Skull');
await sleep(250);
const brainRoll = await rollOnce('Brain');
await sleep(250);
const staminaRoll = await rollOnce('Stamina');
console.log('  modifiers — Skull', skullRoll.modifier, '| Brain', brainRoll.modifier, '| Stamina', staminaRoll.modifier);

// The fixture is built on a counter pair, so the Skull roll must actually be
// carrying something — otherwise the two probes below prove nothing.
check('a Skull roll still carries the matchup', skullRoll.modifier !== 0,
  JSON.stringify({ modifier: skullRoll.modifier, breakdown: skullRoll.modifierBreakdown }));
check('a Brain roll carries none of it', brainRoll.modifier === 0,
  JSON.stringify({ modifier: brainRoll.modifier, breakdown: brainRoll.modifierBreakdown }));
check('a Stamina roll carries none of it', staminaRoll.modifier === 0,
  JSON.stringify({ modifier: staminaRoll.modifier, breakdown: staminaRoll.modifierBreakdown }));

// A pool roll mixing an exempt Stat with a real one is still a real roll —
// the exemption is not a loophole a move can be built around.
const mixed = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout pool')), 8000);
  const h = (payload) => {
    if (payload.characterId !== a.id) return;
    clearTimeout(t);
    gm.off('roll:result', h);
    res(payload);
  };
  gm.on('roll:result', h);
  gm.emit('pool:roll', { characterId: a.id, dieIds: [dieId('Skull'), dieId('Brain')], modifier: 0 });
});
console.log('  Skull + Brain together:', mixed.modifier);
check('Skull + Brain together keeps the matchup', mixed.modifier === skullRoll.modifier,
  JSON.stringify({ mixed: mixed.modifier, skullOnly: skullRoll.modifier }));

const bothExempt = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout pool 2')), 8000);
  const h = (payload) => {
    if (payload.characterId !== a.id) return;
    clearTimeout(t);
    gm.off('roll:result', h);
    res(payload);
  };
  gm.on('roll:result', h);
  gm.emit('pool:roll', { characterId: a.id, dieIds: [dieId('Brain'), dieId('Stamina')], modifier: 0 });
});
check('Brain + Stamina together carries none of it', bothExempt.modifier === 0,
  JSON.stringify({ modifier: bothExempt.modifier }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

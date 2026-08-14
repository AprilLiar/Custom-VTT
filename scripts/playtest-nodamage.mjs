// Playtest driver for the No Damage Tag automation (G2). Drives the real
// server over sockets and reads back round_events + the target's Stats.
//
//   rm -f local.db && node server/index.js &  (or npm run dev)
//   node scripts/playtest-nodamage.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u, o) => fetch(BASE + u, o).then((r) => r.json().catch(() => null));
const jpost = (u, b) =>
  jf(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

const s = io(BASE);
const wait = (ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
    s.on(ev, h);
  });

await new Promise((r) => s.on('connect', r));
s.emit('identity:set', { role: 'gm' });

// Start from a clean arena — a leftover fight would resolve someone else's
// moves and every assertion below would be about the wrong round.
s.emit('combat:clear', {});
await sleep(600);

// The tag is seeded by initDb, so find it rather than creating a duplicate.
const tags = await jf('/api/tags');
const noDamage = tags.find((t) => t.name.trim().toLowerCase() === 'no damage');
check('the No Damage tag exists (seeded at startup)', noDamage != null, JSON.stringify(tags.map((t) => t.name)));
if (!noDamage) process.exit(1);

s.emit('tell:create', { name: 'Reaches out' });
const tell = await wait('tell:created');

// +20 on the roll puts it over any plausible threshold; threshold 5 is the
// default, so this one always succeeds.
s.emit('move:create', {
  name: 'Sure Shove', isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  description: 'A shove that always connects.',
  interactions: { hit: { text: 'The grip closes.', automations: [] } },
  rollSlots: ['Skull'], rollModifier: 20, attackTargets: ['Body'],
  tagIds: [noDamage.id], successThreshold: 5, staminaCost: 0,
});
const sure = await wait('move:created', (m) => m.name === 'Sure Shove');

// Threshold 20 against an unmodified Skull die: unreachable, so this one
// always fails. Same tag, same shape — only the number differs.
s.emit('move:create', {
  name: 'Doomed Shove', isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  description: 'A shove that never connects.',
  interactions: { hit: { text: 'The grip closes.', automations: [] } },
  rollSlots: ['Skull'], rollModifier: 0, attackTargets: ['Body'],
  tagIds: [noDamage.id], successThreshold: 20, staminaCost: 0,
});
const doomed = await wait('move:created', (m) => m.name === 'Doomed Shove');

// A plain damaging move for the control: same frames, no tag. It must still
// deal damage, or the branch is swallowing everything rather than just the
// tagged moves.
s.emit('move:create', {
  name: 'Control Jab', isDefault: true, tellId: tell.id,
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  description: 'An ordinary jab.', interactions: {},
  rollSlots: ['Skull'], rollModifier: 20, attackTargets: ['Body'],
  staminaCost: 0,
});
const control = await wait('move:created', (m) => m.name === 'Control Jab');

check('the threshold round-trips through writeMove', sure.success_threshold === 5 && doomed.success_threshold === 20,
  `sure=${sure.success_threshold} doomed=${doomed.success_threshold}`);

const grappler = await jpost('/api/characters', { name: 'Prober', characterType: 'pc' });
const victim = await jpost('/api/characters', { name: 'Target', characterType: 'pc' });

s.emit('combat:add_participant', { characterId: grappler.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === grappler.id));
s.emit('combat:add_participant', { characterId: victim.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === victim.id));

const bodyOf = async (id) => {
  const { dice } = await jf(`/api/characters/${id}`);
  const b = (dice ?? []).find((d) => d.slot_name === 'Body');
  return `${b?.size}+${b?.bonus}/${b?.status}`;
};

async function runRound(attackerMoveId, label) {
  let st = await jf('/api/combat?role=gm');
  if (st.pairs[0]?.phase !== 'declaration') {
    s.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  }
  // Only the attacker declares; the target stands there, so nothing defends
  // and the attack reaches the damage funnel undefended.
  for (let i = 0; i < 2; i++) {
    st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    const who = side === 'left' ? grappler : victim;
    if (who.id === grappler.id) {
      s.emit('move:declare', { characterId: who.id, moveId: attackerMoveId });
      await wait('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === who.id));
    }
    s.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(500);
  }
  await sleep(2500);
  // The stored replay is keyed by resolutionId, which only the round's own
  // round_summary chat card knows — there is no round-number route.
  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  if (!summary) return [];
  const replay = await jf(`/api/combat/round-replay/${summary.resolutionId}`);
  const events = replay?.events ?? [];
  console.log(`  [${label}] round ${summary.roundNumber}:`, events.map((e) => e.type).join(', '));
  return events;
}

// ---------- 1. a No Damage move that clears its threshold ----------
const bodyBefore = await bodyOf(victim.id);
let evs = await runRound(sure.id, 'success');
let nd = evs.find((e) => e.type === 'no_damage_resolved');
check('a No Damage move emits no_damage_resolved', nd != null, evs.map((e) => e.type).join(','));
check('clearing the threshold is reported as a success', nd?.payload?.succeeded === true, JSON.stringify(nd?.payload));
check('the event carries the threshold it was judged against', nd?.payload?.threshold === 5, JSON.stringify(nd?.payload));
check('no damage was applied', !evs.some((e) => e.type === 'damage_applied'));
check('no Insignificant Damage either — the two must not both claim it',
  !evs.some((e) => e.type === 'insignificant_damage'));
check('the target\'s Body is untouched', (await bodyOf(victim.id)) === bodyBefore,
  `${bodyBefore} -> ${await bodyOf(victim.id)}`);
// The reason a No Damage move is worth authoring at all: On Hit is where
// whatever it actually does gets hung.
check('a successful No Damage move fires On Hit',
  evs.some((e) => e.type === 'automation_fired' && e.payload?.trigger === 'hit'),
  JSON.stringify(evs.filter((e) => e.type === 'automation_fired').map((e) => e.payload)));

// ---------- 2. a No Damage move that falls short ----------
evs = await runRound(doomed.id, 'failure');
nd = evs.find((e) => e.type === 'no_damage_resolved');
check('a short roll still emits no_damage_resolved', nd != null, evs.map((e) => e.type).join(','));
check('falling short is reported as a failure', nd?.payload?.succeeded === false, JSON.stringify(nd?.payload));
check('the move\'s own threshold is used, not the default', nd?.payload?.threshold === 20, JSON.stringify(nd?.payload));
check('a failed No Damage move applies no damage', !evs.some((e) => e.type === 'damage_applied'));
check('the target\'s Body is still untouched', (await bodyOf(victim.id)) === bodyBefore);
// Nothing fires on a failure — and On Miss especially must not, since a Miss
// means the target dodged and nobody dodged this.
check('a failed No Damage move fires nothing at all',
  !evs.some((e) => e.type === 'automation_fired'),
  JSON.stringify(evs.filter((e) => e.type === 'automation_fired').map((e) => e.payload)));

// ---------- 3. the control: an untagged move still hurts ----------
evs = await runRound(control.id, 'control');
check('an untagged move still deals damage', evs.some((e) => e.type === 'damage_applied'),
  evs.map((e) => e.type).join(','));
check('an untagged move emits no no_damage_resolved', !evs.some((e) => e.type === 'no_damage_resolved'));
check('the control actually moved the target\'s Body', (await bodyOf(victim.id)) !== bodyBefore,
  `${bodyBefore} -> ${await bodyOf(victim.id)}`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
s.close();
process.exit(failures ? 1 : 0);

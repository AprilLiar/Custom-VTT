// Playtest: the Perk framework, driving the real server.
//
// Two of the three shipped Perks are exercised here; Second Wind is covered in
// server/test/roundResolution.test.js instead, because producing a *failed
// defence* on demand needs frame data a socket script would only make less
// legible.
//
//   1. **Genius Observer** — the capability the server pushes to a connection.
//      This replaced a `window.confirm` that asked the reader whether they had
//      the Perk, so the thing worth proving is that the answer now comes from
//      granted Perks and updates live, mid-session, without a reload.
//   2. **Cornered Animal** — a conditional roll bonus, run as a BARE/GRANTED
//      pair of otherwise identical rounds, so what the Perk did is the
//      difference between two fights rather than a number read off one event.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-perks.mjs
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

const connect = () =>
  new Promise((res) => {
    const sock = io(BASE);
    sock.capabilities = null;
    sock.on('identity:capabilities', (c) => { sock.capabilities = c; });
    sock.on('connect', () => res(sock));
  });
const gm = await connect();
const pcSock = await connect();
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
await sleep(500);
const stamp = Date.now();

// ======================================================= 0. the registry seeds
console.log('\n--- every automated Perk exists in the compendium, and says so ---');
const perks = await jf('/api/perks');
const byName = (n) => perks.find((p) => p.name === n);
for (const name of ['Genius Observer', 'Cornered Animal', 'Second Wind']) {
  const perk = byName(name);
  check(`"${name}" was seeded from the registry`, perk != null, JSON.stringify(perks.map((p) => p.name)));
  check(`...and is flagged automated, so the card can badge it`, perk?.automated === true, JSON.stringify(perk));
}
// A Perk the GM invents has no code and must say so rather than wearing a badge
// it cannot honour.
gm.emit('perk:create', { name: `Purely Narrative ${stamp}`, description: 'flavour only' });
const narrative = await wait(gm, 'perk:created', (p) => p.name === `Purely Narrative ${stamp}`);
check('a GM-invented Perk is NOT flagged automated', narrative.automated === false, JSON.stringify(narrative));

// ============================================ 1. the name of an automated Perk
console.log('\n--- an automated Perk\'s name is frozen; everything else is not ---');
const observer = byName('Genius Observer');
gm.emit('perk:update', { perkId: observer.id, name: 'Genius Observerrr', description: observer.description });
await sleep(700);
const afterRename = (await jf('/api/perks')).find((p) => p.id === observer.id);
check('renaming an automated Perk is refused', afterRename.name === 'Genius Observer', afterRename.name);
check('...and it still has its rules attached', afterRename.automated === true, JSON.stringify(afterRename));

gm.emit('perk:update', { perkId: observer.id, name: 'Genius Observer', description: `Reworded ${stamp}` });
await sleep(700);
const reworded = (await jf('/api/perks')).find((p) => p.id === observer.id);
check('the description is still freely editable', reworded.description === `Reworded ${stamp}`, reworded.description);

// ================================================= 2. Genius Observer, live
console.log('\n--- Genius Observer decides who may read a revealed move in full ---');
const pc = await jpost('/api/characters', { name: `Reader${stamp}`, characterType: 'pc' });
pcSock.emit('identity:set', { role: 'player', characterId: pc.id });
await sleep(600);
check('a player with no Perks may not read a move in full',
  pcSock.capabilities?.canSeeRevealedDetail === false, JSON.stringify(pcSock.capabilities));
check('the GM always may — they wrote the move', gm.capabilities?.canSeeRevealedDetail === true,
  JSON.stringify(gm.capabilities));

gm.emit('perk:grant', { characterId: pc.id, perkId: observer.id });
await sleep(900);
// The point of pushing rather than answering on reload: a Perk handed out
// mid-session has to take effect at the table.
check('granting the Perk opens it up, with no reload', pcSock.capabilities?.canSeeRevealedDetail === true,
  JSON.stringify(pcSock.capabilities));

gm.emit('perk:revoke', { characterId: pc.id, perkId: observer.id });
await sleep(900);
check('revoking it closes it again', pcSock.capabilities?.canSeeRevealedDetail === false,
  JSON.stringify(pcSock.capabilities));

// ============================================ 3. Cornered Animal, bare/granted
const cornered = byName('Cornered Animal');

// One identical round, twice. `grantTo` decides whether the attacker carries
// the Perk; nothing else differs.
const fight = async (label, { grantPerk, staminaFraction }) => {
  gm.emit('combat:clear', {});
  await sleep(700);
  gm.emit('tell:create', { name: `Tell ${label} ${stamp}` });
  const tell = await wait(gm, 'tell:created', (t) => t.name === `Tell ${label} ${stamp}`);
  gm.emit('move:create', {
    name: `Jab ${label} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: 'a jab', interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0,
  });
  const jab = await wait(gm, 'move:created', (m) => m.name === `Jab ${label} ${stamp}`);

  const atk = await jpost('/api/characters', { name: `Atk${label}${stamp}`, characterType: 'npc' });
  const foe = await jpost('/api/characters', { name: `Foe${label}${stamp}`, characterType: 'npc' });
  if (grantPerk) {
    gm.emit('perk:grant', { characterId: atk.id, perkId: cornered.id });
    await sleep(500);
  }

  gm.emit('combat:add_participant', { characterId: atk.id, side: 'left', pairIndex: 0 });
  await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === atk.id));
  gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
  await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));
  gm.emit('combat:next_round', {});
  await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

  // Starting a fight restores full Stamina, so the Perk's condition has to be
  // set AFTER the round opens or it is immediately undone.
  const sheet = await jf(`/api/characters/${atk.id}`);
  const max = sheet.character.max_stamina;
  const target = Math.floor(max * staminaFraction);
  const now = sheet.character.current_stamina;
  if (target !== now) gm.emit('stamina:adjust', { characterId: atk.id, delta: target - now });
  await sleep(500);

  const st0 = await jf('/api/combat?role=gm');
  const start = st0.pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const st = await jf('/api/combat?role=gm');
    const side = st.pairs[0].declaringSide;
    if (!side) break;
    const who = side === 'left' ? atk : foe;
    gm.emit('move:declare', { characterId: who.id, moveId: jab.id, placementTic: start });
    await sleep(600);
    gm.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(700);
  }
  await sleep(4500);

  const chat = await jf('/api/chat');
  const summary = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
  const events = summary ? (await jf(`/api/combat/round-replay/${summary.resolutionId}`))?.events ?? [] : [];
  const roll = events
    .filter((e) => e.type === 'roll')
    .map((e) => e.payload)
    .find((r) => r.characterId === atk.id);
  return { roll, atk, max };
};

console.log('\n--- Cornered Animal, at full Stamina: the condition is unmet ---');
const healthy = await fight('H', { grantPerk: true, staminaFraction: 1 });
console.log('  breakdown:', JSON.stringify(healthy.roll?.modifierBreakdown));
check('the check ran', healthy.roll != null);
check('nothing is claimed while the condition is unmet',
  !(healthy.roll?.modifierBreakdown ?? []).some((t) => t.label === 'Cornered Animal'),
  JSON.stringify(healthy.roll?.modifierBreakdown));

console.log('\n--- the same fighter, cornered: +2 under its own name ---');
const hurt = await fight('C', { grantPerk: true, staminaFraction: 0.2 });
console.log('  breakdown:', JSON.stringify(hurt.roll?.modifierBreakdown));
const term = (hurt.roll?.modifierBreakdown ?? []).find((t) => t.label === 'Cornered Animal');
check('the Perk appears on the roll it changed', term != null, JSON.stringify(hurt.roll?.modifierBreakdown));
check('...worth +2', term?.amount === 2, JSON.stringify(term));
check('...and the modifier really carries it', hurt.roll?.modifier === (healthy.roll?.modifier ?? 0) + 2,
  JSON.stringify({ healthy: healthy.roll?.modifier, cornered: hurt.roll?.modifier }));

console.log('\n--- an ungranted fighter at the same Stamina gets nothing ---');
const control = await fight('B', { grantPerk: false, staminaFraction: 0.2 });
console.log('  breakdown:', JSON.stringify(control.roll?.modifierBreakdown));
check('no Perk, no term', !(control.roll?.modifierBreakdown ?? []).some((t) => t.label === 'Cornered Animal'),
  JSON.stringify(control.roll?.modifierBreakdown));
check('and the difference between the two fights IS the Perk',
  (hurt.roll?.modifier ?? 0) - (control.roll?.modifier ?? 0) === 2,
  JSON.stringify({ granted: hurt.roll?.modifier, bare: control.roll?.modifier }));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, pcSock]) s.close();
process.exit(failures ? 1 : 0);

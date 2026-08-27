// Playtest: Non-Committed — the only Perk that stops the round.
//
// It adds a FIFTH pause to the pair's resolution row, at the head of the round:
// after everyone has declared, before anything reveals. What only a live server
// shows is that the pause actually holds (the round must not resolve past it),
// that answering it releases the round, that a refund lands, and — the part
// most easily got wrong — that it asks ONCE rather than every time the engine
// resumes.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3041 node server/index.js
//   E2E_URL=http://localhost:3041 PLAYTEST_DB="file:/tmp/pt.db" node scripts/playtest-non-committed.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
if (!process.env.PLAYTEST_DB) {
  console.error('PLAYTEST_DB must be the same TURSO_DATABASE_URL the server was started with.');
  process.exit(1);
}
process.env.TURSO_DATABASE_URL = process.env.PLAYTEST_DB;
const { all, one } = await import('../server/db.js');

let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok ? '' : ' — ' + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 20000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
const setupFailed = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', setupFailed);
process.on('uncaughtException', setupFailed);

gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

const perks = await jf('/api/perks');
const perk = perks.find((p) => p.name === 'Non-Committed');
check('the Perk is seeded from the registry at startup', Boolean(perk));
if (!perk) process.exit(1);

gm.emit('tell:create', { name: `NC Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `NC Tell ${stamp}`);
const mk = async (name, staminaCost) => {
  gm.emit('move:create', {
    name: `${name}${stamp}`, isDefault: true, tellId: tell.id, description: name,
    interactions: {}, staminaCost, startupTics: 1, activeTics: 1, recoveryTics: 1,
    rollSlots: ['Right Hand'], attackTargets: ['Skull'],
  });
  return wait('move:created', (m) => m.name === `${name}${stamp}`);
};
const keeper = await mk('NCKeep', 2);
const regret = await mk('NCRegret', 3);

const holder = await jpost('/api/characters', { name: `NC${stamp}`, characterType: 'npc' });
const foe = await jpost('/api/characters', { name: `Foe${stamp}`, characterType: 'npc' });
gm.emit('perk:grant', { characterId: holder.id, perkId: perk.id });
await sleep(600);

gm.emit('combat:add_participant', { characterId: holder.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === holder.id));
gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
const declareFor = {
  left: [{ characterId: holder.id, moveId: keeper.id }, { characterId: holder.id, moveId: regret.id }],
  right: [{ characterId: foe.id, moveId: keeper.id }],
};
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  for (const d of declareFor[side]) {
    gm.emit('move:declare', { ...d, placementTic: start });
    await sleep(500);
  }
  gm.emit('combat:character_done_declaring', { characterId: declareFor[side][0].characterId });
  await sleep(700);
}
await sleep(1500);

// --- the pause itself -------------------------------------------------------
const paused = await one("SELECT status, pending_noncommit_json FROM pair_round_resolutions WHERE pair_index = 0");
check('the round stops at the head, before anything reveals', paused?.status === 'paused_noncommit', JSON.stringify(paused?.status));
const events = await all("SELECT type FROM round_events WHERE pair_index = 0");
check('...and nothing has revealed yet', !events.some((e) => e.type === 'reveal'), events.map((e) => e.type).join(', '));

const payload = JSON.parse(paused?.pending_noncommit_json ?? 'null');
const entry = payload?.entries?.[0];
check('the prompt names only the Perk holder', payload?.entries?.length === 1 && entry?.characterId === holder.id, JSON.stringify(payload));
check('and lists both of their declarations, with what each refunds', entry?.moves?.length === 2 && entry.moves.every((m) => m.staminaRefund > 0), JSON.stringify(entry?.moves));

const before = (await jf(`/api/characters/${holder.id}`)).character.current_stamina;
const regretRow = entry.moves.find((m) => m.moveName.startsWith('NCRegret'));

// A socket that controls neither fighter must not be able to answer.
const outsider = io(BASE);
await new Promise((r) => outsider.on('connect', r));
outsider.emit('identity:set', { role: 'player', characterId: foe.id });
await sleep(400);
outsider.emit('combat:resolve_noncommit', { pairIndex: 0, declaredMoveIds: [regretRow.declaredMoveId] });
await sleep(900);
check(
  'a fighter who does not own the prompt cannot answer it',
  (await one("SELECT status FROM pair_round_resolutions WHERE pair_index = 0"))?.status === 'paused_noncommit'
);
outsider.close();

// --- answering it -----------------------------------------------------------
gm.emit('combat:resolve_noncommit', { pairIndex: 0, declaredMoveIds: [regretRow.declaredMoveId] });
await sleep(2500);

const gone = await one('SELECT id FROM declared_moves WHERE id = ?', [regretRow.declaredMoveId]);
check('the interrupted move is off the board', gone == null);
const kept = await all('SELECT id FROM declared_moves WHERE character_id = ?', [holder.id]);
check('the one they kept is still there', kept.length === 1);
// **Asserted on the event, not on the total.** Answering releases the round, and
// a round pays Stamina regen — so a before/after comparison is measuring the
// refund PLUS whatever the round did, and the first version of this probe duly
// failed against a perfectly correct refund. The event carries the figure the
// refund actually moved.
const refundEvent = (await all("SELECT payload FROM round_events WHERE pair_index = 0 AND type = 'noncommit'"))
  .map((e) => JSON.parse(e.payload))
  .find((p) => p.declaredMoveId === regretRow.declaredMoveId);
check('the refund is recorded, for exactly what the move committed', refundEvent?.staminaRefunded === regretRow.staminaRefund, JSON.stringify(refundEvent));
const after = (await jf(`/api/characters/${holder.id}`)).character.current_stamina;
check('and the Stamina really went up', after >= before + regretRow.staminaRefund, `${before} -> ${after}`);

const chat = await jf('/api/chat');
check('the table is told, by name', chat.some((c) => typeof c.message === 'string' && /taken back before anyone saw it/.test(c.message)));

// --- and the round actually runs afterwards ---------------------------------
let resolved = null;
for (let i = 0; i < 60; i += 1) {
  resolved = await one("SELECT status FROM pair_round_resolutions WHERE pair_index = 0 ORDER BY id DESC LIMIT 1");
  if (resolved?.status === 'complete') break;
  await sleep(250);
}
check('answering releases the round and it resolves', resolved?.status === 'complete', JSON.stringify(resolved));
const after2 = await all("SELECT type FROM round_events WHERE pair_index = 0");
check('...and the kept move revealed', after2.some((e) => e.type === 'reveal'), after2.map((e) => e.type).join(', '));

// --- it must not ask twice in the same round --------------------------------
const pauses = await all("SELECT status FROM pair_round_resolutions WHERE pair_index = 0 AND status = 'paused_noncommit'");
check('the window does not re-open on the same round', pauses.length === 0);

// --- the case that matters most: everybody else -----------------------------
//
// A pair with no holder must not pause AT ALL. Getting this wrong would stall
// every fight in the game behind a prompt nobody can answer, which is a far
// worse failure than the Perk not working — so it is probed directly rather
// than inferred from the suite passing.
gm.emit('combat:clear', {});
await sleep(900);
const plainA = await jpost('/api/characters', { name: `PlainA${stamp}`, characterType: 'npc' });
const plainB = await jpost('/api/characters', { name: `PlainB${stamp}`, characterType: 'npc' });
gm.emit('combat:add_participant', { characterId: plainA.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === plainA.id));
gm.emit('combat:add_participant', { characterId: plainB.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === plainB.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const plainStart = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
const plainBy = { left: plainA.id, right: plainB.id };
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  gm.emit('move:declare', { characterId: plainBy[side], moveId: keeper.id, placementTic: plainStart });
  await sleep(500);
  gm.emit('combat:character_done_declaring', { characterId: plainBy[side] });
  await sleep(700);
}
let plainStatus = null;
for (let i = 0; i < 60; i += 1) {
  plainStatus = await one("SELECT status FROM pair_round_resolutions WHERE pair_index = 0 ORDER BY id DESC LIMIT 1");
  if (plainStatus?.status === 'complete') break;
  await sleep(250);
}
check('a pair with no holder never pauses, and resolves normally', plainStatus?.status === 'complete', JSON.stringify(plainStatus));

// --- keeping everything is a real answer ------------------------------------
gm.emit('combat:clear', {});
await sleep(900);
gm.emit('combat:add_participant', { characterId: holder.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === holder.id));
gm.emit('combat:add_participant', { characterId: foe.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === foe.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const keepStart = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
const keepBy = { left: holder.id, right: foe.id };
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  gm.emit('move:declare', { characterId: keepBy[side], moveId: keeper.id, placementTic: keepStart });
  await sleep(500);
  gm.emit('combat:character_done_declaring', { characterId: keepBy[side] });
  await sleep(700);
}
await sleep(1500);
check(
  'the window opens again on a new round',
  (await one("SELECT status FROM pair_round_resolutions WHERE pair_index = 0 ORDER BY id DESC LIMIT 1"))?.status === 'paused_noncommit'
);
gm.emit('combat:resolve_noncommit', { pairIndex: 0, declaredMoveIds: [] });
await sleep(2500);
const keptAll = await all('SELECT id FROM declared_moves WHERE character_id = ?', [holder.id]);
check('committing to everything keeps every move', keptAll.length === 1, JSON.stringify(keptAll));
let keepStatus = null;
for (let i = 0; i < 60; i += 1) {
  keepStatus = await one("SELECT status FROM pair_round_resolutions WHERE pair_index = 0 ORDER BY id DESC LIMIT 1");
  if (keepStatus?.status === 'complete') break;
  await sleep(250);
}
check('...and the round runs on', keepStatus?.status === 'complete', JSON.stringify(keepStatus));

console.log(fails === 0 ? '\nall probes passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

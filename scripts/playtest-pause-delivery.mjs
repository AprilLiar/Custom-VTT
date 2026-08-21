// Playtest: a pause finds the GM even when the GM was not there when it was
// raised.
//
// Reported from the table: "all GM prompts break if the GM is not present at
// the exact moment of resolution. If the GM was using a phone and locked it,
// the prompt is never shown and the fight becomes corrupted, without the
// ability to proceed further."
//
// That is not something a unit test can honestly reproduce — the failure lived
// in delivery, between a real socket dropping and a real socket coming back —
// so this drives two GM connections against a real server: one that runs the
// round, and one standing in for the phone that was locked through it.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-pause-delivery.mjs
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

const connect = () => new Promise((res) => {
  const sock = io(BASE);
  sock.on('connect', () => res(sock));
});
const waitOn = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

// The connection that runs the fight — a second GM tab, a laptop, whatever.
const driver = await connect();
driver.emit('identity:set', { role: 'gm' });
const wait = (ev, pred, ms) => waitOn(driver, ev, pred, ms);

driver.emit('combat:clear', {});
await sleep(700);
driver.emit('tell:create', { name: 'Guard up' });
const tell = await wait('tell:created');
const stamp = Date.now();

const mk = async (name, extra) => {
  driver.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: [], staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// The same fixture the Block adjudication playtest uses: a swing that always
// clears the threshold, and a guard covering its whole Active window, which is
// the coverage that reaches a person.
const punch = await mk('Straight', { activeTics: 2, attackTargets: ['Skull'], rollModifier: 30 });
const guard = await mk('Front Guard', {
  startupTics: 1, activeTics: 2, recoveryTics: 1,
  rollSlots: ['Body'], isDefensive: true, defenseKind: 'block', defenseFramePositions: [1, 2],
});

const striker = await jpost('/api/characters', { name: `Str${stamp}`, characterType: 'npc' });
// A PC, so a Player identity has something real to log in as below.
const holder = await jpost('/api/characters', { name: `Hld${stamp}`, characterType: 'pc' });

driver.emit('combat:add_participant', { characterId: striker.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === striker.id));
driver.emit('combat:add_participant', { characterId: holder.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === holder.id));

const snapshot = () => jf('/api/combat?role=gm');
const statusOf = async () => (await snapshot()).pairs[0]?.resolutionStatus;

async function declareBoth() {
  const st = await snapshot();
  if (st.pairs[0]?.phase !== 'declaration') {
    driver.emit('combat:next_round', {});
    await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  }
  const start = (await snapshot()).pairs[0].roundStartTic ?? 0;
  for (let i = 0; i < 2; i++) {
    const now = await snapshot();
    const side = now.pairs[0].declaringSide;
    if (!side) break;
    const who = side === 'left' ? striker : holder;
    driver.emit('move:declare', {
      characterId: who.id,
      moveId: who.id === striker.id ? punch.id : guard.id,
      placementTic: start,
    });
    await sleep(400);
    driver.emit('combat:character_done_declaring', { characterId: who.id });
    await sleep(600);
  }
  await sleep(3000);
}

// ---------------------------------------------------------------------------
console.log('\n— The GM locks their phone, and the round pauses without them —');
// ---------------------------------------------------------------------------
// A second GM connection: this is the phone. It is listening now, and it will
// be gone by the time the guard is reached.
const phone = await connect();
phone.emit('identity:set', { role: 'gm' });
await waitOn(phone, 'combat:updated');
const seenWhileAway = [];
phone.on('combat:updated', (c) => {
  const p = c?.pairs?.[0];
  if (p?.pendingDefense || p?.pendingDodge) seenWhileAway.push(p.pendingDefense ?? p.pendingDodge);
});

phone.disconnect();
await sleep(300);
check('the phone really is off the wire before the round runs', phone.connected === false);

await declareBoth();
check('the round paused on the guard while nobody was watching',
  (await statusOf()) === 'paused_defense', await statusOf());
check('...and the phone was told nothing, because it was not there',
  seenWhileAway.length === 0, JSON.stringify(seenWhileAway));

// ---------------------------------------------------------------------------
console.log('\n— They unlock it, and the question is waiting —');
// ---------------------------------------------------------------------------
// A reconnect re-sends identity (roleContext.jsx does this on every `connect`),
// and the server answers identity with a fresh snapshot. No reload, no extra
// request: this is the whole recovery path.
phone.connect();
await waitOn(phone, 'connect');
const resync = new Promise((res) => phone.once('combat:updated', res));
phone.emit('identity:set', { role: 'gm' });
const recovered = await resync;

const prompt = recovered?.pairs?.[0]?.pendingDefense;
check('reconnecting hands the GM the pending question, unprompted', Boolean(prompt),
  JSON.stringify(recovered?.pairs?.[0]));
check('...worded in full, not as raw pause state',
  prompt?.defenseKind === 'block' &&
    prompt?.defenderCharacterName === holder.name &&
    prompt?.attackerCharacterName === striker.name &&
    Number.isFinite(prompt?.attackerResult),
  JSON.stringify(prompt));
check('...with the coverage flattened the way the dialog reads it',
  prompt?.coverage === 'full', String(prompt?.coverage));
check('...and naming the line of attack it is about',
  prompt?.targetSlotName === 'Skull', String(prompt?.targetSlotName));

// ---------------------------------------------------------------------------
console.log('\n— The same snapshot tells a Player nothing —');
// ---------------------------------------------------------------------------
const player = await connect();
const playerSnap = new Promise((res) => player.once('combat:updated', res));
player.emit('identity:set', { role: 'player', characterId: holder.id });
const asPlayer = await playerSnap;
check('a Player is not shown the defence prompt',
  asPlayer?.pairs?.[0]?.pendingDefense == null && asPlayer?.pairs?.[0]?.pendingDodge == null,
  JSON.stringify(asPlayer?.pairs?.[0]?.pendingDefense));
check("...and the attacker's roll does not reach them at all",
  !JSON.stringify(asPlayer?.pairs ?? []).includes('attackerResult'),
  JSON.stringify(asPlayer?.pairs?.[0]));

// ---------------------------------------------------------------------------
console.log('\n— GM Tools can summon it by hand —');
// ---------------------------------------------------------------------------
const pausesFor = (sock) => {
  const answer = new Promise((res) => sock.once('combat:pauses', res));
  sock.emit('combat:resummon_pause');
  return answer;
};
const listed = await pausesFor(phone);
check('the tool is told exactly what the fight is waiting on',
  listed?.pauses?.length === 1, JSON.stringify(listed));
const entry = listed?.pauses?.[0];
check('...by kind, pair and round', entry?.kind === 'block' && entry?.pairIndex === 0 && entry?.roundNumber >= 1,
  JSON.stringify(entry));
check('...with the question attached, so the tool can raise the dialog itself',
  entry?.prompt?.attackerDeclaredMoveId != null && entry?.prompt?.defenseKind === 'block',
  JSON.stringify(entry?.prompt));
check('...and marked as the GM’s to answer', entry?.gmCanAnswer === true, String(entry?.gmCanAnswer));
check('...naming both fighters in the summary',
  (entry?.summary ?? '').includes(holder.name) && (entry?.summary ?? '').includes(striker.name),
  entry?.summary);
if (entry?.summary) console.log(`  ${entry.summary}`);

// A Player asking gets nothing back at all — the handler is GM-only.
let playerHeard = false;
player.once('combat:pauses', () => { playerHeard = true; });
player.emit('combat:resummon_pause');
await sleep(800);
check('a Player asking the same question is ignored', playerHeard === false);

// ---------------------------------------------------------------------------
console.log('\n— Answering it moves the fight on, and the list empties —');
// ---------------------------------------------------------------------------
phone.emit('combat:resolve_block', { pairIndex: 0, outcome: 'successful' });
await sleep(4000);
check('the round runs on once the recovered prompt is answered',
  (await statusOf()) !== 'paused_defense', await statusOf());
const after = await pausesFor(phone);
check('nothing is left waiting', (after?.pauses ?? []).length === 0, JSON.stringify(after));
const afterSnap = await snapshot();
check('and the snapshot stops reporting it, so the dialog comes down on its own',
  afterSnap.pairs[0]?.pendingDefense == null, JSON.stringify(afterSnap.pairs[0]?.pendingDefense));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
driver.close();
phone.close();
player.close();
process.exit(failures ? 1 : 0);

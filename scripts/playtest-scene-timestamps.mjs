// Playtest: the Timestamp tool (Scene tab, GM-exclusive — see db.js's own
// comment on scene_timestamps). Covers:
//   - the two different trust levels for the same table: managing the list
//     (create/update/delete/REST read) is exactly as GM-secret as GM
//     Notes, while PLAYING one is a plain io.emit a Player receives too —
//     carrying only that one row's date/subtext, never the id or the rest
//     of the list
//   - the list is global, not Scene-scoped — no active Scene is needed at
//     all for any of this to work
//   - chronological auto-sort (undated rows last), an explicit REAL date
//     column now, not free text
//   - "Current" (is_current) is exclusive — setting a new one clears the
//     old one in the same write, and re-toggling the current one clears it
//     to none rather than being a one-way pin
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-scene-timestamps.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));

const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const wait = (sock, ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => {
      if (pred(p)) {
        clearTimeout(t);
        sock.off(ev, h);
        res(p);
      }
    };
    sock.on(ev, h);
  });

const stamp = Date.now();

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
await sleep(200);

const player = io(BASE);
await new Promise((r) => player.on('connect', r));
player.emit('identity:set', { role: 'player', characterId: null });
await sleep(200);

// ============================================ 1. a Player may not manage the list at all
console.log('--- managing Timestamps is GM-only ---');
const restAsPlayer = await fetch(
  `${BASE}/api/scene-timestamps?${new URLSearchParams({ role: 'player' })}`
);
check("a Player's own REST read is refused (403)", restAsPlayer.status === 403);

player.emit('scene_timestamp:create', { name: `ForgedTs${stamp}`, date: '2001-01-01', subtext: '' });
await sleep(300);
const restAsGmAfterForgery = await jf(`/api/scene-timestamps?${new URLSearchParams({ role: 'gm' })}`);
check(
  "a Player's own scene_timestamp:create is refused — nothing was inserted",
  !restAsGmAfterForgery.some((t) => t.name === `ForgedTs${stamp}`),
  JSON.stringify(restAsGmAfterForgery.map((t) => t.name))
);

// ============================================ 2. the GM may create/update/delete, GM-only broadcast
console.log('\n--- the GM manages the list, broadcast GM-only (emitToGm), a real date field ---');
let playerSawManagement = false;
const spyManagement = () => {
  playerSawManagement = true;
};
player.on('scene_timestamp:created', spyManagement);

gm.emit('scene_timestamp:create', { name: `Middle${stamp}`, date: '2015-05-12', subtext: 'It begins.' });
const created = await wait(gm, 'scene_timestamp:created', (t) => t.name === `Middle${stamp}`);
check('the create landed with the right fields', created.date === '2015-05-12' && created.subtext === 'It begins.');

await sleep(300);
player.off('scene_timestamp:created', spyManagement);
check("a Player's own socket never receives scene_timestamp:created", !playerSawManagement);

gm.emit('scene_timestamp:update', { timestampId: created.id, name: created.name, date: '2015-05-12', subtext: 'Updated.' });
const updated = await wait(gm, 'scene_timestamp:updated', (t) => t.id === created.id);
check('the update landed', updated.subtext === 'Updated.');

// ============================================ 3. chronological auto-sort, undated last
console.log('\n--- REST list is auto-sorted chronologically, undated rows last ---');
gm.emit('scene_timestamp:create', { name: `Early${stamp}`, date: '2010-01-01', subtext: '' });
const early = await wait(gm, 'scene_timestamp:created', (t) => t.name === `Early${stamp}`);
gm.emit('scene_timestamp:create', { name: `Late${stamp}`, date: '2020-01-01', subtext: '' });
const late = await wait(gm, 'scene_timestamp:created', (t) => t.name === `Late${stamp}`);
gm.emit('scene_timestamp:create', { name: `Undated${stamp}`, date: '', subtext: '' });
const undated = await wait(gm, 'scene_timestamp:created', (t) => t.name === `Undated${stamp}`);
await sleep(300);

const sortedList = await jf(`/api/scene-timestamps?${new URLSearchParams({ role: 'gm' })}`);
const ourIds = new Set([early.id, updated.id, late.id, undated.id]);
const ourOrder = sortedList.filter((t) => ourIds.has(t.id)).map((t) => t.id);
check(
  'chronological order: Early, Middle(updated), Late, then Undated last',
  JSON.stringify(ourOrder) === JSON.stringify([early.id, updated.id, late.id, undated.id]),
  JSON.stringify(ourOrder)
);

// ============================================ 4. Current is exclusive, and toggles off
console.log('\n--- Current (star) is exclusive, and re-toggling clears it ---');
gm.emit('scene_timestamp:set_current', { timestampId: early.id });
let currentChanged = await wait(gm, 'scene_timestamp:current_changed', () => true);
check('marking Early current lands', currentChanged.currentId === early.id);

gm.emit('scene_timestamp:set_current', { timestampId: late.id });
currentChanged = await wait(gm, 'scene_timestamp:current_changed', () => true);
check('marking Late current lands', currentChanged.currentId === late.id);
await sleep(300);
const afterSwitch = await jf(`/api/scene-timestamps?${new URLSearchParams({ role: 'gm' })}`);
check(
  'Early was un-starred when Late became current — exactly one row is current',
  afterSwitch.find((t) => t.id === early.id)?.is_current === 0 &&
    afterSwitch.find((t) => t.id === late.id)?.is_current === 1,
  JSON.stringify(afterSwitch.filter((t) => ourIds.has(t.id)).map((t) => [t.id, t.is_current]))
);

gm.emit('scene_timestamp:set_current', { timestampId: late.id });
currentChanged = await wait(gm, 'scene_timestamp:current_changed', () => true);
check('re-toggling the current one clears it to none (currentId: null)', currentChanged.currentId === null);

// ============================================ 5. playing broadcasts to EVERYONE, date/subtext only
console.log('\n--- playing broadcasts to EVERYONE, date/subtext only ---');
const gmPlayed = wait(gm, 'stage:timestamp_played', () => true);
const playerPlayed = wait(player, 'stage:timestamp_played', () => true);
gm.emit('stage:timestamp_play', { timestampId: updated.id });
const [gmSaw, playerSaw] = await Promise.all([gmPlayed, playerPlayed]);
check(
  "the GM's own socket receives the play event with the right fields",
  gmSaw.date === '2015-05-12' && gmSaw.subtext === 'Updated.',
  JSON.stringify(gmSaw)
);
check(
  "a Player's socket receives the SAME play event — nobody is excluded from watching it play",
  playerSaw.date === '2015-05-12' && playerSaw.subtext === 'Updated.',
  JSON.stringify(playerSaw)
);
check(
  'the played payload carries no id/name — a Player never gets an identifier back to look anything up with',
  playerSaw.timestampId === undefined && playerSaw.id === undefined && playerSaw.name === undefined,
  JSON.stringify(playerSaw)
);

// ============================================ 6. a Player may not trigger a play, or set current
console.log('\n--- only the GM may trigger a play or set Current ---');
let gmSawSecondPlay = false;
const spyPlay = () => {
  gmSawSecondPlay = true;
};
gm.on('stage:timestamp_played', spyPlay);
player.emit('stage:timestamp_play', { timestampId: updated.id });
await sleep(300);
gm.off('stage:timestamp_played', spyPlay);
check("a Player's own stage:timestamp_play is refused — nothing was broadcast", !gmSawSecondPlay);

player.emit('scene_timestamp:set_current', { timestampId: early.id });
await sleep(300);
const afterPlayerSetCurrent = await jf(`/api/scene-timestamps?${new URLSearchParams({ role: 'gm' })}`);
check(
  "a Player's own scene_timestamp:set_current is refused",
  !afterPlayerSetCurrent.some((t) => t.is_current === 1),
  JSON.stringify(afterPlayerSetCurrent.filter((t) => t.is_current).map((t) => t.id))
);

// ============================================ 7. cleanup / delete
console.log('\n--- delete ---');
for (const id of [created.id, early.id, late.id, undated.id]) {
  gm.emit('scene_timestamp:delete', { timestampId: id });
  await wait(gm, 'scene_timestamp:deleted', (p) => p.timestampId === id);
}
const afterDelete = await jf(`/api/scene-timestamps?${new URLSearchParams({ role: 'gm' })}`);
check(
  'all four test Timestamps are gone from the list',
  ![created.id, early.id, late.id, undated.id].some((id) => afterDelete.some((t) => t.id === id)),
  JSON.stringify(afterDelete.map((t) => t.id))
);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
player.close();
process.exit(failures ? 1 : 0);

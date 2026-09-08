// Playtest: the Timestamp tool (Scene tab, GM-exclusive — see db.js's own
// comment on scene_timestamps). Covers the two different trust levels for
// the same table:
//   - managing the list (create/update/delete/REST read) is exactly as
//     GM-secret as GM Notes — a Player's own attempt at any of it is
//     refused, and a Player-identified REST fetch gets a 403
//   - PLAYING one is the opposite: a plain io.emit, so a Player socket
//     receives the same stage:timestamp_played a GM's own does, carrying
//     only that one row's dateText/subtext (never the id, never the rest
//     of the list)
//   - the list is global, not Scene-scoped — no active Scene is needed at
//     all for any of this to work
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

player.emit('scene_timestamp:create', { name: `ForgedTs${stamp}`, dateText: 'Day 0', subtext: '' });
await sleep(300);
const restAsGmAfterForgery = await jf(`/api/scene-timestamps?${new URLSearchParams({ role: 'gm' })}`);
check(
  "a Player's own scene_timestamp:create is refused — nothing was inserted",
  !restAsGmAfterForgery.some((t) => t.name === `ForgedTs${stamp}`),
  JSON.stringify(restAsGmAfterForgery.map((t) => t.name))
);

// ============================================ 2. the GM may create/update/delete, GM-only broadcast
console.log('\n--- the GM manages the list, broadcast GM-only (emitToGm) ---');
let playerSawManagement = false;
const spyManagement = () => {
  playerSawManagement = true;
};
player.on('scene_timestamp:created', spyManagement);

gm.emit('scene_timestamp:create', { name: `DayOne${stamp}`, dateText: 'Day 1', subtext: 'It begins.' });
const created = await wait(gm, 'scene_timestamp:created', (t) => t.name === `DayOne${stamp}`);
check('the create landed with the right fields', created.date_text === 'Day 1' && created.subtext === 'It begins.');

await sleep(300);
player.off('scene_timestamp:created', spyManagement);
check("a Player's own socket never receives scene_timestamp:created", !playerSawManagement);

gm.emit('scene_timestamp:update', { timestampId: created.id, name: created.name, dateText: 'Day 1', subtext: 'Updated.' });
const updated = await wait(gm, 'scene_timestamp:updated', (t) => t.id === created.id);
check('the update landed', updated.subtext === 'Updated.');

// ============================================ 3. playing is the opposite trust model — everyone sees it
console.log('\n--- playing broadcasts to EVERYONE, dateText/subtext only ---');
const gmPlayed = wait(gm, 'stage:timestamp_played', () => true);
const playerPlayed = wait(player, 'stage:timestamp_played', () => true);
gm.emit('stage:timestamp_play', { timestampId: updated.id });
const [gmSaw, playerSaw] = await Promise.all([gmPlayed, playerPlayed]);
check(
  "the GM's own socket receives the play event with the right text",
  gmSaw.dateText === 'Day 1' && gmSaw.subtext === 'Updated.',
  JSON.stringify(gmSaw)
);
check(
  "a Player's socket receives the SAME play event — nobody is excluded from watching it play",
  playerSaw.dateText === 'Day 1' && playerSaw.subtext === 'Updated.',
  JSON.stringify(playerSaw)
);
check(
  'the played payload carries no id/name — a Player never gets an identifier back to look anything up with',
  playerSaw.timestampId === undefined && playerSaw.id === undefined && playerSaw.name === undefined,
  JSON.stringify(playerSaw)
);

// ============================================ 4. a Player may not trigger a play either
console.log('\n--- only the GM may trigger a play ---');
let gmSawSecondPlay = false;
const spyPlay = () => {
  gmSawSecondPlay = true;
};
gm.on('stage:timestamp_played', spyPlay);
player.emit('stage:timestamp_play', { timestampId: updated.id });
await sleep(300);
gm.off('stage:timestamp_played', spyPlay);
check("a Player's own stage:timestamp_play is refused — nothing was broadcast", !gmSawSecondPlay);

// ============================================ 5. delete
console.log('\n--- delete ---');
gm.emit('scene_timestamp:delete', { timestampId: updated.id });
await wait(gm, 'scene_timestamp:deleted', (p) => p.timestampId === updated.id);
const afterDelete = await jf(`/api/scene-timestamps?${new URLSearchParams({ role: 'gm' })}`);
check(
  'the deleted Timestamp is gone from the list',
  !afterDelete.some((t) => t.id === updated.id),
  JSON.stringify(afterDelete.map((t) => t.id))
);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
player.close();
process.exit(failures ? 1 : 0);

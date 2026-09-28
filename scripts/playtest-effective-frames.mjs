// Playtest: a character's OWN move frames are what combat uses.
//
//   TURSO_DATABASE_URL="file:/tmp/ef.db" PORT=3042 node server/index.js
//   E2E_URL=http://localhost:3042 PLAYTEST_DB="file:/tmp/ef.db" node scripts/playtest-effective-frames.mjs
//
// Reported as "Speed mastery changes the amount of Startup frames in the
// character sheet, but in actual combat mathematics it did not" — and the
// report is narrower than the bug. `getMovesFor` is the ONLY place that folds
// `character_move_overrides` and Perk `moveFrameDelta` into a move's frames, so
// the sheet and the declare picker show the reduced footprint while every
// combat path reads the raw `moves` template. Speed mastery is simply the
// easiest way to see it; a GM-granted override and Osu! are wrong in exactly
// the same way.
//
// This is a live playtest rather than a unit test because the bug is entirely
// in the wiring: every function involved is individually correct, and the only
// place the disagreement exists is the row the declare handler actually wrote.
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
if (!process.env.PLAYTEST_DB) {
  console.error('PLAYTEST_DB must be the same TURSO_DATABASE_URL the server was started with.');
  process.exit(1);
}
process.env.TURSO_DATABASE_URL = process.env.PLAYTEST_DB;
const { all, one, run } = await import('../server/db.js');

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
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

gm.emit('tell:create', { name: `EF ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `EF ${stamp}`);

// Startup 3 so a -1 is unambiguous and a 0 floor is nowhere near.
const STARTUP = 3;
gm.emit('move:create', {
  name: `EFJab${stamp}`, isDefault: true, tellId: tell.id,
  description: 'frames', interactions: {}, staminaCost: 0,
  startupTics: STARTUP, activeTics: 1, recoveryTics: 1, rollSlots: ['Right Hand'],
});
const move = await wait('move:created', (m) => m.name === `EFJab${stamp}`);

const speedy = await jpost('/api/characters', { name: `Speedy${stamp}`, characterType: 'npc' });
const plain = await jpost('/api/characters', { name: `Plain${stamp}`, characterType: 'npc' });

// Path To Mastery: Speed is seeded; grant it to one of the two.
const perk = await one("SELECT id FROM perks WHERE name = 'Path To Mastery: Speed'");
check('Path To Mastery: Speed is seeded', Boolean(perk), 'no such Perk');
if (!perk) process.exit(1);
gm.emit('perk:grant', { characterId: speedy.id, perkId: perk.id });
await sleep(700);

// What the character sheet / declare picker says — the half that was already
// right, quoted here so the comparison below is against a real number rather
// than an assumption about one.
const sheet = await jf(`/api/characters/${speedy.id}?role=gm`);
const shown = sheet.moves.find((m) => m.id === move.id);
// `getMovesFor` keeps the template's own `startup_tics` untouched and publishes
// the character's real frames alongside it as `effective_startup_tics` — that
// second field is what the sheet and the declare picker render, and it is
// already correct. The bug is entirely that combat never reads it.
check(
  `the sheet shows Startup ${STARTUP - 1} for the Perk holder`,
  shown?.effective_startup_tics === STARTUP - 1,
  `sheet says ${shown?.effective_startup_tics}, template says ${shown?.startup_tics}`
);
check(
  'and leaves the shared template alone',
  shown?.startup_tics === STARTUP,
  `template now reads ${shown?.startup_tics}`
);

gm.emit('combat:add_participant', { characterId: speedy.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === speedy.id));
gm.emit('combat:add_participant', { characterId: plain.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === plain.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;

// Declaration alternates by side, so both are declared in whatever order the
// pair asks for rather than a fixed one.
const want = {
  left: { characterId: speedy.id, moveId: move.id },
  right: { characterId: plain.id, moveId: move.id },
};
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  const who = want[side];
  gm.emit('move:declare', { ...who, placementTic: start });
  await sleep(450);
  gm.emit('combat:character_done_declaring', { characterId: who.characterId });
  await sleep(450);
}

const rowFor = (id) =>
  one(
    'SELECT placement_tic, reveal_tic FROM declared_moves WHERE character_id = ? AND move_id = ? ORDER BY id DESC',
    [id, move.id]
  );
const speedyRow = await rowFor(speedy.id);
const plainRow = await rowFor(plain.id);
check('both fighters declared', Boolean(speedyRow && plainRow), `${JSON.stringify(speedyRow)} / ${JSON.stringify(plainRow)}`);
if (!speedyRow || !plainRow) process.exit(1);

// **The bug, stated as a number.** reveal_tic is placement + Startup, so the
// Perk holder must reveal one Tic EARLIER than the fighter without it. That is
// the whole of "Speed mastery changes the combat mathematics".
check(
  'the fighter WITHOUT the Perk reveals after the full Startup',
  plainRow.reveal_tic - plainRow.placement_tic === STARTUP,
  `revealed ${plainRow.reveal_tic - plainRow.placement_tic} Tics after placement`
);
check(
  'the Perk holder reveals a Tic SOONER in the real combat row',
  speedyRow.reveal_tic - speedyRow.placement_tic === STARTUP - 1,
  `revealed ${speedyRow.reveal_tic - speedyRow.placement_tic} Tics after placement, same as without the Perk`
);

// --- and a GM-granted per-character override is the same seam ---------------
gm.emit('combat:clear', {});
await sleep(600);
await run(
  `INSERT INTO character_move_overrides (character_id, move_id, startup_delta, active_delta, recovery_delta)
   VALUES (?, ?, -2, 0, 0)`,
  [plain.id, move.id]
);
gm.emit('combat:add_participant', { characterId: speedy.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === speedy.id));
gm.emit('combat:add_participant', { characterId: plain.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === plain.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const start2 = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;
for (let i = 0; i < 2; i += 1) {
  const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
  if (!side) break;
  const who = want[side];
  gm.emit('move:declare', { ...who, placementTic: start2 });
  await sleep(450);
  gm.emit('combat:character_done_declaring', { characterId: who.characterId });
  await sleep(450);
}
const overridden = await rowFor(plain.id);
check(
  'a GM-granted -2 Startup override also reaches the combat row',
  overridden && overridden.reveal_tic - overridden.placement_tic === STARTUP - 2,
  `revealed ${overridden ? overridden.reveal_tic - overridden.placement_tic : '?'} Tics after placement`
);

// --- the stored row describes itself, so a Perk revoked mid-round cannot
// --- retroactively move a move that is already on the board ------------------
const snapshot = await all(
  `SELECT effective_startup_tics AS s FROM declared_moves WHERE character_id = ? ORDER BY id DESC LIMIT 1`,
  [speedy.id]
).catch(() => null);
check(
  'the declared row carries the frames it was declared with',
  Array.isArray(snapshot) && snapshot[0]?.s === STARTUP - 1,
  `stored ${JSON.stringify(snapshot)}`
);

gm.emit('combat:clear', {});
await sleep(400);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
gm.close();
process.exit(fails ? 1 : 0);

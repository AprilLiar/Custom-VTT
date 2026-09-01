// Playtest: the **Special** Tag on Moves and Perks.
//
// The whole feature is an absence — a Player does not see the thing and cannot
// take it — and an absence is exactly what a unit test cannot check and what
// fails silently in play. Three claims, each of which can be wrong on its own:
//
//   1. **A Player cannot take one, even asking directly.** The Compendium hides
//      it, so reaching the grant event means a stale view or a hand-sent one —
//      which is precisely what somebody who wants the boss's technique will do.
//   2. **Character Creation is not a way around it.** It is the largest way a
//      Player takes Moves and Perks, and it has its own grant path.
//   3. **The GM is unaffected**, both ways round: they can still hand one out,
//      and a Player who has been given one keeps it.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3100 node server/index.js
//   E2E_URL=http://localhost:3100 node scripts/playtest-special-tag.mjs
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

const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  await sleep(400);
  return s;
};
const wait = (sock, ev, pred = () => true, ms = 12000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

const stamp = Date.now();
const gm = await connect({ role: 'gm' });

// Both vocabularies seed their own Special, and both are matched by NAME.
const moveTags = await jf('/api/tags');
const perkTags = await jf('/api/perk-tags');
const specialMoveTag = (moveTags ?? []).find((t) => t.name.trim().toLowerCase() === 'special');
const specialPerkTag = (perkTags ?? []).find((t) => t.name.trim().toLowerCase() === 'special');
check('the Special Move Tag is seeded', specialMoveTag != null,
  JSON.stringify((moveTags ?? []).map((t) => t.name)));
check('the Special Perk Tag is seeded', specialPerkTag != null,
  JSON.stringify((perkTags ?? []).map((t) => t.name)));
if (!specialMoveTag || !specialPerkTag) process.exit(1);

gm.emit('tell:create', { name: `Sp Tell ${stamp}` });
const tell = await wait(gm, 'tell:created');

const mkMove = async (name, tagIds = []) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: false, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1, description: name,
    interactions: {}, rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0, tagIds,
  });
  return wait(gm, 'move:created', (m) => m.name === `${name} ${stamp}`);
};
const mkPerk = async (name, tagIds = []) => {
  gm.emit('perk:create', { name: `${name} ${stamp}`, description: name, tagIds });
  return wait(gm, 'perk:created', (p) => p.name === `${name} ${stamp}`);
};

const secretMove = await mkMove('Forbidden Technique', [specialMoveTag.id]);
const openMove = await mkMove('Ordinary Jab');
const secretPerk = await mkPerk('Mark of the Master', [specialPerkTag.id]);
const openPerk = await mkPerk('Ordinary Grit');

const hero = await jpost('/api/characters', { name: `Sp${stamp}`, characterType: 'pc' });
const player = await connect({ role: 'player', characterId: hero.id });

const movesOf = async () => (await jf(`/api/characters/${hero.id}`)).moves.map((m) => m.name);
const perksOf = async () => (await jf(`/api/characters/${hero.id}`)).perks.map((p) => p.name);

// ============================================ 1. a Player asking directly
console.log('\n--- a Player reaching for it anyway ---');
player.emit('move:grant', { characterId: hero.id, moveId: secretMove.id });
player.emit('perk:grant', { characterId: hero.id, perkId: secretPerk.id });
await sleep(900);
check('a Player cannot learn a Special Move, even asking outright',
  !(await movesOf()).includes(secretMove.name), JSON.stringify(await movesOf()));
check('...nor take a Special Perk', !(await perksOf()).includes(secretPerk.name),
  JSON.stringify(await perksOf()));

// The control: the same two events, on things that are not Special.
player.emit('move:grant', { characterId: hero.id, moveId: openMove.id });
player.emit('perk:grant', { characterId: hero.id, perkId: openPerk.id });
await sleep(900);
check('an ordinary Move is still theirs to learn', (await movesOf()).includes(openMove.name),
  JSON.stringify(await movesOf()));
check('...and an ordinary Perk still theirs to take', (await perksOf()).includes(openPerk.name),
  JSON.stringify(await perksOf()));

// ============================================ 2. Character Creation
console.log('\n--- and through Character Creation ---');
const builder = await jpost('/api/characters', { name: `SpB${stamp}`, characterType: 'pc' });
const asBuilder = await connect({ role: 'player', characterId: builder.id });
asBuilder.emit('character:apply_creation', {
  characterId: builder.id,
  age: 'adult',
  moveIds: [secretMove.id, openMove.id],
  perkIds: [secretPerk.id, openPerk.id],
});
await sleep(1400);
const built = await jf(`/api/characters/${builder.id}`);
const builtMoves = built.moves.map((m) => m.name);
const builtPerks = built.perks.map((p) => p.name);
check('Character Creation refuses a Special Move', !builtMoves.includes(secretMove.name),
  JSON.stringify(builtMoves));
check('...and a Special Perk', !builtPerks.includes(secretPerk.name), JSON.stringify(builtPerks));
check('...while taking the ordinary ones in the same submission',
  builtMoves.includes(openMove.name) && builtPerks.includes(openPerk.name),
  JSON.stringify({ builtMoves, builtPerks }));

// ============================================ 3. the GM is unaffected
console.log('\n--- what the GM can still do ---');
gm.emit('move:grant', { characterId: hero.id, moveId: secretMove.id });
gm.emit('perk:grant', { characterId: hero.id, perkId: secretPerk.id });
await sleep(900);
check('the GM can hand out a Special Move', (await movesOf()).includes(secretMove.name),
  JSON.stringify(await movesOf()));
check('...and a Special Perk', (await perksOf()).includes(secretPerk.name),
  JSON.stringify(await perksOf()));
// And once it is theirs, it stays theirs: hiding what somebody already holds
// would leave them with a move they cannot read.
check('...and it stays on the sheet afterwards, readable',
  (await jf(`/api/characters/${hero.id}`)).moves.some((m) => m.name === secretMove.name));

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
for (const s of [gm, player, asBuilder]) s.close();
process.exit(failures === 0 ? 0 : 1);

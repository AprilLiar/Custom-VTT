// Playtest for **Quirks** — narrative only, positive or negative, any number.
//
// The one thing here that a unit test cannot reach is the thing most worth
// checking: **copy, not link**. Taking an example off the Compendium's shelf
// copies its text onto a character, and every consequence of that choice only
// shows up across two live surfaces — editing your copy must not touch the
// example, editing the example must not rewrite anybody's sheet, and deleting
// the example must leave every copy standing. So this drives real sockets.
//
// It also pins the one authority rule in the feature: **the shelf is the GM's**.
// A Player may write and take Quirks all day, and may not author examples —
// enforced server-side rather than merely hidden in the UI, which is the only
// version of that rule worth having in a no-auth app.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-quirks.mjs
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
    sock.on('connect', () => res(sock));
  });

const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const gm = await connect();
const player = await connect();
gm.emit('identity:set', { role: 'gm' });

const stamp = Date.now();
const hero = await jpost('/api/characters', { name: `Q Hero ${stamp}`, characterType: 'pc' });
const other = await jpost('/api/characters', { name: `Q Other ${stamp}`, characterType: 'pc' });
player.emit('identity:set', { role: 'player', characterId: hero.id });
await sleep(400);

const shelf = async () => (await jf('/api/quirks')) ?? [];
const sheetOf = async (id) => (await jf(`/api/characters/${id}`))?.quirks ?? [];
const mine = (list, name) => list.find((q) => q.name === name) ?? null;

// ============================================ 1. the shelf is the GM's
console.log('\n--- The Compendium shelf is GM-authored ---');
{
  gm.emit('quirk:create', { name: `Steady hands ${stamp}`, description: 'Never shakes.', kind: 'positive' });
  gm.emit('quirk:create', { name: `Bad knee ${stamp}`, description: 'It goes in the cold.', kind: 'negative' });
  // A kind nobody recognises has to become a legal one before it reaches the
  // column's CHECK, rather than throwing.
  gm.emit('quirk:create', { name: `Odd one ${stamp}`, description: '', kind: 'sideways' });
  await sleep(700);

  const list = await shelf();
  check('the GM can put examples on the shelf', list.length >= 3, JSON.stringify(list.map((q) => q.name)));
  check('...on the side they asked for',
    mine(list, `Steady hands ${stamp}`)?.kind === 'positive' && mine(list, `Bad knee ${stamp}`)?.kind === 'negative',
    JSON.stringify(list.map((q) => [q.name, q.kind])));
  check('an unrecognised kind lands on a side rather than being refused',
    mine(list, `Odd one ${stamp}`)?.kind === 'positive', JSON.stringify(mine(list, `Odd one ${stamp}`)));

  const before = (await shelf()).length;
  player.emit('quirk:create', { name: `Player forgery ${stamp}`, kind: 'positive' });
  await sleep(600);
  check('a Player CANNOT author an example', (await shelf()).length === before,
    JSON.stringify((await shelf()).map((q) => q.name)));

  // ...and cannot edit or delete one either.
  const target = mine(await shelf(), `Steady hands ${stamp}`);
  player.emit('quirk:update', { quirkId: target.id, name: 'Hijacked', kind: 'negative' });
  player.emit('quirk:delete', { quirkId: target.id });
  await sleep(600);
  const after = mine(await shelf(), `Steady hands ${stamp}`);
  check('...nor edit or delete one', after != null && after.name === `Steady hands ${stamp}`,
    JSON.stringify(after));
}

// ============================================ 2. taking one COPIES it
console.log('\n--- Taking an example copies its text; it does not link to it ---');
{
  const example = mine(await shelf(), `Bad knee ${stamp}`);
  player.emit('character_quirk:add', { characterId: hero.id, quirkId: example.id });
  await sleep(600);

  let sheet = await sheetOf(hero.id);
  const copy = mine(sheet, `Bad knee ${stamp}`);
  check('the Quirk is on the sheet', copy != null, JSON.stringify(sheet));
  check('...carrying the example\'s own text and side',
    copy?.description === 'It goes in the cold.' && copy?.kind === 'negative', JSON.stringify(copy));
  check('...and no reference back to the shelf', copy != null && copy.quirk_id === undefined,
    JSON.stringify(Object.keys(copy ?? {})));

  // Taking it twice is one Quirk: the second click meant nothing.
  player.emit('character_quirk:add', { characterId: hero.id, quirkId: example.id });
  await sleep(600);
  sheet = await sheetOf(hero.id);
  check('taking the same example twice adds it once',
    sheet.filter((q) => q.name === `Bad knee ${stamp}`).length === 1, JSON.stringify(sheet.map((q) => q.name)));

  // **The copy is yours to reword, and the example does not move.**
  player.emit('character_quirk:update', {
    characterQuirkId: copy.id, name: `Bad knee ${stamp}`, description: 'Mine now.', kind: 'negative',
  });
  await sleep(600);
  check('rewording your copy changes your copy',
    mine(await sheetOf(hero.id), `Bad knee ${stamp}`)?.description === 'Mine now.',
    JSON.stringify(await sheetOf(hero.id)));
  check('...and leaves the example alone',
    mine(await shelf(), `Bad knee ${stamp}`)?.description === 'It goes in the cold.',
    JSON.stringify(mine(await shelf(), `Bad knee ${stamp}`)));

  // ...and the other way round.
  gm.emit('quirk:update', {
    quirkId: example.id, name: `Bad knee ${stamp}`, description: 'GM rewrote the example.', kind: 'negative',
  });
  await sleep(600);
  check('editing the example does NOT rewrite anybody\'s sheet',
    mine(await sheetOf(hero.id), `Bad knee ${stamp}`)?.description === 'Mine now.',
    JSON.stringify(mine(await sheetOf(hero.id), `Bad knee ${stamp}`)));

  // Deleting the example is not a revocation.
  gm.emit('quirk:delete', { quirkId: example.id });
  await sleep(600);
  check('deleting the example removes it from the shelf',
    mine(await shelf(), `Bad knee ${stamp}`) == null, JSON.stringify((await shelf()).map((q) => q.name)));
  check('...and the copy on the sheet survives it',
    mine(await sheetOf(hero.id), `Bad knee ${stamp}`) != null, JSON.stringify(await sheetOf(hero.id)));
}

// ============================================ 3. writing one on the fly
console.log('\n--- Writing one on the spot, and any number of them ---');
{
  for (const [name, kind] of [['Sweet tooth', 'positive'], ['Loud sleeper', 'negative'], ['Lucky', 'positive']]) {
    player.emit('character_quirk:add', {
      characterId: hero.id, name: `${name} ${stamp}`, description: `${name}, at length.`, kind,
    });
  }
  await sleep(800);
  const sheet = await sheetOf(hero.id);
  check('an invented Quirk lands on the sheet with no Compendium row behind it',
    mine(sheet, `Sweet tooth ${stamp}`) != null, JSON.stringify(sheet.map((q) => q.name)));
  check('...and never appears on the shelf',
    mine(await shelf(), `Sweet tooth ${stamp}`) == null, JSON.stringify((await shelf()).map((q) => q.name)));
  check('any number is allowed — four on one character', sheet.length === 4, JSON.stringify(sheet.length));
  check('both sides are represented',
    sheet.some((q) => q.kind === 'positive') && sheet.some((q) => q.kind === 'negative'),
    JSON.stringify(sheet.map((q) => q.kind)));

  // The same name on the two sides is two Quirks, not a duplicate.
  player.emit('character_quirk:add', { characterId: hero.id, name: `Famous ${stamp}`, kind: 'positive' });
  player.emit('character_quirk:add', { characterId: hero.id, name: `Famous ${stamp}`, kind: 'negative' });
  await sleep(700);
  check('the same name on opposite sides is two Quirks',
    (await sheetOf(hero.id)).filter((q) => q.name === `Famous ${stamp}`).length === 2,
    JSON.stringify((await sheetOf(hero.id)).map((q) => [q.name, q.kind])));

  // One character's Quirks are their own.
  check('none of it landed on the other character', (await sheetOf(other.id)).length === 0,
    JSON.stringify(await sheetOf(other.id)));

  // Removing one.
  const doomed = mine(await sheetOf(hero.id), `Lucky ${stamp}`);
  player.emit('character_quirk:remove', { characterQuirkId: doomed.id });
  await sleep(600);
  check('removing one takes exactly that one',
    mine(await sheetOf(hero.id), `Lucky ${stamp}`) == null &&
      mine(await sheetOf(hero.id), `Sweet tooth ${stamp}`) != null,
    JSON.stringify((await sheetOf(hero.id)).map((q) => q.name)));
}

// ============================================ 4. showing one to the table
console.log('\n--- The ↑ puts a Quirk card in the Chat Log ---');
{
  const sheet = await sheetOf(hero.id);
  const shown = mine(sheet, `Sweet tooth ${stamp}`);
  const before = ((await jf('/api/chat')) ?? []).length;
  player.emit('character_quirk:share', { characterQuirkId: shown.id });
  await sleep(800);

  const chat = (await jf('/api/chat')) ?? [];
  const card = chat.find((e) => e.kind === 'quirk' && e.quirkName === `Sweet tooth ${stamp}`);
  check('sharing posts one card', chat.length === before + 1, `${before} -> ${chat.length}`);
  check('...carrying the Quirk in full', card?.quirkDescription === `Sweet tooth, at length.`,
    JSON.stringify(card));
  check('...its side, for the colour', card?.quirkKind === 'positive', JSON.stringify(card?.quirkKind));
  check('...and whose it is', card?.characterName === hero.name, JSON.stringify(card?.characterName));

  // **Self-contained at post time.** Reword the Quirk and the card must not
  // move — the same rule every other non-roll card in this log follows, and the
  // reason chat history survives at all.
  player.emit('character_quirk:update', {
    characterQuirkId: shown.id, name: `Sweet tooth ${stamp}`, description: 'Reworded after.', kind: 'positive',
  });
  await sleep(700);
  const after = ((await jf('/api/chat')) ?? []).find(
    (e) => e.kind === 'quirk' && e.quirkName === `Sweet tooth ${stamp}`
  );
  check('rewording the Quirk does not rewrite the card already in the log',
    after?.quirkDescription === `Sweet tooth, at length.`, JSON.stringify(after?.quirkDescription));

  // ...and it survives the Quirk being dropped altogether.
  player.emit('character_quirk:remove', { characterQuirkId: shown.id });
  await sleep(700);
  check('...nor does dropping the Quirk remove the card',
    ((await jf('/api/chat')) ?? []).some((e) => e.kind === 'quirk' && e.quirkName === `Sweet tooth ${stamp}`));
  check('sharing a Quirk that no longer exists does nothing at all',
    (() => { player.emit('character_quirk:share', { characterQuirkId: shown.id }); return true; })());
  await sleep(600);
  check('...and posts no card', ((await jf('/api/chat')) ?? []).filter(
    (e) => e.kind === 'quirk' && e.quirkName === `Sweet tooth ${stamp}`).length === 1);
}

// ============================================ 5. through the Creator
console.log('\n--- The Character Creator writes them with everything else ---');
{
  const built = await jpost('/api/characters', { name: `Q Built ${stamp}`, characterType: 'pc' });
  gm.emit('character:apply_creation', {
    characterId: built.id,
    quirks: [
      { name: `Creator positive ${stamp}`, description: 'From the wizard.', kind: 'positive' },
      { name: `Creator negative ${stamp}`, description: '', kind: 'negative' },
      // A duplicate and an unnamed row, both of which the validator drops.
      { name: `Creator positive ${stamp}`, kind: 'positive' },
      { name: '   ' },
    ],
    roleplay: {},
  });
  await sleep(1200);
  const sheet = await sheetOf(built.id);
  check('the Creator writes the picked Quirks', sheet.length === 2, JSON.stringify(sheet.map((q) => q.name)));
  check('...on the right sides',
    mine(sheet, `Creator positive ${stamp}`)?.kind === 'positive' &&
      mine(sheet, `Creator negative ${stamp}`)?.kind === 'negative',
    JSON.stringify(sheet.map((q) => [q.name, q.kind])));

  // Re-running the flow must not double them up.
  gm.emit('character:apply_creation', {
    characterId: built.id,
    quirks: [{ name: `Creator positive ${stamp}`, kind: 'positive' }],
    roleplay: {},
  });
  await sleep(1200);
  check('re-running the Creator does not duplicate them',
    (await sheetOf(built.id)).length === 2, JSON.stringify((await sheetOf(built.id)).map((q) => q.name)));

  // And deleting a character takes their Quirks with them.
  await fetch(`${BASE}/api/characters/${built.id}`, { method: 'DELETE' });
  await sleep(500);
  check('deleting a character takes their Quirks', (await jf(`/api/characters/${built.id}`))?.quirks == null);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
player.close();
process.exit(failures ? 1 : 0);

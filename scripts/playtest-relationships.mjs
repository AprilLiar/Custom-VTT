// Playtest: the Relationships board's server surface.
//
// Three things can only be checked against a running server, and all three are
// the kind of thing that fails silently:
//
//   1. **The privacy gate.** A board is private to its owner plus the GM. The
//      only way to test an entitlement is to ask as somebody who lacks it — a
//      real socket identity against a real endpoint.
//   2. **Per-socket broadcast.** `relationships:updated` must reach the owner
//      and the GM and NOBODY else. An `io.emit` would pass every other probe in
//      this file and leak every board in the world.
//   3. **The world-NPC-deleted conversion.** It spans a REST delete, two
//      tables and another player's board, and it is the one place where a GM
//      tidying the roster could destroy somebody's map.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3100 node server/index.js
//   E2E_URL=http://localhost:3100 node scripts/playtest-relationships.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jstatus = (u) => fetch(BASE + u).then((r) => r.status);
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());
const jdel = (u) => fetch(BASE + u, { method: 'DELETE' }).then((r) => r.json().catch(() => null));

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
  // Anything this socket is told about a board, recorded so a leak is visible.
  s.boards = [];
  s.on('relationships:updated', (p) => s.boards.push(p));
  await sleep(400);
  return s;
};

const stamp = Date.now();
const alice = await jpost('/api/characters', { name: `Alice${stamp}`, characterType: 'pc' });
const bob = await jpost('/api/characters', { name: `Bob${stamp}`, characterType: 'pc' });
const npc = await jpost('/api/characters', { name: `Barkeep${stamp}`, characterType: 'npc' });

const gm = await connect({ role: 'gm' });
const aliceSock = await connect({ role: 'player', characterId: alice.id });
const bobSock = await connect({ role: 'player', characterId: bob.id });

const board = (charId, identity) =>
  jf(`/api/characters/${charId}/relationships?${new URLSearchParams(identity)}`);
const boardStatus = (charId, identity) =>
  jstatus(`/api/characters/${charId}/relationships?${new URLSearchParams(identity)}`);

// ============================================ 1. the privacy gate
console.log('--- who may read a board ---');
check('the owner may read their own board', (await boardStatus(alice.id, { role: 'player', characterId: alice.id })) === 200);
check('the GM may read anyone\'s board', (await boardStatus(alice.id, { role: 'gm' })) === 200);
check(
  'another player may NOT read it',
  (await boardStatus(alice.id, { role: 'player', characterId: bob.id })) === 403,
  String(await boardStatus(alice.id, { role: 'player', characterId: bob.id }))
);
check('an unidentified viewer may NOT read it', (await boardStatus(alice.id, {})) === 403);

// ============================================ 2. placing people
console.log('\n--- placing somebody on the board ---');
aliceSock.emit('relationships:add_node', {
  characterId: alice.id, targetCharacterId: npc.id, x: 120, y: -40,
});
await sleep(700);
let mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('the node is there', mine?.nodes?.length === 1, JSON.stringify(mine?.nodes));
check('...at the coordinates it was dropped at', mine.nodes[0].x === 120 && mine.nodes[0].y === -40,
  JSON.stringify([mine.nodes[0].x, mine.nodes[0].y]));
check('...pointing at the world character, not a local person',
  mine.nodes[0].character_id === npc.id && mine.nodes[0].person_id === null, JSON.stringify(mine.nodes[0]));

// ============================================ 3. the broadcast reaches exactly two sockets
console.log('\n--- who is told about a board ---');
check('the owner was told', aliceSock.boards.some((b) => b.characterId === alice.id));
check('the GM was told', gm.boards.some((b) => b.characterId === alice.id));
// The probe that matters most in this file: io.emit would pass everything above.
check(
  'the other player was told NOTHING',
  bobSock.boards.length === 0,
  JSON.stringify(bobSock.boards.map((b) => b.characterId))
);

// ============================================ 4. writes are gated too
console.log('\n--- who may write a board ---');
bobSock.emit('relationships:move_node', { nodeId: mine.nodes[0].id, x: 999, y: 999 });
await sleep(700);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('another player cannot move a node on somebody else\'s board',
  mine.nodes[0].x === 120, JSON.stringify(mine.nodes[0].x));

bobSock.emit('relationships:add_node', { characterId: alice.id, targetCharacterId: npc.id, x: 0, y: 0 });
await sleep(700);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('...nor add one to it', mine.nodes.length === 1, String(mine.nodes.length));

// The GM can, by decision.
gm.emit('relationships:move_node', { nodeId: mine.nodes[0].id, x: 50, y: 60 });
await sleep(700);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('the GM can edit any board', mine.nodes[0].x === 50 && mine.nodes[0].y === 60,
  JSON.stringify([mine.nodes[0].x, mine.nodes[0].y]));

// ============================================ 5. board-local people
console.log('\n--- somebody who was never a fighter ---');
aliceSock.emit('relationships:create_person', { characterId: alice.id, name: `Ferryman${stamp}` });
await sleep(700);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('the person exists on the board', mine.people?.length === 1, JSON.stringify(mine.people));
const ferryman = mine.people[0];

// A person belongs to one board and cannot be placed on another.
bobSock.emit('relationships:add_node', { characterId: bob.id, personId: ferryman.id, x: 0, y: 0 });
await sleep(700);
const bobBoard = await board(bob.id, { role: 'player', characterId: bob.id });
check('somebody else\'s person cannot be placed on your board', (bobBoard.nodes ?? []).length === 0,
  JSON.stringify(bobBoard.nodes));

aliceSock.emit('relationships:add_node', { characterId: alice.id, personId: ferryman.id, x: 300, y: 20 });
await sleep(700);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('but your own can', mine.nodes.length === 2, String(mine.nodes.length));

// A node with both, or neither, is refused before it reaches the CHECK.
aliceSock.emit('relationships:add_node', { characterId: alice.id, targetCharacterId: npc.id, personId: ferryman.id, x: 0, y: 0 });
aliceSock.emit('relationships:add_node', { characterId: alice.id, x: 0, y: 0 });
await sleep(800);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('a node naming both a character and a person is refused', mine.nodes.length === 2, String(mine.nodes.length));

// ============================================ 6. nickname and notes are per placement
console.log('\n--- two placements, two opinions ---');
aliceSock.emit('relationships:add_node', { characterId: alice.id, targetCharacterId: npc.id, x: 500, y: 0 });
await sleep(700);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
const twoOfThem = mine.nodes.filter((n) => n.character_id === npc.id);
check('the same NPC can be placed twice', twoOfThem.length === 2, String(twoOfThem.length));
aliceSock.emit('relationships:update_node', { nodeId: twoOfThem[0].id, nickname: 'The Barkeep', notes: 'Owes me.' });
aliceSock.emit('relationships:update_node', { nodeId: twoOfThem[1].id, nickname: 'Dad', notes: 'Different story.' });
await sleep(900);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
const again = mine.nodes.filter((n) => n.character_id === npc.id);
check('each placement keeps its own nickname',
  again.find((n) => n.id === twoOfThem[0].id).nickname === 'The Barkeep' &&
    again.find((n) => n.id === twoOfThem[1].id).nickname === 'Dad',
  JSON.stringify(again.map((n) => n.nickname)));
check('...and its own notes',
  again.find((n) => n.id === twoOfThem[1].id).notes === 'Different story.');

// ============================================ 7. the conversion
console.log('\n--- the GM deletes an NPC a player remembers ---');
const beforeNodes = (await board(alice.id, { role: 'gm' })).nodes.length;
const deleted = await jdel(`/api/characters/${npc.id}`);
check('the character really was deleted', deleted?.ok === true, JSON.stringify(deleted));
await sleep(900);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('every node survived the deletion', mine.nodes.length === beforeNodes, `${beforeNodes} -> ${mine.nodes.length}`);
const converted = mine.nodes.filter((n) => n.person_id != null && n.nickname);
check('the two placements now point at a board-local person', converted.length === 2,
  JSON.stringify(mine.nodes.map((n) => [n.character_id, n.person_id])));
// One person per board, not per node — two placements of one NPC are two views
// of one person, and must not become two people.
check('...at the SAME person, not one each',
  converted.length === 2 && converted[0].person_id === converted[1].person_id,
  JSON.stringify(converted.map((n) => n.person_id)));
check('their nicknames and notes are untouched',
  converted.some((n) => n.nickname === 'The Barkeep') && converted.some((n) => n.nickname === 'Dad'),
  JSON.stringify(converted.map((n) => n.nickname)));
const remembered = mine.people.find((p) => p.id === converted[0].person_id);
check('the person carries the deleted character\'s name', remembered?.name === `Barkeep${stamp}`,
  JSON.stringify(remembered?.name));
check('nobody was left dangling', mine.nodes.every((n) => (n.character_id == null) !== (n.person_id == null)));

// ============================================ 8. deleting your own board rows
console.log('\n--- deleting people and placements ---');
aliceSock.emit('relationships:delete_person', { personId: ferryman.id });
await sleep(800);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('deleting a person takes their placements with them',
  !mine.people.some((p) => p.id === ferryman.id) && !mine.nodes.some((n) => n.person_id === ferryman.id),
  JSON.stringify([mine.people.length, mine.nodes.length]));

const victim = mine.nodes[0];
aliceSock.emit('relationships:delete_node', { nodeId: victim.id });
await sleep(700);
mine = await board(alice.id, { role: 'player', characterId: alice.id });
check('a node can be removed on its own', !mine.nodes.some((n) => n.id === victim.id));

// ============================================ 9. a deleted PC takes their own board with them
console.log('\n--- the board owner is deleted ---');
const gone = await jdel(`/api/characters/${alice.id}`);
check('deleting the owner succeeds despite their board', gone?.ok === true, JSON.stringify(gone));
const leftovers = await board(alice.id, { role: 'gm' });
check('their board is gone with them',
  (leftovers?.nodes ?? []).length === 0 && (leftovers?.people ?? []).length === 0,
  JSON.stringify(leftovers));

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
for (const s of [gm, aliceSock, bobSock]) s.close();
process.exit(failures === 0 ? 0 : 1);

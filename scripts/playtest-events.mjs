// Playtest: the Events tab (decided, new) — the GM's lanes (Everyone / GM
// only), anyone's sticky notes, author-or-GM edits, moving notes along and
// between lanes, and deleting a lane (its notes move on).
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-events.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  await sleep(300);
  return s;
};

const stamp = Date.now();
const ana = await jpost('/api/characters', { name: `EvAna${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `EvBo${stamp}`, characterType: 'pc' });
const gm = await connect({ role: 'gm' });
const pa = await connect({ role: 'player', characterId: ana.id });
const pb = await connect({ role: 'player', characterId: bo.id });
let pushed = null;
pa.on('events:updated', (b) => (pushed = b));
const board = (who) => jf(who === 'gm' ? '/api/events?role=gm' : `/api/events?role=player&characterId=${who.id}`);
const lane = (b, name) => b.lanes.find((l) => l.name === name);
const PUB = `Rumours ${stamp}`;
const SECRET = `Secrets ${stamp}`;
const OTHER = `Leads ${stamp}`;

console.log('\n--- lanes ---');
pa.emit('event_lane:create', { name: `Nope ${stamp}` });
gm.emit('event_lane:create', { name: PUB, visibility: 'all' });
gm.emit('event_lane:create', { name: SECRET, visibility: 'gm' });
gm.emit('event_lane:create', { name: OTHER, visibility: 'all' });
await sleep(500);
let g = await board('gm');
let a = await board(ana);
check('only the GM makes lanes', !lane(g, `Nope ${stamp}`));
check('the GM sees every lane; a Player only the Everyone ones', lane(g, SECRET) && lane(a, PUB) && !lane(a, SECRET) && lane(a, OTHER), JSON.stringify(a.lanes.map((l) => l.name)));
check('…and a live push carries only theirs too', pushed && !lane(pushed, SECRET) && lane(pushed, PUB));

console.log('\n--- notes ---');
const pub = lane(g, PUB).id;
const sec = lane(g, SECRET).id;
const oth = lane(g, OTHER).id;
pa.emit('event_note:create', { laneId: pub, text: 'Ana saw a ghost', color: 'pink' });
await sleep(200);
gm.emit('event_note:create', { laneId: pub, text: 'The mayor lies', color: 'nonsense' });
await sleep(200);
pa.emit('event_note:create', { laneId: sec, text: 'sneaky' });
gm.emit('event_note:create', { laneId: sec, text: 'The ghost is the mayor' });
await sleep(500);
a = await board(ana);
g = await board('gm');
const notes = lane(a, PUB).notes;
check('anyone writes into a lane they see, in order; a bad colour is yellow', notes.map((n) => n.text).join('|') === 'Ana saw a ghost|The mayor lies' && notes[0].color === 'pink' && notes[1].color === 'yellow', JSON.stringify(notes));
check('…marked with their author', notes[0].author === `EvAna${stamp}` && notes[1].author === 'GM');
check("a Player can't write into a GM-only lane", lane(g, SECRET).notes.map((n) => n.text).join('|') === 'The ghost is the mayor');
check('…and never receives its notes', !JSON.stringify(a).includes('The ghost is the mayor'));
const [anaNote, gmNote] = notes;
pb.emit('event_note:update', { noteId: anaNote.id, text: 'hacked' });
pa.emit('event_note:update', { noteId: gmNote.id, text: 'hacked' });
pb.emit('event_note:delete', { noteId: anaNote.id });
await sleep(400);
a = await board(ana);
check("only the author or the GM edits or deletes: Bo can't touch Ana's note, Ana can't touch the GM's", lane(a, PUB).notes.map((n) => n.text).join('|') === 'Ana saw a ghost|The mayor lies', JSON.stringify(lane(a, PUB).notes));
check('…which each sees as theirs or not', anaNote.mine === true && gmNote.mine === false);
pa.emit('event_note:update', { noteId: anaNote.id, text: 'Ana saw TWO ghosts', color: 'green' });
await sleep(300);
a = await board(ana);
check('the author edits her own (text and colour)', lane(a, PUB).notes[0].text === 'Ana saw TWO ghosts' && lane(a, PUB).notes[0].color === 'green');

console.log('\n--- moving ---');
pb.emit('event_note:move', { noteId: anaNote.id, laneId: pub, index: 1 });
await sleep(300);
a = await board(ana);
check('anyone who sees a note reorders it in its lane (Bo moves Ana’s)', lane(a, PUB).notes.map((n) => n.id).join() === `${gmNote.id},${anaNote.id}`);
pb.emit('event_note:move', { noteId: gmNote.id, laneId: oth, index: 0 });
await sleep(300);
a = await board(ana);
check('…or into another lane they see', lane(a, OTHER).notes.map((n) => n.id).join() === String(gmNote.id) && lane(a, PUB).notes.map((n) => n.id).join() === String(anaNote.id));
pb.emit('event_note:move', { noteId: anaNote.id, laneId: sec, index: 0 });
const secretNote = lane(g, SECRET).notes[0];
pb.emit('event_note:move', { noteId: secretNote.id, laneId: pub, index: 0 });
await sleep(400);
g = await board('gm');
check("a Player can't move a note into, or out of, a GM-only lane", lane(g, PUB).notes.map((n) => n.id).join() === String(anaNote.id) && lane(g, SECRET).notes.length === 1);

console.log('\n--- lanes again ---');
gm.emit('event_lane:update', { laneId: pub, name: `Gossip ${stamp}`, visibility: 'gm' });
await sleep(300);
a = await board(ana);
check('the GM renames a lane and hides it: it leaves the Players’ board', !a.lanes.some((l) => l.id === pub));
gm.emit('event_lane:update', { laneId: pub, visibility: 'all' });
gm.emit('event_lane:move', { laneId: oth, toIndex: 0 });
await sleep(300);
g = await board('gm');
const mine = g.lanes.filter((l) => [pub, sec, oth].includes(l.id)).map((l) => l.id);
check('…shows it again, and reorders lanes', mine[0] === oth && (await board(ana)).lanes.some((l) => l.id === pub), JSON.stringify(mine));
gm.emit('event_lane:delete', { laneId: pub });
await sleep(400);
g = await board('gm');
check('deleting a lane moves its notes to the first remaining lane of the same visibility', !g.lanes.some((l) => l.id === pub) && lane(g, OTHER).notes.map((n) => n.id).includes(anaNote.id), JSON.stringify(lane(g, OTHER)?.notes));

for (const id of [sec, oth]) gm.emit('event_lane:delete', { laneId: id });
await sleep(400);
for (const c of [ana, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
for (const s of [gm, pa, pb]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

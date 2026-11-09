// Playtest: play feedback 5 (vttprojectplan.md, "Play feedback 5") — the
// Action button's board (`board:current`), the resolve stack on
// `fight:resolving`, Mastermind Style (an ally performs the Action the
// Mastermind pays for), "no valid targets" (confirm before paying; No takes
// the Action off the board), and Taken Out at zero HP (no enemy can target).
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-batch5.mjs
import zlib from 'node:zlib';
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILURE(S)');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);
const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  await sleep(300);
  return s;
};
// A real 700×700 PNG: the map's bounds are the cells inside its 10% padding
// (70px grid: columns and rows 1-8).
function png(w, h) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3, 0x30);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}



const stamp = Date.now();
const gm = await connect({ role: 'gm' });
const cards = [];
gm.on('chat:card', (c) => cards.push(c));
const prompts = [];
let answerWith = () => undefined;
gm.on('trigger:prompt', (p) => {
  prompts.push(p);
  const pick = answerWith(p);
  const answer = pick !== undefined ? pick : p.kind === 'confirm' ? false : p.kind === 'targets' ? [p.options[0].id] : p.kind === 'square' && p.minimum === 0 ? [] : p.options?.[0]?.id;
  setTimeout(() => gm.emit('trigger:answer', { id: p.id, answer }), 120);
});
const resolving = [];
gm.on('fight:resolving', (e) => resolving.push(e));
gm.emit('scene:create', { name: `B5 ${stamp}` });
await sleep(300);
const scene = (await jf('/api/scenes?role=gm')).find((s) => s.name === `B5 ${stamp}`);
gm.emit('scene:activate', { sceneId: scene.id });
await sleep(300);
gm.emit('scene:set_mode', { mode: 'combat' });
gm.emit('scene:set_combat_image', { imageData: png(700, 700).toString('base64'), imageMimeType: 'image/png' });
await sleep(400);
const ana = await jpost('/api/characters', { name: `B5Ana${stamp}`, characterType: 'pc' });
const cy = await jpost('/api/characters', { name: `B5Cy${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `B5Bo${stamp}`, characterType: 'npc' });
const p = await connect({ role: 'player', characterId: cy.id });
// Ana is the Mastermind; Cy stands next to Bo, Ana far from him.
gm.emit('build:save', { characterId: ana.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.mastermind' }] } });
gm.emit('build:save', { characterId: cy.id, build: { type: 'hero-type.focused', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.warrior', stances: [{ formId: 'form.power', styleId: 'style.halcyon' }] } });
await sleep(400);
gm.emit('combat_token:place', { ownerType: 'character', ownerId: ana.id, col: 1, row: 1 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: cy.id, col: 4, row: 4 });
gm.emit('combat_token:place', { ownerType: 'character', ownerId: bo.id, col: 4, row: 3 });
await sleep(600);
let st = await jf('/api/stage?role=gm');
const tokOf = (id) => st.combatTokens.find((t) => t.character_id === id);
const [ta, tc, tb] = [tokOf(ana.id), tokOf(cy.id), tokOf(bo.id)];
gm.emit('fight:preset_weight', { mode: 'combat', weight: 'middle', fighters: [ta, tc, tb].map((t) => ({ ref: { combatantId: t.id }, level: 1 })) });
await sleep(300);
const stage = async () => (st = await jf('/api/stage?role=gm'));
const f = (id) => st.combatTokens.find((t) => t.id === id).fight;
const marks = async () => (await jf('/api/dice-marks')).marks;
const DAMAGE = 'action.system-basic-actions.damage';
const current = (s) => new Promise((r) => s.emit('board:current', { mode: 'combat' }, r));

console.log('\n--- the Action button and the resolve stack ---');
gm.emit('fight:start', { mode: 'combat', allies: [{ combatantId: ta.id }, { combatantId: tc.id }], enemies: [{ combatantId: tb.id }], firstSide: 'allies', opener: { combatantId: ta.id } });
await sleep(2500);
const cur = await current(gm);
const anaRoll = cards.filter((c) => c.kind === 'stance_roll').at(-1).payload.roll_id;
check('board:current gives the active fighter’s turn board', cur?.payload?.roll_id === anaRoll && cur.characterId === ana.id && cur.payload.combatant_id === ta.id && cur.payload.results.length > 0, JSON.stringify(cur));
check('the turn’s start showed in the resolve stack', resolving.some((e) => e.busy && e.steps?.some((s) => s.label === 'Start of turn')), JSON.stringify(resolving.slice(0, 4)));
check('…and the plaque is told when it is all done', resolving.at(-1)?.busy === false);

console.log('\n--- Mastermind Style: an ally performs it ---');
await stage();
const boHp = f(tb.id).hp.current;
resolving.length = 0;
prompts.length = 0;
gm.emit('board:place', { rollId: anaRoll, die: 0, actionId: DAMAGE });
await sleep(400);
for (const x of (await marks())[anaRoll].placements) if (x.threshold > 1) gm.emit('board:stop', { rollId: anaRoll, key: x.key, stop: 1 });
await sleep(300);
gm.emit('board:commit', { rollId: anaRoll });
await sleep(3000);
await stage();
check('Ana (far away) pays; Cy, next to Bo, performs it: Bo is hit', f(tb.id).hp.current < boHp, `${boHp} → ${f(tb.id).hp.current}`);
check('…said in a notice', cards.some((c) => c.kind === 'reminder' && c.payload.title === 'Mastermind Style' && /performs Damage for/.test(c.payload.text)), JSON.stringify(cards.slice(-4).map((c) => c.payload.title)));
check('one ally, one enemy: nobody was asked who (only "you may Move 1" after)', !prompts.some((q) => q.kind === 'targets'), JSON.stringify(prompts.map((q) => [q.kind, q.title])));
check('after the ally’s Action the Mastermind may Move 1', prompts.some((q) => q.kind === 'square' && /Mastermind Style \(Move 1\)/.test(q.title)), JSON.stringify(prompts.map((q) => [q.kind, q.title])));
const withAction = resolving.find((e) => e.steps?.some((s) => s.label === 'Damage'));
check('the Action is a step of the stack, then done', Boolean(withAction) && resolving.some((e) => e.steps?.some((s) => s.label === 'Damage' && s.state === 'done')), JSON.stringify(resolving.map((e) => e.steps)));
check('a trigger that arises joins the stack (the total grows)', resolving.some((e) => (e.steps?.length ?? 0) >= 2 && e.steps.some((s) => /Mastermind Style/.test(s.label))), JSON.stringify(resolving.map((e) => e.steps?.map((s) => s.label))));

console.log('\n--- Taken Out: no enemy can target them; "no valid targets" ---');
await stage();
gm.emit('fighter:hp', { ref: { combatantId: tb.id }, delta: -f(tb.id).hp.current });
await sleep(500);
await stage();
check('Bo is Taken Out at zero HP', f(tb.id).hp.current === 0);
prompts.length = 0;
gm.emit('board:place', { rollId: anaRoll, die: 1, actionId: DAMAGE });
await sleep(400);
gm.emit('board:commit', { rollId: anaRoll });
await sleep(2000);
const warn = prompts.find((q) => q.kind === 'confirm' && /no valid targets/.test(q.title));
check('with Bo Taken Out, Damage has nobody to target: a confirmation before anything is paid', Boolean(warn), JSON.stringify(prompts.map((q) => [q.kind, q.title])));
let board = (await marks())[anaRoll];
check('No: the Action comes off the board, its die free again', !board.placements.some((x) => x.die === 1) && board.committing !== true, JSON.stringify(board.placements));
answerWith = (q) => (q.kind === 'confirm' && /no valid targets/.test(q.title) ? true : undefined);
gm.emit('board:place', { rollId: anaRoll, die: 1, actionId: DAMAGE });
await sleep(400);
gm.emit('board:commit', { rollId: anaRoll });
await sleep(2500);
board = (await marks())[anaRoll];
await stage();
check('Yes: it is performed anyway (committed) and nobody is hurt', board.placements.some((x) => x.die === 1 && x.committed) && f(tb.id).hp.current === 0, JSON.stringify(board.placements));
answerWith = () => undefined;

console.log('\n--- the next round repeats the order ---');
const order1 = st.fights.combat.order;
for (let i = 0; i < 6 && st.fights.combat.round === 1; i++) {
  gm.emit('fight:next', { mode: 'combat' });
  await sleep(1500);
  gm.emit('move:skip', { mode: 'combat' });
  await sleep(500);
  await stage();
}
check('round 2 has round 1’s order', st.fights.combat.round === 2 && JSON.stringify(st.fights.combat.order) === JSON.stringify(order1), JSON.stringify([order1, st.fights.combat.order]));

gm.emit('fight:end', { mode: 'combat' });
await sleep(300);
gm.emit('scene:delete', { sceneId: scene.id });
for (const c of [ana, cy, bo]) await fetch(`${BASE}/api/characters/${c.id}`, { method: 'DELETE' });
gm.close();
p.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

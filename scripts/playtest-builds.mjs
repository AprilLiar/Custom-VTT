// Playtest: character builds (builder phase 1) — saved by whoever controls
// the character, cleaned against the rules content on the server, broadcast,
// cleared, and deleted with the character.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-builds.mjs
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
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) =>
    r.json()
  );
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


const stamp = Date.now();
const gm = await connect({ role: 'gm' });
const mira = await jpost('/api/characters', { name: `BMira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `BBo${stamp}`, characterType: 'pc' });
const p = await connect({ role: 'player', characterId: mira.id });
const other = await connect({ role: 'player', characterId: bo.id });
const buildOf = async (c) => (await jf(`/api/characters/${c.id}/build`)).build;
const heard = [];
gm.on('build:updated', (e) => heard.push(e));

check('a new character has no build', (await buildOf(mira)) === null);
const draft = {
  type: 'hero-type.focused',
  archetypes: [{ id: 'archetype.angel', variant: 'focused' }, 'archetype.fake'],
  stances: [{ formId: 'form.blaster', styleId: 'style.halcyon', alias: 'Star' }],
  buildId: 'build.tough',
  level: 42,
  skills: { custom: 'Stern Guardian' },
};
p.emit('build:save', { characterId: mira.id, build: draft });
other.emit('build:save', { characterId: mira.id, build: { ...draft, buildId: 'build.agile' } });
await sleep(500);
const b = await buildOf(mira);
check('the player saves their own build, cleaned on the server (bad ids dropped, level clamped)',
  b?.buildId === 'build.tough' && b.archetypes.length === 1 && b.level === 10 && b.stances[0].alias === 'Star', JSON.stringify(b));
check('...another player cannot overwrite it', b?.buildId === 'build.tough');
check('everyone hears the update', heard.some((e) => e.characterId === mira.id && e.build?.buildId === 'build.tough'));
gm.emit('build:save', { characterId: bo.id, build: { type: 'character-type.boss', healthBars: 4 } });
await sleep(400);
check('the GM builds anyone, any type (a PC as a Boss)', (await buildOf(bo))?.type === 'character-type.boss' && (await buildOf(bo)).healthBars === 4);
p.emit('build:clear', { characterId: mira.id });
await sleep(400);
check('a build can be cleared', (await buildOf(mira)) === null);
await fetch(`${BASE}/api/characters/${bo.id}`, { method: 'DELETE' });
await sleep(300);
check("a deleted character's build goes with them", (await jf(`/api/characters/${bo.id}/build`)).build === null);

await fetch(`${BASE}/api/characters/${mira.id}`, { method: 'DELETE' });
gm.close();
p.close();
other.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

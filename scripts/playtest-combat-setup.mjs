// Playtest: the Combat tab after the builder's phase 0 purge — only the
// combat token picture is left (saved, broadcast as a URL, cropped, removed).
// Unique picks, Stances, Reminders and Armor sources can no longer be set,
// and a deleted character's Combat setup goes with them.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-combat-setup.mjs
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
const setup = (type, id) => jf(`/api/combat-setup?ownerType=${type}&ownerId=${id}`);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const stamp = Date.now();
const mira = await jpost('/api/characters', { name: `CombatMira${stamp}`, characterType: 'pc' });
const bo = await jpost('/api/characters', { name: `CombatBo${stamp}`, characterType: 'pc' });
const gm = await connect({ role: 'gm' });
const miraSock = await connect({ role: 'player', characterId: mira.id });

console.log('\n--- an empty Combat tab ---');
let s = await setup('character', mira.id);
check('a fighter with nothing saved reads as empty', s.profile.image_url === null && s.profile.unique_tokens.length === 0 && s.reminders.length === 0 && s.stances.length === 0, JSON.stringify(s));
const bad = await fetch(`${BASE}/api/combat-setup?ownerType=dragon&ownerId=1`);
check('an impossible owner is a 400', bad.status === 400, String(bad.status));

console.log('\n--- the purged parts ---');
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, uniqueTokens: ['chaos'], armorSources: ['always'] });
miraSock.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'Calm', dice: [{ die: 6 }] });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'self', timing: 'start', text: 'x' });
gm.emit('combat_stance:create', { ownerType: 'character', ownerId: bo.id, name: 'Calm', dice: [{ die: 6 }] });
await sleep(500);
s = await setup('character', mira.id);
check('Unique picks, Armor sources, Stances and Reminders can no longer be set — by anyone',
  s.profile.unique_tokens.length === 0 && s.profile.armor_sources.length === 0 && s.stances.length === 0 && s.reminders.length === 0 &&
    (await setup('character', bo.id)).stances.length === 0, JSON.stringify(s));

console.log('\n--- the token picture ---');
const updated = new Promise((r) => gm.once('combat_profile:updated', r));
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, imageData: PNG, imageMimeType: 'image/png', cropX: 0.1, cropY: 0.1, cropW: 0.5, cropH: 0.5 });
const ev = await updated;
check('saving a picture broadcasts the profile with a URL and no bytes',
  Boolean(ev.profile.image_url) && !JSON.stringify(ev).includes(PNG.slice(0, 20)), JSON.stringify(ev));
check('...and the crop', ev.profile.crop_w === 0.5, JSON.stringify(ev.profile));
const pic = await fetch(BASE + ev.profile.image_url);
check('the URL serves the picture', pic.ok && pic.headers.get('content-type') === 'image/png', `${pic.status} ${pic.headers.get('content-type')}`);
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: bo.id, imageData: PNG, imageMimeType: 'image/png' });
await sleep(300);
check("a player can't set someone else's picture", (await setup('character', bo.id)).profile.image_url === null);
const all = await jf('/api/combat-profiles');
check('every profile is listed by fighter key', all[`character:${mira.id}`]?.image_url === ev.profile.image_url, JSON.stringify(Object.keys(all)));
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, clearImage: true });
await sleep(300);
check('the picture can be removed', (await setup('character', mira.id)).profile.image_url === null);

console.log('\n--- deletes ---');
gm.emit('combat_profile:update', { ownerType: 'character', ownerId: bo.id, imageData: PNG, imageMimeType: 'image/png' });
await sleep(300);
await fetch(`${BASE}/api/characters/${bo.id}`, { method: 'DELETE' });
await sleep(300);
check("a deleted character's profile is gone with them", !(`character:${bo.id}` in (await jf('/api/combat-profiles'))));
await fetch(`${BASE}/api/characters/${mira.id}`, { method: 'DELETE' });

gm.close();
miraSock.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

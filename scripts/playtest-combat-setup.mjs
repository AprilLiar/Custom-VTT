// Playtest: the Combat tab (Panic at the Dojo, Phase 1) through the real
// handlers — token picture, Unique token picks, Reminders, permissions, and
// the delete cascade.
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
gm.emit('temp_npc:create', { name: `Goon${stamp}` });
await sleep(300);
const goon = (await jf('/api/temp-npcs')).find((n) => n.name === `Goon${stamp}`);
const thug = await jpost('/api/characters', { name: `CombatThug${stamp}`, characterType: 'npc' });

console.log('\n--- an empty Combat tab ---');
let s = await setup('character', mira.id);
check('a fighter with nothing saved reads as empty', s.profile.image_url === null && s.profile.unique_tokens.length === 0 && s.reminders.length === 0, JSON.stringify(s));
const bad = await fetch(`${BASE}/api/combat-setup?ownerType=dragon&ownerId=1`);
check('an impossible owner is a 400', bad.status === 400, String(bad.status));

console.log('\n--- Unique tokens ---');
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, uniqueTokens: ['training', 'chaos', 'nonsense', 'chaos', 42] });
await sleep(300);
s = await setup('character', mira.id);
check('a player saves their own picks — unknown keys and duplicates dropped, catalog order kept',
  JSON.stringify(s.profile.unique_tokens) === JSON.stringify(['chaos', 'training']), JSON.stringify(s.profile.unique_tokens));
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: bo.id, uniqueTokens: ['luck'] });
await sleep(300);
check("...but not someone else's", (await setup('character', bo.id)).profile.unique_tokens.length === 0);
gm.emit('combat_profile:update', { ownerType: 'temp_npc', ownerId: goon.id, uniqueTokens: ['luck'] });
gm.emit('combat_stance:create', { ownerType: 'temp_npc', ownerId: goon.id, name: 'Brawl', dice: [{ die: 4 }] });
await sleep(300);
check('a Temp NPC has no Combat setup, not even from the GM (no Temp NPCs in combat)',
  (await setup('temp_npc', goon.id)).profile.unique_tokens.length === 0 && (await setup('temp_npc', goon.id)).stances.length === 0);
gm.emit('combat_profile:update', { ownerType: 'character', ownerId: thug.id, uniqueTokens: ['luck'] });
await sleep(300);
check('...while the GM sets up an NPC', JSON.stringify((await setup('character', thug.id)).profile.unique_tokens) === '["luck"]');

console.log('\n--- the token picture ---');
const updated = new Promise((r) => gm.once('combat_profile:updated', r));
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, imageData: PNG, imageMimeType: 'image/png', cropX: 0.1, cropY: 0.1, cropW: 0.5, cropH: 0.5 });
const ev = await updated;
check('saving a picture broadcasts the profile with a URL and no bytes',
  Boolean(ev.profile.image_url) && !JSON.stringify(ev).includes(PNG.slice(0, 20)), JSON.stringify(ev));
check('...keeping the picks it already had', JSON.stringify(ev.profile.unique_tokens) === '["chaos","training"]');
check('...and the crop', ev.profile.crop_w === 0.5, JSON.stringify(ev.profile));
const pic = await fetch(BASE + ev.profile.image_url);
check('the URL serves the picture', pic.ok && pic.headers.get('content-type') === 'image/png', `${pic.status} ${pic.headers.get('content-type')}`);
const all = await jf('/api/combat-profiles');
check('every profile is listed by fighter key', all[`character:${mira.id}`]?.image_url === ev.profile.image_url && Boolean(all[`character:${thug.id}`]) && !all[`temp_npc:${goon.id}`], JSON.stringify(Object.keys(all)));
miraSock.emit('combat_profile:update', { ownerType: 'character', ownerId: mira.id, clearImage: true });
await sleep(300);
check('the picture can be removed', (await setup('character', mira.id)).profile.image_url === null);

console.log('\n--- Reminders ---');
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'self', timing: 'start', text: '  Pick a stance  ' });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'round', timing: 'end', text: 'Super Move is back' });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'others', timing: 'end', target: 'enemies', text: 'Reactive Chaos?' });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'others', timing: 'start', target: 'one', targetType: 'character', targetId: thug.id, text: 'Watch the goon' });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'others', timing: 'start', target: 'one', targetType: 'temp_npc', targetId: goon.id, text: 'Temp target' });
await sleep(500);
s = await setup('character', mira.id);
check('one reminder per column saved, text trimmed', s.reminders.length === 4 && s.reminders[0].text === 'Pick a stance', JSON.stringify(s.reminders));
const named = s.reminders.find((r) => r.target === 'one');
check('an Others reminder can name one fighter (a character — a Temp NPC is refused)', named?.target_type === 'character' && named?.target_id === thug.id && !s.reminders.some((r) => r.text === 'Temp target'), JSON.stringify(named));
check("a non-Others reminder never carries a target", s.reminders.find((r) => r.scope === 'round').target === 'any');
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'sometimes', timing: 'start', text: 'x' });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'self', timing: 'start', text: '   ' });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'others', timing: 'start', target: 'one', targetType: 'character', targetId: 999999, text: 'ghost' });
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: bo.id, scope: 'self', timing: 'start', text: 'not yours' });
await sleep(500);
check('bad scope, empty text, a missing target and someone else\'s sheet are all refused',
  (await setup('character', mira.id)).reminders.length === 4 && (await setup('character', bo.id)).reminders.length === 0);
const first = s.reminders[0];
miraSock.emit('combat_reminder:update', { reminderId: first.id, timing: 'end', text: 'Pick a stance!' });
await sleep(300);
let r0 = (await setup('character', mira.id)).reminders.find((r) => r.id === first.id);
check('a reminder can be edited', r0.timing === 'end' && r0.text === 'Pick a stance!' && r0.scope === 'self', JSON.stringify(r0));
const bob = await connect({ role: 'player', characterId: bo.id });
bob.emit('combat_reminder:delete', { reminderId: first.id });
await sleep(300);
check("another player cannot delete it", (await setup('character', mira.id)).reminders.some((r) => r.id === first.id));

console.log('\n--- Stances ---');
miraSock.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: ' Iron Wall ', dice: [{ die: 10 }, { die: 6 }, { fixed: 5 }] });
miraSock.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'Bad', dice: [{ die: 20 }] });
miraSock.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'TooMany', dice: Array.from({ length: 9 }, () => ({ die: 4 })) });
miraSock.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: '', dice: [{ die: 4 }] });
miraSock.emit('combat_stance:create', { ownerType: 'character', ownerId: bo.id, name: 'Not yours', dice: [{ die: 4 }] });
await sleep(500);
s = await setup('character', mira.id);
check('a valid stance saves (name trimmed); a d20, nine dice, a blank name and someone else\'s sheet are refused',
  s.stances.length === 1 && s.stances[0].name === 'Iron Wall' && JSON.stringify(s.stances[0].dice) === JSON.stringify([{ die: 10 }, { die: 6 }, { fixed: 5 }]) && (await setup('character', bo.id)).stances.length === 0,
  JSON.stringify(s.stances));
const wall = s.stances[0];
miraSock.emit('combat_stance:update', { stanceId: wall.id, dice: [{ fixed: 0 }, { fixed: 12 }] });
await sleep(300);
check('a stance\'s dice can be edited, fixed numbers 0 and 12 allowed', JSON.stringify((await setup('character', mira.id)).stances[0].dice) === '[{"fixed":0},{"fixed":12}]');
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'self', timing: 'start', text: 'Wall up', stanceId: wall.id });
await sleep(300);
let bound = (await setup('character', mira.id)).reminders.find((r) => r.text === 'Wall up');
check('a reminder can be bound to the owner\'s stance', bound?.stance_id === wall.id, JSON.stringify(bound));
miraSock.emit('combat_reminder:create', { ownerType: 'character', ownerId: mira.id, scope: 'self', timing: 'start', text: 'Foreign', stanceId: 999999 });
await sleep(300);
check('...but not to a stance that is not theirs', !(await setup('character', mira.id)).reminders.some((r) => r.text === 'Foreign'));
miraSock.emit('combat_stance:delete', { stanceId: wall.id });
await sleep(400);
s = await setup('character', mira.id);
bound = s.reminders.find((r) => r.text === 'Wall up');
check('deleting a stance unbinds its reminders, keeping their text', s.stances.length === 0 && bound?.stance_id === null, JSON.stringify(bound));
miraSock.emit('combat_stance:create', { ownerType: 'character', ownerId: mira.id, name: 'Keep', dice: [{ die: 8 }] });
await sleep(300);

console.log('\n--- deletes ---');
await fetch(`${BASE}/api/characters/${thug.id}`, { method: 'DELETE' });
gm.emit('temp_npc:delete', { tempNpcId: goon.id });
await sleep(400);
const after = (await setup('character', mira.id)).reminders.find((r) => r.text === 'Watch the goon');
check("a reminder naming a deleted fighter falls back to Anyone, text kept", after?.target === 'any' && after?.target_id === null, JSON.stringify(after));
check("the deleted NPC's own profile is gone", !(`character:${thug.id}` in (await jf('/api/combat-profiles'))));
await fetch(`${BASE}/api/characters/${mira.id}`, { method: 'DELETE' });
await fetch(`${BASE}/api/characters/${bo.id}`, { method: 'DELETE' });
s = await setup('character', mira.id);
check("a deleted character's Combat tab is gone with them", s.reminders.length === 0 && s.stances.length === 0 && s.profile.unique_tokens.length === 0, JSON.stringify(s));

gm.close();
miraSock.close();
bob.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

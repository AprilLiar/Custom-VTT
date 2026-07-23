// Integration test: start the server against a FRESH local.db (rm local.db && npm start),
// then run `node scripts/e2e.mjs`. Asserts absolute chat counts, so a used DB will fail it.
// Phase 1 end-to-end verification against a running server (fresh local.db).
// Exercises: character CRUD + dice seeding, rolls (die/pool), stepping through
// the full ladder, lock/revert, stamina regen/adjust, inventory, injuries,
// chat history, delete cascade — with a second socket verifying broadcasts.
import { io } from 'socket.io-client';

const URL = 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const jf = (url, opts) => fetch(URL + url, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const jpost = (url, body, method = 'POST') =>
  jf(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Watcher socket: records every broadcast, so we can assert the "other device" view.
const watcher = io(URL);
const actor = io(URL);
const events = [];
for (const ev of ['character:created', 'character:updated', 'character:deleted', 'die:updated', 'roll:result', 'inventory:updated', 'injuries:updated']) {
  watcher.on(ev, (payload) => events.push({ ev, payload }));
}
const waitEvent = (ev, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const existing = events.find((e) => e.ev === ev && pred(e.payload));
    if (existing) return resolve(existing.payload);
    const timer = setTimeout(() => { watcher.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
    const h = (payload) => { if (pred(payload)) { clearTimeout(timer); watcher.off(ev, h); resolve(payload); } };
    watcher.on(ev, h);
  });
const emit = (ev, payload) => actor.emit(ev, payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => watcher.on('connect', r));
await new Promise((r) => actor.on('connect', r));

// --- character creation ---
const created = await jpost('/api/characters', { name: 'Aaron', characterType: 'pc' });
check('create character returns 201', created.status === 201);
const ch = created.body;
check('new character stamina 32/32', ch.max_stamina === 32 && ch.current_stamina === 32, JSON.stringify(ch));
await waitEvent('character:created', (c) => c.id === ch.id);
check('character:created broadcast', true);

const npc = (await jpost('/api/characters', { name: 'Goon', characterType: 'npc' })).body;
check('npc type stored', npc.character_type === 'npc');

const full = (await jf(`/api/characters/${ch.id}`)).body;
check('8 dice auto-seeded', full.dice.length === 8, `got ${full.dice.length}`);
check('dice pools 2/4/2', ['head', 'core', 'legs'].map((p) => full.dice.filter((d) => d.pool === p).length).join() === '2,4,2');
check('all dice default d8 active', full.dice.every((d) => d.current_size === 8 && d.bonus === 0 && d.status === 'active' && d.locked_size === 8));

const skull = full.dice.find((d) => d.slot_name === 'Skull');
const stamina = full.dice.find((d) => d.slot_name === 'Stamina');

// --- die roll with modifier ---
events.length = 0;
emit('die:roll', { characterId: ch.id, dieId: skull.id, modifier: 3 });
let roll = await waitEvent('roll:result');
check('die roll broadcast to other client', roll.characterName === 'Aaron' && roll.dice.length === 1);
check('die roll result in [4,11] (d8+3)', roll.dice[0].result >= 4 && roll.dice[0].result <= 11, JSON.stringify(roll));
check('roll payload has total/timestamp', roll.total === roll.dice[0].result && !!roll.timestamp);

// --- modifier clamping ---
events.length = 0;
emit('die:roll', { characterId: ch.id, dieId: skull.id, modifier: 500 });
roll = await waitEvent('roll:result');
check('modifier clamped to +20', roll.modifier === 20, `got ${roll.modifier}`);

// --- pool roll ---
events.length = 0;
emit('pool:roll', { characterId: ch.id, pool: 'core', modifier: -2 });
roll = await waitEvent('roll:result');
check('pool roll rolls all 4 core dice', roll.dice.length === 4, JSON.stringify(roll.dice));
check('pool total = sum of results', roll.total === roll.dice.reduce((s, d) => s + d.result, 0));

// --- stepping: d8 -> d10 -> d12 -> d12+1 -> d12+2 ---
for (let i = 0; i < 4; i++) { events.length = 0; emit('die:step', { dieId: skull.id, direction: 'up' }); await waitEvent('die:updated', (d) => d.dieId === skull.id); }
let dieState = (await jf(`/api/characters/${ch.id}`)).body.dice.find((d) => d.id === skull.id);
check('4 steps up from d8 = d12+2', dieState.current_size === 12 && dieState.bonus === 2, JSON.stringify(dieState));

// --- step down unwinds bonus first ---
events.length = 0; emit('die:step', { dieId: skull.id, direction: 'down' });
let upd = await waitEvent('die:updated', (d) => d.dieId === skull.id);
check('step down d12+2 -> d12+1', upd.current_size === 12 && upd.bonus === 1);

// --- lock stats: stamina die stepped up first, then lock recomputes max ---
emit('die:step', { dieId: stamina.id, direction: 'up' }); // d8 -> d10
await waitEvent('die:updated', (d) => d.dieId === stamina.id && d.current_size === 10);
events.length = 0;
emit('character:lock_stats', { characterId: ch.id });
const lockedChar = await waitEvent('character:updated', (c) => c.id === ch.id);
check('lock recomputes max stamina 4x10=40', lockedChar.max_stamina === 40, JSON.stringify(lockedChar));
check('current stamina unchanged at 32 (below new max)', lockedChar.current_stamina === 32);
await waitEvent('die:updated', (d) => d.dieId === stamina.id && d.locked_size === 10);
check('die:updated carries locked values', true);

// --- tint data check: step stamina down, current 8 < locked 10 ---
emit('die:step', { dieId: stamina.id, direction: 'down' });
await waitEvent('die:updated', (d) => d.dieId === stamina.id && d.current_size === 8 && d.locked_size === 10);
check('current diverges below locked (red tint data)', true);

// --- revert stats ---
events.length = 0;
emit('character:revert_stats', { characterId: ch.id });
await waitEvent('die:updated', (d) => d.dieId === stamina.id && d.current_size === 10);
check('revert restores stamina die to locked d10', true);

// --- stamina adjust + clamping ---
events.length = 0;
emit('stamina:adjust', { characterId: ch.id, delta: -10 });
let chUpd = await waitEvent('character:updated', (c) => c.id === ch.id);
check('stamina adjust -10 => 22', chUpd.current_stamina === 22, `got ${chUpd.current_stamina}`);
events.length = 0;
emit('stamina:adjust', { characterId: ch.id, delta: -100 });
chUpd = await waitEvent('character:updated', (c) => c.id === ch.id);
check('stamina clamped at 0', chUpd.current_stamina === 0);

// --- stamina regen: rolls d10, adds to current ---
events.length = 0;
emit('stamina:regen', { characterId: ch.id });
chUpd = await waitEvent('character:updated', (c) => c.id === ch.id);
roll = await waitEvent('roll:result', (r) => r.dice[0]?.slot_name === 'Stamina');
check('regen rolled stamina die (1-10)', roll.dice[0].result >= 1 && roll.dice[0].result <= 10);
check('regen added roll to current', chUpd.current_stamina === roll.dice[0].result, `${chUpd.current_stamina} vs ${roll.dice[0].result}`);

// --- incapacitation: step a d8 die down 3x (d6, d4, incapacitated) ---
const leftLeg = full.dice.find((d) => d.slot_name === 'Left Leg');
for (const _ of [1, 2, 3]) { events.length = 0; emit('die:step', { dieId: leftLeg.id, direction: 'down' }); await waitEvent('die:updated', (d) => d.dieId === leftLeg.id); }
dieState = (await jf(`/api/characters/${ch.id}`)).body.dice.find((d) => d.id === leftLeg.id);
check('3 steps down from d8 = incapacitated', dieState.status === 'incapacitated');

// --- incapacitated die refuses to roll ---
events.length = 0;
emit('die:roll', { characterId: ch.id, dieId: leftLeg.id, modifier: 0 });
await sleep(400);
check('incapacitated die does not roll', !events.some((e) => e.ev === 'roll:result'));

// --- revive ---
events.length = 0;
emit('die:step', { dieId: leftLeg.id, direction: 'up' });
upd = await waitEvent('die:updated', (d) => d.dieId === leftLeg.id);
check('revive to fresh d4', upd.current_size === 4 && upd.bonus === 0 && upd.status === 'active');

// --- inventory ---
events.length = 0;
emit('inventory:add', { characterId: ch.id, itemName: 'Brass Knuckles' });
let inv = await waitEvent('inventory:updated', (p) => p.characterId === ch.id);
check('inventory add broadcast with items', inv.items.length === 1 && inv.items[0].item_name === 'Brass Knuckles');
events.length = 0;
emit('inventory:remove', { itemId: inv.items[0].id });
inv = await waitEvent('inventory:updated', (p) => p.characterId === ch.id);
check('inventory remove', inv.items.length === 0);

// --- injuries ---
events.length = 0;
emit('injury:add', { characterId: ch.id, name: 'Cracked Rib', effect: 'breathing hurts' });
let inj = await waitEvent('injuries:updated', (p) => p.characterId === ch.id);
check('injury add', inj.injuries.length === 1 && inj.injuries[0].effect === 'breathing hurts');
events.length = 0;
emit('injury:update', { injuryId: inj.injuries[0].id, name: 'Cracked Rib', effect: 'no pool rolls on Core' });
inj = await waitEvent('injuries:updated', (p) => p.characterId === ch.id);
check('injury update', inj.injuries[0].effect === 'no pool rolls on Core');
events.length = 0;
emit('injury:remove', { injuryId: inj.injuries[0].id });
inj = await waitEvent('injuries:updated', (p) => p.characterId === ch.id);
check('injury remove', inj.injuries.length === 0);

// --- chat history ---
const chat = (await jf('/api/chat')).body;
check('chat history has all rolls (4)', chat.length === 4, `got ${chat.length}`);
check('chat entries carry name + dice + total', chat.every((e) => e.characterName && Array.isArray(e.dice) && typeof e.total === 'number' && e.timestamp));

// --- name + portrait update ---
events.length = 0;
const renamed = await jpost(`/api/characters/${ch.id}`, { name: 'Aaron the Fist', imageData: 'aGVsbG8=', imageMimeType: 'image/jpeg' }, 'PUT');
check('rename + portrait via PUT', renamed.body.name === 'Aaron the Fist' && renamed.body.image_data === 'aGVsbG8=');
await waitEvent('character:updated', (c) => c.id === ch.id && c.name === 'Aaron the Fist');
check('character:updated broadcast on rename', true);

// --- delete cascades, chat survives ---
events.length = 0;
await jf(`/api/characters/${ch.id}`, { method: 'DELETE' });
await waitEvent('character:deleted', (p) => p.id === ch.id);
check('character:deleted broadcast', true);
check('sheet fetch now 404', (await jf(`/api/characters/${ch.id}`)).status === 404);
const chatAfter = (await jf('/api/chat')).body;
check('chat log survives character deletion', chatAfter.length === 4 && chatAfter[0].characterName === '(deleted)');

await jf(`/api/characters/${npc.id}`, { method: 'DELETE' });

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
watcher.close(); actor.close();
process.exit(failures === 0 ? 0 : 1);

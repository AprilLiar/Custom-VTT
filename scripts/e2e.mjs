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
for (const ev of ['character:created', 'character:updated', 'character:deleted', 'die:updated', 'roll:result', 'inventory:updated', 'injuries:updated', 'stance:created', 'stance:updated', 'stance:deleted', 'stance:activated']) {
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

// --- pool roll: any selection of dice, across body sections ---
const body = full.dice.find((d) => d.slot_name === 'Body');
const rightLeg = full.dice.find((d) => d.slot_name === 'Right Leg');
events.length = 0;
emit('pool:roll', { characterId: ch.id, dieIds: [skull.id, body.id, rightLeg.id], modifier: -2 });
roll = await waitEvent('roll:result');
check('pool roll rolls the 3 selected dice (cross-section)', roll.dice.length === 3, JSON.stringify(roll.dice));
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

// --- pool roll silently drops incapacitated dice from the selection ---
events.length = 0;
emit('pool:roll', { characterId: ch.id, dieIds: [skull.id, leftLeg.id], modifier: 0 });
roll = await waitEvent('roll:result');
check('pool roll filters incapacitated dice', roll.dice.length === 1 && roll.dice[0].slot_name === 'Skull');

// --- revive ---
events.length = 0;
emit('die:step', { dieId: leftLeg.id, direction: 'up' });
upd = await waitEvent('die:updated', (d) => d.dieId === leftLeg.id);
check('revive to fresh d4', upd.current_size === 4 && upd.bonus === 0 && upd.status === 'active');

// --- inventory (name + optional description, editable) ---
events.length = 0;
emit('inventory:add', { characterId: ch.id, itemName: 'Brass Knuckles', description: 'worn but solid' });
let inv = await waitEvent('inventory:updated', (p) => p.characterId === ch.id);
check('inventory add with description', inv.items.length === 1 && inv.items[0].item_name === 'Brass Knuckles' && inv.items[0].description === 'worn but solid');
events.length = 0;
emit('inventory:add', { characterId: ch.id, itemName: 'Rope' });
inv = await waitEvent('inventory:updated', (p) => p.characterId === ch.id && p.items.length === 2);
check('inventory add without description defaults empty', inv.items[1].description === '');
events.length = 0;
emit('inventory:update', { itemId: inv.items[1].id, itemName: 'Long Rope', description: '15 meters' });
inv = await waitEvent('inventory:updated', (p) => p.characterId === ch.id);
check('inventory item editable (name + description)', inv.items[1].item_name === 'Long Rope' && inv.items[1].description === '15 meters');
events.length = 0;
emit('inventory:remove', { itemId: inv.items[0].id });
inv = await waitEvent('inventory:updated', (p) => p.characterId === ch.id && p.items.length === 1);
emit('inventory:remove', { itemId: inv.items[0].id });
inv = await waitEvent('inventory:updated', (p) => p.characterId === ch.id && p.items.length === 0);
check('inventory remove', inv.items.length === 0);

// --- ruleset: 7 styles, complete tournament, +2 edges ---
const ruleset = (await jf('/api/ruleset')).body;
check('7 attributes seeded with icons', ruleset.attributes.length === 7 && ruleset.attributes.every((a) => a.icon));
check('21 counter edges at +2', ruleset.counters.length === 21 && ruleset.counters.every((c) => c.bonus === 2));
const outDegree = new Map();
const inDegree = new Map();
for (const c of ruleset.counters) {
  outDegree.set(c.attacker_attribute_id, (outDegree.get(c.attacker_attribute_id) ?? 0) + 1);
  inDegree.set(c.defender_attribute_id, (inDegree.get(c.defender_attribute_id) ?? 0) + 1);
}
check('every style defeats exactly 3 and is defeated by 3', ruleset.attributes.every((a) => outDegree.get(a.id) === 3 && inDegree.get(a.id) === 3));
const attrIdByName = new Map(ruleset.attributes.map((a) => [a.name, a.id]));

// --- stances ---
events.length = 0;
emit('stance:create', { characterId: ch.id, name: 'Blitz', attributeAId: attrIdByName.get('Speed'), attributeBId: attrIdByName.get('Power') });
const stanceA = await waitEvent('stance:created', (s) => s.character_id === ch.id);
check('stance created', stanceA.name === 'Blitz');
const firstActivation = await waitEvent('stance:activated', (p) => p.characterId === ch.id);
check('first stance auto-activates', firstActivation.stanceId === stanceA.id);

events.length = 0;
emit('stance:create', { characterId: ch.id, name: 'Fortress', attributeAId: attrIdByName.get('Defensive'), attributeBId: attrIdByName.get('Keep-out') });
const stanceB = await waitEvent('stance:created', (s) => s.character_id === ch.id);
await sleep(300);
check('second stance does not steal active', !events.some((e) => e.ev === 'stance:activated'));

let sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('sheet includes stances, active is first', sheet.stances.length === 2 && sheet.character.active_stance_id === stanceA.id);

events.length = 0;
emit('stance:create', { characterId: ch.id, name: 'Broken', attributeAId: attrIdByName.get('Speed'), attributeBId: attrIdByName.get('Speed') });
await sleep(300);
check('duplicate-attribute stance rejected', !events.some((e) => e.ev === 'stance:created'));

events.length = 0;
emit('stance:activate', { characterId: ch.id, stanceId: stanceB.id });
const switched = await waitEvent('stance:activated', (p) => p.characterId === ch.id);
check('activate switches stance', switched.stanceId === stanceB.id);

events.length = 0;
emit('stance:update', { stanceId: stanceB.id, name: 'Iron Fortress', attributeAId: attrIdByName.get('Defensive'), attributeBId: attrIdByName.get('Close-Quarters') });
const updatedStance = await waitEvent('stance:updated', (s) => s.id === stanceB.id);
check('stance update', updatedStance.name === 'Iron Fortress' && updatedStance.attribute_b_id === attrIdByName.get('Close-Quarters'));

// deleting the ACTIVE stance hands active to the survivor
events.length = 0;
emit('stance:delete', { stanceId: stanceB.id });
const reActivated = await waitEvent('stance:activated', (p) => p.characterId === ch.id);
await waitEvent('stance:deleted', (p) => p.stanceId === stanceB.id);
check('deleting active stance auto-activates survivor', reActivated.stanceId === stanceA.id);

// the last stance cannot be deleted
events.length = 0;
emit('stance:delete', { stanceId: stanceA.id });
await sleep(300);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('last stance cannot be deleted', !events.some((e) => e.ev === 'stance:deleted') && sheet.stances.length === 1);

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
check('chat history has all rolls (5)', chat.length === 5, `got ${chat.length}`);
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
check('chat log survives character deletion', chatAfter.length === 5 && chatAfter[0].characterName === '(deleted)');

await jf(`/api/characters/${npc.id}`, { method: 'DELETE' });

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
watcher.close(); actor.close();
process.exit(failures === 0 ? 0 : 1);

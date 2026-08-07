// Integration test: start the server against a FRESH local.db (rm local.db && npm start),
// then run `node scripts/e2e.mjs`. Asserts absolute chat counts, so a used DB will fail it.
// Phase 1 end-to-end verification against a running server (fresh local.db).
// Exercises: character CRUD + dice seeding, rolls (die/pool), stepping through
// the full ladder, lock/revert, stamina regen/adjust, inventory, injuries,
// chat history, delete cascade — with a second socket verifying broadcasts.
import { io } from 'socket.io-client';

const URL = process.env.E2E_URL || 'http://localhost:3001';
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
// A third socket that identifies as the GM. Needed because round_events are
// delivered per-pair and FAIL CLOSED (see emitToPairAudience server-side): a
// socket that never sent identity:set is entitled to nothing, so `watcher`
// (deliberately anonymous, to test exactly that) can't see them. This one
// stands in for a GM's real browser.
const gmWatcher = io(URL);
const roundEvents = [];
gmWatcher.on('combat:round_event', (payload) => roundEvents.push(payload));
gmWatcher.emit('identity:set', { role: 'gm' });
const events = [];
for (const ev of ['character:created', 'character:updated', 'character:deleted', 'die:updated', 'roll:result', 'inventory:updated', 'injuries:updated', 'stance:created', 'stance:updated', 'stance:deleted', 'stance:activated', 'tell:created', 'tell:updated', 'tell:deleted', 'move:created', 'move:updated', 'move:deleted', 'move:granted', 'move:revoked', 'roleplay:updated', 'tag:created', 'tag:updated', 'tag:deleted', 'folder:created', 'folder:updated', 'folder:deleted', 'perk:created', 'perk:updated', 'perk:deleted', 'perk:granted', 'perk:revoked', 'counter:created', 'counter:updated', 'counter:deleted', 'character_folder:created', 'character_folder:updated', 'character_folder:deleted', 'combat:updated', 'chat:message', 'chat:cleared', 'chat:move_reveal']) {
  watcher.on(ev, (payload) => events.push({ ev, payload }));
}
// Polls a predicate rather than a single event — needed for round_events,
// which land on gmWatcher while waitEvent below is watching `watcher`, so
// "the state changed" and "this socket has seen the log" are genuinely
// different moments.
const waitFor = async (pred, ms = 5000, label = 'condition') => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(25);
  }
  return false;
};

const waitEvent = (ev, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const existing = events.find((e) => e.ev === ev && pred(e.payload));
    if (existing) return resolve(existing.payload);
    const timer = setTimeout(() => { watcher.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
    const h = (payload) => { if (pred(payload)) { clearTimeout(timer); watcher.off(ev, h); resolve(payload); } };
    watcher.on(ev, h);
  });
// combat:updated is now per-socket-tailored (see mapDeclaredMovesForViewer
// server-side), so watcher and actor can see genuinely different payloads
// once either has an identity set — a second recorder+waiter, scoped to
// actor, is what lets a test assert "this is what the declaring player's
// own client sees" separately from "this is what an outside watcher sees".
const actorEvents = [];
actor.on('combat:updated', (payload) => actorEvents.push({ ev: 'combat:updated', payload }));
const waitActorEvent = (ev, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const existing = actorEvents.find((e) => e.ev === ev && pred(e.payload));
    if (existing) return resolve(existing.payload);
    const timer = setTimeout(() => { actor.off(ev, h); reject(new Error(`timeout waiting for actor ${ev}`)); }, ms);
    const h = (payload) => { if (pred(payload)) { clearTimeout(timer); actor.off(ev, h); resolve(payload); } };
    actor.on(ev, h);
  });
const emit = (ev, payload) => actor.emit(ev, payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => watcher.on('connect', r));
await new Promise((r) => actor.on('connect', r));

// --- character creation ---
const created = await jpost('/api/characters', { name: 'Aaron', characterType: 'pc' });
check('create character returns 201', created.status === 201);
const ch = created.body;
// Character Creation starts every Stat at d4 (game_rules.md), so a brand
// new character's Max Stamina is 4 x 4. The GM then spends the creation
// budget of step-ups from there.
check('new character stamina 16/16', ch.max_stamina === 16 && ch.current_stamina === 16, JSON.stringify(ch));
await waitEvent('character:created', (c) => c.id === ch.id);
check('character:created broadcast', true);

const npc = (await jpost('/api/characters', { name: 'Goon', characterType: 'npc' })).body;
check('npc type stored', npc.character_type === 'npc');

const full = (await jf(`/api/characters/${ch.id}`)).body;
check('8 dice auto-seeded', full.dice.length === 8, `got ${full.dice.length}`);
check('dice pools 2/4/2', ['head', 'core', 'legs'].map((p) => full.dice.filter((d) => d.pool === p).length).join() === '2,4,2');
check('all dice seed at d4 active', full.dice.every((d) => d.current_size === 4 && d.bonus === 0 && d.status === 'active' && d.locked_size === 4));

// --- normalise this fixture to a d8 baseline ---
// Character Creation starts every Stat at d4 and hands the player a budget
// of step-ups (game_rules.md). The scenarios below are about stepping,
// locking, damage and Stamina arithmetic, not about where a sheet starts —
// they were all authored against d8 and stay far more readable that way. So
// spend a notional budget up to d8 across the board, lock it in as this
// character's base, and top Stamina up to the matching 4 x 8. The creation
// defaults themselves are asserted above, where they belong.
for (const d of full.dice) {
  for (const target of [6, 8]) {
    emit('die:step', { dieId: d.id, direction: 'up' });
    await waitEvent('die:updated', (u) => u.dieId === d.id && u.current_size === target);
  }
}
emit('character:lock_stats', { characterId: ch.id });
await waitEvent('character:updated', (c) => c.id === ch.id && c.max_stamina === 32);
emit('stamina:adjust', { characterId: ch.id, delta: 16 });
await waitEvent('character:updated', (c) => c.id === ch.id && c.current_stamina === 32);
check('fixture normalised to d8 / 32 Stamina', true);

// Every fixture from here on wants the same d8 baseline, for the same
// reason — these scenarios are about combat, Stamina costs and damage math,
// all authored against d8, not about where character creation starts.
async function createFighter(name, characterType = 'pc') {
  const body = (await jpost('/api/characters', { name, characterType })).body;
  const sheet = (await jf(`/api/characters/${body.id}`)).body;
  for (const d of sheet.dice) {
    for (const target of [6, 8]) {
      emit('die:step', { dieId: d.id, direction: 'up' });
      await waitEvent('die:updated', (u) => u.dieId === d.id && u.current_size === target);
    }
  }
  emit('character:lock_stats', { characterId: body.id });
  await waitEvent('character:updated', (c) => c.id === body.id && c.max_stamina === 32);
  emit('stamina:adjust', { characterId: body.id, delta: 32 });
  await waitEvent('character:updated', (c) => c.id === body.id && c.current_stamina === 32);
  return (await jf(`/api/characters/${body.id}`)).body.character;
}

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
check('current stamina unchanged at 32 (below new max)', lockedChar.current_stamina === 32, JSON.stringify(lockedChar));
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

// --- ruleset: 7 styles, complete tournament, one bonus per edge ---
const ruleset = (await jf('/api/ruleset')).body;
check('7 attributes seeded with icons', ruleset.attributes.length === 7 && ruleset.attributes.every((a) => a.icon));
// The per-edge bonus is a balance knob (halved once already, to keep an
// ideal counter-pick a +3/-3 tilt rather than a +6/-6 landslide), so assert
// the shape — 21 edges, all seeded at the same positive whole number — not
// the number itself.
const seededBonus = ruleset.counters[0]?.bonus;
check(
  '21 counter edges, each a positive whole-number bonus',
  ruleset.counters.length === 21 &&
    Number.isInteger(seededBonus) &&
    seededBonus > 0 &&
    ruleset.counters.every((c) => c.bonus === seededBonus),
  JSON.stringify(ruleset.counters.slice(0, 3))
);
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

// --- tells: 2 placeholders seeded, CRUD, delete-blocked-when-used ---
let tells = (await jf('/api/tells')).body;
check('2 placeholder tells seeded', tells.length === 2 && tells[0].name === 'Tell 1' && tells[1].name === 'Tell 2');
events.length = 0;
emit('tell:create', { name: 'Shoulder Drop', imageData: 'aGVsbG8=', imageMimeType: 'image/png' });
const newTell = await waitEvent('tell:created');
check('tell created with uploaded image', newTell.name === 'Shoulder Drop' && newTell.image_data === 'aGVsbG8=' && newTell.image_mime_type === 'image/png');
events.length = 0;
emit('tell:update', { tellId: newTell.id, name: 'Shoulder Twitch' });
const updTell = await waitEvent('tell:updated');
check('tell rename keeps image', updTell.name === 'Shoulder Twitch' && updTell.image_data === 'aGVsbG8=');

// --- tags (world-level, GM-managed, with description) ---
events.length = 0;
emit('tag:create', { name: 'Overhead', description: 'Must be blocked standing' });
const tagA = await waitEvent('tag:created');
emit('tag:create', { name: 'Sweep' });
const tagB = await waitEvent('tag:created', (t) => t.name === 'Sweep');
check('tags created, description optional', tagA.name === 'Overhead' && tagA.description === 'Must be blocked standing' && tagB.description === '');
events.length = 0;
emit('tag:update', { tagId: tagB.id, name: 'Sweep', description: 'Must be blocked low' });
const tagBUpdated = await waitEvent('tag:updated');
check('tag description editable', tagBUpdated.description === 'Must be blocked low');

// --- moves: frame data + interactions + style + tags + image ---
const speedId = attrIdByName.get('Speed');
events.length = 0;
emit('move:create', {
  name: 'Hook', isDefault: false, tellId: tells[0].id,
  styleAttributeId: speedId,
  tagIds: [tagA.id, tagB.id, tagA.id], // duplicate must dedupe
  imageData: 'bW92ZQ==', imageMimeType: 'image/png',
  startupTics: 3, activeTics: 2, recoveryTics: 1,
  description: 'A heavy swinging punch.',
  interactions: {
    hit: { text: 'Staggers the target', automations: [{ type: 'opponent_stamina', amount: 2 }] },
    block: { text: '', automations: [] },
    miss: { text: 'Wide open', automations: [{ type: 'self_recovery', amount: 2 }] },
  },
});
const hook = await waitEvent('move:created');
check('move created with frame data 3/2/1', hook.startup_tics === 3 && hook.active_tics === 2 && hook.recovery_tics === 1);
check('move carries style, deduped tags, image', hook.style_attribute_id === speedId && hook.tag_ids.length === 2 && hook.image_data === 'bW92ZQ==');
check('empty interaction dropped, 2 kept', hook.interactions.length === 2 && hook.interactions.map((r) => r.trigger).join() === 'hit,miss');
check('automation stored', hook.interactions[0].automations[0].type === 'opponent_stamina' && hook.interactions[0].automations[0].amount === 2);

events.length = 0;
emit('move:create', { name: 'Jab', isDefault: true, tellId: tells[1].id, startupTics: 2, activeTics: 1, recoveryTics: 0, description: 'Quick poke.', interactions: {} });
const jab = await waitEvent('move:created');
check('default move created (legacy null style allowed)', jab.is_default === 1 && jab.style_attribute_id === null);

// A Default move is usable by anyone, anytime — it never carries a Style
// gate. A styleAttributeId sent alongside isDefault is silently dropped
// rather than stored, regardless of what the client sent.
events.length = 0;
emit('move:create', {
  name: 'Slip Punch', isDefault: true, tellId: tells[1].id, styleAttributeId: speedId,
  startupTics: 1, activeTics: 1, recoveryTics: 0, description: '', interactions: {},
});
const slipPunch = await waitEvent('move:created', (m) => m.name === 'Slip Punch');
check(
  'a Default move ignores a styleAttributeId sent alongside it — never stored',
  slipPunch.is_default === 1 && slipPunch.style_attribute_id === null,
  JSON.stringify(slipPunch)
);
events.length = 0;
emit('move:update', { moveId: slipPunch.id, name: 'Slip Punch', isDefault: true, tellId: tells[1].id, styleAttributeId: speedId, startupTics: 1, activeTics: 1, recoveryTics: 0, description: '', interactions: {} });
const slipPunchUpdated = await waitEvent('move:updated');
check('editing a Default move also can\'t give it a Style', slipPunchUpdated.style_attribute_id === null);
events.length = 0;
emit('move:delete', { moveId: slipPunch.id });
await waitEvent('move:deleted', (p) => p.moveId === slipPunch.id);

events.length = 0;
emit('move:create', { name: 'Nothing', isDefault: false, tellId: tells[0].id, startupTics: 0, activeTics: 0, recoveryTics: 0, description: '', interactions: {} });
await sleep(300);
check('zero-frame move rejected', !events.some((e) => e.ev === 'move:created'));

// tell in use can't be deleted; unused one can
events.length = 0;
emit('tell:delete', { tellId: tells[0].id });
await sleep(300);
check('tell in use is not deletable', !events.some((e) => e.ev === 'tell:deleted'));
events.length = 0;
emit('tell:delete', { tellId: newTell.id });
await waitEvent('tell:deleted', (p) => p.tellId === newTell.id);
check('unused tell deleted', true);

// default appears on the sheet without a grant; unique doesn't until granted
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('default move on sheet automatically', sheet.moves.some((m) => m.id === jab.id));
check('unique move absent before grant', !sheet.moves.some((m) => m.id === hook.id));

// grant works because ch's stance 'Blitz' carries Speed (Hook's style)
events.length = 0;
emit('move:grant', { characterId: ch.id, moveId: hook.id });
await waitEvent('move:granted', (p) => p.characterId === ch.id && p.moveId === hook.id);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('granted move on sheet with is_granted', sheet.moves.some((m) => m.id === hook.id && m.is_granted === 1));
let compendium = (await jf('/api/moves')).body;
check('compendium tracks grants', compendium.moves.find((m) => m.id === hook.id).granted_character_ids.includes(ch.id));

// style gate: a Defensive-styled move can't be granted (no Defensive stance)
events.length = 0;
emit('move:create', { name: 'Guard Wall', isDefault: false, tellId: tells[0].id, styleAttributeId: attrIdByName.get('Defensive'), startupTics: 1, activeTics: 1, recoveryTics: 0, description: '', interactions: {} });
const guardWall = await waitEvent('move:created', (m) => m.name === 'Guard Wall');
events.length = 0;
emit('move:grant', { characterId: ch.id, moveId: guardWall.id });
await sleep(300);
check('grant blocked without a stance of the move style', !events.some((e) => e.ev === 'move:granted'));
emit('move:delete', { moveId: guardWall.id });
await waitEvent('move:deleted', (p) => p.moveId === guardWall.id);

// --- Defensive moves: is_defensive + On Successful/Failed Defense outcomes ---
events.length = 0;
emit('move:create', {
  name: 'Parry', isDefault: false, tellId: tells[0].id, isDefensive: true,
  startupTics: 1, activeTics: 1, recoveryTics: 0, description: 'A defensive stance.',
  interactions: {
    hit: { text: '', automations: [] }, // empty — must be dropped like any other
    defense_success: { text: 'Countered!', automations: [{ type: 'opponent_stamina', amount: 2 }] },
    defense_failure: { text: '', automations: [{ type: 'self_stamina', amount: 3 }] },
  },
});
const parry = await waitEvent('move:created', (m) => m.name === 'Parry');
check('Defensive move stores is_defensive', parry.is_defensive === 1);
check(
  'empty hit interaction dropped, both defense outcomes kept',
  parry.interactions.length === 2 && parry.interactions.map((r) => r.trigger).sort().join() === 'defense_failure,defense_success',
  JSON.stringify(parry.interactions)
);
check('defense_success automation stored', parry.interactions.find((r) => r.trigger === 'defense_success').automations[0].type === 'opponent_stamina');
check('automation-only defense_failure interaction kept (no text)', parry.interactions.find((r) => r.trigger === 'defense_failure').text === '');

// Defense-outcome content submitted for a NON-Defensive move must be
// silently dropped by the server, regardless of what the client sends.
events.length = 0;
emit('move:create', {
  name: 'Plain Strike', isDefault: false, tellId: tells[0].id, isDefensive: false,
  startupTics: 1, activeTics: 1, recoveryTics: 0, description: '',
  interactions: {
    hit: { text: 'A solid hit', automations: [] },
    defense_success: { text: 'Should not be stored', automations: [] },
  },
});
const plainStrike = await waitEvent('move:created', (m) => m.name === 'Plain Strike');
check(
  'non-Defensive move never stores a defense_success interaction',
  plainStrike.is_defensive === 0 && plainStrike.interactions.every((r) => r.trigger !== 'defense_success')
);

// Switching Defensive off and saving removes previously-stored defensive rows
events.length = 0;
emit('move:update', {
  moveId: parry.id, name: 'Parry', isDefault: false, tellId: tells[0].id, isDefensive: false,
  startupTics: 1, activeTics: 1, recoveryTics: 0, description: 'A defensive stance.',
  interactions: {
    defense_success: { text: 'Countered!', automations: [{ type: 'opponent_stamina', amount: 2 }] },
    defense_failure: { text: '', automations: [{ type: 'self_stamina', amount: 3 }] },
  },
});
const parryOff = await waitEvent('move:updated', (m) => m.id === parry.id);
check('turning Defensive off and saving removes stored defensive outcome rows', parryOff.is_defensive === 0 && parryOff.interactions.length === 0);

events.length = 0;
emit('move:delete', { moveId: parry.id });
await waitEvent('move:deleted', (p) => p.moveId === parry.id);
events.length = 0;
emit('move:delete', { moveId: plainStrike.id });
await waitEvent('move:deleted', (p) => p.moveId === plainStrike.id);

// --- folders: create, assign via move:update, delete returns moves to root ---
events.length = 0;
emit('folder:create', { name: 'Punches' });
const folder = await waitEvent('folder:created');
check('folder created', folder.name === 'Punches');

// move:set_folder (drag-and-drop) must touch ONLY folder_id — everything
// else about the move stays exactly as it was, unlike move:update.
events.length = 0;
emit('move:set_folder', { moveId: hook.id, folderId: folder.id });
const draggedIn = await waitEvent('move:updated', (m) => m.id === hook.id);
check('move:set_folder files the move without touching other fields', draggedIn.folder_id === folder.id && draggedIn.name === hook.name && draggedIn.tell_id === hook.tell_id && draggedIn.style_attribute_id === hook.style_attribute_id && draggedIn.startup_tics === hook.startup_tics && draggedIn.image_data === hook.image_data && draggedIn.interactions.length === hook.interactions.length);
events.length = 0;
emit('move:set_folder', { moveId: hook.id, folderId: null });
const draggedOut = await waitEvent('move:updated', (m) => m.id === hook.id);
check('move:set_folder back to root (drop on "All Moves")', draggedOut.folder_id === null && draggedOut.name === hook.name);
events.length = 0;
emit('move:set_folder', { moveId: hook.id, folderId: 999999 });
const draggedBad = await waitEvent('move:updated', (m) => m.id === hook.id);
check('move:set_folder falls back to root for a nonexistent folder id', draggedBad.folder_id === null);

events.length = 0;
emit('move:update', {
  moveId: hook.id, name: 'Heavy Hook', isDefault: false, tellId: tells[1].id,
  styleAttributeId: speedId, folderId: folder.id, tagIds: [tagB.id],
  startupTics: 4, activeTics: 2, recoveryTics: 2, description: 'Slower, harder.',
  interactions: { block: { text: 'Chip', automations: [{ type: 'self_stamina', amount: -3 }] } },
});
const updMove = await waitEvent('move:updated', (m) => m.id === hook.id);
check('move updated, interactions replaced', updMove.name === 'Heavy Hook' && updMove.interactions.length === 1 && updMove.interactions[0].automations[0].amount === 3);
check('move placed in folder, tags replaced, image kept', updMove.folder_id === folder.id && updMove.tag_ids.length === 1 && updMove.tag_ids[0] === tagB.id && updMove.image_data === 'bW92ZQ==');
compendium = (await jf('/api/moves')).body;
check('folders listed by /api/moves', compendium.folders.some((f) => f.id === folder.id));

events.length = 0;
emit('folder:delete', { folderId: folder.id });
await waitEvent('folder:deleted', (p) => p.folderId === folder.id);
compendium = (await jf('/api/moves')).body;
check('deleting folder returns moves to root', compendium.moves.find((m) => m.id === hook.id).folder_id === null);

// --- nested disciplines: parentFolderId, invalid parent -> root, delete
// reparents direct contents + child disciplines ONE LEVEL UP (to the
// deleted discipline's own parent), not unconditionally to root ---
events.length = 0;
emit('folder:create', { name: 'Striking' });
const disciplineA = await waitEvent('folder:created', (f) => f.name === 'Striking');
check('root discipline has no parent', disciplineA.parent_id == null);

events.length = 0;
emit('folder:create', { name: 'Boxing', parentFolderId: disciplineA.id });
const disciplineB = await waitEvent('folder:created', (f) => f.name === 'Boxing');
check('nested discipline stores parent_id', disciplineB.parent_id === disciplineA.id);

events.length = 0;
emit('folder:create', { name: 'Southpaw', parentFolderId: disciplineB.id });
const disciplineC = await waitEvent('folder:created', (f) => f.name === 'Southpaw');
check('grandchild discipline nests under its own parent', disciplineC.parent_id === disciplineB.id);

events.length = 0;
emit('folder:create', { name: 'Bad Parent', parentFolderId: 999999 });
const badParentFolder = await waitEvent('folder:created', (f) => f.name === 'Bad Parent');
check('unknown parentFolderId falls back to root', badParentFolder.parent_id == null);

// file a move directly under Boxing, the discipline about to be deleted
events.length = 0;
emit('move:set_folder', { moveId: jab.id, folderId: disciplineB.id });
await waitEvent('move:updated', (m) => m.id === jab.id && m.folder_id === disciplineB.id);

events.length = 0;
emit('folder:delete', { folderId: disciplineB.id });
const deletedB = await waitEvent('folder:deleted', (p) => p.folderId === disciplineB.id);
check('deleting a nested discipline reports its own parent for client navigation', deletedB.parentFolderId === disciplineA.id);
compendium = (await jf('/api/moves')).body;
check("directly-contained move promotes to the deleted discipline's parent, not root", compendium.moves.find((m) => m.id === jab.id).folder_id === disciplineA.id);
check("child discipline promotes to the deleted discipline's parent, not root", compendium.folders.find((f) => f.id === disciplineC.id).parent_id === disciplineA.id);

// Deleting a ROOT discipline (no parent) promotes its contents/children to
// root — same reparenting code path, just parent_id happens to be null.
events.length = 0;
emit('folder:delete', { folderId: disciplineA.id });
const deletedA = await waitEvent('folder:deleted', (p) => p.folderId === disciplineA.id);
check('deleting a root discipline promotes contents to root', deletedA.parentFolderId == null);
compendium = (await jf('/api/moves')).body;
check('move that had promoted to A now promotes to root', compendium.moves.find((m) => m.id === jab.id).folder_id === null);
check("grandchild discipline promotes to root once its whole ancestor chain collapses", compendium.folders.find((f) => f.id === disciplineC.id).parent_id === null);

events.length = 0;
emit('folder:delete', { folderId: disciplineC.id });
await waitEvent('folder:deleted', (p) => p.folderId === disciplineC.id);
events.length = 0;
emit('folder:delete', { folderId: badParentFolder.id });
await waitEvent('folder:deleted', (p) => p.folderId === badParentFolder.id);
events.length = 0;
emit('move:set_folder', { moveId: jab.id, folderId: null });
await waitEvent('move:updated', (m) => m.id === jab.id && m.folder_id === null);

// tag deletion strips it from moves
events.length = 0;
emit('tag:delete', { tagId: tagB.id });
await waitEvent('tag:deleted', (p) => p.tagId === tagB.id);
compendium = (await jf('/api/moves')).body;
check('deleting tag strips it from moves', compendium.moves.find((m) => m.id === hook.id).tag_ids.length === 0);

events.length = 0;
emit('move:revoke', { characterId: ch.id, moveId: hook.id });
await waitEvent('move:revoked', (p) => p.characterId === ch.id);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('revoked move gone from sheet', !sheet.moves.some((m) => m.id === hook.id));

events.length = 0;
emit('move:delete', { moveId: hook.id });
await waitEvent('move:deleted', (p) => p.moveId === hook.id);
check('move deleted', ((await jf('/api/moves')).body).moves.every((m) => m.id !== hook.id));

// --- Move Roll: optional die-collection + shared bonus, resolved live per character ---
events.length = 0;
emit('move:create', {
  name: 'Body Slam', isDefault: true, tellId: tells[1].id,
  rollSlots: ['Body', 'Body', 'Brain', 'Nonsense'], rollModifier: 2,
  startupTics: 2, activeTics: 1, recoveryTics: 1, description: '', interactions: {},
});
const bodySlam = await waitEvent('move:created', (m) => m.name === 'Body Slam');
check('move Roll dedupes slots and drops unknown ones', bodySlam.roll_slots.length === 2 && bodySlam.roll_slots.includes('Body') && bodySlam.roll_slots.includes('Brain'), JSON.stringify(bodySlam.roll_slots));
check('move Roll bonus stored', bodySlam.roll_modifier === 2);

sheet = (await jf(`/api/characters/${ch.id}`)).body;
let slamOnSheet = sheet.moves.find((m) => m.id === bodySlam.id);
check('default move with a Roll appears on sheet without a grant', !!slamOnSheet);
check('Roll resolves to exactly the character\'s live dice for those slots', slamOnSheet.roll_dice.length === 2, JSON.stringify(slamOnSheet.roll_dice));
check('a move with only concrete slots has no ambiguous roll_choice', slamOnSheet.roll_choice === null);
const slamBody = slamOnSheet.roll_dice.find((d) => d.slot_name === 'Body');
const slamBrain = slamOnSheet.roll_dice.find((d) => d.slot_name === 'Brain');
check('Roll dice carry real die ids + current size/bonus/status', slamBody.current_size === 8 && slamBody.status === 'active' && Number.isInteger(slamBody.dieId));
check('Brain die still untouched baseline d8', slamBrain.current_size === 8 && slamBrain.bonus === 0);
check('effective_roll_modifier = move roll_modifier', slamOnSheet.effective_roll_modifier === 2);

// step the Body die up — the Roll must reflect the CURRENT die, not a stale snapshot
events.length = 0;
emit('die:step', { dieId: slamBody.dieId, direction: 'up' });
await waitEvent('die:updated', (d) => d.dieId === slamBody.dieId);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
slamOnSheet = sheet.moves.find((m) => m.id === bodySlam.id);
check('Roll reflects the die\'s current (stepped) size, live', slamOnSheet.roll_dice.find((d) => d.slot_name === 'Body').current_size === 10);
events.length = 0;
emit('die:step', { dieId: slamBody.dieId, direction: 'down' }); // back to d8
await waitEvent('die:updated', (d) => d.dieId === slamBody.dieId);

// clicking the Roll = pool:roll with the resolved die ids + the pre-filled modifier
events.length = 0;
emit('pool:roll', { characterId: ch.id, dieIds: slamOnSheet.roll_dice.map((d) => d.dieId), modifier: slamOnSheet.effective_roll_modifier });
roll = await waitEvent('roll:result');
check('Move Roll click rolls exactly its configured dice', roll.dice.length === 2 && roll.dice.every((d) => ['Body', 'Brain'].includes(d.slot_name)));
check('Move Roll click uses the pre-filled modifier', roll.modifier === 2);

// incapacitate one of the Roll's dice — pool:roll must silently drop it, not block the whole roll
for (const _ of [1, 2, 3]) { events.length = 0; emit('die:step', { dieId: slamBody.dieId, direction: 'down' }); await waitEvent('die:updated', (d) => d.dieId === slamBody.dieId); }
sheet = (await jf(`/api/characters/${ch.id}`)).body;
slamOnSheet = sheet.moves.find((m) => m.id === bodySlam.id);
check('Roll still lists the incapacitated die (client dims/excludes it, server keeps it visible)', slamOnSheet.roll_dice.find((d) => d.slot_name === 'Body').status === 'incapacitated');
events.length = 0;
emit('pool:roll', { characterId: ch.id, dieIds: slamOnSheet.roll_dice.map((d) => d.dieId), modifier: 0 });
roll = await waitEvent('roll:result');
check('Move Roll silently drops the incapacitated die and still rolls the rest', roll.dice.length === 1 && roll.dice[0].slot_name === 'Brain', JSON.stringify(roll.dice));

// revive the Body die and clean up the test move
events.length = 0;
emit('die:step', { dieId: slamBody.dieId, direction: 'up' });
await waitEvent('die:updated', (d) => d.dieId === slamBody.dieId);
events.length = 0;
emit('move:delete', { moveId: bodySlam.id });
await waitEvent('move:deleted', (p) => p.moveId === bodySlam.id);

// --- Move Roll: ambiguous [Left/Right] Hand/Leg slots need two Tells, and
// ONE shared Left/Right choice resolves every ambiguous slot in the Roll together ---
events.length = 0;
emit('move:create', {
  name: 'Haymaker', isDefault: true, tellId: tells[0].id, // no rightTellId/leftTellId
  rollSlots: ['Hand'], rollModifier: 1,
  startupTics: 2, activeTics: 1, recoveryTics: 1, description: '', interactions: {},
});
await sleep(300);
check('ambiguous Roll without both right/left Tells is rejected', !events.some((e) => e.ev === 'move:created'));

events.length = 0;
emit('move:create', {
  name: 'Haymaker', isDefault: true,
  rightTellId: tells[0].id, leftTellId: tells[1].id,
  rollSlots: ['Left Hand', 'Right Hand', 'Hand'], rollModifier: 1,
  startupTics: 2, activeTics: 1, recoveryTics: 1, description: '', interactions: {},
});
const haymaker = await waitEvent('move:created', (m) => m.name === 'Haymaker');
check(
  'ambiguous move stores right/left tell ids, drops legacy concrete Left/Right Hand slot names',
  haymaker.roll_slots.length === 1 && haymaker.roll_slots[0] === 'Hand' &&
    haymaker.right_tell_id === tells[0].id && haymaker.left_tell_id === tells[1].id,
  JSON.stringify(haymaker)
);

sheet = (await jf(`/api/characters/${ch.id}`)).body;
const haymakerOnSheet = sheet.moves.find((m) => m.id === haymaker.id);
check(
  'ambiguous move has no concrete roll_dice, only a roll_choice',
  haymakerOnSheet.roll_dice.length === 0 && haymakerOnSheet.roll_choice !== null
);
check(
  'roll_choice resolves to the actual Left/Right Hand dice, both still baseline d8',
  haymakerOnSheet.roll_choice.right.length === 1 &&
    haymakerOnSheet.roll_choice.right[0].slot_name === 'Right Hand' &&
    haymakerOnSheet.roll_choice.right[0].current_size === 8 &&
    haymakerOnSheet.roll_choice.left.length === 1 &&
    haymakerOnSheet.roll_choice.left[0].slot_name === 'Left Hand' &&
    haymakerOnSheet.roll_choice.left[0].current_size === 8,
  JSON.stringify(haymakerOnSheet.roll_choice)
);

// choosing a side = pool:roll with that side's resolved dice
events.length = 0;
emit('pool:roll', {
  characterId: ch.id,
  dieIds: haymakerOnSheet.roll_choice.right.map((d) => d.dieId),
  modifier: haymakerOnSheet.effective_roll_modifier,
});
roll = await waitEvent('roll:result');
check('choosing Right rolls the Right Hand die', roll.dice.length === 1 && roll.dice[0].slot_name === 'Right Hand' && roll.modifier === 1);

events.length = 0;
emit('pool:roll', {
  characterId: ch.id,
  dieIds: haymakerOnSheet.roll_choice.left.map((d) => d.dieId),
  modifier: haymakerOnSheet.effective_roll_modifier,
});
roll = await waitEvent('roll:result');
check('choosing Left rolls the Left Hand die', roll.dice.length === 1 && roll.dice[0].slot_name === 'Left Hand' && roll.modifier === 1);

// a Tell used only as an ambiguous right/left Tell (not the base tell_id) still blocks deletion
events.length = 0;
emit('tell:delete', { tellId: tells[0].id });
await sleep(300);
check('a Tell used as an ambiguous right/left Tell is not deletable', !events.some((e) => e.ev === 'tell:deleted'));

// two ambiguous slots together (Hand + Leg): still ONE shared Left/Right
// choice, resolving both simultaneously — not independent per-slot choices
events.length = 0;
emit('move:create', {
  name: 'Dive Kick', isDefault: true,
  rightTellId: tells[0].id, leftTellId: tells[1].id,
  rollSlots: ['Hand', 'Leg'], rollModifier: 0,
  startupTics: 1, activeTics: 1, recoveryTics: 1, description: '', interactions: {},
});
const diveKick = await waitEvent('move:created', (m) => m.name === 'Dive Kick');
sheet = (await jf(`/api/characters/${ch.id}`)).body;
const diveKickOnSheet = sheet.moves.find((m) => m.id === diveKick.id);
check(
  'a move with two ambiguous slots resolves one Right side (Hand+Leg together) and one Left side',
  diveKickOnSheet.roll_choice.right.length === 2 &&
    diveKickOnSheet.roll_choice.right.some((d) => d.slot_name === 'Right Hand') &&
    diveKickOnSheet.roll_choice.right.some((d) => d.slot_name === 'Right Leg') &&
    diveKickOnSheet.roll_choice.left.length === 2 &&
    diveKickOnSheet.roll_choice.left.some((d) => d.slot_name === 'Left Hand') &&
    diveKickOnSheet.roll_choice.left.some((d) => d.slot_name === 'Left Leg'),
  JSON.stringify(diveKickOnSheet.roll_choice)
);

events.length = 0;
emit('move:delete', { moveId: haymaker.id });
await waitEvent('move:deleted', (p) => p.moveId === haymaker.id);
events.length = 0;
emit('move:delete', { moveId: diveKick.id });
await waitEvent('move:deleted', (p) => p.moveId === diveKick.id);

// --- perks: picture/name/description + membership only (no generic
// automation system — mechanical effects are now manual, case-by-case
// PERK_HOOKS entries in server/perkAutomations.js, so a plain grant/revoke
// here must NOT touch dice/stamina/moves at all) ---
sheet = (await jf(`/api/characters/${ch.id}`)).body;
const rightHandBaseline = sheet.dice.find((d) => d.slot_name === 'Right Hand');
check('Right Hand die untouched baseline d8', rightHandBaseline.current_size === 8 && rightHandBaseline.bonus === 0 && rightHandBaseline.locked_size === 8);
const beforeMultiplier = sheet.character.stamina_multiplier;

events.length = 0;
emit('perk:create', {
  name: 'Iron Body', description: 'Years of conditioning.',
  imageData: 'cGVyaw==', imageMimeType: 'image/png',
});
const perk = await waitEvent('perk:created');
check('perk created with image, no automations field', perk.name === 'Iron Body' && perk.image_data === 'cGVyaw==' && perk.automations === undefined);

let perksResp = (await jf('/api/perks')).body;
check('perk listed in compendium, ungranted', perksResp.find((p) => p.id === perk.id)?.granted_character_ids.length === 0);

events.length = 0;
emit('perk:grant', { characterId: ch.id, perkId: perk.id });
await waitEvent('perk:granted', (p) => p.characterId === ch.id && p.perkId === perk.id);
await sleep(200);

sheet = (await jf(`/api/characters/${ch.id}`)).body;
let rightHand = sheet.dice.find((d) => d.slot_name === 'Right Hand');
check('granting a Perk with no PERK_HOOKS entry leaves dice untouched', rightHand.current_size === 8 && rightHand.bonus === 0 && rightHand.locked_size === 8);
check('granting a Perk with no PERK_HOOKS entry leaves stamina multiplier untouched', sheet.character.stamina_multiplier === beforeMultiplier);
check('granted perk on character sheet is just id/name/description/picture', sheet.perks.length === 1 && sheet.perks[0].name === 'Iron Body' && sheet.perks[0].automations === undefined);

perksResp = (await jf('/api/perks')).body;
check('compendium tracks the grant', perksResp.find((p) => p.id === perk.id).granted_character_ids.includes(ch.id));

events.length = 0;
emit('perk:delete', { perkId: perk.id });
await sleep(300);
check('perk delete blocked while still granted to someone', !events.some((e) => e.ev === 'perk:deleted'));

events.length = 0;
emit('perk:revoke', { characterId: ch.id, perkId: perk.id });
await waitEvent('perk:revoked', (p) => p.characterId === ch.id && p.perkId === perk.id);
await sleep(200);

sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('perk removed from character sheet', sheet.perks.length === 0);

events.length = 0;
emit('perk:delete', { perkId: perk.id });
await waitEvent('perk:deleted', (p) => p.perkId === perk.id);
perksResp = (await jf('/api/perks')).body;
check('perk deletable once ungranted', perksResp.every((p) => p.id !== perk.id));

// --- roleplay: fixed-question upsert, custom questions, cap of 20 ---
const q1 = 'What is their favorite food?';
events.length = 0;
emit('roleplay:save_answer', { characterId: ch.id, question: q1, answer: 'Dumplings' });
let rp = await waitEvent('roleplay:updated', (p) => p.characterId === ch.id);
check('fixed answer saved', rp.entries.length === 1 && rp.entries[0].answer === 'Dumplings' && rp.entries[0].is_custom === 0);
events.length = 0;
emit('roleplay:save_answer', { characterId: ch.id, question: q1, answer: 'Spicy dumplings' });
rp = await waitEvent('roleplay:updated', (p) => p.characterId === ch.id);
check('fixed answer upserts, not duplicates', rp.entries.length === 1 && rp.entries[0].answer === 'Spicy dumplings');

events.length = 0;
emit('roleplay:add_question', { characterId: ch.id, question: 'What do they hum when nervous?' });
rp = await waitEvent('roleplay:updated', (p) => p.characterId === ch.id && p.entries.length === 2);
const customQ = rp.entries.find((e) => e.is_custom === 1);
check('custom question added', customQ.question === 'What do they hum when nervous?');
events.length = 0;
emit('roleplay:update_entry', { entryId: customQ.id, question: 'What tune do they hum?', answer: 'An old waltz' });
rp = await waitEvent('roleplay:updated', (p) => p.characterId === ch.id);
check('custom question + answer editable', rp.entries.find((e) => e.id === customQ.id).question === 'What tune do they hum?' && rp.entries.find((e) => e.id === customQ.id).answer === 'An old waltz');

for (let i = 2; i <= 20; i++) {
  emit('roleplay:add_question', { characterId: ch.id, question: `Custom question ${i}` });
  await waitEvent('roleplay:updated', (p) => p.characterId === ch.id && p.entries.filter((e) => e.is_custom).length === i, 5000);
}
events.length = 0;
emit('roleplay:add_question', { characterId: ch.id, question: 'One too many' });
await sleep(300);
rp = (await jf(`/api/characters/${ch.id}`)).body;
check('custom questions capped at 20', rp.roleplay.filter((e) => e.is_custom).length === 20 && !events.some((e) => e.ev === 'roleplay:updated'));
events.length = 0;
emit('roleplay:delete_question', { entryId: customQ.id });
rp = await waitEvent('roleplay:updated', (p) => p.characterId === ch.id);
check('custom question deletable', rp.entries.filter((e) => e.is_custom).length === 19);

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

// --- counters: character-owned CRUD, clamped adjust, show-in-combat toggle ---
events.length = 0;
emit('counter:create', { characterId: ch.id, name: 'Rage', targetPips: 5, rewardType: 'story' });
const counter = await waitEvent('counter:created', (c) => c.character_id === ch.id);
check('counter created with target, current defaults to 0', counter.name === 'Rage' && counter.target_pips === 5 && counter.current_pips === 0 && counter.show_in_combat === 0);
check('reward stored on a character-owned counter', counter.reward_type === 'story');

events.length = 0;
emit('counter:create', { characterId: ch.id, name: 'Bad', targetPips: 1 });
await sleep(300);
check('target below 2 rejected', !events.some((e) => e.ev === 'counter:created'));
events.length = 0;
emit('counter:create', { characterId: ch.id, name: 'Bad', targetPips: 21 });
await sleep(300);
check('target above 20 rejected', !events.some((e) => e.ev === 'counter:created'));

events.length = 0;
emit('counter:adjust', { counterId: counter.id, delta: 3 });
let counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('counter adjust +3', counterUpd.current_pips === 3);
events.length = 0;
emit('counter:adjust', { counterId: counter.id, delta: 10 });
counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('counter adjust clamps at target', counterUpd.current_pips === 5);
events.length = 0;
emit('counter:adjust', { counterId: counter.id, delta: -100 });
counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('counter adjust clamps at 0', counterUpd.current_pips === 0);

events.length = 0;
emit('counter:toggle_show_in_combat', { counterId: counter.id });
counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('show_in_combat toggles on', counterUpd.show_in_combat === 1);
events.length = 0;
emit('counter:toggle_show_in_combat', { counterId: counter.id });
counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('show_in_combat toggles off', counterUpd.show_in_combat === 0);

// --- counter rewards: purely cosmetic, character-owned only, changeable any time ---
events.length = 0;
emit('counter:set_reward', { counterId: counter.id, rewardType: 'combat_prowess' });
counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('reward can be changed after creation', counterUpd.reward_type === 'combat_prowess');
events.length = 0;
emit('counter:set_reward', { counterId: counter.id, rewardType: 'nonsense' });
counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('an unrecognized reward type clears the reward', counterUpd.reward_type === null, JSON.stringify(counterUpd.reward_type));
events.length = 0;
emit('counter:set_reward', { counterId: counter.id, rewardType: 'perk' });
counterUpd = await waitEvent('counter:updated', (c) => c.id === counter.id);
check('reward re-set after clearing', counterUpd.reward_type === 'perk');

sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('counter present on character sheet', sheet.counters.length === 1 && sheet.counters[0].id === counter.id);
check('reward included on the character sheet', sheet.counters[0].reward_type === 'perk');

events.length = 0;
emit('counter:delete', { counterId: counter.id });
await waitEvent('counter:deleted', (p) => p.counterId === counter.id);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('counter deleted', sheet.counters.length === 0);

// --- character folders: GM-managed, same structural pattern as move folders ---
events.length = 0;
emit('character_folder:create', { name: 'Party' });
const charFolder = await waitEvent('character_folder:created');
check('character folder created', charFolder.name === 'Party');

events.length = 0;
emit('character:set_folder', { characterId: ch.id, folderId: charFolder.id });
let folderedChar = await waitEvent('character:updated', (c) => c.id === ch.id && c.folder_id === charFolder.id);
check('character filed into folder via character:set_folder', folderedChar.folder_id === charFolder.id);

let charFolders = (await jf('/api/character-folders')).body;
check('character folder listed by /api/character-folders', charFolders.some((f) => f.id === charFolder.id));

events.length = 0;
emit('character_folder:rename', { folderId: charFolder.id, name: 'Party A' });
const renamedFolder = await waitEvent('character_folder:updated', (f) => f.id === charFolder.id);
check('character folder renamed', renamedFolder.name === 'Party A');

events.length = 0;
emit('character:set_folder', { characterId: ch.id, folderId: 999999 });
folderedChar = await waitEvent('character:updated', (c) => c.id === ch.id && c.folder_id === null);
check('character:set_folder falls back to root for a nonexistent folder id', folderedChar.folder_id === null);

events.length = 0;
emit('character:set_folder', { characterId: ch.id, folderId: charFolder.id });
await waitEvent('character:updated', (c) => c.id === ch.id && c.folder_id === charFolder.id);

events.length = 0;
emit('character_folder:delete', { folderId: charFolder.id });
await waitEvent('character_folder:deleted', (p) => p.folderId === charFolder.id);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('deleting a character folder returns its characters to root', sheet.character.folder_id === null);

// creating a character directly into a folder (Add Character form's GM-only folder picker)
events.length = 0;
emit('character_folder:create', { name: 'Villains' });
const villainsFolder = await waitEvent('character_folder:created');
const seeded = await jpost('/api/characters', { name: 'Seeded Villain', characterType: 'npc', folderId: villainsFolder.id });
check('character created directly into a folder', seeded.body.folder_id === villainsFolder.id);
await jf(`/api/characters/${seeded.body.id}`, { method: 'DELETE' });
events.length = 0;
emit('character_folder:delete', { folderId: villainsFolder.id });
await waitEvent('character_folder:deleted', (p) => p.folderId === villainsFolder.id);

// --- nested character folders: parentFolderId, invalid parent -> root,
// delete reparents direct contents + child folders ONE LEVEL UP (to the
// deleted folder's own parent), not unconditionally to root ---
events.length = 0;
emit('character_folder:create', { name: 'Heroes' });
const rootFolder = await waitEvent('character_folder:created', (f) => f.name === 'Heroes');
check('root character folder has no parent', rootFolder.parent_id == null);

events.length = 0;
emit('character_folder:create', { name: 'Front Line', parentFolderId: rootFolder.id });
const midFolder = await waitEvent('character_folder:created', (f) => f.name === 'Front Line');
check('nested character folder stores parent_id', midFolder.parent_id === rootFolder.id);

events.length = 0;
emit('character_folder:create', { name: 'Tanks', parentFolderId: midFolder.id });
const leafFolder = await waitEvent('character_folder:created', (f) => f.name === 'Tanks');
check('grandchild character folder nests under its own parent', leafFolder.parent_id === midFolder.id);

events.length = 0;
emit('character_folder:create', { name: 'Ghost Parent', parentFolderId: 999999 });
const ghostParentFolder = await waitEvent('character_folder:created', (f) => f.name === 'Ghost Parent');
check('unknown parentFolderId falls back to root', ghostParentFolder.parent_id == null);

// file a character directly under Front Line, the folder about to be deleted
events.length = 0;
emit('character:set_folder', { characterId: ch.id, folderId: midFolder.id });
await waitEvent('character:updated', (c) => c.id === ch.id && c.folder_id === midFolder.id);

events.length = 0;
emit('character_folder:delete', { folderId: midFolder.id });
const deletedMid = await waitEvent('character_folder:deleted', (p) => p.folderId === midFolder.id);
check('deleting a nested folder reports its own parent for client navigation', deletedMid.parentFolderId === rootFolder.id);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check("directly-contained character promotes to the deleted folder's parent, not root", sheet.character.folder_id === rootFolder.id);
charFolders = (await jf('/api/character-folders')).body;
check("child folder promotes to the deleted folder's parent, not root", charFolders.find((f) => f.id === leafFolder.id).parent_id === rootFolder.id);

// Deleting a ROOT folder (no parent) promotes its contents/children to root
events.length = 0;
emit('character_folder:delete', { folderId: rootFolder.id });
const deletedRoot = await waitEvent('character_folder:deleted', (p) => p.folderId === rootFolder.id);
check('deleting a root folder promotes contents to root', deletedRoot.parentFolderId == null);
sheet = (await jf(`/api/characters/${ch.id}`)).body;
check('character that had promoted to root folder now at true root', sheet.character.folder_id === null);
charFolders = (await jf('/api/character-folders')).body;
check('grandchild folder promotes to root once its whole ancestor chain collapses', charFolders.find((f) => f.id === leafFolder.id).parent_id === null);

events.length = 0;
emit('character_folder:delete', { folderId: leafFolder.id });
await waitEvent('character_folder:deleted', (p) => p.folderId === leafFolder.id);
events.length = 0;
emit('character_folder:delete', { folderId: ghostParentFolder.id });
await waitEvent('character_folder:deleted', (p) => p.folderId === ghostParentFolder.id);

// --- global search: named library entities only (Characters/Moves/Perks/Tells/Tags) ---
let searchResults = (await jf('/api/search?q=aaron')).body;
check('search finds a character by name, case-insensitive', searchResults.characters.some((c) => c.id === ch.id));
searchResults = (await jf(`/api/search?q=${encodeURIComponent(jab.name)}`)).body;
check('search finds a move by name', searchResults.moves.some((m) => m.id === jab.id));
searchResults = (await jf('/api/search?q=poke')).body;
check('search finds a move by description substring', searchResults.moves.some((m) => m.id === jab.id));
searchResults = (await jf(`/api/search?q=${encodeURIComponent(tagA.description)}`)).body;
check('search finds a tag by description substring', searchResults.tags.some((t) => t.id === tagA.id));
searchResults = (await jf('/api/search?q=')).body;
check('empty query returns empty result sets, not everything', Object.values(searchResults).every((arr) => arr.length === 0));
searchResults = (await jf('/api/search?q=zzzznomatchzzzz')).body;
check(
  'no-match query returns empty arrays for every type',
  searchResults.characters.length === 0 && searchResults.moves.length === 0 &&
    searchResults.perks.length === 0 && searchResults.tells.length === 0 && searchResults.tags.length === 0
);

// --- chat history ---
const chat = (await jf('/api/chat')).body;
check('chat history has all rolls (9)', chat.length === 9, `got ${chat.length}`);
check('chat entries carry name + dice + total', chat.every((e) => e.characterName && Array.isArray(e.dice) && typeof e.total === 'number' && e.timestamp));

// --- Combat Arena (Phase 6: structure only, no round/Tic timing yet) ---
let combat = (await jf('/api/combat')).body;
check('fresh arena starts empty, Uneven Combat off', combat.participants.length === 0 && combat.unevenCombatEnabled === false);

events.length = 0;
emit('combat:add_participant', { characterId: ch.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === ch.id));
combat = (await jf('/api/combat')).body;
check('character seated on the left', combat.participants.find((p) => p.character_id === ch.id)?.side === 'left');
check(
  '/api/combat resolves the seated character + live dice',
  combat.characters[ch.id]?.character.id === ch.id && combat.characters[ch.id]?.dice.length === 8
);
check(
  '/api/combat includes the seated character\'s stances, for the active-stance badge',
  combat.characters[ch.id]?.stances.some((s) => s.id === combat.characters[ch.id].character.active_stance_id)
);

events.length = 0;
emit('combat:add_participant', { characterId: npc.id, side: 'right', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === npc.id));
check('NPC can be seated too (visibility exception is a client-side concern only)', true);

events.length = 0;
emit('combat:toggle_uneven', {});
await waitEvent('combat:updated', (c) => c.unevenCombatEnabled === true);
check('Uneven Combat toggles on', true);

const sidekick = await createFighter('Sidekick', 'pc');
events.length = 0;
emit('combat:add_participant', { characterId: sidekick.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === sidekick.id));
combat = (await jf('/api/combat')).body;
const leftPair0 = combat.participants.filter((p) => p.side === 'left' && p.pair_index === 0);
check(
  'Uneven Combat: two characters can share the same side/pair (2v1)',
  leftPair0.length === 2 && leftPair0.some((p) => p.character_id === ch.id) && leftPair0.some((p) => p.character_id === sidekick.id)
);

events.length = 0;
emit('combat:move_participant', { characterId: sidekick.id, side: 'right', pairIndex: 1 });
await waitEvent('combat:updated', (c) => c.participants.find((p) => p.character_id === sidekick.id)?.pair_index === 1);
combat = (await jf('/api/combat')).body;
const sidekickSeat = combat.participants.find((p) => p.character_id === sidekick.id);
check('move_participant re-seats an already-seated character', sidekickSeat.side === 'right' && sidekickSeat.pair_index === 1);

events.length = 0;
emit('combat:remove_participant', { characterId: sidekick.id });
await waitEvent('combat:updated', (c) => !c.participants.some((p) => p.character_id === sidekick.id));
check('remove_participant drops just that character', true);
await jf(`/api/characters/${sidekick.id}`, { method: 'DELETE' });

// standalone counters (characterId null) — blocked before Phase 6, now allowed
events.length = 0;
emit('counter:create', { characterId: null, name: 'Momentum', targetPips: 5, rewardType: 'story' });
const standaloneCounter = await waitEvent('counter:created', (c) => c.name === 'Momentum');
check('standalone counter created with null character_id', standaloneCounter.character_id === null);
check('reward silently dropped for a standalone counter, even when requested', standaloneCounter.reward_type === null);
combat = (await jf('/api/combat')).body;
check('/api/combat includes standalone counters', combat.counters.some((c) => c.id === standaloneCounter.id));

events.length = 0;
emit('counter:set_reward', { counterId: standaloneCounter.id, rewardType: 'story' });
await sleep(300);
check('counter:set_reward is a no-op on a standalone counter', !events.some((e) => e.ev === 'counter:updated'));

// a character counter only shows in the arena once flagged Show in Combat;
// its reward tag (purely cosmetic) travels with it once it does
events.length = 0;
emit('counter:create', { characterId: ch.id, name: 'Rage', targetPips: 5, rewardType: 'combat_prowess' });
const rageCounter = await waitEvent('counter:created', (c) => c.name === 'Rage' && c.character_id === ch.id);
combat = (await jf('/api/combat')).body;
check('character counter hidden from the arena until flagged', !combat.counters.some((c) => c.id === rageCounter.id));
events.length = 0;
emit('counter:toggle_show_in_combat', { counterId: rageCounter.id });
await waitEvent('counter:updated', (c) => c.id === rageCounter.id && c.show_in_combat === 1);
combat = (await jf('/api/combat')).body;
check('flagged character counter now included in the arena', combat.counters.some((c) => c.id === rageCounter.id));
check('its reward tag is included via /api/combat too', combat.counters.find((c) => c.id === rageCounter.id).reward_type === 'combat_prowess');

events.length = 0;
emit('counter:delete', { counterId: standaloneCounter.id });
await waitEvent('counter:deleted', (p) => p.counterId === standaloneCounter.id);
events.length = 0;
emit('counter:delete', { counterId: rageCounter.id });
await waitEvent('counter:deleted', (p) => p.counterId === rageCounter.id);

events.length = 0;
emit('combat:clear', {});
await waitEvent('combat:updated', (c) => c.participants.length === 0);
combat = (await jf('/api/combat')).body;
check('combat:clear empties the arena', combat.participants.length === 0);

// --- Phase 7: Combat Timing (declared_moves, Declaration Phase sequencing,
// Tic Countdown, reveal-vs-Tell, Next Round, overflow) ---
const rightFighter = await createFighter('Righty', 'pc');

events.length = 0;
emit('combat:add_participant', { characterId: ch.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === ch.id));
events.length = 0;
emit('combat:add_participant', { characterId: rightFighter.id, side: 'right', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === rightFighter.id));

events.length = 0;
emit('combat:next_round', {});
let p7state = await waitEvent('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
check('Next Round opens Declaration Phase', p7state.pairs[0].phase === 'declaration' && p7state.pairs[0].roundNumber === 1);
check('pair 0 has exactly one combat_pairs row with a side set to declare first', p7state.pairs.length === 1 && ['left', 'right'].includes(p7state.pairs[0].declaringSide));
check('Brain initiative rolled for both participants, posted to chat', events.filter((e) => e.ev === 'roll:result').length === 2);

const losingSide = p7state.pairs[0].declaringSide;
const winningSide = losingSide === 'left' ? 'right' : 'left';
const losingChar = losingSide === 'left' ? ch : rightFighter;
const winningChar = winningSide === 'left' ? ch : rightFighter;

events.length = 0;
emit('move:declare', { characterId: winningChar.id, moveId: jab.id });
await sleep(300);
check('declaring out of turn (before the losing side is done) is a silent no-op', !events.some((e) => e.ev === 'combat:updated'));

events.length = 0;
emit('move:declare', { characterId: 999999, moveId: jab.id });
await sleep(300);
check('declaring for an unseated/unknown character is a silent no-op', !events.some((e) => e.ev === 'combat:updated'));

// actor logs in as the declaring character itself — combat:updated is now
// tailored per socket (see mapDeclaredMovesForViewer), so actor's own copy
// should reveal this move immediately while watcher (still unidentified)
// keeps seeing Tell-only.
emit('identity:set', { role: 'player', characterId: losingChar.id });
await sleep(150);
events.length = 0;
actorEvents.length = 0;
emit('move:declare', { characterId: losingChar.id, moveId: jab.id });
let dUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === losingChar.id));
let losingDeclared = dUpdate.declaredMoves.find((dm) => dm.characterId === losingChar.id);
check('declared move is Tell-only to an unidentified/other viewer', losingDeclared.moveId === null && losingDeclared.moveName === null && losingDeclared.isRevealed === false);
check('placement Tic is the round\'s start Tic for a first-ever move', losingDeclared.placementTic === dUpdate.pairs[0].roundStartTic);
check('reveal Tic is placement + Startup (Jab: 2)', losingDeclared.revealTic === losingDeclared.placementTic + 2);
const ownUpdate = await waitActorEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === losingChar.id));
const ownDeclared = ownUpdate.declaredMoves.find((dm) => dm.characterId === losingChar.id);
check(
  'the player logged in as the declaring character sees the real move on their own combat:updated',
  ownDeclared.isRevealed === true && ownDeclared.moveId === jab.id && ownDeclared.moveName === 'Jab' && ownDeclared.staminaCost === 0
);

events.length = 0;
emit('combat:character_done_declaring', { characterId: winningChar.id });
await sleep(300);
check('marking done for a character whose side isn\'t open yet is a no-op', !events.some((e) => e.ev === 'combat:updated'));

events.length = 0;
emit('combat:character_done_declaring', { characterId: losingChar.id });
dUpdate = await waitEvent('combat:updated', (c) => c.pairs[0].declaringSide === winningSide);
check('losing character done declaring opens the winning side of the pair', dUpdate.pairs[0].declaringSide === winningSide);

events.length = 0;
emit('move:declare', { characterId: winningChar.id, moveId: jab.id });
await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === winningChar.id));
check('winning side can now declare', true);

// Switch identity to the OTHER character — no new declare needed, since
// visibility is recomputed fresh on every broadcast from whatever
// socket.data.identity currently holds (see mapDeclaredMovesForViewer);
// the next combat:updated (triggered below) is enough to observe it.
emit('identity:set', { role: 'player', characterId: winningChar.id });
await sleep(150);

// --- Combat Automation overhaul: the round resolves itself ---
// There is no Start Tic Countdown button, no Tic Forward/Backward, and no
// Next Round any more. The last Done Declaring in a pair drops it into
// Resolving, the engine runs the whole round Tic by Tic, and the pair rolls
// straight into its own next round's Declaration Phase — all inside that one
// emit. So rather than stepping and asserting per Tic, this asserts the
// round's *outcome*: that it happened, that it was logged, and that the pair
// came out the other side in round 2.
actorEvents.length = 0;
events.length = 0;
roundEvents.length = 0;
// The anonymous watcher must stay empty throughout — the secrecy assertion
// below depends on it.
const anonRoundEvents = [];
watcher.on('combat:round_event', (payload) => anonRoundEvents.push(payload));
emit('combat:character_done_declaring', { characterId: winningChar.id });

// The pair ends up back in Declaration for round 2, entirely on its own.
dUpdate = await waitEvent(
  'combat:updated',
  (c) => c.pairs[0].phase === 'declaration' && c.pairs[0].roundNumber === 2,
  8000
);
check('the last Done Declaring resolves the whole round automatically and opens round 2', true);
check('no manual step was needed to get there', dUpdate.pairs[0].roundNumber === 2);

// The round_events land on gmWatcher, a different socket from the one
// waitEvent above watches — so wait for the log itself to arrive rather
// than assuming the combat:updated implies it has.
await waitFor(() => roundEvents.some((e) => e.type === 'round_complete'), 5000);

// round_events: the engine's own log, pushed live to this pair's audience.
check('the round pushed round_event(s) live to the GM', roundEvents.length > 0, `got ${roundEvents.length}`);
check(
  'round_events fail closed: a socket that never identified itself receives none of them',
  anonRoundEvents.length === 0,
  `anonymous socket saw ${anonRoundEvents.length}`
);
check(
  'both fighters\' Jabs revealed as round_events',
  roundEvents.filter((e) => e.type === 'reveal').length === 2,
  JSON.stringify(roundEvents.map((e) => e.type))
);
check(
  'a reveal event carries the whole footprint, so a replay is self-contained',
  roundEvents
    .filter((e) => e.type === 'reveal')
    .every(
      (e) =>
        e.payload.moveName === 'Jab' &&
        e.payload.characterName &&
        typeof e.payload.placementTic === 'number' &&
        typeof e.payload.revealTic === 'number' &&
        typeof e.payload.activeEndTic === 'number' &&
        typeof e.payload.recoveryEndTic === 'number' &&
        Array.isArray(e.payload.defenseFramePositions)
    ),
  JSON.stringify(roundEvents.find((e) => e.type === 'reveal')?.payload)
);
check('the round closed with a round_complete event', roundEvents.some((e) => e.type === 'round_complete'));
check(
  'every round_event is tagged with its own pair and round',
  roundEvents.every((e) => e.pairIndex === 0 && e.roundNumber === 1 && typeof e.seq === 'number')
);
check(
  'round_event seq is strictly increasing',
  roundEvents.every((e, i) => i === 0 || e.seq > roundEvents[i - 1].seq)
);

// --- The round_summary chat card + its replay ---
let chatSoFar = (await jf('/api/chat')).body;
const summaries = chatSoFar.filter((e) => e.kind === 'round_summary');
check('exactly one round_summary chat card is posted for the round', summaries.length === 1);
check(
  'the round_summary card names both sides and carries its resolutionId',
  summaries[0]?.roundNumber === 1 &&
    summaries[0]?.pairIndex === 0 &&
    Array.isArray(summaries[0]?.leftNames) &&
    Array.isArray(summaries[0]?.rightNames) &&
    summaries[0]?.leftNames.length === 1 &&
    summaries[0]?.rightNames.length === 1 &&
    typeof summaries[0]?.resolutionId === 'number',
  JSON.stringify(summaries[0])
);
check(
  'the per-reveal lane_snapshot spam it replaced is gone',
  chatSoFar.filter((e) => e.kind === 'lane_snapshot').length === 0
);

const replay = (await jf(`/api/combat/round-replay/${summaries[0].resolutionId}`)).body;
check('the replay endpoint serves the round back', replay?.roundNumber === 1 && replay?.pairIndex === 0);
check('the replay is complete', replay.status === 'complete' && replay.events.length === roundEvents.length);
check(
  'the replay is the same log, in the same order, that was pushed live',
  replay.events.every((e, i) => e.seq === roundEvents[i].seq && e.type === roundEvents[i].type)
);
check(
  'the replay carries its participants so it can render standalone',
  replay.participants.length === 2 && replay.participants.every((p) => p.name && p.side)
);
check('a replay of a non-existent round 404s', (await jf('/api/combat/round-replay/999999')).status === 404);

// The removed manual controls are genuinely gone server-side, not just
// hidden in the UI — a stale client (or a hand-crafted payload) can't step
// a pair's clock behind the engine's back.
for (const dead of ['combat:start_tic_countdown', 'combat:tic_forward', 'combat:tic_backward']) {
  events.length = 0;
  emit(dead, { pairIndex: 0 });
  await sleep(200);
  check(`${dead} no longer exists (no state change)`, !events.some((e) => e.ev === 'combat:updated'));
}

const round2Declaring = dUpdate.pairs[0].declaringSide === losingSide ? losingChar : winningChar;
const round1FootprintForThatChar = dUpdate.declaredMoves.find((dm) => dm.characterId === round2Declaring.id && dm.roundNumber === 1);
events.length = 0;
emit('move:declare', { characterId: round2Declaring.id, moveId: jab.id });
dUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.filter((dm) => dm.characterId === round2Declaring.id).length === 2);
const round2Declared = dUpdate.declaredMoves.find((dm) => dm.characterId === round2Declaring.id && dm.roundNumber === 2);
check(
  'overflow carries with no special-casing: this character\'s next placement Tic is max(round 2 start, their round-1 move\'s full footprint end)',
  round2Declared.placementTic === Math.max(dUpdate.pairs[0].roundStartTic, round1FootprintForThatChar.recoveryEndTic)
);

// --- Explicit placementTic: dragging a move onto the Tic Counter picks a
// specific Tic, not just the earliest legal one — but never earlier than
// the character's own next-eligible Tic (server clamps forward instead of
// rejecting) ---
const latestFor = (state) =>
  state.declaredMoves
    .filter((dm) => dm.characterId === round2Declaring.id)
    .sort((a, b) => b.id - a.id)[0]; // highest id = most recently declared

const round2Min = Math.max(dUpdate.pairs[0].roundStartTic, round2Declared.recoveryEndTic);
events.length = 0;
emit('move:declare', { characterId: round2Declaring.id, moveId: jab.id, placementTic: round2Min + 5 });
dUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.filter((dm) => dm.characterId === round2Declaring.id).length === 3);
const explicitDeclared = latestFor(dUpdate);
check('an explicit placementTic at/after the legal minimum is honored exactly', explicitDeclared.placementTic === round2Min + 5);

events.length = 0;
emit('move:declare', { characterId: round2Declaring.id, moveId: jab.id, placementTic: 0 });
dUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.filter((dm) => dm.characterId === round2Declaring.id).length === 4);
const clampedDeclared = latestFor(dUpdate);
const clampedMin = Math.max(dUpdate.pairs[0].roundStartTic, explicitDeclared.recoveryEndTic);
check(
  'an explicit placementTic before the legal minimum snaps forward to the minimum instead of being rejected',
  clampedDeclared.placementTic === clampedMin
);

// --- End Combat: the global header's toggle — unlike Clear Arena, the
// roster stays seated so a fresh fight can start without re-seating ---
events.length = 0;
emit('combat:end', {});
dUpdate = await waitEvent('combat:updated', (c) => c.pairs.length === 0);
check(
  'combat:end empties combat_pairs and declaredMoves but leaves the roster seated',
  dUpdate.pairs.length === 0 &&
    dUpdate.declaredMoves.length === 0 &&
    dUpdate.participants.length === 2
);

events.length = 0;
emit('combat:clear', {});
dUpdate = await waitEvent('combat:updated', (c) => c.participants.length === 0);
check('combat:clear empties combat_pairs/declaredMoves/participants', dUpdate.pairs.length === 0 && dUpdate.declaredMoves.length === 0);

// --- Stamina Cost: required on every move (0 is valid, negative restores
// instead of spending), only actually subtracted in one batch once the
// declaring side finishes declaring — move:declare itself only checks
// affordability up front against current_stamina minus every other pending
// (not yet committed) move ---
events.length = 0;
emit('move:create', { name: 'Costly Strike', isDefault: true, tellId: tells[0].id, startupTics: 1, activeTics: 1, recoveryTics: 0, staminaCost: 5, description: '', interactions: {} });
const costlyStrike = await waitEvent('move:created', (m) => m.name === 'Costly Strike');
check('Stamina Cost is stored on the move', costlyStrike.stamina_cost === 5);

events.length = 0;
emit('move:create', { name: 'Second Wind', isDefault: true, tellId: tells[1].id, startupTics: 1, activeTics: 1, recoveryTics: 0, staminaCost: -3, description: '', interactions: {} });
const secondWind = await waitEvent('move:created', (m) => m.name === 'Second Wind');
check('a negative Stamina Cost is stored (restores instead of spending)', secondWind.stamina_cost === -3);

events.length = 0;
emit('move:create', { name: 'Overkill', isDefault: true, tellId: tells[0].id, startupTics: 1, activeTics: 1, recoveryTics: 0, staminaCost: 999, description: '', interactions: {} });
const overkill = await waitEvent('move:created', (m) => m.name === 'Overkill');
check('Stamina Cost clamps to +/-20, same as roll bonus', overkill.stamina_cost === 20);

// Fresh, never-before-mutated characters — ch/rightFighter have been
// through the whole script's worth of regen rolls/adjust/lock/step by this
// point, so their Stamina can't be assumed to still be a known value.
const staminaA = await createFighter('Stamina Test A', 'pc');
const staminaB = await createFighter('Stamina Test B', 'pc');

events.length = 0;
emit('combat:add_participant', { characterId: staminaA.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === staminaA.id));
events.length = 0;
emit('combat:add_participant', { characterId: staminaB.id, side: 'right', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === staminaB.id));

events.length = 0;
emit('combat:next_round', {});
p7state = await waitEvent('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const costSide = p7state.pairs[0].declaringSide;
const otherCostSide = costSide === 'left' ? 'right' : 'left';
const costChar = costSide === 'left' ? staminaA : staminaB;
const otherChar = costSide === 'left' ? staminaB : staminaA;

const beforeCost = (await jf(`/api/characters/${costChar.id}`)).body.character;
check('character starts at full Stamina before any declares', beforeCost.current_stamina === beforeCost.max_stamina);

emit('identity:set', { role: 'player', characterId: costChar.id });
await sleep(150);
events.length = 0;
actorEvents.length = 0;
emit('move:declare', { characterId: costChar.id, moveId: overkill.id });
await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === costChar.id));
const ownCostUpdate = await waitActorEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === costChar.id && dm.moveId === overkill.id));
const ownCostDeclared = ownCostUpdate.declaredMoves.find((dm) => dm.characterId === costChar.id);
check('a move costing exactly what\'s affordable (20 of 32) is declared, staminaCost visible to the declaring character\'s own player', ownCostDeclared.staminaCost === 20);

events.length = 0;
emit('move:declare', { characterId: costChar.id, moveId: overkill.id });
await sleep(300);
check('declaring a second copy that would exceed current Stamina (20+20=40 > 32) is a silent no-op', !events.some((e) => e.ev === 'combat:updated'));

events.length = 0;
emit('move:declare', { characterId: costChar.id, moveId: costlyStrike.id });
await waitEvent('combat:updated', (c) => c.declaredMoves.filter((dm) => dm.characterId === costChar.id).length === 2);
check('a second, cheaper move (5) still fits the remaining pending budget (32-20=12 >= 5)', true);

const stillBefore = (await jf(`/api/characters/${costChar.id}`)).body.character;
check('Stamina Cost is only a visual preview until the side finishes declaring — current_stamina untouched so far', stillBefore.current_stamina === beforeCost.max_stamina);

events.length = 0;
emit('combat:character_done_declaring', { characterId: costChar.id });
const costCharUpdate = await waitEvent('character:updated', (c) => c.id === costChar.id);
check('Stamina Cost is subtracted in one batch (20 + 5 = 25) once the side finishes declaring', costCharUpdate.current_stamina === beforeCost.max_stamina - 25, `expected ${beforeCost.max_stamina - 25}, got ${costCharUpdate.current_stamina}`);
const afterCommit = (await jf(`/api/characters/${costChar.id}`)).body.character;
check('the committed value persists', afterCommit.current_stamina === beforeCost.max_stamina - 25, `expected ${beforeCost.max_stamina - 25}, got ${afterCommit.current_stamina}`);

const beforeOther = (await jf(`/api/characters/${otherChar.id}`)).body.character;
emit('identity:set', { role: 'player', characterId: otherChar.id });
await sleep(150);
events.length = 0;
actorEvents.length = 0;
emit('move:declare', { characterId: otherChar.id, moveId: secondWind.id });
await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === otherChar.id));
const ownOtherUpdate = await waitActorEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === otherChar.id && dm.moveId === secondWind.id));
const ownOtherDeclared = ownOtherUpdate.declaredMoves.find((dm) => dm.characterId === otherChar.id);
check('a negative-cost move is declarable too, staminaCost visible to the declaring character\'s own player', ownOtherDeclared.staminaCost === -3);

events.length = 0;
emit('combat:character_done_declaring', { characterId: otherChar.id });
const otherCharUpdate = await waitEvent('character:updated', (c) => c.id === otherChar.id);
check('a negative Stamina Cost restores Stamina, clamped at max (already full, so unchanged)', otherCharUpdate.current_stamina === beforeOther.max_stamina, `expected ${beforeOther.max_stamina}, got ${otherCharUpdate.current_stamina}`);

events.length = 0;
emit('combat:clear', {});
await waitEvent('combat:updated', (c) => c.participants.length === 0);

await jf(`/api/characters/${staminaA.id}`, { method: 'DELETE' });
await jf(`/api/characters/${staminaB.id}`, { method: 'DELETE' });

// --- Identity fairness (decided): GM sees NPC moves early — the GM
// effectively declared them — but a Player's move stays exactly as hidden
// from the GM as from anyone else, since the GM is an adversarial party
// here, not an omniscient narrator ---
const fairPc = await createFighter('Fairness PC', 'pc');
const fairNpc = await createFighter('Fairness NPC', 'npc');

events.length = 0;
emit('combat:add_participant', { characterId: fairPc.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === fairPc.id));
events.length = 0;
emit('combat:add_participant', { characterId: fairNpc.id, side: 'right', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === fairNpc.id));

events.length = 0;
emit('combat:next_round', {});
let fairState = await waitEvent('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

// Declare for whichever side opens first, mark it done, then declare for
// the other side but DELIBERATELY leave it un-finished — order-agnostic
// since initiative is randomly rolled.
//
// Combat Automation overhaul: the second side must not be marked done here.
// Finishing the last declaration is now what starts resolution, and the
// round runs to completion inside that one emit — every move reveals, so
// there'd be no "declared but not yet revealed" state left to test. Leaving
// the pair one Done Declaring short keeps it in Declaration Phase with both
// moves on the board, which is exactly the window this secrecy check is
// about.
for (let round = 0; round < 2; round++) {
  const side = fairState.pairs[0].declaringSide;
  const charForSide = side === 'left' ? fairPc : fairNpc;
  events.length = 0;
  emit('move:declare', { characterId: charForSide.id, moveId: jab.id });
  fairState = await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === charForSide.id));
  if (round === 0) {
    events.length = 0;
    emit('combat:character_done_declaring', { characterId: charForSide.id });
    fairState = await waitEvent('combat:updated', () => true);
  }
}
check(
  'the pair is still Declaring (one side deliberately unfinished), so nothing has revealed yet',
  fairState.pairs[0].phase === 'declaration'
);

// combat:toggle_uneven is a harmless GM-only flip used purely to force a
// fresh combat:updated broadcast under the new identity — identity:set
// itself doesn't broadcast anything on its own.
emit('identity:set', { role: 'gm' });
await sleep(150);
actorEvents.length = 0;
emit('combat:toggle_uneven', {});
const gmView = await waitActorEvent('combat:updated', () => true);
emit('combat:toggle_uneven', {});
await sleep(150);

const gmSeesNpc = gmView.declaredMoves.find((dm) => dm.characterId === fairNpc.id);
check('GM sees an NPC\'s declared move early, before its reveal Tic', gmSeesNpc.isRevealed === true && gmSeesNpc.moveId === jab.id);
const gmSeesPc = gmView.declaredMoves.find((dm) => dm.characterId === fairPc.id);
check('GM does NOT see a Player\'s declared move early — fairness, same as any other viewer', gmSeesPc.isRevealed === false && gmSeesPc.moveId === null);

emit('identity:set', { role: 'player', characterId: fairPc.id });
await sleep(150);
actorEvents.length = 0;
emit('combat:toggle_uneven', {});
const playerView = await waitActorEvent('combat:updated', () => true);
emit('combat:toggle_uneven', {});
await sleep(150);

const playerSeesOwn = playerView.declaredMoves.find((dm) => dm.characterId === fairPc.id);
check('a Player sees their own character\'s move early', playerSeesOwn.isRevealed === true && playerSeesOwn.moveId === jab.id);
const playerSeesNpc = playerView.declaredMoves.find((dm) => dm.characterId === fairNpc.id);
check('a Player does not see an NPC\'s move early either', playerSeesNpc.isRevealed === false && playerSeesNpc.moveId === null);

events.length = 0;
emit('combat:clear', {});
await waitEvent('combat:updated', (c) => c.participants.length === 0);
await jf(`/api/characters/${fairPc.id}`, { method: 'DELETE' });
await jf(`/api/characters/${fairNpc.id}`, { method: 'DELETE' });

// --- Ambiguous moves: a move with a Left/Right Roll slot requires a
// declare-time appendage choice (the client's popup — see
// CombatHeaderBar.jsx's pendingDeclare) — server-enforced, not just a UI
// nicety, and stored on the declared_moves row so it's recoverable after a
// reload (unlike tellId/rightTellId/leftTellId, it's never secret, same
// reasoning as the Tell itself: it's visible the instant the move
// declares, whoever's watching) ---
const ambigLeft = await createFighter('Ambig Left', 'pc');
const ambigRight = await createFighter('Ambig Right', 'pc');

events.length = 0;
emit('move:create', {
  name: 'Cross Punch', isDefault: true,
  rightTellId: tells[0].id, leftTellId: tells[1].id,
  rollSlots: ['Hand'], rollModifier: 0,
  startupTics: 1, activeTics: 1, recoveryTics: 0, description: '', interactions: {},
});
const crossPunch = await waitEvent('move:created', (m) => m.name === 'Cross Punch');

events.length = 0;
emit('combat:add_participant', { characterId: ambigLeft.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === ambigLeft.id));
events.length = 0;
emit('combat:add_participant', { characterId: ambigRight.id, side: 'right', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === ambigRight.id));

events.length = 0;
emit('combat:next_round', {});
const ambigState = await waitEvent('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const ambigSide = ambigState.pairs[0].declaringSide;
const ambigChar = ambigSide === 'left' ? ambigLeft : ambigRight;

events.length = 0;
emit('move:declare', { characterId: ambigChar.id, moveId: crossPunch.id });
await sleep(300);
check(
  'ambiguous move declared without an appendageChoice is a silent no-op',
  !events.some((e) => e.ev === 'combat:updated' && e.payload.declaredMoves.some((dm) => dm.characterId === ambigChar.id))
);

events.length = 0;
emit('move:declare', { characterId: ambigChar.id, moveId: crossPunch.id, appendageChoice: 'sideways' });
await sleep(300);
check(
  'an invalid appendageChoice is also a silent no-op',
  !events.some((e) => e.ev === 'combat:updated' && e.payload.declaredMoves.some((dm) => dm.characterId === ambigChar.id))
);

events.length = 0;
emit('move:declare', { characterId: ambigChar.id, moveId: crossPunch.id, appendageChoice: 'left' });
const ambigUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === ambigChar.id));
const ambigDm = ambigUpdate.declaredMoves.find((dm) => dm.characterId === ambigChar.id);
check(
  'a valid appendageChoice declares the move and is recorded on it, visible to any viewer like the Tell itself',
  ambigDm.appendageChoice === 'left' && ambigDm.rightTellId === tells[0].id && ambigDm.leftTellId === tells[1].id,
  JSON.stringify(ambigDm)
);

events.length = 0;
emit('combat:character_done_declaring', { characterId: ambigChar.id });
await waitEvent('combat:updated', () => true);
const otherAmbigChar = ambigSide === 'left' ? ambigRight : ambigLeft;
events.length = 0;
emit('move:declare', { characterId: otherAmbigChar.id, moveId: jab.id, appendageChoice: 'left' });
const otherUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === otherAmbigChar.id));
const otherDm = otherUpdate.declaredMoves.find((dm) => dm.characterId === otherAmbigChar.id);
check(
  'a non-ambiguous move ignores an appendageChoice sent alongside it',
  otherDm.appendageChoice === null,
  JSON.stringify(otherDm)
);

events.length = 0;
emit('combat:clear', {});
await waitEvent('combat:updated', (c) => c.participants.length === 0);

// --- Full footprint blocking (decided, revised): a character's next move
// can't be placed until their previous move's ENTIRE footprint (Startup +
// Active + Recovery) ends, not just past its reveal Tic ---
const fpLeft = await createFighter('Footprint Left', 'npc');
const fpRight = await createFighter('Footprint Right', 'npc');

events.length = 0;
emit('move:create', {
  name: 'Long Recovery Move', isDefault: true, tellId: tells[0].id,
  startupTics: 1, activeTics: 2, recoveryTics: 3, description: '', interactions: {},
});
const longMove = await waitEvent('move:created', (m) => m.name === 'Long Recovery Move');

events.length = 0;
emit('combat:add_participant', { characterId: fpLeft.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === fpLeft.id));
events.length = 0;
emit('combat:add_participant', { characterId: fpRight.id, side: 'right', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === fpRight.id));

events.length = 0;
emit('combat:next_round', {});
const fpState = await waitEvent('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
const fpSide = fpState.pairs[0].declaringSide;
const fpChar = fpSide === 'left' ? fpLeft : fpRight;

// Startup 1, Active 2, Recovery 3, placed at round start (tic T): reveals at
// T+1, footprint ends (recoveryEndTic) at T+1+2+3 = T+6.
events.length = 0;
emit('move:declare', { characterId: fpChar.id, moveId: longMove.id });
let fpUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === fpChar.id));
const firstDm = fpUpdate.declaredMoves.find((dm) => dm.characterId === fpChar.id);
check(
  'recoveryEndTic reflects the full Startup+Active+Recovery footprint',
  firstDm.recoveryEndTic === firstDm.revealTic + 2 + 3,
  JSON.stringify(firstDm)
);

// Try to declare a second move at a Tic that's past the first move's reveal
// (its old, no-longer-correct floor) but still inside its Active/Recovery —
// it must clamp all the way to recoveryEndTic, not just snap to revealTic.
events.length = 0;
emit('move:declare', {
  characterId: fpChar.id,
  moveId: jab.id,
  placementTic: firstDm.revealTic, // squarely inside the first move's Active window
});
fpUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.filter((dm) => dm.characterId === fpChar.id).length === 2);
const secondDm = fpUpdate.declaredMoves.filter((dm) => dm.characterId === fpChar.id).find((dm) => dm.id !== firstDm.id);
check(
  'a follow-up move can\'t be placed during the prior move\'s Active/Recovery — clamped to the full footprint end, not just past its reveal',
  secondDm.placementTic === firstDm.recoveryEndTic,
  `expected ${firstDm.recoveryEndTic}, got ${secondDm.placementTic}`
);

// --- move:undeclare: a still-pending (not yet Stamina-committed) declared
// move can be taken back and something else declared instead ---
events.length = 0;
emit('move:undeclare', { declaredMoveId: 999999 });
await sleep(300);
check('undeclaring a nonexistent row is a silent no-op', !events.some((e) => e.ev === 'combat:updated'));

events.length = 0;
emit('move:undeclare', { declaredMoveId: secondDm.id });
fpUpdate = await waitEvent('combat:updated', (c) => !c.declaredMoves.some((dm) => dm.id === secondDm.id));
check(
  'canceling a pending declared move removes it entirely',
  !fpUpdate.declaredMoves.some((dm) => dm.id === secondDm.id) &&
    fpUpdate.declaredMoves.some((dm) => dm.id === firstDm.id)
);

// With the second move taken back, the character can now declare a
// different one landing wherever they like again (still bounded by the
// first move's still-standing footprint).
events.length = 0;
emit('move:declare', { characterId: fpChar.id, moveId: jab.id });
fpUpdate = await waitEvent('combat:updated', (c) => c.declaredMoves.filter((dm) => dm.characterId === fpChar.id).length === 2);
const thirdDm = fpUpdate.declaredMoves.filter((dm) => dm.characterId === fpChar.id).find((dm) => dm.id !== firstDm.id);
check('a fresh declare after canceling lands at the same legal floor as before', thirdDm.placementTic === firstDm.recoveryEndTic);

// Once the side finishes declaring, the committed move can no longer be
// undeclared — same silent no-op as any other rejected declare/undeclare.
events.length = 0;
emit('combat:character_done_declaring', { characterId: fpChar.id });
await waitEvent('combat:updated', (c) => c.pairs[0].declaringSide !== fpSide);
events.length = 0;
emit('move:undeclare', { declaredMoveId: firstDm.id });
await sleep(300);
check(
  'a committed move (side already done declaring) can no longer be undeclared',
  !events.some((e) => e.ev === 'combat:updated')
);

events.length = 0;
emit('combat:clear', {});
await waitEvent('combat:updated', (c) => c.participants.length === 0);
events.length = 0;
emit('move:delete', { moveId: longMove.id });
await waitEvent('move:deleted', (p) => p.moveId === longMove.id);
await jf(`/api/characters/${fpLeft.id}`, { method: 'DELETE' });
await jf(`/api/characters/${fpRight.id}`, { method: 'DELETE' });

events.length = 0;
emit('combat:clear', {});
await waitEvent('combat:updated', (c) => c.participants.length === 0);
events.length = 0;
emit('move:delete', { moveId: crossPunch.id });
await waitEvent('move:deleted', (p) => p.moveId === crossPunch.id);
await jf(`/api/characters/${ambigLeft.id}`, { method: 'DELETE' });
await jf(`/api/characters/${ambigRight.id}`, { method: 'DELETE' });

// --- Multiple pairs declare independently and simultaneously (decided,
// combat redesign): pair 1's losing side and pair 2's losing side can both
// be mid-Declaration at the same time even though they might be literal
// opposite "sides" — declaration is scoped per pair (combat_pairs), not one
// shared batch across the whole arena like Phase 7 originally had it ---
const mpA = await createFighter('MultiPair A', 'pc');
const mpB = await createFighter('MultiPair B', 'pc');
const mpC = await createFighter('MultiPair C', 'pc');
const mpD = await createFighter('MultiPair D', 'pc');

events.length = 0;
emit('combat:add_participant', { characterId: mpA.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === mpA.id));
emit('combat:add_participant', { characterId: mpB.id, side: 'right', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === mpB.id));
emit('combat:add_participant', { characterId: mpC.id, side: 'left', pairIndex: 1 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === mpC.id));
emit('combat:add_participant', { characterId: mpD.id, side: 'right', pairIndex: 1 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === mpD.id));

events.length = 0;
emit('combat:next_round', {});
let mpState = await waitEvent('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
check('two combat_pairs rows exist, one per pairIndex', mpState.pairs.length === 2);
const mpPair0 = mpState.pairs.find((p) => p.pairIndex === 0);
const mpPair1 = mpState.pairs.find((p) => p.pairIndex === 1);
check('both pairs have their own declaringSide independently resolved', ['left', 'right'].includes(mpPair0.declaringSide) && ['left', 'right'].includes(mpPair1.declaringSide));

const mpDeclarer0 = mpPair0.declaringSide === 'left' ? mpA : mpB;
const mpOther0 = mpPair0.declaringSide === 'left' ? mpB : mpA;
const mpDeclarer1 = mpPair1.declaringSide === 'left' ? mpC : mpD;
const mpOther1 = mpPair1.declaringSide === 'left' ? mpD : mpC;

events.length = 0;
emit('move:declare', { characterId: mpDeclarer0.id, moveId: jab.id });
emit('move:declare', { characterId: mpDeclarer1.id, moveId: jab.id });
await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === mpDeclarer0.id) && c.declaredMoves.some((dm) => dm.characterId === mpDeclarer1.id));
check('pair 0 and pair 1 can both declare in the same window — genuinely independent/simultaneous, not batched', true);

events.length = 0;
emit('move:declare', { characterId: mpOther0.id, moveId: jab.id });
await sleep(300);
check('the not-yet-eligible side of pair 0 still can\'t declare while pair 0\'s own turn hasn\'t flipped', !events.some((e) => e.ev === 'combat:updated' && e.payload.declaredMoves.some((dm) => dm.characterId === mpOther0.id)));

// Finish pair 0 entirely (both sides) while pair 1 is still sitting fully
// mid-Declaration (only its first side has declared) — this is Phase B's
// core claim: pair 0 must be able to start and step its OWN Tic Countdown
// without requiring, waiting for, or in any way touching pair 1's state.
events.length = 0;
emit('combat:character_done_declaring', { characterId: mpDeclarer0.id });
let mpUpdate = await waitEvent('combat:updated', (c) => c.pairs.find((p) => p.pairIndex === 0).declaringSide !== mpPair0.declaringSide);
check('pair 0 flips to its other side once that side finishes', mpUpdate.pairs.find((p) => p.pairIndex === 0).declaringSide === (mpPair0.declaringSide === 'left' ? 'right' : 'left'));
check('pair 1 is completely unaffected by pair 0 finishing', mpUpdate.pairs.find((p) => p.pairIndex === 1).declaringSide === mpPair1.declaringSide);

const mpCharAfter = (await jf(`/api/characters/${mpDeclarer0.id}`)).body.character;
check('Stamina committed per-character (not batched by side) the moment they finish', mpCharAfter.current_stamina === mpCharAfter.max_stamina, `expected full, got ${mpCharAfter.current_stamina}/${mpCharAfter.max_stamina}`);

// Pair 1 is STILL mid-Declaration here (only mpDeclarer1 has gone). Finish
// pair 0's remaining side: that alone resolves pair 0's ENTIRE round
// automatically and rolls it into round 2, while pair 1 sits untouched in
// round 1 Declaration. This is decision #12's "no fight ever waits on
// another" in its strongest form — the two pairs end up on different rounds.
events.length = 0;
emit('move:declare', { characterId: mpOther0.id, moveId: jab.id });
await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === mpOther0.id));
emit('combat:character_done_declaring', { characterId: mpOther0.id });
mpUpdate = await waitEvent(
  'combat:updated',
  (c) => c.pairs.find((p) => p.pairIndex === 0).roundNumber === 2,
  8000
);
check(
  'pair 0 resolves its whole round and opens round 2 on its own, with pair 1 still mid-Declaration',
  mpUpdate.pairs.find((p) => p.pairIndex === 0).roundNumber === 2 &&
    mpUpdate.pairs.find((p) => p.pairIndex === 0).phase === 'declaration'
);
check(
  'pair 1 never moved: still round 1, still Declaring, still on its own Tic',
  mpUpdate.pairs.find((p) => p.pairIndex === 1).roundNumber === 1 &&
    mpUpdate.pairs.find((p) => p.pairIndex === 1).phase === 'declaration' &&
    mpUpdate.pairs.find((p) => p.pairIndex === 1).currentTic === mpPair1.currentTic
);
check(
  'the two pairs are genuinely on different rounds at the same time',
  mpUpdate.pairs.find((p) => p.pairIndex === 0).roundNumber !==
    mpUpdate.pairs.find((p) => p.pairIndex === 1).roundNumber
);

// Now finish pair 1's declaration too — it resolves its own round just as
// independently, long after pair 0 already finished one.
events.length = 0;
emit('combat:character_done_declaring', { characterId: mpDeclarer1.id });
await waitEvent('combat:updated', (c) => c.pairs.find((p) => p.pairIndex === 1).declaringSide !== mpPair1.declaringSide);
events.length = 0;
emit('move:declare', { characterId: mpOther1.id, moveId: jab.id });
await waitEvent('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === mpOther1.id));
const pair0RoundBefore = mpUpdate.pairs.find((p) => p.pairIndex === 0).roundNumber;
emit('combat:character_done_declaring', { characterId: mpOther1.id });
mpUpdate = await waitEvent(
  'combat:updated',
  (c) => c.pairs.find((p) => p.pairIndex === 1).roundNumber === 2,
  8000
);
check('pair 1 resolves its own round on its own schedule', mpUpdate.pairs.find((p) => p.pairIndex === 1).roundNumber === 2);
check(
  'pair 0 was not dragged along by pair 1 resolving',
  mpUpdate.pairs.find((p) => p.pairIndex === 0).roundNumber === pair0RoundBefore
);

// Each pair logged its own round independently.
const mpChat = (await jf('/api/chat')).body;
const mpSummaries = mpChat.filter((e) => e.kind === 'round_summary');
check(
  'each pair posted its own round_summary card',
  mpSummaries.some((e) => e.pairIndex === 0) && mpSummaries.some((e) => e.pairIndex === 1),
  JSON.stringify(mpSummaries.map((e) => ({ pair: e.pairIndex, round: e.roundNumber })))
);

events.length = 0;
emit('combat:clear', {});
await waitEvent('combat:updated', (c) => c.participants.length === 0);
await jf(`/api/characters/${mpA.id}`, { method: 'DELETE' });
await jf(`/api/characters/${mpB.id}`, { method: 'DELETE' });
await jf(`/api/characters/${mpC.id}`, { method: 'DELETE' });
await jf(`/api/characters/${mpD.id}`, { method: 'DELETE' });

await jf(`/api/characters/${rightFighter.id}`, { method: 'DELETE' });

// re-seat ch alone so the character-delete cascade check below also
// exercises combat_participants cleanup
events.length = 0;
emit('combat:add_participant', { characterId: ch.id, side: 'left', pairIndex: 0 });
await waitEvent('combat:updated', (c) => c.participants.some((p) => p.character_id === ch.id));

// --- name + portrait update ---
events.length = 0;
const renamed = await jpost(`/api/characters/${ch.id}`, { name: 'Aaron the Fist', imageData: 'aGVsbG8=', imageMimeType: 'image/jpeg' }, 'PUT');
check('rename + portrait via PUT', renamed.body.name === 'Aaron the Fist' && renamed.body.image_data === 'aGVsbG8=');
await waitEvent('character:updated', (c) => c.id === ch.id && c.name === 'Aaron the Fist');
check('character:updated broadcast on rename', true);

// --- delete cascades, chat survives ---
events.length = 0;
const chatBeforeDelete = (await jf('/api/chat')).body;
await jf(`/api/characters/${ch.id}`, { method: 'DELETE' });
await waitEvent('character:deleted', (p) => p.id === ch.id);
check('character:deleted broadcast', true);
await waitEvent('combat:updated', (c) => !c.participants.some((p) => p.character_id === ch.id));
check('deleting a seated character removes them from the arena too', true);
check('sheet fetch now 404', (await jf(`/api/characters/${ch.id}`)).status === 404);
const chatAfter = (await jf('/api/chat')).body;
// Deliberately NOT an absolute count any more. This used to assert an exact
// total, which had already drifted out of sync with its own explanatory
// comment once; the Combat Automation overhaul then changed it again for a
// legitimate reason (the resolution engine writes its own rolls, Stamina
// system messages and a round_summary card per round), and an absolute
// number here would keep needing a rewrite for every future mechanic that
// says anything in chat. What this check is actually about is that deleting
// a character does not destroy history — so compare against the count taken
// just before the delete, and assert the authorship falls back to
// "(deleted)".
check(
  'chat log survives character deletion (nothing lost, author shows as deleted)',
  chatAfter.length === chatBeforeDelete.length && chatAfter[0].characterName === '(deleted)',
  `had ${chatBeforeDelete.length}, now ${chatAfter.length}, first author ${chatAfter[0]?.characterName}`
);

await jf(`/api/characters/${npc.id}`, { method: 'DELETE' });

// --- free-text chat messages + images/GIFs + Clear Chat ---
const chatty = await createFighter('Chatty', 'pc');

events.length = 0;
emit('chat:message', { characterId: chatty.id, text: 'hello table' });
let msg = await waitEvent('chat:message', (m) => m.characterId === chatty.id);
check('chat:message broadcast has kind/name/text', msg.kind === 'message' && msg.characterName === 'Chatty' && msg.message === 'hello table' && msg.imageData === null);
let chatNow = (await jf('/api/chat')).body;
let stored = chatNow.find((e) => e.message === 'hello table');
check('text-only message persisted with kind message, no dice', !!stored && stored.kind === 'message' && stored.dice.length === 0 && stored.total === 0);

// A null characterId posts as the GM's generic persona instead of a real
// character — no picker needed, matches the client's default-poster UX.
events.length = 0;
emit('chat:message', { characterId: null, text: 'GM says hello' });
const gmMsg = await waitEvent('chat:message', (m) => m.message === 'GM says hello');
check('a null characterId posts as "GM" — characterId null, characterName GM', gmMsg.characterId === null && gmMsg.characterName === 'GM');
chatNow = (await jf('/api/chat')).body;
const gmStored = chatNow.find((e) => e.message === 'GM says hello');
check('the GM post persists and reads back the same way via /api/chat', !!gmStored && gmStored.characterId === null && gmStored.characterName === 'GM');

events.length = 0;
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
emit('chat:message', { characterId: chatty.id, text: '', imageData: tinyPng, imageMimeType: 'image/png' });
msg = await waitEvent('chat:message', (m) => m.imageData === tinyPng);
check('image-only message broadcasts image with no text', msg.message === null && msg.imageMimeType === 'image/png');
chatNow = (await jf('/api/chat')).body;
check('image message persisted', chatNow.some((e) => e.imageData === tinyPng && e.imageMimeType === 'image/png'));

events.length = 0;
emit('chat:message', { characterId: chatty.id, text: '   ' });
await sleep(300);
check('whitespace-only message with no image is a silent no-op', !events.some((e) => e.ev === 'chat:message'));

events.length = 0;
emit('chat:message', { characterId: 999999, text: 'ghost' });
await sleep(300);
check('unknown characterId is a silent no-op', !events.some((e) => e.ev === 'chat:message'));

events.length = 0;
const longText = 'x'.repeat(2500);
emit('chat:message', { characterId: chatty.id, text: longText });
msg = await waitEvent('chat:message', (m) => m.characterId === chatty.id && m.message?.startsWith('xxx'));
check('message text capped at 2000 chars', msg.message.length === 2000);

events.length = 0;
emit('chat:clear', {});
await waitEvent('chat:cleared');
chatNow = (await jf('/api/chat')).body;
check('chat:clear empties the log for everyone', chatNow.length === 0);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
watcher.close(); actor.close();
process.exit(failures === 0 ? 0 : 1);

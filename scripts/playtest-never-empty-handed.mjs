// Playtest: Never Empty-Handed, the first player-activated Perk.
//
// The seam answers "what could this character pick up"; taking it is a socket
// event that calls the same `grantWeapon` every other weapon comes through.
// What only a live server shows is the chain: the offer appearing on an empty
// slot, the charge being spent exactly once, and the offer NOT coming back
// while the fight is still running — which is the whole "once per Fight" rule
// and the one part that lives in per-grant state rather than in the definition.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3041 node server/index.js
//   E2E_URL=http://localhost:3041 node scripts/playtest-never-empty-handed.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok ? '' : ' — ' + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
gm.emit('identity:set', { role: 'gm' });
await sleep(400);
const stamp = Date.now();

const perks = await jf('/api/perks');
const perk = perks.find((p) => p.name === 'Never Empty-Handed');
check('the Perk is seeded from the registry at startup', Boolean(perk), JSON.stringify(perks.map((p) => p.name)));
if (!perk) process.exit(1);

const fighter = await jpost('/api/characters', { name: `NEH${stamp}`, characterType: 'npc' });
const sheet = () => jf(`/api/characters/${fighter.id}`);

check('an ungranted character is offered nothing', ((await sheet()).weaponOffers ?? []).length === 0);

gm.emit('perk:grant', { characterId: fighter.id, perkId: perk.id });
await sleep(700);

const withPerk = await sheet();
const offer = (withPerk.weaponOffers ?? [])[0];
check('the granted Perk puts an offer on the empty slot', Boolean(offer), JSON.stringify(withPerk.weaponOffers));
check('and it is the object the Perk describes', offer?.dieSize === 12 && offer?.durability === 3, JSON.stringify(offer));
check('...carrying no modifier — a found object is not a technique', offer?.bonus === 0, JSON.stringify(offer));

gm.emit('weapon:take_offer', { characterId: fighter.id, perkName: 'Never Empty-Handed' });
await sleep(800);

const armed = await sheet();
check('taking it arms the character', armed.weapon?.die_size === 12 && armed.weapon?.durability === 3, JSON.stringify(armed.weapon));
check('and the offer is gone while they are holding it', (armed.weaponOffers ?? []).length === 0);

// The charge, which is the part that lives in per-grant state.
gm.emit('weapon:delete', { characterId: fighter.id });
await sleep(700);
const disarmed = await sheet();
check('putting it down leaves them unarmed', disarmed.weapon == null);
check(
  'but the Fight is not over, so the offer does NOT come back',
  (disarmed.weaponOffers ?? []).length === 0,
  JSON.stringify(disarmed.weaponOffers)
);

// A second press must not conjure a second object.
gm.emit('weapon:take_offer', { characterId: fighter.id, perkName: 'Never Empty-Handed' });
await sleep(700);
check('a second press is refused outright', (await sheet()).weapon == null);

// A hand-sent event naming a Perk this character does not hold arms nobody.
gm.emit('weapon:take_offer', { characterId: fighter.id, perkName: 'Genius Observer' });
await sleep(600);
check('naming an unrelated Perk arms nobody', (await sheet()).weapon == null);

// **And it comes back when the Fight does.** "Once per Fight" is the whole
// rule, and it rests entirely on the fight-scoped state store being cleared
// when a fight ends — a mechanism this Perk shares with Second Wind but which
// nothing here would notice breaking.
gm.emit('combat:clear', {});
await sleep(900);
const nextFight = await sheet();
check(
  'a new Fight restores the charge',
  (nextFight.weaponOffers ?? []).length === 1,
  JSON.stringify(nextFight.weaponOffers)
);
gm.emit('weapon:take_offer', { characterId: fighter.id, perkName: 'Never Empty-Handed' });
await sleep(800);
check('...and it can be taken again', (await sheet()).weapon?.die_size === 12);

console.log(fails === 0 ? '\nall probes passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

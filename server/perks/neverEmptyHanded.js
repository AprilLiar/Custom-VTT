// **Never Empty-Handed** — the `weaponOffer` seam, and the first Perk that is a
// player-facing *action* rather than a number the engine folds in.
//
// "Once per Fight, you can find an object in the environment to act as a
// Weapon, with 1d12 Attack and 3 Durability."
//
// **"You can" is the whole design.** The Perk does not arm anybody: it says
// what it is willing to offer, and the offer appears on the character's own
// **empty Weapon slot** — the place you would look for a weapon, and the place
// that is already the one seam through which any weapon enters the game
// (`grantWeapon`, see server/weapons.js). Picking it up is a deliberate act,
// which is what makes *when* to reach for it a decision worth having: an object
// found is 3 Durability that a Weapon-targeting attack can break, and reaching
// for it early spends the Fight's only chance.
//
// Offered only while the slot is empty, and only once per Fight — spent through
// `consumeOnce(..., 'fight')`, the same store Second Wind's once-per-round
// charge uses, cleared when a fight ends rather than when a round does.
//
// 1d12 with no modifier: a found object hits hard and is not a technique.
export default {
  name: 'Never Empty-Handed',
  description:
    'Once per Fight, you can find an object in the environment to act as a Weapon, with 1d12 Attack and 3 Durability.',

  weaponOffer: () => ({
    label: 'Find an object',
    name: 'Found Object',
    dieSize: 12,
    bonus: 0,
    durability: 3,
    once: 'fight',
  }),
};

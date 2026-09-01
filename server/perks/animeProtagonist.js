// **Anime Protagonist** — Tier 2, the `rollBonus` seam.
//
// "Reasons to Fight give you twice the regular bonus (+2 instead of +1 for every
// Reason)." Written as **one more point per Reason**, not as a multiplier, and
// that is the whole design note: every seam in this registry is additive, and a
// Perk that multiplied an existing term would be the first thing in here whose
// value depended on being applied in a particular order relative to something
// else. `+1 × reasons` on top of the engine's own `+1 × reasons` comes to
// exactly ×2, and two Perks doing it would come to ×3 rather than to an argument.
//
// It rides the roll's own breakdown under this Perk's name, beside the
// "Reasons to Fight" term it doubles — so a fighter with three Reasons reads
// `+3 (Reasons to Fight) +3 (Anime Protagonist)`, which is more honest than a
// silent 6 under one label.
export default {
  name: 'Anime Protagonist',
  description:
    'Your convictions carry you further than they should. Reasons to Fight are worth twice the usual: +2 on every roll for each Reason, instead of +1.',

  rollBonus: ({ reasonsToFight = 0 }) => Math.max(0, Math.trunc(Number(reasonsToFight) || 0)),
};

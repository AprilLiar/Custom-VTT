// **Eye Catcher** — reading where a blow is going, not what it is.
//
// "You know whether the attack against you is a High (Skull, Brain), Mid (Body,
// Stamina, Hands) or a Low (Legs) in addition to the Tell."
//
// **In addition to the Tell** is the whole shape of it. A Tell has always been
// public — it says a move is coming and gives it an identity to look up — and
// this adds one more fact about an attack that has not revealed: roughly where
// on the body it is headed. Not the move, not its frames, not its damage. A
// band, which is exactly enough to guess what to guard and not enough to know.
//
// **Only attacks aimed at the holder**, and only while they are still hidden.
// Once a move reveals, everyone can read its Attack Targets outright and there
// is nothing left for this to disclose.
//
// A move that names targets in more than one band reports all of them, because
// that is the truth — a strike that could land High or Mid is genuinely both,
// and narrowing it to one would be inventing certainty the reader has not
// earned.
export default {
  name: 'Eye Catcher',
  description:
    'You read where a blow is going. For any attack aimed at you, you know whether it is High (Skull, Brain), Mid (Body, Stamina, Hands) or Low (Legs) — in addition to its Tell, and before it reveals.',

  seesAttackHeight: () => true,
};

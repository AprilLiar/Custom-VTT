// **Baron of Suffering** — Tier 2, the `staminaPerHalfDamage` seam.
//
// Other people's pain is your second wind. One Stamina per half-point of damage
// you land — so the Damage Gates run 1 Stamina at a 5, 2 at a 10, 3 at a 15,
// and a multi-Stat attack pays for every Stat it wrecks.
//
// **Only damage that LANDS counts** (decided). The engine pays this out of its
// own record of what it wrote to a die (`applied` in runInterruptAndDamage), so
// a blow aimed at a Stat that is already broken pays nothing — the same reading
// as the end-of-round report that says that damage could not be applied. A
// Partial Block likewise pays only for what got through the guard, because only
// that much was ever dealt.
//
// The seam is a RATE rather than a flat number so the arithmetic stays in the
// engine, where the step count actually is: this file says "one per half", and
// never has to know how many halves there were.
export default {
  name: 'Baron of Suffering',
  description:
    'You feed on what you do to people. You regain 1 Stamina for each 0.5 Damage you deal.',

  staminaPerHalfDamage: () => 1,
};

// **Genius Observer** — Tier 2, the `canSeeRevealedDetail` seam.
//
// The oldest outstanding Perk in the project: the Chat Log's move card has
// asked "Does your character have the Genius Observer Perk?" as a
// `window.confirm` since the combat redesign, because there was no Perk to
// check and no way to check one. It is the first Perk written against the new
// architecture precisely because it needs no new engine behaviour at all — the
// engine already decided who may see what, per connection, for declared-move
// secrecy. This Perk just gets a say in one of those answers.
//
// Unconditional: owning it is the whole condition. It reads as a seam function
// rather than a flag because the seam's signature belongs to the seam, and
// because a later variant ("...only for moves in a Discipline you know") has
// somewhere to go without changing anything else.
export default {
  name: 'Genius Observer',
  description:
    'You read a fight faster than anyone should. Any move that has publicly revealed can be opened in full from the Chat Log — its description, its frames, everything it does — instead of just its name and shape.',

  canSeeRevealedDetail: () => true,
};

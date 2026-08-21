// **Grounded** — Tier 2, the `ignoresMovementPunisher` seam.
//
// The Movement Punisher Tag trips a fighter caught mid-stride, imposing
// Recovery on the move they were moving with. This says it never catches you:
// you move without ever being off balance.
//
// **It answers about the fighter who would be TRIPPED**, not the one throwing
// the punisher — "from your opponents" is what makes it a defence. The engine
// asks it only once the trip would otherwise land, so a fighter who was never
// going to be caught is not told they shrugged anything off.
//
// A boolean rather than a number: there is no half-ignoring a Tag, and OR-ing
// means a second Perk saying the same thing changes nothing.
export default {
  name: 'Grounded',
  description:
    'You are never off balance. All your moves ignore the Movement Punisher Tag from your opponents.',

  ignoresMovementPunisher: () => true,
};

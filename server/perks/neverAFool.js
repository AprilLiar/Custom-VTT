// **Never a Fool** — Tier 2, the `seesFeints` seam.
//
// "You are never fooled twice." A Feint thrown at you announces itself: while
// it is still an unrevealed Tell on the strip, you know that particular move is
// a Feint.
//
// **And nothing else** (decided, in those words). Not which move it is, not its
// frames, not its Roll — only that it is a lie. So this rides the declared-move
// payload as a single boolean on rows the Perk actually earns, and is ABSENT
// from every other row rather than sent as `isFeint: false`: the same
// protect-by-absence rule `moveId`, `moveName` and Eye Catcher's `attackHeights`
// already follow, because a flag a devtools reader can flip is not a secret.
//
// The same three gates Eye Catcher uses decide what "at you" means — somebody
// else's move, in your own pair, coming at you (or at nobody in particular, in
// a 1v1). Your own Feints are not news to you.
//
// **The Feint that MASKS a following move is untouched.** A move declared right
// after a Feint is dropped from the payload entirely for everyone but its
// owner, and this Perk does not bring it back — knowing the Feint is a Feint is
// what the Perk buys, not seeing through to what came after it. That is what
// keeps the Feint Tag worth having against somebody carrying this.
export default {
  name: 'Never a Fool',
  description:
    'You are never fooled twice. A Feint aimed at you is marked as a Feint on the Tic Counter while it is still hidden — that it is a Feint, and nothing else about it.',

  seesFeints: () => true,
};

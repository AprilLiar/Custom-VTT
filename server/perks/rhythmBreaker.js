// **Rhythm Breaker** — Tier 2, the `interruptAmounts` seam.
//
// The mirror of Dogfighter, on the other half of the same contest: where that
// Perk makes your moves hard to break up, this one makes yours good at breaking
// other people's. One file and one registry line, for the same reason.
//
// **+2 either way.** "All your Moves gain Interrupter (2). If a move already had
// Interrupter (X), increase the X by 2" — both branches come to the same
// arithmetic, because the Tag's own value and this bonus are added into one
// figure at the contest (see resolveInterruptContest). Writing it as a flat +2
// is what makes the two sentences agree rather than needing a rule for their
// meeting.
export default {
  name: 'Rhythm Breaker',
  description:
    'You hit on the off-beat. All your Moves count as having Interrupter (2), and a Move that already had Interrupter (X) has it increased by 2 instead.',

  interruptAmounts: () => ({ interrupter: 2 }),
};

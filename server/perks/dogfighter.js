// **Dogfighter** — Tier 2, the `interruptAmounts` seam, and the first Perk to
// use it. The seam's shape was agreed long before anything needed it (see the
// seam register in vttprojectplan.md), which is exactly what that register is
// for: this Perk is one file and one registry line, not an engine argument.
//
// **+2 either way.** "All your Moves gain Hard to Interrupt (2). If a Move
// already had Hard to Interrupt (x), it is instead increased by 2" — both
// branches come to the same arithmetic, because the Tag's own value and this
// bonus are added into one figure at the contest (see resolveInterruptContest).
// Writing it as a flat +2 is what makes the two sentences agree rather than
// needing a rule for their meeting.
//
// It touches only the defending half. A Dogfighter's own attacks are no better
// at breaking moves up — they are simply harder to break up themselves.
export default {
  name: 'Dogfighter',
  description:
    'You do not come apart when someone lands one. All your Moves count as having Hard to Interrupt (2), and a Move that already had Hard to Interrupt (x) has it increased by 2 instead.',

  interruptAmounts: () => ({ hardToInterrupt: 2 }),
};

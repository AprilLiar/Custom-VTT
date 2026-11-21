// **The current patch (decided):** shown at the top of the role screen so
// everyone sees what changed from the get-go. Bump `version` (and both
// package.json versions — a test checks they match) and rewrite `note` as ONE
// sentence on every push to main.
export const PATCH = {
  version: '0.2.2',
  note: "Interrupts now cut in after the current Action and let the interrupted player keep or drop the rest of their queue, the GM can Rewind up to 5 steps, Traps under fighters show a badge, and contest pushes can be tapped.",
};

// **The current patch (decided):** shown at the top of the role screen so
// everyone sees what changed from the get-go. Bump `version` (and both
// package.json versions — a test checks they match) and rewrite `note` as ONE
// sentence on every push to main.
export const PATCH = {
  version: '0.3.5',
  note: "A figure size on the Scene stage now belongs to the character: resize them once and every Scene, old and new, shows them at that size.",
};

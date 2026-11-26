// **The current patch (decided):** shown at the top of the role screen so
// everyone sees what changed from the get-go. Bump `version` (and both
// package.json versions — a test checks they match) and rewrite `note` as ONE
// sentence on every push to main.
export const PATCH = {
  version: '0.3.4',
  note: "The GM can now draw red and purple borders on Combat map square edges: red stops all movement but teleports, purple stops everything, and either can block range.",
};

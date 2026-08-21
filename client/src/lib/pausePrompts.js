// The GM's manual override for a pause prompt (decided, new).
//
// Normally CombatHeaderBar reads every pending prompt straight off the combat
// snapshot and there is nothing here to do. This exists for the case that
// prompted the whole rework: a fight paused, the question asked, and no dialog
// on any screen — which leaves the round unadvanceable by anyone, since only an
// answer moves it on.
//
// GM Tools' Fight Pauses asks the server directly (`combat:resummon_pause`) and
// pushes what it gets back through here. CombatHeaderBar renders that in place
// of the snapshot-derived prompt, so the fallback shares no plumbing with the
// path it is backing up — which is the only thing that makes it a fallback
// rather than a second chance at the same failure.
//
// One at a time, deliberately: a pause is a single question, and the GM picked
// which one to summon.
let current = null;
const listeners = new Set();

export function summonPausePrompt(prompt) {
  current = prompt;
  for (const listener of listeners) listener(current);
}

export function clearSummonedPrompt() {
  summonPausePrompt(null);
}

export function onSummonedPrompt(callback) {
  listeners.add(callback);
  callback(current);
  return () => listeners.delete(callback);
}

// **The Interrupt lock (decided).** Pressing Interrupt puts up a full-screen
// "<name> is interrupting the current turn" for everyone; nobody can act until
// the interrupter commits their Interrupt board (the lock drops at once and
// the Reactive Action resolves) or gives it up. An Interrupt never cuts into
// a resolving Action: pressed while the fight's chain is busy, it waits in a
// queue (a small ⚡ chip with the name at the bottom of the screen) and the
// lock opens as soon as the current stack finishes.
//
// In memory, per fight: a server restart simply drops it (nothing is lost —
// the Interrupt boards themselves live in dice_marks).

// fightId → { active: who | null, queue: [who] }; who: { combatantId, name, by }
// (`by`: the socket that pressed Interrupt — its board opens there).
const state = new Map();

const of = (fightId) => {
  if (!state.has(fightId)) state.set(fightId, { active: null, queue: [] });
  return state.get(fightId);
};

// What the stage shows: null, or { active, queue }.
export function interruptOf(fightId) {
  const s = state.get(fightId);
  return s && (s.active || s.queue.length) ? { active: s.active, queue: [...s.queue] } : null;
}

export const activeInterrupt = (fightId) => state.get(fightId)?.active ?? null;

// Someone pressed Interrupt. `busy`: an Action is resolving right now.
// → 'active' (the lock is theirs now), 'already' (it was), or 'queued'.
export function claimInterrupt(fightId, who, busy) {
  const s = of(fightId);
  if (s.active?.combatantId === who.combatantId) return 'already';
  if (s.active || busy) {
    if (!s.queue.some((q) => q.combatantId === who.combatantId)) s.queue.push({ combatantId: who.combatantId, name: who.name, by: who.by ?? null });
    return 'queued';
  }
  s.queue = s.queue.filter((q) => q.combatantId !== who.combatantId);
  s.active = { combatantId: who.combatantId, name: who.name, by: who.by ?? null };
  return 'active';
}

// Their Interrupt was committed, passed or cancelled: the lock drops.
export function releaseInterrupt(fightId, combatantId = null) {
  const s = state.get(fightId);
  if (!s?.active || (combatantId != null && s.active.combatantId !== combatantId)) return false;
  s.active = null;
  return true;
}

// Taken out of the queue (passed before their turn came).
export function unqueueInterrupt(fightId, combatantId) {
  const s = state.get(fightId);
  if (!s) return false;
  const before = s.queue.length;
  s.queue = s.queue.filter((q) => q.combatantId !== combatantId);
  return s.queue.length !== before;
}

// The stack finished: the next one waiting takes the lock. → who, or null.
export function nextInterrupt(fightId) {
  const s = state.get(fightId);
  if (!s || s.active || !s.queue.length) return null;
  s.active = s.queue.shift();
  return s.active;
}

// The fight ended or was reset.
export function dropInterrupts(fightId) {
  state.delete(fightId);
}

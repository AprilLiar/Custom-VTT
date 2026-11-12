// **Board animations (decided): the effects log.** What the engine did to the
// fighters, in order, so every viewer can play it back one beat at a time.
// The engine's world records an effect at each change (tokens, damage, a
// Shield, a Challenge…); `emitStageUpdated` drains them and sends
// `fight:effects` just before the `stage:updated` they lead to.
//
// An effect: { id, sceneId, mode, kind, combatantId, before, after, data }.
// `before`/`after` are the fighter's shown state around it (`{ tokens, hp,
// challenge_id }`, the same shape as the stage's `fight`), so a viewer can
// hold the display at `before` until the beat plays.
//
// Only the engine records (decided: manual edits stay instant).

let nextId = 1;
let pending = [];
// Fighters whose changes a meaning-level effect is collecting (a hit: its
// Shield, Iron and HP are one "damage" beat, not three).
const mutes = new Map();

export const slice = (f) => (f ? { tokens: { ...(f.tokens ?? {}) }, hp: f.hp ?? null, challenge_id: f.challenge_id ?? null } : null);

export function muteFx(combatantId) {
  mutes.set(combatantId, (mutes.get(combatantId) ?? 0) + 1);
}
export function unmuteFx(combatantId) {
  const n = (mutes.get(combatantId) ?? 0) - 1;
  if (n > 0) mutes.set(combatantId, n);
  else mutes.delete(combatantId);
}
export const isMuted = (combatantId) => mutes.has(combatantId);

// Token deltas between two token maps → [{ key, delta }] (no zeros).
export function tokenChanges(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out = [];
  for (const key of keys) {
    const delta = (Number(after?.[key]) || 0) - (Number(before?.[key]) || 0);
    if (delta) out.push({ key, delta });
  }
  return out;
}

export function recordFx(effect, { force = false } = {}) {
  if (!effect?.combatantId || (!force && isMuted(effect.combatantId))) return null;
  const e = { id: nextId++, data: {}, ...effect };
  // The last change to the same fighter's tokens, right before, joins it
  // (several kinds at once show side by side — decided).
  const last = pending[pending.length - 1];
  if (e.kind === 'tokens' && last && last.kind === 'tokens' && last.combatantId === e.combatantId && last.sceneId === e.sceneId && last.mode === e.mode) {
    const changes = tokenChanges(last.before?.tokens, e.after?.tokens);
    if (!changes.length) {
      pending.pop();
      return null;
    }
    last.after = e.after;
    last.data = { ...last.data, changes };
    return last;
  }
  if (e.kind === 'tokens') {
    const changes = tokenChanges(e.before?.tokens, e.after?.tokens);
    if (!changes.length) return null;
    e.data = { ...e.data, changes };
  }
  pending.push(e);
  return e;
}

// Same kind, same sort, on different fighters, one right after another: one
// beat (an area hit, "every enemy gains Dizzy" — decided: same cause plays together).
const sortOf = (e) => {
  if (e.kind === 'tokens') return e.data.changes.map((c) => `${c.key}${Math.sign(c.delta)}`).sort().join(',');
  if (e.kind === 'challenge') return String(e.data.challengerId ?? '');
  return '';
};
export function groupBeats(effects) {
  const beats = [];
  for (const e of effects) {
    const beat = beats[beats.length - 1];
    const joins =
      beat &&
      beat.sceneId === e.sceneId &&
      beat.mode === e.mode &&
      beat.effects[0].kind === e.kind &&
      sortOf(beat.effects[0]) === sortOf(e) &&
      !beat.effects.some((x) => x.combatantId === e.combatantId);
    if (joins) beat.effects.push(e);
    else beats.push({ id: e.id, sceneId: e.sceneId, mode: e.mode, effects: [e] });
  }
  return beats;
}

// Everything recorded since the last call, as beats.
export function drainFx() {
  const out = pending;
  pending = [];
  return groupBeats(out);
}

// Tests.
export function resetFx() {
  pending = [];
  mutes.clear();
}

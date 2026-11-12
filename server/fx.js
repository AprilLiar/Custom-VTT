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

const sameSq = (a, b) => Boolean(a && b && a.col === b.col && a.row === b.row);

// **Actions (phase 4):** an Action performed opens a frame; the fighters its
// effects land on while it runs become its targets (the attacker lunges at
// the first). Nested (an Action performing another): the innermost collects.
const actions = [];
export function openAction({ sceneId, mode, actorId, name, isSuper = false }) {
  if (actorId == null) return null;
  if (isSuper) recordFx({ sceneId, mode, kind: 'super', combatantId: actorId, before: null, after: null, data: { name } });
  const e = recordFx({ sceneId, mode, kind: 'action', combatantId: actorId, before: null, after: null, data: { name, targets: [], isSuper } });
  if (e) actions.push(e);
  return e;
}
export function closeAction(e) {
  const i = actions.lastIndexOf(e);
  if (i >= 0) actions.splice(i, 1);
}
const noteTarget = (e) => {
  const a = actions[actions.length - 1];
  if (!a || e.combatantId == null || e.combatantId === a.combatantId || e.sceneId !== a.sceneId || e.mode !== a.mode) return;
  if (!a.data.targets.includes(e.combatantId)) a.data.targets = [...a.data.targets, e.combatantId];
};

export function recordFx(effect, { force = false } = {}) {
  if (!effect) return null;
  // A tile (an obstacle or a Copy — phase 3) belongs to no fighter.
  if (effect.kind !== 'tile' && (!effect.combatantId || (!force && isMuted(effect.combatantId)))) return null;
  const e = { id: nextId++, data: {}, ...effect };
  if (!['action', 'super', 'turn'].includes(e.kind)) noteTarget(e);
  const prev = pending[pending.length - 1];
  // An obstacle taken off one square and put on another, back to back, moved.
  if (e.kind === 'tile' && e.data.change === 'placed' && prev?.kind === 'tile' && prev.data.change === 'destroyed' && prev.data.tile === e.data.tile && prev.sceneId === e.sceneId && prev.mode === e.mode && !sameSq(prev.data.at, e.data.at) && e.data.tile !== 'rubble') {
    prev.data = { ...prev.data, change: 'moved', from: prev.data.at, at: e.data.at };
    return prev;
  }
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
  if (e.kind === 'move') return e.data.how ?? '';
  if (e.kind === 'tile') return `${e.data.change}:${e.data.tile}`;
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
      (e.combatantId == null || !beat.effects.some((x) => x.combatantId === e.combatantId)) &&
      (e.kind !== 'tile' || !beat.effects.some((x) => sameSq(x.data.at, e.data.at)));
    if (joins) beat.effects.push(e);
    else beats.push({ id: e.id, sceneId: e.sceneId, mode: e.mode, effects: [e] });
  }
  return beats;
}

// Everything recorded since the last call, as beats.
export function drainFx() {
  // An Action still running with nothing done yet (its target question is
  // out) waits for what it does, so it can lunge at its target.
  let keep = [];
  const last = pending[pending.length - 1];
  if (last?.kind === 'action' && actions.includes(last) && !last.data.targets.length) {
    keep = [pending.pop()];
    if (pending[pending.length - 1]?.kind === 'super') keep.unshift(pending.pop());
  }
  const out = pending;
  pending = keep;
  return groupBeats(out);
}

// Tests.
export function resetFx() {
  pending = [];
  mutes.clear();
  actions.length = 0;
}

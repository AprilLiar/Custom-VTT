// **Board animations (decided): the client's queue.** The server sends what
// the engine did as beats (`fight:effects`, server/fx.js), just before the
// stage they lead to. Beats play one at a time, in order, board-wide; while a
// fighter still has a beat waiting, the board shows it as it was before that
// beat ("hold the display"), so HP, tokens and the Challenge change exactly
// as their animation plays. Rules, buttons and prompts never read this —
// only what's drawn.
//
// Pure: no React, no socket (tested in server/test/boardFx.test.js).

import { isTakenOut } from './hpBars.js';

// How long each kind plays at Normal speed (ms).
export const FX_MS = {
  tokens: 1000,
  damage: 800,
  heal: 800,
  shield: 1200,
  challenge: 600,
  dizzy: 700,
};
const DEFAULT_MS = 600;

// What a damage / heal / Dizzy effect led to, read off its before and after
// (phase 2): a Shield broken, Armor that blocked, a bar broken, Dizzy, Taken
// Out, back from Taken Out.
export function outcomesOf(e) {
  const b = e?.before?.hp;
  const a = e?.after?.hp;
  const out = (s) => Boolean(s && isTakenOut(s));
  return {
    shieldBroke: e?.kind === 'damage' && Boolean(e.data?.broke),
    armor: e?.kind === 'damage' ? Number(e.data?.blocked) || 0 : 0,
    barBroke: Boolean(b && a && (a.broken ?? 0) > (b.broken ?? 0)),
    dizzied: Boolean(a?.dizzy && !b?.dizzy),
    takenOut: !out(b) && out(a),
    revived: out(b) && !out(a),
  };
}
// One effect's time: the bigger outcomes take a little longer.
export function effectMs(e) {
  const base = FX_MS[e?.kind] ?? DEFAULT_MS;
  const o = outcomesOf(e);
  if (o.takenOut) return Math.max(base, 1100);
  if (o.barBroke || o.dizzied || o.revived) return Math.max(base, 1000);
  return base;
}
// More than this many waiting: play at twice the speed until caught up.
export const CATCH_UP_AFTER = 4;
// Never keep more than this many waiting (a device that slept skips ahead).
export const MAX_WAITING = 30;

export const beatMs = (beat) => Math.max(0, ...(beat?.effects ?? []).map(effectMs));

// The time one beat takes: the speed setting, and 2x when the queue is behind.
export function playMs(beat, speed, waiting) {
  if (speed === 'off') return 0;
  let ms = beatMs(beat);
  if (speed === 'fast') ms *= 0.5;
  if (waiting > CATCH_UP_AFTER) ms *= 0.5;
  return Math.round(ms);
}

// New beats onto the waiting list (oldest dropped past MAX_WAITING).
export function enqueue(waiting, beats) {
  const next = [...waiting, ...(beats ?? []).filter((b) => b?.effects?.length)];
  return next.length > MAX_WAITING ? next.slice(next.length - MAX_WAITING) : next;
}

const lastFor = (beat, id) => {
  if (!beat || id == null) return null;
  let found = null;
  for (const e of beat.effects) if (e.combatantId === id) found = e;
  return found;
};
const firstFor = (beat, id) => (beat && id != null ? (beat.effects.find((e) => e.combatantId === id) ?? null) : null);

const withShown = (fight, shown) =>
  shown ? { ...fight, tokens: shown.tokens ?? fight.tokens, hp: shown.hp ?? fight.hp, challenge_id: shown.challenge_id ?? null } : fight;

// A fighter's state as the board shows it now: as it ends the beat playing,
// else as it was before its next waiting beat, else the real one.
export function heldFight(fight, playing, waiting) {
  const id = fight?.combatant_id;
  if (id == null) return fight;
  const now = lastFor(playing, id);
  if (now) return withShown(fight, now.after);
  for (const beat of waiting ?? []) {
    const next = firstFor(beat, id);
    if (next) return withShown(fight, next.before);
  }
  return fight;
}

// The effects of the beat playing that a fighter shows.
export const effectsFor = (beat, id) => (beat && id != null ? beat.effects.filter((e) => e.combatantId === id) : []);

// "+" / "++" / "-" / "--" (decided: two or more doubles the sign).
export const signOf = (delta) => (delta > 0 ? (delta > 1 ? '++' : '+') : delta < -1 ? '--' : '-');

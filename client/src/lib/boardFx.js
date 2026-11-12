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
  tile: 500,
  // Phase 4.
  turn: 900,
  action: 450,
  super: 1500,
};
// Movement (phase 3), by how.
export const MOVE_MS = { push: 450, pull: 450, teleport: 500, swap: 450, out: 500, in: 500 };
const stepsOf = (a, b) => (a && b ? Math.abs(a.col - b.col) + Math.abs(a.row - b.row) : 1);
export const moveHow = (e) => (!e.data?.to ? 'out' : !e.data?.from ? 'in' : (e.data.how ?? 'move'));
export function moveMs(e) {
  const how = moveHow(e);
  if (MOVE_MS[how]) return MOVE_MS[how];
  return Math.min(700, Math.max(300, 150 * stepsOf(e.data.from, e.data.to)));
}
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
  if (e?.kind === 'move') return moveMs(e);
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

// Effects that change what a fighter shows (moves and tiles carry no state).
const shows = (e) => e.after != null && e.before != null;
const lastFor = (beat, id, ok = shows) => {
  if (!beat || id == null) return null;
  let found = null;
  for (const e of beat.effects) if (e.combatantId === id && ok(e)) found = e;
  return found;
};
const firstFor = (beat, id, ok = shows) => (beat && id != null ? (beat.effects.find((e) => e.combatantId === id && ok(e)) ?? null) : null);

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

// **Held positions (phase 3):** where a fighter stands as the board shows it:
// where its move playing now takes it, else where it was before its next
// waiting move, else its real square. `real`: { col, row } or null (out of
// play). → { square, move } (`move`: the effect playing, if any).
const isMove = (e) => e.kind === 'move';
export function heldSquare(id, real, playing, waiting) {
  const now = lastFor(playing, id, isMove);
  if (now) return { square: now.data.to ?? null, move: now };
  for (const beat of waiting ?? []) {
    const next = firstFor(beat, id, isMove);
    if (next) return { square: next.data.from ?? null, move: null };
  }
  return { square: real, move: null };
}

// **Held tiles (phase 3):** the stage's tiles with every waiting beat's tile
// changes undone, latest first (the beat playing shows as it ends).
const sameAt = (t, at) => at && t.col === at.col && t.row === at.row;
export function heldTiles(tiles, waiting) {
  const effects = (waiting ?? []).flatMap((b) => b.effects.filter((e) => e.kind === 'tile'));
  if (!effects.length) return tiles;
  let out = [...(tiles ?? [])];
  const take = (kind, at, ownerId) => {
    const i = out.findIndex((t) => t.kind === kind && sameAt(t, at) && (ownerId == null || t.owner_id === ownerId));
    if (i < 0) return null;
    const [t] = out.splice(i, 1);
    return t;
  };
  for (const e of [...effects].reverse()) {
    const { change, tile, at, from, owner_id } = e.data;
    if (change === 'placed') take(tile, at, owner_id);
    else if (change === 'destroyed') out = [...out, { col: at.col, row: at.row, kind: tile, ...(owner_id != null ? { owner_id } : {}) }];
    else if (change === 'moved' && from) {
      const t = take(tile, at, owner_id);
      out = [...out, { ...(t ?? { kind: tile, ...(owner_id != null ? { owner_id } : {}) }), col: from.col, row: from.row }];
    }
  }
  return out;
}

// A figure's CSS transition while its move plays (`slide`: { how, ms }): it
// slides over the beat (a push snaps out fast and settles), a teleport jumps.
const SLIDE_EASE = { push: 'cubic-bezier(0.15, 0.9, 0.3, 1)', pull: 'cubic-bezier(0.15, 0.9, 0.3, 1)' };
export const slideTransition = (slide, fallback) => {
  if (!slide) return fallback;
  if (['teleport', 'in', 'out'].includes(slide.how)) return 'none';
  const ms = Math.round(slide.ms * (slide.how === 'push' || slide.how === 'pull' ? 0.7 : 0.9));
  const ease = SLIDE_EASE[slide.how] ?? 'ease-in-out';
  return `left ${ms}ms ${ease}, top ${ms}ms ${ease}`;
};

// **An Action's lunge (phase 4):** the attacker's offset toward its first
// target, a third of the way to it, capped at a third of a square (`unit`
// px). → { dx, dy } or null.
export function lungeOf(from, to, unit) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const k = Math.min(len / 3, unit / 3) / len;
  return { dx: dx * k, dy: dy * k };
}

// **A swap (play feedback 7):** the two figures pass side by side, not
// through each other — each steps aside (a quarter of a square, `unit` px),
// opposite ways, at mid-way. → { dx, dy, times, ease } or null.
export function swapStepOf(e, from, to, unit) {
  if (!from || !to || e?.data?.how !== 'swap') return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  // Perpendicular, the same side for both relative to the line a→b — so,
  // moving opposite ways, they step apart.
  const k = (unit * 0.25) / len;
  return { dx: -dy * k, dy: dx * k, times: [0, 0.5, 1], ease: 'easeInOut' };
}

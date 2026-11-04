// A fighter's stack of HP bars (Panic at the Dojo — book p.62, and the GM's
// design). Pure and shared: the server applies every change with these rules,
// and the client uses them to draw.
//
// State: { max, current, bars, broken, dizzy }
//   max     — every bar's Max HP (1-99), or null until someone sets it
//   current — HP left in the CURRENT bar
//   bars    — how many bars the fighter has in total (≥1)
//   broken  — how many of them have broken (the current bar is bars - broken)
//   dizzy   — a bar broke this turn (cleared at the end of the turn)
//
// Rules:
//   - damage never carries from one bar into the next;
//   - when the current bar hits 0 and another bar is left, it breaks: the
//     next (full) bar moves up and the fighter is Dizzy;
//   - on the last bar HP stops at 0 — Taken Out — and any healing revives;
//   - healing never goes above Max, and never repairs a broken bar;
//   - the golden + adds a full bar to the back of the stack.

export const HP_MAX = 99;

const int = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : fallback);

export function normalizeHp(s = {}) {
  const max = s.max == null ? null : Math.min(HP_MAX, Math.max(1, int(s.max, 1)));
  const bars = Math.max(1, int(s.bars, 1));
  const broken = Math.min(bars - 1, Math.max(0, int(s.broken, 0)));
  const current = max == null ? 0 : Math.min(max, Math.max(0, int(s.current, max)));
  return { max, current, bars, broken, dizzy: Boolean(s.dizzy) };
}

export const barsLeft = (s) => s.bars - s.broken;
// **Turns per round (decided, revised — the book's rule, p.60-61):** one per
// Health Bar the fighter has, broken bars included — "Even after some of the
// Boss's health bars are lost, they will still take 4 Turns each Round, to
// keep the fight even." A Taken Out fighter's turns still come up too (Heroic
// Spirit lets them donate a turn).
export const turnsPerRound = (s) => Math.max(1, Math.trunc(Number(s?.bars) || 1));
export const isTakenOut = (s) => s.max != null && barsLeft(s) === 1 && s.current === 0;

// Lands `current` on a value, breaking the bar if it reached 0 with another
// bar behind it. Returns { state, broke }.
function land(s, value) {
  if (value <= 0 && barsLeft(s) > 1) {
    return { state: { ...s, broken: s.broken + 1, current: s.max, dizzy: true }, broke: true };
  }
  return { state: { ...s, current: Math.min(s.max, Math.max(0, value)) }, broke: false };
}

// ± HP on the current bar. Without a Max set there is nothing to change.
export function applyHpDelta(state, delta) {
  const s = normalizeHp(state);
  const d = int(delta, 0);
  if (s.max == null || d === 0) return { state: s, broke: false };
  return land(s, s.current + d);
}

// Setting Max (and/or current). Setting Max for the first time fills the bar;
// later, current is kept but never left above the new Max.
export function setHp(state, { max, current } = {}) {
  let s = normalizeHp(state);
  if (max !== undefined && max !== null) {
    const m = Math.min(HP_MAX, Math.max(1, int(max, 1)));
    s = { ...s, max: m, current: s.max == null ? m : Math.min(s.current, m) };
  }
  if (current !== undefined && current !== null && s.max != null) {
    return land(s, int(current, s.current));
  }
  return { state: s, broke: false };
}

// The golden +: another full bar at the back of the stack.
export const addBar = (state) => {
  const s = normalizeHp(state);
  return { ...s, bars: s.bars + 1 };
};

// Take a full bar off the back of the stack — never the current one.
export const removeBar = (state) => {
  const s = normalizeHp(state);
  return barsLeft(s) > 1 ? { ...s, bars: s.bars - 1 } : s;
};

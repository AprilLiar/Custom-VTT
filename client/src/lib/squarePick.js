// **Picking squares on the board (full automation, phase D — decided:
// targets, squares and placements are picked on the map or lane, legal ones
// glow, with a compact list alongside; the dice board steps aside).** One
// pick at a time, shared by whoever needs it: a `square` prompt from the
// engine (TriggerPrompts), or Free Movement (Move on the dice board or in a
// movement phase). The map and the lane draw the glowing squares and report
// taps; the dice board hides while a pick is open.
//
// pick: { key, mode: 'combat' | 'simple', title, options: [{ id, col, row, label?, note?, cost? }],
//         onPick(id), tone: 'pick' | 'move' } | null
import { useSyncExternalStore } from 'react';

let current = null;
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());

export function setSquarePick(pick) {
  current = pick;
  emit();
}
// Clears the pick only if it is still the one with this key.
export function clearSquarePick(key) {
  if (current?.key === key) setSquarePick(null);
}
export const getSquarePick = () => current;
const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
export const useSquarePick = () => useSyncExternalStore(subscribe, getSquarePick, getSquarePick);

// A tap on a fighter's token (or base) standing on a legal square of the open
// pick goes to the pick, never to the token (decided, batch 3): a target is
// picked by tapping it, and "act from" a Copy's or your own square works even
// though a token sits there. → true when the tap was the pick's.
export function pickAt(mode, col, row) {
  if (!current || current.mode !== mode || col == null || row == null) return false;
  const o = current.options.find((x) => x.col === col && x.row === row);
  if (!o) return false;
  current.onPick(o.id);
  return true;
}

// **While any choice is open, no token menu opens (decided, batch 3).** The
// engine's prompts this client holds (TriggerPrompts reports them) plus an
// open square pick.
let promptsOpen = 0;
export function setPromptsOpen(n) {
  if (n === promptsOpen) return;
  promptsOpen = n;
  emit();
}
export const isChoosing = () => promptsOpen > 0 || current != null;
export const useChoosing = () => useSyncExternalStore(subscribe, isChoosing, isChoosing);

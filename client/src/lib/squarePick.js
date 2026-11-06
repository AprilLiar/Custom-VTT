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

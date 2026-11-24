import { useSyncExternalStore } from 'react';
import { getTableSettings } from './api.js';
import { socket } from '../socket.js';

// **The active fighter's range shading (GM setting, whole table — decided).**
// Opacity 0-100% of the red squares (`table_settings.range_opacity`, default
// 50). One shared store: fetched once, kept current by `table_settings:updated`.
export const DEFAULT_RANGE_OPACITY = 50;
let value = DEFAULT_RANGE_OPACITY;
const subs = new Set();
const set = (v) => {
  const n = Number.isFinite(Number(v)) ? Math.min(100, Math.max(0, Number(v))) : DEFAULT_RANGE_OPACITY;
  if (n === value) return;
  value = n;
  subs.forEach((fn) => fn());
};
let started = false;
function start() {
  if (started) return;
  started = true;
  getTableSettings()
    .then((s) => set(s?.rangeOpacity))
    .catch(() => {});
  socket.on('table_settings:updated', (s) => set(s?.rangeOpacity));
}
const subscribe = (fn) => {
  start();
  subs.add(fn);
  return () => subs.delete(fn);
};
export const useRangeOpacity = () => useSyncExternalStore(subscribe, () => value, () => DEFAULT_RANGE_OPACITY);

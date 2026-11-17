import { useSyncExternalStore } from 'react';
import { getTableSettings } from './api.js';
import { socket } from '../socket.js';

// **Skills on or off for the whole table (GM setting, decided).** Some
// campaigns use no Skills: off hides them everywhere — the builder's Skills
// step, the sheet, the Stance Contest bonus step, Skill warnings, the Homebrew
// Skill field. The data stays stored. One shared store: fetched once, kept
// current by `table_settings:updated`; on until known.
let enabled = true;
const subs = new Set();
const set = (v) => {
  if (v === enabled) return;
  enabled = v;
  subs.forEach((fn) => fn());
};
let started = false;
function start() {
  if (started) return;
  started = true;
  getTableSettings()
    .then((s) => set(s?.skillsEnabled !== false))
    .catch(() => {});
  socket.on('table_settings:updated', (s) => set(s?.skillsEnabled !== false));
}
const subscribe = (fn) => {
  start();
  subs.add(fn);
  return () => subs.delete(fn);
};
export const useSkillsEnabled = () => useSyncExternalStore(subscribe, () => enabled, () => true);
// The free Skill's warning and any other Skill-only line, left out when Skills are off.
export const isSkillWarning = (w) => /\bSkill/.test(w);

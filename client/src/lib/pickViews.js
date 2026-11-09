// **Every board pick, shown to everyone (decided, batch 3).** The table shares
// a player monitor, so a square or target pick — its legal squares and the
// Range it's made in — shows on every screen, not only for whoever is asked
// (they still pick on their own screen; this is view-only). The server sends
// each as `pick:view` (Free Movement's reach too) and clears it with
// `trigger:resolved` / `pick:clear`; a fight's end or a new turn clears the rest.
import { useSyncExternalStore } from 'react';
import { socket } from '../socket.js';

let views = [];
const subs = new Set();
const set = (next) => {
  views = next;
  subs.forEach((fn) => fn());
};
socket.on('pick:view', (v) => v?.id && set([...views.filter((x) => x.id !== v.id), v]));
socket.on('trigger:resolved', ({ id }) => views.some((x) => x.id === id) && set(views.filter((x) => x.id !== id)));
socket.on('pick:clear', ({ id }) => views.some((x) => x.id === id) && set(views.filter((x) => x.id !== id)));
socket.on('fight:ended', () => set([]));
socket.on('fight:turn_ended', () => views.some((x) => x.kind === 'move') && set(views.filter((x) => x.kind !== 'move')));
socket.on('disconnect', () => set([]));

const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
const get = () => views;
export const usePickViews = () => useSyncExternalStore(subscribe, get, get);

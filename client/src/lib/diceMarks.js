import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { EMPTY_MARKS } from './patd/diceBoard.js';

// The turn dice board's marks (server/diceMarks.js), kept live for every
// Stance roll card: { rollId → { used, assign, active } }. Fetched once,
// refreshed on reconnect, and updated over `dice:marks`.
let marks = null;
let pending = null;
const listeners = new Set();
const publish = () => {
  for (const l of listeners) l(marks);
};
const load = () => {
  pending = fetch('/api/dice-marks')
    .then((r) => r.json())
    .then((j) => {
      marks = { ...(j.marks ?? {}), ...(marks ?? {}) };
      publish();
    })
    .catch(() => {});
  return pending;
};
socket.on('dice:marks', (m) => {
  if (!m?.rollId) return;
  marks = { ...(marks ?? {}), [m.rollId]: m };
  publish();
});
socket.on('connect', () => {
  if (marks) {
    marks = null;
    load();
  }
});

// Sets a roll's marks locally at once (the server echoes them back to all).
export function setLocalMarks(rollId, m) {
  marks = { ...(marks ?? {}), [rollId]: { ...(marks?.[rollId] ?? {}), ...m, rollId } };
  publish();
}

// One roll's marks: { used, assign, active } (empty, inactive until known).
export function useDiceMarks(rollId) {
  const [all, setAll] = useState(marks);
  useEffect(() => {
    listeners.add(setAll);
    if (!marks && !pending) load();
    else setAll(marks);
    return () => listeners.delete(setAll);
  }, []);
  return (rollId && all?.[rollId]) || { ...EMPTY_MARKS, active: false };
}

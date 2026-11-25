import { useEffect, useState } from 'react';

// **Remembered between visits (decided):** UI choices kept in this browser —
// which Scene folder is open, which character folders are collapsed — so
// leaving the Scene tab and coming back shows the same thing. Per viewer,
// best effort: any storage error just falls back to the default.
const read = (key, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: kept for this visit only */
  }
};

export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => read(key, initial));
  useEffect(() => write(key, value), [key, value]);
  return [value, setValue];
}

// A Set kept as an array.
export function usePersistentSet(key) {
  const [value, setValue] = useState(() => new Set(read(key, [])));
  useEffect(() => write(key, [...value]), [key, value]);
  return [value, setValue];
}

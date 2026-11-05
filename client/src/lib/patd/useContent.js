import { useEffect, useState } from 'react';
import { indexContent } from './content.js';

// The rules content, loaded on first use (a separate ~1.2MB chunk, so pages
// that never open a Combat tab never download it) and indexed once.
let pending = null;
export function loadContent() {
  if (!pending) pending = import('../../data/patd/content.json').then((m) => indexContent(m.default ?? m));
  return pending;
}

// `null` until loaded.
export function useContent() {
  const [idx, setIdx] = useState(null);
  useEffect(() => {
    let alive = true;
    loadContent()
      .then((i) => alive && setIdx(i))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, []);
  return idx;
}

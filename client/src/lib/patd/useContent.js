import { useEffect, useMemo, useState } from 'react';
import { indexContent } from './content.js';
import { mergeHomebrew } from './homebrew.js';
import { getHomebrew } from '../api.js';
import { socket } from '../../socket.js';
import { useRole } from '../../roleContext.jsx';

// The rules content, loaded on first use (a separate ~1.2MB chunk, so pages
// that never open a Combat tab never download it) and indexed once — plus the
// GM's homebrew items (client/src/lib/patd/homebrew.js), kept live over
// `homebrew:updated`. The GM's index lists drafts; a player's lists only
// published items (drafts stay resolvable for characters already using them).
let pending = null;
export function loadContent() {
  if (!pending) pending = import('../../data/patd/content.json').then((m) => indexContent(m.default ?? m));
  return pending;
}

let hbItems = null;
let hbPending = null;
const hbListeners = new Set();
const setItems = (items) => {
  hbItems = items;
  for (const l of hbListeners) l(items);
};
socket.on('homebrew:updated', ({ items }) => setItems(items ?? []));
socket.on('connect', () => {
  if (hbItems) getHomebrew().then(({ items }) => setItems(items ?? [])).catch(() => {});
});
function loadHomebrewItems() {
  if (!hbPending) hbPending = getHomebrew().then(({ items }) => (hbItems ??= items ?? []));
  return hbPending;
}

// The homebrew items as saved (null until loaded).
export function useHomebrewItems() {
  const [items, setLocal] = useState(hbItems);
  useEffect(() => {
    hbListeners.add(setLocal);
    loadHomebrewItems()
      .then(() => setLocal(hbItems))
      .catch(console.error);
    return () => hbListeners.delete(setLocal);
  }, []);
  return items;
}

// The book's own index (no homebrew), `null` until loaded.
export function useBookContent() {
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

// The merged index, `null` until both are loaded.
export function useContent() {
  const book = useBookContent();
  const items = useHomebrewItems();
  const { role } = useRole();
  return useMemo(() => {
    if (!book || !items) return null;
    if (!items.length) return book;
    try {
      return indexContent(mergeHomebrew(book.content, items, { listDrafts: role === 'gm' }));
    } catch (err) {
      console.error(err);
      return book;
    }
  }, [book, items, role]);
}

import { useEffect, useMemo, useState } from 'react';
import { indexContent } from './content.js';
import { mergeHomebrew } from './homebrew.js';
import { applyRulings } from './rulings.js';
import { getHomebrew } from '../api.js';
import { socket } from '../../socket.js';
import { useRole } from '../../roleContext.jsx';

// The rules content, loaded on first use (a separate ~1.2MB chunk, so pages
// that never open a Combat tab never download it) and indexed once — plus the
// GM's homebrew items (client/src/lib/patd/homebrew.js), kept live over
// `homebrew:updated` with Claude's automation on top. The GM's index lists
// drafts; a player's lists only published items (drafts stay resolvable for
// characters already using them).
let pending = null;
export function loadContent() {
  if (!pending) pending = import('../../data/patd/content.json').then((m) => indexContent(applyRulings(m.default ?? m)));
  return pending;
}

// The homebrew state: { items, automation, coreIds } (automation: Claude's
// map from homebrew/automation.json; coreIds: the items in the committed core).
let hbState = null;
let hbPending = null;
const hbListeners = new Set();
const shape = (p) => ({ items: p?.items ?? [], automation: p?.automation ?? null, coreIds: p?.coreIds ?? [] });
const setState = (payload) => {
  hbState = shape(payload);
  for (const l of hbListeners) l(hbState);
};
socket.on('homebrew:updated', setState);
socket.on('connect', () => {
  if (hbState) getHomebrew().then(setState).catch(() => {});
});
function loadHomebrewState() {
  if (!hbPending) hbPending = getHomebrew().then((p) => (hbState ??= shape(p)));
  return hbPending;
}

// The homebrew state as saved (null until loaded).
export function useHomebrewState() {
  const [state, setLocal] = useState(hbState);
  useEffect(() => {
    hbListeners.add(setLocal);
    loadHomebrewState()
      .then(() => setLocal(hbState))
      .catch(console.error);
    return () => hbListeners.delete(setLocal);
  }, []);
  return state;
}

// The homebrew items as saved (null until loaded).
export function useHomebrewItems() {
  return useHomebrewState()?.items ?? null;
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
  const hb = useHomebrewState();
  const { role } = useRole();
  return useMemo(() => {
    if (!book || !hb) return null;
    if (!hb.items.length) return book;
    try {
      return indexContent(mergeHomebrew(book.content, hb.items, { listDrafts: role === 'gm', automation: hb.automation }));
    } catch (err) {
      console.error(err);
      return book;
    }
  }, [book, hb, role]);
}

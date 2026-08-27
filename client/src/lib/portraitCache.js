import { useEffect, useState } from 'react';

// One decoded image per distinct picture, however many times it is on screen.
//
// **The problem this solves.** Portraits live in the database as base64 and are
// rendered as `data:` URIs. A `data:` URI is not cached by anything — it is not
// a URL, it is the bytes themselves — so twenty nodes of the same NPC is the
// same ~150KB string parsed, decoded and rasterised twenty times, and the
// Relationships board is the first place in this app where the same person can
// appear on screen more than once.
//
// A `blob:` URL *is* a URL, so the browser decodes it once and every `<img>`
// pointing at it shares that decode. This module hands out one blob per
// distinct picture and keeps it alive while anything is using it.
//
// **Reference counted, because a blob URL leaks by design.** The bytes stay in
// memory until `revokeObjectURL`, so entries are counted in and out and revoked
// when the last user unmounts. Getting that wrong the other way — revoking
// while somebody still renders it — shows as a broken image, which is why the
// count is on the entry rather than a timer.

const cache = new Map(); // key -> { url, refs }

function keyFor(record) {
  if (!record?.image_data) return null;
  // Identity plus a cheap fingerprint of the bytes: a character keeps its id
  // when the GM uploads a new portrait, so the id alone would serve the old
  // picture forever.
  const id = record.id ?? 'x';
  const kind = record.character_type != null ? 'c' : 'p';
  return `${kind}${id}:${record.image_data.length}:${record.image_data.slice(0, 24)}`;
}

function toBlobUrl(record) {
  const binary = atob(record.image_data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: record.image_mime_type || 'image/jpeg' }));
}

function acquire(key, record) {
  const existing = cache.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.url;
  }
  const url = toBlobUrl(record);
  cache.set(key, { url, refs: 1 });
  return url;
}

function release(key) {
  const entry = cache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  URL.revokeObjectURL(entry.url);
  cache.delete(key);
}

// Returns a URL for this record's picture, or null when it has none. Falls back
// to a plain `data:` URI if anything about the conversion fails — a broken
// portrait is never worth a broken board.
export function usePortraitUrl(record) {
  const key = keyFor(record);
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!key || !record?.image_data) {
      setUrl(null);
      return undefined;
    }
    let acquired = null;
    try {
      acquired = acquire(key, record);
      setUrl(acquired);
    } catch {
      setUrl(`data:${record.image_mime_type || 'image/jpeg'};base64,${record.image_data}`);
      return undefined;
    }
    return () => release(key);
    // Keyed on the fingerprint, not the record object: the board hands down a
    // fresh object on every broadcast and re-acquiring each time would churn a
    // blob per Stamina tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return url;
}

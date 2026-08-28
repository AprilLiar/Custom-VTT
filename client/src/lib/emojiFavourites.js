// Which emoji this viewer reaches for, kept between sessions.
//
// **localStorage, like every other per-viewer preference** — the camera on the
// relationships board, "show retired", the brand hue in Settings. This app has
// no accounts by design, so "per user" is "per browser": there is nowhere else
// a personal preference could live, and a shared column would make one player's
// favourites everybody's.
//
// Wrapped in try/catch on both sides: a private window can throw on access, and
// a list of favourite emoji is never worth breaking a tab over.

const KEY = 'vtt.emoji.favourites';

// Enough to be useful, few enough that the row stays one or two lines and the
// picker does not turn into a second scrolling list.
export const MAX_FAVOURITES = 16;

export function loadFavourites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    // Filtered on the way OUT as well as in: the stored value is user-editable
    // in any devtools, and a number or an object in this list would be rendered
    // straight into a button.
    return parsed.filter((e) => typeof e === 'string' && e.length > 0).slice(0, MAX_FAVOURITES);
  } catch {
    return [];
  }
}

export function saveFavourites(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_FAVOURITES)));
  } catch {
    /* private window, or storage full — a favourites list is not worth an error */
  }
}

export const isFavourite = (list, emoji) => list.includes(emoji);

// Toggle, and return the new list rather than mutating: the caller holds it in
// React state, where a mutated array would not re-render.
//
// A new favourite goes on the FRONT. The one you just picked is the one you are
// most likely to want again, and appending would bury it behind fifteen older
// ones — which is the whole reason the row exists.
export function toggleFavourite(list, emoji) {
  if (typeof emoji !== 'string' || !emoji) return list;
  if (list.includes(emoji)) return list.filter((e) => e !== emoji);
  return [emoji, ...list].slice(0, MAX_FAVOURITES);
}

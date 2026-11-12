import { useCharacterList } from './sceneLists.js';

// The world's character roster, kept live: one copy shared by every component,
// loaded once per session (lib/sceneLists.js — play feedback 8). An update's
// payload is merged in place; only a new or deleted folder or character reloads.
// **Returns `null` until the first load lands**, so a caller can tell "not
// loaded yet" from "no characters".
export function useRoster() {
  return useCharacterList();
}

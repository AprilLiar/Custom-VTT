import { useEffect, useState } from 'react';
import { getLink, onLinkChange } from './attackTelegraph.js';

// Subscribe to the Attack telegraph's current Tell<->Tic link (see
// attackTelegraph.js). Kept out of that module so it stays React-free and
// its pure timing helpers can be unit-tested under plain `node --test`
// alongside the server's own — same split useMediaQuery.js already uses.
export default function useMoveLink() {
  const [link, setLink] = useState(getLink);
  useEffect(() => onLinkChange(setLink), []);
  return link;
}

// Convenience for the two anchor components, which only ever ask "am I the
// one being pointed at right now?".
export function useIsLinked(declaredMoveId) {
  const { ids } = useMoveLink();
  return declaredMoveId != null && ids.includes(declaredMoveId);
}

import { useEffect, useState } from 'react';

// Mobile readiness (Change 002): a single shared media-query hook so every
// component that needs to branch on viewport/pointer type (bottom nav vs.
// header links, tap-to-declare vs. drag, coarse-pointer touch targets)
// reads the same live value instead of each re-deriving its own
// window.matchMedia call. Re-evaluates on browser resize/rotation, not just
// at mount, so rotating a tablet or resizing a desktop window updates it.
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

// The one shared mobile/desktop breakpoint used across the app shell,
// Arena, and every dialog — matches Tailwind's own `md` (768px).
export const useIsDesktop = () => useMediaQuery('(min-width: 768px)');
export const useIsCoarsePointer = () => useMediaQuery('(pointer: coarse)');

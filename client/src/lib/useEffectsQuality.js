import { useEffect, useState } from 'react';
import { loadEffectsQuality } from './theme.js';

// Visual Overhaul (Ink & Impact): one shared subscription to the effects
// tier, so a component branching on it (InkImpactLayer, InkBackdrop, and
// every CSS-fallback call site) reads the same live value instead of each
// re-reading localStorage at mount and then never noticing a change.
//
// Two things can move the value under a mounted component:
//   - the Settings page saving a new choice (the 'vtt:effects-quality'
//     event saveEffectsQuality dispatches), and
//   - the OS reduced-motion preference flipping, which overrides any
//     stored choice and so has to be watched directly rather than assumed
//     constant for the page load.
//
// Follows lib/useMediaQuery.js's shape deliberately: same live-value,
// same cleanup, so there is one hook idiom in this codebase and not two.
export function useEffectsQuality() {
  const [quality, setQuality] = useState(loadEffectsQuality);

  useEffect(() => {
    const sync = () => setQuality(loadEffectsQuality());
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    window.addEventListener('vtt:effects-quality', sync);
    mql.addEventListener('change', sync);
    // Another tab changing the setting writes localStorage but fires no
    // in-page event, so 'storage' is the only signal there is for it.
    window.addEventListener('storage', sync);
    sync();
    return () => {
      window.removeEventListener('vtt:effects-quality', sync);
      mql.removeEventListener('change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return quality;
}

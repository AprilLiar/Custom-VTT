import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useIsDesktop, useIsLandscape } from '../lib/useMediaQuery.js';
import OrientationGate from './OrientationGate.jsx';

// The Scene tab's fullscreen canvas (Scene tab plan, Phase 1: the route
// skeleton — Phase 4 wires it to the live `stage:updated` broadcast and
// Phase 5 adds summoning). Mounted chrome-free by App.jsx's `Shell()` — see
// that file's own comment for why this route skips the header/bottom-nav
// entirely rather than painting over them.
//
// `useRole()` (GM's drawers vs. a Player's own summon control) arrives with
// Phase 2 onward; for now both roles see the same empty stage.
export default function ScenePage() {
  const isDesktop = useIsDesktop();
  const isLandscape = useIsLandscape();

  // Decided: no portrait layout for the stage is ever built. Desktop is
  // never gated, regardless of window aspect — see useIsLandscape's own
  // comment for why the width check has to live with the caller.
  if (!isDesktop && !isLandscape) {
    return (
      <div className="relative flex h-full w-full flex-col">
        <OrientationGate />
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-zinc-950 text-zinc-500">
      {/* The one way off this route — App.jsx's chromeless branch mounts no
          header, no bottom nav, nothing else that navigates. */}
      <Link
        to="/combat"
        title="Back to the Arena"
        className="absolute left-3 top-3 flex h-11 w-11 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-brand-500 hover:text-brand-300"
        style={{ marginTop: 'var(--safe-top)', marginLeft: 'var(--safe-left)' }}
      >
        <ArrowLeft size={18} aria-hidden />
      </Link>
      <p className="font-display text-sm uppercase tracking-wide">No Scene active yet.</p>
    </div>
  );
}

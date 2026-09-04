import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useIsDesktop, useIsLandscape } from '../lib/useMediaQuery.js';
import { useRole } from '../roleContext.jsx';
import { useStage } from '../lib/useStage.js';
import OrientationGate from './OrientationGate.jsx';
import SceneCastDrawer from './SceneCastDrawer.jsx';
import SceneListDrawer from './SceneListDrawer.jsx';

// The Scene tab's fullscreen canvas (Scene tab plan, Phase 1: the route
// skeleton — Phase 4 wires it to the live `stage:updated` broadcast via
// `useStage()`; Phase 5 adds summoning). Mounted chrome-free by App.jsx's
// `Shell()` — see that file's own comment for why this route skips the
// header/bottom-nav entirely rather than painting over them.
//
// `SceneCastDrawer` (Phase 2, left) and `SceneListDrawer` (Phase 4, right)
// are the GM's overlays on top of the same canvas everyone shares — a
// Player never sees either, matching decision #2. Activating a Scene force-
// navigates every connected client here (App.jsx's Shell(), not this file —
// see that listener's own comment for why it can't live on this page: a
// Player being cut to /scene is the whole point, so the code doing the
// cutting has to run BEFORE this component even mounts).
export default function ScenePage() {
  const isDesktop = useIsDesktop();
  const isLandscape = useIsLandscape();
  const { role } = useRole();
  const stage = useStage();

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

  const activeScene = stage?.activeScene ?? null;
  const backgroundSrc = activeScene?.image_data
    ? `data:${activeScene.image_mime_type || 'image/jpeg'};base64,${activeScene.image_data}`
    : null;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-zinc-950 text-zinc-500">
      {backgroundSrc && (
        <img
          src={backgroundSrc}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          // Decorative — the Scene's own name is announced by the GM
          // activating it, not read off this backdrop image.
          aria-hidden
        />
      )}
      {/* The one way off this route — App.jsx's chromeless branch mounts no
          header, no bottom nav, nothing else that navigates. z-20 so it
          stays above the drawers' own z-10, which dock to the same corners
          for a GM. */}
      <Link
        to="/combat"
        title="Back to the Arena"
        className="absolute left-3 top-3 z-20 flex h-11 w-11 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-brand-500 hover:text-brand-300"
        style={{ marginTop: 'var(--safe-top)', marginLeft: 'var(--safe-left)' }}
      >
        <ArrowLeft size={18} aria-hidden />
      </Link>
      {!activeScene && (
        <p className="relative font-display text-sm uppercase tracking-wide">No Scene active yet.</p>
      )}
      {activeScene && !backgroundSrc && (
        <p className="relative font-display text-sm uppercase tracking-wide">{activeScene.name}</p>
      )}
      {role === 'gm' && <SceneCastDrawer />}
      {role === 'gm' && <SceneListDrawer activeSceneId={activeScene?.id ?? null} />}
    </div>
  );
}

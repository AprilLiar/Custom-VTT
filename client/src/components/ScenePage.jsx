import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useIsDesktop, useIsLandscape } from '../lib/useMediaQuery.js';
import { useRole } from '../roleContext.jsx';
import { useStage } from '../lib/useStage.js';
import { DRAWER_WIDTH } from '../lib/sceneLayout.js';
import OrientationGate from './OrientationGate.jsx';
import SceneCastDrawer from './SceneCastDrawer.jsx';
import SceneListDrawer from './SceneListDrawer.jsx';
import StageRoster from './StageRoster.jsx';
import PlayerSummonDock from './PlayerSummonDock.jsx';

// The Scene tab's fullscreen canvas (Scene tab plan, Phase 1: the route
// skeleton; Phase 4 wired the live backdrop via `useStage()`; Phase 5 adds
// the summoned roster itself). Mounted chrome-free by App.jsx's `Shell()`
// — see that file's own comment for why this route skips the header/
// bottom-nav entirely rather than painting over them.
//
// `SceneCastDrawer` (Phase 2, left) and `SceneListDrawer` (Phase 4, right)
// are the GM's overlays on top of the same canvas everyone shares —
// `PlayerSummonDock` (Phase 5) is a Player's own equivalent, scoped to
// just their own character. A Player never sees either drawer, matching
// decision #2. Activating a Scene force-navigates every connected client
// here (App.jsx's Shell(), not this file — see that listener's own
// comment for why it can't live on this page: a Player being cut to
// /scene is the whole point, so the code doing the cutting has to run
// BEFORE this component even mounts).
export default function ScenePage() {
  const isDesktop = useIsDesktop();
  const isLandscape = useIsLandscape();
  const { role, characterId } = useRole();
  const stage = useStage();

  // A callback ref, not useRef: the orientation gate below swaps in a
  // completely different tree, so the stage element itself can go from
  // absent to present (or back) across a render — a plain ref's own effect
  // only runs once at mount and would miss that transition. `stageWidth`
  // is what `layoutStage` needs to know how much room the roster has.
  const [stageEl, setStageEl] = useState(null);
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    if (!stageEl) return;
    const observer = new ResizeObserver((entries) => setStageWidth(entries[0].contentRect.width));
    observer.observe(stageEl);
    return () => observer.disconnect();
  }, [stageEl]);

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
  const summons = stage?.summons ?? [];
  const backgroundSrc = activeScene?.image_data
    ? `data:${activeScene.image_mime_type || 'image/jpeg'};base64,${activeScene.image_data}`
    : null;

  return (
    <div
      ref={setStageEl}
      className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-zinc-950 text-zinc-500"
    >
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
      {/* A GM's own drawers sit directly over the canvas's left/right
          edges — the same edges decision #3 wants a GM's own summons
          entering from. Without insetting, a small right-side roster
          would render entirely underneath SceneListDrawer, invisible and
          unclickable behind it (see DRAWER_WIDTH's own comment). A Player
          has no drawers, so their stage uses the full measured width. */}
      {stageWidth > 0 && (
        <StageRoster
          summons={summons}
          stageWidth={role === 'gm' ? Math.max(0, stageWidth - DRAWER_WIDTH * 2) : stageWidth}
          offsetX={role === 'gm' ? DRAWER_WIDTH : 0}
          canRemove={role === 'gm'}
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
      {/* z-[2]: summons are independent of the active Scene (decision #6),
          so this text can be on screen at the same time as StageRoster's
          own z-[1] stacking context — it needs to sit above that, not
          fall into the DOM-order tiebreak a bare z-index:auto would lose. */}
      {!activeScene && (
        <p className="relative z-[2] font-display text-sm uppercase tracking-wide">No Scene active yet.</p>
      )}
      {activeScene && !backgroundSrc && (
        <p className="relative z-[2] font-display text-sm uppercase tracking-wide">{activeScene.name}</p>
      )}
      {role === 'gm' && <SceneCastDrawer />}
      {role === 'gm' && <SceneListDrawer activeSceneId={activeScene?.id ?? null} />}
      {role === 'player' && <PlayerSummonDock characterId={characterId} summons={summons} />}
    </div>
  );
}

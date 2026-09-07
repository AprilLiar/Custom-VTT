import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, StickyNote } from 'lucide-react';
import { useIsDesktop, useIsLandscape } from '../lib/useMediaQuery.js';
import { useRole } from '../roleContext.jsx';
import { useStage } from '../lib/useStage.js';
import {
  loadSceneHeightScale,
  loadSceneGapScale,
  loadSceneSizeScale,
  loadSceneShowNameplates,
} from '../lib/sceneSettings.js';
import OrientationGate from './OrientationGate.jsx';
import SceneCastDrawer from './SceneCastDrawer.jsx';
import SceneListDrawer from './SceneListDrawer.jsx';
import SceneNotesDialog from './SceneNotesDialog.jsx';
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

  // Cinematic mode: a purely local viewing preference (never socket-synced
  // — hiding your OWN interface says nothing about the shared game state,
  // unlike everything else this page touches). Hides every overlay control
  // down to just the backdrop and the summoned figures. **Exits only via
  // the same toggle button, not by tapping the stage (decided, revised):**
  // the original "tap anywhere to bring it back" was dropped once figures
  // themselves became draggable — a drag necessarily starts with a press
  // on the stage, which would have fought with "any tap exits," either
  // stealing the first frame of every drag to close cinematic mode or
  // exiting it under a GM mid-repositioning a character. The toggle button
  // itself now stays visible and is the ONLY UI element shown while
  // hidden (see TopLeftControls below) — there is deliberately no second
  // way in or out any more.
  const [uiHidden, setUiHidden] = useState(false);

  // GM Notes (decided, new) — a dialog, not a docked drawer like
  // SceneCastDrawer/SceneListDrawer, since it's opened on demand rather
  // than needed at a glance the whole time the GM is on this page.
  const [notesOpen, setNotesOpen] = useState(false);

  // Scene Settings (client/src/lib/sceneSettings.js) — same "read once,
  // per-device, never socket-synced" shape as Cutscene Speed on the
  // Settings page. Read here rather than inside StageRoster so a setting
  // change takes effect on the next visit to /scene (a fresh mount) without
  // that component needing to know settings exist at all.
  const [heightScale] = useState(loadSceneHeightScale);
  const [gapScale] = useState(loadSceneGapScale);
  const [sizeScale] = useState(loadSceneSizeScale);
  const [showNameplates] = useState(loadSceneShowNameplates);

  // Decided: no portrait layout for the stage is ever built. Desktop is
  // never gated, regardless of window aspect — see useIsLandscape's own
  // comment for why the width check has to live with the caller.
  if (!isDesktop && !isLandscape) {
    return (
      <div className="relative flex h-full w-full flex-col">
        <OrientationGate />
        {/* The chromeless route (App.jsx's Shell()) mounts no header, no
            bottom nav — without this, a phone-width Player stuck in
            portrait had no way off the route at all short of rotating the
            device just to reach the corner link below. */}
        <TopLeftControls />
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
      {/* The whole measured canvas, full width, for every role — the
          cinematic look with the interface hidden entirely (see
          `uiHidden` below) is the benchmark this page is built to match,
          so the figures are never narrowed to "the gap between the
          drawers" the way an earlier pass had them for a GM. Artwork is
          allowed to render behind the drawers on their own translucent
          `bg-zinc-950/90` — intended, not a layout bug. Rendered
          regardless of `uiHidden` — the figures themselves are the one
          thing cinematic mode never hides. */}
      {stageWidth > 0 && (
        <StageRoster
          summons={summons}
          stageWidth={stageWidth}
          heightScale={heightScale}
          gapScale={gapScale}
          sizeScale={sizeScale}
          showNameplates={showNameplates}
          role={role}
          characterId={characterId}
        />
      )}
      {/* The one way off this route (the back-arrow) plus the hide-interface
          toggle — rendered unconditionally now, outside the `!uiHidden` gate
          below, so the toggle itself stays reachable while hidden (see
          TopLeftControls: it hides the back-arrow but never itself while
          `uiHidden`). z-20 so it stays above the drawers' own z-10, which
          dock to the same corners for a GM, and above StageRoster's figures. */}
      <TopLeftControls
        uiHidden={uiHidden}
        onToggleUi={() => setUiHidden((v) => !v)}
        onOpenNotes={role === 'gm' ? () => setNotesOpen(true) : undefined}
      />
      {!uiHidden && (
        <>
          {/* z-[2]: summons are independent of the active Scene (decision
              #6), so this text can be on screen at the same time as
              StageRoster's own z-[1] stacking context — it needs to sit
              above that, not fall into the DOM-order tiebreak a bare
              z-index:auto would lose. */}
          {!activeScene && (
            <p className="relative z-[2] font-display text-sm uppercase tracking-wide">No Scene active yet.</p>
          )}
          {activeScene && !backgroundSrc && (
            <p className="relative z-[2] font-display text-sm uppercase tracking-wide">{activeScene.name}</p>
          )}
          {role === 'gm' && <SceneCastDrawer />}
          {role === 'gm' && <SceneListDrawer activeSceneId={activeScene?.id ?? null} />}
          {role === 'player' && <PlayerSummonDock characterId={characterId} summons={summons} />}
        </>
      )}
      {notesOpen && <SceneNotesDialog activeScene={activeScene} onClose={() => setNotesOpen(false)} />}
    </div>
  );
}

// The corner toolbar. The orientation gate's own call passes neither prop
// at all: there's nothing to hide yet, just the rotate-prompt and the
// back-arrow as this route's one way out.
//
// **The toggle button is the only element that survives `uiHidden`
// (decided, revised).** It used to disappear along with everything else in
// here, and tapping anywhere on the stage was the only way back — dropped
// once figures became draggable (see ScenePage's own `uiHidden` comment):
// a drag press on the stage would have fought with "any tap exits." The
// back-arrow (and the Notes button, GM-only, below) still hide — while
// cinematic mode is on, the toggle button really is meant to be the only
// UI element shown, and leaving either reachable would be a second,
// undocumented way out of it.
function TopLeftControls({ uiHidden, onToggleUi, onOpenNotes }) {
  return (
    <div
      className="absolute left-3 top-3 z-20 flex gap-2"
      style={{ marginTop: 'var(--safe-top)', marginLeft: 'var(--safe-left)' }}
    >
      {!uiHidden && (
        <Link
          to="/combat"
          title="Back to the Arena"
          className="flex h-11 w-11 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-brand-500 hover:text-brand-300"
        >
          <ArrowLeft size={18} aria-hidden />
        </Link>
      )}
      {!uiHidden && onOpenNotes && (
        <button
          type="button"
          onClick={onOpenNotes}
          title="Notes"
          className="flex h-11 w-11 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-brand-500 hover:text-brand-300"
        >
          <StickyNote size={18} aria-hidden />
        </button>
      )}
      {onToggleUi && (
        <button
          type="button"
          onClick={onToggleUi}
          title={uiHidden ? 'Show interface' : 'Hide interface'}
          className="flex h-11 w-11 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-brand-500 hover:text-brand-300"
        >
          {uiHidden ? <Eye size={18} aria-hidden /> : <EyeOff size={18} aria-hidden />}
        </button>
      )}
    </div>
  );
}

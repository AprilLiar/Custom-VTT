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
  loadSceneDrawColor,
  saveSceneDrawColor,
  loadScenePenWidth,
  saveScenePenWidth,
  loadSceneEraserWidth,
  saveSceneEraserWidth,
  loadTimestampDuration,
} from '../lib/sceneSettings.js';
import { socket } from '../socket.js';
import OrientationGate from './OrientationGate.jsx';
import SceneCastDrawer from './SceneCastDrawer.jsx';
import SceneListDrawer from './SceneListDrawer.jsx';
import SceneNotesDialog from './SceneNotesDialog.jsx';
import SceneTimestampDialog from './SceneTimestampDialog.jsx';
import TimestampCutscene from './TimestampCutscene.jsx';
import StageRoster from './StageRoster.jsx';
import SceneDrawingLayer from './SceneDrawingLayer.jsx';
import SceneDrawToolbar from './SceneDrawToolbar.jsx';
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
  const identity = role === 'gm' ? { role: 'gm' } : role === 'player' ? { role: 'player', characterId } : undefined;
  const stage = useStage(identity);

  // A callback ref, not useRef: the orientation gate below swaps in a
  // completely different tree, so the stage element itself can go from
  // absent to present (or back) across a render — a plain ref's own effect
  // only runs once at mount and would miss that transition. `stageWidth` is
  // what `layoutStage` needs to know how much room the roster has;
  // `stageHeight` joins it for the image-projection fix below (bugfix:
  // manually-placed summons syncing wrong vertically between viewers) —
  // `layoutStage` itself still only ever reads `stageWidth`, unchanged.
  const [stageEl, setStageEl] = useState(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  useEffect(() => {
    if (!stageEl) return;
    const observer = new ResizeObserver((entries) => {
      setStageWidth(entries[0].contentRect.width);
      setStageHeight(entries[0].contentRect.height);
    });
    observer.observe(stageEl);
    return () => observer.disconnect();
  }, [stageEl]);

  // The backdrop's own natural pixel size — what `sceneProjection.js` needs
  // to replicate `object-cover`'s crop math so a manually-placed summon's
  // position means the same visual spot in the ARTWORK for every viewer,
  // not just the same fraction of each viewer's own differently-shaped
  // stage box (see StageRoster.jsx's own comment on `imageNaturalWidth`/
  // `imageNaturalHeight` for the full reasoning). Reset alongside
  // `backgroundSrc` itself (the effect below) so a Scene switch never
  // renders new positions through the PREVIOUS image's own dimensions for
  // the one frame before the new image's onLoad fires.
  const [imageNatural, setImageNatural] = useState({ width: 0, height: 0 });
  // Computed here (not down with `backgroundSrc`'s own former spot, after
  // the orientation-gate return below) purely so this reset effect can key
  // off it — every Hook in this component has to run on every render,
  // including the portrait-gate's early return path, so anything a Hook
  // depends on has to be computed before that return, not after it.
  const activeScene = stage?.activeScene ?? null;
  const backgroundSrc = activeScene?.image_data
    ? `data:${activeScene.image_mime_type || 'image/jpeg'};base64,${activeScene.image_data}`
    : null;
  useEffect(() => {
    setImageNatural({ width: 0, height: 0 });
  }, [backgroundSrc]);

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

  // Timestamps (decided, new) — same on-demand dialog shape as Notes above,
  // opened from SceneDrawToolbar's own bottom-right dock instead of
  // TopLeftControls (see that file's own comment on why it lives there).
  const [timestampsOpen, setTimestampsOpen] = useState(false);

  // Scene Settings (client/src/lib/sceneSettings.js) — same "read once,
  // per-device, never socket-synced" shape as Cutscene Speed on the
  // Settings page. Read here rather than inside StageRoster so a setting
  // change takes effect on the next visit to /scene (a fresh mount) without
  // that component needing to know settings exist at all.
  const [heightScale] = useState(loadSceneHeightScale);
  const [gapScale] = useState(loadSceneGapScale);
  const [sizeScale] = useState(loadSceneSizeScale);
  const [showNameplates] = useState(loadSceneShowNameplates);
  const [timestampDuration] = useState(loadTimestampDuration);

  // Draw tool (decided, new) — available to BOTH roles, unlike everything
  // else on this page. `tool` itself ('select' | 'pen' | 'erase') is
  // per-VIEWING-session state, same as `uiHidden`: whether YOUR OWN pointer
  // is currently drawing says nothing about anyone else's. `color`/
  // `penWidth`/`eraserWidth` start from this device's own remembered
  // values (sceneSettings.js) and are re-saved on every change, unlike the
  // read-once display sliders above — "remember the last … settings for
  // each user" means live, not just at load.
  const [tool, setTool] = useState('select');
  const [drawColor, setDrawColor] = useState(loadSceneDrawColor);
  const [penWidth, setPenWidth] = useState(loadScenePenWidth);
  const [eraserWidth, setEraserWidth] = useState(loadSceneEraserWidth);
  const changeDrawColor = (c) => setDrawColor(saveSceneDrawColor(c));
  const changePenWidth = (w) => setPenWidth(saveScenePenWidth(w));
  const changeEraserWidth = (w) => setEraserWidth(saveSceneEraserWidth(w));
  const clearAllDrawings = () => {
    if (window.confirm('Erase every drawing on this Scene? This cannot be undone.')) {
      socket.emit('scene_draw:clear');
    }
  };

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

  const summons = stage?.summons ?? [];
  const drawings = stage?.drawings ?? [];

  return (
    <div
      ref={setStageEl}
      className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-zinc-950 text-zinc-500"
    >
      {backgroundSrc && (
        <img
          src={backgroundSrc}
          alt=""
          // Captures the ONE thing sceneProjection.js needs that CSS itself
          // never exposes — the image's own natural size, before
          // object-cover scales/crops it to fit.
          onLoad={(e) => setImageNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
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
          stageHeight={stageHeight}
          imageNaturalWidth={imageNatural.width}
          imageNaturalHeight={imageNatural.height}
          heightScale={heightScale}
          gapScale={gapScale}
          sizeScale={sizeScale}
          showNameplates={showNameplates}
          role={role}
          characterId={characterId}
        />
      )}
      {/* A sibling of StageRoster, not a child — see this component's own
          header comment for why nesting it inside the roster's own capped
          stacking context would hide a drawing under a manually-placed
          figure. Rendered unconditionally, same as StageRoster: drawings
          are part of the Scene itself, not UI chrome, so cinematic mode
          never hides them either. */}
      {stageWidth > 0 && (
        <SceneDrawingLayer
          drawings={drawings}
          stageWidth={stageWidth}
          stageHeight={stageHeight}
          imageNaturalWidth={imageNatural.width}
          imageNaturalHeight={imageNatural.height}
          tool={tool}
          color={drawColor}
          penWidth={penWidth}
          eraserWidth={eraserWidth}
        />
      )}
      {/* Also unconditional, same reasoning as StageRoster/SceneDrawingLayer
          above: a Timestamp's play beat is narrative content, not a UI
          control, so cinematic mode never hides it either — nor does it
          need `stageWidth > 0`, since it renders nothing until a
          `stage:timestamp_played` event actually arrives. */}
      <TimestampCutscene duration={timestampDuration} />
      {/* The one way off this route (the back-arrow) plus the hide-interface
          toggle — rendered unconditionally now, outside the `!uiHidden` gate
          below, so the toggle itself stays reachable while hidden (see
          TopLeftControls: it hides the back-arrow but never itself while
          `uiHidden`). z-[1000] — above SceneDrawingLayer's own
          STAGE_DRAWING_Z (700, see that file), so this corner's own toggle
          stays clickable even while the whole stage is capturing pointer
          events for an active draw/erase tool, not just above the drawers'
          plain z-10. */}
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
          {/* Pen/Eraser are both roles; the Timestamp button inside is
              GM-only — see SceneDrawToolbar's own header comment for the
              corner, z-index, and role reasoning. */}
          <SceneDrawToolbar
            tool={tool}
            onSelectTool={setTool}
            color={drawColor}
            onColorChange={changeDrawColor}
            penWidth={penWidth}
            onPenWidthChange={changePenWidth}
            eraserWidth={eraserWidth}
            onEraserWidthChange={changeEraserWidth}
            onClearAll={clearAllDrawings}
            role={role}
            onOpenTimestamps={role === 'gm' ? () => setTimestampsOpen(true) : undefined}
          />
        </>
      )}
      {notesOpen && <SceneNotesDialog activeScene={activeScene} onClose={() => setNotesOpen(false)} />}
      {timestampsOpen && <SceneTimestampDialog onClose={() => setTimestampsOpen(false)} />}
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
      className="absolute left-3 top-3 flex gap-2"
      style={{ zIndex: 1000, marginTop: 'var(--safe-top)', marginLeft: 'var(--safe-left)' }}
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

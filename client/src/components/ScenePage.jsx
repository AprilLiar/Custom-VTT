import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, StickyNote } from 'lucide-react';
import { useIsDesktop, useIsLandscape, useIsPhone } from '../lib/useMediaQuery.js';
import { useRole } from '../roleContext.jsx';
import { useControl } from '../lib/useControl.js';
import NowPlaying from './NowPlaying.jsx';
import { useAudioStatus } from '../lib/useAudioStatus.js';
import { openAudioPanel } from '../lib/audioPanel.js';
import { useStage } from '../lib/useStage.js';
import { useBoardFx } from '../lib/useBoardFx.js';
import SuperBanner from './fx/SuperBanner.jsx';
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
import { DEFAULT_BACKGROUND_FIT, backdropFitClassName } from '../lib/backgroundFit.js';
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
import SceneModeToggle from './SceneModeToggle.jsx';
import SceneChat from './SceneChat.jsx';
import SimpleCombatLane from './SimpleCombatLane.jsx';
import { MapTilePalette } from './MapTiles.jsx';
import CombatMap from './CombatMap.jsx';
import { CombatFightersDrawer, CombatMapDrawer } from './CombatDrawers.jsx';
import { ActionButton, FightSetupDialog, InitiativeRail, InterruptBar, InterruptLock, MoveBar, MovementPhaseBar, StancePrompt, StartCombatButton, TriggerPrompts } from './FightControls.jsx';
import ResolvingPlaque from './ResolvingPlaque.jsx';
import FullscreenButton from './FullscreenButton.jsx';
import { turnsPerRound } from '../lib/hpBars.js';
import { WEIGHT_BY_KEY } from '../lib/cinematicWeight.js';
import { useDominantColor } from '../lib/dominantColor.js';

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
  // Own PC plus NPCs the GM assigned to this player (see useControl).
  const { controls, controlled } = useControl();
  const identity = role === 'gm' ? { role: 'gm' } : role === 'player' ? { role: 'player', characterId } : undefined;
  const stage = useStage(identity);
  // A phone (play feedback 8): the fight UI is pared down for it.
  const isPhone = useIsPhone();
  // Board animations (decided): the beat playing, and the board held to it.
  const fx = useBoardFx(stage != null);
  // Nothing to hold: the stage's own lists, so nothing downstream sees new ones.
  const heldSummons = useMemo(() => {
    if (!fx.active) return stage?.summons ?? [];
    return (stage?.summons ?? []).map((x) => {
      if (!x.fight) return x;
      const real = x.lane_slot != null ? { col: x.lane_slot % 10, row: Math.floor(x.lane_slot / 10) } : null;
      const sq = x.fight.combatant_id != null ? fx.square(x.fight.combatant_id, real) : real;
      return { ...x, fight: fx.hold(x.fight), lane_slot: sq ? (sq.slot ?? sq.row * 10 + sq.col) : null };
    });
  }, [stage?.summons, fx]);
  const heldTokens = useMemo(() => {
    if (!fx.active) return stage?.combatTokens ?? [];
    return (stage?.combatTokens ?? []).map((t) => {
      const sq = fx.square(t.id, t.col != null ? { col: t.col, row: t.row } : null);
      return { ...t, fight: t.fight ? fx.hold(t.fight) : t.fight, col: sq?.col ?? null, row: sq?.row ?? null };
    });
  }, [stage?.combatTokens, fx]);
  const heldTileLists = useMemo(
    () => (fx.active ? { simple: fx.tiles(stage?.tiles?.simple ?? []), combat: fx.tiles(stage?.tiles?.combat ?? []) } : (stage?.tiles ?? { simple: [], combat: [] })),
    [stage?.tiles, fx]
  );

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
  // to replicate the active Scene's own fit-mode geometry so a manually-
  // placed summon's position means the same visual spot in the ARTWORK for
  // every viewer,
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
  const backgroundSrc = activeScene?.image_url
    ? activeScene.image_url
    : null;
  // Per-Scene, not per-viewer (decided — db.js's own comment on
  // scenes.background_fit): every viewer renders the SAME Scene's backdrop
  // with the SAME fit mode, and StageRoster/SceneDrawingLayer both need it
  // too (sceneProjection.js's own functions have to project a stored
  // image-fraction position through whichever fit mode is actually
  // rendering, or a manually-placed figure/drawing lands in the wrong spot
  // relative to the backdrop).
  const backgroundFit = activeScene?.background_fit || DEFAULT_BACKGROUND_FIT;
  // Panic at the Dojo: which view this Scene is in (GM's toggle), and the
  // backdrop colour Simple Combat's lane glows in.
  const sceneMode = activeScene?.combat_mode ?? 'scene';
  // The Combat map stays mounted once it has been shown (see the render below).
  const [combatSeen, setCombatSeen] = useState(false);
  // The Scene's drawers likewise (decided): switching to and from Combat never
  // remounts them, so the Scene list and the cast don't load again.
  const [sceneSeen, setSceneSeen] = useState(false);
  useEffect(() => {
    if (sceneMode === 'combat') setCombatSeen(true);
    else setSceneSeen(true);
  }, [sceneMode]);
  const laneGlow = useDominantColor(sceneMode === 'simple' ? backgroundSrc : null);
  useEffect(() => {
    setImageNatural({ width: 0, height: 0 });
  }, [backgroundSrc]);

  // **A backdrop can finish loading before React attaches `onLoad` below.**
  //
  // This used to be explained as a `data:` URI problem — no network round trip,
  // so decoding could beat the listener. The URIs are gone (backdrops are now
  // cacheable URLs), **and the race is exactly as live**: an `immutable` image
  // served straight out of the HTTP cache completes just as instantly as a
  // `data:` URI ever did. Anyone reading "this was a data: thing" and deleting
  // the effect brings back the bug it guards — `imageNaturalWidth/Height` stuck
  // at 0, `stageToImageFraction` falling back to {0,0}, and a figure that can be
  // dragged up but not down.
  //
  // Runs once per `backgroundSrc` change, right after the reset above, so it
  // never clobbers a `load` event this same commit's `onLoad` handler is about
  // to deliver on its own — it only fires when the image turns out to already
  // be `complete` by the time the effect runs.
  const backdropRef = useRef(null);
  useEffect(() => {
    const img = backdropRef.current;
    if (img?.complete && img.naturalWidth) {
      setImageNatural({ width: img.naturalWidth, height: img.naturalHeight });
    }
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

  // Panic at the Dojo, Phase 5: the Start Combat / Change sides dialog.
  const [fightSetupOpen, setFightSetupOpen] = useState(false);

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

  const summons = heldSummons;
  // **Temp NPCs take no part in combat (decided):** they stay on the Scene as
  // figures, but never stand on a Simple Combat lane or join a fight.
  const laneSummons = summons.filter((s) => s.character_id != null);
  const drawings = stage?.drawings ?? [];
  const combatTokens = heldTokens;
  // Combat mode is map only (decided): the backdrop, figures, drawings and
  // lane give way to the Combat Background, its grid and the tokens.
  const isCombat = sceneMode === 'combat';
  // Clear of the GM's two w-64 drawers while they are showing.
  const drawerInset = role === 'gm' && !uiHidden ? { left: 256, right: 256 } : undefined;
  // The fight this mode shows (Phase 5) and every fighter in it.
  const fightMode = sceneMode === 'simple' || sceneMode === 'combat' ? sceneMode : null;
  const fight = fightMode ? (stage?.fights?.[fightMode] ?? null) : null;
  // This fight's Cinematic Weight (GM Tools → Preset Narrative Combat Weight).
  const weight = fightMode ? (WEIGHT_BY_KEY[activeScene?.weights?.[fightMode]] ?? null) : null;
  const fightFighters = !fightMode
    ? []
    : fightMode === 'combat'
      ? combatTokens.map((t) => ({
          key: `c${t.id}`,
          ref: { combatantId: t.id },
          combatantId: t.id,
          characterId: t.character_id,
          name: t.name,
          image_url: t.image_url,
          crop: t.crop,
          turns: turnsPerRound(t.fight.hp),
        }))
      : laneSummons.map((s) => ({
          key: `s${s.id}`,
          ref: { summonId: s.id },
          combatantId: s.fight?.combatant_id ?? null,
          characterId: s.character_id,
          name: s.name,
          image_url: s.image_url,
          top: true,
          turns: turnsPerRound(s.fight?.hp ?? { bars: 1, broken: 0 }),
        }));

  return (
    <div
      ref={setStageEl}
      className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-zinc-950 text-zinc-500"
    >
      {/* **Kept mounted through Combat (decided, fix).** The backdrop, figures
          and drawings are hidden, not unmounted, while the Scene is in Combat,
          so leaving Combat shows them at once instead of reloading them.
          `display: contents` adds no box, so their layering is unchanged. */}
      <div style={{ display: isCombat ? 'none' : 'contents' }}>
      {backgroundSrc && (
        <img
          ref={backdropRef}
          src={backgroundSrc}
          alt=""
          // Captures the ONE thing sceneProjection.js needs that CSS itself
          // never exposes — the image's own natural size, before its own
          // fit mode scales/crops/stretches it to fit.
          onLoad={(e) => setImageNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className={backdropFitClassName(backgroundFit)}
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
          backgroundFit={backgroundFit}
          heightScale={heightScale}
          gapScale={gapScale}
          sizeScale={sizeScale}
          showNameplates={showNameplates}
          role={role}
          controls={controls}
          locked={sceneMode === 'simple'}
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
          backgroundFit={backgroundFit}
          tool={tool}
          color={drawColor}
          penWidth={penWidth}
          eraserWidth={eraserWidth}
        />
      )}
      </div>
      {/* Simple Combat's lane — on top of the stage, under the drawers. Not
          hidden by cinematic mode: like the figures, it is part of the
          scene rather than interface chrome. */}
      {stageWidth > 0 && sceneMode === 'simple' && (
        <SimpleCombatLane
          summons={laneSummons}
          stageWidth={stageWidth}
          stageHeight={stageHeight}
          glow={laneGlow}
          role={role}
          controls={controls}
          inset={drawerInset}
          lanes={stage?.simpleLanes ?? 1}
          laneY={stage?.laneY}
          setup={stage?.fighterSetup ?? {}}
          weight={weight}
          tiles={heldTileLists.simple ?? []}
          activeCombatantId={sceneMode === 'simple' ? (fight?.order?.[fight.turn_index]?.id ?? null) : null}
          armorUsed={sceneMode === 'simple' ? (fight?.armor_used ?? {}) : {}}
          fxBeat={fx.playing?.mode === 'simple' ? fx.playing : null}
        />
      )}
      {/* Likewise the Combat map stays mounted once seen, hidden outside
          Combat, so switching back is instant too. */}
      {stageWidth > 0 && (isCombat || combatSeen) && (
        <div style={{ display: isCombat ? 'contents' : 'none' }}>
        <CombatMap
          active={isCombat}
          scene={activeScene}
          tokens={combatTokens}
          setup={stage?.fighterSetup ?? {}}
          weight={weight}
          stageWidth={stageWidth}
          stageHeight={stageHeight}
          inset={drawerInset}
          role={role}
          controls={controls}
          tiles={heldTileLists.combat ?? []}
          activeCombatantId={isCombat ? (fight?.order?.[fight.turn_index]?.id ?? null) : null}
          armorUsed={isCombat ? (fight?.armor_used ?? {}) : {}}
          fxBeat={isCombat && fx.playing?.mode === 'combat' ? fx.playing : null}
          zoomButtons={!isPhone}
        />
        </div>
      )}
      {/* Also unconditional, same reasoning as StageRoster/SceneDrawingLayer
          above: a Timestamp's play beat is narrative content, not a UI
          control, so cinematic mode never hides it either — nor does it
          need `stageWidth > 0`, since it renders nothing until a
          `stage:timestamp_played` event actually arrives. */}
      <TimestampCutscene duration={timestampDuration} />
      {/* Board animations (phase 4): a Super Move's banner across the board. */}
      {fightMode && fx.playing?.mode === fightMode && (
        <SuperBanner
          beat={fx.playing}
          fighterOf={(id) => (fightMode === 'combat' ? combatTokens.find((t) => t.id === id) : laneSummons.find((x) => x.fight?.combatant_id === id)) ?? null}
        />
      )}
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
      <TopRightAudio uiHidden={uiHidden} role={role} />
      {!uiHidden && role === 'gm' && activeScene && <SceneModeToggle mode={sceneMode} />}
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
          {activeScene && !backgroundSrc && !isCombat && (
            <p className="relative z-[2] font-display text-sm uppercase tracking-wide">{activeScene.name}</p>
          )}
          {/* Both sets stay mounted once shown, hidden by display (decided):
              the tab switch shows them again without refetching anything. */}
          {(isCombat || combatSeen) && (
            <div style={{ display: isCombat ? 'contents' : 'none' }}>
              {role === 'gm' && <CombatFightersDrawer />}
              {role === 'gm' && <CombatMapDrawer scene={activeScene} tokenCount={combatTokens.length} />}
            </div>
          )}
          {(!isCombat || sceneSeen) && (
            <div style={{ display: isCombat ? 'none' : 'contents' }}>
              {role === 'gm' && <SceneCastDrawer />}
              {role === 'gm' && <SceneListDrawer activeSceneId={activeScene?.id ?? null} />}
              {role === 'player' && <PlayerSummonDock characters={controlled} summons={summons} />}
            </div>
          )}
          {/* Pen/Eraser are both roles; the Timestamp button inside is
              GM-only — see SceneDrawToolbar's own header comment for the
              corner, z-index, and role reasoning. */}
          {/* Not on a phone during Simple Combat (play feedback 8): the lane is for fighting. */}
          {!isCombat && !(isPhone && fight) && (
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
          )}
        </>
      )}
      {/* The fight (Phase 5): Start Combat (GM), the initiative rail, and the
          turn-start Stance pick — the prompt shows even in cinematic mode,
          since a turn cannot go on without it. */}
      {/* Map tiles (decided, new): the palette, at the left, in either fight mode. */}
      {/* Stays up with the interface hidden (decided), so tiles can be placed in cinematic mode. */}
      {/* On a phone only the lock (play feedback 8): Actions place tiles, or the GM at a computer. */}
      {/* Phones, either fight mode: a small fullscreen toggle, bottom-left; stays up in cinematic mode too. */}
      {fightMode && isPhone && <FullscreenButton left={role === 'gm' && !uiHidden ? 256 : 0} />}
      {fightMode && <MapTilePalette mode={fightMode} role={role} left={role === 'gm' && !uiHidden ? 256 : 0} lockOnly={isPhone} />}
      {!uiHidden && role === 'gm' && fightMode && !fight && <StartCombatButton onClick={() => setFightSetupOpen(true)} />}
      {/* The rail stays up in cinematic mode too (decided, mobile fix): the
          turn order and Next turn are needed mid-fight whatever the GM hides. */}
      {/* No turn order on a phone (play feedback 8): the Action / End Turn buttons say when it's yours. */}
      {fight && !isPhone && (
        <InitiativeRail
          mode={fightMode}
          fight={fight}
          fighters={fightFighters}
          role={role}
          left={role === 'gm' && !uiHidden ? 268 : 12}
          onEditSides={() => setFightSetupOpen(true)}
          weight={weight}
        />
      )}
      {fight && <StancePrompt mode={fightMode} fight={fight} fighters={fightFighters} role={role} controls={controls} />}
      {fight && <MovementPhaseBar mode={fightMode} fight={fight} fighters={fightFighters} role={role} controls={controls} />}
      {fight && <InterruptBar fight={fight} mode={fightMode} left={role === 'gm' && !uiHidden ? 268 : 8} />}
      {fight && <InterruptLock fight={fight} mode={fightMode} fighters={fightFighters} role={role} controls={controls} />}
      {fight && <ActionButton fight={fight} mode={fightMode} controls={controls} />}
      {fight && <ResolvingPlaque mode={fightMode} sceneId={activeScene?.id ?? null} />}
      <MoveBar />
      <TriggerPrompts />
      {fightSetupOpen && fightMode && (
        <FightSetupDialog mode={fightMode} fighters={fightFighters} existing={fight} onClose={() => setFightSetupOpen(false)} />
      )}
      {/* Chat on the Scene: floating cards for new entries and a chat button
          that opens the full log — both even with the interface hidden. */}
      <SceneChat />
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
// **What is playing, top-right over the stage.** Always present, not only in
// cinematic mode: a Player's top-right corner is empty either way, so there is
// nothing for it to fight with.
//
// The one collision is the GM's own SceneListDrawer, a full-height w-64 rail
// down the right edge whenever the interface is showing. Rather than paint over
// its first entry, the chip steps inboard of it in exactly that case — so it
// never covers the drawer, and never moves at all for a Player.
function TopRightAudio({ uiHidden, role }) {
  const audio = useAudioStatus();
  if (!audio.name) return null;
  const clearOfDrawer = role === 'gm' && !uiHidden;
  return (
    <div
      className={`absolute top-3 ${clearOfDrawer ? 'right-[17rem]' : 'right-3'}`}
      style={{ zIndex: 1000, marginTop: 'var(--safe-top)', marginRight: 'var(--safe-right)' }}
    >
      <NowPlaying variant="scene" onOpen={() => openAudioPanel(audio.playlistId)} />
    </div>
  );
}

function TopLeftControls({ uiHidden, onToggleUi, onOpenNotes }) {
  return (
    <div
      className="absolute left-3 top-3 flex gap-2"
      style={{ zIndex: 1000, marginTop: 'var(--safe-top)', marginLeft: 'var(--safe-left)' }}
    >
      {!uiHidden && (
        <Link
          to="/"
          title="Back"
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

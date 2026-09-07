import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { EyeOff, Maximize2, X } from 'lucide-react';
import { layoutStage, SLOT_WIDTH, SLOT_GAP } from '../lib/sceneLayout.js';
import { stageToImageFraction, imageFractionToStage } from '../lib/sceneProjection.js';
import { socket } from '../socket.js';
import HaloText from './HaloText.jsx';

// The base the "character height" Setting scales (client/src/lib/
// sceneSettings.js) — see this file's own `dvh`/70 comment below for why
// this number and this unit.
const BASE_HEIGHT_DVH = 70;

// Manually-placed figures sit on a flat elevated z-index, above whatever
// small 1..N range the auto-layout crowd's own per-side rank produces (see
// layoutStage) — see this file's own "two rosters" comment below for why
// there are two placement systems at all. An active drag/resize goes above
// even that, so a figure never visually vanishes behind a neighbor mid-
// gesture.
const MANUAL_Z = 500;
const ACTIVE_GESTURE_Z = 9000;
// **Two sibling containers, not one (decided, revised) — see the "two
// containers" comment on this file's own return statement for the full
// story.** The "crowd" container (`z-[1]`) is its own stacking context, a
// deliberate cap so a crowded roster's own internal z values (1..N per
// side, or MANUAL_Z for a placed figure) only ever compete with EACH
// OTHER, never with the GM drawers' own z-10 (SceneCastDrawer/
// SceneListDrawer, ScenePage.jsx) — bleeding art behind a translucent
// drawer is intentional (this file's own header comment). CSS stacking
// contexts nest strictly: no INTERNAL z-index, however high, can ever
// out-rank a SIBLING context of that container itself — confirmed live,
// the hard way, when this used to be ONE container whose OWN z-index got
// bumped while any figure was selected: MANUAL_Z=500 still lost to the
// drawer's z-10 from inside it, and promoting the WHOLE container to
// escape that (the previous fix) then blocked every OTHER piece of Scene
// UI underneath it for as long as ANY figure stayed selected — reported
// live as "selecting a character makes other UI elements inaccessible."
// This constant is now the fixed z of the SEPARATE "elevated" container
// (always mounted, `pointer-events: none` on itself) that ONLY the
// currently selected/hovered figure ever portals into — z-15 clears the
// drawers' z-10 while staying below TopLeftControls'/the draw toolbar's
// much higher values (SceneDrawToolbar.jsx), and its own `pointer-events:
// none` is what lets a click on any OTHER, non-elevated part of the stage
// (including a drawer control directly behind this container) reach
// straight through it instead of being swallowed by empty space.
const CONTROLS_Z = 15;
// Below this many pixels of real pointer movement, a press-and-release is
// read as a tap, not a drag — matches RelationshipNode.jsx's own `moved > 4`
// threshold for the same reason: a click that moved nothing should not
// write a position no different from what was already there.
const DRAG_THRESHOLD_PX = 4;

// The stage itself (Scene tab plan, Phase 5: hard-cut positioning; Phase 6:
// the entrance/exit motion; this pass: manual drag-to-place and resize).
// `summons` already arrives sorted `id DESC` from the server (see
// getStagePayload in server/index.js), which is exactly rank-0-first order
// `layoutStage` wants: the newest summon on each side binds to that side's
// own screen edge, older ones get pushed — this file only filters by side
// and hands the two arrays straight through.
//
// **Two rosters, two placement systems.** A summon with `pos_x`/`pos_y` set
// (server: `scene_summons.pos_x`/`pos_y`, non-NULL once anyone has dragged
// it — see server/db.js's own comment on those columns) is rendered through
// a manual absolute-position branch instead of `layoutStage`'s automatic
// left/right cramming; everything else behaves exactly as it always has.
// Resizing (`scale`) is independent of which roster a figure is in — a
// figure can be resized without ever leaving the automatic layout.
//
// **Two elements per figure, because two things want `transform`** — the
// exact conflict RelationshipNode.jsx already hit and documented. The
// outer plain `div` owns POSITION: for an auto-placed figure that's
// `entry.x` straight off `layoutStage`, recomputed on every render as the
// roster reflows; for a manually-placed one it's a `left`/`top` percentage
// pair, momentarily overridden by direct DOM writes while a drag is live
// (see the pointer handlers below) — either way it stays outside anything
// framer-motion touches. The inner `motion.div` owns the ENTRANCE/EXIT
// slide — if that lived on the SAME element as the position,
// framer-motion's own `animate` would compose `transform` itself and
// overwrite the position's layout on every reflow, snapping every figure
// back to its slide-in origin each time somebody else summoned or
// un-summoned (the exact bug RelationshipNode.jsx's own comment
// describes). Split like this, a reposition (a plain re-render with a new
// `x`, or a live drag's direct DOM write) never touches the motion.div at
// all — `initial` only plays once, on that figure's own mount, keyed by
// `entry.id`, which never changes across a reflow.
//
// **`entry.x` is applied as `left` on the left side and `right` on the
// right** — never `left` for both. A right-side figure used to get an
// absolute `left` computed from `stageWidth - SLOT_WIDTH`, which only
// actually lands flush against the screen's own right edge when the
// figure renders at exactly `SLOT_WIDTH` wide. Once rendering stopped
// clipping figures to that nominal width (below), a right-side figure
// wider than `SLOT_WIDTH` had its TRUE right edge land past the screen's
// own edge — not bleeding behind a drawer as intended, but off the canvas
// entirely, on any device. Anchoring with CSS `right` instead makes the
// browser align flush to the true edge regardless of how wide the image
// actually renders — the figure can only grow further LEFT (into the
// drawer, still intended), never further right (off-screen).
//
// Bottom-anchored, **height-only** sizing — `h-[70dvh]` with width left to
// `auto`, rather than fitting into a fixed SLOT_WIDTH box. This is the
// second attempt at lining up every character's own top edge: the first
// tried a fixed-size BOX (`h-[85vh] w-full object-fit: contain`) on the
// theory that most standing-figure art is taller than the box's own narrow
// aspect ratio and would therefore be height-bound — wrong in practice,
// since plenty of real art is closer to a portrait crop than a full-body
// sprite, which `object-fit: contain` then fits by WIDTH inside that box,
// leaving empty space above and a shorter-looking character. Constraining
// only height sidesteps the whole question: every image is scaled to the
// exact same height, full stop, with whatever width its own aspect ratio
// produces — there is no second dimension left for `object-fit` to
// negotiate, so every character's top is the SAME line by construction,
// not by hoping their aspect ratios cooperate. This is a pure rendering
// rule with no stored-per-picture state, so it applies retroactively to
// every already-uploaded Scene Picture with no migration.
//
// **`dvh`, not `vh` — and 70, not 100.** A plain `vh` unit on mobile Safari
// is pinned to the LARGEST possible viewport (address bar collapsed), not
// the currently-visible one — so `h-screen` (100vh) rendered every figure
// taller than the space actually visible while the address bar was still
// showing, pushing heads up above the top of the real, visible screen.
// `dvh` (already this app's own convention for exactly this problem — see
// GmToolsWidget/Compendium/DialogShell's own `dvh` dialogs) tracks the
// CURRENT visible viewport instead, and backing off from 100 to 70 leaves
// real headroom on top of that for good measure, rather than trusting the
// browser chrome's height to be accounted for down to the pixel.
//
// **The width this produces is not `layoutStage`'s SLOT_WIDTH** — that
// constant is still exactly right for the horizontal SPACING/crowding math
// (see that file's own comment: image aspect ratio was always deliberately
// not its problem), but a character now routinely renders wider than it on
// screen. That is intended, not a bug to square away: the whole point of
// this pass is to stop treating the stage's own width as "the middle
// strip between the drawers" and let artwork use the full canvas edge to
// edge, bleeding behind the GM's drawers on the sides exactly as their own
// `bg-zinc-950/90` translucency already implied it might. `layoutStage`
// still receives the FULL measured stage width — see ScenePage, which no
// longer narrows it or applies any offset.
//
// **`heightScale`/`gapScale`/`sizeScale`/`showNameplates`** are the Scene
// Settings sliders (client/src/lib/sceneSettings.js), read once by
// ScenePage and handed down as plain props — this file stays exactly as
// ignorant of WHERE they came from as it already was of `stageWidth`
// itself. `heightScale` multiplies `BASE_HEIGHT_DVH` directly; `gapScale`/
// `sizeScale` multiply `SLOT_GAP`/`SLOT_WIDTH` before they ever reach
// `layoutStage`, which only ever sees a plain (possibly non-default)
// `slotWidth`/`slotGap` and has no idea a setting exists. The new
// per-summon `scale` (drag-to-resize, below) multiplies on top of all of
// that — a figure's rendered height is always
// `BASE_HEIGHT_DVH * heightScale * summon.scale`.
//
// **Dragging and resizing mirror RelationshipBoard.jsx's own node-drag**
// (`onPointerDown` per figure, `window`-level `pointermove`/`pointerup`/
// `pointercancel`, a plain ref rather than state for the in-progress
// gesture, direct DOM writes with no re-render until the drop) rather than
// Framer Motion's own `drag` prop — this codebase has hit the "two things
// both want `transform`" bug three times already (this file's own comment
// above, RelationshipNode.jsx), and framer's `drag` prop would reintroduce
// exactly that conflict on the very elements that already have a
// transform-owning motion.div. `window`-level listeners (not per-element,
// and no `setPointerCapture`) are what let a drag keep tracking once the
// pointer leaves the figure it started on — see RelationshipBoard.jsx's
// own comment on the same choice. Committed once per gesture, on release:
// `stage:updated` is an unscoped `io.emit` to every connected socket, so
// streaming a write on every pointermove would re-render the whole
// table's screens 60x/second for a drag only the dragging viewer can see
// live anyway — everyone else just sees the figure land in its new spot.

// Named variants, RoundCutscene.jsx's own vocabulary style: a plain object
// of framer-motion keyframes/targets per name, rather than a switch full
// of inline objects. Only two directions for the entrance — the side a
// summon is bound to (decision #3: a Player's own summons always enter
// from the left, a GM's always from the right) is exactly the direction
// its portrait slides in from, so the slide reads as the character
// stepping onto the stage from that edge. One EXIT for both sides —
// un-summoning reads as the picture simply leaving, not as a reversed
// entrance, so it doesn't need its own side split.
const ENTER_LEFT = { x: -140, opacity: 0 };
const ENTER_RIGHT = { x: 140, opacity: 0 };
const IDLE = { x: 0, opacity: 1 };
const EXIT = { opacity: 0, scale: 0.85 };

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// A thin wrapper around createPortal, purely so AnimatePresence (below) has
// something valid to look at. `React.isValidElement()` — which
// AnimatePresence relies on internally to walk its own children — returns
// `false` for a raw createPortal() result (a Portal is its own React
// internal type, not a plain element), so AnimatePresence silently drops
// any portal handed to it directly: confirmed live, the hard way, as
// "every figure vanished the moment AnimatePresence wrapped the portal
// list" — no error, no warning, just nothing rendered. A NORMAL component
// like this one IS a valid element from AnimatePresence's point of view,
// so it can track this wrapper's own mount/key/removal (and therefore run
// its child's exit animation) exactly as it would any other child — what
// THIS component does internally, including portaling its own children
// elsewhere in the DOM, is invisible to and unconstrained by that.
function FigurePortal({ target, children }) {
  return createPortal(children, target);
}

export default function StageRoster({
  summons,
  stageWidth,
  stageHeight,
  imageNaturalWidth,
  imageNaturalHeight,
  heightScale = 1,
  gapScale = 1,
  sizeScale = 1,
  showNameplates = true,
  role,
  characterId,
}) {
  const reduceMotion = useReducedMotion();
  // A manually-placed summon's pos_x/pos_y are fractions of the ACTIVE
  // SCENE's own background image (bugfix, decided, revised — see
  // sceneProjection.js's own header comment), not of this viewer's own
  // stage box the way they originally were. `object-cover` crops that
  // background differently depending on each viewer's own aspect ratio, so
  // "the same fraction of MY OWN box" routinely put a summon at a visually
  // different spot in the artwork on a different screen — usually most
  // visible vertically, since stage-box aspect ratios vary more in height
  // than width across a GM's desktop and a Player's phone/tablet. Every
  // read/write of pos_x/pos_y below goes through stageToImageFraction /
  // imageFractionToStage so it means the same visual spot everywhere;
  // `imageNaturalWidth`/`imageNaturalHeight` (0 until the backdrop's own
  // onLoad fires, ScenePage.jsx) make both functions degrade to a plain
  // stage-box fraction when there's no image loaded yet — the stage box IS
  // the whole coordinate space in that case, same as before this fix.
  const projectionGeometry = { containerWidth: stageWidth, containerHeight: stageHeight, naturalWidth: imageNaturalWidth, naturalHeight: imageNaturalHeight };

  // The resize handle and the un-summon "x" are hidden by default and
  // revealed two ways: real hover (CSS, `group-hover:`, desktop's own
  // affordance for free) and a completed tap that DIDN'T turn into a drag
  // (this state, toggled in the pointerup handler below) — for touch,
  // where there is no hover. **Deliberately not this app's usual
  // `.hover-only-action` convention** (index.css: a hover-only control
  // defaults to always-visible on a coarse pointer, since there's nothing
  // to hover) — here a single press is explicitly meant to be the reveal
  // gesture, not "just always show it," so a bespoke per-figure toggle
  // replaces that default for these two controls only. Single-select: at
  // most one figure's controls are ever showing from a tap, matching
  // "press on them once" rather than every editable figure lighting up at
  // once.
  const [selectedId, setSelectedId] = useState(null);

  // Real-hover companion to selectedId's tap-toggle (above) — tracked in JS,
  // not left purely to CSS `group-hover`, because routing a figure into the
  // elevated container (below) has to be React-driven to land in the same
  // render as everything else; a CSS-only reveal can't move a figure to a
  // different container.
  const [hoveredId, setHoveredId] = useState(null);
  // The one figure, if any, currently routed into the elevated container —
  // see this file's own return statement for why. Priority doesn't matter
  // in practice (at most one of these is ever set on a given device: touch
  // has no hover, and a mouse tap-select is rare enough on desktop not to
  // collide with a real hover), so a plain fallback is enough.
  const elevatedId = selectedId ?? hoveredId;

  // GM may drag/resize anyone; a Player only their own character's summon
  // — the exact rule the server's mayWriteScenePicture enforces, mirrored
  // here so a handle only ever appears where the write would actually
  // succeed. Nobody but the GM may touch a Temp NPC's (character_id is
  // null for one), which falls out of the same comparison for free.
  const canEditSummon = (summon) =>
    role === 'gm' || (role === 'player' && summon.character_id === characterId);

  const auto = [];
  const manual = [];
  for (const s of summons) (s.pos_x != null && s.pos_y != null ? manual : auto).push(s);

  const left = auto.filter((s) => s.side === 'left');
  const right = auto.filter((s) => s.side === 'right');
  const autoPlaced = (() => {
    const result = layoutStage({
      left,
      right,
      stageWidth,
      slotWidth: SLOT_WIDTH * sizeScale,
      slotGap: SLOT_GAP * gapScale,
    });
    return [...result.left, ...result.right];
  })();

  // --- drag-to-place / resize -----------------------------------------
  //
  // `wrapperRef` is the "crowd" container's own top-level box (below) —
  // already `inset-0` inside the stage, so its rect IS the stage's own
  // box; no ref or ResizeObserver is threaded down from ScenePage for
  // this. A plain ref (not state) so drag math always reads the live
  // element with no re-render dependency; `crowdEl`/`elevatedEl` are the
  // SAME two container elements again, but as state — createPortal needs
  // an actual DOM node to target, which isn't available until after the
  // first render mounts these, so a ref alone can't drive the portals'
  // own render decision the way it can drive on-demand math in an event
  // handler. `elRefs` maps a summon id to its position div AND its own
  // `<img>`, both needed (the position div for a move-drag's `left`/`top`,
  // the img for a resize-drag's `height`) without a second ref map.
  // `gestureRef` holds the one in-progress gesture, if any — a plain ref,
  // not state, so a frame of movement never triggers a re-render.
  const wrapperRef = useRef(null);
  const [crowdEl, setCrowdEl] = useState(null);
  const [elevatedEl, setElevatedEl] = useState(null);
  const setCrowdRef = (el) => {
    wrapperRef.current = el;
    setCrowdEl(el);
  };
  const elRefs = useRef(new Map());
  const gestureRef = useRef(null);

  useEffect(() => {
    const onMove = (e) => {
      const g = gestureRef.current;
      if (!g) return;
      const dx = e.clientX - g.startClientX;
      const dy = e.clientY - g.startClientY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) g.moved = true;
      if (g.type === 'move') {
        g.lastLeftPx = g.startLeftPx + dx;
        g.lastTopPx = g.startTopPx + dy;
        g.el.style.left = `${g.lastLeftPx}px`;
        g.el.style.top = `${g.lastTopPx}px`;
      } else {
        // Vertical only — resize tracks height, matching this file's own
        // height-only sizing rule above. Floored well above zero so a wild
        // upward drag can't collapse or invert the image mid-gesture.
        const nextHeightPx = Math.max(20, g.startHeightPx + dy);
        g.img.style.height = `${nextHeightPx}px`;
        g.lastHeightPx = nextHeightPx;
      }
    };
    const onUp = () => {
      const g = gestureRef.current;
      gestureRef.current = null;
      if (!g) return;
      const els = elRefs.current.get(g.summonId);
      if (els) {
        els.wrapper.style.zIndex = '';
        els.img.style.zIndex = '';
      }
      if (!g.moved) {
        // A tap, not a drag — the resize-handle/x gesture never reaches
        // here at all (both call stopPropagation on their own pointerdown),
        // so this is always a tap on the figure itself. Toggles this one
        // figure's controls; tapping a different figure swaps which one is
        // showing rather than stacking (selectedId holds at most one id).
        if (g.type === 'move') setSelectedId((cur) => (cur === g.summonId ? null : g.summonId));
        return;
      }
      if (g.type === 'move') {
        const rect = wrapperRef.current?.getBoundingClientRect();
        if (!rect) return;
        const { fx, fy } = stageToImageFraction({
          x: g.lastLeftPx ?? g.startLeftPx,
          y: g.lastTopPx ?? g.startTopPx,
          containerWidth: rect.width,
          containerHeight: rect.height,
          naturalWidth: imageNaturalWidth,
          naturalHeight: imageNaturalHeight,
        });
        socket.emit('stage:reposition_summon', {
          summonId: g.summonId,
          posX: clamp(fx, 0, 1),
          posY: clamp(fy, 0, 1),
        });
      } else {
        const nextScale = clamp(g.startScale * ((g.lastHeightPx ?? g.startHeightPx) / g.startHeightPx), 0.25, 4);
        socket.emit('stage:resize_summon', { summonId: g.summonId, scale: nextScale });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // imageNaturalWidth/imageNaturalHeight only change once, when the
    // backdrop's own onLoad fires (ScenePage.jsx) — re-subscribing then is
    // harmless (gestureRef itself is a ref, untouched by this effect's own
    // teardown, so an in-progress gesture survives it regardless), and
    // omitting them here would let onUp close over a stale 0/0 forever.
  }, [imageNaturalWidth, imageNaturalHeight]);

  const startMove = (e, entry) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (!canEditSummon(entry)) return;
    const els = elRefs.current.get(entry.id);
    const wrapperRect = wrapperRef.current?.getBoundingClientRect();
    if (!els || !wrapperRect) return;
    const rect = els.wrapper.getBoundingClientRect();
    // The anchor CSS reads left/top as the figure's own bottom-center —
    // recover that same point from the live box regardless of which
    // placement branch produced it, so a first-ever drag on a still
    // auto-placed figure starts from wherever it actually is on screen.
    const startLeftPx = rect.left + rect.width / 2 - wrapperRect.left;
    const startTopPx = rect.bottom - wrapperRect.top;
    els.wrapper.style.left = `${startLeftPx}px`;
    els.wrapper.style.top = `${startTopPx}px`;
    els.wrapper.style.right = '';
    // 'auto', not '': an auto-placed figure's className still carries
    // Tailwind's `bottom-0`, a stylesheet rule an empty inline value
    // cannot override — only an explicit inline `auto` beats it. Left
    // unattended, `top` (new) and `bottom: 0` (still in effect) both being
    // non-auto on a height:auto box makes the box STRETCH to fill the gap
    // between them instead of moving, per how CSS resolves that
    // combination — not a hard cut-and-dried edge case, since art
    // routinely renders far shorter than the whole stage tall.
    els.wrapper.style.bottom = 'auto';
    els.wrapper.style.transform = 'translate(-50%, -100%)';
    els.wrapper.style.zIndex = String(ACTIVE_GESTURE_Z);
    gestureRef.current = {
      type: 'move',
      summonId: entry.id,
      el: els.wrapper,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startLeftPx,
      startTopPx,
      lastLeftPx: startLeftPx,
      lastTopPx: startTopPx,
      moved: false,
    };
  };

  const startResize = (e, entry) => {
    e.stopPropagation();
    if (e.button !== undefined && e.button !== 0) return;
    if (!canEditSummon(entry)) return;
    const els = elRefs.current.get(entry.id);
    if (!els) return;
    const startHeightPx = els.img.getBoundingClientRect().height;
    els.wrapper.style.zIndex = String(ACTIVE_GESTURE_Z);
    gestureRef.current = {
      type: 'resize',
      summonId: entry.id,
      img: els.img,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startHeightPx,
      startScale: entry.scale ?? 1,
      moved: false,
    };
  };

  // No dedicated "remove from stage" write exists (Scene tab plan, decision
  // #4/#6) — un-summoning has only ever been stage:summon's own toggle,
  // re-selecting the SAME picture that's already showing. This button
  // reuses that exact toggle rather than adding a second way to clear a
  // seat.
  const unsummon = (e, entry) => {
    e.stopPropagation();
    if (!canEditSummon(entry)) return;
    socket.emit('stage:summon', { scenePictureId: entry.scene_picture_id });
    setSelectedId((cur) => (cur === entry.id ? null : cur));
  };

  // Hidden (decided, new) — GM-only regardless of ownership, unlike every
  // other corner control above: this is a narrative tool the GM wields over
  // the whole table, not a "may I edit my own character" permission, so it
  // deliberately does NOT go through canEditSummon/editable. A Player never
  // sees this button at all (canHide is false for them) — moot anyway,
  // since a Hidden summon never reaches a Player's own `summons` prop in
  // the first place (server-side redaction, stagePayloadFor).
  const canHide = role === 'gm';
  const toggleHidden = (e, entry) => {
    e.stopPropagation();
    if (!canHide) return;
    socket.emit('stage:toggle_hidden', { summonId: entry.id });
  };

  const setRefs = (id) => ({
    wrapper: (el) => {
      const cur = elRefs.current.get(id) ?? {};
      elRefs.current.set(id, { ...cur, wrapper: el });
    },
    img: (el) => {
      const cur = elRefs.current.get(id) ?? {};
      elRefs.current.set(id, { ...cur, img: el });
    },
  });

  const renderFigure = (entry, { manual: isManual }) => {
    const editable = canEditSummon(entry);
    const refs = setRefs(entry.id);
    const selected = selectedId === entry.id;
    // Hidden by default; shown on real hover (`group-hover`, desktop, free)
    // or when tap-selected (`selected`, mobile — see the `selectedId`
    // comment above). `pointer-events-none` while hidden, not just
    // `opacity-0`, so an invisible corner button can never steal the
    // pointerdown that should start a drag there instead.
    const cornerButtonClass = `absolute flex h-8 w-8 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/80 text-zinc-300 transition-opacity hover:border-brand-500 hover:text-brand-300 ${
      selected ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
    }`;
    const positionStyle = isManual
      ? (() => {
          // Pixels, not a plain CSS percentage — imageFractionToStage
          // already resolves pos_x/pos_y through this viewer's own
          // object-cover crop (see the constructor comment above), so the
          // conversion has to happen in JS before it ever reaches `style`.
          const { x, y } = imageFractionToStage({
            fx: entry.pos_x ?? 0,
            fy: entry.pos_y ?? 0,
            ...projectionGeometry,
          });
          return { left: `${x}px`, top: `${y}px`, transform: 'translate(-50%, -100%)', zIndex: MANUAL_Z };
        })()
      : { [entry.side === 'left' ? 'left' : 'right']: entry.x, zIndex: entry.z };
    return (
      <div
        key={entry.id}
        ref={refs.wrapper}
        // No `width` here — how far a figure's own art reaches from its
        // anchored edge is up to the image's own aspect ratio at a fixed
        // height, not a column this div would otherwise clip it to.
        className={isManual ? 'absolute' : 'absolute bottom-0'}
        // touch-action:none — otherwise mobile reads the same gesture as a
        // page scroll/pinch-zoom instead of a drag (RelationshipNode.jsx
        // uses the same rule for the same reason). Has to live in `style`,
        // not as a bare JSX prop — there is no such DOM attribute.
        // pointerEvents:'auto' unconditionally — a no-op in the crowd
        // container (already the default there) but load-bearing when this
        // figure is portaled into the elevated container instead, which
        // sets pointer-events:none on ITSELF (see this file's own return
        // statement) so its own empty space never blocks a drawer behind
        // it; the one figure actually inside still needs to opt back in.
        style={{ ...positionStyle, touchAction: editable ? 'none' : undefined, pointerEvents: 'auto' }}
        onPointerDown={editable ? (e) => startMove(e, entry) : undefined}
      >
        <motion.div
          initial={entry.side === 'left' ? ENTER_LEFT : ENTER_RIGHT}
          animate={IDLE}
          exit={EXIT}
          transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 28 }}
          // `relative`: the nameplate and the corner buttons below are all
          // positioned against THIS box, which (having no width of its
          // own) always ends up exactly as wide as the `img` it wraps.
          // `group`: what the corner buttons' own `group-hover:` reveal
          // hangs off (see cornerButtonClass above).
          className="group relative"
          style={{ cursor: editable ? 'grab' : undefined, touchAction: editable ? 'none' : undefined }}
          onMouseEnter={editable ? () => setHoveredId(entry.id) : undefined}
          onMouseLeave={editable ? () => setHoveredId((cur) => (cur === entry.id ? null : cur)) : undefined}
        >
          {showNameplates && entry.name && (
            <HaloText
              as="div"
              className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap text-xs font-semibold text-zinc-100"
            >
              {entry.name}
            </HaloText>
          )}
          <img
            ref={refs.img}
            src={`data:${entry.image_mime_type || 'image/png'};base64,${entry.image_data}`}
            alt={entry.name ?? ''}
            draggable={false}
            // `max-w-none` overrides Tailwind's own preflight reset
            // (`img { max-width: 100% }`, meant for ordinary inline
            // images) — without it, a wide/short character's own render
            // silently clamps back down to whatever "100%" of its
            // auto-sized ancestor chain resolves to, defeating the whole
            // height-only sizing rule above for exactly the aspect ratios
            // it exists to fix.
            className="block w-auto max-w-none"
            style={{
              height: `${BASE_HEIGHT_DVH * heightScale * (entry.scale ?? 1)}dvh`,
              // Half-transparent for the GM only — a Player never receives
              // a Hidden summon's row at all (stagePayloadFor), so there is
              // nothing for this branch to do on their side; `entry.is_hidden`
              // is only ever true in a payload the GM themselves received.
              opacity: entry.is_hidden ? 0.5 : 1,
            }}
          />
          {editable && (
            <button
              type="button"
              onPointerDown={(e) => startResize(e, entry)}
              title="Resize"
              aria-label="Resize"
              className={`${cornerButtonClass} left-0 top-0`}
              style={{ cursor: 'ns-resize', touchAction: 'none' }}
            >
              <Maximize2 size={14} aria-hidden />
            </button>
          )}
          {editable && (
            <button
              type="button"
              onPointerDown={(e) => unsummon(e, entry)}
              title="Remove from stage"
              aria-label="Remove from stage"
              className={`${cornerButtonClass} right-0 top-0`}
              style={{ touchAction: 'none' }}
            >
              <X size={14} aria-hidden />
            </button>
          )}
          {canHide && (
            <button
              type="button"
              onPointerDown={(e) => toggleHidden(e, entry)}
              title={entry.is_hidden ? 'Reveal to Players' : 'Hide from Players'}
              aria-label={entry.is_hidden ? 'Reveal to Players' : 'Hide from Players'}
              // Stacked directly under the ✕ (top-10 = the ✕'s own h-8 plus
              // a small gap), same corner — "under the x button", verbatim.
              className={`${cornerButtonClass} right-0 top-10 ${entry.is_hidden ? 'border-brand-500 text-brand-300' : ''}`}
              style={{ touchAction: 'none' }}
            >
              <EyeOff size={14} aria-hidden />
            </button>
          )}
        </motion.div>
      </div>
    );
  };

  const everyEntry = [
    ...autoPlaced.map((entry) => ({ entry, isManual: false })),
    ...manual.map((entry) => ({ entry, isManual: true })),
  ];

  return (
    // **Two containers, not one (decided, revised — bugfix: selecting a
    // character used to make the rest of the Scene UI unreachable).**
    // The "crowd" container is a stacking context of its own (position + a
    // low, fixed z-index): a crowded roster's own z values (1..N per side,
    // from layoutStage's rank, or MANUAL_Z for a dragged figure) only ever
    // compete with EACH OTHER inside this box, never leak out to outrank
    // the drawers' own z-10 — without it, a side with more than ~10
    // summons (or a manually-placed one) would start painting over the
    // GM's own controls. This container's z-index is now FIXED — it used
    // to bump to CONTROLS_Z whenever any figure was selected/hovered, but
    // that promoted the WHOLE roster (not just the one figure whose
    // buttons actually needed to clear the drawer), which meant every
    // OTHER piece of Scene UI sharing that screen region became unreachable
    // for as long as the selection lasted — reported live. It ALSO owns the
    // one background click-catcher below: tapping any part of its own
    // empty space (not a figure, not a button) clears `selectedId` —
    // "clicking on a place where there are no characters deselects."
    //
    // The SECOND, "elevated" container is always mounted too, at a fixed
    // CONTROLS_Z — but `pointer-events: none` on the container itself, so
    // its own empty space never blocks anything behind it (a drawer
    // control, or the crowd container's own click-catcher underneath).
    // ONLY the currently selected/hovered figure (`elevatedId`) ever
    // portals into it — `createPortal(..., entry.id)`'s own key argument
    // is what lets React recognize this as the SAME figure moving to a new
    // DOM parent across renders (not an unmount+remount): its drag/resize
    // refs (`elRefs`, `gestureRef`) stay valid throughout, and framer's own
    // `motion.div` exit animation still tracks correctly, since a portal
    // changes where in the DOM a node lives, never where in the React tree
    // it lives.
    <>
      <div
        ref={setCrowdRef}
        className="absolute inset-0 z-[1]"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedId(null);
        }}
      />
      <div className="absolute inset-0" style={{ zIndex: CONTROLS_Z, pointerEvents: 'none' }} ref={setElevatedEl} />
      {crowdEl && elevatedEl && (
        <AnimatePresence>
          {everyEntry.map(({ entry, isManual }) => (
            <FigurePortal key={entry.id} target={entry.id === elevatedId ? elevatedEl : crowdEl}>
              {renderFigure(entry, { manual: isManual })}
            </FigurePortal>
          ))}
        </AnimatePresence>
      )}
    </>
  );
}

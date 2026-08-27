import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  dotSpacing,
  loadView,
  panBy,
  saveView,
  toWorld,
  zoomAt,
} from '../lib/boardViewport.js';

// The void: a pan/zoom camera over an unbounded plane, and the space nodes and
// relationships will live in from Phase 2 onward.
//
// **The camera is a ref, not state, while a gesture is running.** Writing pan
// into React state on every pointermove re-renders the whole board sixty times a
// second, and the feel of this thing is a stated requirement rather than a nice
// to have — the difference between liquid and rigid is exactly here. So a drag
// writes `transform` straight onto the world layer from a rAF, and commits to
// state once when the pointer lifts. `viewRef` is the truth during a gesture;
// `view` is the truth between them, and the two are only ever equal at rest.
//
// Children are rendered inside the transformed layer, so anything drawn there
// is positioned in world coordinates and needs to know nothing about the camera.

// **Depth, rebuilt (decided, second attempt).**
//
// The first version was two tiled dot fields at different sizes panned at
// different rates. It read as depth at 100% and fell apart everywhere else:
// scaling a fixed tile with the camera means zooming out packs the dots
// tighter and tighter until the field is a grey mess, and two grids at
// different scales beat against each other into moiré on the way there.
//
// So the two jobs are split, and neither is a scaled tile:
//
//   1. **The dots keep a constant on-screen density.** Their world spacing
//      doubles every time zooming out would push them closer than MIN_PX
//      apart, and halves when zooming in would spread them past MAX_PX — the
//      grid steps to a coarser or finer one instead of crowding. They pan 1:1
//      with the camera, so the field still belongs to the world rather than to
//      the screen; the stepping is invisible in motion and is what every
//      infinite canvas does.
//   2. **Depth is three large soft clouds**, drifting at a fraction of the
//      camera's rate. A slow-moving gradient is a far better distance cue than
//      a second grid, and it cannot moiré against anything because it has no
//      repeat.

const DOT_LAYER =
  'radial-gradient(circle at center, rgba(203,213,225,0.16) 1.15px, transparent 1.75px)';

// Fixed in the viewport, drifting slowly. Positions are percentages so they
// scale with the pane rather than needing a measurement.
const CLOUD_RATE = 0.22;
const CLOUDS =
  'radial-gradient(38rem 30rem at 22% 28%, rgba(99,102,141,0.10), transparent 70%),' +
  'radial-gradient(30rem 26rem at 78% 66%, rgba(120,85,95,0.09), transparent 70%),' +
  'radial-gradient(44rem 34rem at 55% 92%, rgba(70,90,110,0.08), transparent 72%)';

function RelationshipVoid(
  { characterId, interactive = true, className = '', children, onViewChange, onBackgroundPointerDown, corner, ...rest },
  ref
) {
  const viewportRef = useRef(null);
  const worldRef = useRef(null);
  const cloudsRef = useRef(null);
  const [view, setView] = useState(() => loadView(characterId));
  const viewRef = useRef(view);
  // Which pointers are currently down on the void, so a second finger can turn a
  // pan into a pinch without either gesture having to know about the other.
  const pointersRef = useRef(new Map());
  const panRef = useRef(null);
  const pinchRef = useRef(null);
  const frameRef = useRef(0);

  // What the board above needs in order to drag a node: the live camera, and
  // one exact screen->world conversion. Exposed imperatively rather than as
  // state because the camera deliberately does not re-render during a gesture —
  // a dragging node asks for the current value sixty times a second and must
  // get the real one, not last render's.
  useImperativeHandle(
    ref,
    () => ({
      getView: () => viewRef.current,
      getViewportEl: () => viewportRef.current,
      // Used by the board to frame the cast on first open. Goes through the
      // same commit path a gesture does, so localStorage and React agree.
      setView: (next) => {
        viewRef.current = next;
        setView(next);
        saveView(characterId, next);
        onViewChange?.(next);
      },
      // clientX/clientY straight off a pointer or drop event.
      toWorld: (clientX, clientY) => {
        const el = viewportRef.current;
        if (!el) return { x: 0, y: 0 };
        const rect = el.getBoundingClientRect();
        return toWorld(viewRef.current, clientX - rect.left, clientY - rect.top);
      },
    }),
    [characterId, onViewChange]
  );

  // One place that puts the camera on screen. Everything that moves the camera —
  // drag, wheel, pinch, a committed state change — goes through here, so the DOM
  // can never disagree with `viewRef`.
  const paint = useCallback(() => {
    frameRef.current = 0;
    const world = worldRef.current;
    const viewport = viewportRef.current;
    if (!world || !viewport) return;
    const v = viewRef.current;
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    // The dot field lives on the viewport rather than on the world layer so its
    // spacing can be quantised independently of the camera's scale — a
    // background inside the transform is scaled by it, which is exactly the
    // crowding this replaced.
    const spacing = dotSpacing(v.zoom);
    viewport.style.backgroundSize = `${spacing}px ${spacing}px`;
    // Modulo the spacing so the offset never grows unbounded — a background
    // position of a few hundred thousand pixels is where subpixel jitter starts.
    viewport.style.backgroundPosition = `${v.x % spacing}px ${v.y % spacing}px`;
    const clouds = cloudsRef.current;
    if (clouds) {
      clouds.style.transform = `translate3d(${v.x * CLOUD_RATE}px, ${v.y * CLOUD_RATE}px, 0)`;
    }
  }, []);

  const schedulePaint = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  // Move the camera without telling React. Used for every frame of a gesture.
  const applyView = useCallback(
    (next) => {
      viewRef.current = next;
      schedulePaint();
    },
    [schedulePaint]
  );

  // End of a gesture: React and localStorage catch up with where the camera
  // already is. One write, not sixty.
  const commitView = useCallback(() => {
    const v = viewRef.current;
    setView(v);
    saveView(characterId, v);
    onViewChange?.(v);
  }, [characterId, onViewChange]);

  // Paint on mount and whenever the camera is moved from outside a gesture.
  useLayoutEffect(() => {
    viewRef.current = view;
    paint();
  }, [view, paint]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const localPoint = (e) => {
    const rect = viewportRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const twoPointers = () => [...pointersRef.current.values()];

  const onPointerDown = (e) => {
    // Only the void itself pans. A pointerdown that started on a child (a node,
    // from Phase 2) is that child's gesture, and this must not steal it.
    if (e.target !== viewportRef.current && e.target !== worldRef.current) return;
    onBackgroundPointerDown?.(e);
    pointersRef.current.set(e.pointerId, localPoint(e));
    viewportRef.current.setPointerCapture(e.pointerId);

    if (pointersRef.current.size === 2) {
      const [a, b] = twoPointers();
      panRef.current = null;
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        zoom: viewRef.current.zoom,
        view: viewRef.current,
      };
      return;
    }
    const p = localPoint(e);
    panRef.current = { startX: p.x, startY: p.y, view: viewRef.current };
  };

  const onPointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, localPoint(e));

    if (pinchRef.current && pointersRef.current.size >= 2) {
      const [a, b] = twoPointers();
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (!distance || !pinchRef.current.distance) return;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const target = clampZoom(pinchRef.current.zoom * (distance / pinchRef.current.distance));
      applyView(zoomAt(pinchRef.current.view, target / pinchRef.current.view.zoom, midX, midY));
      return;
    }
    if (!panRef.current) return;
    const p = localPoint(e);
    applyView(panBy(panRef.current.view, p.x - panRef.current.startX, p.y - panRef.current.startY));
  };

  const endPointer = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.delete(e.pointerId);
    try {
      viewportRef.current.releasePointerCapture(e.pointerId);
    } catch {
      /* already released — the browser drops capture on its own in some paths */
    }
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      panRef.current = null;
      commitView();
    }
  };

  // **Wheel zooms.** Plain scroll, no modifier — that is what a canvas does and
  // what the hand expects here (an earlier version panned on a bare wheel and
  // reserved zoom for Ctrl, which read as backwards).
  //
  // Zoom is about the cursor, so whatever is under the pointer stays under it.
  // A trackpad's two-finger *sideways* swipe still pans, because that gesture
  // has no zoom meaning and reporting it as one would make horizontal scrolling
  // jump the camera: a wheel event carrying real deltaX and almost no deltaY is
  // a pan, everything else is a zoom. Shift-wheel pans vertically, the usual
  // escape hatch for a mouse with only one wheel.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !interactive) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const sidewaysSwipe = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (e.shiftKey || sidewaysSwipe) {
        applyView(panBy(viewRef.current, -e.deltaX, -e.deltaY));
      } else {
        // A wheel notch is ~100 deltaY, so /500 makes one notch a ~22% step —
        // a step, not a leap. The first version used /220 and a single notch
        // went straight to the zoom ceiling.
        applyView(zoomAt(viewRef.current, Math.exp(-e.deltaY / 500), x, y));
      }
      commitView();
    };
    // Non-passive: preventDefault on a passive wheel listener is ignored, and
    // without it the page scrolls behind the board on every zoom.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [interactive, applyView, commitView]);

  const nudgeZoom = (factor) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    applyView(zoomAt(viewRef.current, factor, rect.width / 2, rect.height / 2));
    commitView();
  };

  const reset = () => {
    applyView(DEFAULT_VIEW);
    commitView();
  };

  const handlers = interactive
    ? { onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer }
    : {};

  return (
    <div
      ref={viewportRef}
      data-relationship-void=""
      {...handlers}
      // touch-action:none is mandatory, not defensive — without it the browser
      // claims the gesture and scrolls or zooms the page instead of the board.
      style={{
        touchAction: 'none',
        // Greyish-black, not black. A true black void swallows the dots and
        // reads as "nothing rendered"; this is dark enough to sit under the
        // app's palette and light enough that the depth field is visible.
        backgroundColor: '#15171b',
        backgroundImage: DOT_LAYER,
      }}
      className={`relative overflow-hidden select-none ${interactive ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
      {...rest}
    >
      {/* The clouds: the parallax layer proper, drifting behind the dots at a
          fraction of the camera's rate. Oversized and offset so the drift never
          pulls an edge into view. */}
      <div
        aria-hidden
        ref={cloudsRef}
        className="pointer-events-none absolute"
        style={{ inset: '-30%', willChange: 'transform' }}
      >
        {/* The autonomous drift lives on a CHILD, because the parent's
            transform is written every frame by the camera and a CSS animation
            on the same property would be overwritten sixty times a second. */}
        <div
          className="rel-void-drift absolute inset-0"
          style={{ backgroundImage: CLOUDS }}
        />
      </div>
      {/* A cold vignette over everything. The void reads as depth rather than
          as a dotted sheet only once the edges fall away. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,0.62) 100%)',
        }}
      />
      <div
        ref={worldRef}
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {children}
      </div>

      {interactive && (
        <div className="pointer-events-auto absolute bottom-2 right-2 flex items-center gap-1">
          {corner}
          <ZoomButton onClick={() => nudgeZoom(1 / 1.25)} disabled={view.zoom <= MIN_ZOOM} label="Zoom out">
            −
          </ZoomButton>
          <button
            onClick={reset}
            title="Reset the view"
            className="panel-cut-sm border border-zinc-700 bg-zinc-900/80 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-zinc-400 hover:text-zinc-100"
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <ZoomButton onClick={() => nudgeZoom(1.25)} disabled={view.zoom >= MAX_ZOOM} label="Zoom in">
            +
          </ZoomButton>
        </div>
      )}
    </div>
  );
}

function ZoomButton({ onClick, disabled, label, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="panel-cut-sm h-7 w-7 border border-zinc-700 bg-zinc-900/80 text-sm font-bold text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

export default forwardRef(RelationshipVoid);
export { toWorld };

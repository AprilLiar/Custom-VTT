import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
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

// Two dot fields at different sizes and opacities, panned at different rates.
// That parallax IS the depth illusion — one field alone reads as a flat grid,
// and the near field moving faster than the far one is the only cue that says
// "these are at different distances" without drawing anything else.
const NEAR = { size: 62, rate: 0.6, alpha: 0.11, r: 1.2 };
const FAR = { size: 143, rate: 0.28, alpha: 0.06, r: 1.9 };

const dotLayer = ({ size, alpha, r }) =>
  `radial-gradient(circle at center, rgba(226,232,240,${alpha}) ${r}px, transparent ${r + 0.6}px)`;

export default function RelationshipVoid({
  characterId,
  interactive = true,
  className = '',
  children,
  onViewChange,
}) {
  const viewportRef = useRef(null);
  const worldRef = useRef(null);
  const [view, setView] = useState(() => loadView(characterId));
  const viewRef = useRef(view);
  // Which pointers are currently down on the void, so a second finger can turn a
  // pan into a pinch without either gesture having to know about the other.
  const pointersRef = useRef(new Map());
  const panRef = useRef(null);
  const pinchRef = useRef(null);
  const frameRef = useRef(0);

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
    // The dot fields live on the viewport rather than the world layer precisely
    // so they can move at their own rate — a background inside the transform
    // would be dragged at exactly the camera's speed and the parallax would die.
    viewport.style.backgroundSize = `${NEAR.size * v.zoom}px ${NEAR.size * v.zoom}px, ${FAR.size * v.zoom}px ${FAR.size * v.zoom}px`;
    viewport.style.backgroundPosition = `${v.x * NEAR.rate}px ${v.y * NEAR.rate}px, ${v.x * FAR.rate}px ${v.y * FAR.rate}px`;
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

  // Wheel is zoom-about-the-cursor, and trackpad two-finger scroll is a pan.
  // The browser reports both as `wheel`; `ctrlKey` is what a pinch on a trackpad
  // sets, and is the standard way to tell them apart.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !interactive) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Shift is here alongside Ctrl/Cmd because a mouse wheel has no pinch and
      // Ctrl-wheel is browser page-zoom muscle memory for some people.
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        // A wheel notch is ~100 deltaY, so /500 makes one notch a ~22% step —
        // a step, not a leap. The first version used /220 and a single notch
        // went straight to the zoom ceiling.
        applyView(zoomAt(viewRef.current, Math.exp(-e.deltaY / 500), x, y));
      } else {
        applyView(panBy(viewRef.current, -e.deltaX, -e.deltaY));
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
      {...handlers}
      // touch-action:none is mandatory, not defensive — without it the browser
      // claims the gesture and scrolls or zooms the page instead of the board.
      style={{
        touchAction: 'none',
        // Greyish-black, not black. A true black void swallows the dots and
        // reads as "nothing rendered"; this is dark enough to sit under the
        // app's palette and light enough that the depth field is visible.
        backgroundColor: '#15171b',
        backgroundImage: `${dotLayer(NEAR)}, ${dotLayer(FAR)}`,
      }}
      className={`relative overflow-hidden select-none ${interactive ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
    >
      {/* A cold vignette over the dots. The void reads as depth rather than as a
          dotted sheet only once the edges fall away. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(148,163,184,0.05) 0%, transparent 45%), radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)',
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

export { toWorld };

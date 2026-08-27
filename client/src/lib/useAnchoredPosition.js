import { useLayoutEffect, useState } from 'react';

// Where to put a portalled floating panel so it sits beside its anchor and
// fully on screen.
//
// **Extracted from CombatArena's `useHoverCardPosition`, unchanged in
// behaviour.** It was module-local there and is needed by the Relationships
// board's line editor too; a second copy is how two panels end up disagreeing
// about what "near the edge" means.
//
// The reason a hook exists at all rather than CSS: a panel anchored inside a
// `transform`ed subtree cannot use `position: fixed` — a transformed ancestor
// becomes the containing block, and no z-index can escape the stacking context
// it establishes. So the panel must leave the subtree entirely, which means a
// portal, which means viewport coordinates, which means measuring.
//
// Clamping is what makes it work on a phone: a fixed-width panel centred on an
// anchor near the screen edge would otherwise hang off it.
//
// `anchor` is either a **ref** to an element (measured with
// `getBoundingClientRect`) or a **static rect** in viewport coordinates —
// `{ left, top, width, height }`, with width and height optional. The second
// form is for anchors that are not elements at all: a point on an SVG curve, a
// pointer position.

const DEFAULT_WIDTH = 288; // w-72; keep any max-w on the panel in step
const DEFAULT_GAP = 8;

function rectOf(anchor) {
  if (!anchor) return null;
  // A ref: measure the element it holds.
  if (Object.prototype.hasOwnProperty.call(anchor, 'current')) {
    return anchor.current?.getBoundingClientRect() ?? null;
  }
  const { left, top, width = 0, height = 0 } = anchor;
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

export function useAnchoredPosition(anchor, open, { width: preferredWidth = DEFAULT_WIDTH, gap = DEFAULT_GAP } = {}) {
  const [pos, setPos] = useState(null);
  // A static rect is a fresh object every render, which would restart the
  // effect forever. Anchors are compared by value instead of by identity.
  const key = anchor && !Object.prototype.hasOwnProperty.call(anchor, 'current')
    ? `${anchor.left},${anchor.top},${anchor.width ?? 0},${anchor.height ?? 0}`
    : 'ref';

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    let frame = 0;
    const measure = () => {
      const r = rectOf(anchor);
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(preferredWidth, vw - gap * 2);
      // Centred on the anchor, then pulled back inside the viewport.
      const left = Math.min(Math.max(gap, r.left + r.width / 2 - width / 2), vw - width - gap);
      // Above by preference — an anchor usually sits low in whatever holds it
      // and the space above is usually empty. Flip below when it will not fit,
      // which on a short mobile viewport is most of the time.
      const below = r.top < vh / 2;
      setPos({
        left,
        width,
        below,
        top: below ? r.bottom + gap : undefined,
        bottom: below ? undefined : vh - r.top + gap,
      });
    };
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture phase: inner scroll containers (a lane strip, the page shell, the
    // board) do not bubble scroll to window — the same reason MoveLinkOverlay
    // listens this way.
    window.addEventListener('scroll', remeasure, true);
    window.addEventListener('resize', remeasure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', remeasure, true);
      window.removeEventListener('resize', remeasure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, preferredWidth, gap]);

  return pos;
}

export default useAnchoredPosition;

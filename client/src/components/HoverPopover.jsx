import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// A popover that is genuinely on top, always.
//
// The Arena's declared-move card and overflow preview used to be absolutely
// positioned with `z-50` inside the lane they belong to. That only ever
// worked by luck: `z-index` is resolved within the nearest ancestor stacking
// context, and this app now creates them everywhere — `mask-image` (every
// .ink-panel), `clip-path` (every .panel-cut), `transform`, `opacity`,
// Framer Motion's animated wrappers. A `z-50` inside one of those loses to
// any *later* sibling that has its own, no matter how high the number goes.
// Ancestor masks and clip-paths also clip descendants, so a popover that
// overflows its lane upward could be cut off outright.
//
// Portalling to <body> with fixed positioning sidesteps the whole class of
// problem: there is no ancestor left to be clipped by or ordered against.
// The trade is that position has to be measured rather than inherited, which
// is what the rect tracking below is for.
export default function HoverPopover({
  anchorRef,
  open,
  children,
  interactive = false,
  className = '',
  gap = 8,
}) {
  const [rect, setRect] = useState(null);

  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return undefined;
    }
    const measure = () => {
      const el = anchorRef.current;
      if (el) setRect(el.getBoundingClientRect());
    };
    measure();
    // `true` for capture: the anchor may sit inside a scrolling panel (the
    // lanes, the chat log), and those scroll events do not bubble.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setRect(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open || !rect) return null;

  // Clamped to the viewport so a popover on the first or last lane does not
  // hang off the edge where nobody can read it.
  const left = Math.min(Math.max(rect.left + rect.width / 2, 8), window.innerWidth - 8);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left,
        top: rect.top - gap,
        transform: 'translate(-50%, -100%)',
        zIndex: 60,
      }}
      className={`${interactive ? '' : 'pointer-events-none'} ${className}`}
    >
      {children}
    </div>,
    document.body
  );
}

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useAnchoredPosition from '../lib/useAnchoredPosition.js';

// **A description that only ever showed on hover is unreachable on a phone —
// there is no hover state to trigger it.** Reported as "I cannot tap to read
// a Move tag": a Tag chip's only way to say what it does was its `title`
// attribute, and a touch device has nothing that opens one. This wraps a
// chip so a tap opens the same text in a small portalled popover, closed by
// tapping it again, tapping elsewhere, or Escape — the same open/close shape
// `MoveFilterPopover` already uses for a floating panel anchored to a button.
//
// The plain `title` stays too, unconditionally: it costs nothing extra and
// is still a real hover tooltip for a mouse.
//
// A chip with nothing to say (`text` falsy) renders as an inert `<span>`,
// exactly as it did before this existed — there is nothing to tap open, and
// a button that opens onto emptiness reads as broken rather than as a chip
// with no description.
export default function TapDescribe({ text, className = '', children }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const pos = useAnchoredPosition(anchorRef, open, { width: 240 });

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  if (!text) return <span className={className}>{children}</span>;

  return (
    <button
      type="button"
      ref={anchorRef}
      title={text}
      onClick={(e) => {
        // This chip usually sits on a card that is itself inside a bigger
        // clickable surface (a draggable move card, a grant-checklist row) —
        // reading the tag must never also fire whatever that surface does.
        e.stopPropagation();
        setOpen((was) => !was);
      }}
      className={`${className} cursor-help`}
    >
      {children}
      {open &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            className="fixed z-[90] panel-cut-sm border border-zinc-700 bg-zinc-950 p-2 text-xs leading-snug text-zinc-200 shadow-2xl shadow-black/80"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
          >
            {text}
          </div>,
          document.body
        )}
    </button>
  );
}

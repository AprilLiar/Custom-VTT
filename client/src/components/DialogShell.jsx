import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

// Mobile readiness (Change 002), §10 + 14.7: the shared dialog chrome every
// modal in the app should route through, instead of each one hand-rolling
// its own `fixed inset-0`/`max-h-[90vh]` shell with inconsistent focus/
// scroll-lock/safe-area behavior. Two responsive presentations, picked per
// dialog via `variant` (14.7's decision): `sheet` is a simple GM/player
// prompt — desktop keeps the existing centered panel, mobile slides up from
// the bottom edge with only its top corners cut and safe-bottom padding.
// `fullscreen` is for a complex editor (Damage Application) — desktop stays
// centered, mobile fills the whole viewport so there's room for the
// anatomy figure plus controls. `theater` goes further and fills almost the
// whole viewport on *every* size: for the round cutscene, which is something
// you sit and watch rather than a form you fill in, and which was unusable
// squeezed into a centered `max-w-md` panel. Framer Motion's animated
// entrance/exit is unchanged from what every dialog already used (spring
// scale+fade), just centralized here.
export default function DialogShell({
  title,
  onClose,
  dismissible = true,
  variant = 'sheet', // 'sheet' | 'fullscreen' | 'theater'
  maxWidth = 'max-w-md',
  children,
  footer,
  panelClassName = '',
}) {
  const panelRef = useRef(null);
  const titleId = useRef(`dialog-title-${Math.random().toString(36).slice(2)}`).current;

  // Scroll lock + focus trap + Escape-to-close — every dialog in the app
  // wants all three, so they live here once rather than per-component.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && dismissible) {
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = panelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [dismissible, onClose]);

  const sheetPanelClass =
    variant === 'theater'
      ? 'h-full w-full md:h-[96dvh] md:w-[99vw] md:rounded-none md:ink-panel'
      : variant === 'fullscreen'
        ? 'h-full w-full md:h-auto md:max-h-[90dvh] md:w-full md:rounded-none md:ink-panel'
        : 'w-full rounded-t-2xl md:rounded-none md:ink-panel md:max-h-[90dvh]';

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center ${
        variant === 'theater' ? 'md:p-2' : 'md:p-4'
      }`}
      onClick={dismissible ? onClose : undefined}
    >
      <motion.div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
        initial={variant === 'fullscreen' ? { y: 24, opacity: 0 } : { y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        style={{ paddingBottom: 'var(--safe-bottom)' }}
        className={`flex flex-col gap-3 border border-zinc-700 bg-zinc-900 p-4 outline-none ${
          variant === 'theater' ? '' : 'max-h-[92dvh]'
        } ${sheetPanelClass} ${variant === 'theater' ? 'max-w-none' : maxWidth} ${panelClassName}`}
      >
        {title && (
          <div className="flex shrink-0 items-center gap-2">
            <h3
              id={titleId}
              className="font-display font-bold uppercase tracking-wide text-zinc-100"
            >
              {title}
            </h3>
            {dismissible && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-500 hover:text-zinc-200 md:h-8 md:w-8"
              >
                ✕
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 border-t border-zinc-800 pt-3">{footer}</div>}
      </motion.div>
    </div>
  );
}

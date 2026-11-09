import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { socket } from '../socket.js';

// **"Resolving" (decided, batch 4):** while a fight is working through
// something — a turn's start or end, a Commit's queued Actions, an Interrupt,
// a trigger and its follow-ons — a faint green plaque with a spinning icon
// sits at the bottom of the screen: not a good time to make Actions. It fades
// out over 200ms once the last of it has resolved. The server says when
// (`fight:resolving { sceneId, mode, busy }`); `mode`: this view's fight.
export default function ResolvingPlaque({ mode, sceneId }) {
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const fade = useRef(null);
  useEffect(() => {
    const on = (e) => {
      if (!e || e.mode !== mode || (sceneId != null && e.sceneId !== sceneId)) return;
      setBusy(Boolean(e.busy));
    };
    socket.on('fight:resolving', on);
    return () => socket.off('fight:resolving', on);
  }, [mode, sceneId]);
  useEffect(() => {
    clearTimeout(fade.current);
    if (busy) setShown(true);
    else fade.current = setTimeout(() => setShown(false), 200);
    return () => clearTimeout(fade.current);
  }, [busy]);
  if (!shown && !busy) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 flex -translate-x-1/2 items-center gap-1.5 panel-cut-sm border border-emerald-500/40 bg-emerald-950/80 px-3 py-1 font-display text-[11px] font-bold uppercase tracking-wide text-emerald-200 shadow-lg"
      style={{ zIndex: 3550, bottom: 'calc(max(0.5rem, var(--safe-bottom, 0px)) + 2.25rem)', opacity: busy ? 1 : 0, transition: 'opacity 200ms ease-out' }}
    >
      <Loader2 size={13} className="animate-spin" aria-hidden />
      Resolving
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { socket } from '../socket.js';

// **"Resolving" (decided, batch 4):** while a fight is working through
// something — a turn's start or end, a Commit's queued Actions, an Interrupt,
// a trigger and its follow-ons — a faint green plaque with a spinning icon
// sits at the bottom of the screen: not a good time to make Actions. It fades
// out over 200ms once the last of it has resolved. The server says when
// (`fight:resolving { sceneId, mode, busy, steps }`); `mode`: this view's fight.
//
// **The resolve stack (decided, batch 5):** the plaque names what is resolving
// and where it is in the stack — "Step 2 of 5 · Jab" — and a tap opens the
// whole list: done steps ticked, the current one lit, the queued ones below.
// The total grows as new things arise (a trigger, a follow-on).
export default function ResolvingPlaque({ mode, sceneId }) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState([]);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const fade = useRef(null);
  useEffect(() => {
    const on = (e) => {
      if (!e || e.mode !== mode || (sceneId != null && e.sceneId !== sceneId)) return;
      setBusy(Boolean(e.busy));
      // The last stack stays up while the plaque fades.
      if (e.busy) setSteps(Array.isArray(e.steps) ? e.steps : []);
    };
    socket.on('fight:resolving', on);
    return () => socket.off('fight:resolving', on);
  }, [mode, sceneId]);
  useEffect(() => {
    clearTimeout(fade.current);
    if (busy) setShown(true);
    else
      fade.current = setTimeout(() => {
        setShown(false);
        setSteps([]);
        setOpen(false);
      }, 200);
    return () => clearTimeout(fade.current);
  }, [busy]);
  if (!shown && !busy) return null;
  // The step being worked on: the last one running (a trigger inside an Action is the later one).
  let at = -1;
  steps.forEach((s, i) => {
    if (s.state === 'now') at = i;
  });
  if (at < 0) at = steps.filter((s) => s.state === 'done').length - 1;
  const current = at >= 0 ? steps[at] : null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-resolving={steps.length ? `${at + 1}/${steps.length}` : 'busy'}
      className="fixed left-1/2 flex max-w-[92vw] -translate-x-1/2 flex-col items-stretch panel-cut-sm border border-emerald-500/40 bg-emerald-950/85 font-display text-[11px] font-bold uppercase tracking-wide text-emerald-200 shadow-lg"
      style={{ zIndex: 3550, bottom: 'calc(max(0.5rem, var(--safe-bottom, 0px)) + 2.25rem)', opacity: busy ? 1 : 0, transition: 'opacity 200ms ease-out', pointerEvents: busy ? 'auto' : 'none' }}
    >
      {open && steps.length > 0 && (
        <ol className="max-h-[40vh] space-y-0.5 overflow-y-auto border-b border-emerald-500/30 px-3 py-1.5 text-[10px] normal-case tracking-normal">
          {steps.map((s, i) => (
            <li
              key={i}
              className={`flex items-center gap-1.5 ${s.state === 'done' ? 'text-emerald-200/50' : i === at ? 'text-emerald-100' : s.state === 'now' ? 'text-emerald-200/80' : 'text-emerald-200/70'}`}
            >
              <span className="w-4 shrink-0 text-right tabular-nums">{i + 1}</span>
              <span className="flex w-3 shrink-0 justify-center">
                {s.state === 'done' ? <Check size={10} aria-hidden /> : s.state === 'now' ? <Loader2 size={10} className="animate-spin" aria-hidden /> : null}
              </span>
              <span className={`min-w-0 truncate ${i === at ? 'font-bold' : 'font-medium'}`}>{s.label}</span>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        onClick={() => steps.length > 0 && setOpen((v) => !v)}
        aria-expanded={open}
        title={steps.length ? 'Show the whole stack' : undefined}
        className="flex items-center gap-1.5 px-3 py-1 text-left"
      >
        <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden />
        {current ? (
          <>
            <span className="shrink-0 tabular-nums">
              Step {at + 1} of {steps.length}
            </span>
            <span className="min-w-0 truncate font-semibold normal-case tracking-normal text-emerald-100">· {current.label}</span>
            {open ? <ChevronDown size={12} className="shrink-0" aria-hidden /> : <ChevronUp size={12} className="shrink-0" aria-hidden />}
          </>
        ) : (
          'Resolving'
        )}
      </button>
    </div>
  );
}

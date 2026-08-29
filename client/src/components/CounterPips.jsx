import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRole } from '../roleContext.jsx';
import { useAnchoredPosition } from '../lib/useAnchoredPosition.js';
import { gatesByPip } from '../lib/useCounterGates.js';

// A Counter's pip strip, with its Gates.
//
// **One implementation, used by the sheet and by the Arena.** The two drew their
// own identical rows of pips before this existed; a Gate has a size, a hover
// card and (for the GM) a click, and three of those written twice is how the
// Arena quietly stops showing something the sheet does.
//
// **A Gate's pip is drawn twice the size, for everybody.** That a point of
// progress matters is never the secret — the secret is only what happens there —
// so the table can always see one coming.

const PIP = 16; // h-4 w-4, the size a plain pip has always been
const GATE_PIP = 32;

export default function CounterPips({ counter, gates, onEditGate }) {
  const { role } = useRole();
  const byPip = gatesByPip(gates);
  const canEdit = role === 'gm' && typeof onEditGate === 'function';

  return (
    <div
      className="flex flex-1 flex-wrap items-center justify-center gap-1.5"
      title={`${counter.current_pips} / ${counter.target_pips}`}
    >
      {Array.from({ length: counter.target_pips }, (_, i) => {
        const pip = i + 1;
        return (
          <Pip
            key={pip}
            filled={i < counter.current_pips}
            gate={byPip.get(pip)}
            // The GM clicks any pip to put a Gate on it or edit the one there.
            // A pip with no Gate is only clickable for the GM, so nothing about
            // the strip changes for a Player who has none.
            onClick={canEdit ? () => onEditGate(pip, byPip.get(pip) ?? null) : undefined}
          />
        );
      })}
    </div>
  );
}

function Pip({ filled, gate, onClick }) {
  const ref = useRef(null);
  const [hovering, setHovering] = useState(false);
  const size = gate ? GATE_PIP : PIP;

  const body = (
    <span
      ref={ref}
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={() => setHovering(false)}
      tabIndex={gate ? 0 : undefined}
      role={onClick ? 'button' : undefined}
      title={onClick && !gate ? 'Put a Gate on this pip' : undefined}
      className={`block shrink-0 rounded-full transition-all ${
        gate
          ? // A Gate reads as a ring rather than a bigger dot: doubled and
            // filled it would look like four pips' worth of progress.
            `border-2 ${filled ? 'border-amber-300 bg-amber-500/80' : 'border-amber-500/70 bg-zinc-800'}`
          : `border ${filled ? 'border-brand-400 bg-brand-500' : 'border-zinc-700 bg-zinc-800'}`
      } ${onClick ? 'cursor-pointer hover:ring-2 hover:ring-brand-500/60' : ''}`}
      style={{ width: size, height: size }}
    />
  );

  if (!gate) return body;
  return (
    <>
      {body}
      {hovering && <GateCard gate={gate} anchorRef={ref} />}
    </>
  );
}

// What a Gate says, to whoever is looking.
//
// **"???" is what an absent field looks like, not a flag we obey.** A secret
// Gate arrives without its name and description at all (see `visibleGate` on the
// server), so this renders what it was given; there is nothing here to bypass.
function GateCard({ gate, anchorRef }) {
  // Portalled and viewport-clamped, like every other floating panel in the app —
  // a pip lives inside a scrolling column and a card positioned relative to it
  // would be clipped by the first ancestor with `overflow: hidden`.
  const pos = useAnchoredPosition(anchorRef, true, { width: 232 });
  if (!pos) return null;
  const hidden = gate.secret && gate.name === undefined;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[93] panel-cut border border-amber-900/60 bg-zinc-950 p-2 shadow-2xl shadow-black/80"
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
    >
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-500/80">
          Gate {gate.pip_index}
        </span>
        {gate.secret ? (
          <span className="rounded-full bg-amber-900/40 px-1.5 text-[9px] font-bold uppercase text-amber-300">
            Secret
          </span>
        ) : null}
      </div>
      <p className="text-sm font-bold text-zinc-100">{hidden ? '???' : gate.name || 'Unnamed'}</p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-zinc-400">
        {hidden ? '???' : gate.description || 'No description.'}
      </p>
    </div>,
    document.body
  );
}

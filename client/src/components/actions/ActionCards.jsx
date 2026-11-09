import { splitGates } from '../../lib/patd/gates.js';

// **Action cards, drawn like the book's (vttprojectplan.md, "Action cards
// and the dice board").** An Action: a dark-green slanted header reading
// "cost: Name" over a mint-green body with a brighter green edge, the base
// effect first and each Gate ("3+: …") on its own line with its threshold in
// bold. A Super Move: a dark card — Alpha purple, Delta teal — with its
// "α Super" / "Δ Super" mark.
//
// On the dice board a card can be lit (`lit`: thresholds reached by the dice
// laid on it or the cost paid, `null` for none) — a mild green glow on the
// card and on **every Gate up to the highest one reached** (by the rules you
// get each Gate up to it, decided) — and shows those dice (`dice`: their
// numbers) or what was paid (`paid`: text).

const HEADER_CLIP = { clipPath: 'polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%)' };

// `paidAmount`: how many tokens / HP a paid cost took — it lights the cost
// Gates ("5 Iron: …") up to it.
// `onGateTap(threshold)`: Gate lines become tappable (stop at an earlier Gate,
// phase B); `committed`: the Action was performed (a quieter glow).
// `preview` (a die dragged over the card — decided): the Gate that die would
// reach (a number: every Gate up to it shows sky-blue), or `false` when it
// can't pay for it (a red outline). `undefined`: no die over it.
export function ActionCard({ action, lit = null, dice = [], paid = null, paidAmount = null, compact = false, dropTarget = false, onGateTap = null, committed = false, preview = undefined }) {
  if (!action) return null;
  const { base, gates } = splitGates(action.rulesText);
  // The base effect's threshold: the lowest cost (an "X" cost: 0).
  const lowest = [...(action.gates?.headerThresholds ?? [])].sort((a, b) => a - b)[0] ?? 0;
  const top = lit != null && lit.length ? Math.max(...lit) : null;
  const reached = (t) => top != null && t != null && t <= top;
  const previewed = (t) => typeof preview === 'number' && t != null && t <= preview;
  const previewRing = preview === false ? 'outline outline-2 outline-offset-1 outline-red-500' : typeof preview === 'number' ? 'outline outline-2 outline-offset-1 outline-sky-400' : '';
  const gateTone = (on, pre) => (on ? 'bg-lime-200 ring-1 ring-lime-500' : pre ? 'bg-sky-200 ring-1 ring-sky-500' : '');
  const cost = action.cost?.text ?? (typeof action.cost === 'string' ? action.cost : '');
  const size = compact ? 'text-[11px]' : 'text-xs';
  return (
    <article
      data-action-id={dropTarget ? action.id : undefined}
      className={`relative overflow-hidden rounded-[2px] transition-shadow ${previewRing} ${
        lit != null ? (committed ? 'opacity-75 shadow-[0_0_0_2px_#65a30d]' : 'shadow-[0_0_0_3px_#bef264,0_0_18px_2px_rgba(190,242,100,0.55)]') : ''
      }`}
    >
      <header className="relative flex items-center bg-[linear-gradient(90deg,#3ef09d,#7af5c0)]">
        <h4
          className={`min-w-0 flex-1 truncate bg-[#1d6b2c] py-1 pl-2.5 pr-7 font-bold text-white ${compact ? 'text-xs' : 'text-sm'}`}
          style={HEADER_CLIP}
          title={`${cost ? `${cost}: ` : ''}${action.name}`}
        >
          {cost ? `${cost}: ` : ''}
          {action.name}
        </h4>
        {paid && (
          <span className="shrink-0 truncate px-1.5 text-[10px] font-bold uppercase text-emerald-950" title={`Paid: ${paid}`}>
            {paid}
          </span>
        )}
        {dice.length > 0 && (
          <span className="flex shrink-0 gap-1 px-1.5">
            {dice.map((v, i) => (
              <span key={i} className="flex h-5 min-w-5 items-center justify-center rounded-sm border border-emerald-900 bg-white px-1 font-mono text-[11px] font-black text-emerald-900">
                {v}
              </span>
            ))}
          </span>
        )}
      </header>
      <div
        className={`space-y-0.5 border-r-[6px] border-[#3fd83f] px-2.5 py-1.5 leading-snug text-zinc-950 ${size} ${
          lit != null ? 'bg-[linear-gradient(90deg,#b9f8cf,#dcfce7)]' : 'bg-[linear-gradient(90deg,#3ef09d,#7af5c0)]'
        }`}
      >
        {base && (
          <p
            onClick={onGateTap && reached(lowest) ? (e) => (e.stopPropagation(), onGateTap(lowest)) : undefined}
            className={`whitespace-pre-line rounded-sm px-1 ${gateTone(reached(lowest), previewed(lowest))} ${onGateTap && reached(lowest) ? 'cursor-pointer' : ''}`}
          >
            {base}
          </p>
        )}
        {gates.map((g, i) => (
          <p
            key={i}
            onClick={onGateTap && g.kind === 'dice' && reached(g.n) ? (e) => (e.stopPropagation(), onGateTap(g.n)) : undefined}
            title={onGateTap && g.kind === 'dice' && reached(g.n) ? 'Tap to stop at this Gate' : undefined}
            className={`whitespace-pre-line rounded-sm px-1 pl-3 ${
              g.kind === 'cost' ? gateTone(paidAmount != null && g.n <= paidAmount, false) : gateTone(reached(g.n), previewed(g.n))
            } ${onGateTap && g.kind === 'dice' && reached(g.n) ? 'cursor-pointer' : ''}`}
          >
            <b>{g.threshold}:</b> {g.text}
          </p>
        ))}
      </div>
    </article>
  );
}

export function SuperMoveCard({ move, compact = false }) {
  if (!move) return null;
  const delta = move.variant === 'delta';
  return (
    <article className="overflow-hidden rounded-[2px]">
      <header className={`flex items-center ${delta ? 'bg-[linear-gradient(90deg,#0f2f40,#14506a)]' : 'bg-[linear-gradient(90deg,#2a0a30,#5c0f60)]'}`}>
        <h4
          className={`min-w-0 flex-1 truncate py-1 pl-2.5 pr-7 font-bold text-white ${compact ? 'text-xs' : 'text-sm'} ${delta ? 'bg-[#1d6688]' : 'bg-[#8a1a8c]'}`}
          style={HEADER_CLIP}
        >
          {move.name}
        </h4>
        <span className={`shrink-0 px-2 font-display text-sm font-black italic ${delta ? 'text-sky-300' : 'text-fuchsia-300'}`}>{delta ? 'Δ Super' : 'α Super'}</span>
      </header>
      <p
        className={`whitespace-pre-line border-r-[6px] px-2.5 py-1.5 leading-snug text-zinc-100 ${compact ? 'text-[11px]' : 'text-xs'} ${
          delta ? 'border-[#0b3a50] bg-[linear-gradient(90deg,#0f2f40,#14506a)]' : 'border-[#3a0840] bg-[linear-gradient(90deg,#2a0a30,#5c0f60)]'
        }`}
      >
        {move.rulesText}
      </p>
    </article>
  );
}

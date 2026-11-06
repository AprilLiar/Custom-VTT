import DiceIcon from '../DiceIcon.jsx';
import { shortStyleName } from '../../lib/patd/build.js';
import { splitGates } from '../../lib/patd/gates.js';

// Small shared pieces of the character builder (BuildTab.jsx).

export const cardClass = (on) =>
  `panel-cut-sm border px-2 py-1.5 text-left ${on ? 'border-brand-500 bg-brand-950/40' : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'}`;
export const selectClass =
  'min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1.5 text-xs text-zinc-100 outline-none focus:border-brand-500';

// A Stance's dice: purple / green Action Dice (book colours), fixed numbers,
// and the level's bonus die in amber.
export function DiceRow({ dice }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {dice.map((d, i) =>
        d.kind === 'fixed' ? (
          <span
            key={i}
            title={`Fixed ${d.value}${d.color ? ` (${d.color})` : ''}`}
            className={`flex h-6 w-6 items-center justify-center rounded-sm border text-[11px] font-bold ${
              d.color === 'green' ? 'border-emerald-500/70 text-emerald-300' : 'border-purple-400/70 text-purple-300'
            }`}
          >
            {d.value}
          </span>
        ) : (
          <span key={i} title={d.bonus ? `Bonus d${d.sides} (level)` : d.extra ? `Extra d${d.sides} (an Ability)` : `${d.color ?? ''} d${d.sides}`}>
            <DiceIcon
              size={d.sides}
              className={`h-6 w-6 ${d.bonus ? 'text-amber-300' : d.color === 'green' ? 'text-emerald-300' : 'text-purple-300'}`}
            />
          </span>
        )
      )}
    </span>
  );
}

export const rangeText = (r) => (r ? (r.minimum === r.maximum ? `Range ${r.minimum}` : `Range ${r.minimum}-${r.maximum}`) : 'Range —');

export function StyleLabel({ style }) {
  if (!style) return <span className="text-zinc-500">—</span>;
  return <span>{shortStyleName(style.name)}</span>;
}

// A rules entry (ability, action, super move) as reference text.
export function RulesEntry({ entry, kind }) {
  if (!entry) return null;
  return (
    <li className="panel-cut-sm border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-display text-xs font-bold uppercase tracking-wide text-zinc-100">{entry.name}</span>
        {kind && <span className="text-[10px] uppercase text-zinc-500">{kind}</span>}
        {entry.cost?.text && <span className="text-[11px] font-semibold text-amber-300">{entry.cost.text}</span>}
        {typeof entry.cost === 'string' && <span className="text-[11px] font-semibold text-amber-300">{entry.cost}</span>}
        {entry.automationState === 'requires_ruling' && <span className="text-[10px] uppercase text-red-400">needs a ruling</span>}
      </p>
      <RulesText text={entry.rulesText} gated={kind === 'Action' || kind === 'Super Move'} />
    </li>
  );
}

// Rules text keeping its line breaks; an Action's Gates ("3+: …") as a list.
function RulesText({ text, gated }) {
  const { base, gates } = gated ? splitGates(text) : { base: text ?? '', gates: [] };
  return (
    <div className="mt-0.5 text-xs leading-snug text-zinc-400">
      {base && <p className="whitespace-pre-line">{base}</p>}
      {gates.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {gates.map((g, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-8 shrink-0 text-right font-mono font-bold text-amber-300">{g.threshold}</span>
              <span className="whitespace-pre-line">{g.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

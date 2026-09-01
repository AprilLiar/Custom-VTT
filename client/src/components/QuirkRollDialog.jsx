import { useState } from 'react';
import { Dices, Plus } from 'lucide-react';
import { socket } from '../socket.js';
import { quirkStyle } from '../lib/quirkStyles.js';
import DialogShell from './DialogShell.jsx';
import QuirkCard from './QuirkCard.jsx';

// **Roll a Quirk.** One of a side's examples, at random, in a dialog you can
// take or walk away from — for the table that wants the dice to decide who
// their character is rather than shopping the shelf.
//
// **Re-rollable, deliberately.** A single throw with no way back is a worse
// version of the same feature: you would close it and press the button again,
// which is the same act with more clicks. The Roll again button says so.
//
// The pick itself is made HERE rather than server-side, because it is a
// preference of the person rolling and nobody else is watching it happen — the
// same reasoning the cutscene's playback speed follows. What lands on a
// character goes through the ordinary `character_quirk:add`, so a rolled Quirk
// is indistinguishable afterwards from one somebody chose.
const pick = (list, avoid) => {
  if (!list.length) return null;
  // Never the same one twice in a row while there is anything else to give —
  // a re-roll that shows you what you just saw reads as a broken button.
  const pool = list.length > 1 && avoid ? list.filter((q) => q.id !== avoid.id) : list;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
};

export default function QuirkRollDialog({ kind, quirks, characters, myCharacterId, onClose }) {
  const style = quirkStyle(kind);
  const [rolled, setRolled] = useState(() => pick(quirks, null));
  const [added, setAdded] = useState(null); // characterId it was just given to
  // The GM has no sheet of their own, so they pick whose it is; a Player's own
  // character is the only answer and needs no control.
  const [target, setTarget] = useState(myCharacterId ?? characters[0]?.id ?? null);

  const give = () => {
    if (!rolled || target == null) return;
    socket.emit('character_quirk:add', { characterId: target, quirkId: rolled.id });
    setAdded(target);
  };

  const targetName = characters.find((c) => c.id === target)?.name ?? 'them';

  return (
    <DialogShell
      title={`Roll a ${style.label} Quirk`}
      onClose={onClose}
      portal
      maxWidth="max-w-lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setRolled(pick(quirks, rolled));
              setAdded(null);
            }}
            disabled={quirks.length < 2}
            title={quirks.length < 2 ? 'There is only one on this side' : undefined}
            className="flex min-h-11 items-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:border-zinc-500 disabled:opacity-40 md:min-h-0 md:py-2"
          >
            <Dices size={15} aria-hidden />
            Roll again
          </button>
          <div className="flex items-center gap-2">
            {/* Whose sheet it lands on. A Player has exactly one answer, so the
                picker is not shown to them at all rather than shown with one
                option — a control with no choice in it is furniture. */}
            {myCharacterId == null && characters.length > 0 && (
              <select
                value={target ?? ''}
                onChange={(e) => {
                  setTarget(Number(e.target.value));
                  setAdded(null);
                }}
                aria-label="Give it to"
                className="min-h-11 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-200 md:min-h-0 md:py-1.5"
              >
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={give}
              disabled={!rolled || target == null || added === target}
              title={rolled ? `Add "${rolled.name}" to ${targetName}` : undefined}
              className={`flex min-h-11 items-center gap-1.5 panel-cut-sm border px-3 text-sm font-semibold disabled:opacity-40 md:min-h-0 md:py-2 ${style.chip}`}
            >
              <Plus size={15} aria-hidden />
              {added === target ? 'Added' : 'Add'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 px-3 text-sm text-zinc-400 hover:text-zinc-200 md:min-h-0"
            >
              Close
            </button>
          </div>
        </div>
      }
    >
      {rolled ? (
        <div className="space-y-2">
          <QuirkCard quirk={rolled} />
          {added === target && (
            <p className={`text-sm ${style.heading}`}>
              Added to {targetName}. Roll again, or close.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          There are no {style.label.toLowerCase()} examples on the shelf yet.
        </p>
      )}
    </DialogShell>
  );
}

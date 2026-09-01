import { useState } from 'react';
import { QUIRK_KINDS, quirkKind, quirkStyle } from '../lib/quirkStyles.js';

// Write a Quirk: a name, a description, and which side it is on. The same form
// creates one and edits one, and the same form is used by all three surfaces —
// the Compendium's shelf, a character sheet, and the Creator's step — because
// "a Quirk" is the same three fields everywhere. There is nothing else to a
// Quirk; that is the point of it.
//
// **Creating on the fly is the primary path, not a fallback** (the ask, in
// those words: *"in the creator, or on the sheet, the users can create new
// Quirks on-the-fly"*). So this is an inline form rather than a modal: a
// player writing "Terrified of dogs" mid-session should not have the page taken
// away from them to do it.
//
// `onSubmit` receives `{ name, description, kind }` and nothing else — no ids,
// no target character. Who the Quirk is for is the caller's business, which is
// what lets one form serve a shelf, a sheet and a wizard draft.
export default function QuirkEditor({ initial = null, defaultKind = 'positive', onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [kind, setKind] = useState(quirkKind(initial?.kind ?? defaultKind));

  const submit = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit({ name: trimmed, description: description.trim(), kind });
  };

  return (
    <form onSubmit={submit} className="space-y-2 panel-cut-sm border border-zinc-700 bg-zinc-950/80 p-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Quirk name"
        aria-label="Quirk name"
        maxLength={120}
        autoFocus
        className="w-full panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-brand-500"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What it means at the table…"
        aria-label="Quirk description"
        rows={3}
        maxLength={4000}
        className="w-full panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-brand-500"
      />
      {/* Two buttons rather than a select: there are exactly two sides, they
          are the one thing about a Quirk that carries colour, and showing that
          colour on the control is what makes the choice legible before you have
          read either word. */}
      <div className="flex gap-2">
        {QUIRK_KINDS.map((k) => {
          const style = quirkStyle(k);
          const on = kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={on}
              className={`flex min-h-11 flex-1 items-center justify-center panel-cut-sm border font-display text-xs font-semibold uppercase tracking-wide md:min-h-0 md:py-1.5 ${
                on ? style.toggleOn : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
              }`}
            >
              {style.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!name.trim()}
          className="min-h-11 panel-cut-sm bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-40 md:min-h-0 md:py-1.5"
        >
          {initial ? 'Save' : 'Add Quirk'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 px-3 text-sm text-zinc-400 hover:text-zinc-200 md:min-h-0"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

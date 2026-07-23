import { useState } from 'react';

const MODIFIER_LIMIT = 20;

// Asks for the ad-hoc +/- modifier before a die or pool roll (clamped to +/-20).
export default function RollDialog({ title, onRoll, onClose }) {
  const [value, setValue] = useState('0');

  const submit = (e) => {
    e.preventDefault();
    const n = Math.trunc(Number(value) || 0);
    onRoll(Math.max(-MODIFIER_LIMIT, Math.min(MODIFIER_LIMIT, n)));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="flex w-64 flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
      >
        <h3 className="font-bold text-zinc-100">{title}</h3>
        <label className="text-sm text-zinc-400">
          Modifier (−{MODIFIER_LIMIT} to +{MODIFIER_LIMIT})
          <input
            autoFocus
            type="number"
            min={-MODIFIER_LIMIT}
            max={MODIFIER_LIMIT}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-lg text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="flex-1 rounded-md bg-indigo-600 py-2 font-semibold hover:bg-indigo-500"
          >
            Roll
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

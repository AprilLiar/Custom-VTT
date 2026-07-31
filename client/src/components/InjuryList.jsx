import { useState } from 'react';

// Injuries can optionally dock ranks off one of the 8 die slots (decided —
// see server/gameLogic.js's applyRankPenalty). The penalty only ever takes
// effect when the character reverts to their locked/base stats
// (character:revert_stats), which is why it's shown here as metadata on the
// Injury itself rather than as a live stat change.
const SLOTS = ['Skull', 'Brain', 'Left Hand', 'Stamina', 'Body', 'Right Hand', 'Left Leg', 'Right Leg'];

function Row({ injury, onSave, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(injury.name);
  const [effect, setEffect] = useState(injury.effect);
  const [slotName, setSlotName] = useState(injury.slot_name ?? '');
  const [penalty, setPenalty] = useState(injury.penalty || 0);

  const startEdit = () => {
    setName(injury.name);
    setEffect(injury.effect);
    setSlotName(injury.slot_name ?? '');
    setPenalty(injury.penalty || 0);
    setEditing(true);
  };

  const save = (e) => {
    e?.preventDefault();
    if (!name.trim()) return;
    onSave(name.trim(), effect.trim(), slotName || null, slotName ? penalty : 0);
    setEditing(false);
  };

  if (editing) {
    return (
      <li>
        <form onSubmit={save} className="flex flex-col gap-1 panel-cut-sm border border-zinc-700 bg-zinc-800/60 p-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-semibold text-zinc-100 outline-none focus:border-brand-500"
          />
          <input
            value={effect}
            onChange={(e) => setEffect(e.target.value)}
            placeholder="Effect (optional)"
            className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
          />
          <div className="flex gap-1">
            <select
              value={slotName}
              onChange={(e) => setSlotName(e.target.value)}
              className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
            >
              <option value="">No stat penalty</option>
              {SLOTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {slotName && (
              <input
                type="number"
                min={0}
                value={penalty}
                onChange={(e) => setPenalty(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
                title="Ranks docked from this slot's base value on revert"
                className="w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
              />
            )}
          </div>
          <div className="flex justify-end gap-1">
            <button
              type="submit"
              disabled={!name.trim()}
              className="panel-cut-sm px-2 py-0.5 text-xs font-semibold text-green-400 hover:bg-green-900/30 disabled:opacity-40"
            >
              ✓ Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-700"
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-2 py-0.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-zinc-100">{injury.name}</div>
        {injury.effect && <div className="text-xs text-zinc-500">{injury.effect}</div>}
        {injury.slot_name && injury.penalty > 0 && (
          <div className="text-xs text-red-400">
            -{injury.penalty} rank{injury.penalty === 1 ? '' : 's'} to {injury.slot_name} on revert
          </div>
        )}
      </div>
      <button
        onClick={startEdit}
        title="Edit"
        className="panel-cut-sm px-1.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
      >
        ✎
      </button>
      <button
        onClick={onRemove}
        title="Remove"
        className="panel-cut-sm px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
      >
        ✕
      </button>
    </li>
  );
}

export default function InjuryList({
  items, // [{ id, name, effect, slot_name, penalty }]
  onAdd, // (name, effect, slotName, penalty)
  onUpdate, // (id, name, effect, slotName, penalty)
  onRemove, // (id)
}) {
  const [name, setName] = useState('');
  const [effect, setEffect] = useState('');
  const [slotName, setSlotName] = useState('');
  const [penalty, setPenalty] = useState(0);

  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd(name.trim(), effect.trim(), slotName || null, slotName ? penalty : 0);
    setName('');
    setEffect('');
    setSlotName('');
    setPenalty(0);
  };

  return (
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">Injuries</h3>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-600">None.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <Row
              key={item.id}
              injury={item}
              onSave={(n, eff, slot, pen) => onUpdate(item.id, n, eff, slot, pen)}
              onRemove={() => onRemove(item.id)}
            />
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Injury"
          className="w-1/3 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-brand-500"
        />
        <input
          value={effect}
          onChange={(e) => setEffect(e.target.value)}
          placeholder="Effect (optional)"
          className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-brand-500"
        />
        <select
          value={slotName}
          onChange={(e) => setSlotName(e.target.value)}
          className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 outline-none focus:border-brand-500"
        >
          <option value="">No stat penalty</option>
          {SLOTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {slotName && (
          <input
            type="number"
            min={0}
            value={penalty}
            onChange={(e) => setPenalty(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
            title="Ranks docked from this slot's base value on revert"
            className="w-20 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          />
        )}
        <button
          type="submit"
          disabled={!name.trim()}
          className="panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </div>
  );
}

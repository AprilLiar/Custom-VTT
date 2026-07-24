import { useState } from 'react';
import { AUTOMATION_OPTIONS, TRIGGER_LABELS } from '../lib/moveDisplay.js';
import FrameBar from './FrameBar.jsx';

const FRAME_FIELDS = [
  { key: 'startup', label: 'Startup', color: 'text-yellow-500' },
  { key: 'active', label: 'Active', color: 'text-red-500' },
  { key: 'recovery', label: 'Recovery', color: 'text-blue-500' },
];

function AutomationEditor({ automations, onChange }) {
  const add = () => onChange([...automations, { type: 'self_recovery', amount: 1 }]);
  const update = (i, patch) =>
    onChange(automations.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const remove = (i) => onChange(automations.filter((_, j) => j !== i));

  return (
    <div className="space-y-1">
      {automations.map((a, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select
            value={a.type}
            onChange={(e) => update(i, { type: e.target.value })}
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500"
          >
            {AUTOMATION_OPTIONS.map((o) => (
              <option key={o.type} value={o.type}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={a.type === 'self_recovery' ? -20 : 1}
            max={20}
            value={a.amount}
            onChange={(e) => update(i, { amount: Number(e.target.value) })}
            className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="rounded px-1 text-zinc-600 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-indigo-400 hover:text-indigo-300"
      >
        + automation
      </button>
    </div>
  );
}

// Full Move create/edit form. `initial` is a move (with interactions) for
// edit mode; onSubmit receives the socket payload minus moveId.
export default function MoveCreator({ tells, initial, onSubmit, onCancel }) {
  const initInteraction = (trigger) => {
    const row = initial?.interactions?.find((r) => r.trigger === trigger);
    return { text: row?.text ?? '', automations: row?.automations ?? [] };
  };
  const [name, setName] = useState(initial?.name ?? '');
  const [isDefault, setIsDefault] = useState(Boolean(initial?.is_default));
  const [tellId, setTellId] = useState(initial?.tell_id ?? tells[0]?.id ?? null);
  const [frames, setFrames] = useState({
    startup: initial?.startup_tics ?? 1,
    active: initial?.active_tics ?? 1,
    recovery: initial?.recovery_tics ?? 0,
  });
  const [description, setDescription] = useState(initial?.description ?? '');
  const [interactions, setInteractions] = useState({
    hit: initInteraction('hit'),
    block: initInteraction('block'),
    miss: initInteraction('miss'),
  });

  const total = frames.startup + frames.active + frames.recovery;
  const valid = name.trim() && tellId && total >= 1;

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      isDefault,
      tellId,
      startupTics: frames.startup,
      activeTics: frames.active,
      recoveryTics: frames.recovery,
      description: description.trim(),
      interactions,
    });
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
    >
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        {initial ? 'Edit Move' : 'Move Creator'}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Move name"
          className="min-w-40 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
        />
        <label className="flex items-center gap-1.5 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          Default (everyone has it)
        </label>
        <select
          value={tellId ?? ''}
          onChange={(e) => setTellId(Number(e.target.value))}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-indigo-500"
        >
          {tells.map((t) => (
            <option key={t.id} value={t.id}>
              Tell: {t.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {FRAME_FIELDS.map((f) => (
          <label key={f.key} className={`text-xs font-semibold uppercase ${f.color}`}>
            {f.label} (0-10)
            <input
              type="number"
              min={0}
              max={10}
              value={frames[f.key]}
              onChange={(e) =>
                setFrames((prev) => ({
                  ...prev,
                  [f.key]: Math.max(0, Math.min(10, Math.trunc(Number(e.target.value) || 0))),
                }))
              }
              className="mt-1 block w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
          </label>
        ))}
        <div className="pb-1">
          <FrameBar startup={frames.startup} active={frames.active} recovery={frames.recovery} />
          {total < 1 && <p className="text-xs text-red-400">At least 1 square total</p>}
        </div>
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {Object.entries(TRIGGER_LABELS).map(([trigger, label]) => (
          <div key={trigger} className="rounded-lg border border-zinc-800 p-2">
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-400">
              {label}
            </div>
            <textarea
              value={interactions[trigger].text}
              onChange={(e) =>
                setInteractions((prev) => ({
                  ...prev,
                  [trigger]: { ...prev[trigger], text: e.target.value },
                }))
              }
              placeholder="Text (optional)"
              rows={2}
              className="mb-2 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500"
            />
            <AutomationEditor
              automations={interactions[trigger].automations}
              onChange={(automations) =>
                setInteractions((prev) => ({
                  ...prev,
                  [trigger]: { ...prev[trigger], automations },
                }))
              }
            />
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid}
          className="flex-1 rounded-md bg-indigo-600 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          {initial ? 'Save Move' : 'Create Move'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

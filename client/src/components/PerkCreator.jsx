import { useRef, useState } from 'react';
import { fileToSmallImage } from '../lib/image.js';
import { DIE_SLOT_NAMES } from '../lib/diceSlots.js';
import { AUTOMATION_TYPE_LABELS } from '../lib/perkDisplay.js';
import Thumb from './Thumb.jsx';

const AUTOMATION_TYPES = Object.keys(AUTOMATION_TYPE_LABELS);

// Fresh default payload whenever an automation row's type changes.
function defaultPayload(type, moves) {
  const firstMoveId = moves[0]?.id ?? null;
  switch (type) {
    case 'die_step':
      return { slotName: DIE_SLOT_NAMES[0], steps: 1, scope: 'permanent' };
    case 'stamina_multiplier':
      return { delta: 1 };
    case 'move_tag':
      return { moveId: firstMoveId, tagId: null, action: 'add' };
    case 'move_frame_override':
      return { moveId: firstMoveId, startupDelta: 0, activeDelta: 0, recoveryDelta: 0 };
    case 'move_roll_bonus':
      return { moveId: firstMoveId, amount: 1 };
    default:
      return {};
  }
}

const fieldClass =
  'rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500';

function MoveSelect({ value, onChange, moves }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))} className={`min-w-0 flex-1 ${fieldClass}`}>
      <option value="">Move…</option>
      {moves.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

// Each automation type gets its own sub-form here — adding a new type means
// adding one case in this switch plus a defaultPayload() entry above,
// matching the server-side registry in perkAutomations.js/index.js.
function AutomationRow({ automation, moves, tags, onChange, onRemove }) {
  const { type, payload } = automation;
  const setPayload = (patch) => onChange({ type, payload: { ...payload, ...patch } });
  const setType = (newType) => onChange({ type: newType, payload: defaultPayload(newType, moves) });

  return (
    <div className="space-y-1.5 rounded-lg border border-zinc-700 bg-zinc-800/50 p-2">
      <div className="flex items-center gap-1.5">
        <select value={type} onChange={(e) => setType(e.target.value)} className={`flex-1 ${fieldClass}`}>
          {AUTOMATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {AUTOMATION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <button type="button" onClick={onRemove} className="rounded px-1.5 text-zinc-600 hover:text-red-400">
          ✕
        </button>
      </div>

      {type === 'die_step' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select value={payload.slotName} onChange={(e) => setPayload({ slotName: e.target.value })} className={fieldClass}>
            {DIE_SLOT_NAMES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={-20}
            max={20}
            value={payload.steps}
            onChange={(e) => setPayload({ steps: Number(e.target.value) })}
            title="Steps (+ up, - down) — reuses the same step logic as the sheet's up/down arrows"
            className={`w-16 ${fieldClass}`}
          />
          <span className="text-xs text-zinc-500">steps</span>
          <select value={payload.scope} onChange={(e) => setPayload({ scope: e.target.value })} className={fieldClass}>
            <option value="permanent">Permanent (current + locked)</option>
            <option value="current">Current only (Revert erases it)</option>
          </select>
        </div>
      )}

      {type === 'stamina_multiplier' && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500">Delta</span>
          <input
            type="number"
            min={-20}
            max={20}
            value={payload.delta}
            onChange={(e) => setPayload({ delta: Number(e.target.value) })}
            className={`w-16 ${fieldClass}`}
          />
        </div>
      )}

      {type === 'move_tag' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <MoveSelect value={payload.moveId} onChange={(moveId) => setPayload({ moveId })} moves={moves} />
          <select value={payload.tagId ?? ''} onChange={(e) => setPayload({ tagId: Number(e.target.value) })} className={fieldClass}>
            <option value="">Tag…</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select value={payload.action} onChange={(e) => setPayload({ action: e.target.value })} className={fieldClass}>
            <option value="add">Add</option>
            <option value="remove">Remove</option>
          </select>
        </div>
      )}

      {type === 'move_frame_override' && (
        <div className="flex flex-wrap items-center gap-2">
          <MoveSelect value={payload.moveId} onChange={(moveId) => setPayload({ moveId })} moves={moves} />
          <label className="flex items-center gap-1 text-xs text-yellow-500">
            Startup
            <input type="number" min={-10} max={10} value={payload.startupDelta} onChange={(e) => setPayload({ startupDelta: Number(e.target.value) })} className={`w-14 ${fieldClass}`} />
          </label>
          <label className="flex items-center gap-1 text-xs text-red-500">
            Active
            <input type="number" min={-10} max={10} value={payload.activeDelta} onChange={(e) => setPayload({ activeDelta: Number(e.target.value) })} className={`w-14 ${fieldClass}`} />
          </label>
          <label className="flex items-center gap-1 text-xs text-blue-500">
            Recovery
            <input type="number" min={-10} max={10} value={payload.recoveryDelta} onChange={(e) => setPayload({ recoveryDelta: Number(e.target.value) })} className={`w-14 ${fieldClass}`} />
          </label>
        </div>
      )}

      {type === 'move_roll_bonus' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <MoveSelect value={payload.moveId} onChange={(moveId) => setPayload({ moveId })} moves={moves} />
          <input
            type="number"
            min={-20}
            max={20}
            value={payload.amount}
            onChange={(e) => setPayload({ amount: Number(e.target.value) })}
            className={`w-16 ${fieldClass}`}
          />
          <span
            className="text-xs text-amber-500"
            title="Stored now — has no live effect until Moves get their own rolls in Combat Timing (Phase 7)"
          >
            not yet active ⓘ
          </span>
        </div>
      )}
    </div>
  );
}

// initial is a full Perk record (with .automations as [{type, payload}]) for
// edit mode; onSubmit receives the socket payload minus perkId.
export default function PerkCreator({ moves, tags, initial, onSubmit, onCancel }) {
  const fileRef = useRef(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [image, setImage] = useState(undefined); // undefined = keep existing
  const [automations, setAutomations] = useState(
    initial?.automations?.map((a) => ({ type: a.type, payload: a.payload })) ?? []
  );

  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImage(await fileToSmallImage(file).catch(() => undefined));
  };

  const addAutomation = () =>
    setAutomations((prev) => [...prev, { type: 'die_step', payload: defaultPayload('die_step', moves) }]);
  const updateAutomation = (i, next) =>
    setAutomations((prev) => prev.map((a, j) => (j === i ? next : a)));
  const removeAutomation = (i) => setAutomations((prev) => prev.filter((_, j) => j !== i));

  const valid = Boolean(name.trim());

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      automations,
      ...(image !== undefined ? image : {}),
    });
  };

  const preview =
    image !== undefined
      ? { image_data: image?.imageData, image_mime_type: image?.imageMimeType }
      : initial;

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        {initial ? 'Edit Perk' : 'Perk Creator'}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload Perk art (optional)"
          className="rounded-lg border border-zinc-700 hover:border-indigo-500"
        >
          <Thumb record={preview} name={name || '?'} size="h-12 w-12" rounded="rounded-lg" />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Perk name"
          className="min-w-40 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
        />
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />

      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">Automations</p>
        <div className="space-y-2">
          {automations.map((a, i) => (
            <AutomationRow
              key={i}
              automation={a}
              moves={moves}
              tags={tags}
              onChange={(next) => updateAutomation(i, next)}
              onRemove={() => removeAutomation(i)}
            />
          ))}
        </div>
        <button type="button" onClick={addAutomation} className="mt-2 text-xs text-indigo-400 hover:text-indigo-300">
          + automation
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid}
          className="flex-1 rounded-md bg-indigo-600 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          {initial ? 'Save Perk' : 'Create Perk'}
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

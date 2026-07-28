import { useRef, useState } from 'react';
import { AUTOMATION_OPTIONS, TRIGGER_LABELS } from '../lib/moveDisplay.js';
import { iconFor } from '../lib/styleIcons.js';
import { fileToSmallImage } from '../lib/image.js';
import { ROLL_SLOT_NAMES, ROLL_SLOT_LABELS, AMBIGUOUS_ROLL_SLOTS } from '../lib/diceSlots.js';
import { flattenFolderTree } from '../lib/folders.js';
import FrameBar from './FrameBar.jsx';
import Thumb from './Thumb.jsx';

const FRAME_FIELDS = [
  { key: 'startup', label: 'Startup', color: 'text-yellow-500' },
  { key: 'active', label: 'Active', color: 'text-red-500' },
  { key: 'recovery', label: 'Recovery', color: 'text-blue-500' },
];

// hit/block/miss always show; the two defensive-only triggers only render
// when the Defensive checkbox is on (see below).
const BASE_TRIGGERS = ['hit', 'block', 'miss'];
const DEFENSE_TRIGGERS = ['defense_success', 'defense_failure'];

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

// One On Hit/Block/Miss/Defense-outcome box: free text + automation editor.
function TriggerBox({ trigger, label, interactions, setInteractions }) {
  return (
    <div className="rounded-lg border border-zinc-800 p-2">
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-400">{label}</div>
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
  );
}

// Full Move create/edit form. `initial` is a move (with interactions) for
// edit mode; onSubmit receives the socket payload minus moveId.
export default function MoveCreator({
  tells,
  attributes,
  tags,
  folders,
  initialFolderId = null,
  initial,
  onSubmit,
  onCancel,
}) {
  const initInteraction = (trigger) => {
    const row = initial?.interactions?.find((r) => r.trigger === trigger);
    return { text: row?.text ?? '', automations: row?.automations ?? [] };
  };
  const fileRef = useRef(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [isDefault, setIsDefault] = useState(Boolean(initial?.is_default));
  const [isDefensive, setIsDefensive] = useState(Boolean(initial?.is_defensive));
  const [tellId, setTellId] = useState(initial?.tell_id ?? tells[0]?.id ?? null);
  const [rightTellId, setRightTellId] = useState(initial?.right_tell_id ?? tells[0]?.id ?? null);
  const [leftTellId, setLeftTellId] = useState(initial?.left_tell_id ?? tells[0]?.id ?? null);
  const [styleId, setStyleId] = useState(initial?.style_attribute_id ?? null);
  const [folderId, setFolderId] = useState(initial?.folder_id ?? initialFolderId);
  const [rollSlots, setRollSlots] = useState(initial?.roll_slots ?? []);
  const [rollModifier, setRollModifier] = useState(initial?.roll_modifier ?? 0);
  const [tagIds, setTagIds] = useState(initial?.tag_ids ?? []);
  const [image, setImage] = useState(undefined); // undefined = keep existing
  const [frames, setFrames] = useState({
    startup: initial?.startup_tics ?? 1,
    active: initial?.active_tics ?? 1,
    recovery: initial?.recovery_tics ?? 0,
  });
  const [staminaCost, setStaminaCost] = useState(initial?.stamina_cost ?? 0);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [interactions, setInteractions] = useState({
    hit: initInteraction('hit'),
    block: initInteraction('block'),
    miss: initInteraction('miss'),
    defense_success: initInteraction('defense_success'),
    defense_failure: initInteraction('defense_failure'),
  });

  const total = frames.startup + frames.active + frames.recovery;
  const ambiguousRoll = rollSlots.some((s) => AMBIGUOUS_ROLL_SLOTS.has(s));
  // A Default move is usable by anyone, anytime — it never carries a Style
  // gate, so Style stays required only for a Unique move.
  const valid =
    name.trim() &&
    (isDefault || styleId) &&
    total >= 1 &&
    (ambiguousRoll ? rightTellId && leftTellId : tellId);

  const toggleDefault = (checked) => {
    setIsDefault(checked);
    if (checked) setStyleId(null);
  };

  const toggleRollSlot = (slot) =>
    setRollSlots((prev) => (prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot]));

  const toggleTag = (id) =>
    setTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : prev.length < 10 ? [...prev, id] : prev
    );

  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImage(await fileToSmallImage(file).catch(() => undefined));
  };

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      isDefault,
      isDefensive,
      ...(ambiguousRoll ? { rightTellId, leftTellId } : { tellId }),
      styleAttributeId: styleId,
      folderId,
      rollSlots,
      rollModifier,
      tagIds,
      startupTics: frames.startup,
      activeTics: frames.active,
      recoveryTics: frames.recovery,
      staminaCost,
      description: description.trim(),
      interactions,
      ...(image !== undefined ? image : {}),
    });
  };

  const preview = image !== undefined
    ? { image_data: image?.imageData, image_mime_type: image?.imageMimeType }
    : initial;

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
    >
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        {initial ? 'Edit Move' : 'Move Creator'}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload move art"
          className="rounded-lg border border-zinc-700 hover:border-indigo-500"
        >
          <Thumb record={preview} name={name || '?'} size="h-10 w-10" rounded="rounded-lg" />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
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
            onChange={(e) => toggleDefault(e.target.checked)}
          />
          Default (everyone has it)
        </label>
        <label className="flex items-center gap-1.5 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={isDefensive}
            onChange={(e) => setIsDefensive(e.target.checked)}
          />
          Defensive (adds On Successful/Failed Defense)
        </label>
        {ambiguousRoll ? (
          <>
            <select
              value={rightTellId ?? ''}
              onChange={(e) => setRightTellId(Number(e.target.value))}
              title="Tell shown when this move is rolled as the Right appendage"
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-indigo-500"
            >
              {tells.map((t) => (
                <option key={t.id} value={t.id}>
                  Right Tell: {t.name}
                </option>
              ))}
            </select>
            <select
              value={leftTellId ?? ''}
              onChange={(e) => setLeftTellId(Number(e.target.value))}
              title="Tell shown when this move is rolled as the Left appendage"
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-indigo-500"
            >
              {tells.map((t) => (
                <option key={t.id} value={t.id}>
                  Left Tell: {t.name}
                </option>
              ))}
            </select>
          </>
        ) : (
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
        )}
        <select
          value={folderId ?? ''}
          onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-indigo-500"
        >
          <option value="">Discipline: none</option>
          {flattenFolderTree(folders).map(({ folder, depth, path }) => (
            <option key={folder.id} value={folder.id}>
              Discipline: {'—'.repeat(depth)} {path}
            </option>
          ))}
        </select>
      </div>

      {isDefault ? (
        <p className="text-xs text-zinc-500">
          Default moves have no Style — usable by anyone, anytime.
        </p>
      ) : (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
            Style (required — gates who can learn/use this move)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {attributes.map((attr) => {
              const Icon = iconFor(attr.icon);
              const selected = styleId === attr.id;
              return (
                <button
                  key={attr.id}
                  type="button"
                  onClick={() => setStyleId(attr.id)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold ${
                    selected
                      ? 'border-indigo-500 bg-indigo-600/30 text-indigo-200'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  <Icon size={12} />
                  {attr.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
          Roll (optional — which body-part dice this move rolls)
        </p>
        {ambiguousRoll && (
          <p className="mb-1.5 text-xs text-amber-400">
            Includes a Left/Right choice — pick which Tell shows for each side above. The
            player chooses which appendage to roll with when the move is actually used.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {ROLL_SLOT_NAMES.map((slot) => {
            const selected = rollSlots.includes(slot);
            return (
              <button
                key={slot}
                type="button"
                onClick={() => toggleRollSlot(slot)}
                className={`rounded-lg border px-2 py-1 text-xs font-semibold ${
                  selected
                    ? 'border-indigo-500 bg-indigo-600/30 text-indigo-200'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                }`}
              >
                {ROLL_SLOT_LABELS[slot]}
              </button>
            );
          })}
          {rollSlots.length > 0 && (
            <label className="ml-2 flex items-center gap-1.5 text-xs text-zinc-400">
              Bonus
              <input
                type="number"
                min={-20}
                max={20}
                value={rollModifier}
                onChange={(e) =>
                  setRollModifier(Math.max(-20, Math.min(20, Math.trunc(Number(e.target.value) || 0))))
                }
                className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-500"
              />
            </label>
          )}
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
          Tags ({tagIds.length}/10)
        </p>
        {tags.length === 0 ? (
          <p className="text-xs text-zinc-600">No tags exist yet — create them in the Tags section.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const selected = tagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleTag(tag.id)}
                  disabled={!selected && tagIds.length >= 10}
                  title={tag.description || undefined}
                  className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                    selected
                      ? 'border-emerald-500 bg-emerald-900/40 text-emerald-300'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 disabled:opacity-40'
                  }`}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
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
        <label className="text-xs font-semibold uppercase text-emerald-500">
          Stamina Cost (required)
          <input
            type="number"
            min={-20}
            max={20}
            value={staminaCost}
            onChange={(e) => setStaminaCost(Math.trunc(Number(e.target.value) || 0))}
            title="Subtracted from Current Stamina once the declaring side finishes declaring. 0 is a valid free cost; negative restores Stamina instead."
            className="mt-1 block w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {BASE_TRIGGERS.map((trigger) => (
          <TriggerBox
            key={trigger}
            trigger={trigger}
            label={TRIGGER_LABELS[trigger]}
            interactions={interactions}
            setInteractions={setInteractions}
          />
        ))}
      </div>

      {isDefensive && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
            Defensive outcomes
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {DEFENSE_TRIGGERS.map((trigger) => (
              <TriggerBox
                key={trigger}
                trigger={trigger}
                label={TRIGGER_LABELS[trigger]}
                interactions={interactions}
                setInteractions={setInteractions}
              />
            ))}
          </div>
        </div>
      )}

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

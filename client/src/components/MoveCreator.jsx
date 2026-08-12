import { useRef, useState } from 'react';
import {
  AUTOMATION_OPTIONS,
  AUTOMATION_STAT_SLOTS,
  SIGNED_AUTOMATION_TYPES,
  STAT_STEP_AUTOMATION_TYPES,
  TRIGGER_LABELS,
  carriesBlockTag,
} from '../lib/moveDisplay.js';

// Mirrors clampStaminaModifier in server/moveLogic.js, which is the
// authority — this only keeps the field from showing something the server
// will silently change under the GM.
function clampModifierInput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.max(0.1, Math.min(10, n)) * 10) / 10;
}
import { iconFor } from '../lib/styleIcons.js';
import { fileToSmallImage } from '../lib/image.js';
import {
  ROLL_SLOT_NAMES,
  ROLL_SLOT_LABELS,
  ROLL_SLOT_BOTH_LABELS,
  countRollSlot,
  maxRollSlotCount,
  hasAmbiguousRollSlot,
} from '../lib/diceSlots.js';
import { flattenFolderTree } from '../lib/folders.js';
import FrameBar from './FrameBar.jsx';
import Thumb from './Thumb.jsx';
import DiceIcon from './DiceIcon.jsx';

const FRAME_FIELDS = [
  { key: 'startup', label: 'Startup', color: 'text-yellow-500' },
  { key: 'active', label: 'Active', color: 'text-red-500' },
  { key: 'recovery', label: 'Recovery', color: 'text-blue-500' },
];

// Custom Roll type (item 2, decided): a flat base die instead of a Stat —
// for weapons, where the damage die belongs to the item, not the wielder.
const CUSTOM_ROLL_SIZES = [4, 6, 8, 10, 12];

// hit/block/miss always show; the two defensive-only triggers only render
// when the Defensive checkbox is on (see below).
const BASE_TRIGGERS = ['hit', 'block', 'miss'];
const DEFENSE_TRIGGERS = ['defense_success', 'defense_failure'];

function AutomationEditor({ automations, onChange }) {
  const add = () => onChange([...automations, { type: 'self_recovery', amount: 1 }]);
  const update = (i, patch) =>
    onChange(
      automations.map((a, j) => {
        if (j !== i) return a;
        const next = { ...a, ...patch };
        // Switching TO a stat step needs a Stat immediately — otherwise the
        // row looks complete in the form and vanishes on save.
        if (STAT_STEP_AUTOMATION_TYPES.has(next.type) && !next.slot) next.slot = AUTOMATION_STAT_SLOTS[0];
        return next;
      })
    );
  const remove = (i) => onChange(automations.filter((_, j) => j !== i));

  return (
    <div className="space-y-1">
      {automations.map((a, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select
            value={a.type}
            onChange={(e) => update(i, { type: e.target.value })}
            className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
          >
            {AUTOMATION_OPTIONS.map((o) => (
              <option key={o.type} value={o.type}>
                {o.label}
              </option>
            ))}
          </select>
          {/* A stat step has to say WHICH Stat, so the picker only appears
              for those two types — an automation that names no Stat is
              dropped server-side rather than stored as a row that could
              never fire. */}
          {STAT_STEP_AUTOMATION_TYPES.has(a.type) && (
            <select
              value={a.slot ?? AUTOMATION_STAT_SLOTS[0]}
              onChange={(e) => update(i, { slot: e.target.value })}
              className="min-w-0 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
            >
              {AUTOMATION_STAT_SLOTS.map((slot) => (
                <option key={slot} value={slot}>
                  {slot}
                </option>
              ))}
            </select>
          )}
          <input
            type="number"
            min={SIGNED_AUTOMATION_TYPES.has(a.type) ? -20 : 1}
            max={20}
            value={a.amount}
            onChange={(e) => update(i, { amount: Number(e.target.value) })}
            className="w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-600 hover:text-red-400 md:h-auto md:w-auto md:px-1"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-brand-400 hover:text-brand-300"
      >
        + automation
      </button>
    </div>
  );
}

// One On Hit/Block/Miss/Defense-outcome box: free text + automation editor.
function TriggerBox({ trigger, label, interactions, setInteractions }) {
  return (
    <div className="panel-cut border border-zinc-800 p-2">
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
        className="mb-2 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
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
  const [rollType, setRollType] = useState(initial?.roll_type ?? 'stat');
  const [customRollSize, setCustomRollSize] = useState(initial?.custom_roll_size ?? null);
  // Attack Target (Change 001): no default selection for a brand-new move —
  // an empty array is a valid, explicit "no target" rather than unset data.
  const [attackTargets, setAttackTargets] = useState(initial?.attack_targets ?? []);
  const [tagIds, setTagIds] = useState(initial?.tag_ids ?? []);
  const [image, setImage] = useState(undefined); // undefined = keep existing
  const [frames, setFrames] = useState({
    startup: initial?.startup_tics ?? 1,
    active: initial?.active_tics ?? 1,
    recovery: initial?.recovery_tics ?? 0,
  });
  // 0-based indices into the Startup+Active+Recovery sequence (see
  // FrameBar.jsx) — an annotation on top of those squares, not a 4th phase,
  // so it never affects the frame totals above or combat timing.
  const [defensePositions, setDefensePositions] = useState(
    new Set(initial?.defense_frame_positions ?? [])
  );
  // Combat Automation overhaul: which of the two defensive mechanics this
  // move's Defense Frames represent. Block resolves fully automatically;
  // Dodge is the one remaining human-in-the-loop call (the GM's Successful/
  // Failed prompt) — see vttprojectplan.md. Only meaningful once at least
  // one Defense Frame is actually placed (enforced below at submit time).
  const [defenseKind, setDefenseKind] = useState(initial?.defense_kind ?? 'block');
  const [staminaCost, setStaminaCost] = useState(initial?.stamina_cost ?? 0);
  // Kept as a string while editing so a half-typed "0." isn't snapped away
  // mid-keystroke; clamped on blur and again server-side.
  const [staminaModifier, setStaminaModifier] = useState(String(initial?.stamina_modifier ?? 1));
  // Block Tag (the first Tag automation — see client/src/lib/moveDisplay.js).
  // Driven by the live tag selection, not by the saved move, so tagging a
  // move Block swaps the Stamina field over immediately rather than after a
  // save.
  const isBlockTagged = carriesBlockTag(tagIds, tags);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [interactions, setInteractions] = useState({
    hit: initInteraction('hit'),
    block: initInteraction('block'),
    miss: initInteraction('miss'),
    defense_success: initInteraction('defense_success'),
    defense_failure: initInteraction('defense_failure'),
  });

  const total = frames.startup + frames.active + frames.recovery;
  // Shrinking a frame count can leave a stale Defense tag pointing past the
  // new total — filtered here rather than pruned from state, so re-growing
  // the count (undoing the shrink) doesn't lose the tag.
  // Defense Frames may only sit on ACTIVE frames (decided, new — the server
  // drops anything else, so the picker must not offer it). A guard is
  // something the move is actively doing; a green square on a Startup
  // sequence position lands a Tic before an attack's Active window even
  // opens, which is exactly why "I blocked on the same Tic and nothing
  // happened" kept coming up. Filtered rather than pruned from state, same
  // as the `< total` rule above, so re-growing Active restores the tag.
  const isActiveFrame = (p) => p >= frames.startup && p < frames.startup + frames.active;
  const visibleDefensePositions = [...defensePositions].filter((p) => p < total && isActiveFrame(p));
  const toggleDefensePosition = (index) => {
    if (!isActiveFrame(index)) return;
    setDefensePositions((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  // Only a singly-picked appendage still poses a Left/Right question — see
  // hasAmbiguousRollSlot. Picking it twice means both sides, which is an
  // answer, so such a move needs one Tell like any other.
  const ambiguousRoll = hasAmbiguousRollSlot(rollSlots);
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

  // Cycles how many of this slot the Roll takes. A concrete Stat is
  // one-of-a-kind so this stays a plain on/off toggle; an appendage cycles
  // 0 -> one (player picks a side at declare time) -> both -> 0, because a
  // character has exactly two of each (see maxRollSlotCount).
  const toggleRollSlot = (slot) =>
    setRollSlots((prev) => {
      const next = (countRollSlot(prev, slot) + 1) % (maxRollSlotCount(slot) + 1);
      const without = prev.filter((s) => s !== slot);
      return [...without, ...Array(next).fill(slot)];
    });

  const toggleAttackTarget = (slot) =>
    setAttackTargets((prev) => (prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot]));

  // Mutually exclusive (decided): switching Roll type clears the other
  // type's own picks, same as toggleDefault clearing Style above — a stat
  // slot and a custom base die never coexist on the same move.
  const switchRollType = (type) => {
    setRollType(type);
    if (type === 'custom') setRollSlots([]);
    else setCustomRollSize(null);
  };

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
      defenseKind: isDefensive && visibleDefensePositions.length > 0 ? defenseKind : null,
      ...(ambiguousRoll ? { rightTellId, leftTellId } : { tellId }),
      styleAttributeId: styleId,
      folderId,
      rollSlots,
      rollModifier,
      rollType,
      customRollSize,
      attackTargets,
      tagIds,
      staminaModifier: clampModifierInput(staminaModifier),
      startupTics: frames.startup,
      activeTics: frames.active,
      recoveryTics: frames.recovery,
      defenseFramePositions: visibleDefensePositions,
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
      className="space-y-3 panel-cut-lg border border-zinc-700 bg-zinc-900 p-4"
    >
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        {initial ? 'Edit Move' : 'Move Creator'}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload move art"
          className="panel-cut border border-zinc-700 hover:border-brand-500"
        >
          <Thumb record={preview} name={name || '?'} size="h-10 w-10" cut="panel-cut" />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Move name"
          className="min-w-40 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-brand-500"
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
              className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-brand-500"
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
              className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-brand-500"
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
            className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-brand-500"
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
          className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300 outline-none focus:border-brand-500"
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
                  className={`inline-flex items-center gap-1 panel-cut border px-2 py-1 text-xs font-semibold ${
                    selected
                      ? 'border-brand-500 bg-brand-600/30 text-brand-200'
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
        <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">Roll (optional)</p>
        <div className="mb-1.5 flex gap-1.5">
          <button
            type="button"
            onClick={() => switchRollType('stat')}
            className={`panel-cut-sm border px-2 py-1 text-xs font-semibold ${
              rollType === 'stat'
                ? 'border-brand-500 bg-brand-600/30 text-brand-200'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            Stat
          </button>
          <button
            type="button"
            onClick={() => switchRollType('custom')}
            title="A fixed base die, not tied to any character Stat — for weapons"
            className={`panel-cut-sm border px-2 py-1 text-xs font-semibold ${
              rollType === 'custom'
                ? 'border-brand-500 bg-brand-600/30 text-brand-200'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            Custom
          </button>
        </div>
        {rollType === 'stat' ? (
          <>
            <p className="mb-1 text-xs text-zinc-500">
              Which body-part dice this move rolls. Click Hand or Leg twice to use both of them
              at once — a Straight Block guards with both hands.
            </p>
            {ambiguousRoll && (
              <p className="mb-1.5 text-xs text-amber-400">
                Includes a Left/Right choice — pick which Tell shows for each side above. The
                player chooses which appendage to roll with when the move is actually used. Click
                that slot once more to use both sides instead, and the choice goes away.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {ROLL_SLOT_NAMES.map((slot) => {
                const count = countRollSlot(rollSlots, slot);
                const both = count > 1;
                return (
                  <button
                    key={slot}
                    type="button"
                    title={
                      maxRollSlotCount(slot) > 1
                        ? `Click to cycle: off -> one (side picked when declared) -> both`
                        : undefined
                    }
                    onClick={() => toggleRollSlot(slot)}
                    className={`panel-cut border px-2 py-1 text-xs font-semibold ${
                      count > 0
                        ? 'border-brand-500 bg-brand-600/30 text-brand-200'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                    }`}
                  >
                    {both ? ROLL_SLOT_BOTH_LABELS[slot] : ROLL_SLOT_LABELS[slot]}
                    {both && <span className="ml-1 text-brand-300">x2</span>}
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
                    className="w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-brand-500"
                  />
                </label>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="mb-1 text-xs text-zinc-500">Base die for this move's Roll (e.g. a weapon's damage die)</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {CUSTOM_ROLL_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setCustomRollSize(customRollSize === size ? null : size)}
                  title={`d${size}`}
                  className={`panel-cut border px-2 py-1.5 ${
                    customRollSize === size
                      ? 'border-brand-500 bg-brand-600/30 text-brand-200'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  <DiceIcon size={size} className="h-5 w-5" />
                </button>
              ))}
              {customRollSize != null && (
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
                    className="w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-brand-500"
                  />
                </label>
              )}
            </div>
          </>
        )}
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
          Attack Target ({attackTargets.length} selected — none is valid)
        </p>
        <p className="mb-1.5 text-xs text-zinc-500">
          Which Stats this move's damage may be applied to. Only meaningful when this move has a
          Roll — a move with no Roll isn't an Attack regardless of this selection.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {ROLL_SLOT_NAMES.map((slot) => {
            const selected = attackTargets.includes(slot);
            return (
              <button
                key={slot}
                type="button"
                onClick={() => toggleAttackTarget(slot)}
                className={`panel-cut border px-2 py-1 text-xs font-semibold ${
                  selected
                    ? 'border-brand-500 bg-brand-600/30 text-brand-200'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                }`}
              >
                {ROLL_SLOT_LABELS[slot]}
              </button>
            );
          })}
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
              className="mt-1 block w-20 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
            />
          </label>
        ))}
        <div className="pb-1">
          <p className="mb-1 text-xs font-semibold uppercase text-green-500">
            Click an <span className="text-rose-400">Active</span> square for Defense
          </p>
          <FrameBar
            startup={frames.startup}
            active={frames.active}
            recovery={frames.recovery}
            defensePositions={visibleDefensePositions}
            onToggle={toggleDefensePosition}
            canToggle={isActiveFrame}
          />
          {total < 1 && <p className="text-xs text-red-400">At least 1 square total</p>}
          {/* Shown for every Defensive move, not just once a Defense Frame
              already exists — it previously appeared only after the first
              green square was set, and unlabelled, which made it read as
              "you can't choose". It stays disabled (with the reason) until
              there's a frame for it to apply to, since defense_kind is
              meaningless without one. */}
          {isDefensive && (
            <div className="mt-2">
              <span className="mb-1 block text-xs font-semibold uppercase text-emerald-500">
                Defense type
              </span>
              <div className="flex gap-1.5">
                {['block', 'dodge'].map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={visibleDefensePositions.length === 0}
                    onClick={() => setDefenseKind(kind)}
                    title={
                      kind === 'block'
                        ? 'Resolves fully automatically from dice math — never prompts anyone'
                        : 'The one defense a human still calls: the GM is asked Successful/Failed when it fully covers an attack'
                    }
                    className={`panel-cut-sm border px-2 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40 ${
                      defenseKind === kind
                        ? 'border-green-500 bg-green-900/40 text-green-300'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
                    }`}
                  >
                    {kind}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {visibleDefensePositions.length === 0
                  ? 'Click a frame square above to mark it a Defense Frame — a Defensive move needs at least one before Block or Dodge means anything.'
                  : defenseKind === 'block'
                    ? 'Block resolves automatically from the dice. If it covers only part of the attack, this move’s Recovery is extended to cover the rest.'
                    : 'Dodge auto-fails unless its Defense Frames cover the attack’s whole Active window; when they do, the GM is asked whether it landed.'}
              </p>
            </div>
          )}
        </div>
        {/* Block Tag (the first Tag automation): a Block has no up-front
            Stamina Cost, so the field is replaced rather than disabled — an
            input you can fill in that the server then forces to 0 is worse
            than one that isn't there. Tag the move Block above and this swaps
            over; untag it and the Cost comes back. */}
        {isBlockTagged ? (
          <label className="text-xs font-semibold uppercase text-sky-400">
            Stamina Modifier
            <input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={staminaModifier}
              onChange={(e) => setStaminaModifier(e.target.value)}
              onBlur={(e) => setStaminaModifier(clampModifierInput(e.target.value))}
              title="A Block spends Stamina at resolution for as much of the attack as it absorbed, times this. Above 1 is a costly guard, below 1 a cheap one. Never 0 or negative."
              className="mt-1 block w-20 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
            />
            <span className="mt-1 block max-w-48 text-[10px] font-normal normal-case text-zinc-500">
              Tagged <b>Block</b>: no up-front cost. It spends what it absorbs
              (never more than the attack was worth) × this.
            </span>
          </label>
        ) : (
          <label className="text-xs font-semibold uppercase text-emerald-500">
            Stamina Cost (required)
            <input
              type="number"
              min={-20}
              max={20}
              value={staminaCost}
              onChange={(e) => setStaminaCost(Math.trunc(Number(e.target.value) || 0))}
              title="Subtracted from Current Stamina once the declaring side finishes declaring. 0 is a valid free cost; negative restores Stamina instead."
              className="mt-1 block w-20 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
            />
          </label>
        )}
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
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
          className="flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          {initial ? 'Save Move' : 'Create Move'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="panel-cut-sm border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

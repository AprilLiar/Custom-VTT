import { useEffect, useMemo, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getCharacters, getCombatSetup, getTempNpcs } from '../lib/api.js';
import { fileToPortrait } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import { BASIC_TOKENS, SPECIAL_TOKENS, STATUS_TOKENS, UNIQUE_TOKENS } from '../lib/panicTokens.js';
import { ICON_CREDIT, KIND_CLASS, TokenIcon } from '../lib/panicIcons.jsx';
import CroppedImage from './CroppedImage.jsx';
import DiceIcon from './DiceIcon.jsx';
import {
  FIXED_MAX,
  FIXED_MIN,
  STANCE_DIE_SIZES,
  STANCE_NAME_MAX,
  STANCE_SLOTS_MAX,
  STANCE_SLOTS_MIN,
  describeDice,
} from '../lib/stanceDice.js';

// A fighter's Combat tab (Panic at the Dojo — see vttprojectplan.md, "Game
// system — Panic at the Dojo combat assistant"): the round combat token, which
// Unique tokens this fighter uses, and their Reminders.
//
// Owner-parameterised like ScenePicturesEditor, so the same component is a
// Character sheet tab and a section of the Temp NPC editor. `canEdit` only
// decides whether controls render; the server checks for itself.

const COLUMNS = [
  { scope: 'self', title: 'Your turn', blurb: 'At the start or end of this fighter’s own turn.' },
  { scope: 'others', title: 'Others’ turns', blurb: 'At the start or end of someone else’s turn.' },
  { scope: 'round', title: 'Round', blurb: 'At the start or end of every round.' },
];

const TARGET_LABEL = { any: 'Anyone', allies: 'Allies', enemies: 'Enemies', one: 'One fighter' };

// The End Phase steps the app reminds everyone about by itself (book p.68).
const AUTOMATIC = [
  'Burning — end of a turn: take that much damage (Iron can’t reduce it), then discard half, rounded up.',
  'Speed — end of every turn: everyone holding Speed discards 3.',
  'Fatigue — end of a turn: if you didn’t leave your starting space, you may discard up to 3.',
  'Challenge — end of a turn: if you tried to damage your Challenger, discard their Challenge.',
];

const fighterKey = (type, id) => `${type}:${id}`;

export default function CombatTab({ ownerType, ownerId, canEdit = false, ownerName = '' }) {
  const [profile, setProfile] = useState(null);
  const [reminders, setReminders] = useState(null);
  const [stances, setStances] = useState(null);
  const [fighters, setFighters] = useState([]); // [{ key, type, id, name }]

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setReminders(null);
    setStances(null);
    getCombatSetup(ownerType, ownerId)
      .then(({ profile: p, reminders: r, stances: st }) => {
        if (cancelled) return;
        setProfile(p);
        setReminders(r);
        setStances(st ?? []);
      })
      .catch(console.error);
    // Who a reminder can name: every character and every Temp NPC.
    Promise.all([getCharacters(), getTempNpcs()])
      .then(([characters, npcs]) => {
        if (cancelled) return;
        setFighters([
          ...characters.map((c) => ({ key: fighterKey('character', c.id), type: 'character', id: c.id, name: c.name })),
          ...npcs.map((n) => ({ key: fighterKey('temp_npc', n.id), type: 'temp_npc', id: n.id, name: `${n.name} (Temp NPC)` })),
        ]);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [ownerType, ownerId]);

  useEffect(() => {
    const mine = (p) => p.ownerType === ownerType && p.ownerId === ownerId;
    const onProfile = (p) => mine(p) && setProfile(p.profile);
    const onReminders = (p) => mine(p) && setReminders(p.reminders);
    const onStances = (p) => mine(p) && setStances(p.stances);
    socket.on('combat_profile:updated', onProfile);
    socket.on('combat_reminders:updated', onReminders);
    socket.on('combat_stances:updated', onStances);
    return () => {
      socket.off('combat_profile:updated', onProfile);
      socket.off('combat_reminders:updated', onReminders);
      socket.off('combat_stances:updated', onStances);
    };
  }, [ownerType, ownerId]);

  const fighterName = useMemo(() => Object.fromEntries(fighters.map((f) => [f.key, f.name])), [fighters]);
  const otherFighters = useMemo(
    () => fighters.filter((f) => f.key !== fighterKey(ownerType, ownerId)),
    [fighters, ownerType, ownerId]
  );

  if (!profile || !reminders || !stances) return <p className="text-sm text-zinc-500">Loading…</p>;

  const toggleUnique = (key) => {
    const set = new Set(profile.unique_tokens);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    socket.emit('combat_profile:update', { ownerType, ownerId, uniqueTokens: [...set] });
  };

  return (
    <div className="space-y-6">
      <TokenPicture ownerType={ownerType} ownerId={ownerId} profile={profile} canEdit={canEdit} name={ownerName} />

      <section>
        <h3 className="mb-1 font-display text-sm font-bold uppercase tracking-wide text-zinc-300">Tokens</h3>
        <p className="mb-2 text-xs text-zinc-500">
          Every fighter always has the Basic and Status tokens, the Challenge, Armor and Shield. Check the Unique tokens this fighter uses — they join
          the token row in combat.
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {[...BASIC_TOKENS, ...STATUS_TOKENS].map((t) => (
            <span
              key={t.key}
              title={t.summary}
              className="inline-flex items-center gap-1 panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
            >
              <TokenIcon tokenKey={t.key} className={`h-4 w-4 ${KIND_CLASS[t.kind]}`} />
              {t.name}
            </span>
          ))}
          <span
            title="Held by one fighter, naming another. It has its own slot on the token panel."
            className="inline-flex items-center gap-1 panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
          >
            <TokenIcon tokenKey="challenge" className={`h-4 w-4 ${KIND_CLASS.status}`} />
            Challenge
          </span>
          {SPECIAL_TOKENS.map((t) => (
            <span
              key={t.key}
              title={t.summary}
              className="inline-flex items-center gap-1 panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
            >
              <TokenIcon tokenKey={t.key} className={`h-4 w-4 ${KIND_CLASS[t.kind]}`} />
              {t.name}
            </span>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {UNIQUE_TOKENS.map((t) => {
            const checked = profile.unique_tokens.includes(t.key);
            return (
              <label
                key={t.key}
                className={`flex min-h-11 cursor-pointer items-start gap-2 panel-cut-sm border px-2 py-2 ${
                  checked ? 'border-brand-600 bg-brand-950/40' : 'border-zinc-800 bg-zinc-900'
                } ${canEdit ? '' : 'cursor-default'}`}
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-brand-500"
                  checked={checked}
                  disabled={!canEdit}
                  onChange={() => toggleUnique(t.key)}
                />
                <TokenIcon tokenKey={t.key} className={`mt-0.5 h-5 w-5 shrink-0 ${KIND_CLASS[t.kind]}`} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-zinc-100">
                    {t.name}
                    {t.kind === 'super' && <span className="ml-1 text-[10px] uppercase text-amber-400">Super</span>}
                  </span>
                  <span className="block text-[11px] text-zinc-500">{t.source}</span>
                  <span className="block text-xs text-zinc-400">{t.summary}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <StancesSection ownerType={ownerType} ownerId={ownerId} stances={stances} canEdit={canEdit} />

      <section>
        <h3 className="mb-1 font-display text-sm font-bold uppercase tracking-wide text-zinc-300">Reminders</h3>
        <p className="mb-3 text-xs text-zinc-500">
          Posted to the chat during a fight, with this fighter’s name and portrait.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <ReminderColumn
              key={col.scope}
              column={col}
              reminders={reminders.filter((r) => r.scope === col.scope)}
              ownerType={ownerType}
              ownerId={ownerId}
              canEdit={canEdit}
              fighters={otherFighters}
              fighterName={fighterName}
              stances={stances}
            />
          ))}
        </div>
        <details className="mt-3 text-xs text-zinc-500">
          <summary className="cursor-pointer select-none">Automatic reminders (everyone, always)</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {AUTOMATIC.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      </section>

      <p className="text-[10px] text-zinc-600">{ICON_CREDIT}</p>
    </div>
  );
}

function TokenPicture({ ownerType, ownerId, profile, canEdit, name }) {
  const fileRef = useRef(null);
  const { pick, dialog, busy } = usePictureUpload({
    process: fileToPortrait,
    name,
    previewSizes: [
      { label: 'On the map', px: 48 },
      { label: 'In the turn order', px: 64 },
      { label: 'On the token panel', px: 96 },
    ],
    onPicked: (fields) => socket.emit('combat_profile:update', { ownerType, ownerId, ...fields }),
  });
  return (
    <section className="flex items-center gap-4">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => fileRef.current?.click()}
        title={canEdit ? 'Choose the combat token picture' : undefined}
        className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-zinc-600 bg-zinc-800 shadow-[0_0_0_3px_rgba(0,0,0,0.6)] enabled:hover:border-brand-500"
      >
        {busy ? (
          <span className="text-xs text-zinc-500">…</span>
        ) : profile.image_url ? (
          <CroppedImage src={profile.image_url} crop={cropOf(profile)} alt={name} className="h-full w-full rounded-full" />
        ) : (
          <span className="px-2 text-center text-xs text-zinc-500">{canEdit ? 'Add token' : 'No token'}</span>
        )}
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
      {dialog}
      <div>
        <h3 className="font-display text-sm font-bold uppercase tracking-wide text-zinc-300">Combat token</h3>
        <p className="text-xs text-zinc-500">
          The round token placed on the Combat map. The crop chooses what shows inside the circle.
        </p>
        {canEdit && profile.image_url && (
          <button
            type="button"
            onClick={() => socket.emit('combat_profile:update', { ownerType, ownerId, clearImage: true })}
            className="mt-1 text-xs font-semibold text-red-500 hover:text-red-400"
          >
            Remove token picture
          </button>
        )}
      </div>
    </section>
  );
}

function ReminderColumn({ column, reminders, ownerType, ownerId, canEdit, fighters, fighterName, stances }) {
  const isOthers = column.scope === 'others';
  return (
    <div className="flex flex-col panel-cut border border-zinc-800 bg-zinc-900/60 p-2">
      <h4 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-200">{column.title}</h4>
      <p className="mb-2 text-[11px] text-zinc-500">{column.blurb}</p>
      <ul className="mb-2 space-y-1.5">
        {reminders.length === 0 && <li className="text-xs italic text-zinc-600">None yet.</li>}
        {reminders.map((r) => (
          <ReminderRow
            key={r.id}
            reminder={r}
            canEdit={canEdit}
            isOthers={isOthers}
            fighters={fighters}
            fighterName={fighterName}
            stances={stances}
          />
        ))}
      </ul>
      {canEdit && (
        <ReminderForm
          isOthers={isOthers}
          fighters={fighters}
          stances={stances}
          submitLabel="Add"
          onSubmit={(fields) =>
            socket.emit('combat_reminder:create', { ownerType, ownerId, scope: column.scope, ...fields })
          }
        />
      )}
    </div>
  );
}

function targetText(reminder, fighterName) {
  if (reminder.target !== 'one') return TARGET_LABEL[reminder.target] ?? 'Anyone';
  return fighterName[fighterKey(reminder.target_type, reminder.target_id)] ?? 'Someone';
}

function ReminderRow({ reminder, canEdit, isOthers, fighters, fighterName, stances }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li>
        <ReminderForm
          isOthers={isOthers}
          fighters={fighters}
          stances={stances}
          initial={reminder}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(fields) => {
            socket.emit('combat_reminder:update', { reminderId: reminder.id, ...fields });
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="group panel-cut-sm border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
      <div className="mb-0.5 flex flex-wrap items-center gap-1">
        <span
          className={`panel-cut-sm px-1.5 text-[10px] font-bold uppercase ${
            reminder.timing === 'start' ? 'bg-emerald-700/40 text-emerald-300' : 'bg-sky-700/40 text-sky-300'
          }`}
        >
          {reminder.timing === 'start' ? 'Start' : 'End'}
        </span>
        {isOthers && (
          <span className="panel-cut-sm bg-zinc-800 px-1.5 text-[10px] font-bold uppercase text-zinc-300">
            {targetText(reminder, fighterName)}
          </span>
        )}
        {reminder.stance_id != null && (
          <span className="panel-cut-sm bg-violet-700/40 px-1.5 text-[10px] font-bold uppercase text-violet-200">
            {stances.find((s) => s.id === reminder.stance_id)?.name ?? 'Stance'}
          </span>
        )}
        {canEdit && (
          <span className="ml-auto flex gap-2 text-[11px]">
            <button type="button" onClick={() => setEditing(true)} className="text-zinc-400 hover:text-zinc-100">
              Edit
            </button>
            <button
              type="button"
              onClick={() => socket.emit('combat_reminder:delete', { reminderId: reminder.id })}
              className="text-red-500 hover:text-red-400"
            >
              Delete
            </button>
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-zinc-200">{reminder.text}</p>
    </li>
  );
}

function ReminderForm({ isOthers, fighters, stances = [], initial, submitLabel, onSubmit, onCancel }) {
  const [timing, setTiming] = useState(initial?.timing ?? 'start');
  const [target, setTarget] = useState(initial?.target ?? 'any');
  const [one, setOne] = useState(
    initial?.target === 'one' && initial.target_id != null ? fighterKey(initial.target_type, initial.target_id) : ''
  );
  const [text, setText] = useState(initial?.text ?? '');
  const [stanceId, setStanceId] = useState(initial?.stance_id != null ? String(initial.stance_id) : '');

  const submit = (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    // Bound to a Stance: fires only while that Stance is active. '' = any.
    const fields = { timing, text: body, stanceId: stanceId ? Number(stanceId) : null };
    if (isOthers) {
      fields.target = target;
      if (target === 'one') {
        const f = fighters.find((x) => x.key === one);
        if (!f) return;
        fields.targetType = f.type;
        fields.targetId = f.id;
      }
    }
    onSubmit(fields);
    if (!initial) setText('');
  };

  const selectClass =
    'min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1.5 text-xs outline-none focus:border-brand-500';
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <select value={timing} onChange={(e) => setTiming(e.target.value)} className={selectClass} aria-label="When">
          <option value="start">Start</option>
          <option value="end">End</option>
        </select>
        {isOthers && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={selectClass} aria-label="Whose turn">
            {Object.entries(TARGET_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
        {stances.length > 0 && (
          <select
            value={stanceId}
            onChange={(e) => setStanceId(e.target.value)}
            className={selectClass}
            aria-label="Only in stance"
            title="Fire only while this stance is active"
          >
            <option value="">Any stance</option>
            {stances.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {isOthers && target === 'one' && (
          <select
            value={one}
            onChange={(e) => setOne(e.target.value)}
            className={`${selectClass} min-w-0 flex-1`}
            aria-label="Which fighter"
          >
            <option value="">Choose…</option>
            {fighters.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="Reminder text"
        className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-brand-500"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!text.trim() || (isOthers && target === 'one' && !one)}
          className="min-h-9 panel-cut-sm bg-brand-600 px-3 text-xs font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="min-h-9 px-2 text-xs text-zinc-400 hover:text-zinc-100">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- Stances
//
// A fighter's named dice pools (decided after scoping): 1 to 8 slots, each a
// d4-d12 or a fixed number 0-12 in a die's place. The first stance is the
// default active one; which one is active in a fight belongs to each placed
// copy, so it is not shown or chosen here.
function StancesSection({ ownerType, ownerId, stances, canEdit }) {
  const [adding, setAdding] = useState(false);
  return (
    <section>
      <h3 className="mb-1 font-display text-sm font-bold uppercase tracking-wide text-zinc-300">Stances</h3>
      <p className="mb-2 text-xs text-zinc-500">
        Each stance is a name and its Action Dice. At the start of this fighter’s turn the active stance’s dice roll into
        chat — with several stances, you are asked which one first.
      </p>
      <ul className="mb-2 space-y-1.5">
        {stances.length === 0 && <li className="text-xs italic text-zinc-600">No stances yet.</li>}
        {stances.map((st, i) => (
          <StanceRow key={st.id} stance={st} isDefault={i === 0} canEdit={canEdit} />
        ))}
      </ul>
      {canEdit &&
        (adding ? (
          <StanceForm
            submitLabel="Add stance"
            onCancel={() => setAdding(false)}
            onSubmit={(fields) => {
              socket.emit('combat_stance:create', { ownerType, ownerId, ...fields });
              setAdding(false);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 text-xs font-semibold text-zinc-200 hover:border-brand-500"
          >
            + Add stance
          </button>
        ))}
    </section>
  );
}

function DiceChips({ dice }) {
  return (
    <span className="flex flex-wrap items-center gap-1" title={describeDice(dice)}>
      {dice.map((slot, i) =>
        slot.die !== undefined ? (
          <DiceIcon key={i} size={slot.die} className="h-6 w-6 text-zinc-200" />
        ) : (
          <span
            key={i}
            className="flex h-6 w-6 items-center justify-center rounded-sm border border-amber-500/70 text-[11px] font-bold text-amber-300"
          >
            {slot.fixed}
          </span>
        )
      )}
    </span>
  );
}

function StanceRow({ stance, isDefault, canEdit }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li>
        <StanceForm
          initial={stance}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(fields) => {
            socket.emit('combat_stance:update', { stanceId: stance.id, ...fields });
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1.5">
      <span className="font-display text-sm font-semibold uppercase tracking-wide text-zinc-100">{stance.name}</span>
      {isDefault && <span className="text-[10px] uppercase text-zinc-500">default</span>}
      <DiceChips dice={stance.dice} />
      {canEdit && (
        <span className="ml-auto flex gap-2 text-[11px]">
          <button type="button" onClick={() => setEditing(true)} className="text-zinc-400 hover:text-zinc-100">
            Edit
          </button>
          <button
            type="button"
            onClick={() =>
              window.confirm(`Delete the stance "${stance.name}"? Reminders bound to it will fire in any stance.`) &&
              socket.emit('combat_stance:delete', { stanceId: stance.id })
            }
            className="text-red-500 hover:text-red-400"
          >
            Delete
          </button>
        </span>
      )}
    </li>
  );
}

// One slot's editor value: 'd4'..'d12' or 'fixed'.
const slotKind = (slot) => (slot.die !== undefined ? `d${slot.die}` : 'fixed');

function StanceForm({ initial, submitLabel, onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [dice, setDice] = useState(initial?.dice ?? [{ die: 6 }, { die: 6 }]);
  const setSlot = (i, slot) => setDice((d) => d.map((s, j) => (j === i ? slot : s)));
  const valid = name.trim() && dice.length >= STANCE_SLOTS_MIN && dice.length <= STANCE_SLOTS_MAX;
  const selectClass =
    'min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1.5 text-xs outline-none focus:border-brand-500';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit({ name: name.trim(), dice });
      }}
      className="space-y-2 panel-cut-sm border border-zinc-700 bg-zinc-900 p-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={STANCE_NAME_MAX}
        placeholder="Stance name"
        className="min-h-9 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 text-sm outline-none focus:border-brand-500"
      />
      <div className="flex flex-wrap gap-1.5">
        {dice.map((slot, i) => (
          <div key={i} className="flex items-center gap-1 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-1">
            <select
              value={slotKind(slot)}
              aria-label={`Die ${i + 1}`}
              onChange={(e) =>
                setSlot(i, e.target.value === 'fixed' ? { fixed: 5 } : { die: Number(e.target.value.slice(1)) })
              }
              className={selectClass}
            >
              {STANCE_DIE_SIZES.map((d) => (
                <option key={d} value={`d${d}`}>
                  d{d}
                </option>
              ))}
              <option value="fixed">Fixed</option>
            </select>
            {slot.fixed !== undefined && (
              <input
                type="number"
                min={FIXED_MIN}
                max={FIXED_MAX}
                value={slot.fixed}
                aria-label={`Fixed number ${i + 1}`}
                onChange={(e) => {
                  const n = Math.max(FIXED_MIN, Math.min(FIXED_MAX, Math.trunc(Number(e.target.value) || 0)));
                  setSlot(i, { fixed: n });
                }}
                className="min-h-9 w-14 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1.5 text-xs outline-none focus:border-brand-500"
              />
            )}
            {dice.length > STANCE_SLOTS_MIN && (
              <button
                type="button"
                onClick={() => setDice((d) => d.filter((_, j) => j !== i))}
                title="Remove this die"
                className="px-1 text-xs text-zinc-500 hover:text-red-400"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {dice.length < STANCE_SLOTS_MAX && (
          <button
            type="button"
            onClick={() => setDice((d) => [...d, { die: 6 }])}
            className="min-h-9 panel-cut-sm border border-dashed border-zinc-600 px-2 text-xs text-zinc-300 hover:border-brand-500"
          >
            + Die
          </button>
        )}
      </div>
      <p className="text-[11px] text-zinc-500">
        {dice.length} of {STANCE_SLOTS_MAX} — {describeDice(dice)}
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid}
          className="min-h-9 panel-cut-sm bg-brand-600 px-3 text-xs font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="min-h-9 px-2 text-xs text-zinc-400 hover:text-zinc-100">
          Cancel
        </button>
      </div>
    </form>
  );
}

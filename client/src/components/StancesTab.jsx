import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getRuleset } from '../lib/api.js';
import { iconFor } from '../lib/styleIcons.js';
import { rankMatchups } from '../lib/matchups.js';
import StanceGraph from './StanceGraph.jsx';

// The ruleset is fixed seed data — fetch it once per page load.
let rulesetPromise = null;
const loadRuleset = () => (rulesetPromise ??= getRuleset());

function StyleChip({ attr, className = '' }) {
  const Icon = iconFor(attr.icon);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-zinc-300 ${className}`}
    >
      <Icon size={12} />
      {attr.name}
    </span>
  );
}

function StanceForm({ attributes, initial, onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [picked, setPicked] = useState(
    initial ? [initial.attribute_a_id, initial.attribute_b_id] : []
  );

  const toggle = (id) => {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : prev.length < 2 ? [...prev, id] : prev
    );
  };

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim() || picked.length !== 2) return;
    onSubmit(name.trim(), picked[0], picked[1]);
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
    >
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        {initial ? 'Edit Stance' : 'Stance Creator'}
      </h3>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Stance name"
        className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
      />
      <div className="flex flex-wrap gap-2">
        {attributes.map((attr) => {
          const selected = picked.includes(attr.id);
          const Icon = iconFor(attr.icon);
          return (
            <button
              key={attr.id}
              type="button"
              onClick={() => toggle(attr.id)}
              disabled={!selected && picked.length >= 2}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                selected
                  ? 'border-indigo-500 bg-indigo-600/30 text-indigo-200'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 disabled:opacity-40'
              }`}
            >
              <Icon size={14} />
              {attr.name}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-zinc-600">Pick exactly 2 styles ({picked.length}/2 selected)</p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!name.trim() || picked.length !== 2}
          className="flex-1 rounded-md bg-indigo-600 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          {initial ? 'Save' : 'Create'}
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

function MatchupList({ title, entries, attrById, tone }) {
  return (
    <div>
      <h4 className={`mb-1 text-xs font-bold uppercase tracking-wide ${tone}`}>{title}</h4>
      <ul className="space-y-1">
        {entries.map(({ pair, score }) => (
          <li key={pair.join('-')} className="flex items-center gap-1.5">
            <StyleChip attr={attrById.get(pair[0])} />
            <StyleChip attr={attrById.get(pair[1])} />
            <span
              className={`ml-auto font-mono text-sm font-bold ${
                score > 0 ? 'text-green-400' : score < 0 ? 'text-red-400' : 'text-zinc-500'
              }`}
            >
              {score > 0 ? `+${score}` : score}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StancesTab({ data }) {
  const { character, stances } = data;
  const [ruleset, setRuleset] = useState(null);
  const [form, setForm] = useState(null); // null | { mode: 'create' } | { mode: 'edit', stance }

  useEffect(() => {
    loadRuleset().then(setRuleset).catch(console.error);
  }, []);

  if (!ruleset) return <p className="text-zinc-500">Loading ruleset…</p>;

  const { attributes, counters } = ruleset;
  const attrById = new Map(attributes.map((a) => [a.id, a]));
  const activeStance = stances.find((s) => s.id === character.active_stance_id) ?? null;
  const activePair = activeStance
    ? [activeStance.attribute_a_id, activeStance.attribute_b_id]
    : null;

  const ranked = activePair ? rankMatchups(activePair, attributes, counters) : null;

  const submitForm = (name, attributeAId, attributeBId) => {
    if (form.mode === 'edit') {
      socket.emit('stance:update', {
        stanceId: form.stance.id,
        name,
        attributeAId,
        attributeBId,
      });
    } else {
      socket.emit('stance:create', {
        characterId: character.id,
        name,
        attributeAId,
        attributeBId,
      });
    }
    setForm(null);
  };

  const remove = (stance) => {
    if (window.confirm(`Delete stance ${stance.name}?`)) {
      socket.emit('stance:delete', { stanceId: stance.id });
    }
  };

  return (
    <div className="space-y-4">
      {stances.length === 0 && (
        <div className="rounded-xl border border-amber-700/50 bg-amber-900/20 p-3 text-sm text-amber-300">
          No stances yet — every character should have at least one. Create the first below;
          it becomes the active stance automatically.
        </div>
      )}

      {stances.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {stances.map((stance) => {
            const isActive = stance.id === character.active_stance_id;
            return (
              <div
                key={stance.id}
                onClick={() =>
                  !isActive &&
                  socket.emit('stance:activate', {
                    characterId: character.id,
                    stanceId: stance.id,
                  })
                }
                title={isActive ? 'Active stance' : 'Left-click to activate'}
                className={`cursor-pointer rounded-xl border p-3 transition ${
                  isActive
                    ? 'border-indigo-500 bg-indigo-950/40'
                    : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-bold text-zinc-100">{stance.name}</span>
                  {isActive && (
                    <span className="rounded bg-indigo-600/40 px-1.5 text-xs font-bold uppercase text-indigo-300">
                      Active
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setForm({ mode: 'edit', stance });
                      }}
                      title="Edit"
                      className="rounded px-1.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(stance);
                      }}
                      disabled={stances.length === 1}
                      title={
                        stances.length === 1
                          ? 'Every character keeps at least one stance'
                          : 'Delete'
                      }
                      className="rounded px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <StyleChip attr={attrById.get(stance.attribute_a_id)} />
                  <StyleChip attr={attrById.get(stance.attribute_b_id)} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {form ? (
        <StanceForm
          attributes={attributes}
          initial={form.mode === 'edit' ? form.stance : null}
          onSubmit={submitForm}
          onCancel={() => setForm(null)}
        />
      ) : (
        <button
          onClick={() => setForm({ mode: 'create' })}
          className="rounded-md bg-indigo-600 px-4 py-2 font-semibold hover:bg-indigo-500"
        >
          + New Stance
        </button>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-400">
          Style Counter Chart
        </h3>
        <p className="mb-2 text-xs text-zinc-600">
          Arrow direction: winner → disadvantaged style.
          {activeStance
            ? ` Highlighted for ${activeStance.name}: green = you counter, red = counters you.`
            : ' Activate a stance to highlight its matchups.'}
        </p>
        <StanceGraph attributes={attributes} counters={counters} activePair={activePair} />

        {ranked && (
          <div className="mt-3 grid gap-4 border-t border-zinc-800 pt-3 sm:grid-cols-2">
            <MatchupList
              title={`Best matchups for ${activeStance.name}`}
              entries={ranked.slice(0, 3)}
              attrById={attrById}
              tone="text-green-500"
            />
            <MatchupList
              title={`Worst matchups for ${activeStance.name}`}
              entries={ranked.slice(-3).reverse()}
              attrById={attrById}
              tone="text-red-500"
            />
          </div>
        )}
      </div>
    </div>
  );
}

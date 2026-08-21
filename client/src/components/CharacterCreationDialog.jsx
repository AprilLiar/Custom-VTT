import { useEffect, useMemo, useState } from 'react';
import DialogShell from './DialogShell.jsx';
import StanceGraph from './StanceGraph.jsx';
import Thumb from './Thumb.jsx';
import { socket } from '../socket.js';
import { getMoves, getPerkTags, getPerks, getRuleset, getTags } from '../lib/api.js';
import { dieLabel } from '../lib/dice.js';
import { FIXED_QUESTIONS } from './RoleplayTab.jsx';
import {
  BASE_RANK,
  CREATION_SLOTS,
  PRESETS,
  presetByKey,
  statPointsSpent,
  validateCreation,
} from '../../../server/characterCreation.js';
import { dieAtRank } from '../../../server/gameLogic.js';

// Character Creation — the guided build, start to finish, in one window.
//
// **The rules live in server/characterCreation.js and this dialog imports
// them** (the same cross-boundary import CombatArena.jsx already uses for
// moveLogic). That is the point: a budget the wizard counts one way and the
// server enforces another is worse than no budget at all. Both read the same
// PRESETS and the same validateCreation, so the number shown here and the
// number the server accepts are the same number by construction.
//
// **Nothing is written until Finish.** Every earlier version of a flow like
// this applies as it goes, and abandoning it halfway leaves a half-built
// character nobody can tell apart from a finished one. The whole draft is
// local state until the last button, and then one `character:apply_creation`
// event applies it in the order the flow asked for it.
//
// **Every step is a suggestion, and every step has a Skip (decided, revised).**
// A creation flow's job is to guide a build, not to police one: the preset's
// point and Perk counts are shown as what is LEFT and warned about when they
// are exceeded, never enforced, and no step — the preset included — is required
// to move on. Finish is live from the first screen. The only thing that can
// still block is a genuinely broken input (a stance with one Style, or two of
// the same), and Skip is right there next to it.

const STEPS = [
  { key: 'preset', label: 'Start' },
  { key: 'stats', label: 'Stats' },
  { key: 'stance', label: 'Stance' },
  { key: 'moves', label: 'Moves' },
  { key: 'perks', label: 'Perks' },
  { key: 'roleplay', label: 'Role-play' },
];

// One multi-select-OR filter row, in the Compendium's own chip styling — the
// point of these controls being here at all is that they are the ones a player
// has already used, so they have to look and behave the same.
//
// An empty selection means no filtering rather than "match nothing", and the
// whole row is hidden when there is nothing to filter by, rather than rendering
// a bare label over an empty space.
function FilterRow({ label, options, selected, onToggle, onClear }) {
  if (!options.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-xs font-semibold uppercase text-zinc-500">{label}</span>
      {options.map((option) => {
        const active = selected.has(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onToggle(option.id)}
            title={option.description || `Filter by ${option.name}`}
            className={`panel-cut-sm border px-2 py-1 text-xs ${
              active
                ? 'border-brand-500 bg-brand-600/30 text-brand-300'
                : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
            }`}
          >
            {option.name}
          </button>
        );
      })}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="ml-1 text-xs text-zinc-500 underline hover:text-zinc-300"
        >
          clear
        </button>
      )}
    </div>
  );
}

export default function CharacterCreationDialog({ character, onClose }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [presetKey, setPresetKey] = useState(null);
  // **Every Stat starts at a bare d4, whatever the character already has
  // (decided, revised).** This used to seed from the existing spread so that
  // re-running the flow showed what was there — but the budget is the whole
  // point of this screen, and a character who already sat at d8s opened it with
  // most of the points apparently already spent and no sense of what they had
  // bought. Starting flat means the counter runs from the full budget down, and
  // every step of it is a choice the player watches themselves make.
  const [ranks, setRanks] = useState(() =>
    Object.fromEntries(CREATION_SLOTS.map((slot) => [slot, BASE_RANK]))
  );
  const [stance, setStance] = useState({ name: '', pair: [] });
  const [moveIds, setMoveIds] = useState([]);
  const [perkIds, setPerkIds] = useState([]);
  const [answers, setAnswers] = useState({});
  const [library, setLibrary] = useState({
    moves: [], perks: [], attributes: [], counters: [], moveTags: [], perkTags: [],
  });
  // **The same three controls the Compendium already has (decided, new)**, so a
  // player who has browsed the library recognises this screen: a name Search,
  // and multi-select OR filters by Style and by Tag. Kept as Sets for the same
  // reason the Compendium does — an empty Set means "no filtering", never
  // "match nothing".
  const [moveSearch, setMoveSearch] = useState('');
  const [moveStyleFilter, setMoveStyleFilter] = useState(new Set());
  const [moveTagFilter, setMoveTagFilter] = useState(new Set());
  const [perkTagFilter, setPerkTagFilter] = useState(new Set());
  const toggleInSet = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [serverErrors, setServerErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([getMoves(), getPerks(), getRuleset(), getTags(), getPerkTags()]).then(
      ([moveData, perks, ruleset, moveTags, perkTags]) => {
        if (!alive) return;
        setLibrary({
          moves: moveData.moves ?? [],
          perks,
          attributes: ruleset.attributes,
          counters: ruleset.counters,
          moveTags: moveTags ?? [],
          perkTags: perkTags ?? [],
        });
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  // The server answers a rejected draft to this socket alone; a rejection here
  // means the two validators disagreed, which should be impossible — so it is
  // shown rather than swallowed.
  useEffect(() => {
    const rejected = ({ characterId, errors }) => {
      if (characterId !== character.id) return;
      setSaving(false);
      setServerErrors(errors ?? ['The build was refused.']);
    };
    const applied = ({ characterId }) => {
      if (characterId !== character.id) return;
      setSaving(false);
      onClose();
    };
    socket.on('character:creation_rejected', rejected);
    socket.on('character:creation_applied', applied);
    return () => {
      socket.off('character:creation_rejected', rejected);
      socket.off('character:creation_applied', applied);
    };
  }, [character.id, onClose]);

  const preset = presetByKey(presetKey);
  const draft = {
    presetKey,
    statRanks: ranks,
    stance: stance.pair.length === 2 || stance.name
      ? { name: stance.name, attributeAId: stance.pair[0], attributeBId: stance.pair[1] }
      : null,
    moveIds,
    perkIds,
    roleplay: answers,
  };
  const check = useMemo(() => validateCreation(draft), [presetKey, ranks, stance, moveIds, perkIds, answers]);
  const spent = statPointsSpent(ranks);
  // Null when there is no preset — a free-form build has no "left" to report,
  // and 0 would read as "you are out".
  const pointsLeft = preset ? preset.statPoints - spent : null;
  const perksLeft = preset ? preset.perkCount - perkIds.length : null;

  const step = STEPS[stepIndex];
  const last = stepIndex === STEPS.length - 1;

  // Skip means "I am not doing this step", so it clears what the step
  // contributes as well as moving on — otherwise it is just Next with a
  // different label. Back still gets you here, and nothing is written until
  // Finish either way.
  const clearStep = {
    preset: () => setPresetKey(null),
    stats: () => setRanks(Object.fromEntries(CREATION_SLOTS.map((slot) => [slot, 0]))),
    stance: () => setStance({ name: '', pair: [] }),
    moves: () => setMoveIds([]),
    perks: () => setPerkIds([]),
    roleplay: () => setAnswers({}),
  };
  const skip = () => {
    clearStep[step.key]?.();
    if (!last) setStepIndex(stepIndex + 1);
  };

  const setRank = (slot, next) =>
    setRanks((prev) => ({ ...prev, [slot]: Math.max(0, next) }));
  const toggleIn = (list, setList, id) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const styleById = new Map(library.attributes.map((a) => [a.id, a]));
  // Which Styles this build will actually have — the stance being built in
  // step 3. Used to flag a Move the character will not be able to learn,
  // because the server enforces the same rule and would drop it.
  const ownedStyles = new Set(stance.pair);
  const unlearnable = (move) =>
    move.style_attribute_id != null && !ownedStyles.has(move.style_attribute_id);

  // Search on the name, then Style, then Tag — each an independent narrowing,
  // exactly as the Compendium applies them.
  const visibleMoves = library.moves
    .filter((m) => !m.is_default)
    .filter((m) => !moveSearch || m.name.toLowerCase().includes(moveSearch.toLowerCase()))
    .filter((m) => moveStyleFilter.size === 0 || moveStyleFilter.has(m.style_attribute_id))
    .filter((m) => moveTagFilter.size === 0 || (m.tag_ids ?? []).some((id) => moveTagFilter.has(id)));

  const visiblePerks =
    perkTagFilter.size === 0
      ? library.perks
      : library.perks.filter((p) => (p.tag_ids ?? []).some((id) => perkTagFilter.has(id)));

  const finish = () => {
    setServerErrors([]);
    setSaving(true);
    socket.emit('character:apply_creation', { characterId: character.id, ...draft });
  };

  return (
    <DialogShell
      title={`Create ${character.name}`}
      onClose={onClose}
      variant="fullscreen"
      maxWidth="max-w-3xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => (stepIndex === 0 ? onClose() : setStepIndex(stepIndex - 1))}
            className="panel-cut-sm border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
          >
            {stepIndex === 0 ? 'Cancel' : 'Back'}
          </button>
          <div className="hidden text-xs text-zinc-500 sm:block">
            Step {stepIndex + 1} of {STEPS.length}
          </div>
          <div className="flex items-center gap-2">
            {/* On every step, including the last — nothing here is required. */}
            <button
              type="button"
              onClick={skip}
              title={`Clear this step and ${last ? 'leave it out of the build' : 'move on'}`}
              className="panel-cut-sm border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            >
              Skip
            </button>
            {!last && (
              <button
                type="button"
                onClick={() => setStepIndex(stepIndex + 1)}
                className="panel-cut-sm bg-brand-600 px-4 py-2 text-sm font-bold text-white"
              >
                Next
              </button>
            )}
            {/* Live from the first screen: you can stop and finish whenever the
                build is as done as you want it to be. */}
            <button
              type="button"
              disabled={!check.ok || saving}
              onClick={finish}
              className={`panel-cut-sm px-4 py-2 text-sm font-bold disabled:opacity-40 ${
                last ? 'bg-brand-600 text-white' : 'border border-brand-700 text-brand-300 hover:border-brand-500'
              }`}
            >
              {saving ? 'Applying…' : 'Finish'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* The whole route, always visible: a guided flow that hides where you
            are in it is just a series of surprises. */}
        <ol className="flex flex-wrap gap-1 text-[11px] uppercase tracking-wide">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              className={`panel-cut-sm px-2 py-1 ${
                i === stepIndex
                  ? 'bg-brand-600 font-bold text-white'
                  : i < stepIndex
                    ? 'border border-emerald-800 text-emerald-400'
                    : 'border border-zinc-800 text-zinc-600'
              }`}
            >
              {s.label}
            </li>
          ))}
        </ol>

        {step.key === 'preset' && (
          <div className="space-y-2">
            <p className="text-sm text-zinc-400">
              How much fighting has this character already done? It decides how many Stat points and
              Perks they start with.
            </p>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPresetKey(p.key)}
                className={`block w-full panel-cut border p-3 text-left ${
                  presetKey === p.key ? 'border-brand-500 bg-brand-950/40' : 'border-zinc-800 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-lg font-bold text-zinc-100">{p.name}</span>
                  <span className="text-xs text-zinc-400">
                    {p.statPoints} Stat points · {p.perkCount} Perks
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-400">{p.blurb}</p>
              </button>
            ))}
          </div>
        )}

        {step.key === 'stats' && (
          <div className="space-y-3">
            <Budget left={pointsLeft} total={preset?.statPoints ?? null} noun="Stat point" />
            <p className="text-sm text-zinc-400">
              Every Stat starts at <b>d4</b>. One point raises it one step — d4 → d6 → d8 → d10 → d12,
              and past that each point is another +1.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {CREATION_SLOTS.map((slot) => {
                const rank = ranks[slot] ?? 0;
                const die = dieAtRank(rank);
                return (
                  <div key={slot} className="flex items-center gap-2 panel-cut border border-zinc-800 p-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{slot}</span>
                    <button
                      type="button"
                      onClick={() => setRank(slot, rank - 1)}
                      disabled={rank <= 0}
                      className="h-8 w-8 panel-cut-sm border border-zinc-700 text-zinc-300 disabled:opacity-30"
                    >
                      −
                    </button>
                    <span className="w-16 text-center font-display font-bold text-zinc-100">
                      {dieLabel(die.size, die.bonus)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRank(slot, rank + 1)}
                      className="h-8 w-8 panel-cut-sm border border-zinc-700 text-zinc-300"
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step.key === 'stance' && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              A stance is <b>two different Styles</b>. Click two nodes on the graph. You can skip this
              and build one later on the Stances tab — but Moves that carry a Style can only be learned
              by someone whose stance has it.
            </p>
            <input
              value={stance.name}
              onChange={(e) => setStance((s) => ({ ...s, name: e.target.value }))}
              placeholder="Stance name"
              className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-brand-500"
            />
            {library.attributes.length > 0 && (
              <StanceGraph
                attributes={library.attributes}
                counters={library.counters}
                activePair={stance.pair}
                onNodeClick={(id) =>
                  setStance((s) => ({
                    ...s,
                    pair: s.pair.includes(id)
                      ? s.pair.filter((x) => x !== id)
                      : s.pair.length >= 2
                        ? s.pair
                        : [...s.pair, id],
                  }))
                }
              />
            )}
            <div className="text-sm text-zinc-400">
              {stance.pair.length
                ? stance.pair.map((id) => styleById.get(id)?.name).filter(Boolean).join(' + ')
                : 'No Styles picked yet.'}
            </div>
          </div>
        )}

        {step.key === 'moves' && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              Take whatever you want — there is no budget on Moves. Default Moves everybody already has
              are not listed.
            </p>
            <input
              value={moveSearch}
              onChange={(e) => setMoveSearch(e.target.value)}
              placeholder="Search Moves…"
              aria-label="Search Moves"
              className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-brand-500"
            />
            <FilterRow
              label="Filter by style:"
              options={library.attributes}
              selected={moveStyleFilter}
              onToggle={toggleInSet(setMoveStyleFilter)}
              onClear={() => setMoveStyleFilter(new Set())}
            />
            <FilterRow
              label="Filter by tag:"
              options={library.moveTags}
              selected={moveTagFilter}
              onToggle={toggleInSet(setMoveTagFilter)}
              onClear={() => setMoveTagFilter(new Set())}
            />
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {visibleMoves.map((move) => {
                const blocked = unlearnable(move);
                return (
                  <label
                    key={move.id}
                    className={`flex items-center gap-2 panel-cut-sm border p-2 ${
                      blocked ? 'border-amber-900/60 opacity-60' : 'border-zinc-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={moveIds.includes(move.id)}
                      onChange={() => toggleIn(moveIds, setMoveIds, move.id)}
                      className="h-4 w-4"
                    />
                    <Thumb record={move} name={move.name} size="h-7 w-7" cut="panel-cut-sm" />
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{move.name}</span>
                    {blocked && (
                      <span className="shrink-0 text-[11px] uppercase text-amber-400">
                        needs {styleById.get(move.style_attribute_id)?.name ?? 'a Style'}
                      </span>
                    )}
                  </label>
                );
              })}
              {!visibleMoves.length && <p className="text-sm text-zinc-600">No Moves match that.</p>}
            </div>
          </div>
        )}

        {step.key === 'perks' && (
          <div className="space-y-3">
            <Budget left={perksLeft} total={preset?.perkCount ?? null} noun="Perk" />
            <FilterRow
              label="Filter by tag:"
              options={library.perkTags}
              selected={perkTagFilter}
              onToggle={toggleInSet(setPerkTagFilter)}
              onClear={() => setPerkTagFilter(new Set())}
            />
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {visiblePerks.map((perk) => {
                const picked = perkIds.includes(perk.id);
                return (
                  <label
                    key={perk.id}
                    className={`flex items-start gap-2 panel-cut-sm border p-2 ${
                      picked ? 'border-brand-700' : 'border-zinc-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() => toggleIn(perkIds, setPerkIds, perk.id)}
                      className="mt-0.5 h-4 w-4"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-bold text-zinc-100">{perk.name}</span>
                        {perk.automated && (
                          <span className="rounded-full bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300">
                            ⚙ Auto
                          </span>
                        )}
                      </div>
                      {perk.description && (
                        <p className="whitespace-pre-wrap break-words text-xs text-zinc-400">{perk.description}</p>
                      )}
                    </div>
                  </label>
                );
              })}
              {!library.perks.length && <p className="text-sm text-zinc-600">No Perks in the compendium yet.</p>}
            </div>
          </div>
        )}

        {step.key === 'roleplay' && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              Optional, and you can leave any of it blank — the Role-play tab is always there. The last
              question is the one with a mechanic behind it: it is where Reasons to Fight comes from.
            </p>
            {FIXED_QUESTIONS.map((q) => (
              <label key={q} className="block">
                <span className="text-xs text-zinc-400">{q}</span>
                <textarea
                  rows={2}
                  value={answers[q] ?? ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q]: e.target.value }))}
                  className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-brand-500"
                />
              </label>
            ))}
          </div>
        )}

        {/* Warnings are the preset's numbers being exceeded — said plainly and
            then allowed. Errors are the short list of things that would leave
            the character actually broken, and every one of them has a Skip. */}
        {check.warnings.length > 0 && (
          <ul className="panel-cut border border-amber-900/60 bg-amber-950/20 p-2 text-sm text-amber-300">
            {check.warnings.map((w) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        )}
        {(check.errors.length > 0 || serverErrors.length > 0) && (
          <ul className="panel-cut border border-red-900/60 bg-red-950/30 p-2 text-sm text-red-300">
            {[...check.errors, ...serverErrors].map((e) => (
              <li key={e}>• {e}</li>
            ))}
          </ul>
        )}

        {check.ok && (
          <p className="text-sm text-zinc-400">
            Finishing sets these Stats, {stance.pair.length === 2 ? 'creates and takes the stance, ' : ''}
            grants {moveIds.length} Move{moveIds.length === 1 ? '' : 's'} and {perkIds.length} Perk
            {perkIds.length === 1 ? '' : 's'}, and locks the Stats as this character's baseline.
          </p>
        )}
      </div>
    </DialogShell>
  );
}

// The budget, said the way a budget should be said: what is LEFT, big, with
// the total as context. "Spent 10 of 16" makes you do the subtraction the
// decision actually needs.
function Budget({ left, total, noun }) {
  if (total == null) {
    return (
      <div className="panel-cut border border-zinc-800 p-2 text-sm text-zinc-400">
        No preset picked — spend as much or as little as you like.
      </div>
    );
  }
  const over = left < 0;
  return (
    <div
      className={`panel-cut border p-2 text-sm ${
        over ? 'border-amber-800 text-amber-300' : 'border-zinc-800 text-zinc-300'
      }`}
    >
      <span className="font-display text-xl font-bold">{Math.abs(left)}</span>{' '}
      {noun}
      {Math.abs(left) === 1 ? '' : 's'} {over ? 'over' : 'left'}{' '}
      <span className={over ? 'text-amber-500/70' : 'text-zinc-600'}>
        {over ? `— ${total} suggested` : `of ${total}`}
      </span>
    </div>
  );
}

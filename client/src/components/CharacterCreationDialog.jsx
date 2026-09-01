import { useEffect, useMemo, useState } from 'react';
import DialogShell from './DialogShell.jsx';
import QuirkCard from './QuirkCard.jsx';
import QuirkColumns from './QuirkColumns.jsx';
import QuirkEditor from './QuirkEditor.jsx';
import StanceGraph from './StanceGraph.jsx';
import Thumb from './Thumb.jsx';
import { socket } from '../socket.js';
import { getMoves, getPerkTags, getPerks, getQuirks, getRuleset, getTags } from '../lib/api.js';
import { carriesSpecialTag } from '../lib/moveDisplay.js';
import { bundleMoves, moveSelectionCost } from '../../../server/moveBundles.js';
import { QUIRK_KINDS, quirkKind, quirkStyle } from '../lib/quirkStyles.js';
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
  // **Last before Role-play** (the ask, in those words), and that is the right
  // place for it: a Quirk is the first thing on this whole flow that is purely
  // narrative, so it is the hinge between building a fighter and writing a
  // person.
  { key: 'quirks', label: 'Quirks' },
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
      <span className="w-full text-xs font-semibold uppercase text-zinc-500">{label}</span>
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

export default function CharacterCreationDialog({ character, stances = [], onClose }) {
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
  // **Quirks are carried by VALUE in the draft, not as ids** (see
  // character_quirks in db.js): one taken off the Compendium's shelf and one
  // invented on this screen are the same three fields by the time Finish is
  // pressed, because taking an example only ever meant copying its text.
  const [quirks, setQuirks] = useState([]);
  const [writingQuirk, setWritingQuirk] = useState(null); // null | 'positive' | 'negative'
  const [answers, setAnswers] = useState({});
  const [library, setLibrary] = useState({
    moves: [], perks: [], attributes: [], counters: [], moveTags: [], perkTags: [], quirks: [],
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
    Promise.all([getMoves(), getPerks(), getRuleset(), getTags(), getPerkTags(), getQuirks()]).then(
      ([moveData, perks, ruleset, moveTags, perkTags, quirkShelf]) => {
        if (!alive) return;
        setLibrary({
          moves: moveData.moves ?? [],
          perks,
          attributes: ruleset.attributes,
          counters: ruleset.counters,
          moveTags: moveTags ?? [],
          perkTags: perkTags ?? [],
          quirks: quirkShelf ?? [],
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

  // **Declared before every hook that reads them.** A hook's dependency ARRAY
  // is evaluated at render time, so leaving these below `check`'s useMemo threw
  // a temporal-dead-zone ReferenceError and took the whole dialog down the
  // moment it opened. The same trap RelationshipBoard hit; lint does not catch
  // it and no test that never mounts the component can either.
  const styleById = new Map(library.attributes.map((a) => [a.id, a]));
  // **Which Styles this build will actually have.** The stance being built in
  // step 3, PLUS any stance the character already stands in — creation adds a
  // stance, it never takes the old ones away, so a character who already had
  // Speed can still learn a Speed Move whatever this draft picks. Getting that
  // union wrong is not cosmetic any more: it now forbids rather than greys, so
  // a narrower answer here would refuse a Move the server would have granted.
  const ownedStyles = useMemo(
    () =>
      new Set([
        ...stance.pair,
        ...stances.flatMap((s) => [s.attribute_a_id, s.attribute_b_id]),
      ].filter((id) => Number.isInteger(Number(id)))),
    [stance.pair, stances]
  );
  const unlearnable = (move) =>
    move.style_attribute_id != null && !ownedStyles.has(move.style_attribute_id);

  const draft = {
    presetKey,
    statRanks: ranks,
    stance: stance.pair.length === 2 || stance.name
      ? { name: stance.name, attributeAId: stance.pair[0], attributeBId: stance.pair[1] }
      : null,
    moveIds,
    perkIds,
    quirks,
    roleplay: answers,
  };
  // The wizard runs the SAME validator the server does, over the same Style
  // data, so what it refuses and what the server refuses cannot drift — which
  // is the whole reason this module is shared.
  const check = useMemo(
    () =>
      validateCreation({
        ...draft,
        moveStyles: Object.fromEntries(library.moves.map((m) => [m.id, m.style_attribute_id])),
        moveNames: Object.fromEntries(library.moves.map((m) => [m.id, m.name])),
        ownedStyleIds: [...ownedStyles],
        moveLibrary: library.moves,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presetKey, ranks, stance, moveIds, perkIds, answers, library.moves, ownedStyles]
  );
  // **What a Move Point buys (see server/moveBundles.js).** One bundle, one
  // checkbox, one point: `Cross - Head` and `Cross - Body` come together, and a
  // grapple pays for its first selected extension. Derived from the same
  // functions the server prices the submitted build with, so what this screen
  // counts and what the server accepts cannot drift.
  const bundles = useMemo(() => bundleMoves(library.moves), [library.moves]);
  const bundleByKey = useMemo(() => new Map(bundles.map((b) => [b.key, b])), [bundles]);
  const bundleKeyOfMove = useMemo(() => {
    const map = new Map();
    for (const bundle of bundles) for (const id of bundle.moveIds) map.set(id, bundle.key);
    return map;
  }, [bundles]);
  const cost = useMemo(() => moveSelectionCost(moveIds, bundles), [moveIds, bundles]);
  const chosenKeys = useMemo(() => new Set(cost.bundleKeys), [cost]);
  const freedKeys = useMemo(() => new Set(cost.freedKeys), [cost]);

  // Ticking a bundle takes every row in it; unticking drops every row in it.
  // The selection stays a list of move ids — that is what the server writes and
  // what every other part of this dialog already reads — and the bundle is only
  // ever the unit of the CLICK.
  const toggleBundle = (key) => {
    const bundle = bundleByKey.get(key);
    if (!bundle) return;
    const ids = new Set(bundle.moveIds);
    setMoveIds((prev) =>
      prev.some((id) => ids.has(id)) ? prev.filter((id) => !ids.has(id)) : [...prev, ...bundle.moveIds]
    );
  };

  const spent = statPointsSpent(ranks);
  // Null when there is no preset — a free-form build has no "left" to report,
  // and 0 would read as "you are out".
  const pointsLeft = preset ? preset.statPoints - spent : null;
  const perksLeft = preset ? preset.perkCount - perkIds.length : null;
  const movesLeft = preset ? preset.moveCount - cost.points : null;
  // **A cap disables what is not already picked, never what is.** Greying out a
  // ticked box would trap the build: you would be at the cap, over it, or
  // holding a Move you can no longer learn, with no way to put any of them
  // down. So a picked row always stays clickable — the only thing a cap stops
  // is picking one more.
  const atMoveCap = movesLeft != null && movesLeft <= 0;
  const atPerkCap = perksLeft != null && perksLeft <= 0;

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
    quirks: () => {
      setQuirks([]);
      setWritingQuirk(null);
    },
    roleplay: () => setAnswers({}),
  };
  const skip = () => {
    clearStep[step.key]?.();
    if (!last) setStepIndex(stepIndex + 1);
  };

  // Deduped on name+kind, matching what `validateCreation` and the server's own
  // add handler both do — clicking the same example twice meant it once.
  const addQuirk = ({ name, description, kind }) =>
    setQuirks((prev) =>
      prev.some((q) => q.name === name && q.kind === kind)
        ? prev
        : [...prev, { name, description: description ?? '', kind }]
    );

  const setRank = (slot, next) =>
    setRanks((prev) => ({ ...prev, [slot]: Math.max(0, next) }));
  const toggleIn = (list, setList, id) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  // Search on the name, then Style, then Tag — each an independent narrowing,
  // exactly as the Compendium applies them.
  // **Special never appears here (decided, new).** The Tag's whole job is that a
  // Player cannot take the thing for themselves, and Character Creation is the
  // largest way they take things. Filtered unconditionally rather than by role:
  // this dialog builds a Player's own character, and a GM handing out a Special
  // Move does it from the Compendium's Grant list, where they can see it.
  const visibleMoves = library.moves
    .filter((m) => !carriesSpecialTag(m.tag_ids, library.moveTags))
    .filter((m) => !m.is_default)
    .filter((m) => !moveSearch || m.name.toLowerCase().includes(moveSearch.toLowerCase()))
    .filter((m) => moveStyleFilter.size === 0 || moveStyleFilter.has(m.style_attribute_id))
    .filter((m) => moveTagFilter.size === 0 || (m.tag_ids ?? []).some((id) => moveTagFilter.has(id)));

  // **The visible list, as bundles, with grapple extensions pulled up under
  // their grapple.** A bundle shows when any of its moves survives the filters
  // above — filtering by Tag must not split a family in half and charge two
  // points for what one tick buys.
  //
  // `freeWith` names the grapple whose first selected extension this would be,
  // so the row can be offered even at the cap when it is about to cost nothing.
  const visibleMoveIds = new Set(visibleMoves.map((m) => m.id));
  const moveById = new Map(library.moves.map((m) => [m.id, m]));
  const bundleShows = (bundle) => bundle.moveIds.some((id) => visibleMoveIds.has(id));
  const bundleMovesOf = (bundle) => bundle.moveIds.map((id) => moveById.get(id)).filter(Boolean);
  // Which grapples have already spent their one free extension on something
  // else that is selected — read from the priced result rather than recomputed,
  // so the row's own label and the budget agree by construction.
  const hasFreeSpent = (grappleKey) => {
    const bundle = bundleByKey.get(grappleKey);
    return Boolean(bundle?.extensionKeys.some((key) => freedKeys.has(key)));
  };
  const visibleBundles = (() => {
    // **Which grapple owns each follow-up, decided before anything is drawn.**
    // Doing it inline while emitting rows makes the layout depend on the GM's
    // `sort_order`: a grapple that sorts after its own follow-ups would have
    // had them already placed at the top level and would show alone.
    //
    // Two guards keep it from eating rows it should not:
    //  - **first root wins**, so a follow-up two grapples share is indented
    //    once rather than fought over;
    //  - **a grapple is never claimed as somebody's follow-up**, which is what
    //    stops two grapples that name each other from each swallowing the
    //    other and neither appearing at all.
    const claimedBy = new Map();
    for (const bundle of bundles) {
      if (!bundle.isGrappleRoot) continue;
      for (const key of bundle.extensionKeys) {
        if (claimedBy.has(key) || bundleByKey.get(key)?.isGrappleRoot) continue;
        claimedBy.set(key, bundle.key);
      }
    }
    const out = [];
    for (const bundle of bundles) {
      if (claimedBy.has(bundle.key)) continue;
      if (!bundleShows(bundle)) continue;
      out.push({ bundle, moves: bundleMovesOf(bundle), indent: false, freeWith: null });
      if (!bundle.isGrappleRoot) continue;
      for (const key of bundle.extensionKeys) {
        if (claimedBy.get(key) !== bundle.key) continue;
        const extension = bundleByKey.get(key);
        if (!extension || !bundleShows(extension)) continue;
        out.push({
          bundle: extension,
          moves: bundleMovesOf(extension),
          indent: true,
          freeWith: bundle.key,
        });
      }
    }
    return out;
  })();

  const browsablePerks = library.perks.filter((p) => !carriesSpecialTag(p.tag_ids, library.perkTags));
  const visiblePerks =
    perkTagFilter.size === 0
      ? browsablePerks
      : browsablePerks.filter((p) => (p.tag_ids ?? []).some((id) => perkTagFilter.has(id)));

  const finish = () => {
    setServerErrors([]);
    setSaving(true);
    socket.emit('character:apply_creation', { characterId: character.id, ...draft });
  };

  return (
    <DialogShell
      title={`Create ${character.name}`}
      onClose={onClose}
      // **Not dismissible by clicking away (decided, new).** A whole build lives
      // in this dialog's local state and nothing is written until Finish, so a
      // stray click on the backdrop threw away every choice made so far with no
      // warning and no undo. Escape goes with it: both are accidents, and this
      // is the one dialog in the app where an accident costs real work. The ✕
      // stays, and it is deliberate.
      dismissible={false}
      closeButton
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
            <Budget left={movesLeft} total={preset?.moveCount ?? null} noun="Move" hard />
            <p className="text-sm text-zinc-400">
              Default Moves everybody already has are not listed. A Move with a Style can only be taken
              by someone whose stance carries that Style.
            </p>
            {/* **The controls sit beside the list, not above it.** Stacked, the
                Search box and two filter rows ate a third of the window and
                left three or four Moves visible — which is the wrong way round
                on the screen whose whole job is browsing a library. On a narrow
                screen they go back to stacking, where there is no width to
                spend instead. */}
            <div className="flex flex-col gap-3 md:flex-row">
              <aside className="shrink-0 space-y-3 md:w-52">
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
              </aside>
              <div className="min-w-0 flex-1 max-h-[30rem] space-y-1 overflow-y-auto">
              {/* **One row per BUNDLE, not per move** (see server/moveBundles.js).
                  A family of variants is one checkbox and one point — `Cross -
                  Head` and `Cross - Body` are one punch aimed two ways — and a
                  grapple's extensions sit indented under it, the first one
                  taken riding along free.

                  The rows are grouped rather than reordered: the GM's own
                  `sort_order` still decides where a family appears, and a
                  grapple's extensions are pulled up beneath it so they "appear
                  near each other" as asked. */}
              {visibleBundles.map(({ bundle, moves: familyMoves, indent, freeWith }) => {
                const picked = chosenKeys.has(bundle.key);
                const blocked = familyMoves.every((m) => unlearnable(m));
                const free = freedKeys.has(bundle.key);
                // A bundle already inside the budget is always untickable; a
                // new one costs a point unless a grapple is about to absorb it.
                const wouldCost = !picked && !(freeWith != null && chosenKeys.has(freeWith) && !hasFreeSpent(freeWith));
                const disabled = !picked && (blocked || (atMoveCap && wouldCost));
                // The variants themselves, when there is more than one, so a
                // player can see what the single tick is actually taking.
                const variantNames = familyMoves.length > 1
                  ? familyMoves.map((m) => m.name.slice(bundle.name.length).replace(/^\s*-\s*/, '')).filter(Boolean)
                  : [];
                return (
                  <label
                    key={bundle.key}
                    title={
                      blocked
                        ? 'Your stance does not carry the Style this needs'
                        : disabled
                          ? `${preset.name} allows ${preset.moveCount} Moves`
                          : familyMoves.length > 1
                            ? `One Move Point takes all ${familyMoves.length}: ${familyMoves.map((m) => m.name).join(', ')}`
                            : undefined
                    }
                    className={`flex items-center gap-2 panel-cut-sm border p-2 ${indent ? 'ml-6' : ''} ${
                      blocked
                        ? 'border-amber-900/60 opacity-60'
                        : picked
                          ? 'border-brand-700'
                          : 'border-zinc-800'
                    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      disabled={disabled}
                      onChange={() => toggleBundle(bundle.key)}
                      className="h-4 w-4"
                    />
                    <Thumb record={familyMoves[0]} name={bundle.name} size="h-7 w-7" cut="panel-cut-sm" />
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                      {bundle.name}
                      {variantNames.length > 0 && (
                        <span className="ml-1.5 text-xs text-zinc-500">{variantNames.join(' / ')}</span>
                      )}
                    </span>
                    {/* The one thing a points budget has to say out loud: what
                        this tick actually costs. Free extensions are the whole
                        grapple rule, and a rule nobody can see is a rule nobody
                        trusts. */}
                    {picked && free && (
                      <span className="shrink-0 panel-cut-sm bg-emerald-900/40 px-1.5 text-[11px] font-semibold uppercase text-emerald-300">
                        free
                      </span>
                    )}
                    {bundle.isGrappleRoot && bundle.extensionKeys.length > 0 && (
                      <span className="shrink-0 text-[11px] uppercase text-zinc-500">grapple</span>
                    )}
                    {blocked && (
                      <span className="shrink-0 text-[11px] uppercase text-amber-400">needs a Style</span>
                    )}
                  </label>
                );
              })}
                {!visibleBundles.length && <p className="text-sm text-zinc-600">No Moves match that.</p>}
              </div>
            </div>
          </div>
        )}

        {step.key === 'perks' && (
          <div className="space-y-3">
            <Budget left={perksLeft} total={preset?.perkCount ?? null} noun="Perk" hard />
            <div className="flex flex-col gap-3 md:flex-row">
              <aside className="shrink-0 md:w-52">
                <FilterRow
                  label="Filter by tag:"
                  options={library.perkTags}
                  selected={perkTagFilter}
                  onToggle={toggleInSet(setPerkTagFilter)}
                  onClear={() => setPerkTagFilter(new Set())}
                />
              </aside>
              <div className="min-w-0 flex-1 max-h-[30rem] space-y-1 overflow-y-auto">
              {visiblePerks.map((perk) => {
                const picked = perkIds.includes(perk.id);
                const capped = !picked && atPerkCap;
                return (
                  <label
                    key={perk.id}
                    title={capped ? `${preset.name} allows ${preset.perkCount} Perks` : undefined}
                    className={`flex items-start gap-2 panel-cut-sm border p-2 ${
                      picked ? 'border-brand-700' : 'border-zinc-800'
                    } ${capped ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      disabled={!picked && atPerkCap}
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
                {!visiblePerks.length && (
                  <p className="text-sm text-zinc-600">
                    {library.perks.length ? 'No Perks match that.' : 'No Perks in the compendium yet.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {step.key === 'quirks' && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              Quirks are narrative only — nothing here touches a fight. Take as many as you like from
              the Compendium's examples, or write your own; you can add more at any time from the
              sheet.
            </p>
            <QuirkColumns
              quirks={quirks}
              emptyText="None picked."
              renderQuirk={(quirk) => (
                <QuirkCard
                  key={`${quirk.kind}:${quirk.name}`}
                  quirk={quirk}
                  actions={
                    <button
                      type="button"
                      onClick={() =>
                        setQuirks((prev) =>
                          prev.filter((q) => !(q.name === quirk.name && q.kind === quirk.kind))
                        )
                      }
                      title={`Drop ${quirk.name}`}
                      className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400 md:min-h-0"
                    >
                      Drop
                    </button>
                  }
                />
              )}
              footer={(kind) =>
                writingQuirk === kind ? (
                  <QuirkEditor
                    defaultKind={kind}
                    onSubmit={(fields) => {
                      addQuirk(fields);
                      setWritingQuirk(null);
                    }}
                    onCancel={() => setWritingQuirk(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setWritingQuirk(kind)}
                    className={`min-h-11 w-full panel-cut-sm border px-3 text-xs font-semibold uppercase tracking-wide md:min-h-0 md:py-1.5 ${
                      quirkStyle(kind).chip
                    }`}
                  >
                    + Write your own
                  </button>
                )
              }
            />
            {/* The Compendium's shelf, as a pick list. Descriptions and all: a
                Quirk is nothing BUT its description, so picking one by name
                alone would be picking blind. Already-picked examples drop out
                of the list rather than sitting there greyed — this is a shelf,
                not a checklist, and the picked ones are visible above. */}
            {library.quirks.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-display text-xs font-bold uppercase tracking-widest text-zinc-500">
                  From the Compendium
                </h4>
                {/* **Split into the SAME two columns as the picked list above**,
                    rather than flowing both sides through one grid. A shelf that
                    interleaves them puts a negative example in the left-hand
                    column directly under the heading that says Positive, and
                    asks the reader to override the layout with the colour. Two
                    rules for one split is one too many. */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {QUIRK_KINDS.map((kind) => (
                    <div key={kind} className="min-w-0 space-y-2">
                      {library.quirks
                        .filter(
                          (q) =>
                            quirkKind(q.kind) === kind &&
                            !quirks.some((picked) => picked.name === q.name && picked.kind === q.kind)
                        )
                        .map((q) => (
                          <button
                            key={q.id}
                            type="button"
                            onClick={() => addQuirk(q)}
                            title={`Add "${q.name}" to this build`}
                            className={`block w-full panel-cut-sm border p-2 text-left hover:border-brand-500 ${
                              quirkStyle(q.kind).card
                            }`}
                          >
                            <span className="block text-sm font-semibold text-zinc-100">{q.name}</span>
                            {q.description && (
                              <span className="mt-0.5 block text-xs leading-snug text-zinc-400">
                                {q.description}
                              </span>
                            )}
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
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
//
// `hard` is a cap rather than a suggestion — the Perk and Move counts — so it
// says "of N" rather than "N suggested", and going over is red rather than
// amber. A number the wizard will refuse must not be worded as advice.
function Budget({ left, total, noun, hard = false }) {
  if (total == null) {
    return (
      <div className="panel-cut border border-zinc-800 p-2 text-sm text-zinc-400">
        No preset picked — {hard ? 'no limit on these' : 'spend as much or as little as you like'}.
      </div>
    );
  }
  const over = left < 0;
  const tone = over
    ? hard
      ? 'border-red-800 text-red-300'
      : 'border-amber-800 text-amber-300'
    : 'border-zinc-800 text-zinc-300';
  return (
    <div className={`panel-cut border p-2 text-sm ${tone}`}>
      <span className="font-display text-xl font-bold">{Math.abs(left)}</span>{' '}
      {noun}
      {Math.abs(left) === 1 ? '' : 's'} {over ? 'over' : 'left'}{' '}
      <span className={over ? 'opacity-70' : 'text-zinc-600'}>
        {over ? `— ${total} allowed` : `of ${total}`}
      </span>
    </div>
  );
}

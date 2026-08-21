import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Dices, PauseOctagon, Wrench, X } from 'lucide-react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacters } from '../lib/api.js';
import { useSocketRefresh } from '../lib/connection.js';
import { summonPausePrompt } from '../lib/pausePrompts.js';

// GM Tools (decided, new) — a small circular widget the GM can reach from
// anywhere in the app, overlaid above every page's own content. Opening it
// darkens and blurs everything behind, so the tool sheet is unambiguously
// "the thing you're using now" rather than another panel competing with the
// page underneath.
//
// The tool list is deliberately a list, not a single button: Roll Requester
// is the only entry today, but this widget exists to be the GM's drawer for
// the next such tool too, and building it as a one-off button would have to
// be undone the first time a second tool arrives.
//
// GM-only, client-side — the same trust model as every other GM-only control
// in this app. The server checks the GM role for itself on roll:request, so
// hiding the widget is a convenience, not the boundary.

// The 8 concrete Stats, in the canonical order used everywhere else (see
// CONCRETE_ATTACK_TARGET_NAMES server-side).
const STAT_SLOTS = [
  'Skull',
  'Brain',
  'Left Hand',
  'Stamina',
  'Body',
  'Right Hand',
  'Left Leg',
  'Right Leg',
];

function RollRequester({ onDone }) {
  const [characters, setCharacters] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [sentTo, setSentTo] = useState(null);
  // Optional. With a number here the server resolves the roll against it
  // and posts PASS/FAIL itself; left blank the request behaves exactly as
  // it always did. Deliberately never sent to the player being asked — a
  // check whose number you can see is a different thing to attempt.
  const [targetNumber, setTargetNumber] = useState('');

  const load = () => getCharacters().then(setCharacters).catch(() => {});
  // `useEffect(load, [])` — what this used to be — hands React the Promise
  // `load` returns and React files it as the effect's CLEANUP function. Tearing
  // the effect down then calls it: `TypeError: destroy is not a function`,
  // thrown from inside React's commit phase, which unmounts the entire tree.
  // Reported as "closing the Roll Requester makes the whole screen white",
  // and that is exactly what it was — the teardown happens when this component
  // unmounts, i.e. when the GM closes the tool.
  useEffect(() => {
    load();
    // load is stable enough for a mount-only fetch; useSocketRefresh below owns
    // every re-fetch after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useSocketRefresh(load);

  // Players play PCs; asking an NPC's "player" to roll would be asking the
  // GM to answer their own request.
  const pcs = characters
    .filter((c) => c.character_type === 'pc')
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = pcs.find((c) => c.id === selectedId) ?? null;

  const request = (slotName) => {
    socket.emit('roll:request', {
      characterId: selected.id,
      slotName,
      // Blank means "no target" — an unresolved roll, exactly as before.
      targetNumber: targetNumber.trim() === '' ? null : Math.trunc(Number(targetNumber)),
    });
    setSentTo(`${selected.name} — ${slotName}`);
    setSelectedId(null);
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-400">
        {selected
          ? `Which Stat should ${selected.name} roll?`
          : 'Who should roll? They get a prompt wherever they are in the app.'}
      </p>

      {sentTo && !selected && (
        <p className="panel-cut-sm bg-emerald-900/30 px-3 py-2 text-sm text-emerald-300">
          Request sent: {sentTo}
        </p>
      )}

      {!selected ? (
        pcs.length === 0 ? (
          <p className="text-sm text-zinc-600">No player characters exist yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {pcs.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setSentTo(null);
                  setSelectedId(c.id);
                }}
                className="panel-cut-sm min-h-11 border border-zinc-700 bg-zinc-800 px-3 py-2 text-left font-display text-sm text-zinc-200 hover:border-brand-500 hover:text-brand-200"
              >
                {c.name}
              </button>
            ))}
          </div>
        )
      ) : (
        <>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="shrink-0">Target number</span>
            <input
              type="number"
              value={targetNumber}
              onChange={(e) => setTargetNumber(e.target.value)}
              placeholder="none"
              className="w-20 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-brand-500"
            />
            <span className="text-zinc-600">resolved automatically, hidden from the player</span>
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STAT_SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                onClick={() => request(slot)}
                className="panel-cut-sm min-h-11 border border-zinc-700 bg-zinc-800 px-3 py-2 font-display text-sm text-zinc-200 hover:border-brand-500 hover:text-brand-200"
              >
                {slot}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="self-start text-xs text-zinc-500 hover:text-zinc-300"
          >
            ← Pick someone else
          </button>
        </>
      )}
    </div>
  );
}

// **Fight Pauses (decided, new) — the manual way back to a prompt.**
//
// A paused pair cannot advance until somebody answers it, and every automatic
// path that carries the question is now snapshot-driven and self-healing. This
// exists because "automatic and self-healing" is exactly what the old delivery
// was believed to be, right up until a GM locked their phone mid-round and the
// fight could not be continued by anyone at the table.
//
// It asks the SERVER what is paused rather than reading the combat snapshot the
// dialogs normally come from, and summons the prompt out of that answer — so it
// shares no plumbing with the path it is backing up. That is the whole value of
// it; a fallback wired through the same pipe is just a second go at the same
// failure.
const KIND_LABEL = {
  dodge: 'Dodge call',
  block: 'Block call',
  conflict: 'Guard held longer',
  grapple: 'Grapple',
};

function FightPauses({ onDone }) {
  // null until the server has answered once — "nothing is paused" and "we have
  // not asked yet" are different things to show.
  const [pauses, setPauses] = useState(null);

  const ask = useCallback(() => socket.emit('combat:resummon_pause'), []);

  useEffect(() => {
    const receive = (payload) => setPauses(payload?.pauses ?? []);
    socket.on('combat:pauses', receive);
    ask();
    return () => socket.off('combat:pauses', receive);
  }, [ask]);
  useSocketRefresh(ask);

  const summon = (pause) => {
    summonPausePrompt(pause);
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-400">
        Anything the fight is currently waiting on. Summon puts the prompt back on your screen — use
        it if a pause is listed here but no dialog ever appeared.
      </p>

      {pauses === null ? (
        <p className="text-sm text-zinc-600">Asking the server…</p>
      ) : pauses.length === 0 ? (
        <p className="panel-cut-sm bg-zinc-800/60 px-3 py-2 text-sm text-zinc-400">
          Nothing is paused. Every pair is either declaring or resolving on its own.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {pauses.map((pause) => (
            <div
              key={`${pause.pairIndex}:${pause.kind}:${pause.roundNumber}`}
              className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-display text-sm font-semibold text-brand-200">
                  {KIND_LABEL[pause.kind] ?? pause.kind}
                </span>
                <span className="text-xs text-zinc-500">
                  Pair {pause.pairIndex + 1} · Round {pause.roundNumber}
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-300">{pause.summary}</p>
              {pause.gmCanAnswer ? (
                <button
                  type="button"
                  onClick={() => summon(pause)}
                  className="mt-2 min-h-11 w-full panel-cut-sm border border-brand-600/60 bg-brand-900/40 px-3 py-2 font-display text-sm font-semibold text-brand-200 hover:bg-brand-800/50 md:min-h-0 md:w-auto md:py-1"
                >
                  Summon the prompt
                </button>
              ) : (
                <p className="mt-1 text-xs text-zinc-500">
                  Not yours to answer — this one is waiting on the fighter it belongs to.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={ask}
        className="min-h-11 self-start panel-cut-sm border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 md:min-h-0 md:py-1"
      >
        Re-check
      </button>
    </div>
  );
}

const TOOLS = [
  {
    id: 'roll-requester',
    name: 'Roll Requester',
    blurb: 'Ask a player to roll one of their Stats.',
    icon: Dices,
    render: (props) => <RollRequester {...props} />,
  },
  {
    id: 'fight-pauses',
    name: 'Fight Pauses',
    blurb: 'See what the fight is waiting on, and summon the prompt by hand.',
    icon: PauseOctagon,
    render: (props) => <FightPauses {...props} />,
  },
];

export default function GmToolsWidget() {
  const { role } = useRole();
  const [open, setOpen] = useState(false);
  const [toolId, setToolId] = useState(null);

  // Escape closes whatever layer is on top: the tool first, then the drawer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (toolId) setToolId(null);
      else setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, toolId]);

  if (role !== 'gm') return null;

  const tool = TOOLS.find((t) => t.id === toolId) ?? null;

  const close = () => {
    setToolId(null);
    setOpen(false);
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            key="gm-tools-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            // The blur is the point: it puts the page behind out of focus
            // rather than merely dimming it, so the tool sheet reads as a
            // mode you're in, not a panel floating over a live page.
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-sm md:items-center md:p-4"
            onClick={close}
          >
            <motion.div
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              // See DialogShell: added to p-4's 1rem, not replacing it.
              style={{ paddingBottom: 'calc(1rem + var(--safe-bottom))' }}
              className="flex max-h-[88dvh] w-full max-w-lg flex-col gap-3 rounded-t-2xl border border-zinc-700 bg-zinc-900 p-4 md:rounded-none md:panel-cut-lg"
            >
              <div className="flex shrink-0 items-center gap-2">
                <h3 className="font-display font-bold uppercase tracking-wide text-zinc-100">
                  {tool ? tool.name : 'GM Tools'}
                </h3>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close GM tools"
                  className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-500 hover:text-zinc-200 md:h-8 md:w-8"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {tool ? (
                  tool.render({ onDone: close })
                ) : (
                  <div className="flex flex-col gap-2">
                    {TOOLS.map(({ id, name, blurb, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setToolId(id)}
                        className="flex min-h-11 items-center gap-3 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-left hover:border-brand-500"
                      >
                        <Icon size={20} className="shrink-0 text-brand-400" />
                        <span>
                          <span className="block font-display text-sm font-semibold text-zinc-100">
                            {name}
                          </span>
                          <span className="block text-xs text-zinc-500">{blurb}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {tool && (
                <button
                  type="button"
                  onClick={() => setToolId(null)}
                  className="shrink-0 self-start border-t border-zinc-800 pt-2 text-xs text-zinc-500 hover:text-zinc-300"
                >
                  ← All GM tools
                </button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Always visible, on every page — a GM shouldn't have to navigate
          somewhere to reach a GM tool. Sits clear of the mobile bottom nav's
          safe area. z-[45] puts it above the mobile chat overlay (z-40, where
          it's still useful) but below any modal dialog (z-50): a dialog is a
          decision you're in the middle of, and a button floating over it
          reads as part of it. */}
      <motion.button
        type="button"
        whileTap={{ scale: 0.92 }}
        onClick={() => setOpen((v) => !v)}
        aria-label="GM tools"
        title="GM tools"
        style={{ bottom: 'calc(var(--safe-bottom) + 4.5rem)' }}
        className="fixed right-4 z-[45] flex h-12 w-12 items-center justify-center rounded-full border border-brand-500/60 bg-brand-700/90 text-zinc-100 shadow-lg shadow-black/50 hover:bg-brand-600 md:bottom-6 md:h-14 md:w-14"
      >
        <Wrench size={20} />
      </motion.button>
    </>
  );
}

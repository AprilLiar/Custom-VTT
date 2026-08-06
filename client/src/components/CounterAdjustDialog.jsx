import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getCharacter, getCombat } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';
import { REWARD_LABELS, REWARD_COLORS } from '../lib/counterDisplay.js';
import DialogShell from './DialogShell.jsx';

// Counters from a roll card (decided, new). Counters existed in two places
// that had nothing to do with each other — a character's own Counters tab,
// and the Arena's standalone ones — so ticking one up after a roll meant
// leaving the chat, finding the right screen, and coming back. This is the
// same data reached from where the roll actually happened.
//
// Two sections, exactly as decided: the roller's own counters always, and
// the Arena's counters only while a fight is running (there is nothing for
// them to track otherwise). Both sections can create as well as adjust,
// because "the counter I want doesn't exist yet" is the most common reason
// to be here at all.

function CounterRow({ counter, showOwner }) {
  const pips = Array.from({ length: counter.target_pips });
  return (
    <div className="flex items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900/60 p-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-display text-sm text-zinc-200">
            {showOwner && counter.ownerName ? `${counter.ownerName} — ` : ''}
            {counter.name}
          </span>
          {counter.reward_type && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${REWARD_COLORS[counter.reward_type]}`}
            >
              {REWARD_LABELS[counter.reward_type]}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-0.5" title={`${counter.current_pips} / ${counter.target_pips}`}>
          {pips.map((_, i) => (
            <span
              key={i}
              className={`h-2 w-2 border ${
                i < counter.current_pips ? 'border-brand-400 bg-brand-500' : 'border-zinc-700 bg-zinc-800'
              }`}
            />
          ))}
        </div>
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-sm text-zinc-400">
        {counter.current_pips}/{counter.target_pips}
      </span>
      <button
        type="button"
        onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: -1 })}
        disabled={counter.current_pips <= 0}
        className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 md:h-8 md:w-8"
      >
        −
      </button>
      <button
        type="button"
        onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: 1 })}
        disabled={counter.current_pips >= counter.target_pips}
        className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 md:h-8 md:w-8"
      >
        +
      </button>
    </div>
  );
}

function CreateCounter({ characterId, label }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('6');

  const create = (e) => {
    e.preventDefault();
    const targetPips = Math.trunc(Number(target) || 0);
    if (!name.trim() || targetPips < 2 || targetPips > 20) return;
    socket.emit('counter:create', { characterId, name: name.trim(), targetPips });
    setName('');
    setTarget('6');
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-xs text-brand-400 hover:text-brand-300"
      >
        + {label}
      </button>
    );
  }
  return (
    <form onSubmit={create} className="flex flex-wrap items-center gap-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Counter name"
        className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
      />
      <input
        type="number"
        min={2}
        max={20}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        title="Target pips (2-20)"
        className="w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
      />
      <button
        type="submit"
        className="panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold hover:bg-brand-500"
      >
        Create
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs text-zinc-500 hover:text-zinc-300"
      >
        Cancel
      </button>
    </form>
  );
}

export default function CounterAdjustDialog({ characterId, characterName, onClose }) {
  const { role, characterId: myCharacterId } = useRole();
  const [own, setOwn] = useState(null);
  const [arena, setArena] = useState(null);
  const [fightActive, setFightActive] = useState(false);

  const load = () => {
    if (characterId != null) {
      getCharacter(characterId)
        .then((d) => setOwn(d?.counters ?? []))
        .catch(() => setOwn([]));
    } else {
      setOwn([]);
    }
    getCombat(role === 'gm' ? { role: 'gm' } : { role: 'player', characterId: myCharacterId })
      .then((c) => {
        setArena(c?.counters ?? []);
        setFightActive((c?.pairs ?? []).some((p) => p.phase != null));
      })
      .catch(() => {
        setArena([]);
        setFightActive(false);
      });
  };

  // counter:* broadcasts are how an adjust becomes visible — refetch rather
  // than patching local state, so a counter someone else created or deleted
  // while this is open shows up too.
  useEffect(() => {
    load();
    const events = ['counter:created', 'counter:updated', 'counter:deleted', 'combat:updated'];
    for (const ev of events) socket.on(ev, load);
    return () => {
      for (const ev of events) socket.off(ev, load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, role, myCharacterId]);

  // The Arena section only lists counters that aren't already in the first
  // section — a character-owned counter flagged Show in Combat appears in
  // GET /api/combat too, and listing it twice with two sets of +/- buttons
  // would look like two separate counters.
  const ownIds = new Set((own ?? []).map((c) => c.id));
  const arenaOnly = (arena ?? []).filter((c) => !ownIds.has(c.id));

  return (
    <DialogShell title="Counters" onClose={onClose} maxWidth="max-w-lg">
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h4 className="font-display text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {characterName ? `${characterName}'s counters` : 'Character counters'}
          </h4>
          {own == null ? (
            <p className="text-sm text-zinc-600">Loading…</p>
          ) : characterId == null ? (
            <p className="text-sm text-zinc-600">
              This roll wasn't made by a character, so there are no personal counters to adjust.
            </p>
          ) : own.length === 0 ? (
            <p className="text-sm text-zinc-600">No counters yet.</p>
          ) : (
            own.map((c) => <CounterRow key={c.id} counter={c} />)
          )}
          {characterId != null && <CreateCounter characterId={characterId} label="New counter" />}
        </section>

        {fightActive && (
          <section className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
            <h4 className="font-display text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Combat counters
            </h4>
            {arena == null ? (
              <p className="text-sm text-zinc-600">Loading…</p>
            ) : arenaOnly.length === 0 ? (
              <p className="text-sm text-zinc-600">No combat counters yet.</p>
            ) : (
              arenaOnly.map((c) => <CounterRow key={c.id} counter={c} showOwner />)
            )}
            {role === 'gm' && <CreateCounter characterId={null} label="New combat counter" />}
          </section>
        )}
      </div>
    </DialogShell>
  );
}

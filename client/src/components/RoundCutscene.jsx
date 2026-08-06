import { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { AnimatePresence, motion } from 'framer-motion';
import { socket } from '../socket.js';
import { getRoundReplay } from '../lib/api.js';
import {
  PHASE_BG,
  PHASE_BG_EXTENDED,
  PHASE_LABEL,
  phaseAt,
  isExtendedRecoveryTic,
} from '../lib/framePhaseColors.js';

// Combat Automation overhaul §4.1 — a pair's round, rendered as an animated
// "cutscene" instead of narrated through a string of manual GM clicks.
//
// Live and replayed rounds are the SAME component fed the SAME round_events
// shape (§0: the server computes every outcome, the client only plays back
// an ordered log it did not compute). That's what guarantees a "Watch Round
// X" replay looks identical to what was seen live — one renderer, one event
// stream, replayed instead of streamed, rather than two representations
// kept in sync.
//
//   mode='live'   — subscribes to combat:round_event for this pairIndex.
//                   Events arrive as the server persists them, so the
//                   timeline grows while it plays.
//   mode='replay' — one-shot fetch of the stored log. No subscription: the
//                   log is complete and immutable by the time a
//                   round_summary chat card exists to open it.
//
// Sequencing runs on a GSAP tween over a plain {i} proxy rather than a
// timeline of per-element tweens. The proxy's value IS the playhead (how
// many events have been revealed), which makes "skip to end" a single
// assignment instead of bespoke fast-forward logic — trivial precisely
// because nothing is computed during playback (§0). Framer Motion still
// handles the discrete per-element entrances, exactly as it does elsewhere
// in the app.

// How long each event dwells before the next one reveals. Slow enough to
// read a damage number, fast enough that a 7-Tic round doesn't outstay its
// welcome.
const SECONDS_PER_EVENT = 0.55;

// Each event's headline chip. Deliberately short — the sentence beside it
// (eventNarration) carries the meaning, so this is a scanning aid, not the
// explanation.
const EVENT_LABEL = {
  reveal: 'Reveal',
  roll: 'Roll',
  defense_resolved: 'Defense',
  recovery_extended: 'Extension',
  insignificant_damage: 'No effect',
  dodge_prompt: 'Dodge?',
  dodge_resolved: 'Dodge',
  interrupt_resolved: 'Interrupt',
  damage_applied: 'Damage',
  move_conflict_prompt: 'Conflict?',
  move_conflict_resolved: 'Conflict',
  automation_fired: 'Automation',
  stamina_regen: 'Stamina',
  round_complete: 'Round over',
};

// Events that represent the round stopping for a human decision — rendered
// with the paused treatment, and they're where an un-skippable wait lands.
const PAUSE_EVENTS = new Set(['dodge_prompt', 'move_conflict_prompt']);

const COVERAGE_PHRASE = {
  full: 'covering the whole attack',
  'too-early': 'but the guard was already down',
  'too-late': 'but the guard came up late',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The log used to be a label plus a terse fragment, with the actual meaning
// only reachable by hovering for a tooltip — unreadable at the table, where
// nobody is going to hover a line to find out who hit whom. Every row now
// states what happened in one plain sentence, naming the people involved,
// and the hover detail (eventDetail below) is an extra rather than the only
// way to follow a fight.
function eventNarration(ev, startTic) {
  const p = ev.payload ?? {};
  const who = p.characterName ?? 'Someone';
  switch (ev.type) {
    case 'reveal':
      return `${who} reveals ${p.moveName ?? 'a move'}${
        p.isDefensive ? ` (${p.defenseKind === 'dodge' ? 'a Dodge' : 'a Block'})` : ''
      }.`;
    case 'roll': {
      const parts = (p.dice ?? []).map((d) => `${d.slot_name ?? d.slotName} ${d.result}`);
      const mod = p.modifier ? ` (${p.modifier > 0 ? '+' : ''}${p.modifier})` : '';
      return `${parts.join(' + ') || 'Rolled'}${mod} — total ${p.total ?? '?'}.`;
    }
    case 'defense_resolved': {
      const kind = p.defenseType === 'dodge' ? 'Dodge' : 'Block';
      return `${kind} attempted, ${COVERAGE_PHRASE[p.coverage] ?? p.coverage ?? ''}.`;
    }
    case 'recovery_extended':
      return `${who}'s ${p.moveName} blocked late — Recovery extended by ${plural(
        p.extensionTics ?? 0,
        'Tic',
        'Tics'
      )} to cover the rest of ${p.attackerCharacterName}'s ${p.attackerMoveName}.`;
    case 'insignificant_damage':
      return `${who}'s ${p.moveName} rolled ${p.total} — insignificant damage, nothing lands.`;
    case 'dodge_prompt':
      return `${p.defenderCharacterName} fully covers ${p.attackerCharacterName}'s ${p.attackerMoveName} (attack rolled ${p.attackerResult}) — waiting on the GM to call it.`;
    case 'dodge_resolved':
      return p.outcome === 'successful'
        ? 'The GM called the Dodge Successful.'
        : 'The GM called the Dodge Failed.';
    case 'interrupt_resolved':
      return p.interrupted
        ? `Interrupted mid-Startup — rolled ${p.result} against ${plural(p.halfDamageSteps ?? 0, 'step', 'steps')}.`
        : `Held through the hit — rolled ${p.result} against ${plural(p.halfDamageSteps ?? 0, 'step', 'steps')}.`;
    case 'damage_applied':
      if (p.result === 'no-eligible-target') return 'Nothing left to hit — every allowed Stat is out.';
      return `${plural(p.steps ?? 0, 'step', 'steps')} of damage to ${p.slotName ?? 'an unknown Stat'}${
        p.targetCharacterName ? ` on ${p.targetCharacterName}` : ''
      }.`;
    case 'move_conflict_prompt':
      return "A Block's extended Recovery ran into an already-declared move — waiting on Forfeit or Postpone.";
    case 'move_conflict_resolved':
      return p.choice === 'forfeit'
        ? 'Forfeited the colliding move; its Stamina is refunded.'
        : 'Postponed the colliding move past the extended Recovery.';
    case 'automation_fired':
      return `The move's On ${p.trigger === 'defense_success' ? 'Successful Defense' : p.trigger === 'defense_failure' ? 'Failed Defense' : (p.trigger ?? '')} effect fired.`;
    case 'stamina_regen':
      return `Idle Tic — ${who ?? 'they'} recover ${p.amount ?? 1} Stamina.`;
    case 'round_complete':
      return 'Every Tic in this round has resolved.';
    default:
      return '';
  }
}

// The hover detail behind each row. Now genuinely supplementary — the raw
// numbers behind the sentence — rather than the only place the outcome is
// stated. Every element on this timeline is a real DOM node with its own
// payload behind it (§4.1), not a rendered video frame, which is what makes
// this possible at all.
function eventDetail(ev, startTic) {
  const p = ev.payload ?? {};
  const lines = [`Tic ${ev.tic - startTic + 1}`];
  switch (ev.type) {
    case 'reveal':
      lines.push(
        `Startup until Tic ${p.revealTic - startTic + 1}, Active until ${p.activeEndTic - startTic + 1}, Recovery until ${p.recoveryEndTic - startTic + 1}`
      );
      if (p.appendageChoice) lines.push(`Side: ${p.appendageChoice}`);
      break;
    case 'roll':
      if (Array.isArray(p.dice) && p.dice.length) {
        lines.push(p.dice.map((d) => `${d.slot_name ?? d.slotName}: d${d.size} -> ${d.result}`).join('\n'));
      }
      if (p.modifier) lines.push(`Modifier: ${p.modifier > 0 ? '+' : ''}${p.modifier}`);
      break;
    case 'defense_resolved':
      if (p.outcome) lines.push(`Outcome: ${p.outcome}`);
      if (p.defenderResult != null) lines.push(`Defender rolled ${p.defenderResult}`);
      break;
    case 'recovery_extended':
      lines.push(`Now runs through Tic ${p.recoveryEndTic - startTic}`);
      lines.push('Automatic — a Block is never a prompt');
      break;
    case 'insignificant_damage':
      lines.push('Under 5 on the roll: fewer than one Half-Damage step');
      lines.push('Not a Miss — a Miss is an attack evaded by a Dodge');
      break;
    case 'damage_applied':
      if (p.result !== 'no-eligible-target') lines.push(`${(p.steps ?? 0) * 0.5} damage`);
      break;
    default:
      break;
  }
  return lines.join('\n');
}

// Every move revealed so far, in lane order — rebuilt from the reveal
// events themselves rather than from live combat state, so replay works
// identically (the reveal payload carries the whole footprint, see
// processTic's reveal block server-side).
// A late Block's Recovery extension (recovery_extended) is folded into the
// footprint it belongs to rather than kept as a separate overlay: the
// extension genuinely lengthens the move's Recovery window, so the bar has
// to grow with it. It stays keyed to the playhead like everything else —
// the extra Tics appear at the moment the event does, not retroactively
// from the start of the round.
function footprintsFrom(events, upTo) {
  const out = [];
  const byDeclaredMoveId = new Map();
  for (const ev of events.slice(0, upTo)) {
    if (ev.type === 'reveal') {
      const fp = { ...ev.payload };
      out.push(fp);
      if (fp.declaredMoveId != null) byDeclaredMoveId.set(fp.declaredMoveId, fp);
      continue;
    }
    if (ev.type !== 'recovery_extended') continue;
    const fp = byDeclaredMoveId.get(ev.payload?.declaredMoveId);
    if (!fp) continue;
    fp.recoveryEndTic = ev.payload.recoveryEndTic;
    // Earliest wins if a move is extended twice — the whole run from the
    // first extension onward is "extended", not just the latest slice.
    fp.recoveryExtendedFromTic = Math.min(
      fp.recoveryExtendedFromTic ?? Infinity,
      ev.payload.extendedFromTic
    );
  }
  return out;
}

function MoveBar({ fp, ticks, startTic }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-right font-display text-[11px] uppercase tracking-wide text-zinc-400">
        {fp.characterName}
      </span>
      <div className="flex gap-0.5">
        {ticks.map((tic) => {
          const phase = phaseAt(fp, tic);
          // An extension Tic keeps the Block's own colour, dimmed — see
          // isExtendedRecoveryTic. phaseAt calls it plain Recovery (it is,
          // mechanically), so the check has to come first to win the fill.
          const extended = isExtendedRecoveryTic(fp, tic);
          const defenseLabel = fp.defenseKind === 'dodge' ? 'Dodge' : 'Block';
          return (
            <span
              key={tic}
              title={
                phase
                  ? `${fp.characterName} — ${fp.moveName}\nTic ${tic - startTic + 1}: ${
                      extended ? `${defenseLabel} extension` : PHASE_LABEL[phase]
                    }${phase === 'defense' && !extended ? ` (${defenseLabel} window)` : ''}`
                  : undefined
              }
              className={`h-3 w-6 border border-zinc-900 ${
                extended
                  ? PHASE_BG_EXTENDED.defense
                  : phase
                    ? PHASE_BG[phase]
                    : 'bg-zinc-800/50'
              }`}
            />
          );
        })}
      </div>
      <span className="truncate font-display text-[11px] text-zinc-300">{fp.moveName}</span>
    </div>
  );
}

export default function RoundCutscene({
  mode = 'live',
  pairIndex,
  resolutionId,
  roundNumber,
  roundStartTic,
  roundLength,
  pendingDodge,
  pendingConflict,
}) {
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState(null);
  const [visibleCount, setVisibleCount] = useState(0);
  const [error, setError] = useState(null);
  const proxy = useRef({ i: 0 });
  const tweenRef = useRef(null);
  const feedRef = useRef(null);

  // --- Sourcing: live subscription vs one-shot replay fetch ---
  useEffect(() => {
    if (mode !== 'live') return undefined;
    // A fresh mount starts from whatever the server has already pushed
    // during this round; there's no backfill here on purpose — the live
    // view is for the round happening now, and anything missed is
    // recoverable in full from the chat log's replay card afterwards.
    const onEvent = (ev) => {
      if (ev.pairIndex !== pairIndex) return;
      setEvents((prev) =>
        prev.some((e) => e.seq === ev.seq && e.resolutionId === ev.resolutionId)
          ? prev
          : [...prev, ev].sort((a, b) => a.seq - b.seq)
      );
    };
    socket.on('combat:round_event', onEvent);
    return () => socket.off('combat:round_event', onEvent);
  }, [mode, pairIndex]);

  // A new round for the same pair reuses this component — drop the previous
  // round's events rather than appending onto them.
  useEffect(() => {
    if (mode !== 'live') return;
    setEvents([]);
    setVisibleCount(0);
    proxy.current.i = 0;
  }, [mode, pairIndex, roundNumber]);

  useEffect(() => {
    if (mode !== 'replay' || !resolutionId) return undefined;
    let cancelled = false;
    getRoundReplay(resolutionId)
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setEvents(data.events ?? []);
      })
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not load this round'));
    return () => {
      cancelled = true;
    };
  }, [mode, resolutionId]);

  // --- Playback: one tween from wherever the playhead is to the newest
  // event. Re-running as events stream in extends the run rather than
  // restarting it, because gsap.to starts from the proxy's CURRENT value.
  useEffect(() => {
    if (!events.length) return undefined;
    tweenRef.current?.kill();
    const remaining = events.length - proxy.current.i;
    if (remaining <= 0) {
      setVisibleCount(events.length);
      return undefined;
    }
    tweenRef.current = gsap.to(proxy.current, {
      i: events.length,
      duration: remaining * SECONDS_PER_EVENT,
      ease: 'none',
      onUpdate: () => setVisibleCount(Math.floor(proxy.current.i)),
      onComplete: () => setVisibleCount(events.length),
    });
    return () => tweenRef.current?.kill();
  }, [events.length]);

  const skipToEnd = () => {
    tweenRef.current?.kill();
    proxy.current.i = events.length;
    setVisibleCount(events.length);
  };

  // Keep the newest revealed event in view without yanking the page.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleCount]);

  const startTic = meta?.roundStartTic ?? roundStartTic ?? 0;
  const length = meta?.roundLength ?? roundLength ?? 7;
  const ticks = useMemo(
    () => Array.from({ length }, (_, i) => startTic + i),
    [startTic, length]
  );

  const shown = events.slice(0, visibleCount);
  const footprints = footprintsFrom(events, visibleCount);
  const playheadTic = shown.length ? shown[shown.length - 1].tic : startTic;
  const isCaughtUp = visibleCount >= events.length;
  const paused = pendingDodge || pendingConflict;

  // Players above the strip, NPCs below — the same convention the
  // Declaration Lanes and the old lane-snapshot chat cards already use, so
  // the cutscene reads as the same board rather than a new grammar.
  const above = footprints.filter((f) => f.characterType !== 'npc');
  const below = footprints.filter((f) => f.characterType === 'npc');

  if (error) {
    return <div className="panel-cut border border-zinc-800 p-4 text-sm text-zinc-400">{error}</div>;
  }

  return (
    <div className="panel-cut flex h-full min-h-0 flex-col border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-display text-sm uppercase tracking-wide text-zinc-300">
          Round {meta?.roundNumber ?? roundNumber}
          {mode === 'replay' && <span className="ml-2 text-[11px] text-zinc-500">replay</span>}
        </h3>
        <div className="flex items-center gap-2">
          {paused && (
            <span className="panel-cut-sm bg-amber-600/30 px-2 py-0.5 font-display text-[11px] uppercase text-amber-300">
              {pendingDodge ? 'Waiting on the GM’s Dodge call' : 'Waiting on a Forfeit/Postpone choice'}
            </span>
          )}
          <button
            type="button"
            onClick={skipToEnd}
            disabled={isCaughtUp}
            className="panel-cut-sm border border-zinc-700 px-2 py-1 font-display text-[11px] uppercase text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {mode === 'replay' ? 'Skip to end' : 'Catch up'}
          </button>
        </div>
      </div>

      {/* Players above the strip */}
      <div className="mb-1 space-y-1">
        {above.map((fp) => (
          <MoveBar key={fp.declaredMoveId} fp={fp} ticks={ticks} startTic={startTic} />
        ))}
      </div>

      {/* The Tic strip itself, driven by the playhead rather than live
          server state — during a cutscene the round is already computed. */}
      <div className="flex items-center gap-2 py-1">
        <span className="w-24 shrink-0" />
        <div className="flex gap-0.5">
          {ticks.map((tic) => (
            <motion.span
              key={tic}
              animate={{ scale: tic === playheadTic ? 1.15 : 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              title={`Tic ${tic - startTic + 1}`}
              className={`flex h-6 w-6 items-center justify-center border font-display text-[10px] ${
                tic === playheadTic
                  ? 'border-brand-400 bg-brand-700/60 text-zinc-100'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-500'
              }`}
            >
              {tic - startTic + 1}
            </motion.span>
          ))}
        </div>
      </div>

      {/* NPCs below */}
      <div className="mt-1 space-y-1">
        {below.map((fp) => (
          <MoveBar key={fp.declaredMoveId} fp={fp} ticks={ticks} startTic={startTic} />
        ))}
      </div>

      {/* The event feed — every element is a real DOM node with its own
          payload behind it (hover for detail), not a rendered video frame. */}
      {/* The event feed fills whatever height it's given — in the theater
          dialog that's most of the screen, which is the point: the log is
          what you actually read to follow the fight. */}
      <div ref={feedRef} className="mt-3 min-h-32 flex-1 space-y-1 overflow-y-auto pr-1">
        <AnimatePresence initial={false}>
          {shown.map((ev) => (
            <motion.div
              key={`${ev.resolutionId ?? resolutionId}-${ev.seq}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18 }}
              title={eventDetail(ev, startTic)}
              className={`flex items-baseline gap-2 border-l-2 px-2 py-1 text-sm ${
                PAUSE_EVENTS.has(ev.type)
                  ? 'border-amber-500 bg-amber-950/30 text-amber-200'
                  : ev.type === 'damage_applied'
                    ? 'border-rose-600 bg-rose-950/20 text-rose-200'
                    : ev.type === 'insignificant_damage'
                      ? 'border-zinc-600 text-zinc-500'
                      : 'border-zinc-700 text-zinc-300'
              }`}
            >
              <span className="w-8 shrink-0 font-display text-[11px] text-zinc-500">
                T{ev.tic - startTic + 1}
              </span>
              <span className="w-24 shrink-0 font-display text-[11px] uppercase tracking-wide text-zinc-500">
                {EVENT_LABEL[ev.type] ?? ev.type}
              </span>
              {/* The sentence, not a fragment — readable without hovering. */}
              <span className="min-w-0 flex-1">{eventNarration(ev, startTic)}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        {!events.length && (
          <div className="px-2 py-1 text-xs text-zinc-600">Resolving…</div>
        )}
      </div>
    </div>
  );
}

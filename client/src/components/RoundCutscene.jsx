import { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { AnimatePresence, motion, useAnimation, useReducedMotion } from 'framer-motion';
import { socket } from '../socket.js';
import { getRoundReplay } from '../lib/api.js';
import { loadCutsceneSpeed } from '../lib/theme.js';
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
// welcome. Divided by the viewer's own Cutscene Speed setting (Settings —
// 0.1x to 3x), which is per-device and affects nobody else's playback.
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

// How each coverage classification reads in a sentence. `too-short` is
// deliberately NOT phrased as a failure: catching an attack's opening frame
// is how a Block is supposed to work, and the extension that follows is the
// rule working, not a mistake. (`too-late` is the old name for the same
// thing — kept here only so a replay stored before the rename still reads.)
const COVERAGE_PHRASE = {
  full: 'covering the whole attack',
  'too-early': 'but the guard was already down',
  'too-short': 'catching it as it lands',
  'too-late': 'catching it as it lands',
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
      // A defensive roll names its roller: it arrives between the attacker's
      // own roll and the Defense line, and two bare "total N" rows in a row
      // is exactly the ambiguity that made a Block look like it never rolled.
      const prefix = p.defensive
        ? `${who} defends with `
        : p.characterName
          ? `${p.characterName} rolls `
          : '';
      return `${prefix}${parts.join(' + ') || 'a roll'}${mod} — total ${p.total ?? '?'}.`;
    }
    case 'defense_resolved': {
      if (p.coverage === 'no-overlap') {
        const guarded = (p.defenseTics ?? []).map((t) => t - startTic + 1);
        const active = [];
        for (let t = p.attackActiveStart; t < p.attackActiveEnd; t++) active.push(t - startTic + 1);
        return `No defence — the guard covers Tic ${guarded.join(', ')}, but the attack is Active on ${active.join(', ')}.`;
      }
      const kind = p.defenseType === 'dodge' ? 'Dodge' : 'Block';
      return `${kind} attempted, ${COVERAGE_PHRASE[p.coverage] ?? p.coverage ?? ''}.`;
    }
    case 'recovery_extended':
      return `${who}'s ${p.moveName} catches ${p.attackerCharacterName}'s ${p.attackerMoveName} — Recovery extended by ${plural(
        p.extensionTics ?? 0,
        'Tic',
        'Tics'
      )} to hold the guard through it.`;
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
      lines.push('Intended: a Block that catches the opening frame holds through the attack');
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
// What the CURRENT beat is doing, as { byMoveId, byCharacterId, burst }.
// Derived from the newest revealed event only: the playhead advances one
// event at a time, so each event gets exactly one beat of animation and the
// board is otherwise still. Purely a reading of the log — no outcome is
// decided here (§0), which is why a replay animates identically to the live
// watch.
function beatEffects(events, visibleCount) {
  const ev = visibleCount > 0 ? events[visibleCount - 1] : null;
  const empty = { byMoveId: {}, byCharacterId: {}, burst: null, revealedMoveId: null, seq: -1 };
  if (!ev) return empty;
  const p = ev.payload ?? {};
  const out = { ...empty, seq: ev.seq };
  switch (ev.type) {
    case 'reveal':
      out.revealedMoveId = p.declaredMoveId ?? null;
      break;
    case 'roll':
      if (p.declaredMoveId == null) break;
      // A defensive roll is the guard actually going up; an ordinary one is
      // the attack going out.
      out.byMoveId[p.declaredMoveId] = p.defensive
        ? p.defenseType === 'dodge'
          ? 'dodge'
          : 'block'
        : 'attack';
      break;
    case 'insignificant_damage':
      if (p.declaredMoveId != null) out.byMoveId[p.declaredMoveId] = 'fizzle';
      out.burst = { kind: 'fizzle', label: 'No effect', seq: ev.seq };
      break;
    case 'damage_applied': {
      if (p.result === 'no-eligible-target') break;
      const steps = p.steps ?? 0;
      const heavy = steps >= 2;
      // The person being hit is a character, not a move — every bar they
      // own reacts, and the burst fires whether or not they have one.
      if (p.targetCharacterId != null) {
        out.byCharacterId[p.targetCharacterId] = heavy ? 'heavy-hit' : 'hit';
      }
      out.burst = {
        kind: heavy ? 'heavy' : 'hit',
        label: `${steps * 0.5}`,
        sub: p.slotName ?? '',
        seq: ev.seq,
      };
      break;
    }
    case 'dodge_resolved':
      if (p.outcome === 'successful') out.burst = { kind: 'miss', label: 'MISS', seq: ev.seq };
      break;
    default:
      break;
  }
  return out;
}

// The hit itself, over the middle of the strip. A 2+ step hit is a visibly
// different event from a 1-step one rather than the same flash held longer —
// "massive" was the ask, so it is bigger, redder, and shakes.
function ImpactBurst({ burst }) {
  const reduceMotion = useReducedMotion();
  if (!burst) return null;
  // Reduced motion keeps the information (a hit happened, this big) and
  // drops the theatrics: no shockwave, no scale punch, no rotation.
  const heavy = burst.kind === 'heavy';
  const tone =
    burst.kind === 'fizzle'
      ? 'text-zinc-500'
      : burst.kind === 'miss'
        ? 'text-sky-300'
        : heavy
          ? 'text-rose-300'
          : 'text-rose-400';
  return (
    <AnimatePresence>
      <motion.div
        key={burst.seq}
        className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        {/* Shockwave — only for a real hit; a fizzle has no force behind it */}
        {burst.kind !== 'fizzle' && !reduceMotion && (
          <motion.span
            className={`absolute rounded-full border-2 ${
              heavy ? 'border-rose-400' : burst.kind === 'miss' ? 'border-sky-400' : 'border-rose-500'
            }`}
            initial={{ width: 20, height: 20, opacity: 0.9 }}
            animate={{ width: heavy ? 420 : 180, height: heavy ? 420 : 180, opacity: 0 }}
            transition={{ duration: heavy ? 0.75 : 0.5, ease: 'easeOut' }}
          />
        )}
        <motion.div
          className={`flex flex-col items-center font-display font-bold ${tone} ${
            heavy
              ? 'text-6xl drop-shadow-[0_0_24px_rgba(244,63,94,0.9)] md:text-8xl'
              : burst.kind === 'fizzle'
                ? 'text-xl md:text-2xl'
                : 'text-3xl drop-shadow-[0_0_12px_rgba(244,63,94,0.7)] md:text-5xl'
          }`}
          initial={reduceMotion ? { opacity: 0 } : { scale: heavy ? 0.3 : 0.6, opacity: 0, rotate: heavy ? -8 : 0 }}
          animate={
            reduceMotion
              ? { opacity: [0, 1, 0] }
              : {
                  scale: heavy ? [0.3, 1.35, 1.1] : [0.6, 1.1, 1],
                  opacity: [0, 1, 0],
                  rotate: heavy ? [-8, 2, 0] : 0,
                }
          }
          transition={{ duration: heavy ? 1.1 : 0.75, times: [0, 0.25, 1] }}
        >
          <span>{burst.label}</span>
          {burst.sub && (
            <span className="font-display text-xs uppercase tracking-widest opacity-80 md:text-sm">
              {burst.sub}
            </span>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

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

// --- Combat animation vocabulary ---
//
// Each move's bar physically acts out what the event log is saying, so the
// fight reads as a fight rather than as a table of rows that happens to be
// animating. All of it is keyed off the SAME event stream the log is (§0) —
// nothing here computes an outcome, it only performs one that already
// happened, which is what keeps a replay identical to the live watch.
//
// Direction matters: Players sit above the Tic strip and NPCs below (the
// Declaration Lanes convention), so "towards the opponent" is +y for a
// Player and -y for an NPC. `toward` carries that sign.
function attackVariant(toward) {
  return {
    // A committed step in: out fast, hang for an instant at full extension,
    // recover. Not a bounce — a punch doesn't spring back.
    y: [0, toward * 14, toward * 11, 0],
    transition: { duration: 0.5, times: [0, 0.22, 0.5, 1], ease: 'easeOut' },
  };
}

const BLOCK_VARIANT = {
  // Braces: swells outward and holds. The glow rings behind it (below) do
  // the "afterlines" half of the effect.
  scale: [1, 1.12, 1.06, 1],
  transition: { duration: 0.55, times: [0, 0.25, 0.6, 1], ease: 'easeOut' },
};

const DODGE_VARIANT = {
  // Off the line and back — the weave is lateral, deliberately unlike the
  // attack's forward commitment, so the two never read as the same motion.
  x: [0, -13, 11, -5, 0],
  transition: { duration: 0.5, ease: 'easeInOut' },
};

const FIZZLE_VARIANT = {
  // A hit that did nothing: it lands, and nothing happens. A short dim and
  // a twitch, deliberately much smaller than any real impact.
  opacity: [1, 0.45, 1],
  x: [0, 2, -2, 0],
  transition: { duration: 0.4 },
};

const HIT_VARIANT = {
  // Taking one step of damage: knocked back and shaken.
  x: [0, -7, 6, -3, 0],
  transition: { duration: 0.35 },
};

const HEAVY_HIT_VARIANT = {
  // 2+ steps. Same motion, far more of it, plus a scale punch — a heavy
  // hit should be visibly a different event, not the same shake for longer.
  x: [0, -20, 17, -11, 6, 0],
  scale: [1, 1.1, 0.96, 1.03, 1],
  transition: { duration: 0.6 },
};

function barAnimation(effect, toward) {
  switch (effect) {
    case 'attack':
      return attackVariant(toward);
    case 'block':
      return BLOCK_VARIANT;
    case 'dodge':
      return DODGE_VARIANT;
    case 'fizzle':
      return FIZZLE_VARIANT;
    case 'hit':
      return HIT_VARIANT;
    case 'heavy-hit':
      return HEAVY_HIT_VARIANT;
    default:
      return { x: 0, y: 0, scale: 1, opacity: 1 };
  }
}

function MoveBar({ fp, ticks, startTic, effect, beat, staminaFlash }) {
  // NPCs are drawn below the strip, so their "forward" is up the screen.
  const toward = fp.characterType === 'npc' ? -1 : 1;
  const controls = useAnimation();
  // index.css's reduced-motion rule only reaches CSS animations/transitions;
  // Framer drives inline transforms from JS and sails straight past it, so
  // the honouring has to be explicit here. The log still says everything
  // that happened — the motion is emphasis, never the only carrier.
  const reduceMotion = useReducedMotion();
  const glowing = effect === 'block' && !reduceMotion;

  // Driven off `beat` (the seq of the event that caused this effect), not
  // off `effect` alone: two attacks in a row are the same target values, and
  // Framer only re-runs when the values change — so without the seq the
  // second punch would simply not animate.
  useEffect(() => {
    if (!effect || reduceMotion) return;
    controls.set({ x: 0, y: 0, scale: 1, opacity: 1 });
    controls.start(barAnimation(effect, toward));
  }, [effect, beat, toward, controls, reduceMotion]);

  return (
    <motion.div className="relative flex items-center gap-2" animate={controls}>
      <span className="w-24 shrink-0 truncate text-right font-display text-xs uppercase tracking-wide text-zinc-400 md:w-36 md:text-sm">
        {fp.characterName}
      </span>
      {/* The strip is fluid: cells share the row's width instead of being
          fixed, so the timeline actually fills a wide window rather than
          leaving most of it empty. min-w keeps it legible when it can't. */}
      <div className="relative flex min-w-0 flex-1 gap-0.5">
        {/* Block "afterlines" — concentric glowing rings that swell out of
            the guard and fade, behind the bar rather than over it. */}
        <AnimatePresence>
          {glowing &&
            [0, 1, 2].map((ring) => (
              <motion.span
                key={ring}
                className="pointer-events-none absolute inset-0 border-2 border-sky-300"
                initial={{ opacity: 0.75, scaleX: 1, scaleY: 1 }}
                animate={{ opacity: 0, scaleX: 1.06 + ring * 0.05, scaleY: 2.4 + ring * 1.1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.55, delay: ring * 0.09, ease: 'easeOut' }}
              />
            ))}
        </AnimatePresence>
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
              className={`h-4 min-w-2 flex-1 border border-zinc-900 md:h-5 ${
                extended
                  ? PHASE_BG_EXTENDED.defense
                  : phase
                    ? PHASE_BG[phase]
                    : 'bg-zinc-800/50'
              } ${glowing && phase === 'defense' ? 'shadow-[0_0_14px_4px_rgba(125,211,252,0.85)]' : ''}`}
            />
          );
        })}
      </div>
      <span className="relative w-28 shrink-0 truncate font-display text-xs text-zinc-300 md:w-44 md:text-base">
        {fp.moveName}
        {/* The Stamina this move cost, flashed as it comes out and floating
            away — the one number that was previously invisible during a
            round even though it had already been spent at declaration. */}
        <AnimatePresence>
          {staminaFlash && fp.staminaCost > 0 && (
            <motion.span
              key="stam"
              initial={{ opacity: 0, y: 6, scale: 0.7 }}
              animate={{ opacity: [0, 1, 1, 0], y: -18, scale: 1.15 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, times: [0, 0.15, 0.6, 1] }}
              className="pointer-events-none absolute -top-1 left-0 font-display text-sm font-bold text-amber-300 drop-shadow-[0_0_8px_rgba(252,211,77,0.95)] md:text-lg"
            >
              −{fp.staminaCost}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </motion.div>
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
  // Read once per mount rather than subscribed: changing the setting
  // mid-cutscene and having the playhead lurch is worse than it taking
  // effect on the next round you open.
  const [speed] = useState(loadCutsceneSpeed);
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
      duration: (remaining * SECONDS_PER_EVENT) / speed,
      ease: 'none',
      onUpdate: () => setVisibleCount(Math.floor(proxy.current.i)),
      onComplete: () => setVisibleCount(events.length),
    });
    return () => tweenRef.current?.kill();
  }, [events.length, speed]);

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
  const fx = beatEffects(events, visibleCount);
  // A move's bar reacts to what it did (byMoveId) or to its owner being hit
  // (byCharacterId) — the latter is how a character with no move of their
  // own this Tic still visibly takes the punch.
  const effectFor = (fp) => fx.byMoveId[fp.declaredMoveId] ?? fx.byCharacterId[fp.characterId] ?? null;
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
        <h3 className="font-display text-base uppercase tracking-wide text-zinc-300 md:text-xl">
          Round {meta?.roundNumber ?? roundNumber}
          {mode === 'replay' && <span className="ml-2 text-xs text-zinc-500 md:text-sm">replay</span>}
        </h3>
        <div className="flex items-center gap-2">
          {paused && (
            <span className="panel-cut-sm bg-amber-600/30 px-2 py-1 font-display text-xs uppercase text-amber-300 md:text-sm">
              {pendingDodge ? 'Waiting on the GM’s Dodge call' : 'Waiting on a Forfeit/Postpone choice'}
            </span>
          )}
          <button
            type="button"
            onClick={skipToEnd}
            disabled={isCaughtUp}
            className="panel-cut-sm border border-zinc-700 px-3 py-1.5 font-display text-xs uppercase text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 md:text-sm"
          >
            {mode === 'replay' ? 'Skip to end' : 'Catch up'}
          </button>
        </div>
      </div>

      {/* The board: Players above the strip, NPCs below — the same
          convention Declaration Lanes uses. `relative` so the impact burst
          can be centred over the whole board rather than over one row. */}
      <div className="relative shrink-0">
        <ImpactBurst burst={fx.burst} />

        <div className="mb-1 space-y-1">
          {above.map((fp) => (
            <MoveBar
              key={fp.declaredMoveId}
              fp={fp}
              ticks={ticks}
              startTic={startTic}
              effect={effectFor(fp)}
              beat={fx.seq}
              staminaFlash={fx.revealedMoveId === fp.declaredMoveId}
            />
          ))}
        </div>

        {/* The Tic strip itself, driven by the playhead rather than live
            server state — during a cutscene the round is already computed.
            Cells are fluid so the strip spans the panel: the same column
            geometry as MoveBar above (name gutter, flex-1 cells, move-name
            gutter), which is what keeps the two in lockstep at any width. */}
        <div className="flex items-center gap-2 py-1">
          <span className="w-24 shrink-0 md:w-36" />
          <div className="flex min-w-0 flex-1 gap-0.5">
            {ticks.map((tic) => (
              <motion.span
                key={tic}
                animate={{ scale: tic === playheadTic ? 1.15 : 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                title={`Tic ${tic - startTic + 1}`}
                className={`flex h-8 min-w-0 flex-1 items-center justify-center border font-display text-xs md:h-10 md:text-sm ${
                  tic === playheadTic
                    ? 'border-brand-400 bg-brand-700/60 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-500'
                }`}
              >
                {tic - startTic + 1}
              </motion.span>
            ))}
          </div>
          <span className="w-28 shrink-0 md:w-44" />
        </div>

        <div className="mt-1 space-y-1">
          {below.map((fp) => (
            <MoveBar
              key={fp.declaredMoveId}
              fp={fp}
              ticks={ticks}
              startTic={startTic}
              effect={effectFor(fp)}
              beat={fx.seq}
              staminaFlash={fx.revealedMoveId === fp.declaredMoveId}
            />
          ))}
        </div>
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
              className={`flex items-baseline gap-2 border-l-2 px-2 py-1.5 text-sm md:gap-3 md:px-3 md:py-2 md:text-base ${
                PAUSE_EVENTS.has(ev.type)
                  ? 'border-amber-500 bg-amber-950/30 text-amber-200'
                  : ev.type === 'damage_applied'
                    ? 'border-rose-600 bg-rose-950/20 text-rose-200'
                    : ev.type === 'insignificant_damage'
                      ? 'border-zinc-600 text-zinc-500'
                      : 'border-zinc-700 text-zinc-300'
              }`}
            >
              <span className="w-8 shrink-0 font-display text-xs text-zinc-500 md:w-12 md:text-sm">
                T{ev.tic - startTic + 1}
              </span>
              <span className="w-24 shrink-0 font-display text-xs uppercase tracking-wide text-zinc-500 md:w-36 md:text-sm">
                {EVENT_LABEL[ev.type] ?? ev.type}
              </span>
              {/* The sentence, not a fragment — readable without hovering. */}
              <span className="min-w-0 flex-1">{eventNarration(ev, startTic)}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        {!events.length && (
          <div className="px-2 py-1 text-sm text-zinc-600 md:text-base">Resolving…</div>
        )}
      </div>
    </div>
  );
}

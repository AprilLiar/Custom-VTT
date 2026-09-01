import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { AnimatePresence, motion, useAnimation, useReducedMotion } from 'framer-motion';
import { getRoundReplay } from '../lib/api.js';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import {
  loadCutsceneSpeed,
  loadCutsceneStatsCollapsed,
  saveCutsceneStatsCollapsed,
} from '../lib/theme.js';
import { ANATOMY } from '../lib/anatomy.js';
import { EventIcon } from '../lib/eventIcons.jsx';
import {
  decomposeRoll,
  formatRollPart,
  formatRollBreakdown,
  temporaryDamageTitle,
  temporarySteps,
} from '../lib/dice.js';
import {
  PHASE_BG,
  PHASE_BG_EXTENDED,
  TRIP_MARK,
  isTripTic,
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
// **Replay only (decided, revised).** There used to be a `mode='live'` that
// subscribed to `combat:round_event` and played a round as the server resolved
// it, mounted in the Arena in place of the Tic Counter. It is gone: a table at
// a live game watches the replay together afterwards, and a view nobody looked
// at was carrying half this component's complexity — a growing event list, a
// tween that had to extend rather than restart, and a "catch up" button for a
// playhead racing a server. What the Arena shows while a pair resolves is a
// banner (see CombatArena), and the GM's own Dodge/Block/conflict prompts were
// never part of this component: they are dialogs on the header bar and are
// untouched.
//
// One-shot fetch of the stored log. No subscription: the log is complete and
// immutable by the time a round_summary chat card exists to open it.
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
  roster: 'Fighters',
  stamina_changed: 'Stamina',
  windup: 'Winding up',
  reveal: 'Reveal',
  carryover: 'Carried over',
  roll: 'Roll',
  defense_resolved: 'Defense',
  recovery_extended: 'Extension',
  moves_displaced: 'Pushed later',
  insignificant_damage: 'No effect',
  no_damage_resolved: 'No Damage',
  grapple_prompt: 'Which way?',
  grapple_guessed: 'The read',
  grapple_resolved: 'Grapple',
  grapple_chained: 'Chained',
  dodge_prompt: 'Dodge?',
  dodge_resolved: 'Dodge',
  block_prompt: 'Block?',
  block_resolved: 'Block',
  interrupt_resolved: 'Interrupt',
  damage_applied: 'Damage',
  damage_unapplied: 'Nowhere to land',
  damage_shrugged: 'Too hard to hurt',
  weapon_durability: 'Wear',
  weapon_target: 'The weapon',
  move_fizzled: 'The move is lost',
  stat_stepped: 'Stat',
  next_roll_penalty: 'Weakened',
  move_conflict_prompt: 'Conflict?',
  move_conflict_resolved: 'Conflict',
  automation_fired: 'Automation',
  stamina_regen: 'Stamina',
  round_complete: 'Round over',
};

// Events that represent the round stopping for a human decision — rendered
// with the paused treatment, and they're where an un-skippable wait lands.
const PAUSE_EVENTS = new Set(['dodge_prompt', 'block_prompt', 'move_conflict_prompt', 'grapple_prompt']);

// The before/after behind a step, for the hover detail. Sizes are carried on
// the event precisely so a replay watched later shows the step that happened
// rather than the die's current size (§0).
function statStepDetail(p) {
  const from = p.sizeBefore != null ? `d${p.sizeBefore}${p.bonusBefore ? `+${p.bonusBefore}` : ''}` : '?';
  const to = p.sizeAfter != null ? `d${p.sizeAfter}${p.bonusAfter ? `+${p.bonusAfter}` : ''}` : '?';
  return `${p.slotName ?? 'Stat'}: ${from} → ${to}`;
}

// A Stat moving because a move's automation said so — in either direction.
// Down is damage taken; **up is the Stat being restored**, which the log used
// to render as a negative quantity of damage. Phrased as movement rather than
// as a blow, because no attack landed: an interaction fired.
function statStepSentence(p, who) {
  const steps = p.steps ?? 0;
  const slot = p.slotName ?? 'a Stat';
  const on = who ? ` on ${who}` : '';
  if (steps === 0) return `${slot}${on} is unchanged.`;
  return steps > 0
    ? `${slot}${on} steps down ${plural(steps, 'step', 'steps')}.`
    : `${slot}${on} steps back up ${plural(-steps, 'step', 'steps')}.`;
}

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

// "the punch 11 (9 +2 Interrupter) against their 13 (9 +3 held, +1 frame)" —
// the Interruption contest, laid out as the two totals it actually is.
//
// Every situational term is named only when it is non-zero: both Tags are 0 on
// almost every move, and a line that always announced "+0 Interrupter" would
// bury the exchanges where the Tag is the story. A contest with no terms at all
// collapses to the two bare rolls, which is the common case.
//
// A replay stored before this rule was corrected has no `attackerTotal` and is
// rendered by the fallback below instead (§0 — a stored event is never
// rewritten).
function interruptTally(p) {
  if (p.attackerTotal == null) {
    // The old shape: a roll against a number of damage steps.
    return `rolled ${p.result} against ${plural(p.halfDamageSteps ?? 0, 'step', 'steps')}`;
  }
  const side = (total, base, terms) => {
    const named = terms.filter((t) => t.amount).map((t) => `+${t.amount} ${t.label}`);
    return named.length ? `${total} (${base} ${named.join(', ')})` : `${total}`;
  };
  const attack = side(p.attackerTotal, p.attackerRoll ?? 0, [
    { amount: p.interrupter, label: 'Interrupter' },
  ]);
  const held = side(p.defenderTotal, p.result ?? 0, [
    { amount: p.hardToInterrupt, label: 'Hard to Interrupt' },
    { amount: p.activeFrameBonus, label: 'frames elapsed' },
  ]);
  return `the attack ${attack} against their ${held}`;
}

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
    case 'roster':
      return `${(p.participants ?? []).map((f) => f.name).join(' vs ')} — Round ${ev.roundNumber ?? ''}.`.replace(' — Round .', '.');
    case 'windup':
      return `${who} starts winding something up — it comes out on Tic ${p.revealTic - startTic + 1}.`;
    case 'carryover':
      return `${who} is still in ${p.moveName ?? 'a move'} from last round.`;
    case 'roll': {
      // Each die's stored `result` contains its face and its own bonus, so it
      // is shown as the sum it is — face, addition, result — via the same
      // decomposition the chat roll card uses. The roll's shared modifier is
      // not in there (it modifies the roll, not each die) and lands on the
      // total below. This line used to print the summed result as though it
      // were the die face and then append the modifier in parentheses, which
      // is why the engine's automatic rolls looked like they threw their
      // modifiers away: a d4 read "Skull 14 (+11) — total 14".
      const parts = (p.dice ?? []).map((d) => formatRollPart(d));
      // A defensive roll names its roller: it arrives between the attacker's
      // own roll and the Defense line, and two bare "total N" rows in a row
      // is exactly the ambiguity that made a Block look like it never rolled.
      const prefix = p.defensive
        ? `${who} defends with `
        : p.characterName
          ? `${p.characterName} rolls `
          : '';
      // With one die the part already ends in the result; repeating it as a
      // total would just be the same number twice.
      const body = parts.join(' + ') || 'a roll';
      // The total is spelled out whenever it is not simply the one die's own
      // result — either several dice were summed, or a modifier applies.
      // Itemised whenever the total is made of more than one named thing, so a
      // Combat Style, a Stance matchup and a grapple read each read as their own
      // term instead of melting into one figure (decided, new).
      const suffix =
        parts.length === 1 && !p.modifier && !p.chainRollBonus
          ? ''
          : ` — total ${formatRollBreakdown(p.dice, p.modifierBreakdown, p.total, p.modifier ?? 0)}`;
      return `${prefix}${body}${suffix}.`;
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
    case 'moves_displaced': {
      // Three genuinely different sentences, because the three cases are
      // three different things happening to a fighter, not one thing with a
      // footnote. `tics` is always the same number in all of them.
      const cost = plural(p.tics ?? 0, 'Tic', 'Tics');
      const pushed = (p.shiftedDeclaredMoveIds ?? []).length;
      const tail = pushed
        ? ` ${plural(pushed, 'move', 'moves')} they had lined up ${pushed === 1 ? 'is' : 'are'} pushed later.`
        : '';
      if (p.phase === 'startup') {
        return `${who} is caught winding up — ${cost} added to the Startup, and the move lands that much later.${tail}`;
      }
      if (p.phase === 'in-flight') {
        return `${who} is caught mid-move — ${cost} of Recovery on the end of it.${tail}`;
      }
      return `${who} is caught between moves — ${cost} of Recovery, and nothing they do starts on time.${tail}`;
    }
    case 'insignificant_damage':
      return `${who}'s ${p.moveName} rolled ${p.total} — it lands, but the damage is insignificant.`;
    case 'grapple_prompt':
      return `${who}'s ${p.moveName} has ${p.targetCharacterName} — ${plural(
        p.directionCount ?? 0,
        'way',
        'ways'
      )} it could go, and both of them are choosing.`;
    case 'grapple_guessed':
      return p.guessOutcome === 'right'
        ? `${p.targetCharacterName} reads it — ${p.chosen}. +5 to them.`
        : `${p.targetCharacterName} guesses ${p.guess}; it went ${p.chosen}. +5 to ${who}.`;
    case 'grapple_resolved':
      if (p.reason === 'dodged')
        return `${p.targetCharacterName} slips out of ${who}'s ${p.moveName} — the grab closes on nothing.`;
      if (p.success)
        return `${who}'s ${p.moveName} takes hold of ${p.targetCharacterName} — ${p.grapplerTotal} against ${p.targetTotal}${
          p.chainedMoveName ? `, straight into ${p.chainedMoveName}` : ''
        }.`;
      return p.reason === 'below-threshold'
        ? `${who}'s ${p.moveName} never closes — rolled ${p.grapplerTotal}, short of ${p.threshold}.`
        : `${p.targetCharacterName} muscles out of ${who}'s ${p.moveName} — ${p.targetTotal} against ${p.grapplerTotal}.`;
    case 'grapple_chained':
      return `${who} goes straight into ${p.moveName}, out on Tic ${p.revealTic - startTic + 1}${
        p.shifted ? ` (${plural(p.shifted, 'later move', 'later moves')} pushed back)` : ''
      }.`;
    case 'no_damage_resolved':
      return p.succeeded
        ? `${who}'s ${p.moveName} succeeded — rolled ${p.total} against a Threshold of ${p.threshold}. It deals no damage.`
        : `${who}'s ${p.moveName} failed — rolled ${p.total}, short of its Threshold of ${p.threshold}.`;
    case 'dodge_prompt':
      return `${p.defenderCharacterName} fully covers ${p.attackerCharacterName}'s ${p.attackerMoveName} (attack rolled ${p.attackerResult}) — waiting on the GM to call it.`;
    case 'dodge_resolved':
      return p.outcome === 'successful'
        ? 'The GM called the Dodge Successful.'
        : 'The GM called the Dodge Failed.';
    case 'block_prompt':
      return `${p.defenderCharacterName}'s guard ${
        p.coverage === 'too-short' ? 'catches the opening of' : 'covers'
      } ${p.attackerCharacterName}'s ${p.attackerMoveName} (attack rolled ${p.attackerResult}) — waiting on the GM to call it.`;
    case 'block_resolved':
      return p.outcome === 'successful'
        ? `The GM called the Block Successful${p.targetSlotName ? ` for the strike to ${p.targetSlotName}` : ''} — now it rolls.`
        : `The GM called the Block the wrong guard${p.targetSlotName ? ` for the strike to ${p.targetSlotName}` : ''} — it does not apply.`;
    case 'interrupt_resolved':
      return p.interrupted
        ? `${who}'s move is Interrupted mid-Startup — ${interruptTally(p)}, and it never comes out.`
        : `${who} holds through the hit — ${interruptTally(p)}, their move survives.`;
    case 'damage_applied':
      if (p.result === 'no-eligible-target') return 'Nothing left to hit — every allowed Stat is out.';
      // A stored replay from before `stat_stepped` existed has its automation
      // steps in here (source: 'automation'), including negative ones. Read
      // them as the steps they are rather than as "−1 steps of damage" — a
      // stored event is never rewritten (§0), so the renderer is where an old
      // log gets to make sense.
      if (p.source === 'automation') return statStepSentence(p, p.targetCharacterName);
      return `${plural(p.steps ?? 0, 'step', 'steps')} of damage to ${p.slotName ?? 'an unknown Stat'}${
        p.targetCharacterName ? ` on ${p.targetCharacterName}` : ''
      }.`;
    case 'damage_unapplied':
      // Deliberately not phrased as a miss: the blow landed, there was simply
      // nothing left to break. The Injury call is the table's, and the totalled
      // version of this goes to the Chat Log when the round closes.
      return `${p.damage ?? 0} damage lands on ${
        p.targetCharacterName ? `${p.targetCharacterName}'s ` : 'a '
      }${p.slotName ?? 'Stat'} — already broken, so nothing can be applied.`;
    case 'damage_shrugged':
      // Not a miss and not a Block: the blow arrived and the bone was harder
      // than it was. The threshold it needed is on the event so a replay can
      // say the same thing without asking anybody's Perks (§0).
      return `${p.result ?? '?'} is not enough to hurt ${
        p.targetCharacterName ? `${p.targetCharacterName}'s ` : 'that '
      }${p.slotName ?? 'Stat'} — it needs ${p.threshold ?? '?'} to feel anything.`;
    case 'weapon_durability':
      // Said out loud every time, not only when it breaks: a weapon quietly
      // counting down to nothing is the sort of thing a table finds out about
      // at the worst possible moment.
      return p.destroyed
        ? `${p.characterName ?? 'They'} put the last of the ${p.weaponName ?? 'weapon'} into that — it is destroyed.`
        : `${p.weaponName ?? 'The weapon'} takes the wear — ${p.durability ?? 0} Durability left.`;
    case 'weapon_target':
      if (!p.armed) {
        return `${p.attackerCharacterName ?? 'The attack'} came for a weapon ${
          p.targetCharacterName ?? 'the defender'
        } is not carrying — it falls on the ${p.substituteSlotName ?? 'arm'} instead.`;
      }
      return p.destroyed
        ? `${p.attackerCharacterName ?? 'The attacker'} (${p.attackerResult ?? '?'}) breaks ${
            p.targetCharacterName ? `${p.targetCharacterName}'s ` : 'the '
          }${p.weaponName ?? 'weapon'} (${p.weaponResult ?? '?'}).`
        : `${p.weaponName ?? 'The weapon'} (${p.weaponResult ?? '?'}) holds against ${
            p.attackerResult ?? '?'
          } — nothing lands.`;
    case 'move_fizzled':
      // Named, not silently dropped: a declared move that simply never comes
      // out reads as a bug unless the round says why it went.
      return `${p.characterName ?? 'They'} cannot throw ${p.moveName ?? 'the move'} on a broken leg — it is lost${
        p.refund ? `, ${p.refund} Stamina refunded` : ''
      }.`;
    case 'stat_stepped':
      return statStepSentence(p, p.characterName);
    case 'move_conflict_prompt': {
      const n = (p.shifts ?? []).length;
      return n
        ? `The extended guard runs into ${n === 1 ? 'the next declared move' : `${n} declared moves`} — waiting on the call.`
        : "A Block's extended Recovery ran into an already-declared move — waiting on the call.";
    }
    case 'move_conflict_resolved': {
      // **Two payload shapes (§0).** The current one carries the whole cascade
      // (`shifts`, `forfeited`); replays stored before decision #4 carry a
      // single `moveName`/`newPlacementTic`, and are never rewritten — so the
      // old shape is read as a one-move cascade rather than dropped.
      const who = p.characterName ? `${p.characterName}'s ` : '';
      const legacy = p.shifts == null;
      if (legacy) {
        const what = p.moveName ? `${who}${p.moveName}` : 'the colliding move';
        if (p.choice === 'forfeit') return `Forfeited ${what}; its Stamina is refunded.`;
        const where =
          p.newPlacementTic != null
            ? ` to Tic ${p.newPlacementTic - startTic + 1}${p.intoNextRound ? ', which lands in the next round' : ''}`
            : ' past the extended Recovery';
        return `Postponed ${what}${where}.`;
      }
      const parts = [];
      if (p.forfeited) {
        parts.push(
          `forfeits ${who}${p.forfeited.moveName ?? 'the colliding move'}` +
            (p.forfeited.staminaRefunded ? ` (${p.forfeited.staminaRefunded} Stamina back)` : '')
        );
      }
      for (const sh of p.shifts ?? []) {
        parts.push(
          `${sh.moveName ?? 'a move'} slides to Tic ${sh.to - startTic + 1}` +
            (sh.leftRound ? ' — into the next round, Stamina refunded' : '')
        );
      }
      return parts.length ? `${parts.join('; ')}.` : 'The guard extended with nothing in its way.';
    }
    case 'automation_fired': {
      // The server sends already-rendered phrases and the trigger's own
      // display label, so this line and the Chat Log's can never describe
      // the same effect differently. The old version named neither the
      // move nor what actually happened — "an effect fired" is not a thing
      // anyone can act on.
      // `sourceName` since Perks fire through the same executor — it is a
      // move's name or a Perk's, whichever caused this. `moveName` is the
      // fallback for every replay stored before Perks existed (§0: a stored
      // event is never rewritten).
      const head = `${p.sourceName ?? p.moveName ?? 'A move'} — ${p.triggerLabel ?? p.trigger ?? 'effect'}`;
      const body = [p.text, (p.effects ?? []).join(', ')].filter(Boolean).join(' — ');
      return body ? `${head}: ${body}` : `${head} fired.`;
    }
    case 'next_roll_penalty': {
      // A debt, not a standing modifier — it is spent by the very next roll
      // that fighter makes and is then gone, so the line says "next roll"
      // rather than naming a duration. `pending` is the running total when
      // several have stacked up unpaid.
      const owed = p.pending ?? p.amount ?? 0;
      const tail = owed > (p.amount ?? 0) ? ` (${owed} owed in all)` : '';
      return `${who} is rattled — −${p.amount ?? 0} on their next roll, whatever it turns out to be${tail}.`;
    }
    case 'stamina_changed':
      return `${who} ${p.delta < 0 ? 'spends' : 'recovers'} ${Math.abs(p.delta ?? 0)} Stamina — now ${p.currentStamina}/${p.maxStamina}.`;
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
        // Same decomposition as the sentence above — "d4 -> 14" was not just
        // confusing but impossible, since 14 was the post-modifier total.
        lines.push(
          p.dice
            .map((d) => {
              const { flat, raw, result } = decomposeRoll(d);
              const slot = d.slot_name ?? d.slotName;
              return flat === 0
                ? `${slot}: d${d.size} rolled ${result}`
                : `${slot}: d${d.size} rolled ${raw}, ${flat > 0 ? '+' : '−'}${Math.abs(flat)} → ${result}`;
            })
            .join('\n')
        );
      }
      // One line per named modifier, so the hover detail accounts for the total
      // in full. Falls back to the bare number when the roll predates the
      // itemised payload (stored replays are never rewritten — §0).
      if (Array.isArray(p.modifierBreakdown) && p.modifierBreakdown.length) {
        for (const t of p.modifierBreakdown) {
          lines.push(`${t.label}: ${t.amount > 0 ? '+' : '−'}${Math.abs(t.amount)}`);
        }
      } else if (p.modifier) {
        lines.push(`Modifier: ${p.modifier > 0 ? '+' : ''}${p.modifier}, applied once to the total`);
      }
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
    case 'moves_displaced':
      lines.push(
        p.phase === 'startup'
          ? 'Caught in Startup: the wind-up gets longer, so the move is delayed'
          : p.phase === 'in-flight'
            ? 'Caught mid-Active or mid-Recovery: the frames go on the end'
            : 'Caught between moves: there is no move to lengthen, so the cost is the delay'
      );
      lines.push('Applied at this Tic, not book-kept for later');
      lines.push('Everything declared after it slides by the same amount, so nothing overlaps');
      break;
    case 'insignificant_damage':
      lines.push('Under 5 on the roll: fewer than one Half-Damage step');
      lines.push('It connected, so this fires On Hit');
      lines.push('Not a Miss — a Miss is an attack evaded by a Dodge');
      break;
    case 'grapple_resolved':
      if (p.reason === 'dodged') {
        lines.push('A Dodge can evade a grab; a Block cannot');
        lines.push('Evaded before any dice — there was no contest to roll');
        lines.push('Fires On Miss: a Miss is an attack the target got out of the way of');
      } else if (p.success) {
        lines.push(`Cleared its Threshold of ${p.threshold} AND beat the target`);
        lines.push(`Went ${p.direction ?? 'nowhere'} — the direction the grappler picked`);
        lines.push('The target now rolls at -2 while this grab\'s Active frames run');
      } else if (p.reason === 'below-threshold') {
        lines.push(`Under its own Threshold of ${p.threshold} — fumbled outright`);
        lines.push('Nothing fires, and nothing was ever created to undo');
      } else {
        lines.push('Cleared its Threshold but lost the contest — ties go to the target');
        lines.push('Nothing fires, and nothing was ever created to undo');
      }
      break;
    case 'grapple_prompt':
      lines.push('The grappler picks a direction; the target guesses it');
      lines.push('Both answer before anything is rolled — the read is on a blind grab');
      lines.push('Whoever read the other correctly takes +5 into the contest');
      break;
    case 'grapple_guessed':
      lines.push(p.guessOutcome === 'right' ? 'Read correctly: +5 to the target' : 'Read wrong: +5 to the grappler');
      lines.push('Applied to the total, never per die');
      break;
    case 'grapple_chained':
      lines.push('Declared by the engine, not the player — the grab won');
      lines.push('Sits next in line after the grab; the round\'s clock is untouched');
      break;
    case 'no_damage_resolved':
      lines.push('Tagged No Damage: it never deals damage, whatever it rolls');
      lines.push(
        p.succeeded
          ? 'It reached its Threshold, so this fires On Hit'
          : 'It fell short of its Threshold, so nothing fires'
      );
      lines.push('Not a Miss either way — a Miss is an attack evaded by a Dodge');
      break;
    case 'damage_applied':
      if (p.result === 'no-eligible-target') break;
      if (p.source === 'automation') {
        lines.push(statStepDetail(p));
        break;
      }
      lines.push(`${(p.steps ?? 0) * 0.5} damage`);
      break;
    case 'damage_unapplied':
      lines.push(`${p.damage ?? 0} damage, unapplied`);
      lines.push(`${p.slotName ?? 'That Stat'} is incapacitated — consider it for Injuries`);
      break;
    case 'damage_shrugged':
      lines.push(`Minimum Damage Threshold on that Stat: ${p.threshold ?? '?'}`);
      if (p.baseThreshold != null && p.surcharge != null) {
        lines.push(`${p.baseThreshold} for the exchange, +${p.surcharge} for that Stat alone`);
      }
      lines.push('Nothing landed, so nothing is owed — this is not an Injury');
      break;
    case 'weapon_durability':
      lines.push('Using a weapon in a Move costs 1 Durability');
      lines.push(p.destroyed ? 'That was the last of it' : `${p.durability ?? 0} left`);
      break;
    case 'weapon_target':
      if (!p.armed) {
        lines.push('A Weapon attack against an unarmed fighter falls on a random arm');
        break;
      }
      lines.push(`${p.attackerResult ?? '?'} against the weapon's ${p.weaponResult ?? '?'}`);
      lines.push(p.destroyed ? 'Beaten outright — the weapon is gone' : 'A tie holds, so the weapon stands');
      break;
    case 'stat_stepped':
      lines.push(statStepDetail(p));
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
      // The bar was already standing there as a `???` wind-up; the real move
      // drops onto it. Same beat as the Stamina flash above it.
      if (p.declaredMoveId != null) out.byMoveId[p.declaredMoveId] = 'drop';
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
    case 'grapple_resolved':
      if (p.declaredMoveId != null) out.byMoveId[p.declaredMoveId] = p.success ? 'attack' : 'fizzle';
      out.burst = p.success
        ? { kind: 'heavy', label: 'GRAB', sub: p.chainedMoveName ?? '', seq: ev.seq }
        : { kind: 'fizzle', label: p.reason === 'dodged' ? 'Slipped' : 'No hold', seq: ev.seq };
      break;
    case 'no_damage_resolved':
      // A success is a real beat even with no damage behind it — it gets the
      // attack treatment. A failure fizzles, same as Insignificant Damage.
      if (p.declaredMoveId != null) out.byMoveId[p.declaredMoveId] = p.succeeded ? 'attack' : 'fizzle';
      out.burst = p.succeeded
        ? { kind: 'hit', label: `${p.total}`, sub: `vs ${p.threshold}`, seq: ev.seq }
        : { kind: 'fizzle', label: 'Failed', seq: ev.seq };
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
    case 'stat_stepped': {
      // Deliberately NOT the hit treatment. Nothing struck anybody — a move's
      // interaction moved a Stat, and half of those move it upward. The card
      // reacts so the change is visible, and the burst names the Stat and the
      // direction instead of quoting a damage figure.
      const steps = p.steps ?? 0;
      if (steps === 0) break;
      // Only a downward step shakes the card. A restore is announced by the
      // burst and by the pip's own value change — there is no blow to land.
      if (steps > 0 && p.characterId != null) out.byCharacterId[p.characterId] = 'hit';
      out.burst = {
        kind: steps > 0 ? 'hit' : 'fizzle',
        label: `${steps > 0 ? '−' : '+'}${Math.abs(steps)}`,
        sub: p.slotName ?? '',
        seq: ev.seq,
      };
      break;
    }
    case 'dodge_resolved':
      if (p.outcome === 'successful') out.burst = { kind: 'miss', label: 'MISS', seq: ev.seq };
      break;
    case 'moves_displaced': {
      // Every bar that moved slides into its new place. The lengthened one
      // gets it too — it did not move, but its shape changed at the same
      // instant, and animating only some of the affected bars reads as a
      // glitch rather than as one event.
      for (const id of p.shiftedDeclaredMoveIds ?? []) out.byMoveId[id] = 'displaced';
      if (p.affectedDeclaredMoveId != null) out.byMoveId[p.affectedDeclaredMoveId] = 'displaced';
      out.burst = { kind: 'fizzle', label: `+${p.tics ?? 0}`, sub: 'Recovery', seq: ev.seq };
      break;
    }
    case 'move_conflict_resolved':
      // The other place a move is pushed later — a Postpone past a Block's
      // extended Recovery. Same thing happening, so the same animation:
      // "moved later" should look like one gesture in this game, not two.
      if (p.choice === 'postpone' && p.declaredMoveId != null) {
        out.byMoveId[p.declaredMoveId] = 'displaced';
      }
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

// The fighters in this round and the state of their dice at the playhead.
// Built from the same event stream everything else is (§0) — the `roster`
// event captures them as the round opened, and every damage_applied since
// steps the die it hit. That is what makes a replay show the same fight
// deteriorating in the same order, years after the real dice moved on.
const DIE_ORDER = ['Skull', 'Brain', 'Left Hand', 'Right Hand', 'Body', 'Stamina', 'Left Leg', 'Right Leg'];

function fightersFrom(events, upTo) {
  let roster = null;
  const damage = new Map(); // `${characterId}:${slotName}` -> latest applied state
  const stamina = new Map(); // characterId -> current stamina at the playhead
  // **Temporary Damage, accumulated along the playhead.** Half-steps owed back
  // on each Stat, so the pip can draw purple at the moment the blow lands rather
  // than reading a debt that has since been paid off. Seeded from the roster
  // snapshot (what was already owed when the Round opened), added to by a
  // `temporary` damage_applied, and paid down by the heal's own `stat_stepped`.
  const temporary = new Map(); // `${characterId}:${slotName}` -> half-steps owed
  let lastHit = null;
  for (const ev of events.slice(0, upTo)) {
    if (ev.type === 'roster') {
      roster = ev.payload?.participants ?? [];
      for (const f of roster) {
        for (const d of f.dice ?? []) {
          if (d.temporarySteps > 0) temporary.set(`${f.characterId}:${d.slotName}`, d.temporarySteps);
        }
      }
      continue;
    }
    // Stamina moves during a round — automations spend it, an Interrupt
    // refunds half, an idle Tic gives one back. Both events carry the
    // resulting value rather than only a delta, so the card lands on the
    // real number even if a clamp at 0/Max ate part of the change.
    if (ev.type === 'stamina_changed' || ev.type === 'stamina_regen') {
      const p = ev.payload ?? {};
      if (p.characterId != null && p.currentStamina != null) stamina.set(p.characterId, p.currentStamina);
      continue;
    }
    // A Stat moved because an automation said so. It lands on the cards
    // exactly like damage does — the pip has to show the new die either way —
    // but only a DOWNWARD step counts as a `lastHit`, which is what drives the
    // red flash. Flashing a Stat that was just restored would read as being
    // hurt by being healed.
    if (ev.type === 'stat_stepped') {
      const p = ev.payload ?? {};
      if (p.slotName == null || p.characterId == null) continue;
      damage.set(`${p.characterId}:${p.slotName}`, {
        size: p.sizeAfter,
        bonus: p.bonusAfter,
        status: p.statusAfter,
      });
      // The end-of-Round Temporary Damage heal rides this same event type, and
      // says so — a Recover Stat automation must not pay down the purple. The
      // server sends what is left, so the client never has to subtract.
      if (p.source === 'temporary_heal') {
        temporary.set(`${p.characterId}:${p.slotName}`, Math.max(0, p.temporaryRemaining ?? 0));
      }
      if ((p.steps ?? 0) > 0) {
        lastHit = { characterId: p.characterId, slotName: p.slotName, seq: ev.seq, steps: p.steps };
      }
      continue;
    }
    if (ev.type !== 'damage_applied') continue;
    const p = ev.payload ?? {};
    if (p.slotName == null || p.targetCharacterId == null) continue;
    damage.set(`${p.targetCharacterId}:${p.slotName}`, {
      size: p.sizeAfter,
      bonus: p.bonusAfter,
      status: p.statusAfter,
    });
    if (p.temporary) {
      const key = `${p.targetCharacterId}:${p.slotName}`;
      temporary.set(key, (temporary.get(key) ?? 0) + (p.steps ?? 0));
    }
    // Same rule for a stored replay's automation steps, which predate
    // `stat_stepped` and can also be negative.
    if (!(p.source === 'automation' && (p.steps ?? 0) < 0)) {
      lastHit = { characterId: p.targetCharacterId, slotName: p.slotName, seq: ev.seq, steps: p.steps ?? 0 };
    }
  }
  if (!roster) return { fighters: [], lastHit: null };
  const fighters = roster.map((f) => ({
    ...f,
    currentStamina: stamina.get(f.characterId) ?? f.currentStamina,
    dice: [...(f.dice ?? [])]
      .map((d) => {
        const key = `${f.characterId}:${d.slotName}`;
        return {
          ...d,
          ...(damage.get(key) ?? {}),
          // The roster snapshot's own figure is the floor: a Stat can walk into
          // the Round already owing half a step from the Round before.
          temporarySteps: temporary.has(key) ? temporary.get(key) : (d.temporarySteps ?? 0),
        };
      })
      .sort((a, b) => DIE_ORDER.indexOf(a.slotName) - DIE_ORDER.indexOf(b.slotName)),
  }));
  return { fighters, lastHit };
}

// Playback walks BEATS, not events. A beat is either "the clock reached
// Tic N" or "this event happened". Before this, the playhead was simply the
// last revealed event's Tic, so a round with nothing at Tics 4-6 jumped
// straight from 3 to 7 and the quiet stretch of a fight — which is most of
// it — never happened on screen. Time passing is part of what a Tic
// timeline is for.
//
// Tic beats stop at the last Tic any event actually landed on. In live mode
// that is the furthest the server has resolved, so playback walks up to the
// present and waits there rather than racing ahead into Tics that have not
// happened yet; in replay the round's own `round_complete` sits on the last
// Tic, so the whole round is covered.
function beatsFrom(events, startTic) {
  if (!events.length) return [];
  const byTic = new Map();
  let maxTic = startTic;
  for (const ev of events) {
    const t = Math.max(startTic, ev.tic ?? startTic);
    if (!byTic.has(t)) byTic.set(t, []);
    byTic.get(t).push(ev);
    if (t > maxTic) maxTic = t;
  }
  const beats = [];
  for (let t = startTic; t <= maxTic; t++) {
    beats.push({ kind: 'tic', tic: t });
    for (const ev of byTic.get(t) ?? []) beats.push({ kind: 'event', tic: t, ev });
  }
  return beats;
}

function footprintsFrom(events, upTo) {
  const out = [];
  // A move gets ONE bar for its whole life. It enters as an anonymous
  // wind-up, becomes itself at its reveal, and may end struck out — each of
  // those replaces the bar in place rather than adding another beside it,
  // which is what keeps the row from multiplying and what makes the reveal
  // read as the same object filling in.
  const slotOf = new Map();
  const put = (fp) => {
    const id = fp.declaredMoveId;
    if (id != null && slotOf.has(id)) {
      out[slotOf.get(id)] = fp;
      return;
    }
    if (id != null) slotOf.set(id, out.length);
    out.push(fp);
  };
  for (const ev of events.slice(0, upTo)) {
    // A declared move that hasn't revealed yet. The payload has no move
    // identity in it at all (see the server's emitWindups), and no Active or
    // Recovery lengths — so the footprint is closed off at the reveal Tic,
    // which makes phaseAt draw exactly the Startup run and nothing beyond
    // it. No special-casing in the renderer: it's an ordinary footprint that
    // happens to end where the unknown begins.
    if (ev.type === 'windup') {
      const p = ev.payload;
      put({ ...p, windup: true, activeEndTic: p.revealTic, recoveryEndTic: p.revealTic });
      continue;
    }
    // A carryover carries the identical footprint payload a reveal does —
    // it IS a move on this round's board, just one that started earlier.
    if (ev.type === 'reveal' || ev.type === 'carryover') {
      put({ ...ev.payload });
      continue;
    }
    // An Interrupted move is the one thing on the board that never revealed:
    // it dies in Startup, so no reveal event ever described it. Its wind-up
    // bar is already standing; this replaces it with the full footprint it
    // had reserved, struck through (below). Only when the interrupt actually
    // landed: a survived attempt leaves the move secret and intact, and
    // striking out a move that is still coming would be a lie.
    if (ev.type === 'interrupt_resolved' && ev.payload?.interrupted) {
      put({ ...ev.payload, interrupted: true });
      continue;
    }
    // Recovery imposed on the clock (see planImposedRecovery server-side):
    // one move grows or is delayed and everything that character had after it
    // slides. Applied as DELTAS rather than absolute Tics on purpose — the
    // payload deliberately carries only ids and a Tic count, because a
    // still-unrevealed move's Active/Recovery lengths are secret and a
    // round_event is replayed to everyone. Shifting by a delta needs no more
    // than that, and a wind-up bar (whose ends are pinned to its reveal Tic)
    // stays correctly closed off because all four numbers move together.
    if (ev.type === 'moves_displaced') {
      const p = ev.payload ?? {};
      const by = p.tics ?? 0;
      const shift = (fp) => {
        fp.placementTic += by;
        fp.revealTic += by;
        fp.activeEndTic += by;
        fp.recoveryEndTic += by;
        if (fp.recoveryExtendedFromTic != null) fp.recoveryExtendedFromTic += by;
      };
      for (const id of p.shiftedDeclaredMoveIds ?? []) {
        const at = slotOf.get(id);
        if (at != null && out[at]) shift(out[at]);
      }
      const hitAt = slotOf.get(p.affectedDeclaredMoveId);
      const hitFp = hitAt == null ? null : out[hitAt];
      if (hitFp && p.phase === 'startup') {
        // The wind-up genuinely started where it started; only everything
        // after it moves. placementTic deliberately stays put.
        hitFp.revealTic += by;
        hitFp.activeEndTic += by;
        hitFp.recoveryEndTic += by;
        if (hitFp.recoveryExtendedFromTic != null) hitFp.recoveryExtendedFromTic += by;
      } else if (hitFp && p.phase === 'in-flight') {
        // Same treatment a late Block's extension already gets: the extra
        // Tics keep the phase but render dimmed, so "declared Recovery" and
        // "Recovery somebody put on me" are visibly different runs.
        hitFp.recoveryExtendedFromTic = Math.min(
          hitFp.recoveryExtendedFromTic ?? Infinity,
          hitFp.recoveryEndTic
        );
        // Same dimmed-extension treatment a late Block already gets, but NOT
        // the same colour: a Block's extension is the guard being held, so it
        // is drawn in the defence green. These Tics are Recovery somebody
        // else put on you, so they are drawn in Recovery blue.
        hitFp.recoveryExtendedKind = 'imposed';
        hitFp.recoveryEndTic += by;
        // **Trip frames, folded in as a delta like everything else here.**
        // Only the in-flight case produces any — the Startup case puts the
        // Tics into the wind-up and the idle case draws nothing at all (see
        // planImposedRecovery server-side) — which is why this sits in this
        // branch rather than above the phase test. Accumulated, not assigned:
        // a fighter tripped twice in one round is on the floor for the sum.
        if (p.trip) {
          hitFp.tripRecoveryTics = (hitFp.tripRecoveryTics ?? 0) + by;
        }
      }
      continue;
    }
    // A cascade is the other way a move ends up later on the clock, and its bar
    // used to stay exactly where it was — the log said "postponed to Tic 6"
    // while the picture still showed it on Tic 3. Shifted by the delta between
    // old and new placement so a wind-up bar's closed-off ends move with it
    // (see the moves_displaced block above for why deltas).
    // The cascade moves a LIST now, not one move (decision #4). Same delta
    // arithmetic per entry; a pre-#4 replay still carries the single-move shape
    // and is normalised into a one-entry list rather than dropped (§0).
    if (ev.type === 'move_conflict_resolved') {
      const p = ev.payload ?? {};
      const moved =
        p.shifts ??
        (p.choice === 'postpone' && p.newPlacementTic != null
          ? [{ declaredMoveId: p.declaredMoveId, to: p.newPlacementTic }]
          : []);
      for (const sh of moved) {
        const at = slotOf.get(sh.declaredMoveId);
        const fp = at == null ? null : out[at];
        if (!fp || sh.to == null) continue;
        const by = sh.to - fp.placementTic;
        if (by) {
          fp.placementTic += by;
          fp.revealTic += by;
          fp.activeEndTic += by;
          fp.recoveryEndTic += by;
          if (fp.recoveryExtendedFromTic != null) fp.recoveryExtendedFromTic += by;
        }
      }
      continue;
    }
    if (ev.type !== 'recovery_extended') continue;
    const slot = slotOf.get(ev.payload?.declaredMoveId);
    const fp = slot == null ? null : out[slot];
    if (!fp) continue;
    fp.recoveryEndTic = ev.payload.recoveryEndTic;
    fp.recoveryExtendedKind = 'defense';
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

// The reveal itself: the move drops onto the row it had been holding open
// as an anonymous wind-up, lands hard, and settles. Deliberately vertical
// and deliberately unlike `attack` (which commits sideways toward the
// opponent) — this is the move arriving, not the move doing anything yet.
const DROP_VARIANT = {
  y: [-34, 0, -5, 0],
  scaleY: [1.18, 0.82, 1.05, 1],
  opacity: [0, 1, 1, 1],
  transition: { duration: 0.44, times: [0, 0.45, 0.72, 1], ease: 'easeIn' },
};

// Pushed later on the clock. The cells have already been redrawn one Tic
// further right by the time this runs, so the bar arrives from where it used
// to be and settles — the motion IS the displacement, read left to right the
// same way the timeline is. Deliberately not a hit or a flinch: nothing
// struck this move, it simply lost its place in the queue.
const DISPLACED_VARIANT = {
  x: [-22, 5, 0],
  opacity: [0.55, 1, 1],
  transition: { duration: 0.42, times: [0, 0.65, 1], ease: 'easeOut' },
};

function barAnimation(effect, toward) {
  switch (effect) {
    case 'drop':
      return DROP_VARIANT;
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
    case 'displaced':
      return DISPLACED_VARIANT;
    default:
      return { x: 0, y: 0, scale: 1, opacity: 1 };
  }
}

// One fighter, with every Stat they have. The theater window used to be a
// small board over a short log and then a great deal of nothing; a hit
// landing "on Body" meant nothing without a Body to watch it land on. The
// die that just took damage flashes red and its value counts down to what
// it stepped to, so damage is something you SEE happen to a person rather
// than a sentence in a feed.
function StatPip({ die, hit, beat }) {
  const reduceMotion = useReducedMotion();
  const out = die.status === 'incapacitated';
  // **Temporary Damage draws purple** — the same rule as every other surface
  // that shows a Stat (see tintFor in lib/dice.js). A hit still wins the
  // colouring for the beat it lands on: what just happened is the more urgent
  // fact, and the purple is still there a moment later.
  const temporary = temporarySteps(die) > 0;
  const Icon = ANATOMY[die.slotName]?.Icon;
  const controls = useAnimation();
  useEffect(() => {
    if (!hit || reduceMotion) return;
    controls.set({ scale: 1 });
    controls.start({
      scale: [1, 1.45, 0.92, 1],
      transition: { duration: 0.6, times: [0, 0.2, 0.6, 1], ease: 'easeOut' },
    });
  }, [hit, beat, controls, reduceMotion]);
  return (
    <motion.div
      animate={controls}
      title={[
        `${die.slotName} — d${die.size}${die.bonus ? `+${die.bonus}` : ''}${out ? ' (out)' : ''}`,
        temporaryDamageTitle(die),
      ]
        .filter(Boolean)
        .join('\n')}
      className={`flex min-w-0 flex-col items-center gap-0.5 border px-1 py-0.5 ${
        hit
          ? 'border-rose-400 bg-rose-900/50 shadow-[0_0_12px_2px_rgba(251,113,133,0.6)]'
          : temporary
            ? 'border-fuchsia-800/70 bg-fuchsia-950/40'
            : out
              ? 'border-zinc-800 bg-zinc-900/60'
              : 'border-zinc-700 bg-zinc-900'
      }`}
    >
      {/* The Stat's own icon beside its name (decided, new). Eight pips of
          four-letter words are a wall of text at a glance; the icon is what
          makes "they went for the legs" readable without reading. Reuses
          ANATOMY, the same map the Core Stats figure and the damage dialog
          draw from, so a Skull is the same Skull everywhere. */}
      <span className={`flex min-w-0 items-center gap-0.5 font-display text-[9px] uppercase tracking-wide md:text-[10px] ${
        hit ? 'text-rose-200' : temporary ? 'text-fuchsia-300' : out ? 'text-zinc-600' : 'text-zinc-500'
      }`}>
        {Icon && <Icon size={9} aria-hidden="true" className="shrink-0 opacity-80" />}
        <span className="truncate">{die.slotName}</span>
      </span>
      <span className={`font-display text-xs font-bold md:text-sm ${
        out
          ? 'text-zinc-600 line-through'
          : hit
            ? 'text-rose-200'
            : temporary
              ? 'text-fuchsia-200'
              : 'text-zinc-200'
      }`}>
        {out ? 'OUT' : `d${die.size}${die.bonus ? `+${die.bonus}` : ''}`}
      </span>
    </motion.div>
  );
}

function FighterCard({ fighter, lastHit, beat }) {
  const hitSlot = lastHit?.characterId === fighter.characterId ? lastHit.slotName : null;
  return (
    <div className="panel-cut-sm min-w-0 flex-1 border border-zinc-800 bg-zinc-950/70 p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-zinc-700 bg-zinc-800 font-display text-sm text-zinc-300">
          {(fighter.name ?? '?').charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-display text-sm uppercase tracking-wide text-zinc-200 md:text-base">
          {fighter.name}
        </span>
        <span className="shrink-0 font-display text-xs text-amber-300 md:text-sm">
          {fighter.currentStamina}/{fighter.maxStamina} ST
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {fighter.dice.map((d) => (
          <StatPip key={d.slotName} die={d} hit={hitSlot === d.slotName} beat={beat} />
        ))}
      </div>
    </div>
  );
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
  // A move knocked out of its own Startup. It still occupies the row — that
  // is the entire point of drawing it — but as a wreck: no phase colours, no
  // animation, struck through, and dimmed below every live bar around it.
  const dead = Boolean(fp.interrupted);
  // Declared, winding up, not yet revealed. Its footprint is closed off at
  // the reveal Tic (see footprintsFrom), so the row shows the Startup run
  // and stops — the shape of the unknown is exactly as much as anyone is
  // entitled to see before the move comes out.
  const windup = Boolean(fp.windup);

  // Driven off `beat` (the seq of the event that caused this effect), not
  // off `effect` alone: two attacks in a row are the same target values, and
  // Framer only re-runs when the values change — so without the seq the
  // second punch would simply not animate.
  useEffect(() => {
    // A struck-out move doesn't flinch, lunge or guard: it isn't happening.
    // It would otherwise pick up its owner's own being-hit shake, since that
    // is keyed by character and this bar still belongs to one.
    if (!effect || reduceMotion || dead) return;
    controls.set({ x: 0, y: 0, scale: 1, opacity: 1 });
    controls.start(barAnimation(effect, toward));
  }, [effect, beat, toward, controls, reduceMotion, dead]);

  return (
    <motion.div
      className={`relative flex items-center gap-2 ${dead ? 'opacity-60' : ''}`}
      animate={controls}
    >
      <span
        className={`w-24 shrink-0 truncate text-right font-display text-xs uppercase tracking-wide md:w-36 md:text-sm ${
          dead ? 'text-zinc-500 line-through' : 'text-zinc-400'
        }`}
      >
        {fp.characterName}
      </span>
      {/* **The same width as the Tic strip below, exactly** (decided, and this
          reverses the fixed-width note that stood here). The cells were pinned
          to the Tic Counter's own 44px square while the strip beneath them grew
          to fill the board — so the two rulers stopped lining up, and a bar
          claiming Tics 1-3 no longer sat over the squares labelled 1, 2 and 3.
          Alignment is the whole content of this row.
          The concern the fixed size was answering — a Tic stretched into a slab
          that stops reading as a square — was about the STRIP; it is answered by
          the board being held to half the panel's width, and by these bars
          keeping their short height, which is what lets more moves fit.
          Matching the strip takes three things agreeing, not one: the same
          leading label width, the same gap, and **nothing after the cells** —
          the move's own name is taken out of flow on `md` and parked in the
          empty half-panel to the right of the board, because in flow it was
          eating 176px the strip below did not have to give up.
          Below `md` this all reverts to fixed cells: a phone's board is full
          width with no room beside it to park a name, and seven `flex-1` cells
          in 200px would be 25px each. */}
      <div className="relative flex shrink-0 gap-0.5 md:min-w-0 md:flex-1">
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
          const imposed = fp.recoveryExtendedKind === 'imposed';
          const defenseLabel = fp.defenseKind === 'dodge' ? 'Dodge' : 'Block';
          const extensionLabel = imposed ? 'Imposed Recovery' : `${defenseLabel} extension`;
          return (
            <span
              key={tic}
              title={
                phase
                  ? dead
                    ? `${fp.characterName} — Interrupted\nTic ${
                        tic - startTic + 1
                      }: ${PHASE_LABEL[phase]}, never happened`
                    : windup
                      ? `${fp.characterName} — winding something up\nTic ${
                          tic - startTic + 1
                        }: ${PHASE_LABEL[phase]}, reveals on Tic ${fp.revealTic - startTic + 1}`
                      : `${fp.characterName} — ${fp.moveName}\nTic ${tic - startTic + 1}: ${
                        extended ? extensionLabel : PHASE_LABEL[phase]
                      }${phase === 'defense' && !extended ? ` (${defenseLabel} window)` : ''}`
                  : undefined
              }
              className={`relative h-4 w-8 shrink-0 border border-zinc-900 md:h-5 md:w-auto md:min-w-0 md:flex-1 ${
                dead
                  ? // No phase colour: those say "this is happening," and it
                    // isn't. Grey says the Tics were claimed and then weren't.
                    phase
                    ? 'bg-zinc-600/60'
                    : 'bg-zinc-800/50'
                  : extended
                    ? // An imposed Tic that is also a trip Tic keeps the trip
                      // colour: it is dimmed because somebody else put it
                      // there, but it is still the floor — losing that here
                      // would leave the arrow sitting on ordinary blue.
                      PHASE_BG_EXTENDED[
                        imposed ? (isTripTic(fp, tic) ? 'trip_recovery' : 'recovery') : 'defense'
                      ]
                    : phase
                      ? PHASE_BG[phase]
                      : 'bg-zinc-800/50'
              } ${glowing && phase === 'defense' ? 'shadow-[0_0_14px_4px_rgba(125,211,252,0.85)]' : ''}`}
            >
              {/* The strike goes through the footprint itself, not just the
                  label — the bar is the thing that got cancelled. Drawn per
                  occupied cell rather than as one absolute span across the
                  row, so it needs no width arithmetic and can never drift
                  out of register with the cells; the 2px gaps read as one
                  continuous line. */}
              {dead && phase && (
                <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-300" />
              )}
              {/* **Trip Recovery wears a down arrow (decided, new).** The
                  darker blue alone is not enough: it is deliberately adjacent
                  to ordinary Recovery — because it *is* Recovery, just spent on
                  the floor — and two adjacent blues is exactly the distinction
                  that fails for anyone who cannot separate them. The arrow is
                  what actually carries it. Skipped on a dead cell, where the
                  move never happened and there is nothing to be on the floor
                  for. */}
              {!dead && isTripTic(fp, tic) && (
                <span
                  aria-hidden="true"
                  // Sized to be read, not to be technically present. The first
                  // version was 9px of blue-200 at 90% over a blue-800 cell —
                  // there, and invisible at any normal viewing distance, which
                  // is the same as not being there. Trip Recovery shares the
                  // blue family with ordinary Recovery on purpose, so this
                  // glyph is the entire distinction and has to win its cell.
                  className="pointer-events-none absolute inset-0 flex items-center justify-center font-display text-sm font-bold leading-none text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] md:text-base"
                >
                  {TRIP_MARK}
                </span>
              )}
            </span>
          );
        })}
      </div>
      {/* The move's name, and the Stamina it cost flashed beside it. The
          truncation lives on an INNER span on purpose: `truncate` is
          overflow-hidden, and with it on the outer element the cost number
          was clipped the moment it floated above the row — it read as being
          hidden behind the other rows. The outer element clips nothing, so
          the flash can rise out of the row, and z-50 puts it above every
          neighbouring bar and the impact burst. */}
      <span className="relative w-28 shrink-0 md:absolute md:inset-y-0 md:left-full md:ml-2 md:flex md:w-44 md:items-center">
        {/* An Interrupted move is labelled by what happened to it, not by
            what it was. It never reached its reveal Tic, and being destroyed
            early is not a reveal — the timing was always public, the
            identity stays the owner's (see Combat Timing's secrecy rule). */}
        <span
          className={`block truncate font-display text-xs md:text-base ${
            dead
              ? 'text-zinc-500 line-through'
              : windup
                ? 'tracking-widest text-zinc-500'
                : 'text-zinc-300'
          }`}
        >
          {dead ? 'Interrupted' : windup ? '???' : fp.moveName}
        </span>
        <AnimatePresence>
          {staminaFlash && fp.staminaCost > 0 && (
            <motion.span
              key="stam"
              initial={{ opacity: 0, y: 6, scale: 0.7 }}
              animate={{ opacity: [0, 1, 1, 0], y: -20, scale: 1.15 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, times: [0, 0.15, 0.6, 1] }}
              className="pointer-events-none absolute -top-1 left-0 z-50 whitespace-nowrap font-display text-sm font-bold text-amber-300 drop-shadow-[0_0_8px_rgba(252,211,77,0.95)] md:text-lg"
            >
              −{fp.staminaCost} Stamina
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </motion.div>
  );
}

// **Who a row's event belongs to.** The table files an event in the column of
// the fighter who ACTED — a punch appears in the puncher's column, not the
// column of whoever got hit — because the question the table answers is "what
// was each side doing on this Tic".
//
// Four ways to find them, in order of how certain each is:
//   1. `attackerCharacterId`, on the damage events, which name two fighters and
//      whose actor is specifically the attacker.
//   2. `characterId`, which every other event that names one fighter carries.
//      Where that fighter is the one something happened *to* (a Stat stepped by
//      somebody else's automation), their column is still where it goes — the
//      payload names no other, and a guess is worse than a consistent rule.
//   3. The declared move it is about, resolved through the footprints the board
//      is already tracking. This is what places a defence: `defense_resolved`
//      and its Block/Dodge siblings name no character at all, only the guard's
//      own declared move — and the guard belongs to the defender.
//   4. A name, for the two grapple prompts, which predate ids on these payloads.
//
// Anything still unattributed — the roster, the round ending — is genuinely
// about the whole round and gets a full-width row of its own.
function actorOf(ev, ownerOfMove, idByName) {
  const p = ev.payload ?? {};
  if (p.attackerCharacterId != null) return p.attackerCharacterId;
  if (p.characterId != null) return p.characterId;
  for (const key of ['defenderDeclaredMoveId', 'declaredMoveId', 'attackerDeclaredMoveId']) {
    const owner = p[key] != null ? ownerOfMove.get(p[key]) : null;
    if (owner != null) return owner;
  }
  for (const key of ['characterName', 'attackerCharacterName']) {
    const id = p[key] ? idByName.get(p[key]) : null;
    if (id != null) return id;
  }
  return null;
}

// One line in a side's cell: its icon, its type, and the sentence.
function EventLine({ ev, startTic }) {
  const paused = PAUSE_EVENTS.has(ev.type);
  const damage = ev.type === 'damage_applied';
  const faded =
    ev.type === 'insignificant_damage' ||
    ev.type === 'damage_unapplied' ||
    ev.type === 'damage_shrugged' ||
    (ev.type === 'no_damage_resolved' && !ev.payload?.succeeded) ||
    (ev.type === 'grapple_resolved' && !ev.payload?.success);
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18 }}
      title={eventDetail(ev, startTic)}
      className={`flex items-start gap-1.5 border-l-2 px-1.5 py-1 text-xs md:text-sm ${
        paused
          ? 'border-amber-500 bg-amber-950/30 text-amber-200'
          : damage
            ? 'border-rose-600 bg-rose-950/20 text-rose-200'
            : ev.type === 'grapple_resolved' && ev.payload?.success
              ? 'border-amber-600 bg-amber-950/20 text-amber-200'
              : faded
                ? 'border-zinc-700 text-zinc-500'
                : 'border-zinc-700 text-zinc-300'
      }`}
    >
      <EventIcon type={ev.type} className="mt-0.5" />
      <span className="min-w-0">
        {/* The words as well as the icon (decided). The icon is the glance;
            the label is what makes an unfamiliar icon legible the first time,
            and it costs one inline chip rather than the fixed column it used
            to sit in. */}
        <span className="mr-1.5 font-display text-[10px] uppercase tracking-wide text-zinc-500 md:text-xs">
          {EVENT_LABEL[ev.type] ?? ev.type}
        </span>
        {eventNarration(ev, startTic)}
      </span>
    </motion.div>
  );
}

export default function RoundCutscene({ resolutionId }) {
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState(null);
  // How many BEATS have played. Events revealed is derived from it — see
  // beatsFrom: a beat is either a Tic arriving or an event happening, and
  // the quiet Tics are beats too.
  const [visibleBeats, setVisibleBeats] = useState(0);
  const [error, setError] = useState(null);
  // **The Tic being studied, or null while it plays.** Clicking a Tic in the
  // counter stops the playhead and pins everything — stats, Stamina, the move
  // bars — to the state immediately BEFORE that Tic, which is the state the
  // fighters were actually looking at when they were caught by it.
  const [pinnedTic, setPinnedTic] = useState(null);
  // Whether the fighters' Stat cards are folded away — see the toggle in the
  // header. Read once at mount from localStorage, like the playback speed.
  const [statsCollapsed, setStatsCollapsed] = useState(loadCutsceneStatsCollapsed);
  // Read once per mount rather than subscribed: changing the setting
  // mid-cutscene and having the playhead lurch is worse than it taking
  // effect on the next round you open.
  const [speed] = useState(loadCutsceneSpeed);
  const proxy = useRef({ i: 0 });
  const tweenRef = useRef(null);
  const scrollRef = useRef(null);
  const rowRefs = useRef(new Map());

  useEffect(() => {
    if (!resolutionId) return undefined;
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
  }, [resolutionId]);

  const startTic = meta?.roundStartTic ?? 0;
  const length = meta?.roundLength ?? 7;
  const beats = useMemo(() => beatsFrom(events, startTic), [events, startTic]);

  // --- Playback: one tween from wherever the playhead is to the last beat.
  // Killed outright while a Tic is pinned — studying one Tic and having the
  // clock walk out from under you is the thing pinning exists to prevent.
  useEffect(() => {
    if (!beats.length || pinnedTic != null) return undefined;
    tweenRef.current?.kill();
    const remaining = beats.length - proxy.current.i;
    if (remaining <= 0) {
      setVisibleBeats(beats.length);
      return undefined;
    }
    tweenRef.current = gsap.to(proxy.current, {
      i: beats.length,
      duration: (remaining * SECONDS_PER_EVENT) / speed,
      ease: 'none',
      onUpdate: () => setVisibleBeats(Math.floor(proxy.current.i)),
      onComplete: () => setVisibleBeats(beats.length),
    });
    return () => tweenRef.current?.kill();
  }, [beats.length, speed, pinnedTic]);

  const skipToEnd = () => {
    tweenRef.current?.kill();
    proxy.current.i = beats.length;
    setPinnedTic(null);
    setVisibleBeats(beats.length);
  };

  const ticks = useMemo(
    () => Array.from({ length }, (_, i) => startTic + i),
    [startTic, length]
  );

  // **How far the playhead is for rendering purposes.** While pinned that is
  // the last beat BEFORE the pinned Tic began — everything the header draws is
  // derived from it, so pinning rewinds the stats, the Stamina and the move
  // bars together rather than only jumping the log.
  const beatsBefore = useMemo(() => {
    if (pinnedTic == null) return null;
    const at = beats.findIndex((b) => b.tic >= pinnedTic);
    return at < 0 ? beats.length : at;
  }, [beats, pinnedTic]);
  const effectiveBeats = beatsBefore ?? visibleBeats;

  const jumpToTic = useCallback((tic) => {
    tweenRef.current?.kill();
    setPinnedTic(tic);
    rowRefs.current.get(tic)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  const resume = () => {
    // Playback picks up from the pinned Tic rather than from wherever it had
    // got to: you stopped to look at this moment, so this is the moment the
    // round should carry on from.
    proxy.current.i = beatsBefore ?? proxy.current.i;
    setVisibleBeats(beatsBefore ?? visibleBeats);
    setPinnedTic(null);
  };

  // Keep the newest revealed row in view while playing, and never while pinned.
  useEffect(() => {
    if (pinnedTic != null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleBeats, pinnedTic]);

  // The beats played so far, and what they add up to. `visibleCount` (how
  // many EVENTS have been revealed) is derived from the beats rather than
  // driven directly — everything downstream still reasons in events.
  const playedBeats = beats.slice(0, effectiveBeats);
  const visibleCount = playedBeats.reduce((n, b) => n + (b.kind === 'event' ? 1 : 0), 0);
  const shown = events.slice(0, visibleCount);
  const footprints = footprintsFrom(events, visibleCount);
  const { fighters, lastHit } = fightersFrom(events, visibleCount);
  const fx = beatEffects(events, visibleCount);
  const effectFor = (fp) => fx.byMoveId[fp.declaredMoveId] ?? fx.byCharacterId[fp.characterId] ?? null;
  const playheadTic = pinnedTic ?? (playedBeats.length ? playedBeats[playedBeats.length - 1].tic : startTic);
  const isCaughtUp = visibleBeats >= beats.length && pinnedTic == null;

  // --- Who is on which side, and which fighter each event belongs to.
  //
  // The roster event carries every seated fighter's `side`, so the two action
  // columns are the pair's own two sides rather than a guess from character
  // type. Read from the WHOLE log, not from the played part: the columns are
  // the table's structure and must not reshuffle as the round plays.
  const roster = useMemo(
    () => events.find((e) => e.type === 'roster')?.payload?.participants ?? [],
    [events]
  );
  const sideById = useMemo(() => new Map(roster.map((f) => [f.characterId, f.side])), [roster]);
  const idByName = useMemo(() => new Map(roster.map((f) => [f.name, f.characterId])), [roster]);
  const ownerOfMove = useMemo(() => {
    const map = new Map();
    for (const ev of events) {
      const p = ev.payload ?? {};
      if (p.declaredMoveId != null && p.characterId != null) map.set(p.declaredMoveId, p.characterId);
    }
    return map;
  }, [events]);

  // One row per Tic, always — including the Tics where nothing happened, which
  // is most of them. That is what keeps clicking Tic 5 landing somewhere exact,
  // and it is what makes the table read as time passing at a constant rate
  // rather than as a list of highlights.
  const rows = useMemo(() => {
    const shownSet = new Set(shown.map((e) => e.seq));
    const byTic = new Map(ticks.map((t) => [t, { left: [], right: [], whole: [] }]));
    for (const ev of events) {
      if (!shownSet.has(ev.seq)) continue;
      const tic = Math.min(Math.max(ev.tic ?? startTic, startTic), startTic + length - 1);
      const bucket = byTic.get(tic);
      if (!bucket) continue;
      const actor = actorOf(ev, ownerOfMove, idByName);
      const side = actor != null ? sideById.get(actor) : null;
      if (side === 'left') bucket.left.push(ev);
      else if (side === 'right') bucket.right.push(ev);
      else bucket.whole.push(ev);
    }
    return ticks.map((tic) => ({ tic, ...byTic.get(tic) }));
  }, [events, shown, ticks, startTic, length, ownerOfMove, idByName, sideById]);

  const reachedTic = playedBeats.length ? playedBeats[playedBeats.length - 1].tic : startTic - 1;
  const nameOfSide = (side) =>
    roster.filter((f) => f.side === side).map((f) => f.name).join(' & ') || (side === 'left' ? 'Left' : 'Right');

  if (error) {
    return <div className="panel-cut border border-zinc-800 p-4 text-sm text-zinc-400">{error}</div>;
  }

  return (
    // **One scroll container, with the header sticky inside it.** The board and
    // the fighters used to sit above a separately-scrolling log, which meant two
    // nested scrollers and a header that only stayed put when the outer one
    // happened not to move. Now the whole cutscene scrolls and the header is
    // pinned to the top of it, so the Tic counter and the stats are in reach
    // from any row of a long round.
    <div ref={scrollRef} className="panel-cut h-full min-h-0 overflow-y-auto border border-zinc-800 bg-zinc-950/60">
      <div className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950 px-3 pb-2 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-display text-base uppercase tracking-wide text-zinc-300 md:text-xl">
            Round {meta?.roundNumber}
            <span className="ml-2 text-xs text-zinc-500 md:text-sm">replay</span>
          </h3>
          <div className="flex items-center gap-2">
            {pinnedTic != null && (
              <span className="panel-cut-sm bg-brand-700/40 px-2 py-1 font-display text-xs uppercase text-brand-200 md:text-sm">
                Holding at Tic {pinnedTic - startTic + 1}
              </span>
            )}
            {pinnedTic != null && (
              <button
                type="button"
                onClick={resume}
                className="panel-cut-sm border border-brand-600 px-3 py-1.5 font-display text-xs uppercase text-brand-200 hover:bg-brand-900/40 md:text-sm"
              >
                Resume
              </button>
            )}
            <button
              type="button"
              onClick={skipToEnd}
              disabled={isCaughtUp}
              className="panel-cut-sm border border-zinc-700 px-3 py-1.5 font-display text-xs uppercase text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 md:text-sm"
            >
              Skip to end
            </button>
            {/* **Fold the Stat cards away.** The frozen header carries the Tic
                counter, the move frames and both fighters' full Stat grids, and
                on a laptop that is most of the screen before one line of the log
                is visible. This leaves the Tics and the frames — the half you
                actually scroll the log against — and the cards come back with
                the same click. Per-viewer and remembered, like the playback
                speed: how much header you want is a property of the person
                watching. */}
            <button
              type="button"
              onClick={() => setStatsCollapsed((was) => saveCutsceneStatsCollapsed(!was))}
              title={statsCollapsed ? 'Show the fighters\' Stats' : 'Collapse to the Tics and frames'}
              aria-pressed={statsCollapsed}
              className="panel-cut-sm flex h-8 w-8 shrink-0 items-center justify-center border border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {statsCollapsed
                ? <ChevronsUpDown className="h-4 w-4" aria-hidden />
                : <ChevronsDownUp className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>

        {/* The board. `relative` so the impact burst can be centred over the
            whole thing rather than over one row. Held to half the width on a
            desktop, which is what lets the Tic counter's cells grow: a Tic you
            are meant to click has to be big enough to aim at. */}
        <div className="relative w-full md:w-1/2">
          <ImpactBurst burst={fx.burst} />

          <div className="mb-1 space-y-1">
            {footprints.filter((f) => f.characterType !== 'npc').map((fp) => (
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

          {/* The Tic strip. Every cell is a button: clicking one pins the
              round to the state just before that Tic and scrolls the table to
              its row. */}
          <div className="flex items-center gap-2 py-1">
            <span className="w-24 shrink-0 md:w-36" />
            <div className="flex min-w-0 flex-1 gap-0.5">
              {ticks.map((tic) => {
                const reached = tic <= reachedTic;
                return (
                  <motion.button
                    key={tic}
                    type="button"
                    onClick={() => jumpToTic(tic)}
                    animate={{ scale: tic === playheadTic ? 1.12 : 1 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                    title={`Tic ${tic - startTic + 1} — jump here and hold`}
                    className={`flex h-10 min-w-0 flex-1 items-center justify-center border font-display text-sm transition-colors md:h-14 md:text-lg ${
                      tic === playheadTic
                        ? 'border-brand-400 bg-brand-700/60 text-zinc-100'
                        : reached
                          ? 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-brand-600'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-700 hover:border-zinc-600'
                    }`}
                  >
                    {tic - startTic + 1}
                  </motion.button>
                );
              })}
            </div>
          </div>

          <div className="mt-1 space-y-1">
            {footprints.filter((f) => f.characterType === 'npc').map((fp) => (
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

        {/* The fighters, under the board and still inside the frozen header:
            "what is the state of everyone right now" is the question you ask
            from anywhere in a long round, so it travels with you. */}
        {fighters.length > 0 && !statsCollapsed && (
          <div className="mt-2 flex flex-wrap gap-2">
            {fighters.map((f) => (
              <FighterCard key={f.characterId} fighter={f} lastHit={lastHit} beat={fx.seq} />
            ))}
          </div>
        )}

        {/* The table's own column heading, inside the frozen block rather than
            at the top of the scrolling body — a second sticky element at the
            same offset simply slides under the first, which is exactly what it
            did. Whose column is whose is a fact you need at row forty as much as
            at row one. */}
        {/* **The two side columns split at the panel's exact centre.** They
            used to be `1fr 1fr` after the Tic column, which put the divider a
            couple of centimetres right of where the two Stat cards above it
            meet — two rules for the same "left side / right side" line, and the
            eye reads the mismatch long before it works out why. Sized off 50%
            minus the Tic column and half its gap instead, so the boundary lands
            dead centre whatever the panel's width. */}
        <div className="mt-2 grid grid-cols-[2.5rem_calc(50%_-_3.25rem)_1fr] gap-x-2 border-t border-zinc-800 pt-1 font-display text-[10px] uppercase tracking-wide text-zinc-500 md:grid-cols-[3.5rem_calc(50%_-_4.25rem)_1fr] md:text-xs">
          <span>Tic</span>
          <span className="truncate">{nameOfSide('left')}</span>
          <span className="truncate">{nameOfSide('right')}</span>
        </div>
      </div>

      {/* **The log as a table: a row per Tic, a column per side.** A flat
          chronological feed answered "what happened next" and never "what was
          each of them doing at Tic 4" — which is the question a fight actually
          raises. The Tic column is what the counter above scrolls to. */}
      <div className="px-3 pb-3">
        <AnimatePresence initial={false}>
          {rows.map((row) => {
            const reached = row.tic <= reachedTic;
            const empty = !row.left.length && !row.right.length && !row.whole.length;
            if (!reached && !empty) return null;
            return (
              <div
                key={row.tic}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.tic, el);
                  else rowRefs.current.delete(row.tic);
                }}
                className={`grid grid-cols-[2.5rem_calc(50%_-_3.25rem)_1fr] gap-x-2 border-b border-zinc-900 py-1 md:grid-cols-[3.5rem_calc(50%_-_4.25rem)_1fr] ${
                  row.tic === pinnedTic ? 'bg-brand-950/40' : ''
                } ${reached ? '' : 'opacity-40'}`}
              >
                <button
                  type="button"
                  onClick={() => jumpToTic(row.tic)}
                  title={`Hold at Tic ${row.tic - startTic + 1}`}
                  className={`self-start py-1 text-left font-display text-xs hover:text-brand-300 md:text-sm ${
                    row.tic === pinnedTic ? 'text-brand-300' : 'text-zinc-600'
                  }`}
                >
                  T{row.tic - startTic + 1}
                </button>
                <div className="min-w-0 space-y-1">
                  {row.left.map((ev) => (
                    <EventLine key={`${ev.resolutionId ?? resolutionId}-${ev.seq}`} ev={ev} startTic={startTic} />
                  ))}
                </div>
                <div className="min-w-0 space-y-1">
                  {row.right.map((ev) => (
                    <EventLine key={`${ev.resolutionId ?? resolutionId}-${ev.seq}`} ev={ev} startTic={startTic} />
                  ))}
                </div>
                {/* Events about the whole round rather than either fighter —
                    the roster, the round ending — span both columns instead of
                    being filed under somebody who did not do them. */}
                {row.whole.length > 0 && (
                  <div className="col-start-2 col-span-2 min-w-0 space-y-1">
                    {row.whole.map((ev) => (
                      <EventLine key={`${ev.resolutionId ?? resolutionId}-${ev.seq}`} ev={ev} startTic={startTic} />
                    ))}
                  </div>
                )}
                {empty && reached && (
                  <div className="col-start-2 col-span-2 px-1.5 py-1 font-display text-[10px] uppercase tracking-widest text-zinc-700 md:text-xs">
                    nothing lands
                  </div>
                )}
              </div>
            );
          })}
        </AnimatePresence>
        {!events.length && <div className="px-2 py-1 text-sm text-zinc-600 md:text-base">Loading…</div>}
      </div>
    </div>
  );
}

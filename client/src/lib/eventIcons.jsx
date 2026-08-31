import {
  Activity,
  ArrowBigDownDash,
  ArrowRightLeft,
  Ban,
  BatteryWarning,
  ChevronsRight,
  CircleDashed,
  CircleHelp,
  Clock,
  Flag,
  Grab,
  Hand,
  HeartCrack,
  Link2,
  MoveHorizontal,
  Shield,
  ShieldCheck,
  Sparkles,
  Swords,
  TrendingDown,
  Users,
  Wind,
  Zap,
  ZapOff,
} from 'lucide-react';

// **One icon per round-event type, so a Tic can be read at a glance.**
//
// The cutscene's log is a table now — a row per Tic, a column per side — and a
// cell holding four sentences is a paragraph, not a glance. The icon is what
// makes it scannable: you see a fist, a shield and a heart and know the shape
// of the exchange before reading a word of it.
//
// **Grouped by family, not invented per type.** Anything that is a blow landing
// is the same red-family icon; anything that is a guard is a shield; anything
// that costs or returns Stamina is a bolt. Thirty distinct pictograms would be
// thirty things to learn, and the sentence beside each one is still there —
// this is a scanning aid, exactly as the text label beside it always was.
//
// Colour is part of the encoding and matches the log's own row treatment: rose
// for damage, amber for a pause the round is waiting on, emerald for a guard
// that held, zinc for bookkeeping.
const ICONS = {
  // — the round's own frame —
  roster: { Icon: Users, tone: 'text-zinc-500' },
  round_complete: { Icon: Flag, tone: 'text-zinc-400' },

  // — a move's life on the clock —
  windup: { Icon: Clock, tone: 'text-zinc-500' },
  reveal: { Icon: Swords, tone: 'text-zinc-300' },
  carryover: { Icon: ChevronsRight, tone: 'text-zinc-500' },
  moves_displaced: { Icon: MoveHorizontal, tone: 'text-zinc-500' },
  recovery_extended: { Icon: Clock, tone: 'text-zinc-500' },
  move_fizzled: { Icon: Ban, tone: 'text-zinc-500' },

  // — rolling —
  roll: { Icon: Activity, tone: 'text-zinc-300' },
  next_roll_penalty: { Icon: TrendingDown, tone: 'text-zinc-400' },
  next_roll_bonus: { Icon: Sparkles, tone: 'text-zinc-300' },

  // — guards —
  defense_resolved: { Icon: Shield, tone: 'text-emerald-400' },
  block_prompt: { Icon: CircleHelp, tone: 'text-amber-300' },
  block_resolved: { Icon: ShieldCheck, tone: 'text-emerald-400' },
  dodge_prompt: { Icon: CircleHelp, tone: 'text-amber-300' },
  dodge_resolved: { Icon: Wind, tone: 'text-emerald-400' },
  move_conflict_prompt: { Icon: CircleHelp, tone: 'text-amber-300' },
  move_conflict_resolved: { Icon: ArrowRightLeft, tone: 'text-zinc-300' },

  // — grappling —
  grapple_prompt: { Icon: CircleHelp, tone: 'text-amber-300' },
  grapple_guessed: { Icon: Hand, tone: 'text-amber-200' },
  grapple_resolved: { Icon: Grab, tone: 'text-amber-300' },
  grapple_chained: { Icon: Link2, tone: 'text-amber-300' },
  grapple_chain_ended: { Icon: Ban, tone: 'text-zinc-500' },

  // — damage —
  damage_applied: { Icon: HeartCrack, tone: 'text-rose-400' },
  damage_unapplied: { Icon: CircleDashed, tone: 'text-zinc-600' },
  insignificant_damage: { Icon: CircleDashed, tone: 'text-zinc-600' },
  no_damage_resolved: { Icon: CircleDashed, tone: 'text-zinc-400' },
  interrupt_resolved: { Icon: ArrowBigDownDash, tone: 'text-rose-400' },
  stat_stepped: { Icon: TrendingDown, tone: 'text-rose-300' },
  weapon_target: { Icon: Swords, tone: 'text-zinc-300' },
  weapon_durability: { Icon: BatteryWarning, tone: 'text-zinc-400' },

  // — Stamina —
  stamina_changed: { Icon: ZapOff, tone: 'text-amber-300' },
  stamina_regen: { Icon: Zap, tone: 'text-emerald-400' },

  // — everything a move's own author wrote —
  automation_fired: { Icon: Sparkles, tone: 'text-brand-300' },
};

// A type nobody has drawn yet still gets a mark rather than a gap: the log has
// to render *something* for an event written by a newer version of the server
// than the client showing it, which is the same reason `automationLabel` keeps
// its fallback branch.
const FALLBACK = { Icon: CircleDashed, tone: 'text-zinc-600' };

export const eventIcon = (type) => ICONS[type] ?? FALLBACK;

// The icon itself, at the size the log draws it. `title` is deliberately not
// set here — the whole row already carries the event's hover detail, and a
// nested title would win over it on the one element you are most likely to be
// pointing at.
export function EventIcon({ type, className = '' }) {
  const { Icon, tone } = eventIcon(type);
  return <Icon size={14} aria-hidden="true" className={`shrink-0 ${tone} ${className}`} />;
}

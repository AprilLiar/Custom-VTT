import { Skull, Brain, HandFist, Zap, HeartPulse, Footprints } from 'lucide-react';

// Where each of the 8 dice sits, overlaid on the Vitruvian figure as three
// horizontal rows that mirror the original Head/Core/Legs pool grouping
// (2-4-2) rather than tracing the artwork point-for-point: Skull+Brain form
// a symmetric pair straddling the vertical midline (head row) **on the same
// two verticals as Stamina and Body below them** — they used to sit at
// 42%/58%, close enough that the two widgets' Stat-step arrows and
// Half-Damage toggles overlapped and fought for the same pixels; Left Hand,
// Stamina, Body, Right Hand share one row at the hands' height, showing
// they're one group (core row); Left Leg+Right Leg stay a symmetric pair at
// the spread stance (leg row). Extracted from CoreStatsTab.jsx (its original
// home) so the Damage Application dialog (Combat Automation, sub-phase 4 —
// see vttprojectplan.md) can reuse the exact same layout "read-mostly," per
// the plan, without a second copy of these pixel positions drifting out of
// sync with Tab 1's own.
export const ANATOMY = {
  Skull: { top: '11%', left: '36%', Icon: Skull },
  Brain: { top: '11%', left: '64%', Icon: Brain },
  'Left Hand': { top: '32%', left: '9%', Icon: HandFist },
  Stamina: { top: '32%', left: '36%', Icon: Zap },
  Body: { top: '32%', left: '64%', Icon: HeartPulse },
  'Right Hand': { top: '32%', left: '91%', Icon: HandFist },
  'Left Leg': { top: '90%', left: '32%', Icon: Footprints },
  'Right Leg': { top: '90%', left: '68%', Icon: Footprints },
};

// Where the Weapon sits (decided, new). Deliberately NOT in ANATOMY: every
// consumer of that map walks it expecting one die per entry, and a weapon is
// not a die — it has no Stat, no Half-Damage, no step arrows, and most
// characters do not have one at all.
//
// Bottom-right of the figure and clear of the body, on the outside of the
// right leg's vertical. Putting it on a hand would claim it belongs to the
// anatomy; sitting beside the figure says it is something the fighter is
// carrying, which is exactly what it is.
// Kept a little inside the figure's own right edge rather than flush with it:
// the widget is wider than a die (it carries an edit and a put-down control),
// and at 91% its controls sat hard against the panel's border.
export const WEAPON_SPOT = { top: '68%', left: '86%' };

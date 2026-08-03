import { Skull, Brain, HandFist, Zap, HeartPulse, Footprints } from 'lucide-react';

// Where each of the 8 dice sits, overlaid on the Vitruvian figure as three
// horizontal rows that mirror the original Head/Core/Legs pool grouping
// (2-4-2) rather than tracing the artwork point-for-point: Skull+Brain form
// a symmetric pair straddling the vertical midline (head row); Left Hand,
// Stamina, Body, Right Hand share one row at the hands' height, showing
// they're one group (core row); Left Leg+Right Leg stay a symmetric pair at
// the spread stance (leg row). Extracted from CoreStatsTab.jsx (its original
// home) so the Damage Application dialog (Combat Automation, sub-phase 4 —
// see vttprojectplan.md) can reuse the exact same layout "read-mostly," per
// the plan, without a second copy of these pixel positions drifting out of
// sync with Tab 1's own.
export const ANATOMY = {
  Skull: { top: '11%', left: '42%', Icon: Skull },
  Brain: { top: '11%', left: '58%', Icon: Brain },
  'Left Hand': { top: '32%', left: '9%', Icon: HandFist },
  Stamina: { top: '32%', left: '36%', Icon: Zap },
  Body: { top: '32%', left: '64%', Icon: HeartPulse },
  'Right Hand': { top: '32%', left: '91%', Icon: HandFist },
  'Left Leg': { top: '90%', left: '32%', Icon: Footprints },
  'Right Leg': { top: '90%', left: '68%', Icon: Footprints },
};

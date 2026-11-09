import { Wrench } from 'lucide-react';
import { WRENCH_LABEL } from '../lib/patd/homebrewSync.js';

// **The homebrew wrench (vttprojectplan.md, "Commit Homebrew").** Blue and
// filled: Claude automated it. Grey and filled: automated, but its wording
// changed since. Hollow: committed, waiting for Claude. Nothing: not committed.
const LOOK = {
  automated: { cls: 'text-sky-400', fill: 'currentColor' },
  stale: { cls: 'text-zinc-400', fill: 'currentColor' },
  waiting: { cls: 'text-zinc-300', fill: 'none' },
  // One part of an automated item, added since Claude's pass.
  new: { cls: 'text-zinc-500', fill: 'none' },
};
export const PART_LABEL = {
  automated: 'Automated by Claude',
  stale: 'Wording changed since Claude automated it',
  new: 'Added since Claude’s pass',
};

export default function HomebrewWrench({ state, size = 13, label = null, className = '' }) {
  const look = LOOK[state];
  if (!look) return null;
  const text = label ?? WRENCH_LABEL[state] ?? PART_LABEL[state];
  return (
    <span title={text} className={`inline-flex shrink-0 items-center ${look.cls} ${className}`} data-wrench={state}>
      <Wrench size={size} fill={look.fill} aria-label={text} role="img" />
    </span>
  );
}

export function WrenchLegend() {
  return (
    <ul className="space-y-0.5 text-[10px] text-zinc-500">
      {['automated', 'stale', 'waiting'].map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <HomebrewWrench state={s} size={11} />
          {s === 'automated' ? 'Automated' : s === 'stale' ? 'Automated, wording changed since' : 'Committed, not automated yet'}
        </li>
      ))}
      <li className="pl-[17px]">No wrench: not committed</li>
    </ul>
  );
}

import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import MovesCompendium from './Compendium.jsx';
import PerksCompendium from './PerksCompendium.jsx';

// GM-only page hosting every compendium as an internal tab, rather than a
// separate top-level nav link per type — add future compendia (e.g. a Tags-
// only view, if one's ever split out) as another entry here.
const TABS = [
  { key: 'moves', label: 'Moves' },
  { key: 'perks', label: 'Perks' },
];

export default function CompendiumPage() {
  const { role } = useRole();
  const location = useLocation();
  // The header search bar can deep-link here (e.g. a Perk result) via
  // navigate('/compendium', { state: { tab: 'perks' } }).
  const [tab, setTab] = useState(location.state?.tab === 'perks' ? 'perks' : 'moves');

  if (role !== 'gm') return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-1 border-b border-zinc-800">
        <h1 className="mr-4 text-2xl font-bold">Compendium</h1>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`whitespace-nowrap rounded-t-md px-4 py-2 text-sm font-semibold ${
              tab === t.key
                ? 'border-b-2 border-indigo-500 text-zinc-100'
                : 'text-zinc-600 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'moves' && <MovesCompendium />}
      {tab === 'perks' && <PerksCompendium />}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { search } from '../lib/api.js';

const GROUPS = [
  { key: 'characters', label: 'Characters' },
  { key: 'moves', label: 'Moves' },
  { key: 'perks', label: 'Perks' },
  { key: 'tells', label: 'Tells' },
  { key: 'tags', label: 'Tags' },
];

// Compendium entries (Moves/Perks/Tells/Tags) link to the Compendium page,
// which every role can browse (read-only for Players).
const COMPENDIUM_TAB = { moves: 'moves', perks: 'perks', tells: 'moves', tags: 'moves' };

export default function SearchBar() {
  const { role } = useRole();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const handle = setTimeout(() => {
      search(q).then(setResults).catch(console.error);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const goTo = (group, item) => {
    setOpen(false);
    setQuery('');
    if (group === 'characters') {
      navigate(`/character/${item.id}`);
      return;
    }
    navigate('/compendium', { state: { tab: COMPENDIUM_TAB[group] } });
  };

  const visibleResults = results && {
    ...results,
    characters:
      role === 'gm' ? results.characters : results.characters.filter((c) => c.character_type === 'pc'),
  };
  const hasAny = visibleResults && GROUPS.some((g) => visibleResults[g.key]?.length);

  return (
    <div ref={boxRef} className="relative w-64">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Search…"
        className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
      />
      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-y-auto panel-cut-sm border border-zinc-700 bg-zinc-900 shadow-xl">
          {!visibleResults ? (
            <p className="p-3 text-sm text-zinc-500">Searching…</p>
          ) : !hasAny ? (
            <p className="p-3 text-sm text-zinc-500">No matches.</p>
          ) : (
            GROUPS.map((g) => {
              const items = visibleResults[g.key] ?? [];
              if (!items.length) return null;
              return (
                <div key={g.key} className="border-b border-zinc-800 last:border-0">
                  <div className="px-3 pt-2 text-xs font-bold uppercase tracking-wide text-zinc-600">
                    {g.label}
                  </div>
                  {items.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => goTo(g.key, item)}
                      className="cursor-pointer px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{item.name}</span>
                        {g.key === 'characters' && item.character_type === 'npc' && (
                          <span className="panel-cut-sm bg-purple-600/30 px-1 text-[10px] font-bold uppercase text-purple-300">
                            NPC
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <div className="truncate text-xs text-zinc-500">{item.description}</div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

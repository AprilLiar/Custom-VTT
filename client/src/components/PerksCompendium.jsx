import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacters, getPerks } from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import PerkCard from './PerkCard.jsx';
import PerkCreator from './PerkCreator.jsx';

function GrantList({ perk, characters }) {
  return (
    <div className="mt-1 space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-2">
      {characters.map((c) => {
        const granted = perk.granted_character_ids.includes(c.id);
        return (
          <label key={c.id} className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 md:min-h-0">
            <input
              type="checkbox"
              checked={granted}
              onChange={() =>
                socket.emit(granted ? 'perk:revoke' : 'perk:grant', {
                  characterId: c.id,
                  perkId: perk.id,
                })
              }
            />
            {c.name}
            {c.character_type === 'npc' && (
              <span className="panel-cut-sm bg-purple-600/30 px-1 text-xs uppercase text-purple-300">npc</span>
            )}
          </label>
        );
      })}
      {characters.length === 0 && <p className="text-xs text-zinc-600">No characters yet.</p>}
    </div>
  );
}

// The Compendium page's Perks tab: persistent Perk library. Just picture/
// name/description per spec — no folders or style filter, unlike Moves.
// The page is open to every role (see CompendiumPage.jsx) — creation,
// editing, deleting, and granting are gated to role === 'gm' below; a
// Player gets a read-only browse of the same cards.
export default function PerksCompendium() {
  const { role } = useRole();
  const [perks, setPerks] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [form, setForm] = useState(null); // null | { perk? }
  const [grantOpen, setGrantOpen] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  useEffect(() => {
    const refreshAll = () => {
      getPerks().then(setPerks).catch(console.error);
      getCharacters().then(setCharacters).catch(console.error);
    };
    refreshAll();
    const events = [
      'perk:created', 'perk:updated', 'perk:deleted', 'perk:granted', 'perk:revoked',
      'character:created', 'character:updated', 'character:deleted',
    ];
    for (const ev of events) socket.on(ev, refreshAll);
    return () => {
      for (const ev of events) socket.off(ev, refreshAll);
    };
  }, []);

  if (!perks) return <p className="text-zinc-500">Loading…</p>;

  const submitPerk = (payload) => {
    if (form?.perk) socket.emit('perk:update', { perkId: form.perk.id, ...payload });
    else socket.emit('perk:create', payload);
    setForm(null);
  };

  const deletePerk = (perk) => {
    if (perk.granted_character_ids.length > 0) {
      window.alert('Revoke this Perk from everyone before deleting it.');
      return;
    }
    if (window.confirm(`Delete ${perk.name}?`)) socket.emit('perk:delete', { perkId: perk.id });
  };

  const onDropOnCharacter = (e, character) => {
    e.preventDefault();
    setDropTarget(null);
    const perkId = Number(e.dataTransfer.getData('text/perk-id'));
    if (perkId) socket.emit('perk:grant', { characterId: character.id, perkId });
  };

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        {role === 'gm' &&
          (form ? (
            <PerkCreator
              initial={form.perk ?? null}
              onSubmit={submitPerk}
              onCancel={() => setForm(null)}
            />
          ) : (
            <button
              onClick={() => setForm({})}
              className="panel-cut-sm bg-brand-600 px-4 py-2 font-semibold hover:bg-brand-500"
            >
              + New Perk
            </button>
          ))}

        {perks.length === 0 ? (
          <p className="text-sm text-zinc-600">No Perks yet — create the first one.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {perks.map((perk) => (
              <div
                key={perk.id}
                draggable={role === 'gm'}
                onDragStart={role === 'gm' ? (e) => e.dataTransfer.setData('text/perk-id', String(perk.id)) : undefined}
                title={role === 'gm' ? 'Drag onto a character to grant it' : undefined}
                className={role === 'gm' ? 'cursor-grab active:cursor-grabbing' : undefined}
              >
                <PerkCard
                  perk={perk}
                  actions={
                    role === 'gm' ? (
                      <>
                        <button
                          onClick={() => setGrantOpen(grantOpen === perk.id ? null : perk.id)}
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-brand-400 hover:bg-brand-900/40 md:min-h-0"
                        >
                          Grant… ({perk.granted_character_ids.length})
                        </button>
                        <button
                          onClick={() => setForm({ perk })}
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 md:min-h-0"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deletePerk(perk)}
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400 md:min-h-0"
                        >
                          Delete
                        </button>
                      </>
                    ) : null
                  }
                />
                {role === 'gm' && grantOpen === perk.id && <GrantList perk={perk} characters={characters} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {role === 'gm' && (
        <aside className="hidden w-44 shrink-0 md:block">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
            Drag a Perk here
          </h2>
          <div className="space-y-2">
            {characters.map((c) => {
              const src = portraitSrc(c);
              return (
                <div
                  key={c.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropTarget(c.id);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => onDropOnCharacter(e, c)}
                  className={`flex items-center gap-2 ink-panel border p-2 transition ${
                    dropTarget === c.id
                      ? 'border-brand-500 bg-brand-950/50'
                      : 'border-zinc-800 bg-zinc-900'
                  }`}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden panel-cut-sm bg-zinc-800 text-sm font-bold text-zinc-600">
                    {src ? (
                      <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      c.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <span className="truncate text-sm text-zinc-300">{c.name}</span>
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
}

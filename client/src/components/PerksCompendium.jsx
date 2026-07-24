import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacters, getMoves, getPerks, getTags } from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import PerkCard from './PerkCard.jsx';
import PerkCreator from './PerkCreator.jsx';

function GrantList({ perk, characters }) {
  return (
    <div className="mt-1 space-y-1 rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
      {characters.map((c) => {
        const granted = perk.granted_character_ids.includes(c.id);
        return (
          <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-300">
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
              <span className="rounded bg-purple-600/30 px-1 text-xs uppercase text-purple-300">npc</span>
            )}
          </label>
        );
      })}
      {characters.length === 0 && <p className="text-xs text-zinc-600">No characters yet.</p>}
    </div>
  );
}

// GM-only page: persistent Perk library. Just picture/name/description/
// automations per spec — no folders or style filter, unlike Moves.
export default function PerksCompendium() {
  const { role } = useRole();
  const [perks, setPerks] = useState(null);
  const [moves, setMoves] = useState(null);
  const [tags, setTags] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [form, setForm] = useState(null); // null | { perk? }
  const [grantOpen, setGrantOpen] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  useEffect(() => {
    if (role !== 'gm') return;
    const refreshAll = () => {
      getPerks().then(setPerks).catch(console.error);
      getMoves().then((d) => setMoves(d.moves)).catch(console.error);
      getTags().then(setTags).catch(console.error);
      getCharacters().then(setCharacters).catch(console.error);
    };
    refreshAll();
    const events = [
      'perk:created', 'perk:updated', 'perk:deleted', 'perk:granted', 'perk:revoked',
      'move:created', 'move:updated', 'move:deleted',
      'tag:created', 'tag:updated', 'tag:deleted',
      'character:created', 'character:updated', 'character:deleted',
    ];
    for (const ev of events) socket.on(ev, refreshAll);
    return () => {
      for (const ev of events) socket.off(ev, refreshAll);
    };
  }, [role]);

  if (role !== 'gm') return <Navigate to="/" replace />;
  if (!perks || !moves || !tags) return <p className="text-zinc-500">Loading…</p>;

  const moveById = new Map(moves.map((m) => [m.id, m]));
  const tagById = new Map(tags.map((t) => [t.id, t]));

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
    <div className="mx-auto flex max-w-5xl gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        <h1 className="text-2xl font-bold">Perks Compendium</h1>

        {form ? (
          <PerkCreator
            moves={moves}
            tags={tags}
            initial={form.perk ?? null}
            onSubmit={submitPerk}
            onCancel={() => setForm(null)}
          />
        ) : (
          <button
            onClick={() => setForm({})}
            className="rounded-md bg-indigo-600 px-4 py-2 font-semibold hover:bg-indigo-500"
          >
            + New Perk
          </button>
        )}

        {perks.length === 0 ? (
          <p className="text-sm text-zinc-600">No Perks yet — create the first one.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {perks.map((perk) => (
              <div
                key={perk.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/perk-id', String(perk.id))}
                title="Drag onto a character to grant it"
                className="cursor-grab active:cursor-grabbing"
              >
                <PerkCard
                  perk={perk}
                  moveById={moveById}
                  tagById={tagById}
                  actions={
                    <>
                      <button
                        onClick={() => setGrantOpen(grantOpen === perk.id ? null : perk.id)}
                        className="rounded px-2 py-0.5 text-xs text-indigo-400 hover:bg-indigo-900/40"
                      >
                        Grant… ({perk.granted_character_ids.length})
                      </button>
                      <button
                        onClick={() => setForm({ perk })}
                        className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deletePerk(perk)}
                        className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
                      >
                        Delete
                      </button>
                    </>
                  }
                />
                {grantOpen === perk.id && <GrantList perk={perk} characters={characters} />}
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="hidden w-44 shrink-0 sm:block">
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
                className={`flex items-center gap-2 rounded-lg border p-2 transition ${
                  dropTarget === c.id
                    ? 'border-indigo-500 bg-indigo-950/50'
                    : 'border-zinc-800 bg-zinc-900'
                }`}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-800 text-sm font-bold text-zinc-600">
                  {src ? (
                    <img src={src} alt="" className="h-full w-full object-cover" />
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
    </div>
  );
}

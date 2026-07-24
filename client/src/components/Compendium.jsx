import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacters, getMoves, getTells } from '../lib/api.js';
import { TELL_ICONS, tellIconFor } from '../lib/tellIcons.js';
import { portraitSrc } from '../lib/image.js';
import MoveCard from './MoveCard.jsx';
import MoveCreator from './MoveCreator.jsx';

function IconPicker({ value, onChange }) {
  return (
    <div className="flex max-w-72 flex-wrap gap-1">
      {Object.entries(TELL_ICONS).map(([name, Icon]) => (
        <button
          key={name}
          type="button"
          onClick={() => onChange(name)}
          title={name}
          className={`rounded-md border p-1.5 ${
            value === name
              ? 'border-indigo-500 bg-indigo-600/30 text-indigo-300'
              : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
          }`}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}

function TellManager({ tells, usedTellIds }) {
  const [editing, setEditing] = useState(null); // null | 'new' | tell
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('eye');

  const startEdit = (tell) => {
    setEditing(tell);
    setName(tell === 'new' ? '' : tell.name);
    setIcon(tell === 'new' ? 'eye' : tell.icon || 'eye');
  };

  const save = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (editing === 'new') socket.emit('tell:create', { name: name.trim(), icon });
    else socket.emit('tell:update', { tellId: editing.id, name: name.trim(), icon });
    setEditing(null);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">
        Tells (world-level)
      </h2>
      <div className="flex flex-wrap gap-2">
        {tells.map((tell) => {
          const Icon = tellIconFor(tell.icon);
          const used = usedTellIds.has(tell.id);
          return (
            <span
              key={tell.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800 px-3 py-1 text-sm text-zinc-200"
            >
              <Icon size={14} className="text-zinc-400" />
              {tell.name}
              <button
                onClick={() => startEdit(tell)}
                className="text-zinc-600 hover:text-zinc-300"
                title="Edit"
              >
                ✎
              </button>
              <button
                onClick={() =>
                  window.confirm(`Delete Tell "${tell.name}"?`) &&
                  socket.emit('tell:delete', { tellId: tell.id })
                }
                disabled={used}
                title={used ? 'In use by a move — reassign first' : 'Delete'}
                className="text-zinc-600 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
              >
                ✕
              </button>
            </span>
          );
        })}
        {!editing && (
          <button
            onClick={() => startEdit('new')}
            className="rounded-full border border-dashed border-zinc-600 px-3 py-1 text-sm text-zinc-400 hover:border-indigo-500 hover:text-indigo-300"
          >
            + New Tell
          </button>
        )}
      </div>
      {editing && (
        <form onSubmit={save} className="mt-3 flex flex-col gap-2 border-t border-zinc-800 pt-3">
          <div className="flex gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tell name"
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={!name.trim()}
              className="rounded-md bg-indigo-600 px-3 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-md border border-zinc-700 px-3 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
          <IconPicker value={icon} onChange={setIcon} />
        </form>
      )}
    </div>
  );
}

function GrantList({ move, characters }) {
  return (
    <div className="mt-1 space-y-1 rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
      {characters.map((c) => {
        const granted = move.granted_character_ids.includes(c.id);
        return (
          <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={granted}
              onChange={() =>
                socket.emit(granted ? 'move:revoke' : 'move:grant', {
                  characterId: c.id,
                  moveId: move.id,
                })
              }
            />
            {c.name}
            {c.character_type === 'npc' && (
              <span className="rounded bg-purple-600/30 px-1 text-xs uppercase text-purple-300">
                npc
              </span>
            )}
          </label>
        );
      })}
      {characters.length === 0 && <p className="text-xs text-zinc-600">No characters yet.</p>}
    </div>
  );
}

// GM-only page: Tell manager + the persistent library of every move.
// Grant by dragging a move onto a character in the right rail, or via the
// per-move Grant checklist (works on touch).
export default function Compendium() {
  const { role } = useRole();
  const [tells, setTells] = useState(null);
  const [moves, setMoves] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [form, setForm] = useState(null); // null | { move? }
  const [grantOpen, setGrantOpen] = useState(null); // moveId
  const [dropTarget, setDropTarget] = useState(null); // characterId

  useEffect(() => {
    if (role !== 'gm') return;
    const refreshAll = () => {
      getTells().then(setTells).catch(console.error);
      getMoves().then(setMoves).catch(console.error);
      getCharacters().then(setCharacters).catch(console.error);
    };
    refreshAll();
    const events = [
      'tell:created', 'tell:updated', 'tell:deleted',
      'move:created', 'move:updated', 'move:deleted',
      'move:granted', 'move:revoked',
      'character:created', 'character:updated', 'character:deleted',
    ];
    for (const ev of events) socket.on(ev, refreshAll);
    return () => {
      for (const ev of events) socket.off(ev, refreshAll);
    };
  }, [role]);

  if (role !== 'gm') return <Navigate to="/" replace />;
  if (!tells || !moves) return <p className="text-zinc-500">Loading…</p>;

  const tellById = new Map(tells.map((t) => [t.id, t]));
  const usedTellIds = new Set(moves.map((m) => m.tell_id));

  const submitMove = (payload) => {
    if (form?.move) socket.emit('move:update', { moveId: form.move.id, ...payload });
    else socket.emit('move:create', payload);
    setForm(null);
  };

  const onDropOnCharacter = (e, character) => {
    e.preventDefault();
    setDropTarget(null);
    const moveId = Number(e.dataTransfer.getData('text/move-id'));
    if (moveId) socket.emit('move:grant', { characterId: character.id, moveId });
  };

  return (
    <div className="mx-auto flex max-w-5xl gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        <h1 className="text-2xl font-bold">Compendium</h1>
        <TellManager tells={tells} usedTellIds={usedTellIds} />

        {form ? (
          <MoveCreator
            tells={tells}
            initial={form.move ?? null}
            onSubmit={submitMove}
            onCancel={() => setForm(null)}
          />
        ) : (
          <button
            onClick={() => setForm({})}
            disabled={tells.length === 0}
            className="rounded-md bg-indigo-600 px-4 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
          >
            + New Move
          </button>
        )}

        {moves.length === 0 ? (
          <p className="text-sm text-zinc-600">No moves yet — create the first one.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {moves.map((move) => (
              <div
                key={move.id}
                draggable={!move.is_default}
                onDragStart={(e) => e.dataTransfer.setData('text/move-id', String(move.id))}
                className={move.is_default ? '' : 'cursor-grab active:cursor-grabbing'}
              >
                <MoveCard
                  move={move}
                  tell={tellById.get(move.tell_id)}
                  badge={
                    move.is_default ? (
                      <span className="ml-2 rounded bg-zinc-700/60 px-1.5 text-xs font-semibold uppercase text-zinc-400">
                        Default
                      </span>
                    ) : null
                  }
                  actions={
                    <>
                      {!move.is_default && (
                        <button
                          onClick={() =>
                            setGrantOpen(grantOpen === move.id ? null : move.id)
                          }
                          className="rounded px-2 py-0.5 text-xs text-indigo-400 hover:bg-indigo-900/40"
                        >
                          Grant… ({move.granted_character_ids.length})
                        </button>
                      )}
                      <button
                        onClick={() => setForm({ move })}
                        className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() =>
                          window.confirm(
                            `Delete ${move.name}? It disappears from every character.`
                          ) && socket.emit('move:delete', { moveId: move.id })
                        }
                        className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
                      >
                        Delete
                      </button>
                    </>
                  }
                />
                {grantOpen === move.id && !move.is_default && (
                  <GrantList move={move} characters={characters} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="hidden w-44 shrink-0 sm:block">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
          Drag a move here
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

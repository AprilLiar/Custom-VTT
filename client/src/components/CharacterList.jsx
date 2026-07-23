import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { createCharacter, deleteCharacter, getCharacters } from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';

function AddCharacterForm({ onDone }) {
  const { role } = useRole();
  const [name, setName] = useState('');
  const [type, setType] = useState('pc');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      // Players always create PCs — the type selector is GM-only
      await createCharacter({ name: name.trim(), characterType: role === 'gm' ? type : 'pc' });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Character name"
        className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
      />
      {role === 'gm' && (
        <div className="flex overflow-hidden rounded-md border border-zinc-700 text-sm font-semibold">
          {['pc', 'npc'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex-1 py-1.5 uppercase ${
                type === t ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!name.trim() || busy}
          className="flex-1 rounded-md bg-indigo-600 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          Create
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function CharacterList() {
  const { role } = useRole();
  const navigate = useNavigate();
  const [characters, setCharacters] = useState(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    getCharacters().then(setCharacters).catch(console.error);
    const refresh = () => getCharacters().then(setCharacters).catch(console.error);
    socket.on('character:created', refresh);
    socket.on('character:updated', refresh);
    socket.on('character:deleted', refresh);
    return () => {
      socket.off('character:created', refresh);
      socket.off('character:updated', refresh);
      socket.off('character:deleted', refresh);
    };
  }, []);

  if (!characters) return <p className="text-zinc-500">Loading…</p>;

  const visible =
    role === 'gm' ? characters : characters.filter((c) => c.character_type === 'pc');

  const remove = async (character) => {
    const sure = window.confirm(
      `Delete ${character.name}? This permanently removes their dice, inventory, and injuries.`
    );
    if (sure) await deleteCharacter(character.id);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Characters</h1>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="rounded-md bg-indigo-600 px-4 py-2 font-semibold hover:bg-indigo-500"
          >
            + Add Character
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-4">
          <AddCharacterForm onDone={() => setAdding(false)} />
        </div>
      )}

      {visible.length === 0 && !adding ? (
        <p className="text-zinc-500">No characters yet — add the first one.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((c) => {
            const src = portraitSrc(c);
            return (
              <div
                key={c.id}
                onClick={() => navigate(`/character/${c.id}`)}
                className="group cursor-pointer overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 transition hover:border-indigo-600"
              >
                <div className="flex aspect-square items-center justify-center bg-zinc-800">
                  {src ? (
                    <img src={src} alt={c.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-5xl font-bold text-zinc-600">
                      {c.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 p-3">
                  <span className="truncate font-semibold">{c.name}</span>
                  {role === 'gm' && c.character_type === 'npc' && (
                    <span className="rounded bg-purple-600/30 px-1.5 text-xs font-bold uppercase text-purple-300">
                      NPC
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(c);
                    }}
                    title="Delete character"
                    className="ml-auto rounded px-1.5 text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-red-900/40 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

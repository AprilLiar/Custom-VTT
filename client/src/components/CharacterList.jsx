import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import {
  createCharacter,
  deleteCharacter,
  getCharacters,
  getCharacterFolders,
} from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';

function AddCharacterForm({ folders, currentFolder, onDone }) {
  const { role } = useRole();
  const [name, setName] = useState('');
  const [type, setType] = useState('pc');
  const [folderId, setFolderId] = useState(currentFolder);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      // Players always create PCs — the type selector is GM-only. Folder
      // assignment is likewise GM-only; Players' new characters land at root.
      await createCharacter({
        name: name.trim(),
        characterType: role === 'gm' ? type : 'pc',
        folderId: role === 'gm' ? folderId : null,
      });
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
      {role === 'gm' && (
        <select
          value={folderId ?? ''}
          onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-indigo-500"
        >
          <option value="">Folder: root</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              Folder: {f.name}
            </option>
          ))}
        </select>
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
  const [folders, setFolders] = useState(null);
  const [adding, setAdding] = useState(false);
  const [currentFolder, setCurrentFolder] = useState(null); // folder id | null = root
  const [folderDropTarget, setFolderDropTarget] = useState(null); // 'root' | folderId | null
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    const refresh = () => {
      getCharacters().then(setCharacters).catch(console.error);
      getCharacterFolders().then(setFolders).catch(console.error);
    };
    refresh();
    const events = [
      'character:created', 'character:updated', 'character:deleted',
      'character_folder:created', 'character_folder:updated', 'character_folder:deleted',
    ];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  if (!characters || !folders) return <p className="text-zinc-500">Loading…</p>;

  const roleVisible =
    role === 'gm' ? characters : characters.filter((c) => c.character_type === 'pc');
  const visible = roleVisible.filter((c) => (c.folder_id ?? null) === currentFolder);

  const remove = async (character) => {
    const sure = window.confirm(
      `Delete ${character.name}? This permanently removes their dice, inventory, and injuries.`
    );
    if (sure) await deleteCharacter(character.id);
  };

  const createFolder = (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    socket.emit('character_folder:create', { name: newFolderName.trim() });
    setNewFolderName('');
  };

  // Drag a character card onto a folder tab (or "All Characters") to file
  // it — only touches folder_id. GM-only, mirroring the move folder pattern.
  const onDropOnFolder = (e, targetFolderId) => {
    e.preventDefault();
    setFolderDropTarget(null);
    const characterId = Number(e.dataTransfer.getData('text/character-id'));
    if (characterId) socket.emit('character:set_folder', { characterId, folderId: targetFolderId });
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
          <AddCharacterForm
            folders={folders}
            currentFolder={currentFolder}
            onDone={() => setAdding(false)}
          />
        </div>
      )}

      {/* Folder navigation — everyone can browse, only the GM can manage */}
      {(folders.length > 0 || role === 'gm') && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setCurrentFolder(null)}
            onDragOver={(e) => {
              if (role !== 'gm') return;
              e.preventDefault();
              setFolderDropTarget('root');
            }}
            onDragLeave={() => setFolderDropTarget(null)}
            onDrop={(e) => role === 'gm' && onDropOnFolder(e, null)}
            title="Drop a character here to remove it from its folder"
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
              currentFolder == null
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            } ${folderDropTarget === 'root' ? 'ring-2 ring-indigo-400' : ''}`}
          >
            🏠 All Characters
          </button>
          {folders.map((f) => (
            <span key={f.id} className="inline-flex items-center">
              <button
                onClick={() => setCurrentFolder(f.id)}
                onDragOver={(e) => {
                  if (role !== 'gm') return;
                  e.preventDefault();
                  setFolderDropTarget(f.id);
                }}
                onDragLeave={() => setFolderDropTarget(null)}
                onDrop={(e) => role === 'gm' && onDropOnFolder(e, f.id)}
                title="Drop a character here to file it in this folder"
                className={`rounded-l-md px-3 py-1.5 text-sm font-semibold ${
                  currentFolder === f.id
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                } ${folderDropTarget === f.id ? 'ring-2 ring-indigo-400' : ''}`}
              >
                📁 {f.name}
              </button>
              {role === 'gm' && (
                <span className="flex rounded-r-md bg-zinc-800/70 px-1 py-1.5">
                  <button
                    onClick={() => {
                      const name = window.prompt('Rename folder', f.name);
                      if (name?.trim())
                        socket.emit('character_folder:rename', { folderId: f.id, name: name.trim() });
                    }}
                    className="px-1 text-xs text-zinc-600 hover:text-zinc-300"
                    title="Rename"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete folder "${f.name}"? Its characters return to root.`)) {
                        socket.emit('character_folder:delete', { folderId: f.id });
                        if (currentFolder === f.id) setCurrentFolder(null);
                      }
                    }}
                    className="px-1 text-xs text-zinc-600 hover:text-red-400"
                    title="Delete (characters return to root)"
                  >
                    ✕
                  </button>
                </span>
              )}
            </span>
          ))}
          {role === 'gm' && (
            <form onSubmit={createFolder} className="flex gap-1">
              <input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="New folder"
                className="w-28 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                disabled={!newFolderName.trim()}
                className="rounded-md bg-zinc-700 px-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-600 disabled:opacity-40"
              >
                +
              </button>
            </form>
          )}
        </div>
      )}

      {visible.length === 0 && !adding ? (
        <p className="text-zinc-500">
          {currentFolder == null ? 'No characters yet — add the first one.' : 'This folder is empty.'}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((c) => {
            const src = portraitSrc(c);
            return (
              <div
                key={c.id}
                draggable={role === 'gm'}
                onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(c.id))}
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

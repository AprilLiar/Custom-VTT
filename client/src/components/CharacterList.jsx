import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { useRoster } from '../lib/useRoster.js';
import {
  createCharacter,
  deleteCharacter,
  getCharacterFolders,
} from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';
import { flattenFolderTree, folderPath } from '../lib/folders.js';
import FolderTreeNav from './FolderTreeNav.jsx';
import DialogShell from './DialogShell.jsx';

// Mobile readiness (Change 002) §9: dragging a character card onto the
// folder sidebar has no touch equivalent, so this is the tap alternative —
// same character:set_folder event, just a picked row instead of a drop
// target. GM-only, matching the drag gesture's own gating.
function MoveToFolderDialog({ character, folders, onClose }) {
  const flat = flattenFolderTree(folders);
  const moveTo = (folderId) => {
    socket.emit('character:set_folder', { characterId: character.id, folderId });
    onClose();
  };
  return (
    <DialogShell title={`Move ${character.name} to…`} onClose={onClose} maxWidth="max-w-sm">
      <div className="space-y-0.5">
        <button
          onClick={() => moveTo(null)}
          className={`flex min-h-11 w-full items-center truncate panel-cut-sm px-2 text-left text-sm font-semibold ${
            (character.folder_id ?? null) == null
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          }`}
        >
          🏠 All Characters
        </button>
        {flat.map(({ folder, depth, path }) => (
          <button
            key={folder.id}
            onClick={() => moveTo(folder.id)}
            title={path}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            className={`flex min-h-11 w-full items-center truncate panel-cut-sm pr-2 text-left text-sm font-semibold ${
              character.folder_id === folder.id
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            📁 {folder.name}
          </button>
        ))}
      </div>
    </DialogShell>
  );
}

function AddCharacterForm({ folders, currentFolder, onDone }) {
  const { role } = useRole();
  const [name, setName] = useState('');
  const [type, setType] = useState('pc');
  const [folderId, setFolderId] = useState(currentFolder);
  const [busy, setBusy] = useState(false);
  const flatFolders = flattenFolderTree(folders);

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
      className="flex flex-col gap-3 panel-cut-lg border border-zinc-700 bg-zinc-900 p-4"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Character name"
        className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-brand-500"
      />
      {role === 'gm' && (
        <div className="flex overflow-hidden panel-cut-sm border border-zinc-700 text-sm font-semibold">
          {['pc', 'npc'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex-1 py-1.5 uppercase ${
                type === t ? 'bg-brand-600 text-white' : 'bg-zinc-800 text-zinc-400'
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
          className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-brand-500"
        >
          <option value="">Folder: root</option>
          {flatFolders.map(({ folder, path }) => (
            <option key={folder.id} value={folder.id}>
              Folder: {path}
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!name.trim() || busy}
          className="flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          Create
        </button>
        <button
          type="button"
          onClick={onDone}
          className="panel-cut-sm border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
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
  const characters = useRoster();
  const [folders, setFolders] = useState(null);
  const [adding, setAdding] = useState(false);
  const [currentFolder, setCurrentFolder] = useState(null); // folder id | null = root
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState(null); // character being re-filed on mobile

  useEffect(() => {
    // Folders only. The roster itself is useRoster's job — refetching it on
    // `character:updated` meant reloading the whole list on every Stamina
    // change, and a character's own re-filing arrives on that same payload.
    const refetchFolders = () => getCharacterFolders().then(setFolders).catch(console.error);
    refetchFolders();
    const events = ['character_folder:created', 'character_folder:updated'];
    for (const ev of events) socket.on(ev, refetchFolders);
    // If the folder currently being viewed is the one that just got deleted,
    // follow it up to its parent (or root) rather than showing a stale
    // "This folder is empty" for a folder id that no longer exists.
    const onFolderDeleted = ({ folderId, parentFolderId }) => {
      refetchFolders();
      setCurrentFolder((prev) => (prev === folderId ? parentFolderId ?? null : prev));
    };
    socket.on('character_folder:deleted', onFolderDeleted);
    return () => {
      for (const ev of events) socket.off(ev, refetchFolders);
      socket.off('character_folder:deleted', onFolderDeleted);
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

  // Drag a character card onto a folder tab (or root) to file it — only
  // touches folder_id. GM-only, mirroring the move folder pattern.
  const onDropOnFolder = (e, targetFolderId) => {
    e.preventDefault();
    const characterId = Number(e.dataTransfer.getData('text/character-id'));
    if (characterId) socket.emit('character:set_folder', { characterId, folderId: targetFolderId });
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Characters</h1>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="panel-cut-sm bg-brand-600 px-4 py-2 font-semibold hover:bg-brand-500"
          >
            + Add Character
          </button>
        )}
      </div>

      {/* Folder navigation — everyone can browse, only the GM can manage.
          Mobile readiness (Change 002) §9.2A: a fixed sidebar squeezes the
          card grid down to nothing on a phone, so below md it collapses
          into a trigger button that opens the same FolderTreeNav in a
          bottom-sheet dialog instead. */}
      {(folders.length > 0 || role === 'gm') && (
        <button
          onClick={() => setMobileFoldersOpen(true)}
          className="mb-4 flex min-h-11 w-full items-center gap-2 panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 text-left text-sm font-semibold text-zinc-300 hover:bg-zinc-800 md:hidden"
        >
          📁 {currentFolder == null ? 'All Characters' : folderPath(currentFolder, folders)}
          <span className="ml-auto text-xs text-zinc-500">Change…</span>
        </button>
      )}
      {mobileFoldersOpen && (
        <DialogShell title="Folders" onClose={() => setMobileFoldersOpen(false)} maxWidth="max-w-sm">
          <FolderTreeNav
            folders={folders}
            currentFolderId={currentFolder}
            onSelect={(id) => {
              setCurrentFolder(id);
              setMobileFoldersOpen(false);
            }}
            canManage={role === 'gm'}
            onCreate={(name, parentFolderId) =>
              socket.emit('character_folder:create', { name, parentFolderId })
            }
            onRename={(folderId, name) => socket.emit('character_folder:rename', { folderId, name })}
            onDelete={(folderId) => socket.emit('character_folder:delete', { folderId })}
            onDropOnFolder={onDropOnFolder}
            rootLabel="All Characters"
            nounLabel="folder"
          />
        </DialogShell>
      )}
      {moveTarget && (
        <MoveToFolderDialog
          character={moveTarget}
          folders={folders}
          onClose={() => setMoveTarget(null)}
        />
      )}

      <div className="flex gap-4">
        {(folders.length > 0 || role === 'gm') && (
          <aside className="hidden w-44 shrink-0 md:block">
            <FolderTreeNav
              folders={folders}
              currentFolderId={currentFolder}
              onSelect={setCurrentFolder}
              canManage={role === 'gm'}
              onCreate={(name, parentFolderId) =>
                socket.emit('character_folder:create', { name, parentFolderId })
              }
              onRename={(folderId, name) =>
                socket.emit('character_folder:rename', { folderId, name })
              }
              onDelete={(folderId) => socket.emit('character_folder:delete', { folderId })}
              onDropOnFolder={onDropOnFolder}
              rootLabel="All Characters"
              nounLabel="folder"
            />
          </aside>
        )}

        <div className="min-w-0 flex-1">
          {adding && (
            <div className="mb-4">
              <AddCharacterForm
                folders={folders}
                currentFolder={currentFolder}
                onDone={() => setAdding(false)}
              />
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
                const path = folderPath(c.folder_id, folders);
                return (
                  <div
                    key={c.id}
                    draggable={role === 'gm'}
                    onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(c.id))}
                    onClick={() => navigate(`/character/${c.id}`)}
                    className="group flex cursor-pointer flex-col overflow-hidden panel-cut-lg border border-zinc-800 bg-zinc-900 transition hover:border-brand-600"
                  >
                    <div className="flex h-56 items-center justify-center bg-zinc-800">
                      {src ? (
                        <CroppedImage src={src} alt={c.name} crop={cropOf(c)} loading="lazy" className="h-full w-full" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-5xl font-bold text-zinc-600">
                          {c.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 p-3">
                      <span className="truncate font-semibold">{c.name}</span>
                      {role === 'gm' && c.character_type === 'npc' && (
                        <span className="panel-cut-sm bg-purple-600/30 px-1.5 text-xs font-bold uppercase text-purple-300">
                          NPC
                        </span>
                      )}
                      {path && (
                        <span
                          title={path}
                          className="truncate panel-cut-sm bg-zinc-700/50 px-1.5 text-xs text-zinc-400"
                        >
                          📁 {path}
                        </span>
                      )}
                      {role === 'gm' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMoveTarget(c);
                          }}
                          title="Move to folder"
                          className="hover-only-action ml-auto flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-brand-300 group-hover:opacity-100"
                        >
                          ⇄
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(c);
                        }}
                        title="Delete character"
                        className={`hover-only-action flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-600 opacity-0 transition hover:bg-red-900/40 hover:text-red-400 group-hover:opacity-100 md:h-auto md:w-auto md:px-1.5 ${role === 'gm' ? '' : 'ml-auto'}`}
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
      </div>
    </div>
  );
}

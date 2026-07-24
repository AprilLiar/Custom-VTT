import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getCharacter, getCharacters, getMoves, getRuleset, getTags, getTells } from '../lib/api.js';
import { iconFor } from '../lib/styleIcons.js';
import { fileToSmallImage, portraitSrc } from '../lib/image.js';
import MoveCard from './MoveCard.jsx';
import MoveCreator from './MoveCreator.jsx';
import Thumb from './Thumb.jsx';

function TellManager({ tells, usedTellIds }) {
  const [editing, setEditing] = useState(null); // null | 'new' | tell
  const [name, setName] = useState('');
  const [image, setImage] = useState(undefined); // undefined = keep existing
  const fileRef = useRef(null);

  const startEdit = (tell) => {
    setEditing(tell);
    setName(tell === 'new' ? '' : tell.name);
    setImage(undefined);
  };

  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImage(await fileToSmallImage(file).catch(() => undefined));
  };

  const save = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const imagePayload = image !== undefined ? image : {};
    if (editing === 'new') socket.emit('tell:create', { name: name.trim(), ...imagePayload });
    else socket.emit('tell:update', { tellId: editing.id, name: name.trim(), ...imagePayload });
    setEditing(null);
  };

  const preview =
    image !== undefined
      ? { image_data: image?.imageData, image_mime_type: image?.imageMimeType }
      : editing !== 'new'
        ? editing
        : null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">
        Tells (world-level)
      </h2>
      <div className="flex flex-wrap gap-2">
        {tells.map((tell) => {
          const used = usedTellIds.has(tell.id);
          return (
            <span
              key={tell.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
            >
              <Thumb record={tell} name={tell.name} size="h-5 w-5" rounded="rounded-full" />
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
        <form onSubmit={save} className="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Upload Tell art"
            className="rounded-lg border border-zinc-700 hover:border-indigo-500"
          >
            <Thumb record={preview} name={name || '?'} size="h-9 w-9" rounded="rounded-lg" />
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
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
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

function TagManager({ tags }) {
  const [editing, setEditing] = useState(null); // null | 'new' | tag
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const startEdit = (tag) => {
    setEditing(tag);
    setName(tag === 'new' ? '' : tag.name);
    setDescription(tag === 'new' ? '' : tag.description ?? '');
  };

  const save = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (editing === 'new') {
      socket.emit('tag:create', { name: name.trim(), description: description.trim() });
    } else {
      socket.emit('tag:update', {
        tagId: editing.id,
        name: name.trim(),
        description: description.trim(),
      });
    }
    setEditing(null);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">
        Tags (world-level)
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((tag) => (
          <span
            key={tag.id}
            title={tag.description || undefined}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/40 px-2.5 py-0.5 text-sm font-semibold text-emerald-300"
          >
            {tag.name}
            <button
              onClick={() => startEdit(tag)}
              className="text-emerald-700 hover:text-emerald-200"
              title="Edit"
            >
              ✎
            </button>
            <button
              onClick={() =>
                window.confirm(`Delete tag "${tag.name}"? It is removed from every move.`) &&
                socket.emit('tag:delete', { tagId: tag.id })
              }
              className="text-emerald-700 hover:text-red-400"
              title="Delete"
            >
              ✕
            </button>
          </span>
        ))}
        {!editing && (
          <button
            onClick={() => startEdit('new')}
            className="rounded-full border border-dashed border-zinc-600 px-3 py-1 text-sm text-zinc-400 hover:border-indigo-500 hover:text-indigo-300"
          >
            + New Tag
          </button>
        )}
      </div>
      {editing && (
        <form onSubmit={save} className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tag name"
            className="w-28 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (shown as a tooltip)"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

function GrantList({ move, characters, canLearn }) {
  return (
    <div className="mt-1 space-y-1 rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
      {characters.map((c) => {
        const granted = move.granted_character_ids.includes(c.id);
        const learnable = canLearn(c, move);
        return (
          <label
            key={c.id}
            title={!learnable && !granted ? 'No stance with this move’s style' : undefined}
            className={`flex items-center gap-2 text-sm ${
              learnable || granted ? 'text-zinc-300' : 'text-zinc-600'
            }`}
          >
            <input
              type="checkbox"
              checked={granted}
              disabled={!granted && !learnable}
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

// The Compendium page's Moves tab: Tell + Tag managers, folders, style
// filter, and the persistent move library with drag/checklist granting.
// Rendering is GM-gated by the parent CompendiumPage.
export default function MovesCompendium() {
  const [tells, setTells] = useState(null);
  const [tags, setTags] = useState(null);
  const [ruleset, setRuleset] = useState(null);
  const [data, setData] = useState(null); // { folders, moves }
  const [characters, setCharacters] = useState([]);
  const [characterStances, setCharacterStances] = useState(new Map()); // charId -> stances
  const [form, setForm] = useState(null); // null | { move? }
  const [grantOpen, setGrantOpen] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [folderDropTarget, setFolderDropTarget] = useState(null); // 'root' | folderId | null
  const [currentFolder, setCurrentFolder] = useState(null); // folder id | null = root
  const [styleFilter, setStyleFilter] = useState(null); // attribute id | null
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    const refreshAll = () => {
      getTells().then(setTells).catch(console.error);
      getTags().then(setTags).catch(console.error);
      getRuleset().then(setRuleset).catch(console.error);
      getMoves().then(setData).catch(console.error);
      getCharacters()
        .then(async (chars) => {
          setCharacters(chars);
          // stances are needed for the learnability gate in the grant list
          const entries = await Promise.all(
            chars.map(async (c) => [c.id, (await getCharacter(c.id)).stances])
          );
          setCharacterStances(new Map(entries));
        })
        .catch(console.error);
    };
    refreshAll();
    const events = [
      'tell:created', 'tell:updated', 'tell:deleted',
      'tag:created', 'tag:updated', 'tag:deleted',
      'folder:created', 'folder:updated', 'folder:deleted',
      'move:created', 'move:updated', 'move:deleted',
      'move:granted', 'move:revoked',
      'character:created', 'character:updated', 'character:deleted',
      'stance:created', 'stance:updated', 'stance:deleted',
    ];
    for (const ev of events) socket.on(ev, refreshAll);
    return () => {
      for (const ev of events) socket.off(ev, refreshAll);
    };
  }, []);

  if (!tells || !tags || !ruleset || !data) return <p className="text-zinc-500">Loading…</p>;

  const { folders, moves } = data;
  const tellById = new Map(tells.map((t) => [t.id, t]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const attrById = new Map(ruleset.attributes.map((a) => [a.id, a]));
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const usedTellIds = new Set(moves.map((m) => m.tell_id));

  const canLearn = (character, move) => {
    if (move.style_attribute_id == null) return true;
    const stances = characterStances.get(character.id) ?? [];
    return stances.some(
      (s) =>
        s.attribute_a_id === move.style_attribute_id ||
        s.attribute_b_id === move.style_attribute_id
    );
  };

  // Filter semantics: inside a folder the filter applies within it; at root a
  // filter scans everything (all folders + root) and labels each hit's origin.
  let visibleMoves;
  if (styleFilter != null) {
    const pool = currentFolder != null ? moves.filter((m) => m.folder_id === currentFolder) : moves;
    visibleMoves = pool.filter((m) => m.style_attribute_id === styleFilter);
  } else {
    visibleMoves = moves.filter((m) => (m.folder_id ?? null) === currentFolder);
  }
  const showFolderLabels = styleFilter != null && currentFolder == null;

  const submitMove = (payload) => {
    if (form?.move) socket.emit('move:update', { moveId: form.move.id, ...payload });
    else socket.emit('move:create', payload);
    setForm(null);
  };

  const createFolder = (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    socket.emit('folder:create', { name: newFolderName.trim() });
    setNewFolderName('');
  };

  const onDropOnCharacter = (e, character) => {
    e.preventDefault();
    setDropTarget(null);
    const moveId = Number(e.dataTransfer.getData('text/move-id'));
    if (moveId) socket.emit('move:grant', { characterId: character.id, moveId });
  };

  // Drag a move card onto a folder tab (or "All Moves") to reassign it —
  // only touches folder_id, leaving the rest of the move untouched.
  const onDropOnFolder = (e, targetFolderId) => {
    e.preventDefault();
    setFolderDropTarget(null);
    const moveId = Number(e.dataTransfer.getData('text/move-id'));
    if (moveId) socket.emit('move:set_folder', { moveId, folderId: targetFolderId });
  };

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        <TellManager tells={tells} usedTellIds={usedTellIds} />
        <TagManager tags={tags} />

        {/* Folder navigation + style filter */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setCurrentFolder(null)}
            onDragOver={(e) => {
              e.preventDefault();
              setFolderDropTarget('root');
            }}
            onDragLeave={() => setFolderDropTarget(null)}
            onDrop={(e) => onDropOnFolder(e, null)}
            title="Drop a move here to remove it from its folder"
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
              currentFolder == null
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            } ${folderDropTarget === 'root' ? 'ring-2 ring-indigo-400' : ''}`}
          >
            🏠 All Moves
          </button>
          {folders.map((f) => (
            <span key={f.id} className="inline-flex items-center">
              <button
                onClick={() => setCurrentFolder(f.id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setFolderDropTarget(f.id);
                }}
                onDragLeave={() => setFolderDropTarget(null)}
                onDrop={(e) => onDropOnFolder(e, f.id)}
                title="Drop a move here to file it in this folder"
                className={`rounded-l-md px-3 py-1.5 text-sm font-semibold ${
                  currentFolder === f.id
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                } ${folderDropTarget === f.id ? 'ring-2 ring-indigo-400' : ''}`}
              >
                📁 {f.name}
              </button>
              <span className="flex rounded-r-md bg-zinc-800/70 px-1 py-1.5">
                <button
                  onClick={() => {
                    const name = window.prompt('Rename folder', f.name);
                    if (name?.trim())
                      socket.emit('folder:rename', { folderId: f.id, name: name.trim() });
                  }}
                  className="px-1 text-xs text-zinc-600 hover:text-zinc-300"
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete folder "${f.name}"? Its moves return to root.`)) {
                      socket.emit('folder:delete', { folderId: f.id });
                      if (currentFolder === f.id) setCurrentFolder(null);
                    }
                  }}
                  className="px-1 text-xs text-zinc-600 hover:text-red-400"
                  title="Delete (moves return to root)"
                >
                  ✕
                </button>
              </span>
            </span>
          ))}
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

          <div className="ml-auto flex items-center gap-1">
            {ruleset.attributes.map((attr) => {
              const Icon = iconFor(attr.icon);
              const active = styleFilter === attr.id;
              return (
                <button
                  key={attr.id}
                  onClick={() => setStyleFilter(active ? null : attr.id)}
                  title={`Filter by ${attr.name}`}
                  className={`rounded-md border p-1.5 ${
                    active
                      ? 'border-indigo-500 bg-indigo-600/30 text-indigo-300'
                      : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
                  }`}
                >
                  <Icon size={14} />
                </button>
              );
            })}
          </div>
        </div>

        {form ? (
          <MoveCreator
            tells={tells}
            attributes={ruleset.attributes}
            tags={tags}
            folders={folders}
            initialFolderId={currentFolder}
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

        {visibleMoves.length === 0 ? (
          <p className="text-sm text-zinc-600">
            {styleFilter != null
              ? 'No moves with this style here.'
              : currentFolder != null
                ? 'This folder is empty — assign moves to it in the Move Creator.'
                : 'No moves here yet.'}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visibleMoves.map((move) => (
              <div
                key={move.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/move-id', String(move.id))}
                title="Drag onto a folder to file it, or onto a character to grant it"
                className="cursor-grab active:cursor-grabbing"
              >
                <MoveCard
                  move={move}
                  tell={tellById.get(move.tell_id)}
                  style={move.style_attribute_id ? attrById.get(move.style_attribute_id) : null}
                  tags={move.tag_ids.map((id) => tagById.get(id)).filter(Boolean)}
                  folderLabel={
                    showFolderLabels && move.folder_id
                      ? folderById.get(move.folder_id)?.name
                      : null
                  }
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
                          onClick={() => setGrantOpen(grantOpen === move.id ? null : move.id)}
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
                  <GrantList move={move} characters={characters} canLearn={canLearn} />
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

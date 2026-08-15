import { useEffect, useRef, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacter, getCharacters, getMoves, getRuleset, getTags, getTells } from '../lib/api.js';
import { iconFor } from '../lib/styleIcons.js';
import { fileToSmallImage, portraitSrc } from '../lib/image.js';
import { folderPath } from '../lib/folders.js';
import FolderTreeNav from './FolderTreeNav.jsx';
import MoveCard from './MoveCard.jsx';
import MoveCreator from './MoveCreator.jsx';
import Thumb from './Thumb.jsx';
import DialogShell from './DialogShell.jsx';

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
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-4">
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
              <Thumb record={tell} name={tell.name} size="h-5 w-5" cut="rounded-full" />
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
            className="rounded-full border border-dashed border-zinc-600 px-3 py-1 text-sm text-zinc-400 hover:border-brand-500 hover:text-brand-300"
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
            className="panel-cut border border-zinc-700 hover:border-brand-500"
          >
            <Thumb record={preview} name={name || '?'} size="h-9 w-9" cut="panel-cut" />
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tell name"
            className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="panel-cut-sm border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
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
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-4">
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
            className="rounded-full border border-dashed border-zinc-600 px-3 py-1 text-sm text-zinc-400 hover:border-brand-500 hover:text-brand-300"
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
            className="w-28 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (shown as a tooltip)"
            className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="panel-cut-sm border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
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
    <div className="mt-1 space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-2">
      {characters.map((c) => {
        const granted = move.granted_character_ids.includes(c.id);
        const learnable = canLearn(c, move);
        return (
          <label
            key={c.id}
            title={!learnable && !granted ? 'No stance with this move’s style' : undefined}
            className={`flex min-h-11 items-center gap-2 text-sm md:min-h-0 ${
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
              <span className="panel-cut-sm bg-purple-600/30 px-1 text-xs uppercase text-purple-300">
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
// The page itself is open to every role (see CompendiumPage.jsx) — every
// mutating control here (Tell/Tag managers, the Creator, Edit/Delete/Grant,
// folder management, drag-and-drop) is gated to role === 'gm' below; a
// Player gets a read-only browse of the same cards.
export default function MovesCompendium() {
  const { role } = useRole();
  const [tells, setTells] = useState(null);
  const [tags, setTags] = useState(null);
  const [ruleset, setRuleset] = useState(null);
  const [data, setData] = useState(null); // { folders, moves }
  const [characters, setCharacters] = useState([]);
  const [characterStances, setCharacterStances] = useState(new Map()); // charId -> stances
  const [form, setForm] = useState(null); // null | { move? }
  const [grantOpen, setGrantOpen] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [currentFolder, setCurrentFolder] = useState(null); // folder id | null = root
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  const [reorderTarget, setReorderTarget] = useState(null); // move id being hovered as a drop slot
  const [styleFilter, setStyleFilter] = useState(new Set()); // Set<attribute id> — OR'd together
  const [tagFilter, setTagFilter] = useState(new Set()); // Set<tag id> — OR'd together
  // One toggler for both filters: they are the same multi-select-OR control
  // over different id spaces, and two copies of this would be two places for
  // the next change to miss.
  const toggleIn = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleStyleFilter = toggleIn(setStyleFilter);
  const toggleTagFilter = toggleIn(setTagFilter);

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
      'folder:created', 'folder:updated',
      'move:created', 'move:updated', 'move:deleted',
      'move:granted', 'move:revoked', 'moves:reordered',
      'character:created', 'character:updated', 'character:deleted',
      'stance:created', 'stance:updated', 'stance:deleted',
    ];
    for (const ev of events) socket.on(ev, refreshAll);
    // If the discipline currently being viewed is the one that just got
    // deleted, follow it up to its parent (or root) instead of showing a
    // stale "no moves" view for a folder id that no longer exists.
    const onFolderDeleted = ({ folderId, parentFolderId }) => {
      refreshAll();
      setCurrentFolder((prev) => (prev === folderId ? parentFolderId ?? null : prev));
    };
    socket.on('folder:deleted', onFolderDeleted);
    return () => {
      for (const ev of events) socket.off(ev, refreshAll);
      socket.off('folder:deleted', onFolderDeleted);
    };
  }, []);

  if (!tells || !tags || !ruleset || !data) return <p className="text-zinc-500">Loading…</p>;

  const { folders, moves } = data;
  const tellById = new Map(tells.map((t) => [t.id, t]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const attrById = new Map(ruleset.attributes.map((a) => [a.id, a]));
  const usedTellIds = new Set();
  for (const m of moves) {
    usedTellIds.add(m.tell_id);
    if (m.right_tell_id) usedTellIds.add(m.right_tell_id);
    if (m.left_tell_id) usedTellIds.add(m.left_tell_id);
  }

  const canLearn = (character, move) => {
    if (move.style_attribute_id == null) return true;
    const stances = characterStances.get(character.id) ?? [];
    return stances.some(
      (s) =>
        s.attribute_a_id === move.style_attribute_id ||
        s.attribute_b_id === move.style_attribute_id
    );
  };

  // "All Moves" (currentFolder == null) shows every move regardless of
  // discipline — a specific discipline tab shows only its own moves. The
  // style filter narrows whichever of those two pools is currently showing.
  // The two filters narrow independently and are AND'd with each other, while
  // each is OR'd within itself: "a Strength OR Speed move that is Grab OR
  // Feint". Selecting nothing in a filter means that filter isn't applied,
  // which is why an empty Set is checked rather than treated as "match none".
  const folderPool = currentFolder != null ? moves.filter((m) => m.folder_id === currentFolder) : moves;
  const styleMatched =
    styleFilter.size > 0 ? folderPool.filter((m) => styleFilter.has(m.style_attribute_id)) : folderPool;
  const visibleMoves =
    tagFilter.size > 0
      ? styleMatched.filter((m) => (m.tag_ids ?? []).some((id) => tagFilter.has(id)))
      : styleMatched;

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

  // Drag a move card onto a discipline (or root) to reassign it — only
  // touches folder_id, leaving the rest of the move untouched.
  const onDropOnFolder = (e, targetFolderId) => {
    e.preventDefault();
    const moveId = Number(e.dataTransfer.getData('text/move-id'));
    if (moveId) socket.emit('move:set_folder', { moveId, folderId: targetFolderId });
  };

  // Drag a move card onto ANOTHER move card to reorder the library (decided).
  // The same drag that files a move into a Discipline and grants it to a
  // character — the drop target decides which of the three happened, which is
  // why the three drop zones never overlap: a Discipline row and a character
  // rail card are not move cards.
  //
  // The reordered list sent to the server is the *currently visible* one, so
  // dragging inside a filtered view only permutes the moves on screen (see
  // move:reorder on the server for how positions are redistributed).
  const onDropOnMove = (e, targetMove) => {
    e.preventDefault();
    e.stopPropagation(); // don't also let a parent drop zone act on this
    setReorderTarget(null);
    const draggedId = Number(e.dataTransfer.getData('text/move-id'));
    if (!draggedId || draggedId === targetMove.id) return;
    const ids = visibleMoves.map((m) => m.id);
    if (!ids.includes(draggedId)) return; // dragged in from somewhere off-view
    const without = ids.filter((id) => id !== draggedId);
    const at = without.indexOf(targetMove.id);
    if (at < 0) return;
    socket.emit('move:reorder', {
      moveIds: [...without.slice(0, at), draggedId, ...without.slice(at)],
    });
  };

  return (
    <div>
      {/* Mobile readiness (Change 002) §9.2A: same fixed-sidebar-to-drawer
          collapse as CharacterList's folder nav — see that component for
          the full rationale. Filing a move into a Discipline already has a
          tap-only path (Edit → Discipline dropdown in MoveCreator), so no
          extra "move to folder" dialog is needed here, just the browse
          drawer. */}
      <button
        onClick={() => setMobileFoldersOpen(true)}
        className="mb-4 flex min-h-11 w-full items-center gap-2 panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 text-left text-sm font-semibold text-zinc-300 hover:bg-zinc-800 md:hidden"
      >
        📁 {currentFolder == null ? 'All Moves' : folderPath(currentFolder, folders)}
        <span className="ml-auto text-xs text-zinc-500">Change…</span>
      </button>
      {mobileFoldersOpen && (
        <DialogShell title="Disciplines" onClose={() => setMobileFoldersOpen(false)} maxWidth="max-w-sm">
          <FolderTreeNav
            folders={folders}
            currentFolderId={currentFolder}
            onSelect={(id) => {
              setCurrentFolder(id);
              setMobileFoldersOpen(false);
            }}
            canManage={role === 'gm'}
            onCreate={(name, parentFolderId) => socket.emit('folder:create', { name, parentFolderId })}
            onRename={(folderId, name) => socket.emit('folder:rename', { folderId, name })}
            onDelete={(folderId) => socket.emit('folder:delete', { folderId })}
            onDropOnFolder={onDropOnFolder}
            rootLabel="All Moves"
            nounLabel="discipline"
          />
        </DialogShell>
      )}

    <div className="flex gap-4">
      <aside className="hidden w-44 shrink-0 md:block">
        <FolderTreeNav
          folders={folders}
          currentFolderId={currentFolder}
          onSelect={setCurrentFolder}
          canManage={role === 'gm'}
          onCreate={(name, parentFolderId) => socket.emit('folder:create', { name, parentFolderId })}
          onRename={(folderId, name) => socket.emit('folder:rename', { folderId, name })}
          onDelete={(folderId) => socket.emit('folder:delete', { folderId })}
          onDropOnFolder={onDropOnFolder}
          rootLabel="All Moves"
          nounLabel="discipline"
        />
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        {role === 'gm' && (
          <>
            <TellManager tells={tells} usedTellIds={usedTellIds} />
            <TagManager tags={tags} />
          </>
        )}

        {/* Style filter */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs font-semibold uppercase text-zinc-500">Filter by style:</span>
          {ruleset.attributes.map((attr) => {
            const Icon = iconFor(attr.icon);
            const active = styleFilter.has(attr.id);
            return (
              <button
                key={attr.id}
                onClick={() => toggleStyleFilter(attr.id)}
                title={`Filter by ${attr.name}`}
                className={`flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border p-1.5 md:h-auto md:w-auto ${
                  active
                    ? 'border-brand-500 bg-brand-600/30 text-brand-300'
                    : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
                }`}
              >
                <Icon size={14} />
              </button>
            );
          })}
        </div>

        {/* Tag filter — the same multi-select-OR control as the style row
            above, in words rather than icons because a Tag is GM-authored
            free text with no icon to stand in for it. Hidden entirely when
            the world has no Tags yet, rather than rendering a bare label. */}
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs font-semibold uppercase text-zinc-500">Filter by tag:</span>
            {tags.map((tag) => {
              const active = tagFilter.has(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleTagFilter(tag.id)}
                  title={tag.description || `Filter by ${tag.name}`}
                  className={`panel-cut-sm border px-2 py-1 text-xs ${
                    active
                      ? 'border-brand-500 bg-brand-600/30 text-brand-300'
                      : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
                  }`}
                >
                  {tag.name}
                </button>
              );
            })}
            {tagFilter.size > 0 && (
              <button
                onClick={() => setTagFilter(new Set())}
                className="ml-1 text-xs text-zinc-500 underline hover:text-zinc-300"
              >
                clear
              </button>
            )}
          </div>
        )}

        {role === 'gm' &&
          (form ? (
            <MoveCreator
              tells={tells}
              attributes={ruleset.attributes}
              tags={tags}
              folders={folders}
              moves={moves}
              initialFolderId={currentFolder}
              initial={form.move ?? null}
              onSubmit={submitMove}
              onCancel={() => setForm(null)}
            />
          ) : (
            <button
              onClick={() => setForm({})}
              disabled={tells.length === 0}
              className="panel-cut-sm bg-brand-600 px-4 py-2 font-semibold hover:bg-brand-500 disabled:opacity-40"
            >
              + New Move
            </button>
          ))}

        {visibleMoves.length === 0 ? (
          <p className="text-sm text-zinc-600">
            {styleFilter.size > 0 || tagFilter.size > 0
              ? 'No moves match these filters here.'
              : currentFolder != null
                ? 'No moves in this discipline yet — assign moves to it in the Move Creator.'
                : 'No moves here yet.'}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visibleMoves.map((move) => (
              <div
                key={move.id}
                draggable={role === 'gm'}
                onDragStart={role === 'gm' ? (e) => e.dataTransfer.setData('text/move-id', String(move.id)) : undefined}
                onDragEnd={role === 'gm' ? () => setReorderTarget(null) : undefined}
                // Only claim the drop when a move card is what's being
                // dragged: types is readable during dragover where getData
                // is not, so this is the only way to tell before the drop.
                onDragOver={
                  role === 'gm'
                    ? (e) => {
                        if (!e.dataTransfer.types.includes('text/move-id')) return;
                        e.preventDefault();
                        setReorderTarget(move.id);
                      }
                    : undefined
                }
                onDragLeave={
                  role === 'gm'
                    ? () => setReorderTarget((prev) => (prev === move.id ? null : prev))
                    : undefined
                }
                onDrop={role === 'gm' ? (e) => onDropOnMove(e, move) : undefined}
                title={
                  role === 'gm'
                    ? 'Drag onto another move to reorder, onto a discipline to file it, or onto a character to grant it'
                    : undefined
                }
                className={`${role === 'gm' ? 'cursor-grab active:cursor-grabbing' : ''} ${
                  reorderTarget === move.id ? 'ring-2 ring-brand-500' : ''
                }`}
              >
                <MoveCard
                  move={move}
                  allMoves={moves}
                  tell={tellById.get(move.tell_id)}
                  rightTell={move.right_tell_id ? tellById.get(move.right_tell_id) : null}
                  leftTell={move.left_tell_id ? tellById.get(move.left_tell_id) : null}
                  style={move.style_attribute_id ? attrById.get(move.style_attribute_id) : null}
                  combatStyle={
                    move.combat_style_attribute_id
                      ? attrById.get(move.combat_style_attribute_id)
                      : null
                  }
                  tags={move.tag_ids.map((id) => tagById.get(id)).filter(Boolean)}
                  folderLabel={folderPath(move.folder_id, folders) ?? undefined}
                  badge={
                    move.is_default ? (
                      <span className="ml-2 panel-cut-sm bg-zinc-700/60 px-1.5 text-xs font-semibold uppercase text-zinc-400">
                        Default
                      </span>
                    ) : null
                  }
                  actions={
                    role === 'gm' ? (
                      <>
                        {!move.is_default && (
                          <button
                            onClick={() => setGrantOpen(grantOpen === move.id ? null : move.id)}
                            className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-brand-400 hover:bg-brand-900/40 md:min-h-0"
                          >
                            Grant… ({move.granted_character_ids.length})
                          </button>
                        )}
                        <button
                          onClick={() => setForm({ move })}
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 md:min-h-0"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() =>
                            window.confirm(
                              `Delete ${move.name}? It disappears from every character.`
                            ) && socket.emit('move:delete', { moveId: move.id })
                          }
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400 md:min-h-0"
                        >
                          Delete
                        </button>
                      </>
                    ) : null
                  }
                />
                {role === 'gm' && grantOpen === move.id && !move.is_default && (
                  <GrantList move={move} characters={characters} canLearn={canLearn} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {role === 'gm' && (
        <aside className="hidden w-44 shrink-0 md:block">
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
                  className={`flex items-center gap-2 panel-cut border p-2 transition ${
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
    </div>
  );
}

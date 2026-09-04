import { useEffect, useMemo, useState } from 'react';
import { socket } from '../socket.js';
import { getTempNpcs, getTempNpcFolders, getCharacterFolders } from '../lib/api.js';
import { useRoster } from '../lib/useRoster.js';
import { useStage } from '../lib/useStage.js';
import { buildFolderTree } from '../lib/folders.js';
import { FolderRosterNode } from './FolderRoster.jsx';
import FolderTreeNav from './FolderTreeNav.jsx';
import Thumb from './Thumb.jsx';
import TempNpcEditor from './TempNpcEditor.jsx';
import SummonPicker from './SummonPicker.jsx';

// A drag mime of its own (mirrors `text/character-id`, CharacterList's own
// convention) so a Temp NPC card dropped on a folder can't be confused with
// a real character's card doing the same thing elsewhere in the app.
const TEMP_NPC_DRAG_MIME = 'text/temp-npc-id';

// The Scene tab's left drawer (Scene tab plan, Phase 2), GM-only — mounted
// by ScenePage only when `useRole().role === 'gm'`. Two sections, stacked:
//
//   1. **Temp NPCs** — this feature's own brand-new, lightweight roster.
//      Nothing else in the app manages `temp_npc_folders`, so this drawer
//      is genuinely the only place to create/rename/delete/refile one —
//      `FolderTreeNav` (this app's existing "manage a folder tree" widget,
//      already doing exactly this job for character_folders and move
//      Disciplines) is reused as-is for that, with a short list of the
//      current folder's Temp NPCs and an inline "+ New" form beneath it.
//   2. **Characters (NPCs)** — the folder tree itself is read-only here.
//      `character_folders` already has its own management UI (the
//      Character List page); this section only needs to *reflect* that
//      real tree, which is exactly what `FolderRosterNode` already does
//      for the Relationships rail's own "The world" section — same
//      component, same collapse rules, its 3rd consumer (the 4th arrived
//      with Phase 4's Scene list drawer). The cards themselves are NOT
//      read-only, though — every NPC here is click-to-summon (Phase 5).
//
// Clicking a card opens `SummonPicker` (Phase 5) — the GM may summon any
// Temp NPC or real NPC, decision #4's "pick one at summon, swap freely
// after." A Temp NPC's own edit dialog (`TempNpcEditor`, decision #9) moved
// off the card's own click and onto a small "✎" button of its own:
// overloading one element with both a click-to-summon and a
// double-click-to-edit fired the summon picker once on every double-click
// too (a browser dblclick is preceded by two real click events), which is
// harmless for Scenes' own idempotent re-activate but not for popping a
// second dialog open mid-edit. A real NPC card has no such editor here at
// all — it already has a full CharacterSheet, reached the normal way — so
// its whole card stays a single, unambiguous summon trigger.
export default function SceneCastDrawer() {
  const characters = useRoster();
  const stage = useStage();
  const [characterFolders, setCharacterFolders] = useState(null);
  const [tempNpcs, setTempNpcs] = useState(null);
  const [tempNpcFolders, setTempNpcFolders] = useState(null);
  const [currentTempFolder, setCurrentTempFolder] = useState(null);
  const [collapsedNpc, setCollapsedNpc] = useState(new Set());
  const [newTempNpcName, setNewTempNpcName] = useState('');
  const [editingTempNpc, setEditingTempNpc] = useState(null);
  const [summoning, setSummoning] = useState(null); // { ownerType, ownerId, ownerName, currentScenePictureId }

  useEffect(() => {
    let alive = true;
    const refetch = () =>
      getCharacterFolders()
        .then((list) => {
          if (alive) setCharacterFolders(list);
        })
        .catch(console.error);
    refetch();
    const events = ['character_folder:created', 'character_folder:updated', 'character_folder:deleted'];
    for (const ev of events) socket.on(ev, refetch);
    return () => {
      alive = false;
      for (const ev of events) socket.off(ev, refetch);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const refetchTempNpcs = () =>
      getTempNpcs()
        .then((list) => {
          if (alive) setTempNpcs(list);
        })
        .catch(console.error);
    const refetchTempNpcFolders = () =>
      getTempNpcFolders()
        .then((list) => {
          if (alive) setTempNpcFolders(list);
        })
        .catch(console.error);
    refetchTempNpcs();
    refetchTempNpcFolders();
    const npcEvents = ['temp_npc:created', 'temp_npc:updated', 'temp_npc:deleted'];
    const folderEvents = ['temp_npc_folder:created', 'temp_npc_folder:updated', 'temp_npc_folder:deleted'];
    for (const ev of npcEvents) socket.on(ev, refetchTempNpcs);
    for (const ev of folderEvents) socket.on(ev, refetchTempNpcFolders);
    return () => {
      alive = false;
      for (const ev of npcEvents) socket.off(ev, refetchTempNpcs);
      for (const ev of folderEvents) socket.off(ev, refetchTempNpcFolders);
    };
  }, []);

  // Keeps a Temp NPC being edited in sync with live updates (e.g. its own
  // rename), and closes the dialog automatically if it gets deleted out
  // from under the editor.
  useEffect(() => {
    if (!editingTempNpc || !tempNpcs) return;
    const fresh = tempNpcs.find((n) => n.id === editingTempNpc.id);
    if (!fresh) setEditingTempNpc(null);
    else if (fresh !== editingTempNpc) setEditingTempNpc(fresh);
  }, [tempNpcs, editingTempNpc]);

  const toggleNpc = (id) =>
    setCollapsedNpc((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Who's currently on stage, keyed by owner — a card checks this to show
  // its "on stage" badge and to hand SummonPicker the picture it should
  // highlight as already-showing (clicking it again is how a summon toggles
  // off, so the picker needs to know which one that is).
  const summonByOwner = useMemo(() => {
    const map = new Map();
    for (const s of stage?.summons ?? []) {
      if (s.character_id != null) map.set(`character:${s.character_id}`, s);
      if (s.temp_npc_id != null) map.set(`temp_npc:${s.temp_npc_id}`, s);
    }
    return map;
  }, [stage]);

  const openSummonPicker = (ownerType, owner) =>
    setSummoning({
      ownerType,
      ownerId: owner.id,
      ownerName: owner.name,
      currentScenePictureId: summonByOwner.get(`${ownerType}:${owner.id}`)?.scene_picture_id ?? null,
    });

  const npcTree = useMemo(() => buildFolderTree(characterFolders ?? []), [characterFolders]);
  const npcsByFolder = useMemo(() => {
    const map = new Map();
    for (const c of characters ?? []) {
      if (c.character_type !== 'npc') continue;
      const key = c.folder_id ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [characters]);
  const folderlessNpcs = npcsByFolder.get(null) ?? [];

  const tempNpcsInFolder = useMemo(
    () =>
      (tempNpcs ?? [])
        .filter((n) => (n.folder_id ?? null) === currentTempFolder)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [tempNpcs, currentTempFolder]
  );

  const onDropTempNpcOnFolder = (e, targetFolderId) => {
    e.preventDefault();
    const tempNpcId = Number(e.dataTransfer.getData(TEMP_NPC_DRAG_MIME));
    if (tempNpcId) socket.emit('temp_npc:set_folder', { tempNpcId, folderId: targetFolderId });
  };

  const createTempNpc = (e) => {
    e.preventDefault();
    const name = newTempNpcName.trim();
    if (!name) return;
    socket.emit('temp_npc:create', { name, folderId: currentTempFolder });
    setNewTempNpcName('');
  };

  const loading = !characters || !characterFolders || !tempNpcs || !tempNpcFolders;

  return (
    <div
      className="absolute left-0 top-0 z-10 flex h-full w-64 flex-col gap-4 overflow-y-auto border-r border-zinc-800 bg-zinc-950/90 p-3"
      style={{
        // Clears ScenePage's "Back to the Arena" button, which floats
        // above this drawer (z-20) in the same corner rather than pushing
        // this content down — see that file's own comment.
        paddingTop: 'calc(3.5rem + var(--safe-top))',
        paddingBottom: 'calc(0.75rem + var(--safe-bottom))',
        paddingLeft: 'calc(0.75rem + var(--safe-left))',
      }}
    >
      {loading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <>
          <div>
            <SectionLabel>Temp NPCs</SectionLabel>
            <FolderTreeNav
              folders={tempNpcFolders}
              currentFolderId={currentTempFolder}
              onSelect={setCurrentTempFolder}
              canManage
              onCreate={(name, parentFolderId) =>
                socket.emit('temp_npc_folder:create', { name, parentFolderId })
              }
              onRename={(folderId, name) => socket.emit('temp_npc_folder:rename', { folderId, name })}
              onDelete={(folderId) => socket.emit('temp_npc_folder:delete', { folderId })}
              onDropOnFolder={onDropTempNpcOnFolder}
              rootLabel="All Temp NPCs"
              // Specific rather than the generic "folder" (Phase 2's
              // original choice) — SceneListDrawer's own FolderTreeNav
              // (Phase 4) sits right beside this one on the same page, and
              // both used to render an identically-placeholdered "New
              // folder" input, ambiguous to anything querying by it.
              // Mirrors Compendium.jsx's own nounLabel="discipline" for the
              // same reason, against CharacterList's plain "folder".
              nounLabel="Temp NPC folder"
            />
            <div className="mt-2 space-y-1.5">
              {tempNpcsInFolder.map((npc) => (
                <div
                  key={npc.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(TEMP_NPC_DRAG_MIME, String(npc.id))}
                  title={`Summon ${npc.name}`}
                  className="flex w-full items-center gap-1 panel-cut-sm border border-zinc-800 bg-zinc-900 p-1 text-left hover:border-brand-700"
                >
                  <button
                    type="button"
                    onClick={() => openSummonPicker('temp_npc', npc)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Thumb record={npc} name={npc.name} size="h-6 w-6" />
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-300">
                      {npc.name}
                    </span>
                    {summonByOwner.has(`temp_npc:${npc.id}`) && (
                      <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-brand-400">
                        Live
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingTempNpc(npc)}
                    title={`Edit ${npc.name}`}
                    className="shrink-0 px-1 text-xs text-zinc-600 hover:text-zinc-300"
                  >
                    ✎
                  </button>
                </div>
              ))}
              {tempNpcsInFolder.length === 0 && (
                <p className="px-1 text-[10px] text-zinc-600">Nobody filed here yet.</p>
              )}
              <form onSubmit={createTempNpc} className="flex gap-1 pt-1">
                <input
                  value={newTempNpcName}
                  onChange={(e) => setNewTempNpcName(e.target.value)}
                  placeholder="New Temp NPC"
                  className="min-h-11 w-0 min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none focus:border-brand-500 md:min-h-0"
                />
                <button
                  type="submit"
                  disabled={!newTempNpcName.trim()}
                  className="min-h-11 shrink-0 panel-cut-sm bg-zinc-700 px-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 md:min-h-0"
                >
                  +
                </button>
              </form>
            </div>
          </div>

          <div>
            <SectionLabel>Characters (NPCs)</SectionLabel>
            {npcTree.map((node) => (
              <FolderRosterNode
                key={node.id}
                node={node}
                charsByFolder={npcsByFolder}
                collapsed={collapsedNpc}
                onToggle={toggleNpc}
                depth={0}
                rosterCard={(c) => (
                  <NpcCard
                    key={c.id}
                    character={c}
                    onSummon={() => openSummonPicker('character', c)}
                    live={summonByOwner.has(`character:${c.id}`)}
                  />
                )}
              />
            ))}
            {folderlessNpcs.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {folderlessNpcs.map((c) => (
                  <NpcCard
                    key={c.id}
                    character={c}
                    onSummon={() => openSummonPicker('character', c)}
                    live={summonByOwner.has(`character:${c.id}`)}
                  />
                ))}
              </div>
            )}
            {npcTree.length === 0 && folderlessNpcs.length === 0 && (
              <p className="px-1 text-[10px] text-zinc-600">No NPCs in the world yet.</p>
            )}
          </div>
        </>
      )}

      {editingTempNpc && <TempNpcEditor tempNpc={editingTempNpc} onClose={() => setEditingTempNpc(null)} />}
      {summoning && (
        <SummonPicker
          ownerType={summoning.ownerType}
          ownerId={summoning.ownerId}
          ownerName={summoning.ownerName}
          currentScenePictureId={summoning.currentScenePictureId}
          onClose={() => setSummoning(null)}
        />
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="px-1 pb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
      {children}
    </div>
  );
}

// Click-to-summon only — a real NPC already has a full CharacterSheet
// (Scene Pictures tab included, same as every character) for everything
// else, reached the normal way, not from this drawer.
function NpcCard({ character, onSummon, live }) {
  return (
    <button
      type="button"
      onClick={onSummon}
      title={`Summon ${character.name}`}
      className="flex w-full items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900 p-1 text-left hover:border-brand-700"
    >
      <Thumb record={character} name={character.name} size="h-6 w-6" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-300">
        {character.name}
      </span>
      {live && (
        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-brand-400">Live</span>
      )}
    </button>
  );
}

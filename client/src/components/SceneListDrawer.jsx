import { useEffect, useMemo, useState } from 'react';
import { socket } from '../socket.js';
import { getScenes, getSceneFolders } from '../lib/api.js';
import Thumb from './Thumb.jsx';
import FolderTreeNav from './FolderTreeNav.jsx';
import SceneEditor from './SceneEditor.jsx';

const SCENE_DRAG_MIME = 'text/scene-id';

// The Scene tab's right drawer (Scene tab plan, Phase 4), GM-only — mounted
// by ScenePage only when `useRole().role === 'gm'`, mirroring
// SceneCastDrawer's own gate on the opposite edge of the canvas.
//
// Structurally the Temp NPCs section of SceneCastDrawer again: FolderTreeNav
// (this app's own "manage a folder tree" widget) for create/rename/delete/
// navigate, a short list of the current folder's Scenes, and an inline
// "+ New" form. What's different here is the click split, since a Scene
// row has two very different actions worth a single click each:
//   - **single click activates it** (`scene:activate`) — the whole point of
//     this drawer, and the one action a GM will do constantly during a
//     session, so it gets the cheap gesture.
//   - **double-click opens SceneEditor** — renaming, the backdrop picker,
//     deleting. Rarer, so it earns the pricier gesture, the same split
//     Temp NPCs already use for their own editor.
// The active Scene's row is highlighted so the GM can see at a glance what
// every connected Player is currently looking at.
export default function SceneListDrawer({ activeSceneId }) {
  const [scenes, setScenes] = useState(null);
  const [folders, setFolders] = useState(null);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [newSceneName, setNewSceneName] = useState('');
  const [editingScene, setEditingScene] = useState(null);

  useEffect(() => {
    let alive = true;
    const refetchScenes = () =>
      getScenes()
        .then((list) => {
          if (alive) setScenes(list);
        })
        .catch(console.error);
    const refetchFolders = () =>
      getSceneFolders()
        .then((list) => {
          if (alive) setFolders(list);
        })
        .catch(console.error);
    refetchScenes();
    refetchFolders();
    const sceneEvents = ['scene:created', 'scene:updated', 'scene:deleted'];
    const folderEvents = ['scene_folder:created', 'scene_folder:updated', 'scene_folder:deleted'];
    for (const ev of sceneEvents) socket.on(ev, refetchScenes);
    for (const ev of folderEvents) socket.on(ev, refetchFolders);
    return () => {
      alive = false;
      for (const ev of sceneEvents) socket.off(ev, refetchScenes);
      for (const ev of folderEvents) socket.off(ev, refetchFolders);
    };
  }, []);

  // Keeps the open editor in sync with its own live updates (e.g. its own
  // rename or a background finishing upload), and closes it if the Scene
  // gets deleted out from under it.
  useEffect(() => {
    if (!editingScene || !scenes) return;
    const fresh = scenes.find((s) => s.id === editingScene.id);
    if (!fresh) setEditingScene(null);
    else if (fresh !== editingScene) setEditingScene(fresh);
  }, [scenes, editingScene]);

  const scenesInFolder = useMemo(
    () =>
      (scenes ?? [])
        .filter((s) => (s.folder_id ?? null) === currentFolder)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [scenes, currentFolder]
  );

  const onDropSceneOnFolder = (e, targetFolderId) => {
    e.preventDefault();
    const sceneId = Number(e.dataTransfer.getData(SCENE_DRAG_MIME));
    if (sceneId) socket.emit('scene:set_folder', { sceneId, folderId: targetFolderId });
  };

  const createScene = (e) => {
    e.preventDefault();
    const name = newSceneName.trim();
    if (!name) return;
    socket.emit('scene:create', { name, folderId: currentFolder });
    setNewSceneName('');
  };

  const loading = !scenes || !folders;

  return (
    <div
      className="absolute right-0 top-0 z-10 flex h-full w-64 flex-col gap-2 overflow-y-auto border-l border-zinc-800 bg-zinc-950/90 p-3"
      style={{
        // Clears no corner control on this side (the back link lives on the
        // left, with SceneCastDrawer) — just the usual safe-area padding.
        paddingTop: 'calc(0.75rem + var(--safe-top))',
        paddingBottom: 'calc(0.75rem + var(--safe-bottom))',
        paddingRight: 'calc(0.75rem + var(--safe-right))',
      }}
    >
      {loading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <>
          <div className="px-1 pb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
            Scenes
          </div>
          <FolderTreeNav
            folders={folders}
            currentFolderId={currentFolder}
            onSelect={setCurrentFolder}
            canManage
            onCreate={(name, parentFolderId) => socket.emit('scene_folder:create', { name, parentFolderId })}
            onRename={(folderId, name) => socket.emit('scene_folder:rename', { folderId, name })}
            onDelete={(folderId) => socket.emit('scene_folder:delete', { folderId })}
            onDropOnFolder={onDropSceneOnFolder}
            rootLabel="All Scenes"
            // Specific rather than the generic "folder" — SceneCastDrawer's
            // own FolderTreeNav sits right beside this one on the same
            // page; see that file's own comment on nounLabel for why.
            nounLabel="Scene folder"
          />
          <div className="mt-2 space-y-1.5">
            {scenesInFolder.map((scene) => (
              <button
                key={scene.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(SCENE_DRAG_MIME, String(scene.id))}
                onClick={() => socket.emit('scene:activate', { sceneId: scene.id })}
                onDoubleClick={() => setEditingScene(scene)}
                title={
                  scene.id === activeSceneId
                    ? `${scene.name} — currently active`
                    : `Activate ${scene.name} (double-click to edit)`
                }
                className={`flex w-full items-center gap-2 panel-cut-sm border p-1 text-left ${
                  scene.id === activeSceneId
                    ? 'border-brand-500 bg-brand-900/40'
                    : 'border-zinc-800 bg-zinc-900 hover:border-brand-700'
                }`}
              >
                <Thumb record={scene} name={scene.name} size="h-6 w-6" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-300">
                  {scene.name}
                </span>
                {scene.id === activeSceneId && (
                  <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-brand-400">
                    Live
                  </span>
                )}
              </button>
            ))}
            {scenesInFolder.length === 0 && (
              <p className="px-1 text-[10px] text-zinc-600">No Scenes filed here yet.</p>
            )}
            <form onSubmit={createScene} className="flex gap-1 pt-1">
              <input
                value={newSceneName}
                onChange={(e) => setNewSceneName(e.target.value)}
                placeholder="New Scene"
                className="min-h-11 w-0 min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none focus:border-brand-500 md:min-h-0"
              />
              <button
                type="submit"
                disabled={!newSceneName.trim()}
                className="min-h-11 shrink-0 panel-cut-sm bg-zinc-700 px-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 md:min-h-0"
              >
                +
              </button>
            </form>
          </div>
        </>
      )}

      {editingScene && <SceneEditor scene={editingScene} onClose={() => setEditingScene(null)} />}
    </div>
  );
}

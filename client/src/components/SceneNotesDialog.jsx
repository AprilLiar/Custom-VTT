import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getSceneNotes, getMasterNote } from '../lib/api.js';
import DialogShell from './DialogShell.jsx';

// GM Notes (decided, new). Opened from the Scene tab's own corner controls
// (ScenePage.jsx's TopLeftControls, GM-only — this component is never
// reached by a Player, which is why `{ role: 'gm' }` below is hardcoded
// rather than read off useRole()). Two shapes behind one switch:
//   - **Scene Notes**: any number, each pinned to whichever Scene is
//     currently active — server: scene_notes.scene_id, NOT NULL.
//   - **Master Note**: a singleton, the same Note regardless of which Scene
//     you opened this dialog from — for campaign-wide planning that isn't
//     about any one Scene.
// Genuinely GM-secret server-side (see server/db.js's own comment on these
// tables) — not merely hidden client-side the way Temp NPCs/Scenes are, so
// every read here carries `{ role: 'gm' }` and every socket event is one
// only a GM-identified connection was ever sent in the first place.
export default function SceneNotesDialog({ activeScene, onClose }) {
  const [view, setView] = useState('scene'); // 'scene' | 'master'
  const [notes, setNotes] = useState(null);
  const [masterNote, setMasterNote] = useState(null);
  const identity = { role: 'gm' };

  useEffect(() => {
    if (view !== 'scene' || !activeScene) return;
    let cancelled = false;
    setNotes(null);
    getSceneNotes(activeScene.id, identity)
      .then((rows) => { if (!cancelled) setNotes(rows); })
      .catch(console.error);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeScene?.id]);

  useEffect(() => {
    if (view !== 'master') return;
    let cancelled = false;
    setMasterNote(null);
    getMasterNote(identity)
      .then((row) => { if (!cancelled) setMasterNote(row); })
      .catch(console.error);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Live updates so a note created/edited/deleted elsewhere (another GM
  // browser tab, say) patches this open dialog without a refetch.
  // emitToGm already scopes these to GM sockets only — no owner filter to
  // apply client-side the way ScenePicturesEditor's per-owner one needs.
  useEffect(() => {
    const onCreated = (note) =>
      setNotes((prev) => (prev && note.scene_id === activeScene?.id ? [...prev, note] : prev));
    const onUpdated = (note) =>
      setNotes((prev) => (prev ? prev.map((n) => (n.id === note.id ? note : n)) : prev));
    const onDeleted = ({ noteId }) =>
      setNotes((prev) => (prev ? prev.filter((n) => n.id !== noteId) : prev));
    const onMasterUpdated = (row) => setMasterNote(row);
    socket.on('scene_note:created', onCreated);
    socket.on('scene_note:updated', onUpdated);
    socket.on('scene_note:deleted', onDeleted);
    socket.on('master_note:updated', onMasterUpdated);
    return () => {
      socket.off('scene_note:created', onCreated);
      socket.off('scene_note:updated', onUpdated);
      socket.off('scene_note:deleted', onDeleted);
      socket.off('master_note:updated', onMasterUpdated);
    };
  }, [activeScene?.id]);

  const addNote = () => {
    if (!activeScene) return;
    socket.emit('scene_note:create', { sceneId: activeScene.id, title: '', body: '' });
  };

  const tabClass = (active) =>
    `min-h-11 flex-1 panel-cut-sm border px-3 text-sm font-semibold uppercase tracking-wide ${
      active
        ? 'border-brand-500 bg-brand-900/40 text-brand-300'
        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
    }`;

  return (
    <DialogShell title="Notes" onClose={onClose} variant="fullscreen" maxWidth="max-w-2xl" portal>
      <div className="mb-3 flex shrink-0 gap-2">
        <button type="button" onClick={() => setView('scene')} className={tabClass(view === 'scene')}>
          Scene Notes
        </button>
        <button type="button" onClick={() => setView('master')} className={tabClass(view === 'master')}>
          Master Note
        </button>
      </div>

      {view === 'scene' ? (
        !activeScene ? (
          <p className="panel-cut-sm border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-600">
            No Scene is active — Notes are pinned to a specific Scene, so activate one first.
          </p>
        ) : notes == null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-zinc-500">Pinned to {activeScene.name} — nowhere else.</p>
            {notes.map((note) => (
              <NoteCard key={note.id} note={note} />
            ))}
            <button
              type="button"
              onClick={addNote}
              className="min-h-11 w-full panel-cut-sm border border-dashed border-zinc-700 text-xs font-bold uppercase tracking-wide text-zinc-500 hover:border-brand-600 hover:text-zinc-200"
            >
              + Add Note
            </button>
          </div>
        )
      ) : masterNote == null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <MasterNoteEditor note={masterNote} />
      )}
    </DialogShell>
  );
}

// Local draft state seeded once from the note at mount, same shape
// TempNpcEditor.jsx's own name field uses — this is a single-GM-at-a-time
// tool, so there's no live-merge-while-typing case worth building for.
function NoteCard({ note }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const dirty = title !== note.title || body !== note.body;

  const save = () => socket.emit('scene_note:update', { noteId: note.id, title, body });
  const remove = () => {
    if (window.confirm(`Delete this note${note.title ? ` ("${note.title}")` : ''}?`)) {
      socket.emit('scene_note:delete', { noteId: note.id });
    }
  };

  return (
    <div className="space-y-2 panel-cut-sm border border-zinc-800 bg-zinc-900 p-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Untitled Note"
        className="min-h-11 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-semibold outline-none focus:border-brand-500"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        placeholder="Write anything…"
        className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
      />
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={remove}
          className="text-xs font-semibold text-red-500 hover:text-red-400"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty}
          className="min-h-9 panel-cut-sm bg-brand-600 px-4 text-xs font-semibold uppercase tracking-wide hover:bg-brand-500 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function MasterNoteEditor({ note }) {
  const [body, setBody] = useState(note.body);
  const dirty = body !== note.body;
  const save = () => socket.emit('master_note:update', { body });

  return (
    <div className="flex h-full flex-col gap-2">
      <p className="text-xs text-zinc-500">
        One Note for the whole campaign — the same content, reachable from any Scene.
      </p>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Campaign notes…"
        className="min-h-[40dvh] w-full flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-brand-500"
      />
      <button
        type="button"
        onClick={save}
        disabled={!dirty}
        className="min-h-11 shrink-0 self-end panel-cut-sm bg-brand-600 px-5 text-sm font-semibold uppercase tracking-wide hover:bg-brand-500 disabled:opacity-40"
      >
        Save
      </button>
    </div>
  );
}

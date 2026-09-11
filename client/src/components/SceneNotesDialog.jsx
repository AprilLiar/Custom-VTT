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

  // Which note sits in the full-size middle workspace right now — `null`
  // (nothing), `'new'` (a not-yet-created draft), or an existing note's id.
  // A Scene Note reachable through `notes` this way is ALWAYS excluded from
  // the side-box columns below (see `others`) — a note is either the one
  // thing being read/edited in full, or a compact box, never both at once.
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    if (view !== 'scene' || !activeScene) return;
    let cancelled = false;
    setNotes(null);
    setEditingId(null);
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
    const onDeleted = ({ noteId }) => {
      setNotes((prev) => (prev ? prev.filter((n) => n.id !== noteId) : prev));
      setEditingId((cur) => (cur === noteId ? null : cur));
    };
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

  // Saving (create OR update) is what moves a note OUT of the middle
  // workspace and into a side box (decided, new) — it clears `editingId`
  // immediately, before the server's own echo comes back. The just-created
  // case briefly has no matching row in `notes` yet (a normal, accepted
  // async gap this app already tolerates elsewhere) until `onCreated` above
  // appends it — at which point it renders as a box like any other, with no
  // special-casing needed here for "the new one."
  const saveActive = (title, body) => {
    if (editingId === 'new') {
      if (!activeScene) return;
      socket.emit('scene_note:create', { sceneId: activeScene.id, title, body });
    } else {
      socket.emit('scene_note:update', { noteId: editingId, title, body });
    }
    setEditingId(null);
  };
  const deleteActive = () => {
    if (editingId === 'new' || editingId == null) return;
    const note = notes?.find((n) => n.id === editingId);
    if (window.confirm(`Delete this note${note?.title ? ` ("${note.title}")` : ''}?`)) {
      socket.emit('scene_note:delete', { noteId: editingId });
      setEditingId(null);
    }
  };

  const activeNote = editingId === 'new' ? { id: 'new', title: '', body: '' } : notes?.find((n) => n.id === editingId) ?? null;
  // Every OTHER note becomes a compact side box — first filling the left
  // column, then the right (decided, new, verbatim), a plain half/half
  // split so both columns stay roughly balanced as more notes are added,
  // rather than a fixed per-column capacity that would need an arbitrary
  // constant nothing in the request actually specifies.
  const others = (notes ?? []).filter((n) => n.id !== editingId);
  const splitAt = Math.ceil(others.length / 2);
  const leftNotes = others.slice(0, splitAt);
  const rightNotes = others.slice(splitAt);

  const tabClass = (active) =>
    `min-h-11 flex-1 panel-cut-sm border px-3 text-sm font-semibold uppercase tracking-wide [@media(max-height:640px)]:min-h-9 ${
      active
        ? 'border-brand-500 bg-brand-900/40 text-brand-300'
        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
    }`;

  return (
    // max-w-none (decided, revised — the same override `theater` variant
    // uses internally, DialogShell.jsx): the dialog's own `fullscreen`
    // variant already asks for `md:w-full`, so a `maxWidth` class was the
    // only thing actually capping this narrower than the screen. "Extend
    // the space for notes to match the entire screen width" reads literally.
    <DialogShell
      title="Notes"
      onClose={onClose}
      variant="fullscreen"
      maxWidth="max-w-none"
      portal
      panelClassName="[@media(max-height:640px)]:h-full"
    >
      {/* One flex column filling the dialog body, so the tab row and the
          workspace SHARE the available height instead of stacking past it.
          `h-full` on the workspace alone meant "the whole body" — plus the tabs
          above it, which is exactly the overflow that pushed Save off a
          landscape phone's screen. */}
      <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 gap-2 [@media(max-height:640px)]:mb-2">
        <button type="button" onClick={() => setView('scene')} className={tabClass(view === 'scene')}>
          Scene Notes
        </button>
        <button type="button" onClick={() => setView('master')} className={tabClass(view === 'master')}>
          Master Note
        </button>
        {view === 'scene' && activeScene && (
          <button
            type="button"
            onClick={() => setEditingId('new')}
            className="min-h-11 shrink-0 panel-cut-sm border border-dashed border-zinc-700 px-3 text-xs font-bold uppercase tracking-wide text-zinc-500 hover:border-brand-600 hover:text-zinc-200 [@media(max-height:640px)]:min-h-9"
          >
            + Add Note
          </button>
        )}
      </div>

      {view === 'scene' ? (
        !activeScene ? (
          <p className="panel-cut-sm border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-600">
            No Scene is active — Notes are pinned to a specific Scene, so activate one first.
          </p>
        ) : notes == null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[1fr_1.4fr_1fr] [@media(max-height:640px)]:flex-1">
            <NoteColumn notes={leftNotes} onOpen={setEditingId} order="order-2 md:order-1" />
            <div className="order-1 min-h-[60dvh] md:order-2 [@media(max-height:640px)]:min-h-0">
              {activeNote ? (
                <NoteEditor
                  key={activeNote.id}
                  note={activeNote}
                  isNew={editingId === 'new'}
                  onSave={saveActive}
                  onCancel={() => setEditingId(null)}
                  onDelete={editingId !== 'new' ? deleteActive : undefined}
                />
              ) : (
                <div className="flex h-full min-h-[60dvh] flex-col items-center justify-center gap-3 panel-cut-sm border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-600">
                  <p>Select a note to read or edit it in full, or add a new one.</p>
                  <button
                    type="button"
                    onClick={() => setEditingId('new')}
                    className="min-h-11 panel-cut-sm border border-zinc-700 px-4 text-xs font-bold uppercase tracking-wide text-zinc-400 hover:border-brand-600 hover:text-zinc-200"
                  >
                    + Add Note
                  </button>
                </div>
              )}
            </div>
            <NoteColumn notes={rightNotes} onOpen={setEditingId} order="order-3" />
          </div>
        )
      ) : masterNote == null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <MasterNoteEditor note={masterNote} />
      )}
      </div>
    </DialogShell>
  );
}

// A side column of compact, already-saved notes — capped and independently
// scrollable so a long list never pushes the middle workspace off-screen
// (DialogShell's own body is ONE shared scroll container otherwise; this
// nested one is what actually fixes "impossible to see it fully without
// scrolling" for the note you're ACTUALLY working on, while still letting
// a long list of others scroll on its own). Each individual box shows its
// FULL body (decided, revised — no `line-clamp`), growing to whatever
// height its own text needs rather than being cut short with an ellipsis;
// `whitespace-pre-wrap` keeps the line breaks the note was actually typed
// with, which a plain `<p>` would otherwise collapse away.
function NoteColumn({ notes, onOpen, order }) {
  return (
    <div className={`${order} max-h-[70dvh] space-y-2 overflow-y-auto pr-1 [@media(max-height:640px)]:max-h-full`}>
      {notes.map((note) => (
        <button
          key={note.id}
          type="button"
          onClick={() => onOpen(note.id)}
          className="block w-full panel-cut-sm border border-zinc-800 bg-zinc-900 p-3 text-left hover:border-brand-600"
        >
          <p className="truncate text-base font-semibold text-zinc-200">{note.title || 'Untitled Note'}</p>
          {note.body && (
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-400">{note.body}</p>
          )}
        </button>
      ))}
    </div>
  );
}

// The one full-size workspace — local draft state seeded once from the note
// at mount (TempNpcEditor.jsx's own shape; this is a single-GM-at-a-time
// tool, so there's no live-merge-while-typing case worth building), keyed
// by the caller on `note.id` so switching which note is active always
// re-seeds a fresh draft rather than reusing stale state across notes.
function NoteEditor({ note, isNew, onSave, onCancel, onDelete }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const dirty = isNew || title !== note.title || body !== note.body;

  return (
    // **The breakpoint here is HEIGHT, not width (decided, revised — "notes are
    // barely visible on mobile").**
    //
    // The Scene tab is landscape-only (OrientationGate), so "Notes on mobile"
    // means a phone held sideways — about 844x390. That is WIDER than Tailwind's
    // `md`, so every `md:` rule in this file already applies to it: a phone was
    // getting the full desktop layout, three columns and all, inside 390px of
    // height. Sizing this by width could never have fixed it, and 50dvh of a
    // landscape phone is 195px — half of which the title field and the button
    // row take, which is exactly the "barely visible" being reported.
    //
    // So the short-viewport rule is written against `max-height` and gives the
    // open note nearly the whole dialog; the textarea below scrolls inside
    // whatever that comes to.
    <div className="flex h-full min-h-[60dvh] flex-col gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900 p-3 [@media(max-height:640px)]:min-h-0 [@media(max-height:640px)]:gap-1.5 [@media(max-height:640px)]:p-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Untitled Note"
        // text-base on mobile is not only legibility: iOS Safari zooms the
        // whole page in when a focused field's text is under 16px, and a
        // dialog that zooms on every tap into the title is unusable one-handed.
        className="min-h-11 w-full shrink-0 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-base font-semibold outline-none focus:border-brand-500 [@media(max-height:640px)]:min-h-9"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write anything…"
        // `flex-1` gives it the workspace's full height, and `min-h-0` is what
        // lets it actually SCROLL inside that height: without it a flex item
        // floors at its content size, so a long note grew the box and pushed
        // Save off the bottom of the dialog instead of scrolling within itself.
        // leading-relaxed because a wall of notes is read, not just written.
        className="w-full min-h-0 flex-1 resize-none overflow-y-auto panel-cut-sm border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-base leading-relaxed outline-none focus:border-brand-500"
      />
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="text-xs font-semibold text-zinc-500 hover:text-zinc-300">
            Cancel
          </button>
          {onDelete && (
            <button type="button" onClick={onDelete} className="text-xs font-semibold text-red-500 hover:text-red-400">
              Delete
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => onSave(title, body)}
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
    // Same height rule as a Scene Note: fill the dialog and scroll inside it,
    // rather than a dvh guess that overflows a landscape phone.
    <div className="flex h-full min-h-[60dvh] flex-col gap-2 [@media(max-height:640px)]:min-h-0 [@media(max-height:640px)]:flex-1">
      <p className="shrink-0 text-xs text-zinc-500">
        One Note for the whole campaign — the same content, reachable from any Scene.
      </p>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Campaign notes…"
        className="min-h-0 w-full flex-1 resize-none overflow-y-auto panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-base leading-relaxed outline-none focus:border-brand-500"
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

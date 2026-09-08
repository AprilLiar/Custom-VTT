import { useEffect, useState } from 'react';
import { Pencil, Play } from 'lucide-react';
import { socket } from '../socket.js';
import { getSceneTimestamps } from '../lib/api.js';
import DialogShell from './DialogShell.jsx';

// The Timestamp tool's management dialog (Scene tab, GM-exclusive — opened
// from SceneDrawToolbar's own bottom-right dock, `role === 'gm'` gated
// there, so `{ role: 'gm' }` below is hardcoded the same way
// SceneNotesDialog.jsx's own read is: this component is never reached by a
// Player. Genuinely GM-secret server-side too (db.js's own comment on
// scene_timestamps) — every read/write here carries `{ role: 'gm' }` and
// every socket event is one only a GM-identified connection was ever sent.
//
// **One flat, global list, not per-Scene (decided).** A Timestamp is a
// moment in the CAMPAIGN's own timeline ("Day 12", "Three years later…"),
// not an annotation belonging to whichever Scene backdrop happens to be
// active — same reasoning the Master Note already uses, just as its own
// multi-row table instead of a singleton. So there is no Scene-switch tab
// the way Notes has one; every Timestamp is always in this one list.
//
// **Cards, not rows — because "play" needs to be a giant, obvious, hard-to-
// miss button, and "edit" a small, out-of-the-way one (verbatim spec).**
// Modeled on a video-thumbnail hover: the card shows its name at rest, and
// hovering (or, on a coarse pointer, always — `.hover-only-action`, same
// convention CharacterList.jsx's own card actions use) reveals a large
// centered Play and a small corner Edit, the same corner-chip look
// StageRoster's own Resize/Remove/Hide buttons already use.
export default function SceneTimestampDialog({ onClose }) {
  const [timestamps, setTimestamps] = useState(null);
  const identity = { role: 'gm' };

  // Which Timestamp sits in the editor right now — `null` (grid), `'new'`
  // (a not-yet-created draft), or an existing Timestamp's id. Same shape
  // SceneNotesDialog.jsx's own `editingId` uses.
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getSceneTimestamps(identity)
      .then((rows) => {
        if (!cancelled) setTimestamps(rows);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live updates so a Timestamp created/edited/deleted elsewhere (another
  // GM browser tab, say) patches this open dialog without a refetch —
  // emitToGm already scopes these to GM sockets only.
  useEffect(() => {
    const onCreated = (ts) => setTimestamps((prev) => (prev ? [...prev, ts] : prev));
    const onUpdated = (ts) =>
      setTimestamps((prev) => (prev ? prev.map((t) => (t.id === ts.id ? ts : t)) : prev));
    const onDeleted = ({ timestampId }) => {
      setTimestamps((prev) => (prev ? prev.filter((t) => t.id !== timestampId) : prev));
      setEditingId((cur) => (cur === timestampId ? null : cur));
    };
    socket.on('scene_timestamp:created', onCreated);
    socket.on('scene_timestamp:updated', onUpdated);
    socket.on('scene_timestamp:deleted', onDeleted);
    return () => {
      socket.off('scene_timestamp:created', onCreated);
      socket.off('scene_timestamp:updated', onUpdated);
      socket.off('scene_timestamp:deleted', onDeleted);
    };
  }, []);

  const save = (name, dateText, subtext) => {
    if (editingId === 'new') {
      socket.emit('scene_timestamp:create', { name, dateText, subtext });
    } else {
      socket.emit('scene_timestamp:update', { timestampId: editingId, name, dateText, subtext });
    }
    setEditingId(null);
  };
  const deleteActive = () => {
    if (editingId === 'new' || editingId == null) return;
    const ts = timestamps?.find((t) => t.id === editingId);
    if (window.confirm(`Delete this Timestamp${ts?.name ? ` ("${ts.name}")` : ''}?`)) {
      socket.emit('scene_timestamp:delete', { timestampId: editingId });
      setEditingId(null);
    }
  };
  // Playing closes the whole dialog first — the point of a full-screen
  // dim-and-fade beat is lost if it's playing out behind the GM's own
  // management window instead of over the Scene everyone else is looking
  // at.
  const play = (ts) => {
    socket.emit('stage:timestamp_play', { timestampId: ts.id });
    onClose();
  };

  const activeTimestamp =
    editingId === 'new'
      ? { id: 'new', name: '', date_text: '', subtext: '' }
      : (timestamps?.find((t) => t.id === editingId) ?? null);

  return (
    <DialogShell title="Timestamps" onClose={onClose} variant="fullscreen" maxWidth="max-w-none" portal>
      {activeTimestamp ? (
        <TimestampEditor
          key={activeTimestamp.id}
          timestamp={activeTimestamp}
          isNew={editingId === 'new'}
          onSave={save}
          onCancel={() => setEditingId(null)}
          onDelete={editingId !== 'new' ? deleteActive : undefined}
        />
      ) : timestamps == null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {timestamps.map((ts) => (
            <TimestampCard key={ts.id} timestamp={ts} onPlay={() => play(ts)} onEdit={() => setEditingId(ts.id)} />
          ))}
          <button
            type="button"
            onClick={() => setEditingId('new')}
            className="flex aspect-[4/3] flex-col items-center justify-center gap-1 panel-cut-sm border border-dashed border-zinc-700 text-zinc-500 hover:border-brand-600 hover:text-zinc-200"
          >
            <span className="text-2xl leading-none">+</span>
            <span className="text-xs font-bold uppercase tracking-wide">New Timestamp</span>
          </button>
          {timestamps.length === 0 && (
            <p className="col-span-full py-4 text-center text-sm text-zinc-600">
              No Timestamps yet — add one to play it for the whole table.
            </p>
          )}
        </div>
      )}
    </DialogShell>
  );
}

// A single card: the name (and a small Date/subtext preview) at rest, a
// giant centered Play plus a small corner Edit on hover/coarse-pointer.
// `group`/`hover-only-action` is the exact CharacterList.jsx convention —
// see that file's own comment on why a hover-only affordance needs the
// coarse-pointer default-visible override at all.
function TimestampCard({ timestamp, onPlay, onEdit }) {
  return (
    <div className="group relative aspect-[4/3] panel-cut-sm border border-zinc-800 bg-zinc-900 p-3">
      <p className="truncate text-sm font-semibold text-zinc-200">{timestamp.name || 'Untitled Timestamp'}</p>
      {timestamp.date_text && (
        <p className="mt-1 truncate text-xs font-bold uppercase tracking-wide text-zinc-400">
          {timestamp.date_text}
        </p>
      )}
      {timestamp.subtext && <p className="mt-0.5 truncate text-xs text-zinc-600">{timestamp.subtext}</p>}

      <button
        type="button"
        onClick={onPlay}
        title="Play"
        aria-label="Play"
        className="hover-only-action absolute inset-0 m-auto flex h-16 w-16 items-center justify-center rounded-full border-2 border-brand-500 bg-zinc-950/80 text-brand-300 opacity-0 transition hover:bg-brand-900/60 group-hover:opacity-100"
      >
        <Play size={28} fill="currentColor" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onEdit}
        title="Edit"
        aria-label="Edit"
        className="hover-only-action absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/80 text-zinc-300 opacity-0 transition hover:border-brand-500 hover:text-brand-300 group-hover:opacity-100"
      >
        <Pencil size={14} aria-hidden />
      </button>
    </div>
  );
}

// The create/edit form — local draft state seeded once at mount, same
// single-GM-at-a-time shape SceneNotesDialog.jsx's own NoteEditor uses (no
// live-merge-while-typing case worth building here either).
function TimestampEditor({ timestamp, isNew, onSave, onCancel, onDelete }) {
  const [name, setName] = useState(timestamp.name);
  const [dateText, setDateText] = useState(timestamp.date_text);
  const [subtext, setSubtext] = useState(timestamp.subtext);
  const dirty =
    isNew || name !== timestamp.name || dateText !== timestamp.date_text || subtext !== timestamp.subtext;
  const canSave = name.trim().length > 0;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3">
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. The Siege Begins"
          className="min-h-11 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <p className="mt-1 text-[11px] text-zinc-600">Identifies it in this list only — never shown when played.</p>
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Date
        </label>
        <input
          value={dateText}
          onChange={(e) => setDateText(e.target.value)}
          placeholder="e.g. Day 12, or Three Years Later…"
          className="min-h-11 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <p className="mt-1 text-[11px] text-zinc-600">The big bold text shown when this plays.</p>
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Subtext
        </label>
        <input
          value={subtext}
          onChange={(e) => setSubtext(e.target.value)}
          placeholder="Optional — a smaller line shown beneath the Date"
          className="min-h-11 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
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
          onClick={() => onSave(name, dateText, subtext)}
          disabled={!dirty || !canSave}
          className="min-h-9 panel-cut-sm bg-brand-600 px-4 text-xs font-semibold uppercase tracking-wide hover:bg-brand-500 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

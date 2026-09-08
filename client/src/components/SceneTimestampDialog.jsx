import { useEffect, useRef, useState } from 'react';
import { Pencil, Play, Star } from 'lucide-react';
import { socket } from '../socket.js';
import { getSceneTimestamps } from '../lib/api.js';
import { formatTimestampDate } from '../lib/timestampFormat.js';
import DialogShell from './DialogShell.jsx';

const COLUMNS = 7;

// The Timestamp tool's management dialog (Scene tab, GM-exclusive — opened
// from SceneDrawToolbar's own bottom-right dock, `role === 'gm'` gated
// there, so `{ role: 'gm' }` below is hardcoded the same way
// SceneNotesDialog.jsx's own read is: this component is never reached by a
// Player. Genuinely GM-secret server-side too (db.js's own comment on
// scene_timestamps) — every read/write here carries `{ role: 'gm' }` and
// every socket event is one only a GM-identified connection was ever sent.
//
// **One flat, global list, not per-Scene (decided).** A Timestamp is a
// moment in the CAMPAIGN's own timeline, not an annotation belonging to
// whichever Scene backdrop happens to be active — same reasoning the
// Master Note already uses, just as its own multi-row table instead of a
// singleton.
//
// **Sort/grouping is the server's, not this component's (decided).** The
// REST read already returns rows `ORDER BY date, id` (server/index.js's
// own comment on why undated rows sort last) — this file only CHUNKS that
// already-sorted list into rows, it never re-sorts it, so there is exactly
// one place ("what order do Timestamps come in") to keep correct.
export default function SceneTimestampDialog({ onClose }) {
  const [timestamps, setTimestamps] = useState(null);
  const identity = { role: 'gm' };

  // Which Timestamp sits in the editor right now — `null` (grid), `'new'`
  // (a not-yet-created draft), or an existing Timestamp's id. Same shape
  // SceneNotesDialog.jsx's own `editingId` uses.
  const [editingId, setEditingId] = useState(null);

  const currentCardRef = useRef(null);
  const scrolledToCurrentRef = useRef(false);

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

  // **Auto-scroll to the Current Timestamp, once, the first time the list
  // actually has one to scroll to (verbatim spec: "so after there are a
  // lot of them, I do not need to scroll for a long time").** Guarded by a
  // ref rather than running on every `timestamps` update — re-scrolling
  // every time a live edit patches the list (this GM's own save, or
  // another GM tab's) would yank the view out from under whatever the GM
  // is actually looking at right now.
  useEffect(() => {
    if (scrolledToCurrentRef.current || !timestamps || editingId != null) return;
    if (currentCardRef.current) {
      currentCardRef.current.scrollIntoView({ block: 'center', behavior: 'instant' });
      scrolledToCurrentRef.current = true;
    }
  }, [timestamps, editingId]);

  // Live updates so a Timestamp created/edited/deleted/starred elsewhere
  // (another GM browser tab, say) patches this open dialog without a
  // refetch — emitToGm already scopes these to GM sockets only.
  useEffect(() => {
    const onCreated = (ts) => setTimestamps((prev) => (prev ? [...prev, ts] : prev));
    const onUpdated = (ts) =>
      setTimestamps((prev) => (prev ? prev.map((t) => (t.id === ts.id ? ts : t)) : prev));
    const onDeleted = ({ timestampId }) => {
      setTimestamps((prev) => (prev ? prev.filter((t) => t.id !== timestampId) : prev));
      setEditingId((cur) => (cur === timestampId ? null : cur));
    };
    const onCurrentChanged = ({ currentId }) =>
      setTimestamps((prev) => (prev ? prev.map((t) => ({ ...t, is_current: t.id === currentId ? 1 : 0 })) : prev));
    socket.on('scene_timestamp:created', onCreated);
    socket.on('scene_timestamp:updated', onUpdated);
    socket.on('scene_timestamp:deleted', onDeleted);
    socket.on('scene_timestamp:current_changed', onCurrentChanged);
    return () => {
      socket.off('scene_timestamp:created', onCreated);
      socket.off('scene_timestamp:updated', onUpdated);
      socket.off('scene_timestamp:deleted', onDeleted);
      socket.off('scene_timestamp:current_changed', onCurrentChanged);
    };
  }, []);

  const save = (name, date, subtext) => {
    if (editingId === 'new') {
      socket.emit('scene_timestamp:create', { name, date, subtext });
    } else {
      socket.emit('scene_timestamp:update', { timestampId: editingId, name, date, subtext });
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
  const toggleCurrent = (ts) => socket.emit('scene_timestamp:set_current', { timestampId: ts.id });

  const activeTimestamp =
    editingId === 'new'
      ? { id: 'new', name: '', date: '', subtext: '' }
      : (timestamps?.find((t) => t.id === editingId) ?? null);

  // **Grouped into rows of at most COLUMNS, but a new date ALWAYS starts a
  // fresh row even if the previous one still had room (verbatim spec).**
  // Not a CSS concern — `grid-auto-flow` has no way to express "restart
  // the row on a value change" — so the rows are built here in JS and each
  // rendered as its own same-width `grid-cols-COLUMNS` line; every row
  // shares that identical column template, so they still visually align
  // into one continuous grid despite being separate DOM rows.
  const rows = timestamps ? groupIntoRows(timestamps) : [];

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
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
              {row.map((ts) => (
                <TimestampCard
                  key={ts.id}
                  cardRef={ts.is_current ? currentCardRef : undefined}
                  timestamp={ts}
                  onPlay={() => play(ts)}
                  onEdit={() => setEditingId(ts.id)}
                  onToggleCurrent={() => toggleCurrent(ts)}
                />
              ))}
            </div>
          ))}
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
            <button
              type="button"
              onClick={() => setEditingId('new')}
              title="New Timestamp"
              className="flex h-14 items-center justify-center panel-cut-sm border border-dashed border-zinc-700 text-lg leading-none text-zinc-500 hover:border-brand-600 hover:text-zinc-200"
            >
              +
            </button>
          </div>
          {timestamps.length === 0 && (
            <p className="py-4 text-center text-sm text-zinc-600">
              No Timestamps yet — add one to play it for the whole table.
            </p>
          )}
        </div>
      )}
    </DialogShell>
  );
}

// Every entry already arrives sorted by date (the REST read's own `ORDER
// BY`) — this only chunks that order into fixed-width rows, restarting a
// row early whenever the date changes even if the row isn't full yet.
function groupIntoRows(sorted) {
  const rows = [];
  let row = [];
  let lastDate = null;
  for (const ts of sorted) {
    if (row.length > 0 && ts.date !== lastDate) {
      rows.push(row);
      row = [];
    }
    row.push(ts);
    lastDate = ts.date;
    if (row.length === COLUMNS) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

// A single, deliberately SMALL card — "much smaller… so more fit
// simultaneously" (verbatim spec) — just the name and formatted date at
// rest. Star and Edit share the top-right corner (Star nearer the edge,
// verbatim "near the edit button"); the giant centered Play is the same
// video-thumbnail-hover convention the previous, larger card used, just
// scaled down to match. `.hover-only-action`/`group-hover` is the same
// CharacterList.jsx convention as before — a coarse pointer has no hover,
// so it defaults visible there instead of being permanently unreachable.
// The Current Timestamp's Star stays visible even without hovering (a
// small always-on badge doubling as its own toggle) so which one is
// Current reads at a glance across the whole grid, not just on hover.
function TimestampCard({ timestamp, onPlay, onEdit, onToggleCurrent, cardRef }) {
  const isCurrent = Boolean(timestamp.is_current);
  return (
    <div
      ref={cardRef}
      className={`group relative flex h-14 flex-col justify-center gap-0.5 overflow-hidden panel-cut-sm border p-1.5 ${
        isCurrent ? 'border-brand-500 bg-brand-900/30' : 'border-zinc-800 bg-zinc-900'
      }`}
    >
      <p className="truncate text-[11px] font-semibold leading-tight text-zinc-200">
        {timestamp.name || 'Untitled'}
      </p>
      <p className="truncate text-[10px] leading-tight text-zinc-500">
        {formatTimestampDate(timestamp.date) || ' '}
      </p>

      <button
        type="button"
        onClick={onPlay}
        title="Play"
        aria-label="Play"
        className="hover-only-action absolute inset-0 m-auto flex h-8 w-8 items-center justify-center rounded-full border-2 border-brand-500 bg-zinc-950/80 text-brand-300 opacity-0 transition hover:bg-brand-900/60 group-hover:opacity-100"
      >
        <Play size={16} fill="currentColor" aria-hidden />
      </button>
      <div className="absolute right-1 top-1 flex gap-0.5">
        <button
          type="button"
          onClick={onToggleCurrent}
          title={isCurrent ? 'Current — click to unmark' : 'Mark as Current'}
          aria-label={isCurrent ? 'Current — click to unmark' : 'Mark as Current'}
          className={`flex h-5 w-5 items-center justify-center rounded-full border transition ${
            isCurrent
              ? 'border-brand-500 bg-brand-900/70 text-brand-300 opacity-100'
              : 'hover-only-action border-zinc-600 bg-zinc-900/80 text-zinc-300 opacity-0 hover:border-brand-500 hover:text-brand-300 group-hover:opacity-100'
          }`}
        >
          <Star size={10} fill={isCurrent ? 'currentColor' : 'none'} aria-hidden />
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="Edit"
          aria-label="Edit"
          className="hover-only-action flex h-5 w-5 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/80 text-zinc-300 opacity-0 transition hover:border-brand-500 hover:text-brand-300 group-hover:opacity-100"
        >
          <Pencil size={10} aria-hidden />
        </button>
      </div>
    </div>
  );
}

// The create/edit form — local draft state seeded once at mount, same
// single-GM-at-a-time shape SceneNotesDialog.jsx's own NoteEditor uses (no
// live-merge-while-typing case worth building here either). `date` is a
// real `<input type="date">` now (decided, revised — was free text): this
// game's calendar reads as an actual calendar, and sorting/grouping the
// grid above depends on it being one.
function TimestampEditor({ timestamp, isNew, onSave, onCancel, onDelete }) {
  const [name, setName] = useState(timestamp.name);
  const [date, setDate] = useState(timestamp.date);
  const [subtext, setSubtext] = useState(timestamp.subtext);
  const dirty = isNew || name !== timestamp.name || date !== timestamp.date || subtext !== timestamp.subtext;
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
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="min-h-11 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <p className="mt-1 text-[11px] text-zinc-600">
          Shown as {formatTimestampDate(date) || '"May 12, 2015"'} when played — also what sorts the grid.
        </p>
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
          onClick={() => onSave(name, date, subtext)}
          disabled={!dirty || !canSave}
          className="min-h-9 panel-cut-sm bg-brand-600 px-4 text-xs font-semibold uppercase tracking-wide hover:bg-brand-500 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

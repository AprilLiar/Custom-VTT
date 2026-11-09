import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, EyeOff, GripVertical, Plus, Trash2, Users } from 'lucide-react';
import { socket } from '../socket.js';
import { useRole } from '../roleContext.jsx';
import { getEvents } from '../lib/api.js';
import { useSocketRefresh } from '../lib/connection.js';

// **The Events tab (decided, new):** sticky notes in lanes, for everyone.
//   - The GM makes lanes: a name and a visibility (Everyone / GM only),
//     renames, toggles, reorders and deletes them.
//   - Anyone who sees a lane writes notes straight into it (short text, a
//     colour). Only the author or the GM edits or deletes a note.
//   - Anyone who sees a note drags it: along its lane, or into another lane
//     they can see. Each lane is a row of notes that scrolls on its own.
// The server shapes the board per viewer (server/events.js), so a Player never
// receives a GM-only lane at all.

export const NOTE_COLORS = {
  yellow: 'bg-amber-200 text-zinc-900',
  pink: 'bg-pink-200 text-zinc-900',
  blue: 'bg-sky-200 text-zinc-900',
  green: 'bg-lime-200 text-zinc-900',
  orange: 'bg-orange-300 text-zinc-900',
};
const NOTE_MAX = 280;
const DRAG_THRESHOLD = 6;
const EDGE = 48; // px from a lane's edge that scrolls it while dragging

export default function EventsPage() {
  const { role, characterId } = useRole();
  const isGm = role === 'gm';
  const [board, setBoard] = useState(null);
  const [editing, setEditing] = useState(null); // { laneId, note? }
  const identity = isGm ? { role: 'gm' } : { role: 'player', characterId };

  const refresh = useCallback(() => {
    getEvents(identity)
      .then(setBoard)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, characterId]);
  useSocketRefresh(refresh);
  useEffect(() => {
    refresh();
    socket.on('events:updated', setBoard);
    return () => socket.off('events:updated', setBoard);
  }, [refresh]);

  // ---- dragging a note
  const [drag, setDrag] = useState(null); // { note, fromLane, x, y, dx, dy, w, h, moved }
  const [drop, setDrop] = useState(null); // { laneId, index }
  const start = useRef(null);
  const dropAt = (x, y, noteId) => {
    const row = document.elementsFromPoint(x, y).map((el) => el.closest?.('[data-lane-row]')).find(Boolean);
    if (!row) return null;
    // Scroll the lane when held near its ends.
    const r = row.getBoundingClientRect();
    if (x < r.left + EDGE) row.scrollLeft -= 14;
    else if (x > r.right - EDGE) row.scrollLeft += 14;
    const cards = [...row.querySelectorAll('[data-note-id]')].filter((el) => Number(el.dataset.noteId) !== noteId);
    const index = cards.filter((el) => {
      const b = el.getBoundingClientRect();
      return b.left + b.width / 2 < x;
    }).length;
    return { laneId: Number(row.dataset.laneRow), index };
  };
  const onNoteDown = (e, note, laneId) => {
    if (e.button !== 0) return;
    // Touch drags by the grip, so a lane still scrolls under a finger.
    if (e.pointerType !== 'mouse' && !e.target.closest('[data-grip]')) return;
    const b = e.currentTarget.getBoundingClientRect();
    start.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ note, fromLane: laneId, x: e.clientX, y: e.clientY, dx: e.clientX - b.left, dy: e.clientY - b.top, w: b.width, h: b.height, moved: false });
  };
  const onNoteMove = (e) => {
    if (!drag) return;
    const moved = drag.moved || Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > DRAG_THRESHOLD;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, moved });
    if (moved) setDrop(dropAt(e.clientX, e.clientY, drag.note.id));
  };
  const onNoteUp = (e) => {
    if (!drag) return;
    const d = drag.moved ? dropAt(e.clientX, e.clientY, drag.note.id) : null;
    if (!drag.moved) {
      if (drag.note.mine) setEditing({ laneId: drag.fromLane, note: drag.note });
    } else if (d) {
      // Shown at once; the server's board follows.
      setBoard((b) => moveLocally(b, drag.note.id, d.laneId, d.index));
      socket.emit('event_note:move', { noteId: drag.note.id, laneId: d.laneId, index: d.index });
    }
    setDrag(null);
    setDrop(null);
  };

  const lanes = board?.lanes ?? [];
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-bold uppercase tracking-wide">Events</h1>
          <p className="text-xs text-zinc-500">Sticky notes in lanes. Drag a note along its lane or into another one{isGm ? '' : ' — the GM makes the lanes'}.</p>
        </div>
        {isGm && <NewLaneForm />}
      </div>
      {board && !lanes.length && (
        <p className="panel-cut-sm border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
          {isGm ? 'No lanes yet — add one above, then write notes into it.' : 'No lanes yet. Once the GM makes one, you can write notes into it.'}
        </p>
      )}
      {lanes.map((lane, i) => (
        <section key={lane.id} className="panel-cut-sm border border-zinc-800 bg-zinc-950/70 p-2" aria-label={`Lane ${lane.name}`}>
          <LaneHeader lane={lane} index={i} count={lanes.length} isGm={isGm} lanes={lanes} />
          <div data-lane-row={lane.id} className="flex min-h-36 items-stretch gap-3 overflow-x-auto px-1 pb-2 pt-1">
            {lane.notes.map((note, ni) => (
              <NoteSlot key={note.id} showMarker={drop?.laneId === lane.id && drop.index === ni && drag?.moved}>
                <Note
                  note={note}
                  dragging={drag?.moved && drag.note.id === note.id}
                  onPointerDown={(e) => onNoteDown(e, note, lane.id)}
                  onPointerMove={onNoteMove}
                  onPointerUp={onNoteUp}
                  onPointerCancel={() => {
                    setDrag(null);
                    setDrop(null);
                  }}
                />
              </NoteSlot>
            ))}
            {drop?.laneId === lane.id && drop.index >= lane.notes.filter((n) => n.id !== drag?.note.id).length && drag?.moved && <DropMarker />}
            <button
              type="button"
              onClick={() => setEditing({ laneId: lane.id })}
              className="flex w-36 shrink-0 flex-col items-center justify-center gap-1 panel-cut-sm border border-dashed border-zinc-700 text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:border-brand-500 hover:text-brand-300"
            >
              <Plus size={18} />
              Note
            </button>
          </div>
        </section>
      ))}
      {drag?.moved && (
        <div className="pointer-events-none fixed z-[100] opacity-90" style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w, height: drag.h }}>
          <NoteFace note={drag.note} lifted />
        </div>
      )}
      {editing && <NoteEditor editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// The board with one note moved, as the server will have it.
function moveLocally(board, noteId, laneId, index) {
  if (!board) return board;
  let moving = null;
  const without = board.lanes.map((l) => {
    const n = l.notes.find((x) => x.id === noteId);
    if (n) moving = n;
    return { ...l, notes: l.notes.filter((x) => x.id !== noteId) };
  });
  if (!moving) return board;
  return {
    ...board,
    lanes: without.map((l) => (l.id === laneId ? { ...l, notes: [...l.notes.slice(0, index), moving, ...l.notes.slice(index)] } : l)),
  };
}

function NoteSlot({ showMarker, children }) {
  return (
    <>
      {showMarker && <DropMarker />}
      {children}
    </>
  );
}
const DropMarker = () => <div aria-hidden className="w-1 shrink-0 self-stretch rounded-full bg-brand-400 shadow-[0_0_8px] shadow-brand-500" />;

function Note({ note, dragging, ...handlers }) {
  return (
    <div data-note-id={note.id} className={`w-44 shrink-0 touch-pan-x select-none ${dragging ? 'opacity-30' : ''}`} {...handlers}>
      <NoteFace note={note} />
    </div>
  );
}

function NoteFace({ note, lifted = false }) {
  return (
    <article
      className={`relative flex h-full min-h-32 flex-col gap-1 p-3 pr-6 shadow-md ${NOTE_COLORS[note.color] ?? NOTE_COLORS.yellow} ${lifted ? 'rotate-2 shadow-2xl' : ''} ${note.mine ? 'cursor-pointer' : 'cursor-grab'}`}
      title={note.mine ? 'Drag to move · click to edit' : 'Drag to move'}
    >
      <span data-grip className="absolute right-1 top-1 cursor-grab touch-none p-0.5 text-zinc-700/60" aria-label="Drag">
        <GripVertical size={16} />
      </span>
      <p className="whitespace-pre-wrap break-words text-sm leading-snug">{note.text}</p>
      <p className="mt-auto text-[10px] font-semibold uppercase tracking-wide text-zinc-700/70">{note.author}</p>
    </article>
  );
}

function LaneHeader({ lane, index, count, isGm, lanes }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(lane.name);
  useEffect(() => setName(lane.name), [lane.name]);
  const gmOnly = lane.visibility === 'gm';
  const save = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== lane.name) socket.emit('event_lane:update', { laneId: lane.id, name: name.trim() });
    else setName(lane.name);
  };
  const remove = () => {
    const n = lane.notes.length;
    const same = lanes.find((l) => l.id !== lane.id && l.visibility === lane.visibility);
    const target = same ?? (lane.visibility === 'all' ? lanes.find((l) => l.id !== lane.id) : null);
    const fate = !n ? '' : target ? ` Its ${n} note${n === 1 ? '' : 's'} move to “${target.name}”.` : ` Its ${n} note${n === 1 ? '' : 's'} will be deleted too.`;
    if (window.confirm(`Delete the lane “${lane.name}”?${fate}`)) socket.emit('event_lane:delete', { laneId: lane.id });
  };
  const iconBtn = 'flex h-8 w-8 items-center justify-center panel-cut-sm border border-zinc-700 text-zinc-400 hover:border-brand-500 hover:text-brand-300 disabled:opacity-30';
  return (
    <header className="mb-1 flex flex-wrap items-center gap-2 px-1">
      {renaming ? (
        <input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 py-1 font-display text-sm font-bold uppercase tracking-wide"
        />
      ) : (
        <h2
          className={`min-w-0 flex-1 truncate font-display text-sm font-bold uppercase tracking-wide text-zinc-200 ${isGm ? 'cursor-text' : ''}`}
          onDoubleClick={() => isGm && setRenaming(true)}
          title={isGm ? 'Double-click to rename' : undefined}
        >
          {lane.name} <span className="font-sans text-[11px] font-normal normal-case text-zinc-500">{lane.notes.length}</span>
        </h2>
      )}
      {isGm ? (
        <>
          <button
            type="button"
            onClick={() => socket.emit('event_lane:update', { laneId: lane.id, visibility: gmOnly ? 'all' : 'gm' })}
            title="Who sees this lane — click to switch"
            className={`flex h-8 items-center gap-1 panel-cut-sm border px-2 text-[11px] font-semibold uppercase tracking-wide ${gmOnly ? 'border-amber-600 bg-amber-600/20 text-amber-200' : 'border-sky-700 bg-sky-700/20 text-sky-200'}`}
          >
            {gmOnly ? <EyeOff size={14} /> : <Users size={14} />}
            {gmOnly ? 'GM only' : 'Everyone'}
          </button>
          <button type="button" className={iconBtn} disabled={index === 0} onClick={() => socket.emit('event_lane:move', { laneId: lane.id, toIndex: index - 1 })} aria-label="Move lane up">
            <ChevronUp size={16} />
          </button>
          <button type="button" className={iconBtn} disabled={index === count - 1} onClick={() => socket.emit('event_lane:move', { laneId: lane.id, toIndex: index + 1 })} aria-label="Move lane down">
            <ChevronDown size={16} />
          </button>
          <button type="button" className={`${iconBtn} hover:border-red-500 hover:text-red-400`} onClick={remove} aria-label="Delete lane">
            <Trash2 size={15} />
          </button>
        </>
      ) : null}
    </header>
  );
}

function NewLaneForm() {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('all');
  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    socket.emit('event_lane:create', { name: name.trim(), visibility });
    setName('');
  };
  return (
    <form onSubmit={add} className="flex flex-wrap items-center gap-2">
      <input
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        placeholder="New lane"
        className="min-h-9 w-44 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 text-sm"
      />
      <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 text-sm" aria-label="Who sees it">
        <option value="all">Everyone</option>
        <option value="gm">GM only</option>
      </select>
      <button type="submit" disabled={!name.trim()} className="min-h-9 panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40">
        Add lane
      </button>
    </form>
  );
}

function NoteEditor({ editing, onClose }) {
  const existing = editing.note ?? null;
  const [text, setText] = useState(existing?.text ?? '');
  const [color, setColor] = useState(existing?.color ?? 'yellow');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = () => {
    if (!text.trim()) return;
    if (existing) socket.emit('event_note:update', { noteId: existing.id, text: text.trim(), color });
    else socket.emit('event_note:create', { laneId: editing.laneId, text: text.trim(), color });
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={existing ? 'Edit note' : 'New note'} className="w-full max-w-sm panel-cut border border-zinc-700 bg-zinc-950 p-4 shadow-2xl">
        <h2 className="font-display text-sm font-bold uppercase tracking-wide text-zinc-300">{existing ? 'Edit note' : 'New note'}</h2>
        <textarea
          autoFocus
          value={text}
          maxLength={NOTE_MAX}
          rows={4}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && save()}
          placeholder="A short description…"
          className={`mt-2 w-full resize-none p-3 text-sm shadow-inner ${NOTE_COLORS[color]}`}
        />
        <div className="mt-1 flex items-center justify-between">
          <div className="flex gap-1.5" role="radiogroup" aria-label="Colour">
            {Object.keys(NOTE_COLORS).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                onClick={() => setColor(c)}
                className={`h-7 w-7 ${NOTE_COLORS[c]} ${color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-950' : 'opacity-70'}`}
              />
            ))}
          </div>
          <span className="text-[11px] text-zinc-500">
            {text.length}/{NOTE_MAX}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {existing && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Delete this note?')) {
                  socket.emit('event_note:delete', { noteId: existing.id });
                  onClose();
                }
              }}
              className="min-h-9 panel-cut-sm border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-red-500 hover:text-red-400"
            >
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="min-h-9 panel-cut-sm border border-zinc-700 px-3 text-sm text-zinc-300">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={!text.trim()} className="min-h-9 panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40">
            {existing ? 'Save' : 'Add note'}
          </button>
        </div>
      </div>
    </div>
  );
}

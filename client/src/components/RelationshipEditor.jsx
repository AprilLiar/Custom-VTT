import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Minus, Smile, Spline, Trash2 } from 'lucide-react';
import { socket } from '../socket.js';
import { useAnchoredPosition } from '../lib/useAnchoredPosition.js';
import EmojiGrid from './EmojiGrid.jsx';

// What a relationship IS, as opposed to where it is attached.
//
// **Every control applies live.** There is a Close, not a Save. Colour is the
// reason: you are choosing it against the actual board, and a staged palette
// means picking blind and committing before you can see whether it works. The
// rest follow for consistency, and it matches how the sheet already behaves —
// Role-play saves on blur and has no Save button anywhere.
//
// **Portalled to `document.body`.** The board sets a `transform` on its world
// layer, and a transformed ancestor becomes the containing block for
// `position: fixed` — no z-index can escape the stacking context it
// establishes. This codebase has hit that trap four times now.

// Literal hex, not `brand-*` tokens. These are user data written into a column:
// a runtime-themeable token would silently repaint every relationship ever
// drawn the moment somebody changed the app's hue in Settings.
const PRESETS = [
  '#f87179', // the default red
  '#fbbf24',
  '#4ade80',
  '#38bdf8',
  '#a78bfa',
  '#f472b6',
  '#e4e4e7',
  '#8b8b93',
];

export default function RelationshipEditor({ edge, anchor, fromName, toName, onClose }) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef(null);
  const pos = useAnchoredPosition(anchor, true, { width: 268 });

  // **A local draft, echoing the server (the RoleplayTab pattern).**
  //
  // Binding these controls straight to `edge` looks right and feels broken: a
  // keystroke or a checkbox tick could not show until the write had gone to the
  // server and the broadcast had come back, so the checkbox visibly did not
  // move when clicked and fast typing stuttered against the round trip. The
  // draft answers instantly; the server is still the authority, and re-syncs
  // whenever it says something new about a different line.
  const [draft, setDraft] = useState(() => ({
    label: edge.label ?? '',
    color: edge.color ?? PRESETS[0],
    arrow: edge.arrow ?? 'none',
    retired: Boolean(edge.retired),
  }));
  // Keyed on the edge id, not the whole row: re-syncing on every broadcast
  // would yank the caret back mid-word as this component's own echo returned.
  useEffect(() => {
    setDraft({
      label: edge.label ?? '',
      color: edge.color ?? PRESETS[0],
      arrow: edge.arrow ?? 'none',
      retired: Boolean(edge.retired),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge.id]);

  const labelTimer = useRef(0);
  useEffect(() => () => clearTimeout(labelTimer.current), []);

  // One write, one field. The server keeps every value not named, so a colour
  // change never has to carry the label along and cannot clobber it.
  const patch = (fields) => {
    setDraft((d) => ({ ...d, ...fields }));
    socket.emit('relationships:update_edge', { edgeId: edge.id, ...fields });
  };

  // Typing is the one field worth debouncing: a socket frame per keystroke is
  // a lot of traffic for a value nobody reads until you stop.
  const typeLabel = (label) => {
    setDraft((d) => ({ ...d, label }));
    clearTimeout(labelTimer.current);
    labelTimer.current = setTimeout(
      () => socket.emit('relationships:update_edge', { edgeId: edge.id, label }),
      250
    );
  };

  const insertEmoji = (emoji) => {
    const el = inputRef.current;
    const current = draft.label ?? '';
    // At the cursor, not appended: "⚔️ rivals" and "owes me 💰" are both things
    // people write, and only one of them is the end of the string.
    const at = el?.selectionStart ?? current.length;
    const next = `${current.slice(0, at)}${emoji}${current.slice(el?.selectionEnd ?? at)}`;
    patch({ label: next });
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = at + emoji.length;
      el?.setSelectionRange?.(caret, caret);
    });
  };

  if (!pos) return null;

  return createPortal(
    <>
      {/* Click-away. Transparent rather than dimmed: you are editing a line on
          a board you need to keep seeing. */}
      <div className="fixed inset-0 z-[94]" onPointerDown={onClose} />
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="fixed z-[95] flex flex-col gap-2.5 panel-cut border border-zinc-700 bg-zinc-950 p-3 shadow-2xl shadow-black/80"
        style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
      >
        <Row label="Colour">
          <div className="flex flex-wrap items-center gap-1">
            {PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={hex}
                onClick={() => patch({ color: hex })}
                className={`h-6 w-6 panel-cut-sm border-2 ${
                  draft.color?.toLowerCase() === hex ? 'border-zinc-100' : 'border-transparent'
                }`}
                style={{ backgroundColor: hex }}
              />
            ))}
            {/* Anything else, through the platform's own picker — the same
                shape SettingsPage uses for the brand hue. */}
            <label
              title="Any colour"
              className="flex h-6 w-6 cursor-pointer items-center justify-center panel-cut-sm border-2 border-dashed border-zinc-700 text-[10px] text-zinc-500 hover:border-zinc-400 hover:text-zinc-300"
            >
              <input
                type="color"
                value={draft.color}
                onChange={(e) => patch({ color: e.target.value })}
                className="h-0 w-0 opacity-0"
              />
              +
            </label>
          </div>
        </Row>

        <Row label="What is it">
          <div className="relative flex items-center gap-1">
            <input
              ref={inputRef}
              value={draft.label}
              onChange={(e) => typeLabel(e.target.value)}
              maxLength={60}
              placeholder="rivals, owes me, my brother…"
              className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
            />
            <button
              type="button"
              onClick={() => setEmojiOpen((v) => !v)}
              aria-label="Add an emoji"
              className="shrink-0 panel-cut-sm border border-zinc-700 p-1.5 text-zinc-400 hover:text-zinc-100"
            >
              <Smile size={14} />
            </button>
            {emojiOpen && (
              <div className="absolute right-0 top-full z-10 mt-1">
                <EmojiGrid onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />
              </div>
            )}
          </div>
        </Row>

        <Row label="Pointing">
          {/* Drawn with the two names, because "which side" is meaningless
              without them — from and to are storage words, not table words. */}
          <div className="flex gap-1">
            <ArrowButton active={draft.arrow === 'to'} onClick={() => patch({ arrow: 'to' })} title={`${fromName} → ${toName}`}>
              <ArrowRight size={13} />
            </ArrowButton>
            <ArrowButton active={draft.arrow === 'from'} onClick={() => patch({ arrow: 'from' })} title={`${toName} → ${fromName}`}>
              <ArrowLeft size={13} />
            </ArrowButton>
            <ArrowButton active={draft.arrow === 'none'} onClick={() => patch({ arrow: 'none' })} title="No arrow">
              <Minus size={13} />
            </ArrowButton>
          </div>
          <p className="mt-1 truncate text-[10px] text-zinc-600">
            {draft.arrow === 'to' ? `${fromName} → ${toName}` : draft.arrow === 'from' ? `${toName} → ${fromName}` : 'Mutual — no arrow'}
          </p>
        </Row>

        {/* **Only when there is one to undo.** A line bent by hand keeps that
            arc forever, which is the point — but a fan offset the board chose
            for you is not something you asked for and there is nothing here to
            put back. So the control appears exactly when `bend` is set, and
            clearing it hands the line back to the automatic fan rather than
            flattening it: a pair with three lines between them must not all
            collapse onto each other because one of them was straightened. */}
        {edge.bend != null && (
          <button
            type="button"
            onClick={() => patch({ bend: null, bendU: null })}
            title="Drop the hand-drawn arc and let the board space this line again"
            className="flex items-center gap-1.5 self-start panel-cut-sm border border-zinc-700 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
          >
            <Spline size={12} /> Reset curve
          </button>
        )}

        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={draft.retired}
            onChange={(e) => patch({ retired: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="block text-[11px] font-bold uppercase tracking-wide text-zinc-300">
              Retired
            </span>
            <span className="block text-[10px] leading-snug text-zinc-600">
              Was true once. Goes grey, half-faded, behind everything — kept as history.
            </span>
          </span>
        </label>

        <div className="flex items-center justify-between border-t border-zinc-800 pt-2">
          {/* **No confirmation (decided, revised).** It used to ask, on the
              reasoning that a relationship is real work to rebuild. There is an
              undo behind the whole board now — three steps of it, Ctrl+Z — so
              the dialog was buying nothing and costing a click every time,
              which is most of what tidying a web is. Delete and Backspace do
              the same thing to whatever is selected, and they do not ask
              either. */}
          <button
            type="button"
            onClick={() => {
              socket.emit('relationships:delete_edge', { edgeId: edge.id });
              onClose();
            }}
            title="Delete this relationship — Ctrl+Z takes it back"
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-zinc-600 hover:text-brand-400"
          >
            <Trash2 size={12} /> Delete
          </button>
          <button
            type="button"
            onClick={onClose}
            className="panel-cut-sm border border-zinc-700 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-300 hover:bg-zinc-800"
          >
            Close
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}

function Row({ label, children }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">{label}</div>
      {children}
    </div>
  );
}

function ArrowButton({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex flex-1 items-center justify-center panel-cut-sm border py-1.5 ${
        active ? 'border-brand-500 bg-brand-600/25 text-brand-200' : 'border-zinc-700 text-zinc-400 hover:text-zinc-100'
      }`}
    >
      {children}
    </button>
  );
}

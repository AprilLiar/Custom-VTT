import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DialogShell from './DialogShell.jsx';
import FrameBar from './FrameBar.jsx';
import { folderPath } from '../lib/folders.js';

// Pick one move out of the whole library. Built for Grappling's four-direction
// cross (see MoveCreator), which needs to name any move in the game as the
// thing a grab chains into.
//
// **A searchable overlay rather than a <select>.** Every other picker in the
// Move Creator — Tell, Style, Discipline — is a dropdown, and copying that
// would have been the consistent choice. It doesn't survive a real library:
// a flat, unsorted list of every move in the game is unusable at the size a
// Compendium actually reaches, and unlike a Tell or a Style there is nothing
// bounding how many moves exist. So: a filter box, grouped by Discipline, with
// enough of each move visible (frame data, Stamina) to tell two similarly
// named ones apart.
//
// **Portalled to document.body**, unlike every other DialogShell user. The
// rest are mounted near the app root, so their `fixed inset-0` resolves
// against the viewport; this one is mounted deep inside the Move Creator's
// form, and a transformed ancestor (the Compendium's animated column) makes
// `fixed` resolve against *that* instead — which clipped the dialog at the
// column's right edge. Portalling here rather than changing DialogShell keeps
// the eight dialogs already relying on its current behaviour untouched. Same
// fix, same reason, as MoveLinkOverlay.
export default function MovePickerDialog({
  moves = [],
  folders = [],
  excludeMoveId = null,
  title = 'Pick a move',
  onPick,
  onClear = null,
  onClose,
}) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A move cannot chain into itself — that is an unbounded loop rather than
    // a design choice, and the server drops it anyway
    // (normalizeGrappleDirections). Hiding it here means the GM never picks
    // something that silently won't save.
    const pool = moves.filter((m) => m.id !== excludeMoveId);
    const matched = q
      ? pool.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            (m.description ?? '').toLowerCase().includes(q)
        )
      : pool;

    const byFolder = new Map();
    for (const move of matched) {
      const key = move.folder_id ?? null;
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(move);
    }
    return [...byFolder.entries()]
      .map(([folderId, list]) => ({
        folderId,
        label: folderId == null ? 'No Discipline' : folderPath(folderId, folders),
        moves: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [moves, folders, excludeMoveId, query]);

  const total = groups.reduce((n, g) => n + g.moves.length, 0);

  return createPortal(
    <DialogShell title={title} onClose={onClose} variant="fullscreen" maxWidth="max-w-lg">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by name or description…"
        className="mb-3 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
      />

      {total === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-600">
          {moves.length === 0 ? 'No moves exist yet.' : 'Nothing matches that.'}
        </p>
      ) : (
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {groups.map((group) => (
            <div key={String(group.folderId)}>
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.moves.map((move) => (
                  <button
                    key={move.id}
                    type="button"
                    onClick={() => {
                      onPick(move);
                      onClose();
                    }}
                    className="flex w-full items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left hover:border-brand-500 hover:bg-zinc-800"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                      {move.name}
                      {move.is_grappling ? (
                        // Chaining into another grapple is allowed, and it
                        // resolves as an ordinary move — no second mini-game,
                        // no second contest (decided). Flagged rather than
                        // hidden so the GM knows what they are picking.
                        <span
                          title="Grappling — as a chained move it resolves normally, with no second mini-game"
                          className="ml-1.5 text-[10px] uppercase text-amber-400"
                        >
                          grapple
                        </span>
                      ) : null}
                    </span>
                    <FrameBar
                      startup={move.startup_tics}
                      active={move.active_tics}
                      recovery={move.recovery_tics}
                      defensePositions={move.defense_frame_positions}
                    />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {onClear && (
        <button
          type="button"
          onClick={() => {
            onClear();
            onClose();
          }}
          className="mt-3 w-full panel-cut-sm border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-red-500 hover:text-red-300"
        >
          Clear this direction
        </button>
      )}
    </DialogShell>,
    document.body
  );
}

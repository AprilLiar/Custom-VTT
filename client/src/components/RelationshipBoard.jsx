import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { socket } from '../socket.js';
import { DEFAULT_VIEW } from '../lib/boardViewport.js';
import RelationshipNode, { NODE_WIDTH, PORTRAIT_HEIGHT } from './RelationshipNode.jsx';
import RelationshipVoid from './RelationshipVoid.jsx';

// The board proper: the void, the nodes in it, and the two gestures that put
// them there — a drop from the rail, and a drag to reposition.
//
// **Two drag systems, on purpose.**
//   - *Rail → board* is native HTML5 drag-and-drop, with the `text/character-id`
//     mime `CharacterList` and Arena seating already use. It is the app's
//     convention for list-to-target drags and it crosses component boundaries
//     for free.
//   - *Inside the board* is pointer events. Native DnD reports no continuous
//     position and has no touch equivalent at all, so it cannot drive a node
//     that has to track the cursor exactly.
//
// **A node drag never re-renders.** `pointermove` writes `transform` straight
// onto the node's own element; React hears about it once, on drop, as a single
// socket emit. Same rule as the camera, same reason.

export const DRAG_MIME = 'text/character-id';
export const DRAG_PERSON_MIME = 'text/relationship-person-id';

export default function RelationshipBoard({
  ownerCharacterId,
  board,
  charactersById,
  canEdit,
  className = '',
}) {
  const voidRef = useRef(null);
  const nodeEls = useRef(new Map());
  const dragRef = useRef(null);
  const [zoom, setZoom] = useState(DEFAULT_VIEW.zoom);
  const [selectedId, setSelectedId] = useState(null);
  const [dropping, setDropping] = useState(false);
  const [editing, setEditing] = useState(null);

  const peopleById = useMemo(
    () => new Map((board?.people ?? []).map((p) => [p.id, p])),
    [board?.people]
  );

  // What a node shows. A node points at either a world character or a
  // board-local person, and past this line nothing cares which — which is the
  // whole point of the conversion rule: when the GM deletes an NPC, its nodes
  // become people and every reader here carries on unchanged.
  const subjectFor = useCallback(
    (node) =>
      node.character_id != null
        ? charactersById.get(node.character_id) ?? { name: 'Unknown' }
        : peopleById.get(node.person_id) ?? { name: 'Unknown' },
    [charactersById, peopleById]
  );

  const registerNode = useCallback((id, el) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  }, []);

  // ---- repositioning ------------------------------------------------------

  const onNodePointerDown = useCallback(
    (e, node) => {
      if (!canEdit) return;
      const api = voidRef.current;
      if (!api) return;
      setSelectedId(node.id);
      const start = api.toWorld(e.clientX, e.clientY);
      dragRef.current = {
        nodeId: node.id,
        // The grab offset, so the portrait does not jump its own centre under
        // the cursor on the first frame.
        dx: node.x - start.x,
        dy: node.y - start.y,
        x: node.x,
        y: node.y,
        moved: false,
      };
    },
    [canEdit]
  );

  useEffect(() => {
    if (!canEdit) return undefined;
    // Window-level rather than pointer capture: a node drag deliberately passes
    // over other nodes and over the void, and window listeners keep receiving
    // through all of it without any element having to hold the pointer.
    const onMove = (e) => {
      const drag = dragRef.current;
      const api = voidRef.current;
      if (!drag || !api) return;
      const p = api.toWorld(e.clientX, e.clientY);
      drag.x = p.x + drag.dx;
      drag.y = p.y + drag.dy;
      drag.moved = true;
      const el = nodeEls.current.get(drag.nodeId);
      // Straight to the DOM. No setState, no re-render, no dropped frames.
      if (el) el.style.transform = `translate(${drag.x}px, ${drag.y}px)`;
    };
    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || !drag.moved) return;
      socket.emit('relationships:move_node', { nodeId: drag.nodeId, x: drag.x, y: drag.y });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [canEdit]);

  // ---- dropping from the rail --------------------------------------------

  const onDrop = (e) => {
    e.preventDefault();
    setDropping(false);
    if (!canEdit) return;
    const api = voidRef.current;
    if (!api) return;
    const characterId = e.dataTransfer.getData(DRAG_MIME);
    const personId = e.dataTransfer.getData(DRAG_PERSON_MIME);
    if (!characterId && !personId) return;
    const p = api.toWorld(e.clientX, e.clientY);
    // Dropped by the portrait's centre, not its top-left corner: you aim at
    // where you want the face, and the cursor is holding the middle of it.
    socket.emit('relationships:add_node', {
      characterId: ownerCharacterId,
      targetCharacterId: characterId ? Number(characterId) : null,
      personId: personId ? Number(personId) : null,
      x: p.x - NODE_WIDTH / 2,
      y: p.y - PORTRAIT_HEIGHT / 2,
    });
  };

  const onDragOver = (e) => {
    if (!canEdit) return;
    // Only claim the drop when the payload is actually one of ours; otherwise a
    // stray drag from elsewhere in the app would get a drop cursor over a board
    // that will do nothing with it.
    if (!e.dataTransfer.types.includes(DRAG_MIME) && !e.dataTransfer.types.includes(DRAG_PERSON_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };

  const nodes = board?.nodes ?? [];

  return (
    <>
      <RelationshipVoid
        ref={voidRef}
        characterId={ownerCharacterId}
        interactive
        onViewChange={(v) => setZoom(v.zoom)}
        onBackgroundPointerDown={() => setSelectedId(null)}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDropping(false)}
        className={`${className} ${dropping ? 'ring-2 ring-brand-400' : ''}`}
      >
        {nodes.map((node) => (
          <RelationshipNode
            key={node.id}
            node={node}
            person={subjectFor(node)}
            zoom={zoom}
            canEdit={canEdit}
            selected={selectedId === node.id}
            nodeRef={(el) => registerNode(node.id, el)}
            onPointerDown={onNodePointerDown}
            onOpenEditor={setEditing}
            onRequestDelete={(n) => socket.emit('relationships:delete_node', { nodeId: n.id })}
          />
        ))}
        {!nodes.length && <EmptyHint canEdit={canEdit} />}
      </RelationshipVoid>

      {editing && (
        <NodeEditor
          key={editing.id}
          node={nodes.find((n) => n.id === editing.id) ?? editing}
          subject={subjectFor(editing)}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function EmptyHint({ canEdit }) {
  return (
    <div
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-center"
      style={{ left: 0, top: 0 }}
    >
      <p className="font-display text-sm font-bold uppercase tracking-[0.2em] text-zinc-700">
        {canEdit ? 'Drag someone in from the right' : 'Nobody here yet'}
      </p>
    </div>
  );
}

// Nickname and Notes, opened by double-clicking a portrait — the same gesture
// that will open a relationship's editor in Phase 4, so one gesture means
// "edit this thing" everywhere on the board.
//
// Portalled through DialogShell's own fixed backdrop rather than positioned
// against the node: the board sets a `transform`, and a transformed ancestor
// makes `position: fixed` resolve against it instead of the viewport.
function NodeEditor({ node, subject, onClose }) {
  const [nickname, setNickname] = useState(node.nickname ?? '');
  const [notes, setNotes] = useState(node.notes ?? '');

  const save = () => {
    socket.emit('relationships:update_node', { nodeId: node.id, nickname, notes });
    onClose();
  };

  return (
    <BoardDialog title={subject?.name ?? 'Who is this?'} onClose={onClose} onSave={save}>
      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Nickname</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={80}
          placeholder="What you call them"
          className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
        />
      </label>
      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={7}
          placeholder="What your character knows, owes, or suspects."
          className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
        />
      </label>
    </BoardDialog>
  );
}

// **Portalled to document.body, always.** The board sets a `transform` on its
// world layer and framer-motion sets one on the tab body mid-transition, and a
// transformed ancestor makes `position: fixed` resolve against that ancestor
// rather than the viewport — the trap this codebase has already hit three times
// (MovePickerDialog, the Arena hover cards). Cheaper to portal unconditionally
// than to reason about which ancestor happens to be transformed today.
export function BoardDialog({ title, onClose, onSave, saveLabel = 'Save', children, disabled }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 panel-cut-lg border border-zinc-700 bg-zinc-900 p-4"
      >
        <h3 className="font-display text-sm font-bold uppercase tracking-wide text-zinc-200">{title}</h3>
        {children}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="panel-cut-sm border border-zinc-700 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={disabled}
            className="panel-cut-sm bg-brand-600 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-white hover:bg-brand-500 disabled:opacity-40"
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

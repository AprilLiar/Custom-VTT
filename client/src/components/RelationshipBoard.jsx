import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from 'framer-motion';
import { socket } from '../socket.js';
import {
  DEFAULT_VIEW,
  boundsOf,
  anyNodeVisible,
  fitTo,
  loadShowRetired,
  saveShowRetired,
} from '../lib/boardViewport.js';
import {
  anchorPoint,
  assignBends,
  edgeEnds,
  edgePath,
  dropTarget,
  nearestSide,
} from '../lib/relationshipGeometry.js';
import RelationshipEdges from './RelationshipEdges.jsx';
import RelationshipEditor from './RelationshipEditor.jsx';
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
  const lastPointRef = useRef({ x: 0, y: 0 });
  const pathEls = useRef(new Map());
  // **The lines lag, the portrait does not.** The thing under your finger has
  // to track the pointer exactly — anything else feels like rubber-banding the
  // cursor — but the relationships attached to it should whip along behind and
  // catch up. That one asymmetry is most of what makes the board feel like it
  // is full of liquid rather than made of sticks.
  //
  // A rAF loop eases a "drawn" position toward the node's true one and keeps
  // running for a few frames after release, so the web settles rather than
  // snapping. It draws directly to the paths' `d`, never through React.
  const chase = useRef({ raf: 0, nodeId: null, at: null, target: null });
  // **Where a node really is right now, ahead of the server.**
  //
  // Fixes a bug that showed up as "picking a character up and putting it down
  // repeatedly makes it fly off in a random direction". A drag writes the new
  // position straight to the DOM and tells the server on release; until the
  // broadcast comes back, React state still holds the OLD coordinates. Grab the
  // node again in that window and the grab offset was computed against the old
  // position while the portrait was drawn at the new one — so it jumped by
  // exactly the distance of the previous drag, every time, compounding.
  //
  // This map is the local truth between a drop and its confirmation. An entry is
  // cleared once the server's value agrees with it; if the server ever disagrees
  // (the GM moved the same node), the server wins.
  const livePos = useRef(new Map());
  const [zoom, setZoom] = useState(DEFAULT_VIEW.zoom);
  const [selectedId, setSelectedId] = useState(null);
  const [dropping, setDropping] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  // The line being edited, plus the SCREEN point to hang the popover from —
  // captured at the moment of the double-click so the panel does not chase the
  // line if the board is panned behind it.
  const [editingEdge, setEditingEdge] = useState(null);
  const [showRetired, setShowRetired] = useState(() => loadShowRetired(ownerCharacterId));
  // Framer's springs are inline styles, which the global prefers-reduced-motion
  // rule in index.css cannot reach — it only zeroes CSS animations. So the
  // preference is read here too, and every easing below collapses to instant.
  const reduceMotion = useReducedMotion();
  // The line currently being drawn or re-attached, as world points. State
  // rather than a ref because the draft path has to re-render to be seen —
  // it is one <path>, not the whole board, so the cost is a rounding error
  // next to the node drag this deliberately avoids re-rendering.
  const [draft, setDraft] = useState(null);
  // Bumped when a local override is written, so the memo above recomputes
  // without needing the whole board object to change identity.
  const [draftTick, setDraftTick] = useState(0);
  const connectRef = useRef(null);

  // **Declared before every hook that reads them.** These sit above the
  // callbacks and effects below because a hook's dependency ARRAY is evaluated
  // at render time: with `const nodesById` further down the function body,
  // `useCallback(fn, [nodesById])` threw a temporal-dead-zone ReferenceError
  // and took the whole tab down. Lint does not catch it (no-use-before-define
  // is off) and neither does any test that never mounts the component — the
  // browser console said it in one line.
  const rawNodes = board?.nodes ?? [];
  const edges = board?.edges ?? [];

  // Drop any local override the server has now confirmed. Done during render
  // rather than in an effect so the very next line already sees the truth.
  for (const node of rawNodes) {
    const local = livePos.current.get(node.id);
    if (local && local.x === node.x && local.y === node.y) livePos.current.delete(node.id);
  }
  for (const id of livePos.current.keys()) {
    if (!rawNodes.some((n) => n.id === id)) livePos.current.delete(id);
  }

  // Every reader below — the rendered portraits, the edge geometry, the next
  // grab's offset — goes through this one positioned view, so they can never
  // disagree about where somebody is.
  const nodes = useMemo(
    () => rawNodes.map((n) => ({ ...n, ...(livePos.current.get(n.id) ?? {}) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board?.nodes, draftTick]
  );
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

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

  // The editor reads the edge out of board state every render rather than
  // holding a copy, so a live edit repaints the panel from the same truth the
  // line is drawn from — there is no second version of the relationship.
  const liveEditedEdge = editingEdge ? edges.find((e) => e.id === editingEdge.id) : null;

  // The arrow controls are meaningless as "from" and "to" — those are storage
  // words. They are drawn with the two people's actual names.
  const endName = useCallback(
    (nodeId) => {
      if (nodeId == null) return 'the loose end';
      const node = nodesById.get(nodeId);
      return node ? subjectFor(node)?.name ?? 'Unknown' : 'Unknown';
    },
    [nodesById, subjectFor]
  );

  const registerPath = useCallback((key, el) => {
    if (el) pathEls.current.set(key, el);
    else pathEls.current.delete(key);
  }, []);

  // Rewrites every path touching `nodeId`, using `movedNode` as that node's
  // live position. The bends are recomputed the same way the render does it, so
  // a fanned pair stays fanned while one of its ends is being dragged.
  const redrawEdgesFor = useCallback(
    (nodeId, movedNode) => {
      const lookup = new Map(nodesById);
      lookup.set(nodeId, movedNode);
      const bends = assignBends(edges);
      for (const edge of edges) {
        if (edge.from_node_id !== nodeId && edge.to_node_id !== nodeId) continue;
        const ends = edgeEnds(edge, lookup);
        if (!ends) continue;
        const { d, mid } = edgePath(ends.from, ends.to, bends.get(edge.id) ?? 0);
        pathEls.current.get(edge.id)?.setAttribute('d', d);
        pathEls.current.get(`hit-${edge.id}`)?.setAttribute('d', d);
        const label = pathEls.current.get(`label-${edge.id}`);
        if (label) {
          label.style.left = `${mid.x}px`;
          label.style.top = `${mid.y}px`;
        }
      }
    },
    [edges, nodesById]
  );

  // Point the chase at a new target and make sure the loop is running. The
  // loop stops on its own once it has caught up and the drag is over.
  const chaseEdges = useCallback(
    (nodeId, target) => {
      const c = chase.current;
      if (c.nodeId !== nodeId) {
        c.nodeId = nodeId;
        c.at = { ...target };
      }
      c.target = target;
      if (reduceMotion) {
        c.at = { ...target };
        redrawEdgesFor(nodeId, { ...nodesById.get(nodeId), ...target });
        return;
      }
      if (c.raf) return;
      const step = () => {
        const cur = chase.current;
        if (!cur.target || cur.nodeId == null) {
          cur.raf = 0;
          return;
        }
        // A plain exponential chase rather than a spring: no overshoot, so a
        // line never crosses its own anchor, and one constant to tune.
        const k = 0.3;
        cur.at.x += (cur.target.x - cur.at.x) * k;
        cur.at.y += (cur.target.y - cur.at.y) * k;
        const node = nodesById.get(cur.nodeId);
        if (node) redrawEdgesFor(cur.nodeId, { ...node, x: cur.at.x, y: cur.at.y });
        const settled = Math.hypot(cur.target.x - cur.at.x, cur.target.y - cur.at.y) < 0.4;
        // Keep going while the pointer is still down even once caught up —
        // the next move has to find the loop already running.
        if (settled && !dragRef.current) {
          if (node) redrawEdgesFor(cur.nodeId, { ...node, ...cur.target });
          cur.raf = 0;
          cur.nodeId = null;
          cur.at = null;
          cur.target = null;
          return;
        }
        cur.raf = requestAnimationFrame(step);
      };
      c.raf = requestAnimationFrame(step);
    },
    [nodesById, redrawEdgesFor, reduceMotion]
  );

  useEffect(() => () => cancelAnimationFrame(chase.current.raf), []);

  // **Open on the map, not on empty space.** The camera is per-browser, so a
  // board opened on a second device — or one laid out far from the origin —
  // would otherwise land at the default view with the whole cast off screen
  // and no hint that it exists. Found by opening the board at phone size.
  //
  // Once, on the first load that has nodes, and only when none of them are
  // visible: a saved camera that already shows the map is left exactly where
  // the player left it.
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !nodes.length) return;
    const api = voidRef.current;
    const el = api?.getViewportEl();
    if (!el) return;
    framed.current = true;
    const rect = el.getBoundingClientRect();
    if (anyNodeVisible(api.getView(), nodes, rect.width, rect.height)) return;
    api.setView(fitTo(boundsOf(nodes), rect.width, rect.height));
  }, [nodes]);

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
      // The lines have to come along, or a dragged portrait tears away from its
      // own relationships until you let go. Same technique: recompute the two
      // or three paths that touch this node and write `d` directly.
      chaseEdges(drag.nodeId, { x: drag.x, y: drag.y });
    };
    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || !drag.moved) return;
      // Record where it actually ended BEFORE telling the server, so a second
      // grab in the gap uses the real position rather than the stale one.
      livePos.current.set(drag.nodeId, { x: drag.x, y: drag.y });
      setDraftTick((t) => t + 1);
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
  }, [canEdit, chaseEdges]);

  // ---- drawing and re-attaching a relationship ----------------------------
  //
  // One gesture serves both: dragging from a node's dot proposes a NEW line,
  // and dragging a loose end proposes moving an EXISTING one. They differ only
  // in what happens on release, so they share every frame in between.

  const beginConnect = useCallback((e, origin) => {
    const api = voidRef.current;
    if (!canEdit || !api) return;
    e.stopPropagation();
    const point = api.toWorld(e.clientX, e.clientY);
    connectRef.current = { ...origin, target: null };
    setDraft({ from: origin.anchor, to: point });
  }, [canEdit]);

  const onDotPointerDown = useCallback(
    (e, node, side) =>
      beginConnect(e, { kind: 'new', nodeId: node.id, side, anchor: anchorPoint(node, side) }),
    [beginConnect]
  );

  const onEndPointerDown = useCallback(
    (e, edge, end) => {
      const api = voidRef.current;
      if (!canEdit || !api) return;
      // The other end stays put and is what the rubber band hangs from.
      const otherNodeId = end === 'from' ? edge.to_node_id : edge.from_node_id;
      const otherSide = end === 'from' ? edge.to_side : edge.from_side;
      const otherNode = otherNodeId != null ? nodesById.get(otherNodeId) : null;
      const anchor = otherNode
        ? anchorPoint(otherNode, otherSide)
        : { x: end === 'from' ? edge.to_x : edge.from_x, y: end === 'from' ? edge.to_y : edge.from_y };
      beginConnect(e, { kind: 'move', edgeId: edge.id, end, anchor });
    },
    [beginConnect, canEdit, nodesById]
  );

  useEffect(() => {
    if (!canEdit) return undefined;
    const onMove = (e) => {
      const connect = connectRef.current;
      const api = voidRef.current;
      if (!connect || !api) return;
      const point = api.toWorld(e.clientX, e.clientY);
      // Hit-testing is arithmetic against the stored rects, not
      // elementFromPoint: exact at any zoom, and it does not care that the
      // element under the cursor is the line being dragged.
      //
      // `dropTarget` accepts a padded region rather than the bare portrait,
      // because the four dots sit OUTSIDE the picture and aiming at one is the
      // natural thing to do — the strict rect rejected exactly that drop.
      const over = dropTarget(nodes, point, {
        exceptId: connect.kind === 'new' ? connect.nodeId : null,
      });
      connect.target = over ? { nodeId: over.id, side: nearestSide(over, point) } : null;
      setDraft({
        from: connect.anchor,
        // Snap to the dot once you are over somebody: the line lands where it
        // will actually attach, so the drop is never a surprise.
        to: connect.target ? anchorPoint(over, connect.target.side) : point,
      });
    };
    const onUp = () => {
      const connect = connectRef.current;
      connectRef.current = null;
      setDraft(null);
      if (!connect) return;
      if (connect.kind === 'new') {
        if (!connect.target) return; // released in empty space: no line
        socket.emit('relationships:add_edge', {
          fromNodeId: connect.nodeId,
          fromSide: connect.side,
          toNodeId: connect.target.nodeId,
          toSide: connect.target.side,
        });
        return;
      }
      // Moving an existing end: onto a node re-attaches it, into space drops it
      // loose wherever it was released.
      socket.emit('relationships:move_end', {
        edgeId: connect.edgeId,
        end: connect.end,
        nodeId: connect.target?.nodeId ?? null,
        side: connect.target?.side,
        ...(connect.target ? {} : lastPointRef.current),
      });
    };
    // The release position matters for a loose drop, and pointerup carries it.
    const remember = (e) => {
      const api = voidRef.current;
      if (api && connectRef.current) lastPointRef.current = api.toWorld(e.clientX, e.clientY);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointermove', remember);
    window.addEventListener('pointerup', remember);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointermove', remember);
      window.removeEventListener('pointerup', remember);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [canEdit, nodes]);

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


  return (
    <>
      <RelationshipVoid
        ref={voidRef}
        characterId={ownerCharacterId}
        interactive
        onViewChange={(v) => setZoom(v.zoom)}
        onBackgroundPointerDown={() => {
          setSelectedId(null);
          setSelectedEdgeId(null);
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDropping(false)}
        corner={
          canEdit && edges.some((e) => e.retired) ? (
            <button
              onClick={() => {
                const next = !showRetired;
                setShowRetired(next);
                saveShowRetired(ownerCharacterId, next);
              }}
              title="Retired relationships are kept as history"
              className={`panel-cut-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${
                showRetired
                  ? 'border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:text-zinc-100'
                  : 'border-brand-700/60 bg-zinc-900/80 text-brand-300'
              }`}
            >
              {showRetired ? 'Retired shown' : 'Retired hidden'}
            </button>
          ) : null
        }
        className={`${className} ${dropping ? 'ring-2 ring-brand-400' : ''}`}
      >
        <RelationshipEdges
          edges={edges}
          nodesById={nodesById}
          zoom={zoom}
          canEdit={canEdit}
          selectedEdgeId={selectedEdgeId}
          onEdgePointerDown={(e, edge) => {
            e.stopPropagation();
            setSelectedEdgeId(edge.id);
            setSelectedId(null);
          }}
          onEdgeDoubleClick={(edge, e) => {
            setSelectedEdgeId(edge.id);
            setEditingEdge({ id: edge.id, anchor: { left: e.clientX, top: e.clientY } });
          }}
          onEndPointerDown={onEndPointerDown}
          registerPath={registerPath}
          showRetired={showRetired}
          draft={draft}
        />
        {nodes.map((node) => (
          <RelationshipNode
            key={node.id}
            node={node}
            person={subjectFor(node)}
            zoom={zoom}
            canEdit={canEdit}
            selected={selectedId === node.id}
            connecting={Boolean(draft)}
            connectTarget={
              draft && connectRef.current?.target?.nodeId === node.id
                ? connectRef.current.target.side
                : null
            }
            nodeRef={(el) => registerNode(node.id, el)}
            onPointerDown={onNodePointerDown}
            onDotPointerDown={onDotPointerDown}
            onOpenEditor={setEditing}
            onRequestDelete={(n, keepRelationships) =>
              socket.emit('relationships:delete_node', { nodeId: n.id, keepRelationships })
            }
          />
        ))}
        {!nodes.length && <EmptyHint canEdit={canEdit} />}
      </RelationshipVoid>

      {editingEdge && liveEditedEdge && (
        <RelationshipEditor
          edge={liveEditedEdge}
          anchor={editingEdge.anchor}
          fromName={endName(liveEditedEdge.from_node_id)}
          toName={endName(liveEditedEdge.to_node_id)}
          onClose={() => setEditingEdge(null)}
        />
      )}

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

import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { TEXT_VISIBLE_ZOOM } from '../lib/boardViewport.js';
import { DOT_OUT, NODE_H, NODE_W, SIDES } from '../lib/relationshipGeometry.js';
import { usePortraitUrl } from '../lib/portraitCache.js';
import HaloText from './HaloText.jsx';

// One person, placed. The portrait is the whole hit target; the name and any
// nickname hang beneath it and are never overlapped (see HaloText).
//
// **Positioned in world coordinates**, inside the board's transform, so this
// component knows nothing about the camera — `x`/`y` are exactly what is in the
// database. The only thing it needs zoom for is deciding whether text is big
// enough to be worth drawing.
//
// **The drag writes straight to the DOM.** `onDragMove` hands the parent a
// world position every frame and the parent writes `transform` on this element
// without a re-render; React only hears about it once, on drop. That is the
// same rule the camera follows, and for the same reason — the feel of the board
// is the requirement, and sixty re-renders a second is how you lose it.

// Re-exported from the geometry module so there is one source for the node's
// footprint: the maths that places the dots and the CSS that draws the portrait
// must agree, and two constants would eventually not.
export const NODE_WIDTH = NODE_W;
export const PORTRAIT_HEIGHT = NODE_H;

export default function RelationshipNode({
  node,
  person,
  zoom,
  canEdit,
  selected,
  onPointerDown,
  onOpenEditor,
  onRequestDelete,
  onDotPointerDown,
  connecting,
  connectTarget,
  nodeRef,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropped, setDropped] = useState(0);
  const downAt = useRef(null);
  const reduceMotion = useReducedMotion();
  // A shared blob URL rather than a data: URI — the same face can be on this
  // board many times, and a data: URI is decoded once per <img>.
  const src = usePortraitUrl(person);
  const showText = zoom >= TEXT_VISIBLE_ZOOM;

  const handlePointerDown = (e) => {
    if (!canEdit) return;
    // Left button only: middle-drag pans the board, and right-click is the
    // browser's own menu.
    if (e.button !== 0) return;
    downAt.current = { x: e.clientX, y: e.clientY };
    onPointerDown?.(e, node);
  };

  // The landing. Only after a real drag — a click that moved nothing should not
  // make the portrait bounce.
  const handlePointerUp = (e) => {
    if (!canEdit || !downAt.current) return;
    const moved = Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y);
    downAt.current = null;
    if (moved > 4) setDropped((n) => n + 1);
  };

  // **Two elements, because two things want `transform`.**
  //
  // The outer div owns POSITION: its transform is the node's world coordinate,
  // and a drag writes it straight from the pointer handler with no re-render.
  // The inner motion.div owns the ENTRANCE: framer-motion composes `transform`
  // itself from the motion values it manages, so animating scale on the same
  // element that carries the position wrote `transform: none` over it and
  // stacked every node at the origin. That was invisible to every test and
  // obvious in the first screenshot.
  //
  // Split like this, both get what they need: the spring stays on the arrival,
  // and dragging stays rigid to the pointer, which is what you want while a
  // thing is under your finger.
  return (
    <div
      ref={nodeRef}
      data-node-id={node.id}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (canEdit) onOpenEditor?.(node);
      }}
      className="absolute left-0 top-0 flex flex-col items-center"
      style={{
        width: NODE_WIDTH,
        transform: `translate(${node.x}px, ${node.y}px)`,
        cursor: canEdit ? 'grab' : 'default',
        touchAction: 'none',
      }}
    >
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        // `dropped` bumps a counter on release, and the spring overshoots back
        // to 1 — the portrait lands rather than stopping dead. Damping is low
        // enough to be felt and high enough not to wobble.
        animate={{ scale: dropped ? [1.07, 1] : 1, opacity: 1 }}
        whileHover={canEdit ? { scale: 1.035 } : undefined}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: 'spring', stiffness: 420, damping: 20, mass: 0.6 }
        }
        className="flex w-full flex-col items-center"
      >
      <div className="group relative">
        {src ? (
          <img
            src={src}
            alt=""
            draggable={false}
            className={`panel-cut border-2 object-cover ${selected ? 'border-brand-500' : 'border-zinc-700'}`}
            style={{ width: NODE_WIDTH, height: PORTRAIT_HEIGHT }}
          />
        ) : (
          <div
            className={`flex items-center justify-center panel-cut border-2 bg-zinc-800 text-4xl font-bold text-zinc-600 ${selected ? 'border-brand-500' : 'border-zinc-700'}`}
            style={{ width: NODE_WIDTH, height: PORTRAIT_HEIGHT }}
          >
            {(person?.name ?? '?').slice(0, 1).toUpperCase()}
          </div>
        )}

        {canEdit && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label={`Remove ${person?.name ?? 'this person'}`}
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-zinc-400 opacity-0 transition-opacity hover:border-brand-500 hover:text-brand-300 group-hover:opacity-100 hover-only-action"
          >
            <X size={11} />
          </button>
        )}

        {/* The four connection dots. Visible on hover, and forced visible for
            everyone while a line is being drawn — you need to see where you
            may drop it, not discover it by hovering mid-drag. */}
        {canEdit &&
          SIDES.map((side) => (
            <ConnectDot
              key={side}
              side={side}
              visible={connecting}
              highlighted={connectTarget === side}
              onPointerDown={(e) => onDotPointerDown?.(e, node, side)}
            />
          ))}

        {menuOpen && (
          <DeleteMenu
            onClose={() => setMenuOpen(false)}
            onChoose={(keepRelationships) => {
              setMenuOpen(false);
              onRequestDelete?.(node, keepRelationships);
            }}
          />
        )}
      </div>

      {showText && (
        <div className="mt-1 flex w-full flex-col items-center leading-tight">
          <HaloText className="truncate text-center text-[13px] font-bold text-white">
            {person?.name ?? 'Unknown'}
          </HaloText>
          {node.nickname ? (
            <HaloText className="truncate text-center text-[11px] text-zinc-400">
              {`"${node.nickname}"`}
            </HaloText>
          ) : null}
        </div>
      )}
      </motion.div>
    </div>
  );
}

// One connection dot, protruding a few pixels from its side of the portrait.
// It is a grab handle: `stopPropagation` on pointerdown so it starts a line
// rather than a node drag, and a transparent hit-ring twice its visible size
// because a 9px target is not one.
function ConnectDot({ side, visible, highlighted, onPointerDown }) {
  const place = {
    top: { left: '50%', top: -DOT_OUT, transform: 'translate(-50%, -50%)' },
    bottom: { left: '50%', top: `calc(100% + ${DOT_OUT}px)`, transform: 'translate(-50%, -50%)' },
    left: { left: -DOT_OUT, top: '50%', transform: 'translate(-50%, -50%)' },
    right: { left: `calc(100% + ${DOT_OUT}px)`, top: '50%', transform: 'translate(-50%, -50%)' },
  }[side];
  return (
    <span
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e);
      }}
      className={`absolute flex h-4 w-4 items-center justify-center transition-opacity ${
        visible || highlighted ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}
      style={{ ...place, cursor: 'crosshair', touchAction: 'none' }}
    >
      <span
        className={`block rounded-full transition-all ${
          highlighted
            ? 'h-3 w-3 bg-brand-400 shadow-[0_0_10px_rgb(var(--color-brand-rgb)/70%)]'
            : 'h-2 w-2 bg-zinc-400 hover:h-3 hover:w-3 hover:bg-brand-400'
        }`}
      />
    </span>
  );
}

// The two options the ✕ offers. Not a portal: it is a child of the node and
// therefore already inside the board's transform, which is exactly where it
// should live — it is anchored to the portrait, not to the viewport.
function DeleteMenu({ onClose, onChoose }) {
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute left-1/2 top-full z-20 mt-1 w-52 -translate-x-1/2 panel-cut border border-zinc-700 bg-zinc-950 p-1 shadow-2xl shadow-black/80"
    >
      <MenuButton onClick={() => onChoose(true)}>
        Delete character only
        <span className="block normal-case text-[9px] text-zinc-500">
          Relationships stay, floating loose
        </span>
      </MenuButton>
      <MenuButton onClick={() => onChoose(false)}>
        Delete character and all relationships
        <span className="block normal-case text-[9px] text-zinc-500">Everything goes</span>
      </MenuButton>
      <MenuButton onClick={onClose} muted>
        Cancel
      </MenuButton>
    </div>
  );
}

function MenuButton({ onClick, children, muted }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide ${
        muted ? 'text-zinc-600 hover:text-zinc-300' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Shapes, Trash2, X } from 'lucide-react';
import { socket } from '../socket.js';
import { DESTRUCTIBLE, TILES, TILE_BY_KEY, displayKinds, groupSquares, mergeInto, placeTile, squareKey } from '../lib/mapTiles.js';
import { quadCenter, quadSize, tileShapes } from '../lib/tileArt.js';
import { beginTileDrag, subscribeTileDrag } from '../lib/combatDrag.js';

// Map tiles on the Scene (decided, new) — the Combat map and Simple Combat
// lanes share everything here; each view only says where its squares are:
//   squareAt(clientX, clientY) → { col, row } | null   (null: off the board)
//   quadOf(col, row)           → [tl, tr, br, bl] in the view's own pixels | null
// Tiles sit ABOVE the grid / lane lines and BELOW every token or miniature.
// Everyone may place, move and remove them (decided, as in the book's Free
// Placement); the stacking rules are client/src/lib/mapTiles.js's.

const DRAG_THRESHOLD = 5;
const HIGHLIGHT = 'rgba(250, 204, 21, 0.35)';

// One square's tiles, drawn into `quad`. `label` adds the names in the middle.
export function TileFrame({ quad, kinds, label = true, opacity = 1 }) {
  const shown = displayKinds(kinds);
  const { w, h } = quadSize(quad);
  const [cx, cy] = quadCenter(quad);
  const lines = shown.map((k) => TILE_BY_KEY[k]).filter(Boolean);
  // Fits the square: the longest name within ~85% of its width (Rajdhani's
  // capitals run about 0.55em each), and every line within its height.
  const longest = Math.max(1, ...lines.map((t) => t.name.length));
  const font = Math.max(6, Math.min(14, (w * 0.85) / (longest * 0.55), (h * 0.55) / Math.max(1, lines.length)));
  return (
    <g opacity={opacity}>
      {shown.map((k) =>
        tileShapes(k, quad, TILE_BY_KEY[k]?.color ?? '#fff').map((s, i) => (
          <path
            key={`${k}${i}`}
            d={s.d}
            fill={s.fill}
            stroke={s.stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={s.dash}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={s.opacity}
          />
        ))
      )}
      {label &&
        lines.map((t, i) => (
          <text
            key={t.key}
            x={cx}
            y={cy + (i - (lines.length - 1) / 2) * font * 1.05}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={font}
            fontWeight="700"
            fill={t.color}
            stroke="rgba(0,0,0,0.85)"
            strokeWidth={Math.max(2, font * 0.28)}
            paintOrder="stroke"
            style={{ fontFamily: 'Rajdhani, sans-serif', textTransform: 'uppercase', letterSpacing: '0.03em' }}
          >
            {t.name}
          </text>
        ))}
    </g>
  );
}

const pointsAttr = (quad) => quad.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

// Everything a view needs to show and edit its tiles: the drawn layer (an SVG
// of the view's size), and the popup. `rootRef` is the view's positioned root,
// whose top-left is (0, 0) of `quadOf`.
export function MapTileLayer({ active = true, mode, tiles, squareAt, quadOf, width, height, rootRef, zIndex = 1 }) {
  const squares = useMemo(() => [...groupSquares(tiles).values()], [tiles]);
  const [drag, setDrag] = useState(null); // { key, from, pointerId, startX, startY, x, y, moved }
  const [paletteDrag, setPaletteDrag] = useState(null); // { kind, x, y }
  const [popup, setPopup] = useState(null); // { col, row }
  // A move shows where it landed straight away; the next stage update clears it.
  const [pending, setPending] = useState(null);
  useEffect(() => setPending(null), [tiles]);

  const latest = useRef({});
  latest.current = { squareAt, mode, active };
  useEffect(
    () =>
      subscribeTileDrag((ev) => {
        // A hidden view (the Combat map kept mounted outside Combat) ignores drags.
        if (!latest.current.active) return;
        if (ev.type === 'move') setPaletteDrag({ kind: ev.item.kind, x: ev.x, y: ev.y });
        else {
          setPaletteDrag(null);
          if (ev.type !== 'drop') return;
          const sq = latest.current.squareAt(ev.x, ev.y);
          if (sq) socket.emit('map_tile:place', { mode: latest.current.mode, col: sq.col, row: sq.row, kind: ev.item.kind });
        }
      }),
    []
  );

  const shown = useMemo(() => {
    if (!pending) return squares;
    const map = new Map(squares.map((s) => [squareKey(s.col, s.row), { ...s }]));
    const moving = map.get(squareKey(pending.from.col, pending.from.row));
    if (!moving) return squares;
    map.delete(squareKey(pending.from.col, pending.from.row));
    if (pending.to) {
      const k = squareKey(pending.to.col, pending.to.row);
      const target = map.get(k) ?? { col: pending.to.col, row: pending.to.row, kinds: [] };
      map.set(k, { ...target, kinds: mergeInto(target.kinds, moving.kinds) });
    }
    return [...map.values()];
  }, [squares, pending]);

  const toLocal = (clientX, clientY) => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? [clientX - r.left, clientY - r.top] : [clientX, clientY];
  };

  const onDown = (e, sq) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: { col: sq.col, row: sq.row }, kinds: sq.kinds, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false });
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, moved });
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) setPopup(drag.from);
    else {
      const to = squareAt(e.clientX, e.clientY);
      if (!to || to.col !== drag.from.col || to.row !== drag.from.row) {
        setPending({ from: drag.from, to });
        socket.emit('map_tile:move', { mode, from: drag.from, to });
        setPopup(null);
      }
    }
    setDrag(null);
  };

  // Where a drop would land, and what is being carried.
  const carrying = drag?.moved ? { kinds: drag.kinds, x: drag.x, y: drag.y } : paletteDrag ? { kinds: [paletteDrag.kind], x: paletteDrag.x, y: paletteDrag.y } : null;
  const target = carrying ? squareAt(carrying.x, carrying.y) : null;
  const targetQuad = target ? quadOf(target.col, target.row) : null;
  const targetKinds = target ? shown.find((s) => s.col === target.col && s.row === target.row)?.kinds ?? [] : [];
  const preview = targetQuad
    ? drag?.moved
      ? mergeInto(targetKinds, carrying.kinds)
      : placeTile(targetKinds, carrying.kinds[0])
    : null;

  const popupSquare = popup ? shown.find((s) => s.col === popup.col && s.row === popup.row) : null;
  const popupQuad = popupSquare ? quadOf(popupSquare.col, popupSquare.row) : null;
  useEffect(() => {
    if (popup && !popupSquare) setPopup(null);
  }, [popup, popupSquare]);

  return (
    <>
      <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height} style={{ zIndex }} aria-hidden>
        {targetQuad && <polygon points={pointsAttr(targetQuad)} fill={HIGHLIGHT} />}
        {shown.map((sq) => {
          const quad = quadOf(sq.col, sq.row);
          if (!quad) return null;
          const lifted = drag?.moved && drag.from.col === sq.col && drag.from.row === sq.row;
          const isTarget = target && target.col === sq.col && target.row === sq.row;
          return (
            <g key={squareKey(sq.col, sq.row)} data-map-tile={squareKey(sq.col, sq.row)}>
              <TileFrame quad={quad} kinds={sq.kinds} opacity={lifted ? 0.3 : isTarget ? 0.35 : 1} />
              {/* The hit area: the whole square. */}
              <polygon
                points={pointsAttr(quad)}
                fill="transparent"
                style={{ pointerEvents: 'all', cursor: lifted ? 'grabbing' : 'pointer', touchAction: 'none' }}
                onPointerDown={(e) => onDown(e, sq)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={() => setDrag(null)}
              >
                <title>{displayKinds(sq.kinds).map((k) => TILE_BY_KEY[k]?.name).join(' + ')}</title>
              </polygon>
            </g>
          );
        })}
        {targetQuad && preview && <TileFrame quad={targetQuad} kinds={preview} opacity={0.85} />}
        {carrying && !targetQuad && (() => {
          const [x, y] = toLocal(carrying.x, carrying.y);
          const r = 22;
          const quad = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
          return <TileFrame quad={quad} kinds={carrying.kinds} opacity={0.6} />;
        })()}
      </svg>
      {popupSquare && popupQuad && (
        <TileInfoPopup
          mode={mode}
          square={popupSquare}
          anchor={{ x: quadCenter(popupQuad)[0], top: Math.min(...popupQuad.map((p) => p[1])), bottom: Math.max(...popupQuad.map((p) => p[1])) }}
          bounds={{ width, height }}
          onClose={() => setPopup(null)}
        />
      )}
    </>
  );
}

// A placed square's tiles: each one's description, with Remove (and Destroy
// for a Wall or Rubble). Opens above the square, or below if there is no room.
function TileInfoPopup({ mode, square, anchor, bounds, onClose }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  const kinds = displayKinds(square.kinds);
  const W = 240;
  const left = Math.max(8, Math.min(bounds.width - W - 8, anchor.x - W / 2));
  const above = anchor.top > 200;
  const emit = (event, kind) => socket.emit(event, { mode, col: square.col, row: square.row, kind });
  return (
    <div
      ref={ref}
      className="pointer-events-auto absolute space-y-2 panel-cut-sm border border-zinc-700 bg-zinc-950/95 p-2 shadow-xl"
      style={{ left, width: W, zIndex: 40, ...(above ? { bottom: bounds.height - anchor.top + 6 } : { top: anchor.bottom + 6 }) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" onClick={onClose} aria-label="Close" className="absolute right-1 top-1 p-1 text-zinc-500 hover:text-zinc-200">
        <X size={14} aria-hidden />
      </button>
      {kinds.map((k) => {
        return (
          <div key={k} className="pr-5">
            <TileInfo kind={k} />
            <div className="mt-1 flex gap-1">
              <button
                type="button"
                onClick={() => emit('map_tile:remove', k)}
                className="min-h-8 panel-cut-sm border border-zinc-700 px-2 text-[11px] text-zinc-300 hover:border-red-500 hover:text-red-400"
              >
                Remove
              </button>
              {DESTRUCTIBLE.has(k) && (
                <button
                  type="button"
                  onClick={() => emit('map_tile:destroy', k)}
                  title={k === 'wall' ? 'Destroyed by 2+ damage: becomes Rubble' : 'Destroyed by 2+ damage: gone'}
                  className="min-h-8 panel-cut-sm border border-zinc-700 px-2 text-[11px] text-zinc-300 hover:border-orange-500 hover:text-orange-300"
                >
                  Destroy{k === 'wall' ? ' → Rubble' : ''}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A tile's name, colour and brief rules.
function TileInfo({ kind }) {
  const t = TILE_BY_KEY[kind];
  if (!t) return null;
  return (
    <>
      <p className="font-display text-sm font-bold uppercase tracking-wide" style={{ color: t.color }}>
        {t.name}
      </p>
      <p className="text-xs leading-snug text-zinc-300">{t.blurb}</p>
    </>
  );
}

function useOutsideClose(ref, onClose) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) latest.current?.();
    };
    // Next tick, so the tap that opened it doesn't close it.
    const id = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [ref]);
}

const SWATCH = [[2, 2], [34, 2], [34, 34], [2, 34]];

// **The Map Tiles palette (decided, new)** — an overlay button at the left of
// the screen, shown only in Simple Combat and Combat. It opens a small
// vertical list of every tile: its look and name. Drag one onto a square to
// place it; tap it for a brief description of what it does.
export function MapTilePalette({ mode, left = 0, role }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null); // tile key
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) setInfo(null);
  }, [open]);
  return (
    <div
      ref={boxRef}
      className="absolute top-1/2 flex -translate-y-1/2 items-start gap-1.5"
      style={{ left: left + 12, zIndex: 1000, marginLeft: 'var(--safe-left)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Map tiles"
        aria-label="Map tiles"
        aria-expanded={open}
        className={`flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border ${
          open ? 'border-brand-500 bg-brand-900/70 text-brand-200' : 'border-zinc-700 bg-zinc-900/85 text-zinc-300 hover:border-brand-500 hover:text-brand-300'
        }`}
      >
        <Shapes size={18} aria-hidden />
      </button>
      {open && (
        <div className="flex max-h-[70vh] w-36 flex-col gap-0.5 overflow-y-auto panel-cut-sm border border-zinc-700 bg-zinc-950/90 p-1">
          {TILES.map((t) => (
            <button
              key={t.key}
              type="button"
              data-tile-palette={t.key}
              onPointerDown={(e) => beginTileDrag({ kind: t.key }, e)}
              onClick={() => setInfo((k) => (k === t.key ? null : t.key))}
              className={`flex items-center gap-2 rounded-sm px-1 py-0.5 text-left ${info === t.key ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
              style={{ touchAction: 'none', cursor: 'grab' }}
            >
              <svg width="36" height="36" className="shrink-0" aria-hidden>
                <rect x="2" y="2" width="32" height="32" fill="rgba(24,24,27,0.9)" />
                <TileFrame quad={SWATCH} kinds={t.key === 'pit_trap' ? ['pit', 'trap'] : [t.key]} label={false} />
              </svg>
              <span className="font-display text-xs font-semibold uppercase leading-tight tracking-wide" style={{ color: t.color }}>
                {t.name}
              </span>
            </button>
          ))}
          {role === 'gm' && (
            <button
              type="button"
              onClick={() => window.confirm('Remove every tile from this fight’s board?') && socket.emit('map_tile:clear', { mode })}
              className="mt-1 flex items-center justify-center gap-1 rounded-sm border border-zinc-800 px-1 py-1 text-[10px] text-zinc-400 hover:border-red-500 hover:text-red-400"
            >
              <Trash2 size={11} aria-hidden /> Clear all tiles
            </button>
          )}
        </div>
      )}
      {open && info && (
        <div className="relative w-56 panel-cut-sm border border-zinc-700 bg-zinc-950/95 p-2 pr-6 shadow-xl">
          <button type="button" onClick={() => setInfo(null)} aria-label="Close" className="absolute right-1 top-1 p-1 text-zinc-500 hover:text-zinc-200">
            <X size={14} aria-hidden />
          </button>
          <TileInfo kind={info} />
          <p className="mt-1 text-[10px] italic text-zinc-500">Drag it onto a square to place it.</p>
        </div>
      )}
    </div>
  );
}

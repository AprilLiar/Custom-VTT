import { vipIdsOf } from '../lib/battleParams.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import CopyLayer from './CopyLayer.jsx';
import SquarePickLayer from './SquarePickLayer.jsx';
import ActiveRangeLayer from './ActiveRangeLayer.jsx';
import PickViewLayer from './PickViewLayer.jsx';
import { clearSquarePick, isChoosing, pickAt, setSquarePick, useChoosing } from '../lib/squarePick.js';
import { OBSTACLES } from '../lib/mapTiles.js';
import { Maximize2, Minus, Plus, X } from 'lucide-react';
import { socket } from '../socket.js';
import {
  cellAt,
  cellCenter,
  cellInside,
  cellRect,
  cellTaken,
  fitImage,
  GRID_MARGIN_SQUARES,
  gridLines,
  moveToken,
  normalizeGrid,
} from '../lib/combatGrid.js';
import { subscribeFighterDrag } from '../lib/combatDrag.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';
import FighterOverlay, { ArmorRings, ChallengeLock } from './FighterOverlay.jsx';
import FighterFx from './fx/FighterFx.jsx';
import TileFx from './fx/TileFx.jsx';
import { lungeOf, moveHow, slideTransition, swapStepOf } from '../lib/boardFx.js';
import { useLunge } from './fx/useLunge.js';
import { armorRings } from '../lib/panicTokens.js';
import { MapTileLayer } from './MapTiles.jsx';
import MapBorderLayer from './MapBorders.jsx';
import { HazardBadges, hazardsAt } from './HazardBadges.jsx';
import { isTakenOut } from '../lib/hpBars.js';
import { useHandMove } from './HandMoveDialog.jsx';

// The Combat view (Panic at the Dojo, Phase 3): the Scene's Combat Background,
// fitted whole into the stage, its square grid, and every placed token.
//
// Replaces the stage while the Scene is in Combat mode (decided: map only — no
// figures, drawings or lane). Grid geometry is in the map image's own pixels
// (client/src/lib/combatGrid.js), so it lines up for every viewer.
//
// Tokens snap to cells. Dragging one onto another swaps them; dropping a new
// one from a palette (combatDrag.js) onto an occupied cell is refused. A click
// that isn't a drag calls `onSelect(token)` — the token panel hangs off it.

const DRAG_THRESHOLD = 5;
const MAX_ZOOM = 5;
const MIN_ZOOM = 0.5;
const HIGHLIGHT = 'rgba(250, 204, 21, 0.45)';

export default function CombatMap({
  active = true,
  scene,
  tokens,
  stageWidth,
  stageHeight,
  inset,
  role,
  controls = () => false,
  setup = {},
  // Armor sources used this turn, by combatant id (the fight's `armor_used`).
  armorUsed = {},
  weight = null,
  tiles = [],
  // Map borders (red / purple lines on square edges): [{ side, col, row, color, blocksRange }].
  borders = [],
  // The combatant whose turn it is (a fight in this mode), or null.
  activeCombatantId = null,
  // Board animations: the beat playing now (useBoardFx), or null.
  fxBeat = null,
  // The +, − and fit buttons — none on a phone (play feedback 8: pinch and drag instead).
  zoomButtons = true,
}) {
  // The token whose panel is open (Phase 4). A click opens it; a drag closes it.
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  // No token menu while any choice is open (decided, batch 3) — and one open
  // when a choice starts closes.
  const choosing = useChoosing();
  const onSelect = (t) => !isChoosing() && setSelectedTokenId(t.id);
  useEffect(() => {
    if (choosing) setSelectedTokenId(null);
  }, [choosing]);
  const rootRef = useRef(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const src = scene?.combat_image_url ?? null;
  useEffect(() => setNatural({ width: 0, height: 0 }), [src]);
  const imgRef = useRef(null);
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
  }, [src]);

  const grid = useMemo(() => normalizeGrid(scene?.grid ?? {}), [scene?.grid]);
  const insetLeft = inset?.left ?? 0;
  const insetRight = inset?.right ?? 0;
  // The whole board fits at zoom 1: the picture and the 2 squares round it
  // (combatGrid.js GRID_MARGIN_SQUARES). `baseFit` is still the picture's place.
  const baseFit = useMemo(() => {
    const m = GRID_MARGIN_SQUARES * grid.size;
    if (!natural.width) return fitImage(stageWidth, stageHeight, 0, 0, { left: insetLeft, right: insetRight });
    const board = fitImage(stageWidth, stageHeight, natural.width + 2 * m, natural.height + 2 * m, { left: insetLeft, right: insetRight });
    return { scale: board.scale, width: natural.width * board.scale, height: natural.height * board.scale, left: board.left + m * board.scale, top: board.top + m * board.scale };
  }, [stageWidth, stageHeight, natural.width, natural.height, insetLeft, insetRight, grid.size]);

  // **Zoom (decided, added with Phase 5)** — per viewer, never synced: the
  // wheel zooms about the pointer (0.5× to 5×), dragging empty map pans, and
  // the corner buttons do the same for touch. `view` is the offset of the
  // zoomed image's corner from where the fitted image would sit.
  const [view, setView] = useState({ zoom: 1, offX: 0, offY: 0 });
  useEffect(() => setView({ zoom: 1, offX: 0, offY: 0 }), [src]);
  const area = { left: insetLeft, right: stageWidth - insetRight, top: 0, bottom: stageHeight };
  // **The camera may leave the arena (decided, batch 5):** the map can be
  // dragged, at any zoom, until only a strip of it is left on screen — never
  // lost entirely. Zoom runs from 0.5× to 5×.
  const clampView = (v) => {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
    const w = baseFit.width * zoom;
    const h = baseFit.height * zoom;
    const clampAxis = (off, base, size, lo, hi) => {
      const keep = Math.min(120, size / 4, (hi - lo) / 4);
      return Math.min(hi - keep, Math.max(lo + keep - size, base + off)) - base;
    };
    return {
      zoom,
      offX: clampAxis(v.offX, baseFit.left, w, area.left, area.right),
      offY: clampAxis(v.offY, baseFit.top, h, area.top, area.bottom),
    };
  };
  // Zoom by `factor` keeping the stage point (sx, sy) where it is.
  const zoomAt = (factor, sx, sy) =>
    setView((v) => {
      const scale = baseFit.scale * v.zoom;
      const ox = baseFit.left + v.offX;
      const oy = baseFit.top + v.offY;
      const px = (sx - ox) / scale;
      const py = (sy - oy) / scale;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const ns = baseFit.scale * zoom;
      return clampView({ zoom, offX: sx - px * ns - baseFit.left, offY: sy - py * ns - baseFit.top });
    });
  const fit = {
    scale: baseFit.scale * view.zoom,
    width: baseFit.width * view.zoom,
    height: baseFit.height * view.zoom,
    left: baseFit.left + view.offX,
    top: baseFit.top + view.offY,
  };
  // **Tokens stick to their squares (fix).** A token slides when IT moves (a
  // drop, a swap), but when the view moves — pan, zoom, a resize — every token
  // must move with the map in the same frame, or they trail behind it.
  const viewKey = `${fit.left.toFixed(2)},${fit.top.toFixed(2)},${fit.scale.toFixed(5)}`;
  const lastViewKey = useRef(viewKey);
  const viewMoved = lastViewKey.current !== viewKey;
  useEffect(() => {
    lastViewKey.current = viewKey;
  });
  const panRef = useRef(null);
  const onWheel = (e) => {
    if (!baseFit.scale) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(Math.exp(-e.deltaY / 400), e.clientX - rect.left, e.clientY - rect.top);
  };
  // One finger (or the mouse) on empty map pans; **two fingers pinch (decided,
  // batch 5)**: the zoom follows their spread, about their midpoint, and the
  // map follows the midpoint.
  const touches = useRef(new Map()); // pointerId → { x, y }
  const pinchOf = () => {
    const [a, b] = [...touches.current.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const onPanDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    panRef.current = touches.current.size === 2 ? { pinch: pinchOf() } : { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onPanMove = (e) => {
    const p = panRef.current;
    if (!p || !touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (p.pinch) {
      if (touches.current.size < 2) return;
      const now = pinchOf();
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect && p.pinch.d > 0 && now.d > 0) zoomAt(now.d / p.pinch.d, now.x - rect.left, now.y - rect.top);
      const dx = now.x - p.pinch.x;
      const dy = now.y - p.pinch.y;
      setView((v) => clampView({ ...v, offX: v.offX + dx, offY: v.offY + dy }));
      panRef.current = { pinch: now };
      return;
    }
    if (p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    panRef.current = { ...p, x: e.clientX, y: e.clientY };
    setView((v) => clampView({ ...v, offX: v.offX + dx, offY: v.offY + dy }));
  };
  const onPanUp = (e) => {
    touches.current.delete(e.pointerId);
    // One finger left after a pinch pans on.
    const [id, at] = [...touches.current.entries()][0] ?? [];
    panRef.current = id != null ? { id, x: at.x, y: at.y } : null;
  };
  const lines = useMemo(
    () => (natural.width ? gridLines(natural.width, natural.height, grid) : null),
    [natural.width, natural.height, grid]
  );

  // A move is shown where it landed straight away; the next stage update
  // (which carries the server's answer) clears it.
  const [pending, setPending] = useState(null); // [{ id, col, row }]
  useEffect(() => setPending(null), [tokens]);
  const placed = useMemo(() => {
    if (!pending) return tokens;
    const byId = new Map(pending.map((c) => [c.id, c]));
    return tokens.map((t) => (byId.has(t.id) ? { ...t, ...byId.get(t.id) } : t));
  }, [tokens, pending]);

  const ready = natural.width > 0 && fit.scale > 0;
  const toImage = (clientX, clientY) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { x: -1, y: -1 };
    return { x: (clientX - rect.left - fit.left) / fit.scale, y: (clientY - rect.top - fit.top) / fit.scale };
  };
  // **Endless Field / Pyroclasm (Arena Parameters):** the board has no edge —
  // every cell beyond the map image is a square too (Pyroclasm's are Traps).
  const arenaParams = scene?.battle?.combat?.arena ?? [];
  const boundless = arenaParams.includes('endless_field') || arenaParams.includes('pyroclasm');
  const lava = arenaParams.includes('pyroclasm');
  const cellUnder = (clientX, clientY) => {
    if (!ready) return null;
    const p = toImage(clientX, clientY);
    const c = cellAt(grid, p.x, p.y);
    return boundless || cellInside(natural.width, natural.height, grid, c.col, c.row) ? c : null;
  };
  const toStagePx = (x, y) => ({ x: fit.left + x * fit.scale, y: fit.top + y * fit.scale });

  // Map tiles: a grid cell's square in stage pixels (only cells that can hold
  // a token).
  const tileQuadOf = (col, row) => {
    if (!ready) return null;
    const inside = cellInside(natural.width, natural.height, grid, col, row);
    if (!inside && !boundless) return null;
    const r = inside ? cellRect(natural.width, natural.height, grid, col, row) : { x: grid.offsetX + col * grid.size, y: grid.offsetY + row * grid.size, width: grid.size, height: grid.size };
    const a = toStagePx(r.x, r.y);
    const b = toStagePx(r.x + r.width, r.y + r.height);
    return [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]];
  };

  // **Map borders:** an edge's two ends in stage pixels ('v': a square's left
  // edge, 'h': its top), and the edge nearest the pointer — only edges that
  // touch a square of the board.
  const edgePx = (side, col, row) => {
    if (!ready) return null;
    const x = grid.offsetX + col * grid.size;
    const y = grid.offsetY + row * grid.size;
    const a = toStagePx(x, y);
    const b = side === 'v' ? toStagePx(x, y + grid.size) : toStagePx(x + grid.size, y);
    return [[a.x, a.y], [b.x, b.y]];
  };
  const onBoard = (col, row) => boundless || cellInside(natural.width, natural.height, grid, col, row);
  const edgeAt = (clientX, clientY) => {
    if (!ready) return null;
    const p = toImage(clientX, clientY);
    const fx = (p.x - grid.offsetX) / grid.size;
    const fy = (p.y - grid.offsetY) / grid.size;
    const col = Math.floor(fx);
    const row = Math.floor(fy);
    const dx = fx - col;
    const dy = fy - row;
    const near = [
      [dx, { side: 'v', col, row }, [col - 1, row]],
      [1 - dx, { side: 'v', col: col + 1, row }, [col + 1, row]],
      [dy, { side: 'h', col, row }, [col, row - 1]],
      [1 - dy, { side: 'h', col, row: row + 1 }, [col, row + 1]],
    ].sort((m, n) => m[0] - n[0])[0];
    return onBoard(col, row) || onBoard(...near[2]) ? near[1] : null;
  };

  // The GM, or a Player who controls this character (their own, or an NPC assigned to them).
  const canDrag = (t) => role === 'gm' || (t.character_id != null && controls(t.character_id));

  // ---- moving a placed token
  const [drag, setDrag] = useState(null); // { id, pointerId, startX, startY, x, y, moved }
  // A hand move of a fighter holding Speed asks whether to spend it (decided).
  const [handMove, handMoveDialog] = useHandMove();
  const onTokenDown = (e, t) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // A legal square of the open pick under this token: the tap is the pick's.
    if (pickAt('combat', t.col, t.row, scene?.id)) return;
    if (!canDrag(t)) {
      onSelect?.(t);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: t.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false });
  };
  const onTokenMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD;
    if (moved && !drag.moved) setSelectedTokenId(null);
    setDrag({ ...drag, x: e.clientX, y: e.clientY, moved });
  };
  const onTokenUp = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const token = placed.find((t) => t.id === drag.id);
    if (!drag.moved) {
      if (token) onSelect?.(token);
    } else {
      const cell = cellUnder(e.clientX, e.clientY);
      const changes = cell ? moveToken(placed, drag.id, cell.col, cell.row) : null;
      if (changes?.length) {
        setPending(changes);
        const id = drag.id;
        handMove({
          combatantId: token?.fight ? id : null,
          name: token?.name,
          speed: token?.fight?.tokens?.speed ?? 0,
          where: { col: cell.col, row: cell.row },
          send: () => socket.emit('combat_token:move', { combatantId: id, col: cell.col, row: cell.row }),
          revert: () => setPending(null),
        });
      }
    }
    setDrag(null);
  };

  // ---- dropping a new token from a palette
  const [paletteDrag, setPaletteDrag] = useState(null); // { fighter, x, y }
  const latest = useRef({});
  latest.current = { cellUnder, placed, active };
  useEffect(
    () =>
      subscribeFighterDrag((ev) => {
        if (!latest.current.active) return;
        if (ev.type === 'move') setPaletteDrag({ fighter: ev.fighter, x: ev.x, y: ev.y });
        else {
          setPaletteDrag(null);
          if (ev.type !== 'drop' || !latest.current.active) return;
          const cell = latest.current.cellUnder(ev.x, ev.y);
          if (!cell || cellTaken(latest.current.placed, cell.col, cell.row)) return;
          socket.emit('combat_token:place', {
            ownerType: ev.fighter.ownerType,
            ownerId: ev.fighter.ownerId,
            col: cell.col,
            row: cell.row,
          });
          // **Stooges (decided):** dropping a Stooges character asks how many
          // there are, then the rest are placed by tapping free squares.
          if (ev.fighter.ownerType === 'character') {
            fetch(`/api/characters/${ev.fighter.ownerId}/build`)
              .then((r) => r.json())
              .then((r) => {
                if (r?.build?.type === 'character-type.stooges') setStooges({ fighter: ev.fighter, ask: true, total: 6, placed: [cell], left: 0 });
              })
              .catch(() => {});
          }
        }
      }),
    []
  );

  // ---- placing a unit of Stooges: how many, then their squares
  const [stooges, setStooges] = useState(null); // { fighter, ask, total, placed: [cells], left }
  // Every free square of the board: on it, no token, no obstacle but Fog.
  const freeCells = (extra = []) => {
    if (!lines || !natural.width) return [];
    const r = lines.rect;
    const c0 = Math.ceil((r.x0 - grid.offsetX) / grid.size - 0.5);
    const c1 = Math.floor((r.x1 - grid.offsetX) / grid.size - 0.5);
    const r0 = Math.ceil((r.y0 - grid.offsetY) / grid.size - 0.5);
    const r1 = Math.floor((r.y1 - grid.offsetY) / grid.size - 0.5);
    const blocked = new Set(tiles.filter((t) => t.kind !== 'fog' && OBSTACLES.has(t.kind)).map((t) => `${t.col},${t.row}`));
    const out = [];
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (!cellInside(natural.width, natural.height, grid, col, row)) continue;
        if (blocked.has(`${col},${row}`) || cellTaken(placed, col, row) || extra.some((x) => x.col === col && x.row === row)) continue;
        out.push({ id: `${col},${row}`, col, row, label: `column ${col}, row ${row}` });
      }
    }
    return out;
  };
  const stoogeKey = 'stooges-place';
  useEffect(() => {
    if (!stooges || stooges.ask || stooges.left <= 0) {
      clearSquarePick(stoogeKey);
      return undefined;
    }
    setSquarePick({
      key: stoogeKey,
      tone: 'pick',
      mode: 'combat',
      sceneId: scene?.id ?? null,
      title: `Place ${stooges.fighter.name}: ${stooges.left} left`,
      options: freeCells(stooges.placed),
      onPick: (id) => {
        const [col, row] = id.split(',').map(Number);
        socket.emit('combat_token:place', { ownerType: stooges.fighter.ownerType, ownerId: stooges.fighter.ownerId, col, row });
        setStooges((s) => (s ? { ...s, placed: [...s.placed, { col, row }], left: s.left - 1 } : s));
      },
    });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stooges, placed, tiles]);
  useEffect(() => () => clearSquarePick(stoogeKey), []);

  const dragging = drag?.moved ? drag : null;
  let hoverCell = null;
  let hoverOk = false;
  if (dragging) {
    hoverCell = cellUnder(dragging.x, dragging.y);
    hoverOk = Boolean(hoverCell);
  } else if (paletteDrag) {
    hoverCell = cellUnder(paletteDrag.x, paletteDrag.y);
    hoverOk = Boolean(hoverCell) && !cellTaken(placed, hoverCell.col, hoverCell.row);
  }
  const highlight = hoverCell && hoverOk && cellInside(natural.width, natural.height, grid, hoverCell.col, hoverCell.row) ? cellRect(natural.width, natural.height, grid, hoverCell.col, hoverCell.row) : null;
  const outsideHighlight = hoverCell && hoverOk && !highlight ? tileQuadOf(hoverCell.col, hoverCell.row) : null;

  const tokenSize = grid.size * fit.scale * 0.88;
  // A token's middle: its square's, or — the Giant's 2×2 — between its four.
  const tokenCenter = (t) => {
    const a = cellCenter(grid, t.col, t.row);
    if (!(t.size > 1)) return toStagePx(a.x, a.y);
    const b = cellCenter(grid, t.col + 1, t.row + 1);
    return toStagePx((a.x + b.x) / 2, (a.y + b.y) / 2);
  };
  // Each token's overlay (tokens, HP, Challenge) and the open token panel.
  // `onlySelected`: just the token whose panel is open — drawn in a layer of
  // its own above the page's controls, so the map itself never covers the
  // turn order, the back button or the drawers (play feedback).
  const vipIds = vipIdsOf(scene?.battle?.combat);
  const overlays = (onlySelected) => {
          // Where every token stands, for the overlays and the Challenge sparks.
          const centers = new Map(placed.map((t) => [t.id, tokenCenter(t)]));
          const iconSize = Math.max(14, Math.min(26, tokenSize * 0.42));
          const byId = new Map(placed.map((t) => [t.id, t]));
          return placed.filter((t) => (onlySelected ? t.id === selectedTokenId : t.id !== selectedTokenId)).map((t) => {
            if (dragging?.id === t.id) return null;
            const center = centers.get(t.id);
            const fight = t.fight;
            const challenger = fight?.challenge_id != null ? byId.get(fight.challenge_id) : null;
            return (
              <div key={`o${t.id}`}>
                {fight && <ArmorRings center={center} rx={tokenSize / 2 + 6} gap={6} rings={armorRings(fight, setup[`${t.owner_type}:${t.owner_id}`], armorUsed[t.id] ?? 0)} />}
                {/* Only during the Challenge holder's own turn (decided). */}
                {challenger && activeCombatantId === t.id && (
                  <ChallengeLock from={center} to={centers.get(challenger.id)} radius={tokenSize / 2} />
                )}
                {fight && (
                  <FighterOverlay
                    name={t.name}
                    fight={fight}
                    setup={setup[`${t.owner_type}:${t.owner_id}`]}
                    anchor={{ x: center.x, top: center.y - tokenSize / 2, bottom: center.y + tokenSize / 2 }}
                    iconSize={iconSize}
                    selected={selectedTokenId === t.id}
                    canEdit={canDrag(t)}
                    fighterRef={{ combatantId: t.id }}
                    bounds={{ width: stageWidth, height: stageHeight }}
                    weight={weight}
                    challenger={challenger}
                    candidates={placed
                      .filter((o) => o.id !== t.id)
                      .map((o) => ({ key: o.id, ref: { combatantId: o.id }, name: o.name, image_url: o.image_url, crop: o.crop }))}
                    onClose={() => setSelectedTokenId(null)}
                    vip={vipIds.includes(t.id)}
                  />
                )}
              </div>
            );
          });
  };

  const rootRect = rootRef.current?.getBoundingClientRect();

  return (
    <>
    <div
      ref={rootRef}
      // Click-through: only the tokens (and an open panel) catch the pointer,
      // so the drawers beside the map stay usable even while it is raised.
      className="pointer-events-none absolute inset-0"
      // Above the GM's drawers while a token's panel is open.
      // Clipped to the map area between the drawers, so a zoomed-in token off
      // the edge never shows through a drawer — except while a panel is open,
      // when the whole layer sits above the drawers instead.
      style={{
        // 1001 while a panel is open: above the drawers, docks and corner controls.
        zIndex: 1,
        clipPath: `inset(0 ${insetRight}px 0 ${insetLeft}px)`,
      }}
      // The wheel bubbles here from the map and from the tokens on it alike.
      onWheel={onWheel}
      onPointerMove={onTokenMove}
      onPointerUp={onTokenUp}
      onPointerCancel={() => setDrag(null)}
    >
      {/* The visible map area, between the drawers: clips the zoomed map, and
          catches the wheel (zoom) and drags on empty map (pan). */}
      <div
        className={`absolute overflow-hidden ${src ? 'pointer-events-auto' : ''} cursor-grab active:cursor-grabbing`}
        style={{ left: area.left, top: 0, width: Math.max(0, area.right - area.left), height: stageHeight, touchAction: 'none' }}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanUp}
        onPointerCancel={onPanUp}
      >
      {ready && boundless && lines && (
        <BeyondTheMap
          left={area.left}
          width={Math.max(0, area.right - area.left)}
          height={stageHeight}
          inner={{ x0: fit.left + lines.rect.x0 * fit.scale, y0: fit.top + lines.rect.y0 * fit.scale, x1: fit.left + lines.rect.x1 * fit.scale, y1: fit.top + lines.rect.y1 * fit.scale }}
          step={grid.size * fit.scale}
          origin={{ x: fit.left + grid.offsetX * fit.scale, y: fit.top + grid.offsetY * fit.scale }}
          lava={lava}
          hover={outsideHighlight}
        />
      )}
      {src ? (
        <img
          ref={imgRef}
          src={src}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className="pointer-events-none absolute select-none"
          style={
            ready
              ? { left: fit.left - area.left, top: fit.top, width: fit.width, height: fit.height, maxWidth: 'none' }
              : { visibility: 'hidden', left: 0, top: 0 }
          }
        />
      ) : (
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center font-display text-sm uppercase tracking-wide text-zinc-500">
          {role === 'gm' ? 'No Combat Background yet — add one in Map settings.' : 'The map is being prepared.'}
        </p>
      )}

      {ready && lines && (
        <svg
          className="pointer-events-none absolute"
          style={{ left: fit.left + lines.rect.x0 * fit.scale - area.left, top: fit.top + lines.rect.y0 * fit.scale }}
          width={(lines.rect.x1 - lines.rect.x0) * fit.scale}
          height={(lines.rect.y1 - lines.rect.y0) * fit.scale}
          viewBox={`${lines.rect.x0} ${lines.rect.y0} ${lines.rect.x1 - lines.rect.x0} ${lines.rect.y1 - lines.rect.y0}`}
          aria-hidden
        >
          {/* The board's ring past the picture: plain and dark, still squares to stand on. */}
          <path
            d={`M${lines.rect.x0},${lines.rect.y0}H${lines.rect.x1}V${lines.rect.y1}H${lines.rect.x0}Z M0,0V${natural.height}H${natural.width}V0Z`}
            fillRule="evenodd"
            fill="rgba(39,39,42,0.75)"
          />
          {highlight && (
            <rect x={highlight.x} y={highlight.y} width={highlight.width} height={highlight.height} fill={HIGHLIGHT} />
          )}
          <g opacity={grid.opacity}>
            {[
              ['black', 3],
              ['white', 1.2],
            ].map(([stroke, width]) => (
              <g key={stroke} stroke={stroke} strokeWidth={width} vectorEffect="non-scaling-stroke">
                {lines.xs.map((x) => (
                  <line key={`x${x}`} x1={x} x2={x} y1={lines.rect.y0} y2={lines.rect.y1} vectorEffect="non-scaling-stroke" />
                ))}
                {lines.ys.map((y) => (
                  <line key={`y${y}`} x1={lines.rect.x0} x2={lines.rect.x1} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
                ))}
              </g>
            ))}
          </g>
        </svg>
      )}
      </div>

      {/* Above the grid, below every token (tokens are z 10). */}
      {ready && (
        <MapTileLayer
          active={active}
          mode="combat"
          tiles={tiles.filter((t) => t.kind !== 'copy')}
          squareAt={cellUnder}
          quadOf={tileQuadOf}
          width={stageWidth}
          height={stageHeight}
          rootRef={rootRef}
          zIndex={5}
        />
      )}
      {/* Map borders: above the tiles, below the tokens — on top of everything while the GM paints them. */}
      {ready && (
        <MapBorderLayer
          borders={borders}
          edgePx={edgePx}
          edgeAt={edgeAt}
          cell={grid.size * fit.scale}
          width={stageWidth}
          height={stageHeight}
          zIndex={6}
          editable={role === 'gm' && active}
        />
      )}
      {/* Copies (phase E): the Original's picture, faded. */}
      {ready && (
        <CopyLayer
          copies={tiles.filter((t) => t.kind === 'copy')}
          quadOf={tileQuadOf}
          ownerOf={(id) => tokens.find((t) => t.id === id) ?? null}
          zIndex={7}
        />
      )}
      {/* Chained Down (Tilt): a chain from each chained fighter to their Wall (or its Rubble). */}
      {ready && activeCombatantId != null && (
        <ChainLayer chains={scene?.battle?.combat?.chains ?? {}} tiles={tiles} tokens={placed} quadOf={tileQuadOf} centerOf={tokenCenter} width={stageWidth} height={stageHeight} thickness={Math.max(2, grid.size * fit.scale * 0.07)} />
      )}
      {/* Sabotage: each Bomb's HP; Secure the McGuffin: the gem over whoever holds the Important Thing. */}
      {ready && (
        <BattleMarks battle={scene?.battle?.combat} tokens={placed} quadOf={tileQuadOf} centerOf={tokenCenter} size={tokenSize} width={stageWidth} height={stageHeight} />
      )}
      {/* Squares to pick (phase D): above the tiles, below the tokens. */}
      {ready && <ActiveRangeLayer mode="combat" active={activeCombatantId != null && active} quadOf={tileQuadOf} width={stageWidth} height={stageHeight} zIndex={6} />}
      {ready && <PickViewLayer mode="combat" sceneId={scene?.id} quadOf={tileQuadOf} width={stageWidth} height={stageHeight} zIndex={7} />}
      {ready && <SquarePickLayer mode="combat" sceneId={scene?.id} quadOf={tileQuadOf} width={stageWidth} height={stageHeight} zIndex={8} />}

      {ready && zoomButtons && (
        <div
          className="pointer-events-auto absolute bottom-3 flex flex-col gap-1"
          style={{ right: insetRight + 12, zIndex: 30, marginBottom: 'var(--safe-bottom)' }}
        >
          {[
            [Plus, 'Zoom in', () => zoomAt(1.25, (area.left + area.right) / 2, stageHeight / 2)],
            [Minus, 'Zoom out', () => zoomAt(0.8, (area.left + area.right) / 2, stageHeight / 2)],
            [Maximize2, 'Fit the whole map', () => setView({ zoom: 1, offX: 0, offY: 0 })],
          ].map(([Icon, label, onClick]) => (
            <button
              key={label}
              type="button"
              onClick={onClick}
              title={label}
              aria-label={label}
              className="flex h-9 w-9 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/85 text-zinc-300 hover:border-brand-500 hover:text-brand-300"
            >
              <Icon size={16} aria-hidden />
            </button>
          ))}
          {Math.abs(view.zoom - 1) > 0.001 && (
            <span className="text-center font-display text-[10px] tabular-nums text-zinc-400">{view.zoom.toFixed(1)}×</span>
          )}
        </div>
      )}

      {ready &&
        placed.map((t) => {
          const isDragged = dragging?.id === t.id;
          let center;
          if (isDragged && rootRect) center = { x: dragging.x - rootRect.left, y: dragging.y - rootRect.top };
          else center = tokenCenter(t);
          // Board animations (phase 3): a move playing slides over its beat.
          const mv = fxBeat?.effects.find((e) => e.kind === 'move' && e.combatantId === t.id);
          // Phase 4: an Action's attacker lunges at its first target.
          const act = fxBeat?.effects.find((e) => e.kind === 'action' && e.combatantId === t.id && e.data.targets?.length);
          const lungeTo = act ? placed.find((o) => o.id === act.data.targets[0]) : null;
          const step = mv ? swapStepOf(mv, tokenCenter({ ...mv.data.from, size: t.size }), tokenCenter({ ...mv.data.to, size: t.size }), grid.size * fit.scale) : null;
          const lunge = step ?? (lungeTo && lungeTo.col != null ? lungeOf(center, tokenCenter(lungeTo), grid.size * fit.scale) : null);
          return (
            <Token
              key={t.id}
              token={t}
              center={center}
              size={tokenSize * (t.size ?? 1) + (t.size > 1 ? grid.size * fit.scale * 0.12 : 0)}
              lifted={isDragged}
              animate={!viewMoved}
              slide={mv ? { how: moveHow(mv), ms: fxBeat.ms } : null}
              lunge={lunge ? { ...lunge, ms: fxBeat.ms * (step ? 0.9 : 1), key: `${fxBeat.id}:${(step ? mv : act).id}` } : null}
              selected={selectedTokenId === t.id}
              canEdit={canDrag(t)}
              onPointerDown={(e) => onTokenDown(e, t)}
              underfoot={hazardsAt(tiles, t)}
            />
          );
        })}

      {ready && overlays(false)}

      {ready &&
        fxBeat &&
        (() => {
          const centers = new Map(placed.map((t) => [t.id, tokenCenter(t)]));
          const sizeOf = new Map(placed.map((t) => [t.id, t.size ?? 1]));
          return (
            <>
              <TileFx beat={fxBeat} quadOf={tileQuadOf} d={tokenSize} />
              {placed.map((t) => (
                <FighterFx
                  key={`fx${t.id}`}
                  beat={fxBeat}
                  combatantId={t.id}
                  center={t.col != null ? centers.get(t.id) : null}
                  diameter={tokenSize * (t.size ?? 1)}
                  centerOf={(id) => centers.get(id)}
                  squareCenter={(sq) => (sq ? tokenCenter({ col: sq.col, row: sq.row, size: sizeOf.get(t.id) }) : null)}
                  name={t.name}
                />
              ))}
            </>
          );
        })()}

      {paletteDrag && rootRect && (
        <Token
          token={{ name: paletteDrag.fighter.name, image_url: paletteDrag.fighter.image_url, crop: paletteDrag.fighter.crop, top: paletteDrag.fighter.top }}
          center={{ x: paletteDrag.x - rootRect.left, y: paletteDrag.y - rootRect.top }}
          size={Math.max(36, tokenSize)}
          lifted
          ghost={!hoverOk}
        />
      )}
      {handMoveDialog}
    </div>
    {stooges?.ask && (
      <StoogeCountDialog
        name={stooges.fighter.name}
        onCancel={() => setStooges(null)}
        onConfirm={(total) => setStooges((s) => (s ? { ...s, ask: false, total, left: Math.max(0, total - s.placed.length) } : s))}
      />
    )}
    {stooges && !stooges.ask && stooges.left > 0 && (
      <div
        className="pointer-events-auto fixed inset-x-2 mx-auto flex max-w-sm items-center gap-2 panel-cut-sm border border-lime-600 bg-zinc-950/90 px-2 py-1 shadow-xl"
        style={{ zIndex: 3100, top: 'max(3rem, var(--safe-top, 0px))' }}
        role="dialog"
        aria-label="Placing Stooges"
      >
        <p className="min-w-0 flex-1 truncate font-display text-xs font-bold uppercase tracking-wide text-lime-200">
          {stooges.fighter.name}: tap {stooges.left} more free square{stooges.left === 1 ? '' : 's'}
        </p>
        <button type="button" onClick={() => setStooges(null)} className="min-h-7 shrink-0 panel-cut-sm border border-zinc-700 px-2 text-[11px] text-zinc-300 hover:border-lime-400">
          Done
        </button>
      </div>
    )}
    {/* The open token panel, above the page's controls (z 1001) — only it. */}
    {ready && selectedTokenId != null && (
      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 1001 }}>
        {overlays(true)}
      </div>
    )}
    </>
  );
}

const cropFrom = (c) => (c ? cropOf({ crop_x: c.x, crop_y: c.y, crop_w: c.w, crop_h: c.h }) : null);

// A round combat token: the fighter's combat-token picture (or portrait), a
// light ring and a drop shadow. Lifted while dragged.
// `slide` (board animations): a move playing now (boardFx.slideTransition).
export function Token({ token, center, size, lifted = false, animate = true, slide = null, lunge = null, selected = false, ghost = false, canEdit = false, onPointerDown, underfoot = [] }) {
  const lungeRef = useLunge(lunge);
  return (
    <div
      className={`group absolute ${onPointerDown ? `pointer-events-auto ${canEdit ? (lifted ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}` : 'pointer-events-none'}`}
      style={{
        left: center.x - size / 2,
        top: center.y - size / 2,
        width: size,
        height: size,
        zIndex: lifted ? 30 : selected ? 20 : 10,
        // Taken Out at zero HP (batch 5): half transparent and grey, until healed.
        opacity: ghost ? 0.45 : token.fight?.hp && isTakenOut(token.fight.hp) ? 0.5 : 1,
        filter: token.fight?.hp && isTakenOut(token.fight.hp) ? 'grayscale(0.85)' : undefined,
        transition: lifted || !animate ? 'none' : slideTransition(slide, 'left 160ms ease-out, top 160ms ease-out'),
        touchAction: 'none',
      }}
      title={token.name}
      data-combat-token={token.id}
      data-taken-out={token.fight?.hp && isTakenOut(token.fight.hp) ? 'true' : undefined}
      onPointerDown={onPointerDown}
    >
      <div
        // An Action's lunge (board animations): out toward the target and back.
        ref={lungeRef}
        className={`h-full w-full overflow-hidden rounded-full border-2 bg-zinc-800 ${
          selected ? 'border-yellow-400' : 'border-zinc-100/80'
        }`}
        style={{
          boxShadow: lifted ? '0 10px 18px rgba(0,0,0,0.7)' : '0 3px 6px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.8)',
          transform: lifted ? 'scale(1.08)' : undefined,
        }}
      >
        {token.image_url ? (
          <CroppedImage src={token.image_url} crop={cropFrom(token.crop)} top={Boolean(token.top)} alt={token.name} className="h-full w-full rounded-full" draggable={false} />
        ) : (
          <span className="flex h-full w-full items-center justify-center font-display text-lg font-bold uppercase text-zinc-300">
            {(token.name ?? '?').slice(0, 1)}
          </span>
        )}
      </div>
      {!lifted && <HazardBadges list={underfoot} size={size} className="bottom-[10%]" />}
      {/* Only once the token is tapped (decided): on a phone there's no hover,
          and an always-visible ✕ was too easy to hit by accident. */}
      {canEdit && !lifted && token.id != null && selected && (
        <button
          type="button"
          title={`Remove ${token.name} from the map`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            socket.emit('combat_token:remove', { combatantId: token.id });
          }}
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/90 text-zinc-300 hover:text-red-400"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

// **Beyond the map (Endless Field / Pyroclasm):** the grid goes on past the
// image's edge — faint squares a fighter can be pushed or moved to; under
// Pyroclasm they glow as lava (every square out there is a Trap). Stage pixels.
function BeyondTheMap({ left, width, height, inner, step, origin, lava, hover }) {
  if (!(step > 4)) return null;
  const xs = [];
  for (let x = origin.x + Math.ceil((left - origin.x) / step) * step; x <= left + width; x += step) xs.push(x - left);
  const ys = [];
  for (let y = origin.y + Math.ceil(-origin.y / step) * step; y <= height; y += step) ys.push(y);
  const hole = `M0,0H${width}V${height}H0Z M${inner.x0 - left},${inner.y0}V${inner.y1}H${inner.x1 - left}V${inner.y0}Z`;
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
      <defs>
        <radialGradient id="beyond-lava" cx="50%" cy="50%" r="75%">
          <stop offset="0%" stopColor="#f97316" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#7f1d1d" stopOpacity="0.55" />
        </radialGradient>
        <clipPath id="beyond-clip">
          <path d={hole} clipRule="evenodd" />
        </clipPath>
      </defs>
      <g clipPath="url(#beyond-clip)">
        <rect width={width} height={height} fill={lava ? 'url(#beyond-lava)' : 'rgba(24,24,27,0.6)'} className={lava ? 'beyond-lava' : undefined} />
        <g stroke={lava ? 'rgba(253,186,116,0.35)' : 'rgba(161,161,170,0.25)'} strokeWidth="1">
          {xs.map((x) => (
            <line key={`x${x}`} x1={x} x2={x} y1={0} y2={height} />
          ))}
          {ys.map((y) => (
            <line key={`y${y}`} x1={0} x2={width} y1={y} y2={y} />
          ))}
        </g>
      </g>
      {hover && <polygon points={hover.map(([x, y]) => `${x - left},${y}`).join(' ')} fill="rgba(250, 204, 21, 0.45)" />}
    </svg>
  );
}

// **Chained Down (Tilt, decided):** an iron chain, sagging and swaying
// slightly, from the fighter to the Wall they're chained to — while the Wall
// (or its Rubble) stands. Stage pixels; under the tokens.
function ChainLayer({ chains, tiles, tokens, quadOf, centerOf, width, height, thickness }) {
  const links = [];
  for (const [id, sq] of Object.entries(chains)) {
    const t = tokens.find((x) => String(x.id) === String(id));
    if (!t || t.col == null) continue;
    if (!tiles.some((x) => x.col === sq.col && x.row === sq.row && (x.kind === 'wall' || x.kind === 'rubble'))) continue;
    const q = quadOf(sq.col, sq.row);
    if (!q) continue;
    const a = { x: q.reduce((n, p) => n + p[0], 0) / 4, y: q.reduce((n, p) => n + p[1], 0) / 4 };
    const b = centerOf(t);
    links.push({ id, a, b });
  }
  if (!links.length) return null;
  const sag = (a, b, k) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + Math.max(6, Math.hypot(b.x - a.x, b.y - a.y) * k);
    return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
  };
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} style={{ zIndex: 9 }} aria-hidden>
      {links.map(({ id, a, b }) => {
        const d1 = sag(a, b, 0.12);
        const d2 = sag(a, b, 0.2);
        return (
          <g key={id}>
            {/* The links: a dark outline, then alternating steel links that creep along. */}
            <path d={d1} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={thickness * 1.8} strokeLinecap="round">
              <animate attributeName="d" values={`${d1};${d2};${d1}`} dur="2.6s" repeatCount="indefinite" />
            </path>
            <path d={d1} fill="none" stroke="#a1a1aa" strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${thickness * 2.2} ${thickness * 1.1}`} className="chain-links">
              <animate attributeName="d" values={`${d1};${d2};${d1}`} dur="2.6s" repeatCount="indefinite" />
            </path>
            <path d={d1} fill="none" stroke="#e4e4e7" strokeWidth={thickness * 0.4} strokeLinecap="round" strokeDasharray={`${thickness * 1.1} ${thickness * 2.2}`} className="chain-links">
              <animate attributeName="d" values={`${d1};${d2};${d1}`} dur="2.6s" repeatCount="indefinite" />
            </path>
            {/* The shackle at the Wall. */}
            <circle cx={a.x} cy={a.y} r={thickness * 1.6} fill="none" stroke="#d4d4d8" strokeWidth={thickness * 0.7} />
          </g>
        );
      })}
    </svg>
  );
}

// **Victory Parameters on the map:** a Bomb's HP (Sabotage) and the Important
// Thing carried by its holder (Secure the McGuffin). Stage pixels, over the tokens.
const SIDE_FILL = { allies: '#38bdf8', enemies: '#f87171', renegades: '#fbbf24' };
function BattleMarks({ battle, tokens, quadOf, centerOf, size, width, height }) {
  const bombs = battle?.victory === 'sabotage' ? (battle.sabotage?.bombs ?? []) : [];
  const holder = battle?.victory === 'secure_the_mcguffin' && battle.mcguffin?.holder != null ? tokens.find((t) => t.id === battle.mcguffin.holder) : null;
  if (!bombs.length && !holder) return null;
  const r = Math.max(7, size * 0.2);
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} style={{ zIndex: 12 }} aria-hidden>
      {bombs.map((b) => {
        const q = quadOf(b.col, b.row);
        if (!q) return null;
        const x = q[1][0] - r * 0.4;
        const y = q[0][1] + r * 0.4;
        return (
          <g key={`${b.col},${b.row}`}>
            <circle cx={x} cy={y} r={r} fill="#18181b" stroke={SIDE_FILL[b.side] ?? '#f43f5e'} strokeWidth={2} />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={r * 1.1} fontWeight="700" fill="#fecdd3" style={{ fontFamily: 'Rajdhani, sans-serif' }}>
              {b.hp}
            </text>
          </g>
        );
      })}
      {holder?.col != null &&
        (() => {
          const c = centerOf(holder);
          const x = c.x + size * 0.36;
          const y = c.y - size * 0.36;
          const g = r * 1.1;
          return (
            <g className="mcguffin-gem">
              <polygon points={`${x},${y - g} ${x + g * 0.8},${y - g * 0.2} ${x},${y + g} ${x - g * 0.8},${y - g * 0.2}`} fill="#38bdf8" stroke="#e0f2fe" strokeWidth={1.5} />
              <polyline points={`${x - g * 0.8},${y - g * 0.2} ${x + g * 0.8},${y - g * 0.2}`} stroke="#e0f2fe" strokeWidth={1} fill="none" />
            </g>
          );
        })()}
    </svg>
  );
}

// **How many Stooges (decided):** asked when a Stooges character is dropped on
// the map — the one just dropped counts; the rest are placed by tapping squares.
function StoogeCountDialog({ name, onConfirm, onCancel }) {
  const [n, setN] = useState(6);
  return (
    <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/50 p-4" style={{ zIndex: 3050 }} role="dialog" aria-label="How many Stooges?">
      <div className="w-full max-w-xs panel-cut-sm border border-zinc-700 bg-zinc-950 p-3 shadow-2xl">
        <p className="mb-1 font-display text-sm font-bold uppercase tracking-wide text-zinc-100">{name}: how many?</p>
        <p className="mb-2 text-xs text-zinc-400">Stooges are one unit of several bodies (the book starts with 6). This one counts; tap free squares for the rest.</p>
        <div className="mb-3 flex items-center justify-center gap-2">
          <button type="button" onClick={() => setN((v) => Math.max(1, v - 1))} className="h-10 w-10 panel-cut-sm border border-zinc-700 text-lg text-zinc-200" aria-label="Fewer">
            −
          </button>
          <input
            type="number"
            min={1}
            max={20}
            value={n}
            onChange={(e) => setN(Math.min(20, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))}
            className="h-10 w-16 panel-cut-sm border border-zinc-700 bg-zinc-900 text-center text-lg text-zinc-100 outline-none focus:border-brand-500"
            aria-label="How many Stooges"
          />
          <button type="button" onClick={() => setN((v) => Math.min(20, v + 1))} className="h-10 w-10 panel-cut-sm border border-zinc-700 text-lg text-zinc-200" aria-label="More">
            +
          </button>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => onConfirm(n)} className="min-h-10 flex-1 panel-cut-sm bg-brand-600 font-display text-xs font-bold uppercase text-white hover:bg-brand-500">
            Place them
          </button>
          <button type="button" onClick={onCancel} className="min-h-10 panel-cut-sm border border-zinc-700 px-3 text-xs text-zinc-300">
            Just this one
          </button>
        </div>
      </div>
    </div>
  );
}

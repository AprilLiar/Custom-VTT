import { useEffect, useRef } from 'react';
import {
  stageToImageFraction,
  imageFractionToStage,
  stageLengthToImageFraction,
  imageFractionLengthToStage,
} from '../lib/sceneProjection.js';
import { socket } from '../socket.js';

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// A shared pen/eraser annotation canvas over the stage (Scene tab plan,
// decided, new) — a sibling of StageRoster, not a child of it: StageRoster's
// own roster wrapper deliberately caps itself at a low z-index so a crowded
// roster never outranks the GM's drawers (see that file's own CONTROLS_Z
// comment, and the corner-button/drawer bug it documents) — nesting this
// canvas inside that same wrapper would inherit the identical cap and make
// a drawing invisible under a manually-placed figure. As a direct sibling
// instead, its own z-index (below) competes directly with everything else
// on the page, no nesting surprises.
//
// STAGE_DRAWING_Z (700) sits above StageRoster's own MANUAL_Z (500, a
// figure that's been manually dragged) but below its ACTIVE_GESTURE_Z
// (9000, a figure mid-drag or mid-resize RIGHT NOW) — drawings render
// ABOVE every steady-state figure on purpose (the common "circle this,
// point at that" GM annotation use, not a hidden-under-tokens terrain
// layer), while a figure actively being dragged still visually wins for
// the brief moment that gesture is live. Any UI chrome that must stay
// clickable regardless of the active draw tool (TopLeftControls,
// PlayerSummonDock, the draw toolbar itself) sits higher still — see each
// of their own z-index comments.
export const STAGE_DRAWING_Z = 700;

function pointsFromRow(row) {
  try {
    const parsed = JSON.parse(row.points);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function strokePath(ctx, stagePoints, color, widthPx, isEraser) {
  if (stagePoints.length < 2) return;
  ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5, widthPx);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(stagePoints[0][0], stagePoints[0][1]);
  for (let i = 1; i < stagePoints.length; i++) ctx.lineTo(stagePoints[i][0], stagePoints[i][1]);
  ctx.stroke();
}

export default function SceneDrawingLayer({
  drawings,
  stageWidth,
  stageHeight,
  imageNaturalWidth,
  imageNaturalHeight,
  tool, // 'select' | 'pen' | 'erase'
  color,
  penWidth,
  eraserWidth,
}) {
  const canvasRef = useRef(null);
  // The one in-progress LOCAL stroke, if any — a ref, not state, for the
  // same reason StageRoster's own gestureRef is a ref: a point is appended
  // on every pointermove, and routing that through React state would
  // re-render the whole page at pointer-move frequency for no benefit
  // (nobody but the drawer sees a stroke mid-gesture anyway — see the
  // commit-on-release comment on onPointerUp below).
  const liveStrokeRef = useRef(null);
  const geometry = {
    containerWidth: stageWidth,
    containerHeight: stageHeight,
    naturalWidth: imageNaturalWidth,
    naturalHeight: imageNaturalHeight,
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    // Oldest first — replay order IS the eraser (see scene_drawings' own
    // comment in db.js): a stroke only ever erases what was already painted
    // before it landed, never anything drawn after.
    for (const row of drawings) {
      const points = pointsFromRow(row);
      const stagePoints = points.map(([fx, fy]) => {
        const { x, y } = imageFractionToStage({ fx, fy, ...geometry });
        return [x, y];
      });
      const widthPx = imageFractionLengthToStage(row.width, stageWidth, imageNaturalWidth, imageNaturalHeight, stageHeight);
      strokePath(ctx, stagePoints, row.color, widthPx, Boolean(row.is_eraser));
    }
    // The local, not-yet-committed stroke (if the pointer is down right
    // now) paints on top last, so the drawer sees their own line grow
    // immediately rather than waiting on a round trip.
    const live = liveStrokeRef.current;
    if (live) strokePath(ctx, live.points, live.color, live.widthPx, live.isEraser);
  };

  // Re-size the canvas's own pixel buffer to the stage box, HiDPI-aware —
  // a canvas's width/height ATTRIBUTES are its pixel buffer, entirely
  // separate from its CSS size, so both have to be set together or the
  // drawing comes out blurry (buffer too small) or misaligned (buffer
  // sized in CSS px while every coordinate below is real device px).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stageWidth || !stageHeight) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = stageWidth * dpr;
    canvas.height = stageHeight * dpr;
    canvas.style.width = `${stageWidth}px`;
    canvas.style.height = `${stageHeight}px`;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageWidth, stageHeight]);

  // Replays everything from scratch whenever the canonical list changes
  // (a stroke landed, a clear happened, or — via imageNaturalWidth/Height —
  // the backdrop finished loading and every stored fraction now projects to
  // a different pixel spot). Simpler and plenty fast for a per-Scene stroke
  // count in the dozens-to-low-hundreds range; no incremental-append path.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(redraw, [drawings, imageNaturalWidth, imageNaturalHeight]);

  const widthPxFor = (t) => (t === 'erase' ? eraserWidth : penWidth);

  const localPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onPointerDown = (e) => {
    if (tool === 'select') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    liveStrokeRef.current = {
      points: [localPoint(e)],
      color,
      widthPx: widthPxFor(tool),
      isEraser: tool === 'erase',
    };
  };

  const onPointerMove = (e) => {
    const live = liveStrokeRef.current;
    if (!live) return;
    live.points.push(localPoint(e));
    redraw();
  };

  // Committed once per stroke, on release — never mid-gesture. Same
  // trade-off StageRoster's own drag/resize already makes: streaming every
  // point over the socket would re-render every OTHER viewer's canvas at
  // pointer-move frequency for a line only the drawer can see move live
  // anyway. Everyone else just sees it land once the pen lifts.
  const onPointerUp = () => {
    const live = liveStrokeRef.current;
    liveStrokeRef.current = null;
    if (!live || live.points.length < 2) {
      redraw();
      return;
    }
    const imagePoints = live.points.map(([x, y]) => {
      const { fx, fy } = stageToImageFraction({ x, y, ...geometry });
      return [clamp(fx, 0, 1), clamp(fy, 0, 1)];
    });
    const widthFraction = stageLengthToImageFraction(
      live.widthPx,
      stageWidth,
      imageNaturalWidth,
      imageNaturalHeight,
      stageHeight
    );
    socket.emit('scene_draw:add', {
      points: imagePoints,
      color: live.color,
      width: widthFraction,
      isEraser: live.isEraser,
    });
    // No redraw here on purpose — the canvas already shows the just-drawn
    // stroke (painted live during onPointerMove above), and clearing
    // liveStrokeRef without a redraw leaves those exact pixels in place
    // until the server's own echo (the `drawings` effect above) repaints
    // everything including the now-persisted stroke. Redrawing here first
    // would flash it away for the one frame before that echo arrives.
  };

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0"
      style={{
        zIndex: STAGE_DRAWING_Z,
        // Only captures the stage's pointer events while a tool is
        // selected — 'select' (the default) lets every event fall through
        // untouched to StageRoster's own figures beneath, regardless of
        // this canvas's z-index.
        pointerEvents: tool === 'select' ? 'none' : 'auto',
        touchAction: 'none',
        cursor: tool === 'select' ? undefined : 'crosshair',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

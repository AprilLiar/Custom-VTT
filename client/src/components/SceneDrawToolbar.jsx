import { Eraser, Pencil } from 'lucide-react';
import {
  SCENE_PEN_WIDTH_MIN,
  SCENE_PEN_WIDTH_MAX,
  SCENE_ERASER_WIDTH_MIN,
  SCENE_ERASER_WIDTH_MAX,
} from '../lib/sceneSettings.js';

// Docked bottom-right — the one corner nothing else on this page claims:
// PlayerSummonDock owns bottom-left, both GM drawers own the full left/
// right edges, TopLeftControls owns top-left. Available to BOTH roles (a
// Player may draw and erase exactly like a GM — decided, new), unlike
// every OTHER docked control on this page, which is one role or the other.
// Sits above SceneDrawingLayer's own STAGE_DRAWING_Z (see that file) so its
// own buttons stay clickable even while the draw/erase tool has the whole
// stage capturing pointer events — the exact bug StageRoster's corner
// buttons hit against the GM's drawers, avoided here by simply always
// docking above the layer whose pointer capture could otherwise eat it.
export const DRAW_TOOLBAR_Z = 950;

// Clicking the ALREADY-active tool's own button returns to 'select' — the
// same "press it again to undo" shape TopLeftControls' own hide/show
// toggle uses. The eraser's second job (its own "double-press" gesture,
// decided) lives on the SAME button as a plain onDoubleClick — a single
// click still only ever selects the tool; wiping every stroke needs the
// deliberate second gesture, not a stray follow-up click while aiming for
// the button.
export default function SceneDrawToolbar({
  tool,
  onSelectTool,
  color,
  onColorChange,
  penWidth,
  onPenWidthChange,
  eraserWidth,
  onEraserWidthChange,
  onClearAll,
}) {
  const toggle = (t) => onSelectTool((cur) => (cur === t ? 'select' : t));

  return (
    <div
      className="absolute bottom-3 right-3 flex flex-col items-end gap-2"
      style={{ zIndex: DRAW_TOOLBAR_Z, marginBottom: 'var(--safe-bottom)', marginRight: 'var(--safe-right)' }}
    >
      {tool === 'pen' && (
        <div className="flex items-center gap-2 panel-cut-sm border border-zinc-700 bg-zinc-900/90 p-2">
          <input
            type="color"
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
            title="Pen color"
            className="h-7 w-7 cursor-pointer border border-zinc-700 bg-transparent p-0"
          />
          <input
            type="range"
            min={SCENE_PEN_WIDTH_MIN}
            max={SCENE_PEN_WIDTH_MAX}
            value={penWidth}
            onChange={(e) => onPenWidthChange(Number(e.target.value))}
            title="Pen width"
            className="w-24"
          />
        </div>
      )}
      {tool === 'erase' && (
        <div className="flex items-center gap-2 panel-cut-sm border border-zinc-700 bg-zinc-900/90 p-2">
          <span className="text-xs text-zinc-400">Eraser width</span>
          <input
            type="range"
            min={SCENE_ERASER_WIDTH_MIN}
            max={SCENE_ERASER_WIDTH_MAX}
            value={eraserWidth}
            onChange={(e) => onEraserWidthChange(Number(e.target.value))}
            title="Eraser width"
            className="w-24"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => toggle('pen')}
          title="Pen"
          className={`flex h-11 w-11 items-center justify-center panel-cut-sm border ${
            tool === 'pen'
              ? 'border-brand-500 bg-brand-900/60 text-brand-200'
              : 'border-zinc-700 bg-zinc-900/80 text-zinc-300 hover:border-brand-500'
          }`}
        >
          <Pencil size={18} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => toggle('erase')}
          onDoubleClick={onClearAll}
          title="Eraser — double-press to clear every drawing on this Scene"
          className={`flex h-11 w-11 items-center justify-center panel-cut-sm border ${
            tool === 'erase'
              ? 'border-brand-500 bg-brand-900/60 text-brand-200'
              : 'border-zinc-700 bg-zinc-900/80 text-zinc-300 hover:border-brand-500'
          }`}
        >
          <Eraser size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

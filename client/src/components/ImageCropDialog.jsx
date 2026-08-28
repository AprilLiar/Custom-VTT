import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import {
  clampView,
  cropFromView,
  cropStyle,
  initialView,
  minScale,
  viewFromCrop,
  zoomViewAt,
} from '../lib/imageCrop.js';

// The step between picking a file and saving it: choose what actually shows.
//
// **Why this exists.** Every thumbnail in the app is square and every uploaded
// picture is not, so `object-fit: cover` was quietly deciding which part of each
// face survived — and it always chooses the middle, which is where a face
// usually is not. This puts that decision where it belongs.
//
// **The frame is fixed and the picture moves.** The opposite arrangement — a
// draggable rectangle over a still picture — needs eight resize handles and a
// corner you can never quite grab. One square window with the picture panned and
// zoomed behind it is the gesture every phone already teaches, and it makes an
// illegal state unreachable: `clampView` simply cannot put the frame off the
// picture, so there is no "your crop is outside the image" to report.
//
// **The preview is the point.** On the right, the same crop rendered at the size
// it will actually appear, with the name beside it exactly as the app lays it
// out. A crop looks quite different at 320px and at 24px, and the whole reason
// to stop and choose is to see the small one before committing.

const FRAME = 320;

export default function ImageCropDialog({
  src,
  name,
  initialCrop = null,
  // How this picture is used in the app, so the preview shows the real thing
  // rather than a generic square: a roster row, a move card, a board portrait.
  previewSizes = [
    { label: 'In lists', px: 24 },
    { label: 'On cards', px: 48 },
    { label: 'Full size', px: 96 },
  ],
  onCancel,
  onConfirm,
}) {
  const [natural, setNatural] = useState(null);
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const frameRef = useRef(null);
  const dragRef = useRef(null);

  // The picture's real size, which every conversion needs. Read from a detached
  // Image rather than from the rendered <img>, so the view is settled before
  // anything paints and the frame never shows a flash of un-positioned picture.
  useEffect(() => {
    if (!src) return undefined;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      setNatural(size);
      setView(initialCrop ? viewFromCrop(initialCrop, size, FRAME) : initialView(size, FRAME));
    };
    img.onerror = () => live && setFailed(true);
    img.src = src;
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Escape cancels, like every other dialog here.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const pan = useCallback(
    (dx, dy) => setView((v) => (v ? clampView({ ...v, x: v.x + dx, y: v.y + dy }, natural, FRAME) : v)),
    [natural]
  );

  const onPointerDown = (e) => {
    if (!view || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    pan(e.clientX - drag.x, e.clientY - drag.y);
    dragRef.current = { x: e.clientX, y: e.clientY };
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  // Wheel zooms about the pointer, the same rule the relationship board settled
  // on: whatever is under the cursor stays under it.
  const onWheel = (e) => {
    if (!view) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView((v) =>
      zoomViewAt(v, Math.exp(-e.deltaY / 500), e.clientX - rect.left, e.clientY - rect.top, natural, FRAME)
    );
  };

  const zoomBy = (factor) =>
    setView((v) => (v ? zoomViewAt(v, factor, FRAME / 2, FRAME / 2, natural, FRAME) : v));

  const crop = view && natural ? cropFromView(view, natural, FRAME) : null;
  const atMinZoom = view && natural ? view.scale <= minScale(natural, FRAME) + 1e-9 : true;

  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col gap-3 overflow-y-auto panel-cut-lg border border-zinc-700 bg-zinc-900 p-4">
        <div>
          <h3 className="font-display text-sm font-bold uppercase tracking-wide text-zinc-200">
            Choose what shows
          </h3>
          <p className="text-[11px] text-zinc-500">
            Drag to move, scroll to zoom. The whole picture is still saved — only thumbnails use
            this frame.
          </p>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row">
          {/* The frame. A fixed square window with the picture moving behind it. */}
          <div className="shrink-0">
            <div
              ref={frameRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onWheel={onWheel}
              className="relative overflow-hidden panel-cut border-2 border-zinc-700 bg-zinc-950"
              style={{
                width: FRAME,
                height: FRAME,
                maxWidth: '100%',
                cursor: view ? 'grab' : 'default',
                touchAction: 'none',
              }}
            >
              {failed ? (
                <p className="flex h-full items-center justify-center px-6 text-center text-xs text-zinc-600">
                  That file could not be read as an image.
                </p>
              ) : view && natural ? (
                <img
                  src={src}
                  alt=""
                  draggable={false}
                  className="absolute left-0 top-0 origin-top-left select-none"
                  style={{
                    width: natural.width,
                    height: natural.height,
                    maxWidth: 'none',
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  }}
                />
              ) : (
                <p className="flex h-full items-center justify-center text-xs text-zinc-600">…</p>
              )}
              {/* Rule-of-thirds guides, drawn over the picture and ignoring the
                  pointer so they never eat a drag. */}
              {view && !failed && (
                <div className="pointer-events-none absolute inset-0">
                  {[1, 2].map((n) => (
                    <span key={`v${n}`} className="absolute top-0 h-full w-px bg-white/15" style={{ left: `${(n * 100) / 3}%` }} />
                  ))}
                  {[1, 2].map((n) => (
                    <span key={`h${n}`} className="absolute left-0 h-px w-full bg-white/15" style={{ top: `${(n * 100) / 3}%` }} />
                  ))}
                </div>
              )}
            </div>

            <div className="mt-2 flex items-center gap-1">
              <ToolButton onClick={() => zoomBy(1 / 1.25)} disabled={atMinZoom} label="Zoom out">
                <Minus size={13} />
              </ToolButton>
              <ToolButton onClick={() => zoomBy(1.25)} label="Zoom in">
                <Plus size={13} />
              </ToolButton>
              <ToolButton
                onClick={() => natural && setView(initialView(natural, FRAME))}
                label="Reset to the whole picture"
              >
                <RotateCcw size={12} />
              </ToolButton>
            </div>
          </div>

          {/* The preview: the same crop at the sizes it will really appear,
              with the name laid out beside it as the app lays it out. */}
          <div className="min-w-0 flex-1">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
              How it will look
            </div>
            <div className="space-y-3">
              {previewSizes.map((size) => (
                <div key={size.label}>
                  <div className="mb-1 text-[9px] uppercase tracking-wide text-zinc-600">
                    {size.label}
                  </div>
                  <div className="flex items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-2">
                    <PreviewFrame src={src} crop={crop} px={size.px} />
                    <span className="min-w-0 truncate text-sm font-semibold text-zinc-200">
                      {name?.trim() || 'Unnamed'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
          <button
            type="button"
            onClick={onCancel}
            className="panel-cut-sm border border-zinc-700 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!crop}
            onClick={() => onConfirm(crop)}
            className="panel-cut-sm bg-brand-600 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-white hover:bg-brand-500 disabled:opacity-40"
          >
            Use this
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// One preview tile. Deliberately built from `cropStyle` rather than from the
// editor's own view: it renders through the exact code path the app will use,
// so the preview cannot agree with the editor and disagree with the result.
function PreviewFrame({ src, crop, px }) {
  const inner = cropStyle(crop);
  return (
    <span
      className="relative block shrink-0 overflow-hidden panel-cut-sm border border-zinc-700 bg-zinc-800"
      style={{ width: px, height: px }}
    >
      {inner ? <img src={src} alt="" draggable={false} style={inner} /> : null}
    </span>
  );
}

function ToolButton({ onClick, disabled, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center panel-cut-sm border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

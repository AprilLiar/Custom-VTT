import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageDown, Play, Square } from 'lucide-react';
import { socket } from '../socket.js';
import { getImageInventory } from '../lib/api.js';

// **Shrink every picture already in the database, from the browser.**
//
// The app's upload pipeline encodes to WebP now, but everything uploaded before
// that is still a JPEG — or, for Scene pictures and backdrops, a LOSSLESS PNG,
// which is how they came to be the largest rows in the schema. That matters
// more than storage: Render's free tier has no persistent disk, so the embedded
// replica is rebuilt on every cold start and the whole database is downloaded
// several times a day. Shrinking the pictures is shrinking the hosting bill.
//
// **Why this is a button rather than a script.** A one-shot migration would
// need Turso credentials to reach the live database. This needs nothing but
// being logged in as the GM: the browser already has a canvas encoder (the same
// one every upload uses), so it fetches each picture, re-encodes it, and hands
// back only the results that came out smaller.
//
// GIFs are skipped outright — a canvas export keeps one frame and silently
// kills the animation.

const WEBP_QUALITY = 0.82;
const KB = (n) => `${(n / 1024).toFixed(0)} KB`;
// KB under a megabyte: "0.0 MB saved" after a real saving reads as a failure.
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : KB(n));

// Fetch, decode, re-encode. Returns null when there is nothing to gain, so the
// caller can leave the row alone rather than write an identical picture back.
async function reencode(item) {
  const res = await fetch(`/api/img/${item.kind}/${item.id}/${item.hash ?? 'live'}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.type === 'image/gif') return null; // animation would not survive a canvas
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/webp', WEBP_QUALITY);
  if (!dataUrl.startsWith('data:image/webp')) return null; // no WebP encoder here
  const imageData = dataUrl.split(',')[1];
  // The server refuses a bigger picture too; checking here as well saves a
  // pointless round trip per image on a library that is already optimised.
  if (imageData.length >= item.bytes) return null;
  return { imageData, imageMimeType: 'image/webp' };
}

export default function ImageReencodeTool({ onDone }) {
  const [inventory, setInventory] = useState(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [saved, setSaved] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState(null);
  const stop = useRef(false);

  const load = useCallback(() => {
    getImageInventory({ role: 'gm' }).then(setInventory).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const run = async () => {
    if (!inventory?.items?.length) return;
    stop.current = false;
    setRunning(true);
    setDone(0);
    setSaved(0);
    setSkipped(0);
    setError(null);
    for (const item of inventory.items) {
      if (stop.current) break;
      setCurrent(item);
      try {
        const next = await reencode(item);
        if (next) {
          socket.emit('image:reencode', { kind: item.kind, id: item.id, ...next });
          setSaved((s) => s + (item.bytes - next.imageData.length));
        } else {
          setSkipped((s) => s + 1);
        }
      } catch {
        // One unreadable picture must not stop the pass — a library with a
        // single corrupt row should still get the benefit of every other row.
        setSkipped((s) => s + 1);
      }
      setDone((d) => d + 1);
    }
    setCurrent(null);
    setRunning(false);
    load(); // re-read, so the totals shown are the real new ones
  };

  const total = inventory?.items?.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-400">
        Re-encodes every stored picture to WebP, in this browser, and saves back only the ones
        that come out smaller. Safe to run more than once — an already-optimised picture is
        skipped rather than re-saved. Animated GIFs are always skipped.
      </p>

      {error && <p className="text-xs text-red-300">{error}</p>}

      {inventory == null ? (
        <p className="text-sm text-zinc-600">Reading the library…</p>
      ) : (
        <div className="panel-cut-sm border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm">
          <div className="flex justify-between text-zinc-300">
            <span>{total} pictures stored</span>
            <span className="font-mono">{size(inventory.totalBytes)}</span>
          </div>
          {running && (
            <div className="mt-2 text-xs text-zinc-500">
              {done} / {total}
              {current && ` — ${current.kind} #${current.id} (${KB(current.bytes)})`}
            </div>
          )}
          {!running && done > 0 && (
            <div className="mt-2 text-xs text-brand-300">
              Done. {done - skipped} re-encoded, {skipped} already optimal — {size(saved)} saved.
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={running ? () => { stop.current = true; } : run}
          disabled={!total}
          className="min-h-11 panel-cut-sm flex items-center gap-2 border border-brand-600 bg-brand-700/30 px-3 text-xs font-semibold text-brand-200 hover:bg-brand-700/50 disabled:opacity-40 md:min-h-0 md:py-2"
        >
          {running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {running ? 'Stop' : 'Re-encode all pictures'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="min-h-11 panel-cut-sm border border-zinc-700 px-3 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 md:min-h-0 md:py-2"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export const ImageReencodeIcon = ImageDown;

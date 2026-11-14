import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

// **Fullscreen, phones only, in a fight mode (Combat and Simple Combat).** A
// small toggle in the bottom-left corner that hides the browser's own bars.
// It renders nothing where the browser can't take a page fullscreen (an
// iPhone's Safari only fullscreens video), so it never shows a dead button.
const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
const fsEnabled = () => typeof document !== 'undefined' && Boolean(document.fullscreenEnabled ?? document.webkitFullscreenEnabled);

export default function FullscreenButton({ left = 0 }) {
  const [on, setOn] = useState(() => Boolean(typeof document !== 'undefined' && fsElement()));
  useEffect(() => {
    const sync = () => setOn(Boolean(fsElement()));
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);
  if (!fsEnabled()) return null;

  const toggle = () => {
    const root = document.documentElement;
    const done = fsElement()
      ? (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document)
      : (root.requestFullscreen ?? root.webkitRequestFullscreen)?.call(root, { navigationUI: 'hide' });
    // A refused request (no user gesture, a policy) just leaves things as they are.
    done?.catch?.(() => {});
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={on ? 'Exit fullscreen' : 'Fullscreen'}
      aria-label={on ? 'Exit fullscreen' : 'Fullscreen'}
      aria-pressed={on}
      className="absolute bottom-2 flex h-8 w-8 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900/75 text-zinc-300 shadow shadow-black/40 active:border-brand-500 active:text-brand-300"
      style={{ left: left + 8, zIndex: 1000, marginLeft: 'var(--safe-left)', marginBottom: 'var(--safe-bottom)' }}
    >
      {on ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
    </button>
  );
}

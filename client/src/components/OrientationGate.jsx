import { Smartphone } from 'lucide-react';

// Scene tab (decided): the stage never gets a portrait layout. A phone-width
// viewport in portrait sees this instead of the canvas, for both roles —
// simpler and more honest than trying to make a cinematic fullscreen scene
// work in a 390px-wide column. `ScenePage.jsx` is the only caller; the gate
// itself has no opinion on WHEN it applies (see useIsLandscape's own comment
// for why the width check lives with the caller, not the media query).
export default function OrientationGate() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-zinc-950 p-6 text-center text-zinc-300">
      <Smartphone className="rotate-90" size={48} aria-hidden />
      <p className="font-display text-lg font-bold uppercase tracking-wide text-zinc-100">
        Flip your device to landscape
      </p>
      <p className="max-w-xs text-sm text-zinc-500">
        The Scene view is built for a wide screen — rotate your phone to see it.
      </p>
    </div>
  );
}

import { socket } from '../socket.js';

// The Scene / Simple Combat / Combat switch at the top of the Scene page
// (Panic at the Dojo). GM-only — decided: Players don't see it at all, their
// view simply follows (scenes.combat_mode rides every stage:updated). Hidden
// with the rest of the interface in cinematic mode.
const MODES = [
  { key: 'scene', label: 'Scene' },
  { key: 'simple', label: 'Simple Combat' },
  { key: 'combat', label: 'Combat' },
];

export default function SceneModeToggle({ mode }) {
  return (
    <div
      role="radiogroup"
      aria-label="Scene mode"
      className="absolute left-1/2 top-3 flex -translate-x-1/2 panel-cut-sm border border-zinc-700 bg-zinc-950/85 p-0.5 shadow-lg backdrop-blur"
      style={{ zIndex: 1000, marginTop: 'var(--safe-top)' }}
    >
      {MODES.map((m) => {
        const active = mode === m.key;
        return (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => !active && socket.emit('scene:set_mode', { mode: m.key })}
            className={`min-h-10 panel-cut-sm px-3 font-display text-xs font-semibold uppercase tracking-wide transition-colors sm:px-4 ${
              active ? 'bg-brand-600 text-white' : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

import { useState } from 'react';
import {
  DEFAULT_HUE,
  PRESET_HUES,
  applyBrandHue,
  hexToHue,
  hueToBrandHex,
  loadSavedHue,
  saveHue,
} from '../lib/theme.js';

// Only one setting for now (the primary accent color) — more will land here
// later. Live-previews on every change (applyBrandHue), only persists to
// localStorage once a choice is actually made (saveHue), so the app-wide
// --color-brand-* variables (see index.css) always reflect whatever was
// last saved on the next load, not a mid-edit preview.
export default function SettingsPage() {
  const [hue, setHue] = useState(() => loadSavedHue() ?? DEFAULT_HUE);

  const choose = (nextHue) => {
    setHue(nextHue);
    saveHue(nextHue);
  };

  const preview = (nextHue) => applyBrandHue(nextHue);

  const reset = () => {
    setHue(DEFAULT_HUE);
    saveHue(null);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      <div className="panel-cut-lg space-y-3 border border-zinc-800 bg-zinc-900 p-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
            Primary Color
          </h2>
          <p className="mt-1 text-xs text-zinc-600">
            Sets the app's one accent color — buttons, highlights, focus rings. More settings are
            coming later.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {PRESET_HUES.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => choose(p.hue)}
              onMouseEnter={() => preview(p.hue)}
              onMouseLeave={() => preview(hue)}
              title={p.name}
              className={`h-9 w-9 panel-cut-sm border-2 ${
                hue === p.hue ? 'border-zinc-100' : 'border-zinc-700 hover:border-zinc-400'
              }`}
              style={{ backgroundColor: hueToBrandHex(p.hue) }}
            />
          ))}
          <label
            title="Pick a custom color"
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center panel-cut-sm border-2 border-dashed border-zinc-700 text-zinc-500 hover:border-zinc-400 hover:text-zinc-300"
          >
            <input
              type="color"
              value={hueToBrandHex(hue)}
              onChange={(e) => choose(hexToHue(e.target.value))}
              className="h-0 w-0 opacity-0"
            />
            +
          </label>
          <button
            type="button"
            onClick={reset}
            className="panel-cut-sm border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800"
          >
            Reset to default
          </button>
        </div>
      </div>
    </div>
  );
}

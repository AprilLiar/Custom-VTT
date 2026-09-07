import { useState } from 'react';
import {
  DEFAULT_HUE,
  PRESET_HUES,
  applyBrandHue,
  hexToHue,
  hueToBrandHex,
  loadSavedHue,
  saveHue,
  CUTSCENE_SPEED_MIN,
  CUTSCENE_SPEED_MAX,
  DEFAULT_CUTSCENE_SPEED,
  loadCutsceneSpeed,
  saveCutsceneSpeed,
} from '../lib/theme.js';
import {
  SCENE_HEIGHT_SCALE_MIN,
  SCENE_HEIGHT_SCALE_MAX,
  DEFAULT_SCENE_HEIGHT_SCALE,
  loadSceneHeightScale,
  saveSceneHeightScale,
  SCENE_GAP_SCALE_MIN,
  SCENE_GAP_SCALE_MAX,
  DEFAULT_SCENE_GAP_SCALE,
  loadSceneGapScale,
  saveSceneGapScale,
  SCENE_SIZE_SCALE_MIN,
  SCENE_SIZE_SCALE_MAX,
  DEFAULT_SCENE_SIZE_SCALE,
  loadSceneSizeScale,
  saveSceneSizeScale,
  loadSceneShowNameplates,
  saveSceneShowNameplates,
} from '../lib/sceneSettings.js';

// Per-device display preferences. The accent color live-previews on every
// change (applyBrandHue) but only persists once a choice is actually made
// (saveHue), so the app-wide --color-brand-* variables (see index.css)
// always reflect what was last saved on the next load, not a mid-edit
// preview. Everything here is localStorage-only and affects nobody else's
// view — these are properties of the person looking, not of the game.
export default function SettingsPage() {
  const [hue, setHue] = useState(() => loadSavedHue() ?? DEFAULT_HUE);
  const [speed, setSpeed] = useState(loadCutsceneSpeed);
  const [sceneHeightScale, setSceneHeightScale] = useState(loadSceneHeightScale);
  const [sceneGapScale, setSceneGapScale] = useState(loadSceneGapScale);
  const [sceneSizeScale, setSceneSizeScale] = useState(loadSceneSizeScale);
  const [sceneShowNameplates, setSceneShowNameplates] = useState(loadSceneShowNameplates);

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
            Sets the app's one accent color — buttons, highlights, focus rings.
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

      <div className="panel-cut-lg space-y-3 border border-zinc-800 bg-zinc-900 p-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
            Cutscene Speed
          </h2>
          <p className="mt-1 text-xs text-zinc-600">
            How fast a round's cutscene plays back, as a multiple of the normal pace. Lower is
            slower. Only affects your own view.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="range"
            min={CUTSCENE_SPEED_MIN}
            max={CUTSCENE_SPEED_MAX}
            step={0.1}
            value={speed}
            onChange={(e) => setSpeed(saveCutsceneSpeed(e.target.value))}
            aria-label="Cutscene speed"
            className="min-w-48 flex-1 accent-brand-500"
          />
          <span className="w-16 shrink-0 text-right font-mono text-sm text-zinc-200">
            {speed.toFixed(1)}x
          </span>
          <button
            type="button"
            onClick={() => setSpeed(saveCutsceneSpeed(DEFAULT_CUTSCENE_SPEED))}
            className="panel-cut-sm border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800"
          >
            Reset to default
          </button>
        </div>
      </div>

      <div className="panel-cut-lg space-y-4 border border-zinc-800 bg-zinc-900 p-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">Scene Stage</h2>
          <p className="mt-1 text-xs text-zinc-600">
            How characters render on the Scene tab's stage. Only affects your own view — everyone
            still sees the same Scene and the same summons, just sized to their own taste.
          </p>
        </div>

        <SceneSlider
          label="Character Height"
          value={sceneHeightScale}
          min={SCENE_HEIGHT_SCALE_MIN}
          max={SCENE_HEIGHT_SCALE_MAX}
          step={0.05}
          onChange={(e) => setSceneHeightScale(saveSceneHeightScale(e.target.value))}
          onReset={() => setSceneHeightScale(saveSceneHeightScale(DEFAULT_SCENE_HEIGHT_SCALE))}
        />
        <SceneSlider
          label="Distance Apart"
          value={sceneGapScale}
          min={SCENE_GAP_SCALE_MIN}
          max={SCENE_GAP_SCALE_MAX}
          step={0.1}
          onChange={(e) => setSceneGapScale(saveSceneGapScale(e.target.value))}
          onReset={() => setSceneGapScale(saveSceneGapScale(DEFAULT_SCENE_GAP_SCALE))}
        />
        <SceneSlider
          label="Picture Size"
          value={sceneSizeScale}
          min={SCENE_SIZE_SCALE_MIN}
          max={SCENE_SIZE_SCALE_MAX}
          step={0.05}
          onChange={(e) => setSceneSizeScale(saveSceneSizeScale(e.target.value))}
          onReset={() => setSceneSizeScale(saveSceneSizeScale(DEFAULT_SCENE_SIZE_SCALE))}
        />

        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={sceneShowNameplates}
            onChange={(e) => setSceneShowNameplates(saveSceneShowNameplates(e.target.checked))}
            className="h-4 w-4"
          />
          Show name plates over characters
        </label>
      </div>
    </div>
  );
}

// One slider row, shared by the three Scene Stage scales above — same
// range/value/reset shape as Cutscene Speed's own row, just parameterized
// instead of copy-pasted three times.
function SceneSlider({ label, value, min, max, step, onChange, onReset }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-zinc-400">{label}</div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={onChange}
          aria-label={label}
          className="min-w-48 flex-1 accent-brand-500"
        />
        <span className="w-16 shrink-0 text-right font-mono text-sm text-zinc-200">
          {Math.round(value * 100)}%
        </span>
        <button
          type="button"
          onClick={onReset}
          className="panel-cut-sm border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

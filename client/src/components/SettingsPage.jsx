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
  EFFECTS_QUALITIES,
  hasWebGL2,
  loadEffectsQualityPreference,
  prefersReducedMotion,
  probeEffectsQuality,
  saveEffectsQuality,
} from '../lib/theme.js';
import { useEffectsQuality } from '../lib/useEffectsQuality.js';
import InkHeading from './InkHeading.jsx';

const QUALITY_LABEL = {
  high: 'High',
  medium: 'Medium',
  off: 'Off',
};

const QUALITY_BLURB = {
  high: 'Full ink effects, including the GPU splatter layer over cutscenes and the drifting arena backdrop.',
  medium: 'No GPU effects — the same hits and speed lines, drawn with CSS instead. Kinder to phone batteries.',
  off: 'Ink styling only. Nothing animates beyond the app’s normal transitions.',
};

// Per-device display preferences. The accent color live-previews on every
// change (applyBrandHue) but only persists once a choice is actually made
// (saveHue), so the app-wide --color-brand-* variables (see index.css)
// always reflect what was last saved on the next load, not a mid-edit
// preview. Everything here is localStorage-only and affects nobody else's
// view — these are properties of the person looking, not of the game.
export default function SettingsPage() {
  const [hue, setHue] = useState(() => loadSavedHue() ?? DEFAULT_HUE);
  const [speed, setSpeed] = useState(loadCutsceneSpeed);

  // The tier actually in force (reduced motion can override the stored
  // choice) vs. what the user explicitly picked — shown separately so
  // "Automatic" is distinguishable from a deliberate choice that happens to
  // match the probe, and so a forced-Off is explained rather than looking
  // like a broken control.
  const quality = useEffectsQuality();
  const [qualityPref, setQualityPref] = useState(loadEffectsQualityPreference);
  const reducedMotion = prefersReducedMotion();
  const noWebGL = !hasWebGL2();

  const chooseQuality = (value) => {
    saveEffectsQuality(value);
    setQualityPref(value);
  };

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
      <InkHeading seed={13}>Settings</InkHeading>

      <div className="ink-panel space-y-3 border border-zinc-800 bg-zinc-900 p-4">
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

      <div className="ink-panel space-y-3 border border-zinc-800 bg-zinc-900 p-4">
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

      <div className="ink-panel space-y-3 border border-zinc-800 bg-zinc-900 p-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
            Visual Effects
          </h2>
          <p className="mt-1 text-xs text-zinc-600">
            How much work this device does to draw the fight. Only affects your own view.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => chooseQuality(null)}
            className={`panel-cut-sm border px-3 py-1.5 text-xs font-semibold ${
              qualityPref == null
                ? 'border-brand-500 bg-brand-950/50 text-zinc-100'
                : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            Automatic
          </button>
          {EFFECTS_QUALITIES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => chooseQuality(q)}
              title={QUALITY_BLURB[q]}
              className={`panel-cut-sm border px-3 py-1.5 text-xs font-semibold ${
                qualityPref === q
                  ? 'border-brand-500 bg-brand-950/50 text-zinc-100'
                  : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {QUALITY_LABEL[q]}
            </button>
          ))}
        </div>

        <p className="text-xs text-zinc-500">
          Currently running at <span className="text-zinc-200">{QUALITY_LABEL[quality]}</span>
          {qualityPref == null && ` (detected for this device — ${QUALITY_LABEL[probeEffectsQuality()]})`}.{' '}
          {QUALITY_BLURB[quality]}
        </p>

        {/* Both of these silently cap the tier, so say so rather than
            leaving a High button that visibly does nothing when pressed. */}
        {reducedMotion && (
          <p className="text-xs text-amber-400/90">
            Your system is set to reduce motion, so effects stay off no matter what is selected
            here.
          </p>
        )}
        {!reducedMotion && noWebGL && (
          <p className="text-xs text-amber-400/90">
            This browser has no WebGL — High falls back to Medium.
          </p>
        )}
      </div>
    </div>
  );
}

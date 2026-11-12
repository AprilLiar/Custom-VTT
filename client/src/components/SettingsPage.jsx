import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { socket } from '../socket.js';
import { getTableSettings } from '../lib/api.js';
import { LANE_Y_DEFAULT, LANE_Y_MAX, LANE_Y_MIN, MAX_LANES } from '../lib/simpleLane.js';
import {
  DEFAULT_HUE,
  PRESET_HUES,
  applyBrandHue,
  hexToHue,
  hueToBrandHex,
  loadSavedHue,
  saveHue,
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
  loadFxSpeed,
  saveFxSpeed,
  FX_SPEEDS,
  saveSceneShowNameplates,
  TIMESTAMP_DURATION_MIN,
  TIMESTAMP_DURATION_MAX,
  DEFAULT_TIMESTAMP_DURATION,
  loadTimestampDuration,
  saveTimestampDuration,
  DEFAULT_AUDIO_VOLUME,
  loadAudioVolume,
  saveAudioVolume,
} from '../lib/sceneSettings.js';
import { refreshVolume } from '../lib/audioEngine.js';
import { compendiumArchiveUrl, getCompendiumArchives } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';

// **The old system's archive (the pivot).** When the original combat system was
// removed, its Compendium — Moves, Tells, Tags, Perks, Perk Tags, Quirks, Move
// folders, the Styles their ids point into, and which character had what — was
// written into the database as one JSON document before anything was deleted.
// This is where the GM gets it back out. Pictures are not in it.
//
// Usually exactly one archive. A second appears only if the old tables ever came
// back (a rollback to the previous deploy recreates them), and it never
// replaces the first, so the list shows every one with its date.
// **Simple Combat lanes (GM, the whole table).** Unlike everything else on
// this page this is NOT per-browser: lane positions are shared, so the lane
// count is one server setting everybody's Simple Combat follows.
function SimpleCombatLanes() {
  const [lanes, setLanes] = useState(null);
  const [laneY, setLaneY] = useState(null);
  const sendY = useRef(null);
  useEffect(() => {
    getTableSettings()
      .then((s) => {
        setLanes(s.simpleLanes);
        setLaneY(s.laneY);
      })
      .catch(console.error);
    const onUpdated = (s) => {
      setLanes(s.simpleLanes);
      setLaneY(s.laneY);
    };
    socket.on('table_settings:updated', onUpdated);
    return () => socket.off('table_settings:updated', onUpdated);
  }, []);
  return (
    <div className="panel-cut-lg space-y-3 border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">Simple Combat Lanes</h2>
        <p className="mt-1 text-xs text-zinc-600">
          How many lanes of ten spaces Simple Combat shows — for the whole table, not just you. Fighters in a lane
          you remove step onto the lanes that remain. GM-only.
        </p>
      </div>
      <div className="flex gap-2" role="radiogroup" aria-label="Simple Combat lanes">
        {Array.from({ length: MAX_LANES }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={lanes === n}
            disabled={lanes === null}
            onClick={() => {
              setLanes(n);
              socket.emit('table_settings:set', { simpleLanes: n });
            }}
            className={`min-h-11 flex-1 panel-cut-sm border px-3 text-sm font-semibold ${
              lanes === n ? 'border-brand-500 bg-brand-600 text-white' : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-brand-500'
            }`}
          >
            {n} × 10
          </button>
        ))}
      </div>
      {/* **Lane height (decided, new)** — where the lanes sit on the screen,
          still centred; table-wide. Sent shortly after the slider settles. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <label htmlFor="lane-y" className="font-semibold uppercase tracking-wide">
            Lane height
          </label>
          <span className="tabular-nums">{laneY == null ? '…' : `${Math.round(laneY * 100)}% down the screen`}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="lane-y"
            type="range"
            min={LANE_Y_MIN}
            max={LANE_Y_MAX}
            step={0.01}
            value={laneY ?? LANE_Y_DEFAULT}
            disabled={laneY === null}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLaneY(v);
              clearTimeout(sendY.current);
              sendY.current = setTimeout(() => socket.emit('table_settings:set', { laneY: v }), 150);
            }}
            className="flex-1 accent-brand-500"
          />
          <button
            type="button"
            disabled={laneY === null || Math.abs(laneY - LANE_Y_DEFAULT) < 0.005}
            onClick={() => {
              setLaneY(LANE_Y_DEFAULT);
              socket.emit('table_settings:set', { laneY: null });
            }}
            className="min-h-9 panel-cut-sm border border-zinc-700 px-2 text-xs text-zinc-300 hover:border-brand-500 disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function OldSystemArchive() {
  const [state, setState] = useState(null); // { archives, purge } | { error }
  useEffect(() => {
    getCompendiumArchives({ role: 'gm' })
      .then(setState)
      .catch((err) => setState({ error: err.message }));
  }, []);

  const total = (counts) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
  const label = (table) => table.replace(/_/g, ' ');

  return (
    <div className="panel-cut-lg space-y-3 border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">Old Compendium</h2>
        <p className="mt-1 text-xs text-zinc-600">
          Everything the old system's Compendium held, saved as JSON when it was removed, so it can be
          recovered. Pictures are not included. GM-only.
        </p>
      </div>
      {state == null ? (
        <p className="text-sm text-zinc-600">Loading…</p>
      ) : state.error ? (
        <p className="text-sm text-red-400">Could not load the archive: {state.error}</p>
      ) : !state.archives.length ? (
        <p className="text-sm text-zinc-500">
          {state.purge?.status === 'skipped'
            ? `The old system was NOT removed, because its archive did not verify: ${state.purge.problems.join('; ')}`
            : 'There is no archive on this database.'}
        </p>
      ) : (
        <div className="space-y-2">
          {state.archives.map((a) => (
            <div key={a.id} className="panel-cut-sm border border-zinc-700 bg-zinc-800 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-sm font-semibold text-zinc-100">
                  Saved {new Date(a.archivedAt).toLocaleString()}
                </span>
                <span className="text-xs text-zinc-500">{total(a.counts)} rows</span>
                <a
                  href={compendiumArchiveUrl(a.id, { role: 'gm' })}
                  download
                  className="ml-auto flex min-h-11 items-center gap-1.5 panel-cut-sm border border-brand-600/60 bg-brand-900/40 px-3 text-xs font-semibold text-brand-200 hover:bg-brand-800/50 md:min-h-0 md:py-1.5"
                >
                  <Download size={14} aria-hidden />
                  Download JSON
                </a>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                {Object.entries(a.counts)
                  .filter(([, n]) => n > 0)
                  .map(([table, n]) => `${n} ${label(table)}`)
                  .join(' · ')}
              </p>
            </div>
          ))}
          {state.purge?.problems?.length > 0 && (
            <p className="text-xs text-amber-400">
              Some old columns could not be dropped (their data was cleared): {state.purge.problems.join('; ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Per-device display preferences. The accent color live-previews on every
// change (applyBrandHue) but only persists once a choice is actually made
// (saveHue), so the app-wide --color-brand-* variables (see index.css)
// always reflect what was last saved on the next load, not a mid-edit
// preview. Everything here is localStorage-only and affects nobody else's
// view — these are properties of the person looking, not of the game.
export default function SettingsPage() {
  const { role } = useRole();
  const [hue, setHue] = useState(() => loadSavedHue() ?? DEFAULT_HUE);
  const [sceneHeightScale, setSceneHeightScale] = useState(loadSceneHeightScale);
  const [sceneGapScale, setSceneGapScale] = useState(loadSceneGapScale);
  const [sceneSizeScale, setSceneSizeScale] = useState(loadSceneSizeScale);
  const [sceneShowNameplates, setSceneShowNameplates] = useState(loadSceneShowNameplates);
  const [fxSpeed, setFxSpeed] = useState(loadFxSpeed);
  const [timestampDuration, setTimestampDuration] = useState(loadTimestampDuration);
  const [audioVolume, setAudioVolume] = useState(loadAudioVolume);

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
          <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">Music Volume</h2>
          <p className="mt-1 text-xs text-zinc-600">
            How loud the GM's Audio Player is on this device. Everyone hears the same song at the
            same moment — only the loudness is yours, because that is a property of the room you are
            sitting in rather than of the game. Slide to zero to mute yourself entirely.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={audioVolume}
            onChange={(e) => {
              setAudioVolume(saveAudioVolume(e.target.value));
              // Takes effect on the song already playing, not at the next
              // track: a volume slider that does nothing until something else
              // changes reads as broken.
              refreshVolume();
            }}
            aria-label="Music volume"
            className="min-w-48 flex-1 accent-brand-500"
          />
          <span className="w-16 shrink-0 text-right font-mono text-sm text-zinc-200">
            {audioVolume === 0 ? 'Muted' : `${Math.round(audioVolume * 100)}%`}
          </span>
          <button
            type="button"
            onClick={() => {
              setAudioVolume(saveAudioVolume(DEFAULT_AUDIO_VOLUME));
              refreshVolume();
            }}
            className="panel-cut-sm border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800"
          >
            Reset to default
          </button>
        </div>
      </div>

      <div className="panel-cut-lg space-y-3 border border-zinc-800 bg-zinc-900 p-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
            Timestamp Card Duration
          </h2>
          <p className="mt-1 text-xs text-zinc-600">
            How long the Scene tab's Timestamp tool dims in, holds, and fades back out when played.
            Only affects your own view — everyone sees the same card play, just timed to their own
            taste.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="range"
            min={TIMESTAMP_DURATION_MIN}
            max={TIMESTAMP_DURATION_MAX}
            step={0.5}
            value={timestampDuration}
            onChange={(e) => setTimestampDuration(saveTimestampDuration(e.target.value))}
            aria-label="Timestamp card duration"
            className="min-w-48 flex-1 accent-brand-500"
          />
          <span className="w-16 shrink-0 text-right font-mono text-sm text-zinc-200">
            {timestampDuration.toFixed(1)}s
          </span>
          <button
            type="button"
            onClick={() => setTimestampDuration(saveTimestampDuration(DEFAULT_TIMESTAMP_DURATION))}
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

        {/* Board animations (decided): per device — Normal, Fast (half the time) or Off. */}
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          Fight animations
          <select
            value={fxSpeed}
            onChange={(e) => setFxSpeed(saveFxSpeed(e.target.value))}
            className="border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
          >
            {FX_SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v === 'normal' ? 'Normal' : v === 'fast' ? 'Fast' : 'Off'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {role === 'gm' && <SimpleCombatLanes />}
      {role === 'gm' && <OldSystemArchive />}
    </div>
  );
}

// One slider row, shared by the three Scene Stage scales above — the same
// range/value/reset shape each time, parameterized instead of copy-pasted three
// times.
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

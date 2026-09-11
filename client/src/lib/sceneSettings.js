// Per-viewer Scene stage display preferences (Settings page). Same
// localStorage-only, per-device pattern theme.js already uses for Cutscene
// Speed: how big you like characters on YOUR OWN screen is a property of
// the person looking, not of the game everyone shares. What's actually
// shared and server-synced (who's summoned, which Scene is active) is
// untouched — these settings only change how StageRoster renders that
// same shared state locally.

function loadScale(key, min, max, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  } catch {
    return fallback;
  }
}

function saveScale(key, value, min, max, fallback) {
  const clamped = Math.min(max, Math.max(min, Number(value) || fallback));
  try {
    // Default is "nothing stored" — same convention saveCutsceneSpeed uses —
    // so a fresh browser and a browser that was reset to default look
    // identical in storage.
    if (clamped === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, String(clamped));
  } catch {
    // Storage unavailable; the value still works for this session.
  }
  return clamped;
}

// --- Character height, a multiplier on StageRoster's own base 70dvh ---
const HEIGHT_KEY = 'vtt-scene-height-scale';
export const SCENE_HEIGHT_SCALE_MIN = 0.5;
export const SCENE_HEIGHT_SCALE_MAX = 1.5;
export const DEFAULT_SCENE_HEIGHT_SCALE = 1;
export const loadSceneHeightScale = () =>
  loadScale(HEIGHT_KEY, SCENE_HEIGHT_SCALE_MIN, SCENE_HEIGHT_SCALE_MAX, DEFAULT_SCENE_HEIGHT_SCALE);
export const saveSceneHeightScale = (v) =>
  saveScale(HEIGHT_KEY, v, SCENE_HEIGHT_SCALE_MIN, SCENE_HEIGHT_SCALE_MAX, DEFAULT_SCENE_HEIGHT_SCALE);

// --- Distance apart, a multiplier on layoutStage's own SLOT_GAP ---
const GAP_KEY = 'vtt-scene-gap-scale';
export const SCENE_GAP_SCALE_MIN = 0;
export const SCENE_GAP_SCALE_MAX = 3;
export const DEFAULT_SCENE_GAP_SCALE = 1;
export const loadSceneGapScale = () =>
  loadScale(GAP_KEY, SCENE_GAP_SCALE_MIN, SCENE_GAP_SCALE_MAX, DEFAULT_SCENE_GAP_SCALE);
export const saveSceneGapScale = (v) =>
  saveScale(GAP_KEY, v, SCENE_GAP_SCALE_MIN, SCENE_GAP_SCALE_MAX, DEFAULT_SCENE_GAP_SCALE);

// --- Picture size, a multiplier on layoutStage's own SLOT_WIDTH (its
// nominal per-character spacing/crowding unit, not a crop) ---
const SIZE_KEY = 'vtt-scene-size-scale';
export const SCENE_SIZE_SCALE_MIN = 0.5;
export const SCENE_SIZE_SCALE_MAX = 2;
export const DEFAULT_SCENE_SIZE_SCALE = 1;
export const loadSceneSizeScale = () =>
  loadScale(SIZE_KEY, SCENE_SIZE_SCALE_MIN, SCENE_SIZE_SCALE_MAX, DEFAULT_SCENE_SIZE_SCALE);
export const saveSceneSizeScale = (v) =>
  saveScale(SIZE_KEY, v, SCENE_SIZE_SCALE_MIN, SCENE_SIZE_SCALE_MAX, DEFAULT_SCENE_SIZE_SCALE);

// --- Draw tool: last-used pen color/width and eraser width, per device
// (decided, new) — "remember the last color and width settings for each
// user" reads, in this app's own no-login model, as "remember it on MY OWN
// device," the same as every other Scene preference on this page. Not
// server-synced and deliberately not attached to any drawn stroke either —
// scene_drawings itself carries no author, so there is nowhere for a
// per-user setting to live except locally. ---
const DRAW_COLOR_KEY = 'vtt-scene-draw-color';
export const DEFAULT_SCENE_DRAW_COLOR = '#ef4444';
export function loadSceneDrawColor() {
  try {
    return localStorage.getItem(DRAW_COLOR_KEY) || DEFAULT_SCENE_DRAW_COLOR;
  } catch {
    return DEFAULT_SCENE_DRAW_COLOR;
  }
}
export function saveSceneDrawColor(color) {
  try {
    localStorage.setItem(DRAW_COLOR_KEY, color);
  } catch {
    // Storage unavailable; the choice still works for this session.
  }
  return color;
}

const PEN_WIDTH_KEY = 'vtt-scene-draw-pen-width';
export const SCENE_PEN_WIDTH_MIN = 1;
export const SCENE_PEN_WIDTH_MAX = 20;
export const DEFAULT_SCENE_PEN_WIDTH = 4;
export const loadScenePenWidth = () =>
  loadScale(PEN_WIDTH_KEY, SCENE_PEN_WIDTH_MIN, SCENE_PEN_WIDTH_MAX, DEFAULT_SCENE_PEN_WIDTH);
export const saveScenePenWidth = (v) =>
  saveScale(PEN_WIDTH_KEY, v, SCENE_PEN_WIDTH_MIN, SCENE_PEN_WIDTH_MAX, DEFAULT_SCENE_PEN_WIDTH);

const ERASER_WIDTH_KEY = 'vtt-scene-draw-eraser-width';
export const SCENE_ERASER_WIDTH_MIN = 8;
export const SCENE_ERASER_WIDTH_MAX = 80;
export const DEFAULT_SCENE_ERASER_WIDTH = 24;
export const loadSceneEraserWidth = () =>
  loadScale(ERASER_WIDTH_KEY, SCENE_ERASER_WIDTH_MIN, SCENE_ERASER_WIDTH_MAX, DEFAULT_SCENE_ERASER_WIDTH);
export const saveSceneEraserWidth = (v) =>
  saveScale(ERASER_WIDTH_KEY, v, SCENE_ERASER_WIDTH_MIN, SCENE_ERASER_WIDTH_MAX, DEFAULT_SCENE_ERASER_WIDTH);

// --- Timestamp card duration, in seconds — the whole dim-in/hold/dim-out
// loop the Timestamp tool's "play" button triggers (TimestampCutscene.jsx).
// Per-device, same as Cutscene Speed: how long you like to sit on a title
// card is a property of the person watching, not of the game everyone
// shares — every viewer's socket receives the same play event, but each
// renders it on their own configured timer. An absolute duration, not a
// speed multiplier like Cutscene Speed, because there's no existing pace to
// scale here — "roughly 3 seconds" is the whole spec. ---
const TIMESTAMP_DURATION_KEY = 'vtt-scene-timestamp-duration';
export const TIMESTAMP_DURATION_MIN = 1;
export const TIMESTAMP_DURATION_MAX = 10;
export const DEFAULT_TIMESTAMP_DURATION = 3;
export const loadTimestampDuration = () =>
  loadScale(TIMESTAMP_DURATION_KEY, TIMESTAMP_DURATION_MIN, TIMESTAMP_DURATION_MAX, DEFAULT_TIMESTAMP_DURATION);
export const saveTimestampDuration = (v) =>
  saveScale(TIMESTAMP_DURATION_KEY, v, TIMESTAMP_DURATION_MIN, TIMESTAMP_DURATION_MAX, DEFAULT_TIMESTAMP_DURATION);

// --- Name plates over each character's own head — on by default ---
const NAMEPLATES_KEY = 'vtt-scene-nameplates-hidden';
export function loadSceneShowNameplates() {
  try {
    return localStorage.getItem(NAMEPLATES_KEY) !== '1';
  } catch {
    return true;
  }
}
export function saveSceneShowNameplates(shown) {
  const next = Boolean(shown);
  try {
    if (next) localStorage.removeItem(NAMEPLATES_KEY);
    else localStorage.setItem(NAMEPLATES_KEY, '1');
  } catch {
    // Storage unavailable; the toggle still works for this session.
  }
  return next;
}

// --- Audio Player volume, per device ---
//
// **Per-device on purpose, and the one part of the Audio Player that is not
// synced.** Everyone hears the same song at the same instant — that is the
// whole feature — but how loud it should be is a property of the room the
// listener is sitting in, not of the game. Same reasoning as Cutscene Speed
// and Timestamp Duration above, and the same storage.
//
// **Not built on saveScale, unlike every other setting in this file, and the
// reason is worth stating: `saveScale` coerces with `Number(value) || fallback`,
// which turns a volume of exactly 0 back into the default.** Every other
// setting here has a meaningless zero, so that has never mattered; for a
// volume slider, zero is mute — the single most likely thing a player at a
// noisy table reaches for. So this pair keeps the storage convention (absent
// means default) and drops the falsy coercion.
const AUDIO_VOLUME_KEY = 'vtt-audio-volume';
export const DEFAULT_AUDIO_VOLUME = 0.5;

export function loadAudioVolume() {
  try {
    const raw = localStorage.getItem(AUDIO_VOLUME_KEY);
    if (raw == null) return DEFAULT_AUDIO_VOLUME;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_AUDIO_VOLUME;
  } catch {
    return DEFAULT_AUDIO_VOLUME;
  }
}

export function saveAudioVolume(value) {
  const n = Number(value);
  const clamped = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_AUDIO_VOLUME;
  try {
    if (clamped === DEFAULT_AUDIO_VOLUME) localStorage.removeItem(AUDIO_VOLUME_KEY);
    else localStorage.setItem(AUDIO_VOLUME_KEY, String(clamped));
  } catch {
    // Storage unavailable; the value still works for this session.
  }
  return clamped;
}

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

// User-configurable primary/accent color (Settings page). The app's whole
// red palette is a `--color-brand-{50..950}` scale plus a `--color-brand-rgb`
// raw triplet (see index.css) — this module regenerates that scale from a
// single hue at a fixed saturation/lightness curve (matching the shape of
// the built-in crimson default) and writes it onto :root as inline style
// overrides, which win over the CSS file's own declarations. Persisted to
// localStorage so it survives a reload; more settings can follow the same
// pattern later.

const STOPS = [
  [50, 85, 96],
  [100, 82, 91],
  [200, 80, 83],
  [300, 76, 72],
  [400, 72, 60],
  [500, 74, 50],
  [600, 72, 40],
  [700, 70, 32],
  [800, 65, 24],
  [900, 55, 16],
  [950, 50, 9],
];

const STORAGE_KEY = 'vtt-brand-hue';
export const DEFAULT_HUE = 355; // matches the built-in crimson in index.css

export const PRESET_HUES = [
  { name: 'Crimson', hue: 355 },
  { name: 'Azure', hue: 210 },
  { name: 'Violet', hue: 265 },
  { name: 'Emerald', hue: 150 },
  { name: 'Amber', hue: 38 },
];

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Ignores the picked color's own saturation/lightness — only its hue feeds
// the curve above, so every generated scale stays visually consistent
// (same contrast steps) regardless of what a user's native color picker
// happened to hand back.
export function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function hueToBrandHex(hue) {
  const mid = STOPS.find(([shade]) => shade === 500);
  return rgbToHex(hslToRgb(hue, mid[1], mid[2]));
}

export function applyBrandHue(hue) {
  const root = document.documentElement.style;
  for (const [shade, s, l] of STOPS) {
    const rgb = hslToRgb(hue, s, l);
    root.setProperty(`--color-brand-${shade}`, rgbToHex(rgb));
    if (shade === 500) root.setProperty('--color-brand-rgb', rgb.join(' '));
  }
}

function resetBrandHue() {
  const root = document.documentElement.style;
  for (const [shade] of STOPS) root.removeProperty(`--color-brand-${shade}`);
  root.removeProperty('--color-brand-rgb');
}

export function loadSavedHue() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const hue = raw != null ? Number(raw) : null;
  return Number.isFinite(hue) ? hue : null;
}

export function saveHue(hue) {
  if (hue == null) {
    localStorage.removeItem(STORAGE_KEY);
    resetBrandHue();
    return;
  }
  localStorage.setItem(STORAGE_KEY, String(hue));
  applyBrandHue(hue);
}

// Called once at app startup so a saved preference survives a reload.
export function initTheme() {
  const saved = loadSavedHue();
  if (saved != null) applyBrandHue(saved);
}

// --- Cutscene playback speed (Settings) ---
//
// A multiplier on RoundCutscene's own per-event dwell, not an absolute
// duration: what "too fast" means depends on how much is happening in a
// round, so scaling the existing pace is the knob that stays meaningful if
// that pace is ever retuned. 1 is the current speed; 0.1 is a tenth of it
// (much slower per event) and 3 is three times it.
//
// Client-side and per-device on purpose — how fast you like to read a log is
// a preference of the person watching, not a property of the fight, so it
// deliberately does NOT go through the server or affect anyone else's view.
const SPEED_KEY = 'vtt-cutscene-speed';
export const CUTSCENE_SPEED_MIN = 0.1;
export const CUTSCENE_SPEED_MAX = 3;
export const DEFAULT_CUTSCENE_SPEED = 1;

export function clampCutsceneSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CUTSCENE_SPEED;
  return Math.min(CUTSCENE_SPEED_MAX, Math.max(CUTSCENE_SPEED_MIN, n));
}

export function loadCutsceneSpeed() {
  const raw = localStorage.getItem(SPEED_KEY);
  return raw == null ? DEFAULT_CUTSCENE_SPEED : clampCutsceneSpeed(raw);
}

export function saveCutsceneSpeed(value) {
  const speed = clampCutsceneSpeed(value);
  if (speed === DEFAULT_CUTSCENE_SPEED) localStorage.removeItem(SPEED_KEY);
  else localStorage.setItem(SPEED_KEY, String(speed));
  return speed;
}

// --- Effects quality (Settings) ---
//
// Visual Overhaul (Ink & Impact): the app now has a GPU tier — a WebGL ink
// splatter layer over the cutscene and a drifting ink backdrop behind the
// shell (Phases V3/V4). Those are genuinely expensive on a phone that is
// going to sit in a fight for an hour, so they are gated behind a tier
// rather than shipped unconditionally.
//
//   'high'   — WebGL effects on. Everything below, plus shaders.
//   'medium' — no GL context is ever constructed; the CSS/SVG fallbacks
//              (.speed-lines, ImpactBurst, the static .bg-arena gradients)
//              carry the same information with none of the GPU cost.
//   'off'    — ink materials and layout only; no effect animation at all.
//
// Per-device and localStorage-only, exactly like the hue and playback-speed
// preferences above: how hard your device should work is a property of your
// device, not of the game, so it deliberately never reaches the server.
const QUALITY_KEY = 'vtt-effects-quality';
export const EFFECTS_QUALITIES = ['high', 'medium', 'off'];

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Whether this device can construct a WebGL2 context at all. Probed against
// a throwaway canvas and cached — some browsers are slow to create the
// context, and the answer cannot change within a page load.
let webgl2Support = null;
export function hasWebGL2() {
  if (webgl2Support !== null) return webgl2Support;
  try {
    const canvas = document.createElement('canvas');
    webgl2Support = !!canvas.getContext('webgl2');
  } catch {
    webgl2Support = false;
  }
  return webgl2Support;
}

// The default when the user has never chosen. Errs toward 'medium': the
// fallback tier still looks like the same app, so guessing low costs a
// little polish, while guessing high on a weak phone costs a dropped-frame
// cutscene in the middle of someone's fight.
export function probeEffectsQuality() {
  if (prefersReducedMotion()) return 'off';
  if (!hasWebGL2()) return 'medium';
  const coarse =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(pointer: coarse)').matches;
  if (coarse) return 'medium';
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = navigator.deviceMemory ?? 4; // Chromium-only; absent elsewhere
  if (cores < 4 || memory < 4) return 'medium';
  return 'high';
}

// The stored preference, or null if the user has never picked one. Kept
// separate from the effective value below so Settings can show "Automatic"
// distinctly from a deliberate choice that happens to match the probe.
export function loadEffectsQualityPreference() {
  const raw = localStorage.getItem(QUALITY_KEY);
  return EFFECTS_QUALITIES.includes(raw) ? raw : null;
}

// What components should actually act on. Reduced motion wins over
// everything, including an explicit 'high' — a stated accessibility
// preference is not a thing a display setting gets to override.
export function loadEffectsQuality() {
  if (prefersReducedMotion()) return 'off';
  const chosen = loadEffectsQualityPreference() ?? probeEffectsQuality();
  // A device with no WebGL2 cannot honour 'high' even when it is asked for
  // explicitly, so cap it here rather than letting every consumer discover
  // that separately by failing to create a context.
  if (chosen === 'high' && !hasWebGL2()) return 'medium';
  return chosen;
}

export function saveEffectsQuality(value) {
  if (value == null) localStorage.removeItem(QUALITY_KEY);
  else if (EFFECTS_QUALITIES.includes(value)) localStorage.setItem(QUALITY_KEY, value);
  window.dispatchEvent(new Event('vtt:effects-quality'));
  return loadEffectsQuality();
}

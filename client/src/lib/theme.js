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

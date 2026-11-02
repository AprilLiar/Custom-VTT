import { useEffect, useState } from 'react';

// The most prominent colour of a picture — Simple Combat's lane glows in it,
// so the overlay belongs to whatever Scene it sits on.
//
// "Prominent" rather than "average": an average of a red sky and a blue sea is
// mud. Pixels are bucketed by hue (24 buckets) and each bucket is weighted by
// how saturated and how bright its pixels are, so a large vivid area wins over
// a larger grey one. The winning bucket's average colour is brightened a
// little so the glow still reads on a dark backdrop. Greyscale pictures fall
// back to a soft white.
//
// Backdrops are served from this app's own origin (/api/img/…), so the canvas
// is never tainted and getImageData is allowed.
export const FALLBACK_GLOW = 'rgb(226, 232, 240)';

export function dominantColorOf(img) {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    if (data[i + 3] < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < 0.12 || max < 0.15) continue;
    let hue;
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue = (hue * 60 + 360) % 360;
    const weight = chroma * (0.4 + max);
    const bucket = buckets[Math.floor(hue / 15) % 24];
    bucket.w += weight;
    bucket.r += data[i] * weight;
    bucket.g += data[i + 1] * weight;
    bucket.b += data[i + 2] * weight;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w < 1) return FALLBACK_GLOW;
  let r = best.r / best.w;
  let g = best.g / best.w;
  let b = best.b / best.w;
  // Lift it towards full brightness, keeping the hue.
  const lift = 255 / Math.max(r, g, b, 1);
  const k = Math.min(lift, 1.6);
  r = Math.min(255, r * k);
  g = Math.min(255, g * k);
  b = Math.min(255, b * k);
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export function useDominantColor(src) {
  const [color, setColor] = useState(FALLBACK_GLOW);
  useEffect(() => {
    if (!src) {
      setColor(FALLBACK_GLOW);
      return undefined;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        setColor(dominantColorOf(img));
      } catch {
        setColor(FALLBACK_GLOW);
      }
    };
    img.onerror = () => !cancelled && setColor(FALLBACK_GLOW);
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return color;
}

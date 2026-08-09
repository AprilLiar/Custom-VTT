import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEffectsQuality } from '../lib/useEffectsQuality.js';

// Visual Overhaul (Ink & Impact), Phase V4 — sumi ink drifting in water,
// behind the whole app.
//
// Ambient, not informational: it says nothing about the fight, it just stops
// the background being a flat slab. That is exactly why it is the most
// aggressively budgeted thing in this pass — see the throttle and the
// visibility pause below. `high` tier only; at `medium`/`off` this component
// returns null and no GL context is ever constructed, and `.bg-arena`'s
// static radial gradients carry on as they always have.
//
// Rendered through a PORTAL to <body>, not inline in the app shell. A
// `z-index: -1` child paints behind its stacking-context parent's own
// background, and the shell's background is `.bg-arena`'s opaque near-black —
// so a canvas mounted inside the shell would be perfectly invisible no
// matter what it drew. At body level it sits above body's background and
// below every bit of app chrome, which is the layer this wants.

const VERT = /* glsl */ `
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

// Domain-warped fbm. Three octaves and a single warp iteration is the
// cheapest thing that still reads as ink bleeding through water rather than
// as generic noise; this runs fullscreen, so every octave is real cost.
const FRAG = /* glsl */ `
  precision mediump float;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uColor;
  varying vec2 vUv;

  vec2 hash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
          dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
          dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    // Correct for aspect so the ink does not stretch on a wide window.
    vec2 p = vec2(uv.x * (uResolution.x / max(uResolution.y, 1.0)), uv.y) * 2.2;
    float t = uTime * 0.035;

    vec2 warp = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, -t * 0.8)));
    float d = fbm(p + warp * 1.8 + vec2(t * 0.4, 0.0));

    // Density is biased toward the top and bottom edges: the middle of the
    // screen is where the app's own content sits, and an ambient backdrop
    // must never compete with text for attention.
    float edge = smoothstep(0.38, 0.0, uv.y) + smoothstep(0.62, 1.0, uv.y);
    float ink = smoothstep(0.0, 0.40, d) * (0.22 + edge * 0.9);

    gl_FragColor = vec4(uColor * ink, ink * 0.72);
  }
`;

function brandRgb() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-brand-rgb')
    .trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts.map((v) => v / 255);
  return [0.94, 0.25, 0.3];
}

// Ambient motion does not need 60fps, and a permanently-running fullscreen
// shader is precisely the battery cost the quality tier exists to avoid.
const TARGET_FPS = 20;
const FRAME_MS = 1000 / TARGET_FPS;
// How often the brand colour is re-read. getComputedStyle forces a style
// recalc, so it is deliberately not done per frame; the hue picker is not
// something anyone drags at 20Hz.
const COLOR_RESYNC_FRAMES = 30;

export default function InkBackdrop() {
  const quality = useEffectsQuality();
  const active = quality === 'high';
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let cancelled = false;
    let cleanup = () => {};

    (async () => {
      const { Renderer, Geometry, Program, Mesh } = await import('ogl');
      if (cancelled) return;

      // Half-resolution buffer: this is soft, low-frequency noise with no
      // detail to lose, and it halves the fragment count on a fullscreen
      // pass. Nobody can tell, and a phone very much can.
      const dpr = Math.min(1, window.devicePixelRatio || 1) * 0.5;
      const renderer = new Renderer({ canvas, alpha: true, dpr, antialias: false });
      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 0);

      const program = new Program(gl, {
        vertex: VERT,
        fragment: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uResolution: { value: [1, 1] },
          uColor: { value: brandRgb() },
        },
        transparent: true,
        depthTest: false,
      });
      const mesh = new Mesh(gl, {
        geometry: new Geometry(gl, {
          position: { size: 2, data: new Float32Array([-1, -1, 3, -1, -1, 3]) },
        }),
        program,
      });

      const resize = () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        renderer.setSize(w, h);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        program.uniforms.uResolution.value = [w, h];
      };
      resize();
      window.addEventListener('resize', resize);

      let raf = 0;
      let last = 0;
      let frames = 0;
      const start = performance.now();

      const loop = (now) => {
        raf = requestAnimationFrame(loop);
        if (now - last < FRAME_MS) return;
        last = now;
        if (++frames % COLOR_RESYNC_FRAMES === 0) {
          program.uniforms.uColor.value = brandRgb();
        }
        program.uniforms.uTime.value = (now - start) / 1000;
        renderer.render({ scene: mesh });
      };

      // A hidden tab must not be animating. Without this the loop keeps its
      // rAF registration in some browsers' background throttling modes and
      // in others simply resumes with a huge time jump.
      const onVisibility = () => {
        if (document.hidden) {
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
        } else if (!raf) {
          last = 0;
          raf = requestAnimationFrame(loop);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      if (!document.hidden) raf = requestAnimationFrame(loop);

      // Lets .bg-arena drop its opaque base colour so this shows through,
      // and its grain layer with it — see the rule in index.css for why the
      // grain cannot stay (soft-light needs an opaque base to blend against).
      // The red glows stay and composite over the ink.
      document.documentElement.setAttribute('data-ink-backdrop', '');

      cleanup = () => {
        document.documentElement.removeAttribute('data-ink-backdrop');
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('resize', resize);
        if (raf) cancelAnimationFrame(raf);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      };
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [active]);

  if (!active) return null;

  return createPortal(
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />,
    document.body
  );
}

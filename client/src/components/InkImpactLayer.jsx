import { useEffect, useRef } from 'react';
import { INK_SPLAT_URI } from '../lib/inkAssets.js';

// Visual Overhaul (Ink & Impact), Phase V3 — the GPU half of a hit.
//
// This adds NO new plumbing. beatEffects() in RoundCutscene.jsx already
// reduces the round-event stream into a normalised burst descriptor
// (`{ kind, label, sub, seq }`), and this is simply a second renderer
// subscribing to the same value that ImpactBurst does. The DOM burst keeps
// the *information* — the damage number, the slot name, MISS — and this
// layer adds the force behind it. Neither is a fallback for the other's
// content; only the shockwave ring is deduplicated (ImpactBurst drops it
// when this layer is live, since ink splatter replaces it).
//
// `ogl` is dynamically imported so it lands in its own chunk: a viewer who
// never opens a fight never downloads it, and the service worker's
// precache is untouched.

const GRAVITY = 1.1;

// Per-kind emission. A 2+ half-damage-step hit has always been a visibly
// different event from a 1-step one in this cutscene (see ImpactBurst), so
// the splatter preserves that rather than flattening both into "a hit".
const EMISSION = {
  hit: { count: 26, speed: 0.55, size: 0.11, lines: false },
  heavy: { count: 60, speed: 0.95, size: 0.17, lines: true },
};

const VERT = /* glsl */ `
  attribute vec2 position;
  attribute vec2 uv;
  attribute vec2 iOffset;
  attribute vec2 iVel;
  attribute float iSize;
  attribute float iSpin;
  uniform float uTime;
  uniform float uAspect;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float t = uTime;
    // Ballistic, with drag — ink thrown from an impact decelerates fast and
    // then falls, rather than travelling in a straight line forever.
    float drag = 1.0 - exp(-2.4 * t);
    vec2 pos = iOffset + iVel * drag * 0.42 + vec2(0.0, -GRAVITY_PLACEHOLDER * t * t * 0.5);
    float grow = 1.0 + t * 0.6;
    float c = cos(iSpin * t);
    float s = sin(iSpin * t);
    vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
    corner *= iSize * grow;
    corner.x /= uAspect;
    gl_Position = vec4(pos + corner, 0.0, 1.0);
    vUv = uv;
    vFade = clamp(1.0 - t * 1.35, 0.0, 1.0);
  }
`.replace('GRAVITY_PLACEHOLDER', GRAVITY.toFixed(2));

const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tSplat;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float a = texture2D(tSplat, vUv).a * vFade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

// Radial speed lines, in polar coordinates, hollow in the middle so the
// damage number stays readable through them. Same shape the CSS
// `.speed-lines` fallback draws — one motif, two tiers.
const LINES_VERT = /* glsl */ `
  attribute vec2 position;
  varying vec2 vPos;
  void main() {
    vPos = position;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const LINES_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uAspect;
  varying vec2 vPos;
  void main() {
    vec2 p = vec2(vPos.x * uAspect, vPos.y);
    float r = length(p);
    float a = atan(p.y, p.x);
    // Irregular spacing: evenly spaced rays read as a test pattern.
    float rays = sin(a * 46.0) * 0.5 + 0.5;
    rays += sin(a * 17.0 + 1.7) * 0.35;
    float line = smoothstep(0.72, 1.0, rays);
    // Hollow centre, faded outer edge, and the whole thing rushes outward.
    float hole = smoothstep(0.18 + uTime * 0.55, 0.62 + uTime * 0.7, r);
    float envelope = clamp(1.0 - uTime * 2.6, 0.0, 1.0);
    float a2 = line * hole * envelope * 0.75;
    if (a2 < 0.01) discard;
    gl_FragColor = vec4(uColor, a2);
  }
`;

function brandRgb() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-brand-rgb')
    .trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return parts.map((v) => v / 255);
  }
  return [0.94, 0.25, 0.3];
}

export default function InkImpactLayer({ burst }) {
  const canvasRef = useRef(null);
  const stateRef = useRef(null);
  const burstRef = useRef(null);
  burstRef.current = burst;

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let cleanup = () => {};

    (async () => {
      const { Renderer, Geometry, Program, Mesh, Texture } = await import('ogl');
      if (cancelled) return;

      const renderer = new Renderer({
        canvas,
        alpha: true,
        antialias: true,
        dpr: Math.min(2, window.devicePixelRatio || 1),
      });
      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 0);
      // Two passes composite into one frame (speed lines under splatter), so
      // the clear is done once per frame by hand rather than per render call.
      renderer.autoClear = false;

      const splat = new Texture(gl, { generateMipmaps: false });
      const img = new Image();
      img.onload = () => {
        splat.image = img;
        // ogl uploads on the next draw once `image` is set; being explicit
        // costs nothing and removes any doubt about a first burst firing
        // before the texture landed.
        splat.needsUpdate = true;
      };
      img.src = INK_SPLAT_URI;

      const quad = {
        position: { size: 2, data: new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]) },
        uv: { size: 2, data: new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]) },
      };

      const linesProgram = new Program(gl, {
        vertex: LINES_VERT,
        fragment: LINES_FRAG,
        uniforms: { uTime: { value: 0 }, uColor: { value: brandRgb() }, uAspect: { value: 1 } },
        transparent: true,
        depthTest: false,
      });
      const linesMesh = new Mesh(gl, {
        geometry: new Geometry(gl, { position: quad.position }),
        program: linesProgram,
      });

      const state = {
        renderer,
        gl,
        Geometry,
        Program,
        Mesh,
        splat,
        linesMesh,
        linesProgram,
        particles: null,
        startedAt: 0,
        lines: false,
        raf: 0,
        aspect: 1,
      };
      stateRef.current = state;

      // Size the canvas from its PARENT's box plus the bleed, in JS.
      //
      // Three things forced this rather than doing it in CSS:
      //  * ogl's setSize writes inline style.width/height in px, which fights
      //    the layout classes — so its output is corrected right after.
      //  * A canvas is a REPLACED element, so an `-top-40 -bottom-40` pair
      //    does not stretch it the way it would a div; with height:auto it
      //    falls back to its intrinsic 300x150.
      //  * `h-[calc(100%+20rem)]` cannot resolve either, because the parent
      //    is content-height (height:auto), so the percentage has nothing
      //    definite to resolve against and collapses to auto again.
      // Measuring the parent and writing a px height sidesteps all three.
      //
      // The cutscene mounts inside a dialog that animates in, so a first
      // measurement of 0 is legitimate — and a canvas left at 0 never
      // resizes again for the observer to notice. Retry next frame instead.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const BLEED = 160; // px above and below, matching the -top-40 class
      const box = canvas.parentElement ?? canvas;
      const resize = () => {
        const rect = box.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 1) {
          requestAnimationFrame(resize);
          return;
        }
        const h = rect.height + BLEED * 2;
        // setSize has to be the thing that runs: renderer.render() sets the
        // GL viewport from the renderer's OWN stored width/height on every
        // frame, so bypassing it leaves the viewport at ogl's 300x150 default
        // and the whole layer draws into a corner of the canvas — which is
        // exactly what "canvas sized correctly but nothing visible" looked
        // like. Its inline style writes are then corrected below.
        renderer.setSize(rect.width, h);
        canvas.style.width = '100%';
        canvas.style.height = `${h}px`;
        state.aspect = rect.width / h;
      };
      resize();
      // Observing the PARENT, not the canvas: the canvas is absolutely
      // positioned so resizing it cannot feed back into the parent's box,
      // which keeps this from becoming a resize loop.
      const ro = new ResizeObserver(resize);
      ro.observe(box);

      const render = () => {
        const t = (performance.now() - state.startedAt) / 1000;
        // The loop is gated on "a burst is still animating" — this is never
        // a permanent render loop, so an idle cutscene costs no GPU at all.
        const alive = t < 1.4;
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (state.lines) {
          state.linesProgram.uniforms.uTime.value = t;
          state.linesProgram.uniforms.uAspect.value = state.aspect;
          renderer.render({ scene: state.linesMesh });
        }
        if (state.particles) {
          state.particles.program.uniforms.uTime.value = t;
          state.particles.program.uniforms.uAspect.value = state.aspect;
          renderer.render({ scene: state.particles.mesh });
        }
        if (alive) {
          state.raf = requestAnimationFrame(render);
        } else {
          state.raf = 0;
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      };
      state.render = render;

      cleanup = () => {
        ro.disconnect();
        if (state.raf) cancelAnimationFrame(state.raf);
        // Release the context rather than waiting for GC — a cutscene can be
        // opened and closed many times in a session.
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        stateRef.current = null;
      };

      // A burst may have arrived while ogl was still loading.
      if (burstRef.current) spawn(burstRef.current);
    })();

    function spawn(b) {
      const state = stateRef.current;
      if (!state) return;
      const cfg = EMISSION[b.kind];
      if (!cfg) return; // miss/fizzle carry no force — the DOM burst says it
      const { Geometry, Program, Mesh, gl } = state;
      const n = cfg.count;
      const offsets = new Float32Array(n * 2);
      const vels = new Float32Array(n * 2);
      const sizes = new Float32Array(n);
      const spins = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const angle = Math.random() * Math.PI * 2;
        // sqrt keeps the emission disc uniform instead of clumping centrally.
        const speed = cfg.speed * (0.35 + Math.sqrt(Math.random()) * 0.9);
        offsets[i * 2] = (Math.random() - 0.5) * 0.06;
        offsets[i * 2 + 1] = (Math.random() - 0.5) * 0.06;
        vels[i * 2] = Math.cos(angle) * speed;
        vels[i * 2 + 1] = Math.sin(angle) * speed;
        sizes[i] = cfg.size * (0.35 + Math.random() * 0.9);
        spins[i] = (Math.random() - 0.5) * 5;
      }
      const geometry = new Geometry(gl, {
        position: { size: 2, data: new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]) },
        uv: { size: 2, data: new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]) },
        iOffset: { instanced: 1, size: 2, data: offsets },
        iVel: { instanced: 1, size: 2, data: vels },
        iSize: { instanced: 1, size: 1, data: sizes },
        iSpin: { instanced: 1, size: 1, data: spins },
      });
      const program = new Program(gl, {
        vertex: VERT,
        fragment: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uAspect: { value: state.aspect },
          uColor: { value: brandRgb() },
          tSplat: { value: state.splat },
        },
        transparent: true,
        depthTest: false,
        cullFace: null,
      });
      state.particles?.geometry.remove?.();
      state.particles = { geometry, program, mesh: new Mesh(gl, { geometry, program }) };
      state.lines = cfg.lines;
      state.startedAt = performance.now();
      if (!state.raf) state.raf = requestAnimationFrame(state.render);
    }

    stateRef.current = stateRef.current ?? null;
    canvas.__spawn = spawn;

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  // Fire on a genuinely new burst. Keyed on seq, which is unique per
  // round_event, so two hits on the same Tic both play.
  const lastSeq = useRef(-1);
  useEffect(() => {
    if (!burst || burst.seq === lastSeq.current) return;
    lastSeq.current = burst.seq;
    canvasRef.current?.__spawn?.(burst);
  }, [burst]);

  return (
    /* Vertical bleed well past the Tic strip. ImpactBurst is a DOM element
       and simply overflows its parent, but a canvas clips to its own box —
       at the strip's own ~56px height the splatter had nowhere to go and
       read as a smear. The parent sets no overflow, so growing past it is
       free.
       Its height is set in JS (see resize above) because neither an
       inset pair nor a percentage height can size a replaced element here. */
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute -top-40 left-0 z-30 w-full"
    />
  );
}

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useRole } from '../roleContext.jsx';
import { useAudioStatus } from '../lib/useAudioStatus.js';
import { unlockAudioFromGesture, silentReason } from '../lib/audioEngine.js';

// What is playing, wherever you are in the app.
//
// Two hosts, one component: CombatHeaderBar renders it inside the global strip
// on every page but the Scene, and ScenePage puts it top-right over the stage.
// `variant` is the only difference between them, because the Scene's version
// sits over artwork and has to carry its own legibility.

// **A drawn record, not a GIF.** There is no GIF, Lottie or animated asset
// anywhere in this repo, and index.css zeroes every CSS animation under
// prefers-reduced-motion — a GIF would ignore that, ship a fixed resolution
// into a high-DPI phone, and not follow the theme. An inline SVG spun by
// Framer Motion (already this app's animation tool) is crisp at any size,
// costs no request, and stops spinning for anyone who asked motion to stop.
function Record({ className = '', spinning = true }) {
  const reduced = useReducedMotion();
  return (
    <motion.svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      animate={spinning && !reduced ? { rotate: 360 } : { rotate: 0 }}
      transition={
        spinning && !reduced
          ? { repeat: Infinity, ease: 'linear', duration: 3 }
          : { duration: 0.2 }
      }
    >
      <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.18" />
      <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="1.4" />
      {/* Two grooves and a label — the whole vocabulary of "record" at 16px. */}
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.55" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" opacity="0.85" />
      {/* The spindle hole, off-centre-looking only while still — it is what
          makes the rotation readable at all at this size. */}
      <circle cx="12" cy="12" r="0.8" fill="none" stroke="currentColor" strokeWidth="0.9" />
      <circle cx="12" cy="7.2" r="0.7" fill="currentColor" opacity="0.9" />
    </motion.svg>
  );
}

// Scrolls only when the name genuinely does not fit. A marquee that runs on a
// title with room to spare is just noise, and most song names fit.
function Marquee({ text, className = '' }) {
  const reduced = useReducedMotion();
  const boxRef = useRef(null);
  const textRef = useRef(null);
  const [overflowPx, setOverflowPx] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    const el = textRef.current;
    if (!box || !el) return undefined;
    const measure = () => setOverflowPx(Math.max(0, el.scrollWidth - box.clientWidth));
    measure();
    // The box changes width on rotation and on the Scene's drawer opening, so
    // a one-time measurement would be wrong for the rest of the session.
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const scrolling = overflowPx > 0 && !reduced;
  return (
    <span ref={boxRef} className={`relative block overflow-hidden ${className}`}>
      <motion.span
        ref={textRef}
        className="inline-block whitespace-nowrap"
        animate={scrolling ? { x: [0, -overflowPx, -overflowPx, 0, 0] } : { x: 0 }}
        transition={
          scrolling
            ? {
                duration: Math.max(6, overflowPx / 18),
                times: [0, 0.45, 0.55, 0.95, 1], // slide, hold, slide back, hold
                repeat: Infinity,
                ease: 'linear',
              }
            : { duration: 0.2 }
        }
      >
        {text}
      </motion.span>
    </span>
  );
}

// `onOpen` is supplied only where opening the Audio Player makes sense; a
// Player never gets one, so for them this is a plain indicator rather than a
// button.
export default function NowPlaying({ variant = 'bar', onOpen }) {
  const { role } = useRole();
  const audio = useAudioStatus();
  if (!audio.name) return null;

  const scene = variant === 'scene';
  // Blocked is the one state with a remedy the person themselves can apply, so
  // it is the one state that always reads as tappable — including for a Player,
  // who otherwise has nothing to press here.
  const blocked = audio.status === 'blocked';
  const interactive = blocked || (role === 'gm' && typeof onOpen === 'function');

  // A device that cannot reach YouTube at all (an ad blocker, a captive portal,
  // a network that filters it) still knows what the table is playing — so it
  // says so rather than showing a record that silently never spins.
  const label = blocked
    ? 'Tap to enable audio'
    : audio.status === 'error'
      ? `${audio.name} — can't play here`
      : audio.status === 'silent'
        ? `${audio.name} (${silentReason(audio)})`
        : audio.name;

  const handle = () => {
    if (blocked) {
      // A click IS a user gesture, which is exactly what a browser that
      // refused autoplay is waiting for.
      unlockAudioFromGesture();
      return;
    }
    onOpen?.();
  };

  const body = (
    <>
      <Record
        spinning={audio.isPlaying && audio.status === 'playing'}
        className={
          scene
            ? 'h-4 w-4 shrink-0 text-zinc-200 md:h-6 md:w-6'
            : 'h-4 w-4 shrink-0 text-brand-300 md:h-5 md:w-5'
        }
      />
      <Marquee
        text={label}
        className={
          scene
            ? 'max-w-[7.5rem] text-[10px] font-semibold text-zinc-100 md:max-w-[14rem] md:text-xs'
            : 'max-w-[8rem] text-[10px] text-zinc-300 sm:max-w-[14rem] md:max-w-[22rem] md:text-xs'
        }
      />
    </>
  );

  // The Scene variant puts the TEXT (never the record) on the same tinted
  // plate character nameplates use, so the two read as one visual family over
  // whatever artwork is behind them. HaloText itself is not reused here
  // because it bakes in pointer-events-none and this chip has to be tappable;
  // the tint below is its values, kept deliberately identical.
  if (scene) {
    return (
      <button
        type="button"
        onClick={interactive ? handle : undefined}
        aria-label={interactive ? 'Open the Audio Player' : label}
        className={`pointer-events-auto flex items-center gap-1.5 px-1.5 py-0.5 ${
          interactive ? '' : 'cursor-default'
        }`}
        style={{
          backdropFilter: 'blur(7px) opacity(0.2)',
          WebkitBackdropFilter: 'blur(7px) opacity(0.2)',
          backgroundColor: 'rgba(21,23,27,0.55)',
        }}
      >
        {body}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={interactive ? handle : undefined}
      aria-label={interactive ? 'Open the Audio Player' : label}
      className={`flex min-w-0 items-center gap-2 ${
        interactive ? 'hover:text-brand-200' : 'cursor-default'
      }`}
    >
      {body}
    </button>
  );
}

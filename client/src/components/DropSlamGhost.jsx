import { motion } from 'framer-motion';
import { useEffect } from 'react';

const TIMES = [0, 0.08, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 1];
const TOTAL_MS = 900;

const GLOW = [
  'brightness(1) drop-shadow(0 0 0px rgb(var(--color-brand-rgb) / 0%))',
  'brightness(1.1) drop-shadow(0 0 6px rgb(var(--color-brand-rgb) / 60%))',
  'brightness(1.1) drop-shadow(0 0 6px rgb(var(--color-brand-rgb) / 60%))',
  'brightness(1.9) drop-shadow(0 0 28px rgb(var(--color-brand-rgb) / 95%))',
  'brightness(1.3) drop-shadow(0 0 14px rgb(var(--color-brand-rgb) / 80%))',
  'brightness(1) drop-shadow(0 0 4px rgb(var(--color-brand-rgb) / 40%))',
  'brightness(1) drop-shadow(0 0 4px rgb(var(--color-brand-rgb) / 40%))',
  'brightness(1) drop-shadow(0 0 0px rgb(var(--color-brand-rgb) / 0%))',
  'brightness(1) drop-shadow(0 0 0px rgb(var(--color-brand-rgb) / 0%))',
];

// Shared "drag-release" impact effect (fighting-game visual pass): the
// dropped thing hovers right where it was released — just long enough to
// cover the round-trip to the server — then violently slams down with a
// shake once it lands. Used for declaring a move onto the Tic Counter and
// for seating a character in the Combat Arena; deliberately NOT used for
// Compendium grant-drags or folder-filing drags, which stay instant.
// Fixed-positioned at the raw drop coordinates, so no portal is needed —
// it escapes whatever container it's rendered inside.
export default function DropSlamGhost({ x, y, onDone, children }) {
  useEffect(() => {
    const timer = setTimeout(onDone, TOTAL_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <motion.div
      className="pointer-events-none fixed z-[100]"
      style={{ left: x, top: y, translateX: '-50%', translateY: '-50%' }}
      initial={{ opacity: 0, scale: 0.7, y: -14 }}
      animate={{
        opacity: [0, 1, 1, 1, 1, 1, 1, 1, 0],
        scale: [0.7, 1.1, 1.1, 0.9, 1.08, 0.97, 1.02, 1, 1],
        y: [-14, -10, -10, 4, 0, 0, 0, 0, 0],
        x: [0, 0, 0, 0, -5, 5, -3, 2, 0],
        rotate: [0, -1, -1, 2, -5, 4, -2, 1, 0],
        filter: GLOW,
      }}
      transition={{ duration: TOTAL_MS / 1000, times: TIMES, ease: 'easeInOut' }}
    >
      {children}
    </motion.div>
  );
}

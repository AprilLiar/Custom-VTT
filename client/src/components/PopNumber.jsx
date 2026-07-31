import { motion } from 'framer-motion';

// Shared "bigger and vibrant, then falling back down onto the previous
// number" flash (decided) — originally just Tab 1's Current Stamina pop,
// now reused everywhere a Stamina number actually changes (idle-Tic regen,
// automatic per-round regen, manual stamina:regen, a move's Stamina Cost
// being spent on Done Declaring, and a manual +/- adjust alike), always the
// same yellow flash regardless of whether the change was a spend or a gain
// — the point is "this number just changed," not which direction. Keyed on
// `value` so React replays the animation from scratch every time it
// actually changes, and stays put otherwise.
export default function PopNumber({ value, className }) {
  return (
    <motion.span
      key={value}
      initial={{ scale: 1.35, color: '#fbbf24' }}
      animate={{ scale: 1, color: '#f4f4f5' }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className={`inline-block ${className ?? ''}`}
    >
      {value}
    </motion.span>
  );
}

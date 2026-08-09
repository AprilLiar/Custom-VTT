import { motion, useReducedMotion } from 'framer-motion';
import { INK_STROKE_VIEWBOX, inkStroke } from '../lib/inkAssets.js';

// Visual Overhaul (Ink & Impact), Phase V5 — the one page-title treatment.
//
// The impact face plus a brush stroke that draws itself on underneath. This
// is what the "graded intensity" decision means in practice for the calm
// library surfaces: they get the materials and the typographic voice, and
// none of the particle or shader work. One shared component rather than six
// hand-styled `<h1>`s, so the six pages cannot drift.
//
// It is also what finally consumes `inkStroke()` from lib/inkAssets.js —
// authored in V1 for exactly this and unused until now.
export default function InkHeading({
  children,
  seed = 1,
  as: Tag = 'h1',
  size = 'text-2xl md:text-3xl',
  className = '',
  strokeClassName = 'max-w-56',
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className={`min-w-0 ${className}`}>
      <Tag className={`font-impact uppercase leading-none tracking-wide text-zinc-100 ${size}`}>
        {children}
      </Tag>
      <svg
        viewBox={INK_STROKE_VIEWBOX}
        preserveAspectRatio="none"
        aria-hidden="true"
        className={`mt-1 h-2 w-full text-brand-500 ${strokeClassName}`}
      >
        <motion.path
          d={inkStroke(seed)}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          // non-scaling-stroke because the viewBox is stretched with
          // preserveAspectRatio="none" to span whatever width the heading
          // has; without it the stroke thins and thickens with the page.
          vectorEffect="non-scaling-stroke"
          initial={reduceMotion ? { pathLength: 1 } : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
        />
      </svg>
    </div>
  );
}

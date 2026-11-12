import { AnimatePresence, motion } from 'framer-motion';
import CroppedImage from '../CroppedImage.jsx';
import { cropOf } from '../../lib/imageCrop.js';

// **A Super Move (phase 4):** a banner sweeps across the board with its name
// and the fighter's portrait; play goes on behind it. `beat`: the beat playing
// (useBoardFx); `fighterOf(combatantId)` → { name, image_url, crop } or null.
export default function SuperBanner({ beat, fighterOf }) {
  const e = beat?.effects.find((x) => x.kind === 'super');
  const who = e ? fighterOf(e.combatantId) : null;
  const s = beat?.speed ?? 1;
  return (
    <AnimatePresence>
      {e && (
        <motion.div
          key={`${beat.id}:${e.id}`}
          className="pointer-events-none absolute inset-x-0 flex items-center justify-center"
          style={{ top: '38%', zIndex: 1100 }}
          initial={{ x: '-100%', opacity: 0 }}
          animate={{ x: ['-100%', '0%', '0%', '100%'], opacity: [0, 1, 1, 0] }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.5 * s, times: [0, 0.18, 0.82, 1], ease: 'easeInOut' }}
          aria-hidden
        >
          <div
            className="flex w-full items-center justify-center gap-4 py-3"
            style={{ background: 'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(124,45,18,0.92) 18%, rgba(194,65,12,0.95) 50%, rgba(124,45,18,0.92) 82%, rgba(0,0,0,0) 100%)', borderTop: '2px solid rgba(251,191,36,0.9)', borderBottom: '2px solid rgba(251,191,36,0.9)' }}
          >
            {who?.image_url && (
              <span className="h-14 w-14 shrink-0 overflow-hidden rounded-full border-2 border-amber-300">
                <CroppedImage src={who.image_url} crop={who.crop ? cropOf({ crop_x: who.crop.x, crop_y: who.crop.y, crop_w: who.crop.w, crop_h: who.crop.h }) : null} alt="" className="h-full w-full" draggable={false} />
              </span>
            )}
            <span className="flex flex-col leading-none">
              <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-amber-200">{who?.name ? `${who.name} · Super Move` : 'Super Move'}</span>
              <span className="font-display text-3xl font-black uppercase text-white" style={{ textShadow: '0 2px 8px rgba(0,0,0,0.8)' }}>
                {e.data?.name}
              </span>
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

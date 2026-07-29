import { useState } from 'react';
import { motion } from 'framer-motion';

const MODIFIER_LIMIT = 20;

// Asks for the ad-hoc +/- modifier before a die or pool roll (clamped to +/-20).
// initialModifier pre-fills the field (e.g. a Move's own Roll bonus) while
// still leaving it freely editable before submitting.
export default function RollDialog({ title, onRoll, onClose, initialModifier = 0 }) {
  const [value, setValue] = useState(String(initialModifier));

  const submit = (e) => {
    e.preventDefault();
    const n = Math.trunc(Number(value) || 0);
    onRoll(Math.max(-MODIFIER_LIMIT, Math.min(MODIFIER_LIMIT, n)));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <motion.form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.85, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        className="flex w-64 flex-col gap-3 panel-cut-lg border border-zinc-700 bg-zinc-900 p-4"
      >
        <h3 className="font-bold text-zinc-100">{title}</h3>
        <label className="text-sm text-zinc-400">
          Modifier (−{MODIFIER_LIMIT} to +{MODIFIER_LIMIT})
          <input
            autoFocus
            type="number"
            min={-MODIFIER_LIMIT}
            max={MODIFIER_LIMIT}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-lg text-zinc-100 outline-none focus:border-brand-500"
          />
        </label>
        <div className="flex gap-2">
          <motion.button
            type="submit"
            whileTap={{ scale: 0.9 }}
            whileHover={{ scale: 1.03 }}
            className="flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold hover:bg-brand-500"
          >
            Roll
          </motion.button>
          <button
            type="button"
            onClick={onClose}
            className="panel-cut-sm border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      </motion.form>
    </div>
  );
}

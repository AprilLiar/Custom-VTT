import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { gsap } from 'gsap';
import { Sword, X } from 'lucide-react';
import { socket } from '../socket.js';
import { DIE_SIZES, dieLabel } from '../lib/dice.js';
import DialogShell from './DialogShell.jsx';
import RollDialog from './RollDialog.jsx';

// The Weapon (decided, new) — the one thing on the Vitruvian figure that is
// not a Stat.
//
// **Empty by default, for everybody.** A character is not born holding
// anything, so the slot starts as an outline you can click, not as a d4 you
// have to explain away. That emptiness is load-bearing elsewhere: a Move whose
// Roll names the Weapon cannot be declared at all without one (see
// move:declare), and the Arena greys such a card exactly as it greys a
// Movement move on a broken leg.
//
// Rolling it here costs nothing. Durability is spent by USING the weapon in a
// Move, which the engine charges once per declaration — see
// spendWeaponForDeclaredMove in server/roundResolution.js.

// **Both dialogs are portalled to <body>, and they have to be (fix).** On the
// desktop sheet this widget is placed by an absolutely-positioned wrapper
// carrying `-translate-x-1/2 -translate-y-1/2`, and a transformed ancestor
// becomes the containing block for `position: fixed` descendants. A dialog
// rendered in place therefore laid itself out inside a 64px box: found in the
// browser as a modal squeezed into a sliver beside the figure's right hand,
// with its own title wrapping one word per line. Every other dialog on this
// page is raised by CoreStatsTab, outside the wrapper, which is why this is the
// only widget that has ever hit it.
const toBody = (node) => (typeof document === 'undefined' ? node : createPortal(node, document.body));

// The editor. Also the whole creation path from the client's side: there is one
// server event behind it (`weapon:create`), and it replaces whatever the
// character was carrying, so editing and re-arming are the same act.
function WeaponEditor({ weapon, characterId, onClose }) {
  const [name, setName] = useState(weapon?.name ?? '');
  const [dieSize, setDieSize] = useState(weapon?.die_size ?? 6);
  const [bonus, setBonus] = useState(String(weapon?.bonus ?? 0));
  const [durability, setDurability] = useState(String(weapon?.durability ?? 3));

  const trimmed = name.trim();
  const dur = Math.trunc(Number(durability));
  // The same two rules grantWeapon enforces server-side, asked here so the
  // button can say no rather than the event vanishing silently.
  const valid = Boolean(trimmed) && Number.isFinite(dur) && dur >= 1;

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    socket.emit('weapon:create', {
      characterId,
      name: trimmed,
      dieSize,
      bonus: Math.trunc(Number(bonus) || 0),
      durability: dur,
    });
    onClose();
  };

  return (
    <DialogShell title={weapon ? 'Edit weapon' : 'Take up a weapon'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm text-zinc-400">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Chipped machete"
            className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-brand-500"
          />
        </label>

        <div>
          <span className="font-display text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Dice
          </span>
          <div className="mt-1 flex flex-wrap gap-2">
            {DIE_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => setDieSize(size)}
                className={`min-h-11 panel-cut-sm border px-4 font-display font-bold ${
                  dieSize === size
                    ? 'border-brand-500 bg-brand-600/30 text-brand-200'
                    : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                d{size}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-zinc-400">
            Modifier
            <input
              type="number"
              value={bonus}
              onChange={(e) => setBonus(e.target.value)}
              onFocus={(e) => e.target.select()}
              className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-brand-500"
            />
            {/* Said out loud because it is the whole arithmetic of a weapon:
                the die and the modifier are added together, and then every
                other modifier on the roll lands on top exactly as it does for
                a Stat. */}
            <span className="mt-1 block text-xs text-zinc-600">Added to the die.</span>
          </label>
          <label className="block text-sm text-zinc-400">
            Durability
            <input
              type="number"
              min={1}
              value={durability}
              onChange={(e) => setDurability(e.target.value)}
              onFocus={(e) => e.target.select()}
              className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-brand-500"
            />
            <span className="mt-1 block text-xs text-zinc-600">1 per Move that uses it.</span>
          </label>
        </div>

        <div className="flex gap-2">
          <motion.button
            type="submit"
            disabled={!valid}
            whileTap={valid ? { scale: 0.95 } : undefined}
            className="flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold hover:bg-brand-500 disabled:opacity-40"
          >
            {weapon ? 'Save' : 'Take it up'}
          </motion.button>
          <button
            type="button"
            onClick={onClose}
            className="panel-cut-sm border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export default function WeaponSlot({ characterId, weapon, offers = [], compact = false }) {
  const [editing, setEditing] = useState(false);
  const [rolling, setRolling] = useState(false);
  const buttonRef = useRef(null);
  const lastDurability = useRef(weapon?.durability ?? null);

  // The same violent little punch a die gives when it is rolled, fired instead
  // on Durability dropping — which is the moment a weapon is worth looking at,
  // and the one thing about it that happens without anybody clicking here.
  useEffect(() => {
    const now = weapon?.durability ?? null;
    const before = lastDurability.current;
    lastDurability.current = now;
    if (now == null || before == null || now >= before || !buttonRef.current) return;
    gsap
      .timeline()
      .fromTo(
        buttonRef.current,
        { rotate: 0, filter: 'brightness(1)' },
        { rotate: -12, filter: 'brightness(1.7)', duration: 0.1, ease: 'power2.out' }
      )
      .to(buttonRef.current, { rotate: 8, duration: 0.08 })
      .to(buttonRef.current, { rotate: 0, filter: 'brightness(1)', duration: 0.4, ease: 'elastic.out(1, 0.5)' });
  }, [weapon?.durability]);

  const onRoll = (modifier) => socket.emit('weapon:roll', { characterId, modifier });

  const size = compact ? 'h-14 w-14 text-sm' : 'h-16 w-16 text-base';

  if (!weapon) {
    return (
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="No weapon — click to take one up"
          className={`relative flex items-center justify-center panel-cut-lg border border-dashed border-zinc-700 bg-zinc-900/60 text-zinc-600 transition-colors hover:border-brand-500 hover:text-brand-300 ${size}`}
        >
          <Sword className="h-7 w-7 opacity-60" />
        </button>
        <span className="text-xs text-zinc-600">Weapon</span>
        {/* **What a Perk is offering to put here (Never Empty-Handed).** On the
            empty slot rather than on the Perk's own card, because this is where
            you look for a weapon — and it is the one place in the app that
            already means "you are carrying nothing". Only takeable offers ever
            arrive (the server filters a spent once-per-Fight charge out
            entirely), so the button's absence is the whole of the "you already
            did this" state; there is nothing to grey out. */}
        {offers.map((offer) => (
          <button
            key={offer.perkName}
            type="button"
            onClick={() => socket.emit('weapon:take_offer', { characterId, perkName: offer.perkName })}
            title={`${offer.perkName} — d${offer.dieSize}, ${offer.durability} Durability`}
            className="panel-cut-sm whitespace-nowrap border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[11px] text-amber-300 hover:border-amber-500 hover:bg-amber-900/40"
          >
            {offer.label}
          </button>
        ))}
        {editing &&
          toBody(
            <WeaponEditor weapon={null} characterId={characterId} onClose={() => setEditing(false)} />
          )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-1">
        {/* The badge is a SIBLING of the button, not a child of it (fix).
            `panel-cut-lg` is a clip-path, and a clip-path clips its own
            descendants — a Durability pip hung off the button's corner came out
            with its outer half shaved away. */}
        <div className="relative">
          <motion.button
            ref={buttonRef}
            type="button"
            onClick={() => setRolling(true)}
            whileTap={{ scale: 0.9 }}
            title={`Roll ${weapon.name}`}
            className={`relative flex items-center justify-center panel-cut-lg border border-amber-700/70 bg-zinc-800/90 font-display font-bold text-zinc-100 backdrop-blur-sm transition-colors hover:border-brand-500 ${size}`}
          >
            <Sword className="pointer-events-none absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 text-amber-200 opacity-25" />
            <span>{dieLabel(weapon.die_size, weapon.bonus)}</span>
          </motion.button>
          {/* Durability is a countdown, so it is a number on the weapon rather
              than something hidden in a tooltip — at 1 it is the most important
              thing on this widget. */}
          <span
            className={`pointer-events-none absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold ${
              weapon.durability <= 1 ? 'bg-red-600 text-white' : 'bg-amber-700 text-amber-100'
            }`}
          >
            {weapon.durability}
          </span>
        </div>
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit this weapon"
            className="min-h-9 min-w-8 panel-cut-sm px-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 md:min-h-0"
          >
            ✎
          </button>
          <button
            type="button"
            onClick={() => socket.emit('weapon:delete', { characterId })}
            title="Put it down"
            className="flex min-h-9 min-w-8 items-center justify-center panel-cut-sm px-1 text-red-500 hover:bg-red-900/30 md:min-h-0"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <span className="max-w-24 truncate text-xs text-zinc-500" title={weapon.name}>
        {weapon.name}
      </span>
      {rolling &&
        toBody(
          <RollDialog title={`Roll ${weapon.name}`} onRoll={onRoll} onClose={() => setRolling(false)} />
        )}
      {editing &&
        toBody(
          <WeaponEditor weapon={weapon} characterId={characterId} onClose={() => setEditing(false)} />
        )}
    </div>
  );
}

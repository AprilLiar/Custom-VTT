import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { updateCharacter } from '../lib/api.js';
import { fileToPortrait, portraitSrc, vitruvianSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import CroppedImage from './CroppedImage.jsx';
import { ANATOMY, WEAPON_SPOT } from '../lib/anatomy.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';

// How the 8 Stats sit around the Vitruvian figure. Wide screens keep the
// original 2 / 4 / 2 shape, which mirrors the figure directly: head at the
// top, arms and torso across the middle, legs at the bottom.
//
// A phone cannot fit that middle row — four Stat widgets side by side ran
// straight off both edges, clipping Left Hand and Right Hand out of view
// entirely. Narrow screens get four rows of two instead, grouped by body
// part rather than simply wrapped: hands together, torso together, legs
// together, so the left/right pairing still reads off the figure behind it.
const WIDE_ROWS = [
  ['Skull', 'Brain'],
  ['Left Hand', 'Stamina', 'Body', 'Right Hand'],
  ['Left Leg', 'Right Leg'],
];
const NARROW_ROWS = [
  ['Skull', 'Brain'],
  ['Left Hand', 'Right Hand'],
  ['Stamina', 'Body'],
  ['Left Leg', 'Right Leg'],
];
import DieWidget from './DieWidget.jsx';
import RollDialog from './RollDialog.jsx';
import ItemList from './ItemList.jsx';
import InjuryList from './InjuryList.jsx';
import VitruvianFigure from './VitruvianFigure.jsx';
import WeaponSlot from './WeaponSlot.jsx';
import PopNumber from './PopNumber.jsx';

function NamePortrait({ character }) {
  const fileRef = useRef(null);
  const nameRef = useRef(null);
  const [name, setName] = useState(character.name);
  const debounceRef = useRef(null);

  // Follow live renames from other devices unless this input is being edited
  useEffect(() => {
    if (document.activeElement !== nameRef.current) setName(character.name);
  }, [character.name]);

  const onNameChange = (value) => {
    setName(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim() && value.trim() !== character.name) {
        updateCharacter(character.id, { name: value.trim() }).catch(console.error);
      }
    }, 500);
  };

  // The crop step sits between the file picker and the save. The Arena card
  // still renders `image_data` whole — only the square frames use the crop.
  const { pick, dialog, busy } = usePictureUpload({
    process: fileToPortrait,
    name,
    previewSizes: [
      { label: 'In the roster', px: 32 },
      { label: 'On the sheet', px: 96 },
      { label: 'On a relationship board', px: 112 },
    ],
    onPicked: (fields) => updateCharacter(character.id, fields),
  });

  const src = portraitSrc(character);
  return (
    <div className="flex items-center gap-4">
      <motion.button
        onClick={() => fileRef.current?.click()}
        title="Click to upload / replace portrait"
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden border border-zinc-700 bg-zinc-800 [clip-path:polygon(0_0,100%_0,100%_88%,88%_100%,0_100%)] hover:border-brand-500"
      >
        {busy ? (
          <span className="text-xs text-zinc-500">…</span>
        ) : src ? (
          <CroppedImage
            src={src}
            alt={character.name}
            crop={cropOf(character)}
            className="h-full w-full"
          />
        ) : (
          <span className="px-1 text-center text-xs text-zinc-500">Add portrait</span>
        )}
      </motion.button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
      {dialog}
      <div className="min-w-0 flex-1">
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="w-full panel-cut-sm border border-transparent bg-transparent px-2 py-1 font-display text-3xl font-bold uppercase tracking-wide text-zinc-100 outline-none hover:border-zinc-700 focus:border-brand-500"
        />
        {character.character_type === 'npc' && (
          <span className="ml-2 panel-cut-sm bg-purple-600/30 px-1.5 text-xs font-bold uppercase text-purple-300">
            NPC
          </span>
        )}
      </div>
    </div>
  );
}

function StaminaBlock({ character, staminaDie }) {
  const regenBlocked = !staminaDie || staminaDie.status === 'incapacitated';
  return (
    <div className="flex flex-wrap items-center gap-4 border border-zinc-800 bg-zinc-900 p-4 [clip-path:polygon(0_0,100%_0,100%_100%,3%_100%,0_82%)]">
      <div>
        <div className="font-display text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Stamina
        </div>
        <div className="text-2xl font-bold">
          <PopNumber value={character.current_stamina} />
          <span className="text-zinc-500"> / {character.max_stamina}</span>
        </div>
      </div>
      <div className="flex gap-1">
        <button
          onClick={() => socket.emit('stamina:adjust', { characterId: character.id, delta: -1 })}
          className="h-11 w-11 panel-cut-sm border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800 md:h-9 md:w-9"
        >
          −
        </button>
        <button
          onClick={() => socket.emit('stamina:adjust', { characterId: character.id, delta: 1 })}
          className="h-11 w-11 panel-cut-sm border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800 md:h-9 md:w-9"
        >
          +
        </button>
      </div>
      <button
        onClick={() => socket.emit('stamina:regen', { characterId: character.id })}
        disabled={regenBlocked}
        title={
          regenBlocked
            ? 'Stamina die is incapacitated — it can’t be rolled'
            : 'Roll the Stamina die (current size) and add it to Current Stamina'
        }
        className="ml-auto panel-cut-sm bg-emerald-700 px-4 py-2 font-semibold hover:bg-emerald-600 disabled:opacity-40"
      >
        Roll Regen
      </button>
    </div>
  );
}

export default function CoreStatsTab({ data }) {
  const { character, dice, inventory, injuries, weapon, weaponOffers = [] } = data;
  const { role } = useRole();
  // Tailwind's own `sm` — the width below which the 4-wide middle row of
  // Stats stops fitting at all (see NARROW_ROWS above).
  const narrow = !useMediaQuery('(min-width: 640px)');
  const [dialog, setDialog] = useState(null); // { type: 'die', die } | { type: 'pool' }
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const vitruvianFileRef = useRef(null);
  const [uploadingVitruvian, setUploadingVitruvian] = useState(false);

  const staminaDie = dice.find((d) => d.slot_name === 'Stamina');
  const anyActive = dice.some((d) => d.status === 'active');

  const onPickVitruvian = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingVitruvian(true);
    try {
      const { imageData, imageMimeType } = await fileToPortrait(file);
      await updateCharacter(character.id, {
        vitruvianImageData: imageData,
        vitruvianImageMimeType: imageMimeType,
      });
    } catch (err) {
      console.error(err);
    } finally {
      setUploadingVitruvian(false);
    }
  };

  const rollDie = (die) => setDialog({ type: 'die', die });
  const stepDie = (die, direction) => socket.emit('die:step', { dieId: die.id, direction });
  const toggleHalfDamage = (die) => socket.emit('die:toggle_half_damage', { dieId: die.id });
  const toggleSelect = (die) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(die.id)) next.delete(die.id);
      else next.add(die.id);
      return next;
    });

  const exitSelection = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  const onDialogRoll = (modifier) => {
    if (dialog.type === 'die') {
      socket.emit('die:roll', {
        characterId: character.id,
        dieId: dialog.die.id,
        modifier,
      });
    } else {
      socket.emit('pool:roll', {
        characterId: character.id,
        dieIds: [...selectedIds],
        modifier,
      });
      exitSelection();
    }
  };

  return (
    <div className="space-y-4">
      <NamePortrait character={character} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => socket.emit('character:lock_stats', { characterId: character.id })}
          title="Snapshot every die's current size/bonus/status as the new rested baseline"
          className="panel-cut-sm bg-zinc-800 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-zinc-700"
        >
          Lock in Stats
        </button>
        <button
          onClick={() => socket.emit('character:revert_stats', { characterId: character.id })}
          title="Reset every die back to its locked baseline (Current Stamina untouched)"
          className="panel-cut-sm bg-zinc-800 px-4 py-2 text-sm font-semibold text-sky-300 hover:bg-zinc-700"
        >
          Revert Stats to Base
        </button>
        {!selecting ? (
          <button
            onClick={() => setSelecting(true)}
            disabled={!anyActive}
            title="Select any dice to roll together with one shared modifier"
            className="panel-cut-sm bg-brand-600 px-4 py-2 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
          >
            Pool Roll
          </button>
        ) : (
          <>
            <button
              onClick={() => setDialog({ type: 'pool' })}
              disabled={selectedIds.size === 0}
              className="panel-cut-sm bg-brand-600 px-4 py-2 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
            >
              Roll {selectedIds.size || ''} selected
            </button>
            <button
              onClick={exitSelection}
              className="panel-cut-sm border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <span className="text-xs text-zinc-500">Tap dice to add them to the roll</span>
          </>
        )}
      </div>

      {/* Desktop/tablet: unchanged absolute Vitruvian layout. */}
      <div className="relative mx-auto hidden aspect-square w-full max-w-2xl select-none md:block">
        <VitruvianFigure
          className="absolute inset-0 h-full w-full text-zinc-400"
          customSrc={vitruvianSrc(character)}
        />
        {role === 'gm' && (
          <>
            <button
              onClick={() => vitruvianFileRef.current?.click()}
              disabled={uploadingVitruvian}
              title="Upload a custom Vitruvian Man for this character"
              className="absolute right-1 top-1 z-10 panel-cut-sm border border-zinc-700 bg-zinc-900/80 p-1.5 text-zinc-400 hover:border-brand-500 hover:text-brand-300 disabled:opacity-40"
            >
              <Upload size={14} />
            </button>
            <input
              ref={vitruvianFileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={onPickVitruvian}
            />
          </>
        )}
        {dice.map((die) => {
          const spot = ANATOMY[die.slot_name];
          if (!spot) return null;
          return (
            <div
              key={die.id}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ top: spot.top, left: spot.left }}
            >
              <DieWidget
                die={die}
                onRoll={rollDie}
                onStep={stepDie}
                selecting={selecting}
                selected={selectedIds.has(die.id)}
                onToggleSelect={toggleSelect}
                onToggleHalfDamage={toggleHalfDamage}
                Icon={spot.Icon}
              />
            </div>
          );
        })}
        {/* The Weapon (decided, new). Bottom-right of the figure, off the
            body: it is the one thing here that is not a Stat, and putting it
            on an arm or a hip would say it belonged to the anatomy. Empty for
            everybody until somebody picks something up. */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ top: WEAPON_SPOT.top, left: WEAPON_SPOT.left }}
        >
          <WeaponSlot characterId={character.id} weapon={weapon} offers={weaponOffers} />
        </div>
      </div>

      {/* Mobile readiness (Change 002) §14.6A: a 2/4/2 grouped grid (head
          row, core row, legs row — same visual grouping the Vitruvian
          figure itself shows) instead of absolute coordinates, which get
          cramped and overlap-prone under ~390px. A faint Vitruvian figure
          still sits behind it as a backdrop, purely decorative (no dice are
          positioned against it), so the character still "reads" as the
          same body layout at a glance. */}
      <div className="relative mx-auto w-full max-w-md select-none md:hidden">
        <VitruvianFigure
          className="pointer-events-none absolute inset-0 h-full w-full text-zinc-400 opacity-[0.08]"
          customSrc={vitruvianSrc(character)}
        />
        {role === 'gm' && (
          <>
            <button
              onClick={() => vitruvianFileRef.current?.click()}
              disabled={uploadingVitruvian}
              title="Upload a custom Vitruvian Man for this character"
              className="absolute right-1 top-1 z-10 flex h-11 w-11 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-brand-500 hover:text-brand-300 disabled:opacity-40"
            >
              <Upload size={14} />
            </button>
            <input
              ref={vitruvianFileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={onPickVitruvian}
            />
          </>
        )}
        <div className="relative space-y-3 py-2">
          {(narrow ? NARROW_ROWS : WIDE_ROWS).map((slots, rowIndex) => (
            <div key={rowIndex} className="flex justify-center gap-3">
              {slots.map((slot) => {
                const die = dice.find((d) => d.slot_name === slot);
                if (!die) return null;
                const spot = ANATOMY[slot];
                return (
                  <DieWidget
                    key={die.id}
                    die={die}
                    onRoll={rollDie}
                    onStep={stepDie}
                    selecting={selecting}
                    selected={selectedIds.has(die.id)}
                    onToggleSelect={toggleSelect}
                    onToggleHalfDamage={toggleHalfDamage}
                    Icon={spot.Icon}
                  />
                );
              })}
            </div>
          ))}
          {/* A row of its own on a phone, rather than a coordinate: the mobile
              layout is grouped rows, and the Weapon is its own group. */}
          <div className="flex justify-center gap-3">
            <WeaponSlot characterId={character.id} weapon={weapon} offers={weaponOffers} compact />
          </div>
        </div>
      </div>

      <StaminaBlock character={character} staminaDie={staminaDie} />

      <div className="grid gap-4 md:grid-cols-2">
        <ItemList
          title="Inventory"
          items={inventory.map((i) => ({ id: i.id, name: i.item_name, desc: i.description ?? '' }))}
          emptyText="Empty."
          namePlaceholder="Item"
          descPlaceholder="Description (optional)"
          onAdd={(name, desc) =>
            socket.emit('inventory:add', {
              characterId: character.id,
              itemName: name,
              description: desc,
            })
          }
          onUpdate={(id, name, desc) =>
            socket.emit('inventory:update', { itemId: id, itemName: name, description: desc })
          }
          onRemove={(id) => socket.emit('inventory:remove', { itemId: id })}
        />
        <InjuryList
          items={injuries}
          onAdd={(name, effect, slotName, penalty) =>
            socket.emit('injury:add', { characterId: character.id, name, effect, slotName, penalty })
          }
          onUpdate={(id, name, effect, slotName, penalty) =>
            socket.emit('injury:update', { injuryId: id, name, effect, slotName, penalty })
          }
          onRemove={(id) => socket.emit('injury:remove', { injuryId: id })}
        />
      </div>

      {dialog && (
        <RollDialog
          title={
            dialog.type === 'die'
              ? `Roll ${dialog.die.slot_name}`
              : `Roll ${selectedIds.size} dice together`
          }
          onRoll={onDialogRoll}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Skull, Brain, HandFist, Zap, HeartPulse, Footprints, Upload } from 'lucide-react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { updateCharacter } from '../lib/api.js';
import { fileToPortrait, portraitSrc, vitruvianSrc } from '../lib/image.js';
import DieWidget from './DieWidget.jsx';
import RollDialog from './RollDialog.jsx';
import ItemList from './ItemList.jsx';
import InjuryList from './InjuryList.jsx';
import VitruvianFigure from './VitruvianFigure.jsx';
import PopNumber from './PopNumber.jsx';

// Where each of the 8 dice sits, overlaid on the Vitruvian figure as three
// horizontal rows that mirror the original Head/Core/Legs pool grouping
// (2-4-2) rather than tracing the artwork point-for-point: Skull+Brain form
// a symmetric pair straddling the vertical midline (head row); Left Hand,
// Stamina, Body, Right Hand share one row at the hands' height, showing
// they're one group (core row); Left Leg+Right Leg stay a symmetric pair at
// the spread stance (leg row). Each die carries its own low-opacity icon
// (rendered inside the die by DieWidget) instead of a separate overlay.
const ANATOMY = {
  Skull: { top: '11%', left: '42%', Icon: Skull },
  Brain: { top: '11%', left: '58%', Icon: Brain },
  'Left Hand': { top: '32%', left: '9%', Icon: HandFist },
  Stamina: { top: '32%', left: '36%', Icon: Zap },
  Body: { top: '32%', left: '64%', Icon: HeartPulse },
  'Right Hand': { top: '32%', left: '91%', Icon: HandFist },
  'Left Leg': { top: '90%', left: '32%', Icon: Footprints },
  'Right Leg': { top: '90%', left: '68%', Icon: Footprints },
};

function NamePortrait({ character }) {
  const fileRef = useRef(null);
  const nameRef = useRef(null);
  const [name, setName] = useState(character.name);
  const [uploading, setUploading] = useState(false);
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

  const onPickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const portrait = await fileToPortrait(file);
      await updateCharacter(character.id, portrait);
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
    }
  };

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
        {uploading ? (
          <span className="text-xs text-zinc-500">…</span>
        ) : src ? (
          <img src={src} alt={character.name} className="h-full w-full object-cover" />
        ) : (
          <span className="px-1 text-center text-xs text-zinc-500">Add portrait</span>
        )}
      </motion.button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
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
          className="h-9 w-9 panel-cut-sm border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800"
        >
          −
        </button>
        <button
          onClick={() => socket.emit('stamina:adjust', { characterId: character.id, delta: 1 })}
          className="h-9 w-9 panel-cut-sm border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800"
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
  const { character, dice, inventory, injuries } = data;
  const { role } = useRole();
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

      <div className="relative mx-auto aspect-square w-full max-w-2xl select-none">
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

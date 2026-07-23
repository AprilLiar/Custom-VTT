import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { updateCharacter } from '../lib/api.js';
import { fileToPortrait, portraitSrc } from '../lib/image.js';
import DieWidget from './DieWidget.jsx';
import RollDialog from './RollDialog.jsx';

const POOLS = [
  { key: 'head', label: 'Head' },
  { key: 'core', label: 'Core' },
  { key: 'legs', label: 'Legs' },
];

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
      <button
        onClick={() => fileRef.current?.click()}
        title="Click to upload / replace portrait"
        className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 hover:border-indigo-500"
      >
        {uploading ? (
          <span className="text-xs text-zinc-500">…</span>
        ) : src ? (
          <img src={src} alt={character.name} className="h-full w-full object-cover" />
        ) : (
          <span className="px-1 text-center text-xs text-zinc-500">Add portrait</span>
        )}
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
      <div className="min-w-0 flex-1">
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-2xl font-bold text-zinc-100 outline-none hover:border-zinc-700 focus:border-indigo-500"
        />
        {character.character_type === 'npc' && (
          <span className="ml-2 rounded bg-purple-600/30 px-1.5 text-xs font-bold uppercase text-purple-300">
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
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500">Stamina</div>
        <div className="text-2xl font-bold">
          {character.current_stamina}
          <span className="text-zinc-500"> / {character.max_stamina}</span>
        </div>
      </div>
      <div className="flex gap-1">
        <button
          onClick={() => socket.emit('stamina:adjust', { characterId: character.id, delta: -1 })}
          className="h-9 w-9 rounded-md border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800"
        >
          −
        </button>
        <button
          onClick={() => socket.emit('stamina:adjust', { characterId: character.id, delta: 1 })}
          className="h-9 w-9 rounded-md border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800"
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
        className="ml-auto rounded-md bg-emerald-700 px-4 py-2 font-semibold hover:bg-emerald-600 disabled:opacity-40"
      >
        Roll Regen
      </button>
    </div>
  );
}

function ListSection({ title, children, form }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">{title}</h3>
      {children}
      {form}
    </div>
  );
}

function Inventory({ character, items }) {
  const [name, setName] = useState('');
  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    socket.emit('inventory:add', { characterId: character.id, itemName: name.trim() });
    setName('');
  };
  return (
    <ListSection
      title="Inventory"
      form={
        <form onSubmit={add} className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New item"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-md bg-indigo-600 px-3 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
          >
            Add
          </button>
        </form>
      }
    >
      {items.length === 0 ? (
        <p className="text-sm text-zinc-600">Empty.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-sm text-zinc-200">
              <span className="flex-1">{item.item_name}</span>
              <button
                onClick={() => socket.emit('inventory:remove', { itemId: item.id })}
                className="rounded px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </ListSection>
  );
}

function InjuryRow({ injury }) {
  const [name, setName] = useState(injury.name);
  const [effect, setEffect] = useState(injury.effect);

  useEffect(() => setName(injury.name), [injury.name]);
  useEffect(() => setEffect(injury.effect), [injury.effect]);

  const save = () => {
    if (!name.trim()) {
      setName(injury.name);
      return;
    }
    if (name.trim() !== injury.name || effect.trim() !== injury.effect) {
      socket.emit('injury:update', {
        injuryId: injury.id,
        name: name.trim(),
        effect: effect.trim(),
      });
    }
  };

  return (
    <li className="flex items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        className="w-1/3 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-zinc-200 outline-none hover:border-zinc-700 focus:border-indigo-500"
      />
      <input
        value={effect}
        onChange={(e) => setEffect(e.target.value)}
        onBlur={save}
        placeholder="Effect"
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-zinc-400 outline-none hover:border-zinc-700 focus:border-indigo-500"
      />
      <button
        onClick={() => socket.emit('injury:remove', { injuryId: injury.id })}
        className="rounded px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
      >
        ✕
      </button>
    </li>
  );
}

function Injuries({ character, injuries }) {
  const [name, setName] = useState('');
  const [effect, setEffect] = useState('');
  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    socket.emit('injury:add', {
      characterId: character.id,
      name: name.trim(),
      effect: effect.trim(),
    });
    setName('');
    setEffect('');
  };
  return (
    <ListSection
      title="Injuries"
      form={
        <form onSubmit={add} className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Injury"
            className="w-1/3 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
          />
          <input
            value={effect}
            onChange={(e) => setEffect(e.target.value)}
            placeholder="Effect"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-md bg-indigo-600 px-3 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
          >
            Add
          </button>
        </form>
      }
    >
      {injuries.length === 0 ? (
        <p className="text-sm text-zinc-600">None.</p>
      ) : (
        <ul className="space-y-1">
          {injuries.map((injury) => (
            <InjuryRow key={injury.id} injury={injury} />
          ))}
        </ul>
      )}
    </ListSection>
  );
}

export default function CoreStatsTab({ data }) {
  const { character, dice, inventory, injuries } = data;
  const [dialog, setDialog] = useState(null); // { type: 'die', die } | { type: 'pool', pool, label }

  const staminaDie = dice.find((d) => d.slot_name === 'Stamina');

  const rollDie = (die) => setDialog({ type: 'die', die });
  const stepDie = (die, direction) => socket.emit('die:step', { dieId: die.id, direction });

  const onDialogRoll = (modifier) => {
    if (dialog.type === 'die') {
      socket.emit('die:roll', {
        characterId: character.id,
        dieId: dialog.die.id,
        modifier,
      });
    } else {
      socket.emit('pool:roll', { characterId: character.id, pool: dialog.pool, modifier });
    }
  };

  return (
    <div className="space-y-4">
      <NamePortrait character={character} />

      <div className="flex gap-2">
        <button
          onClick={() => socket.emit('character:lock_stats', { characterId: character.id })}
          title="Snapshot every die's current size/bonus/status as the new rested baseline"
          className="rounded-md bg-zinc-800 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-zinc-700"
        >
          Lock in Stats
        </button>
        <button
          onClick={() => socket.emit('character:revert_stats', { characterId: character.id })}
          title="Reset every die back to its locked baseline (Current Stamina untouched)"
          className="rounded-md bg-zinc-800 px-4 py-2 text-sm font-semibold text-sky-300 hover:bg-zinc-700"
        >
          Revert Stats to Base
        </button>
      </div>

      {POOLS.map((pool) => {
        const poolDice = dice.filter((d) => d.pool === pool.key);
        const anyActive = poolDice.some((d) => d.status === 'active');
        return (
          <div key={pool.key} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex items-center">
              <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
                {pool.label}
              </h3>
              <button
                onClick={() => setDialog({ type: 'pool', pool: pool.key, label: pool.label })}
                disabled={!anyActive}
                className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-sm font-semibold text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Roll pool
              </button>
            </div>
            <div className="flex flex-wrap gap-4">
              {poolDice.map((die) => (
                <DieWidget key={die.id} die={die} onRoll={rollDie} onStep={stepDie} />
              ))}
            </div>
          </div>
        );
      })}

      <StaminaBlock character={character} staminaDie={staminaDie} />

      <div className="grid gap-4 md:grid-cols-2">
        <Inventory character={character} items={inventory} />
        <Injuries character={character} injuries={injuries} />
      </div>

      {dialog && (
        <RollDialog
          title={
            dialog.type === 'die'
              ? `Roll ${dialog.die.slot_name}`
              : `Roll ${dialog.label} pool`
          }
          onRoll={onDialogRoll}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

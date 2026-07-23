import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacter } from '../lib/api.js';
import CoreStatsTab from './CoreStatsTab.jsx';

const TABS = [
  { key: 'core', label: 'Core Stats', phase: 1 },
  { key: 'stances', label: 'Stances', phase: 2 },
  { key: 'moves', label: 'Moves', phase: 3 },
  { key: 'perks', label: 'Perks', phase: 4 },
  { key: 'counters', label: 'Counters', phase: 5 },
];

export default function CharacterSheet() {
  const { id } = useParams();
  const { role } = useRole();
  const navigate = useNavigate();
  const [data, setData] = useState(null); // { character, dice, inventory, injuries }
  const [tab, setTab] = useState('core');
  const characterId = Number(id);

  useEffect(() => {
    let cancelled = false;
    getCharacter(characterId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => navigate('/', { replace: true }));
    return () => {
      cancelled = true;
    };
  }, [characterId, navigate]);

  useEffect(() => {
    const onCharacterUpdated = (character) => {
      if (character.id !== characterId) return;
      setData((prev) => (prev ? { ...prev, character } : prev));
    };
    const onCharacterDeleted = ({ id: deletedId }) => {
      if (deletedId === characterId) navigate('/', { replace: true });
    };
    const onDieUpdated = (die) => {
      if (die.characterId !== characterId) return;
      setData((prev) =>
        prev
          ? {
              ...prev,
              dice: prev.dice.map((d) =>
                d.id === die.dieId
                  ? {
                      ...d,
                      current_size: die.current_size,
                      bonus: die.bonus,
                      status: die.status,
                      locked_size: die.locked_size,
                      locked_bonus: die.locked_bonus,
                      locked_status: die.locked_status,
                    }
                  : d
              ),
            }
          : prev
      );
    };
    const onInventoryUpdated = ({ characterId: cid, items }) => {
      if (cid !== characterId) return;
      setData((prev) => (prev ? { ...prev, inventory: items } : prev));
    };
    const onInjuriesUpdated = ({ characterId: cid, injuries }) => {
      if (cid !== characterId) return;
      setData((prev) => (prev ? { ...prev, injuries } : prev));
    };

    socket.on('character:updated', onCharacterUpdated);
    socket.on('character:deleted', onCharacterDeleted);
    socket.on('die:updated', onDieUpdated);
    socket.on('inventory:updated', onInventoryUpdated);
    socket.on('injuries:updated', onInjuriesUpdated);
    return () => {
      socket.off('character:updated', onCharacterUpdated);
      socket.off('character:deleted', onCharacterDeleted);
      socket.off('die:updated', onDieUpdated);
      socket.off('inventory:updated', onInventoryUpdated);
      socket.off('injuries:updated', onInjuriesUpdated);
    };
  }, [characterId, navigate]);

  if (!data) return <p className="text-zinc-500">Loading…</p>;

  // Players can't open NPC sheets — the Combat Arena (Phase 6) is the only
  // place NPC info is shown to them.
  if (role !== 'gm' && data.character.character_type === 'npc') {
    navigate('/', { replace: true });
    return null;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            disabled={t.key !== 'core'}
            onClick={() => setTab(t.key)}
            title={t.key !== 'core' ? `Coming in Phase ${t.phase}` : undefined}
            className={`whitespace-nowrap rounded-t-md px-4 py-2 text-sm font-semibold ${
              tab === t.key
                ? 'border-b-2 border-indigo-500 text-zinc-100'
                : 'text-zinc-600'
            } ${t.key !== 'core' ? 'cursor-not-allowed opacity-50' : 'hover:text-zinc-300'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'core' && <CoreStatsTab data={data} />}
    </div>
  );
}

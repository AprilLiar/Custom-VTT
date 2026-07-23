import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacter } from '../lib/api.js';
import CoreStatsTab from './CoreStatsTab.jsx';
import StancesTab from './StancesTab.jsx';

const TABS = [
  { key: 'core', label: 'Core Stats', phase: 1 },
  { key: 'stances', label: 'Stances', phase: 2 },
  { key: 'moves', label: 'Moves', phase: 3 },
  { key: 'perks', label: 'Perks', phase: 4 },
  { key: 'counters', label: 'Counters', phase: 5 },
];
const BUILT_TABS = ['core', 'stances'];

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
    const onStanceCreated = (stance) => {
      if (stance.character_id !== characterId) return;
      setData((prev) => (prev ? { ...prev, stances: [...prev.stances, stance] } : prev));
    };
    const onStanceUpdated = (stance) => {
      if (stance.character_id !== characterId) return;
      setData((prev) =>
        prev
          ? { ...prev, stances: prev.stances.map((s) => (s.id === stance.id ? stance : s)) }
          : prev
      );
    };
    const onStanceDeleted = ({ stanceId, characterId: cid }) => {
      if (cid !== characterId) return;
      setData((prev) =>
        prev ? { ...prev, stances: prev.stances.filter((s) => s.id !== stanceId) } : prev
      );
    };
    const onStanceActivated = ({ characterId: cid, stanceId }) => {
      if (cid !== characterId) return;
      setData((prev) =>
        prev
          ? { ...prev, character: { ...prev.character, active_stance_id: stanceId } }
          : prev
      );
    };

    socket.on('character:updated', onCharacterUpdated);
    socket.on('character:deleted', onCharacterDeleted);
    socket.on('die:updated', onDieUpdated);
    socket.on('inventory:updated', onInventoryUpdated);
    socket.on('injuries:updated', onInjuriesUpdated);
    socket.on('stance:created', onStanceCreated);
    socket.on('stance:updated', onStanceUpdated);
    socket.on('stance:deleted', onStanceDeleted);
    socket.on('stance:activated', onStanceActivated);
    return () => {
      socket.off('character:updated', onCharacterUpdated);
      socket.off('character:deleted', onCharacterDeleted);
      socket.off('die:updated', onDieUpdated);
      socket.off('inventory:updated', onInventoryUpdated);
      socket.off('injuries:updated', onInjuriesUpdated);
      socket.off('stance:created', onStanceCreated);
      socket.off('stance:updated', onStanceUpdated);
      socket.off('stance:deleted', onStanceDeleted);
      socket.off('stance:activated', onStanceActivated);
    };
  }, [characterId, navigate]);

  if (!data) return <p className="text-zinc-500">Loading…</p>;

  // Players can't open NPC sheets — the Combat Arena (Phase 6) is the only
  // place NPC info is shown to them.
  if (role !== 'gm' && data.character.character_type === 'npc') {
    navigate('/', { replace: true });
    return null;
  }

  const activeStance = data.stances.find((s) => s.id === data.character.active_stance_id);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-zinc-800">
        {TABS.map((t) => {
          const built = BUILT_TABS.includes(t.key);
          return (
            <button
              key={t.key}
              disabled={!built}
              onClick={() => setTab(t.key)}
              title={!built ? `Coming in Phase ${t.phase}` : undefined}
              className={`whitespace-nowrap rounded-t-md px-4 py-2 text-sm font-semibold ${
                tab === t.key
                  ? 'border-b-2 border-indigo-500 text-zinc-100'
                  : 'text-zinc-600'
              } ${!built ? 'cursor-not-allowed opacity-50' : 'hover:text-zinc-300'}`}
            >
              {t.label}
            </button>
          );
        })}
        {activeStance && (
          <span
            title="Active stance"
            className="ml-auto whitespace-nowrap rounded-full bg-indigo-600/30 px-2.5 py-0.5 text-xs font-semibold text-indigo-300"
          >
            {activeStance.name}
          </span>
        )}
      </div>

      {tab === 'core' && <CoreStatsTab data={data} />}
      {tab === 'stances' && <StancesTab data={data} />}
    </div>
  );
}

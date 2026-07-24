import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacter } from '../lib/api.js';
import CoreStatsTab from './CoreStatsTab.jsx';
import StancesTab from './StancesTab.jsx';
import MovesTab from './MovesTab.jsx';
import RoleplayTab from './RoleplayTab.jsx';
import PerksTab from './PerksTab.jsx';
import CountersTab from './CountersTab.jsx';

const TABS = [
  { key: 'core', label: 'Core Stats', phase: 1 },
  { key: 'stances', label: 'Stances', phase: 2 },
  { key: 'moves', label: 'Moves', phase: 3 },
  { key: 'perks', label: 'Perks', phase: 4 },
  { key: 'counters', label: 'Counters', phase: 5 },
  { key: 'roleplay', label: 'Role-play', phase: 3 },
];
const BUILT_TABS = ['core', 'stances', 'moves', 'perks', 'counters', 'roleplay'];

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
    // Any move-template change, or a Move/Perk grant/revoke for this
    // character (Perks can carry per-character move overrides), can alter
    // the effective move list — refetch it wholesale (cheap, always
    // consistent, avoids re-deriving the override math client-side).
    const refetchMoves = ({ characterId: cid } = {}) => {
      if (cid !== undefined && cid !== characterId) return;
      getCharacter(characterId)
        .then((fresh) => setData((prev) => (prev ? { ...prev, moves: fresh.moves } : prev)))
        .catch(() => {});
    };
    // A Perk grant/revoke also needs the perks list itself refetched — its
    // die/stamina side-effects arrive separately via die:updated/
    // character:updated, which are already handled above.
    const refetchPerks = ({ characterId: cid } = {}) => {
      if (cid !== undefined && cid !== characterId) return;
      getCharacter(characterId)
        .then((fresh) => setData((prev) => (prev ? { ...prev, perks: fresh.perks } : prev)))
        .catch(() => {});
    };
    const onRoleplayUpdated = ({ characterId: cid, entries }) => {
      if (cid !== characterId) return;
      setData((prev) => (prev ? { ...prev, roleplay: entries } : prev));
    };
    const onCounterCreated = (counter) => {
      if (counter.character_id !== characterId) return;
      setData((prev) => (prev ? { ...prev, counters: [...prev.counters, counter] } : prev));
    };
    const onCounterUpdated = (counter) => {
      if (counter.character_id !== characterId) return;
      setData((prev) =>
        prev
          ? { ...prev, counters: prev.counters.map((c) => (c.id === counter.id ? counter : c)) }
          : prev
      );
    };
    const onCounterDeleted = ({ counterId }) => {
      setData((prev) =>
        prev ? { ...prev, counters: prev.counters.filter((c) => c.id !== counterId) } : prev
      );
    };

    socket.on('move:created', refetchMoves);
    socket.on('move:updated', refetchMoves);
    socket.on('move:deleted', refetchMoves);
    socket.on('move:granted', refetchMoves);
    socket.on('move:revoked', refetchMoves);
    socket.on('perk:granted', refetchMoves);
    socket.on('perk:revoked', refetchMoves);
    socket.on('perk:granted', refetchPerks);
    socket.on('perk:revoked', refetchPerks);
    socket.on('roleplay:updated', onRoleplayUpdated);
    socket.on('character:updated', onCharacterUpdated);
    socket.on('character:deleted', onCharacterDeleted);
    socket.on('die:updated', onDieUpdated);
    socket.on('inventory:updated', onInventoryUpdated);
    socket.on('injuries:updated', onInjuriesUpdated);
    socket.on('stance:created', onStanceCreated);
    socket.on('stance:updated', onStanceUpdated);
    socket.on('stance:deleted', onStanceDeleted);
    socket.on('stance:activated', onStanceActivated);
    socket.on('counter:created', onCounterCreated);
    socket.on('counter:updated', onCounterUpdated);
    socket.on('counter:deleted', onCounterDeleted);
    return () => {
      socket.off('move:created', refetchMoves);
      socket.off('move:updated', refetchMoves);
      socket.off('move:deleted', refetchMoves);
      socket.off('move:granted', refetchMoves);
      socket.off('move:revoked', refetchMoves);
      socket.off('perk:granted', refetchMoves);
      socket.off('perk:revoked', refetchMoves);
      socket.off('perk:granted', refetchPerks);
      socket.off('perk:revoked', refetchPerks);
      socket.off('roleplay:updated', onRoleplayUpdated);
      socket.off('character:updated', onCharacterUpdated);
      socket.off('character:deleted', onCharacterDeleted);
      socket.off('die:updated', onDieUpdated);
      socket.off('inventory:updated', onInventoryUpdated);
      socket.off('injuries:updated', onInjuriesUpdated);
      socket.off('stance:created', onStanceCreated);
      socket.off('stance:updated', onStanceUpdated);
      socket.off('stance:deleted', onStanceDeleted);
      socket.off('stance:activated', onStanceActivated);
      socket.off('counter:created', onCounterCreated);
      socket.off('counter:updated', onCounterUpdated);
      socket.off('counter:deleted', onCounterDeleted);
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
      {tab === 'moves' && <MovesTab data={data} />}
      {tab === 'perks' && <PerksTab data={data} />}
      {tab === 'counters' && <CountersTab data={data} />}
      {tab === 'roleplay' && <RoleplayTab data={data} />}
    </div>
  );
}

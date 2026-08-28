import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacter } from '../lib/api.js';
import { useSocketRefresh } from '../lib/connection.js';
import CoreStatsTab from './CoreStatsTab.jsx';
import StancesTab from './StancesTab.jsx';
import MovesTab from './MovesTab.jsx';
import RoleplayTab from './RoleplayTab.jsx';
import RelationshipsTab from './RelationshipsTab.jsx';
import CharacterCreationDialog from './CharacterCreationDialog.jsx';
import PerksTab from './PerksTab.jsx';
import CountersTab from './CountersTab.jsx';

// Mobile readiness (Change 002) §8.1: the active tab scrolls itself into
// view inside the row's own horizontal scroller — same pattern as the
// Combat Arena's Tic squares (TicSquare in CombatArena.jsx).
function TabButton({ tab: t, active, built, onClick }) {
  const ref = useRef(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [active]);
  return (
    <button
      ref={ref}
      disabled={!built}
      onClick={onClick}
      title={!built ? `Coming in Phase ${t.phase}` : undefined}
      className={`relative min-h-11 shrink-0 snap-center whitespace-nowrap px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide transition-colors ${
        active ? 'text-zinc-100' : 'text-zinc-600'
      } ${!built ? 'cursor-not-allowed opacity-50' : 'hover:text-zinc-300'}`}
    >
      {t.label}
      {active && (
        <motion.span
          layoutId="tab-underline"
          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
          className="absolute inset-x-2 -bottom-px h-0.5 bg-gradient-to-r from-brand-500 to-brand-400"
        />
      )}
    </button>
  );
}

const TABS = [
  { key: 'core', label: 'Core Stats', phase: 1 },
  { key: 'stances', label: 'Stances', phase: 2 },
  { key: 'moves', label: 'Moves', phase: 3 },
  { key: 'perks', label: 'Perks', phase: 4 },
  { key: 'counters', label: 'Counters', phase: 5 },
  { key: 'roleplay', label: 'Role-play', phase: 3 },
  // PC-only (see PC_ONLY_TABS): a Relationships board belongs to a player, and
  // an NPC has nobody to keep one for.
  { key: 'relationships', label: 'Relationships', phase: 11 },
];
const BUILT_TABS = ['core', 'stances', 'moves', 'perks', 'counters', 'roleplay', 'relationships'];
const PC_ONLY_TABS = new Set(['relationships']);
// The Relationships board is the one tab that does not fit a 768px column — it
// is a canvas, and a canvas wants the whole width the page can spare.
const WIDE_TABS = new Set(['relationships']);

export default function CharacterSheet() {
  const { id } = useParams();
  const { role, characterId: myCharacterId } = useRole();
  const navigate = useNavigate();
  const [data, setData] = useState(null); // { character, dice, inventory, injuries }
  const [tab, setTab] = useState('core');
  const [creating, setCreating] = useState(false);
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

  // Mobile readiness (Change 002) §11.2: reconnect/resume resync — the
  // targeted socket listeners below already patch most live changes, but a
  // broadcast missed while disconnected/backgrounded never replays, so this
  // re-fetches the whole sheet fresh on either.
  useSocketRefresh(() => getCharacter(characterId).then(setData).catch(() => {}));

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
                      half_damage: die.half_damage,
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
    // **A Perk grant/revoke takes one fetch, not two (fix).** A Perk changes
    // both lists — it can carry per-character move overrides *and* it is itself
    // a Perk — so both `refetchMoves` and `refetchPerks` were bound to
    // `perk:granted`/`perk:revoked`. Each ran its own `getCharacter`, so one
    // click cost two full sheet reads (24 queries each) and then threw half of
    // each away. One fetch, both lists off it.
    const refetchMovesAndPerks = ({ characterId: cid } = {}) => {
      if (cid !== undefined && cid !== characterId) return;
      getCharacter(characterId)
        .then((fresh) =>
          setData((prev) => (prev ? { ...prev, moves: fresh.moves, perks: fresh.perks } : prev))
        )
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
    // The weapon is one row, replaced wholesale on every change (see
    // server/weapons.js) — so the payload IS the new state and there is nothing
    // to merge. `null` means they are carrying nothing again, which is a real
    // value here, not an absence.
    const onWeaponUpdated = ({ characterId: cid, weapon }) => {
      if (cid !== characterId) return;
      // `weaponOffers` is only meaningful on an EMPTY slot, and whether a
      // once-per-Fight charge is still there is the server's answer, not one
      // this patch can derive. So: armed, the offers are simply gone; disarmed,
      // refetch and let the server say whether anything is still on the table.
      // Losing a weapon is rare enough to afford one request, and guessing here
      // is how a spent charge would reappear as a button that then refuses.
      if (weapon) {
        setData((prev) => (prev ? { ...prev, weapon, weaponOffers: [] } : prev));
        return;
      }
      getCharacter(characterId).then(setData).catch(() => {});
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
    socket.on('perk:granted', refetchMovesAndPerks);
    socket.on('perk:revoked', refetchMovesAndPerks);
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
    socket.on('weapon:updated', onWeaponUpdated);
    return () => {
      socket.off('move:created', refetchMoves);
      socket.off('move:updated', refetchMoves);
      socket.off('move:deleted', refetchMoves);
      socket.off('move:granted', refetchMoves);
      socket.off('move:revoked', refetchMoves);
      socket.off('perk:granted', refetchMovesAndPerks);
      socket.off('perk:revoked', refetchMovesAndPerks);
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
      socket.off('weapon:updated', onWeaponUpdated);
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
  const canCreate = role === 'gm' || myCharacterId === data.character.id;

  // A canvas tab drops the column cap and takes whatever width <main> has left
  // after the chat panel; every other tab keeps the readable 768px measure.
  const visibleTabs = TABS.filter(
    (t) => !PC_ONLY_TABS.has(t.key) || data.character.character_type === 'pc'
  );

  return (
    <div className={WIDE_TABS.has(tab) ? 'mx-auto w-full' : 'mx-auto max-w-3xl'}>
      {/* Mobile readiness (Change 002) §8.1: sticky under the mobile top
          bar so it stays reachable while a tall tab's content scrolls;
          scroll-snap-x makes the horizontal tab scroll land cleanly on
          each tab instead of stopping mid-button. The active-stance badge
          moved to its own row below (was ml-auto inside this same
          scroller) so it can no longer widen the tab strip's own scroll
          content on a narrow phone. */}
      <div className="sticky top-0 z-10 -mx-2 flex items-center gap-1 overflow-x-auto overflow-y-hidden bg-zinc-950 px-2 [scrollbar-width:none] [scroll-snap-type:x_proximity] md:mx-0 md:bg-transparent md:px-0">
        {visibleTabs.map((t) => (
          <TabButton key={t.key} tab={t} active={tab === t.key} built={BUILT_TABS.includes(t.key)} onClick={() => setTab(t.key)} />
        ))}
      </div>
      {/* Character Creation (decided, new) lives beside the active-stance
          badge rather than inside a tab: it is a thing you do TO the whole
          sheet, and every tab it touches is one it would have to be
          duplicated into otherwise. Offered to the GM on any sheet, and to a
          Player on their own character — building your own fighter is the
          whole point of a guided flow, and the trust model here is the same
          one every other control in this app uses. */}
      <div className="mb-2 mt-1.5 flex items-center justify-end gap-2 border-b border-zinc-800 pb-2">
        {canCreate && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            title="Walk through building this character step by step"
            className="panel-cut-sm border border-brand-700 px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-300 hover:border-brand-500 hover:text-brand-200"
          >
            Character Creation
          </button>
        )}
        {activeStance && (
          <span
            title="Active stance"
            className="whitespace-nowrap bg-brand-600/30 px-3 py-1 text-xs font-semibold text-brand-300 [clip-path:polygon(8%_0,100%_0,92%_100%,0_100%)]"
          >
            {activeStance.name}
          </span>
        )}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >
          {tab === 'core' && <CoreStatsTab data={data} />}
          {tab === 'stances' && <StancesTab data={data} />}
          {tab === 'moves' && <MovesTab data={data} />}
          {tab === 'perks' && <PerksTab data={data} />}
          {tab === 'counters' && <CountersTab data={data} />}
          {tab === 'roleplay' && <RoleplayTab data={data} />}
          {tab === 'relationships' && <RelationshipsTab data={data} />}
        </motion.div>
      </AnimatePresence>

      {creating && (
        <CharacterCreationDialog
          character={data.character}
          // The stances they already stand in: creation ADDS a stance, so a
          // Style bought earlier still counts toward what Moves are learnable.
          stances={data.stances}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

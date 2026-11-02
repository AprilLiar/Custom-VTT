import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCharacter } from '../lib/api.js';
import { useSocketRefresh } from '../lib/connection.js';
import CharacterHeader from './CharacterHeader.jsx';
import CountersTab from './CountersTab.jsx';
import RoleplayTab from './RoleplayTab.jsx';
import RelationshipsTab from './RelationshipsTab.jsx';
import ScenePicturesEditor from './ScenePicturesEditor.jsx';
import CombatTab from './CombatTab.jsx';

// Mobile readiness (Change 002) §8.1: the active tab scrolls itself into
// view inside the row's own horizontal scroller.
function TabButton({ tab: t, active, onClick }) {
  const ref = useRef(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [active]);
  return (
    <button
      ref={ref}
      onClick={onClick}
      className={`relative min-h-11 shrink-0 snap-center whitespace-nowrap px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide transition-colors ${
        active ? 'text-zinc-100' : 'text-zinc-600 hover:text-zinc-300'
      }`}
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

// **What survives of the sheet (decided, revised — the pivot).** The old
// system's tabs — Core Stats, Stances, Moves, Perks and Quirks — went with it.
// The name and profile picture moved from Core Stats into CharacterHeader above
// the tabs, so they are still editable.
const TABS = [
  { key: 'counters', label: 'Counters' },
  // Panic at the Dojo: the combat token, Unique tokens and Reminders.
  { key: 'combat', label: 'Combat' },
  { key: 'roleplay', label: 'Role-play' },
  // PC-only (see PC_ONLY_TABS): a Relationships board belongs to a player, and
  // an NPC has nobody to keep one for.
  { key: 'relationships', label: 'Relationships' },
  // Last, always — "a new tab at the very end" (the Scene tab plan's own
  // wording). Every character gets this one, PC and NPC alike: unlike
  // Relationships (which needs a player to belong to), a Scene Picture is
  // just art, and a real NPC gets summoned onto the stage exactly like a PC.
  { key: 'scene_pictures', label: 'Scene Pictures' },
];
const PC_ONLY_TABS = new Set(['relationships']);
// The Relationships board is the one tab that does not fit a 768px column — it
// is a canvas, and a canvas wants the whole width the page can spare.
const WIDE_TABS = new Set(['relationships']);

export default function CharacterSheet() {
  const { id } = useParams();
  const { role, characterId: myCharacterId } = useRole();
  const navigate = useNavigate();
  const [data, setData] = useState(null); // { character, roleplay, counters }
  const [tab, setTab] = useState('counters');
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
      // **Merged, not replaced.** character:updated is a PARTIAL row — it
      // deliberately carries no picture bytes, only the picture's URL.
      setData((prev) =>
        prev ? { ...prev, character: { ...prev.character, ...character } } : prev
      );
    };
    const onCharacterDeleted = ({ id: deletedId }) => {
      if (deletedId === characterId) navigate('/', { replace: true });
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

    socket.on('roleplay:updated', onRoleplayUpdated);
    socket.on('character:updated', onCharacterUpdated);
    socket.on('character:deleted', onCharacterDeleted);
    socket.on('counter:created', onCounterCreated);
    socket.on('counter:updated', onCounterUpdated);
    socket.on('counter:deleted', onCounterDeleted);
    return () => {
      socket.off('roleplay:updated', onRoleplayUpdated);
      socket.off('character:updated', onCharacterUpdated);
      socket.off('character:deleted', onCharacterDeleted);
      socket.off('counter:created', onCounterCreated);
      socket.off('counter:updated', onCounterUpdated);
      socket.off('counter:deleted', onCounterDeleted);
    };
  }, [characterId, navigate]);

  if (!data) return <p className="text-zinc-500">Loading…</p>;

  // Players can't open NPC sheets — an NPC belongs to the GM.
  if (role !== 'gm' && data.character.character_type === 'npc') {
    navigate('/', { replace: true });
    return null;
  }

  const canEdit = role === 'gm' || myCharacterId === data.character.id;

  // A canvas tab drops the column cap and takes whatever width <main> has left
  // after the chat panel; every other tab keeps the readable 768px measure.
  const visibleTabs = TABS.filter(
    (t) => !PC_ONLY_TABS.has(t.key) || data.character.character_type === 'pc'
  );

  return (
    <div className={WIDE_TABS.has(tab) ? 'mx-auto w-full' : 'mx-auto max-w-3xl'}>
      <CharacterHeader character={data.character} />
      {/* Mobile readiness (Change 002) §8.1: sticky under the mobile top
          bar so it stays reachable while a tall tab's content scrolls;
          scroll-snap-x makes the horizontal tab scroll land cleanly on
          each tab instead of stopping mid-button. */}
      <div className="sticky top-0 z-10 -mx-2 mb-3 flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-zinc-800 bg-zinc-950 px-2 [scrollbar-width:none] [scroll-snap-type:x_proximity] md:mx-0 md:bg-transparent md:px-0">
        {visibleTabs.map((t) => (
          <TabButton key={t.key} tab={t} active={tab === t.key} onClick={() => setTab(t.key)} />
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >
          {tab === 'counters' && <CountersTab data={data} />}
          {tab === 'combat' && (
            <CombatTab
              ownerType="character"
              ownerId={data.character.id}
              ownerName={data.character.name}
              canEdit={canEdit}
            />
          )}
          {tab === 'roleplay' && <RoleplayTab data={data} />}
          {tab === 'relationships' && <RelationshipsTab data={data} />}
          {tab === 'scene_pictures' && (
            <ScenePicturesEditor
              ownerType="character"
              ownerId={data.character.id}
              canEdit={canEdit}
              hasPortrait={Boolean(data.character.image_url)}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

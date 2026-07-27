import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCombat, getCharacters, getCharacterFolders } from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import { dieLabel, tintFor, POOLS } from '../lib/dice.js';
import { buildFolderTree } from '../lib/folders.js';

const MIN_TARGET = 2;
const MAX_TARGET = 20;

// Read-only glance at a seated character: portrait, active stance, dice
// pools, stamina — not the full sheet. Click through to the sheet to
// actually roll/step; everything shown here stays live via the same
// character:updated/die:updated/stance:activated broadcasts the sheet
// itself listens to. Stance is shown because it's the one thing the plan
// already calls strategically visible to opponents mid-fight.
function ParticipantCard({ entry, role, onRemove, onDragStart, navigate }) {
  const { character, dice, stances } = entry;
  const src = portraitSrc(character);
  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  return (
    <div
      draggable={role === 'gm'}
      onDragStart={onDragStart}
      onClick={() => navigate(`/character/${character.id}`)}
      title="Open full sheet"
      className="group relative flex min-h-40 min-w-64 flex-1 cursor-pointer overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 hover:border-indigo-600"
    >
      {role === 'gm' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(character.id);
          }}
          title="Remove from arena"
          className="absolute right-1 top-1 z-10 rounded px-1 text-xs text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-red-900/40 hover:text-red-400"
        >
          ✕
        </button>
      )}

      {/* Portrait fills the card's full height edge-to-edge, no padding/gaps */}
      {src ? (
        <img src={src} alt="" className="h-full w-28 shrink-0 object-cover sm:w-32" />
      ) : (
        <div className="flex h-full w-28 shrink-0 items-center justify-center bg-zinc-800 text-3xl font-bold text-zinc-600 sm:w-32">
          {character.name.slice(0, 1).toUpperCase()}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{character.name}</div>
          {character.character_type === 'npc' && (
            <span className="rounded bg-purple-600/30 px-1 text-[10px] font-bold uppercase text-purple-300">
              NPC
            </span>
          )}
        </div>
        {activeStance && (
          <div className="truncate text-xs text-indigo-300" title="Active stance">
            {activeStance.name}
          </div>
        )}
        <div className="text-xs text-zinc-400">
          Stamina {character.current_stamina}/{character.max_stamina}
        </div>
        <div className="space-y-1">
          {POOLS.map((pool) => {
            const poolDice = dice.filter((d) => d.pool === pool.key);
            if (!poolDice.length) return null;
            return (
              <div key={pool.key} className="flex flex-wrap gap-1">
                {poolDice.map((d) => (
                  <span
                    key={d.id}
                    title={d.slot_name}
                    className={`rounded px-1 py-0.5 text-[10px] font-mono ${
                      d.status === 'incapacitated' ? 'text-zinc-700 line-through' : 'text-zinc-300'
                    }`}
                    style={{ backgroundColor: tintFor(d) || 'rgba(255,255,255,0.05)' }}
                  >
                    {dieLabel(d.current_size, d.bonus)}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Same pips look as the character sheet's Counters tab, adapted for the
// Arena: standalone counters show just their name, character-owned ones
// show "{CharacterName} - {CounterName}" per the plan's decided labeling.
function ArenaCounterRow({ counter, characterName }) {
  const label = characterName ? `${characterName} - ${counter.name}` : counter.name;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
      <span className="font-bold text-zinc-100">{label}</span>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: -1 })}
          disabled={counter.current_pips <= 0}
          className="h-8 w-8 shrink-0 rounded-md border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800 disabled:opacity-30"
        >
          −
        </button>
        <div
          className="flex flex-1 flex-wrap items-center justify-center gap-1.5"
          title={`${counter.current_pips} / ${counter.target_pips}`}
        >
          {Array.from({ length: counter.target_pips }, (_, i) => (
            <span
              key={i}
              className={`h-4 w-4 rounded-full border ${
                i < counter.current_pips
                  ? 'border-indigo-400 bg-indigo-500'
                  : 'border-zinc-700 bg-zinc-800'
              }`}
            />
          ))}
        </div>
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: 1 })}
          disabled={counter.current_pips >= counter.target_pips}
          className="h-8 w-8 shrink-0 rounded-md border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800 disabled:opacity-30"
        >
          +
        </button>
        <button
          onClick={() => socket.emit('counter:delete', { counterId: counter.id })}
          title="Delete"
          className="rounded px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// Every available (unseated) character inside this folder, including all
// descendant folders — what the roster's per-folder count shows, and what
// decides whether an empty subtree hides itself entirely.
function countAvailable(node, charsByFolder) {
  const direct = charsByFolder.get(node.id)?.length ?? 0;
  const childSum = node.children.reduce((sum, child) => sum + countAvailable(child, charsByFolder), 0);
  return direct + childSum;
}

// One folder row in the roster's recursive, collapsible tree. Clicking the
// header toggles collapse for its whole subtree (tracked as a Set of folder
// ids in the parent); a folder whose complete subtree has no available
// characters hides itself rather than showing an always-empty row. Direct
// characters render before child folders once expanded, per spec.
function FolderRosterNode({ node, charsByFolder, collapsed, onToggle, depth, rosterCard }) {
  const count = countAvailable(node, charsByFolder);
  if (count === 0) return null;
  const isCollapsed = collapsed.has(node.id);
  const directChars = charsByFolder.get(node.id) ?? [];
  return (
    <div>
      <button
        onClick={() => onToggle(node.id)}
        style={{ paddingLeft: `${depth * 12}px` }}
        className="flex w-full items-center gap-1 rounded-md py-1 text-left text-[10px] font-bold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
      >
        <span className="shrink-0">{isCollapsed ? '▸' : '▾'}</span>
        <span className="min-w-0 flex-1 truncate">📁 {node.name}</span>
        <span className="shrink-0 normal-case text-zinc-600">({count})</span>
      </button>
      {!isCollapsed && directChars.length > 0 && (
        <div className="space-y-2 pb-1" style={{ paddingLeft: `${depth * 12 + 10}px` }}>
          {directChars.map(rosterCard)}
        </div>
      )}
      {!isCollapsed &&
        node.children.map((child) => (
          <FolderRosterNode
            key={child.id}
            node={child}
            charsByFolder={charsByFolder}
            collapsed={collapsed}
            onToggle={onToggle}
            depth={depth + 1}
            rosterCard={rosterCard}
          />
        ))}
    </div>
  );
}

// Phase 6: structure only, no round/Tic timing yet. GM drags characters onto
// a left/right side and groups them into pairs (a side/pair_index can hold
// more than one character when Uneven Combat is on). Dice/stamina here are
// a read-only glance — rolling still happens from each character's own
// sheet, reachable by clicking their card.
export default function CombatArena() {
  const { role } = useRole();
  const navigate = useNavigate();
  const [combat, setCombat] = useState(null); // { unevenCombatEnabled, participants, characters, counters }
  const [roster, setRoster] = useState(null);
  const [folders, setFolders] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // `${side}-${pairIndex}` | null
  const [counterName, setCounterName] = useState('');
  const [counterTarget, setCounterTarget] = useState(6);
  const [collapsedFolders, setCollapsedFolders] = useState(new Set()); // roster folder ids, collapsed

  useEffect(() => {
    const refresh = () => {
      getCombat().then(setCombat).catch(console.error);
      getCharacters().then(setRoster).catch(console.error);
      getCharacterFolders().then(setFolders).catch(console.error);
    };
    refresh();
    const events = [
      'combat:updated',
      'character:created', 'character:deleted',
      'counter:created', 'counter:updated', 'counter:deleted',
      'stance:created', 'stance:updated', 'stance:deleted',
      'character_folder:created', 'character_folder:updated', 'character_folder:deleted',
    ];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  // Live dice/stamina patching for whoever's currently seated — same
  // fine-grained approach as CharacterSheet.jsx, so a die click anywhere
  // doesn't force a full re-fetch of every seated character.
  useEffect(() => {
    const onCharacterUpdated = (character) => {
      setCombat((prev) =>
        prev?.characters[character.id]
          ? {
              ...prev,
              characters: {
                ...prev.characters,
                [character.id]: { ...prev.characters[character.id], character },
              },
            }
          : prev
      );
    };
    const onDieUpdated = (die) => {
      setCombat((prev) => {
        const entry = prev?.characters[die.characterId];
        if (!entry) return prev;
        return {
          ...prev,
          characters: {
            ...prev.characters,
            [die.characterId]: {
              ...entry,
              dice: entry.dice.map((d) =>
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
            },
          },
        };
      });
    };
    const onStanceActivated = ({ characterId, stanceId }) => {
      setCombat((prev) => {
        const entry = prev?.characters[characterId];
        if (!entry) return prev;
        return {
          ...prev,
          characters: {
            ...prev.characters,
            [characterId]: { ...entry, character: { ...entry.character, active_stance_id: stanceId } },
          },
        };
      });
    };
    socket.on('character:updated', onCharacterUpdated);
    socket.on('die:updated', onDieUpdated);
    socket.on('stance:activated', onStanceActivated);
    return () => {
      socket.off('character:updated', onCharacterUpdated);
      socket.off('die:updated', onDieUpdated);
      socket.off('stance:activated', onStanceActivated);
    };
  }, []);

  if (!combat || !roster || !folders) return <p className="text-zinc-500">Loading…</p>;

  const { unevenCombatEnabled, participants, characters, counters } = combat;
  const seatedIds = new Set(participants.map((p) => p.character_id));
  const visibleRoster = role === 'gm' ? roster : roster.filter((c) => c.character_type === 'pc');
  const availableCharacters = visibleRoster.filter((c) => !seatedIds.has(c.id));
  // Folders render first (recursive, collapsible, alphabetical at every
  // level, hidden entirely when their whole subtree has nobody available),
  // then folderless characters last under their own heading.
  const rootCharacters = availableCharacters.filter((c) => c.folder_id == null);
  const availableByFolder = new Map();
  for (const c of availableCharacters) {
    if (c.folder_id == null) continue;
    if (!availableByFolder.has(c.folder_id)) availableByFolder.set(c.folder_id, []);
    availableByFolder.get(c.folder_id).push(c);
  }
  const rosterFolderTree = buildFolderTree(folders);
  const toggleFolderCollapse = (folderId) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });

  const pairIndices = [...new Set(participants.map((p) => p.pair_index))].sort((a, b) => a - b);
  const rows = [...pairIndices, pairIndices.length ? pairIndices[pairIndices.length - 1] + 1 : 0];

  const onDrop = (e, side, pairIndex) => {
    e.preventDefault();
    setDropTarget(null);
    const characterId = Number(e.dataTransfer.getData('text/character-id'));
    if (!characterId) return;
    const event = seatedIds.has(characterId) ? 'combat:move_participant' : 'combat:add_participant';
    socket.emit(event, { characterId, side, pairIndex });
  };

  const remove = (characterId) => socket.emit('combat:remove_participant', { characterId });

  const rosterCard = (c) => {
    const src = portraitSrc(c);
    return (
      <div
        key={c.id}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(c.id))}
        title="Drag onto a side to seat them"
        className="flex cursor-grab items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2 active:cursor-grabbing"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-800 text-sm font-bold text-zinc-600">
          {src ? (
            <img src={src} alt="" className="h-full w-full object-cover" />
          ) : (
            c.name.slice(0, 1).toUpperCase()
          )}
        </div>
        <span className="truncate text-sm text-zinc-300">{c.name}</span>
        {c.character_type === 'npc' && (
          <span className="ml-auto rounded bg-purple-600/30 px-1 text-[10px] font-bold uppercase text-purple-300">
            NPC
          </span>
        )}
      </div>
    );
  };

  const addCounter = (e) => {
    e.preventDefault();
    if (!counterName.trim()) return;
    socket.emit('counter:create', {
      characterId: null,
      name: counterName.trim(),
      targetPips: counterTarget,
    });
    setCounterName('');
    setCounterTarget(6);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Combat Arena</h1>
        <div className="flex items-center gap-3">
          {role === 'gm' ? (
            <label className="flex items-center gap-1.5 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={unevenCombatEnabled}
                onChange={() => socket.emit('combat:toggle_uneven', {})}
              />
              Uneven Combat
            </label>
          ) : (
            unevenCombatEnabled && (
              <span className="rounded-full bg-amber-600/30 px-2 py-0.5 text-xs font-semibold text-amber-300">
                Uneven Combat
              </span>
            )
          )}
          {role === 'gm' && participants.length > 0 && (
            <button
              onClick={() =>
                window.confirm('Clear the arena? Everyone currently seated is removed.') &&
                socket.emit('combat:clear', {})
              }
              className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              Clear Arena
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          {participants.length === 0 && (
            <p className="text-sm text-zinc-600">
              No one in the arena yet.
              {role === 'gm' ? ' Drag characters from the roster to start a fight.' : ''}
            </p>
          )}

          {rows.map((rowIdx) => {
            const leftOccupants = participants.filter((p) => p.side === 'left' && p.pair_index === rowIdx);
            const rightOccupants = participants.filter((p) => p.side === 'right' && p.pair_index === rowIdx);
            const leftKey = `left-${rowIdx}`;
            const rightKey = `right-${rowIdx}`;
            return (
              <div key={rowIdx} className="flex items-stretch gap-3">
                <div
                  onDragOver={(e) => {
                    if (role !== 'gm') return;
                    e.preventDefault();
                    setDropTarget(leftKey);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => role === 'gm' && onDrop(e, 'left', rowIdx)}
                  className={`flex min-h-24 flex-1 gap-2 overflow-x-auto rounded-lg border border-dashed p-2 ${
                    dropTarget === leftKey ? 'border-indigo-400 bg-indigo-950/20' : 'border-zinc-800'
                  }`}
                >
                  {leftOccupants.map(
                    (p) =>
                      characters[p.character_id] && (
                        <ParticipantCard
                          key={p.character_id}
                          entry={characters[p.character_id]}
                          role={role}
                          onRemove={remove}
                          navigate={navigate}
                          onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(p.character_id))}
                        />
                      )
                  )}
                </div>
                <div className="w-px shrink-0 bg-zinc-700/50" title="Pair divider" />
                <div
                  onDragOver={(e) => {
                    if (role !== 'gm') return;
                    e.preventDefault();
                    setDropTarget(rightKey);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => role === 'gm' && onDrop(e, 'right', rowIdx)}
                  className={`flex min-h-24 flex-1 gap-2 overflow-x-auto rounded-lg border border-dashed p-2 ${
                    dropTarget === rightKey ? 'border-indigo-400 bg-indigo-950/20' : 'border-zinc-800'
                  }`}
                >
                  {rightOccupants.map(
                    (p) =>
                      characters[p.character_id] && (
                        <ParticipantCard
                          key={p.character_id}
                          entry={characters[p.character_id]}
                          role={role}
                          onRemove={remove}
                          navigate={navigate}
                          onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(p.character_id))}
                        />
                      )
                  )}
                </div>
              </div>
            );
          })}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-400">Counters</h2>
            {counters.length === 0 ? (
              <p className="text-sm text-zinc-600">No counters shown here yet.</p>
            ) : (
              <div className="space-y-2">
                {counters.map((c) => (
                  <ArenaCounterRow
                    key={c.id}
                    counter={c}
                    characterName={c.character_id ? characters[c.character_id]?.character.name : null}
                  />
                ))}
              </div>
            )}
            {role === 'gm' && (
              <form onSubmit={addCounter} className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
                <input
                  value={counterName}
                  onChange={(e) => setCounterName(e.target.value)}
                  placeholder="Standalone counter name"
                  className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                />
                <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                  Target
                  <input
                    type="number"
                    min={MIN_TARGET}
                    max={MAX_TARGET}
                    value={counterTarget}
                    onChange={(e) =>
                      setCounterTarget(
                        Math.max(MIN_TARGET, Math.min(MAX_TARGET, Number(e.target.value) || MIN_TARGET))
                      )
                    }
                    className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                  />
                </label>
                <button
                  type="submit"
                  disabled={!counterName.trim()}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
                >
                  + New Arena Counter
                </button>
              </form>
            )}
          </div>
        </div>

        {role === 'gm' && (
          <aside className="hidden w-44 shrink-0 sm:block">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
              Roster (drag to seat)
            </h2>
            <div className="space-y-1">
              {rosterFolderTree.map((node) => (
                <FolderRosterNode
                  key={node.id}
                  node={node}
                  charsByFolder={availableByFolder}
                  collapsed={collapsedFolders}
                  onToggle={toggleFolderCollapse}
                  depth={0}
                  rosterCard={rosterCard}
                />
              ))}
              {rootCharacters.length > 0 && (
                <div className="pt-2">
                  <h3 className="mb-1 text-[10px] font-bold uppercase tracking-wide text-zinc-600">
                    Folderless
                  </h3>
                  <div className="space-y-2">{rootCharacters.map(rosterCard)}</div>
                </div>
              )}
              {availableCharacters.length === 0 && (
                <p className="text-xs text-zinc-600">Everyone is seated.</p>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

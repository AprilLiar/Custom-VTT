import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import {
  getCombat,
  getCharacters,
  getCharacterFolders,
  getTells,
  getTags,
  getRuleset,
  getMoves,
} from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import { dieLabel, tintFor, POOLS } from '../lib/dice.js';
import { buildFolderTree, folderPath } from '../lib/folders.js';
import { REWARD_LABELS, REWARD_COLORS } from '../lib/counterDisplay.js';
import MoveCard from './MoveCard.jsx';
import Thumb from './Thumb.jsx';

const MIN_TARGET = 2;
const MAX_TARGET = 20;

// Read-only glance at a seated character: portrait, active stance, dice
// pools, stamina — not the full sheet. Click through to the sheet to
// actually roll/step; everything shown here stays live via the same
// character:updated/die:updated/stance:activated broadcasts the sheet
// itself listens to. Stance is shown because it's the one thing the plan
// already calls strategically visible to opponents mid-fight.
function ParticipantCard({
  entry,
  role,
  onRemove,
  onDragStart,
  navigate,
  declaredMoves,
  ownDeclares,
  sideStillDeclaring,
}) {
  const { character, dice, stances } = entry;
  const src = portraitSrc(character);
  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  // Would-be Stamina after every move this client itself declared this
  // window, purely a visual preview — the real current_stamina isn't
  // touched until the side actually finishes declaring (see
  // combat:side_done_declaring server-side). Only computable for moves
  // THIS client declared (staminaCost never rides the public broadcast —
  // see move:declare — so an opponent's pending cost stays hidden, same
  // secrecy as the move's identity).
  const pendingCost = sideStillDeclaring
    ? declaredMoves
        .filter((dm) => dm.characterId === character.id && ownDeclares.has(dm.id))
        .reduce((sum, dm) => sum + (ownDeclares.get(dm.id).staminaCost ?? 0), 0)
    : 0;
  const previewStamina = character.current_stamina - pendingCost;
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
        <div
          className={`text-xs ${
            pendingCost === 0
              ? 'text-zinc-400'
              : pendingCost > 0
                ? 'font-semibold text-red-400'
                : 'font-semibold text-emerald-400'
          }`}
          title={
            pendingCost !== 0
              ? `Pending, not yet confirmed: ${pendingCost > 0 ? '-' : '+'}${Math.abs(pendingCost)} Stamina`
              : undefined
          }
        >
          Stamina {pendingCost !== 0 ? previewStamina : character.current_stamina}/{character.max_stamina}
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
      {/* Character-owned counters only ever carry a reward — a standalone
          counter never has one — but this stays read-only display here
          either way; editing it happens on the character's own sheet. */}
      {counter.reward_type && (
        <span
          className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${REWARD_COLORS[counter.reward_type]}`}
        >
          {REWARD_LABELS[counter.reward_type]}
        </span>
      )}
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

// The secret face: just the Tell (or both Tells side by side, for a move
// with an ambiguous Left/Right Roll), greyed out — a move can be declared
// to land at any open Tic, so unlike the old text badge this deliberately
// shows no timing/length hint at all, only identity-via-Tell.
function DeclaredMoveTellFace({ dm, tellById }) {
  const rightTell = dm.rightTellId ? tellById.get(dm.rightTellId) : null;
  const leftTell = dm.leftTellId ? tellById.get(dm.leftTellId) : null;
  const tell = tellById.get(dm.tellId);
  return (
    <div className="flex w-64 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 opacity-60 grayscale">
      {rightTell || leftTell ? (
        <>
          <Thumb record={rightTell} name={rightTell?.name} size="h-8 w-8" />
          <Thumb record={leftTell} name={leftTell?.name} size="h-8 w-8" />
          <span className="min-w-0 truncate text-xs font-semibold uppercase text-zinc-500">
            {rightTell?.name ?? '?'} / {leftTell?.name ?? '?'}
          </span>
        </>
      ) : (
        <>
          <Thumb record={tell} name={tell?.name} size="h-8 w-8" />
          <span className="min-w-0 truncate text-xs font-semibold uppercase text-zinc-500">
            {tell?.name ?? 'Tell'}
          </span>
        </>
      )}
    </div>
  );
}

// A declared move as a small flip card: the grey Tell-only face above until
// this client's own declare or the real reveal Tic, then a Framer Motion
// flip (rotate + cross-fade, since the two faces are very different sizes —
// a literal double-sided 3D flip would force the small face into the big
// one's footprint) swaps in the full MoveCard.
function DeclaredMoveFlipCard({ dm, move, tellById, tagById, styleById, moveFolders }) {
  const revealed = dm.isRevealed && move;
  return (
    <div style={{ perspective: 1200 }}>
      <AnimatePresence mode="wait" initial={false}>
        {revealed ? (
          <motion.div
            key="back"
            initial={{ rotateY: -90, opacity: 0 }}
            animate={{ rotateY: 0, opacity: 1 }}
            exit={{ rotateY: 90, opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeInOut' }}
            className="w-64"
          >
            <MoveCard
              move={move}
              tell={tellById.get(move.tell_id)}
              rightTell={move.right_tell_id ? tellById.get(move.right_tell_id) : null}
              leftTell={move.left_tell_id ? tellById.get(move.left_tell_id) : null}
              style={move.style_attribute_id ? styleById.get(move.style_attribute_id) : null}
              tags={(move.tag_ids ?? []).map((id) => tagById.get(id)).filter(Boolean)}
              folderLabel={folderPath(move.folder_id, moveFolders) ?? undefined}
            />
          </motion.div>
        ) : (
          <motion.div
            key="front"
            initial={{ rotateY: 90, opacity: 0 }}
            animate={{ rotateY: 0, opacity: 1 }}
            exit={{ rotateY: -90, opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeInOut' }}
          >
            <DeclaredMoveTellFace dm={dm} tellById={tellById} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Every seated character's declared moves (any round — an overflowing move
// still pending from a previous round stays visible, same as the badges
// this replaced), each as a DeclaredMoveFlipCard.
function DeclaredMovesPanel({ participants, characters, declaredMoves, tellById, tagById, styleById, moveFolders }) {
  const byCharacter = new Map();
  for (const dm of declaredMoves) {
    if (!byCharacter.has(dm.characterId)) byCharacter.set(dm.characterId, []);
    byCharacter.get(dm.characterId).push(dm);
  }
  const seatedOrder = participants.map((p) => p.character_id).filter((id) => byCharacter.has(id));
  if (!seatedOrder.length) return null;

  return (
    <div className="mt-2 space-y-2 border-t border-zinc-800 pt-2">
      {seatedOrder.map((characterId) => (
        <div key={characterId} className="flex flex-wrap items-start gap-2">
          <div className="w-24 shrink-0 pt-2 text-xs text-zinc-400">
            {characters[characterId]?.character.name ?? '—'}
          </div>
          <div className="flex flex-1 flex-wrap gap-2">
            {byCharacter
              .get(characterId)
              .sort((a, b) => a.placementTic - b.placementTic)
              .map((dm) => (
                <DeclaredMoveFlipCard
                  key={dm.id}
                  dm={dm}
                  move={characters[characterId]?.moves?.find((m) => m.id === dm.moveId)}
                  tellById={tellById}
                  tagById={tagById}
                  styleById={styleById}
                  moveFolders={moveFolders}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Phase 7 status bar: round/phase, per-side declare sequencing (server-
// enforced — see combat:side_done_declaring), and the Tic Countdown's
// forward/back controls. "Done Declaring" is open-access (same trust model
// as declaring itself); Next Round/Start Tic Countdown/Tic forward-back are
// GM-only client-side, matching the plan's own event contract. Below the
// controls, DeclaredMovesPanel shows every seated character's declared
// moves as flip cards (see above).
function CombatTimingBar({
  combat,
  role,
  hasParticipants,
  participants,
  characters,
  declaredMoves,
  tellById,
  tagById,
  styleById,
  moveFolders,
}) {
  const { phase, roundNumber, declaringSide, relativeTic, roundLength, isOverflow, overflowBy } = combat;
  if (phase == null && !hasParticipants) return null;
  return (
    <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-bold text-zinc-200">
          {phase == null ? 'Not started' : `Round ${roundNumber}`}
        </span>
        {phase === 'declaration' && (
          <>
            <span className="text-zinc-400">
              {declaringSide
                ? `${declaringSide === 'left' ? 'Left' : 'Right'} is declaring…`
                : 'Declarations complete'}
            </span>
            {declaringSide && (
              <button
                onClick={() => socket.emit('combat:side_done_declaring', { side: declaringSide })}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {declaringSide === 'left' ? 'Left' : 'Right'} done declaring
              </button>
            )}
            {role === 'gm' && !declaringSide && (
              <button
                onClick={() => socket.emit('combat:start_tic_countdown', {})}
                className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold hover:bg-indigo-500"
              >
                Start Tic Countdown
              </button>
            )}
          </>
        )}
        {phase === 'tic_countdown' && (
          <>
            <span className="text-zinc-400">
              Tic {relativeTic} / {roundLength}
              {isOverflow && <span className="ml-1 text-amber-400">(overflow +{overflowBy})</span>}
            </span>
            {role === 'gm' && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => socket.emit('combat:tic_backward', {})}
                  title="Tic back"
                  className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                >
                  ◀
                </button>
                <button
                  onClick={() => socket.emit('combat:tic_forward', {})}
                  title="Tic forward"
                  className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                >
                  ▶
                </button>
              </div>
            )}
          </>
        )}
        {role === 'gm' && phase !== 'declaration' && hasParticipants && (
          <button
            onClick={() => socket.emit('combat:next_round', {})}
            className="ml-auto rounded-md bg-emerald-700 px-2 py-1 text-xs font-semibold hover:bg-emerald-600"
          >
            Next Round
          </button>
        )}
      </div>
      <DeclaredMovesPanel
        participants={participants}
        characters={characters}
        declaredMoves={declaredMoves}
        tellById={tellById}
        tagById={tagById}
        styleById={styleById}
        moveFolders={moveFolders}
      />
    </div>
  );
}

// Declaration Phase's declare-a-move picker — one row per seated character
// on whichever side may currently declare (server-enforced; this is purely
// a courtesy filter so the UI doesn't offer a button that'd just be
// rejected). A styled move dims/disables the same way Tab 3 does: usable
// only while it matches one of the two styles in the character's active
// stance.
function DeclareMoveRow({ entry, onDeclare }) {
  const { character, stances, moves } = entry;
  const [moveId, setMoveId] = useState('');
  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  const activeStyles = activeStance ? [activeStance.attribute_a_id, activeStance.attribute_b_id] : [];
  const usable = (move) => move.style_attribute_id == null || activeStyles.includes(move.style_attribute_id);
  const usableMoves = (moves ?? []).filter(usable);
  return (
    <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-2">
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{character.name}</span>
      <select
        value={moveId}
        onChange={(e) => setMoveId(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200"
      >
        <option value="">Declare a move…</option>
        {usableMoves.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.stamina_cost > 0 ? `-${m.stamina_cost}` : m.stamina_cost < 0 ? `+${-m.stamina_cost}` : '0'} Stamina)
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          if (!moveId) return;
          onDeclare(character.id, Number(moveId));
          setMoveId('');
        }}
        disabled={!moveId}
        className="shrink-0 rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold hover:bg-indigo-500 disabled:opacity-40"
      >
        Declare
      </button>
    </div>
  );
}

// Phase 6 shipped structure only; Phase 7 adds round/Tic timing on top (see
// CombatTimingBar/DeclareMoveRow above). GM drags characters onto a
// left/right side and groups them into pairs (a side/pair_index can hold
// more than one character when Uneven Combat is on). Dice/stamina here are
// a read-only glance — rolling still happens from each character's own
// sheet, reachable by clicking their card.
export default function CombatArena() {
  const { role } = useRole();
  const navigate = useNavigate();
  const [combat, setCombat] = useState(null); // { unevenCombatEnabled, participants, characters, counters, ...Phase 7 timing state, declaredMoves }
  const [roster, setRoster] = useState(null);
  const [folders, setFolders] = useState(null);
  const [tells, setTells] = useState(null);
  // Only needed to render a declared move's revealed face as the same full
  // MoveCard Tab 3/Compendium use (style icon, tags, discipline path).
  const [tags, setTags] = useState(null);
  const [ruleset, setRuleset] = useState(null);
  const [moveFolders, setMoveFolders] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // `${side}-${pairIndex}` | null
  const [counterName, setCounterName] = useState('');
  const [counterTarget, setCounterTarget] = useState(6);
  const [collapsedFolders, setCollapsedFolders] = useState(new Set()); // roster folder ids, collapsed

  useEffect(() => {
    const refresh = () => {
      getCombat().then(setCombat).catch(console.error);
      getCharacters().then(setRoster).catch(console.error);
      getCharacterFolders().then(setFolders).catch(console.error);
      getTells().then(setTells).catch(console.error);
      getTags().then(setTags).catch(console.error);
      getRuleset().then(setRuleset).catch(console.error);
      getMoves().then((d) => setMoveFolders(d.folders)).catch(console.error);
    };
    refresh();
    const events = [
      'combat:updated',
      'character:created', 'character:deleted',
      'counter:created', 'counter:updated', 'counter:deleted',
      'stance:created', 'stance:updated', 'stance:deleted',
      'character_folder:created', 'character_folder:updated', 'character_folder:deleted',
      'tell:created', 'tell:updated', 'tell:deleted',
      'tag:created', 'tag:updated', 'tag:deleted',
      'folder:created', 'folder:updated', 'folder:deleted',
    ];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  // The server withholds a declared move's real identity from everyone but
  // the declaring client (no-auth means it can't tell who "owns" a socket
  // otherwise — see the plan's known limitation). declared_move:own arrives
  // only on the socket that actually declared it; remembered here so this
  // client keeps showing its own move as revealed even though every
  // combat:updated refresh still brings back the redacted Tell-only version.
  // staminaCost rides along the same own-only channel (never the public
  // broadcast — see move:declare server-side) so the pending-Stamina
  // preview below is exactly as secret as the move's identity: only this
  // client, for moves it declared itself, can compute it before reveal.
  const [ownDeclares, setOwnDeclares] = useState(new Map()); // declaredMoveId -> {moveId, moveName, staminaCost}
  useEffect(() => {
    const onOwnDeclare = (dm) =>
      setOwnDeclares((prev) =>
        new Map(prev).set(dm.id, { moveId: dm.moveId, moveName: dm.moveName, staminaCost: dm.staminaCost })
      );
    socket.on('declared_move:own', onOwnDeclare);
    return () => socket.off('declared_move:own', onOwnDeclare);
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

  if (!combat || !roster || !folders || !tells || !tags || !ruleset || !moveFolders) {
    return <p className="text-zinc-500">Loading…</p>;
  }

  const { unevenCombatEnabled, participants, characters, counters, declaringSide, phase } = combat;
  const tellById = new Map(tells.map((t) => [t.id, t]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const styleById = new Map(ruleset.attributes.map((a) => [a.id, a]));
  const declaredMoves = combat.declaredMoves.map((dm) =>
    ownDeclares.has(dm.id) ? { ...dm, ...ownDeclares.get(dm.id), isRevealed: true } : dm
  );
  const declareForSide = (side) =>
    participants.filter((p) => p.side === side).map((p) => characters[p.character_id]).filter(Boolean);
  const onDeclareMove = (characterId, moveId) => socket.emit('move:declare', { characterId, moveId });
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

      <CombatTimingBar
        combat={combat}
        role={role}
        hasParticipants={participants.length > 0}
        participants={participants}
        characters={characters}
        declaredMoves={declaredMoves}
        tellById={tellById}
        tagById={tagById}
        styleById={styleById}
        moveFolders={moveFolders}
      />

      {combat.phase === 'declaration' && declaringSide && declareForSide(declaringSide).length > 0 && (
        <div className="mb-3 space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-500">
            {declaringSide === 'left' ? 'Left' : 'Right'} declaring
          </h2>
          {declareForSide(declaringSide).map((entry) => (
            <DeclareMoveRow key={entry.character.id} entry={entry} onDeclare={onDeclareMove} />
          ))}
        </div>
      )}

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
                          declaredMoves={declaredMoves}
                          ownDeclares={ownDeclares}
                          sideStillDeclaring={phase === 'declaration' && declaringSide === p.side}
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
                          declaredMoves={declaredMoves}
                          ownDeclares={ownDeclares}
                          sideStillDeclaring={phase === 'declaration' && declaringSide === p.side}
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

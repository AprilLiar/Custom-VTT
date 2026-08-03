import { useEffect, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { socket } from '../socket.js';
import { getChat, getCharacters, getTells, getTags, getRuleset, getMoves } from '../lib/api.js';
import { fileToChatImage } from '../lib/image.js';
import { folderPath } from '../lib/folders.js';
import { useRole } from '../roleContext.jsx';
import Thumb from './Thumb.jsx';
import FrameBar from './FrameBar.jsx';
import MoveCard from './MoveCard.jsx';
import DiceIcon from './DiceIcon.jsx';
import DamageApplicationDialog from './DamageApplicationDialog.jsx';
import ResolveDefenseDialog from './ResolveDefenseDialog.jsx';

// Combat Automation (Phase 9, sub-phase 4 — 4.1's damage formula):
// halfDamageSteps = floor(result / 5), damage = halfDamageSteps * 0.5.
// Duplicated client-side rather than importing server/combatDamage.js (a
// server-only module) — same precedent as snapshotPhaseColorAt below
// already duplicating phaseAtTic's own logic for the same reason.
function computeHitDamage(result) {
  const halfDamageSteps = Math.max(0, Math.floor(result / 5));
  return { halfDamageSteps, damage: halfDamageSteps * 0.5 };
}

const DICE_TRAY_SIZES = [4, 6, 8, 10, 12];

// Phase colors match FrameBar/the live Tic Counter's own footprint palette
// (see CombatArena.jsx's DECLARED_PHASE_COLOR/TicSquare zoneStyle) so a
// snapshot reads consistently with the Arena itself.
const SNAPSHOT_PHASE_COLOR = {
  startup: 'bg-amber-500',
  active: 'bg-rose-500',
  recovery: 'bg-blue-500',
  defense: 'bg-emerald-500',
};

// Which phase(s) `move` occupies at `tic` — an array since two different
// characters' moves in the same lane can genuinely overlap the same Tic
// (both throwing at once); each gets its own thin colored segment in that
// square rather than one hiding the other.
function snapshotPhaseColorAt(move, tic) {
  if (tic < move.placementTic || tic >= move.recoveryEndTic) return null;
  const offset = tic - move.placementTic;
  if (move.defenseFramePositions?.includes(offset)) return SNAPSHOT_PHASE_COLOR.defense;
  if (tic < move.revealTic) return SNAPSHOT_PHASE_COLOR.startup;
  if (tic < move.activeEndTic) return SNAPSHOT_PHASE_COLOR.active;
  return SNAPSHOT_PHASE_COLOR.recovery;
}

// A cumulative per-lane Tic Counter snapshot (decided, Chat Log redesign,
// item 4): posted fresh every time any move in the lane reveals, so the
// chat log ends up with a full history of how that lane's Tic Counter
// filled in over the round — the LAST snapshot for a given lane/round shows
// every move that ultimately revealed, each in its true position. PC move
// bars sit above the shared Tic strip, NPC bars below (matches the seating
// convention the Declaration Lanes already use — see CombatArena.jsx). Each
// bar spans exactly the Tics its move's footprint occupies, clipped to this
// round's own window (a carried-over move's earlier Tics belong to a past
// snapshot, not this one — see overlapsRoundWindow server-side). Clicking a
// bar re-uses the same Genius Observer honor-system gate the old single-move
// card had, expanding the full MoveCard for just that move.
function LaneSnapshotCard({ entry, moveInfo }) {
  const [expandedId, setExpandedId] = useState(null);
  const { roundNumber, roundStartTic, roundLength, moves } = entry;
  const pcMoves = moves.filter((m) => m.characterType === 'pc');
  const npcMoves = moves.filter((m) => m.characterType === 'npc');
  const gridStyle = { gridTemplateColumns: `repeat(${roundLength}, minmax(0, 1fr))` };
  const windowEnd = roundStartTic + roundLength;

  const barStyle = (move) => {
    const start = Math.max(move.placementTic, roundStartTic);
    const end = Math.min(move.recoveryEndTic, windowEnd);
    return { gridColumn: `${start - roundStartTic + 1} / ${end - roundStartTic + 1}` };
  };

  const toggleExpanded = (move) => {
    if (expandedId === move.declaredMoveId) {
      setExpandedId(null);
    } else if (window.confirm('Does your character have the Genius Observer Perk?')) {
      setExpandedId(move.declaredMoveId);
    }
  };

  const MoveBar = ({ move }) => (
    <button
      type="button"
      onClick={() => toggleExpanded(move)}
      style={barStyle(move)}
      title={`${move.characterName}: ${move.moveName}`}
      className="flex min-w-0 items-center gap-1 truncate panel-cut-sm border border-zinc-700 bg-zinc-800/80 px-1 py-0.5 text-left text-[10px] text-zinc-200 hover:border-brand-600"
    >
      <span className="truncate font-semibold">{move.characterName}</span>
      <span className="truncate text-zinc-400">{move.moveName}</span>
    </button>
  );

  const expandedMove = moves.find((m) => m.declaredMoveId === expandedId);

  return (
    <div className="mt-1 w-full space-y-1 panel-cut-sm bg-zinc-800/60 p-1.5">
      <div className="font-display text-[9px] font-bold uppercase tracking-wide text-zinc-600">
        Round {roundNumber}
      </div>
      {pcMoves.length > 0 && (
        <div className="grid gap-1" style={gridStyle}>
          {pcMoves.map((m) => (
            <MoveBar key={m.declaredMoveId} move={m} />
          ))}
        </div>
      )}
      <div className="grid gap-0.5" style={gridStyle}>
        {Array.from({ length: roundLength }, (_, i) => {
          const tic = roundStartTic + i;
          const colors = moves.map((m) => snapshotPhaseColorAt(m, tic)).filter(Boolean);
          return (
            <div
              key={tic}
              className="flex h-5 items-stretch overflow-hidden border border-zinc-700 bg-zinc-900 text-[9px] font-bold text-zinc-500"
            >
              {colors.length === 0 ? (
                <span className="flex flex-1 items-center justify-center">{i + 1}</span>
              ) : (
                colors.map((c, ci) => (
                  <span key={ci} className={`flex flex-1 items-center justify-center text-zinc-950 ${c}`}>
                    {ci === 0 ? i + 1 : ''}
                  </span>
                ))
              )}
            </div>
          );
        })}
      </div>
      {npcMoves.length > 0 && (
        <div className="grid gap-1" style={gridStyle}>
          {npcMoves.map((m) => (
            <MoveBar key={m.declaredMoveId} move={m} />
          ))}
        </div>
      )}
      {expandedMove && (
        <div className="border-t border-zinc-700 pt-1.5">
          {expandedMove.full && moveInfo ? (
            <MoveCard
              move={expandedMove.full}
              tell={moveInfo.tellById.get(expandedMove.full.tell_id)}
              rightTell={
                expandedMove.full.right_tell_id ? moveInfo.tellById.get(expandedMove.full.right_tell_id) : null
              }
              leftTell={expandedMove.full.left_tell_id ? moveInfo.tellById.get(expandedMove.full.left_tell_id) : null}
              style={
                expandedMove.full.style_attribute_id
                  ? moveInfo.styleById.get(expandedMove.full.style_attribute_id)
                  : null
              }
              tags={(expandedMove.full.tag_ids ?? []).map((id) => moveInfo.tagById.get(id)).filter(Boolean)}
              folderLabel={folderPath(expandedMove.full.folder_id, moveInfo.moveFolders) ?? undefined}
            />
          ) : (
            <div className="text-xs text-zinc-400">
              {expandedMove.description ? (
                <p className="whitespace-pre-wrap break-words">{expandedMove.description}</p>
              ) : (
                <p className="italic text-zinc-600">No description.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Entry({ entry, character, moveInfo, characters, defenseResolutions }) {
  const [expanded, setExpanded] = useState(false);
  const [openDialog, setOpenDialog] = useState(null); // 'apply' | 'resolve' | null
  const { role } = useRole();
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const multi = entry.kind === 'roll' && entry.dice.length > 1;
  return (
    <div className="flex gap-2 border-b border-zinc-800 px-3 py-2 text-sm">
      <Thumb
        record={character}
        name={entry.characterName}
        size="h-6 w-6"
        cut="rounded-full"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-display font-semibold text-zinc-200">{entry.characterName}</span>
          <span className="font-display ml-auto text-xs text-zinc-600">{time}</span>
        </div>
        {entry.kind === 'message' ? (
          <div className="mt-1">
            {entry.message && (
              <p className="font-display whitespace-pre-wrap break-words text-zinc-300">{entry.message}</p>
            )}
            {entry.imageData && (
              <img
                src={`data:${entry.imageMimeType || 'image/png'};base64,${entry.imageData}`}
                alt=""
                className="mt-1 max-h-64 max-w-full panel-cut-sm object-contain"
              />
            )}
          </div>
        ) : entry.kind === 'lane_snapshot' ? (
          <LaneSnapshotCard entry={entry} moveInfo={moveInfo} />
        ) : entry.kind === 'move_reveal' ? (
          entry.move ? (
            <div className="mt-1 w-full panel-cut-sm bg-zinc-800/60 p-1.5">
              <button
                type="button"
                onClick={() => {
                  // Interim honor-system gate (decided) — asks rather than
                  // checking real Perk ownership automatically; a later pass
                  // is expected to replace this with an actual check against
                  // the logged-in character's granted Perks.
                  if (expanded) {
                    setExpanded(false);
                  } else if (window.confirm('Does your character have the Genius Observer Perk?')) {
                    setExpanded(true);
                  }
                }}
                title={expanded ? 'Click to collapse' : 'Click to show the full move'}
                className="flex w-full items-center gap-2 text-left hover:opacity-80"
              >
                <Thumb record={{ image_data: entry.move.imageData, image_mime_type: entry.move.imageMimeType }} name={entry.move.name} size="h-8 w-8" />
                <div className="min-w-0 flex-1">
                  <div className="font-display truncate text-sm font-semibold text-zinc-100">{entry.move.name}</div>
                  <FrameBar
                    startup={entry.move.startupTics}
                    active={entry.move.activeTics}
                    recovery={entry.move.recoveryTics}
                    defensePositions={entry.move.defenseFramePositions}
                    size="h-2.5 w-2.5"
                  />
                </div>
              </button>
              {expanded && (
                entry.move.full && moveInfo ? (
                  <div className="mt-1.5 border-t border-zinc-700 pt-1.5">
                    <MoveCard
                      move={entry.move.full}
                      tell={moveInfo.tellById.get(entry.move.full.tell_id)}
                      rightTell={entry.move.full.right_tell_id ? moveInfo.tellById.get(entry.move.full.right_tell_id) : null}
                      leftTell={entry.move.full.left_tell_id ? moveInfo.tellById.get(entry.move.full.left_tell_id) : null}
                      style={entry.move.full.style_attribute_id ? moveInfo.styleById.get(entry.move.full.style_attribute_id) : null}
                      tags={(entry.move.full.tag_ids ?? []).map((id) => moveInfo.tagById.get(id)).filter(Boolean)}
                      folderLabel={folderPath(entry.move.full.folder_id, moveInfo.moveFolders) ?? undefined}
                    />
                  </div>
                ) : (
                  // Auxiliary move data hasn't loaded yet, or this move was
                  // itself deleted after revealing — falls back to the
                  // compact fields every move_reveal card always carries.
                  <div className="mt-1.5 border-t border-zinc-700 pt-1.5 text-xs text-zinc-400">
                    {entry.move.description ? (
                      <p className="whitespace-pre-wrap break-words">{entry.move.description}</p>
                    ) : (
                      <p className="italic text-zinc-600">No description.</p>
                    )}
                    {entry.move.staminaCost != null && (
                      <p className="mt-1 text-zinc-500">
                        Stamina Cost:{' '}
                        {entry.move.staminaCost > 0
                          ? `-${entry.move.staminaCost}`
                          : entry.move.staminaCost < 0
                          ? `+${-entry.move.staminaCost}`
                          : '0'}
                      </p>
                    )}
                  </div>
                )
              )}
            </div>
          ) : (
            <p className="mt-1 italic text-zinc-600">(move deleted)</p>
          )
        ) : (
          <>
            <div className="mt-1 space-y-0.5">
              {entry.dice.map((d, i) => {
                // The physical die face isn't stored separately — result is
                // already `rollDie(size) + bonus + modifier` (see logRoll
                // server-side), so it's recovered exactly by subtracting the
                // two flat additions back out. Shown as its own breakdown
                // ("what was rolled on the d8, then summed") per the plan's
                // decided chat-card redesign — the final result is bolder
                // and bigger so it strikes the eye at a glance.
                const flat = d.bonus + entry.modifier;
                const raw = d.result - flat;
                return (
                  <div key={i} className="font-display flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-zinc-500">{d.slot_name}</span>
                    <span className="font-mono text-xs text-zinc-400">
                      d{d.size}: {raw}
                      {flat !== 0 ? ` ${flat > 0 ? '+' : '−'} ${Math.abs(flat)}` : ''} =
                    </span>
                    <span className="font-mono text-xl font-black leading-none text-white">{d.result}</span>
                  </div>
                );
              })}
            </div>
            {multi && (
              <div className="font-display mt-1 text-right font-mono text-2xl font-black leading-none text-brand-300">
                Total {entry.total}
              </div>
            )}
            {entry.declaredMoveId != null && (() => {
              // Combat Automation (Phase 9, sub-phase 4 — 4.1's damage line
              // + Apply button, 4.2's Partial-Block/Dodge override). Only a
              // roll carrying the reveal-time roll-context payload (see
              // buildRollContext server-side) ever gets these — a bare Dice
              // Tray roll or a manual Stat roll from the Moves tab never
              // has entry.declaredMoveId set, so they render exactly as
              // before, untouched.
              const raw = computeHitDamage(entry.total);
              const resolved = defenseResolutions?.get(entry.declaredMoveId);
              // A Full Block/Dodge zeroes the damage entirely; Partial
              // substitutes the reduced (netResult-based) figure in place
              // of the raw roll's own damage — "the reduced damage... can
              // still be applied... via the same Apply/Damage-Application-
              // dialog flow" (4.2). No resolution yet, or the pick came
              // back Failed (falls through to the plain 4.1 Hit), both
              // just use the raw roll's own damage, unmodified.
              const steps = resolved
                ? resolved.outcome === 'full'
                  ? 0
                  : resolved.halfDamageSteps
                : raw.halfDamageSteps;
              const damage = steps * 0.5;
              return (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-1.5">
                  <span className="font-display text-sm text-zinc-400">
                    Damage: <span className="font-mono font-bold text-red-400">{damage}</span>
                  </span>
                  {resolved && (
                    <span className="text-xs italic text-zinc-500">
                      ({resolved.outcome === 'full' ? 'Full' : resolved.outcome === 'partial' ? 'Partial' : 'Failed'}{' '}
                      {resolved.defenseType === 'dodge' ? 'Dodge' : 'Block'})
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={!damage}
                    onClick={() => setOpenDialog('apply')}
                    className="ml-auto panel-cut-sm bg-red-800/80 px-2.5 py-1 text-xs font-semibold text-red-100 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Apply
                  </button>
                  {role === 'gm' && !resolved && (
                    <button
                      type="button"
                      onClick={() => setOpenDialog('resolve')}
                      className="panel-cut-sm border border-sky-700/50 px-2.5 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-950/40"
                    >
                      Resolve Defense
                    </button>
                  )}
                  {openDialog === 'apply' && (
                    <DamageApplicationDialog
                      targetCandidateIds={entry.targetCandidateIds ?? []}
                      initialHalfDamageSteps={steps}
                      characters={characters}
                      onClose={() => setOpenDialog(null)}
                    />
                  )}
                  {openDialog === 'resolve' && (
                    <ResolveDefenseDialog
                      attackerDeclaredMoveId={entry.declaredMoveId}
                      attackerResult={entry.total}
                      targetCandidateIds={entry.targetCandidateIds ?? []}
                      characters={characters}
                      onClose={() => setOpenDialog(null)}
                    />
                  )}
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

function Composer({ characters }) {
  const { role, characterId: myCharacterId } = useRole();
  // Defaults to posting without ever needing a pick: a Player always posts
  // as the one character they logged in as (fixed, no picker — see Roles /
  // access model); the GM defaults to a generic 'gm' persona but can still
  // pick any character from the dropdown, same as before.
  const [characterId, setCharacterId] = useState(() =>
    role === 'player' ? String(myCharacterId ?? '') : 'gm'
  );
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null); // { imageData, imageMimeType, previewName }
  const [error, setError] = useState('');
  const [diceTrayMod, setDiceTrayMod] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    if (role === 'player') {
      setCharacterId(String(myCharacterId ?? ''));
      return;
    }
    if (characterId !== 'gm' && !characters.some((c) => String(c.id) === characterId)) {
      setCharacterId('gm');
    }
  }, [role, myCharacterId, characters, characterId]);

  const attachFile = async (file) => {
    if (!file) return;
    setError('');
    try {
      const { imageData, imageMimeType } = await fileToChatImage(file);
      setPending({ imageData, imageMimeType, previewName: file.name || 'image' });
    } catch (err) {
      setError(err.message);
    }
  };

  // Paste still works for a quick static screenshot — same fileToChatImage
  // pipeline either way, a clipboard image item's getAsFile() returns a
  // real File/Blob indistinguishable from one picked off disk. But an
  // actual animated GIF needs the file picker below, not paste: browsers
  // flatten a pasted clipboard image to a single static frame (typically
  // re-encoding it as PNG) regardless of the source format, which is why a
  // pasted GIF always posted looking static — a real <input type="file">
  // selection is the only path that preserves the original file's true
  // image/gif type and raw bytes.
  const onPaste = async (e) => {
    const item = [...e.clipboardData.items].find((it) => it.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    await attachFile(item.getAsFile());
  };

  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    await attachFile(file);
  };

  // Same "who's posting" resolution the message send below already used —
  // shared so the Dice Tray attributes its rolls identically.
  const postingCharacterId =
    role === 'player' ? myCharacterId : characterId === 'gm' ? null : Number(characterId);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed && !pending) return;
    socket.emit('chat:message', {
      characterId: postingCharacterId,
      text: trimmed,
      imageData: pending?.imageData ?? null,
      imageMimeType: pending?.imageMimeType ?? null,
    });
    setText('');
    setPending(null);
    setError('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Dice Tray (item 1): a raw d4-d12 roll plus an adjustable modifier, not
  // tied to any character's own die — see dice:roll_custom server-side,
  // shared with a move's Custom Roll type. Attributed to whoever's
  // currently selected in the "post as" picker above, same as a message.
  const rollCustomDie = (size) =>
    socket.emit('dice:roll_custom', { characterId: postingCharacterId, size, modifier: diceTrayMod });

  return (
    <div className="border-t border-zinc-800 p-2">
      {error && <p className="mb-1 text-xs text-red-400">{error}</p>}
      {pending && (
        <div className="mb-1 flex items-center gap-2 panel-cut-sm bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
          <span className="truncate">📎 {pending.previewName}</span>
          <button
            onClick={() => setPending(null)}
            className="ml-auto text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      )}
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[10px] font-semibold uppercase text-zinc-500">Mod</span>
        <button
          type="button"
          onClick={() => setDiceTrayMod((m) => Math.max(-20, m - 1))}
          className="panel-cut-sm border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          −
        </button>
        <span className="w-6 text-center font-mono text-xs text-zinc-300">
          {diceTrayMod > 0 ? `+${diceTrayMod}` : diceTrayMod}
        </span>
        <button
          type="button"
          onClick={() => setDiceTrayMod((m) => Math.min(20, m + 1))}
          className="panel-cut-sm border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          +
        </button>
        <span className="mx-1 h-4 w-px bg-zinc-800" />
        {DICE_TRAY_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => rollCustomDie(size)}
            title={`Roll 1d${size}${
              diceTrayMod ? (diceTrayMod > 0 ? ` + ${diceTrayMod}` : ` − ${Math.abs(diceTrayMod)}`) : ''
            }`}
            className="shrink-0 panel-cut-sm border border-zinc-700 p-1 text-zinc-400 hover:border-brand-500 hover:bg-zinc-800 hover:text-brand-300"
          >
            <DiceIcon size={size} />
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {role === 'player' ? (
          <span
            title="You always post as your own character"
            className="font-display max-w-[6.5rem] shrink-0 truncate panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-400"
          >
            {characters.find((c) => String(c.id) === characterId)?.name ?? '…'}
          </span>
        ) : (
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
            className="font-display max-w-[6.5rem] shrink-0 panel-cut-sm border border-zinc-700 bg-zinc-900 px-1 py-1.5 text-xs text-zinc-300"
            title="Post as"
          >
            <option value="gm">GM</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Attach an image — use this (not paste) for an animated GIF, since pasting flattens the animation"
          className="shrink-0 panel-cut-sm border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <Paperclip size={16} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Say something…"
          className="font-display min-w-0 flex-1 resize-none panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
        <button
          onClick={send}
          className="shrink-0 panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-500"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default function ChatPanel({ open, onClose }) {
  const { role } = useRole();
  const [entries, setEntries] = useState([]);
  const [characters, setCharacters] = useState(new Map());
  // Only needed to render a move_reveal card's expanded full MoveCard (see
  // Entry above) — the same lookups CombatArena.jsx/MovesTab.jsx already
  // fetch independently for the same purpose, no shared cache between them.
  const [tells, setTells] = useState(null);
  const [tags, setTags] = useState(null);
  const [ruleset, setRuleset] = useState(null);
  const [moveFolders, setMoveFolders] = useState(null);
  // Combat Automation (Phase 9, sub-phase 4): combat:resolve_defense's
  // broadcast, keyed by the attacker's own declaredMoveId so the Entry
  // whose roll triggered it can override its damage line (Full = 0,
  // Partial = the reduced amount) — see Entry above. Never cleared on
  // chat:cleared: a resolution is tied to a Tic-Countdown-scoped
  // declaredMoveId, not a chat row, and a fresh fight starts with a fresh
  // set of declared moves anyway (new ids), so a stale entry here can never
  // wrongly match a future roll.
  const [defenseResolutions, setDefenseResolutions] = useState(new Map());
  const bottomRef = useRef(null);

  useEffect(() => {
    getChat().then(setEntries).catch(console.error);
    const onRoll = (entry) => setEntries((prev) => [...prev, entry]);
    const onMessage = (entry) => setEntries((prev) => [...prev, entry]);
    const onMoveReveal = (entry) => setEntries((prev) => [...prev, entry]);
    const onLaneSnapshot = (entry) => setEntries((prev) => [...prev, entry]);
    const onCleared = () => setEntries([]);
    const onDefenseResolved = (payload) =>
      setDefenseResolutions((prev) => new Map(prev).set(payload.attackerDeclaredMoveId, payload));
    socket.on('roll:result', onRoll);
    socket.on('chat:message', onMessage);
    socket.on('chat:move_reveal', onMoveReveal);
    socket.on('chat:lane_snapshot', onLaneSnapshot);
    socket.on('chat:cleared', onCleared);
    socket.on('combat:defense_resolved', onDefenseResolved);
    return () => {
      socket.off('roll:result', onRoll);
      socket.off('chat:message', onMessage);
      socket.off('chat:move_reveal', onMoveReveal);
      socket.off('chat:lane_snapshot', onLaneSnapshot);
      socket.off('chat:cleared', onCleared);
      socket.off('combat:defense_resolved', onDefenseResolved);
    };
  }, []);

  useEffect(() => {
    // Avatars for the feed — unfiltered by role, same as the rolls/messages
    // themselves (everyone sees everyone's chat activity, NPCs included).
    const refresh = () =>
      getCharacters()
        .then((list) => setCharacters(new Map(list.map((c) => [c.id, c]))))
        .catch(console.error);
    refresh();
    const events = ['character:created', 'character:updated', 'character:deleted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  useEffect(() => {
    const refresh = () => {
      getTells().then(setTells).catch(console.error);
      getTags().then(setTags).catch(console.error);
      getRuleset().then(setRuleset).catch(console.error);
      getMoves().then((d) => setMoveFolders(d.folders)).catch(console.error);
    };
    refresh();
    const events = [
      'tell:created', 'tell:updated', 'tell:deleted',
      'tag:created', 'tag:updated', 'tag:deleted',
      'folder:created', 'folder:updated', 'folder:deleted',
    ];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  const moveInfo =
    tells && tags && ruleset && moveFolders
      ? {
          tellById: new Map(tells.map((t) => [t.id, t])),
          tagById: new Map(tags.map((t) => [t.id, t])),
          styleById: new Map(ruleset.attributes.map((a) => [a.id, a])),
          moveFolders,
        }
      : null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, open]);

  if (!open) return null;

  const clearChat = () => {
    if (confirm('Clear the whole chat log for everyone?')) socket.emit('chat:clear');
  };

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-zinc-900 md:static md:z-auto md:w-80 md:border-l md:border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">Chat Log</h2>
        {role === 'gm' && (
          <button
            onClick={clearChat}
            className="ml-auto panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
          >
            Clear Chat
          </button>
        )}
        <button
          onClick={onClose}
          className={`${role === 'gm' ? '' : 'ml-auto'} panel-cut-sm px-2 text-zinc-500 hover:text-zinc-200 md:hidden`}
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="p-4 text-sm text-zinc-600">Nothing here yet.</p>
        ) : (
          entries.map((entry, i) => (
            <Entry
              key={entry.id ?? `live-${i}`}
              entry={entry}
              character={characters.get(entry.characterId)}
              moveInfo={moveInfo}
              characters={characters}
              defenseResolutions={defenseResolutions}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
      <Composer
        characters={[...characters.values()]
          .filter((c) => role === 'gm' || c.character_type === 'pc')
          .sort((a, b) => a.name.localeCompare(b.name))}
      />
    </aside>
  );
}

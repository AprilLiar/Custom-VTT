import { useEffect, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { socket } from '../socket.js';
import { getChat, getCharacters, getTells, getTags, getRuleset, getMoves } from '../lib/api.js';
import { fileToChatImage } from '../lib/image.js';
import { folderPath } from '../lib/folders.js';
import { phaseBgAt } from '../lib/framePhaseColors.js';
import { useRole } from '../roleContext.jsx';
import { useSocketRefresh } from '../lib/connection.js';
import Thumb from './Thumb.jsx';
import FrameBar from './FrameBar.jsx';
import MoveCard from './MoveCard.jsx';
import DiceIcon from './DiceIcon.jsx';
import DialogShell from './DialogShell.jsx';
import CounterAdjustDialog from './CounterAdjustDialog.jsx';
import RoundCutscene from './RoundCutscene.jsx';

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

// Which phase(s) `move` occupies at `tic` — an array since two different
// characters' moves in the same lane can genuinely overlap the same Tic
// (both throwing at once); each gets its own thin colored segment in that
// square rather than one hiding the other.
//
// The palette and the phase walk both live in framePhaseColors.js now
// (Combat Automation overhaul §4.3) — this file used to carry its own copy
// of each, one of four near-duplicates across the client.
const snapshotPhaseColorAt = phaseBgAt;

// Combat Automation overhaul §4.2 — one button per pair per round,
// replacing chat:lane_snapshot's per-reveal spam. Deliberately ungated
// (decision #11): a resolved round is public history, so anyone can watch
// any round back, including one they weren't in.
function RoundSummaryCard({ entry, onWatch }) {
  const left = (entry.leftNames ?? []).join(' & ') || 'Left';
  const right = (entry.rightNames ?? []).join(' & ') || 'Right';
  return (
    <button
      type="button"
      onClick={() => onWatch?.(entry.resolutionId)}
      className="mt-1 flex w-full items-center gap-2 panel-cut-sm border border-brand-800/60 bg-brand-950/30 p-2 text-left hover:bg-brand-950/60"
    >
      <span className="font-display text-xs uppercase tracking-wide text-brand-300">▶ Watch</span>
      <span className="font-display text-xs text-zinc-300">
        Round {entry.roundNumber} between {left} and {right}
      </span>
    </button>
  );
}

function Entry({ entry, character, moveInfo, characters, defenseResolutions, onWatchRound, onAdjustCounters }) {
  const [expanded, setExpanded] = useState(false);
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
          {/* Counters, reachable from the roll that earned them (decided,
              new). Only on a roll: a plain chat message or a replay card has
              no "this just happened, tick something" moment behind it. */}
          {entry.kind === 'roll' && (
            <button
              type="button"
              onClick={() => onAdjustCounters?.(entry)}
              title="Adjust a counter"
              aria-label="Adjust a counter"
              className="flex h-6 w-6 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 text-sm leading-none text-zinc-500 hover:border-brand-500 hover:text-brand-300"
            >
              +
            </button>
          )}
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
        ) : entry.kind === 'round_summary' ? (
          <RoundSummaryCard entry={entry} onWatch={onWatchRound} />
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
            {/* The one number in a roll card that matters gets the impact
                face (Visual Overhaul V5); the breakdown above it stays
                monospaced so the dice still line up column-wise. */}
            {multi && (
              <div className="mt-1 text-right leading-none text-brand-300">
                <span className="font-display text-xs uppercase tracking-widest text-zinc-500">Total </span>
                <span className="font-impact text-3xl">{entry.total}</span>
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
              // Attack Target (Change 001): a Successful Block's own
              // combat:defense_resolved payload (resolved) carries the
              // post-Block replacement; otherwise fall back to this roll's
              // own declare-time snapshot (from buildRollContext live, or
              // GET /api/chat's batched reload enrichment — see server/
              // index.js) — either way, always the current server state,
              // never something derived client-side.
              const effectiveAttackTargets = resolved?.effectiveAttackTargets ?? entry.effectiveAttackTargets ?? [];
              const attackTargetSource = resolved?.attackTargetSource ?? entry.attackTargetSource ?? 'move';
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
                  <span className="w-full text-xs text-zinc-500">
                    Effective Attack Target:{' '}
                    <span className={effectiveAttackTargets.length ? 'text-zinc-300' : 'text-zinc-600'}>
                      {effectiveAttackTargets.length ? effectiveAttackTargets.join(' + ') : 'None'}
                    </span>
                    {attackTargetSource === 'block' && (
                      <span className="italic text-sky-400"> — changed by Block</span>
                    )}
                  </span>
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
    <div style={{ paddingBottom: 'var(--safe-bottom)' }} className="border-t border-zinc-800 p-2">
      {error && <p className="mb-1 text-xs text-red-400">{error}</p>}
      {pending && (
        <div className="mb-1 flex items-center gap-2 panel-cut-sm bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
          <span className="truncate">📎 {pending.previewName}</span>
          <button
            onClick={() => setPending(null)}
            className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200 md:h-6 md:w-6"
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
          className="flex h-11 min-w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800 md:h-auto md:min-w-0"
        >
          −
        </button>
        <span className="w-6 text-center font-mono text-xs text-zinc-300">
          {diceTrayMod > 0 ? `+${diceTrayMod}` : diceTrayMod}
        </span>
        <button
          type="button"
          onClick={() => setDiceTrayMod((m) => Math.min(20, m + 1))}
          className="flex h-11 min-w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800 md:h-auto md:min-w-0"
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
            className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 p-1 text-zinc-400 hover:border-brand-500 hover:bg-zinc-800 hover:text-brand-300 md:h-auto md:w-auto"
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
          className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 md:h-auto md:w-auto"
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
          className="min-h-11 shrink-0 panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-500 md:min-h-0"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default function ChatPanel({ open }) {
  const { role } = useRole();
  const [entries, setEntries] = useState([]);
  // Which round the "Watch Round N" button opened, if any (§4.2) — the
  // replay itself is a fullscreen RoundCutscene, matching how
  // a fullscreen dialog already takes over the screen elsewhere in the app.
  const [replayResolutionId, setReplayResolutionId] = useState(null);
  // Which roll card's "+" is open, if any — the whole entry, so the dialog
  // can name whoever made the roll.
  const [counterEntry, setCounterEntry] = useState(null);
  const [characters, setCharacters] = useState(new Map());
  // Only needed to render a move_reveal card's expanded full MoveCard (see
  // Entry above) — the same lookups CombatArena.jsx/MovesTab.jsx already
  // fetch independently for the same purpose, no shared cache between them.
  const [tells, setTells] = useState(null);
  const [tags, setTags] = useState(null);
  const [ruleset, setRuleset] = useState(null);
  const [moveFolders, setMoveFolders] = useState(null);
  // Attack Target (Change 001): flat move templates (roll_type/roll_slots),
  // (kept for the move_reveal card's expanded MoveCard)
  // client-side without a second fetch of its own.
  const [moves, setMoves] = useState(null);
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

  // Mobile readiness (Change 002) §11.2: a broadcast missed while the tab
  // was backgrounded (mobile suspend) or the socket was reconnecting never
  // replays — re-fetching the Chat tail on reconnect/resume is what closes
  // that gap for the log itself. Live entries pushed via the socket
  // listeners below are unaffected; this only ever replaces the base list.
  useSocketRefresh(() => getChat().then(setEntries).catch(console.error));

  useEffect(() => {
    getChat().then(setEntries).catch(console.error);
    const onRoll = (entry) => setEntries((prev) => [...prev, entry]);
    const onMessage = (entry) => setEntries((prev) => [...prev, entry]);
    const onMoveReveal = (entry) => setEntries((prev) => [...prev, entry]);
    const onRoundSummary = (entry) => setEntries((prev) => [...prev, entry]);
    const onCleared = () => setEntries([]);
    const onDefenseResolved = (payload) =>
      setDefenseResolutions((prev) => new Map(prev).set(payload.attackerDeclaredMoveId, payload));
    socket.on('roll:result', onRoll);
    socket.on('chat:message', onMessage);
    socket.on('chat:move_reveal', onMoveReveal);
    socket.on('chat:round_summary', onRoundSummary);
    socket.on('chat:cleared', onCleared);
    socket.on('combat:defense_resolved', onDefenseResolved);
    return () => {
      socket.off('roll:result', onRoll);
      socket.off('chat:message', onMessage);
      socket.off('chat:move_reveal', onMoveReveal);
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
      getMoves().then((d) => {
        setMoveFolders(d.folders);
        setMoves(d.moves);
      }).catch(console.error);
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
    <aside className="absolute inset-0 z-40 flex flex-col bg-zinc-900 md:static md:z-auto md:w-80 md:border-l md:border-zinc-800">
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
        {/* No mobile close button: Chat is a real tab now (decided), so the
            bottom nav is the only way in and out — tap Chat again, or tap any
            other tab. A second, differently-placed exit was the confusion. */}
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
              onWatchRound={setReplayResolutionId}
              onAdjustCounters={setCounterEntry}
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
      {counterEntry && (
        <CounterAdjustDialog
          characterId={counterEntry.characterId}
          characterName={counterEntry.characterName}
          onClose={() => setCounterEntry(null)}
        />
      )}
      {/* `theater`, not `fullscreen`: a replay is watched, not filled in, and
          the fullscreen variant's centered max-w-md panel left the timeline
          and its log squeezed into a column on desktop. */}
      {replayResolutionId != null && (
        <DialogShell
          title="Round replay"
          variant="theater"
          onClose={() => setReplayResolutionId(null)}
        >
          <RoundCutscene mode="replay" resolutionId={replayResolutionId} />
        </DialogShell>
      )}
    </aside>
  );
}

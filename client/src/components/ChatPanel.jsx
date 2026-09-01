import { useEffect, useMemo, useRef, useState } from 'react';
import { sortTags } from '../lib/moveDisplay.js';
import { Paperclip } from 'lucide-react';
import { socket } from '../socket.js';
import { getChat, getTells, getTags, getRuleset, getMoves } from '../lib/api.js';
import { fileToChatImage } from '../lib/image.js';
import { folderPath } from '../lib/folders.js';
import { phaseBgAt } from '../lib/framePhaseColors.js';
import { decomposeRoll, formatModifierTerms, formatRollTotal } from '../lib/dice.js';
import { useRole } from '../roleContext.jsx';
import { useSocketRefresh } from '../lib/connection.js';
import { useRoster } from '../lib/useRoster.js';
import Thumb from './Thumb.jsx';
import FrameBar from './FrameBar.jsx';
import QuirkCard from './QuirkCard.jsx';
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

function Entry({ entry, character, moveInfo, characters, defenseResolutions, onWatchRound, onAdjustCounters, moveDetail, onRequestDetail }) {
  const [expanded, setExpanded] = useState(false);
  const { role, capabilities } = useRole();
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
        ) : entry.kind === 'quirk' ? (
          // **A Quirk, shown to the table** — the ↑ on a Quirk card on a
          // character sheet. The same `QuirkCard` in the same colours, so what
          // lands in the log is recognisably the thing that was pointed at
          // rather than a paraphrase of it.
          //
          // Rendered entirely from the row's own payload, which was written at
          // post time: the card still reads correctly after the Quirk is
          // reworded, dropped, or its character deleted, exactly as every other
          // non-roll card in this log does.
          <div className="mt-1">
            <QuirkCard
              quirk={{
                name: entry.quirkName,
                description: entry.quirkDescription,
                kind: entry.quirkKind,
              }}
              byline={entry.characterName ? `${entry.characterName}'s Quirk` : 'A Quirk'}
            />
          </div>
        ) : entry.kind === 'round_summary' ? (
          <RoundSummaryCard entry={entry} onWatch={onWatchRound} />
        ) : entry.kind === 'move_reveal' ? (
          entry.move ? (
            <div className="mt-1 w-full panel-cut-sm bg-zinc-800/60 p-1.5">
              <button
                type="button"
                onClick={() => {
                  // **A real check now, not the honour-system prompt it
                  // replaced.** This used to be a window.confirm asking "Does
                  // your character have the Genius Observer Perk?" — a gate
                  // that trusted the reader about the reader's own advantage.
                  // The answer comes from the server against the logged-in
                  // character's granted Perks (see capabilitiesFor in
                  // server/index.js); the button simply isn't offered to a
                  // viewer who hasn't earned it.
                  if (!capabilities.canSeeRevealedDetail) return;
                  // The full move is fetched the first time it is actually
                  // asked for, not shipped with the card — see
                  // move:request_detail server-side. Requested on every open
                  // rather than once ever: the GM can edit a move between
                  // rounds, and a card re-opened after that should show what
                  // the move is now.
                  if (!expanded) onRequestDetail?.(entry.move.id);
                  setExpanded((prev) => !prev);
                }}
                disabled={!capabilities.canSeeRevealedDetail}
                title={
                  capabilities.canSeeRevealedDetail
                    ? expanded
                      ? 'Click to collapse'
                      : 'Click to show the full move'
                    : 'Reading a move in full takes the Genius Observer Perk.'
                }
                className={`flex w-full items-center gap-2 text-left ${
                  capabilities.canSeeRevealedDetail ? 'hover:opacity-80' : 'cursor-default'
                }`}
              >
                <Thumb record={{ image_data: entry.move.imageData, image_mime_type: entry.move.imageMimeType }} name={entry.move.name} size="h-8 w-8" />
                <div className="min-w-0 flex-1">
                  <div className="font-display truncate text-sm font-semibold text-zinc-100">{entry.move.name}</div>
                  {/* The public half of the card: what came out, and how long
                      it takes. The bar is the picture of it and the numbers
                      are the same fact said plainly — frame data is read as
                      "1 / 2 / 1" at a table, and a row of coloured squares
                      alone makes you count. */}
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <FrameBar
                      startup={entry.move.startupTics}
                      active={entry.move.activeTics}
                      recovery={entry.move.recoveryTics}
                      defensePositions={entry.move.defenseFramePositions}
                      size="h-2.5 w-2.5"
                    />
                    <span className="font-mono text-[10px] leading-none text-zinc-500">
                      {entry.move.startupTics} / {entry.move.activeTics} / {entry.move.recoveryTics}
                    </span>
                  </div>
                </div>
                {/* Says which of the two cards this is, rather than leaving a
                    Player to discover by clicking that nothing happens. */}
                <span className="shrink-0 self-start font-display text-[10px] uppercase leading-none text-zinc-600">
                  {capabilities.canSeeRevealedDetail ? (expanded ? 'Hide' : 'Read') : 'Locked'}
                </span>
              </button>
              {expanded && (
                moveDetail?.move && moveInfo ? (
                  <div className="mt-1.5 border-t border-zinc-700 pt-1.5">
                    <MoveCard
                      move={moveDetail.move}
                      allMoves={moveInfo.moves}
                      tell={moveInfo.tellById.get(moveDetail.move.tell_id)}
                      rightTell={moveDetail.move.right_tell_id ? moveInfo.tellById.get(moveDetail.move.right_tell_id) : null}
                      leftTell={moveDetail.move.left_tell_id ? moveInfo.tellById.get(moveDetail.move.left_tell_id) : null}
                      style={moveDetail.move.style_attribute_id ? moveInfo.styleById.get(moveDetail.move.style_attribute_id) : null}
                      combatStyle={
                        moveDetail.move.combat_style_attribute_id
                          ? moveInfo.styleById.get(moveDetail.move.combat_style_attribute_id)
                          : null
                      }
                      tags={sortTags((moveDetail.move.tag_ids ?? []).map((id) => moveInfo.tagById.get(id)).filter(Boolean))}
                      folderLabel={folderPath(moveDetail.move.folder_id, moveInfo.moveFolders) ?? undefined}
                    />
                  </div>
                ) : (
                  // Nothing to fall back to on purpose. The compact card
                  // carries no description any more — that is the gated half,
                  // and a half-card would quietly hand out some of what the
                  // Perk is for. So this says which of the three things
                  // happened instead of showing a stub.
                  <div className="mt-1.5 border-t border-zinc-700 pt-1.5 text-xs italic text-zinc-600">
                    {moveDetail?.reason === 'deleted'
                      ? 'This move has since been deleted.'
                      : moveDetail?.reason === 'not_revealed'
                      ? 'That move has not been revealed.'
                      : moveDetail?.reason === 'perk'
                      ? 'Reading a move in full takes the Genius Observer Perk.'
                      : 'Reading…'}
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
                // `rollDie(size) + that die's own bonus` (see logRoll
                // server-side), so it's recovered by subtracting the bonus
                // back out. The roll's shared modifier is deliberately NOT in
                // here: it modifies the roll, not each die, and is shown once
                // on the total line below. Shown as its own breakdown ("what
                // was rolled on the d8, then summed") per the plan's decided
                // chat-card redesign — the final result is bolder and bigger
                // so it strikes the eye at a glance. decomposeRoll is shared
                // with the round cutscene's log so the two can't drift.
                const { flat, raw } = decomposeRoll(d);
                return (
                  <div key={i} className="font-display flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-zinc-500">{d.slot_name}</span>
                    {/* With nothing to add — the common case now that the
                        roll's modifier lives on the total line — the face IS
                        the result, so "d4: 2 = 2" is dropped for a plain
                        "d4:". Only a die carrying its own bonus prints a sum. */}
                    <span className="font-mono text-xs text-zinc-400">
                      d{d.size}:{flat !== 0 ? ` ${raw} ${flat > 0 ? '+' : '−'} ${Math.abs(flat)} =` : ''}
                    </span>
                    <span className="font-mono text-xl font-black leading-none text-white">{d.result}</span>
                  </div>
                );
              })}
            </div>
            {/* Shown whenever there is more than one die OR a modifier to
                apply — the modifier lands here, on the roll, and this is the
                only place it is visible now that it is no longer folded into
                every die. A single die with no modifier still prints nothing:
                the total would just be the same number twice. */}
            {(multi || Boolean(entry.modifier)) && (
              <div className="font-display mt-1 text-right font-mono leading-none text-brand-300">
                <span className="text-xs text-zinc-500">Total </span>
                <span className="text-2xl font-black">
                  {formatRollTotal(entry.dice, entry.modifier, entry.total)}
                </span>
                {/* **What the modifier was made of.** Its own quiet line under
                    the total, and only when there is more than one named piece
                    to name — a roll of 11 with `+ 4 (Stance matchup) − 5 (Read
                    on the grab)` used to print as a bare `11 + 4 = 15` while
                    the engine went on to announce 10, and the log contradicted
                    itself. Engine rolls carry `modifierTerms`; a Dice Tray roll
                    has none and this renders nothing. */}
                {Boolean(formatModifierTerms(entry.modifierTerms)) && (
                  <div className="mt-0.5 text-[11px] font-normal leading-snug text-zinc-500">
                    {formatModifierTerms(entry.modifierTerms)}
                  </div>
                )}
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

  // calc, not a bare var: the inline style beats the p-2 class, so the raw
  // inset wiped this row's bottom padding on desktop (see DialogShell).
  return (
    <div
      style={{ paddingBottom: 'calc(0.5rem + var(--safe-bottom))' }}
      className="border-t border-zinc-800 p-2"
    >
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
  const roster = useRoster();
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
  // The gated half of a move-reveal card, keyed by moveId — answers to
  // `move:request_detail`, which the server only fills in for a socket whose
  // identity passes canSeeRevealedDetail. Kept here rather than per-Entry so
  // the same move revealed three times this fight is fetched once per open
  // rather than three times, and so a refusal is remembered too (a `move`
  // of null with a `reason`), which is what stops a denied card retrying
  // forever.
  const [moveDetails, setMoveDetails] = useState(new Map());
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
    const onQuirk = (entry) => setEntries((prev) => [...prev, entry]);
    const onCleared = () => setEntries([]);
    const onDefenseResolved = (payload) =>
      setDefenseResolutions((prev) => new Map(prev).set(payload.attackerDeclaredMoveId, payload));
    const onMoveDetail = (payload) =>
      setMoveDetails((prev) => new Map(prev).set(payload.moveId, payload));
    // A Perk granted mid-session changes the answer to every refusal already
    // cached above, so the cache is dropped whenever capabilities move.
    const onCapabilities = () => setMoveDetails(new Map());
    socket.on('roll:result', onRoll);
    socket.on('chat:message', onMessage);
    socket.on('chat:move_reveal', onMoveReveal);
    socket.on('chat:round_summary', onRoundSummary);
    socket.on('chat:quirk', onQuirk);
    socket.on('chat:cleared', onCleared);
    socket.on('combat:defense_resolved', onDefenseResolved);
    socket.on('move:detail', onMoveDetail);
    socket.on('identity:capabilities', onCapabilities);
    return () => {
      socket.off('roll:result', onRoll);
      socket.off('chat:message', onMessage);
      socket.off('chat:move_reveal', onMoveReveal);
      // Was missing, so an unmounted panel kept appending round summaries to
      // a dead setState — the other four were always cleaned up.
      socket.off('chat:round_summary', onRoundSummary);
      socket.off('chat:quirk', onQuirk);
      socket.off('chat:cleared', onCleared);
      socket.off('combat:defense_resolved', onDefenseResolved);
      socket.off('move:detail', onMoveDetail);
      socket.off('identity:capabilities', onCapabilities);
    };
  }, []);

  // Avatars for the feed — unfiltered by role, same as the rolls/messages
  // themselves (everyone sees everyone's chat activity, NPCs included).
  // Through useRoster because this panel is mounted on *every* page, so it was
  // the widest-reaching copy of the refetch-on-every-Stamina-change bug.
  const characters = useMemo(() => new Map((roster ?? []).map((c) => [c.id, c])), [roster]);

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

  // `moves` is in here because MoveCard needs the whole library to name a
  // move's Requirement and its grapple branches. It used to be read as a bare
  // `moves` from inside Entry, which is a different scope — the expanded card
  // would have thrown a ReferenceError the first time anybody opened one.
  const moveInfo =
    tells && tags && ruleset && moveFolders
      ? {
          tellById: new Map(tells.map((t) => [t.id, t])),
          tagById: new Map(tags.map((t) => [t.id, t])),
          styleById: new Map(ruleset.attributes.map((a) => [a.id, a])),
          moveFolders,
          moves: moves ?? [],
        }
      : null;

  const requestMoveDetail = (moveId) => {
    if (moveId == null) return;
    // Drop any cached answer first so a reopen genuinely re-asks, and the
    // card shows "Reading…" rather than a stale copy of an edited move.
    setMoveDetails((prev) => {
      if (!prev.has(moveId)) return prev;
      const next = new Map(prev);
      next.delete(moveId);
      return next;
    });
    socket.emit('move:request_detail', { moveId });
  };

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
              moveDetail={entry.move ? moveDetails.get(entry.move.id) : undefined}
              onRequestDetail={requestMoveDetail}
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
          <RoundCutscene resolutionId={replayResolutionId} />
        </DialogShell>
      )}
    </aside>
  );
}

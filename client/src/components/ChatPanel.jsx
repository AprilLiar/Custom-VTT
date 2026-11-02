import { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { socket } from '../socket.js';
import { getChat } from '../lib/api.js';
import { fileToChatImage } from '../lib/image.js';
import { decomposeRoll, formatRollTotal } from '../lib/dice.js';
import { useRole } from '../roleContext.jsx';
import { useSocketRefresh } from '../lib/connection.js';
import { useRoster } from '../lib/useRoster.js';
import Thumb from './Thumb.jsx';
import DiceIcon from './DiceIcon.jsx';
import CounterAdjustDialog from './CounterAdjustDialog.jsx';
import CroppedImage from './CroppedImage.jsx';
import { cropOf } from '../lib/imageCrop.js';

// A fighter as a fight card names them: their round token (or portrait).
function FighterChip({ fighter }) {
  const crop = fighter?.crop
    ? cropOf({ crop_x: fighter.crop.x, crop_y: fighter.crop.y, crop_w: fighter.crop.w, crop_h: fighter.crop.h })
    : null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-6 w-6 shrink-0 overflow-hidden rounded-full border border-zinc-600 bg-zinc-800">
        {fighter?.image_url ? (
          <CroppedImage src={fighter.image_url} crop={crop} alt="" className="h-full w-full rounded-full" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[10px] font-bold uppercase text-zinc-400">
            {(fighter?.name ?? '?').slice(0, 1)}
          </span>
        )}
      </span>
      <span className="font-display text-sm font-semibold text-zinc-100">{fighter?.name}</span>
    </span>
  );
}

// **Fight cards (Panic at the Dojo, Phase 5)** — posted by the table itself:
// a Reminder box (a fighter's own, or an automatic End Phase one naming
// everyone it applies to) and a turn-start Stance roll, each die shown on its
// own so the player sees exactly what they are working with.
function FightCard({ entry }) {
  const p = entry.payload ?? {};
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (entry.kind === 'stance_roll') {
    return (
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="panel-cut-sm border border-sky-700/60 bg-sky-950/40 p-2">
          <div className="mb-1.5 flex items-center gap-2">
            <FighterChip fighter={p.fighter} />
            <span className="ml-auto font-display text-[10px] text-zinc-500">{time}</span>
          </div>
          <p className="mb-1.5 font-display text-[11px] font-semibold uppercase tracking-wide text-sky-300">
            Stance: {p.stance}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(p.results ?? []).map((r, i) => (
              <span
                key={i}
                className={`flex min-w-11 flex-col items-center panel-cut-sm border px-1.5 py-1 ${
                  r.die !== undefined ? 'border-zinc-600 bg-zinc-900' : 'border-amber-600/70 bg-amber-950/40'
                }`}
              >
                <span className="font-mono text-[10px] text-zinc-500">{r.die !== undefined ? `d${r.die}` : 'fixed'}</span>
                <span className="font-mono text-xl font-black leading-none text-white">{r.result}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="border-b border-zinc-800 px-3 py-2">
      <div
        className={`panel-cut-sm border p-2 ${
          p.automatic ? 'border-orange-600/60 bg-orange-950/30' : 'border-violet-600/60 bg-violet-950/30'
        }`}
      >
        <div className="mb-1 flex items-center gap-2">
          <span
            className={`font-display text-[10px] font-bold uppercase tracking-wide ${
              p.automatic ? 'text-orange-300' : 'text-violet-300'
            }`}
          >
            {p.automatic ? 'Rule reminder' : 'Reminder'} · {p.title}
          </span>
          <span className="ml-auto font-display text-[10px] text-zinc-500">{time}</span>
        </div>
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1">
          {(p.fighters ?? []).map((f, i) => (
            <FighterChip key={i} fighter={f} />
          ))}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-zinc-200">{p.text}</p>
      </div>
    </div>
  );
}

const DICE_TRAY_SIZES = [4, 6, 8, 10, 12];

// One entry in the log. Two kinds remain (decided, revised — the pivot): a
// message, with an optional picture or GIF, and a Dice Tray roll. The old
// system's cards — move reveals, round summaries and their replays, Quirk cards,
// and the damage line under an engine roll — went with it.
// Exported for the Scene's floating chat cards (SceneChat.jsx); `compact`
// drops the roll card's Counters button there.
export function Entry({ entry, character, onAdjustCounters, compact = false }) {
  if (entry.kind === 'reminder' || entry.kind === 'stance_roll') return <FightCard entry={entry} />;
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
              new). Only on a roll: a plain chat message has no "this just
              happened, tick something" moment behind it. */}
          {entry.kind === 'roll' && !compact && (
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
            {entry.imageUrl && (
              <img
                src={entry.imageUrl}
                alt=""
                className="mt-1 max-h-64 max-w-full panel-cut-sm object-contain"
              />
            )}
          </div>
        ) : (
          <>
            <div className="mt-1 space-y-0.5">
              {entry.dice.map((d, i) => {
                // The physical die face isn't stored separately — result is
                // `rollDie(size) + that die's own bonus` (see logRoll
                // server-side), so it's recovered by subtracting the bonus
                // back out. The roll's shared modifier is deliberately NOT in
                // here: it modifies the roll, not each die, and is shown once
                // on the total line below.
                const { flat, raw } = decomposeRoll(d);
                return (
                  <div key={i} className="font-display flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-zinc-500">{d.slot_name}</span>
                    {/* With nothing to add, the face IS the result, so "d4: 2 =
                        2" is dropped for a plain "d4:". Only a die carrying its
                        own bonus prints a sum. */}
                    <span className="font-mono text-xs text-zinc-400">
                      d{d.size}:{flat !== 0 ? ` ${raw} ${flat > 0 ? '+' : '−'} ${Math.abs(flat)} =` : ''}
                    </span>
                    <span className="font-mono text-xl font-black leading-none text-white">{d.result}</span>
                  </div>
                );
              })}
            </div>
            {/* Shown whenever there is more than one die OR a modifier to
                apply — the modifier lands here, on the roll. A single die with
                no modifier prints nothing: the total would just be the same
                number twice. */}
            {(multi || Boolean(entry.modifier)) && (
              <div className="font-display mt-1 text-right font-mono leading-none text-brand-300">
                <span className="text-xs text-zinc-500">Total </span>
                <span className="text-2xl font-black">
                  {formatRollTotal(entry.dice, entry.modifier, entry.total)}
                </span>
              </div>
            )}
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
  // tied to any character — see dice:roll_custom server-side. Attributed to
  // whoever's currently selected in the "post as" picker above, same as a
  // message.
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
  // Which roll card's "+" is open, if any — the whole entry, so the dialog
  // can name whoever made the roll.
  const [counterEntry, setCounterEntry] = useState(null);
  const roster = useRoster();
  const bottomRef = useRef(null);

  // Mobile readiness (Change 002) §11.2: a broadcast missed while the tab
  // was backgrounded (mobile suspend) or the socket was reconnecting never
  // replays — re-fetching the Chat tail on reconnect/resume is what closes
  // that gap for the log itself. Live entries pushed via the socket
  // listeners below are unaffected; this only ever replaces the base list.
  useSocketRefresh(() => getChat().then(setEntries).catch(console.error));

  useEffect(() => {
    getChat().then(setEntries).catch(console.error);
    const onEntry = (entry) => setEntries((prev) => [...prev, entry]);
    const onCleared = () => setEntries([]);
    socket.on('roll:result', onEntry);
    socket.on('chat:message', onEntry);
    socket.on('chat:card', onEntry);
    socket.on('chat:cleared', onCleared);
    return () => {
      socket.off('roll:result', onEntry);
      socket.off('chat:message', onEntry);
      socket.off('chat:card', onEntry);
      socket.off('chat:cleared', onCleared);
    };
  }, []);

  // Avatars for the feed — unfiltered by role, same as the rolls/messages
  // themselves (everyone sees everyone's chat activity, NPCs included).
  // Through useRoster because this panel is mounted on *every* page.
  const characters = useMemo(() => new Map((roster ?? []).map((c) => [c.id, c])), [roster]);

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
    </aside>
  );
}

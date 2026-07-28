import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getChat, getCharacters, getTells, getTags, getRuleset, getMoves } from '../lib/api.js';
import { dieFormula } from '../lib/dice.js';
import { fileToChatImage } from '../lib/image.js';
import { folderPath } from '../lib/folders.js';
import { useRole } from '../roleContext.jsx';
import Thumb from './Thumb.jsx';
import FrameBar from './FrameBar.jsx';
import MoveCard from './MoveCard.jsx';

function Entry({ entry, character, moveInfo }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const multi = entry.kind === 'roll' && entry.dice.length > 1;
  return (
    <div className="flex gap-2 border-b border-zinc-800 px-3 py-2 text-sm">
      <Thumb
        record={character}
        name={character ? entry.characterName : '?'}
        size="h-6 w-6"
        rounded="rounded-full"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-zinc-200">{entry.characterName}</span>
          <span className="ml-auto text-xs text-zinc-600">{time}</span>
        </div>
        {entry.kind === 'message' ? (
          <div className="mt-1">
            {entry.message && (
              <p className="whitespace-pre-wrap break-words text-zinc-300">{entry.message}</p>
            )}
            {entry.imageData && (
              <img
                src={`data:${entry.imageMimeType || 'image/png'};base64,${entry.imageData}`}
                alt=""
                className="mt-1 max-h-64 max-w-full rounded-md object-contain"
              />
            )}
          </div>
        ) : entry.kind === 'move_reveal' ? (
          entry.move ? (
            <div className="mt-1 w-full rounded-md bg-zinc-800/60 p-1.5">
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
                  <div className="truncate text-sm font-semibold text-zinc-100">{entry.move.name}</div>
                  <FrameBar
                    startup={entry.move.startupTics}
                    active={entry.move.activeTics}
                    recovery={entry.move.recoveryTics}
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
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-400">
              {entry.dice.map((d, i) => (
                <span key={i}>
                  {d.slot_name} ({dieFormula(d.size, d.bonus, entry.modifier)}):{' '}
                  <span className="font-mono text-zinc-200">{d.result}</span>
                </span>
              ))}
            </div>
            {multi && (
              <div className="mt-0.5 text-right font-mono text-sm font-bold text-zinc-100">
                Total {entry.total}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Composer({ characters }) {
  const [characterId, setCharacterId] = useState('');
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null); // { imageData, imageMimeType, previewName }
  const [error, setError] = useState('');

  useEffect(() => {
    if (characterId && !characters.some((c) => String(c.id) === characterId)) {
      setCharacterId('');
    }
  }, [characters, characterId]);

  // Images/GIFs attach by pasting straight into the composer — no file
  // picker. Same fileToChatImage pipeline either way: a clipboard image
  // item's getAsFile() returns a real File/Blob, indistinguishable from one
  // picked off disk.
  const onPaste = async (e) => {
    const item = [...e.clipboardData.items].find((it) => it.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    setError('');
    try {
      const { imageData, imageMimeType } = await fileToChatImage(file);
      setPending({ imageData, imageMimeType, previewName: file.name || 'pasted image' });
    } catch (err) {
      setError(err.message);
    }
  };

  const send = () => {
    if (!characterId) {
      setError('Pick who is posting first.');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && !pending) return;
    socket.emit('chat:message', {
      characterId: Number(characterId),
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

  return (
    <div className="border-t border-zinc-800 p-2">
      {error && <p className="mb-1 text-xs text-red-400">{error}</p>}
      {pending && (
        <div className="mb-1 flex items-center gap-2 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
          <span className="truncate">📎 {pending.previewName}</span>
          <button
            onClick={() => setPending(null)}
            className="ml-auto text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex items-center gap-1">
        <select
          value={characterId}
          onChange={(e) => setCharacterId(e.target.value)}
          className="max-w-[6.5rem] shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-1 py-1.5 text-xs text-zinc-300"
          title="Post as"
        >
          <option value="">Post as…</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Say something… (paste an image to attach)"
          className="min-w-0 flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
        <button
          onClick={send}
          className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
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
  const bottomRef = useRef(null);

  useEffect(() => {
    getChat().then(setEntries).catch(console.error);
    const onRoll = (entry) => setEntries((prev) => [...prev, entry]);
    const onMessage = (entry) => setEntries((prev) => [...prev, entry]);
    const onMoveReveal = (entry) => setEntries((prev) => [...prev, entry]);
    const onCleared = () => setEntries([]);
    socket.on('roll:result', onRoll);
    socket.on('chat:message', onMessage);
    socket.on('chat:move_reveal', onMoveReveal);
    socket.on('chat:cleared', onCleared);
    return () => {
      socket.off('roll:result', onRoll);
      socket.off('chat:message', onMessage);
      socket.off('chat:move_reveal', onMoveReveal);
      socket.off('chat:cleared', onCleared);
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
            className="ml-auto rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
          >
            Clear Chat
          </button>
        )}
        <button
          onClick={onClose}
          className={`${role === 'gm' ? '' : 'ml-auto'} rounded px-2 text-zinc-500 hover:text-zinc-200 md:hidden`}
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

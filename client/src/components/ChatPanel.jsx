import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getChat, getCharacters } from '../lib/api.js';
import { dieFormula } from '../lib/dice.js';
import { fileToChatImage } from '../lib/image.js';
import { useRole } from '../roleContext.jsx';
import Thumb from './Thumb.jsx';

function Entry({ entry, character }) {
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
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (characterId && !characters.some((c) => String(c.id) === characterId)) {
      setCharacterId('');
    }
  }, [characters, characterId]);

  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const { imageData, imageMimeType } = await fileToChatImage(file);
      setPending({ imageData, imageMimeType, previewName: file.name });
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
          placeholder="Say something…"
          className="min-w-0 flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickFile}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Attach an image or GIF"
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
        >
          🖼
        </button>
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
  const bottomRef = useRef(null);

  useEffect(() => {
    getChat().then(setEntries).catch(console.error);
    const onRoll = (entry) => setEntries((prev) => [...prev, entry]);
    const onMessage = (entry) => setEntries((prev) => [...prev, entry]);
    const onCleared = () => setEntries([]);
    socket.on('roll:result', onRoll);
    socket.on('chat:message', onMessage);
    socket.on('chat:cleared', onCleared);
    return () => {
      socket.off('roll:result', onRoll);
      socket.off('chat:message', onMessage);
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

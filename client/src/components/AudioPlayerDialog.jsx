import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronUp, ListMusic, Music, Pause, Pencil, Play,
  Plus, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Square, Trash2,
} from 'lucide-react';
import { socket } from '../socket.js';
import { getAudioLibrary } from '../lib/api.js';
import { useSocketRefresh } from '../lib/connection.js';
import { useAudioStatus } from '../lib/useAudioStatus.js';
import DialogShell from './DialogShell.jsx';

// The Audio Player — the GM Tools drawer's third tool.
//
// GM-only, and genuinely so server-side: every management event here is
// emitToGm-scoped, so a Player never enumerates the library, they only ever
// hear whatever is currently playing. That is why `{ role: 'gm' }` is
// hardcoded below rather than read off useRole(), exactly as SceneNotesDialog
// does for the same reason.
//
// Nothing in this component plays audio. It sends the GM's intent to the
// server, which resolves it and broadcasts one anchor to everybody; the actual
// playback lives in lib/audioEngine.js, outside React entirely.

const IDENTITY = { role: 'gm' };

// The same chip styling StageRoster uses for its on-stage controls, so the
// app's two hover/tap-revealed tool rows look like one idea.
const BTN =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-600 ' +
  'bg-zinc-900/80 text-zinc-300 hover:border-brand-500 hover:text-brand-300 ' +
  'disabled:opacity-30 disabled:hover:border-zinc-600 disabled:hover:text-zinc-300';

export default function AudioPlayerDialog({ onClose }) {
  const [library, setLibrary] = useState(null); // { playlists, tracks }
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | trackId
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [rejection, setRejection] = useState(null);
  const audio = useAudioStatus();

  // Hover on a pointer device, a completed tap on a touch one — **deliberately
  // not this app's usual .hover-only-action convention**, which makes buttons
  // permanently visible on touch rather than revealing them. Same approach
  // StageRoster takes, and for the same reason: a row of five icons always on
  // screen is a different (worse) design than one that appears on demand.
  const [hoveredId, setHoveredId] = useState(null);
  const [tappedId, setTappedId] = useState(null);
  const revealedId = tappedId ?? hoveredId;

  const refresh = useCallback(() => {
    getAudioLibrary(IDENTITY).then(setLibrary).catch(console.error);
  }, []);
  useEffect(refresh, [refresh]);
  // A reconnect or a tab-resume must not leave this panel showing a library
  // that has moved on — the hard convention for any GM tool holding server
  // state (see connection.js's own note, which names these panels).
  useSocketRefresh(refresh);

  // Live patches rather than refetches: emitToGm already scoped every one of
  // these to GM sockets, so there is no owner filter to apply here.
  useEffect(() => {
    const patchTracks = (fn) => setLibrary((lib) => (lib ? { ...lib, tracks: fn(lib.tracks) } : lib));
    const patchLists = (fn) => setLibrary((lib) => (lib ? { ...lib, playlists: fn(lib.playlists) } : lib));

    const onListCreated = (row) => {
      patchLists((ls) => [...ls, row]);
      setSelectedId(row.id);
    };
    const onListUpdated = (row) => patchLists((ls) => ls.map((l) => (l.id === row.id ? row : l)));
    const onListDeleted = ({ playlistId }) => {
      patchLists((ls) => ls.filter((l) => l.id !== playlistId));
      patchTracks((ts) => ts.filter((t) => t.playlist_id !== playlistId));
      setSelectedId((cur) => (cur === playlistId ? null : cur));
    };
    const onTrackCreated = (row) => patchTracks((ts) => [...ts, row]);
    const onTrackUpdated = (row) => patchTracks((ts) => ts.map((t) => (t.id === row.id ? row : t)));
    const onTrackDeleted = ({ trackId }) => patchTracks((ts) => ts.filter((t) => t.id !== trackId));
    const onReordered = ({ trackIds }) =>
      patchTracks((ts) =>
        ts.map((t) => {
          const i = trackIds.indexOf(t.id);
          return i === -1 ? t : { ...t, sort_order: i };
        })
      );
    const onRejected = ({ reason }) => setRejection(reason);
    const onUnplayable = ({ name, code }) =>
      setRejection(`"${name ?? 'That track'}" cannot be played here (YouTube error ${code}) — skipped.`);

    socket.on('audio_playlist:created', onListCreated);
    socket.on('audio_playlist:updated', onListUpdated);
    socket.on('audio_playlist:deleted', onListDeleted);
    socket.on('audio_track:created', onTrackCreated);
    socket.on('audio_track:updated', onTrackUpdated);
    socket.on('audio_track:deleted', onTrackDeleted);
    socket.on('audio_tracks:reordered', onReordered);
    socket.on('audio_track:rejected', onRejected);
    socket.on('audio:track_unplayable', onUnplayable);
    return () => {
      socket.off('audio_playlist:created', onListCreated);
      socket.off('audio_playlist:updated', onListUpdated);
      socket.off('audio_playlist:deleted', onListDeleted);
      socket.off('audio_track:created', onTrackCreated);
      socket.off('audio_track:updated', onTrackUpdated);
      socket.off('audio_track:deleted', onTrackDeleted);
      socket.off('audio_tracks:reordered', onReordered);
      socket.off('audio_track:rejected', onRejected);
      socket.off('audio:track_unplayable', onUnplayable);
    };
  }, []);

  // Opened from the spinning record: land on the playing song's playlist and
  // scroll to the song itself, rather than wherever the panel was last left.
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (jumpedRef.current || !library || !audio.playlistId) return;
    jumpedRef.current = true;
    setSelectedId(audio.playlistId);
  }, [library, audio.playlistId]);

  const playlists = library?.playlists ?? [];
  const selected = playlists.find((p) => p.id === selectedId) ?? playlists[0] ?? null;
  const tracks = (library?.tracks ?? [])
    .filter((t) => t.playlist_id === selected?.id)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  const move = (trackId, delta) => {
    const ids = tracks.map((t) => t.id);
    const i = ids.indexOf(trackId);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    // The whole new order, not a swap — the same wire format move:reorder
    // uses, so the server never has to reconstruct an intent from a delta.
    socket.emit('audio_track:reorder', { playlistId: selected.id, trackIds: ids });
  };

  return (
    <DialogShell title="Audio Player" onClose={onClose} variant="fullscreen" maxWidth="max-w-none" portal>
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <Transport audio={audio} />
        {rejection && (
          <p className="panel-cut-sm border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            {rejection === 'not-a-youtube-link'
              ? 'That is not a YouTube link — paste a watch, youtu.be, embed or shorts URL.'
              : rejection}{' '}
            <button type="button" className="underline" onClick={() => setRejection(null)}>
              dismiss
            </button>
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <PlaylistRail
            playlists={playlists}
            selectedId={selected?.id ?? null}
            onSelect={(id) => {
              setSelectedId(id);
              setEditing(null);
              setTappedId(null);
            }}
          />

          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {!selected ? (
              <p className="text-sm text-zinc-600">
                {library == null ? 'Loading…' : 'Make a playlist to start adding songs.'}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display truncate text-sm font-bold uppercase tracking-wide text-zinc-300">
                    {selected.name}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setEditing('new')}
                    className="min-h-11 panel-cut-sm flex items-center gap-1.5 border border-zinc-700 px-3 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 md:min-h-0 md:py-1.5"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add song
                  </button>
                </div>

                {editing === 'new' && (
                  <TrackEditor
                    playlistId={selected.id}
                    onDone={() => setEditing(null)}
                    onReject={setRejection}
                  />
                )}

                <div
                  className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
                  // A tap on empty space puts the revealed tool row away again,
                  // the same escape StageRoster gives its on-stage controls.
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setTappedId(null);
                  }}
                >
                  {tracks.length === 0 && editing !== 'new' && (
                    <p className="text-sm text-zinc-600">No songs in this playlist yet.</p>
                  )}
                  {tracks.map((track, i) =>
                    editing === track.id ? (
                      <TrackEditor
                        key={track.id}
                        track={track}
                        playlistId={selected.id}
                        onDone={() => setEditing(null)}
                        onReject={setRejection}
                      />
                    ) : (
                      <TrackRow
                        key={track.id}
                        track={track}
                        isPlaying={audio.trackId === track.id && audio.isPlaying}
                        isCurrent={audio.trackId === track.id}
                        revealed={revealedId === track.id}
                        first={i === 0}
                        last={i === tracks.length - 1}
                        confirming={confirmingDelete === track.id}
                        onHover={setHoveredId}
                        onTap={() => setTappedId((cur) => (cur === track.id ? null : track.id))}
                        onEdit={() => setEditing(track.id)}
                        onMove={(d) => move(track.id, d)}
                        onConfirmDelete={() => setConfirmingDelete(track.id)}
                        onCancelDelete={() => setConfirmingDelete(null)}
                        onDelete={() => {
                          socket.emit('audio_track:delete', { trackId: track.id });
                          setConfirmingDelete(null);
                        }}
                      />
                    )
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </DialogShell>
  );
}

// The transport row. Pinned at the top so the controls do not move as the
// track list scrolls under them.
function Transport({ audio }) {
  const [mode, setMode] = useState({ repeatMode: 'playlist', shuffle: false });
  useEffect(() => {
    const onState = (s) => setMode({ repeatMode: s.repeatMode, shuffle: s.shuffle });
    socket.on('audio:state', onState);
    return () => socket.off('audio:state', onState);
  }, []);

  const cycleRepeat = () => {
    const next = { playlist: 'track', track: 'off', off: 'playlist' }[mode.repeatMode] ?? 'playlist';
    socket.emit('audio:set_mode', { repeatMode: next });
  };

  const RepeatIcon = mode.repeatMode === 'track' ? Repeat1 : Repeat;
  const idle = !audio.name;

  return (
    <div className="panel-cut-sm flex flex-wrap items-center gap-2 border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <Music className="h-4 w-4 shrink-0 text-brand-400" />
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
        {idle ? 'Nothing playing' : audio.name}
        {audio.status === 'blocked' && <span className="text-amber-300"> — audio blocked, tap the record</span>}
        {audio.status === 'silent' && <span className="text-zinc-500"> — re-syncing</span>}
      </span>
      <div className="flex items-center gap-1.5">
        <button type="button" className={BTN} title="Previous" disabled={idle} onClick={() => socket.emit('audio:previous')}>
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={BTN}
          title={audio.isPlaying ? 'Pause' : 'Resume'}
          disabled={idle}
          onClick={() => socket.emit(audio.isPlaying ? 'audio:pause' : 'audio:resume')}
        >
          {audio.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button type="button" className={BTN} title="Next" disabled={idle} onClick={() => socket.emit('audio:next')}>
          <SkipForward className="h-4 w-4" />
        </button>
        <button type="button" className={BTN} title="Stop" disabled={idle} onClick={() => socket.emit('audio:stop')}>
          <Square className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={cycleRepeat}
          title={`Repeat: ${mode.repeatMode}`}
          className={`${BTN} ${mode.repeatMode !== 'off' ? 'border-brand-500 text-brand-300' : ''}`}
        >
          <RepeatIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => socket.emit('audio:set_mode', { shuffle: !mode.shuffle })}
          title={mode.shuffle ? 'Shuffle on' : 'Shuffle off'}
          className={`${BTN} ${mode.shuffle ? 'border-brand-500 text-brand-300' : ''}`}
        >
          <Shuffle className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PlaylistRail({ playlists, selectedId, onSelect }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const submit = () => {
    const clean = name.trim();
    if (!clean) return;
    if (renaming) socket.emit('audio_playlist:rename', { playlistId: renaming, name: clean });
    else socket.emit('audio_playlist:create', { name: clean });
    setName('');
    setAdding(false);
    setRenaming(null);
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 md:w-56 md:border-r md:border-zinc-800 md:pr-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-xs font-bold uppercase tracking-wide text-zinc-500">Playlists</span>
        <button
          type="button"
          onClick={() => {
            setAdding(true);
            setRenaming(null);
            setName('');
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700 text-zinc-400 hover:border-brand-500 hover:text-brand-300"
          title="New playlist"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {(adding || renaming) && (
        <div className="flex gap-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') {
                setAdding(false);
                setRenaming(null);
              }
            }}
            placeholder="Playlist name"
            className="min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
          />
          <button type="button" onClick={submit} className="panel-cut-sm border border-zinc-700 px-2 text-xs text-zinc-300 hover:bg-zinc-800">
            Save
          </button>
        </div>
      )}

      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto md:max-h-none">
        {playlists.length === 0 && <p className="text-xs text-zinc-600">None yet.</p>}
        {playlists.map((p) => (
          <div key={p.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm md:min-h-0 md:py-1.5 ${
                p.id === selectedId ? 'bg-zinc-800 text-brand-300' : 'text-zinc-300 hover:bg-zinc-900'
              }`}
            >
              <ListMusic className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{p.name}</span>
            </button>
            <button
              type="button"
              title="Rename"
              onClick={() => {
                setRenaming(p.id);
                setAdding(false);
                setName(p.name);
              }}
              className="hover-only-action flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 opacity-0 hover:text-brand-300 group-hover:opacity-100"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {confirming === p.id ? (
              <button
                type="button"
                onClick={() => {
                  socket.emit('audio_playlist:delete', { playlistId: p.id });
                  setConfirming(null);
                }}
                className="shrink-0 px-1.5 text-xs font-semibold text-red-300"
              >
                Sure?
              </button>
            ) : (
              <button
                type="button"
                title="Delete playlist"
                onClick={() => setConfirming(p.id)}
                className="hover-only-action flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 opacity-0 hover:text-red-300 group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// **Name on the left half, tools bound to the right end.** Adding a sixth tool
// later appends on the right without moving the five that are already there,
// and the name truncates rather than pushing them off.
function TrackRow({
  track, isPlaying, isCurrent, revealed, first, last, confirming,
  onHover, onTap, onEdit, onMove, onDelete, onConfirmDelete, onCancelDelete,
}) {
  return (
    <div
      onMouseEnter={() => onHover(track.id)}
      onMouseLeave={() => onHover((cur) => (cur === track.id ? null : cur))}
      onClick={onTap}
      className={`flex min-h-11 items-center gap-2 px-2 ${
        isCurrent ? 'bg-brand-600/10' : 'hover:bg-zinc-900'
      }`}
    >
      <span className={`w-1/2 shrink-0 truncate text-sm ${isCurrent ? 'text-brand-300' : 'text-zinc-200'}`}>
        {track.name}
      </span>
      <span className="min-w-0 flex-1" />
      <div
        className={`flex shrink-0 items-center gap-1 transition-opacity ${
          revealed ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={BTN}
          title={isPlaying ? 'Pause' : 'Play for everyone'}
          onClick={() => socket.emit(isPlaying ? 'audio:pause' : 'audio:play', { trackId: track.id })}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button type="button" className={BTN} title="Move up" disabled={first} onClick={() => onMove(-1)}>
          <ChevronUp className="h-4 w-4" />
        </button>
        <button type="button" className={BTN} title="Move down" disabled={last} onClick={() => onMove(1)}>
          <ChevronDown className="h-4 w-4" />
        </button>
        <button type="button" className={BTN} title="Edit" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </button>
        {confirming ? (
          <>
            <button type="button" onClick={onDelete} className="px-1.5 text-xs font-semibold text-red-300">
              Delete?
            </button>
            <button type="button" onClick={onCancelDelete} className="px-1 text-xs text-zinc-500">
              No
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`${BTN} hover:border-red-500 hover:text-red-300`}
            title="Delete"
            onClick={onConfirmDelete}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// **The video's own title is offered, never imposed.** It arrives from the
// server (a browser fetch to youtube.com would be refused by CORS) and only
// fills a name the GM has not typed into — so pasting a link into an empty
// form names the song for you, and re-pasting a link never silently
// overwrites a name you chose.
function TrackEditor({ track, playlistId, onDone, onReject }) {
  const [name, setName] = useState(track?.name ?? '');
  const [url, setUrl] = useState(track ? `https://www.youtube.com/watch?v=${track.youtube_id}` : '');
  const [looking, setLooking] = useState(false);
  const touchedName = useRef(Boolean(track));

  useEffect(() => {
    const onTitle = ({ title }) => {
      setLooking(false);
      if (title && !touchedName.current) setName(title);
    };
    socket.on('audio:title', onTitle);
    return () => socket.off('audio:title', onTitle);
  }, []);

  const lookup = (value) => {
    if (!value.trim()) return;
    setLooking(true);
    socket.emit('audio:lookup_title', { url: value });
  };

  const save = () => {
    if (!url.trim()) return;
    if (track) socket.emit('audio_track:update', { trackId: track.id, name, url });
    else socket.emit('audio_track:create', { playlistId, name, url });
    onDone();
  };

  return (
    <div className="panel-cut-sm flex flex-col gap-2 border border-zinc-700 bg-zinc-900/70 p-3">
      <input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={(e) => lookup(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData?.getData('text');
          if (pasted) setTimeout(() => lookup(pasted), 0);
        }}
        placeholder="YouTube link"
        className="border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
      />
      <input
        value={name}
        onChange={(e) => {
          touchedName.current = true;
          setName(e.target.value);
          onReject?.(null);
        }}
        placeholder={looking ? 'Looking up the title…' : 'Song name'}
        className="border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          className="min-h-11 panel-cut-sm border border-brand-600 bg-brand-700/30 px-3 text-xs font-semibold text-brand-200 hover:bg-brand-700/50 md:min-h-0 md:py-1.5"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onDone}
          className="min-h-11 panel-cut-sm border border-zinc-700 px-3 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 md:min-h-0 md:py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

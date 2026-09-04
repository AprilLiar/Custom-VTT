import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getScenePictures } from '../lib/api.js';
import { fileToScenePicture } from '../lib/image.js';
import Thumb from './Thumb.jsx';

// The Scene tab's shared picture editor (Scene tab plan, Phase 3: upload,
// rename, delete — Phase 1 shipped the list-only skeleton this replaces).
// Parameterized by owner rather than owning its own owner-lookup, so the
// exact same component serves both of this feature's two owner kinds
// without knowing which one it's looking at:
//   - a Character sheet's own final tab (`ownerType: 'character'`)
//   - a Temp NPC's double-click editor, with no tab strip around it at all
//     (`ownerType: 'temp_npc'`) — see CLAUDE.md decision #9: a Temp NPC has
//     nothing else to edit, so this IS the whole dialog.
//
// `canEdit` is passed in rather than derived here — the two callers already
// know the answer from their own context (CharacterSheet's existing
// `canCreate`; TempNpcEditor's own GM-only gate) and re-deriving it a third
// way here would be a second place for that rule to drift. The server is
// the real gate either way (`mayWriteScenePicture`) — this only decides
// whether the upload/rename/delete controls render at all.
//
// No crop step here, unlike every other picture upload in this app:
// `scene_pictures` carries no crop_* columns (see server/db.js's own note),
// and cropping a transparent character cutout the way a portrait photo
// gets cropped doesn't make sense — the art already arrives framed the way
// it's meant to show on the stage.
export default function ScenePicturesEditor({ ownerType, ownerId, canEdit = false }) {
  const [pictures, setPictures] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setPictures(null);
    getScenePictures(ownerType, ownerId)
      .then((rows) => {
        if (!cancelled) setPictures(rows);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [ownerType, ownerId]);

  // Live updates so an already-open editor (e.g. a GM and a Player both
  // looking at the same character) patches without a refetch. `io.emit`
  // reaches every socket regardless of owner, so each handler filters to
  // this instance's own owner before touching state.
  useEffect(() => {
    const ownerKey = ownerType === 'character' ? 'character_id' : 'temp_npc_id';
    const isMine = (picture) => picture[ownerKey] === ownerId;
    const onCreated = (picture) => {
      if (isMine(picture)) setPictures((prev) => (prev ? [...prev, picture] : prev));
    };
    const onUpdated = (picture) => {
      if (isMine(picture)) {
        setPictures((prev) => (prev ? prev.map((p) => (p.id === picture.id ? picture : p)) : prev));
      }
    };
    const onDeleted = ({ scenePictureId }) =>
      setPictures((prev) => (prev ? prev.filter((p) => p.id !== scenePictureId) : prev));
    socket.on('scene_picture:created', onCreated);
    socket.on('scene_picture:updated', onUpdated);
    socket.on('scene_picture:deleted', onDeleted);
    return () => {
      socket.off('scene_picture:created', onCreated);
      socket.off('scene_picture:updated', onUpdated);
      socket.off('scene_picture:deleted', onDeleted);
    };
  }, [ownerType, ownerId]);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const processed = await fileToScenePicture(file);
      if (processed) {
        socket.emit('scene_picture:create', {
          ownerType,
          ownerId,
          name: file.name.replace(/\.[^./]+$/, ''),
          ...processed,
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const rename = (picture) => {
    const name = window.prompt('Name this Scene Picture', picture.name);
    if (name?.trim()) socket.emit('scene_picture:update', { scenePictureId: picture.id, name: name.trim() });
  };

  const remove = (picture) => {
    if (window.confirm(`Delete this Scene Picture${picture.name ? ` ("${picture.name}")` : ''}?`)) {
      socket.emit('scene_picture:delete', { scenePictureId: picture.id });
    }
  };

  if (!pictures) return <p className="text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Transparent PNGs of this {ownerType === 'temp_npc' ? 'Temp NPC' : 'character'}, picked when
        they're summoned onto a Scene. These are separate from the regular portrait above — any
        number, any pose or expression.
      </p>
      {pictures.length === 0 && !canEdit ? (
        <p className="panel-cut-sm border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-600">
          No Scene Pictures yet.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {pictures.map((picture) => (
            <div key={picture.id} className="space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-900 p-2">
              <button
                type="button"
                onClick={canEdit ? () => rename(picture) : undefined}
                disabled={!canEdit}
                title={canEdit ? 'Rename' : undefined}
                className="block w-full"
              >
                <Thumb record={picture} name={picture.name} size="h-20 w-full" cut="panel-cut-sm" />
              </button>
              <p className="truncate text-center text-xs text-zinc-400">{picture.name || 'Untitled'}</p>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(picture)}
                  className="w-full text-[10px] font-bold uppercase tracking-wide text-red-500 hover:text-red-400"
                >
                  Delete
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex h-20 flex-col items-center justify-center gap-1 panel-cut-sm border border-dashed border-zinc-700 text-[10px] font-bold uppercase tracking-wide text-zinc-500 hover:border-brand-600 hover:text-zinc-200 disabled:opacity-40"
            >
              {busy ? '…' : '+ Add picture'}
            </button>
          )}
        </div>
      )}
      {canEdit && <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />}
    </div>
  );
}

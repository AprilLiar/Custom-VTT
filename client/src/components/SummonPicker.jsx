import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getScenePictures } from '../lib/api.js';
import Thumb from './Thumb.jsx';
import DialogShell from './DialogShell.jsx';

// Scene tab plan, Phase 5, decision #4: summoning picks ONE Scene Picture
// from the owner's own library; the same control later swaps which
// picture shows without leaving the stage (pick a different one), or
// un-summons (re-pick the one already showing) — both are just
// `stage:summon` with a different `scenePictureId`, the server sorts out
// which case it is.
//
// One small shared dialog serves both callers: SceneCastDrawer's rows
// (any owner, GM-only) and a Player's own docked control on ScenePage
// (their own character only). Neither caller pre-checks ownership — the
// server's own `mayWriteScenePicture` gate is what actually enforces it;
// a Player who somehow triggered this for someone else's owner would just
// have their `stage:summon` silently refused.
export default function SummonPicker({ ownerType, ownerId, ownerName, currentScenePictureId, onClose }) {
  const [pictures, setPictures] = useState(null);

  useEffect(() => {
    let alive = true;
    getScenePictures(ownerType, ownerId)
      .then((rows) => {
        if (alive) setPictures(rows);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [ownerType, ownerId]);

  const pick = (picture) => {
    socket.emit('stage:summon', { scenePictureId: picture.id });
    onClose();
  };

  return (
    <DialogShell title={`Summon ${ownerName}`} onClose={onClose} maxWidth="max-w-sm" portal>
      {!pictures ? (
        <p className="text-zinc-500">Loading…</p>
      ) : pictures.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No Scene Pictures yet — add one from {ownerName}'s own editor first.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {pictures.map((picture) => {
            const showing = picture.id === currentScenePictureId;
            return (
              <button
                key={picture.id}
                type="button"
                onClick={() => pick(picture)}
                title={showing ? 'Currently showing — click to un-summon' : `Summon with ${picture.name || 'this picture'}`}
                className={`space-y-1 panel-cut-sm border p-2 text-left ${
                  showing
                    ? 'border-brand-500 bg-brand-900/40'
                    : 'border-zinc-800 bg-zinc-900 hover:border-brand-700'
                }`}
              >
                <Thumb record={picture} name={picture.name} size="h-16 w-full" cut="panel-cut-sm" />
                <p className="truncate text-center text-xs text-zinc-400">{picture.name || 'Untitled'}</p>
                {showing && (
                  <p className="text-center text-[9px] font-bold uppercase tracking-wide text-brand-400">
                    On stage
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}
    </DialogShell>
  );
}

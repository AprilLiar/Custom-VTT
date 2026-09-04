import { useEffect, useState } from 'react';
import { getScenePictures } from '../lib/api.js';
import Thumb from './Thumb.jsx';

// The Scene tab's shared picture editor (Scene tab plan, Phase 1: list-only
// skeleton — Phase 3 adds upload/rename/delete). Parameterized by owner
// rather than owning its own owner-lookup, so the exact same component
// serves both of this feature's two owner kinds without knowing which one
// it's looking at:
//   - a Character sheet's own final tab (`ownerType: 'character'`)
//   - a Temp NPC's double-click editor, with no tab strip around it at all
//     (`ownerType: 'temp_npc'`) — see CLAUDE.md decision #9: a Temp NPC has
//     nothing else to edit, so this IS the whole dialog.
//
// `canEdit` is passed in rather than derived here — the two callers already
// know the answer from their own context (CharacterSheet's existing
// `canCreate`; the Temp NPC drawer's own GM-only gate) and re-deriving it a
// third way here would be a second place for that rule to drift.
export default function ScenePicturesEditor({ ownerType, ownerId, canEdit = false }) {
  const [pictures, setPictures] = useState(null);

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

  if (!pictures) return <p className="text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Transparent PNGs of this {ownerType === 'temp_npc' ? 'Temp NPC' : 'character'}, picked when
        they're summoned onto a Scene. These are separate from the regular portrait above — any
        number, any pose or expression.
      </p>
      {pictures.length === 0 ? (
        <p className="panel-cut-sm border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-600">
          No Scene Pictures yet.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {pictures.map((picture) => (
            <div key={picture.id} className="space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-900 p-2">
              <Thumb record={picture} name={picture.name} size="h-20 w-full" cut="panel-cut-sm" />
              <p className="truncate text-center text-xs text-zinc-400">{picture.name || 'Untitled'}</p>
            </div>
          ))}
        </div>
      )}
      {/* Upload/rename/delete arrive in Phase 3, once scene_picture:create
          etc. exist server-side — canEdit is already threaded through so
          that phase only has to add controls here, not re-plumb access. */}
    </div>
  );
}

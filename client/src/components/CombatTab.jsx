import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getCombatSetup } from '../lib/api.js';
import { fileToPortrait } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import CroppedImage from './CroppedImage.jsx';
import BuildTab from './builder/BuildTab.jsx';

// A character's Combat tab (Panic at the Dojo). **Purged for the character
// builder (decided, builder phase 0):** the hand-made Stances, Unique token
// picks, Reminders and Armor sources are gone; only the combat token picture
// stays, above the character builder (builder/BuildTab.jsx): hero type,
// Archetypes, Forms, Styles, Build, Skills and level, with Stances derived
// from them — see vttprojectplan.md, "Character builder & turn automation".
//
// `canEdit` only decides whether controls render; the server checks for itself.

export default function CombatTab({ ownerType, ownerId, canEdit = false, ownerName = '', isNpc = false }) {
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    getCombatSetup(ownerType, ownerId)
      .then(({ profile: p }) => {
        if (!cancelled) setProfile(p);
      })
      .catch(console.error);
    const onProfile = (ev) => {
      if (ev.ownerType === ownerType && Number(ev.ownerId) === Number(ownerId)) setProfile(ev.profile);
    };
    socket.on('combat_profile:updated', onProfile);
    return () => {
      cancelled = true;
      socket.off('combat_profile:updated', onProfile);
    };
  }, [ownerType, ownerId]);

  if (!profile) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-6">
      <TokenPicture ownerType={ownerType} ownerId={ownerId} profile={profile} canEdit={canEdit} name={ownerName} />
      {ownerType === 'character' && <BuildTab characterId={ownerId} canEdit={canEdit} isNpc={isNpc} />}
    </div>
  );
}

function TokenPicture({ ownerType, ownerId, profile, canEdit, name }) {
  const fileRef = useRef(null);
  const { pick, dialog, busy } = usePictureUpload({
    process: fileToPortrait,
    name,
    previewSizes: [
      { label: 'On the map', px: 48 },
      { label: 'In the turn order', px: 64 },
      { label: 'On the token panel', px: 96 },
    ],
    onPicked: (fields) => socket.emit('combat_profile:update', { ownerType, ownerId, ...fields }),
  });
  return (
    <section className="flex items-center gap-4">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => fileRef.current?.click()}
        title={canEdit ? 'Choose the combat token picture' : undefined}
        className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-zinc-600 bg-zinc-800 shadow-[0_0_0_3px_rgba(0,0,0,0.6)] enabled:hover:border-brand-500"
      >
        {busy ? (
          <span className="text-xs text-zinc-500">…</span>
        ) : profile.image_url ? (
          <CroppedImage src={profile.image_url} crop={cropOf(profile)} alt={name} className="h-full w-full rounded-full" />
        ) : (
          <span className="px-2 text-center text-xs text-zinc-500">{canEdit ? 'Add token' : 'No token'}</span>
        )}
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
      {dialog}
      <div>
        <h3 className="font-display text-sm font-bold uppercase tracking-wide text-zinc-300">Combat token</h3>
        <p className="text-xs text-zinc-500">
          The round token placed on the Combat map. The crop chooses what shows inside the circle.
        </p>
        {canEdit && profile.image_url && (
          <button
            type="button"
            onClick={() => socket.emit('combat_profile:update', { ownerType, ownerId, clearImage: true })}
            className="mt-1 text-xs font-semibold text-red-500 hover:text-red-400"
          >
            Remove token picture
          </button>
        )}
      </div>
    </section>
  );
}


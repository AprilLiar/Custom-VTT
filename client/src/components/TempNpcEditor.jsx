import { useRef, useState } from 'react';
import { socket } from '../socket.js';
import { fileToPortrait, portraitSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import CroppedImage from './CroppedImage.jsx';
import DialogShell from './DialogShell.jsx';
import ScenePicturesEditor from './ScenePicturesEditor.jsx';

// The Temp NPC's whole editor (Scene tab plan, decision #9): unlike a real
// NPC, which already has a full CharacterSheet, a Temp NPC has nothing else
// to edit — double-clicking one in SceneCastDrawer opens straight into this
// dialog, which embeds the very same Scene Pictures editor every character
// gets on its own sheet tab.
//
// Edit-only: a brand-new Temp NPC is created inline in the drawer's own
// name field (mirroring FolderTreeNav's own "+ New folder" form right next
// to it), never through this dialog — Scene Pictures need an owner id to
// attach to, so there is nothing this dialog could show before the row
// exists anyway.
//
// The portrait here is the Temp NPC's own regular picture (its Thumb
// everywhere in the drawer) — reuses fileToPortrait/usePictureUpload/the
// crop dialog exactly like PersonEditor's own board-local person, since
// temp_npcs carries the same crop_* columns a portrait needs. Not to be
// confused with Scene Pictures below, which have no crop step at all.
export default function TempNpcEditor({ tempNpc, onClose }) {
  const [name, setName] = useState(tempNpc.name);
  const [picture, setPicture] = useState(null);
  const fileRef = useRef(null);

  const preview = picture
    ? `data:${picture.imageMimeType};base64,${picture.imageData}`
    : portraitSrc(tempNpc);
  const previewCrop = picture
    ? cropOf({ crop_x: picture.cropX, crop_y: picture.cropY, crop_w: picture.cropW, crop_h: picture.cropH })
    : cropOf(tempNpc);

  const { pick, dialog, busy } = usePictureUpload({
    process: fileToPortrait,
    name,
    previewSizes: [
      { label: 'In the drawer', px: 24 },
      { label: 'On a card', px: 88 },
    ],
    onPicked: setPicture,
  });

  const save = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    socket.emit('temp_npc:update', { tempNpcId: tempNpc.id, name: trimmed, ...(picture ?? {}) });
  };

  const remove = () => {
    if (window.confirm(`Delete ${tempNpc.name}? This removes their Scene Pictures too.`)) {
      socket.emit('temp_npc:delete', { tempNpcId: tempNpc.id });
      onClose();
    }
  };

  return (
    <DialogShell title={tempNpc.name} onClose={onClose} maxWidth="max-w-sm" portal>
      <form onSubmit={save} className="space-y-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="shrink-0 panel-cut border border-zinc-700 bg-zinc-800 hover:border-brand-600"
            style={{ width: 64, height: 64 }}
            title="Choose a picture"
          >
            {preview ? (
              <CroppedImage src={preview} crop={previewCrop} className="h-full w-full panel-cut" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[9px] font-bold uppercase tracking-wide text-zinc-500">
                {busy ? '…' : 'Add picture'}
              </span>
            )}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
          {dialog}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            autoFocus
            className="min-h-11 min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-brand-500"
          />
        </div>
        <button
          type="submit"
          disabled={!name.trim()}
          className="min-h-11 w-full panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={remove}
          className="text-xs font-semibold text-red-500 hover:text-red-400"
        >
          Delete Temp NPC
        </button>
      </form>
      <div className="mt-4 border-t border-zinc-800 pt-4">
        <ScenePicturesEditor ownerType="temp_npc" ownerId={tempNpc.id} canEdit />
      </div>
    </DialogShell>
  );
}

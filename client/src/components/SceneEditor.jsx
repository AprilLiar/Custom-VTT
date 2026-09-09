import { useRef, useState } from 'react';
import { socket } from '../socket.js';
import { fileToSceneBackground, portraitSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import CroppedImage from './CroppedImage.jsx';
import DialogShell from './DialogShell.jsx';
import { BACKGROUND_FIT_OPTIONS, DEFAULT_BACKGROUND_FIT } from '../lib/backgroundFit.js';

// A Scene's editor (Scene tab plan, Phase 4) — double-clicking a row in
// SceneListDrawer opens this; single-clicking it activates the Scene
// instead (see that file's own comment for the split). Structurally the
// same shape as TempNpcEditor: a name field, a picture picker with the crop
// dialog (scenes carries the same crop_* columns a portrait needs — that
// crop is the right-drawer THUMBNAIL only, never what the live stage
// renders), a Background Fit picker, and a delete button. No embedded
// ScenePicturesEditor here — Scene Pictures belong to a Character or a Temp
// NPC, never to a Scene itself.
//
// **Background Fit is per-Scene, not a Settings-page slider (decided).**
// How this Scene's own backdrop art scales inside the stage box is an
// authored property of that art — a battle map's own edges can carry real
// information a Player's device happening to crop away would hide from
// them specifically, with no way for the GM to know or fix it per-viewer —
// so it's edited HERE, alongside the picture itself, and applies
// identically to every viewer (see db.js's own comment on
// scenes.background_fit for the fuller reasoning).
export default function SceneEditor({ scene, onClose }) {
  const [name, setName] = useState(scene.name);
  const [picture, setPicture] = useState(null);
  // **Best Fit, not Cover, for a Scene that has no backdrop yet (decided).**
  // `scenes.background_fit` defaults to 'cover' at the schema level (every
  // Scene needs SOME value, and Cover was the only mode that existed before
  // this setting shipped), so `scene.background_fit` is never actually
  // falsy — reading it straight would always show "Cover" pre-selected,
  // schema default or not. Read only once a backdrop already exists: at
  // that point it's a real choice (the GM's own, or Cover from before this
  // setting existed) and has to be respected as-is, never silently swapped
  // out from under an already-placed backdrop. A Scene with nothing
  // uploaded yet has no real choice to respect, so the picker opens on
  // Best Fit — the mode that shows the whole image regardless of how a
  // GM's own screen happens to be shaped, which is the safer thing to see
  // first the moment there IS something to upload.
  const [backgroundFit, setBackgroundFit] = useState(
    scene.image_data ? scene.background_fit || DEFAULT_BACKGROUND_FIT : 'contain'
  );
  const fileRef = useRef(null);

  const preview = picture
    ? `data:${picture.imageMimeType};base64,${picture.imageData}`
    : portraitSrc(scene);
  const previewCrop = picture
    ? cropOf({ crop_x: picture.cropX, crop_y: picture.cropY, crop_w: picture.cropW, crop_h: picture.cropH })
    : cropOf(scene);

  const { pick, dialog, busy } = usePictureUpload({
    process: fileToSceneBackground,
    name,
    previewSizes: [
      { label: 'In the drawer', px: 40 },
      { label: 'Full width', px: 320 },
    ],
    onPicked: setPicture,
  });

  const save = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    socket.emit('scene:update', { sceneId: scene.id, name: trimmed, backgroundFit, ...(picture ?? {}) });
  };

  const remove = () => {
    if (window.confirm(`Delete ${scene.name}? This cannot be undone.`)) {
      socket.emit('scene:delete', { sceneId: scene.id });
      onClose();
    }
  };

  return (
    <DialogShell title={scene.name} onClose={onClose} maxWidth="max-w-sm" portal>
      <form onSubmit={save} className="space-y-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="shrink-0 panel-cut border border-zinc-700 bg-zinc-800 hover:border-brand-600"
            style={{ width: 64, height: 64 }}
            title="Choose a backdrop"
          >
            {preview ? (
              <CroppedImage src={preview} crop={previewCrop} className="h-full w-full panel-cut" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[9px] font-bold uppercase tracking-wide text-zinc-500">
                {busy ? '…' : 'Add backdrop'}
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
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Background Fit
          </label>
          <select
            value={backgroundFit}
            onChange={(e) => setBackgroundFit(e.target.value)}
            className="min-h-11 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-brand-500"
          >
            {BACKGROUND_FIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={!name.trim()}
          className="min-h-11 w-full panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          Save
        </button>
        <button type="button" onClick={remove} className="text-xs font-semibold text-red-500 hover:text-red-400">
          Delete Scene
        </button>
      </form>
    </DialogShell>
  );
}

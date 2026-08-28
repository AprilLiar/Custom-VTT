import { useRef, useState } from 'react';
import { fileToSmallImage } from '../lib/image.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import Thumb from './Thumb.jsx';

// Perk Creator: picture, name, description. Mechanical effects are no
// longer configured here — they're manual, case-by-case code in
// server/perkAutomations.js's PERK_HOOKS, keyed by the Perk's name.
//
// initial is a full Perk record for edit mode; onSubmit receives the socket
// payload minus perkId. `tags` is the Perk Tag vocabulary (its own list, not
// the Move tag one) — optional categorisation with no mechanics behind it.
export default function PerkCreator({ initial, tags = [], onSubmit, onCancel }) {
  const fileRef = useRef(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [tagIds, setTagIds] = useState(initial?.tag_ids ?? []);
  const [image, setImage] = useState(undefined); // undefined = keep existing

  const toggleTag = (id) =>
    setTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  // `image` stays `undefined` until a picture is actually chosen, which is how
  // edit mode says "keep the existing one" — the crop rides along inside it, so
  // a Perk edited without touching its art keeps both.
  const { pick: pickImage, dialog } = usePictureUpload({
    process: (file) => fileToSmallImage(file).catch(() => undefined),
    name,
    previewSizes: [
      { label: 'On the Perk card', px: 48 },
      { label: 'In a list', px: 24 },
    ],
    onPicked: setImage,
  });

  const valid = Boolean(name.trim());

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      tagIds,
      ...(image !== undefined ? image : {}),
    });
  };

  const preview =
    image !== undefined
      ? {
          image_data: image?.imageData,
          image_mime_type: image?.imageMimeType,
          crop_x: image?.cropX,
          crop_y: image?.cropY,
          crop_w: image?.cropW,
          crop_h: image?.cropH,
        }
      : initial;

  return (
    <form onSubmit={submit} className="space-y-3 panel-cut-lg border border-zinc-700 bg-zinc-900 p-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        {initial ? 'Edit Perk' : 'Perk Creator'}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload Perk art (optional)"
          className="panel-cut border border-zinc-700 hover:border-brand-500"
        >
          <Thumb record={preview} name={name || '?'} size="h-12 w-12" cut="panel-cut" />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Perk name"
          className="min-w-40 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-brand-500"
        />
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
      />

      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
          Tags ({tagIds.length}) — categorisation only
        </p>
        {tags.length === 0 ? (
          <p className="text-xs text-zinc-600">
            No Perk tags exist yet — create them in the Perk Tags section.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const selected = tagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleTag(tag.id)}
                  title={tag.description || undefined}
                  className={`panel-cut border px-2 py-1 text-xs font-semibold ${
                    selected
                      ? 'border-sky-500 bg-sky-600/25 text-sky-200'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid}
          className="flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          {initial ? 'Save Perk' : 'Create Perk'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="panel-cut-sm border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
      {dialog}
    </form>
  );
}

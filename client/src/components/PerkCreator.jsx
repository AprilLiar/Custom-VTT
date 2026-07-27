import { useRef, useState } from 'react';
import { fileToSmallImage } from '../lib/image.js';
import Thumb from './Thumb.jsx';

// Perk Creator: picture, name, description. Mechanical effects are no
// longer configured here — they're manual, case-by-case code in
// server/perkAutomations.js's PERK_HOOKS, keyed by the Perk's name.
//
// initial is a full Perk record for edit mode; onSubmit receives the socket
// payload minus perkId.
export default function PerkCreator({ initial, onSubmit, onCancel }) {
  const fileRef = useRef(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [image, setImage] = useState(undefined); // undefined = keep existing

  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImage(await fileToSmallImage(file).catch(() => undefined));
  };

  const valid = Boolean(name.trim());

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      ...(image !== undefined ? image : {}),
    });
  };

  const preview =
    image !== undefined
      ? { image_data: image?.imageData, image_mime_type: image?.imageMimeType }
      : initial;

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        {initial ? 'Edit Perk' : 'Perk Creator'}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload Perk art (optional)"
          className="rounded-lg border border-zinc-700 hover:border-indigo-500"
        >
          <Thumb record={preview} name={name || '?'} size="h-12 w-12" rounded="rounded-lg" />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Perk name"
          className="min-w-40 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
        />
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
      />

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid}
          className="flex-1 rounded-md bg-indigo-600 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          {initial ? 'Save Perk' : 'Create Perk'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-700 px-4 text-zinc-400 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

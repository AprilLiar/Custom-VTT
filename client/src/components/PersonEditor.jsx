import { useRef, useState } from 'react';
import { socket } from '../socket.js';
import { fileToPortrait, portraitSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import CroppedImage from './CroppedImage.jsx';
import { BoardDialog } from './RelationshipBoard.jsx';

// Making up somebody who was never a fighter.
//
// The app's Character Sheet is a fighter's sheet — Stats, Stances, Moves — so a
// bartender your character owes money to has nowhere to exist in the world. A
// board-local person is the answer: a name, a face, and nothing else, because
// nothing else is needed to think about them.
//
// **Name is the only required field.** A face with no name is not somebody you
// can reason about, and the rail would show a blank row. The picture falls back
// to the same first-letter placeholder every portrait in this app falls back to.
//
// Reuses `fileToPortrait` — the identical 800px/JPEG-q0.8 canvas resize a real
// character portrait goes through — so a board-local person costs the same
// bytes as anybody else and rides comfortably inside the socket's 8MB frame.

export default function PersonEditor({ ownerCharacterId, person, onClose }) {
  const [name, setName] = useState(person?.name ?? '');
  const [picture, setPicture] = useState(null);
  const fileRef = useRef(null);

  const preview = picture
    ? `data:${picture.imageMimeType};base64,${picture.imageData}`
    : portraitSrc(person);
  // A freshly chosen picture carries its own crop; an unchanged one keeps
  // whatever the stored row already has.
  const previewCrop = picture
    ? cropOf({ crop_x: picture.cropX, crop_y: picture.cropY, crop_w: picture.cropW, crop_h: picture.cropH })
    : cropOf(person);

  const { pick, dialog, busy } = usePictureUpload({
    process: fileToPortrait,
    name,
    previewSizes: [
      { label: 'On the board', px: 112 },
      { label: 'In the rail', px: 32 },
    ],
    onPicked: setPicture,
  });

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    socket.emit(
      person ? 'relationships:update_person' : 'relationships:create_person',
      person
        ? { personId: person.id, name: trimmed, ...(picture ?? {}) }
        : { characterId: ownerCharacterId, name: trimmed, ...(picture ?? {}) }
    );
    onClose();
  };

  return (
    <BoardDialog
      title={person ? `Edit ${person.name}` : 'Someone new'}
      onClose={onClose}
      onSave={save}
      saveLabel={person ? 'Save' : 'Create'}
      disabled={!name.trim() || busy}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={() => fileRef.current?.click()}
          className="shrink-0 panel-cut border border-zinc-700 bg-zinc-800 hover:border-brand-600"
          style={{ width: 88, height: 88 }}
          title="Choose a picture"
        >
          {preview ? (
            <CroppedImage src={preview} crop={previewCrop} className="h-full w-full panel-cut" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[10px] font-bold uppercase tracking-wide text-zinc-500">
              {busy ? '…' : 'Add picture'}
            </span>
          )}
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
        {dialog}
        <label className="min-w-0 flex-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
            Name <span className="text-brand-400">*</span>
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
            placeholder="Who are they?"
            className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
          <p className="mt-2 text-[10px] leading-snug text-zinc-600">
            They exist on your board only. Nickname and notes live on each
            placement, so you can drag them out twice and say something different
            about each.
          </p>
        </label>
      </div>
      {person && (
        <button
          onClick={() => {
            if (!window.confirm(`Delete ${person.name} and every placement of them?`)) return;
            socket.emit('relationships:delete_person', { personId: person.id });
            onClose();
          }}
          className="self-start text-[10px] font-bold uppercase tracking-wide text-zinc-600 hover:text-brand-400"
        >
          Delete this person
        </button>
      )}
    </BoardDialog>
  );
}

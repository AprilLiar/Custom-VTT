import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { updateCharacter } from '../lib/api.js';
import { fileToPortrait, portraitSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { usePictureUpload } from '../lib/usePictureUpload.jsx';
import CroppedImage from './CroppedImage.jsx';

// The character's name and profile picture, above every tab of the sheet.
//
// **Moved, not rewritten (the pivot).** This lived at the top of the Core Stats
// tab, which was the only place a character could be renamed or given a
// portrait. Core Stats went with the old system; these two did not, so they
// moved up here unchanged and now sit above Counters, Role-play, Relationships
// and Scene Pictures alike.
export default function CharacterHeader({ character }) {
  const fileRef = useRef(null);
  const nameRef = useRef(null);
  const [name, setName] = useState(character.name);
  const debounceRef = useRef(null);

  // Follow live renames from other devices unless this input is being edited
  useEffect(() => {
    if (document.activeElement !== nameRef.current) setName(character.name);
  }, [character.name]);

  const onNameChange = (value) => {
    setName(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim() && value.trim() !== character.name) {
        updateCharacter(character.id, { name: value.trim() }).catch(console.error);
      }
    }, 500);
  };

  // The crop step sits between the file picker and the save — only the square
  // frames use the crop; the picture itself is stored whole.
  const { pick, dialog, busy } = usePictureUpload({
    process: fileToPortrait,
    name,
    previewSizes: [
      { label: 'In the roster', px: 32 },
      { label: 'On the sheet', px: 96 },
      { label: 'On a relationship board', px: 112 },
    ],
    onPicked: (fields) => updateCharacter(character.id, fields),
  });

  const src = portraitSrc(character);
  return (
    <div className="mb-3 flex items-center gap-4">
      <motion.button
        onClick={() => fileRef.current?.click()}
        title="Click to upload / replace portrait"
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden border border-zinc-700 bg-zinc-800 [clip-path:polygon(0_0,100%_0,100%_88%,88%_100%,0_100%)] hover:border-brand-500"
      >
        {busy ? (
          <span className="text-xs text-zinc-500">…</span>
        ) : src ? (
          <CroppedImage src={src} alt={character.name} crop={cropOf(character)} className="h-full w-full" />
        ) : (
          <span className="px-1 text-center text-xs text-zinc-500">Add portrait</span>
        )}
      </motion.button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
      {dialog}
      <div className="min-w-0 flex-1">
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="w-full panel-cut-sm border border-transparent bg-transparent px-2 py-1 font-display text-3xl font-bold uppercase tracking-wide text-zinc-100 outline-none hover:border-zinc-700 focus:border-brand-500"
        />
        {character.character_type === 'npc' && (
          <span className="ml-2 panel-cut-sm bg-purple-600/30 px-1.5 text-xs font-bold uppercase text-purple-300">
            NPC
          </span>
        )}
      </div>
    </div>
  );
}

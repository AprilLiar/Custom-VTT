import { useState } from 'react';
import Thumb from './Thumb.jsx';
import SummonPicker from './SummonPicker.jsx';

// A Player's own docked summon control (Scene tab plan, Phase 5) —
// ScenePage's Player-side counterpart to the GM's SceneCastDrawer. One button
// per character the Player controls: their own PC first, then every NPC the GM
// assigned to them (see useControl). Docked bottom-left so it never collides
// with the corner "Back" link (top-left) or either GM-only drawer (both absent
// for a Player anyway). z-[1000] — matches ScenePage's own TopLeftControls
// value, so this stays clickable even while SceneDrawingLayer's canvas is
// capturing pointer events for an active draw/erase tool (its own
// STAGE_DRAWING_Z is 700).
export default function PlayerSummonDock({ characters = [], summons }) {
  const [pickerFor, setPickerFor] = useState(null); // the character whose picker is open

  if (!characters.length) return null;
  const summonOf = (c) => summons?.find((s) => s.character_id === c.id);
  const own = characters[0];
  const openSummon = pickerFor ? summonOf(pickerFor) : null;

  return (
    <>
      <div
        className="absolute bottom-3 left-3 flex flex-col-reverse items-start gap-1.5"
        style={{ zIndex: 1000, marginBottom: 'var(--safe-bottom)', marginLeft: 'var(--safe-left)' }}
      >
        {characters.map((character) => {
          const mySummon = summonOf(character);
          const isOwn = character.id === own.id;
          return (
            <button
              key={character.id}
              type="button"
              onClick={() => setPickerFor(character)}
              title={mySummon ? `Change how ${isOwn ? 'you appear' : `${character.name} appears`} on stage` : `Summon ${isOwn ? 'yourself' : character.name} onto the stage`}
              className={`flex items-center gap-2 panel-cut-sm border p-1.5 pr-3 ${
                mySummon
                  ? 'border-brand-500 bg-brand-900/60 text-brand-200'
                  : 'border-zinc-700 bg-zinc-900/80 text-zinc-300 hover:border-brand-500'
              }`}
            >
              <Thumb record={character} name={character.name} size="h-8 w-8" />
              <span className="text-xs font-semibold">
                {isOwn ? (mySummon ? 'On stage' : 'Summon yourself') : mySummon ? `${character.name} on stage` : `Summon ${character.name}`}
              </span>
            </button>
          );
        })}
      </div>
      {pickerFor && (
        <SummonPicker
          ownerType="character"
          ownerId={pickerFor.id}
          ownerName={pickerFor.name}
          currentScenePictureId={openSummon?.scene_picture_id ?? null}
          onClose={() => setPickerFor(null)}
        />
      )}
    </>
  );
}

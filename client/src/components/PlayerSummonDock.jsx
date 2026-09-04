import { useMemo, useState } from 'react';
import { useRoster } from '../lib/useRoster.js';
import Thumb from './Thumb.jsx';
import SummonPicker from './SummonPicker.jsx';

// A Player's own docked summon control (Scene tab plan, Phase 5) —
// ScenePage's Player-side counterpart to the GM's SceneCastDrawer, scoped
// to their own character only (the GM's drawer never lists a PC — a Player
// summons themselves from here, nowhere else). Docked bottom-left so it
// never collides with the corner "Back to the Arena" link (top-left) or
// either GM-only drawer (both absent for a Player anyway).
export default function PlayerSummonDock({ characterId, summons }) {
  const characters = useRoster();
  const [pickerOpen, setPickerOpen] = useState(false);
  const character = useMemo(() => characters?.find((c) => c.id === characterId), [characters, characterId]);

  const mySummon = summons?.find((s) => s.character_id === characterId);

  if (!character) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        title={mySummon ? 'Change how you appear on stage' : 'Summon yourself onto the stage'}
        className={`absolute bottom-3 left-3 z-20 flex items-center gap-2 panel-cut-sm border p-1.5 pr-3 ${
          mySummon
            ? 'border-brand-500 bg-brand-900/60 text-brand-200'
            : 'border-zinc-700 bg-zinc-900/80 text-zinc-300 hover:border-brand-500'
        }`}
        style={{ marginBottom: 'var(--safe-bottom)', marginLeft: 'var(--safe-left)' }}
      >
        <Thumb record={character} name={character.name} size="h-8 w-8" />
        <span className="text-xs font-semibold">{mySummon ? 'On stage' : 'Summon yourself'}</span>
      </button>
      {pickerOpen && (
        <SummonPicker
          ownerType="character"
          ownerId={characterId}
          ownerName={character.name}
          currentScenePictureId={mySummon?.scene_picture_id ?? null}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

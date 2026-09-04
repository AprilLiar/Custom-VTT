import { useState } from 'react';
import { socket } from '../socket.js';
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
export default function TempNpcEditor({ tempNpc, onClose }) {
  const [name, setName] = useState(tempNpc.name);

  const save = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    socket.emit('temp_npc:update', { tempNpcId: tempNpc.id, name: trimmed });
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
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            autoFocus
            className="min-h-11 w-0 min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="min-h-11 shrink-0 panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
          >
            Save
          </button>
        </div>
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

import { useMemo, useState } from 'react';
import { buildFolderTree } from '../lib/folders.js';
import { portraitSrc } from '../lib/image.js';
import { FolderRosterNode } from './FolderRoster.jsx';

// The cast, down the right-hand fifth of the Relationships tab.
//
// Three sections, in this order and for this reason:
//   1. **You**, pinned at the top and outside every folder. You are the one
//      person on this board who is not somebody the GM filed.
//   2. **Custom** — the people who exist only on this board, in glowing white.
//      Not a `character_folders` row and never will be: these belong to one
//      player's board, and putting them in the world's folder tree would put
//      them in everybody's.
//   3. **The world's NPCs**, in the GM's own nested folders, exactly as the
//      Arena's seating rail shows them — same component, same collapse rules.
//
// **Players see NPCs here.** That is a deliberate exception to the rule that a
// Player never sees an NPC outside combat (CharacterList filters them, and a
// Player is bounced off an NPC sheet). The Arena roster is the existing
// precedent: knowing who exists in the world is not the same as reading their
// sheet, and a relationship map is worthless without the cast.

export default function RelationshipRail({
  me,
  npcs,
  folders,
  people = [],
  onCreatePerson,
  canEdit,
}) {
  const [collapsed, setCollapsed] = useState(new Set());
  const [customCollapsed, setCustomCollapsed] = useState(false);

  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const npcsByFolder = useMemo(() => {
    const map = new Map();
    for (const c of npcs) {
      const key = c.folder_id ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [npcs]);

  const tree = useMemo(() => buildFolderTree(folders ?? []), [folders]);
  const folderless = npcsByFolder.get(null) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto panel-cut border border-zinc-800 bg-zinc-900/60 p-2">
      <SectionLabel>You</SectionLabel>
      {me && <RailCard record={me} />}

      <div>
        <button
          onClick={() => setCustomCollapsed((v) => !v)}
          className="flex w-full items-center gap-1 panel-cut-sm py-1 text-left text-[10px] font-bold uppercase tracking-wide text-white hover:text-white"
          // The glow is the point: this folder is yours and nobody else's, and
          // it should read as different from the GM's folders at a glance.
          style={{ textShadow: '0 0 8px rgba(255,255,255,0.65)' }}
        >
          <span className="shrink-0">{customCollapsed ? '▸' : '▾'}</span>
          <span className="min-w-0 flex-1 truncate">✨ Custom</span>
          <span className="shrink-0 normal-case text-zinc-500">({people.length})</span>
        </button>
        {!customCollapsed && (
          <div className="space-y-2 pb-1 pl-2.5">
            {people.map((p) => (
              <RailCard key={`person-${p.id}`} record={p} />
            ))}
            {canEdit && (
              <button
                onClick={onCreatePerson}
                className="w-full panel-cut-sm border border-dashed border-zinc-700 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 hover:border-brand-600 hover:text-zinc-200"
              >
                + New person
              </button>
            )}
            {!people.length && !canEdit && (
              <p className="px-1 text-[10px] text-zinc-600">Nobody yet.</p>
            )}
          </div>
        )}
      </div>

      <SectionLabel>The world</SectionLabel>
      {tree.map((node) => (
        <FolderRosterNode
          key={node.id}
          node={node}
          charsByFolder={npcsByFolder}
          collapsed={collapsed}
          onToggle={toggle}
          depth={0}
          rosterCard={(c) => <RailCard key={c.id} record={c} />}
        />
      ))}
      {folderless.length > 0 && (
        <div>
          <SectionLabel>Folderless</SectionLabel>
          <div className="space-y-2">
            {folderless.map((c) => (
              <RailCard key={c.id} record={c} />
            ))}
          </div>
        </div>
      )}
      {!npcs.length && (
        <p className="px-1 text-[11px] text-zinc-600">
          The world has no NPCs yet. Ask your GM, or make someone of your own above.
        </p>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="px-1 pt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
      {children}
    </div>
  );
}

// One person in the rail. Duck-typed on `{ name, image_data, image_mime_type }`
// so a world character row and a board-local person row render identically —
// which is the point: once somebody is on the board, where they came from stops
// mattering to everything except deletion.
function RailCard({ record }) {
  const src = portraitSrc(record);
  return (
    <div
      className="flex items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900 p-1 text-left"
      title={record.name}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="h-8 w-8 shrink-0 panel-cut-sm object-cover" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center panel-cut-sm bg-zinc-800 text-xs font-bold text-zinc-600">
          {(record.name ?? '?').slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-300">
        {record.name}
      </span>
    </div>
  );
}

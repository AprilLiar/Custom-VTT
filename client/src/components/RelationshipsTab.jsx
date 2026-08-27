import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { getCharacterFolders } from '../lib/api.js';
import { useIsDesktop } from '../lib/useMediaQuery.js';
import { useRole } from '../roleContext.jsx';
import { useRoster } from '../lib/useRoster.js';
import RelationshipRail from './RelationshipRail.jsx';
import RelationshipVoid from './RelationshipVoid.jsx';

// Phase 1 of the Relationships board: the tab, the void, and the cast.
//
// Nothing can be placed yet — dragging a name out of the rail comes in Phase 2,
// along with the tables that would store it. What this phase settles is the part
// that is expensive to change later and cheap to change now: how the board
// claims space on a sheet capped at 768px, how the camera feels, and what the
// void looks like.
//
// **Two ways to be big.** Inline, the tab breaks the sheet's `max-w-3xl` and
// takes a fixed slab of viewport height. Fullscreen portals the whole thing over
// the app — past the header, the chat panel and the tab strip — because a
// relationship web outgrows a column quickly and the 320px chat panel is worth
// reclaiming. Escape comes back.
//
// The height below is a magic number and is meant to be: the alternative is a
// calc() against a header, an optional combat bar and a mobile bottom nav, any
// of which can change height on its own. A slab plus a fullscreen escape hatch
// is more robust than arithmetic that is wrong the moment a fight starts.
const INLINE_HEIGHT = 'h-[clamp(22rem,calc(100dvh-15rem),46rem)]';

export default function RelationshipsTab({ data }) {
  const { role, characterId: myCharacterId } = useRole();
  const isDesktop = useIsDesktop();
  const [fullscreen, setFullscreen] = useState(false);
  const [folders, setFolders] = useState([]);
  const roster = useRoster();

  const character = data.character;
  // Decision: the GM may see and edit any board; a Player only their own. Phone
  // is view-and-navigate only — precise pointer work has no room on that screen.
  const canEdit = isDesktop && (role === 'gm' || myCharacterId === character.id);

  useEffect(() => {
    let alive = true;
    getCharacterFolders()
      .then((list) => alive && setFolders(list))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => e.key === 'Escape' && setFullscreen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const npcs = (roster ?? []).filter((c) => c.character_type === 'npc');
  const me = (roster ?? []).find((c) => c.id === character.id) ?? character;

  const board = (
    <div className="flex h-full min-h-0 gap-2">
      <RelationshipVoid
        characterId={character.id}
        interactive
        className="min-w-0 flex-1 panel-cut border border-zinc-800"
      >
        {/* Phase 2 fills this with nodes. The marker is here so the void is
            visibly a *place* rather than an empty box you cannot tell you are
            moving through — without it, panning an unmarked plane looks broken. */}
        <Origin />
      </RelationshipVoid>
      <div className="hidden w-52 shrink-0 md:block lg:w-60">
        <RelationshipRail
          me={me}
          npcs={npcs}
          folders={folders}
          people={[]}
          canEdit={canEdit}
          onCreatePerson={() => {}}
        />
      </div>
    </div>
  );

  const toggle = (
    <button
      onClick={() => setFullscreen((v) => !v)}
      className="flex items-center gap-1 panel-cut-sm border border-zinc-700 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
    >
      {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      {fullscreen ? 'Exit' : 'Fullscreen'}
    </button>
  );

  if (fullscreen) {
    // Portalled to body deliberately. The void sets a `transform` on its world
    // layer, and a transformed ancestor makes `position: fixed` resolve against
    // that ancestor instead of the viewport — the exact trap this codebase has
    // already hit three times (see MovePickerDialog and the Arena hover cards).
    return createPortal(
      <div className="fixed inset-0 z-[90] flex flex-col gap-2 bg-zinc-950 p-2">
        <div className="flex shrink-0 items-center gap-2">
          <h2 className="font-display text-sm font-bold uppercase tracking-wide text-zinc-300">
            {character.name} — Relationships
          </h2>
          <span className="text-[10px] uppercase tracking-wide text-zinc-600">Esc to exit</span>
          <div className="ml-auto">{toggle}</div>
        </div>
        <div className="min-h-0 flex-1">{board}</div>
      </div>,
      document.body
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-zinc-500">
          {canEdit
            ? 'Drag to pan, scroll to move, ⌘/Ctrl-scroll to zoom.'
            : 'Look around: drag to pan, pinch or ⌘/Ctrl-scroll to zoom.'}
        </p>
        <div className="ml-auto">{toggle}</div>
      </div>
      <div className={`${INLINE_HEIGHT} min-h-0`}>{board}</div>
      {!isDesktop && (
        <p className="text-[10px] uppercase tracking-wide text-zinc-600">
          Editing the board needs a bigger screen — here you can look around it.
        </p>
      )}
    </div>
  );
}

// A faint origin marker, so panning an empty plane still reads as motion.
function Origin() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{ left: -60, top: -60, width: 120, height: 120 }}
    >
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-zinc-100/5" />
      <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-zinc-100/5" />
    </div>
  );
}

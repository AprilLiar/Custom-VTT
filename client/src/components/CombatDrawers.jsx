import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { socket } from '../socket.js';
import { getCombatProfiles } from '../lib/api.js';
import { useRoster } from '../lib/useRoster.js';
import { useCharacterFolders as useSharedCharacterFolders } from '../lib/sceneLists.js';
import { buildFolderTree } from '../lib/folders.js';
import { FolderRosterNode } from './FolderRoster.jsx';
import { beginFighterDrag } from '../lib/combatDrag.js';
import { fileToSceneBackground } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import { GRID_OFFSET_LIMIT, GRID_SIZE_MAX, GRID_SIZE_MIN, normalizeGrid } from '../lib/combatGrid.js';
import CroppedImage from './CroppedImage.jsx';

// The Combat mode's side panels (Panic at the Dojo, Phase 3), standing in for
// the Scene drawers while the map is up:
//   - CombatFightersDrawer (GM, left): every Character and Temp NPC, each
//     dragged onto the map as many times as you like.
//   - CombatMapDrawer (GM, right): the Combat Background and the grid.
//   The GM places every token (decided, revised): there is no Player dock.

// Every fighter's combat profile, kept live — the token picture to drag.
function useCombatProfiles() {
  const [profiles, setProfiles] = useState({});
  useEffect(() => {
    let alive = true;
    getCombatProfiles()
      .then((p) => alive && setProfiles(p))
      .catch(console.error);
    const onUpdated = ({ ownerType, ownerId, profile }) =>
      setProfiles((prev) => ({ ...prev, [`${ownerType}:${ownerId}`]: profile }));
    socket.on('combat_profile:updated', onUpdated);
    return () => {
      alive = false;
      socket.off('combat_profile:updated', onUpdated);
    };
  }, []);
  return profiles;
}

// The picture a fighter is dragged (and drawn) with: their combat token if
// they have one, otherwise their portrait.
function fighterOf(ownerType, record, profiles) {
  const profile = profiles[`${ownerType}:${record.id}`];
  const token = profile?.image_url
    ? { image_url: profile.image_url, crop: { x: profile.crop_x, y: profile.crop_y, w: profile.crop_w, h: profile.crop_h } }
    : { image_url: record.image_url ?? null, crop: { x: record.crop_x, y: record.crop_y, w: record.crop_w, h: record.crop_h } };
  return { ownerType, ownerId: record.id, name: record.name, ...token };
}

function FighterChip({ fighter, label }) {
  const crop = cropOf({ crop_x: fighter.crop?.x, crop_y: fighter.crop?.y, crop_w: fighter.crop?.w, crop_h: fighter.crop?.h });
  return (
    <button
      type="button"
      onPointerDown={(e) => beginFighterDrag(fighter, e)}
      title={`Drag ${fighter.name} onto the map`}
      className="flex min-h-11 w-full cursor-grab items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1 text-left hover:border-brand-500 active:cursor-grabbing"
      style={{ touchAction: 'none' }}
    >
      <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-zinc-600 bg-zinc-800">
        {fighter.image_url ? (
          <CroppedImage src={fighter.image_url} crop={crop} alt="" className="h-full w-full rounded-full" draggable={false} />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-xs font-bold uppercase text-zinc-400">
            {fighter.name.slice(0, 1)}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-200">{fighter.name}</span>
      {label && <span className="text-[9px] font-bold uppercase text-zinc-500">{label}</span>}
    </button>
  );
}

// The character folders, kept live — the session's shared copy (play feedback 8).
function useCharacterFolders() {
  return useSharedCharacterFolders() ?? [];
}

export function CombatFightersDrawer() {
  const characters = useRoster();
  const profiles = useCombatProfiles();
  const folders = useCharacterFolders();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const q = query.trim().toLowerCase();
  const match = (r) => !q || r.name.toLowerCase().includes(q);
  const chars = (characters ?? []).filter(match);
  // **In their folders (decided):** the GM's character folders, as on the
  // Scene's cast drawer; a search shows the matches in their folders too.
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const byFolder = useMemo(() => {
    const map = new Map();
    for (const c of chars) {
      const key = c.folder_id ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [chars]);
  const chip = (c) => <FighterChip key={`c${c.id}`} fighter={fighterOf('character', c, profiles)} label={c.character_type === 'npc' ? 'NPC' : ''} />;
  return (
    <div className="absolute left-0 top-0 z-10 flex h-full w-64 flex-col gap-3 overflow-y-auto border-r border-zinc-800 bg-zinc-950/90 p-3 pt-16">
      <div>
        <h2 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-400">Fighters</h2>
        <p className="text-[11px] text-zinc-500">Drag onto a square. Drag again for another copy.</p>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search"
        className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 text-sm outline-none focus:border-brand-500"
      />
      <section className="space-y-1">
        <h3 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Characters</h3>
        {tree.map((node) => (
          <FolderRosterNode key={node.id} node={node} charsByFolder={byFolder} collapsed={collapsed} onToggle={toggle} depth={0} rosterCard={chip} />
        ))}
        {(byFolder.get(null) ?? []).map(chip)}
      </section>
    </div>
  );
}

function Stepper({ label, value, min, max, onChange, suffix = 'px' }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-zinc-400">{label}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - 1))}
          className="flex h-8 w-8 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-brand-500"
          aria-label={`${label} minus one`}
        >
          <Minus size={14} aria-hidden />
        </button>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const n = Math.trunc(Number(e.target.value));
            if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
          className="h-8 w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1 text-center text-sm tabular-nums outline-none focus:border-brand-500"
          aria-label={label}
        />
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + 1))}
          className="flex h-8 w-8 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-brand-500"
          aria-label={`${label} plus one`}
        >
          <Plus size={14} aria-hidden />
        </button>
        <span className="w-4 text-[10px] text-zinc-500">{suffix}</span>
      </span>
    </div>
  );
}

export function CombatMapDrawer({ scene, tokenCount }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  // Shown immediately while the server's echo is on its way, so ±1 feels live.
  const serverGrid = useMemo(() => normalizeGrid(scene?.grid ?? {}), [scene?.grid]);
  const [grid, setGrid] = useState(serverGrid);
  useEffect(() => setGrid(serverGrid), [serverGrid]);
  const change = (patch) => {
    setGrid((g) => normalizeGrid({ ...g, ...patch }));
    socket.emit('scene:set_grid', patch);
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const processed = await fileToSceneBackground(file);
      if (processed) socket.emit('scene:set_combat_image', processed);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute right-0 top-0 z-10 flex h-full w-64 flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950/90 p-3 pt-16">
      <section className="space-y-2">
        <h2 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-400">Combat Background</h2>
        {scene?.combat_image_url && (
          <img src={scene.combat_image_url} alt="" className="w-full panel-cut-sm border border-zinc-800" />
        )}
        {/* No upload: the map uses the Scene's own artwork (decided). */}
        {scene?.combat_image_url && !scene.combat_image_own && <p className="text-[11px] text-zinc-500">The Scene’s artwork — upload a map to replace it here.</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="min-h-9 flex-1 panel-cut-sm bg-brand-600 px-2 text-xs font-semibold hover:bg-brand-500"
          >
            {busy ? '…' : scene?.combat_image_own ? 'Replace' : 'Upload map'}
          </button>
          {scene?.combat_image_own && (
            <button
              type="button"
              onClick={() =>
                window.confirm('Remove this Scene’s Combat Background?') &&
                socket.emit('scene:set_combat_image', { clear: true })
              }
              className="min-h-9 panel-cut-sm border border-zinc-700 px-2 text-xs text-zinc-300 hover:border-red-500 hover:text-red-400"
            >
              Remove
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
      </section>

      <section className="space-y-2">
        <h2 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-400">Grid</h2>
        <p className="text-[11px] text-zinc-500">In the map picture’s own pixels.</p>
        <Stepper label="Square" value={grid.size} min={GRID_SIZE_MIN} max={GRID_SIZE_MAX} onChange={(size) => change({ size })} />
        <Stepper
          label="Offset X"
          value={grid.offsetX}
          min={-GRID_OFFSET_LIMIT}
          max={GRID_OFFSET_LIMIT}
          onChange={(offsetX) => change({ offsetX })}
        />
        <Stepper
          label="Offset Y"
          value={grid.offsetY}
          min={-GRID_OFFSET_LIMIT}
          max={GRID_OFFSET_LIMIT}
          onChange={(offsetY) => change({ offsetY })}
        />
        <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          Opacity
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={grid.opacity}
            onChange={(e) => change({ opacity: Number(e.target.value) })}
            className="w-32 accent-brand-500"
          />
          <span className="w-8 text-right tabular-nums text-zinc-500">{Math.round(grid.opacity * 100)}%</span>
        </label>
      </section>

      <section className="space-y-2">
        <h2 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-400">Tokens</h2>
        <p className="text-[11px] text-zinc-500">{tokenCount} on the map.</p>
        <button
          type="button"
          disabled={!tokenCount}
          onClick={() =>
            window.confirm('Take every token off this map?') && socket.emit('combat_token:clear')
          }
          className="min-h-9 w-full panel-cut-sm border border-zinc-700 px-2 text-xs text-zinc-300 hover:border-red-500 hover:text-red-400 disabled:opacity-40"
        >
          Clear the map
        </button>
      </section>
    </div>
  );
}

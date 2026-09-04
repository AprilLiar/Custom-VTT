import { useMemo } from 'react';
import { socket } from '../socket.js';
import { layoutStage, SLOT_WIDTH } from '../lib/sceneLayout.js';

// The stage itself (Scene tab plan, Phase 5) — every summoned Character or
// Temp NPC, hard-cut into position via `layoutStage` (no motion yet, that's
// Phase 6). `summons` already arrives sorted `id DESC` from the server
// (see getStagePayload in server/index.js), which is exactly rank-0-first
// order `layoutStage` wants: the newest summon on each side binds to that
// side's own screen edge, older ones get pushed — this file only filters
// by side and hands the two arrays straight through.
//
// Bottom-anchored, `object-fit: contain` inside a fixed SLOT_WIDTH column
// — image aspect ratio is deliberately not `layoutStage`'s problem (see
// that file's own comment), so the framing happens here instead.
//
// `offsetX` shifts every figure right by that many px after layout —
// ScenePage already narrowed `stageWidth` itself to the visible gap
// between a GM's own drawers (see DRAWER_WIDTH), so `layoutStage` lays
// out entirely within that narrower space starting at 0; this is just
// what re-anchors 0 to where the gap actually starts on screen.
export default function StageRoster({ summons, stageWidth, offsetX = 0, canRemove }) {
  const placed = useMemo(() => {
    const left = summons.filter((s) => s.side === 'left');
    const right = summons.filter((s) => s.side === 'right');
    const result = layoutStage({ left, right, stageWidth });
    return [...result.left, ...result.right];
  }, [summons, stageWidth]);

  return (
    // A stacking context of its own (position + a low, fixed z-index): a
    // crowded roster's own z values (1..N per side, from layoutStage's
    // rank) only ever compete with EACH OTHER inside this box, never leak
    // out to outrank the drawers' z-10/z-20 — without this wrapper, a side
    // with more than ~10 summons would start painting over the GM's own
    // controls.
    <div className="absolute inset-0 z-[1]">
      {placed.map((entry) => (
        <div
          key={entry.id}
          className="absolute bottom-0"
          style={{ left: entry.x + offsetX, width: SLOT_WIDTH, zIndex: entry.z }}
        >
          <img
            src={`data:${entry.image_mime_type || 'image/png'};base64,${entry.image_data}`}
            alt={entry.name ?? ''}
            className="block max-h-[85vh] w-full object-contain object-bottom"
          />
          {canRemove && (
            <button
              type="button"
              onClick={() => socket.emit('stage:remove_summon', { summonId: entry.id })}
              title={`Remove ${entry.name ?? 'this summon'} from the stage`}
              className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/80 text-zinc-300 hover:border-red-500 hover:text-red-400"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

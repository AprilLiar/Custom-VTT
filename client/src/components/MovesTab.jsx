import { useEffect, useMemo, useState } from 'react';
import { sortTags } from '../lib/moveDisplay.js';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getRuleset, getTags, getTells, getMoves } from '../lib/api.js';
import { folderPath } from '../lib/folders.js';
import MoveCard from './MoveCard.jsx';
import RollDialog from './RollDialog.jsx';

// Tab 3: read-only list of the character's available moves — all Default
// moves plus Unique moves granted by the GM (who can revoke from here).
// A styled move is only usable while the ACTIVE stance carries its style;
// unusable moves render dimmed.
export default function MovesTab({ data }) {
  const { role } = useRole();
  const { character, moves, stances } = data;
  const [tells, setTells] = useState(null);
  const [tags, setTags] = useState(null);
  const [ruleset, setRuleset] = useState(null);
  const [folders, setFolders] = useState(null); // move disciplines, for the always-shown discipline label
  const [rollFor, setRollFor] = useState(null); // { move, side } whose Roll dialog is open
  // Filters (decided, new). The same multi-select-OR control the Compendium
  // uses, in the same words, because it is the same question asked of a
  // smaller pile — a sheet with thirty moves on it is no more scannable than
  // a Compendium with thirty. Tell and Tag rather than the Compendium's Style
  // and Tag: on your own sheet a Style you cannot use is already dimmed, while
  // "which of these opens with the shoulder drop" has had no answer at all.
  const [tellFilter, setTellFilter] = useState(new Set()); // Set<tell id> — OR'd
  const [tagFilter, setTagFilter] = useState(new Set()); // Set<tag id> — OR'd
  const toggleIn = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleTell = toggleIn(setTellFilter);
  const toggleTag = toggleIn(setTagFilter);

  // Every Tell a move on THIS sheet actually opens with, and every Tag one of
  // them actually carries — not the world's full list. The Compendium is the
  // library and shows everything; a sheet is a hand of cards, and offering a
  // filter that can only ever return nothing is a worse answer than not
  // offering it. Both sides of an ambiguous move's Left/Right pair count.
  const moveTellIds = (move) =>
    [move.tell_id, move.left_tell_id, move.right_tell_id].filter((id) => id != null);
  const moveTagIds = (move) => move.effective_tag_ids ?? move.tag_ids ?? [];
  const presentTellIds = useMemo(() => {
    const ids = new Set();
    for (const m of moves) for (const id of moveTellIds(m)) ids.add(id);
    return ids;
  }, [moves]);
  const presentTagIds = useMemo(() => {
    const ids = new Set();
    for (const m of moves) for (const id of moveTagIds(m)) ids.add(id);
    return ids;
  }, [moves]);

  useEffect(() => {
    const refresh = () => {
      getTells().then(setTells).catch(console.error);
      getTags().then(setTags).catch(console.error);
      getRuleset().then(setRuleset).catch(console.error);
      getMoves().then((d) => setFolders(d.folders)).catch(console.error);
    };
    refresh();
    const events = [
      'tell:created', 'tell:updated', 'tell:deleted',
      'tag:created', 'tag:updated', 'tag:deleted',
      'folder:created', 'folder:updated', 'folder:deleted',
    ];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  if (!tells || !tags || !ruleset || !folders) return <p className="text-zinc-500">Loading…</p>;
  const tellById = new Map(tells.map((t) => [t.id, t]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const attrById = new Map(ruleset.attributes.map((a) => [a.id, a]));

  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  const activeStyles = activeStance
    ? [activeStance.attribute_a_id, activeStance.attribute_b_id]
    : [];
  const usable = (move) =>
    move.style_attribute_id == null || activeStyles.includes(move.style_attribute_id);

  if (moves.length === 0) {
    return (
      <p className="text-sm text-zinc-600">
        No moves yet — Default moves appear here automatically once the GM creates them in
        the Compendium.
      </p>
    );
  }

  // The two filters narrow independently and are AND'd with each other, while
  // the picks *within* one are OR'd — "a Jab or a Hook, and Fast" — matching
  // the Compendium exactly. An empty filter is not applied at all.
  const visibleMoves = moves.filter((m) => {
    if (tellFilter.size > 0 && !moveTellIds(m).some((id) => tellFilter.has(id))) return false;
    if (tagFilter.size > 0 && !moveTagIds(m).some((id) => tagFilter.has(id))) return false;
    return true;
  });

  const filterRow = (label, items, selected, toggle, clear, labelFor, titleFor) =>
    items.length === 0 ? null : (
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs font-semibold uppercase text-zinc-500">{label}</span>
        {items.map((item) => {
          const active = selected.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => toggle(item.id)}
              title={titleFor?.(item) || `Filter by ${labelFor(item)}`}
              className={`min-h-11 panel-cut-sm border px-2 py-1 text-xs md:min-h-0 ${
                active
                  ? 'border-brand-500 bg-brand-600/30 text-brand-300'
                  : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
              }`}
            >
              {labelFor(item)}
            </button>
          );
        })}
        {selected.size > 0 && (
          <button
            type="button"
            onClick={clear}
            className="ml-1 text-xs text-zinc-500 underline hover:text-zinc-300"
          >
            clear
          </button>
        )}
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {filterRow(
          'Filter by Tell:',
          tells.filter((t) => presentTellIds.has(t.id)),
          tellFilter,
          toggleTell,
          () => setTellFilter(new Set()),
          (t) => t.name
        )}
        {filterRow(
          'Filter by tag:',
          tags.filter((t) => presentTagIds.has(t.id)),
          tagFilter,
          toggleTag,
          () => setTagFilter(new Set()),
          (t) => t.name,
          (t) => t.description
        )}
      </div>

      {visibleMoves.length === 0 ? (
        <p className="text-sm text-zinc-600">No moves on this sheet match these filters.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visibleMoves.map((move) => {
            const style = move.style_attribute_id ? attrById.get(move.style_attribute_id) : null;
            const combatStyle = move.combat_style_attribute_id
              ? attrById.get(move.combat_style_attribute_id)
              : null;
            const isUsable = usable(move);
            // "The move copy on the character": Perk-granted frame/tag overrides
            // folded in, so this sheet shows what this character actually has.
            const effectiveMove = {
              ...move,
              startup_tics: move.effective_startup_tics ?? move.startup_tics,
              active_tics: move.effective_active_tics ?? move.active_tics,
              recovery_tics: move.effective_recovery_tics ?? move.recovery_tics,
            };
            const effectiveTagIds = move.effective_tag_ids ?? move.tag_ids;
            return (
              <MoveCard
                key={move.id}
                move={effectiveMove}
                allMoves={moves}
                tell={tellById.get(move.tell_id)}
                rightTell={move.right_tell_id ? tellById.get(move.right_tell_id) : null}
                leftTell={move.left_tell_id ? tellById.get(move.left_tell_id) : null}
                style={style}
                combatStyle={combatStyle}
                tags={sortTags(effectiveTagIds.map((id) => tagById.get(id)).filter(Boolean))}
                folderLabel={folderPath(move.folder_id, folders) ?? undefined}
                perkModified={move.has_perk_overrides}
                rollBonus={move.roll_bonus ?? 0}
                onRollClick={(side) => setRollFor({ move, side })}
                // A Secondary move is on the sheet and readable, but you cannot
                // reach for it — the tint is the whole point of granting one
                // (decided, new). Same treatment an unusable Style already gets,
                // since "you have it, you just can't throw it right now" is the
                // same statement.
                dimmed={!isUsable || Boolean(move.is_secondary)}
                dimReason={
                  move.is_secondary
                    ? move.requirement_move_id != null
                      ? `Secondary — declarable only right after ${move.requirement_move_name ?? 'the move it follows'}`
                      : 'Secondary — reached only from a grapple, never declared by hand'
                    : style
                      ? `Needs an active stance with ${style.name}`
                      : undefined
                }
                badge={
                  move.is_default ? (
                    <span className="ml-2 panel-cut-sm bg-zinc-700/60 px-1.5 text-xs font-semibold uppercase text-zinc-400">
                      Default
                    </span>
                  ) : (
                    <span className="ml-2 panel-cut-sm bg-purple-600/30 px-1.5 text-xs font-semibold uppercase text-purple-300">
                      Unique
                    </span>
                  )
                }
                actions={
                  role === 'gm' && !move.is_default ? (
                    <button
                      onClick={() =>
                        window.confirm(`Revoke ${move.name} from ${character.name}?`) &&
                        socket.emit('move:revoke', { characterId: character.id, moveId: move.id })
                      }
                      className="panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
                    >
                      Revoke
                    </button>
                  ) : null
                }
              />
            );
          })}

        </div>
      )}

      {rollFor && (
        <RollDialog
          title={
            rollFor.side
              ? `Roll ${rollFor.move.name} (${rollFor.side === 'right' ? 'Right' : 'Left'})`
              : `Roll ${rollFor.move.name}`
          }
          initialModifier={rollFor.move.effective_roll_modifier ?? 0}
          onRoll={(modifier) => {
            if (rollFor.move.roll_type === 'custom') {
              socket.emit('dice:roll_custom', {
                characterId: character.id,
                size: rollFor.move.custom_roll_size,
                modifier,
              });
              return;
            }
            const sideDice = rollFor.side ? rollFor.move.roll_choice[rollFor.side] : [];
            socket.emit('pool:roll', {
              characterId: character.id,
              dieIds: [...rollFor.move.roll_dice, ...sideDice].map((d) => d.dieId),
              modifier,
            });
          }}
          onClose={() => setRollFor(null)}
        />
      )}
    </div>
  );
}

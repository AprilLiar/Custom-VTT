import { useEffect, useState } from 'react';
import { sortTags } from '../lib/moveDisplay.js';
import { MoveFilterChips, useMoveFilters } from '../lib/moveFilters.jsx';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getRuleset, getTags, getTells, getMoves } from '../lib/api.js';
import { folderPath } from '../lib/folders.js';
import DropButton from './DropButton.jsx';
import MoveCard from './MoveCard.jsx';
import RollDialog from './RollDialog.jsx';

// Tab 3: read-only list of the character's available moves — all Default
// moves plus Unique moves granted by the GM (who can revoke from here).
// A styled move is only usable while the ACTIVE stance carries its style;
// unusable moves render dimmed.
export default function MovesTab({ data }) {
  const { role, characterId } = useRole();
  const { character, moves, stances, weapon } = data;
  // **Whose sheet is this?** A Player can reach another character's sheet by
  // typing the URL — the app's trust model has always allowed that — so "am I a
  // Player" is not the question. Dropping a Move is only offered on your own.
  const isOwnSheet = role === 'player' && characterId === character.id;
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
  // Shared with the Arena's declare picker (see lib/moveFilters.jsx) rather
  // than kept here: three copies of one control is how two of them quietly stop
  // agreeing about what "OR'd within, AND'd between" means.
  const filters = useMoveFilters(moves);

  // **A Move that rolls the Weapon, on somebody carrying nothing (decided,
  // new).** Dimmed exactly as a Secondary move is, and for the same reason:
  // it is on the sheet, it is readable, and it cannot be reached for. The
  // server refuses it at declaration too — this is that rule shown rather
  // than discovered.
  const needsWeapon = (move) => !weapon && (move.roll_slots ?? []).includes('Weapon');

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

  const visibleMoves = moves.filter(filters.matches);

  return (
    <div className="space-y-3">
      {/* **Four filters, split left and right by the question they ask
          (decided, revised).** Left: what the move *does* — the Attack Target it
          goes for and the Attack Roll it makes. Right: what the move *is* — the
          Tell it opens with and the Tags it carries. "Which of my moves goes for
          the head" and "which of them rolls a Hand" are what you ask of a long
          sheet mid-round, and neither was askable at all before.
          **One column per filter (revised).** They were two columns of two
          stacked rows, which read as two controls rather than four — the second
          filter of each pair looked like a continuation of the first. One
          column apiece keeps the left/right split and makes each its own thing.
          Two columns at `sm`, four at `lg`, one on a phone, where they simply
          stack in that order. */}
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <MoveFilterChips
            label="Attack Target:"
            items={filters.targetItems}
            selected={filters.targetFilter}
            onToggle={filters.toggleTarget}
            onClear={filters.clearTarget}
            labelFor={(s) => s.name}
            titleFor={(s) => `Show only moves that go for the ${s.name}`}
          />
        </div>
        <div>
          <MoveFilterChips
            label="Attack Roll:"
            items={filters.rollItems}
            selected={filters.rollFilter}
            onToggle={filters.toggleRoll}
            onClear={filters.clearRoll}
            labelFor={(s) => s.name}
            titleFor={(s) => `Show only moves that roll ${s.name}`}
          />
        </div>
        <div>
          <MoveFilterChips
            label="Filter by Tell:"
            items={tells.filter((t) => filters.presentTellIds.has(t.id))}
            selected={filters.tellFilter}
            onToggle={filters.toggleTell}
            onClear={filters.clearTell}
            labelFor={(t) => t.name}
          />
        </div>
        <div>
          <MoveFilterChips
            label="Filter by tag:"
            items={tags.filter((t) => filters.presentTagIds.has(t.id))}
            selected={filters.tagFilter}
            onToggle={filters.toggleTag}
            onClear={filters.clearTag}
            labelFor={(t) => t.name}
            titleFor={(t) => t.description}
          />
        </div>
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
                dimmed={!isUsable || Boolean(move.is_secondary) || needsWeapon(move)}
                dimReason={
                  move.is_secondary
                    ? move.requirement_move_id != null
                      ? `Secondary — declarable only right after ${move.requirement_move_name ?? 'the move it follows'}`
                      : 'Secondary — reached only from a grapple, never declared by hand'
                    : needsWeapon(move)
                      ? 'Rolls a Weapon — nothing in hand to swing'
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
                  // A Default move is everybody's and cannot be dropped by
                  // anyone — there is nothing to revoke, only a Compendium row
                  // to un-default.
                  move.is_default ? null : role === 'gm' ? (
                    <button
                      onClick={() =>
                        window.confirm(`Revoke ${move.name} from ${character.name}?`) &&
                        socket.emit('move:revoke', { characterId: character.id, moveId: move.id })
                      }
                      className="panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
                    >
                      Revoke
                    </button>
                  ) : isOwnSheet ? (
                    // "Forget", not "Drop" — the same word the Compendium's
                    // Learn/Forget pair uses for a Move, so a player learns one
                    // vocabulary rather than two names for one act.
                    <DropButton
                      label="Forget"
                      title={`Remove ${move.name} from your sheet`}
                      onClick={() =>
                        socket.emit('move:revoke', { characterId: character.id, moveId: move.id })
                      }
                    />
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
            const pool = [...rollFor.move.roll_dice, ...sideDice];
            socket.emit('pool:roll', {
              characterId: character.id,
              dieIds: pool.map((d) => d.dieId).filter((id) => id != null),
              // The Weapon is not a die row and so has no id to send — it rides
              // as its own flag and the server puts it back in the pool. See
              // pool:roll and server/weapons.js.
              includeWeapon: pool.some((d) => d.slot_name === 'Weapon'),
              modifier,
            });
          }}
          onClose={() => setRollFor(null)}
        />
      )}
    </div>
  );
}

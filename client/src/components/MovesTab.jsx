import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getRuleset, getTags, getTells } from '../lib/api.js';
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
  const [rollFor, setRollFor] = useState(null); // move whose Roll dialog is open

  useEffect(() => {
    const refresh = () => {
      getTells().then(setTells).catch(console.error);
      getTags().then(setTags).catch(console.error);
      getRuleset().then(setRuleset).catch(console.error);
    };
    refresh();
    const events = ['tell:created', 'tell:updated', 'tell:deleted', 'tag:created', 'tag:updated', 'tag:deleted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  if (!tells || !tags || !ruleset) return <p className="text-zinc-500">Loading…</p>;
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

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {moves.map((move) => {
        const style = move.style_attribute_id ? attrById.get(move.style_attribute_id) : null;
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
            tell={tellById.get(move.tell_id)}
            style={style}
            tags={effectiveTagIds.map((id) => tagById.get(id)).filter(Boolean)}
            perkModified={move.has_perk_overrides}
            rollBonus={move.roll_bonus ?? 0}
            onRollClick={() => setRollFor(move)}
            dimmed={!isUsable}
            dimReason={style ? `Needs an active stance with ${style.name}` : undefined}
            badge={
              move.is_default ? (
                <span className="ml-2 rounded bg-zinc-700/60 px-1.5 text-xs font-semibold uppercase text-zinc-400">
                  Default
                </span>
              ) : (
                <span className="ml-2 rounded bg-purple-600/30 px-1.5 text-xs font-semibold uppercase text-purple-300">
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
                  className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
                >
                  Revoke
                </button>
              ) : null
            }
          />
        );
      })}

      {rollFor && (
        <RollDialog
          title={`Roll ${rollFor.name}`}
          initialModifier={rollFor.effective_roll_modifier ?? 0}
          onRoll={(modifier) =>
            socket.emit('pool:roll', {
              characterId: character.id,
              dieIds: rollFor.roll_dice.map((d) => d.dieId),
              modifier,
            })
          }
          onClose={() => setRollFor(null)}
        />
      )}
    </div>
  );
}

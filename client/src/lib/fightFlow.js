// Which Reminders fire when, in a Panic at the Dojo fight (Phase 5). Pure and
// shared: the server decides with it, tests pin it.
//
// A fight has fighters — placed copies — each with an owner (`character:<id>`
// or `temp_npc:<id>`), a side ('allies' | 'enemies') and an active stance.
// Reminders belong to the OWNER (they are written on the Combat tab), so one
// reminder fires at most once per moment, even when the owner has several
// copies in the fight.
//
// Moments: 'turn_start' | 'turn_end' (of the active fighter's turn),
// 'round_start' | 'round_end'.
//
//   self   — the active fighter's owner's reminders, at their turn's start/end
//   others — every OTHER owner's, at someone else's turn, filtered by target:
//            any, allies (the active fighter is on their side), enemies (it
//            isn't), or one (the active fighter's owner is the one named)
//   round  — every owner's, at the round's start/end
//
// A reminder bound to a Stance fires only while the relevant copy's active
// stance is that one: the active fighter for `self`, otherwise any copy of the
// owner in the fight. A copy with no stance chosen yet uses the owner's first
// (the default).

const ownerOf = (f) => f.ownerKey;

export function remindersToFire({ moment, active = null, fighters, remindersByOwner, defaultStanceByOwner = {} }) {
  const timing = moment.endsWith('start') ? 'start' : 'end';
  const isTurn = moment.startsWith('turn');
  const stanceOf = (f) => f.activeStanceId ?? defaultStanceByOwner[f.ownerKey] ?? null;
  const copiesOf = new Map();
  for (const f of fighters) {
    if (!copiesOf.has(f.ownerKey)) copiesOf.set(f.ownerKey, []);
    copiesOf.get(f.ownerKey).push(f);
  }
  const stanceOk = (reminder, copies) =>
    reminder.stance_id == null || copies.some((c) => stanceOf(c) === reminder.stance_id);

  const out = [];
  for (const [ownerKey, copies] of copiesOf) {
    for (const r of remindersByOwner[ownerKey] ?? []) {
      if (r.timing !== timing) continue;
      if (isTurn && active) {
        if (r.scope === 'self') {
          if (ownerKey !== active.ownerKey || !stanceOk(r, [active])) continue;
        } else if (r.scope === 'others') {
          if (ownerKey === active.ownerKey) continue;
          const sides = new Set(copies.map((c) => c.side));
          if (r.target === 'allies' && !sides.has(active.side)) continue;
          if (r.target === 'enemies' && ![...sides].some((s) => s !== active.side)) continue;
          if (r.target === 'one' && `${r.target_type}:${r.target_id}` !== active.ownerKey) continue;
          if (!stanceOk(r, copies)) continue;
        } else continue;
      } else if (!isTurn) {
        if (r.scope !== 'round' || !stanceOk(r, copies)) continue;
      } else continue;
      out.push({ ownerKey, reminder: r, fighter: r.scope === 'self' ? active : copies[0] });
    }
  }
  return out;
}

// Who stands on a Trap (a Trap or a Pit Trap — both hold a `trap` tile):
// `fighters[i].square` is their "col,row" on this board, `trapSquares` the
// squares holding a Trap.
export function fightersOnTraps(fighters, trapSquares) {
  const traps = trapSquares instanceof Set ? trapSquares : new Set(trapSquares ?? []);
  return fighters.filter((f) => f.square != null && traps.has(f.square));
}

// The End Phase steps the app reminds about by itself (book p.68), at the end
// of a turn. `fighters[i].tokens` are Panic token counts; `active` is the
// fighter whose turn is ending; `onTraps` whoever stands on a Trap.
// Returns [{ rule, text, fighters }].
export function automaticReminders({ active, fighters, nameOf = (f) => f.name, onTraps = [] }) {
  const out = [];
  // **Traps (decided, new):** "At the end of every single turn, everyone
  // standing on a Trap takes 1 damage" (p.72) — a global reminder naming them.
  if (onTraps.length) {
    out.push({
      rule: 'trap',
      text: 'Traps: everyone standing on a Trap or Pit Trap takes 1 damage (each Trap deals damage once per turn).',
      fighters: onTraps,
    });
  }
  const burning = active?.tokens?.burning ?? 0;
  if (burning > 0) {
    out.push({
      rule: 'burning',
      text: `Burning: take ${burning} damage (Iron can't reduce it), then discard ${Math.ceil(burning / 2)} Burning.`,
      fighters: [active],
    });
  }
  const fast = fighters.filter((f) => (f.tokens?.speed ?? 0) > 0);
  if (fast.length) {
    out.push({ rule: 'speed', text: 'Speed: everyone discards 3 Speed tokens (all of them if fewer).', fighters: fast });
  }
  if ((active?.tokens?.fatigue ?? 0) > 0) {
    out.push({
      rule: 'fatigue',
      text: "Fatigue: if you didn't leave your starting space this turn, you may discard up to 3 Fatigue.",
      fighters: [active],
    });
  }
  if (active?.challengeId != null) {
    const challenger = fighters.find((f) => f.combatantId === active.challengeId);
    out.push({
      rule: 'challenge',
      text: `Challenge: if you tried to damage ${challenger ? nameOf(challenger) : 'your Challenger'} this turn, discard their Challenge.`,
      fighters: [active],
    });
  }
  return out;
}

export { ownerOf };

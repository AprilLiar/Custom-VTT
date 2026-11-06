// **A fight's runtime (full automation, phase A).** Everything the engine
// keeps between moments of a fight, persisted with the fight (`fights.runtime`)
// so a server restart loses nothing. Pure helpers; the server stores it.
//
// {
//   round, turn: { activeId, index },
//   fighters: { [combatantId]: {
//     state: {},          // persistent choices (Song, Mood, Weapon …)
//     pool: [],           // the Action Pool (phase B)
//     placed: [],         // dice / tokens laid on Actions (phase B)
//     flags: {},          // this turn: moved, tookDamage, startSquare, armorUsed …
//     fight: {},          // this fight: superMovesUsed …
//   } },
//   usage: { [key]: n },  // rule / limited usage counters, keys end in ':turn' | ':round' | ':own_turn:<id>' | ':fight'
//   temps: [],            // temporary modifiers and effects with an expiry
//   scheduled: [],        // effects scheduled for a later boundary
//   sides: { allies: { supersThisRound: 0 }, enemies: { supersThisRound: 0 } },
// }

export function emptyRuntime() {
  return { round: 1, turnSeq: 0, turn: { activeId: null, index: 0 }, fighters: {}, usage: {}, temps: [], scheduled: [], sides: { allies: { supersThisRound: 0 }, enemies: { supersThisRound: 0 } } };
}

export function parseRuntime(text) {
  try {
    const v = JSON.parse(text || 'null');
    return v && typeof v === 'object' ? { ...emptyRuntime(), ...v } : emptyRuntime();
  } catch {
    return emptyRuntime();
  }
}

export function fighterRt(rt, id) {
  const k = String(id);
  if (!rt.fighters[k]) rt.fighters[k] = { state: {}, pool: [], placed: [], flags: {}, fight: {} };
  const f = rt.fighters[k];
  f.state ??= {};
  f.pool ??= [];
  f.placed ??= [];
  f.flags ??= {};
  f.fight ??= {};
  return f;
}

// A usage counter key: per rule (or limited node) and owner, per period.
export function usageKey(id, ownerId, period) {
  if (period === 'own_turn') return `${id}:${ownerId}:own_turn`;
  return `${id}:${ownerId}:${period ?? 'fight'}`;
}

// Turn boundaries: per-turn counters and flags reset; a new round also resets
// per-round counters and the sides' Super Move counts. Temporaries that expire
// at these boundaries are dropped (see expireTemps).
export function startTurn(rt, activeId, round) {
  if (round != null && round !== rt.round) {
    for (const k of Object.keys(rt.usage)) if (k.endsWith(':round')) delete rt.usage[k];
    rt.sides = { allies: { supersThisRound: 0 }, enemies: { supersThisRound: 0 } };
    rt.round = round;
  }
  for (const k of Object.keys(rt.usage)) {
    if (k.endsWith(':turn') || k.endsWith(':action')) delete rt.usage[k];
    // "own turn": resets when its owner's own turn starts.
    if (k.endsWith(':own_turn') && k.split(':').slice(-2, -1)[0] === String(activeId)) delete rt.usage[k];
  }
  for (const f of Object.values(rt.fighters)) f.flags = {};
  rt.turn = { ...rt.turn, activeId };
  rt.turnSeq = (rt.turnSeq ?? 0) + 1;
  return rt;
}

// Install a temporary (modifier or effect) with its duration, stamped with the
// turn and round it was installed in.
export function addTemp(rt, temp) {
  // `action`: the Action it was made during — "your next Action" is a later one.
  rt.temps.push({ ...temp, seq: rt.turnSeq ?? 0, round: rt.round, action: rt.actionSeq ?? 0 });
  return rt;
}

// Temporaries whose duration ends at `boundary` → removed and returned.
//   boundary: 'end_of_turn' | 'start_of_turn' | 'end_of_round' | 'action' | 'damage_action' | 'hit'
//   ctx: { activeId, actorId }
export function expireTemps(rt, boundary, { activeId = null, actorId = null } = {}) {
  const seq = rt.turnSeq ?? 0;
  const earlier = (t) => (t.action ?? -1) < (rt.actionSeq ?? 0);
  const ends = (t) => {
    const d = t.duration;
    switch (boundary) {
      case 'end_of_turn':
        return (
          d === 'end_of_current_turn' ||
          d === 'end_of_current_turn_or_next_action' ||
          d === 'end_of_that_turn' ||
          (d === 'after_end_of_target_next_turn' && t.targetId === activeId && seq > t.seq)
        );
      case 'start_of_turn':
        return d === 'start_of_next_own_turn' && t.ownerId === activeId && seq > t.seq;
      case 'end_of_round':
        return d === 'end_of_current_round' || (d === 'end_of_next_round' && rt.round > t.round);
      case 'action':
        return d === 'end_of_current_turn_or_next_action' && t.ownerId === actorId && earlier(t);
      case 'damage_action':
        return d === 'until_next_damage_dealing_action' && t.ownerId === actorId && earlier(t);
      case 'hit':
        return d === 'current_hit';
      default:
        return false;
    }
  };
  const gone = rt.temps.filter(ends);
  rt.temps = rt.temps.filter((t) => !ends(t));
  return gone;
}

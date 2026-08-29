// Gates — a marker on one pip of a Counter, and what happens when the count
// reaches it.
//
// A Counter is a clock with no mechanics behind it. A Gate is the GM writing on
// one of its pips: *when this fills to here, something happens*. The Gate itself
// still has no mechanics — it is a reminder with a name, a description and a
// switch deciding whether the table may read either.
//
// Pure, and split out for the two things here that are worth stating exactly:
// which Gates a change crosses, and what a given viewer is allowed to know
// about one. Both are invisible in a screenshot and both fail quietly.

// A pip index is 1-based: gate 1 sits on the first pip, gate `target_pips` on
// the last. That matches how the table talks ("a gate on the fourth") and how
// `current_pips` already counts, so "reached" is a plain `current >= pip`.
export const gatePip = (gate) => Math.trunc(Number(gate?.pip_index));

export const isValidPip = (pip, targetPips) =>
  Number.isInteger(pip) && pip >= 1 && pip <= Math.trunc(Number(targetPips) || 0);

// **Which Gates a change has just reached.** Upward only: a Counter ticking back
// down has not reached anything, and re-announcing on the way past would turn a
// correction into an event. Crossing the same Gate again after going back down
// DOES announce again — it is a reminder, and the second time through is a
// second time the table needs reminding.
//
// Inclusive at the top, exclusive at the bottom (`from < pip <= to`), so landing
// exactly ON a Gate is reaching it and starting there is not.
export function gatesCrossed(gates, from, to) {
  const a = Math.trunc(Number(from) || 0);
  const b = Math.trunc(Number(to) || 0);
  if (!(b > a)) return [];
  return (gates ?? [])
    .filter((g) => {
      const pip = gatePip(g);
      return Number.isInteger(pip) && pip > a && pip <= b;
    })
    .sort((x, y) => gatePip(x) - gatePip(y));
}

// **What this viewer may know.** Protect by ABSENCE: a secret Gate's name and
// description are not sent at all rather than sent with a flag telling the
// client to hide them — a flag is a request, and the payload is in the network
// tab either way.
//
// What is never secret is that a Gate is THERE. The pip is drawn twice the size
// for everybody, deliberately: the table can see something is coming and cannot
// see what, which is the whole point of the mechanic. `secret` rides along so
// the client can draw "???" rather than an empty card.
export function visibleGate(gate, identity) {
  const base = {
    id: gate.id,
    counter_id: gate.counter_id,
    pip_index: gatePip(gate),
    secret: gate.secret ? 1 : 0,
  };
  if (!gate.secret || identity?.role === 'gm') {
    return { ...base, name: gate.name ?? '', description: gate.description ?? '' };
  }
  return base;
}

export const visibleGates = (gates, identity) =>
  (gates ?? []).map((gate) => visibleGate(gate, identity));

// The line a reached Gate posts to the Chat Log.
//
// **One public message, and it never carries a secret.** Chat is broadcast to
// the whole table, so a secret Gate announces only that it was reached — which
// gives away nothing the pip strip was not already showing — while a Gate the
// GM chose to leave open is announced by name. The GM reads the description by
// hovering it, the same way everyone else does.
export function gateChatLine(counterLabel, gate, current, targetPips) {
  const where = `${current}/${targetPips}`;
  const name = String(gate?.name ?? '').trim();
  if (gate?.secret || !name) return `${counterLabel} reached a Gate — ${where}.`;
  return `${counterLabel} reached the Gate “${name}” — ${where}.`;
}

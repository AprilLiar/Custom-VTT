// **Victory Parameters (book pp.48-50): who has won, from the fighters as they
// stand.** Pure — the engine (server/triggers.js) asks at the end of every
// turn and at the end of every Round, announces a winner once, and the GM
// ends the fight (decided). A fighter here: { id, side, square, hp }.
import { atZero } from './patd/engine/turn.js';

export const inPlay = (f) => Boolean(f.square);
export const standing = (f) => inPlay(f) && !atZero(f.hp);
const sidesOf = (fighters) => [...new Set(fighters.map((f) => f.side).filter(Boolean))];

// Last One Standing: only one side has anyone standing.
export function lastOneStanding(fighters) {
  const sides = sidesOf(fighters);
  if (sides.length < 2) return null;
  const left = sides.filter((s) => fighters.some((f) => f.side === s && standing(f)));
  return left.length === 1 ? left[0] : null;
}

// King of the Hill (round end): everyone standing in the King Zone is of one side.
export function kingOfTheHill(fighters, kingSquares) {
  const inZone = fighters.filter((f) => standing(f) && kingSquares.some((k) => k.col === f.square.col && k.row === f.square.row));
  const sides = sidesOf(inZone);
  return sides.length === 1 ? sides[0] : null;
}

// Outlast: the Attackers win once every Survivor is down or out of play; the
// Survivors win if any stand at the end of round 3.
// Three-sided: the third side (the Renegades) plays Interference — it wins
// if ever no Attacker is left in play.
export function outlast(fighters, survivors, { roundEnd = false, round = 1 } = {}) {
  if (!survivors) return null;
  const sides = sidesOf(fighters);
  const interference = sides.length > 2 && survivors !== 'renegades' ? 'renegades' : null;
  const attackers = sides.find((s) => s !== survivors && s !== interference) ?? null;
  if (interference && attackers && !fighters.some((f) => f.side === attackers && inPlay(f))) return interference;
  const survivorsLeft = fighters.some((f) => f.side === survivors && standing(f));
  if (!survivorsLeft) return attackers;
  if (roundEnd && round >= 3) return survivors;
  return null;
}

// Protect the VIP: a side whose VIP is down or out of play loses; the last
// side with its VIP standing wins.
export function protectTheVip(fighters, vips) {
  const sides = sidesOf(fighters);
  const alive = sides.filter((s) => {
    const vip = fighters.find((f) => f.id === vips?.[s]);
    return vip ? standing(vip) : true;
  });
  if (alive.length === 1 && sides.length >= 2) return alive[0];
  return null;
}

// Tournament Play (round end): the side that lost the round — someone of
// theirs out of play (the Outside), or two or more of them at 0 HP. Both:
// nobody wins it (a draw).
export function tournamentRoundLoser(fighters) {
  const lost = sidesOf(fighters).filter((s) => {
    const mine = fighters.filter((f) => f.side === s);
    return mine.some((f) => !inPlay(f)) || mine.filter((f) => inPlay(f) && atZero(f.hp)).length >= 2;
  });
  return lost.length === 1 ? lost[0] : null;
}

// Rounds a side needs to take a best of `n`.
export const roundsToWin = (bestOf) => Math.ceil((bestOf === 5 ? 5 : 3) / 2);

// The side that always takes the first turn of each Round: Outlast's
// Attackers, Sabotage's Saboteurs.
export function forcedFirstSide(battle, sides) {
  if (battle?.victory === 'outlast' && battle.victoryOpts?.survivors) return sides.find((s) => s !== battle.victoryOpts.survivors && !(sides.length > 2 && s === 'renegades')) ?? null;
  if (battle?.victory === 'sabotage' && battle.victoryOpts?.saboteurs) return battle.victoryOpts.saboteurs;
  return null;
}

// **Actions a Victory Parameter grants (Fight Setup, book p.48-49).** Not the
// book's content file: they join the content index with the table's rulings
// (rulings.js `applyRulings`), on the server and the client alike, and are
// offered on a fighter's dice board only while their parameter is in force
// (`battleActionIdsFor`; server/fights.js stores them on the board).
const oneDie = {
  text: '1+',
  selection: 'exactly_one',
  options: [{ id: 'option-1', category: 'dice', components: [{ kind: 'pool_number', minimum: 1, maximum: null, count: 1, matching: false, consume: true }], rating: { ref: 'payment.poolNumbers.0' } }],
  additionalOptions: [],
};
const base = { ownerId: 'system.basic-actions', kind: 'basic', source: { sourceId: 'source.pdf', pdfPage: 52, printedPage: '49' }, cost: oneDie, gates: { headerThresholds: [1], effectThresholds: [], mayStopAtEarlierGate: true, modificationsApplyBeforeExecution: true }, limits: [], conditions: [], tags: ['battle'], usableWhileTakenOut: false, automationState: 'structured' };

export const SABOTAGE = 'action.battle.sabotage';
export const GRAB_IT = 'action.battle.grab-it';

export const BATTLE_ACTIONS = [
  { ...base, id: SABOTAGE, name: 'Sabotage', rulesText: 'Place a Bomb into an adjacent Key Location. You cannot perform this Action while an enemy or another Bomb is in the Key Location.', effect: { op: 'battle_sabotage' } },
  { ...base, id: GRAB_IT, name: 'Grab It!', rulesText: 'Pick up an adjacent Important Thing that is not being held. You now hold it, and it moves with you until you drop it.', effect: { op: 'battle_grab_it' } },
];

// The battle Actions a fighter on `side` may use under `battle` (one mode's).
// Sabotage: the Saboteurs, and the Renegades in a three-sided fight. Grab It!: everyone.
export function battleActionIdsFor(battle, side) {
  if (!battle || !side) return [];
  if (battle.victory === 'sabotage') return side === battle.victoryOpts?.saboteurs || side === 'renegades' ? [SABOTAGE] : [];
  if (battle.victory === 'secure_the_mcguffin') return [GRAB_IT];
  return [];
}

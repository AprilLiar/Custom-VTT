// **The table's rulings on the book's content (vttprojectplan.md, "Rulings").**
// Small, named patches applied to the content when it is indexed, on the
// server and the client alike, so the content file stays the user's export.
//
// Each ruling: { id, abilityId, ruleId, patch(rule) → rule, note? } — the note
// is added to the Ability's rules text, so the sheet shows the ruling.

export const RULINGS = [
  {
    // Halcyon Style: "at the start of your turn, you may discard one token" —
    // ruled: only a Status token (Burning, Fatigue, Weakness), never a basic
    // one; skipped when none is held, otherwise a choice (or none).
    id: 'halcyon-status-only',
    abilityId: 'ability.style-halcyon.halcyon-style',
    ruleId: 'ability.style-halcyon.halcyon-style.rule-1',
    patch: (rule) => ({ ...rule, effect: { ...rule.effect, tokenFilter: 'status' } }),
    note: 'Table ruling: only a Status token (Burning, Fatigue, Weakness) may be discarded this way.',
  },
];

import { BATTLE_ACTIONS } from './battleActions.js';

// **The 1e PATCH'd UP adoption (decided 2026-11-24, patch-review.md):** the
// Super Moves, Basic Actions and Builds the user took from the 1st Edition
// patch notes, replacing our 2e text and its structured effect. Keyed by id;
// each patch returns the new item (name, rules text, cost, gates, effect…).
const self = { ref: 'self' };
const target = { ref: 'targets.target' };
const tokens = (token, amount, to = target) => ({ op: 'gain_tokens', token, amount, target: to });
const dieCost = (text, minimum, extra = {}) => ({
  text,
  selection: 'exactly_one',
  options: [{ id: 'option-1', category: 'dice', components: [{ kind: 'pool_number', minimum, maximum: null, count: 1, matching: false, consume: true, ...extra }], rating: { ref: 'payment.poolNumbers.0' } }],
  additionalOptions: [],
});
const stepsOf = (e) => e.steps.map((x) => x);
export const PATCH_1E = {
  superMoves: {
    'super-move.archetype-angel.sirens-scream': (m) => ({
      ...m,
      rulesText: 'Challenge and deal 2 damage to all enemies. Then, you gain a 10-point Shield.',
      effect: { ...m.effect, steps: stepsOf(m.effect).map((x) => (x.op === 'gain_shield' ? { ...x, value: 10 } : x)) },
    }),
    'super-move.archetype-demon.unending-despair': (m) => ({
      ...m,
      rulesText: 'Target an adjacent enemy. Give them 4 Burning tokens and 4 Weakness tokens. You gain 2 Iron tokens, 2 Power tokens, 2 Speed tokens, and 2 Chaos tokens.',
      effect: {
        op: 'sequence',
        steps: [
          stepsOf(m.effect)[0],
          tokens('burning', 4),
          tokens('weakness', 4),
          tokens('iron', 2, self),
          tokens('power', 2, self),
          tokens('speed', 2, self),
          tokens('chaos', 2, self),
        ],
      },
    }),
    'super-move.archetype-flametongue.watch-the-world-burn': (m) => ({
      ...m,
      rulesText: 'Place a Trap under each enemy you can see, then give each of those enemies 4 Burning tokens.',
      effect: { op: 'sequence', steps: [stepsOf(m.effect)[0], tokens('burning', 4, { kind: 'enemy', range: { mode: 'visible', origin: 'self' }, count: 'all' })] },
    }),
    'super-move.archetype-trickster.funny-little-box-of-pain': (m) => ({
      ...m,
      rulesText: 'Target an enemy at Range 2. Push everyone adjacent to the target one space. Then, place Walls into each space adjacent to the target and place a Deadly Trap beneath them.',
      effect: { ...m.effect, steps: stepsOf(m.effect).filter((x) => !(x.op === 'gain_tokens' && x.token === 'fatigue')) },
    }),
    'super-move.archetype-underdog.hyper-install': (m) => {
      const lasting = stepsOf(m.effect).find((x) => x.op === 'temporary');
      return {
        ...m,
        rulesText:
          'You gain 5 Shield and you heal. For the rest of this Fight, you gain a benefit at the start of every single turn, depending on whose turn it is. If it is an enemy turn, you gain 1 Iron token and 1 Speed token. If it is an allied turn, you gain 1 Power token and heal 1. If it is your turn, you gain both effects: gain 1 Iron token, 1 Power token, 1 Speed token, and you heal 1.',
        effect: {
          op: 'sequence',
          steps: [{ op: 'gain_shield', value: 5, target: self }, { op: 'heal', amount: { ref: 'context.healValue' }, target: self }, { ...lasting, duration: 'end_of_fight' }],
        },
      };
    },
    'super-move.archetype-winterblossom.blizzard': (m) => {
      const swap = (n) =>
        Array.isArray(n) ? n.map(swap) : n && typeof n === 'object' ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === 'token' && v === 'fatigue' ? 'burning' : swap(v)])) : n;
      return {
        ...m,
        rulesText: 'Until the end of this Round, increase your maximum range by 2. Also until the end of this Round, at the end of every turn, you give 1 Burning token and 1 Weakness token to every enemy within range, then you may move 1 space.',
        effect: swap(m.effect),
      };
    },
    'super-move.archetype-punk.knuckle-sandwich': (m) => ({
      ...m,
      rulesText: 'Deal 5 damage to an adjacent enemy, then give them 4 Weakness tokens and your Challenge token. Then, you may push them up to three spaces.',
      effect: { ...m.effect, steps: stepsOf(m.effect).map((x) => (x.op === 'push' ? { ...x, upTo: true } : x)) },
    }),
    // Same effect; the 1e name.
    'super-move.archetype-teacher.transcendant-spirit': (m) => ({ ...m, name: 'Remember My Teachings' }),
  },
  actions: {
    'action.system-basic-actions.grapple': (a) => ({
      ...a,
      rulesText: 'Target someone within Range 1-X. Pull them up to 3 spaces.',
      gates: { ...a.gates, headerThresholds: [], effectThresholds: [] },
      effect: { op: 'sequence', steps: [...stepsOf(a.effect).slice(0, 2), { op: 'pull', distance: 3, upTo: true, target }] },
    }),
    // **Bring It On!** replaces A Challenger Approaches (same id, so every
    // reference to the Basic Action still holds).
    'action.system-basic-actions.a-challenger-approaches': (a) => ({
      ...a,
      name: 'Bring It On!',
      cost: dieCost('4+', 4),
      rulesText: 'Challenge any number of enemies within Range 1-3.',
      gates: { headerThresholds: [4], effectThresholds: [], mayStopAtEarlierGate: true, modificationsApplyBeforeExecution: true },
      effect: {
        op: 'for_each',
        selector: { kind: 'enemy', range: { mode: 'explicit', origin: 'self', minimum: 1, maximum: 3 }, count: { maximum: 20 } },
        binding: 'each',
        effect: { op: 'sequence', steps: [{ op: 'challenge', target: { ref: 'bindings.each' }, challenger: self }] },
      },
    }),
    'action.system-basic-actions.put-it-out': (a) => {
      const more = (gate) => ({ op: 'if', condition: { operator: 'gte', args: [{ ref: 'resolution.gateRating' }, gate] }, then: { op: 'sequence', steps: [{ op: 'discard_tokens', amount: 2, upTo: true, target, tokenFilter: 'non_rare' }] } });
      return {
        ...a,
        rulesText: 'Remove one non-Rare token from someone within range. 4+: Remove up to two more non-Rare tokens from them. 7+: Remove up to two more non-Rare tokens from them.',
        effect: { op: 'sequence', steps: [stepsOf(a.effect)[0], { op: 'discard_tokens', amount: 1, target, tokenFilter: 'non_rare' }, more(4), more(7)] },
      };
    },
  },
  // New Builds (their Abilities below).
  builds: [
    { id: 'build.bulky', name: 'Bulky Build', descriptionText: 'You are bigger than most, with more meat on your bones. It takes a lot to take you down.', abilityIds: ['ability.build-bulky.bulky-build'], actionIds: [], barHpBonus: 3, unblockable: true, automationState: 'structured' },
    { id: 'build.experimental', name: 'Experimental Build', descriptionText: 'You are a product of science, a machine or a modified life form. Enemy blows do not slow you down, and you seem unstoppable until you suddenly collapse.', abilityIds: ['ability.build-experimental.experimental-build'], actionIds: [], unblockable: true, automationState: 'structured' },
    { id: 'build.intimidating', name: 'Intimidating Build', descriptionText: 'Lesser foes cower before you. Your wounds only make you look scarier. When you finally fall, you stay standing from the hit that did it, for just a moment.', abilityIds: ['ability.build-intimidating.intimidating-build'], actionIds: [], unblockable: true, automationState: 'structured' },
  ],
  abilities: [
    // Bulky's +3 HP per Health Bar is applied where bars get their HP (`barHpBonus`).
    { id: 'ability.build-bulky.bulky-build', name: 'Bulky Build', ownerId: 'build.bulky', rulesText: 'You have +3 HP per Health Bar. For example, in a Middleweight fight you have 19 HP per Health Bar, while everyone else has 16.', rules: [], automationState: 'structured' },
    {
      id: 'ability.build-experimental.experimental-build',
      name: 'Experimental Build',
      ownerId: 'build.experimental',
      rulesText: 'At the end of your turn, you may give 1 Burning token to an enemy you dealt damage to during this turn.',
      rules: [
        {
          id: 'ability.build-experimental.experimental-build.rule-1',
          events: ['own_turn.end_abilities'],
          optional: true,
          effect: {
            op: 'sequence',
            steps: [
              { op: 'select', binding: 'target', selector: { kind: 'enemy', range: { mode: 'map', origin: 'self' }, count: 1, damagedThisTurn: true } },
              tokens('burning', 1),
            ],
          },
        },
      ],
      automationState: 'structured',
    },
    {
      id: 'ability.build-intimidating.intimidating-build',
      name: 'Intimidating Build',
      ownerId: 'build.intimidating',
      rulesText: 'At the start or end of your turn, you may give 1 Weakness token to an enemy within range.',
      rules: [
        {
          id: 'ability.build-intimidating.intimidating-build.rule-1',
          // Once per turn, at either end: the start, or — if not used then — the end.
          events: ['own_turn.start', 'own_turn.end_abilities'],
          optional: true,
          limit: { metric: 'uses', maximum: 1, period: 'turn' },
          effect: {
            op: 'sequence',
            steps: [{ op: 'select', binding: 'target', selector: { kind: 'enemy', range: { mode: 'stance', origin: 'self' }, count: 1 } }, tokens('weakness', 1)],
          },
        },
      ],
      automationState: 'structured',
    },
  ],
};
// (No note on the card: the 1e texts simply are the rules now — decided.)

// **Luck as an Interrupt (decided, play feedback):** the Underdog's "once per
// turn, after any Action fully resolves, you may spend 1 Luck Token to
// Teleport 3 and Heal 1" was asked after every Action — too tedious. It is a
// token Action instead: on the Interrupt button any time someone else acts,
// and on your own board; once per turn.
export const LUCKY_ESCAPE = 'action.resource-luck.lucky-escape';
const luckyEscape = {
  id: LUCKY_ESCAPE,
  name: 'Lucky Escape',
  ownerId: 'archetype.underdog',
  kind: 'unique',
  cost: { text: '1 Luck Token', selection: 'exactly_one', options: [{ id: 'option-1', category: 'token', components: [{ kind: 'token', token: 'luck', amount: 1, consume: true }], rating: 1 }], additionalOptions: [] },
  rulesText: 'Teleport 3 and heal 1. Usable once per turn, at any time (as an Interrupt on other turns).',
  effect: { op: 'sequence', steps: [{ op: 'teleport', distance: 3, target: { ref: 'self' } }, { op: 'heal', amount: 1, target: { ref: 'self' } }] },
  gates: { headerThresholds: [], effectThresholds: [], mayStopAtEarlierGate: true, modificationsApplyBeforeExecution: true },
  limits: [{ maximum: 1, period: 'turn', metric: 'uses' }],
  conditions: [],
  tags: [],
  usableWhileTakenOut: false,
  automationState: 'structured',
};
// Rules replaced by the above (dropped from their Ability).
const DROPPED_RULES = new Set(['ability.resource-mechanic-luck.luck-mechanics.rule-1']);
const LUCK_NOTE = 'Table ruling: Teleport 3 and Heal 1 for 1 Luck is the Lucky Escape Action — use it any time (Interrupt), once per turn.';

export function applyRulings(content) {
  const byAbility = new Map();
  for (const r of RULINGS) byAbility.set(r.abilityId, [...(byAbility.get(r.abilityId) ?? []), r]);
  const patched = (list, table) => (list ?? []).map((x) => (table[x.id] ? table[x.id](x) : x));
  const added = (list, extra) => [...(list ?? []), ...extra.filter((e) => !(list ?? []).some((x) => x.id === e.id))];
  return {
    ...content,
    // The Victory Parameters' own Actions (battleActions.js).
    actions: patched(added([...(content.actions ?? []), ...BATTLE_ACTIONS.filter((a) => !(content.actions ?? []).some((x) => x.id === a.id))], [luckyEscape]), PATCH_1E.actions),
    archetypes: (content.archetypes ?? []).map((a) => (a.id === 'archetype.underdog' && !(a.actionIds ?? []).includes(LUCKY_ESCAPE) ? { ...a, actionIds: [...(a.actionIds ?? []), LUCKY_ESCAPE] } : a)),
    superMoves: patched(content.superMoves, PATCH_1E.superMoves),
    builds: added(content.builds, PATCH_1E.builds),
    abilities: added(content.abilities, PATCH_1E.abilities).map((a0) => {
      // Rules replaced by an Action (Luck's Lucky Escape).
      const a = a0.rules?.some((r) => DROPPED_RULES.has(r.id))
        ? { ...a0, rules: a0.rules.filter((r) => !DROPPED_RULES.has(r.id)), rulesText: `${a0.rulesText}\n${LUCK_NOTE}` }
        : a0;
      const rs = byAbility.get(a.id);
      if (!rs) return a;
      const notes = rs.map((r) => r.note).filter(Boolean);
      return {
        ...a,
        rulesText: notes.length ? `${a.rulesText}\n${notes.join('\n')}` : a.rulesText,
        rules: a.rules.map((rule) => rs.filter((r) => r.ruleId === rule.id).reduce((acc, r) => r.patch(acc), rule)),
      };
    }),
  };
}

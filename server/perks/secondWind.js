// **Second Wind** — Tier 1 (a declarative trigger) plus per-round state.
//
// Nothing here is new vocabulary: `defense_failure` is one of the game's own
// triggers and `self_stamina` is one of its own automation types. The Perk is
// just a list of them attached to a character instead of to a move, run through
// the same executor, so it produces the same Chat Log line, the same
// `automation_fired` event and the same cutscene beat a move's On Block would.
//
// `once: 'round'` is the part that needed real machinery — the charge lives in
// `character_perk_state` and is refreshed when THIS fighter's pair starts its
// next round, not when any fight anywhere does (see clearPerkState).
//
// A negative `self_stamina` gives Stamina back rather than taking it. The Move
// Creator cannot author that — it takes the absolute value of anything outside
// SIGNED_TYPES — which is exactly the kind of thing a code-authored Perk is
// for, and it is why the effect's label had to learn to follow its sign.
//
// **A sample, chosen to exercise the trigger path and the state store.**
export default {
  name: 'Second Wind',
  description:
    'Getting hit wakes you up. The first time your guard fails in a round, you recover 2 Stamina.',

  triggers: {
    defense_failure: {
      once: 'round',
      text: 'the hit knocks the wind back into them',
      automations: [{ type: 'self_stamina', amount: -2 }],
    },
  },
};

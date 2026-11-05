# Panic at the Dojo — import guide

This package exports the character content in the supplied *2e / PATCH’D UP Beta* PDF, with the user’s six screenshot Builds replacing the PDF’s original Builds and the Focused, Fused and Frantic Bleed abilities. Bleeding conditions and Bleed-triggered effects belonging to Forms, Styles and villain Archetypes remain intact.

The content file is declarative JSON. It contains source text and structured mechanics; it is not an executable rules engine. General combat procedures, normal token behavior, terrain behavior, cinematic weights and encounter parameters are deliberately left to the VTT. Option-specific unique-token mechanics are included because they form part of the options that grant them.

Combat rolls generate numbers in an Action Pool, which are spent to pay for Actions with listed effects. Larger payments unlock Gates, and tokens provide resources for reactions, movement and special mechanics. Forms determine the base Action Dice; Styles determine range and add mechanics; combining them creates a Stance. Archetypes provide specialization across Stances, while Builds supply an independent passive benefit. Focused Heroes begin with one Archetype, Fused Heroes with two, and Frantic Heroes with three whose components they recombine during play. Forms also grant narrative Skills, and advancement grants further options and Super Moves.

## Files

| File | Purpose |
|---|---|
| `panic-at-the-dojo.content.json` | Main catalog and structured effect programs |
| `panic-at-the-dojo.schema.json` | JSON Schema Draft 2020-12 for validating the catalog |
| `panic-at-the-dojo.import-guide.md` | Data model, resolution contract and operation reference |

## Catalog layout

| Collection | Meaning |
|---|---|
| `forms` | Twelve Forms, alternate names, complexity, colored dice, Skills and linked mechanics |
| `styles` | Sixty-five Styles, each linked to its player Archetype |
| `freestyles` | Twelve Freestyles, dice replacements and globally banned Forms |
| `archetypes` | Thirteen player and nine villain Archetypes; `kind` distinguishes them |
| `builds` | The six replacement Builds from the screenshot |
| `actions` / `basicActionIds` | All Actions, with the ten universally available Basic Actions indexed separately |
| `abilities` | Named Abilities broken into individually identified event rules |
| `superMoves` | Twenty-six player Supers and nine villain Supers |
| `skills` | Twelve Form Skills; the character’s fourth, two-word Skill is free text |
| `heroTypes` / `composition` | Focused, Fused and Frantic construction constraints and Stance assembly |
| `advancementTracks` / `features` | Complete level 1–10 Hero and Warrior advancement and granted features |
| `warriorPaths` / `characterTypes` | Seven Warrior’s Paths and the NPC creation information present in the PDF |
| `resourceMechanics` | Control, Chaos, Poltergeist, Mentor, Luck, Training and Rapid Strike token mechanics |
| `sources` / `systemGroups` | Source provenance and the owner record for Basic Actions |

Every catalog entity has a globally unique, stable string `id`. Reference fields ending in `Id` or `Ids` resolve to catalog records. `abilityVariants.focused`, `.fused` and `.frantic` also contain Ability IDs. Local cost-option IDs, choice-option IDs and runtime `ref` paths are not catalog references. An entity’s `actionIds` and `abilityIds` are references rather than embedded copies. Resolve a resource mechanic’s `ownerId` to find its associated option.

Names are presentation text. Use IDs for saved characters. In particular, the printed spelling **Persistant Freestyle** is retained. Separate records are used for identically named Form/Freestyle Actions: Chaotic’s *Left, Right!* hits the same enemy twice, while One-Two’s version requires two different enemies.

`source.pdfPage` is one-based physical PDF numbering. `printedPage` is the page label in the PDF. Screenshot sources use `region` with the Build name. Source `rulesText` preserves mechanical numbers and wording, with PDF wrapping/whitespace normalized. Descriptions and `sourceExplanations` remain source prose, not extra executable effects.

## Import and Stance assembly

```js
const content = JSON.parse(jsonText);
const entities = new Map();
for (const value of Object.values(content)) {
  if (!Array.isArray(value)) continue;
  for (const row of value) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
    if (entities.has(row.id)) throw new Error(`Duplicate ID: ${row.id}`);
    entities.set(row.id, row);
  }
}
const resolve = id => {
  if (!entities.has(id)) throw new Error(`Unresolved ID: ${id}`);
  return entities.get(id);
};
```

Create fixed Stances by combining one chosen Form with one chosen Style or Freestyle. Combine their linked Actions and Abilities; take range from the Style and dice from the Form. Apply composition modifiers such as Blaster’s range increase. Form aliases only change the displayed name.

For a Freestyle, retain the Form’s **purple** dice and discard its **green** dice, then add the Freestyle’s purple dice. Fixed numbers are `{ "kind": "fixed", "value": 5 }`, not dice to roll. At most one Freestyle is known, and its banned Form cannot be among the character’s known Forms or Stances. Freestyles override the ordinary Style-per-Archetype selection constraints. Bonus dice from advancement are separate from the Form’s colored base dice.

Frantic Stances are assembled each turn. Apply their previous-turn component exclusions and only activate the selected Frantic variant. Fused abilities granted later by advancement remain constant. Construction counts under `composition.initialForms`, `initialStyles` and `heroTypes.stylesPerArchetype` describe initial creation; apply advancement grants afterward.

## Costs and gates

Costs are separate from effects. With `selection: exactly_one`, choose one option and pay **all** its components. A Dice Action consumes one Action Pool number at least as large as `minimum`; Token Actions require exact quantities. `token: basic` permits a mixture of Iron, Power and Speed. HP, Shield value, and a Challenge held by an enemy are distinct cost resources. Capture spent values and holders before removing them.

Bag of Tricks uses `one_or_more_distinct`: each selected cost option is paid once. Its 2+ plus 1 HP option has two components, and is still one paid option. `X` is the number of paid options. Roughhousing instead offers separate optional additional payments; its ordinary 4+ payment is still required.

Use `payment.rating` for the actual paid or emulated rating and initialize `resolution.gateRating` to it. If the player elects to stop at an earlier Gate, lower only `resolution.gateRating`, leaving actual payment and X values unchanged. Token alternatives can explicitly map payment quantities to gate ratings: for example, Flare’s 3 Basic tokens map to rating 1, and 6 Basic tokens map to rating 5. A free or copied Action’s supplied rating controls Gates without consuming an Action Pool number.

`gates.headerThresholds` and `effectThresholds` preserve the printed thresholds for inspection; the effect program determines whether a Gate appends a new step or replaces an earlier value. Resolve replacement values and choice counts before executing the affected portion. Additive gates stay in order. Each `damage` node is a separate hit, even when two consecutive nodes target the same character.

## Runtime values and selectors

`{ "ref": "targets.target" }` means a runtime value lookup, not a JavaScript expression or catalog ID. Resolve paths by safe property traversal. Expressions use `{ "operator": "gte", "args": [...] }`; implement an explicit operator dispatch table, never `eval` or `Function`.

| Namespace | Supplied by |
|---|---|
| `self` | Acting character; explicit `actor` overrides individual operations |
| `context` | Active character, side relationship, round, Heal/Bleed values, Super limits and Heroic Spirit recipient |
| `side` | The current character’s side and shared counters |
| `payment` | Consumed numbers, token quantities by type, HP, destroyed Shield value and former Challenge holder |
| `resolution` | Gate rating selected for this resolution |
| `variables` | Resolution-local values written by `set_variable` |
| `targets` | Objects captured by `select`, `ensure_target` and `select_token` |
| `bindings` | Loop objects, newly placed obstacles and captured die rolls |
| `state` | Persistent choices belonging to this option’s owner, such as Song, Mood, Ammo or Weapon |
| `event` | The triggering event and its actual actors, targets and values |
| `history` | Resolution history, including damage actually dealt, newly Challenged enemies and discarded-token counts |

A selector describes **kind**, **range**, **count**, and optional filters. `enemy`, `ally`, `unit`, `space`, `obstacle` and the other kinds are typed selection requests. A single selected target remains a reference to that object after movement; a later selector is evaluated at its later position in the sequence. Multi-target operations apply the listed amount to each selected target unless a field such as `totalAcrossTargets` says otherwise.

`range.mode: stance` uses the relevant actor’s current range; `adjacent` means exactly distance 1; `explicit` supplies minimum/maximum; `visible` requires sight but does not impose Stance range; `none` adds no distance restriction; `map` covers the map. Relationship-specific modes such as `adjacent_to_binding` identify their origin through a binding. `range.origin` defaults to self and can instead name an ally, Copy, obstacle or earlier target. Filters add restrictions rather than replacing the selected kind. Allies include self unless `excludeSelf` is explicit.

Expression operators include arithmetic/comparison/boolean operations, `tier_value` (highest satisfied `[threshold, value]` pair), `lookup`, `choose_integer`, and the explicit board predicates. `if` expressions are lazy so an inapplicable branch does not require a missing value. A number of choice options or repetitions must resolve to a legal integer. `maximum: null` on `repeat` means no numeric upper limit, with its stopping condition still enforced.

## Ability events, duration and state

Each `abilities[].rules[]` entry has a stable rule ID, event list, optional condition, effect and optional usage limit. `continuous` is a passive modifier. Other event names describe exact events the VTT must emit; `own_turn.start` and `own_turn.end_abilities` are the Start and End Ability windows, not cleanup. `any_turn` includes every character’s turn; `allied_turn` includes the owner’s turn. When one rule listens to multiple events, use a shared counter if `sharedAcrossEvents` is true.

Form/Style passive rules are active when their source is in the current Stance. Constant Archetype and Build rules apply independently of Stance. Build records carry the PDF’s common Unblockable property. `modify_rule` is scoped to the current Action resolution when run as an Action effect, to the owning passive while continuous, or to an explicit enclosing `temporary` duration. It does not permanently mutate the catalog. Delayed effects capture their bindings when scheduled.

`start_of_next_own_turn`, `end_of_current_turn`, `end_of_current_round`, `end_of_next_round` and `end_of_fight` refer to the effect owner unless the duration explicitly names a target. A duration containing `or_next_action` expires on the first matching boundary. Restrictions and hard usage limits cannot be increased by number-modification effects.

Spending tokens and discarding tokens are different events. Preserve actual damage history after defenses; damage-based token grants use damage actually dealt. Keep event-derived enemy/ally sets distinct and deduplicated. Copies use the Original’s resources and modifiers while moving/targeting from the Copy’s position, as the engine’s normal Copy rules require. Pit Trap in Bag of Tricks is two atomic placements—Pit and Trap—in the same captured empty space.

Super Moves remain separate from Actions. They normally consume two matching numbers of at least 3 and share the once-per-fight character limit. They cannot be used in Round 1. Context supplies the cinematic-weight permission and side limit. Transcendant Spirit has its explicit no-number payment exception. Special Super effects can grant later triggers and resource actions; those are represented separately from the initial Super damage. Rapid Strike is a Super token and uses its dedicated resource Action; generic theft/conversion/discard must honor the engine’s Super-token protection.

## Source decisions and validation

`automationState: structured` means the entry has a declarative mechanical breakdown. It does **not** mean that a complete browser combat engine has been implemented or tested. `requires_ruling` marks a source conflict or unfinished entry. Inspect this status on the entry and its dependencies before enabling automatic resolution. The rules text remains available for manual play. Null range and unfinished placeholders deliberately remain unresolved; the schema accepts them to preserve the beta’s actual content.

The validation checks JSON syntax, schema shape, source coverage, unique IDs and cross-references, removal of the old Build/Bleed options, colored dice, advancement tables, and representative cost and gated-effect behavior. JSON Schema checks shape; cross-reference existence, legal character selections, board legality and event payload correctness require interpreter validation. The specific source conflicts are listed in the accompanying chat for user rulings.

## Operation reference

The table lists required parameters. The schema records optional parameters and exact object shapes. Amounts, values, distances, targets and counts can contain runtime references or expression objects where their schema permits.

| Operation | Required parameters | Meaning |
|---|---|---|
| `add_pool_number` | `value`, `target` | Add one number with this value to each target’s Action Pool. |
| `append_to_current_action` | `effect` | Insert the enclosed effect after the pending Action’s original effect. |
| `assemble_stance` | `excludeEachUsedOnPreviousOwnTurn`, `pickArchetypeAbility`, `pickForm`, `pickStyle` | Choose the listed components, respecting previous-turn exclusions. |
| `become_taken_out` | — | Apply the engine’s Taken Out state. |
| `challenge` | `target`, `challenger` | Give the acting unit’s named Challenge to the target through Challenge-token rules. |
| `change_current_stance_component` | `chooseOneOf` | Change one eligible component selected from chooseOneOf. |
| `choose` | `minimum`, `maximum`, `unique`, `resolveOrder`, `chooser`, `options` | Choose a permitted number of distinct options, then resolve them in printed order. |
| `choose_mode` | `stateKey`, `options` | Choose one listed mode, store it in the owner-scoped stateKey, and honor disabled modes. |
| `choose_warrior_path` | `count` | Make the required Warrior’s Path selection. |
| `combine_pool_numbers` | `count`, `method` | Replace the chosen numbers with their combined value using method. |
| `convert_tokens` | `target`, `to` | Change selected token instances to the type named by to. |
| `copy_declared_action` | `afterOriginal`, `excludeOncePerTurnActions`, `rating` | Queue a copy of the enemy’s declared Action at the supplied rating. |
| `damage` | `amount`, `target` | One independent hit per target; use actor when specified, otherwise the current acting unit. |
| `delegate_actions` | `actorSelector`, `payer`, `useActorsLocationRangeAndStance` | The payer pays costs while a selected ally performs using the ally’s position and Stance. |
| `destroy_obstacle` | `target` | Destroy each selected obstacle through its normal destruction behavior. |
| `destroy_shield` | `target` | Remove the target’s Shield entirely. |
| `discard_tokens` | `amount`, `target`, `tokenFilter` | Remove matching tokens, subject to chooser, amount, exclusions and upTo qualifiers. |
| `distribute_distinct_basic_tokens` | `amounts`, `types` | Assign distinct Basic token types to the listed quantities. |
| `dodge_declared_action` | `target` | Make the chosen legal target immune to the entire declared Action. |
| `duplicate_pool_number` | `target` | Add a copy of one selected eligible number. |
| `duplicate_token` | `target` | Grant another token of the selected instance’s type. |
| `ensure_target` | `binding`, `selector` | Reuse an existing binding, or select it now if it is still unbound. |
| `for_each` | `selector`, `binding`, `effect` | Bind each selected object in turn and resolve the enclosed effect for that object. |
| `gain_shield` | `value`, `target` | Offer a Shield with this value; the engine handles existing Shields and the cap. |
| `gain_tokens` | `token`, `amount`, `target` | Grant amount of token to each target through the engine’s token rules. |
| `gain_tokens_until` | `token`, `total`, `target` | Add tokens only until the named total is reached; do not remove excess tokens. |
| `grant_archetype_variant` | `archetype`, `variant` | Grant the named variant of an eligible Archetype, preserving an old one only if specified. |
| `grant_armor` | `target`, `temporary` | Grant one Armor source, or the binary temporary Armor benefit when temporary=true. |
| `heal` | `amount`, `target` | Restore HP to each target; the engine applies health-bar limits. |
| `heroic_spirit.use_maximum_dice_results` | — | Use each donor die’s maximum instead of rolling for this Heroic Spirit. |
| `if` | `condition`, `then` | Evaluate condition; resolve then, otherwise else when present. |
| `increase_distinct_pool_numbers` | `amounts`, `maximum` | Assign each increase to a different pool number, respecting maximum. |
| `increase_pool_number` | `amount`, `target` | Increase one selected number by amount. |
| `joint_choice` | `groups`, `options`, `unique`, `resolveOrder` | Different choosers select options from one shared list; uniqueness applies across all groups. |
| `limited` | `maximum`, `period`, `scope`, `effect` | Resolve the effect only if its own usage counter has not reached the limit. |
| `modify_action_numbers` | `count`, `amount`, `exclude` | Increase selected eligible numeric fields of the pending Action; exclusions are mandatory. |
| `modify_pool_numbers` | `amount`, `minimum`, `target` | Apply an adjustment to all affected Action Pool numbers, honoring minimum. |
| `modify_rule` | `rule`, `value`, `target` | Apply a named, parameterized rule modifier to its target in the current scope. |
| `move` | `distance`, `target`, `upTo` | Action Movement. upTo=false means the listed distance is mandatory when movement is possible. |
| `move_obstacles` | `distance`, `optionalPerObstacle`, `selector`, `uniqueDestinations`, `upTo` | Move eligible obstacles, respecting distance and unique-destination restrictions. |
| `narrative_permission` | `text` | Store the exact narrative Skill permission; it is resolved by players rather than a combat engine. |
| `negate_declared_action` | — | End the declared Action without resolving its effects. |
| `optional` | `effect`, `chooser` | The named chooser may resolve the entire enclosed effect or decline it. |
| `pay_hp` | `amount`, `target` | Pay HP as a resource, rather than dealing damage. |
| `perform_action` | `selector`, `rating`, `actor`, `payCost`, `resultingActionType` | Perform a selected legal Action with the stated actor/rating and cost treatment. |
| `place_obstacle` | `obstacle`, `count`, `target` | Place the listed number/type in legal spaces. A binding captures created obstacles. |
| `prepend_to_current_action` | `effect` | Insert the enclosed effect before the pending Action’s original effect. |
| `pull` | `distance`, `target` | Forced movement toward origin, or toward the acting unit if origin is absent. |
| `pull_until` | `origin`, `step`, `stopCondition`, `target` | Move the target toward origin one step at a time until stopCondition or a movement blocker. |
| `push` | `distance`, `target` | Forced movement away from origin, or away from the acting unit if origin is absent. |
| `reduce_damage` | `allowsAlreadyReduced`, `amount`, `ignoresUnblockable` | Reduce the incoming damage packet; special bypass permissions are explicit fields. |
| `reduce_forced_movement` | `amount`, `minimum` | Reduce the pending forced movement, with its stated lower bound. |
| `reduce_shield` | `amount`, `target`, `upTo` | Remove the stated amount of Shield, respecting upTo when present. |
| `register_trigger` | `events`, `effect` | Register the enclosed effect for the named events within its enclosing duration. |
| `remove_from_play` | `allowComeback`, `allowRescue`, `duration`, `heroicSpiritContinues`, `target` | Remove target and honor duration, comeback/rescue restrictions and Heroic Spirit flags. |
| `remove_lowest_action_die` | `fallbackOrder`, `target` | Suppress the lowest Action Die, using the stated ordered fallbacks. |
| `repeat` | `minimum`, `maximum`, `effect` | Repeat the effect within the stated bounds; capture history and apply stopWhen/onStop. |
| `replace_obstacle` | `replacement`, `target` | Replace each selected obstacle with the specified type. |
| `replace_pool_number` | `target`, `value` | Replace one selected number with the specified evaluated value. |
| `replace_token_gain` | `amount`, `fromToken`, `toToken` | Replace the specified portion of an incoming token grant with another type. |
| `replay_start_effects` | `asActionEffects`, `sources` | Resolve all applicable Start effects again as effects of the current Action. |
| `reroll_dice` | `maximum`, `mustKeepNew` | Reroll up to maximum dice; mustKeepNew prevents choosing the former result. |
| `reroll_die` | `target` | Reroll a selected die; keep the new result and repeat only under repeatWhile when supplied. |
| `retain_pool_numbers` | `maximumCount`, `maximumTotal` | Retain only the permitted count and total when the pool would otherwise be discarded. |
| `return_to_play` | `target`, `destination` | Return the target into a legal destination after any preceding healing. |
| `roll_die` | `binding`, `sides` | Roll a die with sides and store its result in bindings[binding]. |
| `schedule` | `at`, `effect` | Capture the current bindings and schedule the effect at the named future boundary. |
| `select` | `binding`, `selector` | Choose legal targets now and save the result under targets[binding]. |
| `select_token` | `binding`, `holder`, `count` | Choose token instances or a token type held by the specified holder; bind the selection. |
| `selector_by_gate` | `cases` | Use the selector attached to the highest satisfied gate threshold. |
| `sequence` | `steps` | Resolve steps in listed order; do not merge hits or movements. |
| `set_pool_number` | `target`, `value` | Replace one selected number with the chosen legal value. |
| `set_state` | `key`, `value` | Store a value in the current owner’s persistent state. |
| `set_variable` | `name`, `value` | Store value in variables[name] in the current resolution scope. |
| `spend_optional_tokens` | `maximum`, `target`, `token` | Offer payment of zero through maximum tokens; record actual payment. |
| `spend_tokens` | `token`, `amount`, `target` | Pay the exact token amount; this is spending, not an effect that discards tokens. |
| `split_incoming_damage` | `maximumRedirectors`, `originalShare`, `originalTarget`, `recipient`, `recipientShare` | Split one incoming damage packet between original target and recipient. |
| `split_pool_number` | `minimumOriginal`, `parts` | Replace one eligible number with parts calculated by the listed rounding methods. |
| `steal_tokens` | `recipient`, `target` | Transfer the selected token instances to recipient. |
| `substitute_cost` | `amount`, `replaceOneOf`, `spendToken` | Pay spendToken instead of one of the explicitly listed resource quantities. |
| `swap_spaces` | `target`, `actor` | Swap target and actor simultaneously through the engine’s swap rules. |
| `swap_twins` | — | Swap the two linked Twins; requires the GM to define the unfinished Twins model. |
| `switch` | `cases`, `match` | Resolve the first matching case; later cases do not resolve. |
| `teleport` | `distance`, `target` | Choose a legal destination within the listed distance, ignoring intervening spaces. |
| `teleport_to` | `target`, `destination` | Teleport to a destination selected by the explicit destination selector. |
| `temporary` | `duration`, `effect` | Install the enclosed effect or modifier until the stated expiry. |
| `trigger_warrior_path` | — | Resolve the effects of the character’s selected Warrior’s Path. |
| `unresolved` | `sourceText` | Source content is unfinished. Preserve and display it; no mechanical implementation is supplied. |
| `upgrade_archetype_variant` | `fromVariant`, `selection`, `toVariant` | Replace a selected old ability variant with the specified new variant. |

## Vocabulary index

These are engine adapter keys, not names of additional catalog options.

### Expression operators

`add`, `adjacent`, `and`, `ceil`, `choose_integer`, `divide`, `enemy_shares_space_with_obstacle`, `eq`, `floor`, `gt`, `gte`, `if`, `is_ally`, `is_enemy`, `is_obstacle`, `lookup`, `lt`, `lte`, `max`, `min`, `multiply`, `not`, `not_in`, `subtract`, `tier_value`, `within_range_of_self_or_copies`, `within_stance_range`.

### Selector kinds

`action`, `ally`, `ally_or_obstacle`, `enemy`, `enemy_or_obstacle`, `obstacle`, `own_copy`, `own_pool_number`, `own_twin`, `previous_action_target`, `rolled_die`, `self_and_allies`, `self_and_own_copies`, `self_and_visible_allies`, `self_or_ally`, `space`, `unit`, `unit_or_obstacle`.

### Range modes

`adjacent`, `adjacent_to_any_own_copy`, `adjacent_to_binding`, `adjacent_to_destroyed_copy`, `adjacent_to_event_action_target`, `explicit`, `map`, `nearest_to_event_former_holder`, `none`, `on_or_adjacent_to_binding`, `on_or_adjacent_to_destroyed_obstacles`, `self_or_copies_range`, `stance`, `target_and_adjacent`, `visible`, `within_placed_obstacles`.

### Ability and granted-trigger events

`allied_turn.end_abilities`, `allied_turn.start`, `ally.action.resolved`, `ally_in_range.would_take_damage`, `any_action.fully_resolved`, `any_movement_phase.start`, `any_turn.end_abilities`, `any_turn.start`, `continuous`, `end_phase.pool_discard`, `end_phase.speed_discard`, `enemy.destroyed_own_copy`, `enemy.removed_own_challenge_by_enemy_action_or_ability`, `enemy.turn.start`, `enemy_in_range.action.cost_paid_before_resolution`, `enemy_in_range.broke_allied_shield`, `enemy_in_range.damaged_allied_shield`, `enemy_in_range.own_shield_broken`, `enemy_in_range.own_shield_damaged`, `enemy_in_range.trap_damage_taken`, `enemy_turn.start`, `own_action_phase.start`, `own_stance_select_phase.start`, `own_turn.end_abilities`, `own_turn.start`, `reactive_action.opportunity`, `self.action.before`, `self.action.cost_paid`, `self.action.damage_dealt_to_enemy`, `self.action.resolved`, `self.action_dice.rolled`, `self.action_or_ability.damage_dealt`, `self.armor_triggered`, `self.bleed`, `self.burning_token_damage_taken`, `self.challenge_given_to_enemy`, `self.control_tokens_spent`, `self.copy_destroyed`, `self.damage_dealing_action.resolved`, `self.damage_dealt`, `self.damage_dealt_to_enemy`, `self.damage_reduced_by_armor`, `self.damage_reduced_by_iron`, `self.damage_taken`, `self.dice_action.resolved`, `self.fell_to_zero_hp`, `self.first_action_on_own_turn.resolved`, `self.free_movement.one_space_finished`, `self.gain_speed_tokens`, `self.giving_heroic_spirit`, `self.healed`, `self.hit_enhanced_with_power`, `self.hit_reduced`, `self.hit_reduced_from_enemy`, `self.hp_paid`, `self.iron_tokens_spent`, `self.move_over_wall`, `self.movement.finished`, `self.mythical_d12.rolled`, `self.power_tokens_spent`, `self.push_finished`, `self.pushed`, `self.reactive_action.before`, `self.shield_absorbed`, `self.shield_absorbed_from_enemy_action`, `self.throw_or_grapple.resolved`, `self.token_action.pay_cost`, `self.tokens_discarded_by_action_or_ability`, `self.tokens_given_to_enemy`, `self.took_damage_from_action`, `self.took_damage_from_enemy_action`, `self.training_token_spent`, `self.weakness_given_to_enemy`, `self.would_be_pushed_or_pulled`, `self.would_take_damage`, `shield_in_range.broken`, `stance.construct`, `visible_enemy.gain_basic_tokens`, `warrior_path.trigger`.

### Rule modifier keys

`abilities.disabled`, `action_cost.reduction`, `action_damage.adjustment`, `action_dice.additional`, `action_dice.omit_color`, `action_movement.set`, `actions.additional_targets_in_stance_range`, `allies_can_spend_own_tokens`, `armor.disabled`, `armor.first_trigger_reduction`, `armor.not_spent_when_one_damage_hit_fully_blocked`, `armor.triggers_per_turn`, `challenge.cannot_discard`, `challenge.unblockable`, `control.dodge_cost`, `copies.maximum_hp`, `current_action.maximum_range_bonus`, `damage.immunity`, `end_phase.speed_discard`, `end_phase.speed_discard_floor`, `enhance_hit.additional_uses`, `footprint`, `frantic.active_abilities`, `free_movement.cost_per_space`, `free_movement.disabled`, `freestyles.disabled`, `iron.can_reduce_hits_to_own_copies`, `iron_can_pay_as`, `iron_tokens.additional_per_hit`, `movement.all_pits_adjacent`, `movement.all_spaces_empty`, `movement.cannot_enter_adjacent_to_self`, `next_action.additional_legal_targets`, `next_action.maximum_range_bonus`, `next_damage_action.unblockable`, `opponents.iron_token_limit_per_hit`, `own_challenged_enemies.always_in_range`, `own_challenges.immune_to_enemy_action_or_ability_removal`, `poltergeist.total_per_action`, `power_tokens.additional_per_hit`, `range.maximum_bonus`, `range.maximum_set`, `range.minimum_set`, `range.set`, `rubble.no_fatigue`, `shield.disabled`, `sight.ignore`, `speed_tokens.cannot_gain_or_spend`, `spend_target_weakness_as_own_power`, `stance.composition`, `throw.target_range`, `throw.target_selector`, `unblockable`, `walls.may_move_over`, `walls.treat_as`, `weakness.damage_reduction`, `weapon.disabled`.


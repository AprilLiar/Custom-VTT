// Tag automations — the first Tags in the game that DO something rather than
// describe something.
//
// Tags started as pure annotation: a world-level name + description the GM
// hangs on a Move, shown as a chip with a tooltip. This module is where a Tag
// stops being decoration and starts being a rule, and it is deliberately
// shaped like `PERK_HOOKS` in perkAutomations.js — a small registry keyed by
// the Tag's **exact name**, holding hand-written behaviour per Tag, rather
// than a generic automation system that tries to anticipate every effect
// anybody might want. That generic approach was already tried once for Perks
// and removed (see vttprojectplan.md's Perks & Tags section); the lesson
// carries over.
//
// **Keyed by name, matched case-insensitively, never by id.** The GM owns the
// tag list: ids differ between databases, a world may already have its own
// "Block" tag, and the GM can rename or re-create one at any time. Matching
// on the name is what keeps a mechanic attached to the thing the table thinks
// it is attached to.

export const BLOCK_TAG = 'Block';
export const NO_DAMAGE_TAG = 'No Damage';
export const FEINT_TAG = 'Feint';
// **The first Tags that carry a NUMBER.** Authored as `Interrupter (3)` /
// `Hard to Interrupt (2)` — the amount lives in the tag's own name rather than
// in a new column, because a Tag is a world-level row the GM creates and names,
// and "Interrupter (3)" is already how a table would write it on a card. Three
// separate tags for three strengths is also how a GM would naturally build it,
// and `tagAmount` below sums them, so stacking works without anybody designing
// stacking.
export const INTERRUPTER_TAG = 'Interrupter';
export const HARD_TO_INTERRUPT_TAG = 'Hard to Interrupt';
// **A pair of Tags that only mean anything about each other.** Neither does a
// thing on its own: `Movement` is a label saying this move takes you somewhere,
// and `Movement Punisher` is a move built to catch someone doing that. The
// mechanic lives in the meeting of the two.
export const MOVEMENT_TAG = 'Movement';
export const MOVEMENT_PUNISHER_TAG = 'Movement Punisher';

// **Off The Ground**: the Tag that reads Trip Recovery frames. A move carrying
// it may be declared so its Startup overlaps the declarer's own trip frames —
// see `placementFloorAfterTrip` in combatTiming.js for the two caps that keep
// it from becoming a general "start earlier" licence.
//
// The only Tag so far whose effect is at **declare** time rather than at
// resolution: it does not change what the move does, only when it may be put
// on the clock.
export const OFF_THE_GROUND_TAG = 'Off The Ground';

// **Grounding**: the Tag that WRITES Trip Recovery frames, where Off The Ground
// only reads them. Every Recovery frame this move has becomes a Trip Recovery
// frame — the move puts its own user on the floor as part of throwing it.
//
// Its natural pair is Off The Ground, and that is the point: a move that grounds
// you is a real cost until you have something to throw off the floor. Nothing
// about the *count* changes; a 3-Recovery move still has three frames. What
// changes is what kind they are, which is exactly what Movement Punisher already
// does to somebody else — this is a fighter doing it to themselves, on purpose.
export const GROUNDING_TAG = 'Grounding';

// How much Recovery a punished Movement move costs its owner. A flat 3 rather
// than a number in the Tag's name: the two Interruption Tags are parameterised
// because their whole point is scaling a contest, and this one is a single
// consequence the table can price once.
//
// **These are Trip Recovery frames (decided, revised).** Being caught
// mid-stride puts you on the floor, which is a different state from being
// slow to recover — Off The Ground reads it, and the frames draw as their
// own darker blue with a down arrow. The count is unchanged; what changed is
// what kind of frames they are.
export const MOVEMENT_PUNISH_RECOVERY = 3;

// **Punisher — (Stat)**: a move built to catch a specific *kind* of attack.
// While the opponent has a move on the clock — anywhere in its Startup, Active
// or Recovery frames — whose own Roll includes the named Stat, this move rolls
// +2. A `Punisher - Body` catches somebody in the middle of anything that rolls
// Body, whatever else that move also rolls.
//
// **Parameterised by a STAT rather than by a number**, which is new: the two
// Interruption Tags put an amount in their name, and this one puts a Stat there.
// Same reason either does it — a Tag is a world-level row the GM names, and
// "Punisher - Body" is already how a table would write it on a card.
export const PUNISHER_TAG = 'Punisher';

// Flat, like MOVEMENT_PUNISH_RECOVERY and for the same reason: it is a single
// consequence the table can price once, not a contest being scaled.
export const PUNISHER_BONUS = 2;

// The five Stats a Punisher may name. Deliberately NOT the seven-name Roll
// vocabulary: Stamina and Weapon are not on this list, and Hand and Leg mean
// *either or both* — a `Punisher - Hand` catches a move rolling a Left Hand, a
// Right Hand, or the ambiguous Hand, because what is being punished is somebody
// throwing hands.
export const PUNISHER_STATS = ['Skull', 'Brain', 'Body', 'Hand', 'Leg'];

// One entry per Tag that carries mechanics. See resolveBlockStamina and
// resolveNoDamageOutcome in combatDamage.js for the arithmetic behind each,
// and vttprojectplan.md's Block Stamina / No Damage Tag rules for the design.
export const TAG_HOOKS = {
  [BLOCK_TAG]: {
    // The move has no up-front Stamina Cost. writeMove forces stamina_cost
    // to 0 so it can't be authored, and combat:declare's affordability check
    // therefore never blocks declaring one.
    noStaminaCost: true,
    // It spends Stamina at resolution instead, proportional to how much of
    // the attack its guard actually absorbed.
    staminaFromAbsorbed: true,
    // Which authoring field replaces Stamina Cost on the Move Creator.
    staminaField: 'stamina_modifier',
  },
  [NO_DAMAGE_TAG]: {
    // The move never deals damage — it does not reach applyAutoDamage at all,
    // and it never triggers an Interruption check, because Interruption is
    // gated on damage having actually been dealt.
    suppressesDamage: true,
    // What it does instead: compare the roll against the move's own Success
    // Threshold. Success fires On Hit — it connected, which is the same
    // reasoning that makes Insignificant Damage fire On Hit rather than On
    // Miss. Failure fires nothing (see resolveNoDamage in roundResolution.js).
    usesSuccessThreshold: true,
    // Which authoring field the Move Creator reveals for it.
    thresholdField: 'success_threshold',
  },
  [INTERRUPTER_TAG]: {
    // Carries an amount in its name; see tagAmount. It moves ONE comparison —
    // the Interruption check — and nothing else. The attack's own roll, its
    // damage and every other rule are untouched: the attack is merely
    // "considered" this much harder to hold through.
    parameterised: true,
    interruptSide: 'attacker',
  },
  [HARD_TO_INTERRUPT_TAG]: {
    // The same knob from the other side: the move being caught in Startup
    // counts its resistance roll this much higher, for that comparison only.
    parameterised: true,
    interruptSide: 'defender',
  },
  [MOVEMENT_TAG]: {
    // Pure annotation on its own — nothing reads it except the Tag below.
    // It is a **liability**, which is unusual for a Tag: putting it on a move
    // is telling the table what that move is vulnerable to.
    describesMovement: true,
  },
  [MOVEMENT_PUNISHER_TAG]: {
    // Fires only against a Movement move, and only on a real connection.
    punishesTag: MOVEMENT_TAG,
    imposesRecovery: MOVEMENT_PUNISH_RECOVERY,
    // ...and they land as Trip Recovery, not ordinary Recovery.
    imposesTripRecovery: true,
  },
  [OFF_THE_GROUND_TAG]: {
    // Read at declare time by the placement floor, not at resolution. Nothing
    // in the damage or timing engines looks at it.
    overlapsTripRecovery: true,
  },
  [PUNISHER_TAG]: {
    // Carries a STAT in its name rather than an amount — see punisherStats.
    // Read at roll time by the shared modifier funnel, and it moves exactly one
    // number: this move's own Roll. Nothing about the attack it is punishing
    // changes.
    parameterisedByStat: true,
    rollBonus: PUNISHER_BONUS,
  },
  [GROUNDING_TAG]: {
    // Also read at declare time, and the only Tag that writes
    // `declared_moves.trip_recovery_tics` from the move's own shape rather than
    // from something that happened during the round. Frozen at declare like
    // every other snapshot on that row: editing the template's Recovery
    // afterwards must not reach back into an attack already on the clock.
    groundsSelf: true,
  },
  [FEINT_TAG]: {
    // A Feint shows its own Tell exactly like any other move — that is the
    // whole point, it is a lie told in public. What it changes is the move
    // declared IMMEDIATELY after it: that one goes on the timeline in
    // secret, with no Tell and no attack telegraph for anyone but its owner,
    // and only becomes visible when it reveals during resolution.
    masksNextMove: true,
  },
};

const norm = (name) => String(name ?? '').trim().toLowerCase();

// Does this set of tag names include `tagName`? Case-insensitive, whitespace
// tolerant — a GM typing "block " must not silently lose the mechanic.
export function hasTagNamed(tagNames, tagName) {
  const wanted = norm(tagName);
  return (tagNames ?? []).some((n) => norm(n) === wanted);
}

// How much a parameterised Tag is worth on this move, summed across every tag
// whose name is `<Name> (<number>)` — or the bare `<Name>`, which counts as 1
// so a GM who writes just "Interrupter" gets the obvious thing rather than
// nothing.
//
// Matched the same way `hasTagNamed` matches: case-insensitively, whitespace
// tolerant, by NAME rather than id, because the GM owns the tag list and may
// rename or re-create one at any time. Spaces inside the parentheses, a `+`
// sign, and any amount of padding are all accepted — this is a name a person
// typed, not a form field.
//
// Returns 0 when the Tag isn't present at all, so every caller can add it
// unconditionally.
export function tagAmount(tagNames, tagName) {
  const wanted = norm(tagName);
  let total = 0;
  for (const raw of tagNames ?? []) {
    const name = norm(raw);
    if (name === wanted) {
      total += 1;
      continue;
    }
    // `interrupter (3)` — the prefix has to match exactly, so a tag called
    // "Interrupter Killer" never counts as an Interrupter.
    const m = name.match(/^(.*?)\s*\(\s*\+?(\d+)\s*\)$/);
    if (m && m[1] === wanted) total += Number(m[2]);
  }
  return total;
}

// Which Stats this move's Punisher Tags name. `Punisher - Body`,
// `Punisher — Hand`, `punisher-leg`, `Punisher (Skull)` and `Punisher: Brain`
// all read the same, because this is a name a person typed rather than a form
// field — the same tolerance `tagAmount` gives the numbered Tags.
//
// A Stat the list does not know (`Punisher - Stamina`, a typo, a bare
// `Punisher`) is dropped rather than half-matched: a Tag that silently punishes
// nothing is better than one that punishes the wrong thing, and the GM can see
// the name they typed.
//
// Returns a Set, so several Punisher Tags on one move are naturally one
// question — see punisherBonus on why they do not stack.
export function punisherStats(tagNames) {
  const wanted = norm(PUNISHER_TAG);
  const found = new Set();
  for (const raw of tagNames ?? []) {
    // The separator is whatever the GM reached for: a hyphen, an en or em
    // dash, a colon, or parentheses.
    const m = String(raw ?? '')
      .trim()
      .match(/^(.*?)\s*(?:[-–—:]|\()\s*([^()]*?)\s*\)?$/);
    if (!m || norm(m[1]) !== wanted) continue;
    const stat = PUNISHER_STATS.find((name) => norm(name) === norm(m[2]));
    if (stat) found.add(stat);
  }
  return found;
}

// Which of the five Punisher Stats a Roll slot counts as. Left/Right collapse
// into the appendage, because a Punisher names the limb rather than the side —
// and the ambiguous `Hand`/`Leg` the Roll vocabulary itself uses lands in the
// same place. Anything else (Stamina, Weapon, Custom) is not punishable and
// answers null.
export function punishableStat(slotName) {
  const name = norm(slotName);
  if (name === 'left hand' || name === 'right hand' || name === 'hand') return 'Hand';
  if (name === 'left leg' || name === 'right leg' || name === 'leg') return 'Leg';
  return PUNISHER_STATS.find((stat) => norm(stat) === name) ?? null;
}

// The Punisher's +2, and which Stat earned it.
//
// `opponentSlotNames` is every Roll slot of every opponent move whose frames —
// Startup, Active or Recovery — cover the Tic this roll is happening on. The
// caller supplies them; this decides whether they are what the move was built
// for.
//
// **+2 once, however many Tags matched (decided).** The move is either
// punishing what they threw or it is not: a `Punisher - Hand` + `Punisher - Leg`
// move catching somebody rolling both is still one move catching one attack,
// and the Interruption Tags stack only because their whole point is a
// parameterised amount. The matched Stat is returned so the roll's own
// breakdown can say which one it was — a modifier nobody can account for reads
// as the engine inventing numbers.
export function punisherBonus({ tagNames, opponentSlotNames } = {}) {
  const wanted = punisherStats(tagNames);
  if (wanted.size === 0) return { amount: 0, stat: null };
  // In PUNISHER_STATS order rather than the opponent's, so a move that catches
  // two of them names the same one every time.
  for (const stat of PUNISHER_STATS) {
    if (!wanted.has(stat)) continue;
    if ((opponentSlotNames ?? []).some((slot) => punishableStat(slot) === stat)) {
      return { amount: PUNISHER_BONUS, stat };
    }
  }
  return { amount: 0, stat: null };
}

export const interrupterAmount = (tagNames) => tagAmount(tagNames, INTERRUPTER_TAG);
export const hardToInterruptAmount = (tagNames) => tagAmount(tagNames, HARD_TO_INTERRUPT_TAG);

// The Interruption contest, with both Tags folded in.
//
// **This is a contest of two attack rolls (decided, corrected).** An earlier
// version compared the caught fighter's roll against the DAMAGE the blow dealt,
// which was a misreading — the damage never enters it. What is actually being
// asked is whether the punch beat the move it caught:
//
//   attacker's attack roll  + Interrupter (x)
//        vs
//   the caught move's own attack roll + Hard to Interrupt (x)
//                                     + 1 per elapsed Active frame
//
// Each Tag still moves only its own side of that one comparison, and neither
// touches the roll either fighter actually made — a real roll goes out at its
// real value, and the Tag is what that roll is *considered* to be worth here.
//
// **The caught fighter wins ties.** "Failing means the move is cancelled", so a
// draw is not a failure: the attack has to genuinely beat them to break the
// move up.
//
// Pure, so the arithmetic can be pinned without a socket — and worth pinning
// twice over, since it has already been got wrong once.
export function resolveInterruptContest({
  attackerRoll = 0,
  interrupter = 0,
  defenderRoll = 0,
  hardToInterrupt = 0,
  // +1 per Active frame of the attack that has already elapsed, including the
  // one landing now (computeInterruptBonus in combatTiming.js). It belongs to
  // the CAUGHT fighter: the longer the attack has been out, the more of it they
  // have had to read.
  activeFrameBonus = 0,
} = {}) {
  const attackerTotal = attackerRoll + interrupter;
  const defenderTotal = defenderRoll + hardToInterrupt + activeFrameBonus;
  return { attackerTotal, defenderTotal, interrupted: attackerTotal > defenderTotal };
}

// **Movement Punisher (decided, new).** A move built to catch someone moving:
// when it connects with a real blow against somebody whose move carries
// **Movement**, they trip — narratively, and mechanically as Recovery imposed
// on them exactly the way an Add Recovery effect does it.
//
// All three conditions are required, and the middle one is the interesting one:
// **"connects" means at least half a point of damage actually landed.** A miss
// does not trip anybody, and neither does a blow that a guard reduced to
// nothing — you have to have genuinely caught them mid-stride.
//
// Pure, so the three-way condition can be pinned without a socket.
// **A Movement move needs legs to move with (decided, new).** A move carrying
// the Movement Tag cannot be declared, and cannot resolve, while either of its
// user's Legs is incapacitated — you do not step, slip or lunge on a broken
// leg, whichever one it is.
//
// Either leg, not both: the Tag says the move is footwork, and footwork on one
// leg is not footwork. It is also the reading that keeps the rule legible at
// the table — "a broken leg stops you moving" needs no follow-up question.
//
// `legStatuses` is whatever the two Leg dice's `status` columns currently say.
// Passing an empty list (a character somehow without Leg dice) blocks nothing,
// which is the safe direction: this refuses moves, and a missing row is not
// evidence of a break.
export function movementBlockedByLegs({ tagNames, legStatuses } = {}) {
  if (!hasTagNamed(tagNames, MOVEMENT_TAG)) return false;
  return (legStatuses ?? []).some((status) => status === 'incapacitated');
}

export function movementPunisherApplies({ punisherTagNames, targetTagNames, damageSteps = 0 } = {}) {
  if (!hasTagNamed(punisherTagNames, MOVEMENT_PUNISHER_TAG)) return false;
  if (!hasTagNamed(targetTagNames, MOVEMENT_TAG)) return false;
  return damageSteps > 0;
}

export const carriesBlockTag = (tagNames) => hasTagNamed(tagNames, BLOCK_TAG);
export const carriesNoDamageTag = (tagNames) => hasTagNamed(tagNames, NO_DAMAGE_TAG);
export const carriesFeintTag = (tagNames) => hasTagNamed(tagNames, FEINT_TAG);
export const carriesOffTheGroundTag = (tagNames) => hasTagNamed(tagNames, OFF_THE_GROUND_TAG);
export const carriesGroundingTag = (tagNames) => hasTagNamed(tagNames, GROUNDING_TAG);

// How many Trip Recovery frames a declaration starts life with. Zero for every
// move that does not carry **Grounding**; the move's whole Recovery window when
// it does.
//
// **Recovery frames added LATER are ordinary** — a Block that held too short
// extends the window (`recovery_extension_tics`), and `phaseAt` measures the
// trip window backwards from the Recovery end, so those extra frames land in
// front of the trip ones. That is the right way round: the extension is time
// spent still on your feet recovering from the guard, and the floor is where
// the move was always going to leave you.
//
// Pure, and separate from the declare handler, so the one arithmetic claim here
// — "all of them, and none of anybody else's" — can be pinned by a test.
export function groundingTripRecoveryTics({ tagNames, recoveryTics } = {}) {
  if (!carriesGroundingTag(tagNames)) return 0;
  const tics = Math.trunc(Number(recoveryTics) || 0);
  return tics > 0 ? tics : 0;
}

// Does a Feint conceal the declaration being made? "Right after" is a timing
// claim, not just an ordering one — the same reading the Requirement gate
// already uses ("not later, not without it, but right after"): the follow-up
// has to start on the very Tic the Feint's own frames end. Holding it back
// for a later Tic is a slower, different thing, and it gets no concealment.
//
// Pure, so the rule can be pinned by a test without a socket or a database;
// the caller supplies the two facts that need one (whether the previous
// declaration's move carries the Tag, and where its footprint ends).
//
// A null/absent previous footprint answers false rather than throwing — the
// first move of a round has nothing in front of it to be hidden by.
export function feintMasksDeclaration({ previousCarriesFeint, previousFootprintEndTic, placementTic }) {
  if (!previousCarriesFeint) return false;
  if (!Number.isInteger(previousFootprintEndTic) || !Number.isInteger(placementTic)) return false;
  return placementTic === previousFootprintEndTic;
}

// A move's tag names as they apply **to one specific character**, not as the
// template stores them. Perks can add or remove a Tag on a move for a single
// character (character_move_tags, action 'add' | 'remove'), and the Moves tab
// already renders that resolved set — so a mechanic hanging off a Tag has to
// read the same resolved set, or a Perk that grants the Block Tag would show
// up in the UI and do nothing.
//
// Removals are applied after additions, so a Perk that removes a tag wins
// over one that adds it — matching the effective_tag_ids resolution in
// server/index.js, which this mirrors on names instead of ids.
export function effectiveTagNames({ moveTagNames = [], overrides = [] }) {
  const added = overrides.filter((o) => o.action === 'add').map((o) => o.tag_name);
  const removed = new Set(overrides.filter((o) => o.action === 'remove').map((o) => norm(o.tag_name)));
  const out = [];
  const seen = new Set();
  for (const name of [...moveTagNames, ...added]) {
    const key = norm(name);
    if (!key || seen.has(key) || removed.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

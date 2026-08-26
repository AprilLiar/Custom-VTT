// Display helpers for Move cards.

export const TRIGGER_LABELS = {
  hit: 'On Hit',
  block: 'On Block',
  miss: 'On Miss',
  defense_success: 'On Successful Defense',
  defense_failure: 'On Failed Defense',
  grapple_success: 'On Successful Grapple',
};

// **Every authored automation type needs a case here (bugfix).** The fallback
// prints the raw payload — a stat step rendered as literally
// `opponent_stat_step 1` on the move card, which is what "it shows a string
// instead of a proper name" meant. It is kept as a last resort rather than
// removed, because a card must still render something for an automation saved
// by a newer version of the app than the one displaying it.
export function automationLabel({ type, amount, slot }) {
  const n = Math.abs(amount);
  // The stat-step types name a Stat, and the Stat is the point — "step 1" says
  // nothing without it.
  const where = slot ? ` ${slot}` : '';
  switch (type) {
    case 'self_recovery':
      return `${amount > 0 ? '+' : '−'}${n} Recovery (self)`;
    case 'opponent_recovery':
      return `+${n} Recovery → opponent`;
    case 'self_stamina':
      return `−${n} Stamina (self)`;
    case 'opponent_stamina':
      return `−${n} Stamina → opponent`;
    case 'self_stat_step':
      // A step is signed: positive damages, negative restores. Say which,
      // rather than printing a minus sign and leaving the reader to work out
      // that a negative amount of damage is healing.
      return amount > 0
        ? `${n} step${n === 1 ? '' : 's'} down${where} (self)`
        : `${n} step${n === 1 ? '' : 's'} up${where} (self)`;
    case 'opponent_stat_step':
      return amount > 0
        ? `${n} step${n === 1 ? '' : 's'} down${where} → opponent`
        : `${n} step${n === 1 ? '' : 's'} up${where} → opponent`;
    case 'self_stat_increase':
      return `${n} step${n === 1 ? '' : 's'} up${where} (self)`;
    case 'self_stat_recover':
      // Named as healing rather than as a step up, because the ceiling is the
      // whole difference between it and the line above.
      return `Recover${where} ${n} step${n === 1 ? '' : 's'} (self, never past base)`;
    case 'opponent_next_roll_penalty':
      return `−${n} on the opponent's next roll`;
    // Named as a trip rather than as Recovery-with-a-qualifier: the frames
    // behave identically, but what the author is choosing is to put somebody
    // on the floor, and the Off The Ground Tag is playable off that fact.
    case 'self_trip_recovery':
      return `Trip yourself — +${n} Trip Recovery`;
    case 'opponent_trip_recovery':
      return `Trip the opponent — +${n} Trip Recovery`;
    default:
      return `${type} ${amount}`;
  }
}

export const AUTOMATION_OPTIONS = [
  { type: 'self_recovery', label: 'Recovery (self, +/-)' },
  { type: 'opponent_recovery', label: 'Add Recovery to opponent' },
  { type: 'self_stamina', label: 'Lose extra Stamina (self)' },
  { type: 'opponent_stamina', label: 'Opponent loses Stamina' },
  { type: 'self_stat_step', label: 'Step your own Stat down' },
  { type: 'opponent_stat_step', label: "Step the opponent's Stat down" },
  // Restoring a Stat was always possible — `self_stat_step` with a *negative*
  // amount does it — but "type minus two to heal two" is not an authoring
  // affordance anybody finds, so it gets its own option with a plain positive
  // number. It is the same mechanic underneath, negated server-side.
  { type: 'self_stat_increase', label: 'Increase your own Stat' },
  // Same upward step, with a ceiling: healing back toward where the Stat
  // started, never past it.
  { type: 'self_stat_recover', label: 'Recover your own Stat (never past base)' },
  // The two trip effects. Deliberately next to the Recovery options they are
  // siblings of, so an author comparing "add Recovery" with "trip" sees both.
  { type: 'opponent_trip_recovery', label: 'Trip the opponent (Trip Recovery)' },
  { type: 'self_trip_recovery', label: 'Trip yourself (Trip Recovery)' },
  { type: 'opponent_next_roll_penalty', label: "Weaken the opponent's next roll" },
];

// The two stat-step automations name one Stat outright, so they use the
// concrete slots only — the ambiguous Hand/Leg vocabulary a move's Roll
// uses has no meaning here. Mirrors AUTOMATION_STAT_SLOTS in
// server/moveLogic.js, which is the authority.
export const AUTOMATION_STAT_SLOTS = [
  'Skull',
  'Brain',
  'Left Hand',
  'Right Hand',
  'Body',
  'Stamina',
  'Left Leg',
  'Right Leg',
];

export const SIGNED_AUTOMATION_TYPES = new Set([
  'self_recovery',
  'self_stat_step',
  'opponent_stat_step',
]);

// Mirrors STAT_STEP_TYPES in server/moveLogic.js (the authority): which types
// show a Stat picker in the Move Creator. `self_stat_increase` names a Stat
// too — it just has its direction in its name rather than in its sign, which
// is why it is absent from SIGNED_AUTOMATION_TYPES above.
export const STAT_STEP_AUTOMATION_TYPES = new Set([
  'self_stat_step',
  'opponent_stat_step',
  'self_stat_increase',
  'self_stat_recover',
]);

// ---------- Block Tag (the first Tag automation) ----------
//
// A move carrying the **Block** Tag has no up-front Stamina Cost. It pays at
// resolution for exactly as much of the attack as its guard absorbed, scaled
// by its Stamina Modifier — see server/tagAutomations.js for the rule and
// server/combatDamage.js's resolveBlockStamina for the arithmetic.
//
// Matched by NAME, case-insensitively, never by id: tag ids differ between
// databases and the GM owns this list, so the client resolves a move's
// tag_ids against the live tag list exactly the way the server resolves its
// own. Keeping both sides on the name is what stops the two from disagreeing
// about which moves are Blocks.
export const BLOCK_TAG_NAME = 'Block';
export const NO_DAMAGE_TAG_NAME = 'No Damage';
export const FEINT_TAG_NAME = 'Feint';
const MOVEMENT_TAG_NAME = 'Movement';

const normTag = (name) => String(name ?? '').trim().toLowerCase();

// A move's own Tag rows, alphabetically (decided, new).
//
// `/api/tags` returns the world-level list in this order already, but a MOVE
// stores `tag_ids` in the order the GM happened to tick them, so the chips on a
// card came out in pick order — the same "creation order" complaint one layer
// down. Every place that resolves tag_ids into rows goes through here, so the
// card, the Moves tab and the chat reveal all read the same way.
export function sortTags(tags) {
  return [...(tags ?? [])].sort((a, b) =>
    normTag(a?.name).localeCompare(normTag(b?.name))
  );
}

// Mirrors hasTagNamed in server/tagAutomations.js, which is the authority.
// Matched on the name, case-insensitively, never on the id — see that file
// for why (ids differ between databases; the GM owns the tag list).
function isTagNamed(tagId, tags, wanted) {
  const tag = (tags ?? []).find((t) => t.id === tagId);
  return tag ? normTag(tag.name) === normTag(wanted) : false;
}

export function isBlockTagId(tagId, tags) {
  return isTagNamed(tagId, tags, BLOCK_TAG_NAME);
}

// `tagIds` may be a move's stored tag_ids or the Move Creator's live
// selection — both are plain id arrays, so this covers the saved card and
// the half-authored form alike.
export function carriesBlockTag(tagIds, tags) {
  return (tagIds ?? []).some((id) => isBlockTagId(id, tags));
}

export function carriesNoDamageTag(tagIds, tags) {
  return (tagIds ?? []).some((id) => isTagNamed(id, tags, NO_DAMAGE_TAG_NAME));
}

// The third Tag automation: a Feint's own Tell is public, but whatever is
// declared immediately after it goes on the timeline hidden. The server owns
// the rule (see feint_masked in server/index.js's move:declare); the client
// reads the same Tag only to *say so* up front — greying nothing out, just
// telling the declaring player what their next move is about to become.
// The Movement Tag, read client-side for one reason: a move that needs legs
// cannot be declared on a broken one (see movementBlockedByLegs server-side,
// which is the authority). The picker greys it and says why rather than letting
// the player drag something the server will silently refuse — the same
// treatment a Requirement or a Secondary already gets.
export function carriesMovementTag(tagIds, tags) {
  return (tagIds ?? []).some((id) => isTagNamed(id, tags, MOVEMENT_TAG_NAME));
}

export function carriesFeintTag(tagIds, tags) {
  return (tagIds ?? []).some((id) => isTagNamed(id, tags, FEINT_TAG_NAME));
}

// "×1.5" / "×0.5" — the multiplier as the table reads it. 1 is still shown
// rather than hidden: "this Block charges exactly what it absorbed" is a real
// statement about the move, not an absent value.
export function staminaModifierLabel(modifier) {
  const n = Number(modifier);
  return `×${Number.isFinite(n) && n > 0 ? n : 1}`;
}

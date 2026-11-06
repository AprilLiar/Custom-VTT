// **The engine's event bus (full automation, phase A).** Pure routing: given a
// content event name (`abilities[].rules[].events`) and the fighter it is
// about (the subject), which fighters listen to it. The engine emits exact
// content names at each game point; this decides who hears each one.
//
//   self.* / own_* / end_phase.* / stance.* / warrior_path.*  → the subject only
//   ally.*            → the subject's allies (not the subject)
//   ally_in_range.*   → allies with the subject in their range
//   enemy.*           → the subject's enemies
//   enemy_in_range.*  → enemies with the subject in their range
//   visible_enemy.*   → enemies who can see the subject
//   shield_in_range.* → anyone with the subject in their range
//   any_* / any_action.* / reactive_action.* → everyone
//
// `world` supplies enemiesOf / alliesOf / inRange (interpreter.js world).

const STANCE_RANGE = { mode: 'stance', origin: 'self' };
const VISIBLE = { mode: 'visible', origin: 'self' };

export function listenersFor(eventName, subject, world) {
  const name = String(eventName);
  const all = world.fighters();
  if (!subject) return name.startsWith('any_') ? all : [];
  const allies = () => world.alliesOf(subject).filter((f) => f.id !== subject.id);
  const enemies = () => world.enemiesOf(subject);
  if (name.startsWith('ally_in_range.')) return allies().filter((f) => world.inRange(f, subject, STANCE_RANGE));
  if (name.startsWith('ally.')) return allies();
  if (name.startsWith('enemy_in_range.')) return enemies().filter((f) => world.inRange(f, subject, STANCE_RANGE));
  if (name.startsWith('enemy.') || name.startsWith('enemy_turn.')) return enemies();
  if (name.startsWith('visible_enemy.')) return enemies().filter((f) => world.inRange(f, subject, VISIBLE));
  if (name.startsWith('shield_in_range.')) return all.filter((f) => f.id !== subject.id && world.inRange(f, subject, STANCE_RANGE));
  if (name.startsWith('any_') || name.startsWith('reactive_action.')) return all;
  return [subject];
}

// The turn-boundary events each fighter hears, by relation to the active one
// ("allied_turn" includes the owner's own turn).
export function turnEvents(moment, relation) {
  const end = moment === 'end';
  if (relation === 'self') return end ? ['own_turn.end_abilities', 'allied_turn.end_abilities', 'any_turn.end_abilities'] : ['own_turn.start', 'allied_turn.start', 'any_turn.start'];
  if (relation === 'ally') return end ? ['allied_turn.end_abilities', 'any_turn.end_abilities'] : ['allied_turn.start', 'any_turn.start'];
  return end ? ['any_turn.end_abilities'] : ['enemy_turn.start', 'enemy.turn.start', 'any_turn.start'];
}

export const relationTo = (f, active) => (f.id === active.id ? 'self' : f.side === active.side ? 'ally' : 'enemy');

// **Fight Setup: Complications and Battle Parameters (book pp.41-50).**
// The catalog every view shares — names, the book's rule in short, the icon
// key and where each applies — plus the stored shape and its normalizer.
// Stored per Scene and fight mode (`scenes.battle` JSON: { simple, combat }),
// set by the GM in Fight Setup at any time (`battle:set`), read by the engine.

export const FAMILIES = [
  { key: 'complication', label: 'Complications' },
  { key: 'tilt', label: 'Tilted' },
  { key: 'arena', label: 'Arena' },
  { key: 'victory', label: 'Victory' },
];

export const SIDES = ['allies', 'enemies', 'renegades'];
export const SIDE_LABEL = { allies: 'Allies', enemies: 'Enemies', renegades: 'Renegades' };

// `lane`: works on a Simple Combat lane too. `built`: the engine runs it.
export const PARAMS = [
  // Complications
  { key: 'guest_heroes', family: 'complication', name: 'Guest Heroes', icon: 'UserPlus', lane: true, built: true,
    text: 'An NPC Warrior or Boss with one Health Bar joins the heroes. Any hero player controls it; it adds a Hero slot and an Enemy slot to the Initiative.' },
  { key: 'uneven_fights', family: 'complication', name: 'Uneven Fights', icon: 'Scale3d', lane: true, built: true,
    text: 'More Health Bars than heroes. Heroes split the extra evenly (extra HP on every bar, rounded up) or unevenly (whole bars to chosen heroes). Bosses take up to 6 bars. A 1v1 is 2 bars each.' },
  { key: 'switched_sides', family: 'complication', name: 'Switched Sides', icon: 'ArrowLeftRight', lane: true, built: true,
    text: 'A hero joins the enemies (acting on Enemy slots) or an enemy joins the heroes (as a Guest). Put them in that column at Start Combat; an enemy joining the heroes is made a Guest.' },
  { key: 'three_way', family: 'complication', name: 'Three Way Battle', icon: 'Triangle', lane: true, built: true,
    text: 'A third side, the Renegades, fights everyone. Initiative goes Heroes → Enemies → Renegades.' },
  // Tilted Parameters — one per side
  { key: 'chained_down', family: 'tilt', name: 'Chained Down', icon: 'Link', lane: true, built: true,
    text: "Each unit on this side places its own named Wall next to it and can't move more than 3 spaces from it; 5 from its Rubble once the Wall is destroyed; free once the Rubble is destroyed. Immune to Open The Path." },
  { key: 'disarmed', family: 'tilt', name: 'Disarmed', icon: 'Ban', lane: true, built: true,
    text: 'Every unit on this side has Range 1, whatever the Stance, and Abilities do not increase it. (As an Arena Parameter: everyone.)' },
  { key: 'enraged', family: 'tilt', name: 'Enraged', icon: 'Flame', lane: true, built: true,
    text: "Whenever someone on this side is dealt damage by an enemy, they take that enemy's Challenge token, discarding any they held. This triggers no Abilities." },
  { key: 'handcuffs', family: 'tilt', name: 'Handcuffs', icon: 'Lock', lane: true, built: true,
    text: 'Every non-Stooge unit on this side is cuffed to one other unit. Apart, the one who stayed is pulled 1 space at a time until adjacent. Removed from play: both are. At 0 HP: the partner gains 3 Fatigue.' },
  { key: 'keep_em_coming', family: 'tilt', name: "Keep 'Em Coming", icon: 'Repeat', lane: true, built: true,
    text: 'No rest since the last fight: half HP on the current Health Bar, and half the Burning, Fatigue and Weakness held, rounded up. Applied once, to what they hold when it takes effect.' },
  { key: 'overwhelming_power', family: 'tilt', name: 'Overwhelming Power', icon: 'Zap', lane: true, built: true,
    text: "This side is outmatched: at the start of every turn that isn't this side's, the active unit gains 1 Power, 1 Iron and 1 Speed." },
  { key: 'too_slow', family: 'tilt', name: 'Too Slow', icon: 'Turtle', lane: true, built: true,
    text: 'At the start of each of this side’s turns, the active character discards their lowest die before rolling their Action Dice.' },
  { key: 'weakened_state', family: 'tilt', name: 'Weakened State', icon: 'Wine', lane: true, built: true,
    text: 'At the start of each of this side’s turns, the active character gains 1 Burning, 1 Weakness and 1 Fatigue.' },
  // Arena Parameters
  { key: 'cage_match', family: 'arena', name: 'Cage Match', icon: 'Grid2x2', lane: true, built: true, outside: true,
    text: 'No Outside: the edge of the arena holds everyone. (Half-size arena; units start on the edge.)' },
  { key: 'endless_field', family: 'arena', name: 'Endless Field', icon: 'Infinity', lane: false, built: true, outside: true,
    text: 'No Outside: the grid goes on past the map in every direction.' },
  { key: 'factory', family: 'arena', name: 'Factory', icon: 'Factory', lane: false, built: true,
    text: 'Conveyor Belts: at the end of every turn, everything on a belt is pushed 1 space along it. Spend 1 Iron or 1 Speed to stay put.' },
  { key: 'icy_floor', family: 'arena', name: 'Icy Floor', icon: 'Snowflake', lane: true, built: true,
    text: 'After every movement, slide 1 more space the same way (not after teleports or swaps, or into Walls and Rubble; a unit in the way is pushed 1). Here a Free Movement slides once, at its end.' },
  { key: 'pyroclasm', family: 'arena', name: 'Pyroclasm', icon: 'FlameKindling', lane: true, built: true, outside: true,
    text: 'The Outside is endless Traps. Pits become Pit Traps; all Rubble becomes Pit Traps at each round end; removed Traps and Pits leave Rubble.' },
  { key: 'traffic', family: 'arena', name: 'Traffic', icon: 'Car', lane: true, built: true,
    text: 'The Danger Zone: anyone in it at the end of each Round takes 6 damage (Armor and Iron reduce it).' },
  { key: 'trick_room', family: 'arena', name: 'Trick Room', icon: 'Repeat2', lane: true, built: true, outside: true,
    text: 'No Outside: moving off one edge brings you in at the opposite edge, same row or column.' },
  { key: 'disarmed_all', family: 'arena', name: 'Disarmed (everyone)', icon: 'Ban', lane: true, built: true,
    text: 'Disarmed as an Arena Parameter: every unit has Range 1, whatever the Stance; Abilities do not increase it.' },
  // Victory Parameters — one per fight
  { key: 'last_one_standing', family: 'victory', name: 'Last One Standing', icon: 'Trophy', lane: true, built: true,
    text: 'The default: the fight ends when only one side remains in play. No Fight Must Go On.' },
  { key: 'king_of_the_hill', family: 'victory', name: 'King of the Hill', icon: 'Crown', lane: true, built: true,
    text: 'A 4×4 King Zone. At each round end, if everyone standing in it is from one side, that side wins.' },
  { key: 'outlast', family: 'victory', name: 'Outlast', icon: 'Hourglass', lane: true, built: true,
    text: 'Survivors vs Attackers (who go first). Attackers return and heal fully each round end. Survivors standing after round 3 win. No Fight Must Go On.' },
  { key: 'protect_the_vip', family: 'victory', name: 'Protect the VIP', icon: 'ShieldUser', lane: true, built: true,
    text: 'Each side has a VIP with +10 max HP on their first bar. A side whose VIP falls loses. Anyone may give their turn to the VIP.' },
  { key: 'sabotage', family: 'victory', name: 'Sabotage', icon: 'Bomb', lane: false, built: false,
    text: 'Saboteurs (who go first) plant Bombs (HP = Bleed Value) on Key Locations; each scores 1 at round end. 3 points wins; otherwise the Defense wins after round 3.' },
  { key: 'secure_the_mcguffin', family: 'victory', name: 'Secure the McGuffin', icon: 'Gem', lane: false, built: false,
    text: 'Grab It! the Important Thing and bring it into your Control Zone to win. Moved by anyone else, you drop it.' },
  { key: 'tournament', family: 'victory', name: 'Tournament Play', icon: 'Medal', lane: true, built: true,
    text: 'Best of 3 or 5. A side loses a round when one of them goes Outside or two reach 0 HP; positions, HP and tokens reset. A drawn round just continues.' },
];

export const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));
export const paramsOf = (family) => PARAMS.filter((p) => p.family === family);

// The Fight Must Go On! — every Victory Parameter but these two.
export const NO_GO_ON = new Set(['last_one_standing', 'outlast']);

// The stored shape for one fight mode, normalized.
//   tilts:   { allies, enemies, renegades } → a tilt key or null
//   arena:   [arena keys]
//   victory: a victory key (default Last One Standing)
//   complications: [complication keys]
//   cuffs:   [[combatantId, combatantId]]   (Handcuffs pairs, set by the GM)
//   guests:  [characterId]  (Guest Heroes: any hero player controls them; one Health Bar)
//   chains:  { [combatantId]: { col, row } } (Chained Down Walls)
//   applied: { keep_em_coming: { [side]: fightId }, vip: { fightId, ids } } (once per fight)
//   victoryOpts: { survivors (Outlast), vips: { [side]: combatantId } (Protect the VIP),
//                  bestOf: 3|5 (Tournament), saboteurs (Sabotage) }
export function normalizeBattle(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const tilts = {};
  for (const s of SIDES) tilts[s] = PARAM_BY_KEY[v.tilts?.[s]]?.family === 'tilt' ? v.tilts[s] : null;
  const arena = [...new Set((Array.isArray(v.arena) ? v.arena : []).filter((k) => PARAM_BY_KEY[k]?.family === 'arena'))];
  const victory = PARAM_BY_KEY[v.victory]?.family === 'victory' ? v.victory : 'last_one_standing';
  const complications = [...new Set((Array.isArray(v.complications) ? v.complications : []).filter((k) => PARAM_BY_KEY[k]?.family === 'complication'))];
  const cuffs = (Array.isArray(v.cuffs) ? v.cuffs : [])
    .map((p) => (Array.isArray(p) ? p.map(Number) : []))
    .filter((p) => p.length === 2 && p.every(Number.isInteger) && p[0] !== p[1]);
  const chains = {};
  for (const [id, sq] of Object.entries(v.chains && typeof v.chains === 'object' ? v.chains : {})) {
    if (Number.isInteger(sq?.col) && Number.isInteger(sq?.row)) chains[id] = { col: sq.col, row: sq.row };
  }
  const applied = v.applied && typeof v.applied === 'object' ? v.applied : {};
  const o = v.victoryOpts && typeof v.victoryOpts === 'object' ? v.victoryOpts : {};
  const vips = {};
  for (const s of SIDES) if (Number.isInteger(o.vips?.[s])) vips[s] = o.vips[s];
  const victoryOpts = {
    survivors: SIDES.includes(o.survivors) ? o.survivors : null,
    saboteurs: SIDES.includes(o.saboteurs) ? o.saboteurs : null,
    vips,
    bestOf: o.bestOf === 5 ? 5 : 3,
  };
  const guests = [...new Set((Array.isArray(v.guests) ? v.guests : []).map(Number).filter(Number.isInteger))];
  return { tilts, arena, victory, complications, cuffs, chains, applied, victoryOpts, guests };
}

export function parseBattleColumn(json) {
  let all = {};
  try {
    all = JSON.parse(json || '{}') ?? {};
  } catch {
    all = {};
  }
  return { simple: normalizeBattle(all.simple), combat: normalizeBattle(all.combat) };
}

// Only one Arena Parameter that replaces the Outside at a time (book p.45).
export function toggleArena(list, key) {
  if (list.includes(key)) return list.filter((k) => k !== key);
  const p = PARAM_BY_KEY[key];
  const kept = p?.outside ? list.filter((k) => !PARAM_BY_KEY[k]?.outside) : list;
  return [...kept, key];
}

// The tilt on a side, and whether a fighter there is Disarmed.
export const tiltOn = (battle, side) => battle?.tilts?.[side] ?? null;
export const isDisarmed = (battle, side) => tiltOn(battle, side) === 'disarmed' || Boolean(battle?.arena?.includes('disarmed_all'));
export const partnerOf = (battle, id) => {
  const pair = (battle?.cuffs ?? []).find((p) => p.includes(id));
  return pair ? pair.find((x) => x !== id) : null;
};
// Chained Down: how far from their Wall (3) or its Rubble (5) they may be; null = free.
export const leashOf = (battle, id, tileKindsAt) => {
  const at = battle?.chains?.[id];
  if (!at) return null;
  const kinds = tileKindsAt(at);
  if (kinds.includes('wall')) return { at, max: 3 };
  if (kinds.includes('rubble')) return { at, max: 5 };
  return null;
};
// Keep 'Em Coming on what a fighter holds: half the HP on the current bar, and
// half their Burning, Fatigue and Weakness, rounded up.
export function keepEmComing(hp, tokens) {
  const t = { ...tokens };
  for (const k of ['burning', 'fatigue', 'weakness']) if (t[k]) t[k] = Math.ceil(t[k] / 2);
  const current = hp?.current != null ? Math.ceil(hp.current / 2) : hp?.current;
  return { hp: { ...hp, current }, tokens: t };
}

// Guest Heroes in force for a fight mode's settings (character ids).
export const guestsOf = (battle) => (battle?.complications?.includes('guest_heroes') ? battle.guests ?? [] : []);

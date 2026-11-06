// **Passive rule modifiers (full automation, phase A).** `modify_rule` (and
// lasting `grant_armor`) in an Ability's `continuous` rules are in effect while
// their source is: constant Abilities always, a Form's or Style's while its
// Stance is active (the fighter's abilityIds already say which). Their target
// is the owner (`{ ref: 'self' }`) or a selector — an aura over allies or
// enemies in range. Temporary ones (`temporary` effects) live in the fight
// runtime until they expire.
//
// modifiersOn(fighter, world, idx, temps) → [{ rule, value, source, ownerId, node }]

const nodesOf = (effect) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.op === 'modify_rule' || (n.op === 'grant_armor' && !n.temporary)) out.push(n);
    if (n.op === 'sequence') return n.steps.forEach(walk);
  };
  walk(effect);
  return out;
};

// Does a modifier's target take in `fighter`, given its owner?
export function targetsFighter(target, owner, fighter, world) {
  if (!target || target.ref === 'self') return owner.id === fighter.id;
  if (typeof target.kind !== 'string') return false;
  const sameSide = owner.side === fighter.side;
  const kindOk =
    target.kind === 'enemy' ? !sameSide : target.kind === 'ally' ? sameSide && (owner.id !== fighter.id || !target.excludeSelf) : target.kind === 'self_and_allies' ? sameSide : target.kind === 'unit';
  if (!kindOk) return false;
  if (owner.id === fighter.id) return true;
  return world ? world.inRange(owner, fighter, target.range ?? { mode: 'stance', origin: 'self' }) : true;
}

// Every modifier now in effect on `fighter`.
export function modifiersOn(fighter, world, idx, temps = []) {
  const out = [];
  for (const owner of world.fighters()) {
    for (const abilityId of owner.abilityIds ?? []) {
      const ability = idx.get(abilityId);
      for (const rule of ability?.rules ?? []) {
        if (!rule.events.includes('continuous')) continue;
        for (const node of nodesOf(rule.effect)) {
          if (!targetsFighter(node.target, owner, fighter, world)) continue;
          out.push({ rule: node.op === 'grant_armor' ? 'armor.source' : node.rule, value: node.op === 'grant_armor' ? node : node.value, source: ability.id, ownerId: owner.id, node });
        }
      }
    }
  }
  for (const t of temps) if (t.targetId === fighter.id && t.rule) out.push({ rule: t.rule, value: t.value, source: t.source, ownerId: t.ownerId, node: t.node ?? null, temporary: true });
  return out;
}

// Queries over a modifier list.
export const modsFor = (mods, rule) => mods.filter((m) => m.rule === rule);
export const hasMod = (mods, rule, pred = () => true) => mods.some((m) => m.rule === rule && pred(m.value));
export const sumMod = (mods, rule) => modsFor(mods, rule).reduce((n, m) => n + (Number(m.value) || 0), 0);
// The last-installed value (temporaries after continuous), or `fallback`.
export const valueOf = (mods, rule, fallback = null) => {
  const list = modsFor(mods, rule);
  return list.length ? list[list.length - 1].value : fallback;
};
// A list-valued modifier (unblockable: ['shields', 'armor'], damage.immunity: ['fall']).
export const listMod = (mods, rule) => [...new Set(modsFor(mods, rule).flatMap((m) => (Array.isArray(m.value) ? m.value : [m.value])))];

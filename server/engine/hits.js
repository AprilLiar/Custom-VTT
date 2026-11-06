// **One hit, applied (full automation, phase C).** The fight's `world.damage`
// (server/triggers.js) lands here: it gathers both fighters' tokens and
// modifiers, runs Damage Resolution (client/src/lib/patd/engine/damage.js),
// asks Power / Iron / Shield of whoever controls each side per their Ask /
// Auto / Never settings (the dice board's Power toggle stands in for the
// attacker's own committed Actions), applies what was spent and lost, and
// emits the damage events through the bus.
import { chebyshev } from '../../client/src/lib/patd/interpreter.js';
import { autoIron, isAttack, resolveDamage, unblockableSet } from '../../client/src/lib/patd/engine/damage.js';
import { hasMod, listMod, modifiersOn, valueOf } from '../../client/src/lib/patd/engine/modifiers.js';
import { expireTemps, fighterRt } from '../../client/src/lib/patd/engine/runtime.js';
import { patdContent } from '../patdContent.js';

const SOURCE_NAME = { trap: 'a Trap', fall: 'a fall', burning: 'Burning' };

// kit: { ask, emitEvent }
export function createHits({ ask, emitEvent }) {
  // A choice of 0..max tokens, or a yes/no, for one fighter's controller.
  const askNumber = async (env, fighter, title, text, max, unit) => {
    const options = [{ id: '0', label: 'None' }];
    for (let i = 1; i <= max; i++) options.push({ id: String(i), label: `${i} ${unit}` });
    const ans = await ask(fighter, env.key, env.gen, env.tg, env.when)({ kind: 'choose', title, text, options, minimum: 1, maximum: 1 });
    return Number(Array.isArray(ans) ? ans[0] : ans) || 0;
  };
  const askYes = async (env, fighter, title, text) => Boolean(await ask(fighter, env.key, env.gen, env.tg, env.when)({ kind: 'confirm', title, text }));

  // `internals` (from the world): { writeTokens, changeHp, bleedCheck, inPit }
  async function resolveHit(env, internals, target, amount, attacker = null, opts = {}) {
    const { world, rt } = env;
    const idx = patdContent();
    const source = typeof opts.source === 'string' ? { kind: opts.source } : (opts.source ?? { kind: 'other' });
    const attack = isAttack(source.kind) && attacker != null;
    const scoped = opts.mods ?? [];
    const modsOf = (f) => [...modifiersOn(f, world, idx, rt.temps), ...scoped.filter((m) => m.targetId === f.id)];
    const atkMods = attacker ? modsOf(attacker) : [];
    const tgtMods = modsOf(target);
    const enemy = Boolean(attacker && attacker.side !== target.side);
    const emit = opts.emit === undefined ? (ev, f, p) => emitEvent(env, ev, f, p) : opts.emit;
    const fire = async (ev, f, payload, filter) => (emit ? emit(ev, f, payload, filter) : null);

    // Unblockable: the attacker's lasting ones (Mad Style), this resolution's
    // (Shockwave), the next damaging Action's (Take Aim), the node's own
    // (Become My Canvas), and a Build Ability's (all — book p.26).
    const ub = unblockableSet(
      attack ? listMod(atkMods, 'unblockable') : [],
      attack && source.kind === 'action' ? listMod(atkMods, 'next_damage_action.unblockable') : [],
      opts.unblockable ?? [],
      opts.ignore ?? []
    );
    const abilitiesOff = ub.has('abilities');

    // Armor: hand-added Armor tokens, the build's sources, others' Armor auras,
    // "Armor against Burning" (Inferno) for Burning, temporary Armor last.
    const own = (m) => m.rule === 'armor.source' && m.ownerId === target.id;
    const auras = tgtMods.filter((m) => m.rule === 'armor.source' && m.ownerId !== target.id && !m.node?.onlyDamageSource).length;
    const sourceOnly = tgtMods.filter((m) => own(m) && m.node?.onlyDamageSource && m.node.onlyDamageSource === (source.kind === 'burning' ? 'burning_tokens' : source.kind)).length;
    const frt = fighterRt(rt, target.id);
    const armor = {
      sources: (target.tokens.armor ?? 0) + (target.innateArmor ?? 0) + auras + sourceOnly,
      temp: (target.tokens.temp_armor ?? 0) > 0,
      triggered: frt.flags.armorTriggers ?? 0,
      firstReduction: Number(valueOf(tgtMods, 'armor.first_trigger_reduction', 3)) || 3,
      perTurn: Number(valueOf(tgtMods, 'armor.triggers_per_turn', 1)) || 1,
      keepOnOne: hasMod(tgtMods, 'armor.not_spent_when_one_damage_hit_fully_blocked'),
      disabled: hasMod(tgtMods, 'armor.disabled'),
    };
    const from = attacker ? ` from ${attacker.name}` : SOURCE_NAME[source.kind] ? ` from ${SOURCE_NAME[source.kind]}` : '';
    const prefs = (f) => f?.prefs ?? { power: 'auto', iron: 'auto', shield: 'auto' };

    const decide = {
      split: opts.noSplit || abilitiesOff
        ? null
        : async (n) => {
            const payload = { damage: n, target, attacker, split: null };
            await fire('ally_in_range.would_take_damage', target, payload);
            return payload.split;
          },
      power: async ({ max, amount: n }) => {
        if (opts.power === 'max') return max;
        if (opts.power === 'none') return 0;
        const mode = prefs(attacker).power;
        if (mode === 'never') return 0;
        if (mode === 'auto') return max;
        return askNumber(env, attacker, 'Enhance the hit', `${attacker.name} hits ${target.name} for ${n}. Spend Power: +1 damage and Push 1 each.`, max, 'Power');
      },
      iron: async ({ max, amount: n, armorBlocks }) => {
        const mode = prefs(target).iron;
        if (mode === 'never') return 0;
        if (mode === 'auto') return autoIron({ max, amount: n, armorBlocks });
        return askNumber(
          env,
          target,
          'Reduce the hit',
          `${target.name} takes ${n} damage${from}${armorBlocks ? ` (Armor would block ${armorBlocks})` : ''}. Spend Iron: −1 damage and −1 push/pull each.`,
          max,
          'Iron'
        );
      },
      // Iron Form / Mountainous Freestyle: "spend 1 Iron to take 1 less from any
      // source" — their rules ignore Unblockable (`ignoresUnblockable`).
      wouldTake: async (n) => {
        const payload = { damage: n, target, attacker, reduction: 0 };
        await fire('self.would_take_damage', target, payload);
        return payload.reduction;
      },
      shield: async ({ value, amount: n, armorBlocks }) => {
        const mode = prefs(target).shield;
        if (mode === 'never') return false;
        if (mode === 'auto') return true;
        return askYes(env, target, 'Shield', `${target.name} takes ${n} damage${from}${armorBlocks ? ` (Armor would block ${armorBlocks})` : ''}. Block it with your Shield (${value})?`);
      },
    };

    const r = await resolveDamage(
      {
        amount,
        source,
        attacker: attacker ? { tokens: attacker.tokens, mods: atkMods, enemy } : null,
        target: { tokens: target.tokens, mods: tgtMods, dizzy: Boolean(target.dizzy), inPit: internals.inPit(target) },
        distance: attacker?.square && target.square ? chebyshev(attacker.square, target.square) : null,
        unblockable: ub,
        allowIron: Boolean(opts.allowIron),
        armor,
        shieldDisabled: hasMod(tgtMods, 'shield.disabled'),
        exploitWeakness: attack && hasMod(atkMods, 'spend_target_weakness_as_own_power'),
      },
      decide
    );

    // ---- apply what was spent
    if (attacker && (r.spend.weakness || r.spend.power)) {
      await internals.writeTokens(attacker, (t) => {
        t.weakness = (t.weakness ?? 0) - r.spend.weakness;
        t.power = (t.power ?? 0) - r.spend.power;
      });
    }
    const usedTemp = r.armor?.triggered && r.armor.usedTemp && r.armor.spent;
    if (r.spend.targetWeakness || r.spend.iron || r.spend.shield || usedTemp) {
      await internals.writeTokens(target, (t) => {
        t.weakness = (t.weakness ?? 0) - r.spend.targetWeakness;
        t.iron = (t.iron ?? 0) - r.spend.iron;
        t.shield = (t.shield ?? 0) - r.spend.shield;
        if (usedTemp) t.temp_armor = 0;
      });
    }
    if (r.armor?.triggered && r.armor.spent && !r.armor.usedTemp) frt.flags.armorTriggers = (frt.flags.armorTriggers ?? 0) + 1;
    // The Challenge: an attempt on your Challenger counts (End Phase removal).
    if (attacker && attacker.challengeId === target.id) fighterRt(rt, attacker.id).flags.damagedChallenger = true;

    // ---- HP
    let bled = false;
    let fell = false;
    if (r.amount > 0) {
      const { before, landed, row } = await internals.changeHp(target, -r.amount);
      if (before) {
        bled = await internals.bleedCheck(target, before, landed, row);
        fell = before.current > 0 && landed <= 0;
      }
    }

    // ---- events (the attacker's own always; the target's unless the hit
    // ignores their Abilities)
    const T = abilitiesOff ? async () => null : fire;
    if (attacker && r.power > 0) {
      await fire('self.power_tokens_spent', attacker, { amount: r.spend.power, target });
      await fire('self.hit_enhanced_with_power', attacker, { target, amount: r.power });
    }
    if (r.iron > 0) {
      await T('self.iron_tokens_spent', target, { amount: r.iron, attacker });
      await T('self.hit_reduced', target, { attacker });
      if (enemy) await T('self.hit_reduced_from_enemy', target, { attacker });
      await T('self.damage_reduced_by_iron', target, { attacker, amount: r.iron });
    }
    if (r.absorbed > 0) {
      const payload = { attacker, amount: r.absorbed, shieldBroke: r.broke, target, enemy: attacker };
      await T('self.shield_absorbed', target, payload);
      if (enemy && source.kind === 'action') await T('self.shield_absorbed_from_enemy_action', target, payload);
      if (enemy) {
        const how = r.broke ? 'broken' : 'damaged';
        await fire(`enemy_in_range.own_shield_${how}`, attacker, payload, (l) => l.id === target.id);
        await fire(`enemy_in_range.${r.broke ? 'broke' : 'damaged'}_allied_shield`, attacker, payload, (l) => l.id !== target.id && l.side === target.side);
      }
      if (r.broke) await fire('shield_in_range.broken', target, payload);
    }
    if (r.armor?.triggered) {
      await T('self.armor_triggered', target, { attacker, amount: r.armor.blocked });
      if (r.armor.blocked > 0) await T('self.damage_reduced_by_armor', target, { attacker, amount: r.armor.blocked });
    }
    if (r.amount > 0) {
      await T('self.damage_taken', target, { attacker, amount: r.amount });
      if (source.kind === 'action' && attacker) await T('self.took_damage_from_action', target, { attacker, amount: r.amount, enemyDamageDealers: enemy ? [attacker] : [] });
      if (source.kind === 'action' && enemy) await T('self.took_damage_from_enemy_action', target, { attacker, amount: r.amount });
      if (source.kind === 'burning') await T('self.burning_token_damage_taken', target, { amount: r.amount });
      if (source.kind === 'trap') await fire('enemy_in_range.trap_damage_taken', target, { target, amount: r.amount });
      if (attacker) {
        await fire('self.damage_dealt', attacker, { target, amount: r.amount });
        if (enemy) await fire('self.damage_dealt_to_enemy', attacker, { target, amount: r.amount });
        if (attack) await fire('self.action_or_ability.damage_dealt', attacker, { target, amount: r.amount });
      }
      if (bled) await T('self.bleed', target, {});
      if (fell) await T('self.fell_to_zero_hp', target, { attacker });
    }
    // Heroic Style: the other half lands on the redirector (no further split).
    for (const g of r.split?.give ?? []) {
      if (g.to && g.amount > 0) await resolveHit(env, internals, g.to, g.amount, attacker, { ...opts, noSplit: true });
    }
    expireTemps(rt, 'hit');
    return {
      taken: r.amount,
      dealt: r.amount,
      toHp: r.amount,
      steps: r.steps,
      bled,
      fell,
      absorbed: r.absorbed,
      broke: r.broke,
      immune: r.immune,
      dizzy: r.dizzy,
      pushBonus: r.pushBonus,
      pushResist: r.pushResist,
    };
  }

  return { resolveHit };
}

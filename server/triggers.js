// **Turn triggers (builder phase 3 — vttprojectplan.md, "Character builder &
// turn automation").** At the start and end of every turn, each fighter's
// abilities listening to that moment (their own turn, an ally's, an enemy's,
// any turn) run through the interpreter (client/src/lib/patd/interpreter.js)
// against this world: the fight's fighters, their squares on the map or lane,
// the map tiles (Walls, Fog) and the database.
//
// Choices and targets are asked of whoever controls the fighter (and the GM)
// with `trigger:prompt`; the answer comes back as `trigger:answer`. Because a
// prompt waits for a person, triggers never run inside the server-wide write
// queue — each write is queued on its own — and each fight's triggers run one
// after another on their own chain.
import { all, one, run } from './db.js';
import { applyHpDelta } from '../client/src/lib/hpBars.js';
import { WEIGHT_BY_KEY, crossesBleed } from '../client/src/lib/cinematicWeight.js';
import { TOKEN_BY_KEY, absorbWithShield, capOf, innateArmor } from '../client/src/lib/panicTokens.js';
import { packLane, clampLanes } from '../client/src/lib/simpleLane.js';
import { chebyshev, ruleSupport, runRule, targetable } from '../client/src/lib/patd/interpreter.js';
import { controlsCharacter } from './control.js';
import { hpOf, saveHp, serialized, shapeFightState } from './combatState.js';
import { assembles, derivedFor, franticPickOf } from './fighterStances.js';
import { armorSourcesOf, stanceOfBuild } from '../client/src/lib/patd/build.js';
import { patdContent } from './patdContent.js';

const MIDDLEWEIGHT = WEIGHT_BY_KEY.middle;
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const FOLLOW_ON_DEPTH = 3;
const IMPROVED_WARRIOR = 'ability.feature-improved-warrior.improved-warrior';

// Which events a fighter listens to at a moment, by their relation to the
// active fighter. ("allied_turn" includes the owner's own turn.)
function eventsFor(moment, relation) {
  const end = moment === 'end';
  if (relation === 'self') return end ? ['own_turn.end_abilities', 'allied_turn.end_abilities', 'any_turn.end_abilities'] : ['own_turn.start', 'allied_turn.start', 'any_turn.start'];
  if (relation === 'ally') return end ? ['allied_turn.end_abilities', 'any_turn.end_abilities'] : ['allied_turn.start', 'any_turn.start'];
  return end ? ['any_turn.end_abilities'] : ['enemy_turn.start', 'enemy.turn.start', 'any_turn.start'];
}

export function createTriggerEngine({ io, postCard, emitStageUpdated }) {
  const pending = new Map(); // prompt id → { resolve, characterId, request }
  const chains = new Map(); // "sceneId:mode" → Promise
  const fightState = new Map(); // "sceneId:mode" → { states: Map(combatantId → {}), usage: {} }
  let nextId = 1;
  const queued = (fn) => serialized(fn)();

  const sendPrompt = (prompt) => {
    for (const s of io.sockets.sockets.values()) {
      const v = s.data?.identity;
      if (v?.role === 'gm' || controlsCharacter(v, prompt.characterId)) s.emit('trigger:prompt', prompt);
    }
  };
  const ask = (fighter, fightKey) => (request) =>
    new Promise((resolve) => {
      const id = `t${nextId++}`;
      const prompt = {
        id,
        characterId: fighter.characterId,
        combatantId: fighter.id,
        fighterName: fighter.name,
        kind: request.kind,
        title: request.title,
        text: request.text,
        options: request.options ?? null,
        minimum: request.minimum ?? 0,
        maximum: request.maximum ?? 1,
      };
      const timer = setTimeout(() => finish(id, null), PROMPT_TIMEOUT_MS);
      pending.set(id, { resolve, prompt, timer, fightKey });
      sendPrompt(prompt);
    });
  const finish = (id, answer) => {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    io.emit('trigger:resolved', { id });
    p.resolve(answer);
  };

  // ---- the world of one fight
  async function buildWorld(fight) {
    const { scene_id: sceneId, mode } = fight;
    const ids = new Set([...JSON.parse(fight.allies || '[]'), ...JSON.parse(fight.enemies || '[]')]);
    const sideOf = (id) => (JSON.parse(fight.allies || '[]').includes(id) ? 'allies' : 'enemies');
    const rows = (await all('SELECT cb.*, c.name FROM combatants cb JOIN characters c ON c.id = cb.character_id WHERE cb.scene_id = ? AND cb.mode = ?', [sceneId, mode])).filter((r) => ids.has(r.id));
    const scene = await one('SELECT simple_weight, combat_weight FROM scenes WHERE id = ?', [sceneId]);
    const weight = WEIGHT_BY_KEY[mode === 'simple' ? scene?.simple_weight : scene?.combat_weight] ?? MIDDLEWEIGHT;
    // Squares: a map cell, or a lane space as (column, lane).
    let squareOf = (r) => (r.grid_col != null ? { col: r.grid_col, row: r.grid_row } : null);
    const tiles = await all('SELECT col, row, kind FROM map_tiles WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    let tileSquare = (t) => ({ col: t.col, row: t.row });
    if (mode === 'simple') {
      const lanes = clampLanes((await one('SELECT simple_lanes FROM table_settings WHERE id = 1'))?.simple_lanes);
      const packed = packLane(await all('SELECT id, lane_slot FROM scene_summons WHERE scene_id = ? AND character_id IS NOT NULL ORDER BY id', [sceneId]), lanes);
      squareOf = (r) => {
        const slot = r.summon_id != null ? packed.get(r.summon_id) : null;
        return slot == null ? null : { col: slot % 10, row: Math.floor(slot / 10) };
      };
      tileSquare = (t) => ({ col: t.col % 10, row: Math.floor(t.col / 10) });
    }
    const traps = new Set(tiles.filter((t) => t.kind === 'trap').map((t) => { const q = tileSquare(t); return `${q.col},${q.row}`; }));
    const walls = new Set(tiles.filter((t) => t.kind === 'wall').map((t) => { const q = tileSquare(t); return `${q.col},${q.row}`; }));
    const fogSquares = tiles.filter((t) => t.kind === 'fog').map(tileSquare);
    const fogged = (sq) => fogSquares.some((f) => chebyshev(f, sq) <= 1);

    const fighters = [];
    const idx = patdContent();
    const stoogeSeen = new Set();
    for (const r of [...rows].sort((a, b) => a.id - b.id)) {
      const d = await derivedFor(r.character_id);
      const state = shapeFightState(r);
      const stance = stanceOfBuild(d, state.active_stance_id, idx) ?? d?.stances.find((s) => s.formId && s.styleId) ?? null;
      // A Frantic Hero's one Frantic Ability for this turn comes with their pick.
      const frantic = assembles(d) ? franticPickOf(r)?.abilityId : null;
      // Stooges are one unit: only the leading body's abilities run.
      const isStooges = d?.type.id === 'character-type.stooges';
      const follower = isStooges && stoogeSeen.has(r.character_id);
      if (isStooges) stoogeSeen.add(r.character_id);
      fighters.push({
        id: r.id,
        characterId: r.character_id,
        name: r.name,
        side: sideOf(r.id),
        tokens: { ...state.tokens },
        bleeding: state.hp.max != null && state.hp.current <= weight.bleed,
        currentBar: { damage: state.hp.max != null ? state.hp.max - state.hp.current : 0 },
        square: squareOf(r),
        stance,
        derived: d,
        abilityIds: d && !follower ? [...d.constantAbilityIds, ...(frantic ? [frantic] : []), ...(stance?.abilityIds ?? [])] : [],
        // Armor from the build (always, or while this Stance is active).
        innateArmor: d ? innateArmor(armorSourcesOf(d, idx), stance?.key ?? null) : 0,
      });
    }
    const byId = (id) => fighters.find((f) => f.id === id);

    const readRow = (id) => one('SELECT * FROM combatants WHERE id = ?', [id]);
    const writeTokens = async (f, change) => {
      await queued(async () => {
        const row = await readRow(f.id);
        if (!row) return;
        const tokens = shapeFightState(row).tokens;
        change(tokens);
        for (const k of Object.keys(tokens)) if (!(tokens[k] > 0)) delete tokens[k];
        await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(tokens), f.id]);
        f.tokens = { ...tokens };
      });
    };
    const changeHp = async (f, delta) => {
      let result = { landed: null, before: null };
      await queued(async () => {
        const row = await readRow(f.id);
        if (!row) return;
        const before = hpOf(row);
        if (before.max == null) return;
        const next = applyHpDelta(before, delta).state;
        await saveHp(f.id, next);
        result = { before, landed: before.current + delta, row };
        f.bleeding = next.current <= weight.bleed;
        f.currentBar = { damage: next.max - next.current };
      });
      return result;
    };

    const world = {
      context: { healValue: weight.heal, bleedValue: weight.bleed, round: fight.round },
      fighters: () => fighters,
      enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
      alliesOf: (f) => fighters.filter((x) => x.side === f.side),
      inRange: (from, to, range) =>
        targetable({ from: from.square, to: to.square, range, stanceRange: from.stance?.range, walls, fogged, enemy: from.side !== to.side }),
      heldTokens: (f) => ({ ...f.tokens }),
      gainTokens: (f, key, n) =>
        TOKEN_BY_KEY[key] && key !== 'challenge' ? writeTokens(f, (t) => (t[key] = Math.min(capOf(key), (t[key] ?? 0) + n))) : null,
      discardTokens: async (f, keys, n) => {
        let taken = 0;
        await writeTokens(f, (t) => {
          for (const k of keys) {
            const take = Math.min(n - taken, t[k] ?? 0);
            t[k] = (t[k] ?? 0) - take;
            taken += take;
          }
        });
        return taken;
      },
      // A new Shield replaces the old or raises it by 1 — whichever is more.
      gainShield: (f, v) => writeTokens(f, (t) => (t.shield = Math.min(capOf('shield'), Math.max(Number(v) || 0, (t.shield ?? 0) + 1)))),
      tempArmor: (f) => writeTokens(f, (t) => (t.armor = Math.min(capOf('armor'), (t.armor ?? 0) + 1))),
      heal: async (f, n) => {
        await changeHp(f, Math.max(0, Number(n) || 0));
        return n;
      },
      payHp: (f, n) => changeHp(f, -Math.max(0, Number(n) || 0)),
      // Damage: the Shield absorbs first (unless `bypassShield` — Traps), the
      // rest hits HP. → { dealt, bled, absorbed, broke }.
      damage: async (f, n, _attacker = null, { bypassShield = false } = {}) => {
        let amount = Math.max(0, Number(n) || 0);
        let absorbed = 0;
        let broke = false;
        if (!bypassShield && (f.tokens.shield ?? 0) > 0) {
          await writeTokens(f, (t) => {
            const r = absorbWithShield(t.shield ?? 0, amount);
            absorbed = r.absorbed;
            broke = r.broke;
            amount = r.rest;
            t.shield = r.shield;
          });
        }
        const { before, landed, row } = await changeHp(f, -amount);
        let bled = false;
        if (before && crossesBleed(before.current, landed, weight.bleed) && row.bled_round !== fight.round) {
          bled = true;
          await queued(() => run('UPDATE combatants SET bled_round = ? WHERE id = ?', [fight.round, f.id]));
          await postCard('reminder', {
            title: `Round ${fight.round}`,
            text: `${f.name} Bleeds (HP ${Math.max(0, landed)} ≤ ${weight.bleed}) — "When you Bleed" abilities trigger.`,
            fighters: [{ name: f.name }],
            automatic: 'bleed',
          });
        }
        return { dealt: n, bled, absorbed, broke };
      },
      challenge: (target, challenger) => queued(() => run('UPDATE combatants SET challenge_id = ? WHERE id = ?', [challenger.id, target.id])),
      addPoolNumber: () => null, // posted in the ability's card
    };
    const onTrap = (f) => f.square != null && traps.has(`${f.square.col},${f.square.row}`);
    return { world, fighters, byId, onTrap, weight };
  }

  // ---- running one fighter's rules for some events
  async function runFor(fighter, events, env, eventPayload = null, depth = 0) {
    const idx = patdContent();
    for (const abilityId of fighter.abilityIds) {
      const ability = idx.get(abilityId);
      for (const rule of ability?.rules ?? []) {
        if (!rule.events.some((e) => events.includes(e))) continue;
        const support = ruleSupport(rule);
        if (!support.ok) {
          await postCard('reminder', {
            title: `${ability.name} — by hand`,
            text: ability.rulesText,
            fighters: [{ name: fighter.name }],
            automatic: 'ability_manual',
          });
          continue;
        }
        const lines = [];
        const ctx = {
          world: env.world,
          self: fighter,
          state: env.stateOf(fighter.id),
          usage: env.usage,
          ability,
          event: eventPayload,
          log: (l) => lines.push(l),
          ask: ask(fighter, env.key),
          emit: depth < FOLLOW_ON_DEPTH ? (ev, f, payload) => runFor(f, [ev], env, payload, depth + 1) : null,
        };
        try {
          await runRule(rule, ctx);
        } catch (err) {
          lines.push(`stopped: ${err.message}`);
        }
        if (lines.length) {
          // Done for you: a notice (grey, fades fast — decided).
          await postCard('reminder', { title: ability.name, text: `${lines.join('; ')}.`, fighters: [{ name: fighter.name }], automatic: 'ability', notice: true });
          await emitStageUpdated();
        }
      }
    }
  }

  // Whether any of a fighter's abilities sets an End Phase rule
  // (`modify_rule end_phase.<rule>`), and to what: Shadow Form and Silent
  // Freestyle discard no Speed, Scrambling Style keeps at least 2.
  const endPhaseRule = (f, rule) => {
    const idx = patdContent();
    for (const id of f.abilityIds) {
      for (const r of idx.get(id)?.rules ?? []) {
        if (!r.events.includes('continuous')) continue;
        const nodes = r.effect?.op === 'sequence' ? r.effect.steps : [r.effect];
        const hit = nodes.find((n) => n?.op === 'modify_rule' && n.rule === rule);
        if (hit) return hit.value;
      }
    }
    return null;
  };

  // **The End Phase, automated (decided).** After the turn's end abilities:
  // everyone on a Trap (or Pit Trap) takes 1 damage — unless they have Armor
  // or a Shield, which the app doesn't subtract: a reminder instead. Then
  // everyone discards 3 Speed (all if fewer; not Shadow Form / Silent
  // Freestyle; Scrambling Style keeps 2).
  async function runEndPhase(env, fighters, onTrap) {
    for (const f of fighters.filter(onTrap)) {
      // Shields only block Actions and Abilities that target you, so a Trap
      // goes past them; Armor isn't subtracted automatically: a reminder.
      const armored = (f.tokens.armor ?? 0) > 0 || f.innateArmor > 0;
      if (armored) {
        await postCard('reminder', {
          title: 'Trap',
          text: `${f.name} stands on a Trap: 1 damage — they have Armor, so resolve it by hand.`,
          fighters: [{ name: f.name }],
          automatic: 'trap',
        });
        continue;
      }
      const { bled } = await env.world.damage(f, 1, null, { bypassShield: true });
      await postCard('reminder', { title: 'Trap', text: `${f.name} takes 1 damage from a Trap.`, fighters: [{ name: f.name }], automatic: 'trap', notice: true });
      await runFor(f, ['self.damage_taken'], env, { amount: 1 });
      if (bled) await runFor(f, ['self.bleed'], env, {});
    }
    const lost = [];
    for (const f of fighters) {
      const held = f.tokens.speed ?? 0;
      if (!held) continue;
      if (endPhaseRule(f, 'end_phase.speed_discard') === 0) continue;
      const floor = Number(endPhaseRule(f, 'end_phase.speed_discard_floor')) || 0;
      const n = Math.min(3, Math.max(0, held - floor));
      if (!n) continue;
      await env.world.discardTokens(f, ['speed'], n);
      lost.push(`${f.name} ${n}`);
    }
    if (lost.length) {
      await postCard('reminder', { title: 'Speed', text: `End Phase: Speed discarded — ${lost.join(', ')}.`, fighters: [], automatic: 'speed', notice: true });
    }
    await emitStageUpdated();
  }

  // **Damage from an Action, entered on the token panel** (`fighter:damage`).
  // The Shield absorbs first; the attacker is the active fighter when they are
  // on the other side, so "after your Shield absorbs from an enemy Action"
  // (Thorns Form) runs against them. `row`: the target's combatant row.
  async function runActionDamage(fightRow, row, amount) {
    const { env, byId, world } = await envFor(fightRow);
    const target = byId(row.id);
    if (!target) return false;
    let order = [];
    try {
      order = JSON.parse(fightRow.turn_order || '[]');
    } catch {
      order = [];
    }
    const active = byId(order[fightRow.turn_index]?.id);
    const attacker = active && active.side !== target.side ? active : null;
    world.context.activeCharacter = active ?? null;
    const r = await world.damage(target, amount, attacker);
    await postCard('reminder', {
      title: 'Damage',
      text: `${target.name} takes ${amount} damage${attacker ? ` from ${attacker.name}` : ''}${r.absorbed ? ` — the Shield absorbs ${r.absorbed}${r.broke ? ' and breaks' : ''}, ${amount - r.absorbed} to HP` : ''}.`,
      fighters: [{ name: target.name }],
      automatic: 'damage',
      notice: true,
    });
    await emitStageUpdated();
    if (r.absorbed) {
      const payload = { attacker, amount: r.absorbed, shieldBroke: r.broke };
      await runFor(target, ['self.shield_absorbed'], env, payload);
      if (attacker) await runFor(target, ['self.shield_absorbed_from_enemy_action'], env, payload);
    }
    return true;
  }

  const envFor = async (fightRow) => {
    const key = `${fightRow.scene_id}:${fightRow.mode}`;
    if (!fightState.has(key)) fightState.set(key, { states: new Map(), usage: {} });
    const fs = fightState.get(key);
    const { world, fighters, byId, onTrap } = await buildWorld(fightRow);
    const env = {
      key,
      world,
      usage: fs.usage,
      stateOf: (id) => {
        if (!fs.states.has(id)) fs.states.set(id, {});
        return fs.states.get(id);
      },
    };
    return { fs, env, world, fighters, byId, onTrap };
  };

  // Start of combat: Improved Warrior gives the Warrior's Path's benefit (its
  // rule is text only in the content, so it is matched by id here).
  async function runFightStart(fightRow) {
    const { env, fighters } = await envFor(fightRow);
    for (const f of fighters) {
      if (f.abilityIds.includes(IMPROVED_WARRIOR)) await runFor(f, ['warrior_path.trigger'], env, {});
    }
  }

  // Start or end of the active fighter's turn: everyone's matching rules.
  async function runTurn(fightRow, activeId, moment) {
    const { fs, env, world, fighters, byId, onTrap } = await envFor(fightRow);
    // Usage limits per turn reset at each turn start.
    if (moment === 'start') for (const k of Object.keys(fs.usage)) if (k.endsWith(':turn')) delete fs.usage[k];
    const active = byId(activeId);
    if (!active) return;
    world.context.activeCharacter = active;
    const order = [active, ...fighters.filter((f) => f.id !== active.id)];
    for (const f of order) {
      const relation = f.id === active.id ? 'self' : f.side === active.side ? 'ally' : 'enemy';
      await runFor(f, eventsFor(moment, relation), env, { activeCharacter: active });
    }
    if (moment === 'end') await runEndPhase(env, fighters, onTrap);
  }

  const onChain = (fightRow, job) => {
    const key = `${fightRow.scene_id}:${fightRow.mode}`;
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(job).catch((err) => console.error('turn triggers', err));
    chains.set(key, next);
    return next;
  };

  return {
    // A fight began: forget any old fight state, then "start of combat" rules.
    startFight(fightRow) {
      fightState.delete(`${fightRow.scene_id}:${fightRow.mode}`);
      return onChain(fightRow, () => runFightStart(fightRow));
    },
    // Damage from an Action to a fighter of this fight, on its chain.
    actionDamage(fightRow, row, amount) {
      return onChain(fightRow, () => runActionDamage(fightRow, row, amount));
    },
    // Queues the triggers of a turn moment on the fight's own chain (never awaited by the caller).
    schedule(fightRow, activeId, moment) {
      return onChain(fightRow, () => runTurn(fightRow, activeId, moment));
    },
    // A fight ended: forget its choices and cancel its open prompts.
    endFight(sceneId, mode) {
      const key = `${sceneId}:${mode}`;
      fightState.delete(key);
      for (const [id, p] of pending) if (p.fightKey === key) finish(id, null);
    },
    answer(socket, { id, answer }) {
      const p = pending.get(id);
      if (!p) return;
      const v = socket.data.identity;
      if (v?.role !== 'gm' && !controlsCharacter(v, p.prompt.characterId)) return;
      finish(id, answer);
    },
    openPromptsFor(socket) {
      const v = socket.data.identity;
      return [...pending.values()].map((p) => p.prompt).filter((p) => v?.role === 'gm' || controlsCharacter(v, p.characterId));
    },
  };
}

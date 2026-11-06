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
import { TOKEN_BY_KEY, capOf, innateArmor } from '../client/src/lib/panicTokens.js';
import { packLane, clampLanes } from '../client/src/lib/simpleLane.js';
import { chebyshev, ruleSupport, runRule, targetable } from '../client/src/lib/patd/interpreter.js';
import { controlsCharacter } from './control.js';
import { hpOf, saveHp, serialized, shapeFightState } from './combatState.js';
import { assembles, derivedFor, franticPickOf } from './fighterStances.js';
import { armorSourcesOf, stanceOfBuild } from '../client/src/lib/patd/build.js';
import { patdContent } from './patdContent.js';
import { listenersFor, relationTo, turnEvents } from '../client/src/lib/patd/engine/bus.js';
import { modifiersOn, valueOf } from '../client/src/lib/patd/engine/modifiers.js';
import { addTemp, expireTemps, fighterRt, startTurn } from '../client/src/lib/patd/engine/runtime.js';
import { spendPrefs } from '../client/src/lib/patd/engine/damage.js';
import { loadRuntime, saveRuntime } from './engine/runtimeStore.js';
import { createActionRunner } from './engine/actions.js';
import { createHits } from './engine/hits.js';

const MIDDLEWEIGHT = WEIGHT_BY_KEY.middle;
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const FOLLOW_ON_DEPTH = 3;
const IMPROVED_WARRIOR = 'ability.feature-improved-warrior.improved-warrior';

export function createTriggerEngine({ io, postCard, emitStageUpdated }) {
  const pending = new Map(); // prompt id → { resolve, characterId, request }
  const chains = new Map(); // "sceneId:mode" → Promise
  let nextId = 1;
  const queued = (fn) => serialized(fn)();

  const sendPrompt = (prompt) => {
    for (const s of io.sockets.sockets.values()) {
      const v = s.data?.identity;
      if (v?.role === 'gm' || controlsCharacter(v, prompt.characterId)) s.emit('trigger:prompt', prompt);
    }
  };
  // **Fight generations.** Ending or starting a fight on a Scene bumps its
  // generation: queued work from before is skipped, work already running stops
  // at its next ability, and it asks no new questions. Without this, a prompt
  // opened just as a fight ended kept that Scene's chain waiting (up to the
  // timeout), and the next fight there — a reused Scene id too — got no triggers.
  const gens = new Map();
  const gen = (key) => gens.get(key) ?? 0;
  const stale = (env) => gen(env.key) !== env.gen;
  // **Turn generations.** A turn's questions belong to that turn: when it ends
  // (Next / Previous turn) the ones still open close as declined, and a turn's
  // triggers still running after it ended ask nothing more (they keep their
  // automatic effects). Without this an unanswered prompt held the fight's
  // chain, and every later turn's prompts queued behind it, popping up on
  // later turns (Trickster's steal "on a random turn").
  const turnGens = new Map();
  const turnGen = (key) => turnGens.get(key) ?? 0;
  const ask = (fighter, fightKey, g, tg, when) => (request) =>
    new Promise((resolve) => {
      if (gen(fightKey) !== g || turnGen(fightKey) !== tg) return resolve(null);
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
        required: request.required ?? [],
        when: when ?? null,
      };
      const timer = setTimeout(() => finish(id, null), PROMPT_TIMEOUT_MS);
      pending.set(id, { resolve, prompt, timer, fightKey, tg });
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
  // Damage Resolution for every hit of this engine's fights (engine/hits.js).
  const hits = createHits({ ask, emitEvent: (env, ev, f, p, filter) => emitEvent(env, ev, f, p, 0, filter) });

  // ---- the world of one fight
  async function buildWorld(fight) {
    const { scene_id: sceneId, mode } = fight;
    const ids = new Set([...JSON.parse(fight.allies || '[]'), ...JSON.parse(fight.enemies || '[]')]);
    const sideOf = (id) => (JSON.parse(fight.allies || '[]').includes(id) ? 'allies' : 'enemies');
    const rows = (await all('SELECT cb.*, c.name, c.character_type FROM combatants cb JOIN characters c ON c.id = cb.character_id WHERE cb.scene_id = ? AND cb.mode = ?', [sceneId, mode])).filter((r) => ids.has(r.id));
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
    const pits = new Set(tiles.filter((t) => t.kind === 'pit').map((t) => { const q = tileSquare(t); return `${q.col},${q.row}`; }));
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
        // Whose Challenge this fighter holds (their Challenger's combatant id).
        challengeId: state.challenge_id ?? null,
        bleeding: state.hp.max != null && state.hp.current <= weight.bleed,
        dizzy: Boolean(state.hp.dizzy),
        // Ask / Auto / Never for Power, Iron and Shield (decided: players Ask, NPCs Auto).
        prefs: spendPrefs(d?.build?.prefs, r.character_type === 'npc'),
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
        f.dizzy = Boolean(next.dizzy);
        f.currentBar = { damage: next.max - next.current };
      });
      return result;
    };
    // You Bleed once per Round, when damage takes you to the Bleed Value or below.
    const bleedCheck = async (f, before, landed, row) => {
      if (!crossesBleed(before.current, landed, weight.bleed) || row.bled_round === fight.round) return false;
      await queued(() => run('UPDATE combatants SET bled_round = ? WHERE id = ?', [fight.round, f.id]));
      await postCard('reminder', {
        title: `Round ${fight.round}`,
        text: `${f.name} Bleeds (HP ${Math.max(0, landed)} ≤ ${weight.bleed}) — "When you Bleed" abilities trigger.`,
        fighters: [{ name: f.name }],
        automatic: 'bleed',
      });
      return true;
    };
    const inPit = (f) => f.square != null && pits.has(`${f.square.col},${f.square.row}`);

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
      // Temporary Armor is binary (book p.24): you have it or you don't.
      tempArmor: (f) => writeTokens(f, (t) => (t.temp_armor = 1)),
      heal: async (f, n) => {
        await changeHp(f, Math.max(0, Number(n) || 0));
        return n;
      },
      payHp: (f, n) => changeHp(f, -Math.max(0, Number(n) || 0)),
      // **Damage (phase C):** the whole Damage Resolution — Weakness, Power,
      // Iron, Shield, Armor — with its prompts and events (engine/hits.js).
      // opts: { source: 'action' | 'ability' | 'super' | 'trap' | 'fall' |
      // 'burning', ignore, allowIron, mods, unblockable, power, emit }.
      damage: (f, n, attacker = null, opts = {}) =>
        hits.resolveHit(world.env, { writeTokens, changeHp, bleedCheck, inPit }, f, n, attacker, opts),
      // A modifier until its duration ends (engine/runtime.js), e.g. Take Aim.
      addTemp: (temp) => addTemp(world.env.rt, temp),
      challenge: (target, challenger) => queued(() => run('UPDATE combatants SET challenge_id = ? WHERE id = ?', [challenger.id, target.id])),
      // Onto the fighter's active turn board (phase B); held numbers outside a turn come in phase F.
      addPoolNumber: (f, v) => runner.addPoolNumber(f.id, v, 'ability'),
    };
    const onTrap = (f) => f.square != null && traps.has(`${f.square.col},${f.square.row}`);
    return { world, fighters, byId, onTrap, weight };
  }

  // Build Abilities are Unblockable (book p.26): the builds marked so in the content.
  const buildUnblockable = (idx) => new Set((idx.content.builds ?? []).filter((b) => b.unblockable).flatMap((b) => b.abilityIds ?? []));

  // ---- running one fighter's rules for some events
  async function runFor(fighter, events, env, eventPayload = null, depth = 0) {
    const idx = patdContent();
    for (const abilityId of fighter.abilityIds) {
      if (stale(env)) return;
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
          ask: ask(fighter, env.key, env.gen, env.tg, env.when),
          // A Text notification: an orange reminder, like any rule left to people.
          notify: (text) => postCard('reminder', { title: ability.name, text, fighters: [{ name: fighter.name }], automatic: 'ability_text' }),
          // Follow-on events go through the bus to whoever listens (engine/bus.js).
          emit: depth < FOLLOW_ON_DEPTH ? (ev, f, payload, filter) => emitEvent(env, ev, f, payload, depth + 1, filter) : null,
          // Its damage is an Ability's; a Build Ability is Unblockable (book p.26).
          source: 'ability',
          unblockable: buildUnblockable(idx).has(ability.id) ? ['all'] : [],
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

  // **The event bus** (engine/bus.js): one event, every listener's rules.
  // `filter(listener)`: only some of them (whose Shield was hit: their own, or an ally's).
  async function emitEvent(env, eventName, subject, payload = {}, depth = 0, filter = null) {
    for (const f of listenersFor(eventName, subject, env.world)) {
      if (filter && !filter(f)) continue;
      if (stale(env)) return;
      await runFor(f, [eventName], env, payload, depth);
    }
  }

  // The modifiers in effect on a fighter now (engine/modifiers.js): continuous
  // rules of active sources, auras from others, and the runtime's temporaries.
  // Shadow Form / Silent Freestyle keep their Speed, Scrambling Style keeps 2.
  const endPhaseRule = (env, f, rule) => valueOf(modifiersOn(f, env.world, patdContent(), env.rt.temps), rule, null);

  // **The End Phase, automated (decided; book p.68).** After the turn's end
  // abilities, in the book's order:
  //   1. Traps: 1 damage to everyone standing on one (Armor applies; no Iron or Shield).
  //   2. Burning: the active fighter takes damage equal to their Burning (no
  //      Iron; the Shield and Armor apply), then discards half, rounded up.
  //   3. Challenge: removed from whoever tried to damage their Challenger this turn.
  //   4. Speed: everyone discards 3 (Shadow Form / Silent Freestyle none,
  //      Scrambling Style keeps 2, Drive Install only 1).
  //   5. Fatigue: if the active fighter never left their starting space, they
  //      discard up to 3 (decided: done for them — nobody would decline).
  async function runEndPhase(env, fighters, onTrap, active) {
    const notices = [];
    for (const f of fighters.filter(onTrap)) {
      if (stale(env)) return;
      const r = await env.world.damage(f, 1, null, { source: 'trap' });
      notices.push(`${f.name}: Trap, ${r.immune ? 'immune' : `${r.taken} damage${r.steps.length ? ` (${r.steps.join(', ')})` : ''}`}`);
    }
    if (active && (active.tokens.burning ?? 0) > 0) {
      const held = active.tokens.burning;
      const r = await env.world.damage(active, held, null, { source: 'burning' });
      const discard = Math.ceil(held / 2);
      await env.world.discardTokens(active, ['burning'], discard);
      notices.push(`${active.name}: Burning, ${r.immune ? 'immune' : `${r.taken} damage${r.steps.length ? ` (${r.steps.join(', ')})` : ''}`}, discards ${discard}`);
    }
    for (const f of fighters) {
      if (f.challengeId == null || !fighterRt(env.rt, f.id).flags.damagedChallenger) continue;
      const challenger = fighters.find((x) => x.id === f.challengeId);
      await queued(() => run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [f.id, f.challengeId]));
      f.challengeId = null;
      notices.push(`${f.name} attacked ${challenger?.name ?? 'their Challenger'}: the Challenge is removed`);
    }
    const lost = [];
    for (const f of fighters) {
      const held = f.tokens.speed ?? 0;
      if (!held) continue;
      const per = Number(endPhaseRule(env, f, 'end_phase.speed_discard') ?? 3);
      if (!(per > 0)) continue;
      const floor = Number(endPhaseRule(env, f, 'end_phase.speed_discard_floor')) || 0;
      const n = Math.min(per, Math.max(0, held - floor));
      if (!n) continue;
      await env.world.discardTokens(f, ['speed'], n);
      lost.push(`${f.name} ${n}`);
    }
    if (lost.length) notices.push(`Speed discarded — ${lost.join(', ')}`);
    if (active && (active.tokens.fatigue ?? 0) > 0) {
      const start = fighterRt(env.rt, active.id).flags.startSquare;
      const still = start === undefined || (start == null && active.square == null) || (start && active.square && start.col === active.square.col && start.row === active.square.row);
      if (still) {
        const n = await env.world.discardTokens(active, ['fatigue'], 3);
        if (n) notices.push(`${active.name} didn't move: discards ${n} Fatigue`);
      }
    }
    if (notices.length) {
      await postCard('reminder', { title: 'End Phase', text: `${notices.join('. ')}.`, fighters: [], automatic: 'end_phase', notice: true });
    }
    await emitStageUpdated();
  }

  // **Damage from an Action, entered on the token panel** (`fighter:damage`):
  // the whole Damage Resolution, with the active fighter as the attacker when
  // they are on the other side — so their Weakness, Power and Unblockable
  // apply, and "after your Shield absorbs from an enemy Action" (Thorns Form)
  // runs against them. `row`: the target's combatant row.
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
    env.when = `${attacker ? `${attacker.name}'s` : 'An'} Action`;
    const r = await world.damage(target, amount, attacker, { source: 'action' });
    await postCard('reminder', {
      title: 'Damage',
      text: `${target.name} takes ${r.taken} damage${attacker ? ` from ${attacker.name}` : ''}${r.immune ? ' — immune' : r.steps.length ? ` (${amount}: ${r.steps.join(', ')})` : ''}.`,
      fighters: [{ name: target.name }],
      automatic: 'damage',
      notice: true,
    });
    await emitStageUpdated();
    await env.save();
    return true;
  }

  // A job's environment: the fight's world and its persisted runtime
  // (engine/runtime.js) — loaded fresh, changed in memory by this job, and
  // saved with env.save() (only the fight's chain writes it).
  const envFor = async (fightRow, tg = null) => {
    const key = `${fightRow.scene_id}:${fightRow.mode}`;
    const rt = await loadRuntime(fightRow.id);
    const { world, fighters, byId, onTrap } = await buildWorld(fightRow);
    const env = {
      key,
      gen: gen(key),
      tg: tg ?? turnGen(key),
      when: null,
      world,
      rt,
      usage: rt.usage,
      stateOf: (id) => fighterRt(rt, id).state,
      save: () => (gen(key) === env.gen ? saveRuntime(fightRow.id, rt) : null),
    };
    world.env = env;
    return { env, world, fighters, byId, onTrap };
  };

  // Start of combat: Improved Warrior gives the Warrior's Path's benefit (its
  // rule is text only in the content, so it is matched by id here).
  async function runFightStart(fightRow) {
    const { env, fighters } = await envFor(fightRow);
    for (const f of fighters) {
      if (f.abilityIds.includes(IMPROVED_WARRIOR)) await runFor(f, ['warrior_path.trigger'], env, {});
    }
    await env.save();
  }

  // Start or end of the active fighter's turn: everyone's matching rules.
  // opts.dizzyIds: who was Dizzy when the turn ended (fights.js clears it right after).
  async function runTurn(fightRow, activeId, moment, tg, opts = {}) {
    const { env, world, fighters, byId, onTrap } = await envFor(fightRow, tg);
    for (const f of fighters) if (opts.dizzyIds?.includes(f.id)) f.dizzy = true;
    const rt = env.rt;
    // Turn boundaries (engine/runtime.js): a new round expires its temporaries
    // and resets per-round counters; a turn start resets per-turn counters and
    // flags and expires "until your next turn" temporaries.
    if (moment === 'start') {
      if (fightRow.round !== rt.round) expireTemps(rt, 'end_of_round');
      startTurn(rt, activeId, fightRow.round);
      expireTemps(rt, 'start_of_turn', { activeId });
    }
    const active = byId(activeId);
    if (!active) return env.save();
    // Where the turn began (the End Phase's Fatigue: "did not move").
    if (moment === 'start') fighterRt(rt, active.id).flags.startSquare = active.square ?? null;
    env.when = `${moment === 'start' ? 'Start' : 'End'} of ${active.name}'s turn`;
    world.context.activeCharacter = active;
    const order = [active, ...fighters.filter((f) => f.id !== active.id)];
    for (const f of order) await runFor(f, turnEvents(moment, relationTo(f, active)), env, { activeCharacter: active });
    if (moment === 'end') {
      await runEndPhase(env, fighters, onTrap, active);
      expireTemps(rt, 'end_of_turn', { activeId });
    }
    await env.save();
  }

  const onChain = (fightRow, job) => {
    const key = `${fightRow.scene_id}:${fightRow.mode}`;
    const g = gen(key);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => (gen(key) === g ? job() : null)).catch((err) => console.error('turn triggers', err));
    chains.set(key, next);
    return next;
  };
  // A fresh start for a Scene's fight: old work dropped, its prompts closed.
  const reset = (key) => {
    gens.set(key, gen(key) + 1);
    chains.set(key, Promise.resolve());
    for (const [id, p] of pending) if (p.fightKey === key) finish(id, null);
  };

  // **Performing Actions** (engine/actions.js): Commit and Retrieve on the board.
  const runner = createActionRunner({
    envFor,
    ask,
    emitEvent,
    postCard,
    emitStageUpdated,
    emit: (ev, payload) => io.emit(ev, payload),
    queued,
    // Phase F (reactions) decides whether anyone could react between Actions.
    reactionsAvailable: async () => false,
  });
  const onBoardChain = async (rollId, job) => {
    const { fight } = await runner.fightOfBoard(rollId);
    if (fight) onChain(fight, job);
  };

  return {
    // Commit the placed Actions of a turn board, in order (phase B).
    commitBoard(rollId) {
      return onBoardChain(rollId, () => runner.commitBoard(rollId));
    },
    // GM: undo a committed Action and every later one.
    retrieve(rollId, key) {
      return onBoardChain(rollId, () => runner.retrieve(rollId, key));
    },
    // A fight began: forget any old fight state, then "start of combat" rules.
    startFight(fightRow) {
      reset(`${fightRow.scene_id}:${fightRow.mode}`);
      return onChain(fightRow, () => runFightStart(fightRow));
    },
    // Damage from an Action to a fighter of this fight, on its chain.
    actionDamage(fightRow, row, amount) {
      return onChain(fightRow, () => runActionDamage(fightRow, row, amount));
    },
    // Queues the triggers of a turn moment on the fight's own chain (never awaited by the caller).
    schedule(fightRow, activeId, moment, opts = {}) {
      const tg = turnGen(`${fightRow.scene_id}:${fightRow.mode}`);
      return onChain(fightRow, () => runTurn(fightRow, activeId, moment, tg, opts));
    },
    // The turn is over (Next / Previous turn): its open questions close as
    // declined, with a note, and its still-running triggers ask nothing more.
    turnOver(fightRow) {
      const key = `${fightRow.scene_id}:${fightRow.mode}`;
      const old = turnGen(key);
      turnGens.set(key, old + 1);
      for (const [id, p] of pending) {
        if (p.fightKey !== key || p.tg !== old) continue;
        finish(id, null);
        postCard('reminder', {
          title: p.prompt.title,
          text: `${p.prompt.fighterName}: not answered before the turn ended — skipped.`,
          fighters: [{ name: p.prompt.fighterName }],
          automatic: 'ability',
          notice: true,
        }).catch(() => {});
      }
    },
    // A fight ended: forget its choices and cancel its open prompts.
    endFight(sceneId, mode) {
      reset(`${sceneId}:${mode}`);
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

// **Moving fighters (full automation, phase D — book pp.53-60).** The fight's
// world (server/triggers.js) hands movement here: the pure planners
// (client/src/lib/patd/engine/board.js) say where a fighter may go, the
// person who controls the movement picks a square (a `square` prompt — the
// legal squares glow on the map or lane, with a list beside), and this file
// applies it: the new square, Traps on the way (each once per turn), Rubble's
// Fatigue, a Pit's fall, a Wall smashed into Rubble (World of Cardboard,
// always on), the Outside, and Save Yourself.
import {
  actionMoveDestinations,
  forcedMoves,
  freeMoveReach,
  gridDistance,
  has,
  key,
  landingsOf,
  neighbors,
  pathCost,
  saveYourselfCost,
  saveYourselfSquares,
  teleportDestinations,
} from '../../client/src/lib/patd/engine/board.js';
import { ironAllowance, unblockableSet } from '../../client/src/lib/patd/engine/damage.js';
import { hasMod, modifiersOn, valueOf } from '../../client/src/lib/patd/engine/modifiers.js';
import { patdContent } from '../patdContent.js';

// **Movement modifiers (phase G).** Free Movement off (`free_movement.disabled`,
// or Caged Style's "cannot gain or spend Speed" — whose Action Movement is
// also reduced to zero), its cost per space (Weightless Style), and Rubble
// without Fatigue (Winged, Weightless).
const modsOn = (env, f) => (env?.world && f ? modifiersOn(f, env.world, patdContent(), env.rt?.temps ?? []) : []);
export const noSpeed = (mods) => hasMod(mods, 'speed_tokens.cannot_gain_or_spend', (v) => v !== false);
export const noFreeMove = (mods) => noSpeed(mods) || hasMod(mods, 'free_movement.disabled', (v) => v !== false);
const costOpts = (mods) => {
  const v = valueOf(mods, 'free_movement.cost_per_space', null);
  return { costPerSpace: v == null ? null : Math.max(0, Number(v) || 0) };
};

// A square pick's title: what is doing it, and the movement — "One-Two Form (Move 2)".
const named = (env, what) => (env?.source ? `${env.source} (${what})` : what);
// A square's name for people: map cells by column and row, lane spaces by lane.
export const squareName = (mode, sq) => (sq == null ? 'the Outside' : mode === 'simple' ? `lane ${sq.row + 1}, space ${sq.col + 1}` : `column ${sq.col}, row ${sq.row}`);
const DANGER = ['pit', 'trap', 'rubble'];
const noteOf = (b, sq) => DANGER.filter((k) => has(b, sq, k)).map((k) => k[0].toUpperCase() + k.slice(1)).join(', ');

// kit: { ask, emitEvent, postCard }
export function createMoves({ ask, emitEvent, postCard }) {
  const fire = (env, ev, f, payload = {}) => emitEvent(env, ev, f, payload);

  // Asks `chooser` to pick one of `dests` ([{ square, cost?, ... }]); one
  // choice needs no asking. `allowNone`: they may decline (→ null).
  // **Skip (decided, batch 4):** every movement from an Action or Ability may
  // be declined — the pick always asks (even with one landing) and Skip
  // (`'__skip'`) moves nobody.
  async function pickSquare(env, chooser, mode, b, dests, { title, text, allowNone = false, costs = null, skippable = true }) {
    if (!dests.length) return null;
    if (dests.length === 1 && !allowNone && !skippable) return dests[0];
    const options = dests.map((d) => ({
      id: d.square ? key(d.square) : 'outside',
      label: squareName(mode, d.square),
      col: d.square?.col ?? null,
      row: d.square?.row ?? null,
      note: [d.square ? noteOf(b, d.square) : 'Outside', costs ? `${costs(d)} Speed` : ''].filter(Boolean).join(' · '),
    }));
    const ans = await ask(chooser, env.key, env.gen, env.tg, env.when)({ kind: 'square', mode, title, text, options, minimum: allowNone ? 0 : 1, maximum: 1, skippable });
    const id = Array.isArray(ans) ? ans[0] : ans;
    if (id === '__skip') return null;
    const hit = dests.find((d) => (d.square ? key(d.square) : 'outside') === id);
    return hit ?? (allowNone ? null : dests[0]);
  }

  // Traps: each deals 1 damage once per turn (book p.72).
  const trapReady = (env, sq) => {
    const rt = env.rt;
    if (rt.trapsHit?.seq !== rt.turnSeq) rt.trapsHit = { seq: rt.turnSeq, keys: [] };
    if (rt.trapsHit.keys.includes(key(sq))) return false;
    rt.trapsHit.keys.push(key(sq));
    return true;
  };
  const lines = [];
  const note = (l) => lines.push(l);
  async function trap(env, f, sq) {
    if (!trapReady(env, sq)) return;
    const r = await env.world.damage(f, 1, null, { source: 'trap' });
    note(`${f.name} triggers a Trap: ${r.immune ? 'immune' : `${r.taken} damage`}`);
  }
  async function rubble(env, f) {
    if (hasMod(modsOn(env, f), 'rubble.no_fatigue', (v) => v !== false)) return;
    await env.world.gainTokens(f, 'fatigue', 1);
    note(`${f.name} lands on Rubble: +1 Fatigue`);
  }
  // Fatigue (book p.10): moving or teleporting while Fatigued discards one and goes 2 less.
  async function fatigue(env, f, distance) {
    if (!((f.tokens.fatigue ?? 0) > 0)) return distance;
    await env.world.discardTokens(f, ['fatigue'], 1);
    note(`${f.name} is Fatigued: discards 1, moves 2 less`);
    return Math.max(0, distance - 2);
  }
  const flush = async (title, f) => {
    if (!lines.length) return;
    const text = lines.splice(0).join('. ');
    await postCard('reminder', { title, text: `${text}.`, fighters: f ? [{ name: f.name }] : [], automatic: 'movement', notice: true });
  };

  // Walks a path: Traps on it trigger and Rubble gives Fatigue (the landing's
  // effects are the caller's), then the fighter stands on its last square.
  async function walk(env, m, f, path, { landing = true, kind = 'action' } = {}) {
    for (let i = 0; i < path.length; i++) {
      const sq = path[i];
      const last = i === path.length - 1;
      if (last && !landing) break;
      const b = m.board();
      if (has(b, sq, 'trap')) await trap(env, f, sq);
      if (has(b, sq, 'rubble') && kind !== 'teleport') await rubble(env, f);
      if (kind === 'free') await fire(env, 'self.free_movement.one_space_finished', f, { square: sq });
    }
    if (path.length) await m.setSquare(f, path.at(-1));
  }

  // **Action Movement** ("move X" / "up to X"): the mover picks the square.
  async function actionMove(env, m, f, { distance, upTo = false, allowNone = false }) {
    if (!f.square) return null;
    // Caged Style: an adjacent enemy's Action Movement is reduced to zero.
    if (noSpeed(modsOn(env, f))) {
      note(`${f.name} is Caged: no movement`);
      await flush('Movement', f);
      return null;
    }
    const d = await fatigue(env, f, Math.max(0, Number(distance) || 0));
    const b = m.board();
    const dests = actionMoveDestinations(b, f.square, d, upTo, f.id);
    if (!dests.length) return null;
    const pick = await pickSquare(env, f, m.mode, b, dests, { title: named(env, `Move ${upTo ? 'up to ' : ''}${d}`), text: `${f.name}: pick where to move.`, allowNone: upTo || allowNone });
    if (!pick) return null;
    await walk(env, m, f, pick.path);
    note(`${f.name} moves to ${squareName(m.mode, pick.square)}`);
    await fire(env, 'self.movement.finished', f, { square: pick.square });
    await flush('Movement', f);
    return pick.square;
  }

  // **Teleport X:** any empty space within Range 1-X; safe — no Trap, Pit or Rubble.
  async function teleport(env, m, f, { distance, allowNone = false }) {
    if (!f.square) return null;
    const d = await fatigue(env, f, Math.max(0, Number(distance) || 0));
    const b = m.board();
    const pick = await pickSquare(env, f, m.mode, b, teleportDestinations(b, f.square, d, f.id), { title: named(env, `Teleport ${d}`), text: `${f.name}: pick where to teleport.`, allowNone });
    if (!pick) return null;
    await m.setSquare(f, pick.square);
    note(`${f.name} teleports to ${squareName(m.mode, pick.square)}`);
    await fire(env, 'self.movement.finished', f, { square: pick.square, teleport: true });
    await flush('Teleport', f);
    return pick.square;
  }

  // **Teleport to a picked space (phase H: `teleport_to`):** the rule already
  // picked it; a Trap there triggers, Rubble doesn't (teleports never do).
  async function teleportTo(env, m, f, sq) {
    if (!f?.square || !sq) return null;
    const b = m.board();
    if (has(b, sq, 'trap')) await trap(env, f, sq);
    await m.setSquare(f, sq);
    note(`${f.name} teleports to ${squareName(m.mode, sq)}`);
    await fire(env, 'self.movement.finished', f, { square: sq, teleport: true });
    await flush('Teleport', f);
    return sq;
  }

  // **Swap Spaces:** both teleport into each other's space.
  async function swap(env, m, a, b) {
    if (!a?.square || !b?.square || a.id === b.id) return false;
    const [sa, sb] = [a.square, b.square];
    await m.setSquare(a, null);
    await m.setSquare(b, sa);
    await m.setSquare(a, sb);
    note(`${a.name} and ${b.name} swap spaces`);
    await flush('Swap', a);
    return true;
  }

  // **Push or Pull** `target` `distance` from `origin` (a square). `chooser`
  // picks the landing (decided: tap the landing square; a route is asked only
  // when routes cross different Traps). `hit`: the same Action's hit on them
  // ({ pushBonus: Power, pushResist: Iron }); without one they may resist
  // with Iron here. `unblockable`: the hit's Unblockable list.
  async function forced(env, m, target, { distance, origin, pull = false, upTo = false, chooser, hit = null, unblockable = [] }) {
    if (!target?.square || !origin) return null;
    const verb = pull ? 'Pull' : 'Push';
    let d = Math.max(0, Number(distance) || 0) + (hit?.pushBonus ?? 0) - (hit?.pushResist ?? 0);
    // "When you are Pushed or Pulled, you move one less space" (The Tank).
    const ev = { reduction: 0, pusher: chooser, pull };
    await fire(env, 'self.would_be_pushed_or_pulled', target, ev);
    d -= ev.reduction;
    // In a Pit, all Forced Movement against you is reduced by 1 (book p.11).
    if (m.inPit(target)) d -= 1;
    // Iron resists a push that came without a hit (with one, its Iron already did).
    const ub = unblockableSet(unblockable);
    if (!hit && d > 0 && !ub.has('iron_tokens') && (target.tokens.iron ?? 0) > 0) {
      const max = Math.min(ironAllowance(modifiersOn(target, env.world, patdContent(), env.rt.temps)), target.tokens.iron, d);
      const mode = target.prefs?.iron ?? 'auto';
      let spend = 0;
      if (mode === 'auto') {
        // Auto: only against a push that could end somewhere bad.
        const risky = forcedMoves(m.board(), target.square, origin, d, { pull, upTo, targetId: target.id }).some((x) => x.ends !== 'full' || DANGER.some((k) => x.square && has(m.board(), x.square, k)));
        spend = risky ? max : 0;
      } else if (mode === 'ask') {
        const options = [{ id: '0', label: 'None' }, ...Array.from({ length: max }, (_, i) => ({ id: String(i + 1), label: `${i + 1} Iron` }))];
        const ans = await ask(target, env.key, env.gen, env.tg, env.when)({ kind: 'choose', title: `Resist the ${verb.toLowerCase()}`, text: `${target.name} is ${pull ? 'pulled' : 'pushed'} ${d}. Spend Iron: 1 space less each.`, options, minimum: 1, maximum: 1 });
        spend = Math.min(max, Number(Array.isArray(ans) ? ans[0] : ans) || 0);
      }
      if (spend > 0) {
        await env.world.discardTokens(target, ['iron'], spend);
        d -= spend;
        note(`${target.name} resists with ${spend} Iron`);
        await fire(env, 'self.iron_tokens_spent', target, { amount: spend, attacker: chooser });
      }
    }
    if (d <= 0) {
      await flush(verb, target);
      return target.square;
    }
    const b = m.board();
    const landings = landingsOf(forcedMoves(b, target.square, origin, d, { pull, upTo, targetId: target.id }));
    if (!landings.length) {
      await flush(verb, target);
      return target.square;
    }
    const picked = await pickSquare(env, chooser ?? target, m.mode, b, landings, {
      title: named(env, `${verb} ${d}`),
      text: `${chooser?.name ?? 'Pick'}: where does ${target.name} land?`,
      allowNone: false,
    });
    // Skipped: no push or pull.
    if (!picked) {
      note(`${chooser?.name ?? 'They'} chose not to ${pull ? 'pull' : 'push'} ${target.name}`);
      await flush(verb, target);
      return target.square;
    }
    let route = picked.routes[0];
    const differ = new Set(picked.routes.map((r) => r.traps.map(key).join(';'))).size > 1;
    if (differ) {
      const options = picked.routes.map((r, i) => ({ id: String(i), label: r.traps.length ? `Through ${r.traps.length} Trap${r.traps.length === 1 ? '' : 's'}: ${r.traps.map((t) => squareName(m.mode, t)).join(', ')}` : 'No Traps' }));
      const ans = await ask(chooser ?? target, env.key, env.gen, env.tg, env.when)({ kind: 'choose', title: `${verb}: which way`, text: `${target.name} can get there more than one way.`, options, minimum: 1, maximum: 1 });
      route = picked.routes[Number(Array.isArray(ans) ? ans[0] : ans)] ?? route;
    }
    // Through the Traps on the way (not the landing: Save Yourself may avoid that).
    if (route.square) {
      await walk(env, m, target, route.path, { landing: false });
      if (route.smashed) {
        await m.smashWall(route.smashed);
        note(`${target.name} smashes through a Wall: it becomes Rubble`);
      }
      await m.setSquare(target, route.square);
    }
    note(`${target.name} is ${pull ? 'pulled' : 'pushed'} to ${squareName(m.mode, route.square)}`);
    // **Save Yourself** (book p.60): 1 Speed (2 out of a Pit) for one space —
    // offered when the landing is dangerous (decided default).
    const after = m.board();
    const landing = route.square;
    const dangerous = !landing || DANGER.some((k) => has(after, landing, k));
    const cost = saveYourselfCost(after, landing);
    let saved = null;
    if (dangerous && (target.tokens.speed ?? 0) >= cost) {
      const squares = saveYourselfSquares(after, landing, { from: route.from, selfId: target.id }).map((sq) => ({ square: sq }));
      saved = await pickSquare(env, target, m.mode, after, squares, {
        skippable: false,
        title: 'Save yourself',
        text: `${target.name} lands ${landing ? `on ${noteOf(after, landing)}` : 'Outside'}. Spend ${cost} Speed to move 1 space instead?`,
        allowNone: true,
      });
    }
    if (saved) {
      await env.world.discardTokens(target, ['speed'], cost);
      await m.setSquare(target, saved.square);
      note(`${target.name} saves themselves: ${cost} Speed, to ${squareName(m.mode, saved.square)}`);
      const nb = m.board();
      if (has(nb, saved.square, 'trap')) await trap(env, target, saved.square);
      if (has(nb, saved.square, 'rubble')) await rubble(env, target);
    } else if (!landing) {
      // The Outside: removed from play, Dizzy (Comeback: phase F).
      await m.setSquare(target, null);
      await m.setDizzy(target);
      note(`${target.name} goes Outside: Dizzy and removed from play`);
    } else {
      if (has(after, landing, 'trap')) await trap(env, target, landing);
      if (has(after, landing, 'rubble')) await rubble(env, target);
      if (has(after, landing, 'pit')) {
        // Pits deal 2 fall damage to anyone pushed or pulled in (book p.11).
        const r = await env.world.damage(target, 2, null, { source: { kind: 'fall', tags: ['pits'] } });
        note(`${target.name} falls into a Pit: ${r.immune ? 'immune' : `${r.taken} damage${r.steps.length ? ` (${r.steps.join(', ')})` : ''}`}`);
      }
    }
    if (!pull) await fire(env, 'self.pushed', target, { pusher: chooser, source: chooser, square: target.square });
    if (chooser && chooser.id !== target.id) await fire(env, 'self.push_finished', chooser, { target });
    await flush(verb, target);
    return target.square;
  }

  // ---------------------------------------------------------------- Free Movement

  // Where a fighter can go with their Speed now: [{ id, col, row, cost, note }].
  function freeReach(m, f, env = null) {
    if (!f?.square) return [];
    const mods = modsOn(env, f);
    if (noFreeMove(mods)) return [];
    const b = m.board();
    return [...freeMoveReach(b, f.square, f.tokens.speed ?? 0, f.id, costOpts(mods)).values()].map((r) => ({ id: key(r.square), col: r.square.col, row: r.square.row, cost: r.cost, note: noteOf(b, r.square) }));
  }
  // **A hand move (decided):** what the cheapest Free Movement from where they
  // stand to `to` would cost, whatever Speed they hold — null when no path.
  function handCost(m, f, to, env = null) {
    if (!f?.square || !to) return null;
    // Searched only so far (a map without bounds would be endless): detours
    // and Pits up to three times the straight distance.
    const limit = gridDistance(f.square, to) * 3 + 10;
    const r = freeMoveReach(m.board(), f.square, limit, f.id, costOpts(modsOn(env, f))).get(key(to));
    return r ? r.cost : null;
  }
  // Adjacent allies they could swap with (2 Speed).
  const swapsFor = (fighters, f, env = null) =>
    (f?.square && (f.tokens.speed ?? 0) >= 2 && !noFreeMove(modsOn(env, f))
      ? fighters.filter((a) => a.id !== f.id && a.side === f.side && a.square && neighbors(f.square).some((n) => n.col === a.square.col && n.row === a.square.row))
      : []
    ).map((a) => ({ id: a.id, name: a.name }));

  // One Free Movement: the cheapest path to `to`, paid in Speed after; Traps
  // trigger and Rubble gives Fatigue on the way. Fatigued: it goes 2 spaces
  // less (decided: the last 2 of the path), and only the spaces moved are paid.
  async function freeMove(env, m, f, to) {
    if (!f?.square) return { error: 'not on the board' };
    const mods = modsOn(env, f);
    if (noFreeMove(mods)) return { error: 'cannot use Free Movement now' };
    const b = m.board();
    const opts = costOpts(mods);
    const r = freeMoveReach(b, f.square, f.tokens.speed ?? 0, f.id, opts).get(key(to));
    if (!r) return { error: 'out of reach' };
    let path = r.path;
    const from = f.square;
    const fatigued = (f.tokens.fatigue ?? 0) > 0;
    if (fatigued) {
      await env.world.discardTokens(f, ['fatigue'], 1);
      path = path.slice(0, Math.max(0, path.length - 2));
      note(`${f.name} is Fatigued: discards 1, moves 2 less`);
    }
    const cost = pathCost(b, f.square, path, opts);
    if (cost) await env.world.discardTokens(f, ['speed'], cost);
    // What an undo puts back (batch 3) — only a clean move: no Trap or Rubble crossed.
    const clean = !path.some((sq) => has(b, sq, 'trap') || has(b, sq, 'rubble'));
    await walk(env, m, f, path, { kind: 'free' });
    if (path.length) note(`${f.name} moves to ${squareName(m.mode, path.at(-1))} (${cost} Speed)`);
    await fire(env, 'self.movement.finished', f, { square: f.square, free: true });
    await flush('Free Movement', f);
    return { ok: true, square: f.square, cost, undo: path.length ? { from, cost, fatigue: fatigued ? 1 : 0, clean } : null };
  }

  // 2 Speed: swap spaces with an adjacent ally (Free Movement and a swap).
  async function freeSwap(env, m, f, ally) {
    if (!f?.square || !ally?.square || f.side !== ally.side || f.id === ally.id) return { error: 'not an ally' };
    if (!neighbors(f.square).some((n) => n.col === ally.square.col && n.row === ally.square.row)) return { error: 'not adjacent' };
    if ((f.tokens.speed ?? 0) < 2) return { error: 'needs 2 Speed' };
    if (noFreeMove(modsOn(env, f))) return { error: 'cannot use Free Movement now' };
    await env.world.discardTokens(f, ['speed'], 2);
    await swap(env, m, f, ally);
    return { ok: true };
  }

  return { actionMove, teleport, teleportTo, swap, forced, freeReach, swapsFor, freeMove, freeSwap, handCost };
}

// Whose Free Movement it is now (book p.57): the active fighter before each
// Action (not mid-Commit), everyone else in the Early Movement phase, and
// everyone in the Late one. `phase`: the fight's movement phase or null.
export function mayFreeMove({ phase, activeId, combatantId, committing = false }) {
  if (phase) return phase.waiting.includes(combatantId);
  return combatantId === activeId && !committing;
}

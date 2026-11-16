// **Fight Setup: Complications and Battle Parameters (server).** The GM sets
// them per Scene and fight mode at any time (`battle:set`); they apply from
// that moment. The catalog, stored shape and pure helpers live in
// client/src/lib/battleParams.js; the rules that act during play are in the
// engine (triggers.js: Disarmed, Enraged, Handcuffs, Weakened State,
// Overwhelming Power, Chained Down's leash; fights.js: Too Slow).
import { one, run } from './db.js';
import { PARAM_BY_KEY, SIDES, keepEmComing, normalizeBattle, parseBattleColumn, toggleArena } from '../client/src/lib/battleParams.js';
import { hpOf, saveHp, serialized, shapeFightState } from './combatState.js';

const MODES = new Set(['simple', 'combat']);

export async function battleFor(sceneId, mode) {
  const row = await one('SELECT battle FROM scenes WHERE id = ?', [sceneId]);
  return parseBattleColumn(row?.battle)[mode];
}

// Read → change → write the one fight mode's settings (the change may be async).
export async function updateBattle(sceneId, mode, change) {
  const row = await one('SELECT battle FROM scenes WHERE id = ?', [sceneId]);
  const both = parseBattleColumn(row?.battle);
  const next = normalizeBattle((await change(structuredClone(both[mode]))) ?? both[mode]);
  both[mode] = next;
  await run('UPDATE scenes SET battle = ? WHERE id = ?', [JSON.stringify(both), sceneId]);
  return next;
}

const idsOf = (json) => {
  try {
    return (JSON.parse(json || '[]') ?? []).map(Number);
  } catch {
    return [];
  }
};
export const sideIdsOf = (fight, side) => idsOf(fight?.[side]);

// **Keep 'Em Coming:** once per fight per side, on what they hold now.
export async function applyKeepEmComing(fight, postCard) {
  const battle = await battleFor(fight.scene_id, fight.mode);
  const sides = SIDES.filter((s) => battle.tilts[s] === 'keep_em_coming' && battle.applied?.keep_em_coming?.[s] !== fight.id);
  if (!sides.length) return;
  const names = [];
  for (const side of sides) {
    for (const id of sideIdsOf(fight, side)) {
      const row = await one('SELECT cb.*, c.name FROM combatants cb JOIN characters c ON c.id = cb.character_id WHERE cb.id = ?', [id]);
      if (!row) continue;
      const hp = hpOf(row);
      const next = keepEmComing(hp, shapeFightState(row).tokens);
      if (hp.max != null && !row.infinite_hp) await saveHp(id, next.hp);
      await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(next.tokens), id]);
      names.push(row.name);
    }
  }
  await updateBattle(fight.scene_id, fight.mode, (b) => {
    b.applied = { ...b.applied, keep_em_coming: { ...(b.applied?.keep_em_coming ?? {}) } };
    for (const s of sides) b.applied.keep_em_coming[s] = fight.id;
    return b;
  });
  if (names.length) {
    await postCard('reminder', {
      title: "Keep 'Em Coming",
      text: `No rest since the last fight: ${names.join(', ')} — half HP on the current bar, half their Burning, Fatigue and Weakness (rounded up).`,
      fighters: names.map((name) => ({ name })),
      automatic: 'battle',
      notice: true,
    });
  }
}

// A fight began: last fight's chains and cuff partners who left go; the
// once-only Tilts apply; Chained Down asks for the Walls (on the engine's chain).
export async function battleFightStart(fight, { postCard, triggers }) {
  const ids = new Set([...sideIdsOf(fight, 'allies'), ...sideIdsOf(fight, 'enemies'), ...sideIdsOf(fight, 'renegades')]);
  const battle = await updateBattle(fight.scene_id, fight.mode, (b) => {
    b.chains = {};
    b.cuffs = b.cuffs.filter((p) => p.every((id) => ids.has(id)));
    return b;
  });
  await applyKeepEmComing(fight, postCard);
  // Queued on the fight's chain, never awaited: the Walls are asked for while
  // the handler moves on (the turn's own rules wait their turn on the chain).
  for (const side of SIDES) if (battle.tilts[side] === 'chained_down') Promise.resolve(triggers?.chainDown?.(fight, side)).catch((err) => console.error('chained down', err));
}

export function registerBattleHandlers({ on: onRaw, socket, emitStageUpdated, postCard, triggers = null }) {
  // One at a time, server-wide (combatState's queue): each is a read-change-write.
  const on = (event, handler) => onRaw(event, serialized(handler));
  // **The GM changes one setting** (Fight Setup's icon grid). `change`:
  //   { tilt: { side, key|null } } · { arena: key } (toggle) · { victory: key }
  //   { complication: key } (toggle) · { cuff: [a, b] } · { uncuff: id }
  on('battle:set', async ({ mode, change } = {}) => {
    if (socket.data.identity?.role !== 'gm' || !MODES.has(mode) || !change || typeof change !== 'object') return;
    const sceneId = (await one('SELECT active_scene_id FROM scene_state WHERE id = 1'))?.active_scene_id;
    if (!sceneId) return;
    const fight = await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    let newTilt = null;
    await updateBattle(sceneId, mode, (b) => {
      if (change.tilt && SIDES.includes(change.tilt.side)) {
        const key = change.tilt.key == null ? null : PARAM_BY_KEY[change.tilt.key]?.family === 'tilt' ? change.tilt.key : undefined;
        if (key === undefined) return b;
        const was = b.tilts[change.tilt.side];
        b.tilts[change.tilt.side] = key;
        if (key !== was) newTilt = { side: change.tilt.side, key, was };
        // Off Chained Down: that side's chains are gone (their Walls stay as Walls).
        if (was === 'chained_down' && key !== 'chained_down' && fight) {
          for (const id of sideIdsOf(fight, change.tilt.side)) delete b.chains[id];
        }
        // Keep 'Em Coming re-armed: it may apply again in this fight.
        if (key === 'keep_em_coming' && b.applied?.keep_em_coming) delete b.applied.keep_em_coming[change.tilt.side];
      }
      if (typeof change.arena === 'string' && PARAM_BY_KEY[change.arena]?.family === 'arena') b.arena = toggleArena(b.arena, change.arena);
      if (typeof change.victory === 'string' && PARAM_BY_KEY[change.victory]?.family === 'victory') b.victory = change.victory;
      if (typeof change.complication === 'string' && PARAM_BY_KEY[change.complication]?.family === 'complication') {
        b.complications = b.complications.includes(change.complication)
          ? b.complications.filter((k) => k !== change.complication)
          : [...b.complications, change.complication];
      }
      if (Array.isArray(change.cuff) && change.cuff.length === 2) {
        const [a, c] = change.cuff.map(Number);
        if (Number.isInteger(a) && Number.isInteger(c) && a !== c) b.cuffs = [...b.cuffs.filter((p) => !p.includes(a) && !p.includes(c)), [a, c]];
      }
      if (change.uncuff != null) b.cuffs = b.cuffs.filter((p) => !p.includes(Number(change.uncuff)));
      return b;
    });
    // Set during a fight: the once-only Tilts take effect now.
    if (fight && newTilt?.key === 'keep_em_coming') await applyKeepEmComing(fight, postCard);
    if (fight && newTilt?.key === 'chained_down') Promise.resolve(triggers?.chainDown?.(fight, newTilt.side)).catch((err) => console.error('chained down', err));
    await emitStageUpdated();
  });
}

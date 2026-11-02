// A fighter's state in a fight (Panic at the Dojo, Phase 4): Panic tokens,
// the Challenge, the HP bar stack, Dizzy, and the active Stance.
//
// It lives on the `combatants` row of that placed copy (decided: every copy is
// independent). On the Combat map that row exists as soon as the token is
// placed. In Simple Combat a fighter IS a summon, so its row ('simple' mode,
// keyed by summon_id) is created the first time anything about it changes —
// a summon that never fights never gets one.
//
// Events name a fighter by a REF: `{ combatantId }` (a map token) or
// `{ summonId }` (a Simple Combat miniature). Writes follow the figure rule:
// the GM edits anyone, a Player their own character's copies.
import { all, one, run } from './db.js';
import { TOKEN_BY_KEY, TOKEN_CAP } from '../client/src/lib/panicTokens.js';
import { addBar, applyHpDelta, normalizeHp, removeBar, setHp } from '../client/src/lib/hpBars.js';

export function shapeFightState(row) {
  let tokens = {};
  try {
    tokens = JSON.parse(row?.tokens || '{}');
  } catch {
    tokens = {};
  }
  const clean = {};
  for (const [k, v] of Object.entries(tokens)) {
    const n = Math.trunc(Number(v));
    if (TOKEN_BY_KEY[k] && n > 0) clean[k] = Math.min(TOKEN_CAP, n);
  }
  return {
    combatant_id: row?.id ?? null,
    tokens: clean,
    challenge_id: row?.challenge_id ?? null,
    hp: normalizeHp({
      max: row?.hp_max,
      current: row?.hp_current,
      bars: row?.hp_bars,
      broken: row?.hp_broken,
      dizzy: row?.dizzy,
    }),
    active_stance_id: row?.active_stance_id ?? null,
  };
}

export const EMPTY_FIGHT_STATE = shapeFightState(null);

// Simple Combat states for one Scene, keyed by summon id.
export async function loadSimpleStates(sceneId) {
  const rows = await all("SELECT * FROM combatants WHERE scene_id = ? AND mode = 'simple'", [sceneId]);
  return new Map(rows.map((r) => [r.summon_id, shapeFightState(r)]));
}

// Find (or, for a summon, create) the combatant a ref names.
async function resolveRef(ref) {
  if (ref?.combatantId != null) {
    return one('SELECT * FROM combatants WHERE id = ?', [Number(ref.combatantId)]);
  }
  if (ref?.summonId != null) {
    const summon = await one('SELECT * FROM scene_summons WHERE id = ?', [Number(ref.summonId)]);
    if (!summon) return null;
    await run(
      `INSERT OR IGNORE INTO combatants (scene_id, mode, summon_id, character_id, temp_npc_id)
       VALUES (?, 'simple', ?, ?, ?)`,
      [summon.scene_id, summon.id, summon.character_id, summon.temp_npc_id]
    );
    return one('SELECT * FROM combatants WHERE summon_id = ?', [summon.id]);
  }
  return null;
}

const hpOf = (row) =>
  normalizeHp({ max: row.hp_max, current: row.hp_current, bars: row.hp_bars, broken: row.hp_broken, dizzy: row.dizzy });

const saveHp = (id, s) =>
  run('UPDATE combatants SET hp_max = ?, hp_current = ?, hp_bars = ?, hp_broken = ?, dizzy = ? WHERE id = ?', [
    s.max,
    s.current,
    s.bars,
    s.broken,
    s.dizzy ? 1 : 0,
    id,
  ]);

// **Every fighter write runs one at a time, server-wide.** Each is a read,
// a change and a write; run concurrently, two quick clicks on "+" both read 3
// and both write 4. A single queue (module-level, so it spans every socket)
// is the whole fix, and these writes are human-paced, so it never backs up.
let queue = Promise.resolve();
export const serialized = (fn) => (payload) => {
  const run_ = queue.then(() => fn(payload));
  queue = run_.catch(() => {});
  return run_;
};

// deps: on, socket, mayWrite(viewer, ownerType, ownerId), emitStageUpdated
export function registerCombatStateHandlers({ on: onRaw, socket, mayWrite, emitStageUpdated }) {
  const on = (event, handler) => onRaw(event, serialized(handler));
  // Resolve a ref and check the sender may edit it. Returns the row or null.
  const editable = async (ref) => {
    const row = await resolveRef(ref);
    if (!row) return null;
    const ownerType = row.character_id != null ? 'character' : 'temp_npc';
    return mayWrite(socket.data.identity, ownerType, row.character_id ?? row.temp_npc_id) ? row : null;
  };

  // +1 / −1 / clear one kind of Panic token. Capped at 9 (decided).
  on('fighter:token', async ({ ref, key, delta, clear }) => {
    if (!TOKEN_BY_KEY[key] || key === 'challenge') return;
    const row = await editable(ref);
    if (!row) return;
    const tokens = shapeFightState(row).tokens;
    const next = clear ? 0 : Math.min(TOKEN_CAP, Math.max(0, (tokens[key] ?? 0) + Math.trunc(Number(delta) || 0)));
    if (next > 0) tokens[key] = next;
    else delete tokens[key];
    await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(tokens), row.id]);
    await emitStageUpdated();
  });

  // Who this fighter's Challenge names — another fighter in the same fight
  // (same Scene, same mode), or nobody (`target: null`).
  on('fighter:challenge', async ({ ref, target }) => {
    const row = await editable(ref);
    if (!row) return;
    let targetId = null;
    if (target) {
      const t = await resolveRef(target);
      if (!t || t.id === row.id || t.scene_id !== row.scene_id || t.mode !== row.mode) return;
      targetId = t.id;
    }
    await run('UPDATE combatants SET challenge_id = ? WHERE id = ?', [targetId, row.id]);
    await emitStageUpdated();
  });

  on('fighter:hp', async ({ ref, delta }) => {
    const row = await editable(ref);
    if (!row) return;
    await saveHp(row.id, applyHpDelta(hpOf(row), delta).state);
    await emitStageUpdated();
  });

  on('fighter:set_hp', async ({ ref, max, current }) => {
    const row = await editable(ref);
    if (!row) return;
    await saveHp(row.id, setHp(hpOf(row), { max, current }).state);
    await emitStageUpdated();
  });

  on('fighter:add_bar', async ({ ref }) => {
    const row = await editable(ref);
    if (!row) return;
    await saveHp(row.id, addBar(hpOf(row)));
    await emitStageUpdated();
  });

  on('fighter:remove_bar', async ({ ref }) => {
    const row = await editable(ref);
    if (!row) return;
    await saveHp(row.id, removeBar(hpOf(row)));
    await emitStageUpdated();
  });

  // Dizzy ends at the end of the current turn (book); until turns exist the
  // GM — or the owner — clears it by hand.
  on('fighter:clear_dizzy', async ({ ref }) => {
    const row = await editable(ref);
    if (!row) return;
    await run('UPDATE combatants SET dizzy = 0 WHERE id = ?', [row.id]);
    await emitStageUpdated();
  });

  // Switch the active Stance any time (decided). Must be one of the owner's
  // own stances; null falls back to the default (their first).
  on('fighter:set_stance', async ({ ref, stanceId }) => {
    const row = await editable(ref);
    if (!row) return;
    let id = null;
    if (stanceId != null) {
      const col = row.character_id != null ? 'character_id' : 'temp_npc_id';
      const stance = await one(`SELECT id FROM combat_stances WHERE id = ? AND ${col} = ?`, [
        Number(stanceId),
        row.character_id ?? row.temp_npc_id,
      ]);
      if (!stance) return;
      id = stance.id;
    }
    await run('UPDATE combatants SET active_stance_id = ? WHERE id = ?', [id, row.id]);
    await emitStageUpdated();
  });
}

// A combatant leaving the fight frees anyone holding its Challenge.
export async function releaseChallengesOf(combatantIds) {
  for (const id of combatantIds) await run('UPDATE combatants SET challenge_id = NULL WHERE challenge_id = ?', [id]);
}

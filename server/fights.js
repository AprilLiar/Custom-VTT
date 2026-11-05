// A fight's rounds and turns (Panic at the Dojo, Phase 5): Start Combat, the
// initiative order, advancing turns, the turn-start Stance roll (or pick), and
// the Reminders posted to chat on every boundary.
//
// One fight per Scene per mode (Simple Combat and Combat are separate fights,
// decided). A fight row holds the two sides (combatant ids) and the current
// round's order — [{ side, id }] from buildRound — plus where in it we are.
//
// Order of a turn boundary (decided): the ending turn's End reminders and the
// automatic End Phase ones, Dizzy cleared (it lasts to the end of the current
// turn), then — if the round is over — Round End, a re-rolled order opened by
// the other side, Round Start; then the new turn: **Stance first** (one stance
// rolls straight away; several ask the fighter's player, or the GM), and only
// then the Start reminders, so a stance-bound reminder sees the new stance.
import { all, one, run } from './db.js';
import { imageUrl } from './images.js';
import { buildRound, nextFirstSide } from '../client/src/lib/initiative.js';
import { turnsPerRound } from '../client/src/lib/hpBars.js';
import { automaticReminders, fightersOnTraps } from '../client/src/lib/fightFlow.js';
import { packLane, clampLanes } from '../client/src/lib/simpleLane.js';
import { rollDerived, stancesOf } from './fighterStances.js';
import { resolveRef, serialized, shapeFightState } from './combatState.js';
import { controlsCharacter } from './control.js';

const MODES = new Set(['simple', 'combat']);
const parseIds = (text) => {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
};

// Every fighter of a Scene's fight, with what a card or the order needs.
export async function loadFighters(sceneId, mode) {
  const rows = await all(
    `SELECT cb.*, COALESCE(c.name, tn.name) AS name,
            cp.id AS profile_id, cp.image_hash AS token_hash, (cp.image_data IS NOT NULL) AS has_token,
            cp.crop_x AS t_cx, cp.crop_y AS t_cy, cp.crop_w AS t_cw, cp.crop_h AS t_ch,
            COALESCE(c.image_hash, tn.image_hash) AS portrait_hash,
            (COALESCE(c.image_data, tn.image_data) IS NOT NULL) AS has_portrait,
            COALESCE(c.crop_x, tn.crop_x) AS p_cx, COALESCE(c.crop_y, tn.crop_y) AS p_cy,
            COALESCE(c.crop_w, tn.crop_w) AS p_cw, COALESCE(c.crop_h, tn.crop_h) AS p_ch
     FROM combatants cb
     LEFT JOIN characters c ON c.id = cb.character_id
     LEFT JOIN temp_npcs tn ON tn.id = cb.temp_npc_id
     LEFT JOIN combat_profiles cp
       ON (cb.character_id IS NOT NULL AND cp.character_id = cb.character_id)
       OR (cb.temp_npc_id IS NOT NULL AND cp.temp_npc_id = cb.temp_npc_id)
     WHERE cb.scene_id = ? AND cb.mode = ? AND cb.character_id IS NOT NULL`,
    [sceneId, mode]
  );
  return rows.map((r) => {
    const ownerType = r.character_id != null ? 'character' : 'temp_npc';
    const ownerId = r.character_id ?? r.temp_npc_id;
    const state = shapeFightState(r);
    const token = r.has_token ? imageUrl('combat-token', r.profile_id, { present: true, hash: r.token_hash }) : null;
    return {
      combatantId: r.id,
      ownerKey: `${ownerType}:${ownerId}`,
      ownerType,
      ownerId,
      characterId: r.character_id,
      name: r.name,
      image_url:
        token ??
        (r.has_portrait
          ? imageUrl(ownerType === 'character' ? 'character' : 'temp-npc', ownerId, { present: true, hash: r.portrait_hash })
          : null),
      crop: token ? { x: r.t_cx, y: r.t_cy, w: r.t_cw, h: r.t_ch } : { x: r.p_cx, y: r.p_cy, w: r.p_cw, h: r.p_ch },
      tokens: state.tokens,
      challengeId: state.challenge_id,
      activeStanceId: state.active_stance_id,
      hp: state.hp,
      summonId: r.summon_id,
    };
  });
}

// A fight as the stage payload carries it.
export async function loadFightState(sceneId, mode) {
  const row = await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
  if (!row) return null;
  let order = [];
  try {
    order = JSON.parse(row.turn_order || '[]');
  } catch {
    order = [];
  }
  let pending = null;
  if (row.pending_stance_combatant != null) {
    const c = await one('SELECT character_id FROM combatants WHERE id = ?', [row.pending_stance_combatant]);
    if (c) {
      const stances = await stancesOf(c.character_id);
      pending = {
        combatant_id: row.pending_stance_combatant,
        character_id: c.character_id,
        stances: stances.map((s) => ({ id: s.id, name: s.name })),
      };
    }
  }
  return {
    id: row.id,
    round: row.round,
    order,
    turn_index: row.turn_index,
    allies: parseIds(row.allies),
    enemies: parseIds(row.enemies),
    pending_stance: pending,
  };
}

// deps: on, socket, emitStageUpdated, postCard(kind, payload), postSystemMessage(text)
// `emitAll(event, payload)` broadcasts to every socket (io.emit).
// `triggers` is the turn-trigger engine (server/triggers.js); optional.
export function registerFightHandlers({ on: onRaw, socket, emitStageUpdated, postCard, postSystemMessage, emitAll, triggers = null }) {
  const on = (event, handler) => onRaw(event, serialized(handler));
  const isGm = () => socket.data.identity?.role === 'gm';
  const activeSceneId = async () =>
    (await one('SELECT active_scene_id FROM scene_state WHERE id = 1'))?.active_scene_id ?? null;

  const card = (f) => ({ name: f.name, image_url: f.image_url, crop: f.crop });

  // Squares holding a Trap tile on this fight's board (map_tiles; a Pit Trap is
  // a Pit and a Trap).
  const trapSquares = async (fight) =>
    new Set(
      (await all("SELECT col, row FROM map_tiles WHERE scene_id = ? AND mode = ? AND kind = 'trap'", [fight.scene_id, fight.mode])).map(
        (r) => `${r.col},${r.row}`
      )
    );
  // Each fighter's square: a map token's grid cell, a miniature's lane space.
  const withSquares = async (fight, fighters) => {
    if (fight.mode === 'combat') {
      const rows = await all("SELECT id, grid_col, grid_row FROM combatants WHERE scene_id = ? AND mode = 'combat'", [fight.scene_id]);
      const at = new Map(rows.map((r) => [r.id, r.grid_col != null ? `${r.grid_col},${r.grid_row}` : null]));
      return fighters.map((f) => ({ ...f, square: at.get(f.combatantId) ?? null }));
    }
    const lanes = clampLanes((await one('SELECT simple_lanes FROM table_settings WHERE id = 1'))?.simple_lanes);
    const summons = await all('SELECT id, lane_slot FROM scene_summons WHERE scene_id = ? AND character_id IS NOT NULL ORDER BY id', [fight.scene_id]);
    const packed = packLane(summons, lanes);
    return fighters.map((f) => {
      const slot = f.summonId != null ? packed.get(f.summonId) : null;
      return { ...f, square: slot != null ? `${slot},0` : null };
    });
  };

  // ---- reminders
  const fire = async (fight, moment, activeId = null) => {
    const fighters = (await loadFighters(fight.scene_id, fight.mode)).filter((f) =>
      sideOf(fight, f.combatantId)
    );
    for (const f of fighters) f.side = sideOf(fight, f.combatantId);
    const active = activeId != null ? fighters.find((f) => f.combatantId === activeId) ?? null : null;
    const when = {
      turn_start: `Start of ${active?.name}'s turn`,
      turn_end: `End of ${active?.name}'s turn`,
      round_start: `Start of round ${fight.round}`,
      round_end: `End of round ${fight.round}`,
    }[moment];
    if (moment === 'turn_end' && active) {
      const onTraps = fightersOnTraps(await withSquares(fight, await loadFighters(fight.scene_id, fight.mode)), await trapSquares(fight));
      for (const auto of automaticReminders({ active, fighters, onTraps })) {
        await postCard('reminder', { title: when, text: auto.text, fighters: auto.fighters.map(card), automatic: auto.rule });
      }
    }
  };

  const sideOf = (fight, id) =>
    parseIds(fight.allies).includes(id) ? 'allies' : parseIds(fight.enemies).includes(id) ? 'enemies' : null;

  // ---- the order
  const newRound = async (fight, firstSide, openerId = null) => {
    const fighters = await loadFighters(fight.scene_id, fight.mode);
    const turnsOf = (id) => {
      const f = fighters.find((x) => x.combatantId === id);
      return f ? turnsPerRound(f.hp) : 0;
    };
    const side = (ids) => ids.map((id) => ({ id, turns: turnsOf(id) })).filter((x) => x.turns > 0);
    return buildRound({
      allies: side(parseIds(fight.allies)),
      enemies: side(parseIds(fight.enemies)),
      firstSide,
      openerId,
    });
  };

  const save = (fight) =>
    run('UPDATE fights SET round = ?, turn_order = ?, turn_index = ?, pending_stance_combatant = ? WHERE id = ?', [
      fight.round,
      fight.turn_order,
      fight.turn_index,
      fight.pending_stance_combatant ?? null,
      fight.id,
    ]);

  const orderOf = (fight) => {
    try {
      return JSON.parse(fight.turn_order || '[]');
    } catch {
      return [];
    }
  };

  // Still a fighter of this fight (it may have been removed from the map).
  const valid = async (fight, id) =>
    sideOf(fight, id) != null && Boolean(await one('SELECT id FROM combatants WHERE id = ?', [id]));

  const rollStanceIntoChat = async (fight, combatantId, stanceId) => {
    const fighter = (await loadFighters(fight.scene_id, fight.mode)).find((f) => f.combatantId === combatantId);
    if (!fighter) return;
    // The Stances come from the character's build (builder phase 2); their
    // dice already hold the level's bonus die, from the build's level.
    const stance = (await stancesOf(fighter.characterId)).find((s) => s.id === stanceId);
    if (!stance) return;
    await run('UPDATE combatants SET active_stance_key = ? WHERE id = ?', [stance.id, combatantId]);
    const results = rollDerived(stance.dice);
    // `combatant_id` lets the Scene keep this card up until that fighter's
    // turn ends (fight:turn_ended).
    await postCard('stance_roll', {
      fighter: card(fighter),
      stance: stance.name,
      results,
      combatant_id: combatantId,
    });
  };

  // The start of the turn at fight.turn_index: Stance, then Start reminders.
  const beginTurn = async (fight) => {
    const entry = orderOf(fight)[fight.turn_index];
    if (!entry) return;
    const row = await one('SELECT character_id FROM combatants WHERE id = ?', [entry.id]);
    const stances = row ? await stancesOf(row.character_id) : [];
    if (stances.length > 1) {
      fight.pending_stance_combatant = entry.id;
      await save(fight);
      return; // fight:choose_stance continues the turn.
    }
    if (stances.length === 1) await rollStanceIntoChat(fight, entry.id, stances[0].id);
    await fire(fight, 'turn_start', entry.id);
    // Abilities' "start of turn" rules — run after this handler, never awaited.
    triggers?.schedule({ ...fight }, entry.id, 'start');
  };

  // Move on to the next valid turn, starting a new round when this one is done.
  const advance = async (fight) => {
    let order = orderOf(fight);
    let index = fight.turn_index + 1;
    while (index < order.length && !(await valid(fight, order[index].id))) index++;
    if (index >= order.length) {
      await fire(fight, 'round_end');
      const firstSide = nextFirstSide(order, 'allies');
      order = await newRound(fight, firstSide);
      fight.round += 1;
      index = 0;
      fight.turn_order = JSON.stringify(order);
      await postSystemMessage(`— Round ${fight.round} —`);
      await fire(fight, 'round_start');
    }
    fight.turn_index = index;
    fight.pending_stance_combatant = null;
    await save(fight);
    await beginTurn(fight);
  };

  const fightFor = async (mode) => {
    const sceneId = await activeSceneId();
    if (!sceneId || !MODES.has(mode)) return null;
    return one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
  };

  // Resolve [ref] → combatant ids of this Scene and mode (creating Simple
  // Combat rows for summons as needed).
  const resolveIds = async (refs, sceneId, mode) => {
    const out = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      const row = await resolveRef(ref);
      if (row && row.scene_id === sceneId && row.mode === mode && !out.includes(row.id)) out.push(row.id);
    }
    return out;
  };

  // **Start Combat (GM).** Sides, the side that starts, and its opener.
  on('fight:start', async ({ mode, allies, enemies, firstSide, opener }) => {
    if (!isGm() || !MODES.has(mode)) return;
    const sceneId = await activeSceneId();
    if (!sceneId) return;
    const allyIds = await resolveIds(allies, sceneId, mode);
    const enemyIds = (await resolveIds(enemies, sceneId, mode)).filter((id) => !allyIds.includes(id));
    if (!allyIds.length && !enemyIds.length) return;
    const openerRow = opener ? await resolveRef(opener) : null;
    const side = firstSide === 'enemies' ? 'enemies' : 'allies';
    await run('DELETE FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    await run(
      "INSERT INTO fights (scene_id, mode, allies, enemies, round, turn_order, turn_index) VALUES (?, ?, ?, ?, 1, '[]', 0)",
      [sceneId, mode, JSON.stringify(allyIds), JSON.stringify(enemyIds)]
    );
    const fight = await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    const order = await newRound(fight, side, openerRow?.id ?? null);
    fight.turn_order = JSON.stringify(order);
    fight.turn_index = 0;
    await save(fight);
    await postSystemMessage('— Combat begins: Round 1 —');
    await fire(fight, 'round_start');
    await beginTurn(fight);
    await emitStageUpdated();
  });

  // **Next turn (GM).** Ends the current turn and starts the next.
  on('fight:next', async ({ mode }) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    const current = orderOf(fight)[fight.turn_index];
    if (current && (await valid(fight, current.id))) {
      await fire(fight, 'turn_end', current.id);
      triggers?.schedule({ ...fight }, current.id, 'end');
    }
    // The Scene's floating chat keeps a fighter's turn-start roll up until now.
    if (current) emitAll?.('fight:turn_ended', { combatantId: current.id });
    // Dizzy lasts until the end of the current turn (book p.62).
    await run('UPDATE combatants SET dizzy = 0 WHERE scene_id = ? AND mode = ?', [fight.scene_id, fight.mode]);
    await advance(fight);
    await emitStageUpdated();
  });

  // **The turn-start Stance pick.** The fighter's player — or the GM, who can
  // always answer — chooses; only then do its dice roll and the turn's Start
  // reminders fire.
  on('fight:choose_stance', async ({ mode, stanceId }) => {
    const fight = await fightFor(mode);
    if (!fight?.pending_stance_combatant) return;
    const c = await one('SELECT * FROM combatants WHERE id = ?', [fight.pending_stance_combatant]);
    if (!c) return;
    const viewer = socket.data.identity;
    const allowed = viewer?.role === 'gm' || (c.character_id != null && controlsCharacter(viewer, c.character_id));
    if (!allowed) return;
    const stance = (await stancesOf(c.character_id)).find((s) => s.id === String(stanceId));
    if (!stance) return;
    fight.pending_stance_combatant = null;
    await save(fight);
    await rollStanceIntoChat(fight, c.id, stance.id);
    await fire(fight, 'turn_start', c.id);
    triggers?.schedule({ ...fight }, c.id, 'start');
    await emitStageUpdated();
  });

  // **Change the sides mid-fight (GM)** — takes effect from the next round
  // (decided); anyone removed is skipped from now on.
  on('fight:set_sides', async ({ mode, allies, enemies }) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    const allyIds = await resolveIds(allies, fight.scene_id, fight.mode);
    const enemyIds = (await resolveIds(enemies, fight.scene_id, fight.mode)).filter((id) => !allyIds.includes(id));
    await run('UPDATE fights SET allies = ?, enemies = ? WHERE id = ?', [JSON.stringify(allyIds), JSON.stringify(enemyIds), fight.id]);
    await emitStageUpdated();
  });

  // **End Combat (GM).** Clears the order; positions, HP and tokens stay.
  on('fight:end', async ({ mode }) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    await run('DELETE FROM fights WHERE id = ?', [fight.id]);
    triggers?.endFight(fight.scene_id, fight.mode);
    await run('UPDATE combatants SET dizzy = 0 WHERE scene_id = ? AND mode = ?', [fight.scene_id, fight.mode]);
    await postSystemMessage('— Combat ends —');
    emitAll?.('fight:ended', { mode: fight.mode });
    await emitStageUpdated();
  });
}

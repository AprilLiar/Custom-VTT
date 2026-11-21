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
import { buildRound, moveEntry, repeatRound } from '../client/src/lib/initiative.js';
import { isTakenOut, turnsPerRound } from '../client/src/lib/hpBars.js';
import { automaticReminders, fightersOnTraps } from '../client/src/lib/fightFlow.js';
import { packLane, clampLanes } from '../client/src/lib/simpleLane.js';
import { assembles, derivedFor, franticPickOf, rollDerived, stanceByKey, stancesOf } from './fighterStances.js';
import { franticOptions, franticPickAllowed } from '../client/src/lib/patd/build.js';
import { patdContent } from './patdContent.js';
import { addXp } from './builds.js';
import { parseRuntime } from '../client/src/lib/patd/engine/runtime.js';
import { activeBoardOf, markInterruptReview, readData, saveBoard, closeInterruptBoards, closeReactionBoards, endTurnDice, resumeRoll, startReaction, startRoll } from './diceMarks.js';
import { XP_AWARDS } from '../client/src/lib/patd/build.js';
import { resolveRef, serialized, shapeFightState } from './combatState.js';
import { controlsCharacter } from './control.js';
import { mayFreeMove } from './engine/moves.js';
import { recordFx } from './fx.js';
import { claimInterrupt, dropInterrupts, interruptOf, nextInterrupt, releaseInterrupt, unqueueInterrupt } from './interrupts.js';
import { isDisarmed, parseBattleColumn, tiltOn } from '../client/src/lib/battleParams.js';
import { forcedFirstSide } from '../client/src/lib/battleVictory.js';
import { battleFightStart } from './battle.js';
import { cleanBonuses, contestOfScene, contestState, dropArenas, finishContest, hpLeftOf, mayActFor, runningContest, saveArenas, snapshotStats, startContest } from './contests.js';
import { CONTEST_BY_KEY, normalizeCustom } from '../client/src/lib/contests.js';
import { battleActionIdsFor } from '../client/src/lib/patd/battleActions.js';
import { tieStooges } from './stooges.js';
import { clearRewind, pushRewindPoint, rewindList, rewindOnce } from './rewind.js';

// The fight's reaction window (phase F): { seq, activeId, offers: { [id]: { clusters, … } }, done } | null.
export const windowOf = (row) => {
  try {
    const w = JSON.parse(row?.reaction_window || 'null');
    return w && w.offers ? w : null;
  } catch {
    return null;
  }
};

// The fight's movement phase (phase D): { kind: 'early' | 'late', activeId, waiting: [combatantId] } | null.
export const phaseOf = (row) => {
  try {
    const p = JSON.parse(row?.movement_phase || 'null');
    return p && Array.isArray(p.waiting) ? p : null;
  } catch {
    return null;
  }
};

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
            COALESCE(c.crop_w, tn.crop_w) AS p_cw, COALESCE(c.crop_h, tn.crop_h) AS p_ch,
            tp.id AS tp_id, tp.image_hash AS tp_hash
     FROM combatants cb
     LEFT JOIN characters c ON c.id = cb.character_id
     LEFT JOIN temp_npcs tn ON tn.id = cb.temp_npc_id
     LEFT JOIN combat_profiles cp
       ON (cb.character_id IS NOT NULL AND cp.character_id = cb.character_id)
       OR (cb.temp_npc_id IS NOT NULL AND cp.temp_npc_id = cb.temp_npc_id)
     LEFT JOIN scene_pictures tp
       ON tp.is_token = 1 AND ((cb.character_id IS NOT NULL AND tp.character_id = cb.character_id)
        OR (cb.temp_npc_id IS NOT NULL AND tp.temp_npc_id = cb.temp_npc_id))
     WHERE cb.scene_id = ? AND cb.mode = ? AND cb.character_id IS NOT NULL`,
    [sceneId, mode]
  );
  return rows.map((r) => {
    const ownerType = r.character_id != null ? 'character' : 'temp_npc';
    const ownerId = r.character_id ?? r.temp_npc_id;
    const state = shapeFightState(r);
    // The Scene Picture ticked as the token first (decided), then the unique token, then the portrait.
    const picture = r.tp_id ? imageUrl('scene-picture', r.tp_id, { present: true, hash: r.tp_hash }) : null;
    const token = picture ?? (r.has_token ? imageUrl('combat-token', r.profile_id, { present: true, hash: r.token_hash }) : null);
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
      crop: picture ? null : token ? { x: r.t_cx, y: r.t_cy, w: r.t_cw, h: r.t_ch } : { x: r.p_cx, y: r.p_cy, w: r.p_cw, h: r.p_ch },
      // A Scene Picture as the token: framed from its top, so the face shows (decided).
      top: Boolean(picture),
      tokens: state.tokens,
      challengeId: state.challenge_id,
      activeStanceId: state.active_stance_id,
      hp: state.hp,
      summonId: r.summon_id,
      // Stooges: a body destroyed by a hit (decided) — never the unit's leading body again.
      stoogeOut: Boolean(r.stooge_out),
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
    const c = await one('SELECT character_id, frantic_pick FROM combatants WHERE id = ?', [row.pending_stance_combatant]);
    if (c) {
      const stances = await stancesOf(c.character_id);
      const d = await derivedFor(c.character_id);
      pending = {
        combatant_id: row.pending_stance_combatant,
        character_id: c.character_id,
        stances: stances.map((s) => ({ id: s.id, name: s.name })),
        // A Frantic Hero assembles the turn's Stance instead (builder phase 4).
        assemble: assembles(d) ? franticOptions(d, franticPickOf(c), patdContent()) : null,
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
    renegades: parseIds(row.renegades),
    pending_stance: pending,
    // Early / Late Movement (phase D): who still gets to move, or null.
    movement_phase: phaseOf(row),
    // **Armor sources used this turn**, by combatant (the Armor rings — decided):
    // from the runtime's per-turn flags.
    armor_used: (() => {
      const rt = parseRuntime(row.runtime);
      return Object.fromEntries(
        Object.entries(rt.fighters ?? {})
          .map(([id, f]) => [id, f?.flags?.armorTriggers ?? 0])
          .filter(([, n]) => n > 0)
      );
    })(),
    // **The Interrupt lock (decided):** who is interrupting (everyone waits),
    // and who waits for the resolving stack to finish. Null when none.
    interrupt: interruptOf(row.id),
    // **GM Rewind:** what the next steps back would undo, newest first (up to 5).
    rewind: (await rewindList(row.id)).map((r) => r.label),
    // Who may still react to the last Action (phase F), or null.
    reaction_window: (() => {
      const w = windowOf(row);
      if (!w) return null;
      const waiting = Object.keys(w.offers).map(Number).filter((id) => !(w.done ?? []).includes(id));
      return waiting.length ? { activeId: w.activeId, waiting } : null;
    })(),
  };
}

// An Interrupt board for this fighter: the open one again, or a new one.
// → the payload the client's DiceBoard opens with.
async function interruptBoard(fight, c, offer, emitAll) {
  const open = await one('SELECT roll_id FROM dice_marks WHERE roll_id LIKE ? AND combatant_id = ? AND active = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1', [`react-${fight.id}-%`, c.id]);
  const rollId =
    open?.roll_id ??
    (await serialized(() => startReaction({ fightId: fight.id, seq: Date.now(), combatantId: c.id, characterId: c.character_id, stanceKey: offer.stanceKey, clusters: offer.clusters, fighterName: offer.name }, emitAll))());
  return { roll_id: rollId, combatant_id: c.id, character_id: c.character_id, stance_key: offer.stanceKey, stance: 'Interrupt', fighter: { name: offer.name } };
}

// **The Interrupt lock, once per server:** whenever a fight's stack finishes,
// the next one waiting to Interrupt takes the lock and their board opens
// (`interrupt:open` — their own clients show it). Someone who can no longer
// Interrupt is skipped.
export function wireInterrupts({ triggers, emitStageUpdated, emitAll }) {
  const startNext = async ({ scene_id, mode }) => {
    const fight = await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [scene_id, mode]);
    if (!fight) return;
    let changed = false;
    for (let who = nextInterrupt(fight.id); who; who = nextInterrupt(fight.id)) {
      changed = true;
      const c = await one('SELECT * FROM combatants WHERE id = ?', [who.combatantId]);
      const offer = c ? (await triggers.interruptOffers({ ...fight }))[c.id] : null;
      if (!offer) {
        releaseInterrupt(fight.id, who.combatantId);
        continue;
      }
      // `by`: the connection that pressed Interrupt — its board opens there.
      emitAll?.('interrupt:open', { mode, combatantId: c.id, by: who.by ?? null, payload: await interruptBoard(fight, c, offer, emitAll), clusters: offer.clusters });
      break;
    }
    // Nobody interrupting or waiting any more: an interrupted turn board asks
    // its player what of its queue still happens (decided: a real Interrupt).
    if (!interruptOf(fight.id)) await markInterruptReview(scene_id, mode, emitAll);
    if (changed) await emitStageUpdated();
  };
  triggers.onIdle(startNext);
  return startNext;
}

// deps: on, socket, emitStageUpdated, postCard(kind, payload), postSystemMessage(text)
// `emitAll(event, payload)` broadcasts to every socket (io.emit).
// `triggers` is the turn-trigger engine (server/triggers.js); optional.
export function registerFightHandlers({ on: onRaw, socket, emitStageUpdated, postCard, postSystemMessage, emitAll, triggers = null, startNextInterrupt = null }) {
  const on = (event, handler) => onRaw(event, serialized(handler));
  const isGm = () => socket.data.identity?.role === 'gm';
  const activeSceneId = async () =>
    (await one('SELECT active_scene_id FROM scene_state WHERE id = 1'))?.active_scene_id ?? null;

  const card = (f) => ({ name: f.name, image_url: f.image_url, crop: f.crop, ...(f.top ? { top: true } : {}) });

  // Squares holding a Trap tile on this fight's board (map_tiles; a Pit Trap is
  // a Pit and a Trap).
  const trapSquares = async (fight) =>
    new Set(
      (await all("SELECT col, row FROM map_tiles WHERE scene_id = ? AND mode = ? AND kind IN ('trap', 'deadly_trap')", [fight.scene_id, fight.mode])).map(
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
      // The turn-trigger engine's End Phase does all of these (decided; Burning,
      // Fatigue and the Challenge since full automation phase C). The reminders
      // stay only as the fallback when the engine isn't running.
      const automated = triggers ? new Set(['trap', 'speed', 'burning', 'fatigue', 'challenge']) : new Set();
      for (const auto of automaticReminders({ active, fighters, onTraps }).filter((x) => !automated.has(x.rule))) {
        await postCard('reminder', { title: when, text: auto.text, fighters: auto.fighters.map(card), automatic: auto.rule });
      }
    }
  };

  const sideOf = (fight, id) =>
    parseIds(fight.allies).includes(id) ? 'allies' : parseIds(fight.enemies).includes(id) ? 'enemies' : parseIds(fight.renegades).includes(id) ? 'renegades' : null;

  // ---- the order
  // `prev`: the last round's order, which this one repeats (decided, batch 5:
  // the order is rolled once, at Start Combat).
  const newRound = async (fight, firstSide, openerId = null, prev = null) => {
    const fighters = await loadFighters(fight.scene_id, fight.mode);
    const leaders = await stoogeLeaders(fight, fighters);
    const turnsOf = (id) => {
      const f = fighters.find((x) => x.combatantId === id);
      if (!f) return 0;
      // Stooges share one turn: only their leading body takes it.
      if (leaders.has(f.characterId)) return leaders.get(f.characterId) === id ? 1 : 0;
      return turnsPerRound(f.hp);
    };
    const side = (ids) => ids.map((id) => ({ id, turns: turnsOf(id) })).filter((x) => x.turns > 0);
    const sides = { allies: side(parseIds(fight.allies)), enemies: side(parseIds(fight.enemies)), renegades: side(parseIds(fight.renegades)) };
    // Outlast's Attackers / Sabotage's Saboteurs always take a Round's first turn.
    const battle = parseBattleColumn((await one('SELECT battle FROM scenes WHERE id = ?', [fight.scene_id]))?.battle)[fight.mode];
    const forced = forcedFirstSide(battle, ['allies', 'enemies', 'renegades'].filter((s) => sides[s].length));
    if (forced && sides[forced]?.length) return buildRound({ ...sides, firstSide: forced, openerId: prev || forced !== firstSide ? null : openerId });
    return prev ? repeatRound({ prev, ...sides }) : buildRound({ ...sides, firstSide, openerId });
  };

  // **Stooges (builder phase 4):** every body of one Stooges character in this
  // fight is one unit with one turn and one Stance. Map(characterId → the
  // leading body: the lowest combatant id still in the fight and not destroyed).
  const stoogeLeaders = async (fight, fighters) => {
    const out = new Map();
    const inFight = fighters.filter((f) => sideOf(fight, f.combatantId) && !f.stoogeOut).sort((a, b) => a.combatantId - b.combatantId);
    for (const f of inFight) {
      if (out.has(f.characterId)) continue;
      const d = await derivedFor(f.characterId);
      if (d?.type.id === 'character-type.stooges') out.set(f.characterId, f.combatantId);
    }
    return out;
  };

  // **Stooges (decided):** every Stooges unit in the fight is tied again
  // (server/stooges.js) — at Start Combat every body starts in play.
  // The ids with every other body of any Stooges unit among them (on this board).
  const withUnits = async (ids, sceneId, mode) => {
    if (!ids.length) return ids;
    const chars = await all(`SELECT DISTINCT character_id FROM combatants WHERE id IN (${ids.map(() => '?').join(',')}) AND character_id IS NOT NULL`, ids);
    const out = [...ids];
    for (const c of chars) {
      const bodies = await tieStooges(sceneId, mode, c.character_id);
      for (const id of bodies) if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  const tieFightStooges = async (fight, { fresh = true } = {}) => {
    const ids = [...parseIds(fight.allies), ...parseIds(fight.enemies), ...parseIds(fight.renegades)];
    if (!ids.length) return;
    const chars = await all(`SELECT DISTINCT character_id FROM combatants WHERE id IN (${ids.map(() => '?').join(',')}) AND character_id IS NOT NULL`, ids);
    for (const c of chars) await tieStooges(fight.scene_id, fight.mode, c.character_id, { fresh });
  };

  const save = (fight) =>
    run('UPDATE fights SET round = ?, turn_order = ?, turn_index = ?, pending_stance_combatant = ?, prev_turn_order = ? WHERE id = ?', [
      fight.round,
      fight.turn_order,
      fight.turn_index,
      fight.pending_stance_combatant ?? null,
      fight.prev_turn_order ?? null,
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
    const stance = await stanceByKey(fighter.characterId, stanceId);
    if (!stance) return;
    await run('UPDATE combatants SET active_stance_key = ? WHERE id = ?', [stance.id, combatantId]);
    // Stooges share their Stance: every body of the unit in this fight takes it.
    const d = await derivedFor(fighter.characterId);
    if (d?.type.id === 'character-type.stooges') {
      const bodies = (await loadFighters(fight.scene_id, fight.mode)).filter((f) => f.characterId === fighter.characterId && sideOf(fight, f.combatantId));
      for (const b of bodies) await run('UPDATE combatants SET active_stance_key = ? WHERE id = ?', [stance.id, b.combatantId]);
    }
    // **Too Slow (Tilt, Fight Setup):** on this side's turns the active
    // character discards their lowest die before rolling.
    let dice = stance.dice;
    let tooSlow = null;
    const battle = parseBattleColumn((await one('SELECT battle FROM scenes WHERE id = ?', [fight.scene_id]))?.battle)[fight.mode];
    if (tiltOn(battle, sideOf(fight, combatantId)) === 'too_slow') {
      const rolled = dice.map((d, i) => ({ d, i })).filter((x) => x.d.kind !== 'fixed' && x.d.sides);
      if (rolled.length) {
        const low = rolled.reduce((a, x) => (x.d.sides < a.d.sides ? x : a));
        dice = dice.filter((_, i) => i !== low.i);
        tooSlow = `d${low.d.sides}`;
      }
    }
    // Stance Contests: the Skill bonuses' green dice join the roll.
    const bonus = JSON.parse((await one('SELECT contest_bonus FROM combatants WHERE id = ?', [combatantId]))?.contest_bonus || '[]');
    for (const b of bonus) for (const sides of { dice_d8: [8], dice_2d6: [6, 6], dice_3d4: [4, 4, 4] }[b.key] ?? []) dice = [...dice, { sides, color: 'green', bonus: true }];
    const results = rollDerived(dice);
    if (tooSlow) await postCard('reminder', { title: 'Too Slow', text: `${fighter.name} discards their lowest die (${tooSlow}) before rolling.`, fighters: [{ name: fighter.name }], automatic: 'battle', notice: true });
    // `combatant_id` lets the Scene keep this card up until that fighter's
    // turn ends (fight:turn_ended). `roll_id`, `character_id` and
    // `stance_key` open the turn's dice board from it (server/diceMarks.js).
    const rollId = `${combatantId}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    // The Victory Parameter's own Actions (Sabotage for the Saboteurs, Grab It! for everyone).
    const battleActions = battleActionIdsFor(battle, sideOf(fight, combatantId));
    // Disarmed (Tilt / Arena): the board shows Range 1 whatever the Stance says.
    const disarmed = isDisarmed(battle, sideOf(fight, combatantId));
    await startRoll({ rollId, combatantId, characterId: fighter.characterId, results, stanceKey: stance.id, battleActions, disarmed }, emitAll);
    await postCard('stance_roll', {
      fighter: card(fighter),
      stance: stance.name,
      results,
      combatant_id: combatantId,
      roll_id: rollId,
      character_id: fighter.characterId,
      stance_key: stance.id,
    });
  };

  // The start of the turn at fight.turn_index: Stance, then Start reminders.
  const beginTurn = async (fight) => {
    const entry = orderOf(fight)[fight.turn_index];
    if (!entry) return;
    // Board animations (phase 4): the turn starts — a ring round them and their name.
    recordFx({ sceneId: fight.scene_id, mode: fight.mode, kind: 'turn', combatantId: entry.id, before: null, after: null, data: {} });
    const row = await one('SELECT character_id FROM combatants WHERE id = ?', [entry.id]);
    const stances = row ? await stancesOf(row.character_id) : [];
    // A Frantic Hero assembles a Stance every turn; several fixed Stances ask which.
    if (stances.length > 1 || (row && assembles(await derivedFor(row.character_id)))) {
      fight.pending_stance_combatant = entry.id;
      await save(fight);
      return; // fight:choose_stance continues the turn.
    }
    if (stances.length === 1) await rollStanceIntoChat(fight, entry.id, stances[0].id);
    await fire(fight, 'turn_start', entry.id);
    // Abilities' "start of turn" rules — run after this handler, never awaited.
    // Then Early Movement (phase D).
    const at = { id: fight.id, index: fight.turn_index, round: fight.round };
    Promise.resolve(triggers?.schedule({ ...fight }, entry.id, 'start'))
      .then(() => openEarly({ fightId: at.id, activeId: entry.id, turnIndex: at.index, round: at.round }))
      .catch((err) => console.error('early movement', err));
  };

  // Move on to the next valid turn, starting a new round when this one is done.
  // **The Round's end runs on the engine's chain, outside this handler.** Its
  // rules (The Fight Must Go On!, Outlast, King of the Hill, Tournament Play)
  // write through the same server-wide queue this handler holds, so awaiting
  // them here would deadlock. The handler lets go; once they are done, the new
  // Round is built (from HP as they stand then) in a queued job of its own.
  // Meanwhile Next / End turn / Previous are ignored for that fight.
  const roundEnding = new Set();
  const startRound = async (fight, prevOrder) => {
    const order = await newRound(fight, null, null, prevOrder);
    // Kept so "Previous turn" can step back into the last round.
    fight.prev_turn_order = fight.turn_order;
    fight.round += 1;
    fight.turn_order = JSON.stringify(order);
    await postSystemMessage(`— Round ${fight.round} —`);
    await fire(fight, 'round_start');
    fight.turn_index = 0;
    fight.pending_stance_combatant = null;
    await save(fight);
    await beginTurn(fight);
  };
  const advance = async (fight) => {
    const order = orderOf(fight);
    let index = fight.turn_index + 1;
    while (index < order.length && !(await valid(fight, order[index].id))) index++;
    if (index >= order.length) {
      await fire(fight, 'round_end');
      roundEnding.add(fight.id);
      const roundOf = fight.round;
      Promise.resolve(triggers?.roundEnd?.({ ...fight }))
        .catch((err) => console.error('round end', err))
        .then(() =>
          serialized(async () => {
            roundEnding.delete(fight.id);
            const fresh = await one('SELECT * FROM fights WHERE id = ?', [fight.id]);
            if (!fresh || fresh.round !== roundOf) return;
            await startRound(fresh, order);
            await emitStageUpdated();
          })()
        )
        .catch((err) => console.error('new round', err));
      return;
    }
    fight.turn_index = index;
    fight.pending_stance_combatant = null;
    await save(fight);
    await beginTurn(fight);
  };

  // `fightId`: a Stance Contest's arena fight (never the active Scene's).
  const fightFor = async (mode, fightId = null) => {
    if (fightId != null) {
      return one('SELECT f.* FROM fights f JOIN scenes s ON s.id = f.scene_id WHERE f.id = ? AND s.contest_id IS NOT NULL', [Number(fightId)]);
    }
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
      // **Only real fighters (decided, play feedback 9):** a figure left out
      // (Fight Setup's ×) or never set up (no max HP) is scenery, not a fighter.
      if (!row || row.excluded || row.hp_max == null) continue;
      if (row.scene_id === sceneId && row.mode === mode && !out.includes(row.id)) out.push(row.id);
    }
    return out;
  };

  // **Start Combat (GM).** Sides, the side that starts, and its opener.
  on('fight:start', async ({ mode, allies, enemies, renegades = [], firstSide, opener }) => {
    if (!isGm() || !MODES.has(mode)) return;
    const sceneId = await activeSceneId();
    if (!sceneId) return;
    // (Stooges: any body sent to a side brings the whole unit — every body.)
    const allyIds = await withUnits(await resolveIds(allies, sceneId, mode), sceneId, mode);
    const enemyIds = (await withUnits(await resolveIds(enemies, sceneId, mode), sceneId, mode)).filter((id) => !allyIds.includes(id));
    // Three Way Battles: the Renegades fight everyone.
    const renegadeIds = (await withUnits(await resolveIds(renegades, sceneId, mode), sceneId, mode)).filter((id) => !allyIds.includes(id) && !enemyIds.includes(id));
    if (!allyIds.length && !enemyIds.length && !renegadeIds.length) return;
    const openerRow = opener ? await resolveRef(opener) : null;
    const side = firstSide === 'enemies' || firstSide === 'renegades' ? firstSide : 'allies';
    await run('DELETE FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    await run(
      "INSERT INTO fights (scene_id, mode, allies, enemies, renegades, round, turn_order, turn_index) VALUES (?, ?, ?, ?, ?, 1, '[]', 0)",
      [sceneId, mode, JSON.stringify(allyIds), JSON.stringify(enemyIds), JSON.stringify(renegadeIds)]
    );
    const fight = await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    await tieFightStooges(fight);
    const order = await newRound(fight, side, openerRow?.id ?? null);
    fight.turn_order = JSON.stringify(order);
    fight.turn_index = 0;
    await save(fight);
    await postSystemMessage('— Combat begins: Round 1 —');
    // Last fight's Frantic picks don't bind this one.
    await run('UPDATE combatants SET frantic_pick = NULL WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    // "At the start of combat" abilities (Improved Warrior's Path), before the first turn.
    triggers?.startFight({ ...fight });
    // Fight Setup: Keep 'Em Coming applies, Chained Down asks for its Walls.
    await battleFightStart({ ...fight }, { postCard, triggers });
    await fire(fight, 'round_start');
    await beginTurn(fight);
    await emitStageUpdated();
  });

  // **Next turn (GM).** Ends the current turn and starts the next.
  // The current turn ends and the next starts (GM's Next turn, or the active
  // player's End turn on the dice board — decided).
  // **Movement phases (decided, phase D).** Early Movement, once the turn's
  // start is done: everyone but the active fighter who holds Speed. Late
  // Movement, on End turn: everyone who holds Speed. Each moves or taps Done;
  // the GM can skip; nobody holding Speed means no phase.
  const setPhase = (fight, phase) => {
    fight.movement_phase = phase ? JSON.stringify(phase) : null;
    return run('UPDATE fights SET movement_phase = ? WHERE id = ?', [fight.movement_phase, fight.id]);
  };
  const speedHolders = async (fight, exceptId = null) => {
    const ids = [...parseIds(fight.allies), ...parseIds(fight.enemies), ...parseIds(fight.renegades)].filter((id) => id !== exceptId);
    if (!ids.length) return [];
    const rows = await all(`SELECT * FROM combatants WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    return rows
      // (Taken Out at zero HP — batch 5 — takes no part in a movement phase.)
      .filter((r) => (shapeFightState(r).tokens.speed ?? 0) > 0 && !isTakenOut(shapeFightState(r).hp) && (fight.mode === 'simple' ? r.summon_id != null : r.grid_col != null))
      .map((r) => r.id);
  };
  // Early Movement opens after the turn's start triggers, if that turn is still on.
  // (One argument: `serialized` passes only the first.)
  const openEarly = serialized(async ({ fightId, activeId, turnIndex, round }) => {
    const fight = await one('SELECT * FROM fights WHERE id = ?', [fightId]);
    if (!fight || fight.turn_index !== turnIndex || fight.round !== round || orderOf(fight)[turnIndex]?.id !== activeId) return;
    const waiting = await speedHolders(fight, activeId);
    // Nobody to move: the Action Phase begins now (phase G). Never awaited:
    // this job holds the server-wide queue, and the fight's chain writes through it.
    if (!waiting.length) {
      triggers?.actionPhase?.({ ...fight }, activeId);
      return;
    }
    await setPhase(fight, { kind: 'early', activeId, waiting });
    triggers?.movementPhase?.({ ...fight }, 'early', activeId);
    await emitStageUpdated();
  });
  const finishPhase = async (fight) => {
    const phase = phaseOf(fight);
    await setPhase(fight, null);
    if (phase?.kind === 'late') return nextTurn(fight);
    // Early Movement over: the Action Phase begins (phase G).
    if (phase?.kind === 'early' && phase.activeId != null) triggers?.actionPhase?.({ ...fight }, phase.activeId);
    await emitStageUpdated();
  };

  const nextTurn = async (fight) => {
    // The Round is still ending (its rules run on the engine's chain): wait.
    if (roundEnding.has(fight.id)) return;
    // A Stance Contest's arena: the contestant's one turn is over.
    const contestId = await contestOfScene(fight.scene_id);
    if (contestId) return contestTurnEnded(fight, contestId);
    // **GM Rewind:** a step back to before this turn ended.
    const ending = orderOf(fight)[fight.turn_index];
    const endingName = ending ? (await one('SELECT c.name FROM combatants cb JOIN characters c ON c.id = cb.character_id WHERE cb.id = ?', [ending.id]))?.name : null;
    await pushRewindPoint(fight.id, endingName ? `End of ${endingName}'s turn` : 'Next turn', { inQueue: true });
    // Any movement phase is over (the GM's Next turn skips Late Movement),
    // and so is any reaction window.
    if (fight.movement_phase) await setPhase(fight, null);
    if (fight.reaction_window) {
      await run('UPDATE fights SET reaction_window = NULL WHERE id = ?', [fight.id]);
      fight.reaction_window = null;
      await closeReactionBoards(fight.id, emitAll);
    }
    const current = orderOf(fight)[fight.turn_index];
    // The ending turn's unanswered questions close first (decided), so its
    // End triggers and the next turn's never wait behind them.
    triggers?.turnOver({ ...fight });
    if (current && (await valid(fight, current.id))) {
      await fire(fight, 'turn_end', current.id);
      // Dizzy lasts through the End Phase (no damage from Traps or Burning),
      // which runs after this handler: tell it who was Dizzy.
      const dizzyIds = (await all('SELECT id FROM combatants WHERE scene_id = ? AND mode = ? AND dizzy = 1', [fight.scene_id, fight.mode])).map((r) => r.id);
      triggers?.schedule({ ...fight }, current.id, 'end', { dizzyIds });
    }
    // The Scene's floating chat keeps a fighter's turn-start roll up until now.
    if (current) emitAll?.('fight:turn_ended', { combatantId: current.id });
    if (current) await endTurnDice([current.id], emitAll);
    // Dizzy lasts until the end of the current turn (book p.62).
    await run('UPDATE combatants SET dizzy = 0 WHERE scene_id = ? AND mode = ?', [fight.scene_id, fight.mode]);
    await advance(fight);
    await emitStageUpdated();
  };

  on('fight:next', async ({ mode }) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    await nextTurn(fight);
  });

  // **End turn (decided: the active player ends it).** From the dice board:
  // whoever controls the fighter whose turn it is (or the GM). Not while that
  // board is still performing Actions.
  on('board:end_turn', async ({ rollId }) => {
    const board = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [String(rollId ?? '')]);
    if (!board?.active) return;
    const viewer = socket.data.identity;
    let data = {};
    try {
      data = JSON.parse(board.data || '{}');
    } catch {
      data = {};
    }
    // The ally given the turn by Heroic Spirit (phase F) may end it too.
    if (viewer?.role !== 'gm' && !controlsCharacter(viewer, board.character_id) && !controlsCharacter(viewer, data.heroic?.characterId)) return;
    if (data.committing) return;
    const c = await one('SELECT scene_id, mode FROM combatants WHERE id = ?', [board.combatant_id]);
    const fight = c ? await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [c.scene_id, c.mode]) : null;
    if (!fight || orderOf(fight)[fight.turn_index]?.id !== board.combatant_id) return;
    if (phaseOf(fight)?.kind === 'late') return;
    // Late Movement first, if anyone holds Speed (phase D); the turn ends when it's done.
    // (Not in a Stance Contest's arena: the turn simply ends there.)
    const waiting = (await contestOfScene(fight.scene_id)) ? [] : await speedHolders(fight);
    if (waiting.length) {
      await setPhase(fight, { kind: 'late', activeId: board.combatant_id, waiting });
      triggers?.movementPhase?.({ ...fight }, 'late', board.combatant_id);
      await emitStageUpdated();
      return;
    }
    await nextTurn(fight);
  });

  // ---- Free Movement and the movement phases (phase D)
  const fightOfCombatant = async (combatantId) => {
    const c = await one('SELECT * FROM combatants WHERE id = ?', [Number(combatantId)]);
    const fight = c ? await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [c.scene_id, c.mode]) : null;
    if (!fight || !sideOf(fight, c.id)) return {};
    return { c, fight };
  };
  const mayControl = (c) => isGm() || controlsCharacter(socket.data.identity, c.character_id);
  const activeCommitting = async (fight) => {
    const id = orderOf(fight)[fight.turn_index]?.id;
    const board = id != null ? await one('SELECT data FROM dice_marks WHERE combatant_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1', [id]) : null;
    try {
      return Boolean(JSON.parse(board?.data || '{}').committing);
    } catch {
      return false;
    }
  };
  // May this fighter use Free Movement right now (book p.57)?
  // Never while someone is interrupting (the Interrupt lock).
  // (Stooges: on the unit's turn every body of it may move — they share the Speed.)
  const freeMoveOk = async (fight, c) => {
    let activeId = orderOf(fight)[fight.turn_index]?.id;
    if (c.stooge_unit != null && activeId != null && activeId !== c.id) {
      const a = await one('SELECT stooge_unit FROM combatants WHERE id = ?', [activeId]);
      if (a?.stooge_unit === c.stooge_unit) activeId = c.id;
    }
    return !interruptOf(fight.id)?.active && mayFreeMove({ phase: phaseOf(fight), activeId, combatantId: c.id, committing: await activeCommitting(fight) });
  };

  // Where they can go with their Speed: ack({ mode, speed, options }).
  // (Straight on the socket: the shared `on` wrapper drops acknowledgements.)
  socket.on('move:reach', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const { c, fight } = await fightOfCombatant(payload?.combatantId);
      if (!c || !mayControl(c) || !triggers || !(await freeMoveOk(fight, c))) return ack({ error: 'not now' });
      const reach = await triggers.freeReach({ ...fight }, c.id);
      // Shown to everyone too (batch 3: a shared player monitor), view-only.
      emitAll?.('pick:view', { id: `move:${c.id}`, kind: 'move', mode: reach.mode, sceneId: fight.scene_id, title: 'Free Movement', options: (reach.options ?? []).map((o) => ({ id: o.id, col: o.col, row: o.row })) });
      ack({ ...reach, sceneId: fight.scene_id });
    } catch (err) {
      console.error('error handling move:reach:', err);
      ack({ error: 'failed' });
    }
  });
  on('move:free', async ({ combatantId, to } = {}) => {
    const { c, fight } = await fightOfCombatant(combatantId);
    if (!c || !mayControl(c) || !triggers || !(await freeMoveOk(fight, c))) return;
    if (!Number.isInteger(to?.col) || !Number.isInteger(to?.row)) return;
    triggers.freeMove({ ...fight }, c.id, { col: to.col, row: to.row }).then((r) => socket.emit('move:result', { combatantId: c.id, ...r }));
  });
  // Free Movement closed on the mover's screen: everyone else's view of it goes.
  on('move:view_end', async ({ combatantId } = {}) => {
    if (Number.isInteger(Number(combatantId))) emitAll?.('pick:clear', { id: `move:${Number(combatantId)}` });
  });
  // The back arrow: take back the last Free Movement (batch 3). ack({ ok } | { error }).
  socket.on('move:undo', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const { c, fight } = await fightOfCombatant(payload?.combatantId);
      if (!c || !mayControl(c) || !triggers?.undoFreeMove) return reply({ error: 'not now' });
      const r = await triggers.undoFreeMove({ ...fight }, c.id);
      socket.emit('move:result', { combatantId: c.id, ...r });
      reply(r);
    } catch (err) {
      console.error('error handling move:undo:', err);
      reply({ error: 'failed' });
    }
  });
  on('move:swap', async ({ combatantId, allyId } = {}) => {
    const { c, fight } = await fightOfCombatant(combatantId);
    if (!c || !mayControl(c) || !triggers || !(await freeMoveOk(fight, c))) return;
    triggers.freeSwap({ ...fight }, c.id, Number(allyId)).then((r) => socket.emit('move:result', { combatantId: c.id, ...r }));
  });
  // **The Action button (decided, batch 5):** the turn board of whoever's turn
  // it is — what the Stance roll's card used to open — for the button at the
  // bottom of the screen. ack({ payload | null, characterId }): `characterId`
  // is who must be controlled to use it (after Heroic Spirit, the ally).
  socket.on('board:current', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const fight = await fightFor(payload?.mode, payload?.fightId ?? null);
      const entry = fight ? orderOf(fight)[fight.turn_index] : null;
      const row = entry && !fight.pending_stance_combatant ? await activeBoardOf(entry.id) : null;
      if (!row || String(row.roll_id).startsWith('react-')) return ack({ payload: null });
      const data = JSON.parse(row.data || '{}');
      const fighters = await loadFighters(fight.scene_id, fight.mode);
      const heroic = data.heroic ?? null;
      const f = fighters.find((x) => x.combatantId === (heroic?.combatantId ?? entry.id));
      if (!f) return ack({ payload: null });
      const stanceKey = heroic ? heroic.stanceKey : data.stanceKey;
      const stance = stanceKey ? await stanceByKey(f.characterId, stanceKey) : null;
      ack({
        characterId: f.characterId,
        payload: { fighter: card(f), stance: stance?.name ?? heroic?.stanceName ?? '', results: data.results ?? [], combatant_id: f.combatantId, roll_id: row.roll_id, character_id: f.characterId, stance_key: stanceKey ?? null },
      });
    } catch (err) {
      console.error('error handling board:current:', err);
      ack({ payload: null });
    }
  });
  // The active fighter's attack range, shaded faint red on the board (batch 3).
  socket.on('fight:active_range', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const fight = await fightFor(payload?.mode, payload?.fightId ?? null);
      if (!fight || !triggers?.activeRange) return ack({ combatantId: null, squares: [] });
      ack({ mode: fight.mode, ...(await triggers.activeRange({ ...fight })) });
    } catch (err) {
      console.error('error handling fight:active_range:', err);
      ack({ combatantId: null, squares: [] });
    }
  });
  // **A hand move (decided):** dragging a fighter by hand asks "Do you need to
  // spend Speed tokens on this move?". The cost is the cheapest Free Movement
  // from where they stand (a diagonal is 2 — the diamond grid). `to` is a map
  // square, or a lane space (`slot`). ack({ cost | null, speed }) or ({ error }).
  const handTarget = (payload) =>
    Number.isInteger(payload?.slot) ? { col: payload.slot % 10, row: Math.floor(payload.slot / 10) } : Number.isInteger(payload?.col) && Number.isInteger(payload?.row) ? { col: payload.col, row: payload.row } : null;
  socket.on('move:hand_cost', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const { c, fight } = await fightOfCombatant(payload?.combatantId);
      const to = handTarget(payload);
      if (!c || !mayControl(c) || !triggers || !to) return ack({ error: 'not in a fight' });
      ack(await triggers.handCost({ ...fight }, c.id, to));
    } catch (err) {
      console.error('error handling move:hand_cost:', err);
      ack({ error: 'failed' });
    }
  });
  // "Yes": it IS Free Movement (play feedback 7) — the engine's own: the
  // cheapest path, Speed paid for the spaces moved, Traps and Rubble on the
  // way, and Fatigue (discard 1, stop 2 spaces short on that same path). The
  // server moves the token (`moved`); the client doesn't send the drop.
  socket.on('move:hand_pay', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const { c, fight } = await fightOfCombatant(payload?.combatantId);
      const to = handTarget(payload);
      if (!c || !mayControl(c) || !triggers || !to) return reply({ error: 'not in a fight' });
      const { cost } = await triggers.handCost({ ...fight }, c.id, to);
      const tokens = shapeFightState(c).tokens;
      if (cost == null) return reply({ error: 'no way there' });
      if ((tokens.speed ?? 0) < cost) return reply({ error: `needs ${cost} Speed` });
      const r = await triggers.freeMove({ ...fight }, c.id, to);
      if (!r || r.error) return reply({ error: r?.error ?? 'could not move' });
      reply({ ok: true, moved: true, cost: r.cost, square: r.square });
    } catch (err) {
      console.error('error handling move:hand_pay:', err);
      reply({ error: 'failed' });
    }
  });
  // **Interrupts (decided, revised — replaces the reaction windows):** who of
  // the fighters this person controls can take a Reactive Action right now,
  // and with what. ack({ offers: { [combatantId]: { name, clusters, mode } } }).
  socket.on('interrupt:offers', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const sceneId = await activeSceneId();
      const out = {};
      for (const mode of MODES) {
        const fight = sceneId ? await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [sceneId, mode]) : null;
        if (!fight || !triggers?.interruptOffers || (payload?.mode && payload.mode !== mode)) continue;
        const offers = await triggers.interruptOffers({ ...fight });
        for (const [id, o] of Object.entries(offers)) {
          const c = await one('SELECT * FROM combatants WHERE id = ?', [Number(id)]);
          if (c && mayControl(c)) out[id] = { name: o.name, clusters: o.clusters, mode };
        }
      }
      ack({ offers: out });
    } catch (err) {
      console.error('error handling interrupt:offers:', err);
      ack({ offers: {} });
    }
  });
  // **Interrupt:** open this fighter's Interrupt board — only what they can
  // use now, by resource; one Reactive Action, then it closes (or Close).
  // ack({ payload, clusters }) or ({ error }).
  socket.on('react:open', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const { c, fight } = await fightOfCombatant(payload?.combatantId);
      if (!c || !fight || !mayControl(c) || !triggers?.interruptOffers) return ack({ error: 'no Interrupt now' });
      const offer = (await triggers.interruptOffers({ ...fight }))[c.id];
      if (!offer) return ack({ error: 'nothing to interrupt with now' });
      // **The Interrupt lock (decided):** never into a resolving Action — then
      // it waits for the stack to finish (wireInterrupts opens it).
      const claim = claimInterrupt(fight.id, { combatantId: c.id, name: offer.name, by: socket.id }, triggers.isBusy?.(fight) ?? false);
      if (claim === 'queued') {
        await emitStageUpdated();
        return ack({ queued: true });
      }
      const board = await interruptBoard(fight, c, offer, emitAll);
      if (claim === 'active') await emitStageUpdated();
      ack({ payload: board, clusters: offer.clusters });
    } catch (err) {
      console.error('error handling react:open:', err);
      ack({ error: 'failed' });
    }
  });
  // Close an Interrupt board without using it.
  on('react:pass', async ({ combatantId } = {}) => {
    const { c, fight } = await fightOfCombatant(combatantId);
    if (!c || !fight || !mayControl(c)) return;
    await closeInterruptBoards(fight.id, c.id, emitAll);
    // Giving it up drops the lock (or the place in the queue).
    releaseInterrupt(fight.id, c.id);
    unqueueInterrupt(fight.id, c.id);
    await emitStageUpdated();
    if (triggers && !triggers.isBusy?.(fight)) await startNextInterrupt?.({ scene_id: fight.scene_id, mode: fight.mode });
  });
  // **GM Rewind (decided):** one step back — before the fight's last Action
  // (and every Ability it set off), Free Movement or Next turn. Everything
  // returns: HP, tokens, positions, tiles, dice, whose turn it is. Up to 5 in a row.
  on('fight:rewind', async ({ mode } = {}) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    if (triggers?.isBusy?.(fight)) return socket.emit('fight:rewind_failed', { error: 'Wait — something is still resolving.' });
    const r = await rewindOnce(fight.id);
    if (!r) return socket.emit('fight:rewind_failed', { error: 'Nothing left to rewind.' });
    dropInterrupts(fight.id);
    triggers?.rewound?.({ ...fight });
    // Every board it touched, re-announced (the dice come back on screen).
    for (const id of r.rollIds) {
      const row = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [id]);
      if (row) await saveBoard(id, readData(row), emitAll);
    }
    await postCard('reminder', { title: 'Rewound', text: `The GM rewound “${r.label}”: everything it did is undone.`, fighters: [], automatic: 'retrieve', notice: true });
    await emitStageUpdated();
  });

  // GM: lift a stuck Interrupt lock (the interrupter left, or changed their mind).
  on('interrupt:cancel', async ({ mode } = {}) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    const lock = fight ? interruptOf(fight.id)?.active : null;
    if (!lock) return;
    await closeInterruptBoards(fight.id, lock.combatantId, emitAll);
    releaseInterrupt(fight.id, lock.combatantId);
    await emitStageUpdated();
    if (triggers && !triggers.isBusy?.(fight)) await startNextInterrupt?.({ scene_id: fight.scene_id, mode: fight.mode });
  });

  // Done moving in this movement phase.
  on('move:done', async ({ combatantId } = {}) => {
    const { c, fight } = await fightOfCombatant(combatantId);
    if (c && fight && mayControl(c)) {
      triggers?.endFreeMoves?.({ ...fight }, c.id);
      emitAll?.('pick:clear', { id: `move:${c.id}` });
    }
    const phase = phaseOf(fight);
    if (!c || !phase || !phase.waiting.includes(c.id) || !mayControl(c)) return;
    const waiting = phase.waiting.filter((id) => id !== c.id);
    if (waiting.length) {
      await setPhase(fight, { ...phase, waiting });
      return emitStageUpdated();
    }
    await finishPhase(fight);
  });
  // The GM skips the rest of a movement phase.
  on('move:skip', async ({ mode } = {}) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight || !phaseOf(fight)) return;
    await finishPhase(fight);
  });

  // **Previous turn (GM).** Steps the marker back one turn — into the last
  // round when at the first turn of this one (its order is kept). It only
  // moves the marker: nothing rolls or triggers again, and tokens and HP stay
  // as they are (decided).
  on('fight:previous', async ({ mode }) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight || roundEnding.has(fight.id)) return;
    triggers?.turnOver({ ...fight });
    if (fight.movement_phase) await setPhase(fight, null);
    const current = orderOf(fight)[fight.turn_index];
    let index = fight.turn_index - 1;
    while (index >= 0 && !(await valid(fight, orderOf(fight)[index].id))) index--;
    if (index < 0) {
      if (fight.round <= 1 || !fight.prev_turn_order) return;
      fight.turn_order = fight.prev_turn_order;
      fight.prev_turn_order = null;
      fight.round -= 1;
      index = orderOf(fight).length - 1;
      while (index > 0 && !(await valid(fight, orderOf(fight)[index].id))) index--;
      await postSystemMessage(`— Back to round ${fight.round} —`);
    }
    fight.turn_index = index;
    fight.pending_stance_combatant = null;
    await save(fight);
    if (current) emitAll?.('fight:turn_ended', { combatantId: current.id });
    if (current) await endTurnDice([current.id], emitAll);
    const back = orderOf(fight)[fight.turn_index];
    if (back) await resumeRoll(back.id, emitAll);
    await emitStageUpdated();
  });

  // **The turn-start Stance pick.** The fighter's player — or the GM, who can
  // always answer — chooses; only then do its dice roll and the turn's Start
  // reminders fire.
  on('fight:choose_stance', async ({ mode, stanceId, abilityId = null, fightId = null }) => {
    const fight = await fightFor(mode, fightId);
    if (!fight?.pending_stance_combatant) return;
    const c = await one('SELECT * FROM combatants WHERE id = ?', [fight.pending_stance_combatant]);
    if (!c) return;
    const viewer = socket.data.identity;
    const allowed = viewer?.role === 'gm' || (c.character_id != null && controlsCharacter(viewer, c.character_id));
    if (!allowed) return;
    const d = await derivedFor(c.character_id);
    if (assembles(d)) {
      // Frantic Versatility: one Form, one Style, one Frantic Ability, none of last turn's.
      const [formId, styleId] = String(stanceId).split('+');
      const pick = { formId, styleId, abilityId: abilityId == null ? null : String(abilityId) };
      if (!franticPickAllowed(franticOptions(d, franticPickOf(c), patdContent()), pick)) return;
      await run('UPDATE combatants SET frantic_pick = ? WHERE id = ?', [JSON.stringify(pick), c.id]);
    } else if (!(await stancesOf(c.character_id)).some((s) => s.id === String(stanceId))) return;
    const stance = await stanceByKey(c.character_id, String(stanceId));
    if (!stance) return;
    fight.pending_stance_combatant = null;
    await save(fight);
    await rollStanceIntoChat(fight, c.id, stance.id);
    await fire(fight, 'turn_start', c.id);
    triggers?.schedule({ ...fight }, c.id, 'start');
    await emitStageUpdated();
  });

  // **The GM drags the order (decided, batch 5):** entry `from` to index `to`,
  // alternation or not. It holds for every round after (rounds repeat).
  on('fight:reorder', async ({ mode, from, to } = {}) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    const moved = moveEntry(orderOf(fight), fight.turn_index, Number(from), Number(to));
    if (!moved) return;
    fight.turn_order = JSON.stringify(moved.order);
    fight.turn_index = moved.index;
    await save(fight);
    await emitStageUpdated();
  });

  // **Change the sides mid-fight (GM)** — takes effect from the next round
  // (decided); anyone removed is skipped from now on.
  on('fight:set_sides', async ({ mode, allies, enemies, renegades = [] }) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    const allyIds = await withUnits(await resolveIds(allies, fight.scene_id, fight.mode), fight.scene_id, fight.mode);
    const enemyIds = (await withUnits(await resolveIds(enemies, fight.scene_id, fight.mode), fight.scene_id, fight.mode)).filter((id) => !allyIds.includes(id));
    const renegadeIds = (await withUnits(await resolveIds(renegades, fight.scene_id, fight.mode), fight.scene_id, fight.mode)).filter((id) => !allyIds.includes(id) && !enemyIds.includes(id));
    await run('UPDATE fights SET allies = ?, enemies = ?, renegades = ? WHERE id = ?', [JSON.stringify(allyIds), JSON.stringify(enemyIds), JSON.stringify(renegadeIds), fight.id]);
    await tieFightStooges({ ...fight, allies: JSON.stringify(allyIds), enemies: JSON.stringify(enemyIds), renegades: JSON.stringify(renegadeIds) }, { fresh: false });
    await emitStageUpdated();
  });

  // ---- Stance Contests (GM Tools; server/contests.js) ----
  const emitContest = async () => emitAll?.('contest:state', await contestState());
  const contestLabel = (def) => `${def.name}${def.key === 'custom' ? '' : ' Contest'}`;
  // An arena's fight begins: Stance pick or roll, then the turn's own rules.
  const beginArena = async (arena) => {
    const fight = await one('SELECT * FROM fights WHERE id = ?', [arena.fightId]);
    if (!fight) return;
    await beginTurn(fight);
  };
  on('contest:start', async ({ def, sides } = {}) => {
    if (!isGm()) return;
    const skillsOn = (await one('SELECT skills_enabled FROM table_settings WHERE id = 1'))?.skills_enabled !== 0;
    const def_ = def?.key === 'custom' ? normalizeCustom(def) : CONTEST_BY_KEY[def?.key] ? { key: def.key } : null;
    const r = await startContest({ def: def_ ?? def, sides, originSceneId: await activeSceneId(), skillsOn });
    if (r.error) return socket.emit('contest:error', { error: r.error });
    const shown = def?.key === 'custom' ? normalizeCustom(def) : CONTEST_BY_KEY[def.key];
    await postCard('reminder', { title: `Stance Contest: ${shown.name}`, text: `${shown.text}${shown.key === 'custom' && !shown.text ? 'A custom contest.' : ''} Everyone plays one turn at the same time, in their own arena.`, fighters: r.arenas.map((a) => ({ name: a.name })), automatic: 'contest' });
    // Skills off: nobody has a bonus step — every arena begins at once.
    if (!skillsOn) for (const a of r.arenas) await beginArena(a);
    await emitContest();
  });
  // A contestant's Skill bonuses (Skills on), then their arena begins.
  on('contest:ready', async ({ contestId, combatantId, bonuses } = {}) => {
    const row = await one("SELECT * FROM contests WHERE id = ? AND status = 'running'", [Number(contestId)]);
    if (!row) return;
    const arenas = JSON.parse(row.arenas || '[]');
    const arena = arenas.find((a) => a.combatantId === Number(combatantId));
    if (!arena || arena.ready || !mayActFor(socket.data.identity, arena.characterId)) return;
    const list = cleanBonuses(bonuses);
    await run('UPDATE combatants SET contest_bonus = ? WHERE id = ?', [JSON.stringify(list), arena.combatantId]);
    // 3 Basic tokens of their choice, now.
    const gained = list.filter((b) => b.key === 'basic_tokens').flatMap((b) => b.tokens);
    if (gained.length) {
      const c = await one('SELECT tokens FROM combatants WHERE id = ?', [arena.combatantId]);
      const t = JSON.parse(c?.tokens || '{}');
      for (const k of gained) t[k] = (t[k] ?? 0) + 1;
      await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(t), arena.combatantId]);
    }
    arena.ready = true;
    arena.plusTwo = list.filter((b) => b.key === 'plus_two').length;
    await saveArenas(row.id, arenas);
    await beginArena(arena);
    await emitContest();
    await emitStageUpdated();
  });
  // "After you roll, you may increase one of your numbers by 2" (a Skill bonus).
  on('contest:plus_two', async ({ contestId, combatantId, index } = {}) => {
    const row = await one("SELECT * FROM contests WHERE id = ? AND status = 'running'", [Number(contestId)]);
    if (!row) return;
    const arenas = JSON.parse(row.arenas || '[]');
    const arena = arenas.find((a) => a.combatantId === Number(combatantId));
    if (!arena || !(arena.plusTwo > 0) || arena.done || !mayActFor(socket.data.identity, arena.characterId)) return;
    const board = await activeBoardOf(arena.combatantId);
    if (!board) return;
    const data = JSON.parse(board.data || '{}');
    const r = data.results?.[Number(index)];
    if (!r || r.plusTwo || (data.placements ?? []).some((p) => p.die === Number(index) || (p.dice ?? []).includes(Number(index)))) return;
    r.result = Number(r.result) + 2;
    r.plusTwo = true;
    r.changed = true;
    arena.plusTwo -= 1;
    await saveArenas(row.id, arenas);
    await saveBoard(board.roll_id, data, emitAll);
    await emitContest();
  });
  on('contest:cancel', async () => {
    if (!isGm()) return;
    const row = await runningContest();
    if (!row) return;
    await run("UPDATE contests SET status = 'cancelled' WHERE id = ?", [row.id]);
    await dropArenas(JSON.parse(row.arenas || '[]'));
    await postSystemMessage('— The Stance Contest is called off —');
    emitAll?.('contest:state', null);
  });
  // A contestant ended their turn: what they did is kept; Survival's (or a
  // custom contest's) hits land first, on the engine's chain. Then, once every
  // arena is done, the result.
  const contestTurnEnded = async (fight, contestId) => {
    const row = await one('SELECT * FROM contests WHERE id = ?', [contestId]);
    if (!row || row.status !== 'running') return;
    const arenas = JSON.parse(row.arenas || '[]');
    const arena = arenas.find((a) => a.fightId === fight.id);
    if (!arena || arena.done) return;
    const def = JSON.parse(row.def || '{}').key === 'custom' ? normalizeCustom(JSON.parse(row.def)) : CONTEST_BY_KEY[JSON.parse(row.def).key];
    triggers?.turnOver({ ...fight });
    arena.stats = await snapshotStats(arena, def);
    arena.ending = true;
    await saveArenas(row.id, arenas);
    emitAll?.('fight:turn_ended', { combatantId: arena.combatantId });
    await endTurnDice([arena.combatantId], emitAll);
    await emitContest();
    const hits = def.setup?.hits ?? [];
    // The hits write through the same queue this handler holds: run them on the
    // engine's chain, and finish in a queued job of its own once they're done.
    Promise.resolve(hits.length ? triggers?.contestHits?.({ ...fight }, arena.combatantId, hits) : null)
      .catch((err) => console.error('contest hits', err))
      .then(() =>
        serialized(async () => {
          const fresh = await one('SELECT * FROM contests WHERE id = ?', [contestId]);
          if (!fresh || fresh.status !== 'running') return;
          const list = JSON.parse(fresh.arenas || '[]');
          const a = list.find((x) => x.fightId === fight.id);
          if (!a) return;
          if (hits.length) a.stats.hpLost = Math.max(0, a.stats.hpBefore - (await hpLeftOf(a.combatantId)));
          a.done = true;
          a.ending = false;
          await saveArenas(contestId, list);
          if (list.every((x) => x.done)) {
            const out = await finishContest(contestId);
            if (out) await postContestResult(out);
          }
          await emitContest();
          await emitStageUpdated();
        })()
      )
      .catch((err) => console.error('contest end', err));
  };
  const postContestResult = async ({ def, result }) => {
    const sideName = (side) => result.scores.filter((s) => s.side === side).map((s) => s.name).join(' & ');
    const best = (side) => result.best[side]?.name;
    const text = result.winner
      ? `${sideName(result.winner)} win${result.scores.filter((s) => s.side === result.winner).length === 1 ? 's' : ''} (best: ${best(result.winner)}).`
      : 'A tie — the book says a fight must break out, with no Tilt.';
    await postCard('reminder', { title: `${contestLabel(def)}: ${result.winner ? 'result' : 'a tie'}`, text, fighters: result.scores.map((s) => ({ name: s.name })), automatic: 'contest' });
  };

  // **End Combat (GM).** Clears the order; positions, HP and tokens stay.
  // `outcome` (decided): 'allies', 'enemies' or 'renegades' won — every character on the
  // winning side gets Victory XP (+2), every one on the losing side Defeat XP
  // (+1), on hero builds only, once per character — or anything else to skip
  // (the fight ended mechanically but the story goes on).
  on('fight:end', async ({ mode, outcome = null }) => {
    if (!isGm()) return;
    const fight = await fightFor(mode);
    if (!fight) return;
    if (outcome === 'allies' || outcome === 'enemies' || outcome === 'renegades') {
      const scene = await one('SELECT name FROM scenes WHERE id = ?', [fight.scene_id]);
      const charactersOf = async (ids) => {
        const out = new Map();
        for (const id of ids) {
          const r = await one('SELECT cb.character_id, c.name FROM combatants cb JOIN characters c ON c.id = cb.character_id WHERE cb.id = ?', [id]);
          if (r && !out.has(r.character_id)) out.set(r.character_id, r.name);
        }
        return out;
      };
      const winners = await charactersOf(parseIds(fight[outcome]));
      const losers = await charactersOf(['allies', 'enemies', 'renegades'].filter((s) => s !== outcome).flatMap((s) => parseIds(fight[s])));
      const lines = [];
      for (const [group, amount, label] of [
        [winners, XP_AWARDS.victory, 'Victory'],
        [losers, XP_AWARDS.defeat, 'Defeat'],
      ]) {
        for (const [characterId, name] of group) {
          if (label === 'Defeat' && winners.has(characterId)) continue;
          const r = await addXp(characterId, amount, `${label}${scene?.name ? ` — ${scene.name}` : ''}`);
          if (!r) continue;
          emitAll?.('build:updated', { characterId, build: r.build });
          lines.push(`${name} +${amount} (${label}, ${r.build.xp} XP${r.canLevelUp ? ' — can level up!' : ''})`);
        }
      }
      await postSystemMessage(`— ${outcome === 'allies' ? 'The allies' : outcome === 'enemies' ? 'The enemies' : 'The Renegades'} win — XP: ${lines.length ? lines.join(', ') : 'nobody on an XP track'}`);
    }
    await run('DELETE FROM fights WHERE id = ?', [fight.id]);
    dropInterrupts(fight.id);
    await clearRewind(fight.id);
    await endTurnDice([...parseIds(fight.allies), ...parseIds(fight.enemies), ...parseIds(fight.renegades)], emitAll);
    triggers?.endFight(fight.scene_id, fight.mode);
    await run('UPDATE combatants SET dizzy = 0 WHERE scene_id = ? AND mode = ?', [fight.scene_id, fight.mode]);
    await postSystemMessage('— Combat ends —');
    emitAll?.('fight:ended', { mode: fight.mode });
    await emitStageUpdated();
  });
}

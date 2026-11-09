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
import { TRAY, clampLanes, moveOnLane, packLane } from '../client/src/lib/simpleLane.js';
import { inBounds as inBoundsAt, isEmpty as isEmptyAt, makeBoard, occupant as occupantAt } from '../client/src/lib/patd/engine/board.js';
import { OBSTACLES as OBSTACLE_KINDS, placeTile, removeTile } from '../client/src/lib/mapTiles.js';
import { cellBounds, imageSize } from './imageSize.js';
import { sceneGrid } from './combatMap.js';
import { gridDistance, ruleSupport, runRule, targetable } from '../client/src/lib/patd/interpreter.js';
import { controlsCharacter } from './control.js';
import { hpOf, saveHp, serialized, shapeFightState } from './combatState.js';
import { assembles, derivedFor, franticPickOf } from './fighterStances.js';
import { armorSourcesOf, stanceOfBuild } from '../client/src/lib/patd/build.js';
import { patdContent } from './patdContent.js';
import { listenersFor, relationTo, turnEvents } from '../client/src/lib/patd/engine/bus.js';
import { abilitiesOff, effectiveRange, hasMod, listMod, modifiersOn, valueOf } from '../client/src/lib/patd/engine/modifiers.js';
import { addTemp, expireTemps, fighterRt, startTurn } from '../client/src/lib/patd/engine/runtime.js';
import { spendPrefs, unblockableSet } from '../client/src/lib/patd/engine/damage.js';
import { loadRuntime, saveRuntime } from './engine/runtimeStore.js';
import { createActionRunner } from './engine/actions.js';
import { createHits } from './engine/hits.js';
import { createMoves } from './engine/moves.js';
import { atZero, comebackSquares, reactionClusters, turnContext } from '../client/src/lib/patd/engine/turn.js';
import { hasDiceCost } from '../client/src/lib/patd/tokenCost.js';
import { ENGINE_NATIVE, continuousSupport, isIronAnySource } from '../client/src/lib/patd/coverage.js';
import { addPoolValue, livePool, turnActions } from '../client/src/lib/patd/diceBoard.js';
import { fighterState, readData as readBoardData, saveBoard } from './diceMarks.js';

// The combat map's image size, by image hash (its playable bounds — phase D).
const imageSizes = new Map();
// The map's picture: the uploaded Combat Background, or else (decided) the
// Scene's own artwork — from whichever Scene owns its bytes (a copy's source).
async function mapBounds(sceneId) {
  const scene = await one('SELECT combat_image_hash, image_hash, image_source_id, grid_size, grid_offset_x, grid_offset_y, grid_opacity FROM scenes WHERE id = ?', [sceneId]);
  const own = Boolean(scene?.combat_image_hash);
  const hash = own ? scene.combat_image_hash : scene?.image_hash;
  if (!hash) return null;
  if (!imageSizes.has(hash)) {
    const row = own
      ? await one('SELECT combat_image_data AS data FROM scenes WHERE id = ?', [sceneId])
      : await one('SELECT image_data AS data FROM scenes WHERE id = ?', [scene.image_source_id ?? sceneId]);
    let size = null;
    try {
      size = row?.data ? imageSize(Buffer.from(row.data, 'base64')) : null;
    } catch {
      size = null;
    }
    imageSizes.set(hash, size);
  }
  const size = imageSizes.get(hash);
  return size ? cellBounds(size.width, size.height, sceneGrid(scene)) : null;
}

const MIDDLEWEIGHT = WEIGHT_BY_KEY.middle;
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const FOLLOW_ON_DEPTH = 3;
const IMPROVED_WARRIOR = 'ability.feature-improved-warrior.improved-warrior';
// Done by the engine itself, not by their rules: Control and Chaos (phase F),
// and the Frantic Hero's Stance assembly (fights.js: fight:choose_stance) —
// one list, shared with the automation census (lib/patd/coverage.js).
export { ENGINE_NATIVE };
const BASIC_TOKENS = new Set(['power', 'iron', 'speed']);

export function createTriggerEngine({ io, postCard, emitStageUpdated }) {
  const pending = new Map(); // prompt id → { resolve, characterId, request }
  const chains = new Map(); // "sceneId:mode" → Promise
  let nextId = 1;
  const queued = (fn) => serialized(fn)();

  // **Every board pick is shown to everyone (decided, batch 3 — the table
  // shares a player monitor):** a square or target pick's squares and Range go
  // to every socket as a view (`pick:view`); only whoever is asked can answer.
  // `trigger:resolved` (io.emit) clears it.
  const pickView = (prompt) =>
    (prompt.kind === 'square' || prompt.kind === 'targets') && prompt.mode
      ? {
          id: prompt.id,
          kind: prompt.kind,
          mode: prompt.mode,
          title: prompt.title,
          fighterName: prompt.fighterName,
          area: prompt.area ?? [],
          options: (prompt.options ?? []).filter((o) => o.col != null).map((o) => ({ id: o.id, col: o.col, row: o.row })),
        }
      : null;
  const sendPrompt = (prompt) => {
    for (const s of io.sockets.sockets.values()) {
      const v = s.data?.identity;
      if (v?.role === 'gm' || controlsCharacter(v, prompt.characterId)) s.emit('trigger:prompt', prompt);
    }
    const view = pickView(prompt);
    if (view?.options.length) io.emit('pick:view', view);
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
  // **Every step shows before the next question (decided):** world changes
  // (squares, tokens, HP, tiles) mark the stage dirty; a move redraws at once,
  // and anything else is sent before the next prompt goes out.
  let stageDirty = false;
  const markDirty = () => {
    stageDirty = true;
  };
  const flushStage = async () => {
    if (!stageDirty) return;
    stageDirty = false;
    await emitStageUpdated();
  };
  const ask = (fighter, fightKey, g, tg, when) => async (request) => {
    await flushStage();
    return new Promise((resolve) => {
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
        // A square pick (phase D): which board the options are squares of.
        // A target pick (batch 3) too: its options carry their squares and
        // `area` is the Range they're picked in (red on the board).
        mode: request.mode ?? null,
        area: request.area ?? null,
        // Skip offered even when a pick is required (batch 4): answers '__skip'.
        skippable: Boolean(request.skippable),
      };
      const timer = setTimeout(() => finish(id, null), PROMPT_TIMEOUT_MS);
      pending.set(id, { resolve, prompt, timer, fightKey, tg });
      sendPrompt(prompt);
    });
  };
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
  // Movement on the map and lanes (engine/moves.js).
  const moves = createMoves({ ask, emitEvent: (env, ev, f, p, filter) => emitEvent(env, ev, f, p, 0, filter), postCard });

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
    const tiles = await all('SELECT id, col, row, kind, owner_id FROM map_tiles WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    let tileSquare = (t) => ({ col: t.col, row: t.row });
    // Where a square is stored (lanes keep tiles as space index, row 0).
    let storedOf = (sq) => ({ col: sq.col, row: sq.row });
    let lanes = 1;
    // The arena's edge (phase D): the lanes' ends, or the map image's padding.
    let bounds = null;
    if (mode === 'simple') {
      lanes = clampLanes((await one('SELECT simple_lanes FROM table_settings WHERE id = 1'))?.simple_lanes);
      const packed = packLane(await all('SELECT id, lane_slot FROM scene_summons WHERE scene_id = ? AND character_id IS NOT NULL ORDER BY id', [sceneId]), lanes);
      squareOf = (r) => {
        const slot = r.summon_id != null ? packed.get(r.summon_id) : null;
        return slot == null ? null : { col: slot % 10, row: Math.floor(slot / 10) };
      };
      tileSquare = (t) => ({ col: t.col % 10, row: Math.floor(t.col / 10) });
      storedOf = (sq) => ({ col: sq.row * 10 + sq.col, row: 0 });
      bounds = { colMin: 0, colMax: 9, rowMin: 0, rowMax: lanes - 1 };
    } else {
      bounds = await mapBounds(sceneId);
    }
    // The tiles in board squares — changed in place when a Wall is smashed.
    const tileList = tiles.filter((t) => t.kind !== 'copy').map((t) => ({ ...tileSquare(t), kind: t.kind }));
    const setOf = (kind) => new Set(tileList.filter((t) => t.kind === kind).map((t) => `${t.col},${t.row}`));
    const traps = setOf('trap');
    const walls = setOf('wall');
    const pits = setOf('pit');
    const fogSquares = tiles.filter((t) => t.kind === 'fog').map(tileSquare);
    const fogged = (sq) => fogSquares.some((f) => gridDistance(f, sq) <= 1);

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
        summonId: r.summon_id ?? null,
        name: r.name,
        side: sideOf(r.id),
        tokens: { ...state.tokens },
        // Whose Challenge this fighter holds (their Challenger's combatant id).
        challengeId: state.challenge_id ?? null,
        bleeding: state.hp.max != null && state.hp.current <= weight.bleed,
        dizzy: Boolean(state.hp.dizzy),
        hp: state.hp,
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
    // A fighter's square is also their "space" (`self.space`, `targets.x.space`).
    for (const f of fighters) Object.defineProperty(f, 'space', { get: () => f.square, enumerable: false });
    // Standing in a Wall's space (Parkour Style may; phase G).
    for (const f of fighters) Object.defineProperty(f, 'standingOnWall', { get: () => f.square != null && walls.has(`${f.square.col},${f.square.row}`), enumerable: false });
    // Each fighter's active turn board, for their Action Pool (phase H).
    const boards = new Map();
    if (fighters.length) {
      const marks = await all(`SELECT * FROM dice_marks WHERE active = 1 AND combatant_id IN (${fighters.map(() => '?').join(',')}) ORDER BY created_at, rowid`, fighters.map((f) => f.id));
      for (const m of marks) boards.set(m.combatant_id, readBoardData(m));
    }
    for (const f of fighters) Object.defineProperty(f, 'actionPool', { get: () => livePool(boards.get(f.id)), enumerable: false });
    // Status tokens held — Apply Pressure. Burning, Fatigue and Weakness: a
    // held Challenge is a Unique token (decided), so it doesn't count.
    for (const f of fighters) {
      Object.defineProperty(f, 'statusTokenCount', { get: () => ['burning', 'fatigue', 'weakness'].reduce((n, k) => n + (f.tokens[k] ?? 0), 0), enumerable: false });
    }

    // **Copies (phase E, book p.71):** replicas of their Original — map tiles of
    // kind 'copy' with the Original's combatant id. A Copy fills its space like
    // a unit, can be targeted as an enemy or an obstacle (never an ally), holds
    // no tokens, and has 1 HP: any damage, a Trap included, destroys it.
    const copyOf = (t) => {
      const owner = byId(t.owner_id);
      if (!owner) return null;
      return {
        id: `copy:${t.id}`,
        rowId: t.id,
        isCopy: true,
        ownerId: owner.id,
        characterId: owner.characterId,
        name: `${owner.name}'s Copy`,
        side: owner.side,
        square: tileSquare(t),
        get space() {
          return this.square;
        },
        tokens: {},
        abilityIds: [],
        stance: owner.stance,
        prefs: owner.prefs,
      };
    };
    const copies = tiles.filter((t) => t.kind === 'copy').map(copyOf).filter(Boolean);

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
      markDirty();
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
        f.hp = next;
        f.currentBar = { damage: next.max - next.current };
      });
      markDirty();
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
    // **The board (phase D):** bounds, obstacles and who stands where, now.
    const board = () =>
      makeBoard({
        bounds,
        tiles: tileList,
        units: [...fighters, ...copies].filter((f) => f.square).map((f) => ({ id: f.id, square: f.square })),
        exits: mode === 'simple' ? 'cols' : 'all',
      });
    // A fighter's new square (null: out of play — the Outside).
    const setSquare = async (f, sq) => {
      if (f.isCopy) {
        // A Copy moves as its tile; one that goes Outside is gone.
        if (!sq) return destroyCopy(f);
        const at = storedOf(sq);
        await queued(() => run('UPDATE map_tiles SET col = ?, row = ? WHERE id = ?', [at.col, at.row, f.rowId]));
        f.square = { col: sq.col, row: sq.row };
        markDirty();
        await flushStage();
        return;
      }
      await queued(async () => {
        if (mode === 'simple') {
          const rows = await all('SELECT id, lane_slot FROM scene_summons WHERE scene_id = ? AND character_id IS NOT NULL ORDER BY id', [sceneId]);
          if (f.summonId == null) return;
          const next = moveOnLane(packLane(rows, lanes), f.summonId, sq ? sq.row * 10 + sq.col : null);
          for (const [id, slot] of next) await run('UPDATE scene_summons SET lane_slot = ? WHERE id = ?', [slot ?? TRAY, id]);
        } else {
          await run('UPDATE combatants SET grid_col = ?, grid_row = ? WHERE id = ?', [sq?.col ?? null, sq?.row ?? null, f.id]);
        }
      });
      f.square = sq ? { col: sq.col, row: sq.row } : null;
      // A move shows at once (decided): every step of an Action, one by one.
      markDirty();
      await flushStage();
    };
    // World of Cardboard: a Wall smashed into Rubble.
    const smashWall = async (sq) => {
      const at = storedOf(sq);
      await queued(async () => {
        await run("DELETE FROM map_tiles WHERE scene_id = ? AND mode = ? AND col = ? AND row = ? AND kind = 'wall'", [sceneId, mode, at.col, at.row]);
        const has = await one("SELECT id FROM map_tiles WHERE scene_id = ? AND mode = ? AND col = ? AND row = ? AND kind = 'rubble'", [sceneId, mode, at.col, at.row]);
        if (!has) await run("INSERT INTO map_tiles (scene_id, mode, col, row, kind) VALUES (?, ?, ?, ?, 'rubble')", [sceneId, mode, at.col, at.row]);
      });
      for (let i = tileList.length - 1; i >= 0; i--) if (tileList[i].kind === 'wall' && tileList[i].col === sq.col && tileList[i].row === sq.row) tileList.splice(i, 1);
      if (!tileList.some((t) => t.kind === 'rubble' && t.col === sq.col && t.row === sq.row)) tileList.push({ col: sq.col, row: sq.row, kind: 'rubble' });
      walls.delete(`${sq.col},${sq.row}`);
      markDirty();
    };
    const setDizzy = (f) => (f.isCopy ? null : queued(() => run('UPDATE combatants SET dizzy = 1 WHERE id = ?', [f.id])).then(() => (f.dizzy = true)));

    // ---- obstacles (phase E): placing, destroying, replacing (mapTiles.js stacking rules)
    const kindsAtSq = (sq) => tileList.filter((t) => t.col === sq.col && t.row === sq.row).map((t) => t.kind);
    const writeKinds = async (sq, kinds) => {
      const at = storedOf(sq);
      await queued(async () => {
        await run("DELETE FROM map_tiles WHERE scene_id = ? AND mode = ? AND col = ? AND row = ? AND kind != 'copy'", [sceneId, mode, at.col, at.row]);
        for (const kind of kinds) await run('INSERT INTO map_tiles (scene_id, mode, col, row, kind) VALUES (?, ?, ?, ?, ?)', [sceneId, mode, at.col, at.row, kind]);
      });
      for (let i = tileList.length - 1; i >= 0; i--) if (tileList[i].col === sq.col && tileList[i].row === sq.row) tileList.splice(i, 1);
      for (const kind of kinds) tileList.push({ col: sq.col, row: sq.row, kind });
      for (const [kind, set] of [['trap', traps], ['wall', walls], ['pit', pits]]) {
        const k = `${sq.col},${sq.row}`;
        if (kinds.includes(kind)) set.add(k);
        else set.delete(k);
      }
      fogSquares.splice(0, fogSquares.length, ...tileList.filter((t) => t.kind === 'fog').map((t) => ({ col: t.col, row: t.row })));
      markDirty();
    };
    // `by`: who destroyed it, if anyone did (phase G: Zombie and Crystal Style).
    const destroyCopy = async (c, by = null) => {
      if (!c.square && !copies.includes(c)) return;
      await queued(() => run('DELETE FROM map_tiles WHERE id = ?', [c.rowId]));
      const i = copies.indexOf(c);
      if (i >= 0) copies.splice(i, 1);
      c.square = null;
      markDirty();
      countDestroyed(by);
      const env = world.env;
      const owner = byId(c.ownerId);
      if (!env || !owner) return;
      await emitEvent(env, 'self.copy_destroyed', owner, { copy: c, attacker: by });
      if (by && !by.isCopy && by.side !== owner.side) await emitEvent(env, 'enemy.destroyed_own_copy', by, { copy: c, attacker: by }, 0, (l) => l.id === owner.id);
    };
    // "Obstacles you destroyed this turn" (Collateral Style).
    const countDestroyed = (by) => {
      if (!by || by.isCopy || !world.env) return;
      const flags = fighterRt(world.env.rt, by.id).flags;
      flags.obstaclesDestroyed = (flags.obstaclesDestroyed ?? 0) + 1;
    };
    // Squares within a range of `from` (for space selectors): the board's own,
    // or — with no known edge — those the range can reach.
    const radiusOf = (from, range) =>
      range?.mode === 'adjacent' ? 1 : range?.mode === 'explicit' ? Number(range.maximum) || 1 : Math.max(1, from.stance?.range?.maximum ?? 2) + 6;
    const squaresNear = (from, range) => {
      if (!from?.square) return [];
      const r = radiusOf(from, range);
      const out = [];
      for (let dc = -r; dc <= r; dc++) {
        for (let dr = -r; dr <= r; dr++) {
          const sq = { col: from.square.col + dc, row: from.square.row + dr };
          if (bounds && !(sq.col >= bounds.colMin && sq.col <= bounds.colMax && sq.row >= bounds.rowMin && sq.row <= bounds.rowMax)) continue;
          out.push(sq);
        }
      }
      return out;
    };

    // **Range and sight now (phase G):** the Stance's range with the range
    // modifiers in effect (and "this Action's +X" carried as `rangeBonus`);
    // Walls and Fog ignored for sight where a modifier says so.
    const modsOf = (f) => (f && !f.isCopy && world.env ? modifiersOn(byId(f.id) ?? f, world, patdContent(), world.env.rt.temps) : []);
    const rangeOf = (f) => (f?.isCopy ? f.stance?.range : effectiveRange(f?.stance?.range, modsOf(f), f?.rangeBonus ?? 0));
    const sightOf = (f) => {
      const ignore = listMod(modsOf(f), 'sight.ignore');
      return { walls: ignore.includes('walls') ? new Set() : walls, fogged: ignore.includes('fog') ? () => false : fogged };
    };

    const world = {
      context: { healValue: weight.heal, bleedValue: weight.bleed, round: fight.round },
      fighters: () => fighters,
      enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
      alliesOf: (f) => fighters.filter((x) => x.side === f.side),
      inRange: (from, to, range) => {
        const r = rangeOf(from);
        const sight = sightOf(from);
        // "Within range of you or your Copies" (phase E): from any of them.
        if (range?.mode === 'self_or_copies_range') {
          const origins = [from, ...copies.filter((c) => c.ownerId === from.id)];
          return origins.some((o) => targetable({ from: o.square, to: to.square, range: { mode: 'stance' }, stanceRange: r, ...sight, enemy: from.side !== to.side }));
        }
        // "Each enemy adjacent to any of your Copies" (Zombie Style — phase G).
        if (range?.mode === 'adjacent_to_any_own_copy') {
          return Boolean(to.square) && copies.some((c) => c.ownerId === from.id && c.square && gridDistance(c.square, to.square) === 1);
        }
        return targetable({ from: from.square, to: to.square, range, stanceRange: r, ...sight, enemy: from.side !== to.side });
      },
      heldTokens: (f) => ({ ...f.tokens }),
      // Copies hold no tokens, Shields or HP (book p.71): those do nothing to them.
      // `giver`: whoever's rule gave them (phase G events).
      gainTokens: async (f, key, n, giver = null) => {
        if (f.isCopy || !TOKEN_BY_KEY[key] || key === 'challenge') return null;
        let amount = Math.max(0, Number(n) || 0);
        if (key === 'speed') {
          // Caged Style's neighbours can't gain Speed (phase G).
          if (modsOf(f).some((m) => m.rule === 'speed_tokens.cannot_gain_or_spend')) return null;
          // "When you gain Speed, replace half with Power / Iron" (Power, Iron Form).
          const ev = { amount, replace: null };
          if (world.env) await emitEvent(world.env, 'self.gain_speed_tokens', f, ev);
          if (ev.replace?.to && ev.replace.amount > 0) {
            const r = Math.min(amount, ev.replace.amount);
            amount -= r;
            await writeTokens(f, (t) => (t[ev.replace.to] = Math.min(capOf(ev.replace.to), (t[ev.replace.to] ?? 0) + r)));
          }
        }
        if (!amount) return null;
        const out = await writeTokens(f, (t) => (t[key] = Math.min(capOf(key), (t[key] ?? 0) + amount)));
        if (world.env) {
          const toEnemy = giver && !giver.isCopy && giver.side !== f.side;
          if (toEnemy) await emitEvent(world.env, 'self.tokens_given_to_enemy', giver, { target: f, token: key, amount });
          if (toEnemy && key === 'weakness') await emitEvent(world.env, 'self.weakness_given_to_enemy', giver, { target: f, amount });
          // "When an enemy you can see gains Basic tokens" (Ego Freestyle).
          if (BASIC_TOKENS.has(key)) await emitEvent(world.env, 'visible_enemy.gain_basic_tokens', f, { target: f, token: key, amount });
        }
        return out;
      },
      discardTokens: async (f, keys, n) => {
        if (f.isCopy) return 0;
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
      gainShield: (f, v) => (f.isCopy ? null : writeTokens(f, (t) => (t.shield = Math.min(capOf('shield'), Math.max(Number(v) || 0, (t.shield ?? 0) + 1))))),
      // Temporary Armor is binary (book p.24): you have it or you don't.
      tempArmor: (f) => (f.isCopy ? null : writeTokens(f, (t) => (t.temp_armor = 1))),
      heal: async (f, n) => {
        if (f.isCopy) return 0;
        const r = await changeHp(f, Math.max(0, Number(n) || 0));
        const healed = r.before ? Math.max(0, (f.hp?.current ?? 0) - r.before.current) : 0;
        if (healed > 0 && world.env) await emitEvent(world.env, 'self.healed', f, { amount: healed });
        // What it really healed (a limit of "3 HP per turn" counts this).
        return r.before ? healed : n;
      },
      payHp: (f, n) => {
        if (f.isCopy) return null;
        // "HP you have lost this turn" counts HP paid too (Karma — phase H).
        if (world.env) {
          const flags = fighterRt(world.env.rt, f.id).flags;
          flags.hpLost = (flags.hpLost ?? 0) + Math.max(0, Number(n) || 0);
        }
        return changeHp(f, -Math.max(0, Number(n) || 0));
      },
      // **Damage (phase C):** the whole Damage Resolution — Weakness, Power,
      // Iron, Shield, Armor — with its prompts and events (engine/hits.js).
      // opts: { source: 'action' | 'ability' | 'super' | 'trap' | 'fall' |
      // 'burning', ignore, allowIron, mods, unblockable, power, emit }.
      damage: async (f, n, attacker = null, opts = {}) => {
        // A Copy has 1 HP: any damage destroys it.
        if (f.isCopy) {
          if (!(Number(n) > 0)) return { taken: 0, steps: [], immune: false };
          await destroyCopy(f, attacker);
          return { taken: 1, toHp: 1, dealt: 1, steps: ['the Copy is destroyed'], destroyed: true };
        }
        return hits.resolveHit(world.env, { writeTokens, changeHp, bleedCheck, inPit }, f, n, attacker, opts);
      },
      // **Obstacles (phase E).** The legal squares for a placement, the obstacles
      // in range, and the changes — all by the book's stacking (mapTiles.js).
      mode,
      spaces: (from, range, { empty = false } = {}) => {
        const b = board();
        return squaresNear(from, range).filter(
          (sq) => (!empty || isEmptyAt(b, sq)) && targetable({ from: from.square, to: sq, range, stanceRange: rangeOf(from), ...sightOf(from), enemy: false })
        );
      },
      obstacles: (from, range, { types = null } = {}) => {
        const list = [
          ...tileList.filter((t) => OBSTACLE_KINDS.has(t.kind)).map((t) => ({ id: `${t.col},${t.row}:${t.kind}`, isObstacle: true, kind: t.kind, name: t.kind[0].toUpperCase() + t.kind.slice(1), square: { col: t.col, row: t.row } })),
          ...copies.map((c) => Object.assign(c, { kind: 'copy' })),
        ];
        return list.filter(
          (o) => o.square && (!types || types.includes(o.kind)) && targetable({ from: from.square, to: o.square, range, stanceRange: rangeOf(from), ...sightOf(from), enemy: false })
        );
      },
      copies: () => copies,
      canPlace: (kind, sq) => {
        const b = board();
        if (!inBoundsAt(b, sq)) return false;
        // Rubble and Walls fill a space: not onto a fighter or a Copy.
        if ((kind === 'wall' || kind === 'copy') && occupantAt(b, sq) != null) return false;
        if (kind === 'copy') return isEmptyAt(b, sq);
        return placeTile(kindsAtSq(sq), kind).includes(kind);
      },
      placeObstacle: async (kind, sq, owner = null) => {
        if (kind === 'copy') {
          if (!owner) return null;
          const at = storedOf(sq);
          let id = null;
          await queued(async () => {
            const r = await run("INSERT INTO map_tiles (scene_id, mode, col, row, kind, owner_id) VALUES (?, ?, ?, ?, 'copy', ?)", [sceneId, mode, at.col, at.row, owner.id]);
            id = Number(r?.lastInsertRowid);
          });
          const c = copyOf({ id, col: at.col, row: at.row, owner_id: owner.id, kind: 'copy' });
          if (c) copies.push(c);
          markDirty();
          return c;
        }
        await writeKinds(sq, placeTile(kindsAtSq(sq), kind));
        return { isObstacle: true, kind, square: { col: sq.col, row: sq.row }, name: kind };
      },
      // Destroyed: a Wall becomes Rubble, anything else is gone (a Copy too).
      // `by`: who did it (counted for "obstacles you destroyed this turn").
      destroyObstacle: async (o, by = null) => {
        if (o.isCopy) return destroyCopy(o, by);
        const kinds = kindsAtSq(o.square);
        await writeKinds(o.square, o.kind === 'wall' ? placeTile(removeTile(kinds, 'wall'), 'rubble') : removeTile(kinds, o.kind));
        countDestroyed(by);
      },
      replaceObstacle: async (o, to, by = null) => {
        const sq = { col: o.square.col, row: o.square.row };
        if (o.isCopy) await destroyCopy(o, by);
        await writeKinds(sq, placeTile(o.isCopy ? kindsAtSq(sq) : removeTile(kindsAtSq(sq), o.kind), to));
      },
      // A modifier until its duration ends (engine/runtime.js), e.g. Take Aim.
      addTemp: (temp) => addTemp(world.env.rt, temp),
      // A delayed effect (phase G): run at that moment by runTurn.
      schedule: (item) => {
        const rt = world.env.rt;
        (rt.scheduled ??= []).push({ ...item, seq: rt.turnSeq ?? 0, round: rt.round });
      },
      // **Giving a Challenge (book pp.9, 25, 78).** Never to someone already
      // holding yours, or who discarded yours this turn. Their Shield may block
      // it (1 Shield), unless it is Unblockable by Shields (the Angel's,
      // Showdown) or their Shield already took this Action's damage; someone
      // holding another Challenge picks whose to keep. → { given, blocked, why }
      challenge: async (target, challenger, opts = {}) => {
        if (!target || !challenger || target.isCopy) return { given: false, why: 'not a fighter' };
        if (target.challengeId === challenger.id) return { given: false, why: `${target.name} already holds ${challenger.name}'s Challenge` };
        const env = world.env;
        const askOf = (f, request) => (env ? ask(f, env.key, env.gen, env.tg, env.when)(request) : Promise.resolve(null));
        if (env && (fighterRt(env.rt, target.id).flags.discardedChallengeOf ?? []).includes(challenger.id)) {
          return { given: false, why: `${target.name} discarded ${challenger.name}'s Challenge this turn` };
        }
        const cm = [...modsOf(challenger), ...(opts.mods ?? []).filter((m) => m.targetId === challenger.id)];
        const ub = unblockableSet(listMod(cm, 'unblockable'), listMod(cm, 'challenge.unblockable'), opts.unblockable ?? []);
        const shield = target.tokens.shield ?? 0;
        const shieldOk = shield > 0 && !ub.has('shields') && !opts.shieldSpent && !hasMod(modsOf(target), 'shield.disabled') && (target.prefs?.shield ?? 'auto') !== 'never';
        if (env && shieldOk) {
          const block = Boolean(
            await askOf(target, {
              kind: 'confirm',
              title: 'Shield',
              text: `${challenger.name} Challenges ${target.name}. Block the Challenge with your Shield (${shield} → ${shield - 1})? This Action's damage then gets past it.`,
            })
          );
          if (block) {
            await writeTokens(target, (t) => (t.shield = Math.max(0, (t.shield ?? 0) - 1)));
            const payload = { attacker: challenger, amount: 1, shieldBroke: shield === 1, target, enemy: challenger };
            await emitEvent(env, 'self.shield_absorbed', target, payload);
            if (challenger.side !== target.side) await emitEvent(env, 'self.shield_absorbed_from_enemy_action', target, payload);
            return { given: false, blocked: true };
          }
        }
        // Holding another Challenge: they choose whose to keep (the new one was given either way).
        const old = target.challengeId != null ? byId(target.challengeId) : null;
        if (old && env) {
          const keep = await askOf(target, {
            kind: 'choose',
            title: 'Challenge',
            text: `${target.name} holds ${old.name}'s Challenge and is given ${challenger.name}'s. Keep whose?`,
            options: [
              { id: 'new', label: `${challenger.name}'s` },
              { id: 'old', label: `${old.name}'s` },
            ],
            minimum: 1,
            maximum: 1,
          });
          if ((Array.isArray(keep) ? keep[0] : keep) === 'old') return { given: true, kept: false };
        }
        await queued(() => run('UPDATE combatants SET challenge_id = ? WHERE id = ?', [challenger.id, target.id]));
        target.challengeId = challenger.id;
        markDirty();
        return { given: true, kept: true };
      },
      // **Discarding a held Challenge (decided: a Unique token).** Never while
      // the holder is under "challenge.cannot_discard" (Showdown), nor by the
      // Challenger's enemies when the Challenger's are immune (Distracting Style).
      challengeRemovable: (holder, by) => {
        if (holder?.challengeId == null) return false;
        if (hasMod(modsOf(holder), 'challenge.cannot_discard')) return false;
        const challenger = byId(holder.challengeId);
        if (challenger && by && by.side !== challenger.side && hasMod(modsOf(challenger), 'own_challenges.immune_to_enemy_action_or_ability_removal')) return false;
        return true;
      },
      // Discards it; by the Challenger's enemy, the Challenger's "if an enemy
      // discards your Challenge token" rules run (`event.formerHolder`).
      removeChallenge: async (holder, by) => {
        if (!world.challengeRemovable(holder, by)) return false;
        const challengerId = holder.challengeId;
        const challenger = byId(challengerId);
        await queued(() => run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [holder.id, challengerId]));
        holder.challengeId = null;
        markDirty();
        if (world.env) {
          const flags = fighterRt(world.env.rt, holder.id).flags;
          flags.discardedChallengeOf = [...(flags.discardedChallengeOf ?? []), challengerId];
          if (challenger && by && by.side !== challenger.side) {
            await emitEvent(world.env, 'enemy.removed_own_challenge_by_enemy_action_or_ability', by, { formerHolder: holder, remover: by, challenger }, 0, (l) => l.id === challenger.id);
          }
        }
        return true;
      },
      // Onto the fighter's active turn board (phase B); held numbers outside a turn come in phase F.
      addPoolNumber: (f, v) => world.changePool(f, (d) => addPoolValue(d, v, 'ability')),
      // **The Action Pool (phase H):** the live numbers of a fighter's active
      // board, and changes to it (engine/actions.js changePool).
      // **Actions performed by rules (phase H: `perform_action`):** the Actions
      // a fighter's current Stance gives (`gunslinger`, `unique`, `dice` only),
      // and performing one without its cost, with `rating` for Gates and X.
      actionsFor: (f, { gunslinger = false, unique = false, dice = false } = {}) => {
        const owner = f?.isCopy ? byId(f.ownerId) : f;
        if (!owner?.derived) return [];
        const t = turnActions(owner.derived, owner.stance, idx);
        const personal = t.personal.flatMap((g) => g.ids);
        const ids = unique ? personal : [...t.basic, ...personal];
        return [...new Set(ids)].map((id) => idx.get(id)).filter((a) => a && (!gunslinger || (a.tags ?? []).includes('gunslinger')) && (!dice || hasDiceCost(a)));
      },
      performAction: async (actor, actionId, { rating = 4 } = {}) => {
        const env = world.env;
        if (!env || (env.performDepth ?? 0) >= 3) return { ok: false, lines: [], manual: ['too many Actions inside Actions'] };
        env.performDepth = (env.performDepth ?? 0) + 1;
        try {
          return await runner.performFree(env, fight, actor.isCopy ? byId(actor.ownerId) : actor, actionId, rating);
        } finally {
          env.performDepth -= 1;
        }
      },
      pool: (f) => (f?.isCopy ? [] : livePool(boards.get(f.id))),
      changePool: async (f, change) => {
        if (!f || f.isCopy) return null;
        const d = await runner.changePool(f.id, change);
        if (d) boards.set(f.id, d);
        return d;
      },
      // **Movement (phase D):** engine/moves.js, with the squares picked by people.
      move: (f, opts) => moves.actionMove(world.env, movers, f, opts),
      teleport: (f, opts) => moves.teleport(world.env, movers, f, opts),
      teleportTo: (f, sq) => moves.teleportTo(world.env, movers, f, sq),
      forced: (f, opts) => moves.forced(world.env, movers, f, opts),
      swap: (a, b) => moves.swap(world.env, movers, a, b),
    };
    const movers = { mode, board, setSquare, smashWall, setDizzy, inPit, writeTokens, copies };
    const onTrap = (f) => f.square != null && traps.has(`${f.square.col},${f.square.row}`);
    return { world, fighters, byId, onTrap, weight, movers };
  }

  // Build Abilities are Unblockable (book p.26): the builds marked so in the content.
  const buildUnblockable = (idx) => new Set((idx.content.builds ?? []).filter((b) => b.unblockable).flatMap((b) => b.abilityIds ?? []));

  // ---- running one fighter's rules for some events
  async function runFor(fighter, events, env, eventPayload = null, depth = 0) {
    const idx = patdContent();
    // Their Abilities are disabled for now (Synchro Breaker — phase J).
    if (abilitiesOff(fighter.id, env.rt.temps)) return;
    // Triggers registered for a while (phase G: `register_trigger`), as rules of their source.
    for (const t of env.rt.temps.filter((x) => x.trigger && x.ownerId === fighter.id && x.trigger.events.some((e) => events.includes(e)))) {
      if (stale(env)) return;
      const ability = idx.get(t.source) ?? { id: t.source, name: 'Trigger', rulesText: '' };
      await runOne(fighter, ability, { id: `${t.source}:registered`, events: t.trigger.events, effect: t.trigger.effect }, env, eventPayload, depth);
    }
    for (const abilityId of fighter.abilityIds) {
      if (stale(env)) return;
      // Built into the engine itself (phase F): Control's Copy / Dodge / Parry
      // (engine/actions.js) and Chaos's "as if you spent a 4" (reaction boards).
      if (ENGINE_NATIVE.has(abilityId)) continue;
      const ability = idx.get(abilityId);
      for (const rule of ability?.rules ?? []) {
        if (!rule.events.some((e) => events.includes(e))) continue;
        // Iron Form's extra Iron is the damage step's own (engine/hits.js).
        if (isIronAnySource(rule)) continue;
        await runOne(fighter, ability, rule, env, eventPayload, depth);
      }
    }
  }

  // One rule of one fighter's Ability: by hand if the engine can't do it, else
  // run — with what it did as a grey notice. `captured`: values a delayed
  // effect took when it was scheduled (phase G).
  async function runOne(fighter, ability, rule, env, eventPayload, depth, captured = null) {
    const idx = patdContent();
    const support = ruleSupport(rule);
    if (!support.ok) {
      await postCard('reminder', {
        title: `${ability.name} — by hand`,
        text: ability.rulesText,
        fighters: [{ name: fighter.name }],
        automatic: 'ability_manual',
      });
      return;
    }
    const lines = [];
    const ctx = {
      world: env.world,
      self: fighter,
      state: env.stateOf(fighter.id),
      usage: env.usage,
      ability,
      event: eventPayload,
      captured,
      // "Per Action" limits count within the current Action (phase H).
      actionSeq: env.rt.actionSeq ?? 0,
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
    // What's moving people right now, for the square picks' titles ("One-Two Form (Move 2)").
    const prevSource = env.source;
    env.source = ability.name;
    try {
      await runRule(rule, ctx);
    } catch (err) {
      lines.push(`stopped: ${err.message}`);
    } finally {
      env.source = prevSource;
    }
    if (lines.length) {
      // Done for you: a notice (grey, fades fast — decided).
      await postCard('reminder', { title: ability.name, text: `${lines.join('; ')}.`, fighters: [{ name: fighter.name }], automatic: 'ability', notice: true });
      await emitStageUpdated();
    }
  }

  // **Delayed effects (phase G: `schedule`).** "At the end of this turn …",
  // "at the start of your next turn …": run at that moment by their owner,
  // with the values they captured when scheduled (a fighter or Copy by id).
  async function runScheduled(env, at, pick) {
    const rt = env.rt;
    const due = (rt.scheduled ?? []).filter((s) => s.at === at && pick(s));
    if (!due.length) return;
    rt.scheduled = rt.scheduled.filter((s) => !due.includes(s));
    const idx = patdContent();
    for (const s of due) {
      if (stale(env)) return;
      const owner = env.world.fighters().find((f) => f.id === s.ownerId);
      if (!owner) continue;
      const ability = idx.get(s.source) ?? { id: s.source, name: 'Delayed effect', rulesText: '' };
      const captured = rehydrate(env.world, s.captured);
      await runOne(owner, ability, { id: `${s.source}:scheduled`, events: [at], effect: s.effect }, env, s.event ?? null, 0, captured);
    }
  }
  // A captured value back as the live object: `{ ref: id }` → that fighter or Copy.
  const rehydrate = (world, v) => {
    if (Array.isArray(v)) return v.map((x) => rehydrate(world, x));
    if (v && typeof v === 'object') {
      if ('ref' in v && Object.keys(v).length === 1) return world.fighters().find((f) => String(f.id) === String(v.ref)) ?? (world.copies?.() ?? []).find((c) => String(c.id) === String(v.ref)) ?? null;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rehydrate(world, x)]));
    }
    return v;
  };

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
  // Scrambling Style says its floor as a rule on `end_phase.speed_discard`: read as a modifier of the owner.
  const endPhaseRule = (env, f, rule) => {
    const idx = patdContent();
    const own = f.abilityIds.flatMap((id) => (idx.get(id)?.rules ?? []).filter((r) => r.events.includes('end_phase.speed_discard')).flatMap((r) => modifyNodes(r.effect)));
    const hit = own.filter((n) => n.rule === rule && (!n.target || n.target.ref === 'self'));
    const v = valueOf(modifiersOn(f, env.world, idx, env.rt.temps), rule, null);
    return hit.length ? hit[hit.length - 1].value : v;
  };
  const modifyNodes = (e) => (!e || typeof e !== 'object' ? [] : e.op === 'modify_rule' ? [e] : e.op === 'sequence' ? (e.steps ?? []).flatMap(modifyNodes) : []);

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
    // Copies on a Trap are destroyed by its damage (book p.71; phase E).
    for (const c of [...(env.world.copies?.() ?? [])].filter(onTrap)) {
      await env.world.damage(c, 1, null, { source: 'trap' });
      notices.push(`${c.name}: Trap, destroyed`);
    }
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
    const { world, fighters, byId, onTrap, movers } = await buildWorld(fightRow);
    const env = {
      key,
      gen: gen(key),
      tg: tg ?? turnGen(key),
      when: null,
      world,
      rt,
      usage: rt.usage,
      stateOf: (id) => fighterRt(rt, id).state,
      // Saved, the board shows what the runtime knows too (Armor used this turn …).
      save: async () => {
        if (gen(key) !== env.gen) return null;
        await saveRuntime(fightRow.id, rt);
        markDirty();
        await flushStage();
      },
    };
    world.env = env;
    // This turn so far (phase G), from the runtime's per-turn flags.
    const flag = (f, k) => fighterRt(rt, f.id).flags[k];
    for (const f of fighters) {
      Object.defineProperties(f, {
        performedActionThisTurn: { get: () => (flag(f, 'actions') ?? 0) > 0, enumerable: false, configurable: true },
        tookDamageThisTurn: { get: () => Boolean(flag(f, 'tookDamage')), enumerable: false, configurable: true },
        obstaclesDestroyedThisTurn: { get: () => flag(f, 'obstaclesDestroyed') ?? 0, enumerable: false, configurable: true },
        hpLostThisTurn: { get: () => flag(f, 'hpLost') ?? 0, enumerable: false, configurable: true },
      });
    }
    return { env, world, fighters, byId, onTrap, movers };
  };

  // Start of combat: Improved Warrior gives the Warrior's Path's benefit (its
  // rule is text only in the content, so it is matched by id here).
  async function runFightStart(fightRow) {
    const { env, fighters } = await envFor(fightRow);
    for (const f of fighters) {
      if (f.abilityIds.includes(IMPROVED_WARRIOR)) await runFor(f, ['warrior_path.trigger'], env, {});
    }
    // **Lasting rules left to people (phase J):** each fighter's continuous
    // rules the engine doesn't enforce, said once at the start of the fight,
    // so nothing is dropped silently (lib/patd/coverage.js).
    // One card per Ability, with its rules text — the reminder itself (decided, fix).
    const idx = patdContent();
    for (const f of fighters) {
      const ids = [...new Set(f.abilityIds)].filter((id) => !ENGINE_NATIVE.has(id) && (idx.get(id)?.rules ?? []).some((r) => r.events?.includes('continuous') && !continuousSupport(r).ok));
      for (const id of ids) {
        const ability = idx.get(id);
        await postCard('reminder', {
          title: `${ability.name} — by hand all fight`,
          text: ability.rulesText,
          fighters: [{ name: f.name }],
          automatic: 'ability_manual',
        });
      }
    }
    await env.save();
  }

  // Start or end of the active fighter's turn: everyone's matching rules.
  // opts.dizzyIds: who was Dizzy when the turn ended (fights.js clears it right after).
  // **The Comeback rule (phase F, book p.63).** Someone removed from play may
  // re-enter on any empty space within 3 of the arena's edge: free at the
  // start of a Round, for 3 HP at the start of their own turn. A square pick
  // with a Skip; Stooges never come back.
  async function comeback(env, movers, f, { free }) {
    if (f.square || f.derived?.type?.id === 'character-type.stooges') return false;
    if (!free && !((f.hp?.current ?? 0) >= 3)) return false;
    const b = movers.board();
    const squares = comebackSquares(b.bounds, (sq) => isEmptyAt(b, sq), { colsOnly: movers.mode === 'simple' });
    if (!squares.length) return false;
    const ans = await ask(f, env.key, env.gen, env.tg, env.when)({
      kind: 'square',
      mode: movers.mode,
      title: 'Comeback',
      text: free ? `${f.name}: a new Round — come back into play near the edge?` : `${f.name}: pay 3 HP to come back into play near the edge? (Otherwise, Heroic Spirit.)`,
      options: squares.map((sq) => ({ id: `${sq.col},${sq.row}`, label: `${sq.col},${sq.row}`, col: sq.col, row: sq.row })),
      minimum: 0,
      maximum: 1,
    });
    const id = Array.isArray(ans) ? ans[0] : ans;
    const sq = squares.find((x) => `${x.col},${x.row}` === id);
    if (!sq) return false;
    if (!free) await env.world.payHp(f, 3);
    await movers.setSquare(f, sq);
    await postCard('reminder', { title: 'Comeback', text: `${f.name} comes back into play${free ? '' : ' for 3 HP'}.`, fighters: [{ name: f.name }], automatic: 'movement', notice: true });
    return true;
  }

  // **Heroic Spirit (phase F, book p.63):** a Taken Out active fighter gives
  // their turn — the dice they rolled — to an ally in play, who takes it in
  // their current Stance (the board's `heroic`).
  async function heroicSpirit(env, active) {
    if (active.square && !atZero(active.hp)) return;
    const allies = env.world.alliesOf(active).filter((a) => a.id !== active.id && a.square && !atZero(a.hp));
    if (!allies.length) return;
    const ans = await ask(active, env.key, env.gen, env.tg, env.when)({
      kind: 'targets',
      title: 'Heroic Spirit',
      text: `${active.name} is Taken Out: give your turn — your dice — to an ally.`,
      options: allies.map((a) => ({ id: String(a.id), label: a.name })),
      minimum: 1,
      maximum: 1,
    });
    const ally = allies.find((a) => String(a.id) === String(Array.isArray(ans) ? ans[0] : ans)) ?? allies[0];
    const board = await one('SELECT * FROM dice_marks WHERE combatant_id = ? AND active = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1', [active.id]);
    if (!board) return;
    const data = readBoardData(board);
    data.heroic = { combatantId: ally.id, characterId: ally.characterId, stanceKey: ally.stance?.key ?? null, stanceName: ally.stance?.name ?? null, name: ally.name, fromId: active.id };
    if (ally.stance?.key) data.stanceKey = ally.stance.key;
    await queued(() => saveBoard(board.roll_id, data, (ev, p) => io.emit(ev, p)));
    // "When you give your Heroic Spirit" (the Teacher's Mentor tokens …).
    await emitEvent(env, 'self.giving_heroic_spirit', active, { ally });
    await postCard('reminder', { title: 'Heroic Spirit', text: `${active.name} gives their turn to ${ally.name}.`, fighters: [{ name: active.name }, { name: ally.name }], automatic: 'ability', notice: true });
  }

  async function runTurn(fightRow, activeId, moment, tg, opts = {}) {
    const { env, world, fighters, byId, onTrap, movers } = await envFor(fightRow, tg);
    for (const f of fighters) if (opts.dizzyIds?.includes(f.id)) f.dizzy = true;
    const rt = env.rt;
    // Turn boundaries (engine/runtime.js): a new round expires its temporaries
    // and resets per-round counters; a turn start resets per-turn counters and
    // flags and expires "until your next turn" temporaries.
    let newRound = false;
    if (moment === 'start') {
      newRound = fightRow.round !== rt.round;
      if (newRound) expireTemps(rt, 'end_of_round');
      startTurn(rt, activeId, fightRow.round);
      expireTemps(rt, 'start_of_turn', { activeId });
    }
    const active = byId(activeId);
    if (!active) return env.save();
    if (moment === 'start') {
      env.when = `Start of ${active.name}'s turn`;
      // A new Round: everyone out of play may come back for free; then the
      // active fighter, if still out, for 3 HP.
      if (newRound) for (const f of fighters) await comeback(env, movers, f, { free: true });
      await comeback(env, movers, active, { free: false });
    }
    // Where the turn began (the End Phase's Fatigue: "did not move").
    if (moment === 'start') fighterRt(rt, active.id).flags.startSquare = active.square ?? null;
    env.when = `${moment === 'start' ? 'Start' : 'End'} of ${active.name}'s turn`;
    world.context.activeCharacter = active;
    // "At the start of your next turn …" effects scheduled earlier (phase G).
    if (moment === 'start') await runScheduled(env, 'next_turn.start', (s) => s.ownerId === active.id && s.seq < rt.turnSeq);
    const order = [active, ...fighters.filter((f) => f.id !== active.id)];
    for (const f of order) await runFor(f, turnEvents(moment, relationTo(f, active)), env, { activeCharacter: active });
    // Phase 3 of the turn: still Taken Out? Heroic Spirit.
    if (moment === 'start' && !stale(env)) await heroicSpirit(env, active);
    // "After you roll your Action Dice" (phase G): the turn's dice are on its board.
    if (moment === 'start' && !stale(env) && active.square && !atZero(active.hp)) await runFor(active, ['self.action_dice.rolled'], env, { activeCharacter: active });
    if (moment === 'end') {
      // "At the end of this turn …" effects scheduled during it, before the End Phase.
      await runScheduled(env, 'current_turn.end', () => true);
      await runEndPhase(env, fighters, onTrap, active);
      expireTemps(rt, 'end_of_turn', { activeId });
    }
    await env.save();
  }

  // **The Action Phase begins (phase G):** after Early Movement, or right after
  // the turn's start when nobody moves. "At the start of the Action Phase of
  // your turn" (Wardancer).
  async function runActionPhase(fightRow, activeId) {
    const { env, world, byId } = await envFor(fightRow);
    const active = byId(activeId);
    if (!active || stale(env)) return;
    env.when = `${active.name}'s Action Phase`;
    world.context.activeCharacter = active;
    await runFor(active, ['own_action_phase.start'], env, { activeCharacter: active });
    await env.save();
  }

  // How many jobs each fight's chain holds (queued or running): an Action
  // resolving, a prompt waiting… The Interrupt lock waits for it to empty.
  const busy = new Map();
  const idleHooks = [];
  const onChain = (fightRow, job) => {
    const key = `${fightRow.scene_id}:${fightRow.mode}`;
    const g = gen(key);
    const prev = chains.get(key) ?? Promise.resolve();
    // **The "Resolving" plaque (decided, batch 4):** everyone is told when a
    // fight starts working through something and when it is all done.
    if (!(busy.get(key) > 0)) io.emit('fight:resolving', { sceneId: fightRow.scene_id, mode: fightRow.mode, busy: true });
    busy.set(key, (busy.get(key) ?? 0) + 1);
    const next = prev
      .then(() => (gen(key) === g ? job() : null))
      .catch((err) => console.error('turn triggers', err))
      .finally(() => {
        const left = (busy.get(key) ?? 1) - 1;
        if (left > 0) return busy.set(key, left);
        busy.delete(key);
        io.emit('fight:resolving', { sceneId: fightRow.scene_id, mode: fightRow.mode, busy: false });
        // The stack finished: whoever waits to Interrupt goes now.
        for (const hook of idleHooks) Promise.resolve(hook({ scene_id: fightRow.scene_id, mode: fightRow.mode })).catch((err) => console.error('idle hook', err));
      });
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
    // An Interrupt board is done after its one Reactive Action.
    reactionDone: (fight, row) => reactionDone(fight, row.combatant_id),
  });

  // **Interrupts (decided, revised — replaces the reaction windows):** every
  // fighter but the active one who can take a Reactive Action right now, with
  // what's on offer by resource (engine/turn.js reactionClusters): token
  // Actions they can pay for and whose conditions and limits allow it now
  // (Mentor's on allies' turns, "only during an enemy's turn" …), and dice
  // Actions a Chaos token can pay "as if you had spent a 4" (once per turn).
  // Taken Out or out of play: only Actions usable while Taken Out (the Mentor's).
  async function reactionOffers(fightRow, activeId, except = []) {
    const { env, fighters, byId } = await envFor(fightRow);
    const idx = patdContent();
    const active = byId(activeId);
    const offers = {};
    if (activeId == null) return offers;
    for (const f of fighters) {
      if (f.id === activeId || except.includes(f.id) || !f.derived) continue;
      const out = !f.square || atZero(f.hp);
      const t = turnActions(f.derived, f.stance, idx);
      const ids = [...t.basic, ...t.personal.flatMap((g) => g.ids)].filter((id) => !out || idx.get(id)?.usableWhileTakenOut);
      if (!ids.length) continue;
      const state = await fighterState(f.id);
      const clusters = reactionClusters({
        ids,
        idx,
        ctx: turnContext({ actorId: f.id, actorSide: f.side, activeId, activeSide: active?.side ?? null, tokens: f.tokens }),
        usage: env.rt.usage,
        fighterId: f.id,
        state,
        chaos: out ? 0 : (f.tokens.chaos ?? 0),
        chaosUsed: Boolean(fighterRt(env.rt, f.id).flags.chaosUsed),
      });
      if (clusters.length) offers[f.id] = { clusters, stanceKey: f.stance?.key ?? null, name: f.name, characterId: f.characterId };
    }
    return offers;
  }
  // The fight's active fighter (from its turn order).
  const activeOf = (fightRow) => {
    try {
      return JSON.parse(fightRow.turn_order || '[]')[fightRow.turn_index]?.id ?? null;
    } catch {
      return null;
    }
  };
  // After its one Reactive Action, an Interrupt board freezes.
  async function reactionDone(fightRow, combatantId) {
    await queued(() => run("UPDATE dice_marks SET active = 0 WHERE roll_id LIKE ? AND combatant_id = ?", [`react-${fightRow.id}-%`, combatantId]));
    await emitStageUpdated();
  }
  // Free Movement take-backs, per fighter (in memory; batch 3).
  const freeUndo = new Map(); // `${fightId}:${combatantId}` → [{ from, cost, fatigue, clean, tg }]
  const fightKeyOf = (fightRow) => `${fightRow.scene_id}:${fightRow.mode}`;
  const undoKey = (fightRow, combatantId) => `${fightRow.id}:${combatantId}`;
  const undoable = (fightRow, combatantId) => {
    const last = (freeUndo.get(undoKey(fightRow, combatantId)) ?? []).at(-1);
    return last && last.tg === turnGen(fightKeyOf(fightRow)) ? last : null;
  };
  const onBoardChain = async (rollId, job) => {
    const { fight } = await runner.fightOfBoard(rollId);
    if (fight) onChain(fight, job);
  };

  return {
    // Is an Action (or anything) resolving in this fight right now?
    isBusy(fightRow) {
      return (busy.get(`${fightRow.scene_id}:${fightRow.mode}`) ?? 0) > 0;
    },
    // The fights resolving now, for a (re)connecting viewer's plaque.
    resolvingNow() {
      return [...busy.entries()].filter(([, n]) => n > 0).map(([k]) => ({ sceneId: Number(k.split(':')[0]), mode: k.split(':')[1], busy: true }));
    },
    // Called with { scene_id, mode } whenever a fight's chain empties.
    onIdle(hook) {
      idleHooks.push(hook);
    },
    // **Interrupts:** who can take a Reactive Action now, and with what.
    // **The active fighter's attack range (decided, batch 3):** the squares
    // their Stance reaches now (modifiers, Walls and Fog's sight included).
    async activeRange(fightRow) {
      const id = activeOf(fightRow);
      if (id == null) return { combatantId: null, squares: [] };
      const { world, byId } = await envFor(fightRow);
      const f = byId(id);
      if (!f?.square || !world.spaces) return { combatantId: id, squares: [] };
      const squares = world.spaces(f, { mode: 'stance' }, {}).filter((sq) => sq.col !== f.square.col || sq.row !== f.square.row);
      return { combatantId: id, squares: squares.map((sq) => ({ col: sq.col, row: sq.row })) };
    },
    interruptOffers(fightRow) {
      return reactionOffers(fightRow, activeOf(fightRow));
    },
    // Commit the placed Actions of a turn board, in order (phase B). An Action
    // resolving ends every take-back of Free Movement in that fight.
    async commitBoard(rollId) {
      const { fight } = await runner.fightOfBoard(rollId);
      if (fight) for (const k of [...freeUndo.keys()]) if (k.startsWith(`${fight.id}:`)) freeUndo.delete(k);
      return onBoardChain(rollId, () => runner.commitBoard(rollId));
    },
    // GM: undo a committed Action and every later one.
    retrieve(rollId, key) {
      return onBoardChain(rollId, () => runner.retrieve(rollId, key));
    },
    // **Free Movement (phase D):** where a fighter can go, and going there.
    async freeReach(fightRow, combatantId) {
      const { env, byId, movers, fighters } = await envFor(fightRow);
      const f = byId(combatantId);
      const last = undoable(fightRow, combatantId);
      return {
        // The back arrow (batch 3): their last Free Movement can be taken back.
        canUndo: Boolean(last?.clean),
        mode: fightRow.mode,
        speed: f?.tokens.speed ?? 0,
        fatigued: (f?.tokens.fatigue ?? 0) > 0,
        options: f ? moves.freeReach(movers, f, env) : [],
        swaps: moves.swapsFor(fighters, f, env),
      };
    },
    // **A hand move (decided):** the Speed the cheapest Free Movement there
    // would cost (null: no way there), and the Speed they hold.
    async handCost(fightRow, combatantId, to) {
      const { env, byId, movers } = await envFor(fightRow);
      const f = byId(combatantId);
      return { cost: f ? moves.handCost(movers, f, to, env) : null, speed: f?.tokens.speed ?? 0 };
    },
    freeMove(fightRow, combatantId, to) {
      return onChain(fightRow, async () => {
        const { env, byId, movers } = await envFor(fightRow);
        env.when = 'Free Movement';
        const r = await moves.freeMove(env, movers, byId(combatantId), to);
        if (r?.undo) {
          const k = undoKey(fightRow, combatantId);
          freeUndo.set(k, [...(freeUndo.get(k) ?? []), { ...r.undo, tg: turnGen(fightKeyOf(fightRow)) }]);
        }
        await env.save();
        await emitStageUpdated();
        return r;
      });
    },
    // **The back arrow (decided, batch 3):** take back the last Free Movement —
    // back to where they stood, the Speed (and Fatigue) refunded — until an
    // Action is committed, they're Done, or the turn moves on. A move that
    // crossed a Trap or Rubble can't be taken back (its harm is done).
    undoFreeMove(fightRow, combatantId) {
      return onChain(fightRow, async () => {
        const k = undoKey(fightRow, combatantId);
        const last = undoable(fightRow, combatantId);
        if (!last) return { error: 'nothing to take back' };
        if (!last.clean) return { error: 'that move crossed a Trap or Rubble' };
        const { env, byId, movers } = await envFor(fightRow);
        const f = byId(combatantId);
        if (!f || !isEmptyAt(movers.board(), last.from, [f.id])) return { error: 'that space is taken now' };
        await movers.setSquare(f, last.from);
        await movers.writeTokens(f, (t) => {
          t.speed = (t.speed ?? 0) + last.cost;
          if (last.fatigue) t.fatigue = (t.fatigue ?? 0) + last.fatigue;
        });
        freeUndo.set(k, (freeUndo.get(k) ?? []).slice(0, -1));
        await env.save();
        await emitStageUpdated();
        return { ok: true, square: last.from, refunded: last.cost };
      });
    },
    // Done moving: nothing to take back any more.
    endFreeMoves(fightRow, combatantId) {
      freeUndo.delete(undoKey(fightRow, combatantId));
    },
    freeSwap(fightRow, combatantId, allyId) {
      return onChain(fightRow, async () => {
        const { env, byId, movers } = await envFor(fightRow);
        const r = await moves.freeSwap(env, movers, byId(combatantId), byId(allyId));
        await env.save();
        await emitStageUpdated();
        return r;
      });
    },
    // Early / Late Movement began: "at the start of any movement phase" rules.
    movementPhase(fightRow, kind, activeId) {
      return onChain(fightRow, async () => {
        const { env, byId } = await envFor(fightRow);
        const active = byId(activeId);
        if (active) await emitEvent(env, 'any_movement_phase.start', active, { phase: kind });
        await env.save();
      });
    },
    // The active fighter's Action Phase began (after Early Movement): its rules.
    actionPhase(fightRow, activeId) {
      return onChain(fightRow, () => runActionPhase(fightRow, activeId));
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
    // The board picks open now, as everyone sees them (a reconnect catches up).
    openPickViews() {
      return [...pending.values()].map((p) => pickView(p.prompt)).filter((v) => v?.options.length);
    },
  };
}

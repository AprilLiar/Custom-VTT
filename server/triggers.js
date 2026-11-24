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
import { inBounds as inBoundsAt, isEmpty as isEmptyAt, makeBoard, nearestCells, neighbors as sideSquares, occupant as occupantAt } from '../client/src/lib/patd/engine/board.js';
import { BELT_DIRS, CONTROL_SIDE, OBSTACLES as OBSTACLE_KINDS, TILE_BY_KEY, placeTile, placementBarred, removeTile } from '../client/src/lib/mapTiles.js';
import { cellBounds, imageSize } from './imageSize.js';
import { sceneGrid } from './combatMap.js';
import { evalValue, gridDistance, ruleSupport, runRule, targetable } from '../client/src/lib/patd/interpreter.js';
import { controlsCharacter } from './control.js';
import { hpOf, saveHp, serialized, shapeFightState } from './combatState.js';
import { assembles, derivedFor, franticPickOf } from './fighterStances.js';
import { armorSourcesOf, franticOptions, hasRuleIn, stanceOfBuild } from '../client/src/lib/patd/build.js';
import { patdContent } from './patdContent.js';
import { listenersFor, relationTo, turnEvents } from '../client/src/lib/patd/engine/bus.js';
import { abilitiesOff, effectiveRange, hasMod, listMod, modifiersOn, valueOf } from '../client/src/lib/patd/engine/modifiers.js';
import { addTemp, expireTemps, fighterRt, startTurn } from '../client/src/lib/patd/engine/runtime.js';
import { ironAllowance, spendPrefs, unblockableSet } from '../client/src/lib/patd/engine/damage.js';
import { loadRuntime, saveRuntime } from './engine/runtimeStore.js';
import { createActionRunner } from './engine/actions.js';
import { createHits } from './engine/hits.js';
import { createMoves } from './engine/moves.js';
import { atZero, comebackSquares, reactionClusters, superKey, turnContext } from '../client/src/lib/patd/engine/turn.js';
import { hasDiceCost } from '../client/src/lib/patd/tokenCost.js';
import { ENGINE_NATIVE, continuousSupport, isIronAnySource, isNativeRule } from '../client/src/lib/patd/coverage.js';
import { addPoolValue, livePool, setPoolValue, turnActions } from '../client/src/lib/patd/diceBoard.js';
import { fighterState, readData as readBoardData, saveBoard, setPayableHook } from './diceMarks.js';
import { muteFx, recordFx, slice, unmuteFx } from './fx.js';
import { NO_GO_ON, SIDE_LABEL, isDisarmed, leashOf, parseBattleColumn, partnerOf, tiltOn } from '../client/src/lib/battleParams.js';
import { kingOfTheHill, lastOneStanding, outlast, protectTheVip, roundsToWin, standing, tournamentRoundLoser } from '../client/src/lib/battleVictory.js';
import { updateBattle } from './battle.js';
import { keepRewindMark, rewindMark } from './rewind.js';

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
          sceneId: prompt.sceneId ?? null,
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
    // The resolve stack as it stands when a question goes out (a trigger that arose shows now).
    steps.emit(fightKey);
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
        // Which Scene's board (a Stance Contest's arena is a hidden Scene of its own).
        sceneId: Number(String(fightKey).split(':')[0]) || null,
        area: request.area ?? null,
        // Skip offered even when a pick is required (batch 4): answers '__skip'.
        skippable: Boolean(request.skippable),
        // 'actions': the options are Action ids, shown as their cards (play feedback 7).
        display: request.display ?? null,
        // With 'actions': the number they're performed at (their Gates reached light up).
        rating: Number.isFinite(request.rating) ? request.rating : null,
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

  // **Stooges:** a list with each Stooges unit kept once (its representative body).
  const unitOnce = (list) => list.filter((f) => f.stoogeUnit == null || f.stoogeRep);

  // ---- the world of one fight
  async function buildWorld(fight) {
    const { scene_id: sceneId, mode } = fight;
    const ids = new Set([...JSON.parse(fight.allies || '[]'), ...JSON.parse(fight.enemies || '[]'), ...JSON.parse(fight.renegades || '[]')]);
    // Three Way Battles: the Renegades are everyone else's enemy.
    const sideOf = (id) => (JSON.parse(fight.allies || '[]').includes(id) ? 'allies' : JSON.parse(fight.renegades || '[]').includes(id) ? 'renegades' : 'enemies');
    const rows = (await all('SELECT cb.*, c.name, c.character_type FROM combatants cb JOIN characters c ON c.id = cb.character_id WHERE cb.scene_id = ? AND cb.mode = ?', [sceneId, mode])).filter((r) => ids.has(r.id));
    const scene = await one('SELECT simple_weight, combat_weight, battle FROM scenes WHERE id = ?', [sceneId]);
    // Fight Setup's Complications and Battle Parameters (lib/battleParams.js).
    const battle = parseBattleColumn(scene?.battle)[mode];
    const weight = WEIGHT_BY_KEY[mode === 'simple' ? scene?.simple_weight : scene?.combat_weight] ?? MIDDLEWEIGHT;
    // Squares: a map cell, or a lane space as (column, lane).
    let squareOf = (r) => (r.grid_col != null ? { col: r.grid_col, row: r.grid_row } : null);
    const tiles = await all('SELECT id, col, row, kind, owner_id, placed_by FROM map_tiles WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
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
    const tileList = tiles.filter((t) => t.kind !== 'copy').map((t) => ({ ...tileSquare(t), kind: t.kind, placed_by: t.placed_by ?? null }));
    const setOf = (kind) => new Set(tileList.filter((t) => t.kind === kind).map((t) => `${t.col},${t.row}`));
    const traps = setOf('trap');
    // A Deadly Trap (the Trickster's Super Move) is a Trap that deals 3.
    const deadly = setOf('deadly_trap');
    for (const k of deadly) traps.add(k);
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
      const built = stanceOfBuild(d, state.active_stance_id, idx) ?? d?.stances.find((s) => s.formId && s.styleId) ?? null;
      // **No Stance after Dizzy (1e patch review):** Range 1, no Form or Style
      // Abilities, no Unique Actions — until their next turn.
      const stanceLost = Boolean(r.stance_lost);
      const stance = built && stanceLost ? { ...built, range: { minimum: 1, maximum: 1 }, abilityIds: [], lost: true } : built;
      // A Frantic Hero's one Frantic Ability for this turn comes with their pick.
      // (Greater Frenzy: a second Frantic Ability this turn — `abilityId2`.)
      const pick = assembles(d) ? franticPickOf(r) : null;
      const frantic = pick?.abilityId ?? null;
      const frantic2 = pick?.abilityId2 ?? null;
      // **Stooges (decided):** every body carries the unit's Abilities (a hit
      // body reacts as the unit); `stoogeRep` marks the one body that speaks
      // for the unit wherever something happens once per fighter — turn
      // moments, events heard by many, the End Phase — so nothing runs twice.
      const isStooges = r.stooge_unit != null;
      const stoogeRep = isStooges && !r.stooge_out && squareOf(r) != null && !stoogeSeen.has(r.stooge_unit);
      if (stoogeRep) stoogeSeen.add(r.stooge_unit);
      fighters.push({
        id: r.id,
        characterId: r.character_id,
        summonId: r.summon_id ?? null,
        name: r.name,
        // Stooges (decided): the unit they share everything with, and whether this body was destroyed.
        stoogeUnit: r.stooge_unit ?? null,
        stoogeOut: Boolean(r.stooge_out),
        stoogeRep,
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
        stanceLost,
        abilityIds: d ? [...new Set([...d.constantAbilityIds, ...(frantic ? [frantic] : []), ...(frantic2 ? [frantic2] : []), ...(stance?.abilityIds ?? [])])] : [],
        // The Giant fills a 2×2 block on the map (its `footprint` rule).
        size: mode === 'combat' && d && hasRuleIn(d.constantAbilityIds, 'footprint', idx) ? 2 : 1,
        // Armor from the build (always, or while this Stance is active).
        innateArmor: d ? innateArmor(armorSourcesOf(d, idx), stanceLost ? null : (stance?.key ?? null)) : 0,
      });
    }
    const byId = (id) => fighters.find((f) => f.id === id);
    // A fighter's square is also their "space" (`self.space`, `targets.x.space`).
    for (const f of fighters) Object.defineProperty(f, 'space', { get: () => f.square, enumerable: false });
    // Standing in a Wall's space (Parkour Style may; phase G).
    for (const f of fighters) Object.defineProperty(f, 'standingOnWall', { get: () => f.square != null && walls.has(`${f.square.col},${f.square.row}`), enumerable: false });
    // Standing on a Pit (Vortex Style), Taken Out (Transcendant Spirit), and
    // gone for the rest of the fight (My Final Technique) — the QA pass.
    for (const f of fighters) {
      Object.defineProperty(f, 'standingOnPit', { get: () => f.square != null && pits.has(`${f.square.col},${f.square.row}`), enumerable: false });
      Object.defineProperty(f, 'takenOut', { get: () => !f.square || atZero(f.hp), enumerable: false });
      Object.defineProperty(f, 'removedForGood', { get: () => Boolean(world.env && fighterRt(world.env.rt, f.id).fight.removedForGood), enumerable: false });
      // "While you are within Fog" (Hidden Style).
      Object.defineProperty(f, 'inFog', { get: () => f.square != null && tileList.some((t) => t.kind === 'fog' && t.col === f.square.col && t.row === f.square.row), enumerable: false });
    }
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
    // `kind`: the effect it shows as (board animations — fx.js): 'tokens', or 'shield' for a Shield gained.
    const writeTokens = async (f, change, kind = 'tokens') => {
      await queued(async () => {
        const row = await readRow(f.id);
        if (!row) return;
        const was = shapeFightState(row);
        const tokens = { ...was.tokens };
        change(tokens);
        for (const k of Object.keys(tokens)) if (!(tokens[k] > 0)) delete tokens[k];
        await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(tokens), f.id]);
        f.tokens = { ...tokens };
        const after = { ...slice(was), tokens: { ...tokens } };
        if (kind === 'shield' && !((tokens.shield ?? 0) > (was.tokens.shield ?? 0))) kind = 'tokens';
        recordFx({ sceneId, mode, kind, combatantId: f.id, before: slice(was), after, data: kind === 'shield' ? { shield: tokens.shield ?? 0 } : {} });
      });
      markDirty();
    };
    // A fighter's shown state now (board animations: a hit's before/after).
    const shownState = async (f) => slice(shapeFightState(await readRow(f.id)));
    // A hit's Shield, Iron and HP show as one "damage" beat (engine/hits.js calls these round them).
    const hitFx = {
      begin: async (f) => {
        if (f.isCopy) return null;
        const before = await shownState(f);
        muteFx(f.id);
        return before;
      },
      end: async (f, before, data) => {
        if (!before) return;
        unmuteFx(f.id);
        recordFx({ sceneId, mode, kind: 'damage', combatantId: f.id, before, after: await shownState(f), data });
      },
    };
    const vipFell = (f) => battle.victory === 'protect_the_vip' && world.env && Object.values(battle.victoryOpts?.vips ?? {}).includes(f.id);
    // **A Stooge is destroyed (decided):** out of play for good; the unit's turn,
    // and any Challenge on it, move to the next body still standing. The bar
    // empty: the whole unit is defeated, however many bodies are left.
    const stoogeHit = async (f) => {
      if (f.stoogeOut) return;
      f.stoogeOut = true;
      await queued(() => run('UPDATE combatants SET stooge_out = 1 WHERE id = ?', [f.id]));
      const unit = fighters.filter((x) => x.stoogeUnit === f.stoogeUnit && x.id !== f.id && !x.stoogeOut && x.square).sort((a, b) => a.id - b.id);
      if (f.square) await world.removeFromPlay(f, { forGood: true });
      const next = unit[0] ?? null;
      if (next) {
        await queued(async () => {
          const row = await one('SELECT turn_order FROM fights WHERE id = ?', [fight.id]);
          let order = [];
          try {
            order = JSON.parse(row?.turn_order || '[]');
          } catch {
            order = [];
          }
          if (order.some((e) => e.id === f.id)) await run('UPDATE fights SET turn_order = ? WHERE id = ?', [JSON.stringify(order.map((e) => (e.id === f.id ? { ...e, id: next.id } : e))), fight.id]);
          // Challenges the unit gave stay the unit's.
          await run('UPDATE combatants SET challenge_id = ? WHERE challenge_id = ? AND scene_id = ? AND mode = ?', [next.id, f.id, sceneId, mode]);
        });
        for (const x of fighters) if (x.challengeId === f.id) x.challengeId = next.id;
      }
      const bar = hpOf(await readRow(f.id));
      const gone = atZero(bar);
      await postCard('reminder', {
        title: 'Stooges',
        text: gone
          ? `${f.name}: the Stooges' shared Health Bar is empty — the whole unit is defeated.`
          : `A Stooge is destroyed (${unit.length} left standing; the unit's bar: ${Math.max(0, bar.current)}/${bar.max}).`,
        fighters: [{ name: f.name }],
        automatic: 'battle',
        notice: true,
      });
    };
    // Protect the VIP: who still has the first bar's +10 (battle.applied.vip, this fight only).
    const vipBonus = new Set(battle.applied?.vip?.fightId === fight.id ? battle.applied.vip.ids ?? [] : []);
    let vipSpent = false;
    const changeHp = async (f, delta) => {
      let result = { landed: null, before: null };
      await queued(async () => {
        const row = await readRow(f.id);
        if (!row) return;
        const before = hpOf(row);
        if (before.max == null) return;
        // **Infinite HP (Fight Setup):** a loss is counted, never taken — no
        // Bleed, no broken bar, never Taken Out (landed = where they stand).
        if (row.infinite_hp && delta < 0) {
          // (Stance Contests: a target's biggest single hit too.)
          await run('UPDATE combatants SET damage_taken = damage_taken + ?, damage_max = MAX(COALESCE(damage_max, 0), ?) WHERE id = ?', [-delta, -delta, f.id]);
          const was = shapeFightState(row);
          recordFx({ sceneId, mode, kind: 'damage', combatantId: f.id, before: slice(was), after: slice(was), data: { amount: -delta, infinite: true } });
          result = { before, landed: before.current, row };
          f.hp = before;
          return;
        }
        let next = applyHpDelta(before, delta).state;
        await saveHp(f.id, next);
        // **Hundred-Hand (Stance Contests):** a felled target is replaced at once —
        // counted, and back at full HP where it stood.
        if (row.dummy === 2 && delta < 0 && atZero(next)) {
          await run('UPDATE combatants SET felled = COALESCE(felled, 0) + 1 WHERE id = ?', [f.id]);
          next = { ...next, current: next.max, broken: 0, dizzy: false };
          await saveHp(f.id, next);
          delta = 0;
        }
        // Board animations: HP paid or healed (a hit records its own "damage").
        const was = shapeFightState(row);
        const shown = shapeFightState({ ...row, hp_max: next.max, hp_current: next.current, hp_bars: next.bars, hp_broken: next.broken, dizzy: next.dizzy ? 1 : 0 });
        if (delta) recordFx({ sceneId, mode, kind: delta > 0 ? 'heal' : 'damage', combatantId: f.id, before: slice(was), after: slice(shown), data: { amount: Math.abs(delta) } });
        // **Protect the VIP:** their +10 max HP is on the first bar only — gone once it breaks.
        if (next.broken > before.broken && vipBonus.has(f.id) && next.max != null) {
          vipBonus.delete(f.id);
          next.max = Math.max(1, next.max - 10);
          next.current = Math.min(next.current, next.max);
          await saveHp(f.id, next);
          vipSpent = true;
        }
        result = { before, landed: before.current + delta, row, down: !atZero(before) && atZero(next) };
        f.bleeding = next.current <= weight.bleed;
        f.dizzy = Boolean(next.dizzy);
        f.hp = next;
        f.currentBar = { damage: next.max - next.current };
      });
      markDirty();
      if (vipSpent) {
        vipSpent = false;
        await updateBattle(sceneId, mode, (bt) => {
          if (bt.applied?.vip) bt.applied.vip.ids = (bt.applied.vip.ids ?? []).filter((id) => vipBonus.has(id));
          return bt;
        });
      }
      // **Stooges (decided):** a body that loses any HP is destroyed; the HP
      // came off the unit's one shared bar (the database copies it to all).
      if (result.row?.stooge_unit != null && delta < 0 && result.landed != null && result.landed < (result.before?.current ?? 0)) await stoogeHit(f);
      // **Protect the VIP:** a VIP falling ends it at once (not at the turn's end).
      if (result.down && vipFell(f)) await victoryCheck(world.env, world, fighters);
      // **Their Challenge drops (1e patch review):** falling to 0 HP, everyone holding theirs discards it.
      if (result.down) await dropChallengesOf(f);
      // **Handcuffs (Tilt):** one falls to 0 HP — their partner gains 3 Fatigue.
      if (result.down) {
        const partner = fighters.find((x) => x.id === partnerOf(battle, f.id));
        if (partner && world.gainTokens) {
          await world.gainTokens(partner, 'fatigue', 3);
          await postCard('reminder', { title: 'Handcuffs', text: `${f.name} is down: ${partner.name}, cuffed to them, gains 3 Fatigue.`, fighters: [{ name: partner.name }], automatic: 'battle', notice: true });
        }
      }
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
    // **Arena Parameters (Fight Setup)** that change the edge — one at a time:
    // Cage Match (no Outside: the edge holds), Endless Field (no edge at all),
    // Pyroclasm (no edge; everything beyond the map is Traps, and Pits are
    // Pit Traps), Trick Room (off one edge, in at the opposite one).
    const arena = new Set(battle.arena);
    const endless = mode === 'combat' && (arena.has('endless_field') || arena.has('pyroclasm'));
    const pyroclasm = arena.has('pyroclasm');
    const board = () => {
      const b = makeBoard({
        bounds: endless ? null : bounds,
        tiles: pyroclasm ? [...tileList, ...tileList.filter((t) => t.kind === 'pit').map((t) => ({ ...t, kind: 'trap' }))] : tileList,
        // (A Bomb fills its space: nobody enters it, a push stops before it.)
        units: [
          // (Someone at zero HP is Empty Space — anyone walks over them; 1e patch review.)
          ...[...fighters, ...copies].filter((f) => f.square && (f.isCopy || !f.hp || !atZero(f.hp))).map((f) => ({ id: f.id, square: f.square, size: f.size ?? 1 })),
          ...tileList.filter((t) => t.kind === 'bomb').map((t) => ({ id: `bomb:${t.col},${t.row}`, square: { col: t.col, row: t.row }, size: 1 })),
        ],
        exits: arena.has('cage_match') || arena.has('trick_room') || endless ? 'none' : mode === 'simple' ? 'cols' : 'all',
      });
      // Where comebacks land when the board itself has no edge.
      b.home = bounds;
      if (pyroclasm && bounds) b.trapsBeyond = bounds;
      if (arena.has('trick_room') && bounds) b.wrap = bounds;
      return b;
    };
    // Board animations (phase 3): a square as the stage stores it — a map
    // cell, or a lane's slot (lane × 10 + space).
    const fxSquare = (sq) => (sq ? (mode === 'simple' ? { col: sq.col, row: sq.row, slot: sq.row * 10 + sq.col } : { col: sq.col, row: sq.row }) : null);
    const recordMove = (f, from, to, how) => {
      if (!how || (!from && !to)) return;
      if (f.isCopy) {
        if (from && to) recordTile('moved', 'copy', storedOf(to), { from: storedOf(from), owner_id: f.ownerId, how });
        return;
      }
      recordFx({ sceneId, mode, kind: 'move', combatantId: f.id, before: null, after: null, data: { from: fxSquare(from), to: fxSquare(to), how } });
    };
    // A tile placed, destroyed or moved (an obstacle, or a Copy: `owner_id`).
    const recordTile = (change, kind, at, extra = {}) => recordFx({ sceneId, mode, kind: 'tile', combatantId: null, data: { change, tile: kind, at, ...extra } });
    // A fighter's new square (null: out of play — the Outside). `how` (board
    // animations): 'move', 'push', 'pull', 'teleport' or 'swap'; null shows nothing.
    // `quiet`: no stage update yet (a swap's steps — the board shows only its end).
    // **A Challenger falls or leaves play (decided, 1e patch review):** everyone
    // holding their Challenge discards it at once (no protection stops it).
    async function dropChallengesOf(f) {
      const holders = fighters.filter((x) => x.challengeId === f.id && x.id !== f.id);
      if (!holders.length) return;
      await queued(async () => {
        for (const h of holders) {
          const was = shapeFightState(await readRow(h.id));
          await run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [h.id, f.id]);
          recordFx({ sceneId, mode, kind: 'tokens', combatantId: h.id, before: slice(was), after: { ...slice(was), challenge_id: null }, data: { changes: [{ key: 'challenge', delta: -1 }] } });
        }
      });
      for (const h of holders) h.challengeId = null;
      markDirty();
    }
    const setSquare = async (f, sq, how = 'move', { quiet = false } = {}) => {
      if (f.isCopy) {
        // A Copy moves as its tile; one that goes Outside is gone.
        if (!sq) return destroyCopy(f);
        const at = storedOf(sq);
        const was = f.square ? storedOf(f.square) : null;
        await queued(() => run('UPDATE map_tiles SET col = ?, row = ? WHERE id = ?', [at.col, at.row, f.rowId]));
        if (was && how) recordTile('moved', 'copy', at, { from: was, owner_id: f.ownerId, how });
        f.square = { col: sq.col, row: sq.row };
        markDirty();
        if (!quiet) await flushStage();
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
      const from = f.square;
      if (!(from && sq && from.col === sq.col && from.row === sq.row)) recordMove(f, from, sq, how);
      f.square = sq ? { col: sq.col, row: sq.row } : null;
      // A move shows at once (decided): every step of an Action, one by one.
      markDirty();
      if (!quiet) await flushStage();
      if (!quiet) await cuffCheck(f);
      await mcguffinMoved(f, from, sq, how);
      // Leaving play: their Challenge drops (1e patch review).
      if (!sq && from) await dropChallengesOf(f);
      // Protect the VIP: a VIP removed from play ends it at once too.
      if (!sq && from && vipFell(f)) await victoryCheck(world.env, world, fighters);
      if (!quiet && from && sq && (how === 'move' || how === 'push' || how === 'pull') && !slidingIds.has(f.id)) await icySlide(f, from, sq);
    };
    // **Secure the McGuffin:** the holder carries the Important Thing. Moved by
    // anyone else's Action or Ability (a push, pull, swap, Action Movement), they
    // drop it where this move began; any teleport — even their own — leaves it
    // behind; leaving play drops it too. Carried into their own side's Control
    // Zone, their side wins. (A belt, Icy Floor's slide and Free Movement are
    // nobody's Action: they keep it.)
    const mcguffinMoved = async (f, from, sq, how) => {
      if (battle.victory !== 'secure_the_mcguffin' || battle.mcguffin?.holder !== f.id || f.isCopy) return;
      const performer = world.context?.performer;
      const byOther = performer != null && performer.id !== f.id && how !== null && !slidingIds.has(f.id);
      const drop = !sq || how === 'teleport' || (byOther && (how === 'push' || how === 'pull' || how === 'move')) || (how == null && performer != null && performer.id !== f.id);
      if (drop && from) {
        await writeKinds(from, placeTile(kindsAtSq(from), 'important'));
        battle.mcguffin = { holder: null };
        await saveBattleState();
        await postCard('reminder', { title: 'Secure the McGuffin', text: `${f.name} drops the Important Thing${how === 'teleport' ? ' (a teleport leaves it behind)' : ''}.`, fighters: [{ name: f.name }], automatic: 'battle', notice: true });
        return;
      }
      if (sq) await mcguffinHome(f);
    };
    const mcguffinHome = async (f) => {
      if (!f.square || !world.env) return;
      const zone = kindsAtSq(f.square).map((k) => CONTROL_SIDE[k]).filter(Boolean);
      if (zone.includes(f.side)) await announceWin(world.env, f.side, `${f.name} carried the Important Thing into their Control Zone.`);
    };
    // **Icy Floor (Arena):** after a movement ends, one more space the same way
    // — not into a Wall or Rubble, not after stopping in Rubble or a Pit, not
    // after a teleport or swap. A unit in the way is pushed 1 first (and slides
    // in turn). (A Free Movement slides once at its end, not after each space.)
    let sliding = 0;
    const slidingIds = new Set(); // whoever is sliding now: their slide's own step doesn't slide again
    const icySlide = async (f, from, to) => {
      if (!battle.arena.includes('icy_floor') || sliding > 4) return;
      const dc = Math.sign(to.col - from.col);
      const dr = Math.sign(to.row - from.row);
      const dir = Math.abs(to.col - from.col) >= Math.abs(to.row - from.row) ? { dc, dr: 0 } : { dc: 0, dr };
      if (!dir.dc && !dir.dr) return;
      const here = kindsAtSq(to);
      if (here.includes('rubble') || here.includes('pit')) return;
      const next = { col: to.col + dir.dc, row: to.row + dir.dr };
      const b = board();
      if (!inBoundsAt(b, next) || kindsAtSq(next).includes('wall') || kindsAtSq(next).includes('rubble')) return;
      sliding++;
      try {
        const other = [...fighters].find((x) => x.square && x.square.col === next.col && x.square.row === next.row && x.id !== f.id);
        if (other) {
          const beyond = { col: next.col + dir.dc, row: next.row + dir.dr };
          if (!inBoundsAt(b, beyond) || !isEmptyAt(b, beyond, [other.id])) return;
          await setSquare(other, beyond, 'push');
        }
        if (!isEmptyAt(board(), next, [f.id])) return;
        slidingIds.add(f.id);
        try {
          await setSquare(f, next, 'push');
        } finally {
          slidingIds.delete(f.id);
        }
      } finally {
        sliding--;
      }
    };
    // **Handcuffs (Tilt, Fight Setup):** cuffed pairs stay adjacent. When one
    // moves away, the one who stayed is pulled 1 space at a time until adjacent
    // again (as far as the board lets them); removed from play, both are.
    let cuffing = false;
    const cuffCheck = async (mover) => {
      if (cuffing) return;
      const partner = fighters.find((x) => x.id === partnerOf(battle, mover.id));
      if (!partner) return;
      cuffing = true;
      try {
        if (!mover.square && partner.square) {
          await setSquare(partner, null, 'teleport');
          await postCard('reminder', { title: 'Handcuffs', text: `${mover.name} is removed from play — and so is ${partner.name}, cuffed to them.`, fighters: [{ name: partner.name }], automatic: 'battle', notice: true });
          return;
        }
        let steps = 0;
        while (mover.square && partner.square && gridDistance(partner.square, mover.square) > 1 && steps < 30) {
          const b = board();
          const here = gridDistance(partner.square, mover.square);
          const next = sideSquares(partner.square).filter((sq) => isEmptyAt(b, sq, [partner.id]) && gridDistance(sq, mover.square) < here)[0];
          if (!next) break;
          await setSquare(partner, next, 'pull');
          steps++;
        }
        if (steps) await postCard('reminder', { title: 'Handcuffs', text: `${partner.name} is pulled ${steps} space${steps === 1 ? '' : 's'} after ${mover.name}.`, fighters: [{ name: partner.name }], automatic: 'battle', notice: true });
      } finally {
        cuffing = false;
      }
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
      recordTile('destroyed', 'wall', at);
      recordTile('placed', 'rubble', at);
      markDirty();
    };
    const setDizzy = (f) =>
      f.isCopy
        ? null
        : queued(async () => {
            const was = shapeFightState(await readRow(f.id));
            await run('UPDATE combatants SET dizzy = 1 WHERE id = ?', [f.id]);
            // Board animations: Dizzy outside a hit (a hit's own shows in its damage beat).
            if (!was.hp.dizzy) recordFx({ sceneId, mode, kind: 'dizzy', combatantId: f.id, before: slice(was), after: { ...slice(was), hp: { ...was.hp, dizzy: true } } });
          }).then(() => (f.dizzy = true));

    // ---- obstacles (phase E): placing, destroying, replacing (mapTiles.js stacking rules)
    const kindsAtSq = (sq) => tileList.filter((t) => t.col === sq.col && t.row === sq.row).map((t) => t.kind);
    // Each kind keeps who placed it; a new one is `by`'s (a character id —
    // batch 5: its controller may move it by hand).
    const writeKinds = async (sq, kinds, by = null) => {
      const at = storedOf(sq);
      const was = new Map(tileList.filter((t) => t.col === sq.col && t.row === sq.row).map((t) => [t.kind, t.placed_by ?? null]));
      const byOf = (kind) => (was.has(kind) ? was.get(kind) : by);
      await queued(async () => {
        await run("DELETE FROM map_tiles WHERE scene_id = ? AND mode = ? AND col = ? AND row = ? AND kind != 'copy'", [sceneId, mode, at.col, at.row]);
        for (const kind of kinds) await run('INSERT INTO map_tiles (scene_id, mode, col, row, kind, placed_by) VALUES (?, ?, ?, ?, ?, ?)', [sceneId, mode, at.col, at.row, kind, byOf(kind)]);
      });
      for (const kind of was.keys()) if (!kinds.includes(kind)) recordTile('destroyed', kind, at);
      for (const kind of kinds) if (!was.has(kind)) recordTile('placed', kind, at);
      for (let i = tileList.length - 1; i >= 0; i--) if (tileList[i].col === sq.col && tileList[i].row === sq.row) tileList.splice(i, 1);
      for (const kind of kinds) tileList.push({ col: sq.col, row: sq.row, kind, placed_by: byOf(kind) });
      for (const [kind, set] of [['trap', traps], ['wall', walls], ['pit', pits], ['deadly_trap', deadly]]) {
        const k = `${sq.col},${sq.row}`;
        if (kinds.includes(kind)) set.add(k);
        else set.delete(k);
      }
      if (kinds.includes('deadly_trap')) traps.add(`${sq.col},${sq.row}`);
      fogSquares.splice(0, fogSquares.length, ...tileList.filter((t) => t.kind === 'fog').map((t) => ({ col: t.col, row: t.row })));
      markDirty();
    };
    // `by`: who destroyed it, if anyone did (phase G: Zombie and Crystal Style).
    const destroyCopy = async (c, by = null) => {
      if (!c.square && !copies.includes(c)) return;
      await queued(() => run('DELETE FROM map_tiles WHERE id = ?', [c.rowId]));
      if (c.square) recordTile('destroyed', 'copy', storedOf(c.square), { owner_id: c.ownerId });
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
    // **Disarmed (Tilt / Arena):** Range 1 whatever the Stance; Abilities don't raise it.
    const rangeOf = (f) => {
      if (f && isDisarmed(battle, f.side)) return { minimum: Math.min(1, f.stance?.range?.minimum ?? 1), maximum: 1 };
      return f?.isCopy ? f.stance?.range : effectiveRange(f?.stance?.range, modsOf(f), f?.rangeBonus ?? 0);
    };
    const sightOf = (f) => {
      const ignore = listMod(modsOf(f), 'sight.ignore');
      return { walls: ignore.includes('walls') ? new Set() : walls, fogged: ignore.includes('fog') ? () => false : fogged };
    };

    // An obstacle as the rules see it (a pick's option, a push's target).
    // **Chained Down:** a fighter's own Wall (then its Rubble) is named for them
    // and immune to Open The Path (interpreter candidatesOf).
    const chainOwnerAt = (t) => {
      if (t.kind !== 'wall' && t.kind !== 'rubble') return null;
      const id = Object.keys(battle.chains).find((k) => battle.chains[k].col === t.col && battle.chains[k].row === t.row);
      return id != null ? Number(id) : null;
    };
    const obstacleOf = (t) => {
      const base = t.kind === 'deadly_trap' ? 'Deadly Trap' : t.kind[0].toUpperCase() + t.kind.slice(1);
      const chainedTo = chainOwnerAt(t);
      const owner = chainedTo != null ? fighters.find((f) => f.id === chainedTo) : null;
      // Sabotage: a Bomb belongs to the team that planted it.
      const bomb = t.kind === 'bomb' ? bombAt(t) : null;
      const bombName = bomb ? `${SIDE_LABEL[bomb.side] ?? bomb.side}' Bomb` : null;
      return { id: `${t.col},${t.row}:${t.kind}`, isObstacle: true, kind: t.kind, name: bombName ?? (owner ? `${owner.name}'s ${base}` : base), square: { col: t.col, row: t.row }, chainedTo, side: bomb?.side ?? null };
    };
    const bombAt = (sq) => (battle.sabotage?.bombs ?? []).find((x) => x.col === sq.col && x.row === sq.row) ?? null;
    // Writes this fight's Sabotage / McGuffin state back to the Scene (and keeps it here).
    const saveBattleState = async () => {
      const keep = { sabotage: battle.sabotage, mcguffin: battle.mcguffin };
      const nb = await updateBattle(sceneId, mode, (bt) => ({ ...bt, ...keep }));
      battle.sabotage = nb.sabotage;
      battle.mcguffin = nb.mcguffin;
      markDirty();
    };
    const world = {
      // Fight Setup's settings for this fight (Tilts, Arena, Victory, Complications).
      battle,
      // Chained Down: { at, max } for a fighter on a chained side, else null (engine/moves.js boardFor).
      leash: (f) => leashOf(battle, f.id, kindsAtSq),
      context: { healValue: weight.heal, bleedValue: weight.bleed, round: fight.round, superLimit: weight.supers ?? 1 },
      fighters: () => fighters,
      enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
      // (A Stooge's other bodies are the unit itself, not its allies.)
      alliesOf: (f) => fighters.filter((x) => x.side === f.side && (x.id === f.id || x.stoogeUnit == null || x.stoogeUnit !== f.stoogeUnit)),
      inRange: (from, to, range) => {
        const r = rangeOf(from);
        const sight = sightOf(from);
        // "Enemies holding your Challenge are within your range" (Relentless Style).
        if ((range?.mode ?? 'stance') === 'stance' && to?.challengeId != null && to.challengeId === from?.id && to.square && hasMod(modsOf(from), 'own_challenged_enemies.always_in_range')) return true;
        // "Within range of you or your Copies" (phase E): from any of them.
        if (range?.mode === 'self_or_copies_range') {
          const origins = [from, ...copies.filter((c) => c.ownerId === from.id)];
          return origins.some((o) => targetable({ from: o.square, to: to.square, range: { mode: 'stance' }, stanceRange: r, ...sight, enemy: from.side !== to.side }));
        }
        // "Each enemy adjacent to any of your Copies" (Zombie Style — phase G).
        if (range?.mode === 'adjacent_to_any_own_copy') {
          return Boolean(to.square) && copies.some((c) => c.ownerId === from.id && c.square && gridDistance(c.square, to.square) === 1);
        }
        // A Giant measures from (and is measured to) its nearest square.
        const [a, b] = from?.square && to?.square && ((from.size ?? 1) > 1 || (to.size ?? 1) > 1) ? nearestCells(from.square, from.size ?? 1, to.square, to.size ?? 1) : [from?.square, to?.square];
        return targetable({ from: a, to: b, range, stanceRange: r, ...sight, enemy: from.side !== to.side });
      },
      heldTokens: (f) => ({ ...f.tokens }),
      // The modifiers on a fighter now, and whether a passive rule's condition
      // holds for its owner (their Weapon, Ammo, where they stand).
      mods: (f) => modsOf(f),
      ruleHolds: (rule, owner) => {
        try {
          const state = world.env ? fighterRt(world.env.rt, owner.id).state : {};
          return Boolean(evalValue(rule.condition, { self: owner, state, context: world.context, world, event: {}, targets: {}, bindings: {}, variables: {}, history: {}, payment: {}, resolution: {} }));
        } catch {
          return false;
        }
      },
      // **What a fighter can spend (the QA pass).** Their own tokens; Iron
      // "as if they were Power or Speed tokens" (Machine Style); and the tokens
      // of an ally in whose range they stand who lets them ("Your allies
      // within range may spend your tokens" — Unbreakable Style).
      lendersOf: (f) => (f?.isCopy ? [] : modsOf(f).filter((m) => m.rule === 'allies_can_spend_own_tokens' && m.ownerId !== f.id).map((m) => byId(m.ownerId)).filter(Boolean)),
      spendable: (f, key) => {
        if (!f || f.isCopy) return 0;
        const asOther = listMod(modsOf(f), 'iron_can_pay_as').includes(key) ? (f.tokens.iron ?? 0) : 0;
        return (f.tokens[key] ?? 0) + asOther + world.lendersOf(f).reduce((n, l) => n + (l.tokens[key] ?? 0), 0);
      },
      // Spends `n` of `key`: their own first, then Iron in its place, then a lender's. → how many were spent.
      spend: async (f, key, n) => {
        let left = Math.max(0, Number(n) || 0);
        if (!f || f.isCopy || !left) return 0;
        const take = async (who, k) => {
          const got = Math.min(left, who.tokens[k] ?? 0);
          if (got > 0) await writeTokens(who, (t) => (t[k] = (t[k] ?? 0) - got));
          left -= got;
        };
        await take(f, key);
        if (left && key !== 'iron' && listMod(modsOf(f), 'iron_can_pay_as').includes(key)) await take(f, 'iron');
        for (const l of world.lendersOf(f)) if (left) await take(l, key);
        return Math.max(0, Number(n) || 0) - left;
      },
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
      gainShield: (f, v) => (f.isCopy ? null : writeTokens(f, (t) => (t.shield = Math.min(capOf('shield'), Math.max(Number(v) || 0, (t.shield ?? 0) + 1))), 'shield')),
      // Temporary Armor is binary (book p.24): you have it or you don't.
      tempArmor: (f) => (f.isCopy ? null : writeTokens(f, (t) => (t.temp_armor = 1))),
      // Back to full HP: every bar whole, no Dizzy (Outlast, Tournament Play).
      restoreFull: async (f) => {
        if (f.isCopy) return;
        await queued(async () => {
          const row = await readRow(f.id);
          if (!row || row.hp_max == null) return;
          const before = hpOf(row);
          const next = { ...before, current: before.max, broken: 0, dizzy: false };
          await saveHp(f.id, next);
          const was = shapeFightState(row);
          const shown = shapeFightState({ ...row, hp_current: next.current, hp_broken: 0, dizzy: 0 });
          recordFx({ sceneId, mode, kind: 'heal', combatantId: f.id, before: slice(was), after: slice(shown), data: { amount: Math.max(1, next.max - before.current) } });
          f.hp = next;
          f.dizzy = false;
        });
        markDirty();
      },
      // The squares of a marker kind (King Zone, Danger Zone …) on this board.
      markers: (kind) => tileList.filter((t) => t.kind === kind).map((t) => ({ col: t.col, row: t.row })),
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
        // A Copy has 1 HP: any damage destroys it. **Mirrored Style (the QA
        // pass):** its Copies have 2 HP each, and its Iron may Reduce Hits to them.
        if (f.isCopy) {
          let dmg = Math.max(0, Number(n) || 0);
          if (!dmg) return { taken: 0, steps: [], immune: false };
          const owner = byId(f.ownerId);
          const omods = owner ? modsOf(owner) : [];
          const steps = [];
          if (owner && world.env && hasMod(omods, 'iron.can_reduce_hits_to_own_copies') && (owner.tokens.iron ?? 0) > 0 && (owner.prefs?.iron ?? 'auto') !== 'never') {
            const max = Math.min(ironAllowance(omods), owner.tokens.iron, dmg);
            let spend = max;
            if (owner.prefs?.iron === 'ask') {
              const env = world.env;
              const options = [{ id: '0', label: 'None' }, ...Array.from({ length: max }, (_, i) => ({ id: String(i + 1), label: `${i + 1} Iron` }))];
              const ans = await ask(owner, env.key, env.gen, env.tg, env.when)({ kind: 'choose', title: 'Reduce the hit to your Copy', text: `${f.name} takes ${dmg} damage. Spend Iron: −1 damage each.`, options, minimum: 1, maximum: 1 });
              spend = Math.min(max, Number(Array.isArray(ans) ? ans[0] : ans) || 0);
            }
            if (spend > 0) {
              await writeTokens(owner, (t) => (t.iron = (t.iron ?? 0) - spend));
              dmg -= spend;
              steps.push(`${owner.name} spends ${spend} Iron`);
              await emitEvent(world.env, 'self.iron_tokens_spent', owner, { amount: spend, attacker });
            }
          }
          if (!dmg) return { taken: 0, toHp: 0, dealt: 0, steps: [...steps, 'the Copy takes no damage'], immune: false };
          const maxHp = Math.max(1, Number(valueOf(omods, 'copies.maximum_hp', 1)) || 1);
          const hpOfCopies = world.env && owner ? (fighterRt(world.env.rt, owner.id).fight.copyHp ??= {}) : {};
          const left = (hpOfCopies[f.rowId] ?? maxHp) - dmg;
          if (left > 0) {
            hpOfCopies[f.rowId] = left;
            return { taken: dmg, toHp: dmg, dealt: dmg, steps: [...steps, `the Copy has ${left} HP left`] };
          }
          delete hpOfCopies[f.rowId];
          await destroyCopy(f, attacker);
          return { taken: dmg, toHp: dmg, dealt: dmg, steps: [...steps, 'the Copy is destroyed'], destroyed: true };
        }
        // **Taken Out (1e patch review):** at zero HP they take no damage.
        if (f.hp && atZero(f.hp) && !f.infinite) return { taken: 0, toHp: 0, dealt: 0, steps: [`${f.name} is Taken Out: no damage`], immune: true, takenOut: true };
        const r = await hits.resolveHit(world.env, { writeTokens, changeHp, bleedCheck, inPit, spend: world.spend, spendable: world.spendable, hitFx }, f, n, attacker, opts);
        // **Enraged (Tilt):** dealt damage by an enemy, they take that enemy's
        // Challenge token (a unique token: whoever held it loses it) and drop
        // their own. No Abilities trigger from it.
        if (attacker && !attacker.isCopy && attacker.side !== f.side && (r?.taken ?? 0) > 0 && tiltOn(battle, f.side) === 'enraged' && f.challengeId !== attacker.id) {
          await queued(async () => {
            for (const other of fighters.filter((x) => x.challengeId === attacker.id && x.id !== f.id)) {
              await run('UPDATE combatants SET challenge_id = NULL WHERE id = ?', [other.id]);
              other.challengeId = null;
            }
            const was = shapeFightState(await readRow(f.id));
            await run('UPDATE combatants SET challenge_id = ? WHERE id = ?', [attacker.id, f.id]);
            recordFx({ sceneId, mode, kind: 'challenge', combatantId: f.id, before: slice(was), after: { ...slice(was), challenge_id: attacker.id }, data: { challengerId: attacker.id } });
          });
          f.challengeId = attacker.id;
          markDirty();
          await postCard('reminder', { title: 'Enraged', text: `${f.name} takes ${attacker.name}'s Challenge.`, fighters: [{ name: f.name }], automatic: 'battle', notice: true });
        }
        return r;
      },
      // **Obstacles (phase E).** The legal squares for a placement, the obstacles
      // in range, and the changes — all by the book's stacking (mapTiles.js).
      mode,
      // Every empty square of the board, no obstacle on it (a board without an
      // edge: those within 6 of someone). For placing new bodies (Stooges).
      emptySquares: () => {
        const b = board();
        const out = [];
        const lo = bounds ?? null;
        const near = [...fighters].filter((x) => x.square).map((x) => x.square);
        const box = lo
          ? { c0: lo.colMin, c1: lo.colMax, r0: lo.rowMin, r1: lo.rowMax }
          : near.length
            ? { c0: Math.min(...near.map((q) => q.col)) - 6, c1: Math.max(...near.map((q) => q.col)) + 6, r0: Math.min(...near.map((q) => q.row)) - 6, r1: Math.max(...near.map((q) => q.row)) + 6 }
            : null;
        if (!box) return out;
        for (let r = box.r0; r <= box.r1; r++) for (let c = box.c0; c <= box.c1; c++) {
          const sq = { col: c, row: r };
          if (inBoundsAt(b, sq) && isEmptyAt(b, sq) && !world.obstacleAt(sq)) out.push(sq);
        }
        return out;
      },
      spaces: (from, range, { empty = false } = {}) => {
        const b = board();
        return squaresNear(from, range).filter(
          (sq) => (!empty || isEmptyAt(b, sq)) && targetable({ from: from.square, to: sq, range, stanceRange: rangeOf(from), ...sightOf(from), enemy: false })
        );
      },
      obstacles: (from, range, { types = null } = {}) => {
        const list = [
          // **A Deadly Trap can't be removed by Actions or Abilities** (decided,
          // 1e patch review): never a candidate to destroy, replace or move.
          ...tileList.filter((t) => OBSTACLE_KINDS.has(t.kind) && t.kind !== 'deadly_trap').map(obstacleOf),
          ...copies.map((c) => Object.assign(c, { kind: 'copy' })),
        ];
        return list.filter(
          (o) => o.square && (!types || types.includes(o.kind)) && targetable({ from: from.square, to: o.square, range, stanceRange: rangeOf(from), ...sightOf(from), enemy: false })
        );
      },
      copies: () => copies,
      // Whom `f` damaged this turn (the runtime's turn flags; Experimental Build).
      damagedThisTurn: (f) => (world.env ? fighterRt(world.env.rt, f.id).flags.damagedIds ?? [] : []),
      canPlace: (kind, sq) => {
        const b = board();
        if (!inBoundsAt(b, sq)) return false;
        // Rubble and Walls fill a space: not onto a fighter or a Copy.
        if ((kind === 'wall' || kind === 'copy') && occupantAt(b, sq) != null) return false;
        // Rubble or a Wall would clear the space — not a Deadly Trap's (it can't be removed).
        if ((kind === 'wall' || kind === 'rubble') && kindsAtSq(sq).includes('deadly_trap')) return false;
        if (kind === 'copy') return isEmptyAt(b, sq);
        if (placementBarred(kindsAtSq(sq), kind === 'pit_trap' ? 'pit' : kind)) return false;
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
          recordTile('placed', 'copy', at, { owner_id: owner.id, from: owner.square ? storedOf(owner.square) : null });
          markDirty();
          return c;
        }
        await writeKinds(sq, placeTile(kindsAtSq(sq), kind), owner?.characterId ?? null);
        return obstacleOf({ col: sq.col, row: sq.row, kind });
      },
      // ---- the QA pass: Fog and obstacles under someone, obstacles that move,
      // coming back into play and leaving it for good.
      deadlyAt: (sq) => Boolean(sq) && deadly.has(`${sq.col},${sq.row}`),
      inFog: (sq) => Boolean(sq) && tileList.some((t) => t.kind === 'fog' && t.col === sq.col && t.row === sq.row),
      obstacleAt: (sq) => Boolean(sq) && tileList.some((t) => OBSTACLE_KINDS.has(t.kind) && t.col === sq.col && t.row === sq.row),
      // Where an obstacle may go, up to `distance` spaces away: a space on the
      // board no other obstacle holds — and, for one that fills its space (a
      // Wall, Rubble), nobody stands on.
      obstacleDestinations: (o, distance) => {
        const b = board();
        const out = [];
        const d = Math.max(0, Number(distance) || 0);
        for (let dc = -d; dc <= d; dc++) {
          for (let dr = -d; dr <= d; dr++) {
            const n = Math.abs(dc) + Math.abs(dr);
            if (!n || n > d) continue;
            const sq = { col: o.square.col + dc, row: o.square.row + dr };
            if (!inBoundsAt(b, sq) || world.obstacleAt(sq)) continue;
            if (o.kind === 'wall' && occupantAt(b, sq) != null) continue;
            out.push(sq);
          }
        }
        return out;
      },
      inBounds: (sq) => Boolean(sq) && inBoundsAt(board(), sq),
      // **Factory (Arena):** the way the Conveyor Belt on this square runs, or null.
      beltAt: (sq) => {
        const k = sq ? kindsAtSq(sq).find((x) => BELT_DIRS[x]) : null;
        return k ? BELT_DIRS[k] : null;
      },
      // Every square holding a belt and the obstacles on it.
      beltSquares: () => {
        const out = new Map();
        for (const t of tileList) if (BELT_DIRS[t.kind]) out.set(`${t.col},${t.row}`, { col: t.col, row: t.row, dir: BELT_DIRS[t.kind] });
        return [...out.values()].map((b) => ({ ...b, obstacles: kindsAtSq(b).filter((k) => OBSTACLE_KINDS.has(k)) }));
      },
      moveObstacle: async (o, sq) => {
        if (!o?.square || o.isCopy) return false;
        const from = { col: o.square.col, row: o.square.row };
        const by = tileList.find((t) => t.col === from.col && t.row === from.row && t.kind === o.kind)?.placed_by ?? null;
        await writeKinds(from, removeTile(kindsAtSq(from), o.kind));
        await writeKinds(sq, placeTile(kindsAtSq(sq), o.kind), by);
        if (o.kind === 'bomb') {
          const rec = bombAt(from);
          if (rec) {
            rec.col = sq.col;
            rec.row = sq.row;
            await saveBattleState();
          }
        }
        o.square = { col: sq.col, row: sq.row };
        o.id = `${sq.col},${sq.row}:${o.kind}`;
        await flushStage();
        return true;
      },
      // **Sabotage (Action, 1+):** a Bomb into an adjacent Key Location — not
      // while an enemy or another Bomb is in it. HP = the Bleed Value.
      saveBattle: () => saveBattleState(),
      sabotage: async (self) => {
        if (!self?.square) return { error: 'not on the board' };
        const free = tileList
          .filter((t) => t.kind === 'key_location' && gridDistance(t, self.square) === 1)
          .map((t) => ({ col: t.col, row: t.row }))
          .filter((sq) => !kindsAtSq(sq).includes('bomb') && !fighters.some((x) => x.side !== self.side && x.square && x.square.col === sq.col && x.square.row === sq.row));
        if (!free.length) return { error: 'no free Key Location beside them (an enemy or a Bomb is in it, or none is adjacent)' };
        let at = free[0];
        if (free.length > 1 && world.env) {
          const e = world.env;
          const ans = await ask(self, e.key, e.gen, e.tg, e.when)({ kind: 'square', mode, title: 'Sabotage', text: `${self.name}: which Key Location?`, options: free.map((q) => ({ id: `${q.col},${q.row}`, label: `column ${q.col}, row ${q.row}`, col: q.col, row: q.row })), minimum: 1, maximum: 1 });
          const id = Array.isArray(ans) ? ans[0] : ans;
          at = free.find((q) => `${q.col},${q.row}` === id) ?? at;
        }
        // A fighter standing there (an ally) shares it; the Bomb only needs the Key Location.
        await writeKinds(at, placeTile(kindsAtSq(at), 'bomb'), self.characterId ?? null);
        const hp = Math.max(1, weight.bleed ?? 4);
        battle.sabotage.bombs = [...(battle.sabotage.bombs ?? []).filter((x) => !(x.col === at.col && x.row === at.row)), { col: at.col, row: at.row, side: self.side, hp, max: hp }];
        await saveBattleState();
        await flushStage();
        return { hp, at };
      },
      // A hit on a Bomb: its HP goes down; at 0 it is removed from play.
      damageBomb: async (o, n, by = null) => {
        const rec = bombAt(o.square);
        if (!rec) {
          await writeKinds(o.square, removeTile(kindsAtSq(o.square), 'bomb'));
          return { destroyed: true, hp: 0 };
        }
        rec.hp = Math.max(0, rec.hp - Math.max(0, Number(n) || 0));
        if (rec.hp <= 0) {
          battle.sabotage.bombs = battle.sabotage.bombs.filter((x) => x !== rec);
          await writeKinds(o.square, removeTile(kindsAtSq(o.square), 'bomb'));
          countDestroyed(by);
        }
        await saveBattleState();
        await flushStage();
        return { destroyed: rec.hp <= 0, hp: rec.hp };
      },
      // **Grab It! (Action, 1+):** the adjacent Important Thing, if nobody holds it.
      grabIt: async (self) => {
        if (!self?.square) return { error: 'not on the board' };
        if (battle.mcguffin?.holder != null) return { error: 'someone already holds the Important Thing' };
        const it = tileList.find((t) => t.kind === 'important' && gridDistance(t, self.square) <= 1);
        if (!it) return { error: 'the Important Thing is not adjacent' };
        await writeKinds(it, removeTile(kindsAtSq(it), 'important'));
        battle.mcguffin = { holder: self.id };
        await saveBattleState();
        await flushStage();
        await mcguffinHome(self);
        return { ok: true };
      },
      // An obstacle pushed away from `origin` or pulled toward it: each step
      // strictly farther or closer, never onto another obstacle; the chooser
      // picks where it stops when there is more than one way.
      forcedObstacle: async (o, { distance, origin, pull = false, upTo = false, chooser = null }) => {
        if (!o?.square || !origin) return null;
        const d = Math.max(0, Number(distance) || 0);
        const dist = (sq) => gridDistance(sq, origin);
        const ends = new Map();
        const b = board();
        const walk = (at, n) => {
          let moved = false;
          if (n < d) {
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const sq = { col: at.col + dc, row: at.row + dr };
              if (!(pull ? dist(sq) < dist(at) : dist(sq) > dist(at)) || (sq.col === origin.col && sq.row === origin.row)) continue;
              if (!inBoundsAt(b, sq) || world.obstacleAt(sq) || (o.kind === 'wall' && occupantAt(b, sq) != null)) continue;
              moved = true;
              walk(sq, n + 1);
            }
          }
          if (n > 0 && (n === d || !moved || upTo)) ends.set(`${at.col},${at.row}`, at);
        };
        walk(o.square, 0);
        const dests = [...ends.values()];
        if (!dests.length) return null;
        let to = dests[0];
        if (dests.length > 1 && world.env && chooser) {
          const ans = await ask(chooser, world.env.key, world.env.gen, world.env.tg, world.env.when)({
            kind: 'square',
            mode,
            title: `${world.env.source ?? 'Move'} (${pull ? 'Pull' : 'Push'} the ${o.name})`,
            text: `Where does the ${o.name} end up?`,
            options: dests.map((sq) => ({ id: `${sq.col},${sq.row}`, label: `${sq.col},${sq.row}`, col: sq.col, row: sq.row })),
            minimum: 1,
            maximum: 1,
            skippable: true,
          });
          const id = Array.isArray(ans) ? ans[0] : ans;
          if (id === '__skip') return null;
          to = dests.find((sq) => `${sq.col},${sq.row}` === id) ?? to;
        }
        await world.moveObstacle(o, to);
        return to;
      },
      // You and an obstacle trade spaces (Walled In, Bag of Tricks).
      swapWithObstacle: async (actor, o) => {
        if (!actor?.square || !o?.square || o.isCopy) return false;
        const mine = { col: actor.square.col, row: actor.square.row };
        const its = { col: o.square.col, row: o.square.row };
        const by = tileList.find((t) => t.col === its.col && t.row === its.row && t.kind === o.kind)?.placed_by ?? null;
        await writeKinds(its, removeTile(kindsAtSq(its), o.kind));
        await setSquare(actor, its, 'swap');
        await writeKinds(mine, placeTile(kindsAtSq(mine), o.kind), by);
        o.square = mine;
        o.id = `${mine.col},${mine.row}:${o.kind}`;
        await flushStage();
        return true;
      },
      // Back into play on a picked space (Rescue).
      returnToPlay: async (f, sq) => {
        if (f.isCopy || f.square || f.removedForGood) return false;
        await setSquare(f, sq);
        return true;
      },
      // Out of play; `forGood`: no Comeback, no Rescue for the rest of the fight.
      removeFromPlay: async (f, { forGood = false } = {}) => {
        if (f.isCopy) return destroyCopy(f);
        if (forGood && world.env) fighterRt(world.env.rt, f.id).fight.removedForGood = true;
        await setSquare(f, null);
        return true;
      },
      // Destroyed: a Wall becomes Rubble, anything else is gone (a Copy too).
      // `by`: who did it (counted for "obstacles you destroyed this turn").
      destroyObstacle: async (o, by = null) => {
        if (o.isCopy) return destroyCopy(o, by);
        const kinds = kindsAtSq(o.square);
        // Pyroclasm: a Trap or Pit removed leaves Rubble — the fix is temporary.
        const leavesRubble = o.kind === 'wall' || (pyroclasm && (o.kind === 'trap' || o.kind === 'pit' || o.kind === 'deadly_trap'));
        await writeKinds(o.square, leavesRubble ? placeTile(removeTile(kinds, o.kind), 'rubble') : removeTile(kinds, o.kind));
        countDestroyed(by);
      },
      // Pyroclasm, at a Round's end: every Rubble crumbles into a Pit Trap.
      rubbleToPitTraps: async () => {
        const rubble = tileList.filter((t) => t.kind === 'rubble').map((t) => ({ col: t.col, row: t.row }));
        for (const sq of rubble) await writeKinds(sq, placeTile(placeTile(removeTile(kindsAtSq(sq), 'rubble'), 'pit'), 'trap'));
        return rubble.length;
      },
      replaceObstacle: async (o, to, by = null) => {
        const sq = { col: o.square.col, row: o.square.row };
        if (o.isCopy) await destroyCopy(o, by);
        await writeKinds(sq, placeTile(o.isCopy ? kindsAtSq(sq) : removeTile(kindsAtSq(sq), o.kind), to), by?.characterId ?? null);
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
        await queued(async () => {
          const was = shapeFightState(await readRow(target.id));
          await run('UPDATE combatants SET challenge_id = ? WHERE id = ?', [challenger.id, target.id]);
          recordFx({ sceneId, mode, kind: 'challenge', combatantId: target.id, before: slice(was), after: { ...slice(was), challenge_id: challenger.id }, data: { challengerId: challenger.id } });
        });
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
        await queued(async () => {
          const was = shapeFightState(await readRow(holder.id));
          await run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [holder.id, challengerId]);
          recordFx({ sceneId, mode, kind: 'tokens', combatantId: holder.id, before: slice(was), after: { ...slice(was), challenge_id: null }, data: { changes: [{ key: 'challenge', delta: -1 }] } });
        });
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
    const movers = { mode, board, setSquare, recordMove, smashWall, setDizzy, inPit, writeTokens, copies };
    const onTrap = (f) => f.square != null && traps.has(`${f.square.col},${f.square.row}`);
    return { world, fighters, byId, onTrap, weight, movers };
  }

  // Build Abilities are Unblockable (book p.26): the builds marked so in the content.
  const buildUnblockable = (idx) => new Set((idx.content.builds ?? []).filter((b) => b.unblockable).flatMap((b) => b.abilityIds ?? []));

  // How many jobs each fight's chain holds (queued or running): an Action
  // resolving, a prompt waiting… The Interrupt lock waits for it to empty.
  const busy = new Map();
  // **The resolve stack (decided, batch 5):** what a fight is working through,
  // in order — each step done, now or queued. A Commit lists its Actions up
  // front; a turn's start or end, a triggered Ability and a follow-on join as
  // they arise (right after what is running, before what still waits).
  // Everyone hears it with the plaque: `fight:resolving { busy, steps }`.
  //
  // **Revised (play feedback):** every step is named for what it is — the
  // Ability and whose it is ("Wild Form (Bo)"), the Action ("Crush (Ana)"),
  // the End Phase's parts — never "Start of turn". A turn moment lists the
  // Abilities it will run up front (queued), each marked when it runs and
  // dropped when its condition doesn't hold. The stack carries over between
  // back-to-back jobs (a turn's end, the next start, its Action Phase) and
  // stays up for a moment once everything is done (LINGER_MS), instead of
  // vanishing between them.
  const stacks = new Map(); // fight key → [{ id, label, state, tag }]
  const lingering = new Map(); // fight key → timer: done, still shown
  const LINGER_MS = 1600;
  let stepSeq = 0;
  const steps = {
    emit(key) {
      const [sceneId, mode] = key.split(':');
      // Shown while working, and while it lingers after.
      const shown = (busy.get(key) ?? 0) > 0 || lingering.has(key);
      io.emit('fight:resolving', { sceneId: Number(sceneId), mode, busy: shown, steps: (stacks.get(key) ?? []).map(({ label, state }) => ({ label, state })) });
    },
    // `arising`: it came up while something runs — placed before the queued ones.
    // `tag`: who and what, so a queued step can be claimed when it runs.
    add(key, label, state = 'queued', { silent = false, arising = false, tag = null } = {}) {
      const list = stacks.get(key) ?? [];
      stacks.set(key, list);
      const step = { id: ++stepSeq, label, state, tag };
      const at = arising ? list.findIndex((x) => x.state === 'queued') : -1;
      if (at >= 0) list.splice(at, 0, step);
      else list.push(step);
      if (!silent) steps.emit(key);
      return step.id;
    },
    set(key, id, state, { silent = false } = {}) {
      const step = (stacks.get(key) ?? []).find((x) => x.id === id);
      if (!step || step.state === state) return;
      step.state = state;
      if (!silent) steps.emit(key);
    },
    remove(key, id, { silent = false } = {}) {
      const list = stacks.get(key) ?? [];
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return;
      list.splice(i, 1);
      if (!silent) steps.emit(key);
    },
    clear: (key) => stacks.delete(key),
    // The queued step with this tag, if any (→ its id).
    claim(key, tag) {
      return (stacks.get(key) ?? []).find((x) => x.tag === tag && x.state === 'queued')?.id ?? null;
    },
  };
  // Runs `fn` as a named step of its own; kept when it did something (truthy), dropped otherwise.
  const tracked = async (env, label, fn) => {
    const sid = steps.add(env.key, label, 'now', { arising: true });
    let out;
    try {
      out = await fn();
    } finally {
      if (out) steps.set(env.key, sid, 'done');
      else steps.remove(env.key, sid);
    }
    return out;
  };
  // A turn moment's Abilities, listed up front by name (queued). → their ids.
  const planSteps = (env, list) => {
    const idx = patdContent();
    const ids = [];
    for (const { f, events } of list) {
      if (abilitiesOff(f.id, env.rt.temps)) continue;
      const down = atZero(f.hp);
      for (const abilityId of f.abilityIds) {
        if (ENGINE_NATIVE.has(abilityId)) continue;
        const ability = idx.get(abilityId);
        for (const rule of ability?.rules ?? []) {
          if (!rule.events.some((e) => events.includes(e)) || isNativeRule(rule)) continue;
          if (down && !rule.events.some((e) => WORKS_AT_ZERO.has(e))) continue;
          ids.push(steps.add(env.key, `${ability.name} (${f.name})`, 'queued', { silent: true, tag: `${rule.id}@${f.id}` }));
        }
      }
    }
    if (ids.length) steps.emit(env.key);
    return ids;
  };
  // Whatever of a moment's plan never ran (stale, or skipped before running) leaves the stack.
  const unplan = (env, ids) => {
    for (const id of ids) {
      const step = (stacks.get(env.key) ?? []).find((x) => x.id === id);
      if (step?.state === 'queued') steps.remove(env.key, id, { silent: true });
    }
    steps.emit(env.key);
  };

  // ---- running one fighter's rules for some events
  const WORKS_AT_ZERO = new Set(['own_turn.start', 'self.fell_to_zero_hp', 'self.giving_heroic_spirit']);
  // The part of an effect that affects only its owner: steps whose target is
  // themselves (or none), no picks, no passive rules. → the pruned effect or null.
  const PICKS = new Set(['select', 'for_each', 'choose', 'joint_choice', 'ensure_target', 'select_token']);
  const PASSIVE = new Set(['modify_rule', 'temporary', 'register_trigger', 'schedule', 'grant_armor']);
  const pickInside = (n) => (Array.isArray(n) ? n.some(pickInside) : n && typeof n === 'object' ? (typeof n.kind === 'string' && n.range) || Object.values(n).some(pickInside) : false);
  function selfOnlyEffect(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.op === 'sequence') {
      const steps = (node.steps ?? []).map(selfOnlyEffect).filter(Boolean);
      return steps.length ? { ...node, steps } : null;
    }
    if (node.op === 'optional') {
      const effect = selfOnlyEffect(node.effect);
      return effect ? { ...node, effect } : null;
    }
    if (node.op === 'if') {
      const then = node.then ? selfOnlyEffect(node.then) : null;
      const otherwise = node.else ? selfOnlyEffect(node.else) : null;
      return then || otherwise ? { ...node, then: then ?? { op: 'sequence', steps: [] }, ...(node.else ? { else: otherwise ?? { op: 'sequence', steps: [] } } : {}) } : null;
    }
    if (PICKS.has(node.op) || PASSIVE.has(node.op)) return null;
    if (node.target && node.target.ref !== 'self') return null;
    if (node.recipient && node.recipient.ref !== 'self') return null;
    if (pickInside(node)) return null;
    return node;
  }
  async function runFor(fighter, events, env, eventPayload = null, depth = 0) {
    const idx = patdContent();
    // Their Abilities are disabled for now (Synchro Breaker — phase J).
    if (abilitiesOff(fighter.id, env.rt.temps)) return;
    // **Abilities do not work while Taken Out (book p.62; batch 5)** — except
    // at the start of their own turn (the Angel heals herself back up, the
    // Teacher still gains Mentor Tokens), on falling to zero (A Warrior's
    // Death) and when giving Heroic Spirit.
    // **1e patch review (decided):** at zero HP, the parts of an Ability that
    // affect only themselves still work (`selfOnlyEffect`); the parts that
    // target others, and passive effects, don't.
    const down = atZero(fighter.hp);
    const atZeroRule = (rule) => {
      if (!down || rule.events.some((e) => WORKS_AT_ZERO.has(e))) return rule;
      const effect = selfOnlyEffect(rule.effect);
      return effect ? { ...rule, effect } : null;
    };
    // Triggers registered for a while (phase G: `register_trigger`), as rules of their source.
    for (const t of env.rt.temps.filter((x) => x.trigger && x.ownerId === fighter.id && x.trigger.events.some((e) => events.includes(e)))) {
      if (stale(env)) return;
      const ability = idx.get(t.source) ?? { id: t.source, name: 'Trigger', rulesText: '' };
      const rule = atZeroRule({ id: `${t.source}:registered`, events: t.trigger.events, effect: t.trigger.effect });
      if (rule) await runOne(fighter, ability, rule, env, eventPayload, depth);
    }
    for (const abilityId of fighter.abilityIds) {
      if (stale(env)) return;
      // Built into the engine itself (phase F): Control's Copy / Dodge / Parry
      // (engine/actions.js) and Chaos's "as if you spent a 4" (reaction boards).
      if (ENGINE_NATIVE.has(abilityId)) continue;
      const ability = idx.get(abilityId);
      for (const rule of ability?.rules ?? []) {
        if (!rule.events.some((e) => events.includes(e))) continue;
        const live = atZeroRule(rule);
        if (!live) continue;
        // Run by the engine itself (coverage.js NATIVE_RULES).
        if (isNativeRule(rule)) continue;
        // Iron Form's extra Iron is the damage step's own (engine/hits.js).
        if (isIronAnySource(rule)) continue;
        await runOne(fighter, ability, live, env, eventPayload, depth);
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
      // Someone else's part of a shared choice (Song Form).
      askAs: (f) => ask(f, env.key, env.gen, env.tg, env.when),
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
    // Its line in the resolve stack: the one queued for it (a turn's plan), or a new one.
    const claimed = steps.claim(env.key, `${rule.id}@${fighter.id}`);
    const sid = claimed ?? steps.add(env.key, `${ability.name} (${fighter.name})`, 'now', { silent: true, arising: true, tag: `${rule.id}@${fighter.id}` });
    if (claimed) steps.set(env.key, sid, 'now');
    let ran = false;
    try {
      ran = Boolean((await runRule(rule, ctx))?.ran);
    } catch (err) {
      lines.push(`stopped: ${err.message}`);
    } finally {
      env.source = prevSource;
    }
    if (ran || lines.length) steps.set(env.key, sid, 'done');
    else steps.remove(env.key, sid);
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
    // A Stooges unit hears an event once — through the body it happened to,
    // else the first body that hears it (in range of any body = in range).
    const heard = new Set();
    const listeners = listenersFor(eventName, subject, env.world).filter((f) => {
      if (f.stoogeUnit == null) return true;
      if (subject && subject.stoogeUnit === f.stoogeUnit && f.id !== subject.id) return false;
      if (heard.has(f.stoogeUnit)) return false;
      heard.add(f.stoogeUnit);
      return true;
    });
    for (const f of listeners) {
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
    // Each part a named step of the resolve stack as it happens ("End Phase: Bo: Trap, 1 damage").
    const endNote = (text) => {
      notices.push(text);
      steps.add(env.key, `End Phase: ${text}`, 'done', { arising: true });
    };
    // Copies on a Trap are destroyed by its damage (book p.71; phase E).
    const trapDamage = (x) => (env.world.deadlyAt(x.square) ? 3 : 1);
    for (const c of [...(env.world.copies?.() ?? [])].filter(onTrap)) {
      const r = await env.world.damage(c, trapDamage(c), null, { source: 'trap' });
      endNote(`${c.name}: Trap, ${r.destroyed ? 'destroyed' : (r.steps ?? []).join(', ')}`);
    }
    for (const f of fighters.filter(onTrap)) {
      if (stale(env)) return;
      const r = await env.world.damage(f, trapDamage(f), null, { source: 'trap' });
      endNote(`${f.name}: ${env.world.deadlyAt(f.square) ? 'Deadly Trap' : 'Trap'}, ${r.immune ? 'immune' : `${r.taken} damage${r.steps.length ? ` (${r.steps.join(', ')})` : ''}`}`);
    }
    if (active && (active.tokens.burning ?? 0) > 0) {
      const held = active.tokens.burning;
      const r = await env.world.damage(active, held, null, { source: 'burning' });
      const discard = Math.ceil(held / 2);
      await env.world.discardTokens(active, ['burning'], discard);
      endNote(`${active.name}: Burning, ${r.immune ? 'immune' : `${r.taken} damage${r.steps.length ? ` (${r.steps.join(', ')})` : ''}`}, discards ${discard}`);
    }
    for (const f of fighters) {
      if (f.challengeId == null || !fighterRt(env.rt, f.id).flags.damagedChallenger) continue;
      const challenger = fighters.find((x) => x.id === f.challengeId);
      await queued(() => run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [f.id, f.challengeId]));
      f.challengeId = null;
      endNote(`${f.name} attacked ${challenger?.name ?? 'their Challenger'}: the Challenge is removed`);
    }
    const lost = [];
    for (const f of unitOnce(fighters)) {
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
    if (lost.length) endNote(`Speed discarded — ${lost.join(', ')}`);
    if (active && (active.tokens.fatigue ?? 0) > 0) {
      const start = fighterRt(env.rt, active.id).flags.startSquare;
      const still = start === undefined || (start == null && active.square == null) || (start && active.square && start.col === active.square.col && start.row === active.square.row);
      if (still) {
        const n = await env.world.discardTokens(active, ['fatigue'], 3);
        if (n) endNote(`${active.name} didn't move: discards ${n} Fatigue`);
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
  async function runContestHits(fightRow, combatantId, hits) {
    const { env, byId, world } = await envFor(fightRow);
    const target = byId(combatantId);
    if (!target) return;
    env.when = 'Stance Contest';
    for (const amount of hits) {
      const r = await world.damage(target, amount, null, { source: 'contest' });
      await postCard('reminder', { title: 'Survival', text: `${target.name} takes ${r.taken} of ${amount}${r.steps.length ? ` (${r.steps.join(', ')})` : ''}.`, fighters: [{ name: target.name }], automatic: 'contest', notice: true });
    }
    await emitStageUpdated();
    await env.save();
  }

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
      text: `${target.name} takes ${r.taken} damage${attacker ? ` from ${attacker.name}` : ''}${r.takenOut ? ' — Taken Out: no damage' : r.immune ? ' — immune' : r.steps.length ? ` (${amount}: ${r.steps.join(', ')})` : ''}.`,
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
  // **Victory Parameters (Fight Setup):** a winner is announced once, by a
  // card; the GM ends the fight (decided). Checked at every turn's end and at
  // every Round's end (lib/battleVictory.js).
  async function announceWin(env, side, why) {
    if (!side || env.rt.victory) return;
    env.rt.victory = { side, why };
    await postCard('reminder', {
      title: `Victory: ${SIDE_LABEL[side] ?? side} win`,
      text: `${why} The GM ends the fight (End Combat).`,
      fighters: [],
      automatic: 'victory',
    });
  }
  async function victoryCheck(env, world, fighters, { roundEnd = false, round = 1 } = {}) {
    const b = world.battle;
    if (!b || env.rt.victory) return;
    const o = b.victoryOpts ?? {};
    const all = fighters.filter((f) => !f.isCopy && f.side);
    let side = null;
    let why = '';
    if (b.victory === 'protect_the_vip') {
      // **Three sides (book p.49):** the side whose VIP falls first is removed
      // from play — the other two fight it out; the last side with its VIP wins.
      const sides = [...new Set(all.map((f) => f.side))];
      if (sides.length >= 3) {
        env.rt.vipOut ??= [];
        for (const s of sides) {
          const vip = all.find((f) => f.id === o.vips?.[s]);
          if (!vip || standing(vip) || env.rt.vipOut.includes(s)) continue;
          env.rt.vipOut.push(s);
          const theirs = all.filter((f) => f.side === s && f.square);
          for (const f of theirs) await world.removeFromPlay(f, { forGood: true });
          await postCard('reminder', { title: 'Protect the VIP', text: `${vip.name}, the ${SIDE_LABEL[s] ?? s}' VIP, has fallen: their side is out of the fight. The other two fight it out.`, fighters: [{ name: vip.name }], automatic: 'battle', notice: true });
        }
      }
      side = protectTheVip(all, o.vips);
      why = 'The other side’s VIP has fallen.';
    } else if (b.victory === 'outlast') {
      side = outlast(all, o.survivors, { roundEnd, round });
      why = side === o.survivors ? 'The Survivors held out for three Rounds.' : 'Every Survivor is down.';
    } else if (b.victory === 'king_of_the_hill') {
      if (roundEnd) side = kingOfTheHill(all, world.markers('king'));
      why = 'They alone hold the King Zone at the end of the Round.';
    } else if (b.victory === 'last_one_standing') {
      side = lastOneStanding(all);
      why = 'Only they remain standing.';
    } else if (b.victory === 'sabotage' && roundEnd) {
      // 3 Points wins; the Saboteurs without 3 by the end of round 3 are driven off.
      const pts = b.sabotage?.points ?? {};
      const sab = o.saboteurs;
      const won = ['allies', 'enemies', 'renegades'].filter((s) => (pts[s] ?? 0) >= 3 && (s === sab || s === 'renegades'));
      if (won.length > 1) {
        env.rt.victory = { side: null, why: 'both' };
        await postCard('reminder', { title: 'Sabotage: the Defense loses', text: 'The Saboteurs and the Renegades reach 3 Points together. The Defense is out; the other two fight on under a new Victory Parameter (the GM picks it). Nobody heals or discards; a new Round starts.', fighters: [], automatic: 'victory' });
        return;
      }
      if (won.length) {
        side = won[0];
        why = 'Their Bombs scored 3 Points.';
      } else if (sab && round >= 3) {
        side = sab === 'allies' ? 'enemies' : 'allies';
        why = 'The Saboteurs were driven off: no 3 Points by the end of round 3.';
      }
    }
    if (side) await announceWin(env, side, why);
  }

  // **The end of a Round (Fight Setup):** The Fight Must Go On! (every Victory
  // Parameter but Last One Standing and Outlast): everyone heals twice the
  // Heal Value. Outlast: the Attackers heal to full (they come back for free
  // at the new Round, as anyone does). Tournament Play: the round's loser,
  // the score, and a reset of positions, HP and tokens. Then who has won.
  async function runRoundEnd(fightRow) {
    const { env, world, fighters, movers } = await envFor(fightRow);
    const b = world.battle;
    env.when = `End of round ${fightRow.round}`;
    const people = fighters.filter((f) => !f.isCopy && f.side);
    if (b.victory === 'tournament') {
      await tournamentRoundEnd(env, world, movers, people, fightRow);
    } else if (!NO_GO_ON.has(b.victory) && !env.rt.victory) {
      const heal = 2 * (world.context.healValue ?? 0);
      for (const f of unitOnce(people)) if (f.square) await world.heal(f, heal);
      if (heal) await postCard('reminder', { title: 'The Fight Must Go On!', text: `End of round ${fightRow.round}: everyone heals ${heal} (twice the Heal Value).`, fighters: [], automatic: 'battle', notice: true });
    }
    // Arena Parameters at a Round's end. Traffic: anyone standing in the Danger
    // Zone takes 6 (Armor and Iron may reduce it). Pyroclasm: Rubble → Pit Traps.
    if (b.arena.includes('traffic')) {
      const zone = world.markers('danger');
      const hit = people.filter((f) => f.square && zone.some((z) => z.col === f.square.col && z.row === f.square.row));
      const said = [];
      for (const f of hit) {
        const r = await world.damage(f, 6, null, { source: 'traffic', allowIron: true });
        said.push(`${f.name} ${r?.taken ?? 6}`);
      }
      if (hit.length) await postCard('reminder', { title: 'Traffic', text: `End of round ${fightRow.round}: the Danger Zone hits — ${said.join(', ')} damage.`, fighters: hit.map((f) => ({ name: f.name })), automatic: 'battle', notice: true });
    }
    if (b.arena.includes('pyroclasm')) {
      const n = await world.rubbleToPitTraps();
      if (n) await postCard('reminder', { title: 'Pyroclasm', text: `End of round ${fightRow.round}: ${n} Rubble crumble${n === 1 ? 's' : ''} into Pit Traps.`, fighters: [], automatic: 'battle', notice: true });
    }
    // **Sabotage:** each Bomb in play scores 1 Point for its team.
    if (b.victory === 'sabotage') {
      const onMap = world.markers('bomb');
      const live = (b.sabotage?.bombs ?? []).filter((x) => onMap.some((t) => t.col === x.col && t.row === x.row));
      b.sabotage.bombs = live;
      for (const x of live) b.sabotage.points[x.side] = (b.sabotage.points[x.side] ?? 0) + 1;
      await world.saveBattle();
      const tally = Object.entries(b.sabotage.points).filter(([, n]) => n > 0).map(([s, n]) => `${SIDE_LABEL[s] ?? s} ${n}`).join(', ');
      await postCard('reminder', { title: 'Sabotage', text: `End of round ${fightRow.round}: ${live.length ? `${live.length} Bomb${live.length === 1 ? '' : 's'} score${live.length === 1 ? 's' : ''}` : 'no Bomb in play'}. Points: ${tally || 'none yet'} (3 wins).`, fighters: [], automatic: 'battle', notice: true });
    }
    if (b.victory === 'outlast' && b.victoryOpts?.survivors) {
      const attackers = people.filter((f) => f.side !== b.victoryOpts.survivors);
      for (const f of attackers) await world.restoreFull(f);
      if (attackers.length) await postCard('reminder', { title: 'Outlast', text: `End of round ${fightRow.round}: the Attackers heal to full and return to play.`, fighters: [], automatic: 'battle', notice: true });
    }
    await victoryCheck(env, world, people, { roundEnd: true, round: fightRow.round });
    await stoogeRefill(env, world, fighters, fightRow);
    await env.save();
  }

  // **Stooges at a new Round (decided):** a unit with fewer bodies standing than
  // it started with — and its bar not empty — gets new ones: the GM places each
  // (a square pick; Skip stops). A new body shares the unit's bar and tokens and
  // joins its side. On a lane the GM adds figures by hand (Change sides).
  async function stoogeRefill(env, world, fighters, fightRow) {
    const units = new Map();
    for (const f of fighters) {
      if (f.stoogeUnit == null || f.isCopy) continue;
      if (!units.has(f.stoogeUnit)) units.set(f.stoogeUnit, []);
      units.get(f.stoogeUnit).push(f);
    }
    if (!units.size) return;
    env.rt.stoogeStart ??= {};
    for (const [unit, bodies] of units) {
      const start = (env.rt.stoogeStart[unit] ??= bodies.length);
      const standing = bodies.filter((b) => !b.stoogeOut && b.square);
      const src = standing[0] ?? [...bodies].sort((a, b) => b.id - a.id)[0];
      if (!src || atZero(src.hp)) continue;
      const missing = start - standing.length;
      if (missing <= 0) continue;
      if (world.mode !== 'combat') {
        await postCard('reminder', { title: 'Stooges', text: `New Round: ${missing} Stooge${missing === 1 ? '' : 's'} down. Add ${missing === 1 ? 'a figure' : 'figures'} to the lane and bring ${missing === 1 ? 'it' : 'them'} in with Change sides (they share the unit's bar).`, fighters: [{ name: src.name }], automatic: 'battle', notice: true });
        continue;
      }
      let placed = 0;
      for (let i = 0; i < missing; i++) {
        const options = world.emptySquares().map((q) => ({ id: `${q.col},${q.row}`, label: `column ${q.col}, row ${q.row}`, col: q.col, row: q.row }));
        if (!options.length) break;
        const ans = await ask(src, env.key, env.gen, env.tg, `Round ${fightRow.round + 1}`)({ kind: 'square', mode: 'combat', title: `Stooges: place a new one (${i + 1} of ${missing})`, text: `${src.name}: ${missing} down since the fight began — place a new body (it shares the unit's bar and tokens). Skip to stop.`, options, minimum: 0, maximum: 1, skippable: true });
        const id = Array.isArray(ans) ? ans[0] : ans;
        const at = options.find((o) => o.id === id);
        if (!at) break;
        await queued(async () => {
          const r = await run(
            `INSERT INTO combatants (scene_id, mode, character_id, grid_col, grid_row, stooge_unit, stooge_out, tokens, challenge_id, hp_max, hp_current, hp_bars, hp_broken, dizzy, bled_round, active_stance_key, level, fighter_kind)
             SELECT scene_id, mode, character_id, ?, ?, stooge_unit, 0, tokens, challenge_id, hp_max, hp_current, hp_bars, hp_broken, dizzy, bled_round, active_stance_key, level, fighter_kind FROM combatants WHERE id = ?`,
            [at.col, at.row, src.id]
          );
          const newId = Number(r.lastInsertRowid);
          const col = src.side === 'allies' ? 'allies' : src.side === 'renegades' ? 'renegades' : 'enemies';
          const fr = await one(`SELECT ${col} AS ids FROM fights WHERE id = ?`, [fightRow.id]);
          let ids = [];
          try {
            ids = JSON.parse(fr?.ids || '[]');
          } catch {
            ids = [];
          }
          await run(`UPDATE fights SET ${col} = ? WHERE id = ?`, [JSON.stringify([...ids, newId]), fightRow.id]);
        });
        placed++;
        markDirty();
        await flushStage();
      }
      if (placed) await postCard('reminder', { title: 'Stooges', text: `New Round: ${placed} new Stooge${placed === 1 ? '' : 's'} join${placed === 1 ? 's' : ''} the fight.`, fighters: [{ name: src.name }], automatic: 'battle', notice: true });
    }
  }

  // Tournament Play: a lost Round scores for the other side and resets
  // everyone (start positions, full HP, no tokens or Challenges); a drawn
  // Round just goes on. Best of 3 or 5 (Fight Setup).
  async function tournamentRoundEnd(env, world, movers, people, fightRow) {
    const t = (env.rt.tournament ??= { positions: {}, score: {} });
    const loser = tournamentRoundLoser(people);
    if (!loser) {
      await postCard('reminder', { title: 'Tournament Play', text: `Round ${fightRow.round} is a draw: the fight goes on as it stands.`, fighters: [], automatic: 'battle', notice: true });
      return;
    }
    const winner = [...new Set(people.map((f) => f.side))].find((s) => s !== loser);
    t.score[winner] = (t.score[winner] ?? 0) + 1;
    const need = roundsToWin(world.battle.victoryOpts?.bestOf);
    const tally = Object.entries(t.score).map(([s, n]) => `${SIDE_LABEL[s] ?? s} ${n}`).join(' – ');
    if (t.score[winner] >= need) {
      await announceWin(env, winner, `They take the Tournament, ${tally}.`);
      return;
    }
    await postCard('reminder', { title: 'Tournament Play', text: `${SIDE_LABEL[winner] ?? winner} take round ${fightRow.round} (${tally}). Everyone resets: start positions, full HP, no tokens.`, fighters: [], automatic: 'battle', notice: true });
    // Off the board first, then each to their start, so nobody blocks anyone.
    for (const f of people) if (f.square) await movers.setSquare(f, null, null, { quiet: true });
    for (const f of people) {
      const at = t.positions[f.id];
      if (at) await movers.setSquare(f, at, 'teleport', { quiet: true });
      await world.restoreFull(f);
      await movers.writeTokens(f, (tok) => {
        for (const k of Object.keys(tok)) delete tok[k];
      });
      if (f.challengeId != null) {
        await run('UPDATE combatants SET challenge_id = NULL WHERE id = ?', [f.id]);
        f.challengeId = null;
      }
    }
  }

  // **Chained Down (Tilt):** each fighter on the side places their own Wall
  // next to them — their controller picks the square (decided). Its square is
  // remembered (`battle.chains`), so the Wall (then its Rubble) leashes them.
  async function runChainDown(fightRow, side) {
    const { env, world, fighters, movers } = await envFor(fightRow);
    env.when = 'Chained Down';
    const placed = [];
    for (const f of fighters.filter((x) => x.side === side && x.square && !x.isCopy)) {
      if (world.battle.chains[f.id]) continue;
      const b = movers.board();
      const options = sideSquares(f.square)
        .filter((sq) => world.canPlace('wall', sq) && isEmptyAt(b, sq))
        .map((sq) => ({ id: `${sq.col},${sq.row}`, label: `${sq.col},${sq.row}`, col: sq.col, row: sq.row }));
      if (!options.length) continue;
      const ans = options.length === 1
        ? options[0].id
        : await ask(f, env.key, env.gen, env.tg, env.when)({ kind: 'square', mode: fightRow.mode, title: `Chained Down: ${f.name}'s Wall`, text: `Place ${f.name}'s Wall next to them. They can't move more than 3 spaces from it (5 from its Rubble).`, options, minimum: 1, maximum: 1, skippable: false });
      const id = (Array.isArray(ans) ? ans[0] : ans) ?? options[0].id;
      const opt = options.find((o) => o.id === id) ?? options[0];
      const sq = { col: opt.col, row: opt.row };
      await world.placeObstacle('wall', sq, f);
      world.battle.chains[f.id] = sq;
      await updateBattle(fightRow.scene_id, fightRow.mode, (bt) => {
        bt.chains[f.id] = sq;
        return bt;
      });
      placed.push(f.name);
    }
    await env.save();
    await emitStageUpdated();
    if (placed.length) await postCard('reminder', { title: 'Chained Down', text: `${placed.join(', ')} ${placed.length === 1 ? 'is' : 'are'} chained to their own Wall: no more than 3 spaces from it, 5 from its Rubble, free once that is gone.`, fighters: placed.map((name) => ({ name })), automatic: 'battle', notice: true });
  }

  async function runFightStart(fightRow) {
    const { env, fighters, world } = await envFor(fightRow);
    // Stooges: how many bodies each unit started with (refilled to it each Round).
    env.rt.stoogeStart = {};
    for (const f of fighters) if (f.stoogeUnit != null && !f.isCopy && !f.stoogeOut) env.rt.stoogeStart[f.stoogeUnit] = (env.rt.stoogeStart[f.stoogeUnit] ?? 0) + 1;
    await env.save();
    // Tournament Play: everyone's start position, to reset to after a lost Round.
    if (world.battle.victory === 'tournament') {
      env.rt.tournament = { positions: Object.fromEntries(fighters.filter((f) => f.square && !f.isCopy).map((f) => [f.id, { ...f.square }])), score: {} };
      await env.save();
    }
    for (const f of unitOnce(fighters)) {
      if (f.abilityIds.includes(IMPROVED_WARRIOR)) await runFor(f, ['warrior_path.trigger'], env, {});
    }
    // **Lasting rules left to people (phase J):** each fighter's continuous
    // rules the engine doesn't enforce, said once at the start of the fight,
    // so nothing is dropped silently (lib/patd/coverage.js).
    // One card per Ability, with its rules text — the reminder itself (decided, fix).
    const idx = patdContent();
    for (const f of unitOnce(fighters)) {
      const ids = [...new Set(f.abilityIds)].filter((id) => !ENGINE_NATIVE.has(id) && (idx.get(id)?.rules ?? []).some((r) => r.events?.includes('continuous') && !isNativeRule(r) && !continuousSupport(r).ok));
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
    if (f.square || f.derived?.type?.id === 'character-type.stooges' || f.removedForGood) return false;
    if (!free && !((f.hp?.current ?? 0) >= 3)) return false;
    const b = movers.board();
    const squares = comebackSquares(b.home ?? b.bounds, (sq) => isEmptyAt(b, sq), { colsOnly: movers.mode === 'simple' });
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
  // **Transcendant Spirit (the Teacher's Super Move, the QA pass):** "When you
  // pass on your Heroic Spirit, you may declare you are using this Super Move.
  // If you do, instead of rolling your Action Dice this turn, give them the
  // maximum number each of those dice could have generated. Then, add an 8 to
  // their Action Pool, give them a 4-point Shield, and they heal." Counts as
  // the Super Move of the fight and of the side's Round. Changes `data`.
  const TRANSCENDANT = 'super-move.archetype-teacher.transcendant-spirit';
  async function transcendantSpirit(env, active, ally, data) {
    if (!(active.derived?.superMoveIds ?? []).includes(TRANSCENDANT)) return false;
    const rt = env.rt;
    const used = rt.usage[superKey(active.id)] ?? 0;
    const side = (rt.sides ??= {})[active.side] ??= { supersThisRound: 0 };
    const limit = env.world.context.superLimit ?? 1;
    if (!(env.world.context.round > 1) || used >= 1 || (side.supersThisRound ?? 0) >= limit) return false;
    const yes = await ask(active, env.key, env.gen, env.tg, env.when)({ kind: 'confirm', title: 'Transcendant Spirit', text: `Use your Super Move? ${ally.name}'s dice give their highest numbers, they add an 8, gain Shield 4 and heal.` });
    if (!yes) return false;
    data.results = (data.results ?? []).map((r) => (r.die ? { ...r, result: r.die, changed: true } : r));
    data.extra = [...(data.extra ?? []), { value: 8, source: 'ability' }];
    rt.usage[superKey(active.id)] = used + 1;
    side.supersThisRound = (side.supersThisRound ?? 0) + 1;
    return true;
  }

  // **Greater Frenzy (the QA pass):** "Once per fight, you may choose to use two
  // Frantic Abilities on the same turn" — asked as the turn starts.
  // **Improved Frenzy:** "Once per Round, after you see the results of your
  // Action Dice, you may change your Style or your Archetype" (its Frantic
  // Ability) — the dice stay; the Stance and its Abilities change.
  async function frenzy(env, active, when) {
    const d = active.derived;
    if (!assembles(d) || atZero(active.hp)) return;
    const row = await one('SELECT * FROM combatants WHERE id = ?', [active.id]);
    const pick = franticPickOf(row);
    if (!pick) return;
    const idx = patdContent();
    const save = async (next) => {
      await queued(() => run('UPDATE combatants SET frantic_pick = ? WHERE id = ?', [JSON.stringify(next), active.id]));
      const stance = stanceOfBuild(d, `${next.formId}+${next.styleId}`, idx);
      if (stance) {
        await queued(() => run('UPDATE combatants SET active_stance_key = ? WHERE id = ?', [stance.key, active.id]));
        active.stance = stance;
        await env.world.changePool(active, (data) => (data.stanceKey = stance.key));
      }
      active.abilityIds = [...new Set([...d.constantAbilityIds, ...[next.abilityId, next.abilityId2].filter(Boolean), ...(stance?.abilityIds ?? active.stance?.abilityIds ?? [])])];
      markDirtyFor();
    };
    const askIt = (q) => ask(active, env.key, env.gen, env.tg, env.when)(q);
    const one1 = (ans) => (Array.isArray(ans) ? ans[0] : ans);
    if (when === 'start' && active.abilityIds.includes('ability.feature-greater-frenzy.greater-frenzy') && !fighterRt(env.rt, active.id).fight.greaterFrenzyUsed && !pick.abilityId2) {
      const others = d.franticAbilityIds.filter((id) => id !== pick.abilityId);
      if (others.length) {
        const ans = one1(await askIt({ kind: 'choose', title: 'Greater Frenzy', text: 'Once per fight: use a second Frantic Ability this turn?', options: [{ id: 'none', label: 'Not this turn' }, ...others.map((id) => ({ id, label: idx.get(id)?.name ?? id }))], minimum: 1, maximum: 1 }));
        if (others.includes(ans)) {
          fighterRt(env.rt, active.id).fight.greaterFrenzyUsed = true;
          await save({ ...pick, abilityId2: ans });
          nativeStep(env, `Greater Frenzy (${active.name})`);
          await postCard('reminder', { title: 'Greater Frenzy', text: `${active.name} also uses ${idx.get(ans)?.name} this turn.`, fighters: [{ name: active.name }], automatic: 'ability', notice: true });
        }
      }
    }
    if (when === 'rolled' && active.abilityIds.includes('ability.feature-improved-frenzy.improved-frenzy')) {
      const key = `improved-frenzy:${active.id}:round`;
      if (env.rt.usage[key]) return;
      const opts = franticOptions(d, null, idx);
      const styles = opts.styles.filter((o) => o.id !== pick.styleId);
      const abilities = opts.abilities.filter((o) => o.id !== pick.abilityId && o.id !== pick.abilityId2);
      if (!styles.length && !abilities.length) return;
      const ans = one1(
        await askIt({
          kind: 'choose',
          title: 'Improved Frenzy',
          text: 'Once per Round: change your Style or your Archetype now?',
          options: [{ id: 'none', label: 'Keep them' }, ...styles.map((o) => ({ id: `style:${o.id}`, label: `Style: ${o.name}` })), ...abilities.map((o) => ({ id: `ability:${o.id}`, label: `Archetype: ${o.name}` }))],
          minimum: 1,
          maximum: 1,
        })
      );
      if (!ans || ans === 'none') return;
      const [kind, id] = String(ans).split(':');
      env.rt.usage[key] = 1;
      await save(kind === 'style' ? { ...pick, styleId: id } : { ...pick, abilityId: id });
      nativeStep(env, `Improved Frenzy (${active.name})`);
      await postCard('reminder', { title: 'Improved Frenzy', text: `${active.name} changes their ${kind === 'style' ? 'Style' : 'Archetype'} to ${idx.get(id)?.name}.`, fighters: [{ name: active.name }], automatic: 'ability', notice: true });
    }
  }
  const markDirtyFor = () => emitStageUpdated();

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
    await giveTurn(env, active, ally);
  }

  // **Protect the VIP (book p.49):** "Anyone can use Heroic Spirit to donate
  // their turn to the VIP, even if they are still in play and above zero HP."
  // At the start of each turn of a fighter on a side whose VIP is standing
  // (not the VIP themselves), they are asked — Yes gives the VIP this turn.
  async function vipSpirit(env, active) {
    const b = env.world.battle;
    if (b?.victory !== 'protect_the_vip' || !active.square || atZero(active.hp)) return;
    const vipId = b.victoryOpts?.vips?.[active.side];
    if (vipId == null || vipId === active.id) return;
    const vip = env.world.fighters().find((f) => f.id === vipId);
    if (!vip?.square || atZero(vip.hp)) return;
    const yes = await ask(active, env.key, env.gen, env.tg, env.when)({
      kind: 'confirm',
      title: 'Protect the VIP',
      text: `${active.name}: give this turn — your dice — to ${vip.name}, the VIP (Heroic Spirit)?`,
    });
    if (yes) await giveTurn(env, active, vip);
  }

  // Heroic Spirit's handover: the ally takes this turn with the giver's dice, in their own Stance.
  async function giveTurn(env, active, ally) {
    const board = await one('SELECT * FROM dice_marks WHERE combatant_id = ? AND active = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1', [active.id]);
    if (!board) return;
    const data = readBoardData(board);
    data.heroic = { combatantId: ally.id, characterId: ally.characterId, stanceKey: ally.stance?.key ?? null, stanceName: ally.stance?.name ?? null, name: ally.name, fromId: active.id };
    if (ally.stance?.key) data.stanceKey = ally.stance.key;
    const transcendant = await transcendantSpirit(env, active, ally, data);
    await queued(() => saveBoard(board.roll_id, data, (ev, p) => io.emit(ev, p)));
    if (transcendant) {
      await env.world.gainShield(ally, 4);
      await env.world.heal(ally, env.world.context.healValue);
      nativeStep(env, `Transcendant Spirit (${active.name})`);
      await postCard('reminder', { title: 'Transcendant Spirit', text: `${active.name}'s Super Move: ${ally.name}'s dice give their highest numbers, an 8 joins the Action Pool, Shield 4, and they heal.`, fighters: [{ name: active.name }, { name: ally.name }], automatic: 'ability', notice: true });
    }
    // "When you give your Heroic Spirit" (the Teacher's Mentor tokens …).
    await emitEvent(env, 'self.giving_heroic_spirit', active, { ally });
    await postCard('reminder', { title: 'Heroic Spirit', text: `${active.name} gives their turn to ${ally.name}.`, fighters: [{ name: active.name }, { name: ally.name }], automatic: 'ability', notice: true });
  }

  // **The Action Pool at a turn's start and end (the QA pass, native):**
  //   - Mythical Freestyle: "Whenever you roll a 3 or less on the mythical d12,
  //     re-roll it" — every d12 of the roll, until it shows 4 or more;
  //   - Persistant Freestyle: "When you discard numbers from your Action Pool
  //     during the End Phase, you may keep up to two of them with a total
  //     value of 5 or less" — picked at the turn's end, back in the pool when
  //     their next turn starts.
  // A rule the engine ran itself, shown in the resolve stack by name.
  const nativeStep = (env, label) => steps.add(env.key, label, 'done', { arising: true });
  const hasRule = (f, ruleId) => !atZero(f.hp) && f.abilityIds.includes(ruleId.split('.rule-')[0]);
  async function turnStartPool(env, active) {
    const world = env.world;
    const kept = fighterRt(env.rt, active.id).fight.keptNumbers ?? [];
    if (kept.length) {
      for (const v of kept) await world.addPoolNumber(active, v);
      fighterRt(env.rt, active.id).fight.keptNumbers = [];
      nativeStep(env, `Persistant Freestyle (${active.name})`);
      await postCard('reminder', { title: 'Persistant Freestyle', text: `${active.name} kept ${kept.join(' and ')} from last turn.`, fighters: [{ name: active.name }], automatic: 'ability', notice: true });
    }
    if (hasRule(active, 'ability.freestyle-mythical.mythical-freestyle.rule-1')) {
      const lines = [];
      for (const p of (world.pool(active) ?? []).filter((x) => x.die === 12 && !x.added && x.value <= 3)) {
        let value = p.value;
        for (let i = 0; i < 50 && value <= 3; i++) value = 1 + Math.floor(Math.random() * 12);
        await world.changePool(active, (d) => setPoolValue(d, p.index, value));
        lines.push(`${p.value} → ${value}`);
      }
      if (lines.length) nativeStep(env, `Mythical Freestyle (${active.name})`);
      if (lines.length) await postCard('reminder', { title: 'Mythical Freestyle', text: `${active.name} re-rolls the mythical d12: ${lines.join(', ')}.`, fighters: [{ name: active.name }], automatic: 'ability', notice: true });
    }
  }
  async function keepPoolNumbers(env, active) {
    if (!hasRule(active, 'ability.freestyle-persistant.persistant-freestyle.rule-2')) return;
    const pool = (env.world.pool(active) ?? []).filter((p) => p.value <= 5);
    if (!pool.length) return;
    const ans = await ask(active, env.key, env.gen, env.tg, env.when)({
      kind: 'targets',
      title: 'Persistant Freestyle',
      text: 'Keep up to two numbers for your next turn, with a total of 5 or less.',
      options: pool.map((p) => ({ id: String(p.index), label: String(p.value) })),
      minimum: 0,
      maximum: 2,
      skippable: true,
    });
    const ids = (Array.isArray(ans) ? ans : ans == null ? [] : [ans]).map(String);
    let picks = pool.filter((p) => ids.includes(String(p.index))).slice(0, 2);
    // More than 5 in all: the higher one is let go.
    while (picks.reduce((n, p) => n + p.value, 0) > 5) picks = picks.sort((a, b) => a.value - b.value).slice(0, -1);
    if (!picks.length) return;
    fighterRt(env.rt, active.id).fight.keptNumbers = picks.map((p) => p.value);
    nativeStep(env, `Persistant Freestyle (${active.name})`);
    await postCard('reminder', { title: 'Persistant Freestyle', text: `${active.name} keeps ${picks.map((p) => p.value).join(' and ')} for their next turn.`, fighters: [{ name: active.name }], automatic: 'ability', notice: true });
  }

  // **Tilted Parameters at the start of a turn (Fight Setup).** Weakened State:
  // the tilted side's active character gains 1 Burning, 1 Weakness, 1 Fatigue.
  // Overwhelming Power: whoever takes a turn on any OTHER side gains 1 Power,
  // 1 Iron and 1 Speed. Both through the engine, so they animate and trigger.
  // **Factory (Arena Parameter):** at the end of every turn, every unit and
  // obstacle on a Conveyor Belt moves 1 space the way it runs — those farthest
  // along first, so a queue moves together. A fighter may spend 1 Iron or 1
  // Speed to stay put (asked; an NPC set to Auto stays only when the belt would
  // carry them onto a Trap, Pit or Rubble, or Outside). Obstacles move with the
  // stacking rules; a Wall stops where a unit stands.
  async function factoryBelts(env, world, fighters) {
    if (world.mode !== 'combat' || !world.battle?.arena?.includes('factory')) return;
    const belts = world.beltSquares();
    if (!belts.length) return;
    const ahead = (x, dir) => x.col * dir.dc + x.row * dir.dr;
    const said = [];
    const riders = [...fighters, ...(world.copies?.() ?? [])].filter((f) => f.square && world.beltAt(f.square));
    riders.sort((a, b) => ahead(b.square, world.beltAt(b.square)) - ahead(a.square, world.beltAt(a.square)));
    for (const f of riders) {
      if (stale(env)) return;
      const dir = world.beltAt(f.square);
      if (!dir) continue;
      const next = { col: f.square.col + dir.dc, row: f.square.row + dir.dr };
      if (!f.isCopy) {
        const can = ['iron', 'speed'].filter((k) => (f.tokens[k] ?? 0) > 0);
        let stay = null;
        if (can.length) {
          const mode = f.prefs?.iron ?? 'auto';
          if (mode === 'auto') {
            const bad = !world.inBounds?.(next) || world.obstacleAt(next) != null;
            stay = bad ? can[0] : null;
          } else if (mode === 'ask') {
            const options = [{ id: 'ride', label: 'Ride the belt' }, ...can.map((k) => ({ id: k, label: `Spend 1 ${k === 'iron' ? 'Iron' : 'Speed'}: stay put` }))];
            const ans = await ask(f, env.key, env.gen, env.tg, 'Factory')({ kind: 'choose', title: 'Conveyor Belt', text: `${f.name} is on a Conveyor Belt: it carries them 1 space.`, options, minimum: 1, maximum: 1 });
            const id = Array.isArray(ans) ? ans[0] : ans;
            stay = can.includes(id) ? id : null;
          }
        }
        if (stay) {
          await world.discardTokens(f, [stay], 1);
          said.push(`${f.name} spends 1 ${stay === 'iron' ? 'Iron' : 'Speed'} to stay put`);
          continue;
        }
      }
      const origin = { col: f.square.col - dir.dc, row: f.square.row - dir.dr };
      const was = f.square;
      await world.forced(f, { distance: 1, origin, chooser: null, willing: true, straight: dir });
      if (!f.square || f.square.col !== was.col || f.square.row !== was.row) said.push(`${f.name} rides the belt`);
    }
    // The obstacles on the belts, farthest along first.
    const loads = belts.filter((b) => b.obstacles.length).sort((a, b) => ahead(b, b.dir) - ahead(a, a.dir));
    for (const b of loads) {
      const to = { col: b.col + b.dir.dc, row: b.row + b.dir.dr };
      if (world.inBounds && !world.inBounds(to)) continue;
      for (const kind of b.obstacles) {
        if (kind === 'wall' && fighters.some((f) => f.square && f.square.col === to.col && f.square.row === to.row)) continue;
        await world.moveObstacle({ square: { col: b.col, row: b.row }, kind }, to);
      }
      said.push(`${b.obstacles.map((k) => TILE_BY_KEY[k]?.name ?? k).join(' + ')} moves along the belt`);
    }
    if (said.length) await postCard('reminder', { title: 'Factory', text: `${said.join('. ')}.`, fighters: [], automatic: 'battle', notice: true });
  }

  async function battleTurnStart(env, world, fighters, active) {
    const b = world.battle;
    if (!b) return;
    const said = [];
    if (tiltOn(b, active.side) === 'weakened_state') {
      for (const k of ['burning', 'weakness', 'fatigue']) await world.gainTokens(active, k, 1);
      said.push('Weakened State: +1 Burning, +1 Weakness, +1 Fatigue');
    }
    const outmatched = Object.entries(b.tilts).some(([side, k]) => k === 'overwhelming_power' && side !== active.side && fighters.some((f) => f.side === side));
    if (outmatched) {
      for (const k of ['power', 'iron', 'speed']) await world.gainTokens(active, k, 1);
      said.push('Overwhelming Power: +1 Power, +1 Iron, +1 Speed');
    }
    // Protect the VIP: at the start of their turn the VIP discards a Challenge
    // that isn't another VIP's.
    const vips = Object.values(b.victoryOpts?.vips ?? {});
    if (b.victory === 'protect_the_vip' && vips.includes(active.id) && active.challengeId != null && !vips.includes(active.challengeId)) {
      if (await world.removeChallenge(active, active)) said.push('Protect the VIP: discards the Challenge they held');
    }
    if (said.length) await postCard('reminder', { title: 'Tilted Parameter', text: `${active.name} — ${said.join('; ')}.`, fighters: [{ name: active.name }], automatic: 'battle', notice: true });
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
      if (newRound) for (const f of fighters.filter((x) => !x.square)) await tracked(env, `Comeback (${f.name})`, () => comeback(env, movers, f, { free: true }));
      if (!active.square) await tracked(env, `Comeback (${active.name})`, () => comeback(env, movers, active, { free: false }));
    }
    // Where the turn began (the End Phase's Fatigue: "did not move").
    if (moment === 'start') fighterRt(rt, active.id).flags.startSquare = active.square ?? null;
    env.when = `${moment === 'start' ? 'Start' : 'End'} of ${active.name}'s turn`;
    world.context.activeCharacter = active;
    // Fight Setup's Tilts that act at the start of a turn (Weakened State, Overwhelming Power).
    if (moment === 'start' && !stale(env) && active.square) await battleTurnStart(env, world, fighters, active);
    // "At the start of your next turn …" effects scheduled earlier (phase G).
    if (moment === 'start') await runScheduled(env, 'next_turn.start', (s) => s.ownerId === active.id && s.seq < rt.turnSeq);
    // "If they take the next turn for their side …" (Showdown — the QA pass):
    // settled when the next turn of the target's side begins, whoever takes it.
    if (moment === 'start') {
      const sideOfTarget = (s) => byId(s.captured?.targets?.target?.ref)?.side ?? null;
      await runScheduled(env, 'target_side.next_turn.selected', (s) => s.seq < rt.turnSeq && sideOfTarget(s) === active.side);
    }
    if (moment === 'start' && !stale(env)) await turnStartPool(env, active);
    if (moment === 'start' && !stale(env)) await frenzy(env, active, 'start');
    // (Stooges: the active unit is the active body alone; any other unit is heard once.)
    const order = [active, ...unitOnce(fighters.filter((f) => f.id !== active.id && (f.stoogeUnit == null || f.stoogeUnit !== active.stoogeUnit)))];
    // The Abilities this moment runs, by name, in the order they will run.
    const planned = planSteps(env, order.map((f) => ({ f, events: turnEvents(moment, relationTo(f, active)) })));
    for (const f of order) await runFor(f, turnEvents(moment, relationTo(f, active)), env, { activeCharacter: active });
    unplan(env, planned);
    // Phase 3 of the turn: still Taken Out? Heroic Spirit.
    if (moment === 'start' && !stale(env) && (!active.square || atZero(active.hp))) await tracked(env, `Heroic Spirit (${active.name})`, () => heroicSpirit(env, active).then(() => true));
    // Protect the VIP: anyone may give their turn to their side's VIP.
    if (moment === 'start' && !stale(env) && active.square && !atZero(active.hp)) await vipSpirit(env, active);
    // "After you roll your Action Dice" (phase G): the turn's dice are on its board.
    if (moment === 'start' && !stale(env) && active.square && !atZero(active.hp)) {
      await frenzy(env, active, 'rolled');
      await runFor(active, ['self.action_dice.rolled'], env, { activeCharacter: active });
    }
    if (moment === 'end') {
      if (!stale(env)) await keepPoolNumbers(env, active);
      // "At the end of this turn …" effects scheduled during it, before the End Phase.
      await runScheduled(env, 'current_turn.end', () => true);
      // Factory's belts first: Speed held now can still keep someone in place
      // (the End Phase discards it), and a Trap they ride onto bites once.
      if (!stale(env)) await factoryBelts(env, world, fighters);
      await runEndPhase(env, fighters, onTrap, active);
      expireTemps(rt, 'end_of_turn', { activeId });
      // Victory Parameters: has anyone won? (King of the Hill waits for the Round's end.)
      await victoryCheck(env, world, fighters, { round: fightRow.round });
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
    const planned = planSteps(env, [{ f: active, events: ['own_action_phase.start'] }]);
    await runFor(active, ['own_action_phase.start'], env, { activeCharacter: active });
    unplan(env, planned);
    await env.save();
  }

  const idleHooks = [];
  // `label`: this job's line in the resolve stack (none: it shows no step of its own).
  const onChain = (fightRow, job, label = null) => {
    const key = `${fightRow.scene_id}:${fightRow.mode}`;
    const g = gen(key);
    const prev = chains.get(key) ?? Promise.resolve();
    // **The "Resolving" plaque (decided, batch 4):** everyone is told when a
    // fight starts working through something and when it is all done.
    // Still lingering from the last job: this one carries the same stack on.
    if (lingering.has(key)) {
      clearTimeout(lingering.get(key));
      lingering.delete(key);
    }
    const first = !(busy.get(key) > 0);
    busy.set(key, (busy.get(key) ?? 0) + 1);
    const sid = label ? steps.add(key, label, 'queued', { silent: true }) : null;
    if (first || sid != null) steps.emit(key);
    const next = prev
      .then(() => {
        if (gen(key) !== g) return null;
        if (sid != null) steps.set(key, sid, 'now');
        return job();
      })
      .catch((err) => console.error('turn triggers', err))
      .finally(() => {
        if (sid != null) steps.set(key, sid, 'done', { silent: true });
        const left = (busy.get(key) ?? 1) - 1;
        if (left > 0) {
          busy.set(key, left);
          if (sid != null) steps.emit(key);
          return;
        }
        busy.delete(key);
        // Done: the stack stays up for a moment (all ticked), then goes —
        // unless more work starts meanwhile and carries it on.
        if ((stacks.get(key) ?? []).length) {
          steps.emit(key);
          lingering.set(
            key,
            setTimeout(() => {
              lingering.delete(key);
              if ((busy.get(key) ?? 0) > 0) return;
              steps.clear(key);
              io.emit('fight:resolving', { sceneId: fightRow.scene_id, mode: fightRow.mode, busy: false, steps: [] });
            }, LINGER_MS)
          );
        } else {
          steps.clear(key);
          io.emit('fight:resolving', { sceneId: fightRow.scene_id, mode: fightRow.mode, busy: false, steps: [] });
        }
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

  // What a fighter can pay with beyond their own tokens (server/diceMarks.js
  // fighterState): for the dice board's affordability and the payment itself.
  setPayableHook(async (row) => {
    const fight = await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [row.scene_id, row.mode]);
    if (!fight) return null;
    const { env, byId } = await envFor(fight);
    const f = byId(row.id);
    if (!f) return null;
    const mods = env.world.mods(f);
    return {
      tokens: Object.fromEntries(['iron', 'power', 'speed'].map((k) => [k, env.world.spendable(f, k)])),
      costReduction: valueOf(mods, 'action_cost.reduction', null),
      // Luck pays for Token Actions only with the Underdog's mechanic.
      luck: f.abilityIds.includes('ability.resource-mechanic-luck.luck-mechanics') ? (f.tokens.luck ?? 0) : 0,
    };
  });

  // **Performing Actions** (engine/actions.js): Commit and Retrieve on the board.
  const runner = createActionRunner({
    envFor,
    ask,
    emitEvent,
    postCard,
    emitStageUpdated,
    emit: (ev, payload) => io.emit(ev, payload),
    queued,
    steps,
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
    const active0 = fighters.find((x) => x.id === activeId);
    for (const f of unitOnce(fighters)) {
      if (f.id === activeId || except.includes(f.id) || !f.derived) continue;
      if (active0?.stoogeUnit != null && f.stoogeUnit === active0.stoogeUnit) continue;
      const out = !f.square || atZero(f.hp);
      const t = turnActions(f.derived, f.stance, idx);
      // No Stance (Dizzy, 1e patch review): no Unique Actions — Basic only.
      const ids = [...t.basic, ...(f.stanceLost ? [] : t.personal.flatMap((g) => g.ids))].filter((id) => !out || idx.get(id)?.usableWhileTakenOut);
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
      return [...new Set([...[...busy.entries()].filter(([, n]) => n > 0).map(([k]) => k), ...lingering.keys()])].map((k) => [k]).map(([k]) => ({ sceneId: Number(k.split(':')[0]), mode: k.split(':')[1], busy: true, steps: (stacks.get(k) ?? []).map(({ label, state }) => ({ label, state })) }));
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
      const { world, byId, env } = await envFor(fightRow);
      const f = byId(id);
      if (!f?.square || !world.spaces) return { combatantId: id, squares: [] };
      // **The real reach (decided, play feedback):** every square an Action
      // of theirs can come from — their own (their Stance range with every
      // range modifier, Disarmed included), each of their Copies' (an Action
      // may be taken from a Copy's location), and, with Mastermind Style,
      // each ally in sight (who performs it with their own range).
      const origins = [f, ...(world.copies?.() ?? []).filter((c) => c.ownerId === f.id && c.square).map((c) => ({ ...f, square: c.square }))];
      const mastermind = !atZero(f.hp) && (f.abilityIds ?? []).some((aid) => (patdContent().get(aid)?.rules ?? []).some((r) => r.effect?.op === 'delegate_actions'));
      if (mastermind && env) origins.push(...world.alliesOf(f).filter((a) => a.id !== f.id && a.square && !atZero(a.hp) && world.inRange(f, a, { mode: 'visible', origin: 'self' })));
      const out = new Map();
      for (const o of origins) {
        for (const sq of world.spaces(o, { mode: 'stance' }, {})) {
          if (origins.some((x) => x.square.col === sq.col && x.square.row === sq.row)) continue;
          out.set(`${sq.col},${sq.row}`, { col: sq.col, row: sq.row });
        }
      }
      return { combatantId: id, squares: [...out.values()] };
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
    // **GM Rewind:** the fight was stepped back — its Free Movement take-backs are gone.
    rewound(fightRow) {
      for (const k of [...freeUndo.keys()]) if (k.startsWith(`${fightRow.id}:`)) freeUndo.delete(k);
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
      return { cost: f ? moves.handCost(movers, f, to, env) : null, speed: f?.tokens.speed ?? 0, fatigue: f?.tokens.fatigue ?? 0 };
    },
    freeMove(fightRow, combatantId, to) {
      return onChain(fightRow, async () => {
        const { env, byId, movers } = await envFor(fightRow);
        env.when = 'Free Movement';
        const mark = await rewindMark(fightRow.id);
        const r = await moves.freeMove(env, movers, byId(combatantId), to);
        if (r?.ok) await keepRewindMark(fightRow.id, `Free Movement (${byId(combatantId)?.name ?? 'someone'})`, mark);
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
        const mark = await rewindMark(fightRow.id);
        const r = await moves.freeSwap(env, movers, byId(combatantId), byId(allyId));
        if (r?.ok) await keepRewindMark(fightRow.id, `Swap (${byId(combatantId)?.name ?? 'someone'})`, mark);
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
    // The Round ended (fights.js advance): Victory Parameters' round-end rules.
    roundEnd(fightRow) {
      return onChain(fightRow, () => runRoundEnd(fightRow));
    },
    // Chained Down set on a side: its Walls, on the fight's chain.
    chainDown(fightRow, side) {
      return onChain(fightRow, () => runChainDown(fightRow, side));
    },
    // A fight began: forget any old fight state, then "start of combat" rules.
    startFight(fightRow) {
      reset(`${fightRow.scene_id}:${fightRow.mode}`);
      return onChain(fightRow, () => runFightStart(fightRow));
    },
    // **Survival (Stance Contests):** hits taken in a row at the turn's end, on its chain.
    contestHits(fightRow, combatantId, hits) {
      return onChain(fightRow, () => runContestHits(fightRow, combatantId, hits));
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

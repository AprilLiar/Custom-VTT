// **Stance Contests (GM Tools, decided).** Two sides compete over something
// without fighting (yet) — the book's 12 contests or a custom one. Each
// contestant plays one turn, all at the same time, in **their own hidden
// mini-arena**: a Scene of the contest (`scenes.contest_id`, never listed) in
// Combat mode, holding their own fighter (fresh HP from their build, no
// tokens) and their targets — hidden characters (`characters.hidden`) with
// infinite HP, or 1 HP that comes back (Hundred-Hand), which never take a turn.
// Every arena is an ordinary fight run by the real engine, so every Action and
// Ability works; Super Moves are refused. A contestant's turn ending snapshots
// what they did; when every arena is done the result (client/src/lib/contests.js)
// is posted as a card and the arenas are deleted. Nothing carries over.
import { all, one, run } from './db.js';
import { CONTEST_BY_KEY, STATUS_TOKENS, contestResult, normalizeCustom } from '../client/src/lib/contests.js';
import { barHp } from '../client/src/lib/cinematicWeight.js';
import { gridDistance } from '../client/src/lib/patd/engine/board.js';
import { loadAllDerived, setupFromDerived } from './fighterStances.js';
import { shapeFightState, hpOf } from './combatState.js';
import { loadCombatTokens } from './combatMap.js';
import { loadFightState } from './fights.js';
import { activeBoardOf, endTurnDice } from './diceMarks.js';
import { controlsCharacter } from './control.js';

const ARENA = { col: 4, row: 4 }; // where a contestant stands; targets around them
const AROUND = [
  { col: 5, row: 4 },
  { col: 4, row: 5 },
  { col: 3, row: 4 },
  { col: 4, row: 3 },
  { col: 5, row: 5 },
];
const SKILL_KEYS = new Set(['basic_tokens', 'dice_d8', 'dice_2d6', 'dice_3d4', 'plus_two']);
const BASIC = new Set(['power', 'iron', 'speed']);

const parse = (s, d) => {
  try {
    return JSON.parse(s ?? '') ?? d;
  } catch {
    return d;
  }
};

export const contestOfScene = async (sceneId) => (await one('SELECT contest_id FROM scenes WHERE id = ?', [sceneId]))?.contest_id ?? null;
export const runningContest = () => one("SELECT * FROM contests WHERE status IN ('prep', 'running') ORDER BY id DESC LIMIT 1");
const defOf = (row) => {
  const d = parse(row.def, {});
  return d.key === 'custom' ? normalizeCustom(d) : CONTEST_BY_KEY[d.key] ?? CONTEST_BY_KEY.sumo;
};

// What everyone's contest window shows (null when none is running).
export async function contestState() {
  // The running one — or the latest, while its result is fresh (30 s after it ended).
  const latest = await one('SELECT * FROM contests ORDER BY id DESC LIMIT 1');
  const row = (await runningContest()) ?? (latest?.status === 'done' && latest.finished_at && Date.now() - Number(latest.finished_at) < 30000 ? latest : null);
  if (!row) return null;
  const def = defOf(row);
  const arenas = parse(row.arenas, []);
  const out = [];
  for (const a of arenas) {
    const tokens = row.status === 'done' ? [] : await loadCombatTokens(a.sceneId);
    const board = row.status === 'done' ? null : await activeBoardOf(a.combatantId);
    out.push({
      ...a,
      rollId: board?.roll_id ?? null,
      tokens,
      fight: row.status === 'done' ? null : await loadFightState(a.sceneId, 'combat'),
    });
  }
  return { id: row.id, def, status: row.status, arenas: out, result: parse(row.result, null) };
}

// A fighter's level and HP table from their build (Fight Setup's rules).
async function freshHp(characterId, weightKey) {
  const d = (await loadAllDerived()).get(characterId);
  const setup = d ? setupFromDerived(d) : { level: 1, kind: 'hero', health_bars: 1 };
  const hp = (barHp(weightKey, setup.kind ?? 'hero', setup.level ?? 1) || 16) + (Number(setup.bar_bonus) || 0);
  return { max: hp, bars: Math.min(9, Math.max(1, setup.health_bars ?? 1)), level: setup.level ?? 1, kind: setup.kind ?? 'hero' };
}

// The HP someone has left in all, every unbroken bar counted (Survival's measure).
const hpLeft = (row) => {
  const h = hpOf(row);
  if (h.max == null) return 0;
  return Math.max(0, h.current) + Math.max(0, h.bars - h.broken - 1) * h.max;
};

// **Starting a contest (GM).** `def`: { key } of the book's, or a custom one;
// `sides`: { a: [characterId], b: [characterId] }.
export async function startContest({ def: rawDef, sides, originSceneId, skillsOn }) {
  if (await runningContest()) return { error: 'a contest is already running' };
  const def = rawDef?.key === 'custom' ? normalizeCustom(rawDef) : CONTEST_BY_KEY[rawDef?.key];
  const a = [...new Set((sides?.a ?? []).map(Number).filter(Number.isInteger))];
  const b = [...new Set((sides?.b ?? []).map(Number).filter(Number.isInteger) .filter((id) => !a.includes(id)))];
  if (!def || !a.length || !b.length) return { error: 'pick a contest and someone on each side' };
  const origin = originSceneId ? await one('SELECT simple_weight, combat_weight FROM scenes WHERE id = ?', [originSceneId]) : null;
  const weight = origin?.combat_weight || origin?.simple_weight || 'middle';
  const r = await run("INSERT INTO contests (def, sides, status) VALUES (?, ?, 'prep')", [JSON.stringify(def.key === 'custom' ? def : { key: def.key }), JSON.stringify({ a, b })]);
  const contestId = Number(r.lastInsertRowid);
  const arenas = [];
  for (const [side, ids] of [['a', a], ['b', b]]) {
    for (const characterId of ids) {
      const ch = await one('SELECT name FROM characters WHERE id = ?', [characterId]);
      if (!ch) continue;
      const scene = await run("INSERT INTO scenes (name, combat_mode, contest_id) VALUES (?, 'combat', ?)", [`Contest: ${ch.name}`, contestId]);
      const sceneId = Number(scene.lastInsertRowid);
      const hp = await freshHp(characterId, weight);
      const me = await run(
        `INSERT INTO combatants (scene_id, mode, character_id, grid_col, grid_row, tokens, hp_max, hp_current, hp_bars, hp_broken, level, fighter_kind)
         VALUES (?, 'combat', ?, ?, ?, '{}', ?, ?, ?, 0, ?, ?)`,
        [sceneId, characterId, ARENA.col, ARENA.row, hp.max, hp.max, hp.bars, hp.level, hp.kind]
      );
      const combatantId = Number(me.lastInsertRowid);
      // Their targets.
      const dummyIds = [];
      const starts = {};
      const n = def.setup?.dummies ?? 0;
      for (let i = 0; i < n && i < AROUND.length; i++) {
        const label = def.setup?.javelin ? 'Javelin' : `Target ${i + 1}`;
        const dc = await run("INSERT INTO characters (name, character_type, hidden) VALUES (?, 'npc', 1)", [label]);
        const infinite = def.setup?.dummyHp == null;
        const hpMax = infinite ? 99 : def.setup.dummyHp;
        const sq = AROUND[i];
        const d = await run(
          `INSERT INTO combatants (scene_id, mode, character_id, grid_col, grid_row, tokens, hp_max, hp_current, hp_bars, hp_broken, infinite_hp, dummy)
           VALUES (?, 'combat', ?, ?, ?, '{}', ?, ?, 1, 0, ?, ?)`,
          [sceneId, Number(dc.lastInsertRowid), sq.col, sq.row, hpMax, hpMax, infinite ? 1 : 0, def.setup?.respawn ? 2 : 1]
        );
        const did = Number(d.lastInsertRowid);
        dummyIds.push(did);
        starts[did] = sq;
      }
      const f = await run(
        "INSERT INTO fights (scene_id, mode, allies, enemies, round, turn_order, turn_index) VALUES (?, 'combat', ?, ?, 1, ?, 0)",
        [sceneId, JSON.stringify([combatantId]), JSON.stringify(dummyIds), JSON.stringify([{ side: 'allies', id: combatantId }])]
      );
      arenas.push({ sceneId, fightId: Number(f.lastInsertRowid), combatantId, characterId, name: ch.name, side, dummyIds, starts, ready: !skillsOn, done: false, stats: null });
    }
  }
  await run("UPDATE contests SET arenas = ?, status = 'running' WHERE id = ?", [JSON.stringify(arenas), contestId]);
  return { contestId, arenas };
}

export async function saveArenas(contestId, arenas) {
  await run('UPDATE contests SET arenas = ? WHERE id = ?', [JSON.stringify(arenas), contestId]);
}

// **Skill bonuses (Skills on):** chosen before rolling. 3 Basic tokens (the
// player's mix), green dice added to the roll, or +2 to one number after.
export function cleanBonuses(list) {
  return (Array.isArray(list) ? list : [])
    .filter((b) => SKILL_KEYS.has(b?.key))
    .slice(0, 6)
    .map((b) => (b.key === 'basic_tokens' ? { key: b.key, tokens: (Array.isArray(b.tokens) ? b.tokens : []).filter((t) => BASIC.has(t)).slice(0, 3) } : { key: b.key }));
}

// What a contestant did, read when their turn ends (before the End Phase).
export async function snapshotStats(arena, def) {
  const me = await one('SELECT * FROM combatants WHERE id = ?', [arena.combatantId]);
  const board = await activeBoardOf(arena.combatantId);
  const data = parse(board?.data, {});
  const pool = [...(data.results ?? []), ...(data.extra ?? [])].map((r) => Number(r?.result ?? r?.value)).filter(Number.isFinite);
  const dummies = arena.dummyIds.length ? await all(`SELECT * FROM combatants WHERE id IN (${arena.dummyIds.map(() => '?').join(',')})`, arena.dummyIds) : [];
  const status = (row) => STATUS_TOKENS.reduce((n, k) => n + (shapeFightState(row).tokens[k] ?? 0), 0);
  let pushDistance = 0;
  for (const d of dummies) {
    const start = arena.starts?.[d.id];
    if (start && d.grid_col != null) pushDistance = Math.max(pushDistance, gridDistance(start, { col: d.grid_col, row: d.grid_row }));
  }
  return {
    pool,
    tokens: me ? shapeFightState(me).tokens : {},
    dummyStatus: dummies.reduce((n, d) => n + status(d), 0),
    biggestHit: { damage: dummies.reduce((m, d) => Math.max(m, d.damage_max ?? 0), 0), push: 0 },
    totalDamage: dummies.reduce((n, d) => n + (d.damage_taken ?? 0), 0),
    pushDistance,
    felled: dummies.reduce((n, d) => n + (d.felled ?? 0), 0),
    hpBefore: me ? hpLeft(me) : 0,
    hpLost: 0,
    def: def.key,
  };
}
export const hpLeftOf = async (combatantId) => {
  const row = await one('SELECT * FROM combatants WHERE id = ?', [combatantId]);
  return row ? hpLeft(row) : 0;
};

// Every arena done: the result, then the arenas go.
export async function finishContest(contestId) {
  const row = await one('SELECT * FROM contests WHERE id = ?', [contestId]);
  if (!row || row.status === 'done') return null;
  const def = defOf(row);
  const arenas = parse(row.arenas, []);
  const result = contestResult(
    def,
    arenas.map((a) => ({ side: a.side, id: a.characterId, stats: a.stats ?? {} }))
  );
  const names = Object.fromEntries(arenas.map((a) => [a.characterId, a.name]));
  const shown = {
    winner: result.winner,
    best: Object.fromEntries(Object.entries(result.best).map(([side, v]) => [side, { name: names[v.id], score: v.score.map((x) => (Number.isFinite(x) ? x : null)) }])),
    scores: arenas.map((a) => ({ name: a.name, side: a.side, stats: a.stats })),
  };
  await run("UPDATE contests SET status = 'done', result = ?, finished_at = ? WHERE id = ?", [JSON.stringify(shown), Date.now(), contestId]);
  await dropArenas(arenas);
  return { def, result: shown, arenas };
}

// Deletes every trace of a contest's arenas (fights, boards, fighters, targets, Scenes).
export async function dropArenas(arenas) {
  for (const a of arenas) {
    await endTurnDice([a.combatantId], null).catch(() => {});
    await run('DELETE FROM dice_marks WHERE combatant_id = ?', [a.combatantId]);
    await run('DELETE FROM fights WHERE scene_id = ?', [a.sceneId]);
    await run('DELETE FROM map_tiles WHERE scene_id = ?', [a.sceneId]);
    const dummyChars = a.dummyIds.length ? await all(`SELECT character_id FROM combatants WHERE id IN (${a.dummyIds.map(() => '?').join(',')})`, a.dummyIds) : [];
    await run('DELETE FROM combatants WHERE scene_id = ?', [a.sceneId]);
    for (const d of dummyChars) await run('DELETE FROM characters WHERE id = ? AND hidden = 1', [d.character_id]);
    await run('DELETE FROM scenes WHERE id = ? AND contest_id IS NOT NULL', [a.sceneId]);
  }
}

export const mayActFor = (viewer, characterId) => viewer?.role === 'gm' || controlsCharacter(viewer, characterId);

// A full fake fight world for running content rules in tests (allRules.test.js,
// branches.test.js): four fighters, obstacles, a Copy, Action Pools.
import { patdContent } from '../patdContent.js';
import { runRule } from '../../client/src/lib/patd/interpreter.js';

const C = patdContent().content;
const sq = (col, row) => ({ col, row });
const dist = (a, b) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);

export function makeWorld() {
  const mk = (id, side, col, row) => ({
    id,
    characterId: id,
    name: `F${id}`,
    side,
    square: sq(col, row),
    tokens: { power: 2, iron: 2, speed: 3, shield: 2, burning: 1, fatigue: 1, weakness: 1, luck: 2, poltergeist: 2, mentor: 1, training: 2, control: 3, chaos: 1 },
    hp: { max: 10, current: 8, bars: 1, broken: 0 },
    bleeding: false,
    abilityIds: [],
    stance: { range: { minimum: 1, maximum: 3 }, key: 'k' },
    challengeId: null,
    get space() {
      return this.square;
    },
    get statusTokenCount() {
      return 3;
    },
    actionPool: [{ index: 0, value: 5 }],
    performedActionThisTurn: false,
    tookDamageThisTurn: false,
    obstaclesDestroyedThisTurn: 0,
    standingOnWall: false,
    standingOnPit: false,
    inFog: false,
    takenOut: false,
    hpLostThisTurn: 1,
    currentBar: { damage: 2 },
  });
  const me = mk(1, 'a', 4, 4);
  const ally = mk(2, 'a', 4, 5);
  const foe = mk(3, 'b', 5, 4);
  const foe2 = mk(4, 'b', 6, 4);
  foe.challengeId = me.id;
  const fighters = [me, ally, foe, foe2];
  const tiles = [
    { kind: 'wall', square: sq(3, 3) },
    { kind: 'rubble', square: sq(5, 5) },
    { kind: 'trap', square: sq(6, 5) },
    { kind: 'fog', square: sq(5, 4) },
  ];
  const copies = [{ id: 'copy:1', isCopy: true, ownerId: me.id, name: "F1's Copy", side: 'a', square: sq(3, 4), tokens: {}, kind: 'copy' }];
  const obstacleOf = (t) => ({ id: `${t.square.col},${t.square.row}:${t.kind}`, isObstacle: true, kind: t.kind, name: t.kind, square: t.square });
  const pools = new Map(fighters.map((f) => [f.id, [{ index: 0, value: 5, die: 6 }, { index: 1, value: 3, die: 6 }, { index: 2, value: 7, die: 8, added: false }]]));
  const all = () => [...fighters, ...copies];
  const world = {
    mode: 'combat',
    context: { healValue: 2, bleedValue: 4, round: 2, activeCharacter: me },
    fighters: () => fighters,
    enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
    alliesOf: (f) => fighters.filter((x) => x.side === f.side),
    inRange: (from, to, range) => {
      if (!from?.square || !to?.square) return range?.mode === 'none' || range?.mode === 'map';
      const d = dist(from.square, to.square);
      switch (range?.mode) {
        case 'adjacent':
          return d === 1;
        case 'explicit':
          return d >= (range.minimum ?? 0) && d <= (range.maximum ?? 99);
        case 'none':
        case 'map':
        case 'visible':
          return true;
        default:
          return d >= 0 && d <= 4;
      }
    },
    heldTokens: (f) => ({ ...f.tokens }),
    mods: () => [],
    spendable: (f, k) => f.tokens[k] ?? 0,
    spend: async (f, k, n) => {
      const t = Math.min(n, f.tokens[k] ?? 0);
      f.tokens[k] = (f.tokens[k] ?? 0) - t;
      return t;
    },
    gainTokens: async (f, k, n) => (f.isCopy ? null : (f.tokens[k] = (f.tokens[k] ?? 0) + n)),
    discardTokens: async (f, keys, n) => {
      let left = n;
      for (const k of keys) {
        const t = Math.min(left, f.tokens?.[k] ?? 0);
        if (f.tokens) f.tokens[k] -= t;
        left -= t;
      }
      return n - left;
    },
    gainShield: async (f, v) => (f.tokens.shield = Math.max(v, (f.tokens.shield ?? 0) + 1)),
    tempArmor: async (f) => (f.tokens.temp_armor = 1),
    heal: async (f, n) => {
      if (f.isCopy) return 0;
      f.hp.current = Math.min(f.hp.max, f.hp.current + n);
      return n;
    },
    payHp: async (f, n) => (f.hp.current -= n),
    damage: async (f, n) => {
      if (f.isCopy) return { taken: 1, steps: [], destroyed: true };
      f.hp.current = Math.max(0, f.hp.current - n);
      return { taken: n, toHp: n, dealt: n, steps: [], absorbed: 0, pushBonus: 0, pushResist: 0 };
    },
    challenge: async (t, c) => {
      t.challengeId = c.id;
      return { given: true };
    },
    challengeRemovable: (h) => h.challengeId != null,
    removeChallenge: async (h) => {
      h.challengeId = null;
      return true;
    },
    addPoolNumber: async (f, v) => pools.get(f.id)?.push({ index: pools.get(f.id).length, value: v, added: true }),
    pool: (f) => (f?.isCopy ? [] : pools.get(f.id) ?? []),
    changePool: async (f) => ({}),
    actionsFor: () => [C.actions[0]],
    performAction: async () => ({ ok: true, lines: [], manual: [] }),
    move: async (f) => sq(f.square.col, f.square.row + 1),
    teleport: async (f) => sq(f.square.col, f.square.row - 1),
    teleportTo: async (f, s) => (f.square = s),
    forced: async (f) => f.square,
    forcedObstacle: async (o) => o.square,
    swap: async () => true,
    swapWithObstacle: async () => true,
    spaces: (from, range, { empty = false } = {}) => {
      const out = [];
      for (let c = 0; c < 10; c++) for (let r = 0; r < 10; r++) {
        const s = sq(c, r);
        if (empty && all().some((x) => x.square && dist(x.square, s) === 0)) continue;
        if (world.inRange(from, { square: s }, range)) out.push(s);
      }
      return out;
    },
    obstacles: (from, range, { types = null } = {}) => [...tiles.map(obstacleOf), ...copies].filter((o) => (!types || types.includes(o.kind)) && world.inRange(from, o, range)),
    copies: () => copies,
    canPlace: () => true,
    placeObstacle: async (kind, s, owner) => {
      if (kind === 'copy') {
        const c = { id: `copy:${copies.length + 2}`, isCopy: true, ownerId: owner?.id, name: 'Copy', side: owner?.side, square: s, tokens: {}, kind: 'copy' };
        copies.push(c);
        return c;
      }
      tiles.push({ kind, square: s });
      return obstacleOf({ kind, square: s });
    },
    destroyObstacle: async () => true,
    replaceObstacle: async () => true,
    addTemp: async () => true,
    schedule: async () => true,
    inFog: (s) => tiles.some((t) => t.kind === 'fog' && dist(t.square, s) === 0),
    obstacleAt: (s) => tiles.some((t) => dist(t.square, s) === 0),
    obstacleDestinations: (o) => [sq(o.square.col + 1, o.square.row)],
    moveObstacle: async () => true,
    returnToPlay: async (f, s) => (f.square = s),
    removeFromPlay: async (f) => (f.square = null),
  };
  return { world, me, ally, foe, foe2 };
}

// Answers every question: the first legal option (or the `pick`-th), yes to every "you may".
export const answerWith = (pick = 0) => async (q) => {
  if (q.kind === 'confirm') return true;
  const opts = (q.options ?? []).filter((o) => o.id !== '__skip');
  if (!opts.length) return [];
  const n = Math.max(1, Math.min(q.minimum || 1, opts.length));
  const from = Math.min(pick, opts.length - n);
  return opts.slice(from, from + n).map((o) => o.id);
};
const answer = answerWith(0);

export async function runIt(label, rule, { gate, self = 'me', event = {}, lines = [], pick = 0, trace = null, tweak = null } = {}) {
  const w = makeWorld();
  if (tweak) tweak(w);
  const by = [];
  const ctx = {
    world: w.world,
    self: w[self],
    state: { mood: 'rage', moodToken: 'burning', song: 'power', weapon: 'club', ammo: 'tracer' },
    usage: {},
    ability: { id: rule.id, name: label },
    log: (l) => lines.push(l),
    ask: answerWith(pick),
    askAs: () => answerWith(pick),
    trace,
    emit: async () => null,
    notify: async () => null,
    event: { activeCharacter: w.me, target: w.foe, attacker: w.foe, amount: 2, damage: 2, enemy: w.foe, enemiesDamaged: [w.foe], enemiesForcedMoved: [w.foe], alliesForcedMoved: [], actionTargets: [w.foe], enemyTargets: [w.foe], distinctTargetCount: 1, obstaclesDestroyed: [sq(5, 5)], controlledActor: w.foe, formerHolder: w.foe, die: { result: 2 }, movedSwappedOrTeleportedSelf: true, shieldBroke: true, isCostPayment: false, source: w.foe, enemyDamageDealers: [w.foe], enemyCount: 1, sourceType: 'trap', wall: { isObstacle: true, kind: 'wall', square: sq(3, 3) }, actor: w.foe, ...event },
    resolution: { gateRating: gate },
    payment: { rating: gate, poolNumbers: [gate], tokens: {}, hp: 1, challengeHolder: 3, additionalBasicTokens: 2, selectedOptionCount: 2, totalPoltergeistSpentIncludingCost: 1 },
    history: {},
    mustTarget: null,
    onUnsupported: (node) => by.push(node.op ?? 'step'),
  };
  await runRule(rule, ctx);
  return by;
}


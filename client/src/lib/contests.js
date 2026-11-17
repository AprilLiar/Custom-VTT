// **Stance Contests (book pp.86-89): the catalog and the scoring.** Pure and
// shared — the server scores, every client shows the same table. What each
// contestant did in their own mini-arena is gathered into `stats`:
//   { pool: [numbers], tokens: { key: n }, dummyStatus: n, biggestHit: { damage, push },
//     totalDamage: n, pushDistance: n, felled: n, hpLost: n }
// A side's result is its best contestant's (book p.87).

// Basic tokens that count as Status for Big Game: the negative ones.
export const STATUS_TOKENS = ['burning', 'fatigue', 'weakness', 'dizzy_token', 'stun'];

// measure: what is compared. better: 'high' | 'low'. setup: the arena.
//   dummies: how many targets stand in range; dummyHp: null = infinite;
//   respawn: a felled one is replaced at once; hits: [damage…] taken at the turn's end.
export const CONTESTS = [
  { key: 'big_game', name: 'Big Game', kind: 'dummy', measure: 'dummy_status', better: 'high', setup: { dummies: 1, dummyHp: null },
    text: 'A single target with infinite HP each. Whoever’s target holds the most Status tokens at the end of the turn wins.', examples: 'Catch the biggest dinosaur, put down a bear.' },
  { key: 'crushing', name: 'Crushing', kind: 'dummy', measure: 'biggest_hit', better: 'high', setup: { dummies: 1, dummyHp: null },
    text: 'A single target with infinite HP. The most damage in a single hit wins; on a tie, the hit that would have pushed farther.', examples: 'Karate-chop the most tiles.' },
  { key: 'dance', name: 'Dance', kind: 'tokens', measure: 'tokens:speed', better: 'high', setup: {},
    text: 'The most Speed tokens wins.', examples: 'A race, a quick-draw, an actual dance-off.' },
  { key: 'hundred_hand', name: 'Hundred-Hand', kind: 'dummy', measure: 'felled', better: 'high', setup: { dummies: 3, dummyHp: 1, respawn: true },
    text: 'Three targets with 1 HP are always within range; a felled one is replaced at once. Whoever fells the most by the end of the turn wins.', examples: 'Defeat more henchmen than your rival.' },
  { key: 'fencing', name: 'Fencing', kind: 'dice', measure: 'pool_matching', better: 'high', setup: {},
    text: 'Roll your Action Dice only. The most matching numbers wins; a tie goes to the higher value (three 6s beat three 4s).', examples: 'Chess, darts, a fencing match.' },
  { key: 'gambling', name: 'Gambling', kind: 'dice', measure: 'pool_highest', better: 'high', setup: {},
    text: 'Roll your Action Dice only. The highest number wins; on a tie compare the next highest, and so on.', examples: 'Poker, a bet, the roulette wheel.' },
  { key: 'javelin', name: 'Javelin', kind: 'dummy', measure: 'push_distance', better: 'high', setup: { dummies: 1, dummyHp: null, javelin: true },
    text: 'Each starts next to their own Javelin (infinite HP, targeted as an enemy). Whoever pushes it farthest from where it started wins.', examples: 'A home-run contest, a bus pull.' },
  { key: 'macho', name: 'Macho', kind: 'dummy', measure: 'total_damage', better: 'high', setup: { dummies: 1, dummyHp: null },
    text: 'A single target with infinite HP. The most total damage dealt to it wins.', examples: 'Wrecking a car, stupid shows of strength.' },
  { key: 'negotiation', name: 'Negotiation', kind: 'dice', measure: 'pool_negotiation', better: 'high', setup: {},
    text: 'Roll your Action Dice only. The fewest matching numbers wins; if nobody matches, the highest number; if everybody does, the highest-value pair. Three or more matching loses outright.', examples: 'An argument, a barter.' },
  { key: 'sumo', name: 'Sumo', kind: 'tokens', measure: 'tokens:iron', better: 'high', setup: {},
    text: 'The most Iron tokens wins.', examples: 'An eating contest, staying in the ring.' },
  { key: 'survival', name: 'Survival', kind: 'endure', measure: 'hp_lost', better: 'low', setup: { hits: [5, 5, 5] },
    text: 'At the end of the turn each takes three 5-damage hits in a row. Whoever lost the least HP wins. (It doesn’t carry into the fight.)', examples: 'An avalanche, a hail of gunfire.' },
  { key: 'wrestling', name: 'Wrestling', kind: 'tokens', measure: 'tokens:power', better: 'high', setup: {},
    text: 'The most Power tokens wins.', examples: 'Arm-wrestling, a deadlift.' },
];
export const CONTEST_BY_KEY = Object.fromEntries(CONTESTS.map((c) => [c.key, c]));

// What a custom contest can measure (the GM's builder).
export const MEASURES = [
  { key: 'tokens', label: 'Tokens of a kind held at the turn’s end', needsToken: true },
  { key: 'dummy_status', label: 'Status tokens on their target', needsDummy: true },
  { key: 'biggest_hit', label: 'Damage — the biggest single hit', needsDummy: true },
  { key: 'total_damage', label: 'Damage — the total dealt', needsDummy: true },
  { key: 'push_distance', label: 'How far they push their target', needsDummy: true },
  { key: 'felled', label: 'Targets felled', needsDummy: true },
  { key: 'hp_lost', label: 'HP lost' },
  { key: 'pool_highest', label: 'Dice pool — the highest numbers' },
  { key: 'pool_matching', label: 'Dice pool — the most matching numbers' },
  { key: 'pool_fewest', label: 'Dice pool — the fewest matching numbers' },
];

// A custom contest, normalized: { measure, token?, better, setup: { dummies, dummyHp, respawn, hits }, text }.
export function normalizeCustom(c = {}) {
  const m = MEASURES.find((x) => x.key === c.measure) ?? MEASURES[0];
  const n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.trunc(Number(v)) || d));
  const setup = c.setup ?? {};
  return {
    key: 'custom',
    name: String(c.name ?? '').trim().slice(0, 60) || 'Custom contest',
    kind: m.needsDummy ? 'dummy' : m.key.startsWith('pool') ? 'dice' : 'tokens',
    measure: m.key === 'tokens' ? `tokens:${String(c.token ?? 'iron')}` : m.key,
    better: c.better === 'low' ? 'low' : 'high',
    setup: {
      dummies: m.needsDummy ? n(setup.dummies, 1, 5, 1) : n(setup.dummies, 0, 5, 0),
      dummyHp: setup.dummyHp == null || setup.dummyHp === '' ? null : n(setup.dummyHp, 1, 99, 1),
      respawn: Boolean(setup.respawn),
      hits: (Array.isArray(setup.hits) ? setup.hits : []).map((h) => n(h, 1, 50, 5)).slice(0, 10),
    },
    text: String(c.text ?? '').trim().slice(0, 400),
  };
}

const counts = (pool) => {
  const m = new Map();
  for (const v of pool ?? []) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
};
// The biggest group of matching numbers: { size, value } (size 1 = no match).
export function bestMatch(pool) {
  let best = { size: 0, value: 0 };
  for (const [value, size] of counts(pool)) if (size > best.size || (size === best.size && value > best.value)) best = { size, value };
  return best;
}
const desc = (pool) => [...(pool ?? [])].sort((a, b) => b - a);

// A comparable score: an array compared element by element, bigger is better
// (a 'low' measure is negated). `-Infinity` first marks an outright loss.
export function scoreOf(contest, stats = {}, everyone = []) {
  const m = contest.measure;
  const flip = (arr) => (contest.better === 'low' ? arr.map((x) => -x) : arr);
  if (m.startsWith('tokens:')) return flip([stats.tokens?.[m.slice(7)] ?? 0]);
  switch (m) {
    case 'dummy_status':
      return flip([stats.dummyStatus ?? 0]);
    case 'biggest_hit':
      return flip([stats.biggestHit?.damage ?? 0, stats.biggestHit?.push ?? 0]);
    case 'total_damage':
      return flip([stats.totalDamage ?? 0]);
    case 'push_distance':
      return flip([stats.pushDistance ?? 0]);
    case 'felled':
      return flip([stats.felled ?? 0]);
    case 'hp_lost':
      return flip([stats.hpLost ?? 0]);
    case 'pool_highest':
      return flip(desc(stats.pool));
    case 'pool_matching': {
      const b = bestMatch(stats.pool);
      return flip([b.size, b.value]);
    }
    case 'pool_fewest': {
      const b = bestMatch(stats.pool);
      return flip([-b.size, ...desc(stats.pool)]);
    }
    case 'pool_negotiation': {
      // Three or more matching loses outright.
      const b = bestMatch(stats.pool);
      if (b.size >= 3) return [-Infinity];
      const anyMatch = (st) => bestMatch(st.pool).size >= 2;
      const all = everyone.length ? everyone : [stats];
      // Everybody matches: the highest-value pair wins.
      if (all.every(anyMatch)) return [b.value];
      // Otherwise the fewest matching wins, then the highest number.
      return [-b.size, ...desc(stats.pool)];
    }
    default:
      return [0];
  }
}

export function compareScores(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -Infinity;
    const y = b[i] ?? -Infinity;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// **The result.** `entries`: [{ side, id, stats }]. → { winner: side | null
// (a tie), best: { side: { id, score } }, order: sides best first }.
export function contestResult(contest, entries) {
  const everyone = entries.map((e) => e.stats ?? {});
  const best = {};
  for (const e of entries) {
    const score = scoreOf(contest, e.stats ?? {}, everyone);
    if (!best[e.side] || compareScores(score, best[e.side].score) > 0) best[e.side] = { id: e.id, score };
  }
  const order = Object.keys(best).sort((x, y) => compareScores(best[y].score, best[x].score));
  const tie = order.length > 1 && compareScores(best[order[0]].score, best[order[1]].score) === 0;
  return { winner: order.length && !tie ? order[0] : null, best, order };
}

// The Stance Check bonuses a Skill grants (book p.87), chosen before rolling.
export const SKILL_BONUSES = [
  { key: 'basic_tokens', label: 'Gain 3 Basic tokens of your choice' },
  // Green dice, as the book's icons show (p.82): one d8, two d6, three d4.
  { key: 'dice_d8', label: 'Add a green d8 to your Action Dice', dice: [8] },
  { key: 'dice_2d6', label: 'Add two green d6 to your Action Dice', dice: [6, 6] },
  { key: 'dice_3d4', label: 'Add three green d4 to your Action Dice', dice: [4, 4, 4] },
  { key: 'plus_two', label: 'After rolling, raise one number by 2' },
];

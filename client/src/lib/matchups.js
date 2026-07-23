// Pure matchup math over the ruleset fetched from /api/ruleset.
// A stance is 2 styles; your score vs an enemy style-pair is the sum over all
// cross pairs: +bonus where your style defeats theirs, -bonus where theirs
// defeats yours (same-style pairs contribute 0).

// counters rows -> Map(attackerId -> Map(defenderId -> bonus))
export function buildBeats(counters) {
  const beats = new Map();
  for (const row of counters) {
    if (!beats.has(row.attacker_attribute_id)) beats.set(row.attacker_attribute_id, new Map());
    beats.get(row.attacker_attribute_id).set(row.defender_attribute_id, row.bonus);
  }
  return beats;
}

export function pairScore(myPair, enemyPair, beats) {
  let score = 0;
  for (const mine of myPair) {
    for (const theirs of enemyPair) {
      if (mine === theirs) continue;
      score += beats.get(mine)?.get(theirs) ?? 0;
      score -= beats.get(theirs)?.get(mine) ?? 0;
    }
  }
  return score;
}

// Every possible enemy stance (all unordered style pairs), scored and sorted
// best-for-you first.
export function rankMatchups(myPair, attributes, counters) {
  const beats = buildBeats(counters);
  const ranked = [];
  for (let i = 0; i < attributes.length; i++) {
    for (let j = i + 1; j < attributes.length; j++) {
      const pair = [attributes[i].id, attributes[j].id];
      ranked.push({ pair, score: pairScore(myPair, pair, beats) });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

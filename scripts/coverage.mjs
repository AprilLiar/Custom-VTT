// The automation census (full automation, phase J): what the engine runs and
// what it leaves by hand, with why. No server needed.
//
//   node scripts/coverage.mjs           the totals and the reasons
//   node scripts/coverage.mjs --list    every by-hand entry
import { patdContent } from '../server/patdContent.js';
import { census } from '../client/src/lib/patd/coverage.js';

const idx = patdContent();
const report = census(idx.content);
const list = process.argv.includes('--list');
const name = (id) => idx.get(id)?.name ?? id;

for (const [label, t] of [
  ['Ability rules (triggered)', report.abilities.triggered],
  ['Ability rules (continuous)', report.abilities.continuous],
  ['Actions', report.actions],
  ['Super Moves', report.supers],
]) {
  console.log(`\n${label}: ${t.automatic} of ${t.total} automatic (${Math.round((100 * t.automatic) / Math.max(1, t.total))}%)`);
  const reasons = {};
  for (const b of t.byHand) (reasons[b.reason] ??= []).push(b.id);
  for (const [reason, ids] of Object.entries(reasons).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(3)} by hand — ${reason}${list ? '' : `: ${ids.slice(0, 3).map(name).join(', ')}${ids.length > 3 ? ', …' : ''}`}`);
    if (list) for (const id of ids) console.log(`        ${name(id)} (${id})`);
  }
}

// Playtest: the Arena survives a half-written fight (bugfix).
//
// `GET /api/combat` is the Arena's whole world. If it throws, the page has no
// partial state to fall back on — it simply never leaves its loading gate, with
// nothing on screen to say why. That makes every unguarded `JSON.parse` on this
// path a single point of failure for the entire screen, and the values being
// parsed are the least trustworthy rows in the database: mid-round pause
// payloads, written by a resolution that a redeploy or a free-tier spin-down
// may have interrupted halfway through.
//
// Every case below used to be a 500 and an Arena nobody could open. They now
// degrade to "this pair has no prompt", loudly logged, with the rest of the
// fight intact — the GM can clear the pair and re-run the round.
//
// Only a live server can show this: the failure is in the shaping of a REST
// payload from deliberately corrupt rows, which no unit test reaches.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3041 node server/index.js
//   E2E_URL=http://localhost:3041 node scripts/playtest-arena-resilience.mjs
import { io } from 'socket.io-client';
const BASE = process.env.E2E_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const gm = io(BASE); await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
gm.emit('identity:set', { role: 'gm' }); await sleep(400);
const stamp = Date.now();
const a = await jpost('/api/characters', { name: `A${stamp}`, characterType: 'npc' });
const d = await jpost('/api/characters', { name: `D${stamp}`, characterType: 'npc' });
// `combat:add_participant`, not `combat:seat` — the latter does not exist, and
// emitting it seated nobody, so `combat:next_round` was a no-op and the whole
// script tested an empty Arena while reporting success. Waiting on the
// broadcast rather than sleeping is the other half of not lying: a fixed sleep
// cannot tell "it worked" from "it silently did nothing".
gm.emit('combat:add_participant', { characterId: a.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === a.id));
gm.emit('combat:add_participant', { characterId: d.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === d.id));
gm.emit('combat:next_round', {});
await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

// **Must be the same database the server is serving.** This was hardcoded at
// first, so the script corrupted one file while the server read another and
// every probe passed without testing anything — the exact shape of a
// performance measurement that cannot fail. It is required rather than
// defaulted for the same reason: a wrong-but-plausible default is what made the
// first version lie.
if (!process.env.PLAYTEST_DB) {
  console.error('PLAYTEST_DB must be the same TURSO_DATABASE_URL the server was started with.');
  process.exit(1);
}
process.env.TURSO_DATABASE_URL = process.env.PLAYTEST_DB;
const { run, all } = await import('../server/db.js');
let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok ? '' : ' — ' + detail}`);
};

// Prove the harness is actually pointed at the server's database before
// trusting a single result below.
{
  const marker = `probe-${Date.now()}`;
  await run('INSERT INTO tells (name) VALUES (?)', [marker]);
  const seen = await fetch(`${BASE}/api/tells`).then((r) => r.json());
  check(
    'the harness and the server share a database',
    Array.isArray(seen) && seen.some((t) => t.name === marker),
    'PLAYTEST_DB does not match the server — every probe below would be meaningless'
  );
  const pairs = await all('SELECT pair_index FROM combat_pairs');
  check(
    'a real fight is open, so shapePair actually runs',
    pairs.length > 0,
    'combat_pairs is empty — shapePair is never called and the pause payloads below are never parsed'
  );
  if (fails) process.exit(1);
}
// `pairs` alone is not an assertion: it is `[]` when no fight exists, which is
// truthy, so an empty Arena would pass every probe below while parsing nothing.
// Requiring a real pair is what makes the corrupt rows actually reachable —
// shapePair only runs for rows that exist in combat_pairs.
const hit = async (label) => {
  const r = await fetch(`${BASE}/api/combat?role=gm`);
  const body = await r.text();
  let detail = body.slice(0, 200);
  const ok =
    r.status === 200 &&
    (() => {
      try {
        const payload = JSON.parse(body);
        if (!Array.isArray(payload.pairs) || payload.pairs.length === 0) {
          detail = 'no pairs in the payload, so nothing below is being exercised';
          return false;
        }
        return true;
      } catch {
        return false;
      }
    })();
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label} — ${r.status}${ok ? '' : ' ' + detail}`);
};

await hit('baseline');
// Starting a round may already have opened a resolution for this pair, and the
// table is unique per open pair — clear it so the corrupt row below is the one
// under test rather than a constraint error.
await run(`DELETE FROM pair_round_resolutions WHERE pair_index = 0`);
await run(
  `INSERT INTO pair_round_resolutions (pair_index, round_number, fight_number, round_start_tic, round_length, status, pending_defense_json)
   VALUES (0, 1, 1, 0, 7, 'paused_defense', '{ this is not json')`
);
await hit('corrupt Block pause payload');
await run(`UPDATE pair_round_resolutions SET status='paused_dodge', pending_dodge_json='nonsense{{', pending_defense_json=NULL WHERE pair_index=0`);
await hit('corrupt Dodge pause payload');
await run(`UPDATE pair_round_resolutions SET status='paused_grapple', pending_grapple_json='}{', pending_dodge_json=NULL WHERE pair_index=0`);
await hit('corrupt grapple pause payload');
await run(`UPDATE pair_round_resolutions SET status='paused_conflict', pending_conflict_json='[[[', pending_grapple_json=NULL WHERE pair_index=0`);
await hit('corrupt conflict pause payload');
await run(`UPDATE pair_round_resolutions SET status='paused_defense', pending_defense_json='{"valid":"json","but":"wrong shape"}', pending_conflict_json=NULL WHERE pair_index=0`);
await hit('valid JSON of the wrong shape');
await run('DELETE FROM combat_state WHERE id = 1');
await hit('combat_state row deleted');
const restored = await all('SELECT * FROM combat_state WHERE id = 1');
check('combat_state was re-created', restored.length === 1);
console.log(fails === 0 ? '\nall probes passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

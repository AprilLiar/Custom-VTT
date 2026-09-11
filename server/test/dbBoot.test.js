// **Booting must never hang (bugfix — Render deploys that timed out having
// printed nothing at all).**
//
// `createClient` used to run at module scope in db.js. With a `syncUrl` its
// constructor performs a blocking `PullDb`, and the whole libSQL binding is
// synchronous, so against a primary that does not answer it never returns:
// no throw, no timeout, no output. ES imports are evaluated before a single
// statement of server/index.js runs, so the process froze before its first
// log line and before it listened on a port. From Render's side that is
// indistinguishable from a dead service — "No open ports detected... Timed
// Out" — with nothing in the log to say why.
//
// The replica is gone now (see the note at the top of db.js), which removes
// that particular blocking call — but the property it taught is the one worth
// keeping, and it is broader than the bug: **importing this module must do no
// I/O**, so index.js can bind its port and raise its 503 gate before anything
// else is attempted. Both halves are pinned here because neither can be
// observed from inside a healthy app: that importing db.js connects to
// nothing, and that the boot probe gives up rather than waiting forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 10.255.255.1 is unroutable: a connection to it hangs rather than being
// refused, which is the precise condition that used to freeze the boot. A
// host that refuses fast would prove nothing.
process.env.TURSO_DATABASE_URL = 'libsql://10.255.255.1';
process.env.TURSO_AUTH_TOKEN = 'not-a-real-token';
process.env.TURSO_PROBE_TIMEOUT_MS = '300';

const importStarted = Date.now();
const { primaryHttpUrl, probePrimary, remoteMode, PROBE_TIMEOUT_MS } = await import('../db.js');
const importMs = Date.now() - importStarted;

test('importing db.js against an unreachable primary neither connects nor blocks', () => {
  assert.equal(remoteMode, true, 'this test is only meaningful against a remote URL');
  // The old code would not have reached this line at all — the import itself
  // never completed. A couple of seconds is enormous slack for what should now
  // be pure module evaluation; the failure it guards against is unbounded.
  assert.ok(
    importMs < 2_000,
    `importing db.js took ${importMs}ms — nothing in it may open the client, or reach the network, at import time`
  );
});

test('the primary probe gives up instead of hanging', async () => {
  const started = Date.now();
  const result = await probePrimary({ timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false, 'an unroutable address is not reachable');
  assert.equal(result.host, '10.255.255.1', 'the host is reported without its credentials');
  // The point of doing this over fetch rather than through libSQL is that it
  // CAN be abandoned. Ten times the budget still catches a probe that ignores
  // its own signal, without flaking on a slow machine.
  assert.ok(elapsed < 3_000, `the probe took ${elapsed}ms despite a 300ms budget`);
});

test('the probe timeout is configurable, and 0 disables the probe', async () => {
  assert.equal(PROBE_TIMEOUT_MS, 300, 'TURSO_PROBE_TIMEOUT_MS sets the budget');
  // The escape hatch matters: if the probe ever misjudges a live primary, the
  // deploy must have a way back to the old behaviour without a code change.
  assert.deepEqual(await probePrimary({ timeoutMs: 0 }), { skipped: true });
});

test("Turso's own schemes are probed over plain HTTP", () => {
  // The client keeps the URL exactly as configured; only the probe rewrites
  // it, because `fetch` has no idea what libsql:// means.
  assert.equal(primaryHttpUrl('libsql://db-org.turso.io'), 'https://db-org.turso.io');
  assert.equal(primaryHttpUrl('wss://db-org.turso.io'), 'https://db-org.turso.io');
  assert.equal(primaryHttpUrl('ws://localhost:8080'), 'http://localhost:8080');
  assert.equal(primaryHttpUrl('https://db-org.turso.io'), 'https://db-org.turso.io');
});

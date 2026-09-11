// **The database connection is direct, and must stay direct.**
//
// This file used to exist to pin the opposite: `offline: true` surviving the
// vendor's config expansion, because an embedded replica that quietly stopped
// being one would have looked perfectly healthy while every write went back to
// costing a round trip.
//
// That guarantee is gone, and the new one is worth pinning harder, because the
// failure is worse than slow. A `syncUrl` makes `createClient` hand the URL to
// the native libSQL binding instead of the HTTP client, and the first `.sync()`
// then downloads the whole database **on the event loop** — a synchronous
// native call no timer or signal can shorten. On Render's free tier, with no
// persistent disk to keep the replica between boots, that pull grew past the
// five-minute port scan: the socket was bound, the process never reached
// `accept()`, and the deploy timed out with the site down.
//
// So what is asserted here is an *absence*. Nothing inside a running app can
// observe it — locally it is a file, and in CI there is no primary — and
// reintroducing either key would pass every other test in this suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandConfig } from '@libsql/core/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `cfg-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
const { buildClientConfig } = await import('../db.js');

process.on('exit', () => {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

const remote = () => buildClientConfig({ url: 'libsql://example.turso.io', authToken: 'token' });

test('a remote database is connected to directly — no replica file, no sync target', () => {
  const config = remote();
  assert.equal(config.url, 'libsql://example.turso.io', 'the app talks to the primary itself');
  assert.equal(config.authToken, 'token');
  assert.equal(config.syncUrl, undefined, 'a syncUrl reintroduces the blocking bootstrap pull');
  assert.equal(config.offline, undefined, 'offline writes need a local replica to write to');
  assert.equal(config.syncInterval, undefined);
});

test('nothing reintroduces a replica inside the vendor config expansion', () => {
  // Not passing the keys and the driver not receiving them are different
  // claims, and only the second one decides whether boot blocks. This is the
  // half that would break invisibly if a future `@libsql/client` started
  // inferring a sync target from something else in the config.
  const expanded = expandConfig(remote(), true);
  assert.equal(expanded.syncUrl, undefined);
  assert.equal(expanded.offline, undefined);
  assert.equal(expanded.syncInterval, undefined);
});

test("Turso's libsql:// scheme resolves to the HTTP client, not the native binding", () => {
  // This is the property that makes boot non-blocking, and it is decided
  // entirely inside expandConfig: `createClient` passes preferHttp = true, so
  // libsql:// becomes https, and https is routed to the Hrana-over-HTTP client
  // — which has no native `Database`, no local file and no `sync()` at all.
  // A ws:// or wss:// URL would route to the WebSocket client instead; both are
  // fine, and neither can block the event loop the way the replica did.
  assert.equal(expandConfig(remote(), true).scheme, 'https');
});

test('a plain local file is passed straight through, with and without a token', () => {
  const config = buildClientConfig({ url: 'file:local.db', authToken: undefined });
  assert.deepEqual(config, { url: 'file:local.db' });
  const withToken = buildClientConfig({ url: 'file:local.db', authToken: 't' });
  assert.deepEqual(withToken, { url: 'file:local.db', authToken: 't' });
});

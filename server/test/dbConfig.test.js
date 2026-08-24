// The offline-writes configuration (Phase 5 of the round-trip work).
//
// This file exists because of one specific failure that nothing else could
// catch. `offline: true` is what makes a write land locally instead of waiting
// on a network round trip. If it were ever dropped — renamed upstream, stripped
// by the client's config expansion, lost in a refactor — the app would keep
// working perfectly, every test would pass, and every write would silently go
// back to costing what it cost before. There is no symptom to observe from
// inside the running app, only a game that feels slow again.
//
// So the flag is pinned here, and pinned all the way through the vendor's own
// config expansion rather than just at our own boundary, because "we passed it"
// and "the driver received it" are different claims and only the second one
// matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandConfig } from '@libsql/core/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `cfg-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
const { buildClientConfig, SYNC_SECONDS, syncHealth } = await import('../db.js');

process.on('exit', () => {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

const remote = () =>
  buildClientConfig({
    url: 'libsql://example.turso.io',
    authToken: 'token',
    replicaPath: 'replica.db',
    remote: true,
  });

test('a remote database is opened as a local replica with offline writes', () => {
  const config = remote();
  assert.equal(config.offline, true, 'offline writes are what make a write local');
  assert.equal(config.url, 'file:replica.db', 'the app reads and writes the local file');
  assert.equal(config.syncUrl, 'libsql://example.turso.io', 'the primary is the sync target');
  assert.equal(config.authToken, 'token');
});

test('the flag survives the vendor config expansion and reaches the driver', () => {
  // Passing it is not the same as it arriving. This is the half that would
  // break invisibly if the client ever stopped recognising the option.
  const expanded = expandConfig(remote(), true);
  assert.equal(expanded.offline, true);
  assert.equal(expanded.syncUrl, 'libsql://example.turso.io');
  assert.equal(expanded.path, 'replica.db');
});

test('libSQL own periodic sync stays off, so failures cannot be swallowed', () => {
  // The background loop owns the cadence precisely so it can see the errors and
  // raise the alarm; handing the cadence to the driver would hide them.
  assert.equal(remote().syncInterval, undefined);
  assert.equal(expandConfig(remote(), true).syncInterval, undefined);
});

test('a plain local file gets no replica, no sync target and no offline flag', () => {
  const config = buildClientConfig({ url: 'file:local.db', authToken: undefined, replicaPath: 'replica.db', remote: false });
  assert.deepEqual(config, { url: 'file:local.db' });
  const withToken = buildClientConfig({ url: 'file:local.db', authToken: 't', replicaPath: 'replica.db', remote: false });
  assert.deepEqual(withToken, { url: 'file:local.db', authToken: 't' });
});

test('the sync window is ten seconds, and local mode reports itself healthy', () => {
  // The window is also the size of the crash-loss bound the whole trade rests
  // on, so it is worth failing loudly if someone changes it by accident.
  assert.equal(SYNC_SECONDS, 10);
  // This test process is running against a plain file, so there is nothing to
  // push and nothing that can be unhealthy.
  assert.deepEqual(syncHealth(), { mode: 'local-file', healthy: true });
});

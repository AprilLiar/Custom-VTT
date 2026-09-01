// client/src/lib/theme.js — the cutscene's per-viewer preferences.
//
// Lives in server/test because that is where `npm test` looks. The module is
// pure ES with no DOM imports at the top level, so it imports cleanly here as
// long as `localStorage` exists by the time a function is CALLED — which is the
// point of the stub below, and of the throwing variant after it.
//
// What is pinned is the property no amount of clicking reveals: **a browser
// that refuses storage must not break the cutscene**. A private window, cleared
// site data, or a browser set to block site data makes the accessor itself
// throw — not return null — and an unguarded read there takes the whole replay
// down over a preference about how tall a header is.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const withStorage = async (impl, body) => {
  const had = 'localStorage' in globalThis;
  const previous = globalThis.localStorage;
  globalThis.localStorage = impl;
  try {
    await body();
  } finally {
    if (had) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
  }
};

const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
};

const throwingStorage = () => ({
  getItem() { throw new DOMException('The operation is insecure.'); },
  setItem() { throw new DOMException('The operation is insecure.'); },
  removeItem() { throw new DOMException('The operation is insecure.'); },
});

const { loadCutsceneStatsCollapsed, saveCutsceneStatsCollapsed } = await (async () => {
  // Imported inside a storage stub so a future top-level read cannot blow up
  // the import itself.
  let mod;
  await withStorage(memoryStorage(), async () => {
    mod = await import('../../client/src/lib/theme.js');
  });
  return mod;
})();

test('the collapsed Stat cards preference round-trips', async () => {
  const store = memoryStorage();
  await withStorage(store, async () => {
    assert.equal(loadCutsceneStatsCollapsed(), false, 'expanded is the default');
    assert.equal(saveCutsceneStatsCollapsed(true), true, 'the setter answers what it stored');
    assert.equal(loadCutsceneStatsCollapsed(), true);
    assert.equal(saveCutsceneStatsCollapsed(false), false);
    assert.equal(loadCutsceneStatsCollapsed(), false);
  });
});

test('the default is stored as an absence, not as a "0"', async () => {
  // One representation of the default rather than two, matching how the
  // playback speed clears its own key — so a stale "0" can never mean
  // something different from a missing key.
  const store = memoryStorage();
  await withStorage(store, async () => {
    saveCutsceneStatsCollapsed(true);
    assert.equal(store.map.size, 1);
    saveCutsceneStatsCollapsed(false);
    assert.equal(store.map.size, 0, 'turning it off removes the key');
  });
});

test('a browser that refuses storage still gets a working toggle', async () => {
  await withStorage(throwingStorage(), async () => {
    // The read must answer the default rather than throw...
    assert.equal(loadCutsceneStatsCollapsed(), false);
    // ...and the write must answer what the caller asked for, so the component's
    // own state still flips even though nothing was persisted.
    assert.equal(saveCutsceneStatsCollapsed(true), true);
    assert.equal(saveCutsceneStatsCollapsed(false), false);
  });
});

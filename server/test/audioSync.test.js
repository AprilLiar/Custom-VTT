// The Audio Player's timing and ordering maths.
//
// This file exists because every one of these functions fails *silently* in
// production. A URL form that doesn't parse looks like a GM typo; a clock
// offset computed from the wrong sample sounds like a bad connection; a
// shuffle that differs between the server and a client just plays the wrong
// song and nobody can say why. None of it throws, and none of it is visible
// from inside a running session — which is exactly the shape of thing this
// repo pins with unit tests before wiring it to UI (see combatTiming.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYouTubeId,
  clockOffset,
  expectedPositionMs,
  nextTrackId,
  shuffleOrder,
} from '../audioSync.js';

// ------------------------------------------------------------------ parsing
const VIDEO = 'dQw4w9WgXcQ';

test('every URL form a browser hands a GM yields the same id', () => {
  // Each of these is a real shape you get by copying out of YouTube — the
  // share button, the address bar, the embed dialog, a Short, a livestream.
  for (const url of [
    `https://www.youtube.com/watch?v=${VIDEO}`,
    `https://www.youtube.com/watch?v=${VIDEO}&t=42s`,
    `https://www.youtube.com/watch?list=PLabc123&v=${VIDEO}`, // v= is not first
    `https://youtu.be/${VIDEO}`,
    `https://youtu.be/${VIDEO}?t=42`,
    `https://www.youtube.com/embed/${VIDEO}`,
    `https://www.youtube.com/shorts/${VIDEO}`,
    `https://www.youtube.com/live/${VIDEO}`,
    `https://m.youtube.com/watch?v=${VIDEO}`,
    `http://youtube.com/watch?v=${VIDEO}`,
    `www.youtube.com/watch?v=${VIDEO}`, // pasted without a scheme
    `  https://youtu.be/${VIDEO}  `, // pasted with whitespace
    VIDEO, // the bare id
  ]) {
    assert.equal(parseYouTubeId(url), VIDEO, `failed on ${url}`);
  }
});

test('a trailing timestamp or playlist never bleeds into the id', () => {
  // The id is anchored at exactly 11 characters precisely so this can't happen;
  // a greedy "everything after the slash" match is the obvious wrong way.
  assert.equal(parseYouTubeId(`https://youtu.be/${VIDEO}?t=42&feature=share`), VIDEO);
  assert.equal(parseYouTubeId(`https://www.youtube.com/embed/${VIDEO}?start=30`), VIDEO);
});

test('anything that is not a YouTube video is refused, not guessed at', () => {
  // Saving a track whose link silently resolved to null would produce a row
  // that can never play, so the caller has to be able to tell.
  for (const bad of [
    '',
    null,
    undefined,
    '   ',
    'https://vimeo.com/123456789',
    'https://example.com/watch?v=dQw4w9WgXcQ', // right shape, wrong host
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/results?search_query=music',
    'not a url at all',
  ]) {
    assert.equal(parseYouTubeId(bad), null, `should have refused ${JSON.stringify(bad)}`);
  }
});

// -------------------------------------------------------------------- clock
test('a clean round trip measures the offset it was given', () => {
  // Server clock is 5000ms ahead. Client sends at 1000, server answers at
  // (1100 + 5000), client receives at 1200 — a symmetric 200ms trip.
  const got = clockOffset([{ t0: 1000, serverMs: 6100, t1: 1200 }]);
  assert.equal(got.offsetMs, 5000);
  assert.equal(got.rttMs, 200);
});

test('the lowest-RTT sample wins, and a slow asymmetric trip cannot drag it', () => {
  // The whole reason this is not an average. Three good samples agree on
  // +5000; one 2-second trip is wildly wrong. A mean would land ~250ms out —
  // audible as a quarter-second of desync on every client behind a slow link.
  const samples = [
    { t0: 1000, serverMs: 6100, t1: 1200 }, // rtt 200 → +5000
    { t0: 2000, serverMs: 7020, t1: 2040 }, // rtt  40 → +5000
    { t0: 3000, serverMs: 8050, t1: 3100 }, // rtt 100 → +5000
    { t0: 4000, serverMs: 9100, t1: 6000 }, // rtt 2000 → +4100, badly asymmetric
  ];
  const got = clockOffset(samples);
  assert.equal(got.rttMs, 40, 'picked the fastest round trip');
  assert.equal(got.offsetMs, 5000);
});

test('a client whose clock is far behind still resolves correctly', () => {
  // A phone that has not synced its clock in weeks is the realistic case, and
  // the sign of the offset must survive it.
  const got = clockOffset([{ t0: 0, serverMs: 600_000, t1: 100 }]);
  assert.equal(got.offsetMs, 599_950);
});

test('no usable samples returns null rather than a fabricated zero', () => {
  // null is what makes the engine stay SILENT instead of playing at an
  // unverified offset — a zero here would look like a perfectly synced clock.
  assert.equal(clockOffset([]), null);
  assert.equal(clockOffset(null), null);
  assert.equal(clockOffset([{ t0: 1000, serverMs: NaN, t1: 1200 }]), null);
  assert.equal(clockOffset([{ t0: 5000, serverMs: 1, t1: 1000 }]), null, 't1 before t0 is nonsense');
});

// ----------------------------------------------------------------- position
test('a playing track advances with the server clock', () => {
  const state = { is_playing: 1, position_ms: 30_000, anchored_at_ms: 1_000_000 };
  assert.equal(expectedPositionMs(state, 1_000_000), 30_000, 'at the anchor instant');
  assert.equal(expectedPositionMs(state, 1_020_000), 50_000, '20s later');
  // The joining-late case the whole feature exists for.
  assert.equal(expectedPositionMs({ ...state, position_ms: 0 }, 1_020_000), 20_000);
});

test('a paused track ignores the clock entirely', () => {
  // This is what makes pause/resume exact: no elapsed time, no rounding, no
  // dependence on a clock offset that may not even be established yet.
  const state = { is_playing: 0, position_ms: 42_000, anchored_at_ms: 1_000_000 };
  assert.equal(expectedPositionMs(state, 1_000_000), 42_000);
  assert.equal(expectedPositionMs(state, 9_999_999), 42_000);
});

test('position never goes negative, whatever the clock says', () => {
  // A client whose offset is briefly wrong (mid-handshake) must not ask the
  // player to seek to -4s, which YouTube answers unpredictably.
  const state = { is_playing: 1, position_ms: 1_000, anchored_at_ms: 1_000_000 };
  assert.equal(expectedPositionMs(state, 900_000), 0);
  assert.equal(expectedPositionMs(null, 1_000), 0);
});

test('camelCase and snake_case state are both accepted', () => {
  // The server hands out DB rows; the client keeps a camelCase object. Both
  // call this, so both shapes have to work or the bug appears on one side only.
  const snake = { is_playing: 1, position_ms: 5_000, anchored_at_ms: 100 };
  const camel = { isPlaying: true, positionMs: 5_000, anchoredAtMs: 100 };
  assert.equal(expectedPositionMs(snake, 1_100), expectedPositionMs(camel, 1_100));
});

// --------------------------------------------------------------- what's next
const LIST = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

test('in order, next walks forward and previous walks back', () => {
  assert.equal(nextTrackId({ tracks: LIST, currentId: 2 }), 3);
  assert.equal(nextTrackId({ tracks: LIST, currentId: 2, direction: -1 }), 1);
});

test('repeat playlist wraps at both ends', () => {
  assert.equal(nextTrackId({ tracks: LIST, currentId: 4, repeatMode: 'playlist' }), 1);
  assert.equal(nextTrackId({ tracks: LIST, currentId: 1, repeatMode: 'playlist', direction: -1 }), 4);
});

test('repeat off stops at a natural end but still wraps for a button press', () => {
  // A GM pressing Next on the last track means "get me off this song". A
  // button that silently does nothing reads as broken, so only the track
  // ending by itself is allowed to produce silence.
  assert.equal(nextTrackId({ tracks: LIST, currentId: 4, repeatMode: 'off', atNaturalEnd: true }), null);
  assert.equal(nextTrackId({ tracks: LIST, currentId: 4, repeatMode: 'off', atNaturalEnd: false }), 1);
});

test('repeat track loops one song only when it ends by itself', () => {
  assert.equal(
    nextTrackId({ tracks: LIST, currentId: 2, repeatMode: 'track', atNaturalEnd: true }),
    2
  );
  assert.equal(
    nextTrackId({ tracks: LIST, currentId: 2, repeatMode: 'track', atNaturalEnd: false }),
    3,
    'Next must still escape a repeating track'
  );
});

test('shuffle is the same permutation on every machine given the same seed', () => {
  // The load-bearing property: the server picks what plays next, the client
  // shows what is coming, and neither consults the other. Math.random() would
  // make that impossible to guarantee and impossible to test.
  const a = shuffleOrder([1, 2, 3, 4, 5, 6, 7, 8], 12345);
  const b = shuffleOrder([1, 2, 3, 4, 5, 6, 7, 8], 12345);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, shuffleOrder([1, 2, 3, 4, 5, 6, 7, 8], 12346), 'a new seed reshuffles');
  assert.deepEqual([...a].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8], 'every track survives');
});

test('shuffle plays each track once before repeating', () => {
  // "Shuffle" that can play the same song twice in a row is the classic
  // complaint; walking a fixed permutation is what avoids it.
  const seen = [];
  let current = nextTrackId({ tracks: LIST, currentId: null, shuffle: true, shuffleSeed: 99 });
  for (let i = 0; i < LIST.length; i += 1) {
    seen.push(current);
    current = nextTrackId({ tracks: LIST, currentId: current, shuffle: true, shuffleSeed: 99 });
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('shuffled previous retraces the shuffled order, not a fresh pick', () => {
  const first = nextTrackId({ tracks: LIST, currentId: null, shuffle: true, shuffleSeed: 7 });
  const second = nextTrackId({ tracks: LIST, currentId: first, shuffle: true, shuffleSeed: 7 });
  assert.equal(
    nextTrackId({ tracks: LIST, currentId: second, shuffle: true, shuffleSeed: 7, direction: -1 }),
    first
  );
});

test('a track deleted out from under us falls back to an end, not to nothing', () => {
  // currentId 99 is not in the list: this is exactly the state right after the
  // GM deletes the playing song, and it must still produce something to play.
  assert.equal(nextTrackId({ tracks: LIST, currentId: 99 }), 1);
  assert.equal(nextTrackId({ tracks: LIST, currentId: 99, direction: -1 }), 4);
});

test('an empty playlist is silence, not a crash', () => {
  assert.equal(nextTrackId({ tracks: [], currentId: 1 }), null);
  assert.equal(nextTrackId({}), null);
});

test('a one-track playlist on repeat stays on that track', () => {
  assert.equal(nextTrackId({ tracks: [{ id: 7 }], currentId: 7, repeatMode: 'playlist' }), 7);
  assert.equal(
    nextTrackId({ tracks: [{ id: 7 }], currentId: 7, repeatMode: 'off', atNaturalEnd: true }),
    null
  );
});

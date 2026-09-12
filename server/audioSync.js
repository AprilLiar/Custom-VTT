// The Audio Player's timing and ordering maths — pure functions, no I/O, no
// DOM, no database (CLAUDE.md's standing rule for exactly this kind of thing:
// the risky arithmetic is built and pinned before any UI touches it, the same
// way combatTiming.js and client/src/lib/sceneProjection.js were).
//
// **Imported by BOTH sides.** The client reaches it as
// `../../../server/audioSync.js`, which is this repo's established way of
// sharing pure rules across the boundary (see CharacterCreationDialog.jsx
// importing server/moveBundles.js). That matters more here than usual: the
// server decides what plays next and every client independently computes where
// it should be in the track, so the two must agree by *construction*, not by
// two implementations that look similar.
//
// **Why there is a clock problem at all.** Nothing else in this app is
// wall-clock authoritative — combat Tics are a plain integer counter that
// advances by event. Audio is different in kind: "everyone hears the same
// second of the same song at the same moment" is a statement about real time,
// so the server has to publish an instant and every client has to be able to
// translate that instant into its own clock. Device clocks are wrong by
// arbitrary amounts (minutes, on a phone that has not synced), so the offset
// is measured rather than assumed.

// ---------------------------------------------------------------- YouTube ids
//
// A GM pastes whatever their browser gave them. Every one of these is the same
// video, and a paste format that silently fails is the likeliest real bug in
// the whole feature — hence the deliberately wide net and the tests to match:
//
//   https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL…&t=42s
//   https://youtu.be/dQw4w9WgXcQ?t=42
//   https://www.youtube.com/embed/dQw4w9WgXcQ
//   https://www.youtube.com/shorts/dQw4w9WgXcQ
//   https://www.youtube.com/live/dQw4w9WgXcQ
//   https://m.youtube.com/watch?v=dQw4w9WgXcQ
//   dQw4w9WgXcQ
//
// An id is exactly 11 characters of [A-Za-z0-9_-]. Anchoring on that (rather
// than on "whatever followed the slash") is what keeps a trailing `?t=42`, a
// playlist parameter or a stray slash from being swallowed into the id.
const ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_FORMS = /\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[?&/#]|$)/;
const SHORT_FORM = /^(?:https?:\/\/)?(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&/#]|$)/i;

export function parseYouTubeId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  // A bare id first: it is both the cheapest case and the one a URL parser
  // would mangle (no scheme, no host).
  if (ID.test(raw)) return raw;

  const short = SHORT_FORM.exec(raw);
  if (short) return short[1];

  // `?v=` is the canonical watch form. Read it with URLSearchParams rather than
  // a regex so parameter order never matters — `?list=…&v=…` is just as valid.
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)) return null;
    const v = url.searchParams.get('v');
    if (v && ID.test(v)) return v;
    const path = PATH_FORMS.exec(url.pathname);
    if (path) return path[1];
    return null;
  } catch {
    // Not a URL at all — fall through to the path forms in case someone pasted
    // a bare `embed/<id>` fragment.
    const path = PATH_FORMS.exec(raw);
    return path ? path[1] : null;
  }
}

// ------------------------------------------------------------------- the clock
//
// One sample is a round trip: the client stamps `t0`, the server answers with
// its own `serverMs`, the client stamps `t1` on arrival. If the trip were
// symmetric, the server's clock read `serverMs` at the instant
// `t0 + (t1 - t0) / 2` on the client's clock, so
//
//   offset = serverMs + rtt / 2 - t1        (add to a client Date.now() to get server time)
//
// **The lowest-RTT sample wins, not the median or the mean.** Asymmetry is what
// makes a sample wrong, and a fast round trip has less room to be asymmetric
// than a slow one — a 40ms trip can be off by at most 20ms, a 900ms trip by up
// to 450ms. Averaging drags the good sample toward the bad ones. This is what
// NTP does, and it matters most on exactly the connection this app runs on: a
// phone on mobile data, where most trips are fine and a few are terrible.
export function clockOffset(samples) {
  const usable = (samples ?? []).filter(
    (s) =>
      s &&
      Number.isFinite(s.t0) &&
      Number.isFinite(s.t1) &&
      Number.isFinite(s.serverMs) &&
      s.t1 >= s.t0
  );
  if (!usable.length) return null;
  let best = null;
  for (const s of usable) {
    const rtt = s.t1 - s.t0;
    if (best == null || rtt < best.rtt) best = { rtt, offset: s.serverMs + rtt / 2 - s.t1 };
  }
  return { offsetMs: Math.round(best.offset), rttMs: best.rtt };
}

// ------------------------------------------------------------ where we should be
//
// The entire synchronisation contract, and the reason the server stores an
// ANCHOR rather than a position: a position would be stale the millisecond it
// was written and would need a ticking loop to keep current. An anchor —
// "offset `positionMs` into the track, as of server instant `anchoredAtMs`" —
// stays true forever without anyone touching it, and every client derives the
// live position from it independently.
//
// Paused is the degenerate case and needs no clock at all: the anchor IS the
// position, which is what makes pause/resume exact rather than approximately
// exact.
export function expectedPositionMs(state, serverNowMs) {
  if (!state) return 0;
  const position = Number(state.position_ms ?? state.positionMs ?? 0);
  if (!Number.isFinite(position)) return 0;
  const playing = Boolean(state.is_playing ?? state.isPlaying);
  if (!playing) return Math.max(0, position);
  const anchoredAt = Number(state.anchored_at_ms ?? state.anchoredAtMs ?? 0);
  if (!Number.isFinite(anchoredAt) || !Number.isFinite(serverNowMs)) return Math.max(0, position);
  return Math.max(0, position + (serverNowMs - anchoredAt));
}

// ------------------------------------------------------------------ what's next
//
// **Deterministic on purpose.** The server decides the next track when one
// ends, but a client needs the same answer to show what is coming and to skip
// locally without a round trip. A seeded permutation gives both sides the same
// shuffle from the same `shuffleSeed`, so "next" is a pure function of state
// rather than something that has to be negotiated — and, unlike Math.random(),
// it can be unit-tested.
//
// mulberry32: a small, fast, well-distributed 32-bit PRNG. Nothing here is
// security-sensitive; reproducibility is the whole requirement.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates, driven by the seeded PRNG.
export function shuffleOrder(ids, seed) {
  const out = [...ids];
  const rand = mulberry32(Number(seed) || 0);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// `tracks` is the playlist in its stored order (sort_order, id). Returns the id
// to play next, or null for "stop".
//
// `direction` is +1 for next and -1 for previous, so Previous walks the same
// sequence backwards — including the shuffled one, which is what makes the
// button mean "the song before the one I just heard" rather than a second
// random pick.
//
// **`repeat: 'track'` is ignored by Previous/Next but honoured at a natural
// end.** Looping one song forever is a statement about what happens when it
// finishes, not about what the skip buttons do — a GM who hits Next while a
// track is on repeat means "get me off this song", every time.
export function nextTrackId({
  tracks = [],
  currentId = null,
  repeatMode = 'playlist',
  shuffle = false,
  shuffleSeed = 0,
  direction = 1,
  atNaturalEnd = false,
} = {}) {
  const ids = tracks.map((t) => Number(t.id)).filter(Number.isInteger);
  if (!ids.length) return null;
  if (atNaturalEnd && repeatMode === 'track' && currentId != null && ids.includes(Number(currentId))) {
    return Number(currentId);
  }
  const order = shuffle ? shuffleOrder(ids, shuffleSeed) : ids;
  const at = order.indexOf(Number(currentId));
  // Nothing playing (or the current track was just deleted out from under us):
  // start at whichever end the direction implies.
  if (at === -1) return direction >= 0 ? order[0] : order[order.length - 1];
  const step = direction >= 0 ? 1 : -1;
  const target = at + step;
  if (target >= 0 && target < order.length) return order[target];
  // Ran off an end. Wrapping is what 'playlist' means; 'off' stops, but only at
  // a NATURAL end — a GM pressing Next on the last track still wraps, because a
  // button that silently does nothing reads as broken.
  if (repeatMode === 'off' && atNaturalEnd) return null;
  return step > 0 ? order[0] : order[order.length - 1];
}

// ------------------------------------------------------------------ the fades
//
// **A one-second fade at each end of a song (decided, new).** Expressed as a
// pure function of WHERE IN THE TRACK we are, not as a timed ramp fired by an
// event, and that choice is the whole design:
//
//  - It is self-correcting. A GM seek, a track change, a buffer stall or a
//    resume all move the position; the envelope simply reads the new one. A
//    timed ramp would have to be cancelled and re-aimed at each of those, and
//    every one of those is a chance to leave a client stuck quiet.
//  - It is testable. The player half of this feature cannot be exercised where
//    this app is developed (the egress proxy refuses youtube.com), so the
//    arithmetic being a pure function that can be pinned here is the difference
//    between "verified" and "it looked right".
//
// `durationMs` is NULL until some client reports it — only YouTube knows how
// long a video is — so an unknown length means **no tail fade at all** rather
// than a guessed one that would duck the middle of a song.
//
// **Past the reported end the gain goes back to 1, deliberately.** The duration
// is a number some other browser reported; if it was short, the song is still
// playing and the alternative is a client that has muted itself with nothing
// coming to put it right. Reading "we are past the end and still going" as "the
// duration was wrong" is what makes one bad report cost a second of dip instead
// of the rest of the song.
export function fadeEnvelope(positionMs, durationMs, fadeMs) {
  const fade = Number(fadeMs);
  if (!Number.isFinite(fade) || fade <= 0) return 1;
  const pos = Number(positionMs);
  if (!Number.isFinite(pos) || pos < 0) return 1;

  const total = Number(durationMs);
  // A track shorter than both fades would never reach full volume; leave it
  // alone rather than making it quieter than everything around it.
  const hasTail = Number.isFinite(total) && total > fade * 2;
  if (hasTail) {
    const remaining = total - pos;
    if (remaining >= 0 && remaining < fade) return remaining / fade;
  }
  if (pos < fade) return pos / fade;
  return 1;
}

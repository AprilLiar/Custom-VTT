// The Audio Player's client half: one YouTube player, one clock, one set of
// socket listeners, for the whole tab.
//
// **Deliberately NOT a React component, and this is the load-bearing
// decision.** `Shell()` in App.jsx has two separate `return` branches — one
// for `/scene`, one for everything else — so anything React renders inside it
// is unmounted the moment you cross that boundary. For most components that
// costs a re-render; here it would tear down and re-create the `<iframe>`,
// which reloads it and kills the audio. Even re-PARENTING an iframe reloads
// it. So the player lives in a element this module appends to `document.body`
// itself and never moves, and React only ever *reads* what is going on
// (useAudioStatus.js). Module scope is evaluated once per page no matter how
// many times React mounts anything, which is the same property socket.js
// relies on — and it means StrictMode's double-invoked effects cannot
// double-create anything here either.
//
// The sync contract lives in server/audioSync.js, imported directly the way
// CharacterCreationDialog imports the character-creation rules: the server
// decides what plays and publishes an anchor, every client independently works
// out where that anchor puts it right now, and the two agree by construction
// rather than by two implementations that look similar.
import { socket } from '../socket.js';
import { clockOffset, expectedPositionMs } from '../../../server/audioSync.js';
import { loadAudioVolume } from './sceneSettings.js';

// ---------------------------------------------------------------- the store
//
// A minimal external store rather than React state, because the engine is not
// in the tree. `getSnapshot` must return a referentially stable object or
// useSyncExternalStore spins, hence the shallow-equal guard in `set`.
let snapshot = {
  status: 'idle', // idle | playing | paused | syncing | blocked | silent | error
  detail: null,
  trackId: null,
  playlistId: null,
  name: null,
  isPlaying: false,
  driftMs: null,
  clockReady: false,
};
const listeners = new Set();
export const subscribe = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
export const getSnapshot = () => snapshot;

function set(patch) {
  const next = { ...snapshot, ...patch };
  if (Object.keys(next).every((k) => next[k] === snapshot[k])) return;
  snapshot = next;
  for (const cb of listeners) cb();
}

// ------------------------------------------------------------- the constants
//
// **400ms of tolerance, because `getCurrentTime()` is only about that
// accurate.** Chasing a tighter number does not produce tighter sync, it
// produces seek-thrash — and a seek is audible in a way that 400ms of drift
// simply is not.
const SYNC_TOLERANCE_MS = 400;
// Above this, go quiet BEFORE correcting rather than letting the wrong part of
// the song play while the seek lands.
const SILENCE_THRESHOLD_MS = 1500;
// Half the best round trip is an honest bound on how wrong the offset can be.
// Past this the clock is not good enough to make a sound on — "better silent
// than out of sync" starts here.
const MAX_CLOCK_UNCERTAINTY_MS = 250;
// Three failed attempts to land inside tolerance means something is wrong that
// seeking will not fix (a throttled background tab, a stalled buffer).
const MAX_CORRECTIONS = 3;
const CLOCK_SAMPLES = 5;
const CLOCK_SPACING_MS = 120;
// A brief mobile reconnect blip must not chop the music — the anchor stays
// correct across it as long as the GM changed nothing. Past this the odds that
// a pause or a track change was missed stop being negligible.
const OFFLINE_GRACE_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the state
let serverState = null; // the last audio:state broadcast
let clock = { ready: false, offsetMs: 0, uncertaintyMs: Infinity };
let clockRunning = false;
let player = null;
let playerReady = false;
let creatingPlayer = false;
let hostEl = null;
let currentVideoId = null;
let unlocked = false;
let pendingUnlockGesture = false;
let sawPlayback = false;
let weJustPaused = false;
let corrections = 0;
let lastAnchorId = null;
let offlineSince = null;
let buffering = false;

const serverNow = () => performance.now() + clock.offsetMs;

// ------------------------------------------------------------- the YouTube API
//
// The API script calls exactly one global when it is ready. Chained rather
// than overwritten so this can never be the thing that breaks another embed
// later. A module-level promise makes it load once no matter who asks.
let apiPromise = null;
function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        previous?.();
      } catch {
        /* someone else's handler threw; not ours to care about */
      }
      resolve(window.YT);
    };
    if (!document.querySelector('script[data-yt-iframe-api]')) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.dataset.ytIframeApi = '1';
      // An ad blocker, a captive portal or no network at all. The catch below
      // clears the promise so a later attempt can retry.
      s.onerror = () => reject(new Error('yt-api-blocked'));
      document.head.appendChild(s);
    }
    setTimeout(() => reject(new Error('yt-api-timeout')), 15_000);
  });
  apiPromise.catch(() => {
    apiPromise = null;
  });
  return apiPromise;
}

// **Hidden by being off-screen, NOT by display:none.** `display: none` removes
// the iframe from the render tree and browsers stop — or refuse to start —
// media inside it; `visibility: hidden` is treated inconsistently across
// engines. Off-screen leaves it a fully live, composited element that simply
// nobody can see, which is the one variant every browser agrees about.
//
// The box is a real 16:9 240x135 rather than 1x1: YouTube's own player logic
// misbehaves at degenerate sizes, and this costs nothing when the whole thing
// is 9999px to the left of the viewport.
function ensureHost() {
  if (hostEl) return hostEl;
  hostEl = document.createElement('div');
  hostEl.id = 'yt-audio-host';
  Object.assign(hostEl.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    width: '240px',
    height: '135px',
    pointerEvents: 'none',
  });
  hostEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(hostEl);
  return hostEl;
}

async function ensurePlayer() {
  if (player || creatingPlayer) return;
  creatingPlayer = true;
  try {
    const YT = await loadYouTubeApi();
    player = new YT.Player(ensureHost(), {
      width: 240,
      height: 135,
      playerVars: {
        autoplay: 0, // we decide when playback starts, never YouTube
        controls: 0,
        disablekb: 1,
        fs: 0,
        rel: 0,
        modestbranding: 1,
        iv_load_policy: 3,
        // **Critical on iOS.** Without it the video takes over the entire
        // screen the instant it plays, which is exactly what this feature must
        // never do.
        playsinline: 1,
        origin: window.location.origin,
      },
      events: { onReady, onStateChange, onError },
    });
  } catch (err) {
    set({ status: 'error', detail: err?.message ?? 'api-unavailable' });
  } finally {
    creatingPlayer = false;
  }
}

function onReady() {
  const iframe = player?.getIframe?.();
  // A cross-origin iframe only inherits the page's autoplay permission if it
  // is granted one explicitly. Current versions of the IFrame API set this
  // themselves; a cached older one may not, and a player without it can never
  // be unlocked however good the gesture was.
  if (iframe && !/\bautoplay\b/.test(iframe.allow || '')) {
    iframe.allow = 'autoplay; encrypted-media';
    iframe.src = iframe.src; // eslint-disable-line no-self-assign -- permissions only apply at load
    return; // onReady fires again once it has reloaded
  }
  playerReady = true;
  applyVolume();
  if (pendingUnlockGesture) attemptUnlock();
  reconcile('player-ready');
}

function onError({ data }) {
  const code = Number(data);
  // 5 is a transient HTML5 player hiccup — retry it once locally rather than
  // telling the table the song is broken. The rest are permanent facts about
  // the video (missing, private, embedding disabled, region locked) and the
  // server skips past them for everyone.
  if (code === 5) {
    silence('player-error');
    setTimeout(() => {
      if (currentVideoId) player?.loadVideoById?.({ videoId: currentVideoId, startSeconds: 0 });
    }, 1000);
    return;
  }
  set({ status: 'error', detail: `youtube-${code}` });
  socket.emit('audio:error', { trackId: serverState?.trackId, anchorId: serverState?.anchorId, code });
}

const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

function onStateChange({ data }) {
  switch (data) {
    case YT_STATE.BUFFERING:
      // Whatever position we had is now stale by however long the buffer
      // takes. Go quiet and reconcile on the way back out — this transition is
      // the single most useful sync trigger there is, because it is the moment
      // a client's real position becomes knowable again.
      buffering = true;
      silence('buffering');
      break;
    case YT_STATE.PLAYING:
      buffering = false;
      sawPlayback = true; // the unlock detector reads this
      reconcile('yt-playing');
      break;
    case YT_STATE.PAUSED:
      // Nobody here pressed pause. The OS did — a phone call, another app
      // taking the media session, a Bluetooth headset disconnecting.
      if (serverState?.isPlaying && !weJustPaused) {
        set({ status: 'blocked', detail: 'paused-externally' });
      }
      break;
    case YT_STATE.CUED:
      reportDuration();
      reconcile('yt-cued');
      break;
    case YT_STATE.ENDED:
      // The server de-duplicates these across every listener via anchorId.
      socket.emit('audio:track_ended', {
        trackId: serverState?.trackId,
        anchorId: serverState?.anchorId,
      });
      break;
    default:
      break;
  }
}

// Only YouTube knows how long a video is, and the server needs it to arm its
// end-of-track safety net. The server takes the largest report and ignores
// anything under five seconds, which is what makes a pre-roll ad's duration
// harmless.
function reportDuration() {
  const seconds = player?.getDuration?.() ?? 0;
  const ms = Math.round(seconds * 1000);
  if (ms >= 5000 && serverState?.trackId) {
    socket.emit('audio:duration', { trackId: serverState.trackId, durationMs: ms });
  }
}

// **Is this client actually playing the song, or an advert in front of it?**
// A client stuck on a pre-roll is playing completely different audio, and
// drift alone cannot detect that — the position looks fine, it is just
// position within the wrong thing. Comparing what the player says the current
// video lasts against what the table has agreed it lasts catches it, and the
// answer is silence until the ad is over.
function looksLikeAd() {
  const known = serverState?.durationMs;
  const seconds = player?.getDuration?.() ?? 0;
  if (!known || !seconds) return false;
  return Math.abs(seconds * 1000 - known) > 2000;
}

// --------------------------------------------------------------------- volume
//
// Per-device and never synced: everyone hears the same song at the same
// moment, at whatever loudness suits their own room.
function applyVolume() {
  if (!playerReady) return;
  try {
    player.setVolume(Math.round(loadAudioVolume() * 100));
  } catch {
    /* the player is not ready enough yet; the next reconcile sets it */
  }
}
export function refreshVolume() {
  applyVolume();
}

function silence(detail) {
  try {
    player?.mute?.();
  } catch {
    /* nothing to silence yet */
  }
  set({ status: 'silent', detail });
}

function sound() {
  try {
    player?.unMute?.();
    applyVolume();
  } catch {
    /* not ready; the next reconcile will try again */
  }
}

// ------------------------------------------------------------------ the clock
async function pingOnce(timeoutMs = 2000) {
  return new Promise((resolve) => {
    // performance.now(), not Date.now(): it is monotonic, so an NTP correction
    // or the user changing their clock mid-session cannot silently poison
    // every position we compute from here on.
    const t0 = performance.now();
    let settled = false;
    const finish = (sample) => {
      if (settled) return;
      settled = true;
      socket.off('audio:pong', onPong);
      clearTimeout(timer);
      resolve(sample);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onPong = ({ t0: echo, serverMs }) => {
      if (echo !== t0) return; // a reply from a previous round
      finish({ t0, t1: performance.now(), serverMs });
    };
    socket.on('audio:pong', onPong);
    socket.emit('audio:ping', { t0 });
  });
}

// Sequential, not five at once: simultaneous pings share one connection and
// queue behind each other, so four of the five round trips would be inflated
// by head-of-line delay and the lowest-RTT filter would have nothing clean to
// choose from.
async function runClockHandshake() {
  if (clockRunning) return;
  clockRunning = true;
  try {
    const samples = [];
    for (let i = 0; i < CLOCK_SAMPLES; i += 1) {
      const s = await pingOnce();
      if (s) samples.push(s);
      if (i < CLOCK_SAMPLES - 1) await sleep(CLOCK_SPACING_MS);
    }
    const result = clockOffset(samples);
    clock = result
      ? { ready: true, offsetMs: result.offsetMs, uncertaintyMs: result.rttMs / 2 }
      : { ready: false, offsetMs: 0, uncertaintyMs: Infinity };
    set({ clockReady: clock.ready });
    reconcile('clock');
  } finally {
    clockRunning = false;
  }
}

// ------------------------------------------------------------- the unlock
//
// Browsers refuse to play sound until the person has interacted with the page.
// The role modal is a mandatory tap on every load, so that tap is what buys
// the permission — see roleContext.jsx, which calls this synchronously from
// inside the click handler. It has to be synchronous: an effect reacting to
// `role` might survive Chrome's sticky activation but will not survive
// Safari's.
export function unlockAudioFromGesture() {
  if (unlocked) return true;
  ensurePlayer();
  if (!playerReady || !player) {
    pendingUnlockGesture = true;
    return false;
  }
  return attemptUnlock();
}

function attemptUnlock() {
  pendingUnlockGesture = false;
  sawPlayback = false;
  try {
    // **unMute BEFORE play, not after.** Safari records what the element did
    // during the interaction: a mute-then-play unlock teaches it "this element
    // plays muted", and it will then refuse to ever unmute without another
    // gesture. Volume 0 silences desktop; on iOS setVolume is a no-op, so up
    // to one frame of audio can escape here — paid knowingly, because the
    // alternative cannot be unmuted on Safari at all.
    player.unMute();
    player.setVolume(0);
    player.playVideo();
    // Next frame rather than synchronously: a synchronous pause can race the
    // play promise inside the iframe and cancel the very activation it was
    // meant to buy.
    requestAnimationFrame(() => {
      try {
        weJustPaused = true;
        player.pauseVideo();
      } finally {
        weJustPaused = false;
      }
    });
  } catch {
    /* fall through to the detector below */
  }
  // The browser will not tell us whether the gesture took, so watch for
  // playback actually having happened.
  setTimeout(() => {
    unlocked = sawPlayback;
    if (!unlocked) set({ status: 'blocked', detail: 'autoplay-denied' });
    applyVolume();
    reconcile('unlock');
  }, 2000);
  return true;
}

// ---------------------------------------------------------------- reconciling
//
// **Called on events only**, by explicit design decision: a track starting or
// changing, play, pause, a GM seek, a socket re-connect, the tab becoming
// visible again, and the YouTube player's own transitions out of buffering.
// There is deliberately no polling timer, so drift can accumulate across a
// long uninterrupted track — the accepted cost of that choice.
function reconcile(reason) {
  // **The store's "what is playing" half is NOT set here** — it is mirrored
  // straight off the broadcast (see the audio:state listener). That split
  // matters: this function returns early whenever the local player is not
  // usable, and folding the two together meant a client whose YouTube was
  // blocked or still loading showed NOTHING on screen while the rest of the
  // table listened to a song. What is playing is a fact about the table; only
  // whether *this* device can join it is a fact about the player.
  if (!playerReady || !player) return;

  if (!serverState?.youtubeId) {
    try {
      player.stopVideo?.();
    } catch {
      /* nothing loaded */
    }
    currentVideoId = null;
    set({ status: 'idle', detail: null, driftMs: null });
    return;
  }

  // Load the right video first — everything below is about position within it.
  if (currentVideoId !== serverState.youtubeId) {
    currentVideoId = serverState.youtubeId;
    corrections = 0;
    const startAt = Math.max(0, expectedPositionMs(serverState, serverNow())) / 1000;
    silence('loading');
    try {
      if (serverState.isPlaying) player.loadVideoById({ videoId: currentVideoId, startSeconds: startAt });
      else player.cueVideoById({ videoId: currentVideoId, startSeconds: startAt });
    } catch {
      set({ status: 'error', detail: 'load-failed' });
    }
    return;
  }

  if (!serverState.isPlaying) {
    try {
      weJustPaused = true;
      player.pauseVideo();
    } finally {
      weJustPaused = false;
    }
    set({ status: 'paused', detail: null, driftMs: null });
    return;
  }

  // ---- the "silent rather than out of sync" gates, in order of severity ----
  //
  // `blocked` is kept distinct from `silent` because only one of them has a
  // remedy: a blocked client needs a tap, and the indicator says so.
  if (!unlocked) {
    silence('blocked');
    set({ status: 'blocked', detail: 'autoplay-denied' });
    return;
  }
  if (!clock.ready || clock.uncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS) {
    silence('no-clock');
    return;
  }
  if (offlineSince != null && Date.now() - offlineSince > OFFLINE_GRACE_MS) {
    silence('offline');
    return;
  }
  if (buffering) {
    silence('buffering');
    return;
  }
  if (looksLikeAd()) {
    silence('advert');
    return;
  }

  const target = expectedPositionMs(serverState, serverNow());
  const actual = (player.getCurrentTime?.() ?? 0) * 1000;
  const drift = actual - target;

  if (Math.abs(drift) <= SYNC_TOLERANCE_MS) {
    corrections = 0;
    sound();
    try {
      player.playVideo();
    } catch {
      /* the play will be retried on the next event */
    }
    set({ status: 'playing', detail: reason, driftMs: Math.round(drift) });
    return;
  }

  if (corrections >= MAX_CORRECTIONS) {
    // Seeking is not fixing it. Staying quiet is the promise this feature
    // made; playing the wrong part of the song is the one thing it must not do.
    silence('desynced');
    set({ status: 'silent', detail: 'desynced', driftMs: Math.round(drift) });
    return;
  }

  corrections += 1;
  if (Math.abs(drift) > SILENCE_THRESHOLD_MS) silence('seeking');
  try {
    player.seekTo(target / 1000, true);
    player.playVideo();
  } catch {
    /* retried on the next event */
  }
  set({ status: 'syncing', detail: reason, driftMs: Math.round(drift) });
}

// ------------------------------------------------------------------- wiring
socket.on('audio:state', (state) => {
  const changed = state?.anchorId !== lastAnchorId;
  lastAnchorId = state?.anchorId ?? null;
  serverState = state;
  if (changed) corrections = 0;
  // Mirrored unconditionally, before anything can return early: the indicator
  // must show what the table is listening to even on a device that cannot play
  // it — that is precisely when a person needs to be told something is wrong.
  set({
    trackId: state?.trackId ?? null,
    playlistId: state?.playlistId ?? null,
    name: state?.name ?? null,
    isPlaying: Boolean(state?.isPlaying),
    ...(state?.trackId ? {} : { status: 'idle', detail: null, driftMs: null }),
  });
  ensurePlayer();
  reconcile('server-state');
});

socket.on('connect', () => {
  offlineSince = null;
  // The first connect counts here, unlike useSocketRefresh's deliberate skip:
  // this IS the only chance to establish an offset, and without one the engine
  // stays silent by design.
  clock = { ...clock, ready: false, uncertaintyMs: Infinity };
  set({ clockReady: false });
  runClockHandshake();
});

socket.on('disconnect', () => {
  offlineSince = Date.now();
});

// A tab that was asleep has a clock we can no longer vouch for — a phone that
// suspended for twenty minutes especially. Re-measure before making a sound.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  clock = { ...clock, ready: false, uncertaintyMs: Infinity };
  set({ clockReady: false });
  runClockHandshake();
});

// Start loading the API immediately. The several seconds a person spends
// reading the role modal is exactly the budget needed, so the player is
// usually ready by the time their tap arrives.
loadYouTubeApi().catch(() => {
  /* reported through the store when a play is actually attempted */
});
if (socket.connected) runClockHandshake();

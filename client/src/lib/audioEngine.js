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

// **Why this device is not making a sound, in words (decided, new).**
//
// Every silent state used to render as the same "re-syncing", which is true of
// all of them and useful about none — a person watching a device that will
// start playing in two seconds and a person watching one that never will read
// exactly the same string. The engine already knows which it is; this is what
// puts that on screen, and it is the difference between "the audio is broken"
// and "it is waiting for a clean clock reading".
const SILENT_REASONS = {
  loading: 'loading the track',
  buffering: 'buffering',
  'no-clock': 'measuring the clock',
  offline: 'reconnecting',
  advert: 'an advert is playing',
  desynced: 'out of sync — retrying',
  seeking: 'catching up',
  'player-error': 'retrying',
};
export function silentReason(snap = snapshot) {
  if (snap.status !== 'silent') return null;
  return SILENT_REASONS[snap.detail] ?? 'syncing';
}

function set(patch) {
  const next = { ...snapshot, ...patch };
  if (Object.keys(next).every((k) => next[k] === snapshot[k])) return;
  snapshot = next;
  // Arming the recovery tick from here rather than from each `silence()` call
  // site is what makes it impossible to forget: every way this client can enter
  // or leave a silent state goes through `set`.
  updateRecoveryTick();
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

// **Everything below is the fix for "it says re-syncing and never plays"
// (bugfix).**
//
// The gate above is the right rule and it stays exactly as strict. What was
// wrong is what happened when a device could not clear it: nothing. One
// handshake ran, and if its best round trip came back over 500ms — routine on
// mobile data against a free-tier host that has just woken up — the client went
// silent and **never measured again**. Worse, every `visibilitychange` threw
// away a perfectly good offset and re-ran that one-shot measurement, so on a
// phone (where switching apps is constant) a good clock had to survive an
// unbounded number of coin flips and a bad one was permanent.
//
// Three properties fix it without loosening the sync promise by a millisecond:
//
//  - **The best reading wins, and it is kept.** `clockOffset` already picks the
//    lowest-RTT sample because a fast trip has less room to be asymmetric; that
//    same logic applies ACROSS handshakes, so a 12ms reading from a minute ago
//    is better evidence than a 600ms one taken just now. A measurement is only
//    replaced by a better one, or once it is too old to trust.
//  - **A handshake that fails to clear the gate is retried,** backing off, and
//    with more samples each time. The minimum of N round trips can only improve
//    as N grows: on a link where most trips are slow and a few are fine, this is
//    the difference between "never" and "within a few seconds".
//  - **Retries only run while there is something to play,** so an idle table
//    costs nothing.
//
// A reading older than this is not trusted: a phone that suspended for twenty
// minutes may have had its clock corrected by the network while it slept, and
// `performance.now()` across a suspend is not something to bet audio on.
const CLOCK_MAX_AGE_MS = 5 * 60_000;
// Backoff between handshakes while the table is playing and we still have no
// clock good enough to make a sound on. Fast at first — the common case is a
// single slow round trip, and one retry clears it.
const CLOCK_RETRY_MS = [750, 1500, 3000, 6000, 12_000, 20_000];
// A retry casts a wider net than the first attempt: the whole point is that the
// minimum improves with more samples.
const CLOCK_RETRY_SAMPLES = 9;
// **The silence recovery tick.** `reconcile` is deliberately event-driven, and
// for drift that is the right call (see its own note). But several of the
// states it can land in are silent ones waiting on something that fires no
// event at all — an advert finishing, a buffer that filled while the tab was
// hidden, a load that never produced a state change. Those latched, and a
// latched silence is indistinguishable from a broken feature.
//
// So: while this client is silent AND the table is playing, re-check on a slow
// tick until it either plays or has a reason it can state. It costs nothing in
// the normal case, because a client that is playing is not silent.
const RECOVERY_TICK_MS = 2500;
// How long a player gets to actually start after we ask it to, before we call
// it blocked. Generous: a cold YouTube embed on a slow connection can spend a
// second or more in BUFFERING, and accusing the browser of refusing when it was
// merely loading is how you teach people to ignore the indicator.
const PLAY_WATCHDOG_MS = 4000;
// A brief mobile reconnect blip must not chop the music — the anchor stays
// correct across it as long as the GM changed nothing. Past this the odds that
// a pause or a track change was missed stop being negligible.
const OFFLINE_GRACE_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the state
let serverState = null; // the last audio:state broadcast
let clock = { ready: false, offsetMs: 0, uncertaintyMs: Infinity, measuredAt: 0 };
let clockRunning = false;
let clockAttempt = 0;
let clockRetryTimer = null;
let recoveryTimer = null;
let player = null;
let playerReady = false;
let creatingPlayer = false;
let hostEl = null;
let currentVideoId = null;
let unlocked = false;
let pendingUnlockGesture = false;
let playWatchdog = null;
let readyFallbackTimer = null;
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
  //
  // **Once, and with a way out (bugfix).** Reassigning `src` reloads the embed
  // and this returned early waiting for a second `onReady` — but whether the
  // IFrame API re-runs its handshake against the same Player object after a
  // manual reload is not guaranteed, and if it does not, `playerReady` stays
  // false forever. Every reconcile then returns on its first line and the
  // engine is simply dead, silently, with no indicator to say so. So the reload
  // is attempted at most once, and a timer marks the player ready anyway if the
  // second onReady never arrives: a player with the wrong `allow` might still
  // fail to autoplay, but it can be started by a tap, which is infinitely
  // better than one that can never be started at all.
  if (iframe && !readyFallbackTimer && !/\bautoplay\b/.test(iframe.allow || '')) {
    iframe.allow = 'autoplay; encrypted-media';
    iframe.src = iframe.src; // eslint-disable-line no-self-assign -- permissions only apply at load
    readyFallbackTimer = setTimeout(() => {
      if (!playerReady) markPlayerReady();
    }, 5000);
    return; // onReady normally fires again once it has reloaded
  }
  markPlayerReady();
}

function markPlayerReady() {
  clearTimeout(readyFallbackTimer);
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
      // Playback started, so nothing is blocked — whatever the watchdog was
      // about to conclude is now moot, and a stale `blocked` must not survive
      // the very event that disproves it.
      clearTimeout(playWatchdog);
      playWatchdog = null;
      if (snapshot.status === 'blocked') set({ status: 'syncing', detail: 'yt-playing' });
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

// Is the offset we hold good enough to make a sound on? Three separate
// questions — do we have one, is it precise enough, is it recent enough — and
// every caller wants all three, so they are asked in one place.
function clockUsable() {
  return (
    clock.ready &&
    clock.uncertaintyMs <= MAX_CLOCK_UNCERTAINTY_MS &&
    Date.now() - clock.measuredAt <= CLOCK_MAX_AGE_MS
  );
}

// Take a new measurement only if it actually beats what we already have, or if
// what we have is too old to keep trusting. This is the same "lowest RTT wins"
// rule `clockOffset` applies within one handshake, extended across handshakes —
// see the note by CLOCK_MAX_AGE_MS for why that is the correct comparison
// rather than "most recent wins".
function adoptClock({ offsetMs, uncertaintyMs }) {
  const expired = Date.now() - clock.measuredAt > CLOCK_MAX_AGE_MS;
  if (clock.ready && !expired && uncertaintyMs >= clock.uncertaintyMs) return false;
  clock = { ready: true, offsetMs, uncertaintyMs, measuredAt: Date.now() };
  return true;
}

// Sequential, not all at once: simultaneous pings share one connection and
// queue behind each other, so every round trip but the first would be inflated
// by head-of-line delay and the lowest-RTT filter would have nothing clean to
// choose from.
async function runClockHandshake({ samples = CLOCK_SAMPLES } = {}) {
  if (clockRunning) return;
  clockRunning = true;
  try {
    const collected = [];
    for (let i = 0; i < samples; i += 1) {
      const s = await pingOnce();
      if (s) collected.push(s);
      if (i < samples - 1) await sleep(CLOCK_SPACING_MS);
    }
    const result = clockOffset(collected);
    // A handshake that returned nothing usable does NOT wipe the clock. It used
    // to, which meant one dropped connection turned a good offset into no
    // offset — and then, with no retry, into permanent silence.
    if (result) adoptClock({ offsetMs: result.offsetMs, uncertaintyMs: result.rttMs / 2 });
    set({ clockReady: clockUsable() });
    reconcile('clock');
  } finally {
    clockRunning = false;
    scheduleClockRetry();
  }
}

// Keep measuring until the clock is good enough — but only while the table is
// actually playing something, so a session sitting in silence is not pinging a
// server it has no use for.
function scheduleClockRetry() {
  // Nothing to chase: stand down and forget the backoff, so the next time a
  // clock IS needed it starts from the fast end again.
  if (clockUsable() || !serverState?.isPlaying) {
    clearTimeout(clockRetryTimer);
    clockRetryTimer = null;
    clockAttempt = 0;
    return;
  }
  // **Idempotent, and that is the whole point.** This is called from several
  // places that repeat — the recovery tick, reconcile's own no-clock gate, every
  // audio:state broadcast. An earlier draft cleared and re-armed the timer on
  // each call, which meant that once the backoff grew past the tick interval,
  // every tick cancelled the pending retry and pushed it further out: it would
  // never have fired at all. A retry already in flight is left strictly alone.
  if (clockRetryTimer || clockRunning) return;
  const delay = CLOCK_RETRY_MS[Math.min(clockAttempt, CLOCK_RETRY_MS.length - 1)];
  clockAttempt += 1;
  clockRetryTimer = setTimeout(() => {
    clockRetryTimer = null;
    runClockHandshake({ samples: CLOCK_RETRY_SAMPLES });
  }, delay);
}

// See RECOVERY_TICK_MS. Armed whenever this client is silent while the table
// plays, disarmed the moment it is not — so the normal case pays nothing.
function updateRecoveryTick() {
  const stuck = snapshot.status === 'silent' && Boolean(serverState?.isPlaying);
  if (stuck && !recoveryTimer) {
    recoveryTimer = setInterval(() => {
      // A clock that expired while we sat here is the one gate this tick cannot
      // clear on its own. `scheduleClockRetry` is a no-op when a measurement is
      // already pending, so calling it every tick costs nothing.
      scheduleClockRetry();
      reconcile('recovery');
    }, RECOVERY_TICK_MS);
  } else if (!stuck && recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
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
  ensurePlayer();
  if (!playerReady || !player) {
    // Bank it: onReady finishes the job. The browser's own sticky activation
    // outlives this call, which is the part that actually matters.
    pendingUnlockGesture = true;
    unlocked = true;
    return false;
  }
  return attemptUnlock();
}

// **Rewritten: trust the gesture, then VERIFY BY OBSERVING (bugfix — "audio
// blocked, tap the record" that never cleared, on desktop).**
//
// The old version tried to *infer* whether the browser had granted permission,
// by playing, pausing on the next animation frame, and checking two seconds
// later whether a PLAYING state had been seen in between. It could essentially
// never succeed, for two compounding reasons:
//
//  - **A YouTube player does not reach PLAYING within one animation frame.**
//    Its state changes cross an iframe boundary by postMessage — BUFFERING
//    first, then PLAYING, typically hundreds of milliseconds later. Pausing
//    after ~16ms cancelled the play *before* the very event the detector was
//    waiting for could ever fire. The comment there worried about the opposite
//    race and picked a window an order of magnitude too small.
//  - **At the moment it ran there was usually no video loaded at all.** The
//    role modal fires this on page load, long before any track is chosen, so
//    `playVideo()` had nothing to play and no state to change.
//
// Either one alone pins `unlocked` to false forever, and reconcile's gate then
// parks on `blocked` permanently — with the remedy it offers ("tap the record")
// re-running the identical broken probe.
//
// So there is no probe now. A user gesture IS the permission every browser
// asks for, so having one is taken at face value; and the one thing that
// reliably works on Safari and iOS — calling `playVideo()` synchronously
// inside the click handler — is what a tap now actually does, rather than a
// ceremony whose result had to be guessed at. If the optimism turns out to be
// wrong, `armPlayWatchdog` notices that playback never started and says so,
// which is a fact rather than an inference.
function attemptUnlock() {
  pendingUnlockGesture = false;
  unlocked = true;
  try {
    // unMute BEFORE anything else: Safari records what the element did during
    // the interaction, and a mute-then-play unlock teaches it "this element
    // plays muted" — after which it refuses to unmute without a fresh gesture.
    player.unMute();
    applyVolume();
    // Play HERE, in the gesture's own task, when there is something to play.
    // This is the whole remedy the indicator promises, and the previous version
    // never actually did it.
    if (serverState?.isPlaying && currentVideoId) {
      player.playVideo();
      armPlayWatchdog();
    }
  } catch {
    /* reconcile below will try again through the normal path */
  }
  reconcile('gesture');
  return true;
}

// **How `blocked` is discovered now: by watching, not by guessing.**
//
// If the table is playing and this client has asked its player to play, then
// PLAYING (or at least BUFFERING on the way to it) must follow within a couple
// of seconds. When it does not, the browser has refused, and that is exactly
// the state where a person can help by tapping. Cleared by the PLAYING handler,
// so a slow buffer resolves itself silently rather than accusing the browser.
function armPlayWatchdog() {
  clearTimeout(playWatchdog);
  playWatchdog = setTimeout(() => {
    playWatchdog = null;
    if (!serverState?.isPlaying) return;
    const state = player?.getPlayerState?.();
    if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) return;
    set({ status: 'blocked', detail: 'autoplay-denied' });
  }, PLAY_WATCHDOG_MS);
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
      if (serverState.isPlaying) {
        player.loadVideoById({ videoId: currentVideoId, startSeconds: startAt });
        armPlayWatchdog();
      } else player.cueVideoById({ videoId: currentVideoId, startSeconds: startAt });
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
  // No gesture has happened on this page at all, so a browser cannot grant
  // sound and there is nothing to try. The role modal makes this rare — it is
  // a mandatory tap on every load — but a deep link that skipped it lands here.
  if (!unlocked) {
    silence('blocked');
    set({ status: 'blocked', detail: 'autoplay-denied' });
    return;
  }
  if (!clockUsable()) {
    // Not a dead end any more: scheduleClockRetry keeps measuring until this
    // clears (see CLOCK_RETRY_MS), and the recovery tick re-runs reconcile.
    silence('no-clock');
    scheduleClockRetry();
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
      // Asking is not starting. If the browser refuses, this is what turns a
      // silently-dead player into "tap the record" — see armPlayWatchdog.
      if (player.getPlayerState?.() !== YT_STATE.PLAYING) armPlayWatchdog();
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
  // "Is anything playing" is what gates the clock retries, and this broadcast is
  // how that answer changes. A GM pressing Play on a device whose clock is not
  // good enough yet is precisely the case that used to stick.
  scheduleClockRetry();
});

socket.on('connect', () => {
  offlineSince = null;
  // **Re-measure, but do not throw away what we have.** This used to reset the
  // clock to "unknown" first, which meant every reconnect — and on mobile there
  // are many — opened a window of guaranteed silence, and a reconnect whose
  // handshake came back slow closed that window permanently. The existing
  // reading stays valid until a better or fresher one replaces it; `adoptClock`
  // decides, and CLOCK_MAX_AGE_MS is what stops a stale one lingering.
  clockAttempt = 0;
  runClockHandshake();
});

socket.on('disconnect', () => {
  offlineSince = Date.now();
});

// A tab that was asleep has a clock worth re-checking — a phone that suspended
// for twenty minutes especially. Re-measure, and let CLOCK_MAX_AGE_MS decide
// whether what we held is still trustworthy in the meantime: a five-second app
// switch should not silence the music, and a twenty-minute one should.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  clockAttempt = 0;
  set({ clockReady: clockUsable() });
  runClockHandshake();
});

// Start loading the API immediately. The several seconds a person spends
// reading the role modal is exactly the budget needed, so the player is
// usually ready by the time their tap arrives.
loadYouTubeApi().catch(() => {
  /* reported through the store when a play is actually attempted */
});
if (socket.connected) runClockHandshake();

// **A console hook, because this engine cannot be tested where it is built.**
//
// The YouTube embed is unreachable from the development sandbox (the egress
// proxy refuses youtube.com), so every bug in the player half of this file has
// had to be diagnosed by reading rather than by running — and two of them were
// diagnosed wrong before being diagnosed right. The whole of the engine's
// internal state is what distinguishes "the browser refused" from "the API
// never loaded" from "the clock is not good enough", and none of it is visible
// from the UI's one-word status.
//
// So: `__dogfightAudio()` in the browser console prints it. No UI, no cost, and
// it turns "the audio does not work" into a single answer.
window.__dogfightAudio = () => ({
  status: snapshot.status,
  detail: snapshot.detail,
  reason: silentReason(),
  track: snapshot.name,
  serverSaysPlaying: Boolean(serverState?.isPlaying),
  // The player half: did the API load, did the embed become usable, is a video
  // actually in it, and what does YouTube itself think it is doing right now.
  apiLoaded: Boolean(window.YT?.Player),
  playerReady,
  unlocked,
  currentVideoId,
  ytPlayerState: player?.getPlayerState?.() ?? null,
  ytMuted: player?.isMuted?.() ?? null,
  ytVolume: player?.getVolume?.() ?? null,
  ytCurrentTime: player?.getCurrentTime?.() ?? null,
  // The clock half: whether this device may make a sound at all.
  clock: { ...clock, usable: clockUsable() },
  expectedPositionMs: serverState ? Math.round(expectedPositionMs(serverState, serverNow())) : null,
  driftMs: snapshot.driftMs,
});

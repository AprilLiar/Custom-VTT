// Playtest: the Audio Player's server half — the parts no unit test can reach.
//
// server/test/audioSync.test.js already pins the maths. What it cannot pin is
// the thing this feature actually promises: that a client which connects
// LATE is told where the song already is. That is a property of the live
// identity:set path, the anchor arithmetic and the wall clock together, so it
// is checked here against a running server with real elapsed time.
//
// Also checked here: the GM gate (a Player must not be able to run the
// table's music), and the anchorId guard that stops six clients all reporting
// the same track ending and skipping six songs.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-audio.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jpost = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then((r) => r.json());

const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILED');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.states = [];
  s.on('audio:state', (st) => s.states.push(st));
  if (identity) {
    s.emit('identity:set', identity);
    await sleep(350);
  }
  return s;
};
const latest = (s) => s.states[s.states.length - 1] ?? null;

const stamp = Date.now();
const gm = await connect({ role: 'gm' });
const pc = await jpost('/api/characters', { name: `AudioPC${stamp}`, characterType: 'pc' });
const player = await connect({ role: 'player', characterId: pc.id });

const library = () => jf('/api/audio-library?role=gm');

// ============================================ 1. the clock handshake
console.log('\n--- the clock handshake answers every client, Player included ---');
const pong = await new Promise((r) => {
  player.once('audio:pong', r);
  player.emit('audio:ping', { t0: 12345 });
  setTimeout(() => r(null), 2000);
});
check('a Player gets audio:pong with the echoed t0 and a server clock', Boolean(pong) && pong.t0 === 12345 && Number.isFinite(pong.serverMs), JSON.stringify(pong));

// ============================================ 2. GM management
console.log('\n--- the GM builds a playlist ---');
gm.emit('audio_playlist:create', { name: `Tavern${stamp}` });
await sleep(300);
let lib = await library();
const list = lib.playlists.find((p) => p.name === `Tavern${stamp}`);
check('the playlist was created', Boolean(list), JSON.stringify(lib.playlists));

// Every URL shape a GM might paste, plus one that must be refused.
gm.emit('audio_track:create', { playlistId: list.id, name: 'First', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
gm.emit('audio_track:create', { playlistId: list.id, name: 'Second', url: 'https://youtu.be/9bZkp7q19f0?t=30' });
gm.emit('audio_track:create', { playlistId: list.id, name: 'Third', url: 'oHg5SJYRHA0' });
await sleep(400);
const rejected = new Promise((r) => { gm.once('audio_track:rejected', r); setTimeout(() => r(null), 1200); });
gm.emit('audio_track:create', { playlistId: list.id, name: 'Bad', url: 'https://vimeo.com/12345' });
const rejection = await rejected;
lib = await library();
let tracks = lib.tracks.filter((t) => t.playlist_id === list.id);
check('three tracks landed, in the order they were created', tracks.length === 3 && tracks.map((t) => t.name).join(',') === 'First,Second,Third', JSON.stringify(tracks.map((t) => t.name)));
check('the ids were parsed out of three different URL shapes', tracks.map((t) => t.youtube_id).join(',') === 'dQw4w9WgXcQ,9bZkp7q19f0,oHg5SJYRHA0', JSON.stringify(tracks.map((t) => t.youtube_id)));
check('a non-YouTube link is refused, not stored as a song that can never play', rejection?.reason === 'not-a-youtube-link', JSON.stringify(rejection));

// ============================================ 3. the GM gate
console.log('\n--- a Player may not run the table\'s music ---');
player.emit('audio_playlist:create', { name: `PlayerList${stamp}` });
player.emit('audio_track:delete', { trackId: tracks[0].id });
player.emit('audio:play', { trackId: tracks[0].id });
await sleep(400);
lib = await library();
check("the Player's playlist:create was refused", !lib.playlists.some((p) => p.name === `PlayerList${stamp}`), JSON.stringify(lib.playlists.map((p) => p.name)));
check("the Player's track:delete was refused", lib.tracks.filter((t) => t.playlist_id === list.id).length === 3);
check("the Player's play was refused", latest(player)?.trackId !== tracks[0].id, JSON.stringify(latest(player)));

// ============================================ 4. joining late — the whole point
console.log('\n--- someone who joins 3s late hears it 3s in ---');
gm.emit('audio:play', { trackId: tracks[0].id });
await sleep(300);
const playedAt = Date.now();
check('every connected client was told, GM and Player alike', latest(gm)?.trackId === tracks[0].id && latest(player)?.trackId === tracks[0].id, JSON.stringify({ gm: latest(gm), player: latest(player) }));
check('the broadcast carries the anchor and the video id, not just an id to look up', latest(player)?.youtubeId === 'dQw4w9WgXcQ' && latest(player)?.isPlaying === true && Number.isFinite(latest(player)?.anchoredAtMs), JSON.stringify(latest(player)));

await sleep(3000);
const latecomer = await connect({ role: 'player', characterId: pc.id });
const snapshot = latest(latecomer);
check('a client that never saw the play event is sent the state on identity:set', Boolean(snapshot) && snapshot.trackId === tracks[0].id, JSON.stringify(snapshot));
// The anchor + the server's own clock is everything a late client needs.
const impliedMs = snapshot ? snapshot.positionMs + (snapshot.serverMs - snapshot.anchoredAtMs) : null;
const trueElapsed = Date.now() - playedAt;
check(
  `the anchor implies ~${Math.round(trueElapsed / 1000)}s into the song (got ${Math.round(impliedMs)}ms)`,
  impliedMs != null && Math.abs(impliedMs - trueElapsed) < 700,
  JSON.stringify({ impliedMs, trueElapsed, snapshot })
);

// ============================================ 5. pause anchors where it really is
console.log('\n--- pause freezes the true position, resume continues from it ---');
gm.emit('audio:pause');
await sleep(300);
const paused = latest(gm);
check('paused state reports is_playing false', paused?.isPlaying === false, JSON.stringify(paused));
check('the frozen position is where the song actually was, not where it started', paused?.positionMs > 2500 && paused?.positionMs < 5000, JSON.stringify(paused));
await sleep(1500);
const stillPaused = latest(gm);
check('a paused position does not drift with the clock', stillPaused.positionMs === paused.positionMs, JSON.stringify({ paused, stillPaused }));
gm.emit('audio:resume');
await sleep(300);
check('resume picks up from the frozen position', Math.abs(latest(gm).positionMs - paused.positionMs) < 200, JSON.stringify(latest(gm)));

// ============================================ 6. the anchorId guard
console.log('\n--- six clients reporting one ending must not skip six songs ---');
const before = latest(gm);
// A stale report, from before the last state change.
gm.emit('audio:track_ended', { trackId: before.trackId, anchorId: before.anchorId - 5 });
await sleep(300);
check('a stale track_ended is ignored', latest(gm).trackId === before.trackId, JSON.stringify(latest(gm)));
// Three fresh ones at once — exactly what three listeners' players would send.
gm.emit('audio:track_ended', { trackId: before.trackId, anchorId: before.anchorId });
player.emit('audio:track_ended', { trackId: before.trackId, anchorId: before.anchorId });
latecomer.emit('audio:track_ended', { trackId: before.trackId, anchorId: before.anchorId });
await sleep(500);
check('three simultaneous reports advanced exactly one song', latest(gm).trackId === tracks[1].id, JSON.stringify({ expected: tracks[1].id, got: latest(gm).trackId }));

// ============================================ 7. reorder, and repeat wrap
console.log('\n--- Move Up/Down send the whole order; repeat wraps ---');
gm.emit('audio_track:reorder', { playlistId: list.id, trackIds: [tracks[2].id, tracks[0].id, tracks[1].id] });
await sleep(350);
lib = await library();
tracks = lib.tracks.filter((t) => t.playlist_id === list.id);
check('the new order stuck', tracks.map((t) => t.name).join(',') === 'Third,First,Second', JSON.stringify(tracks.map((t) => t.name)));

gm.emit('audio:play', { trackId: tracks[2].id }); // the last one
await sleep(300);
gm.emit('audio:next');
await sleep(350);
check('next on the last track wraps to the first (repeat: playlist)', latest(gm).trackId === tracks[0].id, JSON.stringify(latest(gm)));

gm.emit('audio:set_mode', { repeatMode: 'off' });
await sleep(300);
check('set_mode does not interrupt the song that is playing', latest(gm).trackId === tracks[0].id && latest(gm).isPlaying === true, JSON.stringify(latest(gm)));
check('the mode changed', latest(gm).repeatMode === 'off', JSON.stringify(latest(gm)));

// ============================================ 8. deleting the playing song
console.log('\n--- deleting the playing song advances rather than going silent ---');
gm.emit('audio:play', { trackId: tracks[0].id });
await sleep(300);
gm.emit('audio_track:delete', { trackId: tracks[0].id });
await sleep(450);
check('playback moved to the next song', latest(gm).trackId === tracks[1].id, JSON.stringify({ expected: tracks[1].id, got: latest(gm).trackId }));

console.log('\n--- deleting the whole playlist stops the music ---');
gm.emit('audio_playlist:delete', { playlistId: list.id });
await sleep(450);
check('playback stopped', latest(gm).trackId === null && latest(gm).isPlaying === false, JSON.stringify(latest(gm)));
lib = await library();
check('the tracks cascaded away with it', !lib.tracks.some((t) => t.playlist_id === list.id));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
gm.close();
player.close();
latecomer.close();
process.exit(failures ? 1 : 0);

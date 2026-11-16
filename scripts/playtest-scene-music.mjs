// Playtest: Scene music — a Scene's song (Scene and Simple Combat) and its
// Combat song, set in the Scene editor; activating the Scene and switching
// its mode plays the right one on loop, replacing the global music; a Scene
// without a song stops a Scene song left playing.
//
//   (start the dev server first)
//   node scripts/playtest-scene-music.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILURE(S)');
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);
const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  await sleep(300);
  return s;
};

const stamp = Date.now();
const gm = await connect({ role: 'gm' });
let audio = null;
gm.on('audio:state', (a) => (audio = a));
const rejected = [];
gm.on('scene:song_rejected', (x) => rejected.push(x));
const scene = async (name) => {
  gm.emit('scene:create', { name });
  await sleep(300);
  return (await jf('/api/scenes?role=gm')).find((s) => s.name === name);
};
const a = await scene(`SM-A ${stamp}`);
const b = await scene(`SM-B ${stamp}`);

console.log('\n--- global music first ---');
gm.emit('audio_playlist:create', { name: `Global ${stamp}` });
await sleep(300);
const lib0 = await jf('/api/audio-library?role=gm');
const pl = lib0.playlists.find((p) => p.name === `Global ${stamp}`);
gm.emit('audio_track:create', { playlistId: pl.id, name: 'Global song', url: 'https://youtu.be/aaaaaaaaaaa' });
await sleep(300);
const globalTrack = (await jf('/api/audio-library?role=gm')).tracks.find((t) => t.playlist_id === pl.id);
gm.emit('audio:play', { trackId: globalTrack.id });
await sleep(300);
check('the global song plays', audio?.trackId === globalTrack.id && audio.isPlaying, JSON.stringify(audio));

console.log('\n--- setting a Scene\'s songs ---');
gm.emit('scene:update', { sceneId: a.id, name: a.name, sceneSong: { name: 'Calm', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' }, combatSong: { name: 'Battle', url: 'ccccccccccc' } });
await sleep(400);
let music = await jf(`/api/scenes/${a.id}/music?role=gm`);
check('the editor reads both songs back (name and link)', music.scene?.name === 'Calm' && /bbbbbbbbbbb/.test(music.scene.url) && music.combat?.name === 'Battle', JSON.stringify(music));
check('…and they stay out of the Audio Player\'s library', !(await jf('/api/audio-library?role=gm')).tracks.some((t) => t.name === 'Calm' || t.name === 'Battle'));
check('setting them on a Scene that isn\'t active leaves the music alone', audio?.trackId === globalTrack.id && audio.isPlaying);
gm.emit('scene:update', { sceneId: b.id, name: b.name, sceneSong: { name: 'Bad', url: 'not a link' } });
await sleep(300);
check('a link that isn\'t YouTube is refused', rejected.some((x) => x.sceneId === b.id && x.which === 'scene'), JSON.stringify(rejected));

console.log('\n--- activating and switching modes ---');
gm.emit('scene:activate', { sceneId: a.id });
await sleep(500);
check('activating the Scene replaces the global music with its song', audio?.name === 'Calm' && audio.isPlaying, JSON.stringify(audio));
const calmId = audio.trackId;
gm.emit('scene:set_mode', { mode: 'simple' });
await sleep(400);
check('Simple Combat keeps the Scene\'s song (not restarted)', audio?.trackId === calmId && audio.isPlaying);
gm.emit('scene:set_mode', { mode: 'combat' });
await sleep(400);
check('Combat plays the Combat song', audio?.name === 'Battle' && audio.isPlaying, JSON.stringify(audio));
gm.emit('audio:track_ended', { trackId: audio.trackId, anchorId: audio.anchorId });
await sleep(400);
check('…on loop: at its end it starts again', audio?.name === 'Battle' && audio.isPlaying && audio.positionMs === 0, JSON.stringify(audio));
gm.emit('scene:set_mode', { mode: 'scene' });
await sleep(400);
check('back to the Scene: its song again', audio?.name === 'Calm' && audio.isPlaying);

console.log('\n--- a Scene without a song ---');
gm.emit('scene:activate', { sceneId: b.id });
await sleep(400);
check('a Scene without a song stops the last Scene\'s song', !audio?.isPlaying, JSON.stringify(audio));
gm.emit('scene:activate', { sceneId: a.id });
await sleep(400);
gm.emit('scene:update', { sceneId: a.id, name: a.name, sceneSong: null });
await sleep(400);
music = await jf(`/api/scenes/${a.id}/music?role=gm`);
check('clearing the active Scene\'s song stops it', music.scene === null && !audio?.isPlaying, JSON.stringify([music, audio]));

gm.emit('audio:stop');
for (const s of [a, b]) gm.emit('scene:delete', { sceneId: s.id });
gm.emit('audio_playlist:delete', { playlistId: pl.id });
await sleep(400);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

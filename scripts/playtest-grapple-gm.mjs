// Playtest: an NPC grappler's follow-up must be asked of the GM.
//
// A grapple where the grabbing character is an NPC pauses waiting for "the
// grappler" to pick a direction — and the GM is the grappler, because the GM
// owns every NPC. If the GM's own prompt never opens, the round sits paused
// forever and the chain never starts, which is exactly what a table sees as
// "grappling does not work".
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-grapple-gm.mjs
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

const connect = () =>
  new Promise((res) => {
    const sock = io(BASE);
    sock.latest = null;
    sock.on('combat:updated', (c) => { sock.latest = c; });
    sock.on('connect', () => res(sock));
  });

const gm = await connect();
const victimSock = await connect();
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: 'Hands to the neck' });
const tell = await wait(gm, 'tell:created');
const stamp = Date.now();

const mk = async (name, extra = {}) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    startupTics: 1, activeTics: 1, recoveryTics: 1,
    description: name, interactions: {}, rollSlots: ['Skull'],
    attackTargets: ['Body'], staminaCost: 0, ...extra,
  });
  return wait(gm, 'move:created', (m) => m.name === `${name} ${stamp}`);
};

const knee = await mk('Knee');
const throwMove = await mk('Hip Throw');
const clinch = await mk('Thai Clinch', {
  isGrappling: true,
  rollModifier: 20, // make the grab land every time
  grappleDirections: { up: knee.id, right: throwMove.id },
  interactions: { grapple_success: { text: 'the clinch is set', automations: [] } },
});

// **The grappler is an NPC and the target is a PC** — the exact pairing the
// bug report describes. An all-NPC grapple auto-chains and never prompts, and
// a PC grappler prompts that player, so neither shape exercises this.
const npc = await jpost('/api/characters', { name: `Npc${stamp}`, characterType: 'npc' });
const pc = await jpost('/api/characters', { name: `Pc${stamp}`, characterType: 'pc' });
victimSock.emit('identity:set', { role: 'player', characterId: pc.id });
await sleep(400);

gm.emit('combat:add_participant', { characterId: npc.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === npc.id));
gm.emit('combat:add_participant', { characterId: pc.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === pc.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const st0 = await jf('/api/combat?role=gm');
const start = st0.pairs[0].roundStartTic ?? 0;
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide;
  if (!side) break;
  const who = side === 'left' ? npc : pc;
  if (who.id === npc.id) {
    gm.emit('move:declare', { characterId: npc.id, moveId: clinch.id, placementTic: start });
    await sleep(500);
  }
  gm.emit('combat:character_done_declaring', { characterId: who.id });
  await sleep(700);
}
await sleep(3000);

const pendingOf = (sock) => sock.latest?.pairs?.find((p) => p.pairIndex === 0)?.pendingGrapple ?? null;
const st1 = await jf('/api/combat?role=gm');
check('the round pauses on the grapple', st1.pairs[0]?.resolutionStatus === 'paused_grapple',
  st1.pairs[0]?.resolutionStatus);

const gmPending = pendingOf(gm);
check('the GM is the grappler, not a bystander', gmPending?.role === 'grappler',
  JSON.stringify({ role: gmPending?.role, waitingOn: gmPending?.waitingOn }));
check('...and is actually being asked right now', gmPending?.answered === false,
  JSON.stringify(gmPending?.answered));
check('...with the follow-up names to choose between',
  gmPending?.directions?.some((d) => /Knee/.test(d.moveName ?? '')),
  JSON.stringify(gmPending?.directions));
check('the PC target is told who it waits on, and sees no names',
  pendingOf(victimSock)?.answered === true &&
    pendingOf(victimSock)?.directions?.every((d) => d.moveName === null),
  JSON.stringify(pendingOf(victimSock)));

// The GM answers for their NPC, and the chain actually starts.
gm.emit('combat:grapple_choose', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: gmPending?.grapplerDeclaredMoveId });
await sleep(900);
check('the GM answering advances to the defender guess', pendingOf(victimSock)?.phase === 'guess',
  JSON.stringify(pendingOf(victimSock)?.phase));
victimSock.emit('combat:grapple_guess', { pairIndex: 0, direction: 'down', grapplerDeclaredMoveId: gmPending?.grapplerDeclaredMoveId });
await sleep(3500);

const after = await jf('/api/combat?role=gm');
check('both answers clear the pause', after.pairs[0]?.resolutionStatus !== 'paused_grapple',
  after.pairs[0]?.resolutionStatus);
const chained = after.declaredMoves.find((d) => d.characterId === npc.id && d.moveName === `Knee ${stamp}`);
check('the follow-up is retroactively on the board', chained != null,
  JSON.stringify(after.declaredMoves.map((d) => d.moveName)));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, victimSock]) s.close();
process.exit(failures ? 1 : 0);

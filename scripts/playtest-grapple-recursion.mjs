// Grapple chains are recursive: if a follow-up is ITSELF a grappling move, the
// whole flow starts again. Nothing special makes that work — a retroactively
// declared move is an ordinary declared move, so when its Tic arrives it goes
// through resolveGrapple like any other — which is exactly the claim worth
// pinning down, because "it should fall out naturally" is not evidence.
//
//   node scripts/playtest-grapple-recursion.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}: ${l}${c ? '' : ' — ' + d}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json().catch(() => null));
const jpost = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const connect = () => new Promise((res) => { const s = io(BASE); s.latest = null; s.on('combat:updated', (c) => { s.latest = c; }); s.on('connect', () => res(s)); });

const gm = await connect(), gs = await connect(), ts = await connect();
const wait = (sock, ev, pred = () => true, ms = 10000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } }; sock.on(ev, h);
});

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(500);
// Listener BEFORE emit: socket.io can deliver the reply before a listener
// attached afterwards exists, which is a race the other playtests only win by
// luck.
// Unique per run: a re-run that reuses a name the server already has gets
// nothing back, which reads as a hang rather than as a duplicate.
const stamp = Date.now();
const tellReady = wait(gm, 'tell:created');
gm.emit('tell:create', { name: `Collar and elbow ${stamp}` });
const tell = await tellReady;
const mk = async (n, x = {}) => {
  const ready = wait(gm, 'move:created', (m) => m.name === `${n} ${stamp}`);
  gm.emit('move:create', { name: `${n} ${stamp}`, isDefault: true, tellId: tell.id, startupTics: 1, activeTics: 1,
    recoveryTics: 0, description: n, interactions: {}, rollSlots: ['Skull'], attackTargets: ['Body'], staminaCost: 0, ...x });
  return ready;
};

// Three deep: Clinch -> Trip (also a grapple) -> Finish.
const finish = await mk('Finish');
const trip = await mk('Trip', { isGrappling: true, rollModifier: 20, grappleDirections: { up: finish.id, right: finish.id } });
const clinch = await mk('Clinch', { isGrappling: true, rollModifier: 20, grappleDirections: { up: trip.id, right: trip.id } });

const a = await jpost('/api/characters', { name: `Ga${stamp}`, characterType: 'pc' });
const b = await jpost('/api/characters', { name: `Vb${stamp}`, characterType: 'pc' });
gs.emit('identity:set', { role: 'player', characterId: a.id });
ts.emit('identity:set', { role: 'player', characterId: b.id });
await sleep(400);
gm.emit('combat:add_participant', { characterId: a.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === a.id));
gm.emit('combat:add_participant', { characterId: b.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === b.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
for (let i = 0; i < 2; i++) {
  const st = await jf('/api/combat?role=gm');
  const side = st.pairs[0].declaringSide; if (!side) break;
  const who = side === 'left' ? a : b;
  if (who.id === a.id) { gm.emit('move:declare', { characterId: a.id, moveId: clinch.id, placementTic: st.pairs[0].roundStartTic ?? 0 }); await sleep(500); }
  gm.emit('combat:character_done_declaring', { characterId: who.id }); await sleep(600);
}
await sleep(2500);

const pend = (s) => s.latest?.pairs?.find((p) => p.pairIndex === 0)?.pendingGrapple ?? null;
// Answer every prompt that appears, up to a bound that would catch a runaway.
let rounds = 0;
for (; rounds < 6; rounds++) {
  const st = await jf('/api/combat?role=gm');
  if (st.pairs[0]?.resolutionStatus !== 'paused_grapple') break;
  const p = pend(gs);
  if (p?.phase === 'choice') {
    gs.emit('combat:grapple_choose', { pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: p.grapplerDeclaredMoveId });
  } else {
    const tpp = pend(ts);
    ts.emit('combat:grapple_guess', { pairIndex: 0, direction: 'left', grapplerDeclaredMoveId: tpp.grapplerDeclaredMoveId });
  }
  await sleep(1800);
}
check('the round did not need an unbounded number of answers', rounds < 6, `answered ${rounds} times`);

const chat = await jf('/api/chat');
const sum = chat.filter((e) => e.kind === 'round_summary' && e.pairIndex === 0).pop();
const evs = sum ? (await jf(`/api/combat/round-replay/${sum.resolutionId}`))?.events ?? [] : [];
const types = evs.map((e) => e.type);
console.log('  events:', types.join(', '));

const prompts = types.filter((t) => t === 'grapple_prompt').length;
const resolveds = types.filter((t) => t === 'grapple_resolved').length;
const chains = types.filter((t) => t === 'grapple_chained').length;
check('a grapple chained into a grapple prompted TWICE', prompts >= 2, `${prompts} prompt(s)`);
check('...and ran two contests', resolveds >= 2, `${resolveds} contest(s)`);
check('...and declared two follow-ups', chains >= 2, `${chains} chain(s)`);
const names = evs.filter((e) => e.type === 'grapple_chained').map((e) => e.payload?.moveName);
check('the second link is the third move in the sequence', names.some((n) => /Finish/.test(n ?? '')), JSON.stringify(names));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, gs, ts]) s.close();
process.exit(failures ? 1 : 0);

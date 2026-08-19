// Playtest: the **Secondary** flag. A Secondary move can be granted and read,
// but never declared off the picker by hand — it arrives the two ways the
// engine puts a move on the board for you.
//
// Three claims, all against the real server:
//   1. a Secondary move with no Requirement is refused when declared by hand;
//   2. the same move still lands when a grapple's cross picks it;
//   3. a Secondary move WITH a Requirement is the combo case — refused on its
//      own, accepted in the slot right after the move it follows.
//
//   npm run dev   (or node server/index.js)
//   node scripts/playtest-secondary.mjs
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
const victim = await connect();
const wait = (sock, ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); sock.off(ev, h); res(p); } };
    sock.on(ev, h);
  });

gm.emit('identity:set', { role: 'gm' });
gm.emit('combat:clear', {});
await sleep(700);
gm.emit('tell:create', { name: 'Shoulder drops' });
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

// The three moves under test.
const opener = await mk('Opener');
const knee = await mk('Secret Knee', { isSecondary: true });          // grapple-only
const followUp = await mk('Combo Elbow', {                            // combo-only
  isSecondary: true,
  requirementMoveId: opener.id,
});
const clinch = await mk('Clinch', {
  isGrappling: true,
  rollModifier: 30,
  grappleDirections: { up: knee.id },
  interactions: { grapple_success: { text: 'the clinch is set', automations: [] } },
});

// ---------------------------------------------------- the flag round-trips
const stored = (await jf('/api/moves')).moves.find((m) => m.id === knee.id);
check('the Secondary flag survives a save', Boolean(stored?.is_secondary),
  JSON.stringify({ is_secondary: stored?.is_secondary }));
const plain = (await jf('/api/moves')).moves.find((m) => m.id === opener.id);
check('an ordinary move is not Secondary', !plain?.is_secondary,
  JSON.stringify({ is_secondary: plain?.is_secondary }));

const npc = await jpost('/api/characters', { name: `Npc${stamp}`, characterType: 'npc' });
const pc = await jpost('/api/characters', { name: `Pc${stamp}`, characterType: 'pc' });
victim.emit('identity:set', { role: 'player', characterId: pc.id });
await sleep(400);

gm.emit('combat:add_participant', { characterId: npc.id, side: 'left', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === npc.id));
gm.emit('combat:add_participant', { characterId: pc.id, side: 'right', pairIndex: 0 });
await wait(gm, 'combat:updated', (c) => c.participants.some((p) => p.character_id === pc.id));
gm.emit('combat:next_round', {});
await wait(gm, 'combat:updated', (c) => c.pairs[0]?.phase === 'declaration');

const st0 = await jf('/api/combat?role=gm');
const start = st0.pairs[0].roundStartTic ?? 0;
// **Read as the character's own owner, not as the GM.** A Player's unrevealed
// move name is withheld from the GM by design (see isRevealedToViewer), so a
// GM-eyed read of a PC's queue comes back as a list of nulls and every
// name-based assertion below would fail for a reason that has nothing to do
// with Secondary.
const declaredOf = async (charId) =>
  (await jf(`/api/combat?role=player&characterId=${charId}`)).declaredMoves.filter(
    (d) => d.characterId === charId
  );

// ------------------------------------------- 1. hand-declaring is refused
// Whoever declares first; both are GM-drivable (the PC's socket is a player,
// but declaring is open-access by this app's trust model — which is exactly
// why the rule has to be enforced server-side rather than by hiding a button).
const first = st0.pairs[0].declaringSide === 'left' ? npc : pc;
const second = first.id === npc.id ? pc : npc;

gm.emit('move:declare', { characterId: first.id, moveId: knee.id, placementTic: start });
await sleep(700);
check('a Secondary move with no Requirement is REFUSED by hand',
  (await declaredOf(first.id)).length === 0,
  JSON.stringify(await declaredOf(first.id)));

gm.emit('move:declare', { characterId: first.id, moveId: followUp.id, placementTic: start });
await sleep(700);
check('a Secondary combo follow-up is refused out of position too',
  (await declaredOf(first.id)).length === 0,
  JSON.stringify(await declaredOf(first.id)));

// ------------------------------ 3. ...but accepted right after its opener
gm.emit('move:declare', { characterId: first.id, moveId: opener.id, placementTic: start });
await sleep(700);
check('its opener declares normally', (await declaredOf(first.id)).length === 1,
  JSON.stringify(await declaredOf(first.id)));
gm.emit('move:declare', { characterId: first.id, moveId: followUp.id });
await sleep(700);
const afterCombo = await declaredOf(first.id);
check('and NOW the Secondary follow-up is accepted, right after it',
  afterCombo.length === 2 && afterCombo.some((d) => d.moveName === `Combo Elbow ${stamp}`),
  JSON.stringify(afterCombo.map((d) => d.moveName)));

// ------------------------------------- 2. the grapple still reaches it
gm.emit('combat:character_done_declaring', { characterId: first.id });
await sleep(700);
gm.emit('move:declare', { characterId: second.id, moveId: clinch.id, placementTic: start });
await sleep(500);
gm.emit('combat:character_done_declaring', { characterId: second.id });
await sleep(4000);

const pendingOf = (sock) => sock.latest?.pairs?.find((p) => p.pairIndex === 0)?.pendingGrapple ?? null;
const grappler = second.id === npc.id ? gm : victim;
const p = pendingOf(grappler);
check('the grapple offers the Secondary move on its cross',
  p?.directions?.some((d) => /Secret Knee/.test(d.moveName ?? '') && d.available),
  JSON.stringify(p?.directions?.map((d) => ({ n: d.moveName, a: d.available }))));

if (p) {
  grappler.emit('combat:grapple_choose', {
    pairIndex: 0, direction: 'up', grapplerDeclaredMoveId: p.grapplerDeclaredMoveId,
  });
  await sleep(4000);
}
const chained = (await declaredOf(second.id)).map((d) => d.moveName);
check('...and the engine puts it on the board, which hands never could',
  chained.some((n) => n === `Secret Knee ${stamp}`), JSON.stringify(chained));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
for (const s of [gm, victim]) s.close();
process.exit(failures ? 1 : 0);

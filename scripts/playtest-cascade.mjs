// Playtest: the Block-extension cascade (Defence rework decision #4).
//
// A Block that falls short extends its own Recovery, and that extension pushes
// the blocker's whole remaining queue back — one prompt for the lot, answered
// Extend or Forfeit by whoever controls that fighter.
//
// **Only a live server can show the part that matters.** The cascade spans
// `finishBlock` (which builds the plan), a socket pause, a human answer, and
// `resolveMoveConflict` (which rebuilds and applies it) — and the whole point
// of decision #4 is that the tail shown in the prompt is the tail that moves.
// Unit tests can pin each half; only a running round proves they agree.
//
//   TURSO_DATABASE_URL="file:/tmp/pt.db" PORT=3041 node server/index.js
//   E2E_URL=http://localhost:3041 node scripts/playtest-cascade.mjs
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

const gm = io(BASE);
await new Promise((r) => gm.on('connect', r));
const wait = (ev, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); gm.off(ev, h); res(p); } };
    gm.on(ev, h);
  });
gm.emit('identity:set', { role: 'gm' });
await sleep(500);
const stamp = Date.now();

gm.emit('tell:create', { name: `Cascade Tell ${stamp}` });
const tell = await wait('tell:created', (t) => t.name === `Cascade Tell ${stamp}`);
const mk = async (name, extra) => {
  gm.emit('move:create', {
    name: `${name} ${stamp}`, isDefault: true, tellId: tell.id,
    description: name, interactions: {}, staminaCost: 0, ...extra,
  });
  return wait('move:created', (m) => m.name === `${name} ${stamp}`);
};

// The attacker's blow: two Active Tics, so a one-Tic guard falls short of it
// and has to stretch. That shortfall is what produces the extension at all.
const lunge = await mk('Cascade Lunge', {
  startupTics: 1, activeTics: 2, recoveryTics: 1, rollSlots: ['Skull'], attackTargets: ['Body'],
});
// The guard: one Defense Frame on its single Active Tic. Covers the first
// Active frame of the Lunge (so it is not discarded) but not the second.
const guard = await mk('Cascade Guard', {
  startupTics: 1, activeTics: 1, recoveryTics: 1, rollSlots: ['Hand', 'Hand'],
  isDefensive: true, defenseKind: 'block', defenseFramePositions: [1],
});
const followA = await mk('Cascade Follow A', {
  startupTics: 1, activeTics: 1, recoveryTics: 0, rollSlots: ['Skull'], staminaCost: 2, attackTargets: ['Body'],
});
const followB = await mk('Cascade Follow B', {
  startupTics: 1, activeTics: 1, recoveryTics: 0, rollSlots: ['Skull'], staminaCost: 2, attackTargets: ['Body'],
});

// Seats a fight, declares the Lunge for the attacker and Guard + two follow-ups
// for the blocker, resolves until the cascade prompt lands, and returns it.
const runToPrompt = async (label) => {
  gm.emit('combat:clear', {});
  await sleep(800);
  const atk = await jpost('/api/characters', { name: `A${label}${stamp}`, characterType: 'npc' });
  const def = await jpost('/api/characters', { name: `D${label}${stamp}`, characterType: 'npc' });
  gm.emit('combat:add_participant', { characterId: atk.id, side: 'left', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === atk.id));
  gm.emit('combat:add_participant', { characterId: def.id, side: 'right', pairIndex: 0 });
  await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === def.id));
  gm.emit('combat:next_round', {});
  await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
  const start = (await jf('/api/combat?role=gm')).pairs[0].roundStartTic ?? 0;

  // Catch the prompt as it fires — it is a round event, and the round runs on
  // once it is answered.
  const prompt = new Promise((res) => {
    const h = (e) => {
      if (e?.type === 'move_conflict_prompt') { gm.off('combat:round_event', h); res(e.payload); }
    };
    gm.on('combat:round_event', h);
  });

  for (let i = 0; i < 2; i++) {
    const side = (await jf('/api/combat?role=gm')).pairs[0].declaringSide;
    if (!side) break;
    if (side === 'left') {
      gm.emit('move:declare', { characterId: atk.id, moveId: lunge.id, placementTic: start });
      await sleep(600);
      gm.emit('combat:character_done_declaring', { characterId: atk.id });
    } else {
      gm.emit('move:declare', { characterId: def.id, moveId: guard.id, placementTic: start });
      await sleep(600);
      // Right behind the guard's authored footprint (1/1/1 -> ends at start+3),
      // which is exactly where the extension will land.
      gm.emit('move:declare', { characterId: def.id, moveId: followA.id, placementTic: start + 3 });
      await sleep(600);
      gm.emit('move:declare', { characterId: def.id, moveId: followB.id, placementTic: start + 5 });
      await sleep(600);
      gm.emit('combat:character_done_declaring', { characterId: def.id });
    }
    await sleep(800);
  }

  // Answer the Block prompt Successful so the guard actually applies; the
  // extension (and the cascade) only exist for a guard that stood.
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const status = (await jf('/api/combat?role=gm')).pairs?.[0]?.resolutionStatus;
    if (status === 'paused_defense') gm.emit('combat:resolve_block', { pairIndex: 0, outcome: 'successful' });
    else if (status === 'paused_conflict') break;
    else if (status == null || status === 'complete') break;
  }
  const payload = await Promise.race([prompt, sleep(8000).then(() => null)]);
  return { atk, def, start, payload };
};

// ============================================ 1. one prompt, whole tail
console.log('--- the cascade is one prompt carrying the whole tail ---');
const first = await runToPrompt('X1');
check('the round paused on a conflict', first.payload != null, 'no move_conflict_prompt arrived');
console.log('  shifts:', JSON.stringify(first.payload?.shifts));
check('both follow-ups are in the one prompt',
  (first.payload?.shifts ?? []).length === 2, JSON.stringify(first.payload?.shifts));
check('...each named, so the choice can be made with the tail visible',
  (first.payload?.shifts ?? []).every((s) => typeof s.moveName === 'string' && s.moveName.length),
  JSON.stringify(first.payload?.shifts));
check('...and the guard that caused it is named too',
  typeof first.payload?.blockerMoveName === 'string', JSON.stringify(first.payload?.blockerMoveName));

// ============================================ 2. Extend applies the whole plan
console.log('\n--- Extend pushes everything back, in one answer ---');
{
  const planned = first.payload.shifts;
  gm.emit('combat:resolve_move_conflict', {
    declaredMoveId: first.payload.declaredMoveId,
    blockerDeclaredMoveId: first.payload.blockerDeclaredMoveId,
    choice: 'extend',
  });
  await sleep(3000);
  const state = await jf('/api/combat?role=gm');
  const placed = new Map((state.declaredMoves ?? []).map((d) => [d.id, d.placementTic]));
  const moved = planned.map((s) => ({ name: s.moveName, want: s.to, got: placed.get(s.declaredMoveId) }));
  console.log('  ', JSON.stringify(moved));
  // A move shoved clear of the round keeps its declaration but stops being a
  // commitment, so it is still on the board at the Tic the plan named.
  check('every move landed exactly where the prompt said it would',
    moved.every((m) => m.got == null || m.got === m.want), JSON.stringify(moved));
  check('the round is no longer paused',
    (await jf('/api/combat?role=gm')).pairs?.[0]?.resolutionStatus !== 'paused_conflict',
    String((await jf('/api/combat?role=gm')).pairs?.[0]?.resolutionStatus));
}

// ============================================ 3. Forfeit
console.log('\n--- Forfeit gives up the first move and refunds it ---');
{
  const second = await runToPrompt('X2');
  check('the second fixture also paused', second.payload != null);
  const victim = second.payload.declaredMoveId;
  const before = (await jf(`/api/characters/${second.def.id}`))?.character?.current_stamina;
  gm.emit('combat:resolve_move_conflict', {
    declaredMoveId: victim,
    blockerDeclaredMoveId: second.payload.blockerDeclaredMoveId,
    choice: 'forfeit',
  });
  await sleep(3000);
  const state = await jf('/api/combat?role=gm');
  const stillThere = (state.declaredMoves ?? []).some((d) => d.id === victim);
  check('the forfeited move is off the board', !stillThere);
  // The chat payload calls the text `message`, not `content`.
  const chat = await jf('/api/chat');
  // Scoped to THIS fixture's fighter — the Extend scenario above logged its own
  // line to the same chat, and "one line per choice" is a per-choice claim.
  const lines = chat.filter(
    (e) => /to wear the extended guard/.test(e.message ?? '') && (e.message ?? '').includes(second.def.name)
  );
  const line = lines.pop();
  check('...and the log says so in one line for the whole choice', line != null,
    JSON.stringify(chat.slice(-3).map((c) => c.message)));
  check('...exactly one line, not one per move', lines.length === 0, `${lines.length + 1} lines`);
  check('...naming the move and the Stamina it gave back',
    /forfeits .* Stamina back/.test(line?.message ?? ''), line?.message ?? '(none)');
  console.log(`  Stamina before ${before}; log: ${line?.message ?? '(none)'}`);
}

console.log(failures ? `\n${failures} PROBE(S) FAILED` : '\nall probes passed');
gm.close();
process.exit(failures ? 1 : 0);

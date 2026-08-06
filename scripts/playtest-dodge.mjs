// Multi-browser playtest for the one human-in-the-loop step left in an
// otherwise automatic round: the GM's Dodge call (Combat Automation
// overhaul, decision #2).
//
// Everything else about a round is covered by unit tests and scripts/e2e.mjs,
// which drive sockets directly. This one has to be a browser test, because
// what it verifies is specifically a *UI reachability* claim that no socket
// test can make: the Dodge prompt must reach the GM **wherever they are in
// the app** — not just on the Arena page — because the paused pair's round
// cannot continue until they answer. It also verifies the other half of that
// claim: a Player must NOT be asked to make the GM's call.
//
// Run against a freshly-started server (it seats its own characters):
//   rm -f local.db && node server/index.js &   # then:
//   node scripts/playtest-dodge.mjs
//
// Exits non-zero on the first failed expectation, like scripts/e2e.mjs.

import { chromium } from 'playwright';
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
// Chromium ships in the image at a known path; PLAYWRIGHT_BROWSERS_PATH is
// not always exported into a bare shell, so resolve it explicitly.
const CHROME =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u, o) => fetch(BASE + u, o).then((r) => r.json().catch(() => null));
const jpost = (u, b, m = 'POST') =>
  jf(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// ---------- scenario setup, over sockets as the GM ----------
const s = io(BASE);
const wait = (ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (p) => {
      if (pred(p)) {
        clearTimeout(t);
        s.off(ev, h);
        res(p);
      }
    };
    s.on(ev, h);
  });

await new Promise((r) => s.on('connect', r));
s.emit('identity:set', { role: 'gm' });

s.emit('tell:create', { name: 'Shifts weight' });
const tell = await wait('tell:created');

// Attacker: 1 Startup, 2 Active — so its Active window is Tics 1-2 when
// placed at the round's first Tic.
s.emit('move:create', {
  name: 'Straight',
  isDefault: true,
  tellId: tell.id,
  startupTics: 1,
  activeTics: 2,
  recoveryTics: 1,
  description: 'A committed straight.',
  interactions: {},
  rollSlots: ['Skull'],
  attackTargets: ['Body'],
});
const straight = await wait('move:created', (m) => m.name === 'Straight');

// Defender: Defense Frames on squares 0,1,2 — placed at the same Tic, that
// covers the attack's whole Active window, which is exactly the
// full-coverage case that pauses for the GM.
s.emit('move:create', {
  name: 'Slip',
  isDefault: true,
  tellId: tell.id,
  startupTics: 1,
  activeTics: 1,
  recoveryTics: 1,
  description: 'Rolls off the line.',
  interactions: {},
  rollSlots: ['Body'],
  attackTargets: ['Body'],
  isDefensive: true,
  defenseKind: 'dodge',
  defenseFramePositions: [0, 1, 2],
});
const slip = await wait('move:created', (m) => m.name === 'Slip');

const striker = await jpost('/api/characters', { name: 'Striker', characterType: 'pc' });
const ghost = await jpost('/api/characters', { name: 'Ghost', characterType: 'pc' });

s.emit('combat:add_participant', { characterId: striker.id, side: 'left', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === striker.id));
s.emit('combat:add_participant', { characterId: ghost.id, side: 'right', pairIndex: 0 });
await wait('combat:updated', (c) => c.participants.some((p) => p.character_id === ghost.id));

s.emit('combat:next_round', {});
let st = await wait('combat:updated', (c) => c.pairs[0]?.phase === 'declaration');
console.log('scenario seated; declaration open');

// ---------- two browsers ----------
const browser = await chromium.launch({ executablePath: CHROME });

const openAs = async (pickRole, path) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const btn = page.getByRole('button', { name: pickRole }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(1200);
  }
  return { ctx, page, errors };
};

// The GM sits on the Characters page — deliberately NOT the Arena. That's
// the whole point: the prompt has to find them there.
const gm = await openAs(/GM/i, '/characters');
// The Player is logged in as the defending character, watching the Arena.
const player = await openAs(new RegExp('Ghost', 'i'), '/combat');

check('GM browser loaded without a page error', gm.errors.length === 0, gm.errors.join('; '));
check('Player browser loaded without a page error', player.errors.length === 0, player.errors.join('; '));
check('the GM is deliberately not on the Arena page', new URL(gm.page.url()).pathname !== '/combat');

// ---------- declare both moves and let the round run into the pause ----------
for (let i = 0; i < 2; i++) {
  const side = st.pairs[0].declaringSide;
  const who = side === 'left' ? striker : ghost;
  const moveId = who.id === striker.id ? straight.id : slip.id;
  s.emit('move:declare', { characterId: who.id, moveId });
  await wait('combat:updated', (c) => c.declaredMoves.some((dm) => dm.characterId === who.id));
  s.emit('combat:character_done_declaring', { characterId: who.id });
  st = await wait('combat:updated', () => true);
  await sleep(400);
}

// The round should now be genuinely paused, waiting on a human.
await sleep(1500);
const paused = await jf('/api/combat?role=gm');
const pair0 = paused.pairs.find((p) => p.pairIndex === 0);
check('the round paused on the Dodge instead of auto-deciding it', pair0?.pendingDodge != null, JSON.stringify(pair0));
check('the pause is recorded as paused_dodge', pair0?.resolutionStatus === 'paused_dodge', pair0?.resolutionStatus);

// ---------- the actual claim: the prompt found the GM off-Arena ----------
const gmDialog = gm.page.getByText(/did it land\?/i).first();
await gmDialog.waitFor({ timeout: 6000 }).catch(() => {});
check('the Dodge prompt reached the GM on a non-Arena page', await gmDialog.count() > 0);

const gmBody = await gm.page.locator('body').innerText();
check(
  'the prompt names both fighters and their moves',
  gmBody.includes('Ghost') && gmBody.includes('Striker') && gmBody.includes('Slip') && gmBody.includes('Straight'),
  gmBody.slice(0, 400)
);
check('the prompt offers exactly the two calls', await gm.page.getByRole('button', { name: /^Successful$/ }).count() === 1 && await gm.page.getByRole('button', { name: /^Failed$/ }).count() === 1);

// The Player must not be asked to make the GM's call.
const playerAsked = await player.page.getByText(/did it land\?/i).count();
check('the Player is NOT asked to make the GM\'s Dodge call', playerAsked === 0);
// ...but they should be able to see that their own fight is waiting.
const playerBody = await player.page.locator('body').innerText();
check(
  'the Player can see their own pair is paused waiting on the GM',
  /waiting on the gm/i.test(playerBody),
  playerBody.slice(0, 400)
);

await gm.page.screenshot({ path: '/tmp/playtest-dodge-gm.png' });
await player.page.screenshot({ path: '/tmp/playtest-dodge-player.png' });

// ---------- answer it, and confirm the round finishes ----------
await gm.page.getByRole('button', { name: /^Successful$/ }).first().click();
await sleep(2500);

const after = await jf('/api/combat?role=gm');
const pairAfter = after.pairs.find((p) => p.pairIndex === 0);
check('answering the prompt clears the pause', pairAfter?.pendingDodge == null);
check('the round ran to completion and opened the next one', pairAfter?.roundNumber === 2, JSON.stringify(pairAfter));

const chat = await jf('/api/chat');
const summary = chat.filter((e) => e.kind === 'round_summary');
check('the completed round posted its replay card', summary.length === 1, `got ${summary.length}`);

const replay = await jf(`/api/combat/round-replay/${summary[0]?.resolutionId}`);
const types = (replay?.events ?? []).map((e) => e.type);
check('the stored log records the pause and the GM\'s answer', types.includes('dodge_prompt') && types.includes('dodge_resolved'), JSON.stringify(types));
check(
  'the GM\'s call is recorded as what they actually clicked',
  replay.events.find((e) => e.type === 'dodge_resolved')?.payload.outcome === 'successful'
);

check('no page errors on either browser during the whole flow', gm.errors.length === 0 && player.errors.length === 0, [...gm.errors, ...player.errors].join('; '));

await browser.close();
s.close();

console.log(failures ? `\n${failures} CHECK${failures === 1 ? '' : 'S'} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

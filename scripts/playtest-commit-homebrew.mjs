// Playtest: Commit Homebrew end to end, on its own server (a fresh database, its
// own homebrew/ core and a fake GitHub):
//   - an empty table gets the committed core back, with Claude's automation;
//   - the GM commits: only published items, one commit, then "unchanged";
//     unpublishing removes the file; a player can't commit;
//   - without a token the tool says so; older items get their part uids once.
//
//   node scripts/playtest-commit-homebrew.mjs      (needs no other server)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { createClient } from '@libsql/client';
import { fakeGithub } from '../server/test/fakeGithub.js';
import { coreFilePath, coreFileText, partsOf } from '../client/src/lib/patd/homebrewSync.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3000 + 40 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;
const bail = (err) => {
  console.log(`FAIL: setup could not complete — ${err?.message ?? err}`);
  console.log('\n1 FAILURE(S)');
  server?.kill();
  process.exit(1);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-hb-'));
const dbUrl = `file:${path.join(dir, 'test.db')}`;
const hbDir = path.join(dir, 'homebrew');
fs.mkdirSync(path.join(hbDir, 'items'), { recursive: true });

// The committed core: one automated Form.
const core = {
  id: 'form.hb-core-ab12',
  kind: 'form',
  name: 'Core Form',
  descriptionText: '',
  published: true,
  aliases: [],
  actionDice: [{ kind: 'die', sides: 6, color: 'purple' }, { kind: 'die', sides: 6, color: 'green' }, { kind: 'die', sides: 6, color: 'green' }],
  skillId: null,
  customSkill: null,
  abilities: [{ uid: 'abil0001', name: 'Core Form', rulesText: 'At the start of your turn, gain 1 Power.', rules: [] }],
  actions: [{ uid: 'actn0001', name: 'Jab', cost: '1+', rulesText: 'Deal 1 damage.' }],
};
fs.writeFileSync(path.join(hbDir, 'items', `${core.id}.json`), coreFileText(core));
const automation = {
  version: 1,
  items: {
    [core.id]: {
      entries: Object.fromEntries(partsOf(core).map((p) => [p.uid, { part: p.part, name: p.name, fingerprint: p.fingerprint, basedOn: 'a'.repeat(40) }])),
    },
  },
};
automation.items[core.id].entries.abil0001.rules = [{ events: ['own_turn.start'], effect: { op: 'gain_tokens', token: 'power', amount: 1, target: { ref: 'self' } }, optional: false }];
fs.writeFileSync(path.join(hbDir, 'automation.json'), JSON.stringify(automation, null, 2));

const gh = fakeGithub({ files: { [coreFilePath(core.id)]: coreFileText(core) } });
const ghServer = await gh.listen(0);
const ghUrl = `http://127.0.0.1:${ghServer.address().port}`;

async function boot(extraEnv) {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), TURSO_DATABASE_URL: dbUrl, TURSO_AUTH_TOKEN: '', HOMEBREW_DIR: hbDir, GITHUB_API_URL: ghUrl, GITHUB_TOKEN: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 300 && !/ready on port/.test(out); i++) await sleep(100);
  if (!/ready on port/.test(out)) throw new Error(`server did not start:\n${out}`);
  return () => out;
}
async function stop() {
  const s = server;
  server = null;
  s.kill();
  await new Promise((r) => s.once('exit', r));
}
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  await sleep(300);
  return s;
};
const commit = (s) => new Promise((r) => s.timeout(20000).emit('homebrew:commit', {}, (err, res) => r(err ? { error: 'timeout' } : res)));
const saved = (s) => new Promise((r) => s.once('homebrew:saved', r));

console.log('\n--- an empty table gets the committed core back ---');
const log1 = await boot({ GITHUB_TOKEN: 'test-token' });
let hb = await jf('/api/homebrew');
check('the core item is restored into the empty table', hb.items.some((i) => i.id === core.id && i.published), JSON.stringify(hb.items.map((i) => i.id)));
const restored = hb.items.find((i) => i.id === core.id);
check('with its part uids', restored?.abilities[0].uid === 'abil0001' && restored?.actions[0].uid === 'actn0001');
check('the payload carries Claude’s automation and the core ids', Boolean(hb.automation?.items?.[core.id]?.entries?.abil0001?.rules) && hb.coreIds.includes(core.id));
check('the boot log says so', /restored 1 item/.test(log1()));

console.log('\n--- the GM commits ---');
const gm = await connect({ role: 'gm' });
const updates = [];
gm.on('homebrew:updated', (e) => updates.push(e));
let s = saved(gm);
gm.emit('homebrew:save', { item: { kind: 'style', name: 'Fresh Style', published: true, range: { minimum: 1, maximum: 2 }, abilities: [{ name: 'Fresh', rulesText: 'Gain 1 Speed.', rules: [] }], actions: [] } });
const freshId = (await s).id;
s = saved(gm);
gm.emit('homebrew:save', { item: { kind: 'form', name: 'Draft Form', published: false, abilities: [], actions: [] } });
const draftId = (await s).id;
hb = await jf('/api/homebrew');
check('a new Ability gets a uid on save', /^[a-z0-9]{8}$/.test(hb.items.find((i) => i.id === freshId)?.abilities[0]?.uid ?? ''));

const before = gh.head();
let res = await commit(gm);
check('the commit lands: 1 added (the core item is unchanged, the draft stays out)', res.ok && res.added === 1 && res.changed === 0 && res.removed === 0, JSON.stringify(res));
check('main moved to the new commit', gh.head() === res.sha && res.sha !== before);
const files = gh.files();
check('the published item is its own file', files.has(coreFilePath(freshId)) && !files.has(coreFilePath(draftId)));
check('the file is the item as saved', JSON.parse(files.get(coreFilePath(freshId))).name === 'Fresh Style');
await sleep(300);
check('everyone hears the new core ids', updates.some((u) => u.coreIds?.includes(freshId)));

res = await commit(gm);
check('committing again changes nothing', res.ok && res.unchanged === true, JSON.stringify(res));

const player = await connect({ role: 'player' });
res = await commit(player);
check('a player cannot commit', res.error === 'gm-only', JSON.stringify(res));

gm.emit('homebrew:publish', { id: freshId, published: false });
await sleep(400);
res = await commit(gm);
check('unpublished: its file is removed', res.ok && res.removed === 1 && !gh.files().has(coreFilePath(freshId)), JSON.stringify(res));
check('the core item is still there', gh.files().has(coreFilePath(core.id)));
gm.close();
player.close();
await stop();

console.log('\n--- no token; older items get uids once ---');
const db = createClient({ url: dbUrl });
await db.execute({
  sql: 'INSERT INTO homebrew (id, kind, data, published) VALUES (?, ?, ?, 1)',
  args: ['form.hb-legacy-zz99', 'form', JSON.stringify({ name: 'Legacy Form', descriptionText: '', aliases: [], actionDice: core.actionDice, skillId: null, abilities: [{ name: 'Old', rulesText: 'x', rules: [] }], actions: [{ name: 'Older', cost: '2+', rulesText: 'y' }] })],
});
await boot({});
const row = (await db.execute({ sql: 'SELECT data FROM homebrew WHERE id = ?', args: ['form.hb-legacy-zz99'] })).rows[0];
const legacy = JSON.parse(row.data);
check('the boot gave the older item’s parts uids, in the table', /^[a-z0-9]{8}$/.test(legacy.abilities[0].uid ?? '') && /^[a-z0-9]{8}$/.test(legacy.actions[0].uid ?? ''), row.data);
const gm2 = await connect({ role: 'gm' });
res = await commit(gm2);
check('without GITHUB_TOKEN the tool says so', res.error === 'no-token' && res.repo === 'AprilLiar/Custom-VTT', JSON.stringify(res));
gm2.close();
await stop();
db.close();
ghServer.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

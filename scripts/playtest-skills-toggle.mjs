// Playtest: the GM's Skills setting (decided) — only the GM changes it, it
// reaches everyone, and table settings report it.
//
//   (start the dev server first)
//   node scripts/playtest-skills-toggle.mjs
import { io } from 'socket.io-client';

const BASE = process.env.E2E_URL || 'http://localhost:3001';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = (u) => fetch(BASE + u).then((r) => r.json());
const connect = async (identity) => {
  const s = io(BASE);
  await new Promise((r) => s.on('connect', r));
  s.emit('identity:set', identity);
  await sleep(300);
  return s;
};
const gm = await connect({ role: 'gm' });
const p = await connect({ role: 'player', characterId: 1 });
let heard = null;
p.on('table_settings:updated', (s) => (heard = s));
check('Skills are on by default', (await jf('/api/table-settings')).skillsEnabled === true);
p.emit('table_settings:set', { skillsEnabled: false });
await sleep(300);
check('only the GM turns them off', (await jf('/api/table-settings')).skillsEnabled === true);
gm.emit('table_settings:set', { skillsEnabled: false });
await sleep(400);
check('the GM turns them off, and everyone hears it', (await jf('/api/table-settings')).skillsEnabled === false && heard?.skillsEnabled === false, JSON.stringify(heard));
gm.emit('table_settings:set', { skillsEnabled: true });
await sleep(300);
check('…and back on', (await jf('/api/table-settings')).skillsEnabled === true);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall probes passed');
process.exit(failures ? 1 : 0);

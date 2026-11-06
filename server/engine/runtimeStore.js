// **Persisting a fight's runtime (full automation, phase A).** The runtime
// (client/src/lib/patd/engine/runtime.js) lives in `fights.runtime`. Only the
// fight's engine chain changes it, and each save goes through the server-wide
// write queue.
import { one, run } from '../db.js';
import { parseRuntime } from '../../client/src/lib/patd/engine/runtime.js';
import { serialized } from '../combatState.js';

export async function loadRuntime(fightId) {
  const row = await one('SELECT runtime FROM fights WHERE id = ?', [fightId]);
  return parseRuntime(row?.runtime);
}

export const saveRuntime = (fightId, rt) => serialized(() => run('UPDATE fights SET runtime = ? WHERE id = ?', [JSON.stringify(rt), fightId]))();

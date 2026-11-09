// **The committed homebrew core (vttprojectplan.md, "Commit Homebrew").** What
// the repo holds under `homebrew/`: the items the GM last committed
// (`homebrew/items/<id>.json`) and Claude's automation map
// (`homebrew/automation.json`). Read from disk at boot — the deploy that a
// commit triggers brings the new files — and updated in memory right after a
// commit, so the wrenches don't wait for the redeploy.
//
// Live edits (the `homebrew` table) always win; the core is the record, and a
// backup: when the table is empty at boot, the core's items are restored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyAutomation, parseCoreFile } from '../client/src/lib/patd/homebrewSync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// HOMEBREW_DIR (env) points it elsewhere — the commit playtest's own core.
export const HOMEBREW_DIR = process.env.HOMEBREW_DIR || path.join(here, '..', 'homebrew');

let coreItems = new Map();
let automation = emptyAutomation();

function readAutomation(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'automation.json'), 'utf8'));
    return data && typeof data.items === 'object' && data.items ? { version: 1, ...data } : emptyAutomation();
  } catch {
    return emptyAutomation();
  }
}

function readItems(dir) {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, 'items')).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const item = parseCoreFile(fs.readFileSync(path.join(dir, 'items', name), 'utf8'), name.slice(0, -5));
    if (item) out.set(item.id, item);
  }
  return out;
}

export function loadCore(dir = HOMEBREW_DIR) {
  coreItems = readItems(dir);
  automation = readAutomation(dir);
  return { items: [...coreItems.values()], automation };
}

export const coreItemList = () => [...coreItems.values()];
export const coreIds = () => [...coreItems.keys()];
export const homebrewAutomation = () => automation;

// After a commit: the core is now exactly the published items.
export function setCoreItems(items) {
  coreItems = new Map(items.filter((i) => i.published).map((i) => [i.id, { ...i, published: true }]));
}
// For tests.
export function setAutomation(a) {
  automation = a ?? emptyAutomation();
}

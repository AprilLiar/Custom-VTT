#!/usr/bin/env node
// **"Automate homebrew content" — Claude's side of the pipeline**
// (vttprojectplan.md, "Commit Homebrew"). Reads the committed core
// (homebrew/items/<id>.json) and the automation map (homebrew/automation.json).
//
//   node scripts/homebrew-automation.mjs [status]
//       The to-do list: every committed item with its wrench, each Ability and
//       Action as new / stale / automated, and for a stale one the wording it
//       was automated for (from git, at its `basedOn` commit) against today's,
//       as a word diff. Leftovers from deleted items or parts are listed too.
//   node scripts/homebrew-automation.mjs stamp <itemId> [uid ... | --all]
//       After writing a part's automation (an Ability's `rules`, an Action's
//       `effect`…) into automation.json: record the wording it now matches and
//       the commit that wording came from. No uids: every part that has an
//       entry. --all: every part (an entry without rules/effect means "checked:
//       its own structured rules, or nothing, is right").
//   node scripts/homebrew-automation.mjs prune
//       Remove the automation of deleted items and parts.
//   node scripts/homebrew-automation.mjs import <snapshot.json>
//       Write a snapshot downloaded from the Commit Homebrew tool (no GitHub
//       token on the server) into homebrew/items/, as a commit would.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUTOMATION_PATH,
  CORE_ITEMS_DIR,
  automationReport,
  coreFilePath,
  coreFileText,
  emptyAutomation,
  parseCoreFile,
  partsOf,
} from '../client/src/lib/patd/homebrewSync.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = (p) => path.join(root, p);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function readCore() {
  const dir = abs(CORE_ITEMS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => parseCoreFile(fs.readFileSync(path.join(dir, n), 'utf8'), n.slice(0, -5)))
    .filter(Boolean);
}
function readAutomation() {
  try {
    return JSON.parse(fs.readFileSync(abs(AUTOMATION_PATH), 'utf8'));
  } catch {
    return emptyAutomation();
  }
}
// Sorted, so the file's diffs stay small.
function writeAutomation(auto) {
  const items = {};
  for (const id of Object.keys(auto.items ?? {}).sort()) {
    const it = auto.items[id];
    const entries = {};
    for (const uid of Object.keys(it.entries ?? {}).sort()) entries[uid] = it.entries[uid];
    items[id] = { ...it, entries };
  }
  fs.mkdirSync(path.dirname(abs(AUTOMATION_PATH)), { recursive: true });
  fs.writeFileSync(abs(AUTOMATION_PATH), `${JSON.stringify({ version: 1, ...auto, items }, null, 2)}\n`);
}

// The item as it was at a commit (null when git doesn't have it).
function itemAt(sha, id) {
  try {
    return parseCoreFile(git('show', `${sha}:${coreFilePath(id)}`), id);
  } catch {
    return null;
  }
}

// A word diff: [-gone-] {+new+}.
function wordDiff(a, b) {
  const x = String(a ?? '').split(/\s+/).filter(Boolean);
  const y = String(b ?? '').split(/\s+/).filter(Boolean);
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push(x[i++]);
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push(`{+${y[j++]}+}`);
    else out.push(`[-${x[i++]}-]`);
  }
  return out.join(' ').replace(/\+\} \{\+/g, ' ').replace(/-\] \[-/g, ' ');
}

const partText = (item, part) => {
  const list = part.part === 'ability' ? item?.abilities : item?.actions;
  const p = list?.find((x) => x.uid === part.uid);
  if (!p) return null;
  return part.part === 'ability' ? `${p.rulesText}${p.rules?.length ? `  [steps: ${JSON.stringify(p.rules)}]` : ''}` : `Cost: ${p.cost} — ${p.rulesText}`;
};

function status() {
  const items = readCore();
  const auto = readAutomation();
  const report = automationReport(items, auto);
  if (!items.length) console.log('No committed homebrew yet (homebrew/items/ is empty).');
  const byId = new Map(items.map((i) => [i.id, i]));
  let todo = 0;
  for (const r of report.items) {
    console.log(`\n${r.wrench === 'automated' ? '[blue]' : r.wrench === 'stale' ? '[grey]' : '[outline]'} ${r.kind} ${r.name} — ${r.id}`);
    for (const p of r.parts) {
      const label = `  ${p.state.padEnd(9)} ${p.part} ${p.index + 1} "${p.name}" (uid ${p.uid})`;
      console.log(label);
      if (p.state !== 'automated') todo++;
      if (p.state === 'new') console.log(`            ${partText(byId.get(r.id), p)}`);
      if (p.state === 'stale') {
        const entry = auto.items[r.id].entries[p.uid];
        const before = entry.basedOn ? partText(itemAt(entry.basedOn, r.id), p) : null;
        const now = partText(byId.get(r.id), p);
        console.log(before == null ? `            (no earlier wording at ${entry.basedOn ?? '—'}) now: ${now}` : `            diff vs ${entry.basedOn.slice(0, 8)}: ${wordDiff(before, now)}`);
      }
    }
  }
  for (const id of report.orphanItems) console.log(`\norphan item (deleted — prune it): ${id}`);
  for (const o of report.orphanEntries) console.log(`orphan part (deleted — prune it): ${o.itemId} ${o.uid}`);
  console.log(`\n${todo} part(s) to automate, ${report.orphanItems.length + report.orphanEntries.length} leftover(s) to prune.`);
}

function stamp(itemId, args) {
  const item = readCore().find((i) => i.id === itemId);
  if (!item) throw new Error(`${itemId} is not in ${CORE_ITEMS_DIR}`);
  const file = coreFilePath(itemId);
  if (git('status', '--porcelain', '--', file).trim()) throw new Error(`${file} has uncommitted changes — commit the item first, so the stamp names its commit`);
  const basedOn = git('log', '-1', '--format=%H', '--', file).trim();
  if (!basedOn) throw new Error(`${file} has no commit yet`);
  const auto = readAutomation();
  auto.items ??= {};
  const autoItem = (auto.items[itemId] ??= { entries: {} });
  autoItem.entries ??= {};
  const parts = partsOf(item);
  const all = args.includes('--all');
  const uids = args.filter((a) => a !== '--all');
  const targets = parts.filter((p) => (all ? true : uids.length ? uids.includes(p.uid) : Boolean(autoItem.entries[p.uid])));
  for (const u of uids) if (!parts.some((p) => p.uid === u)) throw new Error(`${itemId} has no part ${u}`);
  for (const p of targets) {
    const { part, name, fingerprint, basedOn: _was, ...automation } = autoItem.entries[p.uid] ?? {};
    autoItem.entries[p.uid] = { part: p.part, name: p.name, ...automation, fingerprint: p.fingerprint, basedOn };
  }
  autoItem.name = item.name;
  writeAutomation(auto);
  console.log(`Stamped ${targets.length} part(s) of ${item.name} against ${basedOn.slice(0, 8)}.`);
}

function prune() {
  const auto = readAutomation();
  const report = automationReport(readCore(), auto);
  for (const id of report.orphanItems) delete auto.items[id];
  for (const o of report.orphanEntries) delete auto.items[o.itemId].entries[o.uid];
  writeAutomation(auto);
  console.log(`Pruned ${report.orphanItems.length} item(s) and ${report.orphanEntries.length} part(s).`);
}

function importSnapshot(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const items = (Array.isArray(data?.items) ? data.items : []).map((i) => parseCoreFile(coreFileText({ ...i, published: true }))).filter(Boolean);
  const dir = abs(CORE_ITEMS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(items.map((i) => `${i.id}.json`));
  let removed = 0;
  for (const n of fs.readdirSync(dir)) if (n.endsWith('.json') && !keep.has(n)) (fs.unlinkSync(path.join(dir, n)), removed++);
  for (const i of items) fs.writeFileSync(abs(coreFilePath(i.id)), coreFileText(i));
  console.log(`Wrote ${items.length} item(s), removed ${removed}. Commit homebrew/items/ before automating.`);
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
try {
  if (cmd === 'status') status();
  else if (cmd === 'stamp') stamp(rest[0], rest.slice(1));
  else if (cmd === 'prune') prune();
  else if (cmd === 'import') importSnapshot(rest[0]);
  else throw new Error(`unknown command ${cmd}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

import { useState } from 'react';
import { socket } from '../socket.js';
import { useHomebrewState } from '../lib/patd/useContent.js';
import { wrenchState } from '../lib/patd/homebrewSync.js';
import HomebrewWrench from './HomebrewWrench.jsx';

// **GM Tools → Commit Homebrew (vttprojectplan.md, "Commit Homebrew").** Writes
// every published homebrew item into the game's core on GitHub (one file per
// item under homebrew/items/, one commit straight to main), where Claude reads
// it for "automate homebrew content". Drafts stay out. The push redeploys the
// app, so everyone reconnects a minute or two later.
//
// Without a GitHub token on the server it offers the same snapshot as a file
// (scripts/homebrew-automation.mjs import <file> commits it by hand).

export default function CommitHomebrewTool() {
  const hb = useHomebrewState();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!hb) return <p className="text-sm text-zinc-500">Loading…</p>;

  const core = new Set(hb.coreIds);
  const published = hb.items.filter((i) => i.published);
  const states = new Map(hb.items.map((i) => [i.id, wrenchState(i, { autoItem: hb.automation?.items?.[i.id] ?? null, inCore: core.has(i.id) })]));
  const fresh = published.filter((i) => !core.has(i.id));
  const leaving = hb.coreIds.filter((id) => !published.some((i) => i.id === id));
  const stale = published.filter((i) => states.get(i.id) === 'stale');
  const waiting = published.filter((i) => states.get(i.id) === 'waiting');

  const commit = () => {
    setBusy(true);
    setResult(null);
    socket.timeout(60000).emit('homebrew:commit', {}, (err, res) => {
      setBusy(false);
      setResult(err ? { error: 'timeout' } : res);
    });
  };
  const download = () => {
    const blob = new Blob([JSON.stringify({ kind: 'custom-vtt-homebrew-snapshot', items: published }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `homebrew-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="space-y-3 text-sm text-zinc-300">
      <p className="text-xs text-zinc-400">
        Snapshots every <strong>published</strong> homebrew item into the game&rsquo;s core on GitHub, so Claude can see it and automate it when you ask
        (&ldquo;automate homebrew content&rdquo;). Drafts stay out; items you unpublished or deleted leave the core. Your live edits stay as they are.
      </p>
      <ul className="space-y-1 text-xs">
        <li>
          <strong className="text-zinc-100">{published.length}</strong> published item{published.length === 1 ? '' : 's'} will be in the core.
        </li>
        {fresh.length > 0 && <li>New to the core: {fresh.map((i) => i.name).join(', ')}</li>}
        {leaving.length > 0 && <li className="text-amber-300">Leaving the core: {leaving.length} item{leaving.length === 1 ? '' : 's'} no longer published</li>}
        {stale.length > 0 && (
          <li className="flex flex-wrap items-center gap-1">
            <HomebrewWrench state="stale" size={12} /> Wording changed since Claude&rsquo;s pass: {stale.map((i) => i.name).join(', ')}
          </li>
        )}
        {waiting.length > 0 && (
          <li className="flex flex-wrap items-center gap-1">
            <HomebrewWrench state="waiting" size={12} /> Committed, waiting for Claude: {waiting.map((i) => i.name).join(', ')}
          </li>
        )}
      </ul>
      <p className="text-xs text-amber-300/90">Committing redeploys the app: everyone reconnects by themselves a minute or two later.</p>
      <button
        type="button"
        disabled={busy}
        onClick={commit}
        className="min-h-11 w-full panel-cut-sm bg-brand-600 px-4 font-semibold text-white hover:bg-brand-500 disabled:opacity-50"
      >
        {busy ? 'Committing…' : 'Commit Homebrew'}
      </button>
      {result && <CommitResult result={result} onDownload={download} />}
    </div>
  );
}

function CommitResult({ result, onDownload }) {
  if (result.ok && result.unchanged) return <p className="text-xs text-zinc-400">Nothing changed since the last commit — the core already matches.</p>;
  if (result.ok)
    return (
      <p className="text-xs text-emerald-300" role="status">
        Committed: {result.added} added, {result.changed} changed, {result.removed} removed.{' '}
        {result.url && (
          <a href={result.url} target="_blank" rel="noreferrer" className="underline">
            View on GitHub
          </a>
        )}
        . The app redeploys now.
      </p>
    );
  if (result.error === 'no-token')
    return (
      <div className="space-y-2 text-xs text-amber-300" role="alert">
        <p>
          GitHub isn&rsquo;t connected: the server needs a <code>GITHUB_TOKEN</code> (a fine-grained token with Contents read/write on {result.repo}) in
          Render&rsquo;s Environment. Meanwhile, download the snapshot and hand it to Claude.
        </p>
        <button type="button" onClick={onDownload} className="min-h-9 panel-cut-sm border border-zinc-700 px-3 text-zinc-200 hover:border-zinc-500">
          Download snapshot
        </button>
      </div>
    );
  if (result.error === 'busy') return <p className="text-xs text-amber-300">A commit is already running.</p>;
  return (
    <p className="text-xs text-red-400" role="alert">
      The commit failed{result.message ? `: ${result.message}` : '.'} Nothing was changed.
    </p>
  );
}

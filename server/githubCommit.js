// **Commit Homebrew → GitHub (vttprojectplan.md, "Commit Homebrew").** Writes
// every published homebrew item to `homebrew/items/<id>.json` on the repo's
// `main` in ONE commit, with the Git Data API: no clone, no working copy. Files
// of items no longer published (or deleted) are removed in the same commit; an
// unchanged item is an unchanged file, so a commit with nothing new is skipped.
//
// Config (Render env): GITHUB_TOKEN — a fine-grained token with Contents
// read/write on the repo; GITHUB_REPO (default AprilLiar/Custom-VTT);
// GITHUB_BRANCH (default main). A push to main redeploys the app.
// GITHUB_API_URL points it at another API (the playtest's fake GitHub).
import crypto from 'node:crypto';
import { CORE_ITEMS_DIR, planCommit } from '../client/src/lib/patd/homebrewSync.js';

export function githubConfig(env = process.env) {
  return {
    token: env.GITHUB_TOKEN || null,
    repo: env.GITHUB_REPO || 'AprilLiar/Custom-VTT',
    branch: env.GITHUB_BRANCH || 'main',
    api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
  };
}

// Git's own id for a file's bytes, so unchanged files are seen without fetching them.
export function gitBlobSha(text) {
  const buf = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function githubApi({ token, repo, api, fetchImpl }) {
  return async (method, path, body) => {
    const res = await fetchImpl(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'custom-vtt-homebrew',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path}: ${res.status} ${data?.message ?? ''}`.trim());
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

// The blobs directly under `dir` of a tree: Map path → blob sha (empty when the folder is missing).
async function dirBlobs(api, treeSha, dir) {
  let sha = treeSha;
  for (const part of dir.split('/')) {
    const tree = await api('GET', `/git/trees/${sha}`);
    const entry = tree?.tree?.find((t) => t.path === part && t.type === 'tree');
    if (!entry) return new Map();
    sha = entry.sha;
  }
  const tree = await api('GET', `/git/trees/${sha}`);
  return new Map((tree?.tree ?? []).filter((t) => t.type === 'blob').map((t) => [`${dir}/${t.path}`, t.sha]));
}

export function commitMessage(plan) {
  const head = `Commit Homebrew: ${plan.add.length} added, ${plan.change.length} changed, ${plan.remove.length} removed`;
  const lines = [
    ...plan.add.map((f) => `Added: ${f.name} (${f.path})`),
    ...plan.change.map((f) => `Changed: ${f.name} (${f.path})`),
    ...plan.remove.map((p) => `Removed: ${p}`),
  ];
  return `${head}\n\nSnapshot of the GM's published homebrew, written by the app's Commit Homebrew tool.\n\n${lines.join('\n')}\n`;
}

// → { sha, url, added, changed, removed, files } or { unchanged: true, sha, files }.
// Retries when `main` moves between reading it and updating it.
export async function commitHomebrew(items, { token, repo, branch, api: apiBase = 'https://api.github.com', fetchImpl = globalThis.fetch, attempts = 3 }) {
  const api = githubApi({ token, repo, api: apiBase, fetchImpl });
  for (let attempt = 1; ; attempt++) {
    const head = (await api('GET', `/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    const commit = await api('GET', `/git/commits/${head}`);
    const existing = await dirBlobs(api, commit.tree.sha, CORE_ITEMS_DIR);
    const plan = planCommit(items, existing, (path, text) => existing.get(path) === gitBlobSha(text));
    const counts = { added: plan.add.length, changed: plan.change.length, removed: plan.remove.length, files: plan.files.length };
    if (!counts.added && !counts.changed && !counts.removed) return { unchanged: true, sha: head, files: counts.files };
    const tree = await api('POST', '/git/trees', {
      base_tree: commit.tree.sha,
      tree: [
        ...[...plan.add, ...plan.change].map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })),
        ...plan.remove.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
      ],
    });
    const made = await api('POST', '/git/commits', { message: commitMessage(plan), tree: tree.sha, parents: [head] });
    try {
      await api('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: made.sha, force: false });
    } catch (err) {
      if (err.status === 422 && attempt < attempts) continue;
      throw err;
    }
    return { sha: made.sha, url: `https://github.com/${repo}/commit/${made.sha}`, ...counts };
  }
}

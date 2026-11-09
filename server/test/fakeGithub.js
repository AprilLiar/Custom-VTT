// A tiny in-memory GitHub for the Commit Homebrew tests: just the Git Data API
// calls server/githubCommit.js makes (refs, commits, trees, blobs by content).
// `handle()` answers one request; `asFetch()` wraps it as `fetch`, `listen()`
// serves it over HTTP (scripts/playtest-commit-homebrew.mjs).
import crypto from 'node:crypto';
import http from 'node:http';
import { gitBlobSha } from '../githubCommit.js';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

export function fakeGithub({ repo = 'AprilLiar/Custom-VTT', branch = 'main', token = 'test-token', files = {} } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const refs = new Map();
  const log = [];
  let raceOnce = false;

  // Flat Map path → blob sha  ⇄  nested trees.
  const putTree = (entries) => {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    const sha = sha1(JSON.stringify(sorted));
    trees.set(sha, sorted);
    return sha;
  };
  const buildTree = (flat) => {
    const here = [];
    const dirs = new Map();
    for (const [p, sha] of flat) {
      const i = p.indexOf('/');
      if (i < 0) here.push({ path: p, mode: '100644', type: 'blob', sha });
      else {
        const d = p.slice(0, i);
        if (!dirs.has(d)) dirs.set(d, new Map());
        dirs.get(d).set(p.slice(i + 1), sha);
      }
    }
    for (const [d, sub] of dirs) here.push({ path: d, mode: '040000', type: 'tree', sha: buildTree(sub) });
    return putTree(here);
  };
  const flatten = (treeSha, prefix = '', out = new Map()) => {
    for (const e of trees.get(treeSha) ?? []) {
      if (e.type === 'tree') flatten(e.sha, `${prefix}${e.path}/`, out);
      else out.set(`${prefix}${e.path}`, e.sha);
    }
    return out;
  };
  const putBlob = (text) => {
    const sha = gitBlobSha(text);
    blobs.set(sha, text);
    return sha;
  };
  const putCommit = (tree, parents, message) => {
    const sha = sha1(JSON.stringify({ tree, parents, message, n: commits.size }));
    commits.set(sha, { tree, parents, message });
    return sha;
  };

  const initial = new Map(Object.entries({ 'README.md': 'hello\n', ...files }).map(([p, t]) => [p, putBlob(t)]));
  refs.set(branch, putCommit(buildTree(initial), [], 'initial'));

  function handle(method, url, body, headers = {}) {
    log.push({ method, url, body });
    if (headers.authorization !== `Bearer ${token}`) return { status: 401, json: { message: 'Bad credentials' } };
    const base = `/repos/${repo}`;
    if (!url.startsWith(base)) return { status: 404, json: { message: 'Not Found' } };
    const p = url.slice(base.length);
    let m;
    if (method === 'GET' && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = refs.get(decodeURIComponent(m[1]));
      return sha ? { status: 200, json: { object: { sha, type: 'commit' } } } : { status: 404, json: { message: 'Not Found' } };
    }
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/([0-9a-f]+)$/))) {
      const c = commits.get(m[1]);
      return c ? { status: 200, json: { sha: m[1], tree: { sha: c.tree }, message: c.message, parents: c.parents.map((sha) => ({ sha })) } } : { status: 404, json: {} };
    }
    if (method === 'GET' && (m = p.match(/^\/git\/trees\/([0-9a-f]+)$/))) {
      const t = trees.get(m[1]);
      return t ? { status: 200, json: { sha: m[1], tree: t, truncated: false } } : { status: 404, json: {} };
    }
    if (method === 'POST' && p === '/git/trees') {
      const flat = body.base_tree ? flatten(body.base_tree) : new Map();
      for (const e of body.tree) {
        if (e.sha === null) flat.delete(e.path);
        else if (typeof e.content === 'string') flat.set(e.path, putBlob(e.content));
        else flat.set(e.path, e.sha);
      }
      return { status: 201, json: { sha: buildTree(flat) } };
    }
    if (method === 'POST' && p === '/git/commits') return { status: 201, json: { sha: putCommit(body.tree, body.parents, body.message) } };
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const b = decodeURIComponent(m[1]);
      if (raceOnce) {
        // Someone else pushed meanwhile.
        raceOnce = false;
        const head = refs.get(b);
        const flat = flatten(commits.get(head).tree);
        flat.set('OTHER.md', putBlob('someone else\n'));
        refs.set(b, putCommit(buildTree(flat), [head], 'other push'));
      }
      const c = commits.get(body.sha);
      if (!c || (!body.force && !c.parents.includes(refs.get(b)))) return { status: 422, json: { message: 'Update is not a fast forward' } };
      refs.set(b, body.sha);
      return { status: 200, json: { object: { sha: body.sha } } };
    }
    return { status: 404, json: { message: `no fake for ${method} ${p}` } };
  }

  const lower = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    handle,
    log,
    raceNextPatch: () => (raceOnce = true),
    head: () => refs.get(branch),
    commit: (sha = refs.get(branch)) => commits.get(sha),
    // The files at a commit: Map path → text.
    files: (sha = refs.get(branch)) => new Map([...flatten(commits.get(sha).tree)].map(([p, b]) => [p, blobs.get(b)])),
    asFetch: () => async (url, init = {}) => {
      const u = new URL(url);
      const r = handle(init.method ?? 'GET', u.pathname, init.body ? JSON.parse(init.body) : null, lower(init.headers));
      return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.json) };
    },
    listen: (port = 0) =>
      new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          let data = '';
          req.on('data', (c) => (data += c));
          req.on('end', () => {
            const r = handle(req.method, new URL(req.url, 'http://x').pathname, data ? JSON.parse(data) : null, lower(req.headers));
            res.writeHead(r.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r.json));
          });
        });
        server.listen(port, () => resolve(server));
      }),
  };
}

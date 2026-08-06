import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { getRules } from '../lib/api.js';

// The rule book, read from game_rules.md at the repo root (see /api/rules
// server-side). Rendered as sections rather than one long scroll, because
// "what does a too-late Block do again?" is a lookup, not a read-through —
// and with its own search, since the browser's Ctrl-F can't see a section
// that isn't currently open.
//
// The Markdown rendering here is deliberately small and local rather than a
// library: the rule book's own vocabulary is headings, paragraphs, lists,
// bold/italic/code, and blockquotes, and adding a full CommonMark dependency
// to render that would be more surface than the feature is worth. If the
// rules ever need tables or images, swap this for a real parser rather than
// growing it.

// Splits the document on `##` headings — the section boundaries the file's
// own header comment asks authors to preserve. Anything before the first one
// (the title and the editing note) is dropped: it's for whoever edits the
// file, not for a player looking something up.
function parseSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h2 = /^##\s+(?!#)(.*)$/.exec(line);
    if (h2) {
      current = { title: h2[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections.map((s) => ({ ...s, body: s.lines.join('\n').trim() }));
}

// Bold / italic / inline code, applied to a plain string. Returns an array of
// React nodes. Order matters: code first, so `**` inside a code span stays
// literal.
function inline(text, keyPrefix) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.9em] text-brand-200">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      out.push(
        <strong key={key} className="font-semibold text-zinc-100">
          {token.slice(2, -2)}
        </strong>
      );
    } else {
      out.push(
        <em key={key} className="italic text-zinc-300">
          {token.slice(1, -1)}
        </em>
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ body }) {
  const blocks = [];
  const lines = body.split('\n');
  // `list` holds both kinds; `ordered` says which tag to close it with, since
  // the rules use numbered steps wherever order is the point ("a round has
  // exactly two phases", the per-Tic resolution order).
  let list = null;
  let ordered = false;
  let quote = null;
  let para = null;

  const flush = () => {
    if (para) {
      blocks.push(
        <p key={`p-${blocks.length}`} className="text-sm leading-relaxed text-zinc-400">
          {inline(para.join(' '), `p-${blocks.length}`)}
        </p>
      );
      para = null;
    }
    if (list) {
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag
          key={`list-${blocks.length}`}
          className={`ml-5 space-y-1 text-sm text-zinc-400 ${ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {list.map((item, i) => (
            <li key={i}>{inline(item, `li-${blocks.length}-${i}`)}</li>
          ))}
        </Tag>
      );
      list = null;
    }
    if (quote) {
      blocks.push(
        <blockquote
          key={`bq-${blocks.length}`}
          className="border-l-2 border-brand-700 pl-3 text-sm italic text-zinc-500"
        >
          {inline(quote.join(' '), `bq-${blocks.length}`)}
        </blockquote>
      );
      quote = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) {
      flush();
      blocks.push(
        <h3
          key={`h3-${blocks.length}`}
          className="font-display pt-1 text-sm font-bold uppercase tracking-wide text-brand-300"
        >
          {h3[1]}
        </h3>
      );
      continue;
    }
    const li = /^\s*(?:([-*])|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const isOrdered = !li[1];
      // Switching kinds mid-run closes the open list rather than mixing them.
      if (quote || para || (list && ordered !== isOrdered)) flush();
      ordered = isOrdered;
      (list ??= []).push(li[2]);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      if (list || para) flush();
      (quote ??= []).push(bq[1]);
      continue;
    }
    // Markdown soft-wraps: any of the three block kinds runs until a blank
    // line, so an unprefixed line continues whichever one is open.
    if (list) {
      list[list.length - 1] += ' ' + line.trim();
      continue;
    }
    if (quote) {
      quote.push(line.trim());
      continue;
    }
    (para ??= []).push(line.trim());
  }
  flush();
  return <div className="space-y-2">{blocks}</div>;
}

// Highlights every match of `query` in a plain string. Used for the search
// results list, where seeing *why* a section matched is the whole point.
function Highlighted({ text, query }) {
  if (!query) return text;
  const parts = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let at = 0;
  let found = lower.indexOf(needle, at);
  let i = 0;
  while (found !== -1) {
    if (found > at) parts.push(text.slice(at, found));
    parts.push(
      <mark key={i++} className="rounded bg-brand-600/40 px-0.5 text-brand-100">
        {text.slice(found, found + needle.length)}
      </mark>
    );
    at = found + needle.length;
    found = lower.indexOf(needle, at);
  }
  parts.push(text.slice(at));
  return parts;
}

// One line of context around each hit, so a result is scannable without
// opening the section. Snippets are plain text, not rendered Markdown — the
// highlighter works on a string, and a half-line of context would in any case
// slice through emphasis markers and leave them orphaned.
function plainText(line) {
  return line
    .replace(/^\s*(?:[-*]\s+|>\s?|\d+\.\s+|#{1,6}\s+)/, '') // block prefix
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function snippetsFor(body, query, limit = 3) {
  const out = [];
  const needle = query.toLowerCase();
  for (const line of body.split('\n')) {
    const text = plainText(line);
    if (!text || !text.toLowerCase().includes(needle)) continue;
    out.push(text.length > 180 ? text.slice(0, 177) + '…' : text);
    if (out.length >= limit) break;
  }
  return out;
}

export default function RulesPage() {
  const [markdown, setMarkdown] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [openTitle, setOpenTitle] = useState(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    getRules()
      .then((d) => setMarkdown(d?.markdown ?? ''))
      .catch(() => setError("Couldn't load the rules."));
  }, []);

  const sections = useMemo(() => (markdown ? parseSections(markdown) : []), [markdown]);

  // Default to the first section once loaded, rather than an empty pane.
  useEffect(() => {
    if (openTitle == null && sections.length) setOpenTitle(sections[0].title);
  }, [sections, openTitle]);

  const q = query.trim();
  const results = useMemo(() => {
    if (!q) return null;
    const needle = q.toLowerCase();
    return sections
      .map((s) => ({
        ...s,
        inTitle: s.title.toLowerCase().includes(needle),
        snippets: snippetsFor(s.body, q),
      }))
      .filter((s) => s.inTitle || s.snippets.length);
  }, [sections, q]);

  const open = sections.find((s) => s.title === openTitle) ?? null;

  const show = (title) => {
    setOpenTitle(title);
    setQuery('');
    bodyRef.current?.scrollTo?.({ top: 0 });
  };

  if (error) return <p className="text-sm text-zinc-500">{error}</p>;
  if (markdown == null) return <p className="text-sm text-zinc-600">Loading the rules…</p>;

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wide">Rules</h1>
        <div className="relative min-w-56 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the rules…"
            className="w-full panel-cut-sm border border-zinc-700 bg-zinc-900 py-2 pl-7 pr-8 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-zinc-500 hover:text-zinc-200"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {results ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          <p className="text-xs text-zinc-600">
            {results.length === 0
              ? `Nothing in the rules mentions "${q}".`
              : results.length === 1
                ? `1 section mentions "${q}".`
                : `${results.length} sections mention "${q}".`}
          </p>
          {results.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => show(s.title)}
              className="block w-full panel-cut border border-zinc-800 bg-zinc-900/60 p-3 text-left hover:border-brand-600"
            >
              <div className="font-display text-sm font-bold uppercase tracking-wide text-zinc-100">
                <Highlighted text={s.title} query={q} />
              </div>
              <ul className="mt-1 space-y-1">
                {s.snippets.map((sn, i) => (
                  <li key={i} className="text-xs leading-relaxed text-zinc-500">
                    <Highlighted text={sn} query={q} />
                  </li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          {/* Section list: a horizontal chip row on mobile, a sidebar on
              desktop — the same shape the Compendium's own nav already uses. */}
          <nav className="flex shrink-0 gap-1.5 overflow-x-auto pb-1 md:w-56 md:flex-col md:overflow-y-auto md:pb-0">
            {sections.map((s) => (
              <button
                key={s.title}
                type="button"
                onClick={() => show(s.title)}
                className={`shrink-0 panel-cut-sm px-3 py-2 text-left font-display text-xs font-semibold uppercase tracking-wide md:shrink ${
                  s.title === openTitle
                    ? 'bg-brand-600/30 text-brand-200'
                    : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                }`}
              >
                {s.title}
              </button>
            ))}
          </nav>
          <article
            ref={bodyRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto panel-cut border border-zinc-800 bg-zinc-900/40 p-4"
          >
            {open && (
              <>
                <h2 className="font-display text-lg font-bold uppercase tracking-wide text-zinc-100">
                  {open.title}
                </h2>
                <Markdown body={open.body} />
              </>
            )}
          </article>
        </div>
      )}
    </div>
  );
}

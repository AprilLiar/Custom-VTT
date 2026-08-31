import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getPerks, getPerkTags } from '../lib/api.js';
import { useRoster } from '../lib/useRoster.js';
import { portraitSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';
import PerkCard from './PerkCard.jsx';
import PerkCreator from './PerkCreator.jsx';

function GrantList({ perk, characters }) {
  return (
    <div className="mt-1 space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-2">
      {characters.map((c) => {
        const granted = perk.granted_character_ids.includes(c.id);
        return (
          <label key={c.id} className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 md:min-h-0">
            <input
              type="checkbox"
              checked={granted}
              onChange={() =>
                socket.emit(granted ? 'perk:revoke' : 'perk:grant', {
                  characterId: c.id,
                  perkId: perk.id,
                })
              }
            />
            {c.name}
            {c.character_type === 'npc' && (
              <span className="panel-cut-sm bg-purple-600/30 px-1 text-xs uppercase text-purple-300">npc</span>
            )}
          </label>
        );
      })}
      {characters.length === 0 && <p className="text-xs text-zinc-600">No characters yet.</p>}
    </div>
  );
}

// The Perk Tag vocabulary manager — GM-only, and deliberately a separate list
// from the Move tags managed on the Moves tab (see perk_tags in db.js).
// Structurally a twin of Compendium.jsx's TagManager; kept as its own
// component rather than parameterised because the two only look alike, and a
// shared one would have to be told which of two event families, two
// endpoints, and two delete warnings to use for no real saving.
function PerkTagManager({ tags }) {
  const [editing, setEditing] = useState(null); // null | 'new' | tag
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const startEdit = (tag) => {
    setEditing(tag);
    setName(tag === 'new' ? '' : tag.name);
    setDescription(tag === 'new' ? '' : tag.description ?? '');
  };

  const save = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (editing === 'new') {
      socket.emit('perk_tag:create', { name: name.trim(), description: description.trim() });
    } else {
      socket.emit('perk_tag:update', {
        tagId: editing.id,
        name: name.trim(),
        description: description.trim(),
      });
    }
    setEditing(null);
  };

  return (
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">
        Perk Tags (world-level, categorisation only)
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((tag) => (
          <span
            key={tag.id}
            title={tag.description || undefined}
            className="inline-flex items-center gap-1.5 rounded-full bg-sky-900/40 px-2.5 py-0.5 text-sm font-semibold text-sky-300"
          >
            {tag.name}
            <button onClick={() => startEdit(tag)} className="text-sky-700 hover:text-sky-200" title="Edit">
              ✎
            </button>
            <button
              onClick={() =>
                window.confirm(`Delete Perk tag "${tag.name}"? It is removed from every Perk.`) &&
                socket.emit('perk_tag:delete', { tagId: tag.id })
              }
              className="text-sky-700 hover:text-red-400"
              title="Delete"
            >
              ✕
            </button>
          </span>
        ))}
        {!editing && (
          <button
            onClick={() => startEdit('new')}
            className="rounded-full border border-dashed border-zinc-600 px-3 py-1 text-sm text-zinc-400 hover:border-brand-500 hover:text-brand-300"
          >
            + New Perk Tag
          </button>
        )}
      </div>
      {editing && (
        <form onSubmit={save} className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tag name"
            className="w-28 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (shown as a tooltip)"
            className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="panel-cut-sm border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

// The Compendium page's Perks tab: persistent Perk library. Just picture/
// name/description per spec — no folders or style filter, unlike Moves.
// The page is open to every role (see CompendiumPage.jsx) — creation,
// editing, deleting, and granting to *other* characters are gated to
// role === 'gm' below. A Player browses the same cards and can take a Perk
// for themselves, the same way the Moves tab lets them learn a Move.
export default function PerksCompendium() {
  const { role, characterId } = useRole();
  const [perks, setPerks] = useState(null);
  const [tags, setTags] = useState([]);
  // Multi-select, OR logic — the same filter semantics the Moves compendium's
  // Style filter already uses, so the two tabs behave the same way.
  const [tagFilter, setTagFilter] = useState(new Set());
  const [form, setForm] = useState(null); // null | { perk? }
  const [grantOpen, setGrantOpen] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // The roster comes from useRoster, which patches a `character:updated` in
  // place instead of refetching — this list used to reload every Perk, every
  // Tag and every character on each one, and Stamina fires that constantly.
  const characters = useRoster() ?? [];

  useEffect(() => {
    const refetchPerks = () => getPerks().then(setPerks).catch(console.error);
    const refetchTags = () => getPerkTags().then(setTags).catch(console.error);
    refetchPerks();
    refetchTags();
    const perkEvents = ['perk:created', 'perk:updated', 'perk:deleted', 'perk:granted', 'perk:revoked'];
    const tagEvents = ['perk_tag:created', 'perk_tag:updated', 'perk_tag:deleted'];
    for (const ev of perkEvents) socket.on(ev, refetchPerks);
    for (const ev of tagEvents) socket.on(ev, refetchTags);
    return () => {
      for (const ev of perkEvents) socket.off(ev, refetchPerks);
      for (const ev of tagEvents) socket.off(ev, refetchTags);
    };
  }, []);

  if (!perks) return <p className="text-zinc-500">Loading…</p>;

  // Who "me" is, for the Player-facing Take button. The roster endpoint is not
  // role-gated (only the Characters *page* is hidden from Players), so this
  // needs no new fetch — exactly as Compendium.jsx derives it for Moves.
  const myCharacter = role === 'player' ? characters.find((c) => c.id === characterId) ?? null : null;

  const tagById = new Map(tags.map((t) => [t.id, t]));
  const toggleFilter = (id) =>
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // OR across selected tags: a Perk shows if it carries ANY of them. No
  // selection means no filtering at all, rather than "match nothing".
  const visiblePerks =
    tagFilter.size === 0
      ? perks
      : perks.filter((p) => (p.tag_ids ?? []).some((id) => tagFilter.has(id)));

  const submitPerk = (payload) => {
    if (form?.perk) socket.emit('perk:update', { perkId: form.perk.id, ...payload });
    else socket.emit('perk:create', payload);
    setForm(null);
  };

  const deletePerk = (perk) => {
    if (perk.granted_character_ids.length > 0) {
      window.alert('Revoke this Perk from everyone before deleting it.');
      return;
    }
    if (window.confirm(`Delete ${perk.name}?`)) socket.emit('perk:delete', { perkId: perk.id });
  };

  const onDropOnCharacter = (e, character) => {
    e.preventDefault();
    setDropTarget(null);
    const perkId = Number(e.dataTransfer.getData('text/perk-id'));
    if (perkId) socket.emit('perk:grant', { characterId: character.id, perkId });
  };

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        {role === 'gm' &&
          (form ? (
            <PerkCreator
              initial={form.perk ?? null}
              tags={tags}
              onSubmit={submitPerk}
              onCancel={() => setForm(null)}
            />
          ) : (
            <button
              onClick={() => setForm({})}
              className="panel-cut-sm bg-brand-600 px-4 py-2 font-semibold hover:bg-brand-500"
            >
              + New Perk
            </button>
          ))}

        {role === 'gm' && <PerkTagManager tags={tags} />}

        {/* Filter bar — open to every role, since browsing is (a Player gets
            the same read-only library). Hidden entirely when no tags exist,
            rather than showing an empty row of nothing to filter by. */}
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Filter</span>
            {tags.map((tag) => {
              const on = tagFilter.has(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleFilter(tag.id)}
                  title={tag.description || undefined}
                  className={`panel-cut-sm border px-2 py-1 text-xs font-semibold ${
                    on
                      ? 'border-sky-500 bg-sky-600/25 text-sky-200'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  {tag.name}
                </button>
              );
            })}
            {tagFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setTagFilter(new Set())}
                className="panel-cut-sm px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {perks.length === 0 ? (
          <p className="text-sm text-zinc-600">No Perks yet — create the first one.</p>
        ) : visiblePerks.length === 0 ? (
          <p className="text-sm text-zinc-600">No Perks carry the selected tag(s).</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visiblePerks.map((perk) => (
              <div
                key={perk.id}
                draggable={role === 'gm'}
                onDragStart={role === 'gm' ? (e) => e.dataTransfer.setData('text/perk-id', String(perk.id)) : undefined}
                title={role === 'gm' ? 'Drag onto a character to grant it' : undefined}
                className={role === 'gm' ? 'cursor-grab active:cursor-grabbing' : undefined}
              >
                <PerkCard
                  perk={perk}
                  tags={(perk.tag_ids ?? []).map((id) => tagById.get(id)).filter(Boolean)}
                  actions={
                    // **A Player can take a Perk for themselves (decided, new).**
                    // The mirror of the Moves tab's Learn/Forget: the Perk
                    // library has been readable to Players since the page was
                    // opened to them, and "ask the GM to tick a box for you" was
                    // the only way to act on what you read.
                    //
                    // No learnability gate, because a Perk has none — a Move's
                    // Learn button can be closed by style, and `perk:grant`
                    // has no equivalent rule to enforce. Automated Perks are
                    // offered like any other: the trust-based no-auth model is
                    // the whole app's design, and the GM sees every grant.
                    role === 'player' && myCharacter ? (
                      (() => {
                        const has = perk.granted_character_ids.includes(myCharacter.id);
                        return (
                          <button
                            title={
                              has ? `Drop ${perk.name} from your sheet` : `Add ${perk.name} to your sheet`
                            }
                            onClick={() =>
                              socket.emit(has ? 'perk:revoke' : 'perk:grant', {
                                characterId: myCharacter.id,
                                perkId: perk.id,
                              })
                            }
                            className={`flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs md:min-h-0 ${
                              has
                                ? 'text-zinc-500 hover:bg-red-900/40 hover:text-red-400'
                                : 'text-brand-400 hover:bg-brand-900/40'
                            }`}
                          >
                            {has ? 'Drop' : 'Take'}
                          </button>
                        );
                      })()
                    ) : role === 'gm' ? (
                      <>
                        <button
                          onClick={() => setGrantOpen(grantOpen === perk.id ? null : perk.id)}
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-brand-400 hover:bg-brand-900/40 md:min-h-0"
                        >
                          Grant… ({perk.granted_character_ids.length})
                        </button>
                        <button
                          onClick={() => setForm({ perk })}
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 md:min-h-0"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deletePerk(perk)}
                          className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400 md:min-h-0"
                        >
                          Delete
                        </button>
                      </>
                    ) : null
                  }
                />
                {role === 'gm' && grantOpen === perk.id && <GrantList perk={perk} characters={characters} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {role === 'gm' && (
        // Sticky to the scrollport, exactly as the Moves tab's rails are: this
        // is a drop target beside a long grid, and a drag you have to hold
        // while the page scrolls under it is the worst version of it.
        // `self-start` is load-bearing — a stretched flex item is already as
        // tall as its row and has nowhere to stick to. See Compendium.jsx.
        <aside className="hidden w-44 shrink-0 self-start md:sticky md:top-0 md:block md:max-h-[85dvh] md:overflow-y-auto md:pl-1">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
            Drag a Perk here
          </h2>
          <div className="space-y-2">
            {characters.map((c) => {
              const src = portraitSrc(c);
              return (
                <div
                  key={c.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropTarget(c.id);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => onDropOnCharacter(e, c)}
                  className={`flex items-center gap-2 panel-cut border p-2 transition ${
                    dropTarget === c.id
                      ? 'border-brand-500 bg-brand-950/50'
                      : 'border-zinc-800 bg-zinc-900'
                  }`}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden panel-cut-sm bg-zinc-800 text-sm font-bold text-zinc-600">
                    {src ? (
                      <CroppedImage src={src} crop={cropOf(c)} loading="lazy" className="h-full w-full" />
                    ) : (
                      c.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <span className="truncate text-sm text-zinc-300">{c.name}</span>
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
}

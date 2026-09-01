import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getQuirks } from '../lib/api.js';
import { useRoster } from '../lib/useRoster.js';
import { Dices } from 'lucide-react';
import { quirkStyle, splitQuirks } from '../lib/quirkStyles.js';
import QuirkCard from './QuirkCard.jsx';
import QuirkColumns from './QuirkColumns.jsx';
import QuirkEditor from './QuirkEditor.jsx';
import QuirkRollDialog from './QuirkRollDialog.jsx';

// The Compendium's third tab: **the GM's shelf of exemplary Quirks, that
// everyone can see and take** (the ask, in those words).
//
// **These rows are examples, not grants.** Taking one copies its text onto a
// character (`character_quirk:add` carrying the id, which the server resolves
// to text at that instant) — the shelf is never linked to. So there is no
// "granted to (3)" count here and no Grant checklist: a Quirk on a sheet has no
// way back to the example it came from, and it is not supposed to have one. See
// `character_quirks` in db.js for why copy beats link.
//
// Open to every role, like the Perks tab. Authoring is GM-only — enforced
// server-side in `quirk:create`/`update`/`delete`, not merely hidden here.
export default function QuirksCompendium() {
  const { role, characterId } = useRole();
  const [quirks, setQuirks] = useState(null);
  const [form, setForm] = useState(null); // null | { quirk?, kind? }
  const [takeOpen, setTakeOpen] = useState(null); // GM only: quirk id whose character list is open
  const [rolling, setRolling] = useState(null); // null | 'positive' | 'negative'
  const characters = useRoster() ?? [];

  useEffect(() => {
    const refresh = () => getQuirks().then(setQuirks).catch(console.error);
    refresh();
    const events = ['quirk:created', 'quirk:updated', 'quirk:deleted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  if (!quirks) return <p className="text-zinc-500">Loading…</p>;

  // Who "me" is, for the Player-facing Take button — the same derivation the
  // Perks tab makes, off the roster it already has.
  const myCharacter = role === 'player' ? characters.find((c) => c.id === characterId) ?? null : null;

  // Split once here rather than inside the columns, because the Roll buttons
  // below need the same two lists to know whether they have anything to draw.
  const split = splitQuirks(quirks);

  const submit = (fields) => {
    if (form?.quirk) socket.emit('quirk:update', { quirkId: form.quirk.id, ...fields });
    else socket.emit('quirk:create', fields);
    setForm(null);
  };

  const remove = (quirk) => {
    // No "revoke it from everyone first" the way a Perk needs: nobody holds a
    // reference to this row. Everyone who took it has their own copy, and
    // deleting the example takes nothing away from them.
    if (window.confirm(`Delete the example "${quirk.name}"? Characters who took it keep their copy.`)) {
      socket.emit('quirk:delete', { quirkId: quirk.id });
    }
  };

  const columnFooter = (kind) => {
    const style = quirkStyle(kind);
    if (role === 'gm' && form && !form.quirk && form.kind === kind) {
      return <QuirkEditor defaultKind={kind} onSubmit={submit} onCancel={() => setForm(null)} />;
    }
    const side = split[kind];
    return (
      <div className="space-y-2">
        {role === 'gm' && (
          <button
            type="button"
            onClick={() => setForm({ kind })}
            className={`min-h-11 w-full panel-cut-sm border px-3 text-xs font-semibold uppercase tracking-wide md:min-h-0 md:py-1.5 ${style.chip}`}
          >
            + New {style.label} Quirk
          </button>
        )}
        {/* **Let the dice pick one.** Open to every role, not just the GM: a
            player rolling for their own character is the case this is for. Shown
            only when there is something to roll — a button that can only ever
            say "nothing here" is a button that teaches you not to press it. */}
        {side.length > 0 && (
          <button
            type="button"
            onClick={() => setRolling(kind)}
            title={`Draw one of the ${side.length} ${style.label.toLowerCase()} examples at random`}
            className="flex min-h-11 w-full items-center justify-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 md:min-h-0 md:py-1.5"
          >
            <Dices size={14} aria-hidden />
            Roll {style.label} Quirk
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">
        Examples to borrow. Taking one copies its text onto a character — the copy is theirs to
        reword, and editing an example here never rewrites anybody's sheet.
      </p>

      <QuirkColumns
        quirks={quirks}
        emptyText={role === 'gm' ? 'Nothing on this side yet.' : 'Nothing on this side yet.'}
        footer={columnFooter}
        renderQuirk={(quirk) =>
          form?.quirk?.id === quirk.id ? (
            <QuirkEditor
              key={quirk.id}
              initial={quirk}
              onSubmit={submit}
              onCancel={() => setForm(null)}
            />
          ) : (
            <div key={quirk.id}>
              <QuirkCard
                quirk={quirk}
                actions={
                  role === 'player' && myCharacter ? (
                    <button
                      onClick={() =>
                        socket.emit('character_quirk:add', {
                          characterId: myCharacter.id,
                          quirkId: quirk.id,
                        })
                      }
                      title={`Copy "${quirk.name}" onto your sheet`}
                      className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-brand-400 hover:bg-brand-900/40 md:min-h-0"
                    >
                      Take
                    </button>
                  ) : role === 'gm' ? (
                    <>
                      {/* The GM has no sheet of their own, so Take has to ask
                          whose. Same shape as the Perks tab's Grant… list, minus
                          the checkbox: there is nothing to untick, because a
                          copy is not a membership. */}
                      <button
                        onClick={() => setTakeOpen(takeOpen === quirk.id ? null : quirk.id)}
                        className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-brand-400 hover:bg-brand-900/40 md:min-h-0"
                      >
                        Give to…
                      </button>
                      <button
                        onClick={() => setForm({ quirk })}
                        className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 md:min-h-0"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => remove(quirk)}
                        className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400 md:min-h-0"
                      >
                        Delete
                      </button>
                    </>
                  ) : null
                }
              />
              {role === 'gm' && takeOpen === quirk.id && (
                <div className="mt-1 space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-2">
                  {characters.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        socket.emit('character_quirk:add', { characterId: c.id, quirkId: quirk.id });
                        setTakeOpen(null);
                      }}
                      className="flex min-h-11 w-full items-center gap-2 panel-cut-sm px-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 md:min-h-0 md:py-1"
                    >
                      {c.name}
                      {c.character_type === 'npc' && (
                        <span className="panel-cut-sm bg-purple-600/30 px-1 text-xs uppercase text-purple-300">
                          npc
                        </span>
                      )}
                    </button>
                  ))}
                  {characters.length === 0 && <p className="text-xs text-zinc-600">No characters yet.</p>}
                </div>
              )}
            </div>
          )
        }
      />

      {rolling && (
        <QuirkRollDialog
          kind={rolling}
          quirks={split[rolling]}
          characters={characters}
          // A Player has exactly one answer for "whose is it"; the GM picks.
          myCharacterId={myCharacter?.id ?? null}
          onClose={() => setRolling(null)}
        />
      )}
    </div>
  );
}

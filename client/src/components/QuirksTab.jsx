import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getQuirks } from '../lib/api.js';
import { quirkStyle } from '../lib/quirkStyles.js';
import QuirkCard from './QuirkCard.jsx';
import QuirkColumns from './QuirkColumns.jsx';
import QuirkEditor from './QuirkEditor.jsx';

// The character sheet's Quirks tab: **narrative only**, two halves, positive on
// the left and negative on the right.
//
// **A Quirk here is this character's own copy**, name and description and all
// (see `character_quirks` in db.js). So it is editable by whoever owns the
// sheet — rewording your own Quirk is the thing copying buys you, and the
// Compendium's example is untouched by it. The GM can edit any sheet's, exactly
// as they can everywhere else.
//
// Two ways to gain one, side by side under each column: **write one** (the
// primary path — a Quirk is usually invented at the table, not shopped for),
// and **take one from the Compendium's shelf** through a small picker of the
// examples that side has. The picker only appears when there is something on
// the shelf to take, rather than advertising an empty list.
export default function QuirksTab({ data }) {
  const { role, characterId } = useRole();
  const { character, quirks = [] } = data;
  // Whose sheet this is, not what role is looking at it: a Player can reach
  // another character's sheet by typing the URL, which the app's trust model
  // has always allowed.
  const mayEdit = role === 'gm' || characterId === character.id;

  // The Compendium's shelf, for the Take picker. Kept live rather than fetched
  // once: a GM writing an example mid-session should see it appear here.
  const [library, setLibrary] = useState([]);
  const [writing, setWriting] = useState(null); // null | 'positive' | 'negative'
  const [editing, setEditing] = useState(null); // null | character_quirk row
  const [takingFrom, setTakingFrom] = useState(null); // null | 'positive' | 'negative'

  useEffect(() => {
    const refresh = () => getQuirks().then(setLibrary).catch(console.error);
    refresh();
    const events = ['quirk:created', 'quirk:updated', 'quirk:deleted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  const add = (fields) => {
    socket.emit('character_quirk:add', { characterId: character.id, ...fields });
    setWriting(null);
  };
  const save = (fields) => {
    socket.emit('character_quirk:update', { characterQuirkId: editing.id, ...fields });
    setEditing(null);
  };
  const remove = (quirk) => {
    if (window.confirm(`Remove "${quirk.name}" from ${character.name}?`)) {
      socket.emit('character_quirk:remove', { characterQuirkId: quirk.id });
    }
  };

  // What is on the shelf for this side that this character has not already
  // taken — matched on name, which is what the server dedupes on too.
  const haveNames = new Set(quirks.map((q) => `${q.kind}:${q.name.toLowerCase()}`));
  const shelfFor = (kind) =>
    library.filter((q) => q.kind === kind && !haveNames.has(`${kind}:${q.name.toLowerCase()}`));

  const columnFooter = (kind) => {
    if (!mayEdit) return null;
    const style = quirkStyle(kind);
    const shelf = shelfFor(kind);
    if (writing === kind) {
      return <QuirkEditor defaultKind={kind} onSubmit={add} onCancel={() => setWriting(null)} />;
    }
    return (
      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setWriting(kind);
              setTakingFrom(null);
            }}
            className={`min-h-11 panel-cut-sm border px-3 text-xs font-semibold uppercase tracking-wide md:min-h-0 md:py-1.5 ${style.chip}`}
          >
            + Write one
          </button>
          {shelf.length > 0 && (
            <button
              type="button"
              onClick={() => setTakingFrom(takingFrom === kind ? null : kind)}
              className="min-h-11 panel-cut-sm border border-zinc-700 px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 md:min-h-0 md:py-1.5"
            >
              Take from Compendium ({shelf.length})
            </button>
          )}
        </div>
        {takingFrom === kind && (
          // A list of the shelf's own examples, each one click from being
          // copied onto this sheet. Deliberately shows the description too: a
          // Quirk is nothing BUT its description, and picking one by name alone
          // would be picking blind.
          <div className="space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-950/70 p-2">
            {shelf.map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={() => {
                  socket.emit('character_quirk:add', { characterId: character.id, quirkId: q.id });
                  setTakingFrom(null);
                }}
                title={`Copy "${q.name}" onto this sheet`}
                className="block w-full panel-cut-sm border border-zinc-800 px-2 py-1.5 text-left hover:border-brand-600 hover:bg-zinc-900"
              >
                <span className="block text-sm font-semibold text-zinc-200">{q.name}</span>
                {q.description && (
                  <span className="mt-0.5 block text-xs leading-snug text-zinc-500">{q.description}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Quirks are narrative only — they change nothing in a fight. Any number, taken or invented,
        at any time.
      </p>
      <QuirkColumns
        quirks={quirks}
        emptyText={mayEdit ? 'None yet — write one, or take one from the Compendium.' : 'None yet.'}
        footer={columnFooter}
        renderQuirk={(quirk) =>
          editing?.id === quirk.id ? (
            <QuirkEditor
              key={quirk.id}
              initial={quirk}
              onSubmit={save}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <QuirkCard
              key={quirk.id}
              quirk={quirk}
              // **Show it to the table.** Open to every viewer, not only whoever
              // owns the sheet: pointing at somebody's Quirk mid-scene is a
              // thing the GM does constantly, and a Quirk is public information
              // the moment it is on a sheet anybody can open.
              onShare={() => socket.emit('character_quirk:share', { characterQuirkId: quirk.id })}
              actions={
                mayEdit ? (
                  <>
                    <button
                      onClick={() => setEditing(quirk)}
                      title={`Reword ${quirk.name}`}
                      className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 md:min-h-0"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => remove(quirk)}
                      title={`Remove ${quirk.name}`}
                      className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400 md:min-h-0"
                    >
                      Remove
                    </button>
                  </>
                ) : null
              }
            />
          )
        }
      />
    </div>
  );
}

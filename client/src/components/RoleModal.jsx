import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { getCharacters } from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import InkHeading from './InkHeading.jsx';

// Shown on every fresh load, before anything else. A display filter, not
// auth: picking a character just tells the server (via identity:set, see
// roleContext.jsx) which one this connection should see the real declared
// moves for — anyone can still technically pick anyone's PC, same trust
// model as the rest of this app.
export default function RoleModal() {
  const { chooseGm, choosePlayer } = useRole();
  const [characters, setCharacters] = useState(null);

  useEffect(() => {
    getCharacters().then(setCharacters).catch(console.error);
  }, []);

  const pcs = (characters ?? []).filter((c) => c.character_type === 'pc');

  return (
    <div className="bg-arena flex h-screen flex-col items-center justify-center gap-8 text-zinc-100">
      {/* The first thing every visitor sees, so it gets the full treatment
          despite not being a combat surface (Visual Overhaul V5). */}
      <InkHeading
        seed={19}
        size="text-4xl md:text-6xl"
        className="text-center"
        strokeClassName="mx-auto max-w-md"
      >
        Dogfight
      </InkHeading>
      <p className="font-display -mt-4 text-sm uppercase tracking-[0.35em] text-zinc-500">
        Martial Arts TTRPG
      </p>
      <p className="text-zinc-400">Who are you this session?</p>
      <div className="flex w-full max-w-3xl items-stretch gap-6 px-6">
        <div className="ink-panel flex min-w-0 flex-1 flex-col gap-2 border border-zinc-800 bg-zinc-900 p-4">
          <span className="font-display text-xs font-bold uppercase tracking-wide text-zinc-500">
            Play as…
          </span>
          <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1">
            {characters == null ? (
              <p className="text-sm text-zinc-600">Loading…</p>
            ) : pcs.length === 0 ? (
              <p className="text-sm text-zinc-600">No player characters yet.</p>
            ) : (
              pcs.map((c) => {
                const src = portraitSrc(c);
                return (
                  <button
                    key={c.id}
                    onClick={() => choosePlayer(c.id)}
                    className="panel-cut-sm flex items-center gap-3 border border-zinc-800 bg-zinc-950 p-2 text-left hover:border-sky-600 hover:bg-zinc-800 active:scale-[0.98] transition"
                  >
                    <div className="panel-cut-sm flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden bg-zinc-800 text-sm font-bold text-zinc-500">
                      {src ? (
                        <img src={src} alt="" className="h-full w-full object-cover" />
                      ) : (
                        c.name.slice(0, 1).toUpperCase()
                      )}
                    </div>
                    <span className="font-display min-w-0 truncate font-semibold text-zinc-200">
                      {c.name}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <button
          onClick={chooseGm}
          className="panel-cut font-impact shrink-0 bg-amber-700 px-10 py-6 text-3xl uppercase tracking-wide hover:bg-amber-600 active:scale-95 transition"
        >
          GM
        </button>
      </div>
    </div>
  );
}

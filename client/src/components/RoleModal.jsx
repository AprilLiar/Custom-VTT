import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { getCharacters } from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';

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
    <div className="bg-arena flex h-[100dvh] flex-col items-center justify-center gap-6 overflow-y-auto px-4 py-6 text-zinc-100 sm:gap-8">
      <h1 className="text-center font-display text-2xl font-bold uppercase tracking-wide sm:text-4xl">Dogfight: Martial Arts TTRPG</h1>
      <p className="text-zinc-400">Who are you this session?</p>
      <div className="flex w-full max-w-3xl items-stretch gap-3 px-2 sm:gap-6 sm:px-6">
        <div className="panel-cut flex min-w-0 flex-1 flex-col gap-2 border border-zinc-800 bg-zinc-900 p-4">
          <span className="font-display text-xs font-bold uppercase tracking-wide text-zinc-500">
            Play as…
          </span>
          <div className="flex max-h-[min(20rem,55dvh)] flex-col gap-1.5 overflow-y-auto pr-1">
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
                        <CroppedImage src={src} crop={cropOf(c)} className="h-full w-full" />
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
          className="panel-cut-lg font-display shrink-0 bg-amber-700 px-10 py-6 text-2xl font-bold uppercase tracking-wide hover:bg-amber-600 active:scale-95 transition"
        >
          GM
        </button>
      </div>
    </div>
  );
}

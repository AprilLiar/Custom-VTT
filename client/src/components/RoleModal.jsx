import { useRole } from '../roleContext.jsx';

// Shown on every fresh load, before anything else. A display filter, not auth.
export default function RoleModal() {
  const { setRole } = useRole();

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-8 bg-zinc-950 text-zinc-100">
      <h1 className="text-3xl font-bold tracking-tight">Custom VTT</h1>
      <p className="text-zinc-400">Who are you this session?</p>
      <div className="flex gap-6">
        <button
          onClick={() => setRole('player')}
          className="rounded-xl bg-sky-700 px-10 py-6 text-2xl font-bold hover:bg-sky-600 active:scale-95 transition"
        >
          Player
        </button>
        <button
          onClick={() => setRole('gm')}
          className="rounded-xl bg-amber-700 px-10 py-6 text-2xl font-bold hover:bg-amber-600 active:scale-95 transition"
        >
          GM
        </button>
      </div>
    </div>
  );
}

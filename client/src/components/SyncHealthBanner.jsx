import { useEffect, useState } from 'react';
import { socket } from '../socket.js';

// **The offline-writes alarm (Phase 5).**
//
// The server writes to a local database and pushes to Turso every ten seconds,
// which is what makes declaring a move feel instant — see the note above
// `offline: true` in server/db.js. The trade is that a crash costs one sync
// window, and that trade is only honest while the push is actually working.
//
// A failing push looks *exactly* like a working one from in here: the game
// carries on, every action lands, nothing is slow. The damage is invisible
// until the container recycles and takes the unsynced backlog with it. So the
// server announces a health change to every client, and this puts it on screen.
//
// Deliberately louder than ConnectionBanner, and deliberately not dismissible:
// "offline" is self-correcting and everybody already knows what it means, while
// this one is silent data loss in progress and the only fix is a human noticing.
// It renders nothing at all when the sync is healthy, which is almost always.
export default function SyncHealthBanner() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const onHealth = (payload) => setHealth(payload);
    socket.on('db:sync_health', onHealth);
    return () => socket.off('db:sync_health', onHealth);
  }, []);

  if (!health || health.healthy) return null;

  const stale = health.staleSeconds;
  const since =
    stale == null
      ? 'never since this server started'
      : stale < 120
        ? `${stale}s ago`
        : `${Math.round(stale / 60)} min ago`;

  return (
    <div
      role="alert"
      className="font-display shrink-0 bg-red-950/85 px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-red-200"
    >
      Not saving to the cloud — last successful save {since}. Recent progress will be lost if the
      server restarts.
    </div>
  );
}

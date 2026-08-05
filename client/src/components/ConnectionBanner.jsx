import { useConnectionState } from '../lib/connection.js';

// Mobile readiness (Change 002) §11.1: a compact banner that only ever
// renders while not fully 'connected' — reading already-loaded state stays
// available the whole time (nothing here blocks the UI), it's only meant to
// warn that a commit action (declare, roll, apply damage, etc.) won't
// actually reach the server right now.
export default function ConnectionBanner() {
  const state = useConnectionState();
  if (state === 'connected') return null;

  return (
    <div
      role="status"
      className={`font-display shrink-0 px-3 py-1 text-center text-xs font-semibold uppercase tracking-wide ${
        state === 'reconnecting' ? 'bg-amber-900/60 text-amber-200' : 'bg-red-950/70 text-red-200'
      }`}
    >
      {state === 'reconnecting' ? 'Reconnecting…' : 'Offline — actions won’t reach the server'}
    </div>
  );
}

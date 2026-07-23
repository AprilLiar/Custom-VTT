import { useEffect, useState } from 'react';
import { socket } from './socket.js';

export default function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [pingState, setPingState] = useState(null);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onPingUpdate = (state) => setPingState(state);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('ping:update', onPingUpdate);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('ping:update', onPingUpdate);
    };
  }, []);

  const sendPing = () => {
    socket.emit('ping:send', { label: navigator.userAgent.slice(0, 40) });
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-4xl font-bold tracking-tight">Custom VTT</h1>
      <p className="text-zinc-400">Phase 0 — walking skeleton</p>

      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-3 w-3 rounded-full ${
            connected ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
        <span className="text-sm text-zinc-300">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <button
        onClick={sendPing}
        disabled={!connected}
        className="rounded-lg bg-indigo-600 px-6 py-3 text-lg font-semibold hover:bg-indigo-500 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none"
      >
        Ping everyone
      </button>

      <div className="text-center">
        {pingState ? (
          <>
            <p className="text-2xl font-mono">{pingState.count} pings stored</p>
            <p className="text-sm text-zinc-500">
              last: {pingState.lastAt ?? 'never'}
            </p>
          </>
        ) : (
          <p className="text-zinc-500">waiting for server state…</p>
        )}
      </div>

      <p className="max-w-md text-center text-xs text-zinc-600">
        Every press writes a row to the database and broadcasts the new count to
        every connected device. Open this page on two devices to see it update
        live on both.
      </p>
    </div>
  );
}

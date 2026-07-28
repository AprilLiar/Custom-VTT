import { createContext, useContext, useEffect, useState } from 'react';
import { socket } from './socket.js';

// Client-side display filter, not authentication — but 'player' now carries
// a real characterId (decided): picking a specific character at the door,
// instead of a generic Player/GM split, is what lets the server actually
// tell whose declared moves to reveal (see combat:updated/identity:set
// server-side, and vttprojectplan.md's Combat Timing section). Still
// deliberately not persisted — asks again on every fresh load.
const RoleContext = createContext({
  role: null,
  characterId: null,
  chooseGm: () => {},
  choosePlayer: () => {},
});

export function RoleProvider({ children }) {
  const [role, setRole] = useState(null); // null | 'player' | 'gm'
  const [characterId, setCharacterId] = useState(null); // set only once role === 'player'

  // The server keeps identity per-connection, in memory only (matches the
  // no-login, session-only model) — so it has to be re-sent every time the
  // socket (re)connects, not just once at pick time, or a Render cold-start
  // reconnect would silently drop back to fully-redacted for this client.
  useEffect(() => {
    if (!role) return;
    const identity = role === 'gm' ? { role: 'gm' } : { role: 'player', characterId };
    const send = () => socket.emit('identity:set', identity);
    send();
    socket.on('connect', send);
    return () => socket.off('connect', send);
  }, [role, characterId]);

  const chooseGm = () => {
    setRole('gm');
    setCharacterId(null);
  };
  const choosePlayer = (id) => {
    setRole('player');
    setCharacterId(id);
  };

  return (
    <RoleContext.Provider value={{ role, characterId, chooseGm, choosePlayer }}>
      {children}
    </RoleContext.Provider>
  );
}

export const useRole = () => useContext(RoleContext);

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
  capabilities: { canSeeRevealedDetail: false },
  chooseGm: () => {},
  choosePlayer: () => {},
});

// What this viewer is allowed to do that a Perk can change — answered by the
// server, never decided here (see capabilitiesFor in server/index.js). The
// client only stores the answer, the same way it stores nothing else about
// what a character is entitled to see.
const NO_CAPABILITIES = { canSeeRevealedDetail: false };

export function RoleProvider({ children }) {
  const [role, setRole] = useState(null); // null | 'player' | 'gm'
  const [characterId, setCharacterId] = useState(null); // set only once role === 'player'
  const [capabilities, setCapabilities] = useState(NO_CAPABILITIES);

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
    // The server answers every identity:set with the capabilities that go with
    // it, and pushes a fresh answer whenever a Perk is granted or revoked to
    // this character — so a Perk handed out mid-session takes effect at the
    // table rather than on the next reload.
    const receive = (next) => setCapabilities({ ...NO_CAPABILITIES, ...(next ?? {}) });
    socket.on('identity:capabilities', receive);
    return () => {
      socket.off('connect', send);
      socket.off('identity:capabilities', receive);
    };
  }, [role, characterId]);

  const chooseGm = () => {
    setRole('gm');
    setCharacterId(null);
    setCapabilities(NO_CAPABILITIES); // until the server answers
  };
  const choosePlayer = (id) => {
    setRole('player');
    setCharacterId(id);
    setCapabilities(NO_CAPABILITIES);
  };

  return (
    <RoleContext.Provider value={{ role, characterId, capabilities, chooseGm, choosePlayer }}>
      {children}
    </RoleContext.Provider>
  );
}

export const useRole = () => useContext(RoleContext);

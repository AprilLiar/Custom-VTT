import { createContext, useContext, useEffect, useState } from 'react';
import { socket } from './socket.js';
import { unlockAudioFromGesture } from './lib/audioEngine.js';

// Client-side display filter, not authentication — but 'player' carries a real
// characterId (decided): picking a specific character at the door, instead of a
// generic Player/GM split, is what lets the server tell whose Relationships
// board a viewer may read and which Scene summons to hide from them (see
// identity:set server-side). Still deliberately not persisted — asks again on
// every fresh load.
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
    return () => {
      socket.off('connect', send);
    };
  }, [role, characterId]);

  // **Picking a role is what buys permission to play sound.** Browsers refuse
  // audio until the person has interacted with the page, and this modal is the
  // one mandatory tap on every single load — so the table's music can start on
  // its own afterwards instead of every listener needing to find a button.
  //
  // Called synchronously from inside the click handler, deliberately: an effect
  // reacting to `role` might survive Chrome's sticky activation, but it will
  // not survive Safari's, and mobile is the primary way this app is played.
  const chooseGm = () => {
    unlockAudioFromGesture();
    setRole('gm');
    setCharacterId(null);
  };
  const choosePlayer = (id) => {
    unlockAudioFromGesture(); // see chooseGm above
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

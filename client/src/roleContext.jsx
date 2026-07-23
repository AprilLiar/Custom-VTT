import { createContext, useContext, useState } from 'react';

// Client-side display filter only — not authentication. Deliberately not
// persisted: the plan asks the role question again on every fresh load.
const RoleContext = createContext({ role: null, setRole: () => {} });

export function RoleProvider({ children }) {
  const [role, setRole] = useState(null); // null | 'player' | 'gm'
  return <RoleContext.Provider value={{ role, setRole }}>{children}</RoleContext.Provider>;
}

export const useRole = () => useContext(RoleContext);

import { useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { RoleProvider, useRole } from './roleContext.jsx';
import RoleModal from './components/RoleModal.jsx';
import CharacterList from './components/CharacterList.jsx';
import CharacterSheet from './components/CharacterSheet.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import CompendiumPage from './components/CompendiumPage.jsx';
import CombatArena from './components/CombatArena.jsx';
import CombatHeaderBar from './components/CombatHeaderBar.jsx';
import SearchBar from './components/SearchBar.jsx';

function Shell() {
  const { role, characterId } = useRole();
  const [chatOpen, setChatOpen] = useState(true);

  if (!role) return <RoleModal />;

  // A Player only ever plays one character (picked at the Role Modal) — no
  // roster to browse, so "Characters" becomes a direct link to that one
  // sheet instead. The GM keeps the full roster. Landing on "/" follows the
  // same split below so a stray link/back-button press can't strand a
  // Player on a roster they're not meant to see.
  const homePath = role === 'player' ? `/character/${characterId}` : '/';

  return (
    <div className="bg-arena flex h-screen flex-col text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <Link
          to="/combat"
          title="Combat Arena"
          className="font-display text-xl font-bold uppercase tracking-wide hover:text-brand-400"
        >
          Custom VTT
        </Link>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${
            role === 'gm' ? 'bg-amber-600/30 text-amber-300' : 'bg-sky-600/30 text-sky-300'
          }`}
        >
          {role === 'gm' ? 'GM' : 'Player'}
        </span>
        <Link
          to="/compendium"
          className="panel-cut-sm font-display px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-brand-300"
        >
          Compendium
        </Link>
        <Link
          to={homePath}
          className="panel-cut-sm font-display px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-brand-300"
        >
          {role === 'gm' ? 'Characters' : 'Character'}
        </Link>
        <div className="flex-1" />
        <SearchBar />
        <button
          onClick={() => setChatOpen((v) => !v)}
          className="panel-cut-sm font-display border border-zinc-700 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-300 hover:bg-zinc-800"
        >
          {chatOpen ? 'Hide chat' : 'Chat'}
        </button>
      </header>
      <CombatHeaderBar />

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-4">
          <Routes>
            <Route
              path="/"
              element={role === 'player' ? <Navigate to={homePath} replace /> : <CharacterList />}
            />
            <Route path="/character/:id" element={<CharacterSheet />} />
            <Route path="/compendium" element={<CompendiumPage />} />
            <Route path="/combat" element={<CombatArena />} />
            <Route path="*" element={<Navigate to={homePath} replace />} />
          </Routes>
        </main>
        <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <RoleProvider>
      <Shell />
    </RoleProvider>
  );
}

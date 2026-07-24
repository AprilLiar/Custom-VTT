import { useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { RoleProvider, useRole } from './roleContext.jsx';
import RoleModal from './components/RoleModal.jsx';
import CharacterList from './components/CharacterList.jsx';
import CharacterSheet from './components/CharacterSheet.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import CompendiumPage from './components/CompendiumPage.jsx';
import SearchBar from './components/SearchBar.jsx';

function Shell() {
  const { role } = useRole();
  const [chatOpen, setChatOpen] = useState(true);

  if (!role) return <RoleModal />;

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <Link to="/" className="text-lg font-bold tracking-tight hover:text-indigo-400">
          Custom VTT
        </Link>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${
            role === 'gm' ? 'bg-amber-600/30 text-amber-300' : 'bg-sky-600/30 text-sky-300'
          }`}
        >
          {role === 'gm' ? 'GM' : 'Player'}
        </span>
        {role === 'gm' && (
          <Link
            to="/compendium"
            className="rounded-md px-2 py-1 text-sm font-semibold text-zinc-400 hover:text-indigo-300"
          >
            Compendium
          </Link>
        )}
        <div className="flex-1" />
        <SearchBar />
        <button
          onClick={() => setChatOpen((v) => !v)}
          className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          {chatOpen ? 'Hide chat' : 'Chat'}
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-4">
          <Routes>
            <Route path="/" element={<CharacterList />} />
            <Route path="/character/:id" element={<CharacterSheet />} />
            <Route path="/compendium" element={<CompendiumPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
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

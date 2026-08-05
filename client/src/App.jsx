import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Cog, Menu, Search, Swords, Users, BookOpen, MessageSquare } from 'lucide-react';
import { RoleProvider, useRole } from './roleContext.jsx';
import { socket } from './socket.js';
import { useIsDesktop } from './lib/useMediaQuery.js';
import RoleModal from './components/RoleModal.jsx';
import CharacterList from './components/CharacterList.jsx';
import CharacterSheet from './components/CharacterSheet.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import CompendiumPage from './components/CompendiumPage.jsx';
import CombatArena from './components/CombatArena.jsx';
import CombatHeaderBar from './components/CombatHeaderBar.jsx';
import SearchBar from './components/SearchBar.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import ConnectionBanner from './components/ConnectionBanner.jsx';

// Mobile readiness (Change 002) §5.1/14.2: bottom navigation is the primary
// mobile nav (recommended default) — Arena/Character(s)/Compendium/Chat,
// each a real route except Chat (a toggle, not a page — see chatOpen
// below). Settings/Search stay as top-bar icon actions on mobile too, same
// as desktop, rather than crowding a 5th bottom-nav slot.
function BottomNav({ homePath, chatOpen, onToggleChat, unreadChat }) {
  const location = useLocation();
  const items = [
    { to: '/combat', label: 'Arena', icon: Swords, match: (p) => p === '/combat' },
    { to: homePath, label: 'Characters', icon: Users, match: (p) => p === '/' || p.startsWith('/character') },
    { to: '/compendium', label: 'Compendium', icon: BookOpen, match: (p) => p.startsWith('/compendium') },
  ];
  return (
    <nav
      style={{ paddingBottom: 'var(--safe-bottom)' }}
      className="grid shrink-0 grid-cols-4 border-t border-zinc-800 bg-zinc-950 md:hidden"
    >
      {items.map(({ to, label, icon: Icon, match }) => {
        const active = match(location.pathname);
        return (
          <Link
            key={label}
            to={to}
            className={`flex min-h-11 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${
              active ? 'text-brand-400' : 'text-zinc-500'
            }`}
          >
            <Icon size={18} />
            {label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onToggleChat}
        className={`relative flex min-h-11 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${
          chatOpen ? 'text-brand-400' : 'text-zinc-500'
        }`}
      >
        <MessageSquare size={18} />
        Chat
        {!chatOpen && unreadChat > 0 && (
          <span className="absolute right-[22%] top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-bold text-white">
            {unreadChat > 9 ? '9+' : unreadChat}
          </span>
        )}
      </button>
    </nav>
  );
}

function Shell() {
  const { role, characterId } = useRole();
  const isDesktop = useIsDesktop();
  // Mobile readiness (Change 002) §5.1: chatOpen can't be a single constant
  // for every viewport — a mobile first render must start closed (the whole
  // point of the redesign; see the mechanic's own audit note that this used
  // to always open Chat over the entire mobile screen the instant a role
  // was picked) while desktop keeps its existing "always open" default.
  // Deliberately NOT re-derived on every breakpoint change (no effect
  // watching isDesktop) — resizing/rotating mid-session must never yank
  // Chat open over whatever the user is doing.
  const [chatOpen, setChatOpen] = useState(() => isDesktop);
  const [unreadChat, setUnreadChat] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (chatOpen) {
      setUnreadChat(0);
      return;
    }
    const bump = () => setUnreadChat((n) => n + 1);
    const events = ['roll:result', 'chat:message', 'chat:move_reveal', 'chat:lane_snapshot'];
    for (const ev of events) socket.on(ev, bump);
    return () => {
      for (const ev of events) socket.off(ev, bump);
    };
  }, [chatOpen]);

  if (!role) return <RoleModal />;

  // A Player only ever plays one character (picked at the Role Modal) — no
  // roster to browse, so "Characters" becomes a direct link to that one
  // sheet instead. The GM keeps the full roster. Landing on "/" follows the
  // same split below so a stray link/back-button press can't strand a
  // Player on a roster they're not meant to see.
  const homePath = role === 'player' ? `/character/${characterId}` : '/';

  return (
    <div className="app-shell bg-arena flex flex-col text-zinc-100">
      <ConnectionBanner />
      <header
        style={{ paddingTop: 'var(--safe-top)' }}
        className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-3 py-2 md:px-4"
      >
        <Link
          to="/combat"
          title="Combat Arena"
          className="font-display shrink-0 text-lg font-bold uppercase tracking-wide hover:text-brand-400 md:text-xl"
        >
          Custom VTT
        </Link>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${
            role === 'gm' ? 'bg-amber-600/30 text-amber-300' : 'bg-sky-600/30 text-sky-300'
          }`}
        >
          {role === 'gm' ? 'GM' : 'Player'}
        </span>

        {/* Desktop: full inline links + inline search, unchanged. */}
        <Link
          to="/compendium"
          className="panel-cut-sm font-display hidden px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-brand-300 md:inline-block"
        >
          Compendium
        </Link>
        <Link
          to={homePath}
          className="panel-cut-sm font-display hidden px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-brand-300 md:inline-block"
        >
          {role === 'gm' ? 'Characters' : 'Character'}
        </Link>
        <div className="flex-1" />
        <div className="hidden md:block">
          <SearchBar />
        </div>
        <div className="hidden md:block">
          <button
            onClick={() => setChatOpen((v) => !v)}
            className="panel-cut-sm font-display border border-zinc-700 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-300 hover:bg-zinc-800"
          >
            {chatOpen ? 'Hide chat' : 'Chat'}
          </button>
        </div>

        {/* Mobile: compact search action + a small "More" menu for Settings
            (bottom nav already covers Arena/Characters/Compendium/Chat). */}
        <button
          type="button"
          onClick={() => setMobileMenuOpen((v) => !v)}
          title="Search / Settings"
          aria-label="Search / Settings"
          className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 text-zinc-400 hover:border-brand-500 hover:text-brand-300 md:hidden"
        >
          <Menu size={18} />
        </button>
        <Link
          to="/settings"
          title="Settings"
          className="hidden shrink-0 panel-cut-sm border border-zinc-700 p-1.5 text-zinc-400 hover:border-brand-500 hover:text-brand-300 md:block"
        >
          <Cog size={18} />
        </Link>
      </header>

      {mobileMenuOpen && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-zinc-800 bg-zinc-950 p-3 md:hidden">
          <SearchBar mobileFullWidth onNavigate={() => setMobileMenuOpen(false)} />
          <Link
            to="/settings"
            onClick={() => setMobileMenuOpen(false)}
            className="flex min-h-11 items-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            <Cog size={16} />
            Settings
          </Link>
        </div>
      )}

      <CombatHeaderBar />

      <div className="flex flex-1 overflow-hidden">
        <main className="min-w-0 flex-1 overflow-y-auto p-2 md:p-4">
          <Routes>
            <Route
              path="/"
              element={role === 'player' ? <Navigate to={homePath} replace /> : <CharacterList />}
            />
            <Route path="/character/:id" element={<CharacterSheet />} />
            <Route path="/compendium" element={<CompendiumPage />} />
            <Route path="/combat" element={<CombatArena />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to={homePath} replace />} />
          </Routes>
        </main>
        <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      </div>

      {!chatOpen && (
        <BottomNav
          homePath={homePath}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen(true)}
          unreadChat={unreadChat}
        />
      )}
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

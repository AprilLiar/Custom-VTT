import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Cog, FlaskConical, Menu, Users, MessageSquare, Clapperboard, StickyNote } from 'lucide-react';
import { RoleProvider, useRole } from './roleContext.jsx';
import { socket } from './socket.js';
import { useIsDesktop } from './lib/useMediaQuery.js';
import RoleModal from './components/RoleModal.jsx';
import CharacterList from './components/CharacterList.jsx';
import CharacterSheet from './components/CharacterSheet.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import SearchBar from './components/SearchBar.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import HomebrewPage from './components/HomebrewPage.jsx';
import ConnectionBanner from './components/ConnectionBanner.jsx';
import GmToolsWidget from './components/GmToolsWidget.jsx';
import ScenePage from './components/ScenePage.jsx';
import EventsPage from './components/EventsPage.jsx';
import { useControl } from './lib/useControl.js';

// Mobile readiness (Change 002) §5.1/14.2: bottom navigation is the primary
// mobile nav — Character(s) and Chat (a toggle, not a page — see chatOpen
// below). It also held the Arena and the Compendium until the pivot removed
// them. Scene/Search/Settings stay in the top bar's menu on mobile.
function BottomNav({ homePath, chatOpen, onToggleChat, onNavigate, unreadChat }) {
  const location = useLocation();
  const items = [
    { to: homePath, label: 'Characters', icon: Users, match: (p) => p === '/' || p.startsWith('/character') },
  ];
  return (
    // The one legitimate bare use of the inset: this nav has no padding class
    // of its own, so the safe-area inset IS its bottom padding rather than
    // silently replacing one (see DialogShell for the bug that caused).
    <nav
      style={{ paddingBottom: 'var(--safe-bottom)' }}
      className="grid shrink-0 grid-cols-2 border-t border-zinc-800 bg-zinc-950 md:hidden"
    >
      {items.map(({ to, label, icon: Icon, match }) => {
        const active = match(location.pathname);
        return (
          <Link
            key={label}
            to={to}
            // A real tab strip lets you land on a tab by pressing it, even
            // the one you're already "on" — and Chat is the case that
            // surfaces it: opening Chat never changes the route underneath
            // it, so pressing the SAME tab you opened it from (the common
            // gesture for "take me back") left `location.pathname` unchanged
            // and the pathname-keyed close effect below never fired. Chat
            // stayed open, overlaying a page that looked like it should have
            // taken over. Closing it here, on every press, is what makes
            // this button behave like every other one on the strip rather
            // than as a toggle Chat alone gets to ignore.
            onClick={onNavigate}
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
  // NPCs the GM assigned to this Player: linked beside "Character".
  const { assignedNpcs } = useControl();
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

  // Mobile: Chat is a tab, so leaving for another tab leaves Chat (decided).
  // Keyed off the pathname rather than the nav links themselves so the back
  // button and any other in-app navigation behave the same way. Desktop is
  // untouched — there Chat is a persistent side panel beside the page, not a
  // destination you navigate away from.
  const location = useLocation();
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    if (!isDesktop) setChatOpen(false);
  }, [location.pathname, isDesktop]);

  // Scene tab (decided, Phase 4): activating a Scene force-navigates every
  // connected client straight to /scene, including the very first
  // activation of the session — the whole "cinematic cut" the feature
  // exists for. Diffs ONLY `activeScene?.id`, never the rest of the
  // stage:updated payload: a later summon/un-summon (Phase 5) fires this
  // same event with the SAME id, and re-navigating on every one of those
  // would turn a cinematic cut into a constant, disorienting yank (Risk #1
  // in the Scene tab plan). The ref starts at a sentinel rather than
  // seeding from a REST fetch, so a page load or reconnect that happens to
  // land while a Scene is already active never navigates anyone on its
  // own — only a live switch does, which is exactly what a `stage:updated`
  // SOCKET event means (nothing pushes it just to catch a client up).
  // A `null` activeScene (nothing activated, or the active Scene got
  // deleted) never navigates anywhere — there is no Scene to cut to.
  const navigate = useNavigate();
  const lastActiveSceneId = useRef(undefined);
  useEffect(() => {
    const onStageUpdated = (stage) => {
      const id = stage?.activeScene?.id ?? null;
      if (id === lastActiveSceneId.current) return;
      lastActiveSceneId.current = id;
      if (id != null) navigate('/scene', { replace: true });
    };
    socket.on('stage:updated', onStageUpdated);
    return () => socket.off('stage:updated', onStageUpdated);
  }, [navigate]);

  useEffect(() => {
    if (chatOpen) {
      setUnreadChat(0);
      return;
    }
    const bump = () => setUnreadChat((n) => n + 1);
    const events = ['roll:result', 'chat:message', 'chat:card'];
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

  // One route list, shared by both chrome shapes below — /scene is a normal
  // entry in it like any other page.
  const routes = (
    <Routes>
      <Route
        path="/"
        element={role === 'player' ? <Navigate to={homePath} replace /> : <CharacterList />}
      />
      <Route path="/character/:id" element={<CharacterSheet />} />
      <Route path="/scene" element={<ScenePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/homebrew" element={<HomebrewPage />} />
      <Route path="/events" element={<EventsPage />} />
      <Route path="*" element={<Navigate to={homePath} replace />} />
    </Routes>
  );

  // Scene tab (decided): this route needs to be genuinely chrome-free — no
  // header, no mobile menu, no Chat overlay, and
  // critically no BottomNav, since a still-mounted bottom nav under a
  // force-navigated page would let a Player tap their way back out, which is
  // exactly what force-navigating them here is meant to prevent. This is a
  // route-level branch rather than the RelationshipsTab-style
  // portal-over-chrome trick used everywhere else in this app, because that
  // trick only ever paints OVER the chrome — the bottom nav is still there
  // underneath it, still tappable. `ScenePage` itself carries the one way
  // off the route (a small corner Back link), since nothing else on this
  // branch does.
  if (location.pathname === '/scene') {
    return (
      <div className="app-shell bg-arena flex flex-col text-zinc-100">
        <ConnectionBanner />
        <div className="flex flex-1 overflow-hidden">{routes}</div>
        <GmToolsWidget />
      </div>
    );
  }

  return (
    <div className="app-shell bg-arena flex flex-col text-zinc-100">
      <ConnectionBanner />
      <header
        style={{ paddingTop: 'var(--safe-top)' }}
        className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-3 py-2 md:px-4"
      >
        <Link
          to={homePath}
          title="Home"
          className="font-display shrink-0 text-lg font-bold uppercase tracking-wide hover:text-brand-400 md:text-xl"
        >
          Dogfight
        </Link>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${
            role === 'gm' ? 'bg-amber-600/30 text-amber-300' : 'bg-sky-600/30 text-sky-300'
          }`}
        >
          {role === 'gm' ? 'GM' : 'Player'}
        </span>

        {/* Desktop: full inline links + inline search. */}
        <Link
          to={homePath}
          className="panel-cut-sm font-display hidden px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-brand-300 md:inline-block"
        >
          {role === 'gm' ? 'Characters' : 'Character'}
        </Link>
        {role === 'player' &&
          assignedNpcs.map((npc) => (
            <Link
              key={npc.id}
              to={`/character/${npc.id}`}
              title="An NPC assigned to you"
              className="panel-cut-sm font-display hidden max-w-[10rem] truncate px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 hover:text-brand-300 md:inline-block"
            >
              {npc.name}
            </Link>
          ))}
        {/* The Scene tab's only entry point on this branch — the route
            itself is chrome-free once you're on it (see above), so this is
            the sole link a GM (or, once a Scene is active, a Player) has to
            reach it voluntarily. A Player is normally pulled here by the
            force-navigate broadcast (Phase 4) rather than clicking this. */}
        <Link
          to="/scene"
          className="panel-cut-sm font-display hidden px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-brand-300 md:inline-block"
        >
          Scene
        </Link>
        {/* The Events tab (decided, new): sticky notes in lanes, for everyone. */}
        <Link
          to="/events"
          className="panel-cut-sm font-display hidden px-2 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-brand-300 md:inline-block"
        >
          Events
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

        {/* Mobile: compact search action + a small "More" menu for
            Scene/Settings (bottom nav already covers Characters/Chat). */}
        <button
          type="button"
          onClick={() => setMobileMenuOpen((v) => !v)}
          title="Search / Scene / Events / Settings"
          aria-label="Search / Scene / Events / Settings"
          className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 text-zinc-400 hover:border-brand-500 hover:text-brand-300 md:hidden"
        >
          <Menu size={18} />
        </button>
        {role === 'gm' && (
          <Link
            to="/homebrew"
            title="Homebrew"
            className="hidden shrink-0 panel-cut-sm border border-zinc-700 p-1.5 text-zinc-400 hover:border-brand-500 hover:text-brand-300 md:block"
          >
            <FlaskConical size={18} />
          </Link>
        )}
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
          {role === 'player' &&
            assignedNpcs.map((npc) => (
              <Link
                key={npc.id}
                to={`/character/${npc.id}`}
                onClick={() => {
                  setMobileMenuOpen(false);
                  setChatOpen(false);
                }}
                className="flex min-h-11 items-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
              >
                <Users size={16} />
                {npc.name} <span className="text-[11px] font-normal text-zinc-500">NPC</span>
              </Link>
            ))}
          <Link
            to="/scene"
            onClick={() => {
              setMobileMenuOpen(false);
              setChatOpen(false);
            }}
            className="flex min-h-11 items-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            <Clapperboard size={16} />
            Scene
          </Link>
          <Link
            to="/events"
            onClick={() => {
              setMobileMenuOpen(false);
              setChatOpen(false);
            }}
            className="flex min-h-11 items-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            <StickyNote size={16} />
            Events
          </Link>
          {role === 'gm' && (
            <Link
              to="/homebrew"
              onClick={() => {
                setMobileMenuOpen(false);
                setChatOpen(false);
              }}
              className="flex min-h-11 items-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
            >
              <FlaskConical size={16} />
              Homebrew
            </Link>
          )}
          <Link
            to="/settings"
            onClick={() => {
              setMobileMenuOpen(false);
              setChatOpen(false);
            }}
            className="flex min-h-11 items-center gap-2 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            <Cog size={16} />
            Settings
          </Link>
        </div>
      )}

      {/* `relative` so the mobile chat overlay can be absolutely positioned
          against this row rather than the viewport — that keeps it below the
          header and, crucially, ABOVE the bottom nav, which now stays
          visible while chat is open (see BottomNav below). */}
      <div className="relative flex flex-1 overflow-hidden">
        <main className="min-w-0 flex-1 overflow-y-auto p-2 md:p-4">
          {routes}
        </main>
        <ChatPanel open={chatOpen} />
      </div>

      {/* Always mounted on mobile, including while chat is open: the Chat
          item is a toggle, so tapping it again is the way back out. It used
          to unmount whenever chat opened, which left the ✕ in the opposite
          corner as the only exit. */}
      <BottomNav
        homePath={homePath}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
        onNavigate={() => setChatOpen(false)}
        unreadChat={unreadChat}
      />

      {/* Global on purpose: the GM's tool drawer has to be reachable from any
          page (it renders nothing for a Player). */}
      <GmToolsWidget />
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

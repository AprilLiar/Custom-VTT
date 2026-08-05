import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';

// Mobile readiness (Change 002) §11.1: a global connection-state hook so
// every page can show the same compact "reconnecting/offline" banner and
// disable commit actions during it, rather than each component guessing at
// socket.connected itself. 'reconnecting' covers both an active
// reconnect attempt and a plain connect_error (indistinguishable from the
// UI's point of view — both mean "not connected right now, still trying").
export function useConnectionState() {
  const [state, setState] = useState(socket.connected ? 'connected' : 'reconnecting');

  useEffect(() => {
    const onConnect = () => setState('connected');
    const onDisconnect = (reason) => setState(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    const onReconnectAttempt = () => setState('reconnecting');
    const onConnectError = () => setState('reconnecting');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.on('connect_error', onConnectError);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off('connect_error', onConnectError);
    };
  }, []);

  return state;
}

// §11.2: re-run `refresh` after a genuine RE-connect (never the first
// connect — that's just the component's own normal mount-time fetch) and
// after the tab returns from a long background suspend
// (visibilitychange -> visible). Coalesced with a short debounce so a
// resume-then-immediately-reconnect (the common mobile case: unlocking the
// phone triggers both near-simultaneously) doesn't double-fetch. Every
// caller passes a *stable* refresh function (useCallback at the call site)
// since it's read via a ref, not a dependency, precisely so this effect
// doesn't need to re-subscribe every render.
export function useSocketRefresh(refresh) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const hasConnectedOnceRef = useRef(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    const run = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => refreshRef.current(), 150);
    };
    const onConnect = () => {
      if (hasConnectedOnceRef.current) run();
      hasConnectedOnceRef.current = true;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };
    socket.on('connect', onConnect);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      socket.off('connect', onConnect);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(debounceRef.current);
    };
  }, []);
}

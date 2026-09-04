import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getStage } from './api.js';

// The live stage everyone shares (Scene tab plan, Phase 4) — `{ activeScene,
// summons }`, kept live over `stage:updated`. Returns `null` until the
// first fetch lands, same "not loaded yet" convention `useRoster` uses.
//
// This is a plain fetch-then-subscribe hook, not the force-navigate
// listener — that one lives in App.jsx's Shell() and deliberately does NOT
// use this hook, since it must diff only `activeScene?.id` against what it
// personally last saw over the SOCKET, never seed from this hook's own
// initial REST fetch (a page load must never force-navigate on its own).
export function useStage() {
  const [stage, setStage] = useState(null);

  useEffect(() => {
    let alive = true;
    getStage()
      .then((s) => {
        if (alive) setStage(s);
      })
      .catch(console.error);
    const onUpdated = (s) => setStage(s);
    socket.on('stage:updated', onUpdated);
    return () => {
      alive = false;
      socket.off('stage:updated', onUpdated);
    };
  }, []);

  return stage;
}

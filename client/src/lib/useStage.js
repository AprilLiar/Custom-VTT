import { useCallback, useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getStage } from './api.js';
import { useSocketRefresh } from './connection.js';

// The live stage everyone shares (Scene tab plan, Phase 4) — `{ activeScene,
// summons }`, kept live over `stage:updated`. Returns `null` until the
// first fetch lands, same "not loaded yet" convention `useRoster` uses.
//
// This is a plain fetch-then-subscribe hook, not the force-navigate
// listener — that one lives in App.jsx's Shell() and deliberately does NOT
// use this hook, since it must diff only `activeScene?.id` against what it
// personally last saw over the SOCKET, never seed from this hook's own
// initial REST fetch (a page load must never force-navigate on its own).
//
// `identity` rides along to the initial REST fetch only (see getStage's own
// comment) — the SOCKET side needs no identity argument here, since the
// server already knows a connected socket's own identity (socket.data.identity)
// and redacts stage:updated per-socket before it ever reaches this listener.
export function useStage(identity) {
  const [stage, setStage] = useState(null);

  // **Resync on reconnect and on resume (gap, closed).** This hook was
  // mount-fetch-then-subscribe and nothing else — the only live shared
  // surface in the app without the §11.2 refresh every other one has
  // (CharacterSheet, CombatArena, CombatHeaderBar, GmToolsWidget), for the
  // exact reason CharacterSheet's own call site states: a broadcast missed
  // while disconnected or backgrounded NEVER replays. The server draws the
  // same line and lands on the other side of it — `identity:set` answers
  // every reconnect with a fresh COMBAT snapshot, under a comment reading
  // "reconnecting is the resync", and sends no stage snapshot at all.
  //
  // So a viewer who misses a `stage:updated` has nothing that ever brings
  // them level again: they keep rendering summons at sizes and positions
  // that have since changed, with no way back short of a manual reload and
  // nothing on screen to suggest one is needed. A Player's device
  // backgrounding is routine — a phone locking on the far side of the table
  // is enough to arm it.
  //
  // Closed on the strength of that asymmetry, not on a reproduction: an
  // attempt to force the case in a headless browser could not sever the
  // live websocket (`setOffline` left it up), so this is an untested-in-
  // anger fix for a gap that is nonetheless plainly there in the code.
  const refresh = useCallback(() => {
    getStage(identity)
      .then(setStage)
      .catch(() => {});
    // The same two fields the subscribe effect below keys on — `identity`
    // itself is a fresh object literal on every render at the call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.role, identity?.characterId]);
  useSocketRefresh(refresh);

  useEffect(() => {
    let alive = true;
    getStage(identity)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.role, identity?.characterId]);

  return stage;
}

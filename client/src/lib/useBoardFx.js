import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { enqueue, heldFight, playMs } from './boardFx.js';
import { loadFxSpeed } from './sceneSettings.js';

// **Board animations (decided):** the live queue of `fight:effects` beats.
// `ready`: the stage has loaded — beats that arrive before that are never
// played (a viewer who joins or reconnects doesn't replay old ones).
// → { playing, hold(fight) }: the beat playing now, and a fighter's state as
// the board shows it (boardFx.heldFight).
export function useBoardFx(ready) {
  const [speed, setSpeed] = useState(loadFxSpeed);
  const [state, setState] = useState({ playing: null, waiting: [] });
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    const onSpeed = (e) => setSpeed(e.detail ?? loadFxSpeed());
    window.addEventListener('vtt-fx-speed', onSpeed);
    return () => window.removeEventListener('vtt-fx-speed', onSpeed);
  }, []);
  // Turned off: whatever is queued is dropped at once.
  useEffect(() => {
    if (speed === 'off') setState({ playing: null, waiting: [] });
  }, [speed]);

  useEffect(() => {
    const onEffects = (msg) => {
      if (!readyRef.current || speedRef.current === 'off') return;
      setState((s) => ({ ...s, waiting: enqueue(s.waiting, msg?.beats) }));
    };
    // A fresh connection starts clean: nothing old is replayed.
    const onConnect = () => setState({ playing: null, waiting: [] });
    socket.on('fight:effects', onEffects);
    socket.on('connect', onConnect);
    return () => {
      socket.off('fight:effects', onEffects);
      socket.off('connect', onConnect);
    };
  }, []);

  // The next beat starts when the last one ends.
  useEffect(() => {
    if (state.playing || !state.waiting.length) return;
    const [next, ...rest] = state.waiting;
    const ms = playMs(next, speedRef.current, rest.length);
    setState({ playing: { ...next, ms }, waiting: rest });
  }, [state]);
  useEffect(() => {
    if (!state.playing) return;
    const timer = setTimeout(() => setState((s) => ({ ...s, playing: null })), state.playing.ms);
    return () => clearTimeout(timer);
  }, [state.playing]);

  const hold = useCallback((fight) => heldFight(fight, state.playing, state.waiting), [state]);
  return { playing: state.playing, hold };
}

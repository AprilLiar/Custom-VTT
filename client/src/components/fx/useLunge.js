import { useEffect } from 'react';
import { useAnimate } from 'framer-motion';

// **An Action's lunge (board animations, phase 4):** `lunge` { dx, dy, ms, key }
// moves the element out toward the target and back, once per key. → the ref
// to put on the element (its transform is the lunge's).
export function useLunge(lunge) {
  const [scope, animate] = useAnimate();
  const key = lunge?.key ?? null;
  useEffect(() => {
    if (!key || !scope.current) return;
    const controls = animate(scope.current, { x: [0, lunge.dx, 0], y: [0, lunge.dy, 0] }, { duration: lunge.ms / 1000, times: [0, 0.35, 1], ease: 'easeOut' });
    return () => controls.stop();
    // Only a new lunge (its key) starts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return scope;
}

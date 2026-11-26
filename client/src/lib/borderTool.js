import { useSyncExternalStore } from 'react';

// **The Borders tool (decided, GM only):** on or off, the colour it draws and
// whether the borders it draws block range (default yes). Shared between the
// palette's button (MapTiles.jsx) and the Combat map's drawing layer
// (components/MapBorders.jsx). Not saved: it starts off on every load.
let state = { on: false, color: 'red', blocksRange: true };
const subs = new Set();
export const setBorderTool = (patch) => {
  state = { ...state, ...patch };
  for (const fn of subs) fn();
};
export const useBorderTool = () =>
  useSyncExternalStore(
    (fn) => (subs.add(fn), () => subs.delete(fn)),
    () => state
  );

export const BORDER_STYLE = {
  red: { stroke: '#ef4444', glow: 'rgba(239,68,68,0.55)', name: 'Red border', blurb: 'Nothing walks, is pushed or pulled across it. Teleports (and Swaps) pass.' },
  purple: { stroke: '#a855f7', glow: 'rgba(168,85,247,0.6)', name: 'Purple border', blurb: 'Nothing crosses it — not even a Teleport or a Swap; they must find a way round within their distance.' },
};

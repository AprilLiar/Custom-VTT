// **Free Movement on the board (phase D).** Asks the server where a fighter
// can go with their Speed (`move:reach`), and opens it as a square pick
// (lib/squarePick.js) that moves them on a tap (`move:free`); the reach is
// asked again after every move (`move:result`). `inPhase`: started from an
// Early / Late Movement phase, so Done also ends their part in it.
import { socket } from '../socket.js';
import { clearSquarePick, getSquarePick, setSquarePick } from './squarePick.js';

export function startFreeMove({ combatantId, name, inPhase = false, onError = null }) {
  const key = `move:${combatantId}`;
  const refresh = () =>
    socket.emit('move:reach', { combatantId }, (r) => {
      if (!r || r.error) {
        clearSquarePick(key);
        onError?.(r?.error === 'not now' ? 'Not your chance to move now' : 'Could not move');
        return;
      }
      setSquarePick({
        key,
        tone: 'move',
        mode: r.mode,
        title: `${name}: Free Movement`,
        combatantId,
        inPhase,
        speed: r.speed,
        fatigued: r.fatigued,
        swaps: r.swaps ?? [],
        options: r.options.map((o) => ({ ...o, label: o.id, title: `${o.cost} Speed${o.note ? ` · ${o.note}` : ''}` })),
        onPick: (id) => {
          const [col, row] = id.split(',').map(Number);
          socket.emit('move:free', { combatantId, to: { col, row } });
        },
        refresh,
      });
    });
  refresh();
}

// After a move lands, show where they can go from there.
socket.on('move:result', (r) => {
  const pick = getSquarePick();
  if (pick?.tone === 'move' && pick.combatantId === r?.combatantId) pick.refresh();
});
socket.on('stage:updated', () => {
  const pick = getSquarePick();
  if (pick?.tone === 'move') pick.refresh();
});

export function stopFreeMove(done = false) {
  const pick = getSquarePick();
  if (pick?.tone !== 'move') return;
  if (done && pick.inPhase) socket.emit('move:done', { combatantId: pick.combatantId });
  clearSquarePick(pick.key);
}

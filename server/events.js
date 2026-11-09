// **The Events tab (decided, new).** A global board of sticky notes in lanes.
//
//   - Lanes are the GM's: a name, a visibility (Everyone or GM-only) and an
//     order. Deleting one moves its notes to the first remaining lane of the
//     same visibility (or, from an Everyone lane, any lane); with none left,
//     they go with it.
//   - Notes are anyone's: short text and a colour, written straight into a
//     lane. Only the author or the GM edits or deletes one; anyone who can see
//     a note moves it — reorders it in its lane or drops it in another lane
//     they can see.
//   - A GM-only lane and its notes never reach a Player: the board is shaped
//     per viewer (`shapeBoard`) and pushed to each socket on its own.
import { all, one, run } from './db.js';

export const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'orange'];
export const NOTE_MAX = 280;
export const LANE_NAME_MAX = 60;
const VISIBILITIES = new Set(['all', 'gm']);

const isGm = (viewer) => viewer?.role === 'gm';
export const laneVisible = (lane, viewer) => Boolean(lane) && (lane.visibility === 'all' || isGm(viewer));
export const mayEditNote = (note, viewer) =>
  isGm(viewer) || (viewer?.role === 'player' && note?.author_role === 'player' && note.author_character_id === viewer.characterId);

// The board one viewer sees: lanes in order, each with its notes in order.
export function shapeBoard(lanes, notes, viewer) {
  const visible = [...lanes].sort((a, b) => a.position - b.position || a.id - b.id).filter((l) => laneVisible(l, viewer));
  return {
    lanes: visible.map((l) => ({
      id: l.id,
      name: l.name,
      visibility: l.visibility,
      notes: notes
        .filter((n) => n.lane_id === l.id)
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((n) => ({
          id: n.id,
          text: n.text,
          color: n.color,
          author: n.author_role === 'gm' ? 'GM' : (n.author_name ?? 'A player'),
          mine: mayEditNote(n, viewer),
        })),
    })),
  };
}

// `ids` with `id` taken out and put back at `index` (clamped).
export function placeAt(ids, id, index) {
  const rest = ids.filter((x) => x !== id);
  const i = Math.max(0, Math.min(rest.length, Number.isInteger(index) ? index : rest.length));
  return [...rest.slice(0, i), id, ...rest.slice(i)];
}

const loadAll = async () => ({
  lanes: await all('SELECT * FROM event_lanes'),
  notes: await all('SELECT n.*, c.name AS author_name FROM event_notes n LEFT JOIN characters c ON c.id = n.author_character_id'),
});

export async function loadBoard(viewer) {
  const { lanes, notes } = await loadAll();
  return shapeBoard(lanes, notes, viewer);
}

const cleanText = (v, max) => String(v ?? '').trim().slice(0, max);
const cleanColor = (v) => (NOTE_COLORS.includes(v) ? v : null);

export function registerEventHandlers({ on, socket, io }) {
  const viewer = () => socket.data.identity ?? null;
  // Everyone gets their own board after any change.
  const changed = async () => {
    const { lanes, notes } = await loadAll();
    for (const s of io.sockets.sockets.values()) {
      if (s.data?.identity) s.emit('events:updated', shapeBoard(lanes, notes, s.data.identity));
    }
  };
  const laneFor = async (laneId) => one('SELECT * FROM event_lanes WHERE id = ?', [Number(laneId)]);
  const noteFor = async (noteId) => one('SELECT * FROM event_notes WHERE id = ?', [Number(noteId)]);
  const renumber = async (table, ids, extra = '', args = []) => {
    for (let i = 0; i < ids.length; i++) await run(`UPDATE ${table} SET position = ?${extra} WHERE id = ?`, [i, ...args, ids[i]]);
  };
  const noteIds = async (laneId) => (await all('SELECT id FROM event_notes WHERE lane_id = ? ORDER BY position, id', [laneId])).map((r) => r.id);

  // ---- lanes (GM)
  on('event_lane:create', async ({ name, visibility }) => {
    if (!isGm(viewer())) return;
    const clean = cleanText(name, LANE_NAME_MAX);
    if (!clean) return;
    const last = await one('SELECT MAX(position) AS p FROM event_lanes');
    await run('INSERT INTO event_lanes (name, visibility, position) VALUES (?, ?, ?)', [clean, VISIBILITIES.has(visibility) ? visibility : 'all', (last?.p ?? -1) + 1]);
    await changed();
  });
  on('event_lane:update', async ({ laneId, name, visibility }) => {
    if (!isGm(viewer())) return;
    const lane = await laneFor(laneId);
    if (!lane) return;
    const nextName = name === undefined ? lane.name : cleanText(name, LANE_NAME_MAX) || lane.name;
    const nextVis = VISIBILITIES.has(visibility) ? visibility : lane.visibility;
    await run('UPDATE event_lanes SET name = ?, visibility = ? WHERE id = ?', [nextName, nextVis, lane.id]);
    await changed();
  });
  // Up or down one place (`toIndex`: where it should end up).
  on('event_lane:move', async ({ laneId, toIndex }) => {
    if (!isGm(viewer())) return;
    const lane = await laneFor(laneId);
    if (!lane) return;
    const ids = (await all('SELECT id FROM event_lanes ORDER BY position, id')).map((r) => r.id);
    await renumber('event_lanes', placeAt(ids, lane.id, Number(toIndex)));
    await changed();
  });
  on('event_lane:delete', async ({ laneId }) => {
    if (!isGm(viewer())) return;
    const lane = await laneFor(laneId);
    if (!lane) return;
    const others = (await all('SELECT * FROM event_lanes WHERE id != ? ORDER BY position, id', [lane.id]));
    // Same visibility first; an Everyone lane's notes may go anywhere (hiding
    // them is safe), a GM-only lane's never into an Everyone lane.
    const target = others.find((l) => l.visibility === lane.visibility) ?? (lane.visibility === 'all' ? others[0] : null);
    if (target) {
      const moving = await noteIds(lane.id);
      await renumber('event_notes', [...(await noteIds(target.id)), ...moving], ', lane_id = ?', [target.id]);
    }
    await run('DELETE FROM event_notes WHERE lane_id = ?', [lane.id]);
    await run('DELETE FROM event_lanes WHERE id = ?', [lane.id]);
    await changed();
  });

  // ---- notes (anyone who sees the lane)
  on('event_note:create', async ({ laneId, text, color }) => {
    const v = viewer();
    const lane = await laneFor(laneId);
    const clean = cleanText(text, NOTE_MAX);
    if (!v || !laneVisible(lane, v) || !clean) return;
    const last = await one('SELECT MAX(position) AS p FROM event_notes WHERE lane_id = ?', [lane.id]);
    await run('INSERT INTO event_notes (lane_id, text, color, position, author_role, author_character_id) VALUES (?, ?, ?, ?, ?, ?)', [
      lane.id,
      clean,
      cleanColor(color) ?? 'yellow',
      (last?.p ?? -1) + 1,
      isGm(v) ? 'gm' : 'player',
      isGm(v) ? null : (v.characterId ?? null),
    ]);
    await changed();
  });
  on('event_note:update', async ({ noteId, text, color }) => {
    const v = viewer();
    const note = await noteFor(noteId);
    if (!note || !mayEditNote(note, v) || !laneVisible(await laneFor(note.lane_id), v)) return;
    const nextText = text === undefined ? note.text : cleanText(text, NOTE_MAX) || note.text;
    await run('UPDATE event_notes SET text = ?, color = ? WHERE id = ?', [nextText, cleanColor(color) ?? note.color, note.id]);
    await changed();
  });
  on('event_note:delete', async ({ noteId }) => {
    const v = viewer();
    const note = await noteFor(noteId);
    if (!note || !mayEditNote(note, v) || !laneVisible(await laneFor(note.lane_id), v)) return;
    await run('DELETE FROM event_notes WHERE id = ?', [note.id]);
    await changed();
  });
  // Reorder in its lane, or move it into another lane (both must be visible).
  on('event_note:move', async ({ noteId, laneId, index }) => {
    const v = viewer();
    const note = await noteFor(noteId);
    const to = await laneFor(laneId);
    if (!note || !to || !laneVisible(await laneFor(note.lane_id), v) || !laneVisible(to, v)) return;
    if (to.id !== note.lane_id) {
      const left = (await noteIds(note.lane_id)).filter((id) => id !== note.id);
      await renumber('event_notes', left);
    }
    await renumber('event_notes', placeAt(await noteIds(to.id), note.id, Number(index)), ', lane_id = ?', [to.id]);
    await changed();
  });
}

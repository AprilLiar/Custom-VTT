import { useEffect, useState } from 'react';
import { socket } from '../socket.js';

// **A list kept in memory for the whole session (play feedback 8).** The
// Scene tab's drawers refetched their lists (Scenes, folders, actors) every
// time they opened, and every Scene event refetched the whole Scene list. A
// liveList loads once, on first use, and stays live from the socket events
// that already exist: a payload that carries the row is applied in place
// (`upsert`), a delete drops it by id (`remove`: [event, key]), anything
// else reloads it (`refetch`), and a reconnect reloads it (a missed event
// never replays). Every component using it shares the one copy.
//
// → a hook: useThatList() → the list, or null until the first load lands.
export function liveList({ load, upsert = [], remove = [], refetch = [], merge = false, sort = null }) {
  let data = null;
  let loading = null;
  let wired = false;
  const subs = new Set();
  const set = (next) => {
    data = sort ? [...next].sort(sort) : next;
    for (const fn of subs) fn(data);
  };
  const reload = () => {
    loading ??= load()
      .then(set)
      .catch(console.error)
      .finally(() => {
        loading = null;
      });
    return loading;
  };
  const wire = () => {
    if (wired) return;
    wired = true;
    for (const ev of upsert) {
      socket.on(ev, (row) => {
        if (row?.id == null) return reload();
        if (!data) return;
        const i = data.findIndex((r) => r.id === row.id);
        // (A partial update of a row not held yet: reload rather than add half a row.)
        if (i < 0 && merge) return reload();
        set(i < 0 ? [...data, row] : data.map((r, j) => (j === i ? (merge ? { ...r, ...row } : row) : r)));
      });
    }
    for (const [ev, key] of remove) socket.on(ev, (p) => data && set(data.filter((r) => r.id !== p?.[key])));
    for (const ev of refetch) socket.on(ev, reload);
    socket.on('connect', () => data && reload());
  };
  return function useLiveList() {
    const [value, setValue] = useState(data);
    useEffect(() => {
      subs.add(setValue);
      wire();
      if (data == null) reload();
      else setValue(data);
      return () => {
        subs.delete(setValue);
      };
    }, []);
    return value;
  };
}

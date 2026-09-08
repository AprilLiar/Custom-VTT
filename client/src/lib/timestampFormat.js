// Formats a Timestamp's own `date` (server: scene_timestamps.date, an ISO
// 'YYYY-MM-DD' string — the exact shape an `<input type="date">` produces)
// into the display form used everywhere a Timestamp's date is actually
// shown: SceneTimestampDialog.jsx's own compact grid card and
// TimestampCutscene.jsx's big bold played text.
//
// `Date.UTC` + `timeZone: 'UTC'` together, not just a bare `new
// Date(iso)`: parsing a plain 'YYYY-MM-DD' string already lands on UTC
// midnight, but formatting it back out WITHOUT pinning the timezone
// converts to the viewer's own local time first — which silently shifts
// the displayed date a day EARLIER for anyone west of UTC. Both ends have
// to agree on UTC for the calendar date typed into the editor to be the
// exact same one shown back, on every viewer's own clock.
export function formatTimestampDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Frame data strip: adjoining squares — Startup yellow, Active red,
// Recovery blue. Renders exactly startup+active+recovery squares.
const SEGMENTS = [
  { key: 'startup', className: 'bg-yellow-500' },
  { key: 'active', className: 'bg-red-500' },
  { key: 'recovery', className: 'bg-blue-500' },
];

export default function FrameBar({ startup, active, recovery, size = 'h-3.5 w-3.5' }) {
  const counts = { startup, active, recovery };
  return (
    <span className="inline-flex" title={`Startup ${startup} · Active ${active} · Recovery ${recovery}`}>
      {SEGMENTS.flatMap(({ key, className }) =>
        Array.from({ length: counts[key] ?? 0 }, (_, i) => (
          <span
            key={`${key}-${i}`}
            className={`${size} ${className} border border-zinc-900 first:rounded-l-sm last:rounded-r-sm`}
          />
        ))
      )}
    </span>
  );
}

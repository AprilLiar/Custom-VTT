// **Protect the VIP (decided):** a small golden crown with "VIP" beside it,
// floating just above a VIP's token (the map) or figure (a lane). `x`, `y`:
// the point it sits on (stage pixels — the crown's bottom middle); `size`:
// the token's diameter, which it scales with.
export default function VipCrown({ x, y, size = 48, zIndex = 13 }) {
  const h = Math.max(12, Math.min(26, size * 0.32));
  const w = h * 1.35;
  return (
    <div
      className="vip-crown pointer-events-none absolute flex -translate-x-1/2 -translate-y-full items-center gap-0.5"
      style={{ left: x, top: y, zIndex }}
      aria-label="VIP"
    >
      <svg width={w} height={h} viewBox="0 0 27 20" aria-hidden>
        <path d="M2 17 L4 6 L9.5 11 L13.5 2.5 L17.5 11 L23 6 L25 17 Z" fill="#facc15" stroke="#78350f" strokeWidth="1.4" strokeLinejoin="round" />
        <rect x="2" y="16" width="23" height="3" rx="1" fill="#eab308" stroke="#78350f" strokeWidth="1.2" />
        <circle cx="13.5" cy="2.6" r="1.6" fill="#fde68a" stroke="#78350f" strokeWidth="0.8" />
        <circle cx="4" cy="6" r="1.3" fill="#fde68a" stroke="#78350f" strokeWidth="0.8" />
        <circle cx="23" cy="6" r="1.3" fill="#fde68a" stroke="#78350f" strokeWidth="0.8" />
      </svg>
      <span
        className="font-display font-bold uppercase leading-none tracking-wide text-yellow-300"
        style={{ fontSize: Math.max(9, h * 0.62), textShadow: '0 0 2px #000, 0 1px 2px #000' }}
      >
        VIP
      </span>
    </div>
  );
}

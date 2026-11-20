// **Protect the VIP (decided, revised):** a small golden crown with "VIP"
// beside it, under the fighter's HP bar (FighterOverlay — above the token it
// covered the tokens they hold). `size`: the token's diameter, which it scales with.
export default function VipCrown({ size = 48 }) {
  const h = Math.max(11, Math.min(20, size * 0.28));
  const w = h * 1.35;
  return (
    <div className="vip-crown pointer-events-none flex items-center gap-0.5" aria-label="VIP">
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

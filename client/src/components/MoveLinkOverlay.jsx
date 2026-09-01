import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { clearLink, getLinkAnchor } from '../lib/attackTelegraph.js';
import useMoveLink from '../lib/useMoveLink.js';

// The connector between a declared attack's Tell card and the glowing Tic
// where its Startup begins (Attack telegraph — see attackTelegraph.js).
//
// Portalled to <body> deliberately: both endpoints sit inside subtrees full
// of transforms, clip-paths and Framer Motion wrappers, every one of which
// opens a stacking context — a line drawn inside either of them would be
// clipped by its own ancestors and would lose the z-order race against the
// other. At <body> with fixed positioning there is nothing left to lose to.
//
// Positions are read at draw time rather than stored, because both ends
// move: the Tic strip is its own horizontal scroller, the lanes reflow, and
// the page scrolls under both.

// Where the line should meet a box: the point on the box's border along the
// ray towards the other end, so the line stops cleanly at the card/square
// edge instead of burying its tip in the middle of it.
function edgePoint(rect, towardsX, towardsY) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = towardsX - cx;
  const dy = towardsY - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scaleX = dx ? rect.width / 2 / Math.abs(dx) : Infinity;
  const scaleY = dy ? rect.height / 2 / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

const onScreen = (r) =>
  r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;

function measure(ids) {
  const segments = [];
  for (const id of ids) {
    const tellEl = getLinkAnchor('tell', id);
    const ticEl = getLinkAnchor('tic', id);
    // Both ends have to be on screen for a line to mean anything — a Tell
    // whose Tic scrolled out of the strip (or vice versa) simply draws
    // nothing rather than a line running off to a guessed position.
    if (!tellEl || !ticEl) continue;
    const tell = tellEl.getBoundingClientRect();
    const tic = ticEl.getBoundingClientRect();
    if (!tell.width || !tic.width) continue;
    // Scrolling either end out of the viewport drops the line rather than
    // running it off the edge of the screen towards something the reader
    // can no longer see — which reads as pointing at nothing, or worse, at
    // whatever now sits where the anchor used to be.
    if (!onScreen(tell) || !onScreen(tic)) continue;
    const tellCenter = { x: tell.left + tell.width / 2, y: tell.top + tell.height / 2 };
    const ticCenter = { x: tic.left + tic.width / 2, y: tic.top + tic.height / 2 };
    const from = edgePoint(tell, ticCenter.x, ticCenter.y);
    const to = edgePoint(tic, tellCenter.x, tellCenter.y);
    // **Never a Fool.** The Tic anchor is the glow element itself, and it
    // carries `data-feint` when this viewer's Perk has marked the move — so the
    // line is drawn in the same red as the square it lands on, with no second
    // registry to keep in step with the first. Absent for every other viewer,
    // because the attribute is only rendered for the one who earned it.
    segments.push({ id, from, to, feint: ticEl.dataset.feint != null });
  }
  return segments;
}

export default function MoveLinkOverlay() {
  const { ids } = useMoveLink();
  const [segments, setSegments] = useState([]);

  useEffect(() => {
    if (!ids.length) {
      setSegments([]);
      return undefined;
    }
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      // One frame late on purpose: a tap that pins the link can also flip a
      // card or scroll the current Tic into view, and measuring before that
      // settles would anchor the line to where things used to be.
      frame = requestAnimationFrame(() => setSegments(measure(ids)));
    };
    remeasure();
    // `true` = capture phase, so this also catches the Tic strip's own
    // horizontal scroller and the page shell's scroll container, neither of
    // which bubbles a scroll event to window.
    window.addEventListener('scroll', remeasure, true);
    window.addEventListener('resize', remeasure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', remeasure, true);
      window.removeEventListener('resize', remeasure);
    };
  }, [ids]);

  // A pinned link (tap-to-toggle, the touch path) needs a way out that
  // isn't "find the exact same 44px square again" — tapping anywhere else
  // drops it. Hover links clear themselves on mouse-out and never get here.
  useEffect(() => {
    if (!ids.length) return undefined;
    const onPointerDown = (e) => {
      if (e.target.closest?.('[data-move-link-anchor]')) return;
      clearLink();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [ids]);

  if (!segments.length) return null;

  return createPortal(
    <svg
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[70] h-full w-full"
      // Viewport coordinates straight from getBoundingClientRect, so the
      // SVG user space has to be the viewport too.
      style={{ overflow: 'visible' }}
    >
      {segments.map(({ id, from, to, feint }) => {
        const stroke = feint ? 'rgb(253 164 175)' : 'rgb(228 228 231)';
        return (
        <g key={id}>
          {/* Drawn twice: a wide, very transparent pass reads as a glow
              around the thin one, which keeps the line legible over both
              the near-black arena and a bright portrait without needing an
              SVG filter (filters on a fixed full-screen surface repaint the
              whole thing on every scroll tick). */}
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={stroke}
            strokeOpacity="0.18"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={stroke}
            strokeOpacity="0.75"
            strokeWidth="1.5"
            strokeDasharray="5 4"
            strokeLinecap="round"
          />
          <circle cx={from.x} cy={from.y} r="3" fill={stroke} fillOpacity="0.85" />
          <circle cx={to.x} cy={to.y} r="3" fill={stroke} fillOpacity="0.85" />
        </g>
        );
      })}
    </svg>,
    document.body
  );
}

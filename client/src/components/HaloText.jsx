// **Text always wins.** Names, nicknames and (from Phase 4) relationship labels
// are never overlapped by anything on the board.
//
// The mechanism is one CSS property. Each string sits in a rectangle sized to
// fit it, and that rectangle carries a `backdrop-filter` — so whatever passes
// *behind* the box is blurred and faded to near-nothing while the text itself
// stays perfectly sharp on top. It costs the same at one node as at a hundred,
// which a proximity-based approach (measuring every line against every label
// each frame) emphatically would not.
//
// **The fallback is not optional.** `backdrop-filter` inside a `transform`ed
// ancestor is a genuine browser minefield: it establishes its own containing
// block and stacking context, and engines disagree about what "the backdrop"
// even is under a scaled parent. The scrim below is painted unconditionally, so
// where the blur is dropped the text is still legible against a solid ground —
// only the softness is lost, never the readability.
//
// Rendered in a layer that paints LAST inside the world transform, so its
// backdrop is everything already drawn: the edges, the portraits, the dots.

export default function HaloText({
  children,
  className = '',
  // Below the board's text-visible zoom the label is too small to read, and a
  // label nobody can read should not still be blurring things behind it.
  hidden = false,
  as: Tag = 'span',
}) {
  if (hidden || children == null || children === '') return null;
  return (
    <Tag
      className={`pointer-events-none relative inline-block max-w-full px-1.5 py-0.5 ${className}`}
      style={{
        backdropFilter: 'blur(7px) opacity(0.2)',
        WebkitBackdropFilter: 'blur(7px) opacity(0.2)',
        // The void's own colour at low alpha. This is what keeps the text
        // readable when the filter above is ignored.
        backgroundColor: 'rgba(21,23,27,0.55)',
      }}
    >
      {children}
    </Tag>
  );
}

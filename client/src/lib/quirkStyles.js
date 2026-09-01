// **The two sides of a Quirk, in one place.**
//
// A Quirk is positive or negative and nothing else, and that side is carried by
// colour: a green tint for a positive, a red one for a negative. Three surfaces
// draw them — the Compendium's shelf, the character sheet's tab, and the
// Creator's step — and the tint has to be the same green in all three or the
// reader learns three different codes. So the classes live here rather than
// being typed out per surface, the same call `framePhaseColors.js` already
// makes for the frame palette.
//
// **Literal emerald/rose, deliberately not `brand-*`.** The brand hue is
// runtime-overridable (`applyBrandHue`), and a world themed green would repaint
// every negative Quirk to match its positives. Positive/negative is a fact
// about the Quirk, not about the world's colour scheme.
//
// **"Without obstructing the text"** is the ask, in those words, and it is what
// sets the numbers: the background sits at ~8% opacity over the near-black
// panel, which is enough to read the card's side off at a glance from across
// the table and not enough to lift the ground under 14px body text. The border
// carries most of the signal instead — an edge can be saturated without
// touching contrast, because nothing is written on it.

export const QUIRK_KINDS = ['positive', 'negative'];

export const quirkKind = (value) => (value === 'negative' ? 'negative' : 'positive');

const STYLES = {
  positive: {
    label: 'Positive',
    // The card itself.
    card: 'border-emerald-800/70 bg-emerald-950/[0.28]',
    // The column heading above a list of them.
    heading: 'text-emerald-300',
    // A chip, for the Creator's picked list and the sheet's counts.
    chip: 'border-emerald-700/70 bg-emerald-950/40 text-emerald-200',
    // The selected state of a positive/negative toggle.
    toggleOn: 'border-emerald-500 bg-emerald-600/25 text-emerald-200',
    // A whole column's own frame, so an empty column still reads as the
    // positive one rather than as blank space.
    column: 'border-emerald-900/50 bg-emerald-950/[0.12]',
  },
  negative: {
    label: 'Negative',
    card: 'border-rose-900/70 bg-rose-950/[0.28]',
    heading: 'text-rose-300',
    chip: 'border-rose-800/70 bg-rose-950/40 text-rose-200',
    toggleOn: 'border-rose-500 bg-rose-600/25 text-rose-200',
    column: 'border-rose-900/50 bg-rose-950/[0.12]',
  },
};

export const quirkStyle = (kind) => STYLES[quirkKind(kind)];

// Split a flat list into the two columns the layout always wants, in one place
// so no surface has to remember which side goes left.
export function splitQuirks(quirks) {
  const list = quirks ?? [];
  return {
    positive: list.filter((q) => quirkKind(q.kind) === 'positive'),
    negative: list.filter((q) => quirkKind(q.kind) === 'negative'),
  };
}

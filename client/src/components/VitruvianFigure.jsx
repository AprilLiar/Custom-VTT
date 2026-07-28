import vitruvianMan from '../assets/vitruvian-man.png';

// Backdrop for Tab 1's dice pool. The default source art is black ink on
// white, so it's inverted (white line-work) and dimmed to sit as a faint
// watermark behind the dark theme rather than competing with the actual die
// widgets, which are positioned over it via ANATOMY in CoreStatsTab.jsx. A
// GM-uploaded customSrc (see the upload button in CoreStatsTab.jsx) replaces
// it per-character — that art could be anything (a full-color piece, a
// photo), so it's only dimmed via opacity, not run through the same
// invert/brightness filter tuned specifically for the default line art.
export default function VitruvianFigure({ className = '', customSrc }) {
  if (customSrc) {
    return (
      <img
        src={customSrc}
        alt=""
        aria-hidden="true"
        className={`${className} select-none object-contain opacity-30`}
        draggable={false}
      />
    );
  }
  return (
    <img
      src={vitruvianMan}
      alt=""
      aria-hidden="true"
      className={`${className} select-none object-contain opacity-25 [filter:invert(1)_brightness(0.75)]`}
      draggable={false}
    />
  );
}

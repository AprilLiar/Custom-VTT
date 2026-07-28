import vitruvianMan from '../assets/vitruvian-man.png';

// Backdrop for Tab 1's dice pool. The source art is black ink on white, so
// it's inverted (white line-work) and dimmed to sit as a faint watermark
// behind the dark theme rather than competing with the actual die widgets,
// which are positioned over it via ANATOMY in CoreStatsTab.jsx.
export default function VitruvianFigure({ className = '' }) {
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

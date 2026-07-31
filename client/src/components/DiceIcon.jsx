// Small polyhedral-dice silhouettes for the chat Dice Tray (item 1) and the
// Move Creator's Custom Roll die-size picker (item 2) — this app has no
// d4/d8/d10/d12 icon set to draw from (lucide-react only ships pip-based d6
// faces), and a plain shape-per-size outline with the size numeral inside
// reads clearly even at "just an icon" button scale, so it's drawn inline
// here rather than fetched from anywhere.
const SHAPES = {
  4: '12,3 21,20 3,20',
  6: '4,4 20,4 20,20 4,20',
  8: '12,2 22,12 12,22 2,12',
  10: '12,2 19,9 15,22 9,22 5,9',
  12: '12,2 21.5,8.9 17.9,20.1 6.1,20.1 2.5,8.9',
};

export default function DiceIcon({ size, className = 'h-4 w-4' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinejoin="round"
    >
      <polygon points={SHAPES[size]} />
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="9"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        {size}
      </text>
    </svg>
  );
}

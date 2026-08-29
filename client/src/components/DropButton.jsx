// "I do not want this any more" — a Player removing something from their own
// sheet.
//
// **The other half of self-granting.** Players can take Moves and Perks for
// themselves from the Compendium, and could put them back down there too — but
// only there, which meant noticing something unwanted on your sheet and then
// going to the library to find it again. This is the same act, offered where
// you actually notice you want it.
//
// Shared by the Moves and Perks tabs so the two cannot drift apart on wording
// or on the touch target: `min-h-11` is the app's phone-sized tap target and
// collapses on desktop, the same shape every other card action uses.
//
// **No confirmation, deliberately.** It matches the Compendium's own Forget and
// Drop, which are one click; the GM's Revoke on somebody ELSE's sheet keeps its
// `window.confirm`, because that is a different act — undoing another person's
// choice rather than your own.
export default function DropButton({ label, title, onClick }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex min-h-11 items-center panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400 md:min-h-0"
    >
      {label}
    </button>
  );
}

// **Copies on the board (full automation, phase E — book p.71).** A Copy is
// a replica of its Original: drawn as the Original's picture, faded, in a
// dashed ring, with "Copy" under it. `copies`: tiles of kind 'copy' ({ col,
// row, owner_id }, stored squares); `quadOf(col, row)`: the square's polygon
// in stage pixels; `ownerOf(combatantId)`: { name, image_url } or null.
export default function CopyLayer({ copies, quadOf, ownerOf, zIndex = 9 }) {
  if (!copies.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex }} aria-hidden>
      {copies.map((c, i) => {
        const q = quadOf(c.col, c.row);
        if (!q) return null;
        const xs = q.map((p) => p[0]);
        const ys = q.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        const size = Math.max(14, Math.min(w, h) * 0.82);
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
        const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
        const owner = ownerOf(c.owner_id);
        return (
          <div key={`${c.col},${c.row},${i}`} className="absolute flex flex-col items-center" style={{ left: cx - size / 2, top: cy - size / 2, width: size }} title={owner ? `${owner.name}'s Copy` : 'Copy'}>
            <div className="overflow-hidden rounded-full border-2 border-dashed border-violet-300 bg-zinc-900/70 opacity-60" style={{ width: size, height: size }}>
              {owner?.image_url ? (
                <img src={owner.image_url} alt="" className="h-full w-full object-cover grayscale-[40%]" draggable={false} />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-xs font-bold uppercase text-violet-200">{(owner?.name ?? '?').slice(0, 1)}</span>
              )}
            </div>
            <span className="-mt-1 rounded-sm bg-violet-950/90 px-1 font-display text-[9px] font-bold uppercase leading-tight text-violet-200">Copy</span>
          </div>
        );
      })}
    </div>
  );
}

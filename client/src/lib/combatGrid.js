// The Combat map's square grid (Panic at the Dojo, Phase 3). Pure and shared:
// the server uses it to validate and swap placements, the client to draw.
//
// **Everything is in the map image's own pixels** (decided), so a 70px square
// means 70 pixels of the picture and lines up with squares painted on the map
// for every viewer, whatever their screen. A token's position is a CELL
// (col, row) of this grid, so moving or resizing the grid moves the tokens
// with it.
//
// The grid is drawn only inside a 10% padding of the image (decided): lines
// simply stop at that inner rectangle, even where that cuts a square short.
// A cell can hold a token when its centre lies inside the inner rectangle.

export const GRID_DEFAULTS = Object.freeze({ size: 70, offsetX: 0, offsetY: 0, opacity: 0.6 });
export const GRID_SIZE_MIN = 8;
export const GRID_SIZE_MAX = 400;
export const GRID_OFFSET_LIMIT = 400;
export const GRID_PADDING = 0.1;

const clampNum = (n, lo, hi, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

// A grid as stored on a Scene, cleaned.
export function normalizeGrid(g = {}) {
  return {
    size: Math.round(clampNum(g.size, GRID_SIZE_MIN, GRID_SIZE_MAX, GRID_DEFAULTS.size)),
    offsetX: Math.round(clampNum(g.offsetX, -GRID_OFFSET_LIMIT, GRID_OFFSET_LIMIT, GRID_DEFAULTS.offsetX)),
    offsetY: Math.round(clampNum(g.offsetY, -GRID_OFFSET_LIMIT, GRID_OFFSET_LIMIT, GRID_DEFAULTS.offsetY)),
    opacity: clampNum(g.opacity, 0, 1, GRID_DEFAULTS.opacity),
  };
}

// The rectangle the grid lives in: the image minus a 10% border.
export function innerRect(width, height) {
  return {
    x0: width * GRID_PADDING,
    y0: height * GRID_PADDING,
    x1: width * (1 - GRID_PADDING),
    y1: height * (1 - GRID_PADDING),
  };
}

// Positions of the grid lines that fall inside the inner rectangle, in image
// pixels: every `offset + k * size`. The rectangle's own edges are drawn too,
// so the grid always has a frame.
export function gridLines(width, height, grid) {
  const { x0, y0, x1, y1 } = innerRect(width, height);
  const along = (lo, hi, offset, size) => {
    const out = [];
    let k = Math.ceil((lo - offset) / size);
    for (let v = offset + k * size; v <= hi + 1e-9; k++, v = offset + k * size) {
      if (v > lo + 1e-9 && v < hi - 1e-9) out.push(v);
    }
    return [lo, ...out, hi];
  };
  return { xs: along(x0, x1, grid.offsetX, grid.size), ys: along(y0, y1, grid.offsetY, grid.size), rect: { x0, y0, x1, y1 } };
}

export const cellCenter = (grid, col, row) => ({
  x: grid.offsetX + (col + 0.5) * grid.size,
  y: grid.offsetY + (row + 0.5) * grid.size,
});

export const cellAt = (grid, x, y) => ({
  col: Math.floor((x - grid.offsetX) / grid.size),
  row: Math.floor((y - grid.offsetY) / grid.size),
});

// Whether a cell can hold a token: its centre is inside the inner rectangle.
export function cellInside(width, height, grid, col, row) {
  if (!Number.isInteger(col) || !Number.isInteger(row)) return false;
  const { x0, y0, x1, y1 } = innerRect(width, height);
  const c = cellCenter(grid, col, row);
  return c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1;
}

// The square a cell covers, clipped to the inner rectangle — what the drop
// highlight fills.
export function cellRect(width, height, grid, col, row) {
  const { x0, y0, x1, y1 } = innerRect(width, height);
  const left = Math.max(x0, grid.offsetX + col * grid.size);
  const top = Math.max(y0, grid.offsetY + row * grid.size);
  const right = Math.min(x1, grid.offsetX + (col + 1) * grid.size);
  const bottom = Math.min(y1, grid.offsetY + (row + 1) * grid.size);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// Where the map image sits in a stage of the given size: scaled to fit whole
// ("contain"), centred in the space left between any docked drawers.
export function fitImage(stageWidth, stageHeight, width, height, inset = { left: 0, right: 0 }) {
  const left = inset.left || 0;
  const usable = Math.max(1, stageWidth - left - (inset.right || 0));
  if (!width || !height) return { left, top: 0, scale: 1, width: 0, height: 0 };
  const scale = Math.min(usable / width, stageHeight / height);
  return {
    scale,
    width: width * scale,
    height: height * scale,
    left: left + (usable - width * scale) / 2,
    top: (stageHeight - height * scale) / 2,
  };
}

// Moving a placed token to a cell. `tokens` is [{ id, col, row }]. Returns the
// list of { id, col, row } to save: the mover, plus whoever stood on the target
// (swapped into the mover's old cell). A token placed fresh (`fromCell` null)
// cannot swap, so an occupied target refuses it — returns null.
export function moveToken(tokens, id, col, row) {
  const mover = tokens.find((t) => t.id === id);
  if (!mover) return null;
  if (mover.col === col && mover.row === row) return [];
  const occupant = tokens.find((t) => t.id !== id && t.col === col && t.row === row);
  const changes = [{ id, col, row }];
  if (occupant) changes.push({ id: occupant.id, col: mover.col, row: mover.row });
  return changes;
}

export const cellTaken = (tokens, col, row) => tokens.some((t) => t.col === col && t.row === row);

// An image's pixel size from its bytes (PNG, JPEG, WebP, GIF) — enough for the
// combat map's playable bounds (full automation phase D: the server must know
// where the arena's edge, and the Outside, are). No dependencies.
//
// imageSize(buffer) → { width, height } | null
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: the IHDR chunk.
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // GIF: the logical screen.
  if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  // JPEG: the first Start Of Frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

// The cells whose centre lies inside the map's inner rectangle (combatGrid.js
// `cellInside`), as a rectangle of columns and rows — or null when unknown.
export function cellBounds(width, height, grid, padding = 0.1) {
  if (!width || !height || !grid?.size) return null;
  const x0 = width * padding;
  const x1 = width * (1 - padding);
  const y0 = height * padding;
  const y1 = height * (1 - padding);
  const lo = (v0, off) => Math.ceil((v0 - off) / grid.size - 0.5);
  const hi = (v1, off) => Math.floor((v1 - off) / grid.size - 0.5);
  const b = { colMin: lo(x0, grid.offsetX), colMax: hi(x1, grid.offsetX), rowMin: lo(y0, grid.offsetY), rowMax: hi(y1, grid.offsetY) };
  return b.colMax >= b.colMin && b.rowMax >= b.rowMin ? b : null;
}

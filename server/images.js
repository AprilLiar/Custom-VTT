// Where a stored picture lives, and what its URL is.
//
// **This file is the hosting bill's second act.** The first (see
// server/payloads.js) stopped broadcasting pictures nobody had asked for. This
// one stops shipping them inside JSON at all: a row goes out carrying a URL,
// and the browser fetches the bytes once and caches them forever.
//
// That "forever" is the whole trick, and it is why the URL carries a **content
// hash**. A cache that must be revalidated still costs one conditional request
// per image per page load — on a phone opening a roster of thirty portraits,
// that is thirty round trips to a sleepy free-tier dyno just to be told nothing
// changed. A hash in the path means a changed picture is a *different URL*, so
// the old one can be `immutable` for a year and a re-upload is picked up
// instantly with no invalidation logic anywhere. The stale-image-after-upload
// failure mode is not merely unlikely here, it is unrepresentable.
import { createHash } from 'node:crypto';

// **One registry, nine tables, ten columns.** Every image in the schema is
// reachable through this map and nothing else, which is what lets the route
// below be a single handler rather than ten near-identical ones drifting apart
// on cache headers — and what makes `kind` a KEY LOOKUP rather than a fragment
// spliced into SQL. Only identifiers written out here ever reach a statement.
export const IMAGE_KINDS = Object.freeze({
  character: { table: 'characters', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  // The GM's optional replacement for the Core Stats backdrop figure — a second
  // image column on the same row, hence its own kind rather than its own table.
  'character-art': {
    table: 'characters',
    data: 'vitruvian_image_data',
    mime: 'vitruvian_image_mime_type',
    hash: 'vitruvian_image_hash',
  },
  chat: { table: 'chat_log', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  tell: { table: 'tells', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  move: { table: 'moves', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  perk: { table: 'perks', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  person: { table: 'relationship_people', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  'temp-npc': { table: 'temp_npcs', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  scene: { table: 'scenes', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
  'scene-picture': { table: 'scene_pictures', data: 'image_data', mime: 'image_mime_type', hash: 'image_hash' },
});

// Derived rather than written twice, so db.js's migration and backfill can
// never drift out of agreement with the router.
export const IMAGE_COLUMNS = Object.values(IMAGE_KINDS);

export const imageSpec = (kind) =>
  Object.hasOwn(IMAGE_KINDS, String(kind)) ? IMAGE_KINDS[String(kind)] : null;

// 16 base64url characters is 96 bits. This is a **cache key, not a checksum** —
// it has to be stable and not collide across one campaign's pictures, and 96
// bits is absurdly more than enough for that. Hashed over the base64 text
// rather than the decoded bytes because the text is what we are already
// holding; decoding first would buy nothing.
export function hashImageData(base64) {
  if (!base64) return null;
  return createHash('sha256').update(String(base64)).digest('base64url').slice(0, 16);
}

// **A row whose hash has not been filled in yet still has to render.** The boot
// backfill (see db.js) runs before the server accepts a request, so this is
// belt-and-braces rather than the common path — but a picture that 404s because
// of a migration is a worse failure than one that simply isn't cached, so an
// unhashed row gets this sentinel and the route serves it `no-store`.
export const LIVE = 'live';

// `present` lets a caller say "there IS a picture here" without having selected
// the bytes — which is the entire point of the hash columns, since the hot
// paths (buildStagePayload, GET /api/chat) now select neither.
export function imageUrl(kind, id, { data = null, hash = null, present } = {}) {
  const exists = present !== undefined ? Boolean(present) : Boolean(data);
  if (!exists || id == null || !imageSpec(kind)) return null;
  return `/api/img/${kind}/${id}/${hash || (data ? hashImageData(data) : LIVE)}`;
}

// **Never serve the stored mime unfiltered.**
//
// As a `data:` URI inside an `<img>`, a user-uploaded blob is inert. Served
// from our OWN origin it is whatever content type the row says it is, and every
// write path in this app takes that string straight off the wire. This app has
// **no auth by design** (see CLAUDE.md), so "only the GM uploads" is not a
// defence: anyone with the link can store `text/html` and get a same-origin
// document at a stable URL. That is stored XSS, and it is created by giving
// these bytes a URL — so the allow-list ships with the route, not after it.
//
// Anything unrecognised is served as a download that will not open, rather than
// refused: a picture with an odd mime should look broken, not take a page down.
const SERVABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
export const servableMime = (mime) => (SERVABLE.has(mime) ? mime : 'application/octet-stream');

// The same allow-list on the way IN, so a hostile value never reaches a column.
// Write paths fall back to their own sensible default rather than to a
// hardcoded one here — a Scene backdrop and a 128px move icon disagree about
// what "probably" means.
export const sanitizeImageMime = (mime, fallback = 'image/jpeg') =>
  SERVABLE.has(mime) ? mime : fallback;

// ---------------------------------------------------------------- row shaping
//
// Curried so they read point-free in a `.map()`, the way omitVitruvianArt did
// before them.

// A row goes out with a link to its picture instead of the picture. The mime
// goes too — `Content-Type` on the response carries it now, and leaving it
// behind only invites somebody to reassemble a `data:` URI from half a row.
export const withImageUrl = (kind) => (row) => {
  if (!row) return row;
  const { image_data, image_mime_type, image_hash, ...rest } = row;
  const url = imageUrl(kind, row.id, { data: image_data, hash: image_hash });
  return url ? { ...rest, image_url: url } : rest;
};

// **This replaces omitVitruvianArt rather than joining it.** That helper existed
// because the Tab 1 backdrop was too heavy to include in a list; at ~60 bytes a
// URL it now rides everywhere, so the single-character endpoint stops being the
// only place it can come from.
export const shapeCharacter = (row) => {
  if (!row) return row;
  const { vitruvian_image_data, vitruvian_image_mime_type, vitruvian_image_hash, ...rest } =
    withImageUrl('character')(row);
  const url = imageUrl('character-art', row.id, {
    data: vitruvian_image_data,
    hash: vitruvian_image_hash,
  });
  return url ? { ...rest, vitruvian_image_url: url } : rest;
};

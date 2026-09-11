// The image-transport registry and URL builders.
//
// Two of these tests are about money and two are about security, and none of
// them can be observed from inside a running app:
//
//  - A payload that quietly keeps carrying base64 looks perfectly correct and
//    simply costs more; the only symptom is a hosting bill three weeks later.
//  - A `kind` that reaches SQL, or a stored mime that reaches a browser
//    unfiltered, looks perfectly correct too — right up until somebody uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_KINDS,
  IMAGE_COLUMNS,
  imageSpec,
  hashImageData,
  imageUrl,
  servableMime,
  sanitizeImageMime,
  withImageUrl,
  shapeCharacter,
  LIVE,
} from '../images.js';

// ------------------------------------------------------------- the registry
test('every kind names a real table and three real columns', () => {
  // The registry is the only thing standing between a path parameter and a SQL
  // identifier, so a malformed entry is the one way this design goes wrong.
  for (const [kind, spec] of Object.entries(IMAGE_KINDS)) {
    for (const field of ['table', 'data', 'mime', 'hash']) {
      assert.equal(typeof spec[field], 'string', `${kind}.${field}`);
      assert.match(spec[field], /^[a-z_]+$/, `${kind}.${field} must be a bare identifier`);
    }
  }
  assert.equal(IMAGE_COLUMNS.length, Object.keys(IMAGE_KINDS).length);
});

test('an unknown kind resolves to null rather than to something', () => {
  // The whole SQL-injection defence is that this returns null before a query
  // is ever built. `__proto__` and `constructor` are here because a plain
  // property read would hand back an inherited object for both.
  for (const bad of ['characters', 'CHARACTER', '__proto__', 'constructor', 'toString', '', null, undefined, 1]) {
    assert.equal(imageSpec(bad), null, `should have refused ${String(bad)}`);
  }
  assert.ok(imageSpec('character'));
  assert.ok(imageSpec('scene-picture'));
});

test('the registry is frozen, so a caller cannot add a kind at runtime', () => {
  assert.throws(() => {
    IMAGE_KINDS.evil = { table: 'characters; DROP TABLE dice', data: 'x', mime: 'y', hash: 'z' };
  }, TypeError);
});

// ------------------------------------------------------------------- hashing
test('the same bytes always hash the same, different bytes never do', () => {
  assert.equal(hashImageData('abc'), hashImageData('abc'));
  assert.notEqual(hashImageData('abc'), hashImageData('abd'));
  assert.equal(hashImageData(null), null);
  assert.equal(hashImageData(''), null);
});

test('the hash is short and URL-safe', () => {
  // It goes in a path segment, so a `/` or `+` from standard base64 would
  // split the route.
  const h = hashImageData('some base64 payload +/=');
  assert.equal(h.length, 16);
  assert.match(h, /^[A-Za-z0-9_-]{16}$/);
});

// ---------------------------------------------------------------------- URLs
test('a URL is built from the stored hash when there is one', () => {
  assert.equal(imageUrl('character', 7, { hash: 'abc123', present: true }), '/api/img/character/7/abc123');
});

test('a caller holding the bytes gets the same URL the backfill would have stored', () => {
  // This is what keeps a payload correct on a row written before the hash
  // column existed: hashing what we are already holding lands on the identical
  // string, so the URL is cacheable rather than merely functional.
  const data = 'aaaabbbbcccc';
  assert.equal(imageUrl('move', 3, { data }), `/api/img/move/3/${hashImageData(data)}`);
});

test('a row with neither bytes nor hash falls back to the live sentinel, never a 404', () => {
  // A picture that fails to load because of a migration is worse than one that
  // simply is not cached.
  assert.equal(imageUrl('scene', 2, { present: true }), `/api/img/scene/2/${LIVE}`);
});

test('no picture means no URL at all', () => {
  assert.equal(imageUrl('character', 7, { data: null }), null);
  assert.equal(imageUrl('character', 7, { present: false, hash: 'abc' }), null);
  assert.equal(imageUrl('character', null, { present: true }), null);
  assert.equal(imageUrl('not-a-kind', 7, { present: true }), null, 'an unknown kind cannot produce a URL');
});

// ------------------------------------------------------------------ the mime
test('only real image types are ever served back', () => {
  // The security boundary. Serving user bytes from our own origin makes the
  // stored mime a content type the browser OBEYS, and this app has no auth.
  for (const ok of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']) {
    assert.equal(servableMime(ok), ok);
  }
  for (const evil of ['text/html', 'application/javascript', 'image/svg+xml', 'text/html; charset=utf-8', '', null, undefined]) {
    assert.equal(servableMime(evil), 'application/octet-stream', `should have refused ${String(evil)}`);
  }
});

test('image/svg+xml is refused specifically, because SVG executes script', () => {
  // Worth its own test rather than a line in the list above: it is the one
  // entry that looks like an image type and is really a document type.
  assert.equal(servableMime('image/svg+xml'), 'application/octet-stream');
  assert.equal(sanitizeImageMime('image/svg+xml', 'image/png'), 'image/png');
});

test('the same allow-list guards the way in, with a per-caller fallback', () => {
  assert.equal(sanitizeImageMime('image/webp'), 'image/webp');
  assert.equal(sanitizeImageMime('text/html'), 'image/jpeg');
  assert.equal(sanitizeImageMime('text/html', 'image/png'), 'image/png');
  assert.equal(sanitizeImageMime(undefined, 'image/png'), 'image/png');
});

// ------------------------------------------------------------- row shaping
test('a shaped row carries a URL and none of the bytes', () => {
  const shaped = withImageUrl('tell')({
    id: 4,
    name: 'A raised guard',
    image_data: 'BYTES',
    image_mime_type: 'image/png',
    image_hash: 'hash1234hash1234',
  });
  assert.deepEqual(shaped, { id: 4, name: 'A raised guard', image_url: '/api/img/tell/4/hash1234hash1234' });
  assert.ok(!('image_data' in shaped), 'the bytes must not survive shaping — this is the whole point');
  assert.ok(!('image_mime_type' in shaped), 'Content-Type carries the mime now');
});

test('a row with no picture is shaped without an image_url key at all', () => {
  // Rather than `image_url: null`, so `Boolean(row.image_url)` reads naturally
  // at every call site.
  const shaped = withImageUrl('perk')({ id: 9, name: 'Durability', image_data: null });
  assert.deepEqual(shaped, { id: 9, name: 'Durability' });
});

test('a character loses BOTH of its pictures and gains both URLs', () => {
  // characters is the only two-image row in the schema, and the most
  // frequently broadcast one — character:updated fires on every Stamina change.
  const shaped = shapeCharacter({
    id: 12,
    name: 'Vera',
    current_stamina: 7,
    image_data: 'PORTRAIT',
    image_mime_type: 'image/webp',
    image_hash: 'aaaaaaaaaaaaaaaa',
    vitruvian_image_data: 'BACKDROP',
    vitruvian_image_mime_type: 'image/webp',
    vitruvian_image_hash: 'bbbbbbbbbbbbbbbb',
  });
  assert.deepEqual(shaped, {
    id: 12,
    name: 'Vera',
    current_stamina: 7,
    image_url: '/api/img/character/12/aaaaaaaaaaaaaaaa',
    vitruvian_image_url: '/api/img/character-art/12/bbbbbbbbbbbbbbbb',
  });
});

test('a character with only a portrait gets only the one URL', () => {
  const shaped = shapeCharacter({ id: 1, name: 'Nobody', image_data: 'X', image_hash: 'cccccccccccccccc' });
  assert.equal(shaped.image_url, '/api/img/character/1/cccccccccccccccc');
  assert.ok(!('vitruvian_image_url' in shaped));
});

test('shaping a null row is a no-op rather than a crash', () => {
  assert.equal(shapeCharacter(null), null);
  assert.equal(withImageUrl('move')(undefined), undefined);
});

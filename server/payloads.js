// How a row is shaped on its way out to clients.
//
// **This file exists because of the hosting bill.** The app went 60% over
// Render's included bandwidth and 6GB through Turso's sync allowance, and the
// forensics pointed at one habit: broadcasting whole `SELECT *` rows. That is
// harmless for a row of integers and ruinous for the several tables in this
// schema that carry a base64 image in a TEXT column — a picture measured in
// hundreds of kilobytes rides along with a two-byte change, to every connected
// socket, several times a round.
//
// It lives in its own module rather than in index.js because
// roundResolution.js emits the same events (adjustStamina alone accounts for
// most of them) and index.js already imports roundResolution — so the helper
// has to sit below both or the import graph turns into a cycle.
//
// The rule these encode: **a broadcast carries what CHANGED, and the client
// merges it over what it already has.** Anything that has not changed does not
// need to be on the wire.

// A character without either of its pictures.
//
// `characters` is the only table holding two image columns — the portrait, and
// the GM's optional replacement for the Core Stats backdrop figure — and it is
// also the most frequently broadcast row in the app, because `character:updated`
// is how a Stamina change reaches the table. Measured before this existed: 300KB
// per emit, per socket, to deliver a single integer.
//
// **Every consumer must MERGE this payload, never replace with it.** Two of
// them replaced (CharacterSheet and CombatArena) and were fixed in the same
// commit that added this; a consumer that replaces will blank the portrait
// until the next full fetch. The fix for that is always to make the consumer
// merge, never to put the bytes back on the wire.
export const omitCharacterArt = ({
  image_data,
  image_mime_type,
  vitruvian_image_data,
  vitruvian_image_mime_type,
  ...rest
}) => rest;

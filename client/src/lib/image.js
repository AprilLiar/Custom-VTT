// Client-side picture processing.
//
// **Everything here encodes to WebP (bandwidth).** The five pipelines below
// used to save JPEG, and to pass PNG through LOSSLESSLY whenever the source was
// PNG — which is how `scene_pictures` came to hold the largest rows in the
// schema: a 1024px transparent character cutout is routinely 1–2MB before
// base64. WebP keeps the alpha channel these cutouts need while being several
// times smaller than lossless PNG, and is indistinguishable at the sizes any of
// this is displayed at.
//
// That size is not only a transfer cost. Render's free tier has no persistent
// disk, so the embedded replica is rebuilt on every cold start — which makes the
// whole database a download, several times a day. Shrinking the pictures IS
// shrinking the Turso bill.
//
// **GIFs are never re-encoded**, here or anywhere: a canvas export keeps one
// frame and silently kills the animation. See fileToChatImage.

// One encoder for all five pipelines, so they cannot drift apart on format.
// `alpha` asks for a format that keeps transparency — WebP does, so it is the
// same call either way; the flag exists to make the fallback correct, since a
// browser too old for WebP must fall back to PNG for a cutout and JPEG for a
// photograph.
const WEBP_QUALITY = 0.82;
function encode(canvas, { alpha = false } = {}) {
  const webp = canvas.toDataURL('image/webp', WEBP_QUALITY);
  // toDataURL falls back to PNG when it does not know the type asked for, so a
  // prefix check is how you find out whether WebP was actually honoured.
  if (webp.startsWith('data:image/webp')) {
    return { imageData: webp.split(',')[1], imageMimeType: 'image/webp' };
  }
  const fallback = alpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
  return {
    imageData: fallback.split(',')[1],
    imageMimeType: alpha ? 'image/png' : 'image/jpeg',
  };
}

// Portraits: 512px is ample — the largest frame any portrait renders in is a
// character card, and the rest are 24–48px thumbnails.
const MAX_WIDTH = 512;

export function fileToPortrait(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a readable image'));
      img.onload = () => {
        const scale = Math.min(1, MAX_WIDTH / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(encode(canvas));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// **These used to BUILD the picture; now they just point at it.**
//
// Every row arrives from the server already carrying `image_url` — the server
// knows which table a row came from, which is the one thing a row cannot tell
// you about itself, so it is the only place the URL can be assembled. Keeping
// the signature identical is deliberate: all eleven call sites are untouched by
// the change from base64 to URLs.
//
// Why it mattered: a `data:` URI is not a URL, so nothing caches it — every
// portrait was re-downloaded on every page load and every phone unlock, and the
// scene backdrop rode along on every drag and every pen stroke. Behind a URL
// keyed by content hash (see server/images.js), each picture is fetched once.
export const portraitSrc = (record) => record?.image_url ?? null;

// A GM-uploaded replacement for Tab 1's default backdrop figure, specific
// to this character — null falls back to the built-in artwork.
export const vitruvianSrc = (character) => character?.vitruvian_image_url ?? null;

// **The only `data:` URI left in the app**, and the one place it is still
// right: a picture the person chose a moment ago and has not saved yet. Those
// bytes came out of this browser's own canvas and have never touched the
// network, so there is no URL to point at and nothing to cache.
export const localPreviewSrc = (picture) =>
  picture?.imageData
    ? `data:${picture.imageMimeType || 'image/jpeg'};base64,${picture.imageData}`
    : null;

// Chat images/GIFs: never persisted long-term (wiped on Clear Chat and on
// every server restart), so a wider cap than Moves/Tells' 128px thumbnails
// is fine. GIFs are sent as their raw uploaded bytes rather than redrawn
// onto a canvas — canvas re-export only ever keeps one frame, which would
// silently kill the animation.
const CHAT_MAX_WIDTH = 480;
// **1MB, down from 4 (bandwidth).** A GIF is the largest object this system
// can produce, it is stored raw (re-encoding would flatten the animation, which
// is the whole point of posting one), and it used to be echoed to every socket
// AND re-sent inside GET /api/chat on every page load for as long as it stayed
// in the readable tail. It is a URL now rather than an inline payload, so it is
// fetched once per person — but 4MB was still four times more than a reaction
// image needs to be.
const CHAT_GIF_MAX_BYTES = 1024 * 1024;

export function fileToChatImage(file) {
  if (file.type === 'image/gif') {
    return new Promise((resolve, reject) => {
      if (file.size > CHAT_GIF_MAX_BYTES) {
        reject(new Error('GIF too large (max 1MB)'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('could not read file'));
      reader.onload = () => {
        resolve({
          imageData: reader.result.split(',')[1],
          imageMimeType: 'image/gif',
        });
      };
      reader.readAsDataURL(file);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a readable image'));
      img.onload = () => {
        const scale = Math.min(1, CHAT_MAX_WIDTH / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = file.type === 'image/png';
        resolve(encode(canvas, { alpha: png }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// A Scene Picture: a Character's or Temp NPC's transparent-PNG art for the
// stage (Scene tab plan, Phase 3). Same "PNG stays PNG, else JPEG 0.85"
// branch as fileToSmallImage, just a much bigger cap — this is meant to
// show at real screen height, not as a thumbnail, so 128px would be a
// blurry mess. No crop step: scene_pictures carries no crop_* columns, and
// cropping a character cutout the way a portrait photo gets cropped
// doesn't make sense — the art is already framed the way it's meant to
// show.
const SCENE_PICTURE_MAX_SIDE = 1024;

export function fileToScenePicture(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a readable image'));
      img.onload = () => {
        const scale = Math.min(1, SCENE_PICTURE_MAX_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = file.type === 'image/png';
        resolve(encode(canvas, { alpha: png }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// A Scene's fullscreen backdrop (Scene tab plan, Phase 4). Capped by WIDTH,
// not longest side, unlike fileToScenePicture above — a backdrop is always
// meant to be landscape-ish and read at real screen width, so width is the
// dimension that actually matters here (mirrors fileToPortrait's own "cap
// at N wide" framing, just a much bigger N). PNG-preserving all the same,
// on the off chance a GM composites a backdrop with real transparency.
const SCENE_BACKGROUND_MAX_WIDTH = 1600;

export function fileToSceneBackground(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a readable image'));
      img.onload = () => {
        const scale = Math.min(1, SCENE_BACKGROUND_MAX_WIDTH / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = file.type === 'image/png';
        resolve(encode(canvas, { alpha: png }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Small square-ish art for Moves and Tells: cap the longest side at 128px,
// keeping PNG (with transparency) when the source is PNG.
export function fileToSmallImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a readable image'));
      img.onload = () => {
        const scale = Math.min(1, 128 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = file.type === 'image/png';
        resolve(encode(canvas, { alpha: png }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

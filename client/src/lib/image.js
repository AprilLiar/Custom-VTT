// Client-side portrait processing: cap at 800px wide, save as JPEG (~80%
// quality) so the base64 stored in Turso stays small.
const MAX_WIDTH = 800;
const JPEG_QUALITY = 0.8;

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
        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        resolve({
          imageData: dataUrl.split(',')[1],
          imageMimeType: 'image/jpeg',
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export const portraitSrc = (character) =>
  character?.image_data
    ? `data:${character.image_mime_type || 'image/jpeg'};base64,${character.image_data}`
    : null;

// A GM-uploaded replacement for Tab 1's default backdrop figure, specific
// to this character — null falls back to the built-in artwork.
export const vitruvianSrc = (character) =>
  character?.vitruvian_image_data
    ? `data:${character.vitruvian_image_mime_type || 'image/jpeg'};base64,${character.vitruvian_image_data}`
    : null;

// Chat images/GIFs: never persisted long-term (wiped on Clear Chat and on
// every server restart), so a wider cap than Moves/Tells' 128px thumbnails
// is fine. GIFs are sent as their raw uploaded bytes rather than redrawn
// onto a canvas — canvas re-export only ever keeps one frame, which would
// silently kill the animation.
const CHAT_MAX_WIDTH = 480;
const CHAT_GIF_MAX_BYTES = 4 * 1024 * 1024;

export function fileToChatImage(file) {
  if (file.type === 'image/gif') {
    return new Promise((resolve, reject) => {
      if (file.size > CHAT_GIF_MAX_BYTES) {
        reject(new Error('GIF too large (max 4MB)'));
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
        const dataUrl = png
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/jpeg', 0.85);
        resolve({
          imageData: dataUrl.split(',')[1],
          imageMimeType: png ? 'image/png' : 'image/jpeg',
        });
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
        const dataUrl = png
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/jpeg', 0.85);
        resolve({
          imageData: dataUrl.split(',')[1],
          imageMimeType: png ? 'image/png' : 'image/jpeg',
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

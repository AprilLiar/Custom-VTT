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

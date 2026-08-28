import { useCallback, useEffect, useRef, useState } from 'react';
import ImageCropDialog from '../components/ImageCropDialog.jsx';
import { cropFields } from './imageCrop.js';

// The whole "add a picture" flow, in one hook: pick a file, choose what shows,
// hand back the fields to save.
//
// **One hook rather than five copies of the same three states.** Every upload
// site in the app had the same shape already — a hidden file input, a `busy`
// flag, an `await fileToX(file)` — and the crop step adds an object URL, a
// dialog and a pending file to each of them. Written out five times that is
// five chances to leak a blob URL or to save the picture without its crop.
//
// **The crop is measured against the ORIGINAL file, not the stored copy.** The
// editor previews the raw upload while `process` (fileToPortrait,
// fileToSmallImage) independently produces the resized bytes that actually get
// stored. That only works because a crop is normalised — fractions of the
// picture's own width and height — so it means the same thing at 4000px and at
// 128px, and the two never have to agree about a pixel.
//
// `process` is the existing pipeline for this kind of picture, so nothing about
// how images are resized or re-encoded changes here.
export function usePictureUpload({ process, name, previewSizes, onPicked }) {
  const [pending, setPending] = useState(null); // { file, url }
  const [busy, setBusy] = useState(false);
  // A blob URL is a document-lifetime reference: dropped without revoking, the
  // bytes stay alive until the tab closes, and this is a picture.
  const urlRef = useRef(null);

  const release = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => release, [release]);

  // Call from the file input's onChange. Clearing `e.target.value` first is what
  // lets the same file be picked twice in a row — without it the second pick
  // fires no change event at all.
  const pick = useCallback(
    (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      release();
      urlRef.current = URL.createObjectURL(file);
      setPending({ file, url: urlRef.current });
    },
    [release]
  );

  const cancel = useCallback(() => {
    setPending(null);
    release();
  }, [release]);

  const confirm = useCallback(
    async (crop) => {
      const file = pending?.file;
      setPending(null);
      if (!file) return;
      setBusy(true);
      try {
        const processed = await process(file);
        // `process` resolving to undefined is how the existing call sites
        // signal "that was not a readable image" — keep that contract.
        if (processed) await onPicked({ ...processed, ...cropFields(crop) });
      } catch (err) {
        console.error(err);
      } finally {
        setBusy(false);
        release();
      }
    },
    [pending, process, onPicked, release]
  );

  const dialog = pending ? (
    <ImageCropDialog
      src={pending.url}
      name={name}
      previewSizes={previewSizes}
      onCancel={cancel}
      onConfirm={confirm}
    />
  ) : null;

  return { pick, dialog, busy };
}

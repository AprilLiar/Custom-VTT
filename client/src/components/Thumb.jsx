import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';

// Small uploaded-art thumbnail for Moves and Tells, with an initial-letter
// placeholder until the commissioned images are uploaded.
//
// Sixteen call sites go through here, which is why adding the crop was one
// edit: the record carries its own `crop_*` columns and this is the only place
// that has to know they exist. A record without them renders exactly as before.
export default function Thumb({ record, name, size = 'h-6 w-6', cut = 'panel-cut-sm' }) {
  if (record?.image_data) {
    return (
      <CroppedImage
        src={`data:${record.image_mime_type || 'image/png'};base64,${record.image_data}`}
        alt={name}
        crop={cropOf(record)}
        className={`${size} ${cut} shrink-0`}
      />
    );
  }
  return (
    <span
      className={`${size} ${cut} flex shrink-0 items-center justify-center bg-zinc-700/60 text-[0.6rem] font-bold uppercase text-zinc-400`}
    >
      {(name ?? '?').slice(0, 1)}
    </span>
  );
}

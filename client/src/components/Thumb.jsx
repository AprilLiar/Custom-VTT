// Small uploaded-art thumbnail for Moves and Tells, with an initial-letter
// placeholder until the commissioned images are uploaded.
export default function Thumb({ record, name, size = 'h-6 w-6', rounded = 'rounded-md' }) {
  if (record?.image_data) {
    return (
      <img
        src={`data:${record.image_mime_type || 'image/png'};base64,${record.image_data}`}
        alt={name}
        className={`${size} ${rounded} shrink-0 object-cover`}
      />
    );
  }
  return (
    <span
      className={`${size} ${rounded} flex shrink-0 items-center justify-center bg-zinc-700/60 text-[0.6rem] font-bold uppercase text-zinc-400`}
    >
      {(name ?? '?').slice(0, 1)}
    </span>
  );
}

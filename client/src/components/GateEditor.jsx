import { useState } from 'react';
import { socket } from '../socket.js';
import DialogShell from './DialogShell.jsx';

// Putting a Gate on one pip of a Counter, or editing the one already there.
//
// **GM-only, and that is the mechanic rather than a permission.** A Gate is the
// GM writing on a Counter's future, and the Secret switch means nothing if the
// person it is kept from can author it. The Counter itself stays open to
// whoever controls the character, exactly as it always was.
//
// A dialog rather than a live-applying popover, unlike the relationship editor:
// there is nothing here you are choosing *against* the board — no colour to
// judge in place — and a half-typed description broadcasting on every keystroke
// would put a secret through the server a character at a time.
export default function GateEditor({ counter, pipIndex, gate, onClose }) {
  const [name, setName] = useState(gate?.name ?? '');
  const [description, setDescription] = useState(gate?.description ?? '');
  const [secret, setSecret] = useState(gate ? Boolean(gate.secret) : true);

  const save = () => {
    socket.emit('counter_gate:save', {
      counterId: counter.id,
      pipIndex,
      name,
      description,
      secret,
    });
    onClose();
  };

  return (
    <DialogShell
      title={`${gate ? 'Edit' : 'New'} Gate — pip ${pipIndex} of ${counter.target_pips}`}
      onClose={onClose}
      // Opened from a Counter row, which sits deep inside the character sheet's
      // tab body and inside the Arena's scrolling column. Without the portal the
      // panel renders in the right place and paints UNDER the page around it —
      // visible, and every click on it landing on `<main>`.
      portal
      footer={
        <div className="flex items-center justify-between gap-2">
          {gate ? (
            <button
              type="button"
              onClick={() => {
                socket.emit('counter_gate:delete', { gateId: gate.id });
                onClose();
              }}
              className="panel-cut-sm px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-zinc-600 hover:text-brand-400"
            >
              Remove Gate
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="panel-cut-sm border border-zinc-700 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="panel-cut-sm bg-brand-600 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-white hover:bg-brand-500"
            >
              Save
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">
          When <b className="text-zinc-300">{counter.name}</b> fills to this pip, the Chat Log says
          so. The pip is drawn twice the size for everyone — that something is coming is never the
          secret.
        </p>
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="What happens here"
            className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            maxLength={2000}
            placeholder="The detail you want in front of you when it arrives."
            className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={secret}
            onChange={(e) => setSecret(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-[11px] font-bold uppercase tracking-wide text-zinc-300">
              Secret
            </span>
            <span className="block text-[10px] leading-snug text-zinc-600">
              On, the table sees “???” for both the name and the description — the words are not
              sent to them at all. Off, they read it by hovering the pip. The Chat Log line names
              an open Gate and never a secret one.
            </span>
          </span>
        </label>
      </div>
    </DialogShell>
  );
}

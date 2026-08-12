import { useState } from 'react';

// Shared list widget for Inventory and Injuries: bold name on top, grey
// smaller description under it (no line at all when empty), pencil-toggled
// edit mode per row.

function Row({ item, descPlaceholder, onSave, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [desc, setDesc] = useState(item.desc);

  const startEdit = () => {
    setName(item.name);
    setDesc(item.desc);
    setEditing(true);
  };

  const save = (e) => {
    e?.preventDefault();
    if (!name.trim()) return;
    if (name.trim() !== item.name || desc.trim() !== item.desc) {
      onSave(name.trim(), desc.trim());
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <li>
        <form onSubmit={save} className="flex flex-col gap-1 panel-cut-sm border border-zinc-700 bg-zinc-800/60 p-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-semibold text-zinc-100 outline-none focus:border-brand-500"
          />
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={descPlaceholder}
            className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500"
          />
          <div className="flex justify-end gap-1">
            <button
              type="submit"
              disabled={!name.trim()}
              className="panel-cut-sm px-2 py-0.5 text-xs font-semibold text-green-400 hover:bg-green-900/30 disabled:opacity-40"
            >
              ✓ Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="panel-cut-sm px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-700"
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-2 py-0.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-zinc-100">{item.name}</div>
        {item.desc && (
          <div className="text-xs text-zinc-500">{item.desc}</div>
        )}
      </div>
      <button
        onClick={startEdit}
        title="Edit"
        className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 md:h-auto md:w-auto md:px-1.5"
      >
        ✎
      </button>
      <button
        onClick={onRemove}
        title="Remove"
        className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-600 hover:bg-red-900/40 hover:text-red-400 md:h-auto md:w-auto md:px-1.5"
      >
        ✕
      </button>
    </li>
  );
}

export default function ItemList({
  title,
  items, // [{ id, name, desc }]
  emptyText,
  namePlaceholder,
  descPlaceholder,
  onAdd, // (name, desc)
  onUpdate, // (id, name, desc)
  onRemove, // (id)
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd(name.trim(), desc.trim());
    setName('');
    setDesc('');
  };

  return (
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-600">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <Row
              key={item.id}
              item={item}
              descPlaceholder={descPlaceholder}
              onSave={(newName, newDesc) => onUpdate(item.id, newName, newDesc)}
              onRemove={() => onRemove(item.id)}
            />
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={namePlaceholder}
          className="w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-brand-500 sm:w-1/3"
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={descPlaceholder}
          className="w-full min-w-0 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-brand-500 sm:flex-1"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="min-h-11 panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40 sm:min-h-0"
        >
          Add
        </button>
      </form>
    </div>
  );
}

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
        <form onSubmit={save} className="flex flex-col gap-1 rounded-md border border-zinc-700 bg-zinc-800/60 p-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-semibold text-zinc-100 outline-none focus:border-indigo-500"
          />
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={descPlaceholder}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500"
          />
          <div className="flex justify-end gap-1">
            <button
              type="submit"
              disabled={!name.trim()}
              className="rounded px-2 py-0.5 text-xs font-semibold text-green-400 hover:bg-green-900/30 disabled:opacity-40"
            >
              ✓ Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-700"
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
        className="rounded px-1.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
      >
        ✎
      </button>
      <button
        onClick={onRemove}
        title="Remove"
        className="rounded px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
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
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
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
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={namePlaceholder}
          className="w-1/3 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={descPlaceholder}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-md bg-indigo-600 px-3 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </div>
  );
}

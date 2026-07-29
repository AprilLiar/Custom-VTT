import { useState } from 'react';
import { buildFolderTree } from '../lib/folders.js';

// Shared nested-folder navigator for both folder systems (character-list
// folders and move Disciplines) — a vertical, indented tree rather than the
// old flat tab row, since a tab row can't show nesting. Selection works at
// every depth; management controls (create/rename/delete) only render when
// `canManage` is true, matching each caller's own GM-gating.
export default function FolderTreeNav({
  folders,
  currentFolderId,
  onSelect,
  canManage,
  onCreate, // (name, parentFolderId)
  onRename, // (folderId, name)
  onDelete, // (folderId)
  onDropOnFolder, // (e, folderId | null) — null = root
  rootLabel = 'All',
  nounLabel = 'folder',
  folderIcon = '📁',
}) {
  const [dropTarget, setDropTarget] = useState(null); // 'root' | folderId | null
  const [newName, setNewName] = useState('');
  const tree = buildFolderTree(folders);

  const dragProps = (target) =>
    canManage
      ? {
          onDragOver: (e) => {
            e.preventDefault();
            setDropTarget(target);
          },
          onDragLeave: () => setDropTarget(null),
          onDrop: (e) => {
            setDropTarget(null);
            onDropOnFolder(e, target === 'root' ? null : target);
          },
        }
      : {};

  const createFolder = (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreate(newName.trim(), currentFolderId);
    setNewName('');
  };

  const renameFolder = (folder) => {
    const name = window.prompt(`Rename ${nounLabel}`, folder.name);
    if (name?.trim()) onRename(folder.id, name.trim());
  };

  const deleteFolder = (folder) => {
    if (
      window.confirm(
        `Delete ${nounLabel} "${folder.name}"? Its contents and any subfolders move up one level.`
      )
    ) {
      onDelete(folder.id);
    }
  };

  const Row = ({ node, depth }) => (
    <div>
      <div
        className="flex items-center"
        style={{ paddingLeft: `${depth * 14}px` }}
        {...dragProps(node.id)}
      >
        <button
          onClick={() => onSelect(node.id)}
          title={canManage ? `Drop a card here to file it under "${node.name}"` : undefined}
          className={`min-w-0 flex-1 truncate panel-cut-sm px-2 py-1 text-left text-sm font-semibold ${
            currentFolderId === node.id
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          } ${dropTarget === node.id ? 'ring-2 ring-brand-400' : ''}`}
        >
          {folderIcon} {node.name}
        </button>
        {canManage && (
          <span className="flex shrink-0 gap-0.5">
            <button
              onClick={() => renameFolder(node)}
              className="panel-cut-sm px-1 text-xs text-zinc-600 hover:text-zinc-300"
              title="Rename"
            >
              ✎
            </button>
            <button
              onClick={() => deleteFolder(node)}
              className="panel-cut-sm px-1 text-xs text-zinc-600 hover:text-red-400"
              title="Delete"
            >
              ✕
            </button>
          </span>
        )}
      </div>
      {node.children.map((child) => (
        <Row key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => onSelect(null)}
        title={canManage ? 'Drop a card here to clear its folder' : undefined}
        className={`w-full truncate panel-cut-sm px-2 py-1 text-left text-sm font-semibold ${
          currentFolderId == null
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
        } ${dropTarget === 'root' ? 'ring-2 ring-brand-400' : ''}`}
        {...dragProps('root')}
      >
        🏠 {rootLabel}
      </button>
      {tree.map((node) => (
        <Row key={node.id} node={node} depth={1} />
      ))}
      {canManage && (
        <form onSubmit={createFolder} className="flex gap-1 pt-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`New ${nounLabel}`}
            className="w-0 min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            disabled={!newName.trim()}
            className="shrink-0 panel-cut-sm bg-zinc-700 px-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-600 disabled:opacity-40"
          >
            +
          </button>
        </form>
      )}
    </div>
  );
}

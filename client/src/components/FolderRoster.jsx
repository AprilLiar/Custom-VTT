// A recursive, collapsible roster of characters filed in the GM's nested
// `character_folders`.
//
// **Extracted from CombatArena, unchanged.** It was written for the Arena's
// seating rail and was already the right shape for a second caller — it takes
// the characters as a `charsByFolder` map and the card itself as a render prop,
// so it knows nothing about seating. The Relationships board needs exactly this
// tree with a different card, and the alternative was a second copy that would
// have drifted the first time either one's collapse behaviour changed.
//
// The rules it encodes, all deliberate:
//   - a folder whose COMPLETE subtree has no characters hides itself rather
//     than showing an always-empty row;
//   - the count on a folder is its whole subtree, not just its direct children;
//   - direct characters render before child folders once expanded.
//
// `collapsed` is a Set of folder ids owned by the caller, so a page can persist
// or reset it however it likes.

// Every character inside this folder including all descendant folders — what
// the per-folder count shows, and what decides whether an empty subtree hides.
export function countAvailable(node, charsByFolder) {
  const direct = charsByFolder.get(node.id)?.length ?? 0;
  const childSum = node.children.reduce((sum, child) => sum + countAvailable(child, charsByFolder), 0);
  return direct + childSum;
}

export function FolderRosterNode({ node, charsByFolder, collapsed, onToggle, depth, rosterCard }) {
  const count = countAvailable(node, charsByFolder);
  if (count === 0) return null;
  const isCollapsed = collapsed.has(node.id);
  const directChars = charsByFolder.get(node.id) ?? [];
  return (
    <div>
      <button
        onClick={() => onToggle(node.id)}
        style={{ paddingLeft: `${depth * 12}px` }}
        className="flex w-full items-center gap-1 panel-cut-sm py-1 text-left text-[10px] font-bold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
      >
        <span className="shrink-0">{isCollapsed ? '▸' : '▾'}</span>
        <span className="min-w-0 flex-1 truncate">📁 {node.name}</span>
        <span className="shrink-0 normal-case text-zinc-600">({count})</span>
      </button>
      {!isCollapsed && directChars.length > 0 && (
        <div className="space-y-2 pb-1" style={{ paddingLeft: `${depth * 12 + 10}px` }}>
          {directChars.map(rosterCard)}
        </div>
      )}
      {!isCollapsed &&
        node.children.map((child) => (
          <FolderRosterNode
            key={child.id}
            node={child}
            charsByFolder={charsByFolder}
            collapsed={collapsed}
            onToggle={onToggle}
            depth={depth + 1}
            rosterCard={rosterCard}
          />
        ))}
    </div>
  );
}

export default FolderRosterNode;

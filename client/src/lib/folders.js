// Shared nested-folder utilities for both folder systems in this app —
// character-list folders and move-compendium folders ("Disciplines"). Both
// are flat arrays of { id, name, parent_id }, so the same tree logic
// applies to either one unmodified.

// Recursively nested tree, sorted alphabetically by name at every level —
// root folders (parent_id == null) at the top, each with its own
// alphabetically-sorted children array.
export function buildFolderTree(folders) {
  const byParent = new Map();
  for (const f of folders) {
    const key = f.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  }
  const build = (parentId) =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ ...f, children: build(f.id) }));
  return build(null);
}

// Depth-first flatten of the tree built from `folders` -> an ordered array
// of { folder, depth, path }, in the same alphabetical tree order —
// suitable for an indented select/list of every folder at every depth.
export function flattenFolderTree(folders) {
  const tree = buildFolderTree(folders);
  const rows = [];
  const walk = (nodes, depth, parentPath) => {
    for (const node of nodes) {
      const { children, ...folder } = node;
      const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
      rows.push({ folder, depth, path });
      walk(children, depth + 1, path);
    }
  };
  walk(tree, 0, '');
  return rows;
}

// The full "Fighters / Bosses / Final" path string for a single folder id,
// walking up its parent_id chain against the flat `folders` array. null for
// root (folderId == null) or an id that isn't found.
export function folderPath(folderId, folders) {
  if (folderId == null) return null;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts = [];
  let current = byId.get(folderId);
  let guard = 0;
  while (current && guard++ < 1000) {
    parts.unshift(current.name);
    current = current.parent_id != null ? byId.get(current.parent_id) : null;
  }
  return parts.length ? parts.join(' / ') : null;
}

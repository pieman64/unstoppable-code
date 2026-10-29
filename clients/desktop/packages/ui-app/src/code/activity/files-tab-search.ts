export const FILES_TAB_SEARCH_DEBOUNCE_MS = 180;
export const FILES_TAB_SEARCH_RESULT_LIMIT = 500;
export interface FilesTabSearchFile {
  readonly kind: 'file';
  readonly name: string;
  readonly relativePath: string;
}
export interface FilesTabSearchDirectory {
  readonly kind: 'directory';
  readonly name: string;
  readonly relativePath: string;
  readonly children: readonly FilesTabSearchNode[];
}
export type FilesTabSearchNode = FilesTabSearchDirectory | FilesTabSearchFile;
export interface FilesTabSearchTree {
  readonly nodes: readonly FilesTabSearchNode[];
  readonly shownCount: number;
  readonly matchCount: number;
}
interface Directory {
  name: string;
  relativePath: string;
  directories: Map<string, Directory>;
  files: FilesTabSearchFile[];
}
function directory(name: string, relativePath: string): Directory {
  return { name, relativePath, directories: new Map(), files: [] };
}
function nodesOf(parent: Directory): FilesTabSearchNode[] {
  return [
    ...Array.from(parent.directories.values())
      .sort((a, b): number => a.name.localeCompare(b.name))
      .map(
        (child): FilesTabSearchDirectory => ({
          kind: 'directory',
          name: child.name,
          relativePath: child.relativePath,
          children: nodesOf(child),
        }),
      ),
    ...parent.files.sort((a, b): number => a.name.localeCompare(b.name)),
  ];
}
export function normalizeFilesTabSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}
export function matchesFilesTabSearchQuery(
  relativePath: string,
  normalizedQuery: string,
): boolean {
  return (
    normalizedQuery.length > 0 &&
    relativePath.toLowerCase().includes(normalizedQuery)
  );
}
export function buildFilesTabSearchTree(
  paths: readonly string[],
  query: string,
  limit = FILES_TAB_SEARCH_RESULT_LIMIT,
): FilesTabSearchTree {
  const normalized = normalizeFilesTabSearchQuery(query);
  const matches = paths.filter((path): boolean =>
    matchesFilesTabSearchQuery(path, normalized),
  );
  const shown = matches.slice(0, Math.max(0, limit));
  const root = directory('', '');
  for (const path of shown) {
    const segments = path.split('/');
    const name = segments.pop() ?? path;
    let parent = root;
    for (const segment of segments) {
      let child = parent.directories.get(segment);
      if (!child) {
        child = directory(
          segment,
          parent.relativePath ? `${parent.relativePath}/${segment}` : segment,
        );
        parent.directories.set(segment, child);
      }
      parent = child;
    }
    parent.files.push({ kind: 'file', name, relativePath: path });
  }
  return {
    nodes: nodesOf(root),
    shownCount: shown.length,
    matchCount: matches.length,
  };
}
export function flattenFilesTabSearchTree(
  nodes: readonly FilesTabSearchNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): readonly { node: FilesTabSearchNode; depth: number }[] {
  return nodes.flatMap(
    (node): { node: FilesTabSearchNode; depth: number }[] => [
      { node, depth },
      ...(node.kind === 'directory' && !collapsed.has(node.relativePath)
        ? flattenFilesTabSearchTree(node.children, collapsed, depth + 1)
        : []),
    ],
  );
}

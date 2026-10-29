export const FILE_TREE_SET_SEARCH_EVENT = 'canopy:file-tree-set-search';

export interface FileTreeSetSearchDetail {
  projectId: string;
  worktreeId: string;
  query: string;
  acknowledge: () => void;
}

export function isFileTreeSetSearchDetail(
  value: unknown,
): value is FileTreeSetSearchDetail {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'query' in value &&
    typeof value.query === 'string' &&
    'acknowledge' in value &&
    typeof value.acknowledge === 'function'
  );
}

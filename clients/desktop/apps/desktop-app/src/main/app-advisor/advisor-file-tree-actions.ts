import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  FileTreeItemReference,
  FileTreeMutationRequest,
  FileTreeMutationResponse,
} from '@canopy/desktop-shared/types';

export const ADVISOR_FILE_TREE_ACTION_TYPES = [
  'file-tree.create_file',
  'file-tree.create_directory',
  'file-tree.copy',
  'file-tree.move',
  'file-tree.delete',
] as const;

export type AdvisorFileTreeAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_FILE_TREE_ACTION_TYPES)[number] }
>;

export function isAdvisorFileTreeAction(
  action: AppAdvisorAction,
): action is AdvisorFileTreeAction {
  return ADVISOR_FILE_TREE_ACTION_TYPES.some((type) => type === action.type);
}

/** The main owners an App Advisor file tree mutation uses (CAN-6006). */
export interface AdvisorFileTreeActionHost {
  /** Main's split lock, which the window's store mirrors. */
  isSplitLocked(projectId: string, worktreeId: string): boolean;
  /**
   * The explorer's `file-tree:mutate` owner, as the advisor chat with only
   * `worker.filesystem.write`; throws what `mutateFileTree` threw.
   */
  mutate(request: FileTreeMutationRequest): Promise<FileTreeMutationResponse>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

/**
 * The request the window sent for each action: a delete always goes to the
 * Trash, a move never replaces an entry, and a copy increments only when asked.
 */
export function fileTreeMutationRequest(
  action: AdvisorFileTreeAction,
): FileTreeMutationRequest {
  const scope = { projectId: action.projectId, worktreeId: action.worktreeId };
  switch (action.type) {
    case 'file-tree.create_file':
      return { operation: 'create-file', ...scope, target: action.target };
    case 'file-tree.create_directory':
      return { operation: 'create-directory', ...scope, target: action.target };
    case 'file-tree.copy':
      return {
        operation: 'copy',
        ...scope,
        source: action.source,
        target: action.target,
        conflict: action.conflict,
      };
    case 'file-tree.move':
      return {
        operation: 'move',
        ...scope,
        source: action.source,
        target: action.target,
        conflict: 'error',
      };
    case 'file-tree.delete':
      return {
        operation: 'delete',
        ...scope,
        target: action.target,
        useTrash: true,
      };
  }
}

function itemJson(item: FileTreeItemReference): AppAdvisorJson {
  return { repoId: item.repoId, relativePath: item.relativePath };
}

export async function dispatchAdvisorFileTreeAction(
  action: AdvisorFileTreeAction,
  host: AdvisorFileTreeActionHost,
): Promise<Response> {
  if (host.isSplitLocked(action.projectId, action.worktreeId))
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'A Split PR is in progress for this worktree; it is locked until the split finishes.',
        retryable: true,
      },
    };
  try {
    const response = await host.mutate(fileTreeMutationRequest(action));
    return {
      ok: true,
      result: {
        operation: response.operation,
        ...(response.source && { source: itemJson(response.source) }),
        ...(response.target && { target: itemJson(response.target) }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to update the file tree.',
        retryable: true,
      },
    };
  }
}

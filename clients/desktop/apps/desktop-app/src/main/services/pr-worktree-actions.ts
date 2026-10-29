import type {
  CreatePrRequest,
  CreatePrResponse,
  MergePrBlockedReason,
  MergePrRequest,
  MergePrResponse,
} from '@canopy/desktop-shared/types/github';
import type {
  PortalPrActionPayload,
  PortalWorktreePrActionsState as WorktreePrActionsState,
} from '@canopy/protocol/portal';
import { validateId } from '../lib/validation';
import { PortalServiceError } from './portal-service-error';

type Target = { projectId: string; worktreeId: string };
interface WorktreePrActions {
  state: (target: Target) => Promise<WorktreePrActionsState>;
  create: (request: CreatePrRequest) => Promise<CreatePrResponse>;
  merge: (request: MergePrRequest) => Promise<MergePrResponse>;
}

function describeMergeRefusal(
  reason: MergePrBlockedReason | undefined,
): string {
  switch (reason) {
    case 'base_changed':
      return 'The pull request base branch changed during verification.';
    case 'has_conflicts':
      return 'The pull request has merge conflicts.';
    case 'in_merge_queue':
      return 'This pull request is already in the merge queue.';
    default:
      return 'GitHub reports that the pull request cannot merge yet.';
  }
}

// Composition root installs the same operations used by desktop IPC. No IPC
// event or renderer is fabricated, and the relay cannot invoke arbitrary IPC.
let operations: WorktreePrActions | undefined;
const pending = new Set<string>();
export function registerWorktreePrActions(actions: WorktreePrActions): void {
  operations = actions;
}

export async function runWorktreePrAction(
  request: Extract<
    PortalPrActionPayload,
    { action: 'get_actions' | 'create_auto' | 'merge' }
  >,
): Promise<WorktreePrActionsState | CreatePrResponse | MergePrResponse> {
  validateId(request.workspaceLocalId, 'workspaceLocalId');
  validateId(request.worktreeLocalId, 'worktreeLocalId');
  if (!operations)
    throw new PortalServiceError(
      'execution_failed',
      'PR actions are not available yet.',
    );
  const target = {
    projectId: request.workspaceLocalId,
    worktreeId: request.worktreeLocalId,
  };
  const key = `${target.projectId}/${target.worktreeId}`;
  if (request.action === 'get_actions') {
    const state = await operations.state(target);
    return { ...state, busy: state.busy || pending.has(key) };
  }
  if (pending.has(key))
    throw new PortalServiceError(
      'execution_failed',
      'A PR action is already running.',
    );
  pending.add(key);
  try {
    const state = await operations.state(target);
    if (state.busy)
      throw new PortalServiceError(
        'execution_failed',
        'A PR action is already running.',
      );
    // An explicit single repo makes the mobile confirmation concrete and avoids
    // silently merging siblings or committing a local-only repository.
    const ids = request.repoIds;
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string') {
      throw new PortalServiceError('invalid_payload', 'Select one repository.');
    }
    const repo = state.repos.find((entry) => entry.repoId === ids[0]);
    const identityMatches =
      repo?.baseBranch === request.expectedBaseBranch &&
      repo.headBranch === request.expectedHeadBranch &&
      (request.action !== 'merge' ||
        repo.status?.number === request.expectedPrNumber);
    if (
      !repo ||
      !identityMatches ||
      !(request.action === 'create_auto' ? repo.canCreate : repo.canMerge)
    ) {
      throw new PortalServiceError(
        'execution_failed',
        'PR state changed. Refresh and try again.',
      );
    }
    const scoped = {
      ...target,
      repoIds: ids,
      expectedBaseBranch: request.expectedBaseBranch,
      expectedHeadBranch: request.expectedHeadBranch,
    };
    if (request.action === 'create_auto') {
      const result = await operations.create(scoped);
      if (
        result.cancelled !== true &&
        result.repos.length === 0 &&
        (result.failedRepos?.length ?? 0) === 0 &&
        result.skippedRepos.length === 0 &&
        result.localOnlyCommittedRepos.length === 0
      ) {
        throw new PortalServiceError(
          'execution_failed',
          'Pull request creation failed. Refresh and try again.',
        );
      }
      return result;
    }
    const result = await operations.merge({
      ...scoped,
      expectedPrNumber: request.expectedPrNumber,
      confirmUnresolvedComments: request.confirmUnresolvedComments === true,
    });
    const refusal = result.verifiedRepos?.find(
      (entry) => entry.repoId === ids[0] && entry.mergeable === false,
    );
    if (
      refusal &&
      result.mergedRepos.length === 0 &&
      (result.mergeQueueChats ?? []).length === 0 &&
      result.requiresUnresolvedConfirmation.length === 0
    ) {
      throw new PortalServiceError(
        'execution_failed',
        refusal.blockedReason === 'in_merge_queue'
          ? describeMergeRefusal(refusal.blockedReason)
          : `${describeMergeRefusal(refusal.blockedReason)} Refresh and try again.`,
      );
    }
    if (
      result.cancelled !== true &&
      result.mergedRepos.length === 0 &&
      (result.mergeQueueChats ?? []).length === 0 &&
      result.requiresUnresolvedConfirmation.length === 0 &&
      result.failedRepos.length === 0 &&
      (result.verifiedRepos?.length ?? 0) === 0
    ) {
      throw new PortalServiceError(
        'execution_failed',
        'Pull request merge failed. Refresh and try again.',
      );
    }
    return result;
  } finally {
    pending.delete(key);
  }
}

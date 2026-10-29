import type { AppAdvisorActionErrorCode } from '@canopy/desktop-shared/types';
import type { PrStatusData } from '@canopy/desktop-shared/types/github';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import {
  type BaseBranchChangeChoice,
  useBaseBranchChangeStore,
} from '@/stores/baseBranchChangeStore';

export class BaseBranchChangeError extends Error {
  constructor(
    readonly code: AppAdvisorActionErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BaseBranchChangeError';
  }
}

export interface SetWorktreeBaseBranchRequest {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  baseBranch: string;
}

export interface SetWorktreeBaseBranchResult {
  status: 'updated';
  baseBranch: string;
  pullRequestUpdated: boolean;
}

interface PullRequestTarget {
  repoId?: string;
  repoName: string;
  status: PrStatusData;
}

export interface SetWorktreeBaseBranchOptions {
  requestId?: string;
  signal?: AbortSignal;
  confirmUpdatePullRequest?: (request: {
    requestId?: string;
    projectId: string;
    worktreeId: string;
    repoId?: string;
    repoName: string;
    baseBranch: string;
    prNumber: number;
  }) => Promise<BaseBranchChangeChoice | null>;
  onBeforePullRequestUpdate?: (request: {
    projectId: string;
    worktreeId: string;
    prNumber: number;
    previousBaseBranch: string;
    targetBaseBranch: string;
  }) => void;
  onPullRequestUpdateError?: () => void;
  onLocalOnlyPullRequestMismatch?: (request: {
    baseBranch: string;
    repoName: string;
  }) => void;
}

function requireTarget(request: SetWorktreeBaseBranchRequest): void {
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === request.projectId);
  if (!project) {
    throw new BaseBranchChangeError(
      'not_found',
      `Project "${request.projectId}" was not found.`,
    );
  }
  if (project.type === 'cowork') {
    throw new BaseBranchChangeError(
      'invalid_target',
      'Cowork projects do not have Git base branches.',
    );
  }
  if (
    !project.worktrees.some((worktree) => worktree.id === request.worktreeId)
  ) {
    throw new BaseBranchChangeError(
      'not_found',
      `Worktree "${request.worktreeId}" was not found in project "${request.projectId}".`,
    );
  }
  if (project.type === 'single-repo') {
    if (request.repoId !== undefined) {
      throw new BaseBranchChangeError(
        'invalid_target',
        'repoId must be omitted for a single-repository project.',
      );
    }
    return;
  }

  if (!request.repoId) {
    throw new BaseBranchChangeError(
      'invalid_target',
      'repoId is required for a multi-repository project.',
    );
  }
  const repoExists =
    project.repos.some((repo) => repo.id === request.repoId) ||
    (request.repoId === WORKSPACE_ROOT_REPO_ID &&
      typeof project.sourceRepoPath === 'string');
  if (!repoExists) {
    throw new BaseBranchChangeError(
      'invalid_target',
      `Repository "${request.repoId}" was not found in project "${request.projectId}".`,
    );
  }
}

async function awaitConfirmation(
  confirmation: Promise<BaseBranchChangeChoice | null>,
  requestId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<BaseBranchChangeChoice | null> {
  if (!signal) return confirmation;
  if (signal.aborted) {
    if (requestId) {
      useBaseBranchChangeStore.getState().cancelConfirmation(requestId);
    }
    return null;
  }

  let resolveAbort = (): void => undefined;
  const aborted = new Promise<null>((resolve) => {
    resolveAbort = (): void => resolve(null);
  });
  const onAbort = (): void => {
    if (requestId) {
      useBaseBranchChangeStore.getState().cancelConfirmation(requestId);
    }
    resolveAbort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([confirmation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function normalizeBaseBranch(baseBranch: string): string {
  const normalized = baseBranch.trim();
  if (!normalized || normalized.startsWith('-') || normalized === 'HEAD') {
    throw new BaseBranchChangeError(
      'validation_failed',
      'baseBranch must be a valid branch name and cannot be HEAD.',
    );
  }
  return normalized;
}

async function resolvePresence(
  request: Omit<SetWorktreeBaseBranchRequest, 'baseBranch'>,
  baseBranch: string,
): Promise<{ existsLocally: boolean; existsInRemote: boolean }> {
  let response: Awaited<ReturnType<typeof window.api.listBranches>>;
  try {
    response = await window.api.listBranches(request);
  } catch (error) {
    throw new BaseBranchChangeError(
      'execution_failed',
      error instanceof Error ? error.message : 'Failed to list branches.',
      true,
    );
  }
  const matches = response.branches.filter(
    (branch) => branch.name === baseBranch,
  );
  const presence = {
    existsLocally: matches.some((branch) => branch.hasLocalRef),
    existsInRemote: matches.some((branch) => branch.hasRemoteRef),
  };
  if (!presence.existsLocally && !presence.existsInRemote) {
    throw new BaseBranchChangeError(
      'validation_failed',
      `Base branch "${baseBranch}" is no longer available locally or on origin.`,
      true,
    );
  }
  return presence;
}

function findOpenPullRequest(
  request: SetWorktreeBaseBranchRequest,
): PullRequestTarget | null {
  const status =
    useGitHubStore.getState().prStatuses[
      createDiffStatsKey(request.projectId, request.worktreeId)
    ];
  const repo = request.repoId
    ? status?.repos.find((candidate) => candidate.repoId === request.repoId)
    : status?.repos.find(
        (candidate) =>
          candidate.status?.state === 'open' ||
          candidate.status?.state === 'draft',
      );
  if (
    !repo?.status ||
    (repo.status.state !== 'open' && repo.status.state !== 'draft')
  ) {
    return null;
  }
  return {
    repoId: request.repoId,
    repoName: repo.repoName,
    status: repo.status,
  };
}

function assertNoActivePullRequestOperation(
  projectId: string,
  worktreeId: string,
): void {
  const key = createDiffStatsKey(projectId, worktreeId);
  const state = useGitHubStore.getState();
  if (
    state.splitLockedWorktrees.has(key) ||
    state.committingAndPushing.has(key) ||
    state.creatingPr.has(key) ||
    state.mergingLocalBranches.has(key) ||
    state.mergingPr.has(key)
  ) {
    throw new BaseBranchChangeError(
      'surface_unavailable',
      'The pull request base cannot be changed while another Git operation is active for this worktree.',
      true,
    );
  }
}

function isSamePullRequest(
  current: PullRequestTarget | null,
  expected: PullRequestTarget,
): boolean {
  return (
    current?.status.prNumber === expected.status.prNumber &&
    current.status.baseRefName?.trim() === expected.status.baseRefName?.trim()
  );
}

export async function setWorktreeBaseBranch(
  request: SetWorktreeBaseBranchRequest,
  options: SetWorktreeBaseBranchOptions = {},
): Promise<SetWorktreeBaseBranchResult | { status: 'cancelled' }> {
  requireTarget(request);
  const baseBranch = normalizeBaseBranch(request.baseBranch);
  let presence = await resolvePresence(
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      repoId: request.repoId,
    },
    baseBranch,
  );
  const openPullRequest = findOpenPullRequest(request);
  let choice: BaseBranchChangeChoice = 'local-only';

  if (openPullRequest && presence.existsInRemote) {
    const confirm =
      options.confirmUpdatePullRequest ??
      useBaseBranchChangeStore.getState().requestConfirmation;
    const confirmedChoice = await awaitConfirmation(
      confirm({
        ...(options.requestId ? { requestId: options.requestId } : {}),
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        repoId: request.repoId,
        repoName: openPullRequest.repoName,
        baseBranch,
        prNumber: openPullRequest.status.prNumber,
      }),
      options.requestId,
      options.signal,
    );
    if (confirmedChoice === null || options.signal?.aborted) {
      return { status: 'cancelled' };
    }
    choice = confirmedChoice;
  }

  if (choice === 'update-pr' && openPullRequest) {
    assertNoActivePullRequestOperation(request.projectId, request.worktreeId);
    if (!isSamePullRequest(findOpenPullRequest(request), openPullRequest)) {
      throw new BaseBranchChangeError(
        'stale_ui_state',
        'The open pull request changed while the base-branch confirmation was open. Review the latest state and try again.',
        true,
      );
    }
    presence = await resolvePresence(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        repoId: request.repoId,
      },
      baseBranch,
    );
  } else if (openPullRequest && presence.existsInRemote) {
    // A confirmation can stay open while refs change. The local-only choice
    // still revalidates availability before persisting stale metadata.
    presence = await resolvePresence(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        repoId: request.repoId,
      },
      baseBranch,
    );
  }

  if (choice === 'update-pr' && !presence.existsInRemote) {
    choice = 'local-only';
  }

  if (choice === 'update-pr' && openPullRequest) {
    options.onBeforePullRequestUpdate?.({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      prNumber: openPullRequest.status.prNumber,
      previousBaseBranch: openPullRequest.status.baseRefName?.trim() ?? '',
      targetBaseBranch: baseBranch,
    });
  }

  if (options.signal?.aborted) {
    return { status: 'cancelled' };
  }

  await useProjectsStore
    .getState()
    .setTrackedBaseBranch(
      request.projectId,
      request.worktreeId,
      baseBranch,
      request.repoId,
      presence,
    );

  if (options.signal?.aborted) {
    return { status: 'cancelled' };
  }

  if (openPullRequest && !presence.existsInRemote) {
    options.onLocalOnlyPullRequestMismatch?.({
      baseBranch,
      repoName: openPullRequest.repoName,
    });
  }

  if (choice === 'update-pr' && openPullRequest) {
    try {
      await window.api.github.updatePrBaseBranch({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        ...(request.repoId ? { repoId: request.repoId } : {}),
        prNumber: openPullRequest.status.prNumber,
        newBaseBranch: baseBranch,
      });
    } catch (error) {
      options.onPullRequestUpdateError?.();
      throw new BaseBranchChangeError(
        'execution_failed',
        error instanceof Error
          ? error.message
          : 'Failed to update the pull request base branch.',
      );
    }
  }

  return {
    status: 'updated',
    baseBranch,
    pullRequestUpdated: choice === 'update-pr',
  };
}

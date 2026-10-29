import {
  pushBranchWithAuthFailure,
  withGitHubPushAuthFailure,
} from '../lib/github-push';
import { githubAuthFailureCode } from '../lib/github-push-auth-failure';
import type {
  PortalPrRepoFailure,
  PortalPrMutationResult,
} from '@canopy/protocol/portal';
import { runWorktreePrAction } from './pr-worktree-actions';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';
import type {
  CheckDetail,
  PortalPrCreatePayload,
  PortalPrActionPayload,
  PortalPrRefreshPayload,
  PortalPullRequestCheckDetail,
  PortalPullRequestRepo,
  PortalPullRequestRepoStatus,
  PortalPullRequestState,
} from '@canopy/desktop-shared/types';
import type {
  CreatePrResponse,
  RepoFailureResult,
  PrStatusData,
  RepoPrStatus,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import { isPrReadyToMerge } from '@canopy/desktop-shared/types/github';
import {
  clearStalePrCreationProgress,
  getPrCreationProgress,
  rememberPortalPrState,
} from './pr-creation-progress';
import { getPrMergeProgressFeed } from './pr-merge-progress';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';
import { getResolvedGitExecutableForSpawn } from '../lib/git-executable';
import {
  fetchPrStatusForWorktree,
  createPrForRepo,
  updatePrBaseBranchForRepo,
} from '../lib/github-pr';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateId } from '../lib/validation';
import {
  commitWithMessage,
  getCurrentBranch,
  hasUncommittedChanges,
  pullBranchRebase,
  stageAllChanges,
} from '../lib/git';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { PortalServiceError } from './portal-service-error';
import { triggerWorktreePrecommitFailureHook } from '../lib/worktree-precommit-failure-hook';
import { resolveFreshDefaultBranch } from '../lib/git-default-branch';
import { refreshNow } from '../lib/github-poller';
import {
  addWorktreePrStatusChangeListener,
  type WorktreePrStatusChangeListener,
} from '../lib/pr-status-change-emitter';
import { getSharedContainerPublishScheduler } from '../shared-containers/publish/scheduler';

const execFileAsync = promisify(execFile);
const GITHUB_CONNECT_MESSAGE = 'Connect GitHub on the desktop, then retry.';

type PortalCreatePrResponse = Omit<CreatePrResponse, 'failedRepos'> & {
  failedRepos?: PortalPrRepoFailure[];
};

function toPortalPrFailure(failure: RepoFailureResult): PortalPrRepoFailure {
  const result: PortalPrRepoFailure = {
    repoId: failure.repoId,
    repoName: failure.repoName,
    error: failure.error,
    status: failure.status,
  };
  return failure.failureCode === 'github_not_authenticated'
    ? {
        ...result,
        error: GITHUB_CONNECT_MESSAGE,
        failureCode: 'github_not_connected',
      }
    : result;
}

function githubNotConnected(): PortalServiceError {
  return new PortalServiceError('github_not_connected', GITHUB_CONNECT_MESSAGE);
}

async function refreshDesktopPrStatus(
  workspaceLocalId: string,
  worktreeLocalId: string,
): Promise<void> {
  await refreshNow(workspaceLocalId, worktreeLocalId).catch(() => undefined);
}

async function scheduleSharedContainerPublicationAfterPush(
  workspaceLocalId: string,
  worktreeLocalId: string,
): Promise<void> {
  await getSharedContainerPublishScheduler()
    .scheduleKnown(workspaceLocalId, worktreeLocalId)
    .catch(() => undefined);
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    await getResolvedGitExecutableForSpawn(),
    args,
    {
      cwd,
      windowsHide: process.platform === 'win32',
    },
  );
  return stdout.trim();
}

function toPortalReviewStatus(
  status: 'approved' | 'changes_requested' | 'pending' | 'none' | undefined,
): 'approved' | 'changes-requested' | 'pending' | 'none' | undefined {
  if (status === 'approved') return 'approved';
  if (status === 'changes_requested') return 'changes-requested';
  if (status === 'pending') return 'pending';
  // CAN-1528 L2: surface "no reviews" explicitly instead of collapsing it
  // into an absent field; renderers treat absent and 'none' the same.
  if (status === 'none') return 'none';
  return undefined;
}

/**
 * Map the desktop's per-check `CheckStatus` (`'passing' | 'failing' |
 * 'pending' | 'neutral' | 'none'`) onto the portal protocol's narrower
 * per-check status union. `'none'` is dropped — `none` is meaningful for
 * the aggregate "no checks configured" state but not for an individual
 * check row.
 */
function toPortalCheckDetails(
  details: CheckDetail[] | undefined,
): PortalPullRequestCheckDetail[] | undefined {
  if (!details || details.length === 0) return undefined;
  const mapped: PortalPullRequestCheckDetail[] = [];
  for (const check of details) {
    let status: PortalPullRequestCheckDetail['status'] | null = null;
    if (check.status === 'passing') status = 'success';
    else if (check.status === 'failing') status = 'failure';
    else if (check.status === 'pending') status = 'pending';
    else if (check.status === 'neutral') status = 'neutral';
    if (status !== null) {
      mapped.push({
        name: check.name,
        status,
        ...(check.executionState === undefined
          ? {}
          : { executionState: check.executionState }),
        detailsUrl: check.detailsUrl,
      });
    }
  }
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Project one repo's `PrStatusData` onto the flat per-repo portal shape
 * (CAN-1528 L2). Merge readiness is computed here with the shared
 * `isPrReadyToMerge` — its inputs (`mergeable`/`mergeableState`) are
 * desktop-only, so browser code never re-implements the semantics.
 */
function toPortalRepoStatus(status: PrStatusData): PortalPullRequestRepoStatus {
  return {
    number: status.prNumber,
    url: status.prUrl,
    state: status.state,
    baseRefName: status.baseRefName,
    title: status.title,
    checkStatus: status.checkStatus,
    checkDetails: toPortalCheckDetails(status.checkDetails),
    reviewStatus: toPortalReviewStatus(status.reviewStatus),
    labels: status.labels,
    hasConflicts: status.hasConflicts,
    commentCount: status.commentCount,
    unresolvedReviewThreadCount: status.unresolvedReviewThreadCount,
    updatedAt: status.updatedAt,
    mergeReady: isPrReadyToMerge(status),
  };
}

function toPortalRepo(repo: RepoPrStatus): PortalPullRequestRepo {
  return {
    repoId: repo.repoId,
    repoName: repo.repoName,
    status: repo.status ? toPortalRepoStatus(repo.status) : null,
    ...(repo.prLookupAvailable !== undefined
      ? { prLookupAvailable: repo.prLookupAvailable }
      : {}),
  };
}

export async function refreshPullRequestState(
  request: PortalPrRefreshPayload,
): Promise<PortalPullRequestState> {
  validateId(request.workspaceLocalId, 'workspaceLocalId');
  validateId(request.worktreeLocalId, 'worktreeLocalId');
  const status = await fetchPrStatusForWorktree(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  return buildPortalPrState(request, status);
}

/**
 * Project an already-fetched worktree PR status onto the portal shape,
 * attaching live creation/merge feeds and remembering the result for
 * worktree-scope snapshots.
 */
function buildPortalPrState(
  request: PortalPrRefreshPayload,
  status: WorktreePrStatus | null,
): PortalPullRequestState {
  const first = status?.repos[0]?.status;
  const state: PortalPullRequestState = {
    workspaceLocalId: request.workspaceLocalId,
    worktreeLocalId: request.worktreeLocalId,
    number: first?.prNumber ?? null,
    url: first?.prUrl ?? null,
    state: first?.state,
    baseBranch: first?.baseRefName,
    title: first?.title,
    checkStatus: first?.checkStatus,
    checkDetails: toPortalCheckDetails(first?.checkDetails),
    reviewStatus: toPortalReviewStatus(first?.reviewStatus),
    hasConflicts: first?.hasConflicts,
    commentCount: first?.commentCount,
    updatedAt: first?.updatedAt,
    // CAN-1528 L2 additive fields. The flat fields above stay populated from
    // the primary repo for back-compat readers; `repos` carries every repo.
    labels: first?.labels,
    mergeReady: first ? isPrReadyToMerge(first) : undefined,
    repos: status?.repos.map(toPortalRepo),
  };
  // Drop a completed or stale-error creation feed once every repo has a PR, then attach
  // the (possibly cleared) feed — mirrors the renderer store's stale-progress
  // clearing so both surfaces settle to the PR card together.
  const clearedCreationProgress = clearStalePrCreationProgress(
    request.workspaceLocalId,
    request.worktreeLocalId,
    state,
  );
  const creationProgress = getPrCreationProgress(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  if (creationProgress !== undefined) {
    state.creationProgress = creationProgress;
  } else if (clearedCreationProgress) {
    state.creationProgress = null;
  }
  const mergeProgress = getPrMergeProgressFeed(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  if (mergeProgress !== undefined) {
    state.mergeProgress = mergeProgress;
  }
  rememberPortalPrState(state);
  return state;
}

async function refreshPullRequestStateAfterMutation(
  request: PortalPrRefreshPayload,
): Promise<PortalPullRequestState> {
  const state = await refreshPullRequestState(request);
  await refreshDesktopPrStatus(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  return state;
}

/**
 * Re-project the worktree's `pr_status` to a connected portal outside the
 * command path (CAN-1528 L2). The live creation-feed deltas carry the
 * last-remembered payload, which predates a just-created PR — this refreshes
 * the projection (re-reading the creation feed and remembering the fresh
 * payload) and pushes it as an unsolicited delta. Never throws; no-op
 * without an active portal session.
 */
export async function projectPortalPrStatus(
  workspaceLocalId: string,
  worktreeLocalId: string,
): Promise<void> {
  if (!isCanopyPortalActive()) return;
  try {
    enqueuePortalPrStatusDelta(
      await refreshPullRequestState({
        workspaceLocalId,
        worktreeLocalId,
      }),
    );
  } catch {
    // Best-effort: the next snapshot request reconciles the portal.
  }
}

function enqueuePortalPrStatusDelta(state: PortalPullRequestState): void {
  const { workspaceLocalId, worktreeLocalId } = state;
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'pr',
      target: { workspaceLocalId, worktreeLocalId },
      entities: [
        {
          entityType: 'pr_status',
          localId: worktreeLocalId,
          parentLocalId: worktreeScopedParentLocalId(
            workspaceLocalId,
            worktreeLocalId,
          ),
          payload: state,
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
  );
}

/**
 * Push each PR status change the desktop GitHub poller observes to a connected
 * portal, so remote clients hold current PR state without asking for it. The
 * poller already fetched the status; projecting it costs no GitHub requests.
 */
const projectPolledPrStatus: WorktreePrStatusChangeListener = ({
  projectId,
  worktreeId,
  status,
}) => {
  // A null worktree status means the poller had no repository targets to
  // query, so it cannot confirm that a previously known PR was removed.
  if (!isCanopyPortalActive() || status === null) return;
  try {
    enqueuePortalPrStatusDelta(
      buildPortalPrState(
        { workspaceLocalId: projectId, worktreeLocalId: worktreeId },
        status,
      ),
    );
  } catch {
    // Best-effort: the next snapshot request reconciles the portal.
  }
};

/** Idempotent: the emitter keeps listeners in a set. */
export function registerPortalPrStatusProjection(): void {
  addWorktreePrStatusChangeListener(projectPolledPrStatus);
}

export async function createPullRequest(
  request: PortalPrCreatePayload,
): Promise<PortalPullRequestState> {
  validateId(request.workspaceLocalId, 'workspaceLocalId');
  validateId(request.worktreeLocalId, 'worktreeLocalId');
  const cwd = resolveWorktreeCwd(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  const branch = await git(['branch', '--show-current'], cwd);
  const baseBranch = await resolveFreshDefaultBranch(cwd);
  if (!baseBranch) {
    throw new Error(
      'Unable to resolve the default branch for this repository.',
    );
  }
  const pr = await createPrForRepo(
    cwd,
    branch,
    request.title,
    request.body,
    baseBranch,
    request.draft,
  ).catch((error: unknown) => {
    if (githubAuthFailureCode(error)) throw githubNotConnected();
    throw error;
  });
  const state: PortalPullRequestState = {
    workspaceLocalId: request.workspaceLocalId,
    worktreeLocalId: request.worktreeLocalId,
    number: pr.prNumber,
    url: pr.prUrl,
    state: 'open',
    baseBranch,
    headBranch: branch,
    title: request.title,
    body: request.body,
    draft: request.draft,
  };
  rememberPortalPrState(state);
  await refreshDesktopPrStatus(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  return state;
}

export async function runPrAction(
  request: PortalPrActionPayload,
  options: { getWindow?: () => BrowserWindow | null } = {},
): Promise<
  | PortalPullRequestState
  | { ok: true }
  | Awaited<ReturnType<typeof runWorktreePrAction>>
  | PortalCreatePrResponse
> {
  validateId(request.workspaceLocalId, 'workspaceLocalId');
  validateId(request.worktreeLocalId, 'worktreeLocalId');

  try {
    switch (request.action) {
      case 'get_actions':
        return runWorktreePrAction(request);
      case 'create_auto': {
        const result = await runWorktreePrAction(request);
        if (!('repos' in result) || !('skippedRepos' in result)) return result;
        const failedRepos = result.failedRepos?.map(toPortalPrFailure);
        if (
          !result.repos.length &&
          !result.localOnlyCommittedRepos.length &&
          failedRepos?.some(
            (failure) => failure.failureCode === 'github_not_connected',
          )
        )
          throw githubNotConnected();
        await refreshDesktopPrStatus(
          request.workspaceLocalId,
          request.worktreeLocalId,
        );
        return { ...result, failedRepos };
      }
      case 'merge': {
        const result = await runWorktreePrAction(request);
        await refreshDesktopPrStatus(
          request.workspaceLocalId,
          request.worktreeLocalId,
        );
        return result;
      }
      case 'create':
        if (!request.title.trim() || !request.body.trim()) {
          throw new PortalServiceError(
            'invalid_payload',
            'title and body are required.',
          );
        }
        return await createPullRequest({
          workspaceLocalId: request.workspaceLocalId,
          worktreeLocalId: request.worktreeLocalId,
          title: request.title,
          body: request.body,
          draft: request.draft,
        });
      case 'push':
        return await pushTargetRepos(request, options);
      case 'commit_and_push':
        if (!request.commitMessage.trim())
          throw new PortalServiceError(
            'invalid_payload',
            'commitMessage is required.',
          );
        return await pushTargetRepos(request, options);
      case 'pull':
        for (const repo of await resolveTargetRepos(request)) {
          const branch = await getCurrentBranch(repo.repoPath);
          await pullBranchRebase(repo.repoPath, branch);
        }
        return refreshPullRequestStateAfterMutation(request);
      case 'update_base_branch':
        if (!request.baseBranch.trim()) {
          throw new PortalServiceError(
            'invalid_payload',
            'baseBranch is required.',
          );
        }
        await updateBaseBranch(request);
        return refreshPullRequestStateAfterMutation(request);
      default:
        return { ok: true };
    }
  } catch (error) {
    if (error instanceof PortalServiceError) throw error;
    if (githubAuthFailureCode(error)) throw githubNotConnected();
    throw new PortalServiceError(
      'execution_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function pushTargetRepos(
  request: Extract<
    PortalPrActionPayload,
    { action: 'push' | 'commit_and_push' }
  >,
  options: { getWindow?: () => BrowserWindow | null },
): Promise<PortalPullRequestState> {
  const result: PortalPrMutationResult = { repos: [], failedRepos: [] };
  let firstError: unknown;
  for (const repo of await resolveTargetRepos(request)) {
    try {
      if (
        request.action === 'commit_and_push' &&
        (await hasUncommittedChanges(repo.repoPath))
      ) {
        await stageAllChanges(repo.repoPath);
        try {
          await commitWithMessage(repo.repoPath, request.commitMessage);
        } catch (error) {
          await triggerWorktreePrecommitFailureHook({
            projectId: request.workspaceLocalId,
            worktreeId: request.worktreeLocalId,
            repo,
            error,
            commitMessage: request.commitMessage,
            getWindow: options.getWindow,
          }).catch(() => {});
          throw error;
        }
      }
      await pushBranchWithAuthFailure(repo.repoPath);
      result.repos.push({ repoId: repo.repoId, repoName: repo.repoName });
      await scheduleSharedContainerPublicationAfterPush(
        request.workspaceLocalId,
        request.worktreeLocalId,
      );
    } catch (error) {
      firstError ??= error;
      const auth = githubAuthFailureCode(error) !== undefined;
      result.failedRepos.push({
        repoId: repo.repoId,
        repoName: repo.repoName,
        status: 'failed',
        error: auth
          ? GITHUB_CONNECT_MESSAGE
          : error instanceof Error
            ? error.message
            : String(error),
        ...(auth ? { failureCode: 'github_not_connected' } : {}),
      });
    }
  }
  if (!result.repos.length && result.failedRepos.length) {
    if (
      result.failedRepos.some(
        (failure) => failure.failureCode === 'github_not_connected',
      )
    )
      throw githubNotConnected();
    throw firstError;
  }
  if (!result.failedRepos.length)
    return refreshPullRequestStateAfterMutation(request);
  // A status read can fail for the same missing credential. Never lose a
  // successful mutation merely because its follow-up read cannot authenticate.
  const state = await refreshPullRequestStateAfterMutation(request).catch(
    (): PortalPullRequestState => ({
      workspaceLocalId: request.workspaceLocalId,
      worktreeLocalId: request.worktreeLocalId,
      number: null,
      url: null,
    }),
  );
  return { ...state, mutationResult: result };
}

async function resolveTargetRepos(request: {
  workspaceLocalId: string;
  worktreeLocalId: string;
  repoIds?: string[];
}): Promise<Array<{ repoId: string; repoName: string; repoPath: string }>> {
  const cwd = resolveWorktreeCwd(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  const { items } = await readAllSidebarItems();
  const item = items.find(
    (candidate) => candidate.id === request.workspaceLocalId,
  );
  const repos =
    item?.type === 'multi-repo'
      ? await listWorkspaceWorktreeRepoEntries(request.workspaceLocalId, cwd)
      : [
          {
            repoId: item?.id ?? request.workspaceLocalId,
            repoName: item?.name ?? request.workspaceLocalId,
            repoPath: cwd,
          },
        ];
  if (!request.repoIds?.length) return repos;
  const allowed = new Set(request.repoIds);
  return repos.filter((repo) => allowed.has(repo.repoId));
}

async function updateBaseBranch(
  request: Extract<PortalPrActionPayload, { action: 'update_base_branch' }>,
): Promise<void> {
  const [repos, status] = await Promise.all([
    resolveTargetRepos(request),
    fetchPrStatusForWorktree(request.workspaceLocalId, request.worktreeLocalId),
  ]);
  const statusByRepo = new Map(
    (status?.repos ?? []).map((repo) => [repo.repoId, repo.status]),
  );
  for (const repo of repos) {
    const repoStatus = statusByRepo.get(repo.repoId);
    const prNumber = repoStatus?.prNumber;
    if (!prNumber) continue;
    if (request.rebaseOntoNewBase) {
      if (await hasUncommittedChanges(repo.repoPath)) {
        throw new PortalServiceError(
          'execution_failed',
          `Repo "${repo.repoName}" has uncommitted changes.`,
        );
      }
      await git(['fetch', 'origin', request.baseBranch], repo.repoPath);
      await git(['rebase', `origin/${request.baseBranch}`], repo.repoPath);
    }
    await updatePrBaseBranchForRepo(
      repo.repoPath,
      prNumber,
      request.baseBranch,
    );
    if (request.rebaseOntoNewBase) {
      await withGitHubPushAuthFailure(repo.repoPath, () =>
        git(['push', '--force-with-lease', 'origin', 'HEAD'], repo.repoPath),
      );
    }
  }
}

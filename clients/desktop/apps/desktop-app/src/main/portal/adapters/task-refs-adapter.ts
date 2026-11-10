import type {
  HomeBranchTargetsResponse,
  PullRequestSummary,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  PortalTaskRef,
  PortalTaskRefsListPayload,
  PortalTaskRefsListResult,
} from '@canopy/protocol/portal';
import { isGitHubBrokerError } from '../../lib/github-broker/errors';
import { listCheckedOutBranches } from '../../lib/git';
import {
  getPullRequestListingCacheGeneration,
  listOpenPullRequestsForRepo,
} from '../../lib/github-pr-listing';
import { readWorkspaceConfig } from '../../lib/workspace-persistence';
import { recordedRepositoryPath } from '../../lib/workspace-recorded-repo';
import { readWorkspaceIndexEntry } from '../../lib/sidebar-items';
import { resolveWorkspaceReferenceRepoPath } from '../../lib/workspace-reference-repo';
import { validateId } from '../../lib/validation';
import { getDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { listHomeBranchTargets } from '../../canopy-runtime/worker-git-dispatch';
import { findManagedCheckoutWorktreeId } from './worktree-checkout-owner';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';

const INVALID_PAYLOAD_MESSAGE = 'Invalid task reference list request.';
const WORKSPACE_NOT_FOUND_MESSAGE = 'Workspace not found.';
const WORKSPACE_READ_FAILED_MESSAGE = 'Task references could not be loaded.';
const UNSUPPORTED_PROJECT_MESSAGE =
  'This project does not support task reference listings.';
const BRANCH_LIST_FAILED_MESSAGE = 'Task branches could not be listed.';
const GITHUB_NOT_CONNECTED_MESSAGE = 'Connect GitHub to list pull requests.';
const PULL_REQUEST_LIST_FAILED_MESSAGE = 'Pull requests could not be listed.';
const PULL_REQUESTS_CHANGED_MESSAGE =
  'The pull request list changed while loading. Try again.';

const PULL_REQUEST_PREFIX_TTL_MS = 60_000;
const PULL_REQUEST_PAGE_SIZE = 100;
// shortcut: cap each repository at 10 raw pages (1,000 open PRs). Raise this
// only after measuring GitHub request cost and preserving stable tie groups.
const PULL_REQUEST_MAX_RAW_PAGES = 10;
const PULL_REQUEST_MAX_RAW_ROWS =
  PULL_REQUEST_PAGE_SIZE * PULL_REQUEST_MAX_RAW_PAGES;
const PULL_REQUEST_PREFIX_CACHE_MAX_REPOS = 32;

const TASK_REFS_MAIN_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-task-refs',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [],
};

interface PullRequestPrefix {
  rows: PullRequestSummary[];
  cachedAt: number;
  exhausted: boolean;
  capped: boolean;
}

interface PullRequestCandidate {
  repoPath: string;
  pullRequest: PullRequestSummary;
}

class PullRequestListingGenerationChangedError extends Error {
  constructor() {
    super(PULL_REQUESTS_CHANGED_MESSAGE);
    this.name = 'PullRequestListingGenerationChangedError';
  }
}

const pullRequestPrefixes = new Map<string, PullRequestPrefix>();
const pendingPrefixExtensions = new Map<string, Promise<void>>();
let observedPullRequestGeneration: number | undefined;

function pullRequestCacheKey(repoPath: string, generation: number): string {
  return JSON.stringify([repoPath, generation]);
}

function observePullRequestGeneration(): number {
  const generation = getPullRequestListingCacheGeneration();
  if (observedPullRequestGeneration !== generation) {
    pullRequestPrefixes.clear();
    pendingPrefixExtensions.clear();
    observedPullRequestGeneration = generation;
  }
  return generation;
}

function evictPullRequestPrefixes(): void {
  while (pullRequestPrefixes.size > PULL_REQUEST_PREFIX_CACHE_MAX_REPOS) {
    let removedEntry = false;
    for (const key of pullRequestPrefixes.keys()) {
      if (!pendingPrefixExtensions.has(key)) {
        pullRequestPrefixes.delete(key);
        removedEntry = true;
        break;
      }
    }
    if (!removedEntry) return;
  }
}

function getPullRequestPrefix(
  repoPath: string,
  generation: number,
): { key: string; prefix: PullRequestPrefix } {
  const key = pullRequestCacheKey(repoPath, generation);
  const existing = pullRequestPrefixes.get(key);
  if (
    existing &&
    (Date.now() - existing.cachedAt < PULL_REQUEST_PREFIX_TTL_MS ||
      pendingPrefixExtensions.has(key))
  ) {
    pullRequestPrefixes.delete(key);
    pullRequestPrefixes.set(key, existing);
    return { key, prefix: existing };
  }

  if (existing) pullRequestPrefixes.delete(key);
  const prefix: PullRequestPrefix = {
    rows: [],
    cachedAt: Date.now(),
    exhausted: false,
    capped: false,
  };
  pullRequestPrefixes.set(key, prefix);
  evictPullRequestPrefixes();
  return { key, prefix };
}

function parseUpdatedAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function pullRequestUpdatedAt(
  pullRequest: PullRequestSummary,
): string | undefined {
  if (!('updatedAt' in pullRequest)) return undefined;
  return typeof pullRequest.updatedAt === 'string'
    ? pullRequest.updatedAt
    : undefined;
}

function compareCodepoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePullRequests(
  left: PullRequestCandidate,
  right: PullRequestCandidate,
): number {
  const leftUpdatedAt = parseUpdatedAt(pullRequestUpdatedAt(left.pullRequest));
  const rightUpdatedAt = parseUpdatedAt(
    pullRequestUpdatedAt(right.pullRequest),
  );
  if (leftUpdatedAt !== rightUpdatedAt) {
    if (leftUpdatedAt === undefined) return 1;
    if (rightUpdatedAt === undefined) return -1;
    return leftUpdatedAt > rightUpdatedAt ? -1 : 1;
  }
  if (left.pullRequest.number !== right.pullRequest.number) {
    return left.pullRequest.number > right.pullRequest.number ? -1 : 1;
  }
  return compareCodepoint(left.repoPath, right.repoPath);
}

function matchesPullRequestQuery(
  pullRequest: PullRequestSummary,
  query: string | undefined,
): boolean {
  if (query === undefined) return true;
  const normalizedQuery = query.toLowerCase();
  return (
    pullRequest.title.toLowerCase().includes(normalizedQuery) ||
    String(pullRequest.number).includes(normalizedQuery) ||
    pullRequest.headRefName.toLowerCase().includes(normalizedQuery)
  );
}

function filteredPullRequestCandidates(
  prefix: PullRequestPrefix,
  repoPath: string,
  query: string | undefined,
): PullRequestCandidate[] {
  const uniquePullRequests = new Map<number, PullRequestSummary>();
  for (const pullRequest of prefix.rows) {
    if (
      pullRequest.isCrossRepo ||
      !matchesPullRequestQuery(pullRequest, query) ||
      uniquePullRequests.has(pullRequest.number)
    ) {
      continue;
    }
    uniquePullRequests.set(pullRequest.number, pullRequest);
  }
  return Array.from(uniquePullRequests.values())
    .map((pullRequest) => ({ repoPath, pullRequest }))
    .sort(comparePullRequests);
}

function isBoundaryTieComplete(
  prefix: PullRequestPrefix,
  candidates: PullRequestCandidate[],
  targetCount: number,
): boolean {
  const boundaryCandidate = candidates[targetCount - 1];
  if (!boundaryCandidate) return false;
  const boundaryTimestamp = parseUpdatedAt(
    pullRequestUpdatedAt(boundaryCandidate.pullRequest),
  );
  const rawTail = prefix.rows[prefix.rows.length - 1];
  if (!rawTail || boundaryTimestamp === undefined) return false;
  const rawTailTimestamp = parseUpdatedAt(pullRequestUpdatedAt(rawTail));
  return rawTailTimestamp !== undefined && rawTailTimestamp < boundaryTimestamp;
}

async function extendPullRequestPrefix(
  repoPath: string,
  key: string,
  prefix: PullRequestPrefix,
  generation: number,
): Promise<void> {
  const existing = pendingPrefixExtensions.get(key);
  if (existing) {
    await existing;
    return;
  }

  const page = Math.floor(prefix.rows.length / PULL_REQUEST_PAGE_SIZE) + 1;
  const extension = listOpenPullRequestsForRepo(repoPath, undefined, {
    page,
    perPage: PULL_REQUEST_PAGE_SIZE,
  })
    .then((rows) => {
      if (getPullRequestListingCacheGeneration() !== generation) {
        throw new PullRequestListingGenerationChangedError();
      }
      prefix.rows.push(...rows);
      prefix.cachedAt = Date.now();
      if (rows.length < PULL_REQUEST_PAGE_SIZE) prefix.exhausted = true;
      if (page >= PULL_REQUEST_MAX_RAW_PAGES) prefix.capped = true;
    })
    .finally(() => {
      if (pendingPrefixExtensions.get(key) === extension) {
        pendingPrefixExtensions.delete(key);
      }
      evictPullRequestPrefixes();
    });

  pendingPrefixExtensions.set(key, extension);
  await extension;
}

async function ensurePullRequestPrefix(
  repoPath: string,
  query: string | undefined,
  targetCount: number,
  generation: number,
): Promise<PullRequestPrefix> {
  const { key, prefix } = getPullRequestPrefix(repoPath, generation);
  const countToCover = Math.min(targetCount, PULL_REQUEST_MAX_RAW_ROWS);

  while (!prefix.exhausted && !prefix.capped) {
    if (getPullRequestListingCacheGeneration() !== generation) {
      throw new PullRequestListingGenerationChangedError();
    }
    const candidates = filteredPullRequestCandidates(prefix, repoPath, query);
    const hasEnough = candidates.length >= countToCover;
    const tieGroupComplete =
      hasEnough && isBoundaryTieComplete(prefix, candidates, countToCover);
    if (hasEnough && tieGroupComplete) break;
    await extendPullRequestPrefix(repoPath, key, prefix, generation);
  }
  return prefix;
}

function workspaceRepoPaths(config: WorkspaceConfigFile): string[] {
  if (config.type === 'single-repo') {
    return config.repoPath ? [config.repoPath] : [];
  }
  if (config.type === 'multi-repo') {
    return [
      ...(config.sourceRepoPath ? [config.sourceRepoPath] : []),
      ...config.repos.map((repo) => repo.repoPath),
    ];
  }
  return [];
}

async function canonicalWorkspaceRepoPaths(
  config: WorkspaceConfigFile,
): Promise<string[]> {
  const canonicalPaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const repoPath of workspaceRepoPaths(config)) {
    const canonicalPath = await resolveWorkspaceReferenceRepoPath(repoPath);
    if (canonicalPath.length === 0 || seenPaths.has(canonicalPath)) continue;
    seenPaths.add(canonicalPath);
    canonicalPaths.push(canonicalPath);
  }
  return canonicalPaths;
}

async function checkoutMapsForRepoPaths(
  repoPaths: string[],
): Promise<Map<string, Map<string, string>>> {
  const checkoutMaps = new Map<string, Map<string, string>>();
  await Promise.all(
    repoPaths.map(async (repoPath): Promise<void> => {
      try {
        checkoutMaps.set(repoPath, await listCheckedOutBranches(repoPath));
      } catch {
        // Checkout annotations are optional; a stale local repo must not hide refs.
        checkoutMaps.set(repoPath, new Map<string, string>());
      }
    }),
  );
  return checkoutMaps;
}

async function checkedOutWorktreeId(
  workspaceId: string,
  branchName: string,
  repoPaths: string[],
  checkoutMaps: Map<string, Map<string, string>>,
): Promise<string | undefined> {
  for (const repoPath of repoPaths) {
    const checkoutPath = checkoutMaps.get(repoPath)?.get(branchName);
    if (checkoutPath === undefined) continue;
    try {
      const worktreeId = await findManagedCheckoutWorktreeId(
        workspaceId,
        checkoutPath,
      );
      if (worktreeId !== undefined) return worktreeId;
    } catch {
      // The owner helper is best-effort and its result is optional metadata.
    }
  }
  return undefined;
}

async function annotateBranches(
  workspaceId: string,
  targets: HomeBranchTargetsResponse,
  repoPaths: string[],
): Promise<PortalTaskRef[]> {
  const checkoutMaps = await checkoutMapsForRepoPaths(repoPaths);
  const sortedBranches = [...targets.branches].sort((left, right) => {
    const leftIsDefault = left.name === targets.defaultBranch;
    const rightIsDefault = right.name === targets.defaultBranch;
    if (leftIsDefault !== rightIsDefault) return leftIsDefault ? -1 : 1;
    return compareCodepoint(left.name, right.name);
  });
  return Promise.all(
    sortedBranches.map(async (branch): Promise<PortalTaskRef> => {
      const worktreeId = await checkedOutWorktreeId(
        workspaceId,
        branch.name,
        repoPaths,
        checkoutMaps,
      );
      const checkedOut = repoPaths.some(
        (repoPath) => checkoutMaps.get(repoPath)?.has(branch.name) === true,
      );
      return {
        kind: 'branch',
        name: branch.name,
        local: branch.hasLocalRef,
        remote: branch.hasRemoteRef,
        isDefault: branch.name === targets.defaultBranch,
        ...(checkedOut ? { checkedOut: true } : {}),
        ...(worktreeId === undefined
          ? {}
          : { checkedOutWorktreeId: worktreeId }),
      };
    }),
  );
}

function toPullRequestRef(pullRequest: PullRequestSummary): PortalTaskRef {
  const updatedAt = pullRequestUpdatedAt(pullRequest);
  return {
    kind: 'pr',
    number: pullRequest.number,
    title: pullRequest.title,
    headBranch: pullRequest.headRefName,
    baseBranch: pullRequest.baseRefName,
    draft: pullRequest.isDraft,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

async function pullRequestRefs(
  workspaceId: string,
  repoPaths: string[],
  query: string | undefined,
  targetCount: number,
): Promise<PortalTaskRef[]> {
  if (targetCount === 0) return [];

  const generation = observePullRequestGeneration();
  const prefixes = await Promise.all(
    repoPaths.map((repoPath) =>
      ensurePullRequestPrefix(repoPath, query, targetCount, generation),
    ),
  );
  if (getPullRequestListingCacheGeneration() !== generation) {
    throw new PullRequestListingGenerationChangedError();
  }

  const candidates = prefixes.flatMap((prefix, index) => {
    const repoPath = repoPaths[index];
    return repoPath === undefined
      ? []
      : filteredPullRequestCandidates(prefix, repoPath, query);
  });
  candidates.sort(comparePullRequests);

  const checkoutMaps = await checkoutMapsForRepoPaths(repoPaths);
  const refs = await Promise.all(
    candidates.map(async ({ pullRequest }): Promise<PortalTaskRef> => {
      const worktreeId = await checkedOutWorktreeId(
        workspaceId,
        pullRequest.headRefName,
        repoPaths,
        checkoutMaps,
      );
      return {
        ...toPullRequestRef(pullRequest),
        ...(worktreeId === undefined
          ? {}
          : { checkedOutWorktreeId: worktreeId }),
      };
    }),
  );
  if (getPullRequestListingCacheGeneration() !== generation) {
    throw new PullRequestListingGenerationChangedError();
  }
  return refs;
}

function completePage(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  allItems: PortalTaskRef[],
  offset: number,
  limit: number,
): void {
  const items = allItems.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const result: PortalTaskRefsListResult = {
    items,
    ...(nextOffset < allItems.length ? { nextOffset } : {}),
  };
  context.complete(command, result);
}

function parsePayload(payload: unknown): PortalTaskRefsListPayload | null {
  if (!isRecord(payload)) return null;
  const workspaceId = payload.workspaceId;
  const kind = payload.kind;
  const query = payload.query;
  const limit = payload.limit;
  const offset = payload.offset;
  if (typeof workspaceId !== 'string') return null;
  try {
    validateId(workspaceId, 'workspaceId');
  } catch {
    return null;
  }
  if (kind !== undefined && kind !== 'branch' && kind !== 'pr') return null;
  if (
    query !== undefined &&
    (typeof query !== 'string' || query.length < 1 || query.length > 200)
  ) {
    return null;
  }
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return null;
  }
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return null;
  }
  return {
    workspaceId,
    ...(kind === undefined ? {} : { kind }),
    ...(query === undefined ? {} : { query }),
    limit,
    offset,
  };
}

function requiredPullRequestCount(
  payload: PortalTaskRefsListPayload,
  branchCount: number,
): number {
  if (payload.kind === 'pr') {
    const countBeforePage = payload.offset;
    const countWithPage = countBeforePage + payload.limit;
    return Math.min(
      PULL_REQUEST_MAX_RAW_ROWS,
      countWithPage >= Number.MAX_SAFE_INTEGER
        ? PULL_REQUEST_MAX_RAW_ROWS
        : countWithPage + 1,
    );
  }

  const branchRowsBeforePrs = Math.max(0, branchCount - payload.offset);
  const prsOnPage = Math.max(0, payload.limit - branchRowsBeforePrs);
  const reachesPrs =
    payload.offset >= branchCount ||
    payload.limit >= branchCount - payload.offset;
  if (!reachesPrs) return 0;

  const prOffset = Math.max(0, payload.offset - branchCount);
  const extraForNextPage = 1;
  const rowsAfterStart = prsOnPage + extraForNextPage;
  return Math.min(
    PULL_REQUEST_MAX_RAW_ROWS,
    prOffset >= PULL_REQUEST_MAX_RAW_ROWS - rowsAfterStart
      ? PULL_REQUEST_MAX_RAW_ROWS
      : prOffset + rowsAfterStart,
  );
}

function failForPullRequestError(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  error: unknown,
): void {
  if (isGitHubBrokerError(error) && error.code === 'not_authenticated') {
    context.fail(command, 'github_not_connected', GITHUB_NOT_CONNECTED_MESSAGE);
    return;
  }
  context.fail(command, 'execution_failed', PULL_REQUEST_LIST_FAILED_MESSAGE);
}

/** `portal.task_refs.list`: return safe branch/PR refs with exact offset pages. */
export async function handlePortalTaskRefsList(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = parsePayload(command.payload);
  if (!payload) {
    context.fail(command, 'invalid_payload', INVALID_PAYLOAD_MESSAGE);
    return;
  }

  let repoPaths: string[];
  let pullRequestRepoPaths: string[];
  let config: WorkspaceConfigFile;
  try {
    const indexEntry = await readWorkspaceIndexEntry(payload.workspaceId);
    if (!indexEntry) {
      context.fail(command, 'not_found', WORKSPACE_NOT_FOUND_MESSAGE);
      return;
    }
    if (indexEntry.type === 'cowork') {
      context.fail(command, 'unsupported_project', UNSUPPORTED_PROJECT_MESSAGE);
      return;
    }
    config = await readWorkspaceConfig(payload.workspaceId);
    if (config.type === 'cowork') {
      context.fail(command, 'unsupported_project', UNSUPPORTED_PROJECT_MESSAGE);
      return;
    }
    repoPaths = await canonicalWorkspaceRepoPaths(config);
    // A create resolves a pull request number only in the project's own
    // repository, so only that repository's pull requests are listed.
    const pullRequestRepoPath = recordedRepositoryPath(config);
    const canonicalPullRequestRepoPath = pullRequestRepoPath
      ? await resolveWorkspaceReferenceRepoPath(pullRequestRepoPath)
      : '';
    pullRequestRepoPaths = canonicalPullRequestRepoPath
      ? [canonicalPullRequestRepoPath]
      : [];
  } catch {
    context.fail(command, 'execution_failed', WORKSPACE_READ_FAILED_MESSAGE);
    return;
  }

  let branchRefs: PortalTaskRef[] = [];
  if (payload.kind !== 'pr') {
    try {
      const targets = await listHomeBranchTargets(
        getDesktopCanopyRuntime(),
        TASK_REFS_MAIN_CALLER,
        { workspaceId: payload.workspaceId },
      );
      if (!targets.supported && payload.kind === 'branch') {
        context.fail(
          command,
          'unsupported_project',
          UNSUPPORTED_PROJECT_MESSAGE,
        );
        return;
      }
      if (!targets.supported && repoPaths.length === 0) {
        context.fail(
          command,
          'unsupported_project',
          UNSUPPORTED_PROJECT_MESSAGE,
        );
        return;
      }
      if (targets.supported) {
        const query = payload.query?.toLowerCase();
        const matchingTargets = {
          ...targets,
          branches:
            query === undefined
              ? targets.branches
              : targets.branches.filter((branch) =>
                  branch.name.toLowerCase().includes(query),
                ),
        };
        branchRefs = await annotateBranches(
          payload.workspaceId,
          matchingTargets,
          repoPaths,
        );
      }
    } catch {
      context.fail(command, 'execution_failed', BRANCH_LIST_FAILED_MESSAGE);
      return;
    }
  }

  if (payload.kind === 'branch') {
    completePage(command, context, branchRefs, payload.offset, payload.limit);
    return;
  }
  if (payload.kind === 'pr' && pullRequestRepoPaths.length === 0) {
    context.fail(command, 'unsupported_project', UNSUPPORTED_PROJECT_MESSAGE);
    return;
  }

  const prCount = requiredPullRequestCount(payload, branchRefs.length);
  if (prCount === 0) {
    completePage(command, context, branchRefs, payload.offset, payload.limit);
    return;
  }

  try {
    const pullRequestReferences = await pullRequestRefs(
      payload.workspaceId,
      pullRequestRepoPaths,
      payload.query,
      prCount,
    );
    completePage(
      command,
      context,
      [...branchRefs, ...pullRequestReferences],
      payload.offset,
      payload.limit,
    );
  } catch (error) {
    if (payload.kind === undefined) {
      completePage(command, context, branchRefs, payload.offset, payload.limit);
      return;
    }
    if (error instanceof PullRequestListingGenerationChangedError) {
      context.fail(command, 'execution_failed', PULL_REQUESTS_CHANGED_MESSAGE);
      return;
    }
    failForPullRequestError(command, context, error);
  }
}

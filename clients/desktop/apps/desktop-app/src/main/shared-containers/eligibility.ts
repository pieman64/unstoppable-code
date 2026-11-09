import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/protocol/pipelines';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type {
  PreferencesData,
  SharedContainerAudienceAvailability,
  SharedContainerEligibilityRequest,
  SharedContainerEligibilityResponse,
  SharedContainerGithubBlockedReason,
  SharedContainerGithubReadiness,
  SharedContainerPrepareGithubRequest,
  SharedContainerPrepareGithubResponse,
  SharedContainerPublicAudienceBlockedReason,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import {
  readCanopyCloudAccountWithStatus,
  type CanopyCloudAccountEntry,
  type CanopyCloudAccountReadResult,
} from '../lib/canopy-cloud-account-store';
import {
  loadStoredOrgBillingStates,
  resolveLapsedOrganizationNames,
} from '../lib/org-billing-state';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  loadStoredTelemetryEnforcementByOrganization,
  recordTelemetryEnforcementReadFailure,
  type StoredTelemetryEnforcementByOrganization,
} from '../lib/telemetry-enforcement-state';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { mapWithConcurrency } from '../lib/concurrency';
import {
  getCurrentBranch,
  getLiveOriginBranchSha,
  getPushRemoteUrlStrict,
  getRemoteUrlStrict,
  isAncestor,
  pushBranchToOriginNonInteractive,
  resolveRefSha,
} from '../lib/git';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sanitizeRemoteUrl } from '../lib/plan-share-repos';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { supportsSharedContainers } from './canopy-server-client';
import { listSharedContainerLocalRepositories } from './local-repositories';
import type { SharedContainerLocalRepository } from './local-repositories';
import { parseGitHubRemote } from './materialize/code';
import { getSharedContainerPublishScheduler } from './publish/scheduler';
import {
  organizationIdFromSharedContainerOwnerKey,
  sharedContainerOwnerKey,
} from './owner-scope';

interface SharingPreferencesResult {
  telemetrySharing: PreferencesData['telemetrySharing'];
}

const GITHUB_READINESS_CONCURRENCY = 4;

export interface SharedContainerEligibilityDependencies {
  readAccount: () => Promise<CanopyCloudAccountReadResult>;
  loadBillingStates: () => Promise<CanopyOrgBillingState[]>;
  resolveLapsedOrganizationNames: (
    organizationIds: string[],
  ) => Promise<string[]>;
  supportsSharedContainers: () => Promise<boolean>;
  loadEnforcement: () => Promise<StoredTelemetryEnforcementByOrganization>;
  readPreferences: () => Promise<SharingPreferencesResult>;
  /** `organizationId` absent resolves a personal container's anchor. */
  resolveServerWorktreeExternalId: (
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
    selectedOrganizationTeamIds?: readonly string[],
  ) => string | null | Promise<string | null>;
  resolveSharedContainerAnchorConflictOrganizationId: (
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
    selectedOrganizationTeamIds?: readonly string[],
  ) => string | null | Promise<string | null>;
  /** `null` registers through the Personal (user-owned) sync target. */
  refreshWorktreeMetadata: (
    projectId: string,
    worktreeId: string,
    organizationId: string | null,
  ) => Promise<void>;
  flushWorktreeNow: (projectId: string, worktreeId: string) => Promise<void>;
  waitForRegistrationRetry: () => Promise<void>;
  getGithubReadiness: (
    request: SharedContainerEligibilityRequest,
  ) => Promise<SharedContainerGithubReadiness>;
  recordProbeFailure: (reason: string, error: unknown) => void;
  /** `canopy-shared-container-external-sharing` client flag. */
  isExternalSharingEnabled: () => boolean;
  /** Organization binding from `workspace.json`; absent for a personal workspace. */
  readWorkspaceOwner: (
    projectId: string,
  ) => Promise<WorkspaceOwnerBinding | undefined>;
  /**
   * Owner keys that already anchor a shared container for this worktree
   * (organization ids, or the personal owner key), oldest first.
   */
  listSharedContainerAnchorKeys: (
    projectId: string,
    worktreeId: string,
  ) => readonly string[];
}

export interface SharedContainerGithubReadinessDependencies {
  listRepositories: (
    projectId: string,
    worktreeId: string,
  ) => Promise<SharedContainerLocalRepository[]>;
  /**
   * Must distinguish an absent origin from an operational lookup failure:
   * `null` here means "no origin configured" and is classified as
   * `missing-origin`, while a throw is an inconclusive probe that becomes
   * `blocked/unavailable`. A best-effort variant that swallows errors would
   * report a transient failure as a permanent configuration problem.
   */
  getRemoteUrl: (repoPath: string) => Promise<string | null>;
  /**
   * The URL `git push origin` would actually write to (`remote.origin.pushurl`
   * when set, otherwise the fetch URL). Validated separately because the fetch
   * URL is not what the recovery push mutates.
   */
  getPushRemoteUrl: (repoPath: string) => Promise<string | null>;
  getCurrentBranch: (repoPath: string) => Promise<string>;
  resolveHeadSha: (repoPath: string) => Promise<string>;
  getLiveOriginBranchSha: (
    repoPath: string,
    branchName: string,
  ) => Promise<string | null>;
  isAncestor: (
    repoPath: string,
    ancestor: string,
    descendant: string,
  ) => Promise<boolean>;
}

export interface SharedContainerGithubPreparationDependencies extends SharedContainerGithubReadinessDependencies {
  /**
   * Publish `branchName` to the same-named branch on `origin`. Never force
   * pushes, never mutates the working tree, index, or checked-out branch.
   */
  pushBranch: (repoPath: string, branchName: string) => Promise<void>;
  scheduleKnown: (projectId: string, worktreeId: string) => Promise<void>;
  recordFailure: (stage: string, error: unknown) => void;
}

const DEFAULT_GITHUB_READINESS_DEPENDENCIES: SharedContainerGithubReadinessDependencies =
  {
    listRepositories: listSharedContainerLocalRepositories,
    getRemoteUrl: getRemoteUrlStrict,
    getPushRemoteUrl: getPushRemoteUrlStrict,
    getCurrentBranch,
    resolveHeadSha: (repoPath) => resolveRefSha(repoPath, 'HEAD'),
    getLiveOriginBranchSha,
    isAncestor,
  };

const DEFAULT_GITHUB_PREPARATION_DEPENDENCIES: SharedContainerGithubPreparationDependencies =
  {
    ...DEFAULT_GITHUB_READINESS_DEPENDENCIES,
    pushBranch: pushBranchToOriginNonInteractive,
    scheduleKnown: (projectId, worktreeId) =>
      getSharedContainerPublishScheduler().scheduleKnown(projectId, worktreeId),
    recordFailure: (stage, error): void => {
      // Raw Git output stays in the main process. The renderer only ever sees
      // the bounded `failed` result.
      logMainProcessWarn('[shared-containers] github preparation failed', {
        stage,
        error: sanitizeGitFailure(error),
      });
    },
  };

const READY: SharedContainerGithubReadiness = { status: 'ready' };
const PUSH_REQUIRED: SharedContainerGithubReadiness = {
  status: 'push-required',
};

function blocked(
  reason: SharedContainerGithubBlockedReason,
): Extract<SharedContainerGithubReadiness, { status: 'blocked' }> {
  return { status: 'blocked', reason };
}

/**
 * Deterministic configuration problems outrank a transient probe failure, so a
 * worktree that can never be repaired by pushing reports the actionable reason
 * rather than "could not check GitHub".
 *
 * Exhaustive over `SharedContainerGithubBlockedReason` so adding a reason is a
 * compile error here rather than a silent `?? 'unavailable'` fallback. Note
 * that `no-repositories` cannot actually arise from `summarizeReadiness` — the
 * empty-repository case is answered before any probe is summarized — it is
 * listed only to keep that exhaustiveness property.
 */
const BLOCKED_REASON_PRECEDENCE: readonly SharedContainerGithubBlockedReason[] =
  [
    'no-repositories',
    'missing-origin',
    'non-github-origin',
    'no-head',
    'no-branch',
    'diverged',
    'unavailable',
  ];

const MAX_SANITIZED_GIT_FAILURE_LENGTH = 500;

/**
 * Strip embedded remote credentials (`https://user:token@host/...`) and bound
 * the length before a Git failure reaches any log sink.
 */
export function sanitizeGitFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1<redacted>@')
    .slice(0, MAX_SANITIZED_GIT_FAILURE_LENGTH);
}

interface RepositoryReadinessProbe {
  repoPath: string;
  readiness: SharedContainerGithubReadiness;
  /** Present only when the repository resolved a named branch and a HEAD. */
  branchName?: string;
}

/**
 * Classify one repository. Ordering matters: HEAD is resolved before the
 * branch name so an unborn branch reports `no-head` while a detached checkout
 * (which has a valid HEAD) reports `no-branch`.
 *
 * Probe failures reaching the remote are thrown so the caller can distinguish
 * an inconclusive answer from a confirmed one.
 */
async function probeRepositoryReadiness(
  repoPath: string,
  deps: SharedContainerGithubReadinessDependencies,
): Promise<RepositoryReadinessProbe> {
  const [remoteUrl, pushRemoteUrl, branch, headSha] = await Promise.all([
    deps.getRemoteUrl(repoPath),
    deps.getPushRemoteUrl(repoPath),
    deps.getCurrentBranch(repoPath).catch(() => null),
    deps.resolveHeadSha(repoPath).catch(() => null),
  ]);

  const sanitizedRemoteUrl = sanitizeRemoteUrl(remoteUrl);
  if (!sanitizedRemoteUrl) {
    return { repoPath, readiness: blocked('missing-origin') };
  }
  const fetchCoordinates = parseGitHubRemote(sanitizedRemoteUrl);
  if (!fetchCoordinates) {
    return { repoPath, readiness: blocked('non-github-origin') };
  }

  // `remote.origin.pushurl` can point somewhere the fetch URL does not, so
  // validating only the fetch URL would offer a recovery push that publishes
  // the branch to a different host. Both URLs must name the same GitHub
  // repository before a push is offered; anything else is a configuration
  // problem no push can fix.
  const sanitizedPushRemoteUrl = sanitizeRemoteUrl(pushRemoteUrl);
  if (!sanitizedPushRemoteUrl) {
    return { repoPath, readiness: blocked('missing-origin') };
  }
  const pushCoordinates = parseGitHubRemote(sanitizedPushRemoteUrl);
  if (
    !pushCoordinates ||
    pushCoordinates.owner.toLowerCase() !==
      fetchCoordinates.owner.toLowerCase() ||
    pushCoordinates.repository.toLowerCase() !==
      fetchCoordinates.repository.toLowerCase()
  ) {
    return { repoPath, readiness: blocked('non-github-origin') };
  }

  if (!headSha) {
    return { repoPath, readiness: blocked('no-head') };
  }
  if (!branch || branch === 'HEAD') {
    return { repoPath, readiness: blocked('no-branch') };
  }

  const liveOriginSha = await deps.getLiveOriginBranchSha(repoPath, branch);
  if (!liveOriginSha) {
    // No same-named branch on the live remote. Creating it is a safe,
    // non-destructive push of the commit HEAD already points at.
    return { repoPath, readiness: PUSH_REQUIRED, branchName: branch };
  }
  if (liveOriginSha === headSha) {
    return { repoPath, readiness: READY, branchName: branch };
  }
  if (await deps.isAncestor(repoPath, headSha, liveOriginSha)) {
    // Remote already contains everything local HEAD has.
    return { repoPath, readiness: READY, branchName: branch };
  }
  if (await deps.isAncestor(repoPath, liveOriginSha, headSha)) {
    // Remote is strictly behind: a normal fast-forward push repairs it.
    return { repoPath, readiness: PUSH_REQUIRED, branchName: branch };
  }
  return { repoPath, readiness: blocked('diverged'), branchName: branch };
}

function summarizeReadiness(
  probes: readonly RepositoryReadinessProbe[],
): SharedContainerGithubReadiness {
  const blockedReasons = new Set<SharedContainerGithubBlockedReason>();
  for (const probe of probes) {
    if (probe.readiness.status === 'blocked') {
      blockedReasons.add(probe.readiness.reason);
    }
  }
  if (blockedReasons.size > 0) {
    // Any blocker anywhere blocks the whole worktree, so a mixed
    // configuration can never be partially pushed.
    const reason = BLOCKED_REASON_PRECEDENCE.find((candidate) =>
      blockedReasons.has(candidate),
    );
    return blocked(reason ?? 'unavailable');
  }
  return probes.some((probe) => probe.readiness.status === 'push-required')
    ? PUSH_REQUIRED
    : READY;
}

async function probeRepositories(
  request: SharedContainerEligibilityRequest,
  deps: SharedContainerGithubReadinessDependencies,
): Promise<RepositoryReadinessProbe[] | null> {
  const repositories = await deps.listRepositories(
    request.projectId,
    request.worktreeId,
  );
  if (repositories.length === 0) {
    return [];
  }
  const results = await mapWithConcurrency(
    repositories,
    GITHUB_READINESS_CONCURRENCY,
    async (
      repository,
    ): Promise<PromiseSettledResult<RepositoryReadinessProbe>> => {
      try {
        return {
          status: 'fulfilled',
          value: await probeRepositoryReadiness(repository.repoPath, deps),
        };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    },
  );
  const probes: RepositoryReadinessProbe[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      // Timeout, authentication, or transport failure: inconclusive.
      return null;
    }
    probes.push(result.value);
  }
  return probes;
}

/**
 * Classify whether this worktree's repositories are shareable, and if not,
 * whether an ordinary push can fix it.
 *
 * Never throws: an inconclusive probe resolves to `blocked/unavailable` after
 * a sanitized diagnostic, so the caller always has a renderable answer.
 */
export async function getSharedContainerGithubReadiness(
  request: SharedContainerEligibilityRequest,
  deps: SharedContainerGithubReadinessDependencies = DEFAULT_GITHUB_READINESS_DEPENDENCIES,
): Promise<SharedContainerGithubReadiness> {
  if (request.containerType !== 'CODE_WORKTREE') return READY;
  let probes: RepositoryReadinessProbe[] | null;
  try {
    probes = await probeRepositories(request, deps);
  } catch (error) {
    logMainProcessWarn('[shared-containers] github readiness probe failed', {
      error: sanitizeGitFailure(error),
    });
    return blocked('unavailable');
  }
  if (probes === null) {
    logMainProcessWarn('[shared-containers] github readiness probe failed', {
      error: 'repository probe rejected',
    });
    return blocked('unavailable');
  }
  if (probes.length === 0) return blocked('no-repositories');
  return summarizeReadiness(probes);
}

/**
 * Back-compat boolean view of {@link getSharedContainerGithubReadiness}.
 */
export async function isSharedContainerGithubReady(
  request: SharedContainerEligibilityRequest,
  deps: SharedContainerGithubReadinessDependencies = DEFAULT_GITHUB_READINESS_DEPENDENCIES,
): Promise<boolean> {
  return (
    (await getSharedContainerGithubReadiness(request, deps)).status === 'ready'
  );
}

const inFlightGithubPreparations = new Map<
  string,
  Promise<SharedContainerPrepareGithubResponse>
>();

async function runGithubPreparation(
  request: SharedContainerPrepareGithubRequest,
  deps: SharedContainerGithubPreparationDependencies,
): Promise<SharedContainerPrepareGithubResponse> {
  if (request.containerType !== 'CODE_WORKTREE') return { status: 'ready' };

  // Re-probe at the moment of the click. Stale renderer state must never be
  // what authorizes a remote mutation.
  let probes: RepositoryReadinessProbe[] | null;
  try {
    probes = await probeRepositories(request, deps);
  } catch (error) {
    deps.recordFailure('preflight', error);
    return { status: 'blocked', readiness: blocked('unavailable') };
  }
  if (probes === null) {
    deps.recordFailure('preflight', new Error('repository probe rejected'));
    return { status: 'blocked', readiness: blocked('unavailable') };
  }
  if (probes.length === 0) {
    return { status: 'blocked', readiness: blocked('no-repositories') };
  }

  // Full preflight before any push: if a single repository is blocked, none
  // are pushed, so a multi-repo worktree can never be left half-published by
  // a knowable configuration problem.
  const summary = summarizeReadiness(probes);
  if (summary.status === 'blocked') {
    return { status: 'blocked', readiness: summary };
  }
  if (summary.status === 'ready') {
    // Already satisfied — another window, or a previous retry, got there
    // first. Idempotent no-op.
    return { status: 'ready' };
  }

  const pending = probes.filter(
    (probe): probe is RepositoryReadinessProbe & { branchName: string } =>
      probe.readiness.status === 'push-required' &&
      typeof probe.branchName === 'string',
  );
  for (const probe of pending) {
    try {
      await deps.pushBranch(probe.repoPath, probe.branchName);
    } catch (error) {
      // Stop at the first failure. Re-probing on retry makes the already
      // pushed repositories a no-op, so retries stay safe and idempotent.
      deps.recordFailure('push', error);
      return { status: 'failed' };
    }
    try {
      await deps.scheduleKnown(request.projectId, request.worktreeId);
    } catch (error) {
      deps.recordFailure('schedule', error);
    }
  }

  // Verify only the repositories this call actually pushed. Every other
  // repository was already `ready` in the preflight above, and re-probing them
  // would spend a full `ls-remote` + `fetch` + `cat-file` round trip each to
  // re-derive an answer this call did not change. The renderer's
  // `refreshEligibility()` re-asks the whole question afterwards anyway.
  let verified: RepositoryReadinessProbe[];
  try {
    verified = await mapWithConcurrency(
      pending,
      GITHUB_READINESS_CONCURRENCY,
      (probe) => probeRepositoryReadiness(probe.repoPath, deps),
    );
  } catch (error) {
    deps.recordFailure('verify', error);
    return { status: 'blocked', readiness: blocked('unavailable') };
  }
  const after = summarizeReadiness(verified);
  if (after.status === 'ready') return { status: 'ready' };
  if (after.status === 'blocked') {
    return { status: 'blocked', readiness: after };
  }
  // Pushes reported success but the remote still does not contain HEAD.
  deps.recordFailure('verify', new Error('branch still missing after push'));
  return { status: 'failed' };
}

/**
 * One-click recovery for a worktree whose branch is not on GitHub yet.
 *
 * Coalesced per `projectId/worktreeId` so a double-click, or a duplicate IPC
 * request, shares a single in-flight operation instead of pushing twice.
 */
export function prepareSharedContainerGithub(
  request: SharedContainerPrepareGithubRequest,
  deps: SharedContainerGithubPreparationDependencies = DEFAULT_GITHUB_PREPARATION_DEPENDENCIES,
): Promise<SharedContainerPrepareGithubResponse> {
  const key = `${request.projectId}/${request.worktreeId}`;
  const existing = inFlightGithubPreparations.get(key);
  if (existing) return existing;
  const entry: { promise?: Promise<SharedContainerPrepareGithubResponse> } = {};
  entry.promise = runGithubPreparation(request, deps).finally(() => {
    if (inFlightGithubPreparations.get(key) === entry.promise) {
      inFlightGithubPreparations.delete(key);
    }
  });
  inFlightGithubPreparations.set(key, entry.promise);
  return entry.promise;
}

function defaultDependencies(): SharedContainerEligibilityDependencies {
  const telemetry = getTelemetrySyncService();
  return {
    readAccount: readCanopyCloudAccountWithStatus,
    loadBillingStates: loadStoredOrgBillingStates,
    resolveLapsedOrganizationNames: (organizationIds) =>
      resolveLapsedOrganizationNames(organizationIds),
    supportsSharedContainers,
    loadEnforcement: loadStoredTelemetryEnforcementByOrganization,
    readPreferences: readPreferencesFile,
    resolveServerWorktreeExternalId: (
      projectId,
      worktreeId,
      organizationId,
      selectedOrganizationTeamIds,
    ) =>
      telemetry.resolveServerWorktreeExternalId(
        projectId,
        worktreeId,
        organizationId,
        selectedOrganizationTeamIds,
      ),
    resolveSharedContainerAnchorConflictOrganizationId: (
      projectId,
      worktreeId,
      organizationId,
      selectedOrganizationTeamIds,
    ) =>
      telemetry.resolveSharedContainerAnchorConflictOrganizationId(
        projectId,
        worktreeId,
        organizationId,
        selectedOrganizationTeamIds,
      ),
    refreshWorktreeMetadata: (projectId, worktreeId, organizationId) =>
      telemetry.refreshWorktreeMetadata(projectId, worktreeId, organizationId),
    flushWorktreeNow: (projectId, worktreeId) =>
      telemetry.flushWorktreeNow(projectId, worktreeId),
    waitForRegistrationRetry: () =>
      new Promise((resolve) => setTimeout(resolve, 4_000)),
    getGithubReadiness: getSharedContainerGithubReadiness,
    isExternalSharingEnabled: () =>
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key,
      ),
    readWorkspaceOwner: async (projectId) =>
      (await readWorkspaceConfig(projectId)).owner,
    listSharedContainerAnchorKeys: (projectId, worktreeId) =>
      telemetry.listSharedContainerAnchorKeys(projectId, worktreeId),
    recordProbeFailure: (reason, error): void => {
      if (reason === 'telemetry-enforcement') {
        recordTelemetryEnforcementReadFailure(reason, error);
        return;
      }
      logMainProcessWarn('[shared-containers] eligibility probe failed', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

async function failOpen<T>(
  deps: SharedContainerEligibilityDependencies,
  reason: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    deps.recordProbeFailure(reason, error);
    return undefined;
  }
}

/**
 * Who owns (or will own) the container, and whether that is already decided.
 * `organizationId` absent means a personal container.
 */
interface SharedContainerOwnerResolution {
  organizationId?: string;
  fixed: boolean;
  conflictingOrganizationIds?: string[];
}

function requestedOwnerOrganizationId(
  request: SharedContainerEligibilityRequest,
): string | undefined {
  // Public creates a personal container unless ownership is already fixed;
  // Team and Organization use the organization the author picked.
  return request.audience === 'public' ? undefined : request.organizationId;
}

/**
 * The owning organization is fixed the first time a container is shared.
 *
 * - An organization-owned workspace (`workspace.json` owner binding) always
 *   belongs to that organization.
 * - Otherwise an existing sync anchor wins: an organization anchor keeps that
 *   organization, a personal anchor keeps the container personal. A worktree
 *   shared into several organizations before this rule existed keeps the
 *   requested one when it is among them.
 * - Otherwise the author's audience decides (see
 *   {@link requestedOwnerOrganizationId}).
 */
async function resolveSharedContainerOwner(
  request: SharedContainerEligibilityRequest,
  deps: SharedContainerEligibilityDependencies,
): Promise<SharedContainerOwnerResolution> {
  const workspaceOwner = await failOpen(deps, 'workspace-owner', () =>
    deps.readWorkspaceOwner(request.projectId),
  );
  if (workspaceOwner?.type === 'organization') {
    return { organizationId: workspaceOwner.organizationId, fixed: true };
  }
  const requested = requestedOwnerOrganizationId(request);
  const anchorKeys = deps.listSharedContainerAnchorKeys(
    request.projectId,
    request.worktreeId,
  );
  const [firstAnchorKey] = anchorKeys;
  if (firstAnchorKey !== undefined) {
    const requestedKey = sharedContainerOwnerKey(requested);
    if (anchorKeys.length > 1 && !anchorKeys.includes(requestedKey)) {
      return {
        fixed: true,
        conflictingOrganizationIds: anchorKeys.flatMap((key) => {
          const organizationId = organizationIdFromSharedContainerOwnerKey(key);
          return organizationId === undefined ? [] : [organizationId];
        }),
      };
    }
    const ownerKey = anchorKeys.includes(requestedKey)
      ? requestedKey
      : firstAnchorKey;
    const organizationId = organizationIdFromSharedContainerOwnerKey(ownerKey);
    return organizationId === undefined
      ? { fixed: true }
      : { organizationId, fixed: true };
  }
  return requested === undefined
    ? { fixed: false }
    : { organizationId: requested, fixed: false };
}

function userHasTeamInOrganization(
  teams: readonly CanopyTeamSummary[] | undefined,
  organizationId: string | undefined,
): boolean {
  // An account that predates team summaries cannot be checked locally; the
  // member search is authoritative, so offer Team rather than hide it.
  if (teams === undefined) return true;
  return teams.some(
    (team) =>
      organizationId === undefined || team.organization.id === organizationId,
  );
}

interface SharedContainerAudienceResolution {
  audiences: SharedContainerAudienceAvailability;
  link: { anyone: boolean; organization: boolean };
  publicBlockedReason?: SharedContainerPublicAudienceBlockedReason;
}

/**
 * Which invite audiences this container can use.
 *
 * - Organization: the user belongs to an organization, and the container is
 *   not already fixed as personal (a personal container only takes direct
 *   grants) or fixed to an organization the user has left.
 * - Team: Organization, plus at least one of the user's teams in the owning
 *   (or picked) organization.
 * - Public: the external-sharing flag is on and either the container is (or
 *   will be) personal, or its owning organization allows sharing outside it.
 */
function resolveSharedContainerAudiences(
  owner: SharedContainerOwnerResolution,
  organizations: readonly CanopyOrganizationSummary[],
  teams: readonly CanopyTeamSummary[] | undefined,
  request: SharedContainerEligibilityRequest,
  externalSharingEnabled: boolean,
): SharedContainerAudienceResolution {
  const ownerOrganization =
    owner.organizationId === undefined
      ? undefined
      : organizations.find(
          (organization) => organization.id === owner.organizationId,
        );
  const organization = owner.fixed
    ? ownerOrganization !== undefined
    : organizations.length > 0;
  const teamOrganizationId = owner.fixed
    ? owner.organizationId
    : request.organizationId;
  const team =
    organization && userHasTeamInOrganization(teams, teamOrganizationId);
  // Unfixed ownership means Public would create a personal container, which
  // no organization setting governs.
  const publicOwnerIsOrganization =
    owner.fixed && owner.organizationId !== undefined;
  const publicAllowed =
    !publicOwnerIsOrganization ||
    ownerOrganization?.allowExternalContainerSharing === true;
  const publicAudience = externalSharingEnabled && publicAllowed;
  return {
    audiences: { team, organization, public: publicAudience },
    link: { anyone: publicAudience, organization },
    ...(publicAudience
      ? {}
      : {
          publicBlockedReason: externalSharingEnabled
            ? 'external-sharing-disabled'
            : 'feature-disabled',
        }),
  };
}

export async function getSharedContainerEligibility(
  request: SharedContainerEligibilityRequest,
  dependencies?: SharedContainerEligibilityDependencies,
): Promise<SharedContainerEligibilityResponse> {
  const deps = dependencies ?? defaultDependencies();
  const accountRead = await failOpen(deps, 'cloud-account', deps.readAccount);
  if (!accountRead || accountRead.status !== 'ok') {
    return { eligible: false, reason: 'account-unavailable' };
  }
  const account = accountRead?.status === 'ok' ? accountRead.entry : undefined;
  if (accountRead?.status === 'ok' && !account) {
    return { eligible: false, reason: 'no-cloud-account' };
  }
  if (isGuestAccount(account)) {
    return { eligible: false, reason: 'guest-account' };
  }
  const organizations = account?.organizations;
  const externalSharingEnabled = deps.isExternalSharingEnabled();

  // Flag off: exactly the organization-only behavior that predates external
  // sharing. No ownership fixing, no audience fields, and a personal
  // container is never created.
  if (!externalSharingEnabled) {
    if (organizations && organizations.length === 0) {
      return { eligible: false, reason: 'no-organization' };
    }
    const organizationId = request.organizationId;
    if (organizationId === undefined) {
      return { eligible: false, reason: 'no-organization' };
    }
    return evaluateOwnerEligibility(
      request,
      deps,
      account,
      organizationId,
      (response) => response,
    );
  }

  // Flag on: `no-organization` no longer blocks. A user without an
  // organization can still share a personal container with Public.
  const owner = await resolveSharedContainerOwner(request, deps);
  if (owner.conflictingOrganizationIds !== undefined) {
    const conflictingIds = new Set(owner.conflictingOrganizationIds);
    return {
      eligible: false,
      reason: 'anchored-to-other-organization',
      blockedByOrganizationNames: (organizations ?? [])
        .filter((organization) => conflictingIds.has(organization.id))
        .map((organization) => organization.name),
    };
  }
  const { audiences, link, publicBlockedReason } =
    resolveSharedContainerAudiences(
      owner,
      organizations ?? [],
      account?.teams,
      request,
      externalSharingEnabled,
    );
  const withOwnership = (
    response: SharedContainerEligibilityResponse,
  ): SharedContainerEligibilityResponse => ({
    ...response,
    audiences,
    link,
    ...(publicBlockedReason ? { publicBlockedReason } : {}),
    ...(owner.organizationId !== undefined
      ? { ownerOrganizationId: owner.organizationId }
      : {}),
    ownerFixed: owner.fixed,
  });
  if (!audiences.team && !audiences.organization && !audiences.public) {
    return withOwnership({
      eligible: false,
      reason: 'external-sharing-disabled',
    });
  }
  if (request.audience === 'public' && !audiences.public) {
    return withOwnership({
      eligible: false,
      reason: 'external-sharing-disabled',
    });
  }
  return evaluateOwnerEligibility(
    request,
    deps,
    account,
    owner.organizationId,
    withOwnership,
  );
}

/**
 * Gates that depend on the resolved owner. Organization billing and the
 * all-lapsed and telemetry-policy rules apply only to organization-owned
 * containers. A personal container has neither an organization to bill nor an
 * organization policy to enforce, but it still registers through the
 * user-owned target, which needs metadata sharing. Every owner whose stored
 * metadata sharing is Off therefore reports `sync-disabled` (unless an
 * organization owner's policy requires metadata) instead of waiting out
 * registration retries that can never queue anything.
 */
async function evaluateOwnerEligibility(
  request: SharedContainerEligibilityRequest,
  deps: SharedContainerEligibilityDependencies,
  account: CanopyCloudAccountEntry | null | undefined,
  ownerOrganizationId: string | undefined,
  decorate: (
    response: SharedContainerEligibilityResponse,
  ) => SharedContainerEligibilityResponse,
): Promise<SharedContainerEligibilityResponse> {
  const organizations = account?.organizations;
  const selectedOrganizationTeamIds =
    ownerOrganizationId === undefined
      ? []
      : (account?.teams ?? [])
          .filter((team) => team.organization.id === ownerOrganizationId)
          .map((team) => team.id);
  let externalId = await deps.resolveServerWorktreeExternalId(
    request.projectId,
    request.worktreeId,
    ownerOrganizationId,
    selectedOrganizationTeamIds,
  );
  const knownExternalId = (): Pick<
    SharedContainerEligibilityResponse,
    'serverWorktreeExternalId'
  > => (externalId ? { serverWorktreeExternalId: externalId } : {});

  if (ownerOrganizationId !== undefined) {
    const billingStates = await failOpen(
      deps,
      'org-billing',
      deps.loadBillingStates,
    );
    if (organizations && billingStates) {
      // "All lapsed" rule (CAN-2551). This is the ONLY "all lapsed" gate;
      // there is deliberately no renderer-side twin. An earlier revision gated
      // the shared-container entry point on a renderer copy of this rule,
      // which hid the only surface for REVOKING already-granted access — the
      // server keeps `listSharedByMe` / `listContainerRecipients` /
      // `revokeContainerGrant` authorized on membership rather than
      // entitlement precisely so a lapsed owner can still revoke. Do not
      // reintroduce that gate.
      //
      // A PARTIALLY lapsed account is not blocked, and an org with no billing
      // entry is not lapsed.
      const lapsed = organizations.filter((organization) =>
        billingStates.some(
          (state) =>
            state.organizationId === organization.id &&
            state.teamsEntitled === false,
        ),
      );
      if (lapsed.length > 0 && lapsed.length === organizations.length) {
        return decorate({
          eligible: false,
          reason: 'blocked-by-org-billing',
          blockedByOrganizationNames: lapsed.map(
            (organization) => organization.name,
          ),
          ...knownExternalId(),
        });
      }
    }

    const selectedLapsedOrganizationNames = await failOpen(
      deps,
      'selected-org-billing',
      () => deps.resolveLapsedOrganizationNames([ownerOrganizationId]),
    );
    if (
      selectedLapsedOrganizationNames &&
      selectedLapsedOrganizationNames.length > 0
    ) {
      return decorate({
        eligible: false,
        reason: 'blocked-by-org-billing',
        blockedByOrganizationNames: selectedLapsedOrganizationNames,
        ...knownExternalId(),
      });
    }
  }

  const capabilitySupported = await failOpen(
    deps,
    'shared-containers-capability',
    deps.supportsSharedContainers,
  );
  if (capabilitySupported === false) {
    return decorate({
      eligible: false,
      reason: 'unsupported-capability',
      ...knownExternalId(),
    });
  }

  let ownerRequiresMetadata = false;
  if (ownerOrganizationId !== undefined) {
    const enforcement = await failOpen(
      deps,
      'telemetry-enforcement',
      deps.loadEnforcement,
    );
    if (!enforcement) {
      return decorate({
        eligible: false,
        reason: 'sync-blocked-by-org',
        ...knownExternalId(),
      });
    }
    const ownerPolicy = enforcement?.get(
      normalizeUuid(ownerOrganizationId) ?? ownerOrganizationId,
    );
    if (ownerPolicy?.enforcement.prohibited.metadata) {
      return decorate({
        eligible: false,
        reason: 'sync-blocked-by-org',
        blockedByOrganizationNames: [ownerPolicy.organizationName],
        ...knownExternalId(),
      });
    }
    ownerRequiresMetadata = ownerPolicy?.enforcement.required.metadata === true;
  }

  // Personal and organization owners alike register through a target that
  // needs metadata sharing; only an organization requirement overrides Off.
  const preferences = await failOpen(
    deps,
    'telemetry-preferences',
    deps.readPreferences,
  );
  if (
    preferences?.telemetrySharing.metadata === 'off' &&
    !ownerRequiresMetadata
  ) {
    return decorate({
      eligible: false,
      reason: 'sync-disabled',
      ...knownExternalId(),
    });
  }
  if (!externalId) {
    let registrationFailed = false;
    for (let attempt = 0; attempt < 3 && !externalId; attempt += 1) {
      if (attempt > 0) await deps.waitForRegistrationRetry();
      try {
        await deps.refreshWorktreeMetadata(
          request.projectId,
          request.worktreeId,
          // A personal container registers through the user-owned target.
          ownerOrganizationId ?? null,
        );
        await deps.flushWorktreeNow(request.projectId, request.worktreeId);
      } catch (error) {
        registrationFailed = true;
        deps.recordProbeFailure('metadata-registration', error);
      }
      externalId = await deps.resolveServerWorktreeExternalId(
        request.projectId,
        request.worktreeId,
        ownerOrganizationId,
        selectedOrganizationTeamIds,
      );
    }
    if (!externalId && registrationFailed) {
      return decorate({ eligible: false, reason: 'registration-failed' });
    }
  }
  if (!externalId) {
    const conflictOrganizationId =
      await deps.resolveSharedContainerAnchorConflictOrganizationId(
        request.projectId,
        request.worktreeId,
        ownerOrganizationId,
        selectedOrganizationTeamIds,
      );
    if (conflictOrganizationId) {
      const conflictOrganization = organizations?.find(
        (organization) => organization.id === conflictOrganizationId,
      );
      return decorate({
        eligible: false,
        reason: 'anchored-to-other-organization',
        blockedByOrganizationNames: conflictOrganization
          ? [conflictOrganization.name]
          : [],
      });
    }
    return decorate({ eligible: false, reason: 'not-yet-synced' });
  }

  // Repository publication no longer needs a live GitHub preflight. A local
  // remote-tracking ref supplies a pushed base when one is available; when it
  // is not, the publisher emits a schema-v2 snapshot. Keep the readiness and
  // preparation APIs only for the optional artifact-budget push remedy.
  return decorate({ eligible: true, serverWorktreeExternalId: externalId });
}

import { createHash } from 'node:crypto';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { SharedContainerForkErrorCode } from '@canopy/protocol/shared-containers';
import {
  MEMBER_ORG_PROJECT_LIMIT,
  ORG_PROJECT_LIMITS,
} from '@canopy/protocol/org-projects';
import type {
  CreateOrgMemberCodeProjectResult,
  OrgProjectConversionErrorCode,
  OrgProjectConversionResult,
} from '@canopy/desktop-shared/types';
import { getRemoteUrl } from '../../lib/git';
import { remoteUrlsMatch } from '../../lib/repo-url-matcher';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { readWorkspaceOwnership } from '../../lib/workspace-persistence';
import { getObservabilityService } from '../../observability';
import { W5RevisionConflictError } from '../../lib/w5-commit-log-file-store';
import { describeErrorForAppDiagnostic } from '../../observability/app-diagnostic-privacy';
import {
  assertForkWorkspaceOwner,
  SharedContainerForkError,
} from './destination';

type OrganizationOwner = Extract<WorkspaceContext, { kind: 'organization' }>;
type AlreadyBoundSubject = 'repository' | 'share';
/** The fork dialog's existing-destination options, as named in a sentence. */
type ExistingDestinationOption =
  | 'an existing workspace'
  | 'an existing Cowork project';

/** The shapes a new fork destination can take. */
export type ForkCreationShape = 'single-repo' | 'multi-repo' | 'cowork';

function organizationLabel(organizationName: string | undefined): string {
  return organizationName?.trim() || 'the organization';
}

function sentenceStart(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The one place a new organization copy's refusal gets its copy (CAN-4781).
 * Callers and tests depend on the stable code, never on the message.
 */
export function organizationForkError(
  code: Extract<
    SharedContainerForkErrorCode,
    | 'organization-creation-unavailable'
    | 'organization-project-limit'
    | 'organization-already-bound'
    | 'organization-repository-inaccessible'
    | 'organization-shape-unsupported'
    | 'organization-creation-failed'
  >,
  organizationName: string | undefined,
  options: {
    /**
     * Already bound: what the organization already has here. A repository
     * copy names the repository; a Cowork or snapshot copy names the share.
     */
    alreadyBound?: AlreadyBoundSubject;
    /**
     * Already bound: the dialog option that leads to a usable, compatible
     * destination. Absent when none is usable, so none is suggested.
     */
    existingDestinationOption?: ExistingDestinationOption;
    /** Creation failed and part of the attempt could not be removed. */
    cleanupPending?: boolean;
    /** The failure this refusal reports, kept for diagnostics. */
    cause?: unknown;
  } = {},
): SharedContainerForkError {
  const organization = organizationLabel(organizationName);
  const errorOptions =
    options.cause === undefined ? undefined : { cause: options.cause };
  const Organization = sentenceStart(organization);
  switch (code) {
    case 'organization-creation-unavailable':
      return new SharedContainerForkError(
        code,
        `You can't create projects in ${organization} right now, so the copy wasn't made.`,
        errorOptions,
      );
    case 'organization-project-limit':
      return new SharedContainerForkError(
        code,
        `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in ${organization}, so the copy wasn't made. Delete one to make another.`,
        errorOptions,
      );
    case 'organization-already-bound': {
      const existing = `${Organization} already has ${
        options.alreadyBound === 'share'
          ? 'a copy of this share'
          : 'this repository'
      } on this computer`;
      return new SharedContainerForkError(
        code,
        options.existingDestinationOption
          ? `${existing}. Choose ${options.existingDestinationOption} to add the copy there.`
          : `${existing}, so the copy wasn't made.`,
        errorOptions,
      );
    }
    case 'organization-repository-inaccessible':
      return new SharedContainerForkError(
        code,
        `${Organization} has a project for this repository that you can't use, so the copy wasn't made.`,
        errorOptions,
      );
    case 'organization-shape-unsupported':
      return new SharedContainerForkError(
        code,
        `Shares with several repositories can't be copied into a new workspace in ${organization} yet, so the copy wasn't made.`,
        errorOptions,
      );
    case 'organization-creation-failed':
      return new SharedContainerForkError(
        code,
        options.cleanupPending
          ? `Couldn't make the copy in ${organization}, and its unfinished workspace couldn't be removed. Remove it from ${organization} before you try again.`
          : `Couldn't make the copy in ${organization}. Try again.`,
        errorOptions,
      );
  }
}

/**
 * How many creation keys one share revision's copies may walk through in one
 * organization. Each key is used until its project is bound here or can no
 * longer be replayed, so this bounds repeat copies of one revision, not
 * retries.
 */
export const FORK_CREATION_KEY_GENERATIONS = 16;

/**
 * The server answers 409 for a payload that differs from the key's first
 * request, which the key rules out, and for transient write conflicts. A 409
 * is therefore retried on the same key, never treated as a reason to move on.
 */
const FORK_CREATION_CONFLICT_ATTEMPTS = 3;

/**
 * Consecutive keys whose projects are gone (404) before the walk stops. A run
 * of 404s on fresh keys is the organization or the route being unavailable,
 * not a chain of deleted copies.
 */
const FORK_CREATION_GONE_REPLAYS = 4;

/** The conflicts seen on this key, counting the one just answered. */
function conflictCount(
  generation: number,
  conflictGeneration: number,
  conflicts: number,
): number {
  return (generation === conflictGeneration ? conflicts : 0) + 1;
}

/** Let a competing write finish before a conflict is retried on the same key. */
function waitBeforeConflictRetry(attempt: number): Promise<void> {
  const delayMs = 100 * attempt + Math.floor(Math.random() * 100);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Whether a key's project can no longer be used: archived, deleted or gone
 * from the member's catalog. Only then does a copy move on to the next key; a
 * project that is still active was refused for another reason (such as access
 * removed after its claim), and moving on would leave it behind for nothing.
 * A catalog that can't be read proves nothing, so the copy stops.
 */
async function forkProjectRetired(
  owner: OrganizationOwner,
  projectId: string | undefined,
): Promise<boolean> {
  if (projectId === undefined) return false;
  try {
    const { getOrgProjectCatalogService } =
      await import('../../services/org-project-catalog-service');
    const snapshot = await getOrgProjectCatalogService().refresh(owner, {
      force: true,
    });
    if (snapshot.stale || snapshot.error) return false;
    const project = snapshot.projects.find((item) => item.id === projectId);
    return project === undefined || project.state !== 'ACTIVE';
  } catch {
    return false;
  }
}

/**
 * The server creation key for one share revision's copy in one organization,
 * at one generation. Keys form a deterministic chain with no local record: a
 * copy starts at generation 0 and moves on only past a key whose project is
 * already bound here or can no longer be replayed (deleted, archived, or a
 * changed payload). So a retry after a failure walks the same chain and
 * replays the unbound project the failed attempt made, instead of making
 * another, while a later copy of the same revision gets a project of its own.
 * Without a local record the chain can't tell a failed attempt's project from
 * an earlier successful copy whose local workspace was since deleted: both are
 * unbound here, so a new copy replays either one. The key covers every field
 * the server compares on replay.
 */
export function forkOrganizationCreationKey(input: {
  shape: 'single-repo' | 'cowork';
  containerId: string;
  revisionId: string;
  organizationId: string;
  name: string;
  remoteUrl?: string | null;
  generation: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'shared-container-fork',
        input.shape,
        input.containerId,
        input.revisionId,
        input.organizationId,
        input.name,
        input.remoteUrl ?? null,
        input.generation,
      ]),
    )
    .digest('hex');
}

/**
 * A server-safe, non-empty project name for a copy's title, cut at the
 * server's limit without splitting a character.
 */
export function forkOrganizationProjectName(
  title: string,
  fallback: string,
): string {
  const name = title.trim() || fallback.trim() || 'Shared copy';
  return Array.from(name).slice(0, ORG_PROJECT_LIMITS.nameLength).join('');
}

async function organizationDestinationUsable(
  workspaceId: string,
  owner: OrganizationOwner,
): Promise<boolean> {
  try {
    await assertForkWorkspaceOwner(workspaceId, owner, true);
    return true;
  } catch {
    return false;
  }
}

/** The organization's workspace for this repository on this computer, if any. */
async function findBoundRepositoryWorkspace(
  owner: OrganizationOwner,
  remoteUrl: string,
): Promise<string | undefined> {
  const { items } = await readAllSidebarItems({ persistRemovalCleanup: false });
  const candidates: Array<{ workspaceId: string; checkout: string }> = [];
  for (const item of items) {
    if (
      item.type === 'cowork' ||
      item.owner?.type !== 'organization' ||
      item.owner.organizationId !== owner.organizationId
    )
      continue;
    candidates.push(
      ...(item.type === 'single-repo'
        ? [item.repoPath]
        : item.repos.map((repo) => repo.repoPath)
      ).map((checkout) => ({ workspaceId: item.id, checkout })),
    );
  }
  // Remote reads spawn git; read a few at a time rather than one by one.
  for (let start = 0; start < candidates.length; start += 8) {
    const remotes = await Promise.all(
      candidates.slice(start, start + 8).map(async (candidate) => {
        try {
          return await getRemoteUrl(candidate.checkout);
        } catch {
          return null;
        }
      }),
    );
    const match = remotes.findIndex(
      (remote) => !!remote && remoteUrlsMatch(remote, remoteUrl),
    );
    if (match >= 0) return candidates[start + match]?.workspaceId;
  }
  return undefined;
}

/**
 * Refuse, before promotion or any other effect, a new organization copy this
 * member cannot make: the shape is unsupported, organization projects are
 * unavailable to them, or the organization already has the repository here.
 * The creators recheck authorization at creation time; the server decides.
 */
export async function assertOrganizationForkEligible(input: {
  owner: WorkspaceContext;
  organizationName?: string;
  shape: ForkCreationShape;
  /** The single repository's published remote; absent for a snapshot. */
  remoteUrl?: string;
}): Promise<void> {
  const { owner } = input;
  if (owner.kind !== 'organization') return;
  if (input.shape === 'multi-repo')
    throw organizationForkError(
      'organization-shape-unsupported',
      input.organizationName,
    );
  const { isOrgCoworkOperationEligible, isOrgMemberCodeOperationEligible } =
    await import('../../lib/org-cowork-binding-deps');
  let eligible: boolean;
  let eligibilityError: unknown;
  try {
    // The share decides the organization, not the active context.
    eligible =
      input.shape === 'cowork'
        ? await isOrgCoworkOperationEligible(owner.organizationId, {
            scope: 'membership',
          })
        : await isOrgMemberCodeOperationEligible(owner.organizationId, {
            scope: 'membership',
          });
  } catch (error) {
    eligible = false;
    eligibilityError = error;
  }
  if (!eligible)
    throw organizationForkError(
      'organization-creation-unavailable',
      input.organizationName,
      { cause: eligibilityError },
    );
  if (input.shape === 'single-repo' && input.remoteUrl) {
    const bound = await findBoundRepositoryWorkspace(owner, input.remoteUrl);
    if (bound !== undefined)
      throw organizationForkError(
        'organization-already-bound',
        input.organizationName,
        {
          alreadyBound: 'repository',
          ...((await organizationDestinationUsable(bound, owner))
            ? { existingDestinationOption: 'an existing workspace' as const }
            : {}),
        },
      );
  }
}

/**
 * The organization's project is already bound on this computer. Point to its
 * workspace only when it can take this copy: a snapshot repository can't be
 * matched to an existing checkout, so it never can.
 */
async function alreadyBoundError(
  owner: OrganizationOwner,
  organizationName: string | undefined,
  projectId: string | undefined,
  shape: 'repository' | 'snapshot' | 'cowork',
): Promise<SharedContainerForkError> {
  let usable = false;
  if (projectId !== undefined && shape !== 'snapshot') {
    const { items } = await readAllSidebarItems({
      persistRemovalCleanup: false,
    });
    const bound = items.find(
      (item) =>
        item.owner?.type === 'organization' &&
        item.owner.organizationId === owner.organizationId &&
        item.owner.projectId === projectId,
    );
    if (bound) usable = await organizationDestinationUsable(bound.id, owner);
  }
  return organizationForkError('organization-already-bound', organizationName, {
    alreadyBound: shape === 'repository' ? 'repository' : 'share',
    ...(usable
      ? {
          existingDestinationOption:
            shape === 'cowork'
              ? ('an existing Cowork project' as const)
              : ('an existing workspace' as const),
        }
      : {}),
  });
}

function conversionError(
  code: OrgProjectConversionErrorCode | undefined,
  organizationName: string | undefined,
  cause?: unknown,
): SharedContainerForkError {
  const options = cause === undefined ? {} : { cause };
  switch (code) {
    case 'disabled':
    case 'project-unavailable':
      return organizationForkError(
        'organization-creation-unavailable',
        organizationName,
        options,
      );
    case 'member-project-limit':
      return organizationForkError(
        'organization-project-limit',
        organizationName,
        options,
      );
    default:
      return organizationForkError(
        'organization-creation-failed',
        organizationName,
        options,
      );
  }
}

/**
 * Bind the fork's new Personal checkout to the organization in place through
 * the member-code creator: it creates (or, for this copy's key, replays) the
 * member's private project, or uses the organization's project for the
 * repository, then claims, binds and completes. The creator's conversion
 * restores Personal itself when it fails; a later fork failure releases the
 * binding through {@link releaseForkOrganizationBinding}.
 */
export async function bindForkCodeWorkspaceToOrganization(input: {
  owner: WorkspaceContext;
  organizationName?: string;
  workspaceId: string;
  checkoutPath: string;
  containerId: string;
  revisionId: string;
  title: string;
  /** The checkout's folder name, when the title is blank. */
  fallbackName: string;
  remoteUrl?: string;
}): Promise<void> {
  const { owner } = input;
  if (owner.kind !== 'organization') return;
  const name = forkOrganizationProjectName(input.title, input.fallbackName);
  const snapshot = !input.remoteUrl;
  const { getOrgMemberCodeCreator } =
    await import('../../lib/org-member-code-create-deps');
  const { CanopyCloudClientError } = await import('../../canopy-cloud/client');
  let refusal = organizationForkError(
    'organization-creation-failed',
    input.organizationName,
  );
  let conflicts = 0;
  let conflictGeneration = -1;
  let goneReplays = 0;
  let retiredProjectId: string | undefined;
  for (
    let generation = 0;
    generation < FORK_CREATION_KEY_GENERATIONS;
    generation += 1
  ) {
    let result: CreateOrgMemberCodeProjectResult;
    try {
      result = await getOrgMemberCodeCreator().create(
        {
          organizationId: owner.organizationId,
          name,
          folderPath: input.checkoutPath,
          creationKey: forkOrganizationCreationKey({
            shape: 'single-repo',
            containerId: input.containerId,
            revisionId: input.revisionId,
            organizationId: owner.organizationId,
            name,
            remoteUrl: input.remoteUrl,
            generation,
          }),
        },
        // Unexpected failures propagate, so a server refusal after the
        // eligibility check reads as one instead of as a generic failure.
        { scope: 'membership', propagateErrors: true },
      );
    } catch (error) {
      if (error instanceof CanopyCloudClientError && error.status === 404) {
        // The key replays a project that is gone: move on to the next key.
        if ((goneReplays += 1) >= FORK_CREATION_GONE_REPLAYS)
          throw organizationForkError(
            'organization-creation-unavailable',
            input.organizationName,
            { cause: error },
          );
        refusal = organizationForkError(
          'organization-creation-failed',
          input.organizationName,
          { cause: error },
        );
        continue;
      }
      if (
        error instanceof CanopyCloudClientError &&
        error.status === 409 &&
        (conflicts = conflictCount(generation, conflictGeneration, conflicts)) <
          FORK_CREATION_CONFLICT_ATTEMPTS
      ) {
        conflictGeneration = generation;
        await waitBeforeConflictRetry(conflicts);
        generation -= 1;
        continue;
      }
      throw organizationForkError(
        error instanceof CanopyCloudClientError && error.status === 403
          ? 'organization-creation-unavailable'
          : 'organization-creation-failed',
        input.organizationName,
        { cause: error },
      );
    }
    goneReplays = 0;
    if (result.ok) {
      if (result.localWorkspaceId !== input.workspaceId)
        throw organizationForkError(
          'organization-creation-failed',
          input.organizationName,
        );
      return;
    }
    switch (result.code) {
      case 'unavailable':
        throw organizationForkError(
          'organization-creation-unavailable',
          input.organizationName,
        );
      case 'limit-reached':
        throw organizationForkError(
          'organization-project-limit',
          input.organizationName,
        );
      case 'refused':
        if (result.reason === 'no-access' || result.reason === 'ambiguous')
          throw organizationForkError(
            'organization-repository-inaccessible',
            input.organizationName,
          );
        if (result.reason === 'already-org-project')
          throw await alreadyBoundError(
            owner,
            input.organizationName,
            undefined,
            snapshot ? 'snapshot' : 'repository',
          );
        throw organizationForkError(
          'organization-creation-failed',
          input.organizationName,
        );
      case 'setup-failed':
        if (result.conversionCode === 'project-already-bound') {
          // A repository-less key's project belongs to an earlier copy that
          // is bound here. The repository itself holds a GitHub copy's
          // project, so moving on would land on the same one.
          const bound = await alreadyBoundError(
            owner,
            input.organizationName,
            result.organizationProjectId,
            snapshot ? 'snapshot' : 'repository',
          );
          if (!snapshot) throw bound;
          refusal = bound;
          continue;
        }
        if (result.conversionCode === 'project-unavailable') {
          // An archived or deleted project moves the copy to the next key,
          // once: a repository project the inspection keeps matching would
          // come back on every key.
          const retired =
            result.organizationProjectId !== retiredProjectId &&
            (await forkProjectRetired(owner, result.organizationProjectId));
          const unusable = snapshot
            ? organizationForkError(
                'organization-creation-failed',
                input.organizationName,
              )
            : organizationForkError(
                'organization-repository-inaccessible',
                input.organizationName,
              );
          if (!retired) throw unusable;
          retiredProjectId = result.organizationProjectId;
          refusal = unusable;
          continue;
        }
        throw conversionError(result.conversionCode, input.organizationName);
      case 'create-failed':
        throw organizationForkError(
          'organization-creation-failed',
          input.organizationName,
        );
    }
  }
  throw refusal;
}

/**
 * Bind the fork's new Personal Cowork project to the organization in place:
 * the organization creates (or, for this copy's key, replays) the member's
 * private Cowork project, then the same claim, binding and completion as any
 * Cowork move follow.
 */
export async function bindForkCoworkWorkspaceToOrganization(input: {
  owner: WorkspaceContext;
  organizationName?: string;
  workspaceId: string;
  containerId: string;
  revisionId: string;
}): Promise<void> {
  const { owner } = input;
  if (owner.kind !== 'organization') return;
  const { items } = await readAllSidebarItems({ persistRemovalCleanup: false });
  const workspace = items.find((item) => item.id === input.workspaceId);
  if (!workspace || workspace.type !== 'cowork')
    throw organizationForkError(
      'organization-creation-failed',
      input.organizationName,
    );
  // The conversion names the project after the workspace (trimmed, never
  // made unique); the key must cover the name the server compares on replay.
  const name = forkOrganizationProjectName(workspace.name, input.workspaceId);
  const { getOrgProjectMaterialization } =
    await import('../../lib/org-project-materialization');
  let refusal = organizationForkError(
    'organization-creation-failed',
    input.organizationName,
  );
  const { CanopyCloudClientError } = await import('../../canopy-cloud/client');
  let conflicts = 0;
  let conflictGeneration = -1;
  let goneReplays = 0;
  for (
    let generation = 0;
    generation < FORK_CREATION_KEY_GENERATIONS;
    generation += 1
  ) {
    let createError: unknown;
    const result: OrgProjectConversionResult =
      await getOrgProjectMaterialization().convertCoworkWorkspace(
        {
          workspaceId: input.workspaceId,
          organizationId: owner.organizationId,
        },
        {
          creationKey: forkOrganizationCreationKey({
            shape: 'cowork',
            containerId: input.containerId,
            revisionId: input.revisionId,
            organizationId: owner.organizationId,
            name,
            generation,
          }),
          onCreateRefused: (error) => {
            createError = error;
          },
        },
      );
    if (result.ok) {
      if (result.workspaceId !== input.workspaceId)
        throw organizationForkError(
          'organization-creation-failed',
          input.organizationName,
        );
      return;
    }
    // Refused before any claim: the key's project belongs to an earlier copy
    // that is bound here. Move on to the next key.
    if (result.code === 'project-already-bound') {
      goneReplays = 0;
      refusal = await alreadyBoundError(
        owner,
        input.organizationName,
        result.organizationProjectId,
        'cowork',
      );
      continue;
    }
    const status =
      createError instanceof CanopyCloudClientError
        ? createError.status
        : undefined;
    // Only an unclassified conflict is transient; a project limit or a
    // repository mismatch also arrives as a 409 and is final.
    if (
      status === 409 &&
      result.code === 'conversion-failed' &&
      (conflicts = conflictCount(generation, conflictGeneration, conflicts)) <
        FORK_CREATION_CONFLICT_ATTEMPTS
    ) {
      conflictGeneration = generation;
      await waitBeforeConflictRetry(conflicts);
      generation -= 1;
      continue;
    }
    if (result.code === 'project-unavailable' && status === 404) {
      // The key replays a project that is gone.
      if ((goneReplays += 1) >= FORK_CREATION_GONE_REPLAYS)
        throw organizationForkError(
          'organization-creation-unavailable',
          input.organizationName,
          { cause: createError },
        );
      refusal = organizationForkError(
        'organization-creation-failed',
        input.organizationName,
        { cause: createError },
      );
      continue;
    }
    goneReplays = 0;
    // The replayed project was refused after creation: move on only when it
    // was archived or deleted, never for a 403 or a refusal after its claim.
    if (
      result.code === 'project-unavailable' &&
      createError === undefined &&
      (await forkProjectRetired(owner, result.organizationProjectId))
    ) {
      refusal = organizationForkError(
        'organization-creation-failed',
        input.organizationName,
      );
      continue;
    }
    throw conversionError(result.code, input.organizationName, createError);
  }
  throw refusal;
}

/**
 * Compensation for a fork that failed after its new workspace was bound:
 * release the claimed instance and return the workspace to Personal through
 * the supported move back, so the existing rollback can then delete it. The
 * organization project stays, unbound; a retry of the same copy replays it.
 * A workspace that was never bound, or whose conversion already restored
 * Personal, needs nothing.
 */
export async function releaseForkOrganizationBinding(
  workspaceId: string,
): Promise<void> {
  const current = await readWorkspaceOwnership(workspaceId);
  if (current.authority === 'absent') return;
  if (current.authority !== 'ok')
    throw new Error(
      `Preserved fork workspace ${workspaceId}: its ownership is unreadable`,
    );
  if (current.owner === undefined) return;
  const { getOrgProjectMaterialization } =
    await import('../../lib/org-project-materialization');
  const released = await getOrgProjectMaterialization().moveBackToPersonal({
    workspaceId,
  });
  if (!released.ok)
    throw new Error(
      `Preserved fork workspace ${workspaceId}: its organization binding could not be released (${released.code})`,
    );
}

/**
 * Delete a workspace this fork created only once it is Personal again. A
 * workspace whose organization binding could not be released keeps its
 * claim, so it stays where the member can see and remove it.
 */
export async function assertForkWorkspaceUnbound(
  workspaceId: string,
): Promise<void> {
  const current = await readWorkspaceOwnership(workspaceId);
  if (current.authority === 'ok' && current.owner !== undefined)
    throw new Error(
      `Preserved fork workspace ${workspaceId}: it is still bound to its organization`,
    );
}

function errorSummary(error: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  const head = describeErrorForAppDiagnostic(error)
    .split('\n')
    .slice(0, 4)
    .map((line) => line.trim())
    .join(' ');
  if (!(error instanceof Error)) return [head];
  const members: unknown[] =
    'errors' in error && Array.isArray(error.errors) ? error.errors : [];
  return [
    head,
    ...(!(error instanceof SharedContainerForkError) ||
    error.failure === undefined
      ? []
      : errorSummary(error.failure, depth + 1).map((line) => `cause: ${line}`)),
    ...members.flatMap((member) => errorSummary(member, depth + 1)),
  ];
}

/** Expected refusals carry their own explanation and need no diagnostic. */
function isExpectedRefusal(error: unknown): boolean {
  return (
    error instanceof SharedContainerForkError &&
    error.failure === undefined &&
    error.code !== 'organization-creation-failed'
  );
}

/**
 * Keep the cause of an unexpected organization-copy failure, including every
 * member of an incomplete rollback, before it is reduced to a stable refusal.
 * Only error names, codes and frames are kept: messages quote workspace ids
 * and checkout paths, which app diagnostics never carry.
 */
function recordOrganizationForkFailure(error: unknown): void {
  if (isExpectedRefusal(error)) return;
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_container_org_fork_failed',
      ...(error instanceof SharedContainerForkError
        ? { reason: error.code }
        : {}),
      error: errorSummary(error).join(' | ').slice(0, 2000),
    });
  } catch {
    // Best effort: the diagnostic must never replace the refusal.
  }
}

/**
 * Report a failed new organization copy with a stable code. Organization and
 * source refusals keep theirs; any other failure is a creation failure,
 * qualified when its cleanup did not finish.
 */
export function toOrganizationForkFailure(
  error: unknown,
  organizationName: string | undefined,
): Error {
  // A revision conflict keeps its type: the boundary refuses it as such.
  if (error instanceof W5RevisionConflictError) return error;
  recordOrganizationForkFailure(error);
  if (
    error instanceof SharedContainerForkError &&
    (error.code.startsWith('organization-') ||
      error.code === 'source-unavailable')
  )
    return error;
  // The rollback reports incomplete cleanup as an aggregate of the original
  // failure and every cleanup failure. A refusal keeps its reason and adds
  // the cleanup guidance.
  const cleanupPending =
    error instanceof Error && error.name === 'AggregateError';
  const members: unknown[] =
    cleanupPending && 'errors' in error && Array.isArray(error.errors)
      ? error.errors
      : [];
  const first = members[0];
  if (
    first instanceof SharedContainerForkError &&
    first.code.startsWith('organization-') &&
    first.code !== 'organization-creation-failed'
  ) {
    const organization = organizationName?.trim() || 'the organization';
    return new SharedContainerForkError(
      first.code,
      `${first.message} Its unfinished workspace couldn't be removed. Remove it from ${organization} before you try again.`,
      { cause: error },
    );
  }
  return organizationForkError(
    'organization-creation-failed',
    organizationName,
    { cleanupPending },
  );
}

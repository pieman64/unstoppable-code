import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { notifyScriptActionsRepositoryAdd } from '../services/script-actions-lifecycle';
import {
  w5CompositionLocks,
  commitW5BoundaryStep,
  decodeW5CompositionOutcome,
} from './w5-composition-operation';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import { withW5Commit } from './w5-commit-log-file-store';
import {
  afterW5Commit,
  currentW5CommitScope,
  type W5CommitOptions,
} from './w5-commit-scope';
import { createW5SingleDecisionOperation } from './w5-single-decision-operation';
import { WORKSPACE_MANIFEST_STORAGE } from './w5-storage';
import { readdir } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type {
  WorkspaceConfigFile,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import { isGitRepo } from './git';
import { getWorkspaceWorktreesRootDir } from './paths';
import { slugify, uniqueId } from './string-utils';
import { validateId } from './validation';
import {
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
  type WorkspaceConfigUpdateRead,
} from './workspace-persistence';

/** The caller of a repository add or removal (CAN-3819). */
export type WorkspaceRepositorySource =
  /** `workspace:add-repo` and `workspace:remove-repo`. */
  | 'workspace_settings'
  /** A temporary combine adding a repository to its source workspace. */
  | 'temporary_combine'
  /** A shared-container fork binding a cloned repository. */
  | 'shared_container_fork'
  /** The organization multi-repo sync undoing a change it could not sync. */
  | 'organization_sync_revert';

/** A repository to add; its id and name are derived when omitted. */
export interface WorkspaceRepositoryCandidate {
  /** Absolute path of a Git repository. */
  repoPath: string;
  id?: string;
  name?: string;
  source?: WorkspaceRepoData['source'];
  manifestUrl?: string;
}

/**
 * `core.workspace.repository.add`. A new repository is added after the
 * others; the organization sync revert puts back the repository its removal
 * took out, at the position it had.
 */
export type WorkspaceRepositoryAddRequest = W5BoundaryOptions &
  (
    | {
        workspaceId: string;
        source: Exclude<WorkspaceRepositorySource, 'organization_sync_revert'>;
        repository: WorkspaceRepositoryCandidate;
      }
    | {
        workspaceId: string;
        source: 'organization_sync_revert';
        restore: { repository: WorkspaceRepoData; index: number };
      }
  );

/** `core.workspace.repository.remove`. */
export interface WorkspaceRepositoryRemoveRequest extends W5BoundaryOptions {
  workspaceId: string;
  repoId: string;
  source: Extract<
    WorkspaceRepositorySource,
    'workspace_settings' | 'organization_sync_revert'
  >;
}

export interface WorkspaceRepositoryRemoveOutcome {
  /** The removed repository, or `null` when the workspace did not have it. */
  removed: WorkspaceRepoData | null;
}

export type WorkspaceRepositoryRefusal =
  | 'invalid-request'
  | 'not-a-repository'
  | 'not-found'
  | 'not-multi-repo'
  | 'duplicate'
  | 'configuration-unavailable';

/** The repository change was refused before anything was written. */
export class WorkspaceRepositoryRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceRepositoryRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRepositoryRefusedError';
  }
}

function refuse(
  reason: WorkspaceRepositoryRefusal,
  message: string,
): WorkspaceRepositoryRefusedError {
  return new WorkspaceRepositoryRefusedError(reason, message);
}

/**
 * Applies a repository change to the manifest read inside the workspace's
 * write queue. A missing manifest is refused rather than created from the
 * default configuration, and an unreadable one is refused and left as it is.
 */
async function updateRepositories<T>(
  workspaceId: string,
  update: (config: WorkspaceConfigFile) => T | Promise<T>,
  shouldWrite?: (result: T) => boolean,
): Promise<T> {
  try {
    return await updateWorkspaceConfig(
      workspaceId,
      (config, read: WorkspaceConfigUpdateRead): T | Promise<T> => {
        if (read.authority === 'absent') {
          throw refuse('not-found', `Project ${workspaceId} not found`);
        }
        return update(config);
      },
      shouldWrite ? { shouldWrite } : undefined,
    );
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) {
      throw refuse('configuration-unavailable', error.message);
    }
    throw error;
  }
}

/**
 * Repository ids already taken in this workspace: its repositories and every
 * repository folder of its worktrees, so a new id never names an existing
 * checkout.
 */
async function takenRepoIds(
  workspaceId: string,
  config: WorkspaceConfigFile,
): Promise<Set<string>> {
  const taken = new Set(config.repos.map((entry) => entry.id));
  const worktreesRoot = getWorkspaceWorktreesRootDir(workspaceId);
  try {
    const worktreeDirs = await readdir(worktreesRoot, { withFileTypes: true });
    for (const worktree of worktreeDirs.filter((entry) =>
      entry.isDirectory(),
    )) {
      const repoDirs = await readdir(
        join(worktreesRoot, worktree.name, 'repos'),
        {
          withFileTypes: true,
        },
      ).catch(() => []);
      for (const entry of repoDirs) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          taken.add(entry.name);
        }
      }
    }
  } catch {
    // The worktrees directory may not exist yet.
  }
  return taken;
}

async function validateCandidate(
  candidate: WorkspaceRepositoryCandidate,
): Promise<void> {
  const repoPath: unknown = candidate.repoPath;
  if (typeof repoPath !== 'string' || !repoPath || !isAbsolute(repoPath)) {
    throw refuse('invalid-request', 'repoPath must be an absolute path');
  }
  if (!(await isGitRepo(repoPath))) {
    throw refuse('not-a-repository', `Not a git repository: ${repoPath}`);
  }
}

async function addRepository(
  workspaceId: string,
  candidate: WorkspaceRepositoryCandidate,
): Promise<WorkspaceRepoData> {
  const { repoPath } = candidate;
  return updateRepositories(
    workspaceId,
    async (config): Promise<WorkspaceRepoData> => {
      if (config.type !== 'multi-repo') {
        throw refuse(
          'not-multi-repo',
          `Project ${workspaceId} is not a multi-repo project`,
        );
      }
      if (config.repos.some((entry) => entry.repoPath === repoPath)) {
        throw refuse('duplicate', 'Repository already added to this project');
      }
      const name = candidate.name?.trim() || basename(repoPath);
      const preferredId = candidate.id?.trim() || slugify(name) || 'repo';
      const repository: WorkspaceRepoData = {
        id: uniqueId(preferredId, await takenRepoIds(workspaceId, config)),
        name,
        repoPath,
        source: candidate.source,
        manifestUrl: candidate.manifestUrl,
      };
      config.repos.push(repository);
      return repository;
    },
  );
}

async function restoreRepository(
  workspaceId: string,
  repository: WorkspaceRepoData,
  index: number,
): Promise<WorkspaceRepoData> {
  let restored = repository;
  await updateRepositories(
    workspaceId,
    (config): boolean => {
      const existing = config.repos.find((entry) => entry.id === repository.id);
      if (existing) {
        restored = existing;
        return false;
      }
      config.repos.splice(
        Math.min(Math.max(index, 0), config.repos.length),
        0,
        repository,
      );
      return true;
    },
    (changed): boolean => changed,
  );
  return restored;
}

/**
 * The typed in-process `core.workspace.repository.add` boundary (CAN-3819):
 * adds a Git repository to a multi-repo workspace, from the renderer's
 * project settings (`workspace:add-repo`), a temporary combine, a
 * shared-container fork, or the organization multi-repo sync putting back a
 * repository it could not remove.
 *
 * The type and duplicate checks, the id allocation and the write use one
 * read inside the workspace's manifest write queue, so a concurrent
 * repository, settings or ownership change is kept. A workspace without a
 * manifest is refused instead of being created with the repository, and an
 * unreadable manifest is refused and left as it is. Source control is not
 * changed here: a repository enters `canopy.json` through
 * `core.workspace.sourceChanges.apply`. Standalone changes decide the
 * workspace revision, files and keyed outcome together. Parent compositions carry their own retry identity; this operation
 * stays unregistered.
 */
export async function addWorkspaceRepository(
  request: WorkspaceRepositoryAddRequest,
  commit?: W5CommitOptions,
): Promise<WorkspaceRepoData & { scriptActionsOperationId?: string }> {
  validateId(request.workspaceId, 'workspaceId');
  const admit = async (): Promise<void> => {
    if (request.source !== 'organization_sync_revert')
      await validateCandidate(request.repository);
  };
  const apply = async (): Promise<
    WorkspaceRepoData & { scriptActionsOperationId?: string }
  > => {
    if (request.source === 'organization_sync_revert') {
      return restoreRepository(
        request.workspaceId,
        request.restore.repository,
        request.restore.index,
      );
    }
    const repository = await addRepository(
      request.workspaceId,
      request.repository,
    );
    const scriptActionsOperationId = randomUUID();
    await afterW5Commit(() => {
      notifyScriptActionsRepositoryAdd(
        request.workspaceId,
        [repository.id],
        scriptActionsOperationId,
      );
    });
    return { ...repository, scriptActionsOperationId };
  };
  return runRepositoryChange<
    WorkspaceRepoData & { scriptActionsOperationId?: string }
  >(
    'core.workspace.repository.add',
    request,
    commit,
    admit,
    repositoryOutcomeSchema,
    apply,
  );
}

/**
 * The typed in-process `core.workspace.repository.remove` boundary
 * (CAN-3819): removes one repository from a workspace's configuration, from
 * the renderer's project settings (`workspace:remove-repo`) or the
 * organization multi-repo sync undoing an add it could not sync. Worktree
 * checkouts are left for the user to clean up, as before.
 *
 * The removal is applied inside the workspace's manifest write queue, and a
 * workspace that does not have the repository is left unwritten. A missing
 * manifest is refused instead of being created, and an unreadable one is
 * refused and left as it is.
 */
export async function removeWorkspaceRepository(
  request: WorkspaceRepositoryRemoveRequest,
  commit?: W5CommitOptions,
): Promise<WorkspaceRepositoryRemoveOutcome> {
  const { workspaceId, repoId } = request;
  validateId(workspaceId, 'workspaceId');
  validateId(repoId, 'repoId');
  const apply = async (): Promise<WorkspaceRepositoryRemoveOutcome> => {
    const removed = await updateRepositories(
      workspaceId,
      (config): WorkspaceRepoData | null => {
        const index = config.repos.findIndex((entry) => entry.id === repoId);
        if (index < 0) return null;
        const [repository] = config.repos.splice(index, 1);
        return repository ?? null;
      },
      (repository): boolean => repository !== null,
    );
    return { removed };
  };
  return runRepositoryChange<WorkspaceRepositoryRemoveOutcome>(
    'core.workspace.repository.remove',
    request,
    commit,
    async () => {},
    removeOutcomeSchema,
    apply,
  );
}

const repositoryOutcomeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    repoPath: z.string(),
    source: z.enum(['local', 'manifest']).optional(),
    manifestUrl: z.string().optional(),
    scriptActionsOperationId: z.string().optional(),
  })
  .passthrough();
const removeOutcomeSchema = z.object({
  removed: repositoryOutcomeSchema.nullable(),
});
const runRepositoryCommand = createW5SingleDecisionOperation(
  (error) => error instanceof WorkspaceRepositoryRefusedError,
);

function assertStandaloneOptions(
  request: W5BoundaryOptions,
  commit?: W5CommitOptions,
): void {
  if (
    (request.idempotencyKey !== undefined ||
      request.expectedRevision !== undefined) &&
    (commit || currentW5CommitScope())
  )
    throw refuse(
      'invalid-request',
      'Standalone repository revision or retry options cannot join a parent commit',
    );
}

async function runRepositoryChange<T>(
  operation: string,
  request: WorkspaceRepositoryAddRequest | WorkspaceRepositoryRemoveRequest,
  parent: W5CommitOptions | undefined,
  admit: () => Promise<void>,
  schema: z.ZodType<T>,
  apply: () => Promise<T>,
): Promise<T> {
  assertStandaloneOptions(request, parent);
  const locks = w5CompositionLocks({ manifests: [request.workspaceId] });
  if (parent) {
    await admit();
    return commitW5BoundaryStep(parent, locks, apply);
  }
  const { idempotencyKey } = request;
  const parameters = { ...request };
  delete parameters.expectedRevision;
  delete parameters.idempotencyKey;
  const resource = {
    kind: 'workspace',
    workspaceId: request.workspaceId,
  } as const;
  return runRepositoryCommand(
    {
      operation,
      source: 'workspace-repository',
      idempotencyKey,
      parameters: () => parameters,
      storage: [WORKSPACE_MANIFEST_STORAGE],
    },
    admit,
    (outcome): T => decodeW5CompositionOutcome(schema, outcome),
    (_admitted, options, save) =>
      withW5Commit(
        {
          ...options,
          locks,
          expectedRevisions: w5ExpectedRevision(
            resource,
            request.expectedRevision,
          ),
        },
        async () => {
          await checkW5ExpectedRevision(resource, request.expectedRevision);
          return save(await apply());
        },
      ),
  );
}

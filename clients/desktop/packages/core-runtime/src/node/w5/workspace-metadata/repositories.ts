import { basename, isAbsolute } from 'node:path';
import { slugify, uniqueId } from '../../identifiers';
import {
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from '../boundary-operation';
import { currentW5CommitScope, type W5CommitOptions } from '../commit-scope';
import {
  createW5BoundaryStep,
  createW5CompositionLocks,
} from '../composition-operation';
import {
  decodeW5CompositionOutcome,
  type W5OutcomeParser,
} from '../composition-outcome';
import { createW5SingleDecisionOperation } from '../single-decision-operation';
import type {
  W5ManifestEdit,
  W5ManifestEditRead,
  W5ManifestRepositoryView,
  W5WorkspaceCommandHost,
  W5WorkspaceCommandStorage,
  W5WorkspaceManifestEditor,
  W5WorkspaceManifestView,
} from './ports';

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
  source?: W5ManifestRepositoryView['source'];
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
        restore: { repository: W5ManifestRepositoryView; index: number };
      }
  );

/**
 * A new repository a host's caller names by an opaque reference, such as a
 * picker selection (W5d1). A keyed fingerprint covers the request as sent,
 * never a path, and the host resolves the reference only for a new decision,
 * so a retry replays after the reference expired or was rebound.
 */
export type WorkspaceRepositoryReferenceAddRequest = W5BoundaryOptions & {
  workspaceId: string;
  source: Exclude<WorkspaceRepositorySource, 'organization_sync_revert'>;
  repository: Omit<WorkspaceRepositoryCandidate, 'repoPath'> & {
    reference: string;
  };
};

/** `core.workspace.repository.remove`. */
export interface WorkspaceRepositoryRemoveRequest extends W5BoundaryOptions {
  workspaceId: string;
  repoId: string;
  source: Extract<
    WorkspaceRepositorySource,
    'workspace_settings' | 'organization_sync_revert'
  >;
}

/** The added or restored repository, as its keyed outcome saves it. */
export type WorkspaceRepositoryAddOutcome = W5ManifestRepositoryView & {
  scriptActionsOperationId?: string;
};

export interface WorkspaceRepositoryRemoveOutcome {
  /** The removed repository, or `null` when the workspace did not have it. */
  removed: W5ManifestRepositoryView | null;
}

export type WorkspaceRepositoryRefusal =
  | 'invalid-request'
  | 'not-a-repository'
  | 'not-found'
  | 'not-multi-repo'
  | 'duplicate'
  | 'configuration-unavailable'
  /** A host's wire refusal of a workspace the organization sync covers. */
  | 'organization-owned';

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

/** Each request variant without its boundary options. */
export type WithoutBoundaryOptions<T> = T extends unknown
  ? Omit<T, 'expectedRevision' | 'idempotencyKey'>
  : never;

/** The fixed receipt caller source. */
export type WorkspaceRepositoryCommandSource = 'workspace-repository';

export interface WorkspaceRepositoryCommandHost extends W5WorkspaceCommandHost<WorkspaceRepositoryCommandSource> {
  manifest: W5WorkspaceManifestEditor;
  storage: Pick<W5WorkspaceCommandStorage, 'manifest'>;
  /** Whether a host path is a Git repository. */
  isRepository: (repoPath: string) => Promise<boolean>;
  /**
   * Repository folder names in the workspace's worktree checkouts, so a new
   * id never names an existing checkout.
   */
  checkoutRepoIds: (workspaceId: string) => Promise<Iterable<string>>;
  /** Inside the change's scope, after a new repository was staged. */
  afterAdd: (
    workspaceId: string,
    repository: W5ManifestRepositoryView,
  ) => Promise<WorkspaceRepositoryAddOutcome>;
  addOutcome: W5OutcomeParser<WorkspaceRepositoryAddOutcome>;
  removeOutcome: W5OutcomeParser<WorkspaceRepositoryRemoveOutcome>;
  /**
   * Checks the manifest read inside the write queue before a change applies;
   * a `WorkspaceRepositoryRefusedError` it throws refuses with nothing
   * written.
   */
  admitManifestRead?: (
    workspaceId: string,
    view: W5WorkspaceManifestView,
  ) => void;
  /**
   * What a keyed `add` or `remove` fingerprint covers; defaults to the request
   * without its boundary options. A host that keeps paths out of its receipts
   * hashes the path's fingerprint instead (W5d1). `addReferenced` holds no
   * path, so its request is fingerprinted as sent.
   */
  keyedParameters?: (
    parameters: WithoutBoundaryOptions<
      WorkspaceRepositoryAddRequest | WorkspaceRepositoryRemoveRequest
    >,
  ) => unknown;
}

export interface WorkspaceRepositoryCommands {
  /** `parent` joins a composition's commit instead of deciding alone. */
  add(
    request: WorkspaceRepositoryAddRequest,
    parent?: W5CommitOptions,
  ): Promise<WorkspaceRepositoryAddOutcome>;
  /**
   * A standalone `add` of a referenced repository. `resolveRepoPath` runs only
   * when no saved outcome replays, under the key's reservation; a keyed
   * attempt's resolution or path refusal releases the key.
   */
  addReferenced(
    request: WorkspaceRepositoryReferenceAddRequest,
    resolveRepoPath: () => Promise<string>,
  ): Promise<WorkspaceRepositoryAddOutcome>;
  remove(
    request: WorkspaceRepositoryRemoveRequest,
    parent?: W5CommitOptions,
  ): Promise<WorkspaceRepositoryRemoveOutcome>;
}

function refuse(
  reason: WorkspaceRepositoryRefusal,
  message: string,
): WorkspaceRepositoryRefusedError {
  return new WorkspaceRepositoryRefusedError(reason, message);
}

function assertStandaloneOptions(
  request: W5BoundaryOptions,
  parent?: W5CommitOptions,
): void {
  if (
    (request.idempotencyKey !== undefined ||
      request.expectedRevision !== undefined) &&
    (parent || currentW5CommitScope())
  )
    throw refuse(
      'invalid-request',
      'Standalone repository revision or retry options cannot join a parent commit',
    );
}

/**
 * `core.workspace.repository.add` and `.remove` (CAN-3819) over the host's
 * manifest editor. Adding a Git repository to a multi-repo workspace runs the
 * type and duplicate checks, the id allocation and the write on one read
 * inside the workspace's manifest write queue, so a concurrent repository,
 * settings or ownership change is kept; a removal leaves a workspace that does
 * not have the repository unwritten. A workspace without a manifest is
 * refused instead of being created, and an unreadable manifest is refused and
 * left as it is. Standalone changes decide the workspace revision, files and
 * keyed outcome together; a composition passes its own commit.
 */
export function createWorkspaceRepositoryCommands(
  host: WorkspaceRepositoryCommandHost,
): WorkspaceRepositoryCommands {
  const run = createW5SingleDecisionOperation<WorkspaceRepositoryCommandSource>(
    host.decision,
    (error) => error instanceof WorkspaceRepositoryRefusedError,
  );
  const locks = createW5CompositionLocks(host.paths);
  const boundaryStep = createW5BoundaryStep(host.withCommit);

  /**
   * Applies a repository change to the manifest read inside the workspace's
   * write queue.
   */
  async function editRepositories<T>(
    workspaceId: string,
    apply: (
      view: W5WorkspaceManifestView,
    ) => W5ManifestEdit<T> | Promise<W5ManifestEdit<T>>,
  ): Promise<T> {
    const edit = await host.manifest.edit(
      workspaceId,
      (view, read: W5ManifestEditRead) => {
        if (read.authority === 'absent') {
          throw refuse('not-found', `Project ${workspaceId} not found`);
        }
        host.admitManifestRead?.(workspaceId, view);
        return apply(view);
      },
    );
    if (edit.status === 'unreadable')
      throw refuse('configuration-unavailable', edit.message);
    return edit.result;
  }

  async function validateCandidate(
    candidate: WorkspaceRepositoryCandidate,
  ): Promise<void> {
    const repoPath: unknown = candidate.repoPath;
    if (typeof repoPath !== 'string' || !repoPath || !isAbsolute(repoPath)) {
      throw refuse('invalid-request', 'repoPath must be an absolute path');
    }
    if (!(await host.isRepository(repoPath))) {
      throw refuse('not-a-repository', `Not a git repository: ${repoPath}`);
    }
  }

  function addRepository(
    workspaceId: string,
    candidate: WorkspaceRepositoryCandidate,
  ): Promise<W5ManifestRepositoryView> {
    const { repoPath } = candidate;
    return editRepositories(workspaceId, async (view) => {
      if (view.type !== 'multi-repo') {
        throw refuse(
          'not-multi-repo',
          `Project ${workspaceId} is not a multi-repo project`,
        );
      }
      if (view.repos.some((entry) => entry.repoPath === repoPath)) {
        throw refuse('duplicate', 'Repository already added to this project');
      }
      const name = candidate.name?.trim() || basename(repoPath);
      const preferredId = candidate.id?.trim() || slugify(name) || 'repo';
      const taken = new Set(view.repos.map((entry) => entry.id));
      for (const id of await host.checkoutRepoIds(workspaceId)) taken.add(id);
      const repository: W5ManifestRepositoryView = {
        id: uniqueId(preferredId, taken),
        name,
        repoPath,
        source: candidate.source,
        manifestUrl: candidate.manifestUrl,
      };
      return {
        result: repository,
        change: { repos: [...view.repos, repository] },
      };
    });
  }

  function restoreRepository(
    workspaceId: string,
    repository: W5ManifestRepositoryView,
    index: number,
  ): Promise<W5ManifestRepositoryView> {
    return editRepositories(workspaceId, (view) => {
      const existing = view.repos.find((entry) => entry.id === repository.id);
      if (existing) return { result: existing };
      const repos = [...view.repos];
      repos.splice(Math.min(Math.max(index, 0), repos.length), 0, repository);
      return { result: repository, change: { repos } };
    });
  }

  /** What a keyed add or remove's fingerprint covers. */
  function keyedParameters(
    request: WorkspaceRepositoryAddRequest | WorkspaceRepositoryRemoveRequest,
  ): () => unknown {
    return () => {
      const parameters = { ...request };
      delete parameters.expectedRevision;
      delete parameters.idempotencyKey;
      return host.keyedParameters?.(parameters) ?? parameters;
    };
  }

  async function runRepositoryChange<T>(
    operation: string,
    request: W5BoundaryOptions & { workspaceId: string },
    parent: W5CommitOptions | undefined,
    parameters: () => unknown,
    admit: () => Promise<void>,
    parser: W5OutcomeParser<T>,
    apply: () => Promise<T>,
    reservedAdmit?: () => Promise<void>,
  ): Promise<T> {
    assertStandaloneOptions(request, parent);
    const changeLocks = locks({ manifests: [request.workspaceId] });
    if (parent) {
      await admit();
      if (reservedAdmit) await reservedAdmit();
      return boundaryStep(parent, changeLocks, apply);
    }
    const { idempotencyKey } = request;
    const resource = {
      kind: 'workspace',
      workspaceId: request.workspaceId,
    } as const;
    return run(
      {
        operation,
        source: 'workspace-repository',
        idempotencyKey,
        parameters,
        storage: [host.storage.manifest],
        ...(reservedAdmit && { reservedAdmit }),
      },
      admit,
      (outcome): T => decodeW5CompositionOutcome(parser, outcome),
      (_admitted, options, save) =>
        host.withCommit(
          {
            ...options,
            locks: changeLocks,
            expectedRevisions: w5ExpectedRevision(
              resource,
              request.expectedRevision,
            ),
          },
          async () => {
            await host.checkExpectedRevision(
              resource,
              request.expectedRevision,
            );
            return save(await apply());
          },
        ),
    );
  }

  async function add(
    request: WorkspaceRepositoryAddRequest,
    parent?: W5CommitOptions,
  ): Promise<WorkspaceRepositoryAddOutcome> {
    host.validateId(request.workspaceId, 'workspaceId');
    const admit = async (): Promise<void> => {
      if (request.source !== 'organization_sync_revert')
        await validateCandidate(request.repository);
    };
    const apply = async (): Promise<WorkspaceRepositoryAddOutcome> => {
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
      return host.afterAdd(request.workspaceId, repository);
    };
    return runRepositoryChange(
      'core.workspace.repository.add',
      request,
      parent,
      keyedParameters(request),
      admit,
      host.addOutcome,
      apply,
    );
  }

  async function addReferenced(
    request: WorkspaceRepositoryReferenceAddRequest,
    resolveRepoPath: () => Promise<string>,
  ): Promise<WorkspaceRepositoryAddOutcome> {
    const { workspaceId } = request;
    host.validateId(workspaceId, 'workspaceId');
    const { id, name, source, manifestUrl } = request.repository;
    let candidate: WorkspaceRepositoryCandidate | undefined;
    // Under the key's reservation, so a concurrent duplicate never redeems a
    // one-time reference twice.
    const reservedAdmit = async (): Promise<void> => {
      candidate = {
        repoPath: await resolveRepoPath(),
        ...(id !== undefined && { id }),
        ...(name !== undefined && { name }),
        ...(source !== undefined && { source }),
        ...(manifestUrl !== undefined && { manifestUrl }),
      };
      await validateCandidate(candidate);
    };
    const apply = async (): Promise<WorkspaceRepositoryAddOutcome> => {
      if (!candidate)
        throw new Error('A referenced repository add was not admitted');
      return host.afterAdd(
        workspaceId,
        await addRepository(workspaceId, candidate),
      );
    };
    return runRepositoryChange(
      'core.workspace.repository.add',
      request,
      undefined,
      () => {
        const parameters = { ...request };
        delete parameters.expectedRevision;
        delete parameters.idempotencyKey;
        return parameters;
      },
      async () => {},
      host.addOutcome,
      apply,
      reservedAdmit,
    );
  }

  async function remove(
    request: WorkspaceRepositoryRemoveRequest,
    parent?: W5CommitOptions,
  ): Promise<WorkspaceRepositoryRemoveOutcome> {
    const { workspaceId, repoId } = request;
    host.validateId(workspaceId, 'workspaceId');
    host.validateId(repoId, 'repoId');
    const apply = async (): Promise<WorkspaceRepositoryRemoveOutcome> => ({
      removed: await editRepositories(workspaceId, (view) => {
        const index = view.repos.findIndex((entry) => entry.id === repoId);
        if (index < 0) return { result: null };
        const repos = [...view.repos];
        const [repository] = repos.splice(index, 1);
        return { result: repository ?? null, change: { repos } };
      }),
    });
    return runRepositoryChange(
      'core.workspace.repository.remove',
      request,
      parent,
      keyedParameters(request),
      async () => {},
      host.removeOutcome,
      apply,
    );
  }

  return { add, addReferenced, remove };
}

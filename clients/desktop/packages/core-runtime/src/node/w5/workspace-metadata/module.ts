import {
  CoreWorkspaceUpdateResultSchema,
  type CoreWorkspaceRepositoryAddParams,
} from '@canopy/protocol/canopy-core';
import { posix, win32 } from 'node:path';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../../kernel/runtime-profile-graph';
import { CanopyOperationError } from '../../../runtime/errors';
import { slugify } from '../../identifiers';
import {
  CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
  createCoreWorkspaceMetadataHandlers,
  type CoreWorkspaceMetadataCall,
  type CoreWorkspaceMetadataHost,
} from '../../workspace/metadata-commands';
import {
  CoreWorkspaceAddressRefusedError,
  type CoreWorkspaceAddressRefusal,
} from '../../workspace/metadata-wire-errors';
import { WorkspaceConfigUnreadableError } from '../workspace-manifest-repository';
import {
  assertW5DaemonHostingAdmitted,
  createW5DaemonMetadataBinding,
  type W5DaemonMetadataBinding,
  type W5DaemonMetadataBindingOptions,
  type W5DaemonMetadataCall,
  type W5DaemonMetadataCommands,
} from './daemon-binding';
import {
  decideW5Workspace,
  deliverableW5Result,
  projectW5Repository,
  readW5DecidedWorkspace,
} from './decided-workspace';
import { readW5ManifestView } from './manifest-edit';
import type { W5WorkspaceManifestView } from './ports';
import { WorkspaceRepositoryRefusedError } from './repositories';
import type { W5DecisionOnlyRetry } from './retry';

/*
 * The registered `core.workspace.*` metadata commands (W7a, CAN-5523) on the
 * W5 qualification daemon (W7a-3): W7a-2's handlers over the daemon's own
 * host, which runs the W5 command cores through W5d1's binding (CAN-5522).
 * Composed only by the W5 qualification host with W5e events; the daemon
 * binds them to the interface lease and grants `core.workspace.write` only
 * there. Each wire call is addressed before any key is reserved (RR5), and
 * its receipts name the authenticated principal (A13), never the lease.
 */

/** The names a host binds to its interface lease (`leaseBoundOperations`). */
export const W5_HOSTED_METADATA_OPERATIONS: readonly string[] = Object.keys(
  CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
);

export interface W5HostedMetadataModuleOptions extends W5DaemonMetadataBindingOptions {
  /**
   * The trusted projection of a caller's repository selection to a host
   * path (D8). Absent, as in every production daemon today, a repository
   * add is `capability_unavailable`; undefined means an unknown selection.
   */
  readonly projectRepositorySelection?: (
    selectionId: string,
  ) => string | undefined | Promise<string | undefined>;
}

export interface W5HostedMetadata {
  readonly module: RuntimeModule;
  /** The bounded retry's per-label counts. */
  readonly retry: Pick<W5DecisionOnlyRetry, 'counts'>;
}

type AddRepository = CoreWorkspaceRepositoryAddParams['repository'];
type SelectionPort = NonNullable<
  W5HostedMetadataModuleOptions['projectRepositorySelection']
>;

const INDEX_UNAVAILABLE_MESSAGE =
  "Couldn't update this project because the project list couldn't be read. Try again.";
const ORGANIZATION_OWNED_MESSAGE =
  "An organization project's repositories can't be changed this way yet.";

/** The longest name an added repository takes from its folder. */
const DERIVED_REPOSITORY_NAME_MAX = 512;
/*
 * Leaves room for `uniqueId`'s `-<n>` under the 512-character `repoId` a
 * remove request takes. A folder name of 255 `İ` slugifies to 509 characters
 * on APFS or NTFS.
 */
const DERIVED_REPOSITORY_ID_MAX = 500;

function boundary(
  input: { expectedRevision?: number },
  call: CoreWorkspaceMetadataCall,
): { expectedRevision?: number; idempotencyKey: string } {
  return {
    ...(input.expectedRevision !== undefined && {
      expectedRevision: input.expectedRevision,
    }),
    idempotencyKey: call.idempotencyKey,
  };
}

function isOrganizationOwned(view: W5WorkspaceManifestView): boolean {
  return view.type === 'multi-repo' && view.owner?.type === 'organization';
}

function refuseOrganizationOwned(
  _workspaceId: string,
  view: W5WorkspaceManifestView,
): void {
  if (isOrganizationOwned(view))
    throw new WorkspaceRepositoryRefusedError(
      'organization-owned',
      ORGANIZATION_OWNED_MESSAGE,
    );
}

function selectionUnavailable(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message: 'Choosing a repository folder is unavailable on this host.',
    retry: { kind: 'never' },
  });
}

function selectionUnknown(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'The selected folder is no longer available. Choose it again.',
    details: { reason: 'selection-unknown' },
    retry: { kind: 'never' },
  });
}

/**
 * The daemon host of the seven commands. A call's source is fixed: no
 * daemon peer is a Portal session, and `interfaceKind` is self-declared.
 */
function createW5DaemonWorkspaceMetadataHost(
  binding: W5DaemonMetadataBinding,
  options: W5HostedMetadataModuleOptions,
): CoreWorkspaceMetadataHost {
  /**
   * RR5: the workspace is in the index exactly once, or the call is refused
   * before any key is reserved. `missing` is the refusal for an unknown one.
   */
  async function admitWorkspace(
    workspaceId: string,
    missing: Extract<
      CoreWorkspaceAddressRefusal,
      'not-found' | 'configuration-unavailable'
    >,
  ): Promise<void> {
    const { entries, authority, unreadableRowIds } = await binding.index.read();
    if (authority === 'unreadable')
      throw new CoreWorkspaceAddressRefusedError(
        'index-unavailable',
        INDEX_UNAVAILABLE_MESSAGE,
      );
    const readable = entries.filter((entry) => entry.id === workspaceId).length;
    // An unreadable row with this ID is a duplicate: a write would drop it.
    const unreadable = (unreadableRowIds ?? []).filter(
      (id) => id === workspaceId,
    ).length;
    if (readable + unreadable > 1)
      throw new CoreWorkspaceAddressRefusedError(
        'duplicate-workspace',
        `More than one project is stored as ${workspaceId}. Repair the project list and try again.`,
      );
    if (readable === 0)
      throw new CoreWorkspaceAddressRefusedError(
        missing,
        missing === 'not-found'
          ? `Project ${workspaceId} not found.`
          : new WorkspaceConfigUnreadableError().message,
      );
  }

  /** A workspace the organization multi-repo sync covers has no wire form yet. */
  async function admitPersonalRepositories(workspaceId: string): Promise<void> {
    const read = await binding.readManifest(workspaceId);
    if (
      read.authority === 'ok' &&
      isOrganizationOwned(readW5ManifestView(read.document).view)
    )
      throw new CoreWorkspaceAddressRefusedError(
        'organization-owned',
        ORGANIZATION_OWNED_MESSAGE,
      );
  }

  /** Legacy ownership rows refuse before any receipt lookup or read. */
  function commands(
    call: CoreWorkspaceMetadataCall,
    hooks: W5DaemonMetadataCall,
  ): W5DaemonMetadataCommands {
    assertW5DaemonHostingAdmitted();
    return binding.forCall(call.caller.principalId, hooks);
  }

  function repositorySelectionPort(): SelectionPort {
    const project = options.projectRepositorySelection;
    if (!project) throw selectionUnavailable();
    return project;
  }

  /** The selected folder's path, checked to fit a remove request's bounds. */
  async function selectedRepoPath(
    project: SelectionPort,
    repository: AddRepository,
  ): Promise<string> {
    const repoPath = await project(repository.selection.selectionId);
    if (repoPath === undefined) throw selectionUnknown();
    assertDerivedValuesFit(repository, repoPath);
    return repoPath;
  }

  /**
   * Refuses, before any decision, a folder whose name would become a name
   * over 512 characters or an id too long for a remove request to name. The
   * wire bounds a sent id or name; only the folder-name fallback is unbounded.
   */
  function assertDerivedValuesFit(
    repository: AddRepository,
    repoPath: string,
  ): void {
    if (repository.name?.trim()) return;
    const folder = (options.pathFlavor === 'win32' ? win32 : posix).basename(
      repoPath,
    );
    if (
      folder.length > DERIVED_REPOSITORY_NAME_MAX ||
      (repository.id === undefined &&
        slugify(folder).length > DERIVED_REPOSITORY_ID_MAX)
    )
      throw new WorkspaceRepositoryRefusedError(
        'invalid-request',
        'The folder name is too long. Give the repository a shorter name.',
      );
  }

  return {
    async update(input, call) {
      const outcome = await commands(call, {
        admitAddress: () => admitWorkspace(input.workspaceId, 'not-found'),
        decidedWorkspace: (workspaceId) =>
          decideW5Workspace(binding, workspaceId),
      }).metadata.update({
        workspaceId: input.workspaceId,
        patch: input.patch,
        // The wire source, as the desktop's registered command names it.
        source: 'desktop_canopy_client',
        ...boundary(input, call),
      });
      // Version 1 receipts (PR B's qualification port) saved no workspace.
      return outcome.workspace === undefined
        ? readW5DecidedWorkspace(binding, input.workspaceId)
        : CoreWorkspaceUpdateResultSchema.parse(outcome.workspace);
    },
    async reorder(input, call) {
      await commands(call, {
        admitAddress: async () => {
          await admitWorkspace(input.activeWorkspaceId, 'not-found');
          await admitWorkspace(input.overWorkspaceId, 'not-found');
        },
      }).metadata.reorder({
        visibleWorkspaceIds: input.visibleWorkspaceIds,
        activeWorkspaceId: input.activeWorkspaceId,
        overWorkspaceId: input.overWorkspaceId,
        ...boundary(input, call),
      });
    },
    async updateScripts(input, call) {
      await commands(call, {
        admitAddress: () =>
          admitWorkspace(input.workspaceId, 'configuration-unavailable'),
      }).settings.updateScripts({
        workspaceId: input.workspaceId,
        change: input.change,
        source: 'desktop',
        ...boundary(input, call),
      });
    },
    async updatePlanDetection(input, call) {
      await commands(call, {
        admitAddress: () =>
          admitWorkspace(input.workspaceId, 'configuration-unavailable'),
      }).settings.updatePlanDetection({
        workspaceId: input.workspaceId,
        planDetection: input.planDetection,
        source: 'desktop',
        ...boundary(input, call),
      });
    },
    async updatePrivateMemory(input, call) {
      const outcome = await commands(call, {
        admitAddress: () => admitWorkspace(input.workspaceId, 'not-found'),
      }).updatePrivateMemory({
        workspaceId: input.workspaceId,
        privateMemory: input.privateMemory,
        source: 'workspace_settings',
        ...boundary(input, call),
      });
      return {
        workspaceId: outcome.workspaceId,
        privateMemory: outcome.privateMemory,
      };
    },
    async addRepository(input, call) {
      const { repository } = input;
      const project = repositorySelectionPort();
      let selected: Promise<string> | undefined;
      // The selection resolves only for a new decision, once across its
      // stale-file retries, so a keyed retry replays after it expired.
      const added = await commands(call, {
        admitAddress: async () => {
          await admitWorkspace(input.workspaceId, 'not-found');
          await admitPersonalRepositories(input.workspaceId);
        },
        admitManifestRead: refuseOrganizationOwned,
      }).repositories.addReferenced(
        {
          workspaceId: input.workspaceId,
          source: 'workspace_settings',
          repository: {
            reference: repository.selection.selectionId,
            ...(repository.id !== undefined && { id: repository.id }),
            ...(repository.name !== undefined && { name: repository.name }),
          },
          ...boundary(input, call),
        },
        () => (selected ??= selectedRepoPath(project, repository)),
      );
      return { repository: projectW5Repository(added) };
    },
    async removeRepository(input, call) {
      const { removed } = await commands(call, {
        admitAddress: async () => {
          await admitWorkspace(input.workspaceId, 'not-found');
          await admitPersonalRepositories(input.workspaceId);
        },
        admitManifestRead: (workspaceId, view) => {
          refuseOrganizationOwned(workspaceId, view);
          // The result carries the removed repository as stored.
          const repository = view.repos.find(({ id }) => id === input.repoId);
          if (repository) deliverableW5Result(projectW5Repository(repository));
        },
      }).repositories.remove({
        workspaceId: input.workspaceId,
        repoId: input.repoId,
        source: 'workspace_settings',
        ...boundary(input, call),
      });
      return {
        removed: removed === null ? null : projectW5Repository(removed),
      };
    },
  };
}

export function createW5HostedMetadata(
  options: W5HostedMetadataModuleOptions,
): W5HostedMetadata {
  const binding = createW5DaemonMetadataBinding(options);
  return {
    retry: binding.retry,
    module: defineRuntimeModule({
      name: 'core.workspace.metadata',
      plane: 'core',
      definitions: {
        queries: {},
        instructions: CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
        streams: {},
      },
      handlers: {
        queries: {},
        // The request's abort signal never reaches the decision: once
        // admitted, a hosted command runs to its decision, as the record
        // port's commits do.
        instructions: createCoreWorkspaceMetadataHandlers(
          createW5DaemonWorkspaceMetadataHost(binding, options),
        ),
        streams: {},
      },
    }),
  };
}

/** The hosted module alone, for compositions that need no retry counts. */
export function createW5HostedMetadataModule(
  options: W5HostedMetadataModuleOptions,
): RuntimeModule {
  return createW5HostedMetadata(options).module;
}

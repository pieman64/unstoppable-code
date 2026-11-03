import { readFile, realpath } from 'node:fs/promises';
import {
  createPipelineDefinitionService,
  PipelineDefinitionSourceError,
  type PipelineDefinitionService,
  type PipelineDefinitionSourceContext,
  type PipelineDefinitionSourceDocument,
  type PipelineDefinitionSourceEntry,
  type PipelineDefinitionCopy,
  type PipelineDefinitionSourcePort,
  type PipelineDefinitionWritePort,
} from '@canopy/core-runtime/node/pipeline';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import {
  buildSharedPipelineId,
  isAddressableSharedPipelineRemoteId,
  parseSharedPipelineLocalId,
  type SharedPipelineSummary,
} from '@canopy/protocol/pipelines';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  createStoredPipelineDefinitionPort,
  createStoredPipelineDefinitionWriter,
  localPipelineNormalizeOptions,
} from '@canopy/desktop-shared/node/pipelines/definition-sources';
import { backgroundExecutionDeniedMessage } from '@canopy/desktop-shared/lib/automation-context-copy';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { isPathInside } from '../lib/path-safety';
import { readPreferencesFile } from '../lib/preferences-store';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { recordSharedItemLocalUninstall } from '../canopy-cloud/shared-item-subscriptions';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
} from '../canopy-cloud/client';
import {
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
  listSharedPipelines,
} from './canopy-server-client';
import {
  assertStoredPipelineContext,
  copyPipelineInstallOrigin,
  filterProjectPipelineContexts,
  recordSharedPipelineInstall,
  filterStoredPipelineContexts,
  readProjectPipelineOwner,
} from './pipeline-install-context';
import {
  deleteUserPipelineLocalMetadata,
  isPipelineLocalMetadataReadable,
  readPipelineLocalMetadata,
} from './pipeline-local-metadata-store';
import {
  copyPackageInstall,
  removePackageInstall,
} from './pipeline-package-service';
import { deletePipelinePluginCollectionPreferences } from './plugin-collection-store';
import { discoverProjectPipelines } from './project-pipeline-discovery';
import { recordPipelineEnabled } from './pipeline-enablement-commit';
import {
  sharedProjectDiscovery,
  type ContainedProjectPipeline,
} from './shared-project-discovery';
import {
  presentedPipeline,
  presentPipeline,
  presentSourceFailure,
} from './pipeline-definition-presentation';
import {
  assertPipelineContext,
  isPipelineContextDenial,
  pipelineResourceContextEnabled,
} from './resource-lanes';

function isoTimestamp(value: string | undefined): string | null {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function infoEntry(
  info: PipelineInfo,
  source: PipelineDefinitionSourceEntry['source'],
): PipelineDefinitionSourceEntry {
  return {
    source,
    definitionId: info.id,
    name: info.name,
    description: info.description ?? '',
    icon: info.icon ?? '',
    readonly: info.readonly,
    revision: 0,
    owner: null,
    createdAt: isoTimestamp(info.createdAt),
    updatedAt: isoTimestamp(info.updatedAt),
    ...(info.triggerTypes ? { triggerTypes: info.triggerTypes } : {}),
    ...(info.scopes ? { executionScopes: info.scopes } : {}),
    ...(info.curatedContentHash
      ? { checksum: `sha256:${info.curatedContentHash}` }
      : {}),
  };
}

function storedOwner(definitionId: string): string | null {
  if (!isPipelineLocalMetadataReadable()) {
    // Without organization contexts every definition is Personal and its
    // saved owner is never read, so an unreadable store hides nothing.
    if (!pipelineResourceContextEnabled()) return null;
    // With them, never show an unreadable owner as none.
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      backgroundExecutionDeniedMessage('unknown-provenance'),
    );
  }
  return (
    readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: definitionId,
    }).owner ?? null
  );
}

/**
 * An owner-scoped read authorizes the definition against the run owner, as
 * the run start path does, and keeps a refusal's message.
 */
async function assertOwnerContext(assert: () => Promise<void>): Promise<void> {
  try {
    await assert();
  } catch (error) {
    if (isPipelineContextDenial(error))
      throw new PipelineDefinitionSourceError(
        'core.pipeline.contextMismatch',
        error.message,
        error,
      );
    throw error;
  }
}

/** The local store, with each user definition's saved owner and context. */
function storedPort(): PipelineDefinitionSourcePort {
  const store = createStoredPipelineDefinitionPort({ owner: storedOwner });
  return {
    sources: store.sources,
    list: async (
      context,
    ): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      // While saved owners cannot be read, a listing leaves out the user
      // definitions it cannot attribute rather than failing the bundled ones.
      const entries = await store.list(
        pipelineResourceContextEnabled() && !isPipelineLocalMetadataReadable()
          ? {
              ...context,
              sources: context.sources.filter((source) => source !== 'user'),
            }
          : context,
      );
      const visible = new Set(
        (
          await filterStoredPipelineContexts(
            entries.map((entry) => ({ id: entry.definitionId })),
            context.scope.workspaceId,
          )
        ).map((row) => row.id),
      );
      return entries.filter((entry) => visible.has(entry.definitionId));
    },
    read: async (
      source,
      definitionId,
      context,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const document = await store.read(source, definitionId, context);
      if (!document) return null;
      if (context.owner !== undefined) {
        await assertOwnerContext(() =>
          assertStoredPipelineContext(
            definitionId,
            context.scope.workspaceId,
            context.owner,
          ),
        );
        return document;
      }
      const [visible] = await filterStoredPipelineContexts(
        [{ id: definitionId }],
        context.scope.workspaceId,
      );
      if (!visible)
        throw new PipelineDefinitionSourceError(
          'core.pipeline.contextMismatch',
          'Workflow unavailable (context-mismatch)',
        );
      return document;
    },
  };
}

/**
 * The checkout a project scope names: the worktree root, which is where
 * project discovery looks today. Member repositories are not resolved yet.
 */
async function projectCheckout(scope: CanopyWorkspaceScope): Promise<string> {
  const { workspaceId, worktreeId, repoId } = scope;
  if (
    !workspaceId ||
    !worktreeId ||
    (repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID)
  )
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'A project workflow needs a workspace and worktree scope.',
    );
  const [{ readAllSidebarItems }, paths] = await Promise.all([
    import('../lib/sidebar-items'),
    import('../lib/paths'),
  ]);
  const item = (await readAllSidebarItems()).items.find(
    (candidate) => candidate.id === workspaceId,
  );
  const worktrees = item && 'worktrees' in item ? item.worktrees : [];
  if (!item || !worktrees.some((worktree) => worktree.id === worktreeId))
    throw new PipelineDefinitionSourceError(
      'core.pipeline.scopeInvalid',
      'The workflow scope names an unknown worktree.',
    );
  return item.type === 'single-repo'
    ? paths.getWorktreeDir(workspaceId, worktreeId)
    : paths.getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);
}

function visibleProjectPipelines(
  context: PipelineDefinitionSourceContext,
): Promise<ContainedProjectPipeline[]> {
  return sharedProjectDiscovery(
    JSON.stringify([
      context.scope.workspaceId,
      context.scope.worktreeId,
      context.scope.repoId,
    ]),
    () => discoverVisibleProjectPipelines(context),
  );
}

async function discoverVisibleProjectPipelines(
  context: PipelineDefinitionSourceContext,
): Promise<ContainedProjectPipeline[]> {
  const cwd = await projectCheckout(context.scope);
  const checkout = await realpath(cwd);
  const discovered = await discoverProjectPipelines(cwd);
  // Discovery follows links; a definition is read only from the checkout.
  const canonical = await Promise.all(
    discovered.map(async (info) => {
      if (!info.filePath) return undefined;
      const file = await realpath(info.filePath).catch(() => undefined);
      return file !== undefined && isPathInside(checkout, file)
        ? file
        : undefined;
    }),
  );
  const visible = new Set(
    await filterProjectPipelineContexts(
      discovered.filter((_info, index) => canonical[index] !== undefined),
      cwd,
      context.scope.workspaceId,
      context.owner,
    ),
  );
  return discovered.flatMap((info, index) => {
    const canonicalPath = canonical[index];
    return canonicalPath !== undefined && visible.has(info)
      ? [{ info, canonicalPath }]
      : [];
  });
}

function projectPort(): PipelineDefinitionSourcePort {
  return {
    sources: ['project'],
    // A checkout that cannot be read never hides the local stores.
    optional: true,
    list: async (context) =>
      (await visibleProjectPipelines(context)).map(({ info }) => {
        presentPipeline('listed', 'project', info.id, { kind: 'info', info });
        return infoEntry(info, 'project');
      }),
    read: async (
      _source,
      definitionId,
      context,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const found = (await visibleProjectPipelines(context)).find(
        (candidate) => candidate.info.id === definitionId,
      );
      if (!found) return null;
      presentPipeline('read', 'project', definitionId, {
        kind: 'info',
        info: found.info,
      });
      return {
        ...infoEntry(found.info, 'project'),
        format: 'yaml',
        text: await readFile(found.canonicalPath, 'utf8'),
      };
    },
  };
}

function curatedPort(): PipelineDefinitionSourcePort {
  return {
    sources: ['curated'],
    optional: true,
    list: async (): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      const { listManagedCuratedPipelines } =
        await import('./curated-pipeline-catalog');
      const rows = await listManagedCuratedPipelines().catch(
        (error: unknown) => {
          presentSourceFailure('curated', error);
          throw error;
        },
      );
      return rows.map((info) => {
        presentPipeline('listed', 'curated', info.id, { kind: 'info', info });
        return infoEntry({ ...info, readonly: true }, 'curated');
      });
    },
    read: async (
      _source,
      definitionId,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const { CuratedPipelineMissingError, readManagedCuratedPipeline } =
        await import('./curated-pipeline-catalog');
      const { data, rawPipeline } = await readManagedCuratedPipeline(
        definitionId,
      ).catch((error: unknown) => {
        throw error instanceof CuratedPipelineMissingError ||
          isCloudNotFound(error)
          ? new PipelineDefinitionSourceError(
              'core.pipeline.definitionNotFound',
              error.message,
              error,
            )
          : error;
      });
      presentPipeline('read', 'curated', definitionId, { kind: 'data', data });
      return {
        ...infoEntry({ ...data.info, readonly: true }, 'curated'),
        format: 'yaml',
        text: rawPipeline,
      };
    },
  };
}

function isCloudNotFound(error: unknown): error is CanopyCloudClientError {
  return error instanceof CanopyCloudClientError && error.status === 404;
}

/** A missing share and a resource-context refusal keep their own codes. */
export function sharedPipelineReadError(error: unknown): unknown {
  if (isCloudNotFound(error))
    return new PipelineDefinitionSourceError(
      'core.pipeline.definitionNotFound',
      error.message,
      error,
    );
  if (isPipelineContextDenial(error))
    return new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      error.message,
      error,
    );
  return error;
}

/** Shares a definition id can address; others could never be read back. */
export function sharedPipelineRows<Row extends { id: string }>(
  rows: readonly Row[],
): Row[] {
  return rows.filter((row) => isAddressableSharedPipelineRemoteId(row.id));
}

/** The definition id of a share, with its account details kept for display. */
function presentSharedPipeline(
  view: 'listed' | 'read',
  pipeline: SharedPipelineSummary,
): string {
  const definitionId = buildSharedPipelineId(
    CANOPY_CLOUD_SERVER_ID,
    pipeline.id,
  );
  presentPipeline(view, 'shared', definitionId, { kind: 'shared', pipeline });
  return definitionId;
}

function sharedPort(): PipelineDefinitionSourcePort {
  return {
    sources: ['shared'],
    optional: true,
    list: async (
      context,
    ): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      let listed: Awaited<ReturnType<typeof listSharedPipelines>>;
      try {
        await assertCanopyCloudCapability('pipelines-crud-v1');
        listed = await listSharedPipelines({
          limit: 100,
          ...(context.query === undefined ? {} : { q: context.query }),
        });
      } catch (error) {
        presentSourceFailure('shared', error);
        throw error;
      }
      return sharedPipelineRows(listed.data).map((pipeline) => ({
        source: 'shared',
        definitionId: presentSharedPipeline('listed', pipeline),
        name: pipeline.name,
        description: pipeline.description,
        icon: pipeline.icon,
        readonly: !pipeline.canUpdate,
        revision: 0,
        owner: null,
        createdAt: isoTimestamp(pipeline.createdAt),
        updatedAt: isoTimestamp(pipeline.updatedAt),
        triggerTypes: pipeline.triggerTypes,
        ...(pipeline.scopes ? { executionScopes: pipeline.scopes } : {}),
      }));
    },
    read: async (
      _source,
      definitionId,
      context,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const parsed = parseSharedPipelineLocalId(definitionId);
      if (
        !parsed ||
        parsed.serverId !== CANOPY_CLOUD_SERVER_ID ||
        !isAddressableSharedPipelineRemoteId(parsed.remoteId)
      )
        return null;
      await assertCanopyCloudCapability('pipelines-crud-v1');
      let detail: Awaited<ReturnType<typeof getSharedPipeline>>;
      try {
        detail = await (context.owner === undefined
          ? getSharedPipeline(parsed.remoteId)
          : getSharedPipelineForExecutionContext(parsed.remoteId));
        await assertPipelineContext(
          { owner: detail.owner },
          context.scope.workspaceId,
          context.owner,
        );
      } catch (error) {
        throw sharedPipelineReadError(error);
      }
      presentSharedPipeline('read', detail);
      return {
        source: 'shared',
        definitionId,
        name: detail.name,
        description: detail.description,
        icon: detail.icon,
        readonly: !detail.canUpdate,
        revision: 0,
        owner: null,
        createdAt: isoTimestamp(detail.createdAt),
        updatedAt: isoTimestamp(detail.updatedAt),
        format: 'yaml',
        text: detail.rawPipeline,
      };
    },
  };
}

/** Core pipeline definitions over the desktop's sources. */
async function assertWritableContext(definitionId: string): Promise<void> {
  try {
    await assertStoredPipelineContext(definitionId);
  } catch (error) {
    if (isPipelineContextDenial(error))
      throw new PipelineDefinitionSourceError(
        'core.pipeline.contextMismatch',
        error.message,
        error,
      );
    throw error;
  }
}

/** Desktop effects of a saved user definition: an edit drops its stale package install record. */
export function applyUserPipelineSaveEffects(editedId: string | null): void {
  if (editedId !== null) void removePackageInstall(editedId);
  notifyDesktopInventoryChanged(['pipelines']);
}

/**
 * Desktop effects of a deleted user definition: its plugin collection
 * preferences, local owner metadata, subscription ledger entry and package
 * install go with it.
 */
export function applyUserPipelineDeleteEffects(definitionId: string): void {
  deletePipelinePluginCollectionPreferences({
    type: 'stored',
    source: 'user',
    value: definitionId,
  });
  deleteUserPipelineLocalMetadata(definitionId);
  // The subscription ledger names every share this copy came from, even
  // after a local edit dropped its package record.
  recordSharedItemLocalUninstall({ kind: 'pipeline', localId: definitionId });
  void removePackageInstall(definitionId);
  notifyDesktopInventoryChanged(['pipelines']);
}

async function assertPersonalProjectCopy(
  workspaceId: string | undefined,
): Promise<void> {
  let owner: Awaited<ReturnType<typeof readProjectPipelineOwner>>;
  try {
    owner = await readProjectPipelineOwner(workspaceId);
  } catch (error) {
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      errorMessage(error),
      error,
    );
  }
  if (owner.type === 'organization')
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      'Workflow unavailable (context-mismatch)',
    );
}

/** The store steps of a copy, so a test can stand in for the store. */
export interface PipelineCopyStore<T> {
  /** Creates the copy under its assigned id. */
  create(): Promise<T>;
  /** The id the store saved the copy under. */
  idOf(created: T): string;
  remove(created: T): Promise<void>;
  /** The copy as stored after its package install replaced its bytes. */
  reread(created: T): Promise<T>;
}

/**
 * Creates a copy with what the desktop keeps about its origin, all or
 * nothing: a share or install receipt follows the copy, and a stored
 * source's package install carries over with the package's own bytes.
 */
export async function copyPipelineWithProvenance<T>(
  origin: PipelineDefinitionCopy['origin'],
  definitionId: string,
  store: PipelineCopyStore<T>,
): Promise<T> {
  let undoOrigin: (() => Promise<void>) | undefined;
  const onRollback = (undo: () => Promise<void>): void => {
    undoOrigin = undo;
  };
  let created: T | undefined;
  try {
    // A share's read already fetched the detail its receipt records; a
    // project file has no install receipt to carry.
    const share = presentedPipeline('read', 'shared', origin.definitionId);
    if (
      origin.source === 'shared' &&
      share?.kind === 'shared' &&
      'rawPipeline' in share.pipeline
    )
      await recordSharedPipelineInstall(
        share.pipeline,
        definitionId,
        onRollback,
      );
    else if (origin.source !== 'project')
      await copyPipelineInstallOrigin(
        origin.definitionId,
        definitionId,
        onRollback,
      );
    created = await store.create();
    if (store.idOf(created) !== definitionId)
      throw new Error('Pipeline create identity mismatch');
    let written = created;
    if (origin.source === 'user' || origin.source === 'bundled') {
      await copyPackageInstall(origin.definitionId, definitionId);
      written = await store.reread(written);
    }
    notifyDesktopInventoryChanged(['pipelines']);
    return written;
  } catch (error) {
    const failures = [errorMessage(error)];
    try {
      if (created !== undefined) await store.remove(created);
      await undoOrigin?.();
    } catch (rollbackError) {
      failures.push(errorMessage(rollbackError));
    }
    throw new PipelineDefinitionSourceError(
      isPipelineContextDenial(error)
        ? 'core.pipeline.contextMismatch'
        : error instanceof PipelineDefinitionSourceError
          ? error.code
          : 'core.pipeline.sourceUnavailable',
      failures.join('; '),
      error,
    );
  }
}

/**
 * The user store's writer with the desktop effects. The caller records a
 * new definition's owner and agent author, which depend on who wrote it.
 */
export function desktopPipelineDefinitionWriter(): PipelineDefinitionWritePort {
  const store = createStoredPipelineDefinitionWriter({ owner: storedOwner });
  const stored = createStoredPipelineDefinitionPort({ owner: storedOwner });
  return {
    copy: async (copy, context): Promise<PipelineDefinitionSourceDocument> => {
      // An organization's project workflow is never copied out as Personal.
      if (copy.origin.source === 'project' && pipelineResourceContextEnabled())
        await assertPersonalProjectCopy(context.scope.workspaceId);
      return copyPipelineWithProvenance(copy.origin, copy.definitionId, {
        create: () => store.copy(copy, context),
        idOf: (written) => written.definitionId,
        remove: async (written): Promise<void> => {
          await store.delete(written.definitionId, null, context);
        },
        reread: async (written) =>
          (await stored.read('user', copy.definitionId, {
            ...context,
            sources: ['user'],
          })) ?? written,
      });
    },
    upsert: async (
      write,
      context,
    ): Promise<PipelineDefinitionSourceDocument> => {
      if (write.definitionId !== null)
        await assertWritableContext(write.definitionId);
      const written = await store.upsert(write, context);
      applyUserPipelineSaveEffects(write.definitionId);
      return written;
    },
    revision: (definitionId): Promise<number | null> =>
      store.revision(definitionId),
    delete: async (
      definitionId,
      expectedRevision,
      context,
    ): Promise<number> => {
      await assertWritableContext(definitionId);
      const revision = await store.delete(
        definitionId,
        expectedRevision,
        context,
      );
      applyUserPipelineDeleteEffects(definitionId);
      return revision;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDesktopPipelineDefinitionService(): PipelineDefinitionService {
  return createPipelineDefinitionService({
    ports: [storedPort(), projectPort(), curatedPort(), sharedPort()],
    writer: desktopPipelineDefinitionWriter(),
    setDefinitionEnabled: recordPipelineEnabled,
    disabledDefinitionIds: async () =>
      new Set((await readPreferencesFile()).disabledPipelineIds),
    normalizeOptions: localPipelineNormalizeOptions,
    servingTargetIds: [CANOPY_IN_PROCESS_WORKER_TARGET_ID],
  });
}

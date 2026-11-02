import { readFile, realpath } from 'node:fs/promises';
import {
  createPipelineDefinitionService,
  PipelineDefinitionSourceError,
  type PipelineDefinitionService,
  type PipelineDefinitionSourceContext,
  type PipelineDefinitionSourceDocument,
  type PipelineDefinitionSourceEntry,
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
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { recordSharedItemLocalUninstall } from '../canopy-cloud/shared-item-subscriptions';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
} from '../canopy-cloud/client';
import { getSharedPipeline, listSharedPipelines } from './canopy-server-client';
import {
  assertStoredPipelineContext,
  filterProjectPipelineContexts,
  filterStoredPipelineContexts,
} from './pipeline-install-context';
import {
  deleteUserPipelineLocalMetadata,
  isPipelineLocalMetadataReadable,
  readPipelineLocalMetadata,
} from './pipeline-local-metadata-store';
import { removePackageInstall } from './pipeline-package-service';
import { deletePipelinePluginCollectionPreferences } from './plugin-collection-store';
import { discoverProjectPipelines } from './project-pipeline-discovery';
import {
  assertPipelineContext,
  isPipelineContextDenial,
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
  // As the single-pipeline read does, never show an unreadable owner as none.
  if (!isPipelineLocalMetadataReadable())
    throw new PipelineDefinitionSourceError(
      'core.pipeline.contextMismatch',
      backgroundExecutionDeniedMessage('unknown-provenance'),
    );
  return (
    readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: definitionId,
    }).owner ?? null
  );
}

/** The local store, with each user definition's saved owner and context. */
function storedPort(): PipelineDefinitionSourcePort {
  const store = createStoredPipelineDefinitionPort({ owner: storedOwner });
  return {
    sources: store.sources,
    list: async (
      context,
    ): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      const entries = await store.list(context);
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

interface ContainedProjectPipeline {
  info: PipelineInfo;
  /** The resolved file inside the checkout; reads use it, never the link. */
  canonicalPath: string;
}

async function visibleProjectPipelines(
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
    list: async (context) =>
      (await visibleProjectPipelines(context)).map(({ info }) =>
        infoEntry(info, 'project'),
      ),
    read: async (
      _source,
      definitionId,
      context,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      const found = (await visibleProjectPipelines(context)).find(
        (candidate) => candidate.info.id === definitionId,
      );
      if (!found) return null;
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
      return (await listManagedCuratedPipelines()).map((info) =>
        infoEntry({ ...info, readonly: true }, 'curated'),
      );
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

function sharedPort(): PipelineDefinitionSourcePort {
  return {
    sources: ['shared'],
    optional: true,
    list: async (): Promise<readonly PipelineDefinitionSourceEntry[]> => {
      await assertCanopyCloudCapability('pipelines-crud-v1');
      const listed = await listSharedPipelines({ limit: 100 });
      return sharedPipelineRows(listed.data).map((pipeline) => ({
        source: 'shared',
        definitionId: buildSharedPipelineId(
          CANOPY_CLOUD_SERVER_ID,
          pipeline.id,
        ),
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
        detail = await getSharedPipeline(parsed.remoteId);
        await assertPipelineContext(
          { owner: detail.owner },
          context.scope.workspaceId,
        );
      } catch (error) {
        throw sharedPipelineReadError(error);
      }
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

/**
 * The user store's writer with the desktop effects. The caller records a
 * new definition's owner and agent author, which depend on who wrote it.
 */
export function desktopPipelineDefinitionWriter(): PipelineDefinitionWritePort {
  const store = createStoredPipelineDefinitionWriter({ owner: storedOwner });
  return {
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

/** Records an enabled state in the `disabledPipelineIds` preference. */
async function setDefinitionEnabled(
  definitionId: string,
  enabled: boolean,
): Promise<void> {
  await updatePreferencesFile((preferences) => {
    const ids = new Set(preferences.disabledPipelineIds);
    if (enabled) ids.delete(definitionId);
    else ids.add(definitionId);
    return { disabledPipelineIds: Array.from(ids) };
  });
}

export function createDesktopPipelineDefinitionService(): PipelineDefinitionService {
  return createPipelineDefinitionService({
    ports: [storedPort(), projectPort(), curatedPort(), sharedPort()],
    writer: desktopPipelineDefinitionWriter(),
    setDefinitionEnabled,
    disabledDefinitionIds: async () =>
      new Set((await readPreferencesFile()).disabledPipelineIds),
    normalizeOptions: localPipelineNormalizeOptions,
    servingTargetIds: [CANOPY_IN_PROCESS_WORKER_TARGET_ID],
  });
}

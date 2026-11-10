import type { BrowserWindow } from 'electron';
import { CanopyOperationError } from '@canopy/core-runtime';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  pluginEntryId,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  isBuiltInPluginMarketplaceId,
  isCuratedPluginMarketplaceId,
} from '@canopy/protocol/plugins/catalog';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  askPersonToConfirm,
  type RequestPersonAnswers,
} from '../lib/ask-user-outcomes';
import { getWorkspaceScopingContext } from '../lib/workspace-context-service';
import { validateAgentModelId } from '../lib/validation';
import type {
  AdvisorCatalogActionHost,
  RefreshWait,
} from './advisor-catalog-actions';

const REFRESH_WAIT_MS = 60_000;
const REMOVE_MARKETPLACE = 'Remove marketplace';
const KEEP_MARKETPLACE = 'Keep it';

/**
 * The main owners behind App Advisor's catalog actions (CAN-6002): the
 * window's agent and collection IPC owners, the window's marketplace
 * projection, core.catalog.source.* as the advisor chat for marketplace
 * writes (the Portal's direct paths for built-in and curated rows), the
 * publisher skill listing and the local skill suggestions.
 */
export function mainAdvisorCatalogActionHost(options: {
  chatId: string;
  idempotencyKey: string;
  getWindow: () => BrowserWindow | null;
  refreshWaitMs?: number;
  /** This chat's AskUserQuestion, with each answer's provenance. */
  requestUserAnswers: RequestPersonAnswers;
}): AdvisorCatalogActionHost {
  const caller = (
    grant: CanopyCallerDescriptor['grants'][number],
  ): CanopyCallerDescriptor => ({
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${options.chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [grant],
  });
  const keyed = {
    caller: caller('core.catalog.write'),
    metadata: { idempotencyKey: options.idempotencyKey },
  };
  return {
    listAgents: async () => {
      const { listAgentModels } = await import('../agents/agent-model-store');
      return listAgentModels();
    },
    getAgent: async (id) => {
      validateAgentModelId(id, 'agent id');
      const { getAgentModel } = await import('../agents/agent-model-store');
      return (await getAgentModel(id)) ?? null;
    },
    saveAgent: async (request) => {
      const { saveAgentForWindow } = await import('../ipc/agent-models');
      return saveAgentForWindow(request, options.getWindow);
    },
    deleteAgent: async (id) => {
      const { deleteAgentForWindow } = await import('../ipc/agent-models');
      return deleteAgentForWindow({ id }, options.getWindow);
    },
    listCollections: async () => {
      const { readCollectionIndex } =
        await import('../collections/collection-store');
      return (await readCollectionIndex()).collections;
    },
    getCollection: async (id) => {
      const { readCollectionConfig } =
        await import('../collections/collection-store');
      return (await readCollectionConfig(id))?.collection ?? null;
    },
    saveCollection: async (collection) => {
      const { saveCollectionConfig } =
        await import('../collections/collection-store');
      return saveCollectionConfig(collection);
    },
    deleteCollection: async (id) => {
      const { deleteCollectionConfig } =
        await import('../collections/collection-store');
      await deleteCollectionConfig(id);
    },
    loadMarketplaces: async () => {
      const { loadMarketplacesForPresentation } =
        await import('../plugins/plugin-service');
      const loaded = await loadMarketplacesForPresentation();
      if (!loaded.success || !loaded.data)
        throw new Error(
          (loaded.success ? undefined : loaded.error) ??
            'Failed to load plugin marketplaces.',
        );
      return loaded.data.marketplaces;
    },
    coreSourceIds: async () => {
      const { sources } = await getActiveDesktopRuntime().query(
        'core.catalog.source.list',
        { includeDisabled: true },
        { caller: caller('core.catalog.read') },
      );
      return new Set(sources.map((source) => source.sourceId));
    },
    isManagedMarketplace: (id) =>
      isBuiltInPluginMarketplaceId(id) || isCuratedPluginMarketplaceId(id),
    refreshThroughCore: async (sourceId) =>
      (
        await getActiveDesktopRuntime().instruction(
          'core.catalog.source.refresh',
          {
            sourceIds: [sourceId],
            providers: ['claude', 'codex'],
            mode: 'update_then_scan',
            _meta: { idempotencyKey: options.idempotencyKey },
          },
          keyed,
        )
      ).operationId,
    // The refresh operation's own end, read in process: the advisor caller
    // needs no operation-read grant, and a refresh that fails before any
    // provider status is saved still ends as failed.
    awaitRefresh: async (operationId): Promise<RefreshWait> => {
      const signal = AbortSignal.timeout(
        options.refreshWaitMs ?? REFRESH_WAIT_MS,
      );
      try {
        const operation = await getActiveDesktopRuntime().waitForOperation(
          operationId,
          signal,
        );
        return operation.status === 'completed'
          ? { state: 'succeeded' }
          : { state: 'failed', errorCode: operation.error?.code ?? null };
      } catch (error) {
        if (signal.aborted) return { state: 'timed_out' };
        throw error;
      }
    },
    refreshDirect: async (sourceId) => {
      const [{ updateMarketplace }, { refreshAfterSuccess }] =
        await Promise.all([
          import('../plugins/plugin-service'),
          import('../plugins/plugin-handlers'),
        ]);
      const result = await refreshAfterSuccess(
        'plugins:updateMarketplace',
        () => updateMarketplace(sourceId),
      );
      if (!result.success || !result.data)
        throw new Error(
          (result.success ? undefined : result.error) ??
            'Failed to refresh plugin marketplace.',
        );
      return result.data;
    },
    removeThroughCore: async (sourceId, providers) => {
      try {
        const removed = await getActiveDesktopRuntime().instruction(
          'core.catalog.source.delete',
          {
            sourceId,
            providers: [...providers],
            expectedRevision: null,
            _meta: { idempotencyKey: options.idempotencyKey },
          },
          keyed,
        );
        return {
          removedProviders: [...removed.removedProviders],
          alreadyAbsent: removed.alreadyAbsent,
        };
      } catch (error) {
        if (
          error instanceof CanopyOperationError &&
          error.payload.kind === 'not_found'
        )
          return { removedProviders: [], alreadyAbsent: true };
        throw error;
      }
    },
    confirmMarketplaceRemoval: (marketplace) =>
      askPersonToConfirm(
        options.requestUserAnswers,
        `Remove the plugin marketplace ${marketplace.name}? Plugins installed from it are removed too.`,
        { confirm: REMOVE_MARKETPLACE, decline: KEEP_MARKETPLACE },
      ),
    listMarketplaceSkills: async () => {
      const { listDesktopPublisherSkills } =
        await import('../skills/publisher-marketplace');
      return listDesktopPublisherSkills();
    },
    listSkillSuggestions: async () => {
      const [{ isSkillSuggestionsFlagEnabled }, { skillSuggestionSurfacing }] =
        await Promise.all([
          import('../skill-suggestions/feature-gate'),
          import('../skill-suggestions'),
        ]);
      if (!isSkillSuggestionsFlagEnabled()) return null;
      return skillSuggestionSurfacing.list();
    },
    readGlobalSelections: async () => {
      const [{ readPreferencesFile }, read] = await Promise.all([
        import('../lib/preferences-store'),
        getActiveDesktopRuntime().query(
          'core.catalog.selection.get',
          { scope: {} },
          { caller: caller('core.catalog.read') },
        ),
      ]);
      return {
        selections: normalizePluginSelections(
          (await readPreferencesFile()).globalPluginSelections,
        ),
        revision: read.revision,
      };
    },
    installedPluginEntryIds: async () => {
      const [{ loadMarketplacesForPresentation }, { isPluginInstalled }] =
        await Promise.all([
          import('../plugins/plugin-service'),
          import('../services/plugin-catalog-service'),
        ]);
      const loaded = await loadMarketplacesForPresentation();
      if (!loaded.success || !loaded.data)
        throw new Error(
          (loaded.success ? undefined : loaded.error) ??
            'Failed to load plugin marketplaces.',
        );
      return new Set(
        loaded.data.marketplaces.flatMap((marketplace) =>
          marketplace.plugins.filter(isPluginInstalled).map((plugin) =>
            pluginEntryId({
              marketplaceId: plugin.marketplaceId,
              pluginName: plugin.name,
            }),
          ),
        ),
      );
    },
    catalogAvailability: async () => {
      const { entries } = await getActiveDesktopRuntime().query(
        'core.catalog.snapshot.get',
        {
          scope: {},
          kinds: ['collection', 'skill', 'plugin', 'mcp_server'],
          includeUnavailable: true,
        },
        { caller: caller('core.catalog.read') },
      );
      return new Map(
        entries.map((entry) => [entry.entryId, entry.availability]),
      );
    },
    replaceGlobalSelections: async (entryIds, expectedRevision) => {
      try {
        await getActiveDesktopRuntime().instruction(
          'core.catalog.selection.update',
          {
            scope: {},
            expectedRevision,
            selectedItemIds: [...entryIds],
            _meta: { idempotencyKey: options.idempotencyKey },
          },
          keyed,
        );
        return 'applied';
      } catch (error) {
        if (
          error instanceof CanopyOperationError &&
          error.payload.code === 'core.catalog.selection.revisionConflict'
        )
          return 'conflict';
        throw error;
      }
    },
    activeOwner: () => {
      const context = getWorkspaceScopingContext();
      return context?.kind === 'organization'
        ? { kind: 'organization', organizationId: context.organizationId }
        : context
          ? { kind: 'personal' }
          : undefined;
    },
  };
}

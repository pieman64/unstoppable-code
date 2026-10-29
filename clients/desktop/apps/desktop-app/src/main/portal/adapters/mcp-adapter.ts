import type {
  ChatTabPluginSelections,
  PersistedChatTab,
  PortalEntityEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  chatInheritsProjectDefaults,
  chatSurfaceUsesGlobalPluginDefaults,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import {
  type PortalMcpServerEntity,
  worktreeScopedParentLocalId,
} from '@canopy/protocol/portal';
import { listDetectedMcpServersForSelections } from '../../plugins/mcp-inventory';
import { portalChatTabsCache } from '../../services/portal-chat-tabs-cache';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { resolveEffectiveChatPluginSelections } from '../../plugins/global-plugin-overlay';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal-event-bus';

interface PortalMcpProjectionTarget {
  workspaceLocalId: string;
  worktreeLocalId: string;
}

interface PortalMcpProjectionContext extends PortalMcpProjectionTarget {
  selections: ChatTabPluginSelections;
}

interface PortalMcpAdapterDependencies {
  listInventory?: (
    selections: ChatTabPluginSelections,
  ) => Promise<{ servers: DetectedMcpServerInfo[] }>;
  portalActive?: () => boolean;
  emit?: (event: PortalEventEnvelope) => void;
}

const fingerprints = new Map<string, string>();
const emittedLocalIds = new Map<string, string[]>();
const projectionContexts = new Map<string, PortalMcpProjectionContext>();
const EMPTY_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
};

function projectionKey(target: PortalMcpProjectionTarget): string {
  return [target.workspaceLocalId, target.worktreeLocalId].join('\u0000');
}

export function projectPortalMcpServerEntities(
  target: PortalMcpProjectionTarget,
  servers: readonly DetectedMcpServerInfo[],
): PortalMcpServerEntity[] {
  const entities = servers.map(
    (server): PortalMcpServerEntity => ({
      localId: server.key,
      workspaceLocalId: target.workspaceLocalId,
      worktreeLocalId: target.worktreeLocalId,
      serverName: server.serverName,
      displayName: server.displayName,
      source: server.source,
      type: server.type,
      enabled: server.enabled,
      authStatus: server.authStatus,
      ...(server.canRefresh ? { canRefresh: true } : {}),
      // The inventory's error label can embed OAuth callback/token-exchange
      // diagnostics (auth.lastError); redact to a stable string so provider
      // controlled or sensitive error text never reaches portal state.
      // Non-error labels are static strings in mcp-inventory's
      // authStatusLabel()/command branch — a test pins that lastError only
      // flows into the error branch.
      authStatusLabel:
        server.authStatus === 'error'
          ? 'Authentication error'
          : server.authStatusLabel,
      ...(server.serverId === undefined ? {} : { serverId: server.serverId }),
      ...(server.configId === undefined ? {} : { configId: server.configId }),
      ...(server.configName === undefined
        ? {}
        : { configName: server.configName }),
      ...(server.collectionId === undefined
        ? {}
        : { collectionId: server.collectionId }),
      ...(server.bundleId === undefined ? {} : { bundleId: server.bundleId }),
      ...(server.marketplaceId === undefined
        ? {}
        : { marketplaceId: server.marketplaceId }),
      ...(server.pluginName === undefined
        ? {}
        : { pluginName: server.pluginName }),
      ...(server.pluginServerName === undefined
        ? {}
        : { pluginServerName: server.pluginServerName }),
    }),
  );
  // Deterministic order: the inventory is Map-iteration ordered, which can
  // shuffle with selection-array order; sorting keeps fingerprints stable so
  // unchanged sets never re-emit.
  return entities.sort((a, b) => a.localId.localeCompare(b.localId));
}

export function portalMcpServerEntityEnvelope(
  entity: PortalMcpServerEntity,
): PortalEntityEnvelope {
  return {
    entityType: 'mcp_server',
    localId: entity.localId,
    parentLocalId: worktreeScopedParentLocalId(
      entity.workspaceLocalId,
      entity.worktreeLocalId,
    ),
    payload: entity,
  };
}

export async function emitPortalMcpServerProjection(
  context: PortalMcpProjectionContext,
  dependencies: PortalMcpAdapterDependencies = {},
): Promise<void> {
  const portalActive = (): boolean =>
    dependencies.portalActive?.() ?? isCanopyPortalActive();
  if (!portalActive()) {
    return;
  }

  const key = projectionKey(context);
  projectionContexts.set(key, context);
  const listInventory =
    dependencies.listInventory ?? listDetectedMcpServersForSelections;
  const entities = projectPortalMcpServerEntities(
    context,
    (await listInventory(context.selections)).servers,
  );
  const fingerprint = JSON.stringify(entities);
  if (fingerprints.get(key) === fingerprint) {
    return;
  }
  const previousLocalIds = emittedLocalIds.get(key) ?? [];
  if (entities.length === 0 && previousLocalIds.length === 0) {
    // Nothing to upsert and nothing previously emitted to remove.
    fingerprints.set(key, fingerprint);
    return;
  }

  const nextLocalIds = entities.map((entity) => entity.localId);
  const nextLocalIdSet = new Set(nextLocalIds);
  const removed: Array<{
    entityType: 'mcp_server';
    localId: string;
    parentLocalId: string;
  }> = previousLocalIds
    .filter((localId) => !nextLocalIdSet.has(localId))
    .map((localId) => ({
      entityType: 'mcp_server',
      localId,
      parentLocalId: worktreeScopedParentLocalId(
        context.workspaceLocalId,
        context.worktreeLocalId,
      ),
    }));
  fingerprints.set(key, fingerprint);
  emittedLocalIds.set(key, nextLocalIds);

  const event = createPortalEvent('portal.state.delta', {
    scope: 'worktree',
    target: {
      workspaceLocalId: context.workspaceLocalId,
      worktreeLocalId: context.worktreeLocalId,
    },
    entities: entities.map(portalMcpServerEntityEnvelope),
    ...(removed.length === 0 ? {} : { removed }),
    generatedAt: new Date().toISOString(),
  });
  if (dependencies.emit) {
    dependencies.emit(event);
  } else {
    enqueuePortalEvent(event);
  }
}

/**
 * The active chat's effective selections: its own plus the project and
 * global defaults it inherits, minus the ones it turned off. A chat written
 * before live project defaults inherits no project layer, as on its turns.
 */
function effectiveActiveChatSelections(
  target: PortalMcpProjectionTarget,
  chat: Pick<
    PersistedChatTab,
    | 'id'
    | 'pluginSelections'
    | 'disabledGlobalPluginSelections'
    | 'inheritedPluginDefaultsVersion'
  >,
): Promise<ChatTabPluginSelections> {
  return resolveEffectiveChatPluginSelections(
    chat.pluginSelections,
    {
      projectId: target.workspaceLocalId,
      worktreeId: target.worktreeLocalId,
      chatId: chat.id,
    },
    chatSurfaceUsesGlobalPluginDefaults(target.workspaceLocalId) && {
      chatTombstones: chat.disabledGlobalPluginSelections ?? {},
      inheritsProjectDefaults: chatInheritsProjectDefaults(chat),
    },
  );
}

async function workspaceDefaultSelections(
  target: PortalMcpProjectionTarget,
): Promise<ChatTabPluginSelections | undefined> {
  const sidebar = await readAllSidebarItems();
  return sidebar.items.find((item) => item.id === target.workspaceLocalId)
    ?.defaultPluginSelections;
}

async function resolveProjectionContext(
  target: PortalMcpProjectionTarget,
): Promise<PortalMcpProjectionContext | null> {
  const tabsFile = await portalChatTabsCache.read(
    target.workspaceLocalId,
    target.worktreeLocalId,
  );
  const activeTab = tabsFile.tabs.find(
    (tab) => tab.id === tabsFile.activeTabId && (tab.kind ?? 'chat') === 'chat',
  );
  if (activeTab) {
    return {
      ...target,
      selections: await effectiveActiveChatSelections(target, activeTab),
    };
  }
  const defaults = await workspaceDefaultSelections(target);
  return defaults ? { ...target, selections: defaults } : null;
}

export async function listPortalMcpServerEntitiesForWorktree(
  target: PortalMcpProjectionTarget,
): Promise<PortalEntityEnvelope[]> {
  const context = await resolveProjectionContext(target);
  const emptyKey = projectionKey(target);
  if (!context) {
    // The snapshot is the portal's new baseline: with no resolvable context
    // it contains no MCP entities, so drop any stale cache for the worktree
    // rather than letting a later delta diff against a dead baseline.
    projectionContexts.delete(emptyKey);
    fingerprints.delete(emptyKey);
    emittedLocalIds.delete(emptyKey);
    return [];
  }
  const key = emptyKey;
  projectionContexts.set(key, context);
  const inventory = await listDetectedMcpServersForSelections(
    context.selections,
  );
  const entities = projectPortalMcpServerEntities(target, inventory.servers);
  // Seed the delta cache: the snapshot is the portal's baseline, so the next
  // live delta must diff removals against it rather than an empty set.
  fingerprints.set(key, JSON.stringify(entities));
  emittedLocalIds.set(
    key,
    entities.map((entity) => entity.localId),
  );
  return entities.map(portalMcpServerEntityEnvelope);
}

export async function projectWorktreeMcpServersForChat(
  target: PortalMcpProjectionTarget,
  activeChat:
    | Pick<
        PersistedChatTab,
        | 'id'
        | 'pluginSelections'
        | 'disabledGlobalPluginSelections'
        | 'inheritedPluginDefaultsVersion'
      >
    | undefined,
): Promise<void> {
  if (!isCanopyPortalActive()) {
    return;
  }
  await emitPortalMcpServerProjection({
    ...target,
    selections: activeChat
      ? await effectiveActiveChatSelections(target, activeChat)
      : ((await workspaceDefaultSelections(target)) ?? EMPTY_SELECTIONS),
  });
}

export async function refreshProjectedPortalMcpServers(): Promise<void> {
  if (!isCanopyPortalActive()) {
    return;
  }
  await Promise.all(
    Array.from(projectionContexts.values()).map((context) =>
      emitPortalMcpServerProjection(context),
    ),
  );
}

export function clearPortalMcpServerFingerprints(): void {
  fingerprints.clear();
  emittedLocalIds.clear();
  projectionContexts.clear();
}

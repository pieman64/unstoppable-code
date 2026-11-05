import { ResourceContextUnavailableError } from '../../lib/resource-context-error';
import { createPortalCollectionWriteGuard } from '../../services/portal-collection-authorization';
/**
 * Portal adapters for the Plugins-section commands
 * (design: docs/planning/2026-08-27-portal-plugins-section/design.md).
 *
 * READ commands (PR 3): each handler validates the payload with the shared
 * validation helpers, lazy-imports the catalog service, and completes the
 * command with the browser-safe result. The underlying service reads ONLY the
 * desktop's cached inventory — no CLI execution, no marketplace refresh, no
 * MCP health checks or OAuth — and redacts every credential before the result
 * leaves the desktop.
 *
 * MUTATION commands (phase B): the long-running ones (installs, marketplace
 * add/update/remove) complete OFF the serial command loop via
 * {@link completeOffLoop} — see its doc for why — while the fast MCP toggle
 * completes inline. All results reuse the same reduced projections as the
 * read commands.
 */
import {
  PORTAL_CATALOG_RESULT_MAX_BYTES,
  type PortalCollectionsApplyUpdateResult,
} from '@canopy/protocol/portal';
import {
  applyCollectionUpdate,
  CollectionUpdateError,
} from '../../collections/collection-mutations';
import type { PortalShareScope } from '@canopy/protocol/portal';
import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import type { PluginProvider } from '@canopy/desktop-shared/types/plugins';
import type { PortalAdapterContext } from './types';
import { completePortalShareOffLoop } from './share-result';
import { failServiceError, isRecord } from './validation';
import { notifyDesktopInventoryChanged } from '../../services/desktop-inventory-sync-signals';

function requireStringField(
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

function requireShareScope(
  payload: Record<string, unknown>,
): PortalShareScope | null {
  const value = payload['scope'];
  return value === 'private' ||
    value === 'team' ||
    value === 'organization' ||
    value === 'public'
    ? value
    : null;
}

function requireProjectPayload(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  label: string,
): Record<string, unknown> | null {
  if (
    !isRecord(command.payload) ||
    requireStringField(command.payload, 'projectId') === null
  ) {
    context.fail(command, 'invalid_payload', `${label} requires a projectId.`);
    return null;
  }
  return command.payload;
}

export async function handlePortalPluginsListMarketplaces(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.plugins.list_marketplaces']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!requireProjectPayload(command, context, 'Marketplace list request')) {
    return;
  }
  try {
    const { listPortalMarketplaces } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await listPortalMarketplaces());
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPluginsGetPluginDetail(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.plugins.get_plugin_detail']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireProjectPayload(
    command,
    context,
    'Plugin detail request',
  );
  if (!payload) {
    return;
  }
  const marketplaceId = requireStringField(payload, 'marketplaceId');
  const pluginName = requireStringField(payload, 'pluginName');
  if (marketplaceId === null || pluginName === null) {
    context.fail(
      command,
      'invalid_payload',
      'Plugin detail request requires marketplaceId and pluginName.',
    );
    return;
  }
  try {
    const { getPortalPluginDetail } =
      await import('../../services/plugin-catalog-service');
    context.complete(
      command,
      await getPortalPluginDetail(marketplaceId, pluginName),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPluginsReadComponentContent(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.plugins.read_component_content']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireProjectPayload(
    command,
    context,
    'Component content request',
  );
  if (!payload) {
    return;
  }
  const marketplaceId = requireStringField(payload, 'marketplaceId');
  const pluginName = requireStringField(payload, 'pluginName');
  const componentType = requireStringField(payload, 'componentType');
  const componentFile = requireStringField(payload, 'componentFile');
  if (
    marketplaceId === null ||
    pluginName === null ||
    componentType === null ||
    componentFile === null
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Component content request requires marketplaceId, pluginName, componentType, and componentFile.',
    );
    return;
  }
  try {
    const { readPortalPluginComponent } =
      await import('../../services/plugin-catalog-service');
    context.complete(
      command,
      await readPortalPluginComponent(marketplaceId, pluginName, componentFile),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalSkillsList(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.skills.list']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!requireProjectPayload(command, context, 'Skill list request')) {
    return;
  }
  try {
    const { listPortalSkills } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await listPortalSkills());
    notifyDesktopInventoryChanged(['skills']);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalSkillsRead(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.skills.read']>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireProjectPayload(command, context, 'Skill read request');
  if (!payload) {
    return;
  }
  const sourceId = requireStringField(payload, 'sourceId');
  const skillName = requireStringField(payload, 'skillName');
  if (sourceId === null || skillName === null) {
    context.fail(
      command,
      'invalid_payload',
      'Skill read request requires sourceId and skillName.',
    );
    return;
  }
  try {
    const { readPortalSkill } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await readPortalSkill(sourceId, skillName));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalMcpListServers(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.mcp.list_servers']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!requireProjectPayload(command, context, 'MCP server list request')) {
    return;
  }
  try {
    const { listPortalMcpServers } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await listPortalMcpServers());
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalMcpGetServer(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.mcp.get_server']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireProjectPayload(
    command,
    context,
    'MCP server detail request',
  );
  if (!payload) {
    return;
  }
  const serverId = requireStringField(payload, 'serverId');
  if (serverId === null) {
    context.fail(
      command,
      'invalid_payload',
      'MCP server detail request requires a serverId.',
    );
    return;
  }
  try {
    const { getPortalMcpServer } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await getPortalMcpServer(serverId));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalCollectionsList(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.collections.list']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!requireProjectPayload(command, context, 'Collection list request')) {
    return;
  }
  try {
    const { listPortalCollections } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await listPortalCollections());
    notifyDesktopInventoryChanged(['collections']);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalCollectionsGet(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.collections.get']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireProjectPayload(
    command,
    context,
    'Collection detail request',
  );
  if (!payload) {
    return;
  }
  const collectionId = requireStringField(payload, 'collectionId');
  if (collectionId === null) {
    context.fail(
      command,
      'invalid_payload',
      'Collection detail request requires a collectionId.',
    );
    return;
  }
  try {
    const { getPortalCollection } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await getPortalCollection(collectionId));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

// ---------------------------------------------------------------------------
// Mutation commands (phase B)
// ---------------------------------------------------------------------------

function isPluginProviderValue(value: unknown): value is PluginProvider {
  return value === 'claude' || value === 'codex';
}

function requireProviders(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  payload: Record<string, unknown>,
  label: string,
): PluginProvider[] | null {
  const value = payload.providers;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isPluginProviderValue)
  ) {
    context.fail(
      command,
      'invalid_payload',
      `${label} requires a non-empty providers array of 'claude' | 'codex'.`,
    );
    return null;
  }
  return Array.from(new Set<PluginProvider>(value));
}

/**
 * Run a LONG mutation off the serial portal command loop.
 *
 * `applyPollResponse` awaits each command handler in sequence, so awaiting a
 * provider-CLI install (up to 60s per CLI call) or a marketplace-refresh-lock
 * wait inside the handler would stall EVERY subsequent portal command — chat
 * included — for the duration. Instead the handler validates synchronously,
 * detaches the operation, and returns; `complete`/`fail` fire when the
 * operation settles. This is transport-safe:
 *
 * - The adapter context's `complete`/`fail` enqueue onto the session outbox,
 *   and `enqueueEvent` schedules a flush on every enqueue, so a late terminal
 *   event still posts promptly.
 * - The loop persists the command as processed at hand-off, so a redelivery
 *   replays the (empty) persisted events instead of re-running the mutation —
 *   no double execution.
 * - If the operation outlives the 60s command TTL, the server's completion
 *   ingestion guards on non-terminal status (`updateMany` over
 *   QUEUED/DELIVERED), so completing an EXPIRED command is a harmless no-op
 *   server-side and the browser reconciles by refetching.
 */
function completeOffLoop<TResult>(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  operation: () => Promise<TResult>,
): void {
  void (async (): Promise<void> => {
    try {
      context.complete(command, await operation());
    } catch (error) {
      failServiceError(command, context, error);
    }
  })();
}

export function handlePortalPluginsInstallBuiltin(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.plugins.install_builtin']
  >,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Plugin install request',
  );
  if (!payload) {
    return;
  }
  const marketplaceId = requireStringField(payload, 'marketplaceId');
  const pluginName = requireStringField(payload, 'pluginName');
  if (marketplaceId === null || pluginName === null) {
    context.fail(
      command,
      'invalid_payload',
      'Plugin install request requires marketplaceId and pluginName.',
    );
    return;
  }
  const providers = requireProviders(
    command,
    context,
    payload,
    'Plugin install request',
  );
  if (providers === null) {
    return;
  }
  completeOffLoop(command, context, async () => {
    const { installPortalBuiltInPlugin } =
      await import('../../services/plugin-catalog-service');
    return installPortalBuiltInPlugin(marketplaceId, pluginName, providers);
  });
}

/**
 * `portal.plugins.share_plugin`: the browser names a marketplace plugin; the
 * desktop resolves its shareable source from local marketplace state, creates
 * the shared plugin in Canopy Cloud with the desktop's credentials, and
 * publishes the public share. A Cloud round trip, so it completes off-loop
 * like the install commands.
 */
export function handlePortalPluginsSharePlugin(
  // Untyped on purpose: the payload is narrowed field by field below, which
  // lets the registry and tests hand the envelope over without a cast.
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Plugin share request',
  );
  if (!payload) {
    return;
  }
  const marketplaceId = requireStringField(payload, 'marketplaceId');
  const pluginName = requireStringField(payload, 'pluginName');
  const scope = requireShareScope(payload);
  const teamId = requireStringField(payload, 'teamId');
  const organizationId = requireStringField(payload, 'organizationId');
  if (
    marketplaceId === null ||
    pluginName === null ||
    scope === null ||
    (scope === 'team' && teamId === null) ||
    (scope === 'organization' && organizationId === null)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Plugin share request requires marketplaceId, pluginName and a valid destination.',
    );
    return;
  }
  completePortalShareOffLoop(command, context, async () => {
    const { sharePortalPlugin } =
      await import('../../services/plugin-catalog-service');
    return sharePortalPlugin({
      marketplaceId,
      pluginName,
      scope,
      ...(teamId === null ? {} : { teamId }),
      ...(organizationId === null ? {} : { organizationId }),
    });
  });
}

/**
 * `portal.skills.share_skill`: the browser names an installed skill and a
 * scope; the desktop reads the skill's raw bytes and mints the share under its
 * own Cloud credentials. A Cloud round trip, so it completes off-loop.
 */
export function handlePortalSkillsShareSkill(
  // Untyped on purpose: the payload is narrowed field by field below, which
  // lets the registry and tests hand the envelope over without a cast.
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Skill share request',
  );
  if (!payload) {
    return;
  }
  const sourceId = requireStringField(payload, 'sourceId');
  const skillName = requireStringField(payload, 'skillName');
  const scope = requireShareScope(payload);
  if (sourceId === null || skillName === null || scope === null) {
    context.fail(
      command,
      'invalid_payload',
      'Skill share request requires sourceId, skillName and a valid scope.',
    );
    return;
  }
  const teamId = requireStringField(payload, 'teamId');
  const organizationId = requireStringField(payload, 'organizationId');
  // Fail closed rather than silently downgrading a group share to a private
  // copy the requester never asked for.
  if (
    (scope === 'team' && teamId === null) ||
    (scope === 'organization' && organizationId === null)
  ) {
    context.fail(
      command,
      'invalid_payload',
      scope === 'team'
        ? 'A team share requires teamId.'
        : 'An organization share requires organizationId.',
    );
    return;
  }
  completePortalShareOffLoop(command, context, async () => {
    const { sharePortalSkill } =
      await import('../../services/plugin-catalog-service');
    return sharePortalSkill({
      sourceId,
      skillName,
      scope,
      ...(teamId !== null ? { teamId } : {}),
      ...(organizationId !== null ? { organizationId } : {}),
    });
  });
}

/**
 * `portal.collections.share`: the browser names a Collection and a scope; the
 * desktop rebuilds its payload from local state (member refs, plus the raw
 * bytes of any custom skills it carries) and mints the share under its own
 * Cloud credentials.
 *
 * Public shares publish a pinned link after the underlying Collection is
 * created or updated; scoped shares keep the selected owner lane.
 */
export function handlePortalCollectionsShare(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Collection share request',
  );
  if (!payload) {
    return;
  }
  const collectionId = requireStringField(payload, 'collectionId');
  const scope = requireShareScope(payload);
  if (collectionId === null || scope === null) {
    context.fail(
      command,
      'invalid_payload',
      'Collection share request requires collectionId and a valid scope.',
    );
    return;
  }
  const teamId = requireStringField(payload, 'teamId');
  const organizationId = requireStringField(payload, 'organizationId');
  // Fail closed rather than silently downgrading a group share to a private
  // copy the requester never asked for.
  if (
    (scope === 'team' && teamId === null) ||
    (scope === 'organization' && organizationId === null)
  ) {
    context.fail(
      command,
      'invalid_payload',
      scope === 'team'
        ? 'A team share requires teamId.'
        : 'An organization share requires organizationId.',
    );
    return;
  }
  // Off-loop like the other shares: portal poll commands are serial, and a
  // Cloud round trip would otherwise stall every later command.
  completePortalShareOffLoop(command, context, async () => {
    const { sharePortalCollection } =
      await import('../../services/plugin-catalog-service');
    return sharePortalCollection({
      collectionId,
      scope,
      ...(teamId !== null ? { teamId } : {}),
      ...(organizationId !== null ? { organizationId } : {}),
    });
  });
}

/** `portal.sharing.account`: the DESKTOP's Cloud account state. */
export function handlePortalSharingAccount(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Sharing account request',
  );
  if (!payload) {
    return;
  }
  completeOffLoop(command, context, async () => {
    const { getPortalSharingAccount } =
      await import('../../services/plugin-catalog-service');
    return getPortalSharingAccount();
  });
}

/** Load the current Cloud audience for one local shareable resource. */
export function handlePortalSharingExistingShare(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Existing share request',
  );
  if (!payload) return;
  const resourceType = requireStringField(payload, 'resourceType');
  const projectId = requireStringField(payload, 'projectId');
  if (resourceType === 'skill') {
    const sourceId = requireStringField(payload, 'sourceId');
    const skillName = requireStringField(payload, 'skillName');
    if (sourceId === null || skillName === null) {
      context.fail(
        command,
        'invalid_payload',
        'Existing Skill share request requires sourceId and skillName.',
      );
      return;
    }
    completeOffLoop(command, context, async () => {
      const { getPortalExistingSkillShare } =
        await import('../../services/plugin-catalog-service');
      return {
        existingShare: await getPortalExistingSkillShare({
          sourceId,
          skillName,
        }),
      };
    });
    return;
  }
  if (resourceType === 'plugin') {
    const marketplaceId = requireStringField(payload, 'marketplaceId');
    const pluginName = requireStringField(payload, 'pluginName');
    if (marketplaceId === null || pluginName === null) {
      context.fail(
        command,
        'invalid_payload',
        'Existing plugin share request requires marketplaceId and pluginName.',
      );
      return;
    }
    completeOffLoop(command, context, async () => {
      const { getPortalExistingPluginShare } =
        await import('../../services/plugin-catalog-service');
      return {
        existingShare: await getPortalExistingPluginShare({
          marketplaceId,
          pluginName,
        }),
      };
    });
    return;
  }
  if (resourceType === 'collection') {
    const collectionId = requireStringField(payload, 'collectionId');
    if (collectionId === null) {
      context.fail(
        command,
        'invalid_payload',
        'Existing Collection share request requires collectionId.',
      );
      return;
    }
    completeOffLoop(command, context, async () => {
      const { getPortalExistingCollectionShare } =
        await import('../../services/plugin-catalog-service');
      return {
        existingShare: await getPortalExistingCollectionShare(collectionId),
      };
    });
    return;
  }
  if (resourceType === 'pipeline' && projectId !== null) {
    const pipelineId = requireStringField(payload, 'pipelineId');
    const worktreeId = requireStringField(payload, 'worktreeId');
    if (pipelineId === null) {
      context.fail(
        command,
        'invalid_payload',
        'Existing Pipeline share request requires pipelineId.',
      );
      return;
    }
    completeOffLoop(command, context, async () => {
      const { getPortalExistingPipelineShare } =
        await import('../../services/pipelines-service');
      return {
        existingShare: await getPortalExistingPipelineShare({
          projectId,
          pipelineId,
          ...(worktreeId !== null ? { worktreeId } : {}),
        }),
      };
    });
    return;
  }
  context.fail(
    command,
    'invalid_payload',
    'Existing share request requires a valid resourceType.',
  );
}

/** `portal.sharing.list_teams`: teams on the DESKTOP's Cloud account. */
export function handlePortalSharingListTeams(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(command, context, 'Team list request');
  if (!payload) {
    return;
  }
  const query = requireStringField(payload, 'query');
  completeOffLoop(command, context, async () => {
    const { listPortalShareTeams } =
      await import('../../services/plugin-catalog-service');
    return listPortalShareTeams(query ?? undefined);
  });
}

/** `portal.sharing.list_organizations`: the desktop account's organizations. */
export function handlePortalSharingListOrganizations(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Organization list request',
  );
  if (!payload) {
    return;
  }
  const query = requireStringField(payload, 'query');
  completeOffLoop(command, context, async () => {
    const { listPortalShareOrganizations } =
      await import('../../services/plugin-catalog-service');
    return listPortalShareOrganizations(query ?? undefined);
  });
}

export function handlePortalPluginsInstallExternal(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.plugins.install_external']
  >,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Plugin install request',
  );
  if (!payload) {
    return;
  }
  const marketplaceId = requireStringField(payload, 'marketplaceId');
  const pluginName = requireStringField(payload, 'pluginName');
  if (marketplaceId === null || pluginName === null) {
    context.fail(
      command,
      'invalid_payload',
      'Plugin install request requires marketplaceId and pluginName.',
    );
    return;
  }
  completeOffLoop(command, context, async () => {
    const { installPortalExternalPlugin } =
      await import('../../services/plugin-catalog-service');
    return installPortalExternalPlugin(marketplaceId, pluginName);
  });
}

export function handlePortalMarketplaceAdd(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.marketplace.add']
  >,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Marketplace add request',
  );
  if (!payload) {
    return;
  }
  const repo = requireStringField(payload, 'repo');
  if (repo === null) {
    context.fail(
      command,
      'invalid_payload',
      'Marketplace add request requires a repo.',
    );
    return;
  }
  completeOffLoop(command, context, async () => {
    const { addPortalMarketplace } =
      await import('../../services/plugin-catalog-service');
    return addPortalMarketplace(repo);
  });
}

export function handlePortalMarketplaceUpdate(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.marketplace.update']
  >,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Marketplace update request',
  );
  if (!payload) {
    return;
  }
  const marketplaceId = requireStringField(payload, 'marketplaceId');
  if (marketplaceId === null) {
    context.fail(
      command,
      'invalid_payload',
      'Marketplace update request requires a marketplaceId.',
    );
    return;
  }
  completeOffLoop(command, context, async () => {
    const { updatePortalMarketplace } =
      await import('../../services/plugin-catalog-service');
    return updatePortalMarketplace(marketplaceId);
  });
}

export function handlePortalMarketplaceRemove(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.marketplace.remove']
  >,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Marketplace remove request',
  );
  if (!payload) {
    return;
  }
  const marketplaceId = requireStringField(payload, 'marketplaceId');
  if (marketplaceId === null) {
    context.fail(
      command,
      'invalid_payload',
      'Marketplace remove request requires a marketplaceId.',
    );
    return;
  }
  let providers: PluginProvider[] | undefined;
  if (payload.providers !== undefined) {
    const validated = requireProviders(
      command,
      context,
      payload,
      'Marketplace remove request',
    );
    if (validated === null) {
      return;
    }
    providers = validated;
  }
  completeOffLoop(command, context, async () => {
    const { removePortalMarketplace } =
      await import('../../services/plugin-catalog-service');
    return removePortalMarketplace(marketplaceId, providers);
  });
}

export async function handlePortalMarketplaceRefreshAll(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.marketplace.refresh_all']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!requireProjectPayload(command, context, 'Marketplace refresh request')) {
    return;
  }
  try {
    const { startPortalMarketplacesRefresh } =
      await import('../../services/plugin-catalog-service');
    // FIRE-AND-FORGET: the fan-out refresh routinely takes minutes — far past
    // the 60s command TTL — so the command completes as soon as the refresh
    // has been kicked off and the browser reconciles with a later refetch.
    await startPortalMarketplacesRefresh();
    context.complete(command, { started: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalMcpSetConfigEnabled(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.mcp.set_config_enabled']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireProjectPayload(
    command,
    context,
    'MCP config toggle request',
  );
  if (!payload) {
    return;
  }
  const serverId = requireStringField(payload, 'serverId');
  const configId = requireStringField(payload, 'configId');
  const enabled = payload.enabled;
  if (serverId === null || configId === null || typeof enabled !== 'boolean') {
    context.fail(
      command,
      'invalid_payload',
      'MCP config toggle request requires serverId, configId, and a boolean enabled.',
    );
    return;
  }
  // Small-RPC: a fast local fs write, completed inline on the loop.
  try {
    const { setPortalMcpConfigEnabled } =
      await import('../../services/plugin-catalog-service');
    context.complete(
      command,
      await setPortalMcpConfigEnabled(serverId, configId, enabled),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/** Untrusted payload; `requireProjectPayload` and the service validate it. */
export async function handlePortalCollectionsSave(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireProjectPayload(
    command,
    context,
    'Collection save request',
  );
  if (!payload) {
    return;
  }
  if (
    typeof payload.projectId !== 'string' ||
    !payload.projectId.trim() ||
    (command.target?.workspaceLocalId !== undefined &&
      command.target.workspaceLocalId !== payload.projectId)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Collection save requires a matching project.',
    );
    return;
  }
  const collection = payload.collection;
  if (!isRecord(collection) || typeof collection.name !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'Collection save request requires a collection with a name.',
    );
    return;
  }
  // Small-RPC: a fast local fs write, completed inline on the loop. The
  // service validates members and keeps stored share links; the store
  // announces the inventory change.
  try {
    const assertCurrent = await createPortalCollectionWriteGuard(
      payload.projectId,
      context.canMutateResources,
    );
    await assertCurrent();
    const { savePortalCollection } =
      await import('../../services/plugin-catalog-service');
    context.complete(
      command,
      await savePortalCollection(collection, assertCurrent),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/** Imports run off the serial loop; the original session guards every effect. */
export function handlePortalCollectionsApplyUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireProjectPayload(
    command,
    context,
    'Collection update request',
  );
  if (!payload) return;
  const projectId = requireStringField(payload, 'projectId');
  const collectionId = requireStringField(payload, 'collectionId');
  const expectedRevision = requireStringField(payload, 'expectedRevision');
  if (
    !projectId ||
    !collectionId ||
    !expectedRevision ||
    !/^[a-f0-9-]+$/.test(collectionId) ||
    expectedRevision.length > 256 ||
    (command.target?.workspaceLocalId !== undefined &&
      command.target.workspaceLocalId !== projectId)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Collection update requires a matching project, collection and revision.',
    );
    return;
  }
  completeOffLoop(
    command,
    context,
    async (): Promise<PortalCollectionsApplyUpdateResult> => {
      try {
        const assertCurrent = await createPortalCollectionWriteGuard(
          projectId,
          context.canMutateResources,
        );
        await assertCurrent();
        const update = await applyCollectionUpdate(
          { collectionId, expectedRevision },
          undefined,
          {
            key: JSON.stringify([context.sessionId, projectId]),
            assertCurrent,
            validatePrepared: (collection): void => {
              if (
                Buffer.byteLength(JSON.stringify({ collection }), 'utf8') >
                PORTAL_CATALOG_RESULT_MAX_BYTES - 8192
              )
                throw new CollectionUpdateError(
                  'invalid_payload',
                  'This collection is too large to update here.',
                );
            },
          },
        );
        return { success: true, update };
      } catch (error) {
        // Provider/filesystem errors can contain host paths. Keep the wire message
        // controlled while preserving typed refusals and already-attempted effects.
        const code =
          error instanceof ResourceContextUnavailableError
            ? 'permission_denied'
            : error instanceof Error &&
                'code' in error &&
                (error.code === 'invalid_payload' ||
                  error.code === 'permission_denied' ||
                  error.code === 'not_found' ||
                  error.code === 'conflict')
              ? error.code
              : 'execution_failed';
        const messages = {
          invalid_payload: 'This collection cannot be updated here.',
          permission_denied:
            'The session or collection is no longer authorized. Reconnect and refresh.',
          not_found: 'The collection is no longer available. Refresh the list.',
          conflict: 'The collection changed. Refresh it before updating again.',
          execution_failed:
            'The collection could not be updated. Refresh the inventory before trying again.',
        };
        return {
          success: false,
          code,
          message: messages[code],
          partialResourceEffects:
            error instanceof CollectionUpdateError
              ? error.partialResourceEffects
              : [],
        };
      }
    },
  );
}

/** Both operations use the authenticated Portal command path, never renderer IPC. */
function requireMcpManagementPayload(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): { serverId: string; configId?: string } | undefined {
  const payload = requireProjectPayload(
    command,
    context,
    'MCP management request',
  );
  if (!payload) return undefined;
  const serverId = requireStringField(payload, 'serverId');
  if (
    !serverId ||
    (payload.configId !== undefined &&
      (typeof payload.configId !== 'string' ||
        payload.configId.length === 0)) ||
    (command.target?.workspaceLocalId !== undefined &&
      command.target.workspaceLocalId !== payload.projectId)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'MCP management requires a server and matching project/configuration.',
    );
    return undefined;
  }
  return {
    serverId,
    ...(typeof payload.configId === 'string'
      ? { configId: payload.configId }
      : {}),
  };
}

export function handlePortalMcpTestConnection(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void {
  const payload = requireMcpManagementPayload(command, context);
  if (!payload) return;
  // Probing can outlive one poll; it must not stall chat commands behind it.
  completeOffLoop(command, context, async () => {
    const { testPortalMcpConnection } =
      await import('../../services/plugin-catalog-service');
    return testPortalMcpConnection(payload.serverId, payload.configId);
  });
}

export async function handlePortalMcpDeleteServer(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = requireMcpManagementPayload(command, context);
  if (!payload) return;
  try {
    const { deletePortalMcpServer } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await deletePortalMcpServer(payload.serverId));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

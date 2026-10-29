import {
  isAgentModel,
  resolveAgentModelDefinition,
  type ChatModel,
  type ChatTabPluginSelections,
  type McpHttpAuthPreference,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';

/**
 * Union two `ChatTabPluginSelections` value sets. Items from `incoming` that
 * are not already present in `base` are appended; nothing is removed.
 *
 * Used by the chat plugins modal when the user applies a `canopy.json`
 * recommendation: the response carries the workspace's freshly persisted
 * defaults, and the user expects the applied plugin to appear selected in
 * this chat without losing any chat-specific selections they had already
 * staged in the modal.
 *
 * MCP HTTP auth preferences are intentionally preserved from `base` only —
 * recommendations never touch these per-server overrides.
 */
export function mergeChatPluginSelections(
  base: ChatTabPluginSelections,
  incoming: ChatTabPluginSelections,
): ChatTabPluginSelections {
  const normalizedBase = normalizePluginSelections(base);
  const normalizedIncoming = normalizePluginSelections(incoming);
  // Ids routinely contain the separator (`demo/market`), so escape each
  // segment: `demo` + `market/x` must not collide with `demo/market` + `x`.
  const join = (left: string, right: string): string =>
    `${encodeURIComponent(left)}/${encodeURIComponent(right)}`;
  const skillKey = (r: { sourceId: string; skillName: string }): string =>
    join(r.sourceId, r.skillName);
  const pluginKey = (r: {
    marketplaceId: string;
    pluginName: string;
  }): string => join(r.marketplaceId, r.pluginName);
  const mcpKey = (r: { serverId: string; configId: string }): string =>
    join(r.serverId, r.configId);

  const collectionIds = unionBy(
    normalizedBase.collectionIds,
    normalizedIncoming.collectionIds,
    (id) => id,
  );
  const skillRefs = unionBy(
    normalizedBase.skillRefs,
    normalizedIncoming.skillRefs,
    skillKey,
  );
  const pluginRefs = unionBy(
    normalizedBase.pluginRefs,
    normalizedIncoming.pluginRefs,
    pluginKey,
  );
  const mcpServerRefs = unionBy(
    normalizedBase.mcpServerRefs ?? [],
    normalizedIncoming.mcpServerRefs ?? [],
    mcpKey,
  );

  const mcpHttpAuthPreferences: McpHttpAuthPreference[] | undefined =
    normalizedBase.mcpHttpAuthPreferences;

  const merged: ChatTabPluginSelections = {
    collectionIds,
    skillRefs,
    pluginRefs,
  };
  if (mcpServerRefs.length > 0) {
    merged.mcpServerRefs = mcpServerRefs;
  }
  if (mcpHttpAuthPreferences && mcpHttpAuthPreferences.length > 0) {
    merged.mcpHttpAuthPreferences = mcpHttpAuthPreferences;
  }
  return merged;
}

/**
 * Merge an Agent's configured selections into a chat tab's own persisted
 * selections without rewriting the tab-owned values.
 */
export function mergeAgentChatPluginSelections(
  base: ChatTabPluginSelections | undefined,
  agentSelections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  if (!agentSelections) {
    return base;
  }
  return mergeChatPluginSelections(
    normalizePluginSelections(base),
    normalizePluginSelections(agentSelections),
  );
}

/**
 * Resolve the plugin selections that are effectively enabled for a chat model.
 * Custom Agents contribute their configured selections additively without
 * rewriting the chat tab's own persisted selections.
 */
export function resolveAgentChatPluginSelections(
  model: ChatModel | undefined,
  base: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  if (!isAgentModel(model)) {
    return base;
  }
  return mergeAgentChatPluginSelections(
    base,
    resolveAgentModelDefinition(model)?.pluginSelections,
  );
}

/**
 * Remove selections that are inherited exclusively from the current Agent
 * before persisting the chat tab's editable selections. Values already owned
 * by the tab remain persisted even when the Agent also provides them.
 */
export function stripAgentOnlyChatPluginSelections(
  selections: ChatTabPluginSelections,
  agentSelections: ChatTabPluginSelections | undefined,
  originalTabSelections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  const normalized = normalizePluginSelections(selections);
  const agent = normalizePluginSelections(agentSelections);
  const originalTab = normalizePluginSelections(originalTabSelections);

  const agentOnlyCollectionIds = differenceKeys(
    agent.collectionIds,
    originalTab.collectionIds,
    (id) => id,
  );
  const agentOnlySkillRefs = differenceKeys(
    agent.skillRefs,
    originalTab.skillRefs,
    (ref) => `${ref.sourceId}/${ref.skillName}`,
  );
  const agentOnlyPluginRefs = differenceKeys(
    agent.pluginRefs,
    originalTab.pluginRefs,
    (ref) => `${ref.marketplaceId}/${ref.pluginName}`,
  );
  const agentOnlyMcpServerRefs = differenceKeys(
    agent.mcpServerRefs ?? [],
    originalTab.mcpServerRefs ?? [],
    (ref) => `${ref.serverId}/${ref.configId}`,
  );

  const result: ChatTabPluginSelections = {
    collectionIds: normalized.collectionIds.filter(
      (id) => !agentOnlyCollectionIds.has(id),
    ),
    skillRefs: normalized.skillRefs.filter(
      (ref) => !agentOnlySkillRefs.has(`${ref.sourceId}/${ref.skillName}`),
    ),
    pluginRefs: normalized.pluginRefs.filter(
      (ref) =>
        !agentOnlyPluginRefs.has(`${ref.marketplaceId}/${ref.pluginName}`),
    ),
  };
  const mcpServerRefs = (normalized.mcpServerRefs ?? []).filter(
    (ref) => !agentOnlyMcpServerRefs.has(`${ref.serverId}/${ref.configId}`),
  );
  if (mcpServerRefs.length > 0) {
    result.mcpServerRefs = mcpServerRefs;
  }
  if (
    normalized.mcpHttpAuthPreferences &&
    normalized.mcpHttpAuthPreferences.length > 0
  ) {
    result.mcpHttpAuthPreferences = normalized.mcpHttpAuthPreferences;
  }
  return result;
}

function differenceKeys<T>(
  values: T[],
  excluded: T[],
  key: (item: T) => string,
): Set<string> {
  const excludedKeys = new Set(excluded.map(key));
  return new Set(values.map(key).filter((value) => !excludedKeys.has(value)));
}

function unionBy<T>(base: T[], incoming: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>(base.map(key));
  const result = [...base];
  for (const item of incoming) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(item);
  }
  return result;
}

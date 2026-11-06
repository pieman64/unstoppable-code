import {
  isAgentModel,
  resolveAgentModelDefinition,
  type ChatModel,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { mergeChatPluginSelections } from '@canopy/desktop-shared/lib/chat-plugin-selections-merge';

export { mergeChatPluginSelections } from '@canopy/desktop-shared/lib/chat-plugin-selections-merge';

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

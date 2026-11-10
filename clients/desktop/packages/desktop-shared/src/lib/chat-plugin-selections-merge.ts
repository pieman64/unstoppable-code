import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type ChatTabPluginSelections,
  type DeferredToolsReloadAdditions,
  type McpHttpAuthPreference,
} from '../types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { withRequiredPipelineEditorSkill } from './pipeline-editor-tools';

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
 * Additively merge a deferred-tools reload's additions into a chat's current
 * selections (nothing is removed; MCP HTTP auth preferences come from `base`),
 * then apply the pipeline editor's required skill for that chat.
 */
export function mergeDeferredToolsReloadAdditions(
  base: ChatTabPluginSelections | undefined,
  additions: DeferredToolsReloadAdditions,
  target: { projectId: string; worktreeId: string },
): ChatTabPluginSelections {
  const merged = mergeChatPluginSelections(
    base ?? {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    {
      collectionIds: [],
      skillRefs: additions.skillRefs,
      pluginRefs: additions.pluginRefs,
      mcpServerRefs: additions.mcpServerRefs,
    },
  );
  if (
    target.projectId === PIPELINE_EDITOR_PROJECT_ID &&
    target.worktreeId === PIPELINE_EDITOR_WORKTREE_ID
  )
    return withRequiredPipelineEditorSkill(merged);
  return merged;
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

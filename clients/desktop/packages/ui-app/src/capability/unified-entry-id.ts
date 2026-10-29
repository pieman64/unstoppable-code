import {
  localAgentEntryId,
  type UnifiedEntryRef,
} from '@canopy/protocol/unified-entry';

/**
 * The `UnifiedPluginEntry.id` the Plugins inventory gives the entry `ref`
 * names, mirroring the entry builders. `null` when the ref alone cannot name
 * one entry (an account MCP server needs its configuration).
 */
export function unifiedEntryIdForRef(ref: UnifiedEntryRef): string | null {
  switch (ref.type) {
    case 'public-share':
      return `public-share:${ref.shareKind}:${ref.externalId}`;
    case 'curated-plugin':
      return `curated:${ref.key}`;
    case 'curated-pipeline':
      return `pipeline:curated:${ref.key}`;
    case 'marketplace-plugin':
      return `mkt:${ref.marketplaceId}/${ref.pluginName}`;
    case 'curated-mcp':
      return `mcp-catalog:${ref.key}`;
    case 'local-mcp':
      return ref.configId === undefined
        ? `mcp-local:${ref.serverId}`
        : `mcp-local:${ref.serverId}/${ref.configId}`;
    case 'mcp-server':
      return `mcp-local:${ref.serverId}/${ref.configId}`;
    case 'skill':
      return `skill:${ref.sourceId}:${ref.skillName}`;
    case 'shared-skill':
      return `skill:shared:${ref.skillId}`;
    case 'pipeline':
      return `pipeline:${ref.source}:${ref.pipelineId}`;
    case 'local-collection':
      return `collection:local:${ref.collectionId}`;
    case 'shared-collection':
      return `collection:shared:${ref.collectionId}`;
    case 'local-agent':
      return localAgentEntryId(ref.agentId);
    case 'shared-agent':
      return `agent:shared:${ref.agentId}`;
    case 'shared-plugin':
      return `plugin:shared:${ref.pluginId}`;
    case 'shared-blueprint':
      return `blueprint:shared:${ref.blueprintId}`;
    case 'automation':
      return `automation:local:${ref.activityId}`;
    case 'shared-automation':
      return `automation:shared:${ref.automationId}`;
    case 'curated-automation':
      return `automation:curated:${ref.key}`;
    case 'provider-connector':
      return `provider-connector:${ref.displayName}`;
  }
}

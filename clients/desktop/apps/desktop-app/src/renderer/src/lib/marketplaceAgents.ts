import { describeAgentBaseModel } from '@canopy/protocol/agents';
import type { UnifiedLocalAgentInput } from '@canopy/protocol/unified-entry';
import {
  getAgentModelAvailability,
  getModelDisplayName,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { AgentDefinitionSummaryPlugin } from '@canopy/ui-shared/components';

/** Capabilities an agent selects: collections, skills, plugins and servers. */
export function agentPluginCount(agent: AgentModelDefinition): number {
  const selections = agent.pluginSelections;
  return (
    selections.collectionIds.length +
    selections.skillRefs.length +
    selections.pluginRefs.length +
    (selections.mcpServerRefs?.length ?? 0)
  );
}

/** The base model as the model pickers name it. */
export function agentBaseModelLabel(agent: AgentModelDefinition): string {
  return describeAgentBaseModel(agent.baseModel, getModelDisplayName);
}

/** Readable labels for the capabilities an agent selects. */
export function agentPluginLabels(
  agent: AgentModelDefinition,
): AgentDefinitionSummaryPlugin[] {
  const selections = agent.pluginSelections;
  return [
    ...selections.collectionIds.map((id) => ({
      key: `collection:${id}`,
      label: `Collection: ${id}`,
    })),
    ...selections.skillRefs.map((ref) => ({
      key: `skill:${ref.sourceId}:${ref.skillName}`,
      label: `Skill: ${ref.skillName}`,
    })),
    ...selections.pluginRefs.map((ref) => ({
      key: `plugin:${ref.marketplaceId}:${ref.pluginName}`,
      label: `Plugin: ${ref.pluginName}`,
    })),
    ...(selections.mcpServerRefs ?? []).map((ref) => ({
      key: `mcp:${ref.serverId}:${ref.configId}`,
      label: `MCP server: ${ref.serverId}`,
    })),
  ];
}

/**
 * The shared agent this local agent is a copy of, if any: the share it was
 * published as, or the share it was installed from.
 */
function sharedRemoteId(agent: AgentModelDefinition): string | undefined {
  return agent.remoteId ?? agent.importedFromRemoteId;
}

/** Instructions summarize an agent; the base model stands in when empty. */
function agentDescription(agent: AgentModelDefinition): string {
  const firstLine = agent.instructions
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  return firstLine ?? agentBaseModelLabel(agent);
}

/** Map local definitions onto the portable Marketplace inventory input. */
export function marketplaceLocalAgentInputs(
  agents: readonly AgentModelDefinition[],
): UnifiedLocalAgentInput[] {
  return agents.map((agent) => {
    const remoteId = sharedRemoteId(agent);
    return {
      id: agent.id,
      name: agent.name,
      description: agentDescription(agent),
      baseModelLabel: agentBaseModelLabel(agent),
      pluginCount: agentPluginCount(agent),
      updatedAt: agent.updatedAt,
      available: getAgentModelAvailability(agent.id).available,
      ...(remoteId ? { sharedRemoteId: remoteId } : {}),
    };
  });
}

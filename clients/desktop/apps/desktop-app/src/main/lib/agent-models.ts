import {
  agentResourceContextEnabled,
  agentContextSnapshot,
  assertAgentContextSnapshot,
} from '../agents/resource-lanes';
import { getWorkspaceContextService } from './workspace-context-service';
import { initAgentModels } from '@canopy/desktop-shared/types';
import type { AgentModelRegistryEntry } from '@canopy/execution-engine/types/agent-models';
import { listAgentModels } from '../agents/agent-model-store';

export async function loadAgentModelRegistryEntries(): Promise<
  AgentModelRegistryEntry[]
> {
  const agents = await listAgentModels();
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    baseModel: agent.baseModel,
    instructions: agent.instructions,
    pluginSelections: agent.pluginSelections,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    available: false,
  }));
}

let authorizedContext: string | undefined;

/** Synchronous preload snapshots may only reuse a main-authorized context. */
export function agentModelRegistryContextCurrent(): boolean {
  if (!agentResourceContextEnabled()) return true;
  const service = getWorkspaceContextService();
  const state = service.getState();
  return (
    authorizedContext ===
    JSON.stringify([service.accountEpoch(), state.revision, state.context])
  );
}

export async function refreshAgentModelsFromStore(): Promise<void> {
  if (!agentResourceContextEnabled()) {
    initAgentModels(await loadAgentModelRegistryEntries());
    authorizedContext = undefined;
    return;
  }
  const snapshot = await agentContextSnapshot();
  const entries = await loadAgentModelRegistryEntries();
  await assertAgentContextSnapshot(snapshot);
  initAgentModels(entries);
  authorizedContext = snapshot;
}

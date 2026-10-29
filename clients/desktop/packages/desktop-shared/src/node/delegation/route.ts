import type {
  AgentDelegationResult,
  PersistedAgentRouteSnapshot,
} from '@canopy/protocol/delegation';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import type { ResolvedAgentRouteSnapshot } from './types';

/** Detach host-owned snapshots from mutable registries before crossing awaits. */
export function retainAgentRoute(
  route: ResolvedAgentRouteSnapshot,
): ResolvedAgentRouteSnapshot {
  const publicRoute = projectAgentRoute(route);
  return Object.freeze({
    ...publicRoute,
    ...(route.authAccountKey !== undefined
      ? { authAccountKey: route.authAccountKey }
      : {}),
    agentOverlay: route.agentOverlay
      ? Object.freeze({
          agentDefinitionId: route.agentOverlay.agentDefinitionId,
          agentDefinitionRevision: route.agentOverlay.agentDefinitionRevision,
          agentDefinitionHash: route.agentOverlay.agentDefinitionHash,
          pluginProjectionHash: route.agentOverlay.pluginProjectionHash,
          ...(route.agentOverlay.systemPromptAppend !== undefined
            ? { systemPromptAppend: route.agentOverlay.systemPromptAppend }
            : {}),
          artifact: Object.freeze({
            artifactId: route.agentOverlay.artifact.artifactId,
            formatVersion: route.agentOverlay.artifact.formatVersion,
            manifestHash: route.agentOverlay.artifact.manifestHash,
          }),
        })
      : undefined,
    ...(route.capabilityOverlay
      ? {
          capabilityOverlay: Object.freeze({
            capabilityProjectionHash:
              route.capabilityOverlay.capabilityProjectionHash,
            artifact: Object.freeze({
              artifactId: route.capabilityOverlay.artifact.artifactId,
              formatVersion: route.capabilityOverlay.artifact.formatVersion,
              manifestHash: route.capabilityOverlay.artifact.manifestHash,
            }),
          }),
        }
      : {}),
  });
}

/** Never spread the protected snapshot into renderer/transcript/export data. */
export function projectAgentRoute(
  route: ResolvedAgentRouteSnapshot,
): PersistedAgentRouteSnapshot {
  return Object.freeze({
    selectedModelId: route.selectedModelId,
    ...(route.selectedModelLabel
      ? { selectedModelLabel: route.selectedModelLabel }
      : {}),
    ...(route.runtimeModelLabel
      ? { runtimeModelLabel: route.runtimeModelLabel }
      : {}),
    runtimeModelId: route.runtimeModelId,
    harnessId: route.harnessId,
    runtimeKind: route.runtimeKind,
    runnerRegistrationId: route.runnerRegistrationId,
    runtimeVersion: route.runtimeVersion,
    adapterVersion: route.adapterVersion,
    modelSource: route.modelSource,
    providerType: route.providerType,
    assignmentRevision: route.assignmentRevision,
    ...(route.routeId !== undefined ? { routeId: route.routeId } : {}),
    billingAuthority: route.billingAuthority,
    aiCreditsRouted: route.aiCreditsRouted,
    ...(route.requestedThinkingLevel !== undefined
      ? { requestedThinkingLevel: route.requestedThinkingLevel }
      : {}),
    ...(route.effectiveThinkingLevel !== undefined
      ? { effectiveThinkingLevel: route.effectiveThinkingLevel }
      : {}),
    capabilities: Object.freeze([...route.capabilities]),
    supportedThinkingLevels: Object.freeze([...route.supportedThinkingLevels]),
    capabilitySnapshotHash: route.capabilitySnapshotHash,
    capabilityGeneration: route.capabilityGeneration,
    policyRevision: route.policyRevision,
    ...(route.agentOverlay
      ? {
          agentOverlay: Object.freeze({
            agentDefinitionId: route.agentOverlay.agentDefinitionId,
            agentDefinitionRevision: route.agentOverlay.agentDefinitionRevision,
            agentDefinitionHash: route.agentOverlay.agentDefinitionHash,
            pluginProjectionHash: route.agentOverlay.pluginProjectionHash,
          }),
        }
      : {}),
  });
}

export function validateAgentRoute(
  modelId: string,
  requestedThinkingLevel: ThinkingLevel | undefined,
  route: ResolvedAgentRouteSnapshot,
): AgentDelegationResult<ThinkingLevel | undefined> {
  if (route.selectedModelId !== modelId)
    return {
      ok: false,
      error: {
        code: 'route_unavailable',
        message: 'The selected model route changed. Refresh model discovery.',
        retryable: true,
      },
    };
  if (!route.capabilities.includes('read'))
    return {
      ok: false,
      error: {
        code: 'policy_blocked',
        message: 'This route does not support confined delegation reads.',
        retryable: false,
      },
    };
  if (
    requestedThinkingLevel !== undefined &&
    !route.supportedThinkingLevels.includes(requestedThinkingLevel)
  )
    return {
      ok: false,
      error: {
        code: 'capability_unavailable',
        message:
          'The selected route does not support the requested thinking level.',
        retryable: false,
      },
    };
  return { ok: true, value: requestedThinkingLevel };
}

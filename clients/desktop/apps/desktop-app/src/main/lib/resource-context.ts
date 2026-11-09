import { ResourceContextUnavailableError } from './resource-context-error';
import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getFeatureFlagService } from '../feature-flags';
import { getWorkspaceContextService } from './workspace-context-service';
import { getResourceContextPolicyService } from '../services/resource-context-policy-service';

export function resourceContextEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}

export async function resourceContextSnapshot(): Promise<string> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  const state = service.getState();
  return JSON.stringify([
    service.accountEpoch(),
    state.revision,
    state.context,
  ]);
}

export async function assertResourceContextSnapshot(
  snapshot: string,
): Promise<void> {
  if (snapshot !== (await resourceContextSnapshot()))
    throw new ResourceContextUnavailableError('context-mismatch');
}

/**
 * Capture the signed-in account for a request authorized with an explicit
 * caller context. The sidebar selection never authorizes those requests, so
 * unlike resourceContextSnapshot this ignores it.
 */
export async function resourceAccountSnapshot(): Promise<number> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return service.accountEpoch();
}

export async function assertResourceAccountSnapshot(
  snapshot: number,
): Promise<void> {
  if (snapshot !== (await resourceAccountSnapshot()))
    throw new ResourceContextUnavailableError('context-mismatch');
}

export async function assertResourceContext(
  resource: ResourceContextInput['resource'],
  target?: ResourceContextInput['target'],
): Promise<void> {
  if (!resourceContextEnabled()) return;
  const decision = await getResourceContextPolicyService().decide({
    resource,
    ...(target ? { target } : {}),
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
  });
  if (!decision.allow)
    throw new ResourceContextUnavailableError(decision.reason);
}

/**
 * Authorize an explicit trusted caller context through the background policy
 * path. Foreground policy deliberately resolves its own selected sidebar, so
 * it cannot be used for agent calls that carry an owner context.
 */
export async function assertResourceContextForContext(
  resource: ResourceContextInput['resource'],
  context: WorkspaceContext,
  target?: ResourceContextInput['target'],
): Promise<void> {
  if (!resourceContextEnabled()) return;
  const decision = await getResourceContextPolicyService().decide({
    resource,
    ...(target ? { target } : {}),
    invocation: {
      mode: 'background',
      context,
      executionContext: serializeWorkspaceContext(context),
    },
  });
  if (!decision.allow)
    throw new ResourceContextUnavailableError(decision.reason);
}

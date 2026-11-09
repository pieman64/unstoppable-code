import { CoreOperationCancelParamsSchema } from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { AdvisorDelegationControlHost } from './advisor-delegation-control';

/**
 * The main owners behind App Advisor's delegation stops (CAN-6000): the chat's
 * delegation broker, the live core.agent.subagent.run registry, and
 * core.operation.cancel as the advisor chat with only core.operation.cancel.
 */
export function mainAdvisorDelegationControlHost(options: {
  chatId: string;
}): AdvisorDelegationControlHost {
  return {
    inspect: async (target, delegationId) => {
      const { inspectManagedDelegationForUser } =
        await import('../agents/delegation/service');
      return inspectManagedDelegationForUser(target, delegationId);
    },
    findLiveRun: (delegationId, runGeneration) =>
      getActiveDesktopRuntime().subagentRuns.findLive(
        delegationId,
        runGeneration,
      )?.operationId ?? null,
    isSubagentRun: (operationId) =>
      getActiveDesktopRuntime().subagentRuns.isSubagentRun(operationId),
    cancelOperation: async (operationId) => {
      await getActiveDesktopRuntime().instruction(
        'core.operation.cancel',
        CoreOperationCancelParamsSchema.parse({
          operationId,
          reason: 'Stopped by App Advisor',
        }),
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: `agent-action:${options.chatId}`,
            authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
            interfaceKind: 'mcp',
            grants: ['core.operation.cancel'],
          },
        },
      );
    },
    stopWithoutRun: async (target, delegationId) => {
      const { stopManagedDelegationForUser } =
        await import('../agents/delegation/service');
      return stopManagedDelegationForUser(target, delegationId);
    },
    stopAll: async (target, stopRoot) => {
      const { stopAllManagedDelegationsForUser } =
        await import('../agents/delegation/service');
      return stopAllManagedDelegationsForUser(target, { stopRoot });
    },
  };
}

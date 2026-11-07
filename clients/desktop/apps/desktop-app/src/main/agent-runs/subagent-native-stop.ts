import type { SubagentNativeStopTarget } from '@canopy/core-runtime/node/agent/turns';

/** Thrown when the broker refuses to stop a delegated run. */
export class SubagentNativeStopRefusedError extends Error {
  constructor() {
    super('The delegated run could not be stopped.');
    this.name = 'SubagentNativeStopRefusedError';
  }
}

/** Stop the delegated run behind a cancelled core.agent.subagent.run through the broker's user stop (CAN-4112). */
export async function stopSubagentNatively(
  target: SubagentNativeStopTarget,
): Promise<void> {
  const { stopManagedDelegationForUser } =
    await import('../agents/delegation/service');
  const result = await stopManagedDelegationForUser(
    {
      projectId: target.scope.workspaceId,
      worktreeId: target.scope.worktreeId,
      chatId: target.scope.chatId,
    },
    target.delegationId,
    target.runGeneration,
  );
  if (!result.ok) throw new SubagentNativeStopRefusedError();
}

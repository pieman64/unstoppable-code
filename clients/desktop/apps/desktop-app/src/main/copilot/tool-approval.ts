import {
  copilotNativeOperations,
  isCopilotShellControl,
} from '@canopy/desktop-shared/node/copilot/tool-input';
import type { CopilotPreToolInput } from '@canopy/desktop-shared/node/copilot/session-policy';
import type {
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import { approvalCheckForClaudeTool } from '../agents/claude-approval-adapter';

export async function authorizeCopilotNativeTool(
  input: CopilotPreToolInput,
  context: {
    cwd: string;
    approval: ApprovalSessionHandle;
    planMode: boolean;
    signal: AbortSignal;
    toolUseId: string;
  },
): Promise<ApprovalOutcome> {
  if (context.signal.aborted) return { decision: 'deny' };
  if (input.toolName === 'ask_user') return { decision: 'allow' };
  if (isCopilotShellControl(input.toolName, input.toolArgs))
    return { decision: 'allow' };
  const operations = copilotNativeOperations(
    input.toolName,
    input.toolArgs,
    context.cwd,
  );
  if (!operations?.length)
    return { decision: 'deny', message: 'This Copilot tool is not supported.' };
  for (const operation of operations) {
    if (context.planMode && operation.mutates)
      return { decision: 'deny', message: 'Plan mode allows read-only tools.' };
    const normalized = approvalCheckForClaudeTool(
      operation.tool,
      operation.input,
      context.cwd,
    );
    if (normalized.failClosedReason)
      return { decision: 'deny', message: normalized.failClosedReason };
    for (const requirement of [
      normalized,
      ...(normalized.additionalRequirements ?? []),
    ]) {
      if (context.signal.aborted) return { decision: 'deny' };
      const outcome = await context.approval.check(requirement.check, {
        title: `Copilot wants to use ${operation.tool}`,
        details: requirement.details,
        suggestedTarget: requirement.suggestedTarget,
        toolUseId: context.toolUseId,
      });
      if (context.signal.aborted) return { decision: 'deny' };
      if (outcome.decision !== 'allow' || outcome.stopTurn) return outcome;
    }
  }
  return { decision: 'allow' };
}

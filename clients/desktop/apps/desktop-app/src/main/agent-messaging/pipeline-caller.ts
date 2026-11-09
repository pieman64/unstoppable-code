import type { PipelineHostActionCaller } from '@canopy/desktop-shared/node/pipelines/executor/types';
import { PipelineHostRefusal } from '@canopy/desktop-shared/pipelines/host-actions';
import type { ProjectOwnerContext } from '@canopy/desktop-shared/types';
import type { PipelineAgentChatAddress } from '@canopy/execution-engine/types/pipeline';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';

/** A pipeline step acting through the explicit-target actions; built only by desktop main. */
export interface PipelineTrustedCaller {
  executionId: string;
  pipelineId?: string;
  stepId: string;
  /** The run's recorded owner (`execution_context`). */
  owner: ProjectOwnerContext;
  /** The agent whose rules apply to an agent-originated run (`agent_origin`). */
  agentOrigin?: PipelineAgentChatAddress;
}

/** Throws `PipelineHostRefusal('owner_context_unavailable')` for an unparseable owner. */
export function pipelineTrustedCaller(
  caller: PipelineHostActionCaller,
): PipelineTrustedCaller {
  // Same default as the host owner check (`callerOwner` in pipeline-owner-policy).
  const parsed = parseWorkspaceContext(caller.executionContext ?? 'personal');
  if (parsed === null)
    throw new PipelineHostRefusal(
      'owner_context_unavailable',
      "This pipeline's owner can't be checked right now. Try again.",
    );
  const owner: ProjectOwnerContext =
    parsed.kind === 'organization'
      ? { kind: 'organization', organizationId: parsed.organizationId }
      : { kind: 'personal' };
  return {
    executionId: caller.executionId,
    ...(caller.pipelineId !== undefined
      ? { pipelineId: caller.pipelineId }
      : {}),
    stepId: caller.stepId,
    owner,
    ...(caller.agentOrigin !== undefined
      ? { agentOrigin: caller.agentOrigin }
      : {}),
  };
}

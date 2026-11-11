import type { BotAction } from '../families/bots/actions';
import type { ProjectAction } from '../families/projects/actions';
import type { AgentActionResponse } from '../response';
import type { AgentActionCall } from '../surface/family';

/**
 * The host behind the explicit-target project and bot actions. It resolves
 * the trusted caller from the call, authorizes every target against the
 * caller's saved owner, and rechecks bot access on every call.
 */
export interface AgentProjectBotPort<H> {
  dispatch(
    action: ProjectAction | BotAction,
    call: AgentActionCall<H>,
  ): Promise<Omit<AgentActionResponse<string>, 'requestId'>>;
}

/** A project's saved owner: Personal, or one organization by external ID. */
export type AgentProjectOwner =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

/** The agent chat that started a run. */
export interface AgentPipelineOriginChat {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * A pipeline step acting through the explicit-target project actions. A host
 * builds it from its run's trusted fields, never from step inputs, and binds
 * a project port to it; the port ignores the call's own scope.
 */
export interface PipelineTrustedCaller {
  executionId: string;
  pipelineId?: string;
  stepId: string;
  /** The run's recorded owner (`execution_context`). */
  owner: AgentProjectOwner;
  /** The agent whose rules apply to an agent-originated run (`agent_origin`). */
  agentOrigin?: AgentPipelineOriginChat;
}

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

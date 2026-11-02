import type { AgentTranscriptReadPort } from '../port/transcript-read-port';
import type { AgentEnvironmentPort } from '../port/environment-port';
import type {
  AgentActionExecutionScope,
  AgentChatCreatePlacement,
} from './capabilities';

/** How a host backs one environment port member. */
export interface AgentActionHostPortBinding {
  /**
   * `dispatcher` calls registered operations through the host's dispatcher;
   * `retained` keeps an existing host path until its operation is registered.
   */
  via: 'dispatcher' | 'retained';
  /** The registered operations or retained host paths the member uses. */
  uses: readonly string[];
}

/**
 * A host's static declaration of its agent action surface: the families it
 * plugs in, the chat profiles it serves, and how each environment port member
 * reaches the backend. The agent-actions census reads these literals.
 */
export interface AgentActionHostBinding {
  id: string;
  /** Family ids, in surface order. */
  families: readonly string[];
  profiles: Readonly<
    Record<
      string,
      {
        executionScope: AgentActionExecutionScope;
        chatCreatePlacements: readonly AgentChatCreatePlacement[];
      }
    >
  >;
  /** Optional dedicated retained transcript read binding. */
  transcriptReadPort?: Readonly<
    Record<keyof AgentTranscriptReadPort<unknown>, AgentActionHostPortBinding>
  >;
  environmentPort: Readonly<
    Record<keyof AgentEnvironmentPort<unknown>, AgentActionHostPortBinding>
  >;
}

export function defineAgentActionHost<const B extends AgentActionHostBinding>(
  binding: B,
): B {
  return binding;
}

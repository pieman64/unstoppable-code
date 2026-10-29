import type { AgentActionCatalogEntry } from '../../catalog/types';
import {
  agentActionIdempotencyKey,
  agentActionResult,
  portErrorResponse,
} from '../../action-support';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
} from '../../surface/family';
import { PULL_REQUEST_ACTION_TYPES, pullRequestActionSchema } from './actions';

export { PULL_REQUEST_ACTION_TYPES, pullRequestActionSchema } from './actions';

export interface AgentPullRequestCreateResult {
  number: number;
  url: string;
  /** False when an open pull request for the branch was adopted. */
  created: boolean;
}

/**
 * The backend `pull_request.create` runs on: commit, push and open (or adopt)
 * the calling chat's pull request as the chat's owner. Failures are
 * `AgentPortError`s with agent-facing messages.
 */
export interface AgentPullRequestPort<H> {
  create(
    idempotencyKey: string,
    call: AgentActionCall<H>,
  ): Promise<AgentPullRequestCreateResult>;
}

/**
 * `pull_request.create`: the chat header's Create PR, for the agent. Opening
 * an already open pull request adopts it, so a retry is safe without a
 * receipt; the key only lets the host's git steps replay one tool call.
 */
export function createPullRequestActionFamily<H>(options: {
  port: AgentPullRequestPort<H>;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'pull-request',
    types: PULL_REQUEST_ACTION_TYPES,
    actionSchema: pullRequestActionSchema,
    supportedTypes: () => PULL_REQUEST_ACTION_TYPES,
    catalog: pullRequestActionCatalog,
    dispatchJsonSchema: { properties: {} },
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      try {
        const result = await options.port.create(
          agentActionIdempotencyKey(action.type, call, action),
          call,
        );
        return agentActionResult(call, action.type, { ...result });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}

export function pullRequestActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'pull_request.create',
      category: 'git',
      summary:
        "Open a GitHub pull request for this chat's worktree branch with the user's GitHub account: commits every uncommitted change, pushes the branch, then opens the pull request (or returns the one already open). Returns its number and URL.",
      fields: [],
      example: { type: 'pull_request.create' },
      keywords: [
        'pull request',
        'pr',
        'github',
        'open',
        'create',
        'push',
        'commit',
      ],
      notes: [
        'Use this whenever the user asks to open or create a pull request. Do not run gh, git push, or other GitHub commands in the sandbox for that: they have no GitHub credentials.',
        'Title and description are written from the changes. It never merges. Tell the user the returned URL.',
      ],
    },
  ];
}

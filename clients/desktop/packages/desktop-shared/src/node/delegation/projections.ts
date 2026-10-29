import {
  CLAUDE_DELEGATION_SPAWN_SCHEMA,
  CODEX_DELEGATION_SPAWN_SCHEMA,
  parseClaudeDelegationSpawn,
  parseCodexDelegationSpawn,
} from '@canopy/protocol/delegation/spawn-projections';
import {
  AGENT_DELEGATION_INPUT_LIMITS,
  DELEGATION_NOT_DESCENDANT_ERROR,
  parseGetDelegateOutputRequest,
  parseManageDelegateWorktreeRequest,
  parseMessageDelegateRequest,
  parseRequestSteeringRequest,
  parseWatchDelegatesRequest,
  type AgentDelegationResult,
  type AgentDelegationSnapshot,
  type AgentDelegationSpawnRequest,
  type DelegationListFilter,
  type DelegationStopReason,
  type GetDelegateOutputRequest,
  type GetDelegateOutputValue,
  type ManageDelegateWorktreeRequest,
  type MessageDelegateRequest,
  type RequestSteeringRequest,
  type WatchDelegatesRequest,
  type WatchDelegatesValue,
} from '@canopy/protocol/delegation';

import type { DelegationModelDiscovery } from '@canopy/protocol/delegation/discovery';
import type { DelegationCapabilityChoice } from '@canopy/protocol/delegation';
import {
  hasValidDelegationLineage,
  type DelegationParentContext,
} from './types';

/** List Delegates { includeCapabilities: true } payload. Names only, never paths. */
export interface DelegationCapabilityDiscovery {
  readonly capabilities: readonly DelegationCapabilityChoice[];
  readonly capabilitiesTruncated?: boolean;
}

export interface DelegationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

export interface DelegationProjectionNames {
  readonly spawn: string;
  readonly watch: string;
  readonly output: string;
  readonly inspect: string;
  readonly list: string;
  readonly stop: string;
  readonly manageWorktree?: string;
  readonly message?: string;
  readonly requestSteering?: string;
}
export interface DelegationProjectionBroker {
  manageWorktree?(
    parent: DelegationParentContext,
    input: ManageDelegateWorktreeRequest,
  ): Promise<AgentDelegationResult<unknown>>;
  message?(
    parent: DelegationParentContext,
    input: MessageDelegateRequest,
  ): Promise<AgentDelegationResult<unknown>>;
  requestSteering?(
    parent: DelegationParentContext,
    request: RequestSteeringRequest,
  ): Promise<AgentDelegationResult<unknown>>;
  requestStop?(
    parent: DelegationParentContext,
    id: string,
    reason?: DelegationStopReason,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
  spawn(
    parent: DelegationParentContext,
    task: AgentDelegationSpawnRequest,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
  watch(
    parent: DelegationParentContext,
    request: WatchDelegatesRequest,
  ): Promise<AgentDelegationResult<WatchDelegatesValue>>;
  getOutput(
    parent: DelegationParentContext,
    request: GetDelegateOutputRequest,
  ): AgentDelegationResult<GetDelegateOutputValue>;
  inspect(
    parent: DelegationParentContext,
    id: string,
  ): AgentDelegationSnapshot | undefined;
  list(
    parent: DelegationParentContext,
    filter?: DelegationListFilter,
  ): readonly AgentDelegationSnapshot[];
  stop(
    parent: DelegationParentContext,
    id: string,
    reason?: DelegationStopReason,
  ):
    | AgentDelegationResult<AgentDelegationSnapshot>
    | Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
}

const ID_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['delegationId'],
  properties: {
    delegationId: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;
const WATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['delegationIds', 'mode', 'timeoutMs'],
  properties: {
    delegationIds: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 256 },
    },
    mode: { type: 'string', enum: ['any', 'all'] },
    timeoutMs: {
      type: 'integer',
      minimum: 0,
      maximum: AGENT_DELEGATION_INPUT_LIMITS.waitTimeoutMs,
    },
  },
} as const;
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['delegationId'],
  properties: {
    delegationId: { type: 'string', minLength: 1, maxLength: 256 },
    resultIndex: { type: 'integer', minimum: 1 },
  },
} as const;
const UNDER_DELEGATION_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
} as const;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isDelegationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_DELEGATION_INPUT_LIMITS.idCharacters &&
    value === value.trim() &&
    !/[\0\r\n]/.test(value)
  );
}

/** Collision-free names are selected by the host's injected brand namespace. */
export function createDelegationProjection(
  harness: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
  namespace: string,
  broker: DelegationProjectionBroker,
  options: {
    developmentProbe?: boolean;
    names?: DelegationProjectionNames;
    discoverModels?: (
      parent: DelegationParentContext,
      signal?: AbortSignal,
    ) => Promise<DelegationModelDiscovery>;
    discoverCapabilities?: (
      parent: DelegationParentContext,
      signal?: AbortSignal,
    ) => Promise<DelegationCapabilityDiscovery>;
    enableDelegationTools?: boolean;
    requestSteering?: (
      parent: DelegationParentContext,
      request: RequestSteeringRequest,
    ) => Promise<AgentDelegationResult<unknown>>;
  } = {},
): {
  readonly tools: readonly DelegationTool[];
  invoke(
    parent: DelegationParentContext,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentDelegationResult<unknown>>;
} {
  // Brand namespaces are lower-kebab (`unstoppable-code`); hyphens are valid
  // in both Claude MCP and Codex dynamic tool names.
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(namespace))
    throw new Error('Invalid delegation tool namespace');
  const names = options.names ?? {
    spawn: `${namespace}_${harness !== 'codex' ? 'delegate_task' : 'spawn_delegate'}`,
    watch: `${namespace}_watch_delegates`,
    output: `${namespace}_get_delegate_output`,
    inspect: `${namespace}_inspect_delegate`,
    list: `${namespace}_list_delegates`,
    stop: `${namespace}_stop_delegate`,
    manageWorktree: `${namespace}_manage_delegate_worktree`,
    message: `${namespace}_message_delegate`,
    requestSteering: `${namespace}_request_steering`,
  };
  const delegationToolsEnabled = options.enableDelegationTools !== false;
  return {
    tools: Object.freeze(
      [
        ...(names.requestSteering && options.requestSteering
          ? [
              {
                name: names.requestSteering,
                description:
                  'Send a nonblocking steering request to your direct parent. An active parent is steered; an inactive retained parent receives an ordinary turn. This does not pause or terminate your work, and the request cannot grant permissions or override user or system policy.',
                inputSchema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['message'],
                  properties: {
                    message: { type: 'string', minLength: 1, maxLength: 32768 },
                  },
                },
              },
            ]
          : []),
        ...(delegationToolsEnabled
          ? [
              ...(names.manageWorktree && broker.manageWorktree
                ? [
                    {
                      name: names.manageWorktree,
                      description:
                        'Apply an isolated delegate worktree or discard it. Shared-worktree delegates reject both operations. Existing approval, conflict, deduplication, and active-descendant safeguards apply.',
                      inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['delegationId', 'operation'],
                        properties: {
                          delegationId: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 256,
                          },
                          operation: {
                            type: 'string',
                            enum: ['apply', 'discard'],
                          },
                        },
                      },
                    },
                  ]
                : []),
              ...(names.message && broker.message
                ? [
                    {
                      name: names.message,
                      description:
                        'Send a follow-up, steer an active delegate, or interrupt its current run. follow_up starts an inactive retained session or queues its next turn; steer injects into an active turn and becomes an ordinary follow-up only when inactive. Only follow_up may replace bounded write grants. Returns a durable receipt immediately. When the delegation limit is reached, a new run waits in the queue and starts automatically: the result reports its runGeneration and phase (queued or starting) with its queue position. Register Watch Delegates and end your turn instead of polling List Delegates. Set if_busy to reject to fail at once with capacity_exceeded instead of waiting.',
                      inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['delegationId', 'operation'],
                        properties: {
                          delegationId: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 256,
                          },
                          operation: {
                            type: 'string',
                            enum: ['follow_up', 'steer', 'interrupt'],
                          },
                          message: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 32768,
                          },
                          permissions:
                            CLAUDE_DELEGATION_SPAWN_SCHEMA.properties
                              .permissions,
                          if_busy:
                            CLAUDE_DELEGATION_SPAWN_SCHEMA.properties.if_busy,
                        },
                      },
                    },
                  ]
                : []),
              {
                name: names.spawn,
                description: options.developmentProbe
                  ? 'Development probe: start a fresh read-only delegated task using a logical model. No provider process is launched.'
                  : 'Start a delegated task using a logical model ID or configured Agent ID from List Delegates with includeModels: true. A configured Agent carries its model, system instructions and selected plugins, skills and MCP servers. Children start with your plugins, skills and MCP servers by default; set inherit_capabilities: false to start one without them (a configured Agent keeps its own). To give a child more, pass capabilities IDs from List Delegates with includeCapabilities: true. Grant writes explicitly with permissions.writePaths (relative files/directories, or a dot for the workspace); omitted grants allow read/search only. Parent approval settings always apply to commands and MCP tools too. isolation defaults to shared_worktree; choose worktree only when isolation is wanted. Supply a self-contained prompt with paths, scope and expected output. Every call returns a durable ID promptly. When the delegation limit is reached, the task waits in a queue (phase queued, with its position) and starts automatically; set if_busy to reject to fail at once with capacity_exceeded instead. Completion is silent unless you explicitly register Watch Delegates; register it and end your turn rather than polling List Delegates, then retrieve output with Get Delegate Output. Reads share the live working tree and can observe parent edits; returned revision and dirty state describe launch-time observation, not an immutable snapshot.',
                inputSchema:
                  harness !== 'codex'
                    ? CLAUDE_DELEGATION_SPAWN_SCHEMA
                    : CODEX_DELEGATION_SPAWN_SCHEMA,
              },
              {
                name: names.watch,
                description:
                  'Register one durable, nonblocking, one-shot completion watch for the delegates’ current run generations. Pass only delegation IDs returned by Delegate Task or List Delegates; the watch is refused until at least one delegate exists. mode any fires when one settles; all waits for every captured run. Returns immediately. Notifications contain metadata and result indices, never output. timeoutMs is a real deadline of up to 30 minutes (1800000); reaching it notifies you with a timeout outcome and does not cancel delegates.',
                inputSchema: WATCH_SCHEMA,
              },
              {
                name: names.output,
                description:
                  'Read a settled delegate result explicitly. Omit resultIndex for the latest settled result, or provide a one-based result index from a watch notification for that exact historical result. Reads never resume execution, consume output, or change watcher state.',
                inputSchema: OUTPUT_SCHEMA,
              },
              {
                name: names.inspect,
                description:
                  'Read one retained delegation you started, directly or through your delegates, without consuming terminal delivery. childDelegationIds lists the delegations it started itself (the 64 most recent).',
                inputSchema: ID_SCHEMA,
              },
              {
                name: names.list,
                description: [
                  options.discoverModels
                    ? 'List owned children. Set includeModels to true before choosing a child target: returns current logical model and configured Agent IDs, supported thinking levels, recommended available model, auth state and disabled reasons. Pass the selected ID as model when spawning. Discovery is advisory; launch rechecks the exact route and selected capabilities.'
                    : 'List the children owned by this parent session.',
                  ...(options.discoverCapabilities
                    ? [
                        'Set includeCapabilities to true to list plugins, skills and MCP servers you can assign to a child with capabilities: returns each ID, whether the child already inherits it, whether it is assignable, and why not.',
                      ]
                    : []),
                  'The list includes every delegation below you, at any depth. Set underDelegationId to list only the delegations below one of them (or below yourself).',
                ].join(' '),
                inputSchema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    ...(options.discoverModels
                      ? { includeModels: { type: 'boolean' } }
                      : {}),
                    ...(options.discoverCapabilities
                      ? { includeCapabilities: { type: 'boolean' } }
                      : {}),
                    underDelegationId: UNDER_DELEGATION_SCHEMA,
                  },
                },
              },
              {
                name: names.stop,
                description:
                  'Request cancellation and return promptly. An accepted request is not proof of native shutdown; inspect retained status if needed.',
                inputSchema: ID_SCHEMA,
              },
            ]
          : []),
      ].map((tool) => Object.freeze(tool)),
    ),
    async invoke(
      parent,
      name,
      input,
      signal,
    ): Promise<AgentDelegationResult<unknown>> {
      const invalid: AgentDelegationResult<never> = {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Invalid delegation tool request.',
          retryable: false,
        },
      };
      if (signal?.aborted || !hasValidDelegationLineage(parent))
        return {
          ok: false,
          error: {
            code: 'parent_unavailable',
            message: 'This parent cannot invoke delegation tools.',
            retryable: false,
          },
        };
      if (/(?:^|__)WaitDelegates$|(?:^|_)wait_delegates$/.test(name))
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message:
              'Wait Delegates is no longer available. Use Watch Delegates to register a nonblocking completion notification, then Get Delegate Output to read the result.',
            retryable: false,
          },
        };
      if (/(?:^|__)ManageDelegate$|(?:^|_)manage_delegate$/.test(name))
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message:
              'Manage Delegate is no longer available. Use Message Delegate for follow-up, steering, or interruption, and Manage Delegate Worktree for apply or discard.',
            retryable: false,
          },
        };
      if (name === names.requestSteering && options.requestSteering) {
        const parsed = parseRequestSteeringRequest(input);
        return parsed.ok
          ? options.requestSteering(parent, parsed.value)
          : parsed;
      }
      if (!delegationToolsEnabled) return invalid;
      if (name === names.manageWorktree && broker.manageWorktree) {
        const parsed = parseManageDelegateWorktreeRequest(input);
        return parsed.ok ? broker.manageWorktree(parent, parsed.value) : parsed;
      }
      if (name === names.message && broker.message) {
        const parsed = parseMessageDelegateRequest(input);
        return parsed.ok ? broker.message(parent, parsed.value) : parsed;
      }
      if (name === names.spawn) {
        const parsed =
          harness !== 'codex'
            ? parseClaudeDelegationSpawn(input)
            : parseCodexDelegationSpawn(input);
        return parsed.ok ? broker.spawn(parent, parsed.value) : parsed;
      }
      if (name === names.watch) {
        const parsed = parseWatchDelegatesRequest(input);
        return parsed.ok ? broker.watch(parent, parsed.value) : parsed;
      }
      if (name === names.output) {
        const parsed = parseGetDelegateOutputRequest(input);
        return parsed.ok ? broker.getOutput(parent, parsed.value) : parsed;
      }
      if (name === names.list) {
        if (!record(input)) return invalid;
        const keys = Object.keys(input);
        if (keys.length === 0) return { ok: true, value: broker.list(parent) };
        if (
          keys.some(
            (key) =>
              key !== 'includeModels' &&
              key !== 'includeCapabilities' &&
              key !== 'underDelegationId',
          ) ||
          (input.includeModels !== undefined &&
            (typeof input.includeModels !== 'boolean' ||
              !options.discoverModels)) ||
          (input.includeCapabilities !== undefined &&
            (typeof input.includeCapabilities !== 'boolean' ||
              !options.discoverCapabilities)) ||
          (input.underDelegationId !== undefined &&
            !isDelegationId(input.underDelegationId))
        )
          return invalid;
        const underDelegationId = isDelegationId(input.underDelegationId)
          ? input.underDelegationId
          : undefined;
        // Walking one branch never widens access: the branch root must be the
        // caller itself or one of its descendants.
        if (
          underDelegationId !== undefined &&
          underDelegationId !== parent.parentDelegationId &&
          !broker.inspect(parent, underDelegationId)
        )
          return { ok: false, error: { ...DELEGATION_NOT_DESCENDANT_ERROR } };
        const delegations = (): readonly AgentDelegationSnapshot[] =>
          underDelegationId === undefined
            ? broker.list(parent)
            : broker.list(parent, { underDelegationId });
        const includeModels = input.includeModels === true;
        const includeCapabilities = input.includeCapabilities === true;
        if (!includeModels && !includeCapabilities)
          return { ok: true, value: delegations() };
        return {
          ok: true,
          value: {
            delegations: delegations(),
            ...(includeModels && options.discoverModels
              ? await options.discoverModels(parent, signal)
              : {}),
            ...(includeCapabilities && options.discoverCapabilities
              ? await options.discoverCapabilities(parent, signal)
              : {}),
          },
        };
      }
      if (
        (name !== names.inspect && name !== names.stop) ||
        !record(input) ||
        Object.keys(input).length !== 1 ||
        typeof input.delegationId !== 'string' ||
        input.delegationId.length > 256
      )
        return invalid;
      // An agent stopping a delegation is recorded as a parent stop, never as
      // the user cancelling it.
      if (name === names.stop)
        return broker.requestStop
          ? broker.requestStop(parent, input.delegationId, 'stopped_by_parent')
          : broker.stop(parent, input.delegationId, 'stopped_by_parent');
      const snapshot = broker.inspect(parent, input.delegationId);
      return snapshot
        ? { ok: true, value: snapshot }
        : { ok: false, error: { ...DELEGATION_NOT_DESCENDANT_ERROR } };
    },
  };
}

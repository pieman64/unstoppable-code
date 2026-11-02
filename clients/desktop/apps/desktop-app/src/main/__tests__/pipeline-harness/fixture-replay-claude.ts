/**
 * Test-only Claude lifecycle fixture materializer.
 *
 * Lifecycle fixtures contain aliases and content-free observations, not SDK
 * payload copies. This module turns one fixture frame into one typed SDK
 * envelope and normalizes the actual envelope back to a content-free trace
 * projection. `claude.sdk-message` and `claude.stream-event` are the stable
 * recorder templates; the more specific `claude.system.init`,
 * `claude.assistant.text`, `claude.result.success`, etc. keys are also accepted
 * for handwritten fixtures.
 */
import { randomUUID } from 'node:crypto';
import type { UUID } from 'node:crypto';
import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKBackgroundTasksChangedMessage,
  SDKCompactBoundaryMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKInformationalMessage,
  SDKMessage,
  SDKNotificationMessage,
  SDKPartialAssistantMessage,
  SDKPermissionDeniedMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSessionStateChangedMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKThinkingTokensMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKWorkerShuttingDownMessage,
  NonNullableUsage,
} from '@anthropic-ai/claude-agent-sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import type {
  LifecycleControl,
  LifecycleFields,
  LifecycleFrame,
  LifecycleFrameObservation,
  LifecycleIds,
  LifecycleReplayDriver,
} from './contracts';

export interface ClaudeCommandLifecycleFrame {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled';
  session_id?: string;
}

export type ClaudeReplayEnvelope = SDKMessage | ClaudeCommandLifecycleFrame;

export interface ClaudeReplayInput {
  action: 'send' | 'steer';
  messageUuid?: string;
  turnKey: string;
}

export interface ClaudeReplayTransport {
  readonly sessionId: string;
  currentTurnKey(): string | undefined;
  emit(
    envelope: ClaudeReplayEnvelope,
    observation: LifecycleFrameObservation,
    turnKey?: string,
  ): void | Promise<void>;
}

type ClaudeAliasKind = keyof LifecycleIds;

const ID_KINDS: readonly ClaudeAliasKind[] = [
  'session',
  'message',
  'turn',
  'thread',
  'item',
  'task',
  'call',
  'request',
  'toolUse',
];

const ID_FIELD_NAMES = new Set([
  'uuid',
  'session_id',
  'request_id',
  'task_id',
  'call_id',
  'tool_use_id',
  'command_uuid',
  'user_message_uuid',
  'user_message_uuids',
]);

const INIT_API_KEY_SOURCES = [
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
] as const;

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

const RESULT_ERROR_SUBTYPES = [
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
] as const satisfies readonly SDKResultError['subtype'][];

const TASK_TERMINAL_STATUSES = ['completed', 'failed', 'stopped'] as const;

function emptyUsage(): NonNullableUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
    inference_geo: '',
    iterations: [],
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

function fieldValue(frame: LifecycleFrame, key: string): unknown {
  const semantic: Readonly<Record<string, string>> = {
    state: 'sessionState',
    status: 'taskStatus',
    task_type: 'taskType',
    is_backgrounded: 'isBackgrounded',
    result_index: 'resultIndex',
  };
  const alias = semantic[key];
  if (alias && Object.hasOwn(frame.fields ?? {}, alias))
    return frame.fields?.[alias];
  return Object.prototype.hasOwnProperty.call(frame.fields ?? {}, key)
    ? frame.fields?.[key]
    : undefined;
}

function hasField(frame: LifecycleFrame, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(frame.fields ?? {}, key);
}

function stringField(
  frame: LifecycleFrame,
  key: string,
  fallback: string,
): string {
  const value = fieldValue(frame, key);
  if (value === undefined) return fallback;
  if (typeof value !== 'string')
    throw new Error(`Claude replay field ${key} must be a string`);
  return value;
}

function nullableStringField(
  frame: LifecycleFrame,
  key: string,
  fallback: string | null,
): string | null {
  const value = fieldValue(frame, key);
  if (value === undefined) return fallback;
  if (value === null || typeof value === 'string') return value;
  throw new Error(`Claude replay field ${key} must be a string or null`);
}

function numberField(
  frame: LifecycleFrame,
  key: string,
  fallback: number,
): number {
  const value = fieldValue(frame, key);
  if (value === undefined) return fallback;
  if (typeof value !== 'number')
    throw new Error(`Claude replay field ${key} must be a number`);
  return value;
}

function nullableNumberField(
  frame: LifecycleFrame,
  key: string,
  fallback: number | null,
): number | null {
  const value = fieldValue(frame, key);
  if (value === undefined) return fallback;
  if (value === null || typeof value === 'number') return value;
  throw new Error(`Claude replay field ${key} must be a number or null`);
}

function booleanField(
  frame: LifecycleFrame,
  key: string,
  fallback: boolean,
): boolean {
  const value = fieldValue(frame, key);
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean')
    throw new Error(`Claude replay field ${key} must be a boolean`);
  return value;
}

function stringArrayField(frame: LifecycleFrame, key: string): string[] {
  const value = fieldValue(frame, key);
  if (value === undefined) return [];
  if (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
  )
    return value;
  throw new Error(`Claude replay field ${key} must be an array of strings`);
}

function included(frame: LifecycleFrame, key: string): boolean {
  return (
    hasField(frame, key) ||
    (frame.shape !== undefined && frame.shape.includes(key))
  );
}

function validateChoice<const T extends readonly string[]>(
  value: string,
  values: T,
  field: string,
): T[number] {
  const matched = values.find((candidate) => candidate === value);
  if (matched !== undefined) return matched;
  throw new Error(`Unsupported Claude replay ${field}: ${value}`);
}

function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function requireUuid(value: string): UUID {
  if (!isUuid(value)) throw new Error('Claude replay expected a live UUID');
  return value;
}

function parseTraceType(
  label: string,
): { type: string; subtype?: string } | undefined {
  const parts = label.split(':');
  if (parts[0] !== 'sdk' || parts[1] === undefined) return undefined;
  const subtype = parts.slice(2).join(':');
  return {
    type: parts[1],
    ...(subtype.length > 0 ? { subtype } : {}),
  };
}

function templateTraceType(
  template: string,
): { type: string; subtype?: string; assistantBlock?: string } | undefined {
  const key = template.replaceAll('-', '.');
  const parts = key.split('.');
  if (parts[0] !== 'claude') return undefined;
  if (parts[1] === 'system' && parts[2])
    return { type: 'system', subtype: parts.slice(2).join('_') };
  if (parts[1] === 'assistant' && parts[2])
    return { type: 'assistant', assistantBlock: parts[2] };
  if (parts[1] === 'result' && parts[2])
    return { type: 'result', subtype: parts.slice(2).join('_') };
  if (parts[1] === 'user' && parts[2])
    return { type: 'user', subtype: parts.slice(2).join('_') };
  if (parts[1] === 'status') return { type: 'system', subtype: 'status' };
  return undefined;
}

function frameKind(frame: LifecycleFrame): {
  type: string;
  subtype?: string;
  assistantBlock?: string;
} {
  const parsed = parseTraceType(frame.type);
  const template = templateTraceType(frame.template);
  if (parsed) {
    return {
      ...parsed,
      ...(template?.assistantBlock
        ? { assistantBlock: template.assistantBlock }
        : {}),
    };
  }
  if (template) return template;
  throw new Error(
    `Unsupported Claude replay frame type/template: ${frame.type} (${frame.template})`,
  );
}

function assertSubtype(
  frame: LifecycleFrame,
  expected: string | undefined,
): void {
  const fromFields = fieldValue(frame, 'resultSubtype');
  if (fromFields !== undefined && fromFields !== expected)
    throw new Error(
      `Claude replay subtype mismatch: frame type names ${String(expected)}, fields name ${JSON.stringify(fromFields)}`,
    );
}

function addConsumedIds(
  envelope: {
    user_message_uuid?: string;
    user_message_uuids?: string[];
  },
  aliases: readonly string[] | undefined,
  bindings: ClaudeReplayBindings,
): Promise<void> {
  if (!aliases || aliases.length === 0) return Promise.resolve();
  return Promise.all(
    aliases.map((alias) => bindings.resolveConsumed(alias)),
  ).then((uuids) => {
    envelope.user_message_uuids = uuids;
    envelope.user_message_uuid = uuids.at(-1);
  });
}

function copyDirectFields<T extends object>(
  target: T,
  frame: LifecycleFrame,
  allowed: ReadonlySet<string>,
): T {
  const values: LifecycleFields = {};
  for (const [key, value] of Object.entries(frame.fields ?? {})) {
    if (!allowed.has(key) || ID_FIELD_NAMES.has(key)) continue;
    values[key] = value;
  }
  Object.assign(target, values);
  return target;
}

function apiKeySource(frame: LifecycleFrame): SDKSystemMessage['apiKeySource'] {
  return validateChoice(
    stringField(frame, 'apiKeySource', 'none'),
    INIT_API_KEY_SOURCES,
    'apiKeySource',
  );
}

function permissionMode(
  frame: LifecycleFrame,
): SDKSystemMessage['permissionMode'] {
  return validateChoice(
    stringField(frame, 'permissionMode', 'default'),
    PERMISSION_MODES,
    'permissionMode',
  );
}

function resultErrorSubtype(value: string): SDKResultError['subtype'] {
  return validateChoice(value, RESULT_ERROR_SUBTYPES, 'result subtype');
}

function idsForFrame(frame: ClaudeReplayEnvelope): LifecycleIds | undefined {
  const ids: LifecycleIds = {};
  const type = readString(frame, 'type');
  const uuid = readString(frame, 'uuid') ?? readString(frame, 'command_uuid');
  const sessionId = readString(frame, 'session_id');
  const turnId = readString(frame, 'turn_id');
  const taskId = readString(frame, 'task_id');
  const parentToolUseId = readString(frame, 'parent_tool_use_id');
  const toolUseId = parentToolUseId ?? readString(frame, 'tool_use_id');
  const message = readField(frame, 'message');
  const messageId = readString(message, 'id');
  if (sessionId) ids.session = sessionId;
  if (uuid ?? messageId) ids.message = uuid ?? messageId;
  if (turnId) ids.turn = turnId;
  if (taskId) ids.task = taskId;
  if (toolUseId) ids.toolUse = toolUseId;

  const content = readField(message, 'content');
  if (Array.isArray(content)) {
    const toolUse: unknown = content.find(
      (block: unknown) => readString(block, 'type') === 'tool_use',
    );
    const toolUseIdFromBlock = readString(toolUse, 'id');
    if (type === 'assistant' && toolUseIdFromBlock)
      ids.toolUse = toolUseIdFromBlock;
    if (type === 'user') {
      const result: unknown = content.find(
        (block: unknown) => readString(block, 'type') === 'tool_result',
      );
      const resultToolUseId = readString(result, 'tool_use_id');
      if (resultToolUseId) ids.toolUse = resultToolUseId;
    }
  }
  return Object.keys(ids).length > 0 ? ids : undefined;
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key);
}

function readString(value: unknown, key: string): string | undefined {
  const candidate = readField(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined;
}

class ClaudeReplayBindings {
  private readonly aliases = new Map<string, string>();
  private readonly reverseAliases = new Map<string, string>();
  private readonly pendingConsumed = new Map<
    string,
    Array<{ resolve(value: string): void; reject(error: Error): void }>
  >();
  private generatedAlias = 0;
  private readonly generatedIds = new Map<ClaudeAliasKind, number>();

  constructor(
    private readonly sessionId: string,
    private readonly currentTurnKey: () => string | undefined,
  ) {}

  lookup(kind: ClaudeAliasKind, alias: string): string | undefined {
    return this.aliases.get(this.key(kind, alias));
  }

  bindInput(control: LifecycleControl, input: ClaudeReplayInput): void {
    const ids = control.ids;
    if (ids?.session) this.bind('session', ids.session, this.sessionId);
    if (ids?.turn) this.bind('turn', ids.turn, input.turnKey);
    if (ids?.message) {
      if (!input.messageUuid)
        throw new Error(
          `Claude replay ${control.action} ${ids.message} arrived without a live message UUID`,
        );
      this.bind('message', ids.message, requireUuid(input.messageUuid));
    }
  }

  resolve(kind: ClaudeAliasKind, alias: string | undefined): string {
    if (alias) {
      const existing = this.aliases.get(this.key(kind, alias));
      if (existing) return existing;
      const generated = this.makeId(kind);
      this.bind(kind, alias, generated);
      return generated;
    }
    if (kind === 'session') {
      this.bind(kind, '$auto:session', this.sessionId);
      return this.sessionId;
    }
    const generatedAlias = this.makeAutoAlias(kind);
    const existing = this.aliases.get(this.key(kind, generatedAlias));
    if (existing) return existing;
    const generated = this.makeId(kind);
    this.bind(kind, generatedAlias, generated);
    return generated;
  }

  resolveUuid(kind: 'message', alias: string | undefined): UUID {
    return requireUuid(this.resolve(kind, alias));
  }

  aliasFor(
    kind: ClaudeAliasKind,
    actualId: string,
    preferredAlias?: string,
  ): string {
    if (preferredAlias) {
      const bound = this.aliases.get(this.key(kind, preferredAlias));
      if (bound === actualId) return preferredAlias;
    }
    const reverse = this.reverseAliases.get(this.key(kind, actualId));
    if (reverse) return reverse;
    const generatedAlias = this.makeAutoAlias(kind);
    this.bind(kind, generatedAlias, actualId);
    return generatedAlias;
  }

  resolveConsumed(alias: string): Promise<UUID> {
    const found = this.aliases.get(this.key('message', alias));
    if (found) return Promise.resolve(requireUuid(found));
    return new Promise((resolve, reject) => {
      const pending = this.pendingConsumed.get(alias) ?? [];
      const timer = setTimeout(() => {
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        reject(
          new Error(
            `Claude replay input ${alias} was not bound within 10000ms`,
          ),
        );
      }, 10_000);
      const waiter = {
        resolve: (value: string): void => {
          clearTimeout(timer);
          resolve(requireUuid(value));
        },
        reject: (error: Error): void => {
          clearTimeout(timer);
          reject(error);
        },
      };
      pending.push(waiter);
      this.pendingConsumed.set(alias, pending);
    });
  }

  dispose(): void {
    for (const waiters of Array.from(this.pendingConsumed.values())) {
      for (const waiter of waiters)
        waiter.reject(
          new Error('Claude replay disposed before consumed input was bound'),
        );
    }
    this.pendingConsumed.clear();
  }

  private bind(kind: ClaudeAliasKind, alias: string, actualId: string): void {
    const key = this.key(kind, alias);
    const existing = this.aliases.get(key);
    if (existing && existing !== actualId)
      throw new Error(
        `Claude replay alias ${kind}:${alias} was rebound to a different live id`,
      );
    this.aliases.set(key, actualId);
    this.reverseAliases.set(this.key(kind, actualId), alias);
    if (kind === 'message') {
      for (const waiter of this.pendingConsumed.get(alias) ?? [])
        waiter.resolve(actualId);
      this.pendingConsumed.delete(alias);
    }
  }

  private makeAutoAlias(kind: ClaudeAliasKind): string {
    this.generatedAlias += 1;
    return `$auto:${kind}:${this.generatedAlias}`;
  }

  private makeId(kind: ClaudeAliasKind): string {
    const index = (this.generatedIds.get(kind) ?? 0) + 1;
    this.generatedIds.set(kind, index);
    if (kind === 'session') return this.sessionId;
    if (kind === 'turn')
      return this.currentTurnKey() ?? `claude-turn-replay-${randomUUID()}`;
    if (kind === 'call' || kind === 'toolUse') return `toolu_${randomUUID()}`;
    if (kind === 'task') return `task_${randomUUID()}`;
    if (kind === 'request') return `req_${randomUUID()}`;
    if (kind === 'message') return randomUUID();
    if (kind === 'thread') return `thread_${randomUUID()}`;
    return `item_${index}_${randomUUID()}`;
  }

  private key(kind: ClaudeAliasKind, value: string): string {
    return `${kind}:${value}`;
  }
}

class ReplayInputQueue {
  private readonly queued: ClaudeReplayInput[] = [];
  private readonly waiters: Array<{
    action: 'send' | 'steer';
    resolve(input: ClaudeReplayInput): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closedError: Error | undefined;

  push(input: ClaudeReplayInput): void {
    if (this.closedError) return;
    const waiterIndex = this.waiters.findIndex(
      (waiter) => waiter.action === input.action,
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(input);
      }
      return;
    }
    this.queued.push(input);
  }

  take(action: 'send' | 'steer'): Promise<ClaudeReplayInput> {
    if (this.closedError) return Promise.reject(this.closedError);
    const queuedIndex = this.queued.findIndex(
      (input) => input.action === action,
    );
    if (queuedIndex >= 0) {
      const [input] = this.queued.splice(queuedIndex, 1);
      if (input) return Promise.resolve(input);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        action,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `Waiting for Claude replay ${action} control timed out after 60000ms`,
            ),
          );
        }, 60_000),
      };
      this.waiters.push(waiter);
    });
  }

  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.queued.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function contentShape(envelope: ClaudeReplayEnvelope): string[] | undefined {
  if (readString(envelope, 'type') === 'stream_event') {
    const event = readField(envelope, 'event');
    const eventType = readString(event, 'type');
    if (!eventType) return undefined;
    const innerBlock = readField(event, 'content_block');
    const innerDelta = readField(event, 'delta');
    const innerType =
      readString(innerBlock, 'type') ?? readString(innerDelta, 'type');
    return innerType ? [eventType, innerType] : [eventType];
  }
  const message = readField(envelope, 'message');
  const content = readField(message, 'content');
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block: unknown) => readString(block, 'type'))
    .filter((type): type is string => type !== undefined);
}

function traceLabel(envelope: ClaudeReplayEnvelope): string {
  const type = readString(envelope, 'type') ?? 'unknown';
  const subtype = readString(envelope, 'subtype');
  return subtype ? `sdk:${type}:${subtype}` : `sdk:${type}`;
}

function normalizedTaskType(value: string): string {
  if (
    [
      'local_agent',
      'local_bash',
      'local_workflow',
      'mcp_task',
      'local_js',
    ].includes(value)
  )
    return value;
  const normalized = value.toLowerCase();
  const known = [
    'agent',
    'background',
    'command',
    'local_bash',
    'local_js',
    'other',
    'prompt',
    'workflow',
  ] as const;
  const exact = known.find((candidate) => candidate === normalized);
  if (exact) return exact;
  if (
    normalized.includes('bash') ||
    normalized.includes('shell') ||
    normalized.includes('command')
  )
    return 'command';
  if (normalized.includes('workflow')) return 'workflow';
  if (normalized.includes('background')) return 'background';
  if (normalized.includes('agent')) return 'agent';
  if (normalized.includes('prompt')) return 'prompt';
  return 'other';
}

function stopReason(value: string | undefined): string | undefined {
  const known = [
    'end_turn',
    'max_tokens',
    'stop_sequence',
    'tool_use',
  ] as const;
  return value === undefined
    ? undefined
    : known.find((candidate) => candidate === value);
}

function fieldProjection(
  envelope: ClaudeReplayEnvelope,
  bindings: ClaudeReplayBindings,
): LifecycleFields | undefined {
  const fields: LifecycleFields = {};
  const type = readString(envelope, 'type');
  const subtype = readString(envelope, 'subtype');
  const message = readField(envelope, 'message');
  const resultSubtype = type === 'result' ? subtype : undefined;
  if (resultSubtype) {
    fields.resultSubtype = resultSubtype;
    fields.isError = resultSubtype.startsWith('error_');
  }
  const toolResultStatus =
    type === 'user'
      ? readString(readField(envelope, 'tool_use_result'), 'status')
      : undefined;
  if (toolResultStatus) fields.resultSubtype = toolResultStatus;
  if (type === 'command_lifecycle') {
    const state = readString(envelope, 'state');
    if (state) fields.commandState = state;
  }
  const isError = readField(envelope, 'is_error');
  if (typeof isError === 'boolean') fields.isError = isError;
  const resultIndex = readField(envelope, 'result_index');
  if (typeof resultIndex === 'number') fields.resultIndex = resultIndex;

  const terminalReason = readString(envelope, 'terminal_reason');
  if (terminalReason) fields.terminalReason = terminalReason;
  const event = readField(envelope, 'event');
  const delta = readField(event, 'delta');
  const stopValues = [
    readField(envelope, 'stop_reason'),
    readField(message, 'stop_reason'),
    readField(delta, 'stop_reason'),
  ];
  const rawStop = stopValues.find((value) => value !== undefined);
  if (rawStop === null) fields.stopReason = null;
  else if (typeof rawStop === 'string')
    fields.stopReason = stopReason(rawStop) ?? rawStop;

  const origin = readString(readField(envelope, 'origin'), 'kind');
  if (origin) fields.originKind = origin;

  if (type === 'system' && subtype === 'session_state_changed') {
    const state = readString(envelope, 'state');
    if (state) fields.sessionState = state;
  }
  if (type === 'system' && subtype?.startsWith('task_')) {
    const patch = readField(envelope, 'patch');
    const taskType =
      readField(envelope, 'task_type') ?? readField(patch, 'task_type');
    if (typeof taskType === 'string')
      fields.taskType = normalizedTaskType(taskType);
    for (const [wire, semantic] of [
      ['is_backgrounded', 'isBackgrounded'],
      ['ambient', 'ambient'],
    ] as const) {
      const direct = readField(envelope, wire);
      const value = direct !== undefined ? direct : readField(patch, wire);
      if (typeof value === 'boolean' || value === null)
        fields[semantic] = value;
    }
    const workflowName =
      readField(envelope, 'workflow_name') ?? readField(patch, 'workflow_name');
    if (typeof workflowName === 'string') fields.workflowName = workflowName;
    const phase = readField(envelope, 'contract_workflow_phase');
    if (typeof phase === 'string' || phase === null)
      fields.workflowPhase = phase;
  }
  if (
    type === 'system' &&
    ['task_notification', 'task_progress', 'task_updated'].includes(
      subtype ?? '',
    )
  ) {
    const status =
      readString(envelope, 'status') ??
      readString(readField(envelope, 'patch'), 'status');
    if (status) fields.taskStatus = status;
  }
  if (type === 'system' && subtype === 'background_tasks_changed') {
    const tasks = readField(envelope, 'tasks');
    if (Array.isArray(tasks)) {
      fields.backgroundMembersSet = tasks
        .map((task) => readString(task, 'task_id'))
        .filter((taskId): taskId is string => taskId !== undefined)
        .map((taskId) => bindings.aliasFor('task', taskId))
        .sort();
    }
  }
  const willRetry = readField(envelope, 'will_retry');
  if (typeof willRetry === 'boolean') fields.willRetry = willRetry;
  const hasError =
    readField(envelope, 'error') !== undefined ||
    subtype === 'mirror_error' ||
    (type === 'result' && subtype?.startsWith('error_') === true);
  if (hasError) fields.errorClass = 'other';
  if (type === 'stream_event') {
    const shape = contentShape(envelope);
    if (
      shape?.some((part) =>
        ['text_delta', 'thinking_delta', 'input_json_delta'].includes(part),
      )
    )
      fields.segment = true;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function idsProjection(
  frame: LifecycleFrame,
  envelope: ClaudeReplayEnvelope,
  bindings: ClaudeReplayBindings,
): LifecycleIds | undefined {
  const actual = idsForFrame(envelope);
  if (!actual) return undefined;
  const projected: LifecycleIds = {};
  for (const kind of ID_KINDS) {
    const value = actual[kind];
    if (value === undefined) continue;
    const preferred = frame.ids?.[kind];
    projected[kind] = bindings.aliasFor(kind, value, preferred);
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function consumedProjection(
  frame: LifecycleFrame,
  envelope: ClaudeReplayEnvelope,
  bindings: ClaudeReplayBindings,
): string[] | undefined {
  const singular = readString(envelope, 'user_message_uuid');
  const uuids =
    readStringArray(readField(envelope, 'user_message_uuids')) ??
    (singular === undefined ? undefined : [singular]);
  if (!uuids || uuids.length === 0) return undefined;
  return uuids.map((uuid, index) =>
    bindings.aliasFor('message', uuid, frame.consumed?.[index]),
  );
}

function observeClaudeEnvelope(
  frame: LifecycleFrame,
  envelope: ClaudeReplayEnvelope,
  bindings: ClaudeReplayBindings,
): LifecycleFrameObservation {
  const observation: LifecycleFrameObservation = {
    lane: 'root',
    type: traceLabel(envelope),
  };
  const parentToolUseId = readString(envelope, 'parent_tool_use_id');
  if (parentToolUseId) {
    const preferred = frame.lane.startsWith('child:')
      ? frame.lane.slice('child:'.length)
      : undefined;
    observation.lane = `child:${bindings.aliasFor('toolUse', parentToolUseId, preferred)}`;
  }
  const shape = contentShape(envelope);
  if (shape !== undefined && shape.length > 0) observation.shape = shape;
  const ids = idsProjection(frame, envelope, bindings);
  if (ids) observation.ids = ids;
  const consumed = consumedProjection(frame, envelope, bindings);
  if (consumed) observation.consumed = consumed;
  const fields = fieldProjection(envelope, bindings);
  if (fields) observation.fields = fields;
  return observation;
}

function consumedAliases(frame: LifecycleFrame): readonly string[] | undefined {
  return frame.consumed;
}

function laneAlias(frame: LifecycleFrame): string | undefined {
  return frame.lane.startsWith('child:')
    ? frame.lane.slice('child:'.length)
    : undefined;
}

function laneParentToolUseId(
  frame: LifecycleFrame,
  bindings: ClaudeReplayBindings,
): string | null {
  const alias = laneAlias(frame);
  return alias ? bindings.resolve('toolUse', alias) : null;
}

function betaStopReason(
  frame: LifecycleFrame,
  fallback: BetaMessage['stop_reason'],
): BetaMessage['stop_reason'] {
  const value = nullableStringField(frame, 'stopReason', fallback);
  if (value === null) return null;
  return validateChoice(
    value,
    ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'] as const,
    'stop reason',
  );
}

function contentBlockKinds(frame: LifecycleFrame, fallback?: string): string[] {
  if (frame.shape !== undefined) return frame.shape;
  return fallback ? [fallback] : [];
}

function assistantContent(
  frame: LifecycleFrame,
  ids: ClaudeReplayBindings,
  fallbackBlock?: string,
): BetaMessage['content'] {
  const content: BetaMessage['content'] = [];
  const toolUseId = ids.resolve('toolUse', frame.ids?.toolUse);
  const kinds = contentBlockKinds(frame, fallbackBlock);
  for (const kind of kinds) {
    switch (kind) {
      case 'text':
        content.push({
          type: 'text',
          text: stringField(frame, 'text', 'Synthetic Claude replay text'),
          citations: null,
        });
        break;
      case 'thinking':
        content.push({
          type: 'thinking',
          thinking: stringField(frame, 'thinking', 'Synthetic replay thinking'),
          signature: 'synthetic-replay-signature',
        });
        break;
      case 'tool_use':
        content.push({
          type: 'tool_use',
          id: toolUseId,
          name: stringField(frame, 'name', 'replay_tool'),
          input: {},
        });
        break;
      default:
        throw new Error(`Unsupported Claude assistant content shape: ${kind}`);
    }
  }
  return content;
}

function userContent(
  frame: LifecycleFrame,
  bindings: ClaudeReplayBindings,
): SDKUserMessage['message']['content'] {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_result'; tool_use_id: string; content: string }
  > = [];
  if (!Array.isArray(content)) return content;
  const kinds =
    frame.shape ??
    (frame.template.endsWith('.tool_result') ? ['tool_result'] : []);
  for (const kind of kinds) {
    if (kind === 'tool_result') {
      content.push({
        type: 'tool_result',
        tool_use_id: bindings.resolve('toolUse', frame.ids?.toolUse),
        content: 'Synthetic Claude replay tool result',
      });
    } else if (kind === 'text') {
      content.push({
        type: 'text',
        text: stringField(frame, 'text', 'Synthetic Claude replay user text'),
      });
    } else {
      throw new Error(`Unsupported Claude user content shape: ${kind}`);
    }
  }
  return content;
}

function hasContentId(envelope: ClaudeReplayEnvelope): boolean {
  return readString(envelope, 'type') === 'result';
}

export class ClaudeFixtureReplay implements LifecycleReplayDriver {
  private readonly aliases: ClaudeReplayBindings;
  private readonly inputQueue = new ReplayInputQueue();
  private disposed = false;

  constructor(private readonly transport: ClaudeReplayTransport) {
    this.aliases = new ClaudeReplayBindings(transport.sessionId, () =>
      transport.currentTurnKey(),
    );
  }

  /** Called by the scripted query pump as it consumes a real SDK user input. */
  acceptInput(input: ClaudeReplayInput): void {
    if (this.disposed) return;
    this.inputQueue.push(input);
  }

  liveId(kind: keyof LifecycleIds, alias: string): string | undefined {
    return this.aliases.lookup(kind, alias);
  }

  async emit(frame: LifecycleFrame): Promise<void> {
    this.assertLive();
    const envelope = await buildClaudeEnvelope(frame, this.aliases);
    for (const [semantic, wire] of [
      ['terminalReason', 'terminal_reason'],
      ['resultIndex', 'result_index'],
    ] satisfies [string, string][]) {
      if (Object.hasOwn(frame.fields ?? {}, semantic))
        Reflect.set(envelope, wire, frame.fields?.[semantic]);
    }
    if (Object.hasOwn(frame.fields ?? {}, 'originKind'))
      Reflect.set(envelope, 'origin', { kind: frame.fields?.originKind });
    if (
      frame.type === 'sdk:user' &&
      Object.hasOwn(frame.fields ?? {}, 'resultSubtype')
    )
      Reflect.set(envelope, 'tool_use_result', {
        status: frame.fields?.resultSubtype,
      });
    if (frame.type.startsWith('sdk:system:task_')) {
      const destination =
        frame.type === 'sdk:system:task_updated'
          ? readField(envelope, 'patch')
          : envelope;
      if (typeof destination !== 'object' || destination === null)
        throw new Error('Task replay omitted its patch envelope');
      for (const [semantic, wire] of [
        ['taskType', 'task_type'],
        ['isBackgrounded', 'is_backgrounded'],
        ['ambient', 'ambient'],
        ['workflowName', 'workflow_name'],
      ] as const) {
        if (Object.hasOwn(frame.fields ?? {}, semantic))
          Reflect.set(destination, wire, frame.fields?.[semantic]);
      }
      if (Object.hasOwn(frame.fields ?? {}, 'workflowPhase'))
        Reflect.set(
          envelope,
          'contract_workflow_phase',
          frame.fields?.workflowPhase,
        );
    }
    const observation = observeClaudeEnvelope(frame, envelope, this.aliases);
    const turnKey = this.transport.currentTurnKey();
    await this.transport.emit(envelope, observation, turnKey);
  }

  async acceptControl(control: LifecycleControl): Promise<void> {
    if (
      ['interrupt', 'stop-task', 'release', 'start-turn'].includes(
        control.action,
      )
    )
      return;
    this.assertLive();
    if (control.action !== 'send' && control.action !== 'steer')
      throw new Error(
        `Claude fixture replay cannot bind ${control.action}; only send and steer are supported`,
      );
    const input = await this.inputQueue.take(control.action);
    this.aliases.bindInput(control, input);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.aliases.dispose();
    this.inputQueue.close(new Error('Claude fixture replay was disposed'));
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Claude fixture replay was disposed');
  }
}

async function buildClaudeEnvelope(
  frame: LifecycleFrame,
  ids: ClaudeReplayBindings,
): Promise<ClaudeReplayEnvelope> {
  const kind = frameKind(frame);
  const sessionId = ids.resolve('session', frame.ids?.session);
  const messageUuid =
    kind.type === 'command_lifecycle' && frame.ids?.message
      ? await ids.resolveConsumed(frame.ids.message)
      : ids.resolveUuid('message', frame.ids?.message);
  const consumed = consumedAliases(frame);

  if (kind.type === 'command_lifecycle') {
    return {
      type: 'command_lifecycle',
      command_uuid: messageUuid,
      ...(frame.ids?.session ? { session_id: sessionId } : {}),
      state: validateChoice(
        stringField(frame, 'commandState', 'started'),
        ['queued', 'started', 'completed', 'cancelled'] as const,
        'command lifecycle state',
      ),
    } satisfies ClaudeCommandLifecycleFrame;
  }

  if (kind.type === 'stream_event') {
    const eventKind = frame.shape?.[0] ?? 'message_stop';
    let event: SDKPartialAssistantMessage['event'];
    if (eventKind === 'message_stop') event = { type: 'message_stop' };
    else if (eventKind === 'message_start')
      event = {
        type: 'message_start',
        message: {
          id: messageUuid,
          type: 'message',
          container: null,
          context_management: null,
          diagnostics: null,
          stop_details: null,
          role: 'assistant',
          model: 'scripted-claude',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: emptyUsage(),
        },
      };
    else if (eventKind === 'message_delta')
      event = {
        type: 'message_delta',
        context_management: null,
        delta: {
          container: null,
          stop_details: null,
          stop_reason: betaStopReason(frame, 'end_turn'),
          stop_sequence: null,
        },
        usage: emptyUsage(),
      };
    else if (eventKind === 'content_block_stop')
      event = { type: 'content_block_stop', index: 0 };
    else if (eventKind === 'content_block_start') {
      const blockKind = frame.shape?.[1] ?? 'text';
      if (blockKind === 'tool_use')
        event = {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: ids.resolve('toolUse', frame.ids?.toolUse),
            name: 'Agent',
            input: {},
          },
        };
      else if (blockKind === 'thinking')
        event = {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'thinking',
            thinking: 'Synthetic thinking',
            signature: 'synthetic',
          },
        };
      else if (blockKind === 'text')
        event = {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'text',
            text: 'Synthetic Claude replay text',
            citations: null,
          },
        };
      else throw new Error(`Unsupported Claude stream block: ${blockKind}`);
    } else if (eventKind === 'content_block_delta') {
      const deltaKind = frame.shape?.[1] ?? 'text_delta';
      if (deltaKind === 'input_json_delta')
        event = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        };
      else if (deltaKind === 'thinking_delta')
        event = {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: 'Synthetic thinking',
            estimated_tokens: null,
          },
        };
      else if (deltaKind === 'text_delta')
        event = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Synthetic Claude replay delta' },
        };
      else throw new Error(`Unsupported Claude stream delta: ${deltaKind}`);
    } else
      throw new Error(`Unsupported Claude stream event shape: ${eventKind}`);
    const envelope: SDKPartialAssistantMessage = {
      type: 'stream_event',
      event,
      parent_tool_use_id: laneParentToolUseId(frame, ids),
      uuid: messageUuid,
      session_id: sessionId,
    };
    await addConsumedIds(envelope, consumed, ids);
    return envelope;
  }

  if (kind.type === 'assistant') {
    const block =
      frame.shape?.[0] ??
      kind.assistantBlock ??
      (frame.template.endsWith('.thinking')
        ? 'thinking'
        : frame.template.endsWith('.tool_use')
          ? 'tool_use'
          : frame.template.endsWith('.text')
            ? 'text'
            : undefined);
    const envelope: SDKAssistantMessage = {
      type: 'assistant',
      message: {
        id: messageUuid,
        type: 'message',
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        role: 'assistant',
        model: stringField(frame, 'model', 'scripted-claude'),
        content: assistantContent(frame, ids, block),
        stop_reason: betaStopReason(frame, null),
        stop_sequence: nullableStringField(frame, 'stop_sequence', null),
        usage: emptyUsage(),
      },
      parent_tool_use_id: laneParentToolUseId(frame, ids),
      uuid: messageUuid,
      session_id: sessionId,
      ...(included(frame, 'request_id')
        ? { request_id: ids.resolve('request', frame.ids?.request) }
        : {}),
    };
    copyDirectFields(
      envelope,
      frame,
      new Set([
        'user_message_uuid',
        'user_message_uuids',
        'resume_reason',
        'aborted',
        'timestamp',
        'subagent_type',
        'task_description',
      ]),
    );
    await addConsumedIds(envelope, consumed, ids);
    return envelope;
  }

  if (kind.type === 'result') {
    const subtype = kind.subtype ?? stringField(frame, 'subtype', 'success');
    if (subtype === 'success') {
      const envelope: SDKResultSuccess = {
        type: 'result',
        subtype: 'success',
        duration_ms: numberField(frame, 'duration_ms', 0),
        duration_api_ms: numberField(frame, 'duration_api_ms', 0),
        is_error: booleanField(frame, 'isError', false),
        num_turns: numberField(frame, 'num_turns', 1),
        result: stringField(frame, 'result', 'Synthetic Claude replay result'),
        stop_reason: nullableStringField(frame, 'stopReason', 'end_turn'),
        total_cost_usd: numberField(frame, 'total_cost_usd', 0),
        usage: emptyUsage(),
        modelUsage: {},
        permission_denials: [],
        queued_turn_count: numberField(frame, 'queued_turn_count', 0),
        uuid: messageUuid,
        session_id: sessionId,
      };
      copyDirectFields(
        envelope,
        frame,
        new Set([
          'ttft_ms',
          'ttft_stream_ms',
          'time_to_request_ms',
          'user_message_uuid',
          'user_message_uuids',
          'resume_reason',
          'local_command',
        ]),
      );
      await addConsumedIds(envelope, consumed, ids);
      return envelope;
    }
    const errorSubtype = resultErrorSubtype(subtype);
    const envelope: SDKResultError = {
      type: 'result',
      subtype: errorSubtype,
      duration_ms: numberField(frame, 'duration_ms', 0),
      duration_api_ms: numberField(frame, 'duration_api_ms', 0),
      is_error: booleanField(frame, 'isError', true),
      num_turns: numberField(frame, 'num_turns', 1),
      stop_reason: nullableStringField(frame, 'stopReason', 'error'),
      total_cost_usd: numberField(frame, 'total_cost_usd', 0),
      usage: emptyUsage(),
      modelUsage: {},
      permission_denials: [],
      errors: ['Synthetic Claude replay error'],
      uuid: messageUuid,
      session_id: sessionId,
    };
    copyDirectFields(
      envelope,
      frame,
      new Set(['user_message_uuid', 'user_message_uuids', 'resume_reason']),
    );
    await addConsumedIds(envelope, consumed, ids);
    return envelope;
  }

  if (kind.type === 'user') {
    const content = userContent(frame, ids);
    if (kind.subtype === 'replay' || frame.template.endsWith('.replay')) {
      const envelope: SDKUserMessageReplay = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: laneParentToolUseId(frame, ids),
        uuid: messageUuid,
        session_id: sessionId,
        isReplay: true,
      };
      return envelope;
    }
    const envelope: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: laneParentToolUseId(frame, ids),
      uuid: messageUuid,
      session_id: sessionId,
    };
    copyDirectFields(
      envelope,
      frame,
      new Set(['priority', 'shouldQuery', 'client_composed']),
    );
    return envelope;
  }

  if (kind.type === 'tool_progress') {
    return {
      type: 'tool_progress',
      tool_use_id: ids.resolve('toolUse', frame.ids?.toolUse),
      tool_name: 'Bash',
      parent_tool_use_id: laneParentToolUseId(frame, ids),
      elapsed_time_seconds: 1,
      ...(frame.ids?.task
        ? { task_id: ids.resolve('task', frame.ids.task) }
        : {}),
      uuid: messageUuid,
      session_id: sessionId,
    } satisfies SDKToolProgressMessage;
  }

  if (kind.type !== 'system')
    throw new Error(
      `Unsupported Claude replay SDK message family: ${kind.type}`,
    );

  const subtype = kind.subtype ?? stringField(frame, 'subtype', 'init');
  assertSubtype(frame, subtype);

  if (subtype === 'compact_boundary') {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 0 },
      uuid: messageUuid,
      session_id: sessionId,
    } satisfies SDKCompactBoundaryMessage;
  }

  if (subtype === 'init') {
    // Claude Code 2.1.310 tags a queued prompt's init with its ids, as status.
    const envelope: SDKSystemMessage & {
      user_message_uuid?: string;
      user_message_uuids?: string[];
    } = {
      type: 'system',
      subtype: 'init',
      apiKeySource: apiKeySource(frame),
      claude_code_version: stringField(
        frame,
        'claude_code_version',
        'scripted',
      ),
      cwd: stringField(frame, 'cwd', ''),
      tools: stringArrayField(frame, 'tools'),
      mcp_servers: [],
      model: stringField(frame, 'model', 'scripted-claude'),
      permissionMode: permissionMode(frame),
      slash_commands: stringArrayField(frame, 'slash_commands'),
      output_style: stringField(frame, 'output_style', 'default'),
      skills: stringArrayField(frame, 'skills'),
      plugins: [],
      // Match the pinned transport's input-receipt negotiation. These are
      // protocol capabilities, not recorded user content or automatic frames.
      capabilities: [
        'msg_lifecycle_v1',
        'interrupt_receipt_v1',
        'interrupt_cancel_queued_v1',
      ],
      uuid: messageUuid,
      session_id: sessionId,
    };
    if (included(frame, 'capabilities'))
      envelope.capabilities = stringArrayField(frame, 'capabilities');
    if (included(frame, 'agents'))
      envelope.agents = stringArrayField(frame, 'agents');
    if (included(frame, 'betas'))
      envelope.betas = stringArrayField(frame, 'betas');
    if (included(frame, 'effort')) {
      const effort = nullableStringField(frame, 'effort', null);
      if (effort !== null)
        envelope.effort = validateChoice(
          effort,
          ['low', 'medium', 'high', 'max'] as const,
          'effort',
        );
    }
    if (included(frame, 'view_mode')) {
      const viewMode = stringField(frame, 'view_mode', 'default');
      if (viewMode !== 'focus' && viewMode !== 'default')
        throw new Error(`Unsupported Claude replay view_mode: ${viewMode}`);
      envelope.view_mode = viewMode;
    }
    await addConsumedIds(envelope, consumed, ids);
    return envelope;
  }

  if (subtype === 'status') {
    const status = nullableStringField(frame, 'status', null);
    if (status !== null && status !== 'compacting' && status !== 'requesting')
      throw new Error(`Unsupported Claude replay status: ${status}`);
    // The CLI tags the status that picks up a queued prompt with its ids; the SDK type omits them.
    const envelope: SDKStatusMessage & {
      user_message_uuid?: string;
      user_message_uuids?: string[];
    } = {
      type: 'system',
      subtype: 'status',
      status,
      uuid: messageUuid,
      session_id: sessionId,
    };
    copyDirectFields(
      envelope,
      frame,
      new Set(['permissionMode', 'compact_result', 'compact_error']),
    );
    await addConsumedIds(envelope, consumed, ids);
    return envelope;
  }

  if (subtype === 'task_started') {
    const envelope: SDKTaskStartedMessage = {
      type: 'system',
      subtype: 'task_started',
      task_id: ids.resolve('task', frame.ids?.task),
      description: stringField(frame, 'description', 'Synthetic task started'),
      uuid: messageUuid,
      session_id: sessionId,
    };
    if (frame.ids?.toolUse)
      envelope.tool_use_id = ids.resolve('toolUse', frame.ids.toolUse);
    if (typeof frame.fields?.taskType === 'string')
      envelope.task_type = frame.fields.taskType;
    if (typeof frame.fields?.isBackgrounded === 'boolean')
      envelope.is_backgrounded = frame.fields.isBackgrounded;
    copyDirectFields(
      envelope,
      frame,
      new Set([
        'subagent_type',
        'is_backgrounded',
        'spawn_depth',
        'task_type',
        'workflow_name',
        'prompt',
        'skip_transcript',
        'ambient',
      ]),
    );
    return envelope;
  }

  if (subtype === 'task_notification') {
    const status = validateChoice(
      stringField(frame, 'taskStatus', 'completed'),
      TASK_TERMINAL_STATUSES,
      'task status',
    );
    const envelope: SDKTaskNotificationMessage = {
      type: 'system',
      subtype: 'task_notification',
      task_id: ids.resolve('task', frame.ids?.task),
      status,
      output_file: 'synthetic-replay-output.txt',
      summary: 'Synthetic Claude replay task complete',
      uuid: messageUuid,
      session_id: sessionId,
    };
    if (frame.ids?.toolUse)
      envelope.tool_use_id = ids.resolve('toolUse', frame.ids.toolUse);
    copyDirectFields(
      envelope,
      frame,
      new Set(['reason', 'skip_transcript', 'ambient']),
    );
    return envelope;
  }

  if (subtype === 'task_updated') {
    const status = fieldValue(frame, 'taskStatus');
    const patch: SDKTaskUpdatedMessage['patch'] = {};
    if (typeof status === 'string') {
      patch.status = validateChoice(
        status,
        [
          'pending',
          'running',
          'completed',
          'failed',
          'killed',
          'paused',
        ] as const,
        'task update status',
      );
    }
    const envelope: SDKTaskUpdatedMessage = {
      type: 'system',
      subtype: 'task_updated',
      task_id: ids.resolve('task', frame.ids?.task),
      patch,
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'task_progress') {
    const envelope: SDKTaskProgressMessage = {
      type: 'system',
      subtype: 'task_progress',
      task_id: ids.resolve('task', frame.ids?.task),
      description: stringField(frame, 'description', 'Synthetic task progress'),
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
      uuid: messageUuid,
      session_id: sessionId,
    };
    if (frame.ids?.toolUse)
      envelope.tool_use_id = ids.resolve('toolUse', frame.ids.toolUse);
    copyDirectFields(
      envelope,
      frame,
      new Set(['subagent_type', 'last_tool_name', 'summary']),
    );
    return envelope;
  }

  if (subtype === 'background_tasks_changed') {
    const envelope: SDKBackgroundTasksChangedMessage = {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: Array.isArray(frame.fields?.backgroundMembersSet)
        ? frame.fields.backgroundMembersSet
            .filter((value): value is string => typeof value === 'string')
            .map((alias) => ({
              task_id: ids.resolve('task', alias),
              task_type: 'local_agent',
              description: 'Synthetic background task',
            }))
        : [],
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'thinking_tokens') {
    const envelope: SDKThinkingTokensMessage = {
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: numberField(frame, 'estimated_tokens', 0),
      estimated_tokens_delta: numberField(frame, 'estimated_tokens_delta', 0),
      uuid: messageUuid,
      session_id: sessionId,
    };
    if (consumed?.length) {
      envelope.user_message_uuid = await ids.resolveConsumed(
        consumed.at(-1) ?? '',
      );
    }
    return envelope;
  }

  if (subtype === 'session_state_changed') {
    const state = validateChoice(
      stringField(frame, 'state', 'running'),
      ['idle', 'running', 'requires_action'] as const,
      'session state',
    );
    const envelope: SDKSessionStateChangedMessage = {
      type: 'system',
      subtype: 'session_state_changed',
      state,
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'api_retry') {
    const error = validateChoice(
      stringField(frame, 'error', 'unknown'),
      [
        'authentication_failed',
        'oauth_org_not_allowed',
        'account_on_hold',
        'verification_required',
        'billing_error',
        'rate_limit',
        'overloaded',
        'invalid_request',
        'model_not_found',
        'server_error',
        'unknown',
        'max_output_tokens',
        'cloud_credential_error',
      ] as const,
      'api retry error',
    );
    const envelope: SDKAPIRetryMessage = {
      type: 'system',
      subtype: 'api_retry',
      attempt: numberField(frame, 'attempt', 1),
      max_retries: numberField(frame, 'max_retries', 1),
      retry_delay_ms: numberField(frame, 'retry_delay_ms', 0),
      error_status: nullableNumberField(frame, 'error_status', null),
      error,
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'permission_denied') {
    const envelope: SDKPermissionDeniedMessage = {
      type: 'system',
      subtype: 'permission_denied',
      message: 'Synthetic permission denial',
      tool_name: stringField(frame, 'tool_name', 'replay_tool'),
      tool_use_id: ids.resolve(
        'toolUse',
        frame.ids?.toolUse ?? frame.ids?.call,
      ),
      uuid: messageUuid,
      session_id: sessionId,
    };
    copyDirectFields(
      envelope,
      frame,
      new Set(['agent_id', 'decision_reason_type', 'decision_reason']),
    );
    return envelope;
  }

  if (subtype === 'notification') {
    const envelope: SDKNotificationMessage = {
      type: 'system',
      subtype: 'notification',
      key: 'synthetic-replay',
      text: 'Synthetic Claude replay notification',
      priority: validateChoice(
        stringField(frame, 'priority', 'low'),
        ['low', 'medium', 'high', 'immediate'] as const,
        'notification priority',
      ),
      uuid: messageUuid,
      session_id: sessionId,
    };
    copyDirectFields(envelope, frame, new Set(['color', 'timeout_ms']));
    return envelope;
  }

  if (subtype === 'worker_shutting_down') {
    const envelope: SDKWorkerShuttingDownMessage = {
      type: 'system',
      subtype: 'worker_shutting_down',
      reason: stringField(frame, 'reason', 'host_exit'),
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'informational') {
    const envelope: SDKInformationalMessage = {
      type: 'system',
      subtype: 'informational',
      content: 'Synthetic Claude replay information',
      level: validateChoice(
        stringField(frame, 'level', 'info'),
        ['info', 'notice', 'suggestion', 'warning'] as const,
        'informational level',
      ),
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'hook_started') {
    const envelope: SDKHookStartedMessage = {
      type: 'system',
      subtype: 'hook_started',
      hook_id: ids.resolve('call', frame.ids?.call),
      hook_name: 'replay_hook',
      hook_event: 'PreToolUse',
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'hook_progress') {
    const envelope: SDKHookProgressMessage = {
      type: 'system',
      subtype: 'hook_progress',
      hook_id: ids.resolve('call', frame.ids?.call),
      hook_name: 'replay_hook',
      hook_event: 'PreToolUse',
      stdout: '',
      stderr: '',
      output: '',
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (subtype === 'hook_response') {
    const envelope: SDKHookResponseMessage = {
      type: 'system',
      subtype: 'hook_response',
      hook_id: ids.resolve('call', frame.ids?.call),
      hook_name: 'replay_hook',
      hook_event: 'PreToolUse',
      output: '',
      stdout: '',
      stderr: '',
      outcome: validateChoice(
        stringField(frame, 'outcome', 'success'),
        ['success', 'error', 'cancelled'] as const,
        'hook outcome',
      ),
      uuid: messageUuid,
      session_id: sessionId,
    };
    return envelope;
  }

  if (kind.subtype === undefined)
    throw new Error(`Claude system replay frame has no subtype: ${frame.type}`);
  throw new Error(`Unsupported Claude system replay subtype: ${subtype}`);
}

function isTerminal(envelope: ClaudeReplayEnvelope): boolean {
  return hasContentId(envelope);
}

export function isClaudeReplayTerminal(
  envelope: ClaudeReplayEnvelope,
): boolean {
  return isTerminal(envelope);
}

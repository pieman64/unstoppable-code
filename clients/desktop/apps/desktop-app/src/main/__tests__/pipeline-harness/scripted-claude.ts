/**
 * Test-only Claude SDK stream for the provider pipeline harness.
 *
 * `createScriptedClaude(recorder, { target })` creates one Claude driver for
 * one explicitly-bound chat. Pass that driver to
 * `claudeSdkModuleMock(driver)` from the caller's `jest.mock` factory; this
 * module deliberately does not call `jest.mock` itself. The mock intercepts
 * only the SDK boundary: production Claude sessions and the session manager
 * remain real.
 *
 * The async prompt iterator is consumed as an SDK would consume it. The first
 * yielded user message starts a scripted turn, later user messages before its
 * result are steering frames, and the negotiated init advertises the receipt
 * capabilities used by Claude's input-delivery path. Script waits are bounded
 * and identify the turn/operation that timed out.
 */
import { randomUUID } from 'node:crypto';
import type {
  Query as ClaudeSdkQuery,
  query as claudeQuery,
  SDKAssistantMessage,
  NonNullableUsage,
  SDKBackgroundTasksChangedMessage,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  PipelineChatTarget,
  PipelineTraceInput,
  PipelineTraceRecorder,
  ProviderFrameIds,
  LifecycleFixture,
  LifecycleReplayDriver,
  ScriptedProviderDriver,
  ScriptedProviderTurn,
  ScriptedSteer,
} from './contracts';
import {
  ClaudeFixtureReplay,
  isClaudeReplayTerminal,
} from './fixture-replay-claude';

type ClaudeQueryParams = Parameters<typeof claudeQuery>[0];
interface ClaudePromptIterator {
  next(): Promise<IteratorResult<SDKUserMessage, void>>;
  return(): Promise<IteratorResult<SDKUserMessage, void>>;
}

interface CommandLifecycleFrame {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled';
}

type ClaudeSdkStream = AsyncGenerator<
  SDKMessage | CommandLifecycleFrame,
  void,
  unknown
>;

/**
 * Query's public stream type omits Claude's private command_lifecycle receipt
 * extension. This test mock keeps that extension narrow and cast-free while
 * retaining the actual SDK Query control methods used by ClaudeSession.
 */
type ClaudeQueryControls = Pick<
  ClaudeSdkQuery,
  | 'setModel'
  | 'setPermissionMode'
  | 'setMcpPermissionModeOverride'
  | 'setMaxThinkingTokens'
  | 'applyFlagSettings'
  | 'stopTask'
  | 'getContextUsage'
>;

type ClaudeScriptedQuery = ClaudeQueryControls &
  ClaudeSdkStream & {
    cancelAsyncMessage(messageUuid: string): Promise<{ cancelled: boolean }>;
    interrupt(options?: { cancelQueued?: boolean }): Promise<{
      cancelled: string[];
      still_queued: string[];
    }>;
  };

/** Full SDK usage object so additions to the installed SDK surface are checked. */
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

interface QueueWaiter<T> {
  resolve(value: IteratorResult<T, void>): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A closable queue with cancellable, timed reads. Both SDK stream reads and
 * script-facing `take` calls have explicit upper-bounded deadlines.
 */
class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private ended = false;
  private closeError: Error | undefined;

  get isClosed(): boolean {
    return this.ended;
  }

  push(value: T): boolean {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
    return true;
  }

  next(): Promise<IteratorResult<T, void>> {
    return this.read(
      MAX_WAIT_TIMEOUT_MS,
      'waiting for a Claude scripted SDK frame',
    );
  }

  async take(timeoutMs: number, description: string): Promise<T> {
    const result = await this.read(timeoutMs, description);
    if (result.done === true)
      throw this.closeError ?? new Error(`${description}: queue closed`);
    return result.value;
  }

  close(error?: Error, discardQueued = false): void {
    if (this.ended) return;
    this.ended = true;
    this.closeError = error;
    if (discardQueued) this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  private read(
    timeoutMs?: number,
    description = 'Claude scripted stream',
  ): Promise<IteratorResult<T, void>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) {
      if (this.closeError) return Promise.reject(this.closeError);
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      const waiter: QueueWaiter<T> = { resolve, reject };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`${description} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }
}

interface HoldGate {
  promise: Promise<void>;
  release(): void;
}

interface InterruptReceiptGate extends HoldGate {
  entered: Promise<void>;
  markEntered(): void;
}

function createHoldGate(): HoldGate {
  let resolveGate = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  return { promise, release: resolveGate };
}

function createInterruptReceiptGate(): InterruptReceiptGate {
  const hold = createHoldGate();
  let resolveEntered = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  return { ...hold, entered, markEntered: resolveEntered };
}

export interface ScriptedClaudeInterruptReceiptHold {
  /** Resolves when a real Query.interrupt call reaches its SDK response gate. */
  entered: Promise<void>;
  /** Releases the pending SDK interrupt receipt. Safe to call repeatedly. */
  release(): void;
}

export interface ScriptedClaudeResultObservation {
  turnKey: string;
  subtype?: string;
  terminalReason?: string;
}

export interface ScriptedClaudeAssistantCorrelationObservation {
  turnKey: string;
  assistantMessageId?: string;
  userMessageUuid?: string;
  userMessageUuids: readonly string[];
}

interface NativeTaskState {
  taskId: string;
  toolUseId: string;
  kind: 'agent' | 'shell' | 'monitor' | 'workflow';
  turn: ClaudeTurn;
  description: string;
  taskType: string;
}

interface InterruptNotice {
  turnKey?: string;
}

const DEFAULT_WAIT_TIMEOUT_MS = 3_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const HOLD_TIMEOUT_MS = 3_000;
const RECEIPT_CAPABILITIES = [
  'msg_lifecycle_v1',
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
];

type PromptIteratorRead =
  | {
      kind: 'input';
      result: IteratorResult<SDKUserMessage, void>;
    }
  | { kind: 'closed' };

function validateTimeout(
  timeoutMs: number | undefined,
  description: string,
): number {
  const resolved = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_WAIT_TIMEOUT_MS
  )
    throw new Error(
      `${description} timeout must be an integer from 1 to ${MAX_WAIT_TIMEOUT_MS}ms`,
    );
  return resolved;
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createPromptIterator(
  prompt: AsyncIterable<SDKUserMessage>,
  closeSignal: Promise<void>,
): ClaudePromptIterator {
  const iterator = prompt[Symbol.asyncIterator]();
  return {
    async next(): Promise<IteratorResult<SDKUserMessage, void>> {
      const inputRead = iterator.next().then<PromptIteratorRead>((result) => {
        if (result.done === true)
          return {
            kind: 'input',
            result: { done: true, value: undefined },
          };
        return {
          kind: 'input',
          result: { done: false, value: result.value },
        };
      });
      const closeRead = closeSignal.then<PromptIteratorRead>(() => ({
        kind: 'closed',
      }));
      const read = await withTimeout(
        Promise.race([inputRead, closeRead]),
        MAX_WAIT_TIMEOUT_MS,
        'waiting for Claude prompt input or query teardown',
      );
      if (read.kind === 'closed') return { done: true, value: undefined };
      return read.result;
    },
    return(): Promise<IteratorResult<SDKUserMessage, void>> {
      if (iterator.return)
        void Promise.resolve(iterator.return()).catch(() => undefined);
      return Promise.resolve({ done: true, value: undefined });
    },
  };
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, field);
}

function readString(value: unknown, field: string): string | undefined {
  const candidate = readField(value, field);
  return typeof candidate === 'string' ? candidate : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block: unknown) => readString(block, 'text'))
    .filter((text): text is string => text !== undefined)
    .join('\n\n');
}

function idsForFrame(value: unknown): ProviderFrameIds | undefined {
  const ids: ProviderFrameIds = {};
  const messageUuid =
    readString(value, 'uuid') ?? readString(value, 'command_uuid');
  const callId = readString(value, 'call_id');
  const requestId = readString(value, 'request_id');
  const taskId = readString(value, 'task_id');
  const directToolUseId = readString(value, 'tool_use_id');
  if (messageUuid) ids.messageUuid = messageUuid;
  if (callId) ids.callId = callId;
  if (requestId) ids.requestId = requestId;
  if (taskId) ids.taskId = taskId;
  const frameType = readString(value, 'type');
  const frameSubtype = readString(value, 'subtype');
  if (
    directToolUseId &&
    frameType === 'system' &&
    (frameSubtype === 'task_started' || frameSubtype === 'task_notification')
  )
    ids.toolUseId = directToolUseId;

  const message = readField(value, 'message');
  const content = readField(message, 'content');
  if (Array.isArray(content)) {
    for (let index = 0; index < content.length; index += 1) {
      const block = readField(content, String(index));
      const blockType = readString(block, 'type');
      if (blockType === 'tool_use') {
        const toolUseId = readString(block, 'id');
        if (toolUseId) ids.callId = toolUseId;
      } else if (blockType === 'tool_result') {
        const resultCallId = readString(block, 'tool_use_id');
        if (resultCallId) ids.callId = resultCallId;
      }
    }
  }

  if (
    ids.messageUuid === undefined &&
    ids.callId === undefined &&
    ids.requestId === undefined &&
    ids.taskId === undefined &&
    ids.toolUseId === undefined
  )
    return undefined;
  return ids;
}

function extractPromptText(frame: unknown): string {
  return extractText(readField(readField(frame, 'message'), 'content'));
}

function taskTypeFor(kind: NativeTaskState['kind']): string {
  switch (kind) {
    case 'agent':
      return 'local_agent';
    case 'shell':
      return 'local_bash';
    case 'monitor':
      return 'monitor';
    case 'workflow':
      return 'local_workflow';
  }
}

class ClaudeSteer implements ScriptedSteer {
  readonly ids: ProviderFrameIds;
  private state:
    | 'pending'
    | 'settling'
    | 'queued'
    | 'picked-up'
    | 'refused'
    | 'cancelled' = 'pending';
  private lateAcknowledgementScheduled = false;
  private lateAcknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
  private rejectLateAcknowledgement: ((error: Error) => void) | undefined;

  constructor(
    readonly text: string,
    ids: ProviderFrameIds,
    private readonly turn: ClaudeTurn,
  ) {
    this.ids = ids;
  }

  get messageUuid(): string | undefined {
    return this.ids.messageUuid;
  }

  get isPending(): boolean {
    return this.state === 'pending';
  }

  async acknowledge(): Promise<void> {
    if (this.state !== 'pending')
      throw new Error(`Claude steer for ${this.turn.turnKey} is not pending`);
    this.cancelLateAcknowledgement('was acknowledged directly');
    const messageUuid = this.messageUuid;
    if (!messageUuid)
      throw new Error(
        `Claude steer for ${this.turn.turnKey} has no message UUID`,
      );
    this.state = 'settling';
    try {
      await this.turn.emitCommandLifecycle(messageUuid, 'queued');
      this.state = 'queued';
      await this.turn.emitCommandLifecycle(messageUuid, 'started');
      this.state = 'picked-up';
    } catch (error) {
      if (this.state === 'settling') this.state = 'pending';
      throw error;
    }
  }

  async refuse(): Promise<void> {
    if (this.state !== 'pending')
      throw new Error(`Claude steer for ${this.turn.turnKey} is not pending`);
    this.cancelLateAcknowledgement('was refused');
    const messageUuid = this.messageUuid;
    if (!messageUuid)
      throw new Error(
        `Claude steer for ${this.turn.turnKey} has no message UUID`,
      );
    this.state = 'settling';
    try {
      await this.turn.emitCommandLifecycle(messageUuid, 'cancelled');
      this.state = 'refused';
    } catch (error) {
      if (this.state === 'settling') this.state = 'pending';
      throw error;
    }
  }

  async acknowledgeLate(delayMs: number): Promise<void> {
    if (
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_WAIT_TIMEOUT_MS
    )
      throw new Error(
        `Claude steer delay must be an integer from 0 to ${MAX_WAIT_TIMEOUT_MS}ms`,
      );
    if (this.state !== 'pending' || this.lateAcknowledgementScheduled)
      throw new Error(`Claude steer for ${this.turn.turnKey} is not pending`);
    this.lateAcknowledgementScheduled = true;
    await new Promise<void>((resolve, reject) => {
      this.rejectLateAcknowledgement = reject;
      this.lateAcknowledgementTimer = setTimeout(() => {
        this.lateAcknowledgementTimer = undefined;
        this.rejectLateAcknowledgement = undefined;
        resolve();
      }, delayMs);
    });
    await this.acknowledge();
  }

  cancelLateAcknowledgement(reason: string): void {
    if (this.lateAcknowledgementTimer === undefined) return;
    clearTimeout(this.lateAcknowledgementTimer);
    this.lateAcknowledgementTimer = undefined;
    const reject = this.rejectLateAcknowledgement;
    this.rejectLateAcknowledgement = undefined;
    reject?.(
      new Error(
        `Claude steer acknowledgement for ${this.turn.turnKey} was cancelled because the turn ${reason}`,
      ),
    );
  }

  async cancelFromProvider(): Promise<boolean> {
    if (this.state !== 'pending') return false;
    this.cancelLateAcknowledgement('was cancelled by the provider');
    const messageUuid = this.messageUuid;
    if (!messageUuid) return false;
    this.state = 'settling';
    try {
      await this.turn.emitCommandLifecycle(messageUuid, 'cancelled');
      this.state = 'cancelled';
      return true;
    } catch (error) {
      if (this.state === 'settling') this.state = 'pending';
      throw error;
    }
  }
}

/** Synthetic SDK assistant message with an explicit native message identity. */
export function emitScriptedClaudeAssistantMessage(
  turn: ScriptedProviderTurn,
  message: {
    id: string;
    text: string;
    userMessageUuids?: readonly string[];
  },
): Promise<void> {
  if (!(turn instanceof ClaudeTurn))
    throw new Error('Expected a scripted Claude turn');
  return turn.emitIdentifiedText(
    message.id,
    message.text,
    message.userMessageUuids,
  );
}

class ClaudeTurn implements ScriptedProviderTurn {
  readonly turnKey: string;
  readonly prompt: string;
  private readonly rootMessageUuid: string | undefined;
  private readonly steerQueue = new AsyncQueue<ScriptedSteer>();
  private readonly allSteers = new Set<ClaudeSteer>();
  private readonly textChunks: string[] = [];
  private holdGate: HoldGate | undefined;
  private completed = false;
  private closed = false;

  constructor(
    private readonly driver: ClaudeDriver,
    readonly frameQueue: AsyncQueue<SDKMessage | CommandLifecycleFrame>,
    turnKey: string,
    prompt: string,
    rootMessageUuid?: string,
  ) {
    this.turnKey = turnKey;
    this.prompt = prompt;
    this.rootMessageUuid = rootMessageUuid;
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  markReplayComplete(): void {
    if (this.completed) return;
    this.completed = true;
    this.steerQueue.close(
      new Error(
        `Claude turn ${this.turnKey} completed before another steer arrived`,
      ),
      true,
    );
  }

  async emitText(text: string): Promise<void> {
    await this.emitIdentifiedText(
      this.turnKey,
      text,
      this.rootMessageUuid ? [this.rootMessageUuid] : undefined,
    );
  }

  async emitIdentifiedText(
    messageId: string,
    text: string,
    userMessageUuids?: readonly string[],
  ): Promise<void> {
    this.assertCanEmit('text');
    this.textChunks.push(text);
    await this.emitSdkFrame({
      type: 'assistant',
      message: {
        id: messageId,
        type: 'message',
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        role: 'assistant',
        model: 'scripted-claude',
        content: [{ type: 'text', text, citations: null }],
        stop_reason: null,
        stop_sequence: null,
        usage: emptyUsage(),
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.driver.sessionId,
      ...(userMessageUuids && userMessageUuids.length > 0
        ? {
            user_message_uuid: userMessageUuids.at(-1),
            user_message_uuids: [...userMessageUuids],
          }
        : {}),
    } satisfies SDKAssistantMessage);
  }

  async emitToolCall(call: {
    callId: string;
    name: string;
    input?: Readonly<Record<string, unknown>>;
    parentCallId?: string;
  }): Promise<void> {
    this.assertCanEmit('tool call');
    await this.emitSdkFrame({
      type: 'assistant',
      message: {
        id: this.turnKey,
        type: 'message',
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        role: 'assistant',
        model: 'scripted-claude',
        content: [
          {
            type: 'tool_use',
            id: call.callId,
            name: call.name,
            input: call.input ?? {},
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: emptyUsage(),
      },
      parent_tool_use_id: call.parentCallId ?? null,
      uuid: randomUUID(),
      session_id: this.driver.sessionId,
    } satisfies SDKAssistantMessage);
  }

  async emitToolResult(callId: string, output = ''): Promise<void> {
    this.assertCanEmit('tool result');
    await this.emitSdkFrame({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: callId, content: output },
        ],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.driver.sessionId,
    } satisfies SDKUserMessage);
  }

  async startNativeTask(task: {
    taskId: string;
    toolUseId: string;
    kind: 'agent' | 'shell' | 'monitor' | 'workflow';
  }): Promise<void> {
    this.assertCanEmit('start native task');
    await this.driver.startNativeTask(this, task);
  }

  async endNativeTask(
    taskId: string,
    status: 'completed' | 'stopped' | 'failed' = 'completed',
  ): Promise<void> {
    await this.driver.endNativeTask(taskId, status);
  }

  async nextSteer(options?: { timeoutMs?: number }): Promise<ScriptedSteer> {
    const timeoutMs = validateTimeout(
      options?.timeoutMs,
      `Claude turn ${this.turnKey} steer`,
    );
    if (this.isClosed) throw new Error(`Claude turn ${this.turnKey} is closed`);
    return this.steerQueue.take(
      timeoutMs,
      `waiting for the next Claude steer in turn ${this.turnKey}`,
    );
  }

  hold(): void {
    this.assertCanEmit('hold');
    if (!this.holdGate) this.holdGate = createHoldGate();
  }

  release(): Promise<void> {
    const gate = this.holdGate;
    this.holdGate = undefined;
    gate?.release();
    return Promise.resolve();
  }

  async complete(result?: { isError?: boolean }): Promise<void> {
    this.assertCanEmit('complete');
    const isError = result?.isError === true;
    const output = this.textChunks.join('');
    await this.emitSdkFrame({
      type: 'result',
      subtype: 'success',
      is_error: isError,
      result: isError && output.length === 0 ? 'Scripted Claude error' : output,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      stop_reason: isError ? 'error' : 'end_turn',
      total_cost_usd: 0,
      usage: emptyUsage(),
      modelUsage: {},
      permission_denials: [],
      queued_turn_count: 0,
      uuid: randomUUID(),
      session_id: this.driver.sessionId,
    } satisfies SDKResultMessage);
    this.completed = true;
    this.steerQueue.close(
      new Error(
        `Claude turn ${this.turnKey} completed before another steer arrived`,
      ),
      true,
    );
  }

  async emitAbortedStreamingResult(): Promise<void> {
    this.assertCanEmit('emit an aborted-streaming result');
    await this.emitSdkFrame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Cancelled',
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: emptyUsage(),
      modelUsage: {},
      permission_denials: [],
      queued_turn_count: 0,
      terminal_reason: 'aborted_streaming',
      uuid: randomUUID(),
      session_id: this.driver.sessionId,
    } satisfies SDKResultMessage & {
      terminal_reason: 'aborted_streaming';
    });
    this.completed = true;
    this.steerQueue.close(
      new Error(
        `Claude turn ${this.turnKey} completed with an aborted-streaming result`,
      ),
      true,
    );
  }

  addSteer(steer: ClaudeSteer): void {
    if (this.completed || this.closed)
      throw new Error(`Claude turn ${this.turnKey} cannot accept a steer`);
    if (!this.steerQueue.push(steer))
      throw new Error(`Claude turn ${this.turnKey} steer queue is closed`);
    this.allSteers.add(steer);
  }

  pendingSteers(): readonly ClaudeSteer[] {
    return this.driver.pendingSteersFor(this);
  }

  async emitCommandLifecycle(
    messageUuid: string,
    state: 'queued' | 'started' | 'cancelled',
  ): Promise<void> {
    await this.emitSdkFrame({
      type: 'command_lifecycle',
      command_uuid: messageUuid,
      state,
    } satisfies CommandLifecycleFrame);
  }

  async emitNativeFrame(frame: SDKMessage): Promise<void> {
    await this.emitSdkFrame(frame);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelLateAcknowledgements(reason);
    this.holdGate?.release();
    this.holdGate = undefined;
    this.steerQueue.close(
      new Error(`Claude turn ${this.turnKey} ${reason}`),
      true,
    );
  }

  private assertCanEmit(action: string): void {
    if (this.closed || this.driver.isDisposed)
      throw new Error(
        `Cannot ${action}: Claude turn ${this.turnKey} is closed`,
      );
    if (this.completed)
      throw new Error(
        `Cannot ${action}: Claude turn ${this.turnKey} is complete`,
      );
  }

  private cancelLateAcknowledgements(reason: string): void {
    for (const steer of Array.from(this.allSteers))
      steer.cancelLateAcknowledgement(reason);
  }

  private async emitSdkFrame(
    frame: SDKMessage | CommandLifecycleFrame,
  ): Promise<void> {
    if (this.driver.isReplayEnabled) return;
    if (this.closed || this.driver.isDisposed)
      throw new Error(`Claude turn ${this.turnKey} is closed`);
    const gate = this.holdGate;
    if (gate) {
      await this.driver.waitForRelease(
        gate.promise,
        `held Claude turn ${this.turnKey} frame`,
      );
      if (this.holdGate === gate) this.holdGate = undefined;
    }
    if (this.closed || this.driver.isDisposed)
      throw new Error(
        `Claude turn ${this.turnKey} closed before its frame was released`,
      );
    this.driver.emitSdkFrame(this, frame);
  }
}

class ClaudeDriver implements ScriptedProviderDriver {
  readonly provider = 'claude' as const;
  readonly sessionId = `scripted-claude-${randomUUID()}`;
  private turns = new AsyncQueue<ScriptedProviderTurn>();
  private interrupts = new AsyncQueue<InterruptNotice>();
  private frames = new AsyncQueue<SDKMessage | CommandLifecycleFrame>();
  private readonly steers = new Map<string, ClaudeSteer>();
  private readonly tasks = new Map<string, NativeTaskState>();
  private nextTurnNumber = 0;
  private activeTurn: ClaudeTurn | undefined;
  private activeQuery: QueryState | undefined;
  private readonly launchInputs: unknown[] = [];
  private replay: ClaudeFixtureReplay | undefined;
  private disposed = false;
  private nextInterruptRejection: Error | undefined;
  private emitCancelledResultOnAbort = false;
  private nextInterruptReceiptGate: InterruptReceiptGate | undefined;
  private readonly resultObservations: ScriptedClaudeResultObservation[] = [];
  private readonly assistantCorrelations: ScriptedClaudeAssistantCorrelationObservation[] =
    [];
  private readonly emulateRootReceipt: boolean;

  constructor(
    private readonly recorder: PipelineTraceRecorder,
    private readonly target: PipelineChatTarget,
    emulateRootReceipt: boolean,
  ) {
    this.emulateRootReceipt = emulateRootReceipt;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isReplayEnabled(): boolean {
    return this.replay !== undefined;
  }

  getLaunchInputs(): readonly unknown[] {
    return this.launchInputs.slice();
  }

  enableReplay(fixture: LifecycleFixture): LifecycleReplayDriver {
    this.assertLive('enable Claude lifecycle replay');
    if (fixture.provider !== 'claude')
      throw new Error('Claude replay requires a Claude lifecycle fixture');
    if (this.activeQuery)
      throw new Error('Claude replay must be enabled before the first query');
    if (this.replay)
      throw new Error('Claude lifecycle replay is already enabled');
    this.replay = new ClaudeFixtureReplay({
      sessionId: this.sessionId,
      currentTurnKey: (): string | undefined => this.currentTurnKey(),
      emit: (envelope, observation, turnKey): void => {
        const frameQueue = this.activeQuery?.frameQueue ?? this.frames;
        if (!frameQueue.push(envelope))
          throw new Error(
            `Claude replay tried to emit ${observation.type} after the SDK stream closed`,
          );
        const messageType = readString(envelope, 'type') ?? 'unknown';
        const subtype = readString(envelope, 'subtype');
        const ids = idsForFrame(envelope);
        this.recordProviderFrame({
          direction: 'to-canopy',
          type: subtype
            ? `sdk:${messageType}:${subtype}`
            : `sdk:${messageType}`,
          ...(turnKey ? { turnKey } : {}),
          ...(ids ? { ids } : {}),
          replayFrame: observation,
        });
        if (isClaudeReplayTerminal(envelope))
          this.activeTurn?.markReplayComplete();
      },
    });
    return this.replay;
  }

  async nextTurn(options?: {
    timeoutMs?: number;
  }): Promise<ScriptedProviderTurn> {
    const timeoutMs = validateTimeout(options?.timeoutMs, 'next Claude turn');
    return this.turns.take(timeoutMs, 'waiting for the next Claude turn');
  }

  async startTurnByItself(options?: {
    text?: string;
  }): Promise<ScriptedProviderTurn> {
    this.assertLive('start a self-started Claude turn');
    if (
      this.activeTurn &&
      !this.activeTurn.isCompleted &&
      !this.activeTurn.isClosed
    )
      throw new Error(
        `Cannot self-start a Claude turn while ${this.activeTurn.turnKey} is active`,
      );
    const turn = this.createTurn('');
    this.emitTurnInit(this.activeQuery, turn.turnKey);
    if (options?.text !== undefined) await turn.emitText(options.text);
    return turn;
  }

  async nextInterrupt(options?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = validateTimeout(
      options?.timeoutMs,
      'next Claude interrupt',
    );
    await this.interrupts.take(timeoutMs, 'waiting for a Claude interrupt');
  }

  rejectNextInterrupt(error: Error): void {
    this.assertLive('reject the next Claude interrupt');
    this.nextInterruptRejection = error;
  }

  emitCancelledResultOnNextAbort(): void {
    this.assertLive('enable a cancelled Claude result on abort');
    this.emitCancelledResultOnAbort = true;
  }

  holdNextInterruptReceipt(): ScriptedClaudeInterruptReceiptHold {
    this.assertLive('hold the next Claude interrupt receipt');
    if (this.nextInterruptReceiptGate)
      throw new Error('A Claude interrupt receipt is already held');
    const gate = createInterruptReceiptGate();
    this.nextInterruptReceiptGate = gate;
    return { entered: gate.entered, release: () => gate.release() };
  }

  getResultObservations(): readonly ScriptedClaudeResultObservation[] {
    return this.resultObservations.map((observation) => ({ ...observation }));
  }

  getAssistantCorrelations(): readonly ScriptedClaudeAssistantCorrelationObservation[] {
    return this.assistantCorrelations.map((observation) => ({
      ...observation,
      userMessageUuids: [...observation.userMessageUuids],
    }));
  }

  getLiveNativeTaskIds(): readonly string[] {
    return Array.from(this.tasks.keys()).sort();
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.nextInterruptReceiptGate?.release();
    this.nextInterruptReceiptGate = undefined;
    this.replay?.dispose();
    for (const steer of Array.from(this.steers.values()))
      steer.cancelLateAcknowledgement('driver was disposed');
    if (this.activeQuery) this.closeQuery(this.activeQuery, false);
    this.activeTurn?.close('was disposed');
    this.turns.close(new Error('Claude scripted driver was disposed'), true);
    this.interrupts.close(
      new Error('Claude scripted driver was disposed'),
      true,
    );
    this.frames.close(undefined, true);
    for (const task of Array.from(this.tasks.values()))
      task.turn.close('was disposed');
    this.tasks.clear();
    return Promise.resolve();
  }

  createQuery(params: ClaudeQueryParams): ClaudeScriptedQuery {
    this.assertLive('create an SDK query');
    this.launchInputs.push(params);
    if (typeof params.prompt === 'string')
      throw new Error('Expected a streaming Claude prompt iterator');
    if (this.activeQuery && !this.activeQuery.closed)
      throw new Error(
        'One Scripted Claude driver supports one active chat/query',
      );
    if (this.frames.isClosed)
      this.frames = new AsyncQueue<SDKMessage | CommandLifecycleFrame>();
    const prompt = params.prompt;
    const abortSignal = params.options?.abortController?.signal;
    let signalClosed = (): void => undefined;
    const closeSignal = new Promise<void>((resolve) => {
      signalClosed = resolve;
    });
    const queryState: QueryState = {
      frameQueue: this.frames,
      promptIterator: createPromptIterator(prompt, closeSignal),
      closed: false,
      inputPumpStarted: false,
      closeSignal,
      signalClosed,
      ...(abortSignal ? { abortSignal } : {}),
    };
    this.activeQuery = queryState;
    if (abortSignal) {
      const onAbort = (): void => {
        if (this.emitCancelledResultOnAbort) {
          this.emitCancelledResultOnAbort = false;
          const activeTurn = this.activeTurn;
          if (activeTurn) {
            this.emitSdkFrame(activeTurn, {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: 'Cancelled',
              duration_ms: 0,
              duration_api_ms: 0,
              num_turns: 1,
              stop_reason: 'end_turn',
              total_cost_usd: 0,
              usage: emptyUsage(),
              modelUsage: {},
              permission_denials: [],
              queued_turn_count: 0,
              terminal_reason: 'aborted_streaming',
              uuid: randomUUID(),
              session_id: this.sessionId,
            } satisfies SDKResultMessage & {
              terminal_reason: 'aborted_streaming';
            });
          }
          this.closeQuery(queryState, false, false);
        } else this.closeQuery(queryState, false);
      };
      queryState.abortListener = onAbort;
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }

    const stream = (async function* (
      driver: ClaudeDriver,
      state: QueryState,
    ): ClaudeSdkStream {
      driver.startInputPump(state);
      for (;;) {
        const next = await state.frameQueue.next();
        if (next.done === true) return;
        yield next.value;
      }
    })(this, queryState);

    const query = Object.assign(stream, {
      cancelAsyncMessage: (messageUuid: string) =>
        this.cancelAsyncMessage(queryState, messageUuid),
      interrupt: (options?: unknown) => this.interrupt(queryState, options),
      close: () => this.closeQuery(queryState, true),
      setModel: (model?: string): Promise<void> => {
        this.recordControl('setModel', this.currentTurnKey());
        void model;
        return Promise.resolve();
      },
      setPermissionMode: (mode: string): Promise<void> => {
        this.recordControl('setPermissionMode', this.currentTurnKey());
        void mode;
        return Promise.resolve();
      },
      setMcpPermissionModeOverride: (
        serverName: string,
        mode: string | null,
      ): Promise<{ warning?: string }> => {
        this.recordControl(
          'setMcpPermissionModeOverride',
          this.currentTurnKey(),
        );
        void serverName;
        void mode;
        return Promise.resolve({});
      },
      setMaxThinkingTokens: (
        maxThinkingTokens: number | null,
        thinkingDisplay?: string | null,
      ): Promise<void> => {
        this.recordControl('setMaxThinkingTokens', this.currentTurnKey());
        void maxThinkingTokens;
        void thinkingDisplay;
        return Promise.resolve();
      },
      applyFlagSettings: (settings: unknown): Promise<void> => {
        this.recordControl('applyFlagSettings', this.currentTurnKey());
        void settings;
        return Promise.resolve();
      },
      stopTask: (taskId: string): Promise<void> => {
        this.recordControl('stopTask', this.currentTurnKey(), {
          taskId,
        });
        return Promise.resolve();
      },
      getContextUsage: (
        _options?: unknown,
      ): Promise<SDKControlGetContextUsageResponse> => {
        this.recordControl('getContextUsage', this.currentTurnKey());
        void _options;
        return Promise.resolve({
          categories: [],
          totalTokens: 0,
          maxTokens: 0,
          rawMaxTokens: 0,
          percentage: 0,
          gridRows: [],
          model: 'scripted-claude',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: null,
        });
      },
    });
    return query;
  }

  emitSdkFrame(
    turn: ClaudeTurn,
    frame: SDKMessage | CommandLifecycleFrame,
  ): void {
    const messageType = readString(frame, 'type') ?? 'unknown';
    const subtype = readString(frame, 'subtype');
    const ids = idsForFrame(frame);
    const label = subtype
      ? `sdk:${messageType}:${subtype}`
      : `sdk:${messageType}`;
    if (!turn.frameQueue.push(frame))
      throw new Error(
        `Claude turn ${turn.turnKey} tried to emit ${label} after the SDK stream closed`,
      );
    if (messageType === 'assistant') {
      const rawUserMessageUuids = readField(frame, 'user_message_uuids');
      const userMessageUuids = Array.isArray(rawUserMessageUuids)
        ? rawUserMessageUuids.filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      const userMessageUuid = readString(frame, 'user_message_uuid');
      const messageId = readString(readField(frame, 'message'), 'id');
      this.assistantCorrelations.push({
        turnKey: turn.turnKey,
        ...(messageId ? { assistantMessageId: messageId } : {}),
        ...(userMessageUuid ? { userMessageUuid } : {}),
        userMessageUuids,
      });
    }
    if (messageType === 'result') {
      const terminalReason = readString(frame, 'terminal_reason');
      this.resultObservations.push({
        turnKey: turn.turnKey,
        ...(subtype ? { subtype } : {}),
        ...(terminalReason ? { terminalReason } : {}),
      });
    }
    this.recordProviderFrame({
      direction: 'to-canopy',
      type: label,
      turnKey: turn.turnKey,
      ...(ids ? { ids } : {}),
    });
  }

  async startNativeTask(
    turn: ClaudeTurn,
    task: {
      taskId: string;
      toolUseId: string;
      kind: 'agent' | 'shell' | 'monitor' | 'workflow';
    },
  ): Promise<void> {
    if (this.tasks.has(task.taskId))
      throw new Error(`Claude native task ${task.taskId} already exists`);
    const state: NativeTaskState = {
      ...task,
      turn,
      description: `Scripted ${task.kind} task`,
      taskType: taskTypeFor(task.kind),
    };
    this.tasks.set(task.taskId, state);
    await turn.emitNativeFrame({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: this.backgroundTaskSnapshot(),
      uuid: randomUUID(),
      session_id: this.sessionId,
    } satisfies SDKBackgroundTasksChangedMessage);
    await turn.emitNativeFrame({
      type: 'system',
      subtype: 'task_started',
      task_id: task.taskId,
      tool_use_id: task.toolUseId,
      description: state.description,
      task_type: state.taskType,
      is_backgrounded: true,
      uuid: randomUUID(),
      session_id: this.sessionId,
    } satisfies SDKTaskStartedMessage);
  }

  async endNativeTask(
    taskId: string,
    status: 'completed' | 'stopped' | 'failed',
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Claude native task ${taskId} was not started`);
    this.tasks.delete(taskId);
    const ownerTurn = task.turn;
    if (ownerTurn.isClosed || this.disposed)
      throw new Error(`Claude native task ${taskId} owner turn is closed`);
    await ownerTurn.emitNativeFrame({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: this.backgroundTaskSnapshot(),
      uuid: randomUUID(),
      session_id: this.sessionId,
    } satisfies SDKBackgroundTasksChangedMessage);
    await ownerTurn.emitNativeFrame({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: task.toolUseId,
      status,
      output_file: `scripted/${taskId}.txt`,
      summary: `Scripted task ${status}`,
      uuid: randomUUID(),
      session_id: this.sessionId,
    } satisfies SDKTaskNotificationMessage);
  }

  pendingSteersFor(turn: ClaudeTurn): readonly ClaudeSteer[] {
    return Array.from(this.steers.values()).filter(
      (steer) => steer.isPending && this.steerTurn(steer) === turn,
    );
  }

  async waitForRelease(
    promise: Promise<void>,
    description: string,
  ): Promise<void> {
    await withTimeout(
      promise,
      HOLD_TIMEOUT_MS,
      `${description} was not released`,
    );
  }

  private readonly steerOwners = new WeakMap<ClaudeSteer, ClaudeTurn>();

  private steerTurn(steer: ClaudeSteer): ClaudeTurn | undefined {
    return this.steerOwners.get(steer);
  }

  private createTurn(prompt: string, rootMessageUuid?: string): ClaudeTurn {
    this.nextTurnNumber += 1;
    const turnKey = `claude-turn-${this.nextTurnNumber}`;
    const turn = new ClaudeTurn(
      this,
      this.frames,
      turnKey,
      prompt,
      rootMessageUuid,
    );
    this.activeTurn = turn;
    return turn;
  }

  private startInputPump(state: QueryState): void {
    if (state.inputPumpStarted) return;
    state.inputPumpStarted = true;
    void this.consumePromptIterator(state).catch((error: unknown) => {
      if (state.closed || this.disposed) return;
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown prompt iterator error';
      state.frameQueue.close(
        new Error(`Claude scripted prompt input failed: ${message}`),
      );
    });
  }

  private async consumePromptIterator(state: QueryState): Promise<void> {
    for (;;) {
      if (state.closed || this.disposed) return;
      const inputRead = state.promptIterator
        .next()
        .then<PromptIteratorRead>((result) => ({ kind: 'input', result }));
      const closeRead = state.closeSignal.then<PromptIteratorRead>(() => ({
        kind: 'closed',
      }));
      const read = await withTimeout(
        Promise.race([inputRead, closeRead]),
        MAX_WAIT_TIMEOUT_MS,
        'waiting for a Claude prompt or query teardown',
      );
      if (read.kind === 'closed') return;
      const next = read.result;
      if (next.done === true) return;
      const frame = next.value;
      const text = extractPromptText(frame);
      const ids = idsForFrame(frame);
      const current = this.activeTurn;
      if (
        !current ||
        current.isCompleted ||
        current.frameQueue !== state.frameQueue
      ) {
        const rootMessageUuid =
          this.emulateRootReceipt && !this.isReplayEnabled
            ? ids?.messageUuid
            : undefined;
        const turn = this.createTurn(text, rootMessageUuid);
        this.recordProviderFrame({
          direction: 'to-provider',
          type: 'prompt',
          turnKey: turn.turnKey,
          ...(ids ? { ids } : {}),
          text,
        });
        this.replay?.acceptInput({
          action: 'send',
          ...(ids?.messageUuid ? { messageUuid: ids.messageUuid } : {}),
          turnKey: turn.turnKey,
        });
        this.emitTurnInit(state, turn.turnKey);
        if (rootMessageUuid)
          await turn.emitCommandLifecycle(rootMessageUuid, 'started');
        if (!this.turns.push(turn))
          throw new Error(
            'Claude driver closed before publishing the prompt turn',
          );
        continue;
      }

      const steer = new ClaudeSteer(text, ids ?? {}, current);
      if (steer.messageUuid) this.steers.set(steer.messageUuid, steer);
      this.steerOwners.set(steer, current);
      this.recordProviderFrame({
        direction: 'to-provider',
        type: 'steer',
        turnKey: current.turnKey,
        ...(ids ? { ids } : {}),
        text,
      });
      current.addSteer(steer);
      this.replay?.acceptInput({
        action: 'steer',
        ...(ids?.messageUuid ? { messageUuid: ids.messageUuid } : {}),
        turnKey: current.turnKey,
      });
    }
  }

  // Claude emits system/init at the start of every turn, as recorded fixtures show.
  private emitTurnInit(state: QueryState | undefined, turnKey?: string): void {
    const frameQueue = state?.frameQueue ?? this.frames;
    if (this.replay) return;
    const frame = {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      uuid: randomUUID(),
      cwd: '',
      model: 'scripted-claude',
      permissionMode: 'default',
      apiKeySource: 'none',
      claude_code_version: 'scripted',
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      capabilities: RECEIPT_CAPABILITIES,
    } satisfies SDKSystemMessage;
    if (!frameQueue.push(frame))
      throw new Error(
        'Claude SDK stream closed before initialization was emitted',
      );
    this.recordProviderFrame({
      direction: 'to-canopy',
      type: 'sdk:system:init',
      ...(turnKey ? { turnKey } : {}),
      ids: { messageUuid: frame.uuid },
    });
  }

  private async cancelAsyncMessage(
    state: QueryState,
    messageUuid: string,
  ): Promise<{ cancelled: boolean }> {
    this.recordProviderFrame({
      direction: 'to-provider',
      type: 'cancel-async',
      turnKey: this.currentTurnKey(),
      ids: { messageUuid },
    });
    if (state.closed) return { cancelled: false };
    const steer = this.steers.get(messageUuid);
    if (!steer) return { cancelled: false };
    return { cancelled: await steer.cancelFromProvider() };
  }

  private async interrupt(
    state: QueryState,
    options: unknown,
  ): Promise<{ cancelled: string[]; still_queued: string[] }> {
    const cancelQueued = readField(options, 'cancelQueued') === true;
    const currentTurn = this.activeTurn;
    const turnKey =
      currentTurn && !currentTurn.isCompleted ? currentTurn.turnKey : undefined;
    this.recordProviderFrame({
      direction: 'to-provider',
      type: 'interrupt',
      ...(turnKey ? { turnKey } : {}),
    });
    const rejected = this.nextInterruptRejection;
    this.nextInterruptRejection = undefined;
    if (rejected) throw rejected;
    if (!state.closed && !this.disposed) this.interrupts.push({ turnKey });

    const pending = currentTurn ? currentTurn.pendingSteers() : [];
    const cancelled: string[] = [];
    const stillQueued: string[] = [];
    for (const steer of pending) {
      const messageUuid = steer.messageUuid;
      if (!messageUuid) continue;
      if (cancelQueued) {
        if (await steer.cancelFromProvider()) cancelled.push(messageUuid);
      } else {
        stillQueued.push(messageUuid);
      }
    }
    const receiptGate = this.nextInterruptReceiptGate;
    this.nextInterruptReceiptGate = undefined;
    if (receiptGate) {
      receiptGate.markEntered();
      await this.waitForRelease(
        receiptGate.promise,
        'held Claude SDK interrupt receipt',
      );
    }
    return { cancelled, still_queued: stillQueued };
  }

  private closeQuery(
    state: QueryState,
    traceControl: boolean,
    discardQueued = true,
  ): void {
    if (state.closed) return;
    state.closed = true;
    if (state.abortSignal && state.abortListener)
      state.abortSignal.removeEventListener('abort', state.abortListener);
    state.signalClosed();
    if (traceControl) this.recordControl('close', this.currentTurnKey());
    state.frameQueue.close(undefined, discardQueued);
    if (this.activeTurn?.frameQueue === state.frameQueue)
      this.activeTurn.close('was closed with its SDK query');
    const inputIterator = state.promptIterator;
    if (typeof inputIterator.return === 'function') {
      void Promise.resolve(inputIterator.return()).catch(() => undefined);
    }
  }

  private recordControl(
    name: string,
    turnKey: string | undefined,
    ids?: ProviderFrameIds,
  ): void {
    this.recordProviderFrame({
      direction: 'to-provider',
      type: `control:${name}`,
      ...(turnKey ? { turnKey } : {}),
      ...(ids ? { ids } : {}),
    });
  }

  private currentTurnKey(): string | undefined {
    const turn = this.activeTurn;
    return turn && !turn.isCompleted && !turn.isClosed
      ? turn.turnKey
      : undefined;
  }

  private backgroundTaskSnapshot(): SDKBackgroundTasksChangedMessage['tasks'] {
    return Array.from(this.tasks.values()).map((task) => ({
      task_id: task.taskId,
      task_type: task.taskType,
      description: task.description,
    }));
  }

  private recordProviderFrame(
    frame: Omit<
      Extract<PipelineTraceInput, { kind: 'provider' }>,
      'kind' | 'provider' | 'target'
    >,
  ): void {
    const event: PipelineTraceInput = {
      kind: 'provider',
      provider: 'claude',
      target: this.target,
      ...frame,
    };
    this.recorder.record(event);
  }

  private assertLive(action: string): void {
    if (this.disposed)
      throw new Error(`Cannot ${action}: Claude driver is disposed`);
  }
}

interface QueryState {
  frameQueue: AsyncQueue<SDKMessage | CommandLifecycleFrame>;
  promptIterator: ClaudePromptIterator;
  closed: boolean;
  inputPumpStarted: boolean;
  closeSignal: Promise<void>;
  signalClosed(): void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

const driverRuntimes = new WeakMap<ScriptedProviderDriver, ClaudeDriver>();

/** Create a test-only Claude driver bound to one explicit pipeline chat target. */
export function createScriptedClaude(
  recorder: PipelineTraceRecorder,
  options: {
    target: PipelineChatTarget;
    /** Add the Claude root receipt and UUID binding missing from basic fixtures. */
    emulateRootReceipt?: boolean;
  },
): ScriptedProviderDriver {
  const driver = new ClaudeDriver(
    recorder,
    options.target,
    options.emulateRootReceipt === true,
  );
  driverRuntimes.set(driver, driver);
  return driver;
}

/** Configure the next SDK interrupt to reject; test-only provider boundary control. */
export function rejectNextScriptedClaudeInterrupt(
  driver: ScriptedProviderDriver,
  error: Error,
): void {
  const runtime = driverRuntimes.get(driver);
  if (!runtime)
    throw new Error(
      'rejectNextScriptedClaudeInterrupt requires a Claude scripted driver',
    );
  runtime.rejectNextInterrupt(error);
}

/** Script the SDK's real cancellation-shaped result for the next session abort. */
export function emitCancelledResultOnNextScriptedClaudeAbort(
  driver: ScriptedProviderDriver,
): void {
  const runtime = driverRuntimes.get(driver);
  if (!runtime)
    throw new Error(
      'emitCancelledResultOnNextScriptedClaudeAbort requires a Claude scripted driver',
    );
  runtime.emitCancelledResultOnNextAbort();
}

/** Hold the next real Query.interrupt receipt at the scripted SDK boundary. */
export function holdNextScriptedClaudeInterruptReceipt(
  driver: ScriptedProviderDriver,
): ScriptedClaudeInterruptReceiptHold {
  const runtime = driverRuntimes.get(driver);
  if (!runtime)
    throw new Error(
      'holdNextScriptedClaudeInterruptReceipt requires a Claude scripted driver',
    );
  return runtime.holdNextInterruptReceipt();
}

/** Emit a provider-owned cancelled terminal without mutating production state. */
export function emitScriptedClaudeAbortedStreamingResult(
  turn: ScriptedProviderTurn,
): Promise<void> {
  if (!(turn instanceof ClaudeTurn))
    throw new Error('Expected a scripted Claude turn');
  return turn.emitAbortedStreamingResult();
}

/** Read content-free result identities from the scripted SDK boundary. */
export function getScriptedClaudeResultObservations(
  driver: ScriptedProviderDriver,
): readonly ScriptedClaudeResultObservation[] {
  const runtime = driverRuntimes.get(driver);
  if (!runtime)
    throw new Error(
      'getScriptedClaudeResultObservations requires a Claude scripted driver',
    );
  return runtime.getResultObservations();
}

/** Read user-message correlation ids carried by emitted SDK assistant frames. */
export function getScriptedClaudeAssistantCorrelations(
  driver: ScriptedProviderDriver,
): readonly ScriptedClaudeAssistantCorrelationObservation[] {
  const runtime = driverRuntimes.get(driver);
  if (!runtime)
    throw new Error(
      'getScriptedClaudeAssistantCorrelations requires a Claude scripted driver',
    );
  return runtime.getAssistantCorrelations();
}

/** Read scripted native tasks that have no terminal task_notification yet. */
export function getScriptedClaudeLiveNativeTaskIds(
  driver: ScriptedProviderDriver,
): readonly string[] {
  const runtime = driverRuntimes.get(driver);
  if (!runtime)
    throw new Error(
      'getScriptedClaudeLiveNativeTaskIds requires a Claude scripted driver',
    );
  return runtime.getLiveNativeTaskIds();
}

/**
 * SDK module contents for the caller's Jest mock. Only the SDK boundary is
 * replaced; provider/session/manager implementations remain production code.
 */
export function claudeSdkModuleMock(driver: ScriptedProviderDriver): {
  query(params: ClaudeQueryParams): ClaudeScriptedQuery;
  createSdkMcpServer(): { type: string };
  tool(name: string): { name: string };
} {
  const runtime = driverRuntimes.get(driver);
  if (!runtime)
    throw new Error(
      'claudeSdkModuleMock requires a driver from createScriptedClaude',
    );
  return {
    query: (params: ClaudeQueryParams): ClaudeScriptedQuery =>
      runtime.createQuery(params),
    createSdkMcpServer: (): { type: string } => ({ type: 'sdk' }),
    tool: (name: string): { name: string } => ({ name }),
  };
}

import { CodexAuthenticationSession } from './managed-auth';
import { getCanopyDataDir } from '../../canopy-paths';
import {
  getBundledCanopyCliPath,
  getCanopyCliDevLaunchArgs,
} from '../../pipelines/config-paths';
import {
  type AppServerRequestMethod,
  type AppServerRequestParams,
  type AppServerRequestResponse,
  CodexAppServerPool,
  type CodexAppServerConnection,
  type CodexAppServerConnectionOwner,
  type CodexAppServerPoolResourceSnapshot,
  type CodexAppServerProcessCallbacks,
} from './connection';
import { getObservedCanonicalCodexHome } from './canonical-state';
import { CodexHostToolDispatcher } from './host-tools';
import { CODEX_THREAD_ITEM_DISPOSITIONS } from './thread-item-projection';
import type { JsonValue } from './generated/serde_json/JsonValue';
import type { ThreadForkParams } from './generated/v2/ThreadForkParams';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams';
import type { ThreadItem } from './generated/v2/ThreadItem';
import type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage';
import type { Turn } from './generated/v2/Turn';
import type { AccountUpdatedNotification } from './generated/v2/AccountUpdatedNotification';
import type { AccountRateLimitsUpdatedNotification } from './generated/v2/AccountRateLimitsUpdatedNotification';
import type { McpServerElicitationRequestResponse } from './generated/v2/McpServerElicitationRequestResponse';
import {
  resolveCodexSpawnProfile,
  type CodexResolvedSpawnProfile,
  type CodexSpawnProfileRequest,
} from './profile';
import { getCodexMcpBrokerRuntimeDir } from './mcp-runtime-dir';
import {
  finalAssistantText,
  helperUsageFromThreadTokenUsage,
  parseStructuredFinalText,
  proposedPlanText,
} from './structured-turn';
import type {
  CodexRunTurnRequest,
  CodexMcpElicitationPolicy,
  CodexMcpToolCallContext,
  CodexRuntimeEvent,
  CodexThreadHandle,
  CodexTurnOutcome,
} from './thread-handle';
import { CodexCapabilityStore } from './capability-store';
import type { CodexCapabilityLeaseFile } from './capability-types';
import {
  CodexMcpSecretBroker,
  type CodexStdioMcpLaunchRequest,
  type CodexStdioMcpLaunchRoute,
  type CodexStdioMcpRegistrationOptions,
} from './mcp-secret-broker';
import { waitForCodexMcpServers } from './mcp-server-readiness';
import {
  ambientCodexMcpServerNames,
  enabledCodexMcpServerNames,
  excludeAmbientCodexMcpServers,
  flattenCodexThreadConfig,
  omitCodexMcpServersFromThreadConfig,
} from './thread-config';
import { loadBundledCodexModelCatalog } from './bundled-model-catalog';
import { isJsonValue } from './rollout-seed';
import { classifyCodexTransportError } from './transport-errors';
import type { ChatInputAdmission } from '@canopy/protocol/portal/input-delivery';

type JsonRpcId = number | string;

export interface CodexStartThreadRequest {
  params: ThreadStartParams;
  capabilitySnapshotId: string;
  reasoningRouteFamily?: string;
  capabilityLeaseKind?: CodexCapabilityLeaseFile['kind'];
  capabilityLeaseExpiresAt?: string;
  profile?: CodexSpawnProfileRequest;
}

/**
 * Note: there is deliberately no `reasoningRouteFamily` here, unlike the start
 * and fork requests. Resuming does not establish provenance — the persisted
 * history predates this handle — so a lease created on this path is left
 * without a family and fails closed on the next reconstruction. Accepting the
 * field would silently ignore it.
 */
export interface CodexResumeThreadRequest {
  params: ThreadResumeParams;
  capabilitySnapshotId: string;
  capabilityLeaseKind?: CodexCapabilityLeaseFile['kind'];
  capabilityLeaseExpiresAt?: string;
  profile?: CodexSpawnProfileRequest;
}

export interface CodexForkThreadRequest {
  params: ThreadForkParams;
  capabilitySnapshotId: string;
  reasoningRouteFamily?: string;
  capabilityLeaseKind?: CodexCapabilityLeaseFile['kind'];
  capabilityLeaseExpiresAt?: string;
  profile?: CodexSpawnProfileRequest;
}

export interface CodexMaterializeThreadRequest extends CodexStartThreadRequest {
  items: JsonValue[];
}

export interface CodexEphemeralTurnRequest<
  T = unknown,
> extends CodexStartThreadRequest {
  turn: CodexRunTurnRequest;
  parseStructured?: (finalText: string) => T;
}

export interface CodexRuntimeAdmin {
  request<TMethod extends AppServerRequestMethod>(
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    profile?: CodexSpawnProfileRequest,
  ): Promise<AppServerRequestResponse<TMethod>>;
  onAccountUpdated(
    listener: (notification: AccountUpdatedNotification) => void,
    profile?: CodexSpawnProfileRequest,
  ): () => void;
  onRateLimitsUpdated(
    listener: (notification: AccountRateLimitsUpdatedNotification) => void,
    profile?: CodexSpawnProfileRequest,
  ): () => void;
  updateIdleTimeoutMinutes(minutes: number): void;
  suspendIdleWorkersForMemoryPressure(): number;
  /**
   * Retires every worker after its active turn (if any) and resolves only once
   * the pool-wide teardown is complete, so no new request can race the old
   * canonical Codex credentials after an external login flow.
   */
  suspendWorkersForExternalAuthChange(): Promise<number>;
  getResourceSnapshots(): CodexAppServerPoolResourceSnapshot[];
}

export type CodexInteractiveOwner = CodexAppServerConnectionOwner;

export interface CodexInteractiveClientRequest {
  profile?: CodexSpawnProfileRequest;
  owner: CodexInteractiveOwner;
  processCallbacks?: CodexAppServerProcessCallbacks;
}

/**
 * Owner-bound view of the shared app-server transport used by the desktop
 * chat projection. It deliberately does not expose the connection or pool:
 * every ownership-sensitive operation is bound by the runtime service.
 */
export interface CodexInteractiveTransport {
  isOnlyOwner(): boolean;
  isInitialized(): boolean;
  ensureInitialized(options?: { signal?: AbortSignal }): Promise<void>;
  request<TMethod extends AppServerRequestMethod>(
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    options?: {
      timeoutMs?: number;
      rejectOnOwnerFailure?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<AppServerRequestResponse<TMethod>>;
  send(payload: Record<string, unknown>): void;
  completePendingServerRequest(requestId: JsonRpcId): boolean;
  flushPendingServerRequests(shouldSendReplies: boolean): void;
  rejectPendingRequests(error: Error): void;
  rejectAllPendingRequests(error: Error): void;
  registerRootThread(threadId: string): void;
  registerSubagentThread(threadId: string): void;
  unregisterThread(threadId: string): void;
  unsubscribeThreadBestEffort(threadId: string): void;
  /** Record only a completed, locally owned thread before releasing its owner. */
  rememberIdleThread(threadId: string): void;
  /** An idle writer retained by another spawn profile cannot be resumed here. */
  requiresThreadMaterialization(threadId: string): boolean;
  markThreadReady(threadId: string): void;
  recordLoadedThreadProviderRoute(threadId: string, identity: string): void;
  loadedThreadProviderRoute(threadId: string): string | undefined;
  onAccountUpdated(
    listener: (notification: AccountUpdatedNotification) => void,
  ): () => void;
  onRateLimitsUpdated(
    listener: (notification: AccountRateLimitsUpdatedNotification) => void,
  ): () => void;
  suspendIdleProcessIfIdle(): boolean;
  disposeOwnerActiveTurn(target: { threadId: string; turnId: string }): void;
  interruptTurn(target: { threadId: string; turnId: string }): Promise<void>;
  triggerSharedRestart(
    error: Error,
    recoveryTarget?: { threadId: string; turnId: string | null },
    force?: boolean,
  ): void;
  /**
   * Replaces a worker that stopped answering this owner's thread request, but
   * only when no other owner has live work on it. Returns whether it did.
   */
  recycleUnresponsiveProcess(): boolean;
  release(): void;
}

export interface CodexRuntimeService {
  beginAuthentication(): CodexAuthenticationSession;
  startThread(request: CodexStartThreadRequest): Promise<CodexThreadHandle>;
  resumeThread(request: CodexResumeThreadRequest): Promise<CodexThreadHandle>;
  forkThread(request: CodexForkThreadRequest): Promise<CodexThreadHandle>;
  materializeThread(
    request: CodexMaterializeThreadRequest,
  ): Promise<CodexThreadHandle>;
  runEphemeralTurn<T>(
    request: CodexEphemeralTurnRequest<T>,
  ): Promise<CodexTurnOutcome<T>>;
  attachInteractiveClient(
    request: CodexInteractiveClientRequest,
  ): CodexInteractiveTransport;
  registerStdioMcpRoute(
    request: CodexStdioMcpLaunchRequest,
    options?: CodexStdioMcpRegistrationOptions,
  ): Promise<CodexStdioMcpLaunchRoute>;
  revokeStdioMcpRoutes(ownerId: string): Promise<void>;
  admin(): CodexRuntimeAdmin;
  getBundledModelCatalog(): Promise<unknown>;
  getCanonicalState(): Promise<{ codexHome: string }>;
  shutdown(): Promise<void>;
}

interface ActiveTurn {
  turnId?: string;
  signal?: AbortSignal;
  pendingTerminalTurn?: Turn;
  pendingTerminalAdmission?: Promise<void>;
  items: ThreadItem[];
  tokenUsage: ThreadTokenUsage | null;
  onEvent?: (event: CodexRuntimeEvent) => void | Promise<void>;
  mcpElicitationPolicy?: CodexMcpElicitationPolicy;
  nativeApprovalPolicy?: CodexRunTurnRequest['nativeApprovalPolicy'];
  hostTools?: CodexHostToolDispatcher;
  hostToolController?: AbortController;
  resolve: (turn: Turn) => void;
  reject: (error: Error) => void;
}

const TURN_TERMINAL_NOTIFICATION_GRACE_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const nested: unknown = Reflect.get(value, key);
  return isRecord(nested) ? nested : null;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const nested: unknown = Reflect.get(value, key);
  return typeof nested === 'string' ? nested : undefined;
}

/** The fields of a thread start/resume request that ambient MCP isolation reads. */
function readThreadConfigFields(value: unknown): {
  cwd: string | undefined;
  config: { [key: string]: JsonValue } | undefined;
} | null {
  if (!isRecord(value)) return null;
  const { cwd, config } = value;
  if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') return null;
  if (config !== undefined && config !== null && !isRecord(config)) return null;
  let defined: { [key: string]: JsonValue } | undefined;
  if (isRecord(config)) {
    defined = {};
    for (const [key, entry] of Object.entries(config)) {
      if (entry !== undefined && isJsonValue(entry)) defined[key] = entry;
    }
  }
  return { cwd: cwd ?? undefined, config: defined };
}

function combineShutdownErrors(errors: unknown[]): Error {
  const error = new Error(
    'Codex runtime shutdown encountered multiple failures',
  );
  Object.defineProperty(error, 'cause', {
    value: errors[0],
    configurable: true,
  });
  Object.defineProperty(error, 'errors', {
    value: errors,
    configurable: true,
  });
  return error;
}

const AUTH_MODES = new Set([
  'apikey',
  'chatgpt',
  'chatgptAuthTokens',
  'headers',
  'agentIdentity',
  'personalAccessToken',
  'bedrockApiKey',
]);
const PLAN_TYPES = new Set([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'self_serve_business_usage_based',
  'business',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'unknown',
]);
const RATE_LIMIT_REACHED_TYPES = new Set([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === 'number';
}

function isRateLimitWindow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.usedPercent === 'number' &&
    isNullableNumber(value.windowDurationMins) &&
    isNullableNumber(value.resetsAt)
  );
}

function isCreditsSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.hasCredits === 'boolean' &&
    typeof value.unlimited === 'boolean' &&
    isNullableString(value.balance)
  );
}

function isSpendControlLimitSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.limit === 'string' &&
    typeof value.used === 'string' &&
    typeof value.remainingPercent === 'number' &&
    typeof value.resetsAt === 'number'
  );
}

function isAccountUpdatedNotification(
  value: unknown,
): value is AccountUpdatedNotification {
  return (
    isRecord(value) &&
    (value.authMode === null ||
      (typeof value.authMode === 'string' && AUTH_MODES.has(value.authMode))) &&
    (value.planType === null ||
      (typeof value.planType === 'string' && PLAN_TYPES.has(value.planType)))
  );
}

function isAccountRateLimitsUpdatedNotification(
  value: unknown,
): value is AccountRateLimitsUpdatedNotification {
  if (!isRecord(value) || !isRecord(value.rateLimits)) {
    return false;
  }
  const snapshot = value.rateLimits;
  return (
    isNullableString(snapshot.limitId) &&
    isNullableString(snapshot.limitName) &&
    (snapshot.primary === null || isRateLimitWindow(snapshot.primary)) &&
    (snapshot.secondary === null || isRateLimitWindow(snapshot.secondary)) &&
    (snapshot.credits === null || isCreditsSnapshot(snapshot.credits)) &&
    (snapshot.individualLimit === null ||
      isSpendControlLimitSnapshot(snapshot.individualLimit)) &&
    (snapshot.planType === null ||
      (typeof snapshot.planType === 'string' &&
        PLAN_TYPES.has(snapshot.planType))) &&
    (snapshot.rateLimitReachedType === null ||
      (typeof snapshot.rateLimitReachedType === 'string' &&
        RATE_LIMIT_REACHED_TYPES.has(snapshot.rateLimitReachedType)))
  );
}

const THREAD_ITEM_TYPES = new Set(Object.keys(CODEX_THREAD_ITEM_DISPOSITIONS));

function isThreadItem(value: unknown): value is ThreadItem {
  if (!isRecord(value)) {
    return false;
  }
  const type = readString(value, 'type');
  const id = readString(value, 'id');
  if (!type || !id || !THREAD_ITEM_TYPES.has(type)) {
    return false;
  }
  if (type === 'agentMessage' || type === 'plan') {
    return typeof value.text === 'string';
  }
  return true;
}

function isTokenUsageBreakdown(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ].every((key) => typeof value[key] === 'number');
}

function isThreadTokenUsage(value: unknown): value is ThreadTokenUsage {
  return (
    isRecord(value) &&
    isTokenUsageBreakdown(value.total) &&
    isTokenUsageBreakdown(value.last) &&
    (value.modelContextWindow === null ||
      typeof value.modelContextWindow === 'number')
  );
}

function isTurn(value: unknown): value is Turn {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return false;
  }
  if (
    value.status !== 'completed' &&
    value.status !== 'interrupted' &&
    value.status !== 'failed' &&
    value.status !== 'inProgress'
  ) {
    return false;
  }
  if (!Array.isArray(value.items) || !value.items.every(isThreadItem)) {
    return false;
  }
  return (
    value.error === null ||
    (isRecord(value.error) && typeof value.error.message === 'string')
  );
}

class RuntimeThreadHandle
  implements CodexThreadHandle, CodexAppServerConnectionOwner
{
  private activeTurn: ActiveTurn | null = null;
  private disposed = false;

  constructor(
    readonly threadId: string,
    readonly capabilitySnapshotId: string,
    private readonly connection: CodexAppServerConnection,
    private readonly pool: CodexAppServerPool,
    private readonly onDispose: () => void,
    private readonly onDelete: () => Promise<void>,
    private readonly ephemeral = false,
  ) {}

  /**
   * Unlike an interactive client, this handle cannot restore its thread on a
   * replacement worker (an ephemeral thread has no rollout at all), so the
   * worker must outlive it.
   */
  hasInFlightOperation(): boolean {
    return !this.disposed;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  getActiveTurnInterruptTarget(): {
    threadId: string;
    turnId: string | null;
  } | null {
    return this.activeTurn
      ? { threadId: this.threadId, turnId: this.activeTurn.turnId ?? null }
      : null;
  }

  cancelPendingTurnStart(error: Error): void {
    this.activeTurn?.hostToolController?.abort();
    this.activeTurn?.reject(error);
    this.activeTurn = null;
  }

  rejectActiveTurn(error: Error): void {
    this.activeTurn?.hostToolController?.abort();
    this.activeTurn?.reject(error);
    this.activeTurn = null;
  }

  markProcessSuspended(): void {}

  markProcessFailed(): void {}

  handleConnectionNotification(
    method: string,
    notification: Record<string, unknown>,
  ): void | Promise<void> {
    const params = readRecord(notification, 'params');
    if (!params) {
      return;
    }
    if (method === 'thread/started') {
      const thread = readRecord(params, 'thread');
      const startedThreadId = thread ? readString(thread, 'id') : undefined;
      if (startedThreadId && startedThreadId !== this.threadId) {
        this.connection.registerSubagentThread(startedThreadId, this);
      }
    }
    const active = this.activeTurn;
    if (!active) {
      return;
    }
    const admission = active.onEvent?.({ method, params });

    if (readString(params, 'threadId') !== this.threadId) {
      return admission;
    }
    if (method === 'turn/started') {
      const turn = readRecord(params, 'turn');
      active.turnId = turn ? readString(turn, 'id') : undefined;
      return admission;
    }
    if (method === 'item/completed') {
      const item: unknown = params.item;
      if (isThreadItem(item)) {
        active.items.push(item);
      }
      return admission;
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage: unknown = params.tokenUsage;
      if (isThreadTokenUsage(tokenUsage)) {
        active.tokenUsage = tokenUsage;
      }
      return admission;
    }
    let terminalTurn: unknown =
      method === 'turn/completed' ? params.turn : undefined;
    if (method === 'error' && params.willRetry === false) {
      const turnId = readString(params, 'turnId');
      const error = readRecord(params, 'error');
      if (turnId && error && readString(error, 'message')) {
        // Native quota failures may have no turn/completed notification.
        // Keep native identity and admission semantics, including errors that
        // arrive before the turn/start reply. Retrying errors remain progress.
        terminalTurn = {
          id: turnId,
          status: 'failed',
          items: [],
          itemsView: 'full',
          error,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        };
      }
    }
    if (method === 'turn/completed' || terminalTurn !== undefined) {
      const turn: unknown = terminalTurn;
      if (isTurn(turn)) {
        if (!active.turnId) {
          active.pendingTerminalTurn = turn;
          if (admission) {
            active.pendingTerminalAdmission = admission;
            // The turn/start response may be behind this notification on the
            // same stdout stream. Observe the receipt without pausing stdout;
            // runTurn waits for it after learning the turn ID.
            void admission.catch((error: unknown) => {
              active.reject(
                error instanceof Error ? error : new Error(String(error)),
              );
            });
          }
          return;
        }
        if (turn.id !== active.turnId) {
          return admission;
        }
        if (admission) {
          return admission.then(
            () => active.resolve(turn),
            (error: unknown) => {
              active.reject(
                error instanceof Error ? error : new Error(String(error)),
              );
              throw error;
            },
          );
        }
        active.hostToolController?.abort();
        active.resolve(turn);
      } else {
        active.hostToolController?.abort();
        active.reject(new Error('Codex emitted a malformed terminal turn'));
      }
    }
    return admission;
  }

  handleRequestUserInput(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
  ): Promise<void> {
    void request;
    if (!this.connection.completePendingServerRequest(this, requestId)) {
      return Promise.resolve();
    }
    this.connection.send({
      id: requestId,
      error: {
        code: -32000,
        message: 'User input is unavailable for this runtime policy',
      },
    });
    return Promise.resolve();
  }

  async handleDynamicToolCall(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
  ): Promise<void> {
    const dispatcher = this.activeTurn?.hostTools;
    const result = dispatcher
      ? await dispatcher.run(request)
      : {
          contentItems: [
            {
              type: 'inputText',
              text: 'Dynamic tools are unavailable for this runtime policy',
            },
          ],
          success: false,
        };
    if (!this.connection.completePendingServerRequest(this, requestId)) {
      return;
    }
    this.connection.send({
      id: requestId,
      result,
    });
  }

  async handleApprovalRequest(
    requestId: JsonRpcId,
    method: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    const active = this.activeTurn;
    if (
      active?.nativeApprovalPolicy &&
      [
        'item/fileChange/requestApproval',
        'item/commandExecution/requestApproval',
        'item/permissions/requestApproval',
      ].includes(method)
    ) {
      let result: Record<string, unknown> =
        method === 'item/permissions/requestApproval'
          ? { permissions: {}, scope: 'turn' }
          : { decision: 'decline' };
      try {
        result = await active.nativeApprovalPolicy(method, request);
      } catch {
        /* Fail closed. */
      }
      if (
        this.activeTurn !== active ||
        !this.connection.completePendingServerRequest(this, requestId)
      )
        return;
      this.connection.send({ id: requestId, result });
      return;
    }
    if (!this.connection.completePendingServerRequest(this, requestId)) return;
    if (method === 'item/tool/requestUserInput') {
      this.connection.send({
        id: requestId,
        error: {
          code: -32000,
          message: 'User input is unavailable for this runtime policy',
        },
      });
      return Promise.resolve();
    }
    const result =
      method === 'mcpServer/elicitation/request'
        ? {
            action: 'decline',
            content: null,
            _meta: null,
          }
        : method === 'item/permissions/requestApproval'
          ? { permissions: {}, scope: 'turn' }
          : method === 'applyPatchApproval' || method === 'execCommandApproval'
            ? { decision: 'denied' }
            : { decision: 'decline' };
    this.connection.send({ id: requestId, result });
    return Promise.resolve();
  }

  async handleMcpElicitation(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    toolCall: CodexMcpToolCallContext,
    approvalKind: string,
  ): Promise<void> {
    void request;
    const active = this.activeTurn;
    const policy = active?.mcpElicitationPolicy;
    let approved = false;
    if (policy) {
      try {
        const evaluation = await policy.evaluate({
          serverName: toolCall.serverName,
          toolName: toolCall.toolName,
          arguments: toolCall.arguments,
          normalizedArguments: toolCall.normalizedArguments,
          approvalKind,
        });
        approved =
          evaluation.approved &&
          (!evaluation.externalMutation || policy.allowExternalMutation);
      } catch {
        approved = false;
      }
    }
    approved =
      approved &&
      this.activeTurn === active &&
      active?.signal?.aborted !== true;
    if (!this.connection.completePendingServerRequest(this, requestId)) {
      return;
    }
    const result: McpServerElicitationRequestResponse = {
      action: approved ? 'accept' : 'decline',
      content: null,
      _meta: null,
    };
    this.connection.send({ id: requestId, result });
  }

  async runTurn(request: CodexRunTurnRequest): Promise<CodexTurnOutcome> {
    if (this.disposed) {
      throw new Error('Codex thread handle is disposed');
    }
    if (this.activeTurn) {
      throw new Error('A Codex turn is already active for this thread');
    }
    if (request.signal?.aborted) {
      return {
        status: 'interrupted',
        threadId: this.threadId,
        finalText: '',
        usage: {},
      };
    }

    let resolveCompleted!: (turn: Turn) => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<Turn>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const active: ActiveTurn = {
      items: [],
      signal: request.signal,
      tokenUsage: null,
      onEvent: request.onEvent,
      mcpElicitationPolicy: request.mcpElicitationPolicy,
      nativeApprovalPolicy: request.nativeApprovalPolicy,
      resolve: resolveCompleted,
      reject: rejectCompleted,
    };
    if (request.hostToolPolicy) {
      active.hostToolController = new AbortController();
      active.hostTools = new CodexHostToolDispatcher(
        this.threadId,
        () => active.turnId,
        request.hostToolPolicy,
        active.hostToolController.signal,
      );
    }
    this.activeTurn = active;

    let cancellationRequested = false;
    let totalTimer: NodeJS.Timeout | undefined;
    let cancelTerminalNotificationDeadline: (() => void) | undefined;
    const scheduleTerminalNotificationDeadline = (target: {
      threadId: string;
      turnId: string;
    }): void => {
      if (this.activeTurn !== active || cancelTerminalNotificationDeadline) {
        return;
      }
      // The terminal frame may already be read, or waiting in a paused
      // stdout behind other owners' backlog: that is not an unresponsive
      // app-server, so the deadline waits for it (boundedly).
      cancelTerminalNotificationDeadline =
        this.connection.scheduleBacklogAwareDeadline(
          this,
          TURN_TERMINAL_NOTIFICATION_GRACE_MS,
          (): void => {
            if (this.activeTurn !== active) {
              return;
            }
            const error = new Error(
              'Codex turn did not emit a terminal notification after interrupt',
            );
            active.reject(error);
            this.connection.triggerSharedRestart(this, error, target, true);
          },
        );
    };
    const onAbort = (): void => {
      if (cancellationRequested) {
        return;
      }
      cancellationRequested = true;
      active.hostToolController?.abort();
      const target = this.getActiveTurnInterruptTarget() ?? {
        threadId: this.threadId,
        turnId: null,
      };
      if (target.turnId) {
        const activeTarget = {
          threadId: target.threadId,
          turnId: target.turnId,
        };
        void this.connection
          .interruptTurn(this, activeTarget)
          .then(() => scheduleTerminalNotificationDeadline(activeTarget))
          .catch((error: unknown) => {
            active.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
        return;
      }
      // `turn/start` is mutating, so an abort before its response is
      // ambiguous. Quarantine this owner while a busy peer is using the
      // shared process, or restart the worker immediately when it is safe.
      this.connection.triggerSharedRestart(
        this,
        new Error('turn_cancelled'),
        target,
      );
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.totalTimeoutMs !== undefined) {
      totalTimer = setTimeout(onAbort, request.totalTimeoutMs);
      totalTimer.unref?.();
    }

    try {
      const {
        signal: _signal,
        startupTimeoutMs,
        totalTimeoutMs: _totalTimeoutMs,
        onEvent: _onEvent,
        mcpElicitationPolicy: _mcpElicitationPolicy,
        hostToolPolicy: _hostToolPolicy,
        nativeApprovalPolicy: _nativeApprovalPolicy,
        ...turnParams
      } = request;
      void _signal;
      void _totalTimeoutMs;
      void _onEvent;
      void _mcpElicitationPolicy;
      void _hostToolPolicy;
      void _nativeApprovalPolicy;
      const pendingStart = this.connection.request(
        'turn/start',
        { ...turnParams, threadId: this.threadId },
        {
          owner: this,
          timeoutMs: startupTimeoutMs,
          signal: request.signal,
        },
      ) as Promise<{ turn: Turn }>;
      const response = await Promise.race([
        pendingStart,
        completed.then(() => pendingStart),
      ]);
      active.turnId = response.turn.id;
      if (active.pendingTerminalTurn?.id === active.turnId) {
        const terminalTurn = active.pendingTerminalTurn;
        active.hostToolController?.abort();
        if (active.pendingTerminalAdmission) {
          void active.pendingTerminalAdmission.then(
            () => active.resolve(terminalTurn),
            (error: unknown) =>
              active.reject(
                error instanceof Error ? error : new Error(String(error)),
              ),
          );
        } else {
          active.resolve(terminalTurn);
        }
      }
      if (cancellationRequested) {
        const activeTarget = {
          threadId: this.threadId,
          turnId: active.turnId,
        };
        await this.connection.interruptTurn(this, activeTarget);
        scheduleTerminalNotificationDeadline(activeTarget);
      }
      const turn = await completed;
      const status = turn.status === 'inProgress' ? 'failed' : turn.status;
      const items = active.items.length > 0 ? active.items : turn.items;
      const finalText = finalAssistantText(items);
      const plan = proposedPlanText(items, finalText);
      return {
        status,
        threadId: this.threadId,
        turnId: turn.id,
        finalText,
        ...(plan ? { proposedPlanText: plan } : {}),
        usage: helperUsageFromThreadTokenUsage(active.tokenUsage),
        ...(turn.error?.message ? { error: turn.error.message } : {}),
        ...(turn.error?.codexErrorInfo
          ? { errorInfo: turn.error.codexErrorInfo }
          : {}),
      };
    } catch (error) {
      const startupTimedOut =
        error instanceof Error &&
        error.name === 'CodexAppServerRequestTimeoutError' &&
        !active.turnId;
      if (startupTimedOut && !cancellationRequested) {
        cancellationRequested = true;
        this.connection.triggerSharedRestart(
          this,
          new Error('turn_start_timeout'),
          { threadId: this.threadId, turnId: null },
        );
      }
      const transportFailure = classifyCodexTransportError(error);
      return {
        status: cancellationRequested ? 'interrupted' : 'failed',
        threadId: this.threadId,
        turnId: active.turnId,
        finalText: finalAssistantText(active.items),
        usage: helperUsageFromThreadTokenUsage(active.tokenUsage),
        error: error instanceof Error ? error.message : String(error),
        ...(transportFailure ? { transportFailure } : {}),
      };
    } finally {
      active.hostToolController?.abort();
      if (totalTimer) {
        clearTimeout(totalTimer);
      }
      cancelTerminalNotificationDeadline?.();
      request.signal?.removeEventListener('abort', onAbort);
      if (this.activeTurn === active) {
        this.activeTurn = null;
        this.connection.notifyOwnerTurnSettled(this);
      }
    }
  }

  async injectItems(items: JsonValue[]): Promise<void> {
    await this.connection.request(
      'thread/inject_items',
      { threadId: this.threadId, items },
      { owner: this },
    );
  }

  async submitSteeringInput(
    text: string,
    attemptId: string,
    expectedTurnId?: string,
  ): Promise<ChatInputAdmission> {
    const turnId = this.activeTurn?.turnId;
    if (!turnId || (expectedTurnId && expectedTurnId !== turnId))
      return {
        kind: 'rejected',
        attemptId,
        reason: 'The active turn no longer accepts steering',
        fallback: 'ordinary',
      };
    try {
      await this.connection.request(
        'turn/steer',
        {
          threadId: this.threadId,
          expectedTurnId: turnId,
          clientUserMessageId: attemptId,
          input: [{ type: 'text', text, text_elements: [] }],
        },
        { owner: this },
      );
      return { kind: 'accepted', attemptId, providerTurnId: turnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message === 'no active turn to steer' ||
        /^expected active turn id `[^`]+` but found `[^`]+`$/.test(message) ||
        message === 'cannot steer a compact turn' ||
        message === 'cannot steer a review turn'
      )
        return {
          kind: 'rejected',
          attemptId,
          reason: 'The active turn no longer accepts steering',
          fallback: 'ordinary',
        };
      return {
        kind: 'unknown',
        attemptId,
        reason:
          'Delivery was not confirmed. This message will not be resent automatically.',
      };
    }
  }

  async interrupt(): Promise<void> {
    this.activeTurn?.hostToolController?.abort();
    const target = this.getActiveTurnInterruptTarget();
    if (!target) {
      return;
    }
    if (!target.turnId) {
      this.connection.triggerSharedRestart(
        this,
        new Error('turn_cancelled'),
        target,
      );
      return;
    }
    await this.connection.interruptTurn(this, {
      threadId: target.threadId,
      turnId: target.turnId,
    });
  }

  async unsubscribe(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.requestUnsubscribe();
    this.dispose();
  }

  async delete(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      if (this.ephemeral) {
        // Codex rejects thread/delete for a thread without a rollout; only
        // unsubscribing releases it.
        await this.requestUnsubscribe();
      } else {
        await this.connection
          .request(
            'thread/delete',
            { threadId: this.threadId },
            { owner: this, timeoutMs: 10_000 },
          )
          .catch(async (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!/not found/i.test(message)) {
              await this.requestUnsubscribe();
              throw error;
            }
          });
      }
      await this.onDelete();
    } finally {
      this.dispose();
    }
  }

  private requestUnsubscribe(): Promise<void> {
    return this.connection
      .request(
        'thread/unsubscribe',
        { threadId: this.threadId },
        { owner: this, timeoutMs: 5_000 },
      )
      .then(
        () => undefined,
        () => undefined,
      );
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeTurn?.hostToolController?.abort();
    this.connection.unregisterThread(this.threadId, this);
    this.pool.release(this.connection, this);
    this.onDispose();
  }
}

class AdminOwner implements CodexAppServerConnectionOwner {
  private activeOperations = 0;
  private readonly mcpStartupStates = new Map<
    string,
    Map<
      string,
      {
        status: 'starting' | 'ready' | 'failed' | 'cancelled';
        error?: string;
      }
    >
  >();
  private readonly accountUpdatedListeners = new Set<
    (notification: AccountUpdatedNotification) => void
  >();
  private readonly rateLimitsUpdatedListeners = new Set<
    (notification: AccountRateLimitsUpdatedNotification) => void
  >();

  hasActiveTurn = (): boolean => false;
  hasInFlightOperation = (): boolean => this.activeOperations > 0;
  getActiveTurnInterruptTarget = (): null => null;
  cancelPendingTurnStart = (): void => {};
  rejectActiveTurn = (): void => {};
  markProcessSuspended = (): void => {};
  markProcessFailed = (): void => {};
  handleConnectionNotification = (
    method: string,
    notification: Record<string, unknown>,
  ): void => {
    const params = readRecord(notification, 'params');
    if (!params) return;
    if (method === 'mcpServer/startupStatus/updated') {
      const threadId = readString(params, 'threadId');
      const name = readString(params, 'name');
      const status = readString(params, 'status');
      if (
        threadId &&
        name &&
        (status === 'starting' ||
          status === 'ready' ||
          status === 'failed' ||
          status === 'cancelled')
      ) {
        const states =
          this.mcpStartupStates.get(threadId) ??
          new Map<
            string,
            {
              status: 'starting' | 'ready' | 'failed' | 'cancelled';
              error?: string;
            }
          >();
        const error =
          readString(params, 'error') ??
          readString(params, 'failureReason') ??
          undefined;
        states.set(name, error ? { status, error } : { status });
        this.mcpStartupStates.set(threadId, states);
      }
      return;
    }
    if (method === 'account/updated' && isAccountUpdatedNotification(params)) {
      for (const listener of Array.from(this.accountUpdatedListeners)) {
        listener(params);
      }
      return;
    }
    if (
      method === 'account/rateLimits/updated' &&
      isAccountRateLimitsUpdatedNotification(params)
    ) {
      for (const listener of Array.from(this.rateLimitsUpdatedListeners)) {
        listener(params);
      }
    }
  };
  handleRequestUserInput = async (): Promise<void> => {};
  handleDynamicToolCall = async (): Promise<void> => {};
  handleApprovalRequest = async (): Promise<void> => {};
  handleMcpElicitation = async (): Promise<void> => {};

  retainOperation(): () => void {
    this.activeOperations += 1;
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      this.activeOperations = Math.max(0, this.activeOperations - 1);
    };
  }

  hasRetainedOwnership(): boolean {
    return (
      this.activeOperations > 0 ||
      this.accountUpdatedListeners.size > 0 ||
      this.rateLimitsUpdatedListeners.size > 0
    );
  }

  getMcpStartupState(
    threadId: string,
    serverName: string,
  ):
    | {
        status: 'starting' | 'ready' | 'failed' | 'cancelled';
        error?: string;
      }
    | undefined {
    return this.mcpStartupStates.get(threadId)?.get(serverName);
  }

  clearMcpStartupStates(threadId: string): void {
    this.mcpStartupStates.delete(threadId);
  }

  onAccountUpdated(
    listener: (notification: AccountUpdatedNotification) => void,
  ): () => void {
    this.accountUpdatedListeners.add(listener);
    return (): void => {
      this.accountUpdatedListeners.delete(listener);
    };
  }

  onRateLimitsUpdated(
    listener: (notification: AccountRateLimitsUpdatedNotification) => void,
  ): () => void {
    this.rateLimitsUpdatedListeners.add(listener);
    return (): void => {
      this.rateLimitsUpdatedListeners.delete(listener);
    };
  }
}

class DefaultCodexRuntimeService implements CodexRuntimeService {
  private readonly pool: CodexAppServerPool;
  private readonly authenticationSessions =
    new Set<CodexAuthenticationSession>();
  // thread/unsubscribe retains an idle writer for 30 minutes. Keep bounded
  // handoff evidence, not owners/connections (which would retain whole workers).
  private readonly releasedIdleThreads = new Map<
    string,
    { profileId: string; releasedAt: number }
  >();
  private readonly handles = new Set<CodexThreadHandle>();
  private readonly profileAnchors = new Map<
    string,
    {
      owner: AdminOwner;
      connection: CodexAppServerConnection;
    }
  >();
  private shutdownPromise: Promise<void> | null = null;
  private mcpSecretBroker: CodexMcpSecretBroker | null;
  private readonly revokedStdioMcpOwners = new Set<string>();
  private readonly bundledModelCatalogLoads = new Map<
    AbortController,
    Promise<unknown>
  >();

  constructor(
    private readonly capabilityStore = new CodexCapabilityStore(
      getCanopyDataDir(),
    ),
    pool: CodexAppServerPool = new CodexAppServerPool(),
    mcpSecretBroker?: CodexMcpSecretBroker,
    private readonly bundledModelCatalogLoader = loadBundledCodexModelCatalog,
  ) {
    this.pool = pool;
    this.mcpSecretBroker = mcpSecretBroker ?? null;
  }

  registerStdioMcpRoute(
    request: CodexStdioMcpLaunchRequest,
    options?: CodexStdioMcpRegistrationOptions,
  ): Promise<CodexStdioMcpLaunchRoute> {
    if (this.revokedStdioMcpOwners.has(request.ownerId)) {
      return Promise.reject(
        new Error(
          `MCP launch route registration for owner ${request.ownerId} was revoked`,
        ),
      );
    }
    return this.getMcpSecretBroker().registerRoute(request, options);
  }

  revokeStdioMcpRoutes(ownerId: string): Promise<void> {
    this.revokedStdioMcpOwners.add(ownerId);
    return this.mcpSecretBroker?.revokeOwner(ownerId) ?? Promise.resolve();
  }

  getBundledModelCatalog(): Promise<unknown> {
    if (this.shutdownPromise) {
      return Promise.reject(new Error('Codex runtime is shutting down'));
    }
    const controller = new AbortController();
    const load = this.bundledModelCatalogLoader(controller.signal);
    this.bundledModelCatalogLoads.set(controller, load);
    void load.then(
      () => this.bundledModelCatalogLoads.delete(controller),
      () => this.bundledModelCatalogLoads.delete(controller),
    );
    return load;
  }

  attachInteractiveClient(
    request: CodexInteractiveClientRequest,
  ): CodexInteractiveTransport {
    const profile = resolveCodexSpawnProfile(request.profile);
    const connection = this.pool.acquire({
      profileKey: profile.id,
      extraEnv: profile.environment,
      configArgs: profile.configArgs,
      includeCanopySecrets: profile.includeCanopySecrets,
      environmentPolicy: profile.environmentPolicy,
      owner: request.owner,
      processCallbacks: request.processCallbacks ?? {},
    });
    let released = false;
    const owner = request.owner;
    return {
      isOnlyOwner: (): boolean => connection.isOnlyOwner(owner),
      isInitialized: (): boolean => connection.isInitialized(),
      ensureInitialized: (options): Promise<void> =>
        connection.ensureInitialized(options),
      // Only thread start and resume wait for the config read; every other
      // request is written synchronously, preserving its order against send().
      request: (method, params, options) =>
        method === 'thread/start' || method === 'thread/resume'
          ? this.excludeAmbientMcpServersFromRequest(
              connection,
              owner,
              method,
              params,
              options?.signal,
            ).then((isolated) =>
              connection.request(method, isolated, { owner, ...options }),
            )
          : connection.request(method, params, { owner, ...options }),
      send: (payload): void => connection.send(payload),
      completePendingServerRequest: (requestId): boolean =>
        connection.completePendingServerRequest(owner, requestId),
      flushPendingServerRequests: (shouldSendReplies): void =>
        connection.flushPendingServerRequestsForOwner(owner, shouldSendReplies),
      rejectPendingRequests: (error): void =>
        connection.rejectPendingRequestsForOwner(owner, error),
      rejectAllPendingRequests: (error): void =>
        connection.rejectAllPendingRequests(error),
      registerRootThread: (threadId): void =>
        connection.registerRootThread(threadId, owner),
      registerSubagentThread: (threadId): void =>
        connection.registerSubagentThread(threadId, owner),
      unregisterThread: (threadId): void =>
        connection.unregisterThread(threadId, owner),
      unsubscribeThreadBestEffort: (threadId): void =>
        connection.unsubscribeThreadBestEffort(threadId),
      rememberIdleThread: (threadId): void => {
        if (owner.hasActiveTurn()) return;
        this.releasedIdleThreads.delete(threadId);
        this.releasedIdleThreads.set(threadId, {
          profileId: profile.id,
          releasedAt: Date.now(),
        });
        // Eviction is conservative: an unknown writer still fails visibly;
        // it never authorizes a speculative replay of an active external turn.
        if (this.releasedIdleThreads.size > 1_000) {
          const oldest = this.releasedIdleThreads.keys().next().value;
          if (oldest !== undefined) this.releasedIdleThreads.delete(oldest);
        }
      },
      requiresThreadMaterialization: (threadId): boolean => {
        const idle = this.releasedIdleThreads.get(threadId);
        if (!idle) return false;
        if (Date.now() - idle.releasedAt >= 30 * 60_000) {
          this.releasedIdleThreads.delete(threadId);
          return false;
        }
        return idle.profileId !== profile.id;
      },
      recordLoadedThreadProviderRoute: (threadId, identity): void => {
        if (!released)
          connection.recordLoadedThreadProviderRoute(threadId, identity);
      },
      loadedThreadProviderRoute: (threadId): string | undefined =>
        connection.loadedThreadProviderRoute(threadId),
      markThreadReady: (threadId): void => {
        this.releasedIdleThreads.delete(threadId);
      },
      onAccountUpdated: (listener): (() => void) =>
        connection.onAccountUpdated(owner, listener),
      onRateLimitsUpdated: (listener): (() => void) =>
        connection.onRateLimitsUpdated(owner, listener),
      suspendIdleProcessIfIdle: (): boolean =>
        connection.suspendIdleProcessIfIdle(),
      disposeOwnerActiveTurn: (target): void =>
        connection.disposeOwnerActiveTurn(owner, target),
      interruptTurn: (target): Promise<void> =>
        connection.interruptTurn(owner, target),
      triggerSharedRestart: (error, recoveryTarget, force): void =>
        connection.triggerSharedRestart(owner, error, recoveryTarget, force),
      recycleUnresponsiveProcess: (): boolean =>
        connection.recycleUnresponsiveProcess(owner),
      release: (): void => {
        if (released) return;
        released = true;
        this.pool.release(connection, request.owner);
      },
    };
  }

  async startThread(
    request: CodexStartThreadRequest,
  ): Promise<CodexThreadHandle> {
    const profile = resolveCodexSpawnProfile(request.profile);
    const { owner: provisionalOwner, connection } =
      this.getProfileAnchor(profile);
    const releaseOperation = provisionalOwner.retainOperation();
    try {
      const published = await this.capabilityStore.publishSelectedRoots(
        request.params.selectedCapabilityRoots ?? [],
      );
      const pin =
        published.rootContentIds.length > 0
          ? await this.capabilityStore.acquireOperationPin(
              published.rootContentIds,
            )
          : null;
      const stopRefreshingPin = this.startPinRefresh(pin?.pinId);
      let createdThreadId: string | undefined;
      let leasePersisted = false;
      try {
        const config = await this.excludeAmbientMcpServers(
          connection,
          provisionalOwner,
          request.params.cwd,
          flattenCodexThreadConfig(request.params.config, {
            resetMcpServers: true,
          }),
        );
        const response = await connection.request(
          'thread/start',
          {
            ...request.params,
            config,
            selectedCapabilityRoots:
              request.params.selectedCapabilityRoots != null
                ? published.roots
                : undefined,
          },
          { owner: provisionalOwner },
        );
        const responseThreadId = response.thread.id;
        createdThreadId = responseThreadId;
        connection.registerRootThread(responseThreadId, provisionalOwner);
        try {
          await waitForCodexMcpServers({
            threadId: responseThreadId,
            serverNames: enabledCodexMcpServerNames(request.params.config),
            request: (params) =>
              connection.request('mcpServerStatus/list', params, {
                owner: provisionalOwner,
              }),
            getStartupState: (serverName) =>
              provisionalOwner.getMcpStartupState(responseThreadId, serverName),
          });
        } finally {
          provisionalOwner.clearMcpStartupStates(responseThreadId);
        }
        await this.persistThreadLease({
          pinId: pin?.pinId,
          threadId: responseThreadId,
          snapshotId: request.capabilitySnapshotId,
          rootContentIds: published.rootContentIds,
          kind: request.capabilityLeaseKind ?? 'persisted-chat',
          reasoningRouteFamily: request.reasoningRouteFamily,
          expiresAt: request.capabilityLeaseExpiresAt,
        });
        leasePersisted = true;
        return this.attachThread(
          responseThreadId,
          request.capabilitySnapshotId,
          connection,
          profile,
          request.params.ephemeral === true,
        );
      } catch (error) {
        if (createdThreadId) {
          connection.unregisterThread(createdThreadId, provisionalOwner);
          await connection
            .request(
              request.params.ephemeral === true
                ? 'thread/unsubscribe'
                : 'thread/delete',
              { threadId: createdThreadId },
              { owner: provisionalOwner, timeoutMs: 10_000 },
            )
            .catch(() => {});
          if (leasePersisted) {
            await this.capabilityStore
              .releaseLease(createdThreadId)
              .catch(() => {});
          }
        }
        if (pin) {
          await this.capabilityStore
            .releaseOperationPin(pin.pinId)
            .catch(() => {});
        }
        throw error;
      } finally {
        stopRefreshingPin();
      }
    } finally {
      releaseOperation();
    }
  }

  async resumeThread(
    request: CodexResumeThreadRequest,
  ): Promise<CodexThreadHandle> {
    const profile = resolveCodexSpawnProfile(request.profile);
    const existingLease = await this.capabilityStore.readLease(
      request.params.threadId,
    );
    if (
      existingLease &&
      existingLease.snapshotId !== request.capabilitySnapshotId
    ) {
      throw new Error(
        'Cannot resume a Codex thread with a different capability snapshot',
      );
    }
    const { owner: provisionalOwner, connection } =
      this.getProfileAnchor(profile);
    const releaseOperation = provisionalOwner.retainOperation();
    let resumedThreadId: string | undefined;
    try {
      const config = await this.excludeAmbientMcpServers(
        connection,
        provisionalOwner,
        request.params.cwd,
        flattenCodexThreadConfig(request.params.config),
      );
      const response = await connection.request(
        'thread/resume',
        {
          ...request.params,
          config,
        },
        {
          owner: provisionalOwner,
        },
      );
      const responseThreadId = response.thread.id;
      resumedThreadId = responseThreadId;
      connection.registerRootThread(responseThreadId, provisionalOwner);
      try {
        await waitForCodexMcpServers({
          threadId: responseThreadId,
          serverNames: enabledCodexMcpServerNames(request.params.config),
          request: (params) =>
            connection.request('mcpServerStatus/list', params, {
              owner: provisionalOwner,
            }),
          getStartupState: (serverName) =>
            provisionalOwner.getMcpStartupState(responseThreadId, serverName),
        });
      } finally {
        provisionalOwner.clearMcpStartupStates(responseThreadId);
      }
      if (!existingLease) {
        // Deliberately omit `reasoningRouteFamily`. This is the *resume* path,
        // so the persisted history predates this handle and its provenance is
        // unverified — a successful resume does not prove which provider wrote
        // the reasoning, since rejection only happens when a turn replays it.
        // Leaving the family unset keeps the lease fail-closed: the next
        // reconstruction sees unknown provenance and sanitizes. Threads this
        // service *starts* still record their family, which is known by
        // construction.
        await this.writeThreadLease({
          threadId: responseThreadId,
          snapshotId: request.capabilitySnapshotId,
          rootContentIds: [],
          kind: request.capabilityLeaseKind ?? 'persisted-chat',
        });
      }
      return this.attachThread(
        responseThreadId,
        request.capabilitySnapshotId,
        connection,
        profile,
      );
    } catch (error) {
      if (resumedThreadId) {
        try {
          await connection
            .request(
              'thread/unsubscribe',
              { threadId: resumedThreadId },
              { owner: provisionalOwner, timeoutMs: 5_000 },
            )
            .catch(() => {});
        } finally {
          connection.unregisterThread(resumedThreadId, provisionalOwner);
        }
      }
      throw error;
    } finally {
      releaseOperation();
    }
  }

  async forkThread(
    request: CodexForkThreadRequest,
  ): Promise<CodexThreadHandle> {
    const profile = resolveCodexSpawnProfile(request.profile);
    const sourceLease = await this.capabilityStore.readLease(
      request.params.threadId,
    );
    const effectiveSnapshotId =
      request.capabilitySnapshotId === 'legacy-canonical' && sourceLease
        ? sourceLease.snapshotId
        : request.capabilitySnapshotId;
    if (sourceLease && sourceLease.snapshotId !== effectiveSnapshotId) {
      throw new Error(
        'Cannot fork a Codex thread with a different capability snapshot',
      );
    }
    const rootContentIds = sourceLease?.rootContentIds ?? [];
    const pin =
      rootContentIds.length > 0
        ? await this.capabilityStore.acquireOperationPin(rootContentIds)
        : null;
    const stopRefreshingPin = this.startPinRefresh(pin?.pinId);
    const { owner: provisionalOwner, connection } =
      this.getProfileAnchor(profile);
    const releaseOperation = provisionalOwner.retainOperation();
    let createdThreadId: string | undefined;
    let leasePersisted = false;
    try {
      const response = await connection.request(
        'thread/fork',
        {
          ...request.params,
          config: flattenCodexThreadConfig(
            omitCodexMcpServersFromThreadConfig(request.params.config),
          ),
        },
        {
          owner: provisionalOwner,
        },
      );
      createdThreadId = response.thread.id;
      await this.persistThreadLease({
        pinId: pin?.pinId,
        threadId: createdThreadId,
        snapshotId: effectiveSnapshotId,
        rootContentIds,
        kind:
          request.capabilityLeaseKind ?? sourceLease?.kind ?? 'persisted-chat',
        reasoningRouteFamily:
          request.reasoningRouteFamily ?? sourceLease?.reasoningRouteFamily,
        expiresAt: request.capabilityLeaseExpiresAt,
      });
      leasePersisted = true;
      return this.attachThread(
        createdThreadId,
        effectiveSnapshotId,
        connection,
        profile,
      );
    } catch (error) {
      if (createdThreadId) {
        connection.unregisterThread(createdThreadId, provisionalOwner);
        await connection
          .request(
            'thread/delete',
            { threadId: createdThreadId },
            { owner: provisionalOwner, timeoutMs: 10_000 },
          )
          .catch(() => {});
        if (leasePersisted) {
          await this.capabilityStore
            .releaseLease(createdThreadId)
            .catch(() => {});
        }
      }
      if (pin) {
        await this.capabilityStore
          .releaseOperationPin(pin.pinId)
          .catch(() => {});
      }
      throw error;
    } finally {
      stopRefreshingPin();
      releaseOperation();
    }
  }

  async materializeThread(
    request: CodexMaterializeThreadRequest,
  ): Promise<CodexThreadHandle> {
    const handle = await this.startThread(request);
    // An empty `thread/inject_items` is not a no-op request, it is a request
    // the app-server has no reason to accept — and any injection failure here
    // deletes the thread that was just started. That would fail the caller on
    // precisely the case an empty list is reachable from: a legacy lease whose
    // entire loaded tail was provider-private reasoning, which sanitizes down
    // to nothing even though real history existed. The client-side
    // reconstruction path guards this the same way.
    if (request.items.length === 0) return handle;
    try {
      await handle.injectItems(request.items);
      return handle;
    } catch (error) {
      await handle.delete().catch(() => {});
      throw error;
    }
  }

  async runEphemeralTurn<T>(
    request: CodexEphemeralTurnRequest<T>,
  ): Promise<CodexTurnOutcome<T>> {
    const handle = await this.startThread({
      ...request,
      params: { ...request.params, ephemeral: true },
      capabilityLeaseKind: 'ephemeral',
      capabilityLeaseExpiresAt: new Date(
        Date.now() + 60 * 60_000,
      ).toISOString(),
    });
    try {
      const outcome = await handle.runTurn(request.turn);
      const { structured: ignoredStructured, ...unstructuredOutcome } = outcome;
      void ignoredStructured;
      if (
        unstructuredOutcome.status !== 'completed' ||
        !request.turn.outputSchema
      ) {
        return unstructuredOutcome;
      }
      try {
        return {
          ...unstructuredOutcome,
          structured: request.parseStructured
            ? request.parseStructured(unstructuredOutcome.finalText)
            : parseStructuredFinalText<T>(unstructuredOutcome.finalText),
        };
      } catch (error) {
        return {
          ...unstructuredOutcome,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      await handle.delete().catch(() => {});
    }
  }

  beginAuthentication(): CodexAuthenticationSession {
    if (this.shutdownPromise) throw new Error('Codex runtime is stopping.');
    const session = new CodexAuthenticationSession(
      this.pool.beginAuthentication(),
      () => {
        this.authenticationSessions.delete(session);
      },
    );
    this.authenticationSessions.add(session);
    return session;
  }

  admin(): CodexRuntimeAdmin {
    return {
      request: async <TMethod extends AppServerRequestMethod>(
        method: TMethod,
        params: AppServerRequestParams<TMethod>,
        requestedProfile?: CodexSpawnProfileRequest,
      ): Promise<AppServerRequestResponse<TMethod>> => {
        const profile = resolveCodexSpawnProfile(requestedProfile);
        const { owner, connection } = this.getProfileAnchor(profile);
        return connection.request(method, params, {
          owner,
          timeoutMs: 30_000,
        });
      },
      onAccountUpdated: (listener, requestedProfile): (() => void) => {
        const profile = resolveCodexSpawnProfile(requestedProfile);
        const { owner } = this.getProfileAnchor(profile);
        return owner.onAccountUpdated(listener);
      },
      onRateLimitsUpdated: (listener, requestedProfile): (() => void) => {
        const profile = resolveCodexSpawnProfile(requestedProfile);
        const { owner } = this.getProfileAnchor(profile);
        return owner.onRateLimitsUpdated(listener);
      },
      updateIdleTimeoutMinutes: (minutes): void => {
        this.pool.updateIdleTimeoutMinutes(minutes);
      },
      suspendIdleWorkersForMemoryPressure: (): number =>
        this.pool.suspendIdleConnectionsForMemoryPressure(),
      suspendWorkersForExternalAuthChange: (): Promise<number> =>
        this.pool.suspendConnectionsForExternalAuthChange(),
      getResourceSnapshots: (): CodexAppServerPoolResourceSnapshot[] =>
        this.pool.getResourceSnapshots(),
    };
  }

  async getCanonicalState(): Promise<{ codexHome: string }> {
    const existing = getObservedCanonicalCodexHome();
    if (existing) {
      return { codexHome: existing };
    }
    const profile = resolveCodexSpawnProfile();
    const { connection } = this.getProfileAnchor(profile);
    await connection.ensureInitialized();
    const codexHome = getObservedCanonicalCodexHome();
    if (!codexHome) {
      throw new Error('Codex app-server did not report its canonical state');
    }
    return { codexHome };
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async (): Promise<void> => {
        const errors: unknown[] = [];
        const catalogLoads: Promise<unknown>[] = [];
        this.bundledModelCatalogLoads.forEach((load, controller) => {
          controller.abort();
          catalogLoads.push(load);
        });
        await Promise.allSettled(catalogLoads);
        const authCleanup = await Promise.allSettled(
          Array.from(this.authenticationSessions, (session) => session.close()),
        );
        for (const result of authCleanup)
          if (result.status === 'rejected') errors.push(result.reason);
        try {
          await (this.mcpSecretBroker?.shutdown() ?? Promise.resolve());
        } catch (error) {
          errors.push(error);
        }
        try {
          await this.pool.shutdown();
        } catch (error) {
          errors.push(error);
        } finally {
          this.handles.clear();
          this.profileAnchors.clear();
          this.releasedIdleThreads.clear();
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw combineShutdownErrors(errors);
        }
      })();
    }
    return this.shutdownPromise;
  }

  private getMcpSecretBroker(): CodexMcpSecretBroker {
    const devLaunch = getCanopyCliDevLaunchArgs();
    this.mcpSecretBroker ??= new CodexMcpSecretBroker(
      getCodexMcpBrokerRuntimeDir(),
      devLaunch?.command ?? getBundledCanopyCliPath(),
      devLaunch?.args ?? [],
      devLaunch?.cwd,
    );
    return this.mcpSecretBroker;
  }

  private getProfileAnchor(profile: CodexResolvedSpawnProfile): {
    owner: AdminOwner;
    connection: CodexAppServerConnection;
  } {
    const existing = this.profileAnchors.get(profile.id);
    if (existing) {
      return existing;
    }
    if (this.profileAnchors.size >= 4) {
      for (const [profileId, candidate] of Array.from(
        this.profileAnchors.entries(),
      )) {
        if (
          !candidate.owner.hasRetainedOwnership() &&
          candidate.connection.canEvictOwner(candidate.owner)
        ) {
          this.pool.release(candidate.connection, candidate.owner);
          this.profileAnchors.delete(profileId);
          break;
        }
      }
    }
    const owner = new AdminOwner();
    const connection = this.pool.acquire({
      profileKey: profile.id,
      extraEnv: profile.environment,
      configArgs: profile.configArgs,
      includeCanopySecrets: profile.includeCanopySecrets,
      environmentPolicy: profile.environmentPolicy,
      owner,
      processCallbacks: {},
    });
    const anchor = { owner, connection };
    this.profileAnchors.set(profile.id, anchor);
    return anchor;
  }

  /**
   * Thread-scoped `mcp_servers` overrides merge into canonical config, so
   * servers configured globally or in a project layer would start for every
   * thread and stay alive while it is loaded. Disable each ambient server the
   * request does not select.
   */
  private async excludeAmbientMcpServers(
    connection: CodexAppServerConnection,
    owner: CodexAppServerConnectionOwner,
    cwd: string | null | undefined,
    config: { [key: string]: JsonValue } | undefined,
    signal?: AbortSignal,
  ): Promise<{ [key: string]: JsonValue } | undefined> {
    const effective = await connection.request(
      'config/read',
      cwd ? { cwd } : {},
      { owner, ...(signal ? { signal } : {}) },
    );
    return excludeAmbientCodexMcpServers(
      config,
      ambientCodexMcpServerNames(effective),
    );
  }

  private async excludeAmbientMcpServersFromRequest<
    TMethod extends AppServerRequestMethod,
  >(
    connection: CodexAppServerConnection,
    owner: CodexAppServerConnectionOwner,
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    signal: AbortSignal | undefined,
  ): Promise<AppServerRequestParams<TMethod>> {
    const fields =
      method === 'thread/start' || method === 'thread/resume'
        ? readThreadConfigFields(params)
        : null;
    if (!fields) {
      return params;
    }
    const config = await this.excludeAmbientMcpServers(
      connection,
      owner,
      fields.cwd,
      fields.config,
      signal,
    );
    if (config === undefined) return params;
    const isolated: AppServerRequestParams<TMethod> = { ...params };
    const target: unknown = isolated;
    if (isRecord(target)) Reflect.set(target, 'config', config);
    return isolated;
  }

  private attachThread(
    threadId: string,
    capabilitySnapshotId: string,
    connection: CodexAppServerConnection,
    profile: CodexResolvedSpawnProfile,
    ephemeral = false,
  ): CodexThreadHandle {
    // Register the durable per-thread owner only after the mutating request
    // returns a concrete thread id.
    const handle = new RuntimeThreadHandle(
      threadId,
      capabilitySnapshotId,
      connection,
      this.pool,
      () => this.handles.delete(handle),
      () => this.capabilityStore.releaseLease(threadId),
      ephemeral,
    );
    const acquired = this.pool.acquire({
      profileKey: profile.id,
      extraEnv: profile.environment,
      configArgs: profile.configArgs,
      includeCanopySecrets: profile.includeCanopySecrets,
      environmentPolicy: profile.environmentPolicy,
      owner: handle,
      processCallbacks: {},
    });
    if (acquired !== connection) {
      this.pool.release(acquired, handle);
      throw new Error('Codex runtime profile changed while attaching a thread');
    }
    connection.registerRootThread(threadId, handle);
    this.handles.add(handle);
    return handle;
  }

  private startPinRefresh(pinId: string | undefined): () => void {
    if (!pinId) {
      return () => {};
    }
    const timer = setInterval(() => {
      void this.capabilityStore.refreshOperationPin(pinId).catch(() => {});
    }, 20_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async persistThreadLease(options: {
    pinId?: string;
    threadId: string;
    snapshotId: string;
    rootContentIds: string[];
    kind: CodexCapabilityLeaseFile['kind'];
    reasoningRouteFamily?: string;
    expiresAt?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const lease: CodexCapabilityLeaseFile = {
      version: 1,
      threadId: options.threadId,
      snapshotId: options.snapshotId,
      rootContentIds: options.rootContentIds,
      kind: options.kind,
      ...(options.reasoningRouteFamily
        ? { reasoningRouteFamily: options.reasoningRouteFamily }
        : {}),
      createdAt: now,
      updatedAt: now,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    };
    if (options.pinId) {
      await this.capabilityStore.promotePinToLease(options.pinId, lease);
    } else {
      await this.capabilityStore.writeLease(lease);
    }
  }

  private async writeThreadLease(options: {
    threadId: string;
    snapshotId: string;
    rootContentIds: string[];
    kind: CodexCapabilityLeaseFile['kind'];
    reasoningRouteFamily?: string;
  }): Promise<void> {
    await this.persistThreadLease(options);
  }
}

export function createCodexRuntimeService(options?: {
  capabilityStore?: CodexCapabilityStore;
  mcpSecretBroker?: CodexMcpSecretBroker;
  bundledModelCatalogLoader?: (signal: AbortSignal) => Promise<unknown>;
}): CodexRuntimeService {
  return new DefaultCodexRuntimeService(
    options?.capabilityStore,
    undefined,
    options?.mcpSecretBroker,
    options?.bundledModelCatalogLoader,
  );
}

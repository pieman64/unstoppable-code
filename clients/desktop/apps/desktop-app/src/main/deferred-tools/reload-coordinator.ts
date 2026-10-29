import type {
  AgentProviderType,
  AssistantMode,
  ChatInterfaceMode,
  ChatTabPluginSelections,
  DeferredResourceSummary,
  DeferredToolsReloadAck,
  DeferredToolsReloadAdditions,
  DeferredToolsReloadBeginRequest,
  DeferredToolsReloadCancelRequest,
  DeferredToolsReloadEvent,
  DeferredToolsReloadFinishRequest,
  DeferredToolsReloadLifecycle,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import {
  clearTimeout as clearNodeTimeout,
  setTimeout as setNodeTimeout,
} from 'node:timers';
import { isDeepStrictEqual } from 'node:util';
import {
  buildDeferredToolsCatalog,
  classifyLoadItems,
  encodeDeferredCatalogRef,
  encodeMcpRef,
  encodePluginRef,
  encodeSkillRef,
} from './catalog';

type IntentState =
  | 'result_pending'
  | 'ui_prepared'
  | 'interrupting'
  | 'enabling'
  | 'resuming'
  | 'completed';

interface ReloadIntent {
  scope: DeferredToolsReloadScopeKey;
  requestId: string;
  toolCallId: string;
  providerType?: AgentProviderType;
  assistantMode?: AssistantMode;
  interfaceMode?: ChatInterfaceMode;
  additions: DeferredToolsReloadAdditions;
  enabledResources: DeferredResourceSummary[];
  state: IntentState;
  delivered: boolean;
  resumePromise?: Promise<DeferredToolsReloadAck>;
  resumeAbortController: AbortController;
}

export interface DeferredToolsResumeRequest {
  scope: DeferredToolsReloadScopeKey;
  requestId: string;
  toolCallId: string;
  userMessageId: string;
  continuationText: string;
  enabledResources: DeferredResourceSummary[];
  sdkSessionId?: string;
  providerType?: AgentProviderType;
  interfaceMode?: ChatInterfaceMode;
  pluginSelections?: ChatTabPluginSelections;
  signal: AbortSignal;
}

export type DeferredToolsResumeHandler = (
  request: DeferredToolsResumeRequest,
) => Promise<void>;

type Listener = (event: DeferredToolsReloadEvent) => void;
type ReloadCatalogRevalidator = (
  intent: ReloadIntent,
) => Promise<string | undefined>;

const RELOAD_RESULT_DELIVERY_TIMEOUT_MS = 30_000;
// Capability materialization can include plugin discovery plus Codex
// thread/start, whose own bounded request timeout is ten minutes. Keep the
// short timeout while waiting for the provider result, then give each active
// reload phase the same upper bound instead of expiring a healthy transition
// after thirty seconds.
const RELOAD_ACTIVE_PHASE_TIMEOUT_MS = 10 * 60_000;

function scopeKey(scope: DeferredToolsReloadScopeKey): string {
  return `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`;
}

function intentKey(
  scope: DeferredToolsReloadScopeKey,
  toolCallId: string,
): string {
  return `${scopeKey(scope)}#${toolCallId}`;
}

function lifecycleForState(state: IntentState): DeferredToolsReloadLifecycle {
  return { kind: 'state', state };
}

function rejectedAck(
  requestId: string,
  code: NonNullable<DeferredToolsReloadAck['rejection']>['code'],
  message: string,
): DeferredToolsReloadAck {
  return {
    requestId,
    accepted: false,
    lifecycle: { kind: 'outcome', outcome: 'rejected' },
    rejection: { code, message },
  };
}

function additionsMatch(
  left: DeferredToolsReloadAdditions,
  right: DeferredToolsReloadAdditions,
): boolean {
  return (
    isDeepStrictEqual(left.skillRefs, right.skillRefs) &&
    isDeepStrictEqual(left.pluginRefs, right.pluginRefs) &&
    isDeepStrictEqual(left.mcpServerRefs, right.mcpServerRefs)
  );
}

function enabledResourcesMatch(
  left: readonly DeferredResourceSummary[],
  right: readonly DeferredResourceSummary[],
): boolean {
  return isDeepStrictEqual(left, right);
}

class DeferredToolsReloadCoordinator {
  private readonly intents = new Map<string, ReloadIntent>();
  private readonly activeByScope = new Map<string, string>();
  private readonly completedAcks = new Map<string, DeferredToolsReloadAck>();
  private readonly listeners = new Set<Listener>();
  private readonly resumeWaiters = new Map<string, Set<() => void>>();
  private readonly intentTimeouts = new Map<
    string,
    ReturnType<typeof setNodeTimeout>
  >();
  private readonly resumeHandlers = new Map<
    string,
    DeferredToolsResumeHandler
  >();
  private readonly settleCallbacks = new Map<string, Array<() => void>>();
  private resultDeliveryTimeoutMs = RELOAD_RESULT_DELIVERY_TIMEOUT_MS;
  private activePhaseTimeoutMs = RELOAD_ACTIVE_PHASE_TIMEOUT_MS;
  private catalogRevalidator: ReloadCatalogRevalidator = async (
    intent,
  ): Promise<string | undefined> => {
    const provider =
      intent.providerType === 'copilot'
        ? 'copilot'
        : intent.providerType === 'codex'
          ? 'codex'
          : intent.providerType === 'ollama'
            ? 'ollama'
            : intent.providerType === 'opencode'
              ? 'opencode'
              : 'claude';
    const catalog = await buildDeferredToolsCatalog({
      provider,
      pluginSelections: undefined,
    });
    const classified = classifyLoadItems(catalog, [
      ...intent.additions.skillRefs.map((ref) =>
        encodeDeferredCatalogRef(encodeSkillRef(ref.sourceId, ref.skillName)),
      ),
      ...intent.additions.pluginRefs.map((ref) =>
        encodeDeferredCatalogRef(
          encodePluginRef(ref.marketplaceId, ref.pluginName),
        ),
      ),
      ...intent.additions.mcpServerRefs.map((ref) =>
        encodeDeferredCatalogRef(encodeMcpRef(ref.serverId, ref.configId)),
      ),
    ]);
    if (classified.rejected.length > 0) {
      const rejected = classified.rejected[0];
      return `${rejected.ref}: ${rejected.message}`;
    }
    return undefined;
  };

  setCatalogRevalidatorForTests(
    revalidator: ReloadCatalogRevalidator,
  ): () => void {
    const previous = this.catalogRevalidator;
    this.catalogRevalidator = revalidator;
    return () => {
      this.catalogRevalidator = previous;
    };
  }

  setIntentTimeoutMsForTests(
    timeoutMs: number,
    activePhaseTimeoutMs = timeoutMs,
  ): () => void {
    const previousResultDeliveryTimeoutMs = this.resultDeliveryTimeoutMs;
    const previousActivePhaseTimeoutMs = this.activePhaseTimeoutMs;
    this.resultDeliveryTimeoutMs = timeoutMs;
    this.activePhaseTimeoutMs = activePhaseTimeoutMs;
    return () => {
      this.resultDeliveryTimeoutMs = previousResultDeliveryTimeoutMs;
      this.activePhaseTimeoutMs = previousActivePhaseTimeoutMs;
    };
  }

  resetForTests(): void {
    for (const intent of Array.from(this.intents.values())) {
      this.cleanup(intent);
    }
    this.completedAcks.clear();
    this.resumeWaiters.clear();
    this.resumeHandlers.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  registerResumeHandler(
    scope: DeferredToolsReloadScopeKey,
    handler: DeferredToolsResumeHandler,
  ): () => void {
    const key = scopeKey(scope);
    this.resumeHandlers.set(key, handler);
    return () => {
      if (this.resumeHandlers.get(key) === handler) {
        this.resumeHandlers.delete(key);
      }
    };
  }

  createIntent(input: {
    scope: DeferredToolsReloadScopeKey;
    toolCallId: string;
    providerType?: AgentProviderType;
    assistantMode?: AssistantMode;
    interfaceMode?: ChatInterfaceMode;
    additions: DeferredToolsReloadAdditions;
    enabledResources: DeferredResourceSummary[];
  }): { accepted: true; requestId: string } | { accepted: false } {
    const activeKey = this.activeByScope.get(scopeKey(input.scope));
    if (activeKey) {
      return { accepted: false };
    }
    const requestId = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const key = intentKey(input.scope, input.toolCallId);
    this.completedAcks.delete(key);
    const intent: ReloadIntent = {
      scope: input.scope,
      requestId,
      toolCallId: input.toolCallId,
      providerType: input.providerType,
      assistantMode: input.assistantMode,
      interfaceMode: input.interfaceMode,
      additions: input.additions,
      enabledResources: input.enabledResources,
      state: 'result_pending',
      delivered: false,
      resumeAbortController: new AbortController(),
    };
    this.intents.set(key, intent);
    this.activeByScope.set(scopeKey(input.scope), key);
    this.armIntentTimeout(intent, this.resultDeliveryTimeoutMs);
    return { accepted: true, requestId };
  }

  hasActiveReload(scope: DeferredToolsReloadScopeKey): boolean {
    return this.activeByScope.has(scopeKey(scope));
  }

  /**
   * Call `onSettled` once when the scope's active reload ends, however it
   * ends: after its resume handler hands off to a continuation, or when it
   * fails, is cancelled or rejected, or times out. A later reload in the
   * scope never calls it. Returns false, registering nothing, when no reload
   * is active in the scope.
   */
  whenActiveReloadSettles(
    scope: DeferredToolsReloadScopeKey,
    onSettled: () => void,
  ): boolean {
    const activeIntentKey = this.activeByScope.get(scopeKey(scope));
    if (!activeIntentKey || !this.intents.has(activeIntentKey)) {
      return false;
    }
    const callbacks = this.settleCallbacks.get(activeIntentKey) ?? [];
    callbacks.push(onSettled);
    this.settleCallbacks.set(activeIntentKey, callbacks);
    return true;
  }

  shouldSuppressProviderTerminal(scope: DeferredToolsReloadScopeKey): boolean {
    const activeIntentKey = this.activeByScope.get(scopeKey(scope));
    if (!activeIntentKey) {
      return false;
    }
    const intent = this.intents.get(activeIntentKey);
    return intent !== undefined && intent.state !== 'resuming';
  }

  cancelActiveReload(
    scope: DeferredToolsReloadScopeKey,
    reason = 'Deferred-tools reload was cancelled.',
  ): boolean {
    const activeIntentKey = this.activeByScope.get(scopeKey(scope));
    if (!activeIntentKey) {
      return false;
    }
    const intent = this.intents.get(activeIntentKey);
    if (!intent) {
      this.activeByScope.delete(scopeKey(scope));
      return false;
    }
    this.fail(intent, 'cancelled', reason);
    return true;
  }

  cancelPendingToolResult(
    scope: DeferredToolsReloadScopeKey,
    toolCallId: string,
    reason: string,
  ): boolean {
    const intent = this.intents.get(intentKey(scope, toolCallId));
    if (!intent || intent.delivered) return false;
    this.fail(intent, 'cancelled', reason);
    return true;
  }

  unregisterResumeHandler(scope: DeferredToolsReloadScopeKey): void {
    this.resumeHandlers.delete(scopeKey(scope));
  }

  markToolResultDelivered(
    scope: DeferredToolsReloadScopeKey,
    toolCallId: string,
  ): boolean {
    const intent = this.intents.get(intentKey(scope, toolCallId));
    if (!intent || intent.delivered) {
      return false;
    }
    intent.delivered = true;
    this.armIntentTimeout(intent, this.activePhaseTimeoutMs);
    this.emit(intent);
    return true;
  }

  /** OpenCode's persisted ACP result correlates to its HTTP load by receipt. */
  markOpenCodeResultDelivered(
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
  ): boolean {
    const activeKey = this.activeByScope.get(scopeKey(scope));
    const intent = activeKey ? this.intents.get(activeKey) : undefined;
    if (
      !intent ||
      intent.providerType !== 'opencode' ||
      intent.requestId !== requestId ||
      intent.state !== 'result_pending'
    )
      return false;
    return this.markToolResultDelivered(scope, intent.toolCallId);
  }

  markToolResultDeliveredAndWaitForResume(
    scope: DeferredToolsReloadScopeKey,
    toolCallId: string,
    timeoutMs = 5000,
  ): Promise<boolean> {
    const target = this.intents.get(intentKey(scope, toolCallId));
    if (!target) {
      return Promise.resolve(false);
    }

    const key = intentKey(target.scope, target.toolCallId);
    const wait = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      const waiter = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      const waiters = this.resumeWaiters.get(key) ?? new Set<() => void>();
      waiters.add(waiter);
      this.resumeWaiters.set(key, waiters);
    });
    this.markToolResultDelivered(scope, toolCallId);
    return wait.then(() => true);
  }

  async begin(
    request: DeferredToolsReloadBeginRequest,
  ): Promise<DeferredToolsReloadAck> {
    const intent = this.lookup(request);
    if (!intent) {
      const completed = this.lookupCompletedAck(request);
      if (completed) {
        return completed;
      }
      return rejectedAck(
        request.requestId,
        'unknown_request',
        'Deferred-tools reload request was not found.',
      );
    }
    if (intent.requestId !== request.requestId) {
      return rejectedAck(
        request.requestId,
        'stale_request',
        'Deferred-tools reload request id does not match the active reload.',
      );
    }
    if (intent.state !== 'result_pending' && intent.state !== 'ui_prepared') {
      return {
        requestId: request.requestId,
        accepted: true,
        lifecycle: lifecycleForState(intent.state),
      };
    }
    const revalidationError = await this.catalogRevalidator(intent);
    if (!this.isActiveIntent(intent)) {
      const completed = this.lookupCompletedAck(request);
      if (completed) {
        return completed;
      }
      return rejectedAck(
        request.requestId,
        'unknown_request',
        'Deferred-tools reload expired while its catalog was being revalidated.',
      );
    }
    if (intent.requestId !== request.requestId) {
      return rejectedAck(
        request.requestId,
        'stale_request',
        'Deferred-tools reload request id does not match the active reload.',
      );
    }
    if (intent.state !== 'result_pending' && intent.state !== 'ui_prepared') {
      return {
        requestId: request.requestId,
        accepted: true,
        lifecycle: lifecycleForState(intent.state),
      };
    }
    if (revalidationError) {
      const message = `Deferred-tools catalog item disappeared or became unavailable before enablement: ${revalidationError}`;
      this.fail(intent, 'enable_failed', message);
      return {
        requestId: request.requestId,
        accepted: false,
        lifecycle: { kind: 'outcome', outcome: 'enable_failed' },
        rejection: { code: 'invalid_request', message },
      };
    }
    if (
      !additionsMatch(intent.additions, request.additions) ||
      !enabledResourcesMatch(intent.enabledResources, request.enabledResources)
    ) {
      const message =
        'Deferred-tools reload payload does not match the catalog selections validated by the coordinator.';
      this.fail(intent, 'rejected', message);
      return {
        requestId: request.requestId,
        accepted: false,
        lifecycle: { kind: 'outcome', outcome: 'rejected' },
        rejection: { code: 'invalid_request', message },
      };
    }
    intent.state = 'ui_prepared';
    this.armIntentTimeout(intent, this.activePhaseTimeoutMs);
    this.emit(intent);
    intent.state = 'interrupting';
    this.emit(intent);
    intent.state = 'enabling';
    this.emit(intent);
    return {
      requestId: request.requestId,
      accepted: true,
      lifecycle: lifecycleForState(intent.state),
    };
  }

  async finish(
    request: DeferredToolsReloadFinishRequest,
  ): Promise<DeferredToolsReloadAck> {
    const intent = this.lookup(request);
    if (!intent) {
      const completed = this.lookupCompletedAck(request);
      if (completed) {
        return completed;
      }
      return rejectedAck(
        request.requestId,
        'unknown_request',
        'Deferred-tools reload request was not found.',
      );
    }
    if (intent.requestId !== request.requestId) {
      return rejectedAck(
        request.requestId,
        'stale_request',
        'Deferred-tools reload request id does not match the active reload.',
      );
    }
    if (intent.state === 'completed') {
      return {
        requestId: request.requestId,
        accepted: true,
        lifecycle: lifecycleForState('completed'),
      };
    }
    if (intent.resumePromise) {
      return intent.resumePromise;
    }
    const handler = this.resumeHandlers.get(scopeKey(intent.scope));
    if (!handler) {
      this.fail(
        intent,
        'resume_failed',
        'No reload resume handler registered.',
      );
      return {
        requestId: request.requestId,
        accepted: false,
        lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
        rejection: {
          code: 'invalid_request',
          message: 'No reload resume handler registered.',
        },
      };
    }
    intent.state = 'resuming';
    this.armIntentTimeout(intent, this.activePhaseTimeoutMs);
    this.emit(intent);
    this.resolveResumeWaiters(intent);
    const resumePromise = this.resumeIntent(intent, request, handler);
    intent.resumePromise = resumePromise;
    return resumePromise;
  }

  private async resumeIntent(
    intent: ReloadIntent,
    request: DeferredToolsReloadFinishRequest,
    handler: DeferredToolsResumeHandler,
  ): Promise<DeferredToolsReloadAck> {
    try {
      await handler({
        scope: request.scope,
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        userMessageId: request.userMessageId,
        continuationText: request.continuationText,
        enabledResources: intent.enabledResources,
        sdkSessionId: request.resume.sdkSessionId,
        providerType: request.resume.providerType ?? intent.providerType,
        interfaceMode: request.resume.interfaceMode ?? intent.interfaceMode,
        pluginSelections: request.resume.pluginSelections,
        signal: intent.resumeAbortController.signal,
      });
      if (!this.isActiveIntent(intent) || intent.state !== 'resuming') {
        return {
          requestId: request.requestId,
          accepted: false,
          lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
          rejection: {
            code: 'invalid_request',
            message: 'Deferred-tools reload expired before resume completed.',
          },
        };
      }
      intent.state = 'completed';
      this.emit(intent);
      this.completedAcks.set(intentKey(intent.scope, intent.toolCallId), {
        requestId: request.requestId,
        accepted: true,
        lifecycle: lifecycleForState('completed'),
      });
      this.cleanup(intent);
      return {
        requestId: request.requestId,
        accepted: true,
        lifecycle: lifecycleForState('completed'),
      };
    } catch (error) {
      if (this.isActiveIntent(intent)) {
        this.fail(
          intent,
          'resume_failed',
          error instanceof Error
            ? error.message
            : 'Deferred-tools resume failed.',
        );
      }
      return {
        requestId: request.requestId,
        accepted: false,
        lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
        rejection: {
          code: 'invalid_request',
          message:
            error instanceof Error
              ? error.message
              : 'Deferred-tools resume failed.',
        },
      };
    }
  }

  private isActiveIntent(intent: ReloadIntent): boolean {
    return (
      this.intents.get(intentKey(intent.scope, intent.toolCallId)) === intent
    );
  }

  cancel(request: DeferredToolsReloadCancelRequest): DeferredToolsReloadAck {
    const intent = this.lookup(request);
    if (!intent) {
      return rejectedAck(
        request.requestId,
        'unknown_request',
        'Deferred-tools reload request was not found.',
      );
    }
    if (intent.requestId !== request.requestId) {
      return rejectedAck(
        request.requestId,
        'stale_request',
        'Deferred-tools reload request id does not match the active reload.',
      );
    }
    this.fail(
      intent,
      'cancelled',
      request.reason ?? 'Deferred-tools reload was cancelled.',
    );
    return {
      requestId: request.requestId,
      accepted: true,
      lifecycle: { kind: 'outcome', outcome: 'cancelled' },
    };
  }

  private resolveResumeWaiters(intent: ReloadIntent): void {
    const key = intentKey(intent.scope, intent.toolCallId);
    const waiters = this.resumeWaiters.get(key);
    if (!waiters) {
      return;
    }
    this.resumeWaiters.delete(key);
    for (const waiter of Array.from(waiters)) {
      waiter();
    }
  }

  private lookup(request: {
    scope: DeferredToolsReloadScopeKey;
    toolCallId: string;
  }): ReloadIntent | undefined {
    return this.intents.get(intentKey(request.scope, request.toolCallId));
  }

  private lookupCompletedAck(request: {
    scope: DeferredToolsReloadScopeKey;
    toolCallId: string;
    requestId: string;
  }): DeferredToolsReloadAck | undefined {
    const completed = this.completedAcks.get(
      intentKey(request.scope, request.toolCallId),
    );
    if (!completed) {
      return undefined;
    }
    if (completed.requestId === request.requestId) {
      return completed;
    }
    return rejectedAck(
      request.requestId,
      'stale_request',
      'Deferred-tools reload request id does not match the completed reload.',
    );
  }

  private emit(intent: ReloadIntent): void {
    const event: DeferredToolsReloadEvent = {
      scope: intent.scope,
      requestId: intent.requestId,
      toolCallId: intent.toolCallId,
      lifecycle: lifecycleForState(intent.state),
      enabledResources: intent.enabledResources,
      additions: intent.additions,
    };
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
  }

  private armIntentTimeout(intent: ReloadIntent, timeoutMs: number): void {
    const key = intentKey(intent.scope, intent.toolCallId);
    const previous = this.intentTimeouts.get(key);
    if (previous) {
      clearNodeTimeout(previous);
    }
    const timeout = setNodeTimeout(() => {
      if (this.intents.get(key) !== intent) return;
      const outcome =
        intent.state === 'resuming' ? 'resume_failed' : 'enable_failed';
      this.fail(
        intent,
        outcome,
        'Deferred-tools reload timed out before the reload handshake completed.',
      );
    }, timeoutMs);
    if (typeof timeout === 'object' && 'unref' in timeout) {
      timeout.unref();
    }
    this.intentTimeouts.set(key, timeout);
  }

  private fail(
    intent: ReloadIntent,
    outcome: 'cancelled' | 'enable_failed' | 'resume_failed' | 'rejected',
    message: string,
  ): void {
    const event: DeferredToolsReloadEvent = {
      scope: intent.scope,
      requestId: intent.requestId,
      toolCallId: intent.toolCallId,
      lifecycle: { kind: 'outcome', outcome },
      enabledResources: intent.enabledResources,
      error: { outcome, message },
    };
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
    this.cleanup(intent);
  }

  private cleanup(intent: ReloadIntent): void {
    const intentMapKey = intentKey(intent.scope, intent.toolCallId);
    const timeout = this.intentTimeouts.get(intentMapKey);
    if (timeout) {
      clearNodeTimeout(timeout);
      this.intentTimeouts.delete(intentMapKey);
    }
    if (intent.state !== 'completed') {
      intent.resumeAbortController.abort();
    }
    this.resolveResumeWaiters(intent);
    this.intents.delete(intentMapKey);
    const key = scopeKey(intent.scope);
    if (this.activeByScope.get(key) === intentMapKey) {
      this.activeByScope.delete(key);
    }
    // After the reload is fully cleared, so a callback sees it settled.
    const callbacks = this.settleCallbacks.get(intentMapKey) ?? [];
    this.settleCallbacks.delete(intentMapKey);
    for (const onSettled of callbacks) {
      try {
        onSettled();
      } catch {
        // A caller's release must not stop the others or the cleanup that
        // has already completed; callers own their own error handling.
      }
    }
  }
}

export const deferredToolsReloadCoordinator =
  new DeferredToolsReloadCoordinator();

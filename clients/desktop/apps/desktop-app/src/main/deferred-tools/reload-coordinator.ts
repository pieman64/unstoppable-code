import type {
  CoreDeferredToolReloads,
  DeferredToolReloadEvent,
  DeferredToolReloadScope,
} from '@canopy/core-runtime/node/agent/deferred-tools';
import {
  isTerminalDeferredToolsReloadLifecycle,
  type AgentProviderType,
  type AssistantMode,
  type ChatInterfaceMode,
  type ChatTabPluginSelections,
  type DeferredResourceSummary,
  type DeferredToolsReloadAck,
  type DeferredToolsReloadAdditions,
  type DeferredToolsReloadBeginRequest,
  type DeferredToolsReloadCancelRequest,
  type DeferredToolsReloadEvent,
  type DeferredToolsReloadFinishRequest,
  type DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import {
  mcpServerEntryId,
  pluginEntryId,
  skillEntryId,
} from '@canopy/protocol/canopy-core';
import { setTurnLifecycleHostRestartLookup } from '../agents/provider-turn-lifecycle';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { DesktopDeferredToolReloadPayload } from './reload-host';

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
type DesktopReloads = CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>;

let reloads: DesktopReloads | null = null;
let unsubscribeReloads: (() => void) | null = null;
const resumeHandlers = new Map<string, DeferredToolsResumeHandler>();
const listeners = new Set<Listener>();

function scopeKey(scope: DeferredToolsReloadScopeKey): string {
  return `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`;
}

function toCore(scope: DeferredToolsReloadScopeKey): DeferredToolReloadScope {
  return {
    workspaceId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
}

function toDesktop(
  scope: DeferredToolReloadScope,
): DeferredToolsReloadScopeKey {
  return {
    projectId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
}

function toDesktopEvent(
  event: DeferredToolReloadEvent<DesktopDeferredToolReloadPayload>,
): DeferredToolsReloadEvent {
  const { reload } = event;
  return {
    scope: toDesktop(reload.scope),
    requestId: reload.requestId,
    toolCallId: reload.toolCallId,
    lifecycle: event.lifecycle,
    enabledResources: [...reload.payload.enabledResources],
    ...(isTerminalDeferredToolsReloadLifecycle(event.lifecycle)
      ? {}
      : { additions: reload.payload.additions }),
    ...(event.error ? { error: event.error } : {}),
    ...(event.sdkSessionId ? { sdkSessionId: event.sdkSessionId } : {}),
  };
}

function publish(
  event: DeferredToolReloadEvent<DesktopDeferredToolReloadPayload>,
): void {
  const desktopEvent = toDesktopEvent(event);
  for (const listener of Array.from(listeners)) {
    try {
      listener(desktopEvent);
    } catch (error) {
      logMainProcessWarn('[deferred-tools] reload listener failed', error);
    }
  }
}

/** Installed by the desktop runtime (CAN-4127) and cleared at shutdown. */
export function setDeferredToolReloads(next: DesktopReloads | null): void {
  unsubscribeReloads?.();
  unsubscribeReloads = null;
  reloads = next;
  if (next) unsubscribeReloads = next.subscribe(publish);
}

/** For the reload host: the resume handler a turn registered for this chat. */
export function getRegisteredResumeHandler(
  scope: DeferredToolsReloadScopeKey,
): DeferredToolsResumeHandler | undefined {
  return resumeHandlers.get(scopeKey(scope));
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

/** Begin and finish are read-only compatibility: they report and never drive. */
function readOnlyAck(request: {
  scope: DeferredToolsReloadScopeKey;
  toolCallId: string;
  requestId: string;
}): DeferredToolsReloadAck {
  const scope = toCore(request.scope);
  const active = reloads?.active(scope) ?? null;
  if (active && active.toolCallId === request.toolCallId) {
    return active.requestId === request.requestId
      ? {
          requestId: request.requestId,
          accepted: true,
          lifecycle: { kind: 'state', state: active.state },
        }
      : rejectedAck(
          request.requestId,
          'stale_request',
          'Deferred-tools reload request id does not match the active reload.',
        );
  }
  const recent = reloads?.recent(scope, request.toolCallId) ?? null;
  if (recent) {
    return recent.requestId === request.requestId
      ? {
          requestId: request.requestId,
          accepted: recent.lifecycle.kind === 'state',
          lifecycle: recent.lifecycle,
        }
      : rejectedAck(
          request.requestId,
          'stale_request',
          'Deferred-tools reload request id does not match the completed reload.',
        );
  }
  return rejectedAck(
    request.requestId,
    'unknown_request',
    'Deferred-tools reload request was not found.',
  );
}

export const deferredToolsReloadCoordinator = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  },

  registerResumeHandler(
    scope: DeferredToolsReloadScopeKey,
    handler: DeferredToolsResumeHandler,
  ): () => void {
    const key = scopeKey(scope);
    resumeHandlers.set(key, handler);
    return (): void => {
      if (resumeHandlers.get(key) === handler) resumeHandlers.delete(key);
    };
  },

  unregisterResumeHandler(scope: DeferredToolsReloadScopeKey): void {
    resumeHandlers.delete(scopeKey(scope));
  },

  async request(input: {
    scope: DeferredToolsReloadScopeKey;
    toolCallId: string;
    providerType?: AgentProviderType;
    assistantMode?: AssistantMode;
    interfaceMode?: ChatInterfaceMode;
    additions: DeferredToolsReloadAdditions;
    enabledResources: DeferredResourceSummary[];
  }): Promise<
    | { accepted: true; requestId: string }
    | { accepted: false; reason: 'reload_in_progress' | 'unavailable' }
  > {
    if (!reloads) return { accepted: false, reason: 'unavailable' };
    const admission = await reloads.request({
      scope: toCore(input.scope),
      toolCallId: input.toolCallId,
      payload: {
        providerType: input.providerType,
        assistantMode: input.assistantMode,
        interfaceMode: input.interfaceMode,
        additions: input.additions,
        enabledResources: input.enabledResources,
      },
      origin: {
        kind: 'system',
        sourceId: `deferred-tools:${input.providerType ?? 'unknown'}`,
      },
      owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
      enabledEntryIds: [
        ...input.additions.skillRefs.map(skillEntryId),
        ...input.additions.pluginRefs.map(pluginEntryId),
        ...input.additions.mcpServerRefs.map(mcpServerEntryId),
      ],
    });
    return admission.accepted
      ? { accepted: true, requestId: admission.requestId }
      : { accepted: false, reason: admission.reason };
  },

  hasActiveReload(scope: DeferredToolsReloadScopeKey): boolean {
    return (reloads?.active(toCore(scope)) ?? null) !== null;
  },

  /**
   * Call `onSettled` once when the scope's active reload ends, however it
   * ends. Returns false, registering nothing, when no reload is active.
   */
  whenActiveReloadSettles(
    scope: DeferredToolsReloadScopeKey,
    onSettled: () => void,
  ): boolean {
    return reloads?.whenSettled(toCore(scope), onSettled) ?? false;
  },

  shouldSuppressProviderTerminal(scope: DeferredToolsReloadScopeKey): boolean {
    const active = reloads?.active(toCore(scope)) ?? null;
    return active !== null && active.state !== 'resuming';
  },

  /**
   * Whether the reload is restarting the scope's provider session. A turn
   * that session ends there was ended by the reload, not cancelled.
   */
  isRestartingSession(scope: DeferredToolsReloadScopeKey): boolean {
    const state = reloads?.active(toCore(scope))?.state;
    return (
      state === 'ui_prepared' ||
      state === 'interrupting' ||
      state === 'enabling'
    );
  },

  cancelActiveReload(
    scope: DeferredToolsReloadScopeKey,
    reason = 'Deferred-tools reload was cancelled.',
  ): boolean {
    return reloads?.cancel(toCore(scope), reason) ?? false;
  },

  cancelPendingToolResult(
    scope: DeferredToolsReloadScopeKey,
    toolCallId: string,
    reason: string,
  ): boolean {
    return (
      reloads?.cancelUnacknowledged(toCore(scope), toolCallId, reason) ?? false
    );
  },

  /** The provider accepted the Load result for this tool call. True once; the caller may then stop its own turn. */
  markToolResultDelivered(
    scope: DeferredToolsReloadScopeKey,
    toolCallId: string,
  ): boolean {
    return reloads?.acknowledge({ scope: toCore(scope), toolCallId }) ?? false;
  },

  /** OpenCode: the persisted ACP result carries the reload's request id. True once; only for an OpenCode reload in result_pending. */
  markOpenCodeResultDelivered(
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
  ): boolean {
    if (!reloads) return false;
    const coreScope = toCore(scope);
    const active = reloads.active(coreScope);
    if (
      !active ||
      active.payload.providerType !== 'opencode' ||
      active.state !== 'result_pending'
    )
      return false;
    return reloads.acknowledge({ scope: coreScope, requestId });
  },

  /** MCP proxy providers: acknowledge, then wait at most timeoutMs for the reload to reach resuming or settle. */
  markToolResultDeliveredAndWaitForResume(
    scope: DeferredToolsReloadScopeKey,
    toolCallId: string,
    timeoutMs = 5000,
  ): Promise<boolean> {
    const active = reloads?.active(toCore(scope)) ?? null;
    if (!reloads || !active || active.toolCallId !== toolCallId)
      return Promise.resolve(false);
    const current = reloads;
    const { requestId } = active;
    return new Promise<boolean>((resolve) => {
      let unsubscribe: () => void = () => undefined;
      const done = (): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      };
      const timer = setTimeout(done, timeoutMs);
      unsubscribe = current.subscribe((event) => {
        if (event.reload.requestId !== requestId) return;
        if (
          isTerminalDeferredToolsReloadLifecycle(event.lifecycle) ||
          (event.lifecycle.kind === 'state' &&
            event.lifecycle.state === 'resuming')
        )
          done();
      });
      current.acknowledge({ scope: toCore(scope), toolCallId });
    });
  },

  begin(
    request: DeferredToolsReloadBeginRequest,
  ): Promise<DeferredToolsReloadAck> {
    return Promise.resolve(readOnlyAck(request));
  },

  finish(
    request: DeferredToolsReloadFinishRequest,
  ): Promise<DeferredToolsReloadAck> {
    return Promise.resolve(readOnlyAck(request));
  },

  cancel(request: DeferredToolsReloadCancelRequest): DeferredToolsReloadAck {
    const scope = toCore(request.scope);
    const active = reloads?.active(scope) ?? null;
    if (
      reloads &&
      active &&
      active.toolCallId === request.toolCallId &&
      active.requestId === request.requestId
    ) {
      reloads.cancel(
        scope,
        request.reason ?? 'Deferred-tools reload was cancelled.',
        { requestId: request.requestId },
      );
      return {
        requestId: request.requestId,
        accepted: true,
        lifecycle: { kind: 'outcome', outcome: 'cancelled' },
      };
    }
    if (active && active.toolCallId === request.toolCallId)
      return rejectedAck(
        request.requestId,
        'stale_request',
        'Deferred-tools reload request id does not match the active reload.',
      );
    const recent = reloads?.recent(scope, request.toolCallId) ?? null;
    if (recent && recent.requestId !== request.requestId)
      return rejectedAck(
        request.requestId,
        'stale_request',
        'Deferred-tools reload request id does not match the completed reload.',
      );
    return rejectedAck(
      request.requestId,
      'unknown_request',
      'Deferred-tools reload request was not found.',
    );
  },
};

setTurnLifecycleHostRestartLookup((scope) =>
  deferredToolsReloadCoordinator.isRestartingSession(scope),
);

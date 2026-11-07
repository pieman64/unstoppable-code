import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { useEffect, useRef, type JSX } from 'react';
import type {
  AppAdvisorRendererToolRequest,
  AppAdvisorRendererToolResponse,
  AppAdvisorUiStateEnvelope,
  AppAdvisorAction,
  AppAdvisorBrowserAction,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  getAppAdvisorRendererToolRequestOriginChatId,
  getRendererToolRequestScopeKey,
} from '@canopy/desktop-shared/types';
import { isReplayableAppAdvisorResponse } from '@canopy/desktop-shared/lib/app-advisor-replay';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { showFilesInRenderer } from '@/lib/show-files';
import {
  registerInterfaceTools,
  unregisterAllInterfaceTools,
} from '@/client/interface-tools-client';
import { APP_ADVISOR_PRESENTATION_ACTION_TYPES } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  onTurnFileViewerClosed,
  revealTurnFileTarget,
} from '@/lib/turn-file-viewer';

function isBrowserAction(
  action: AppAdvisorAction,
): action is AppAdvisorBrowserAction {
  return action.type.startsWith('browser.');
}

/**
 * Bridge mounted in the main renderer. Handles only renderer-tool
 * variants whose answers are sourced from the main window:
 *  - `get_current_ui_state`: returns the latest envelope.
 *  - `dispatch_action`: routes through {@link dispatchAppAction}.
 *
 * `ask_user_question` requests must reach the App Advisor renderer's
 * bridge (the question card mounts there). If one arrives here it is
 * treated as a soft routing error: respond with `surface_unavailable`
 * (retryable: true) so the main-process tool runtime can retry against
 * the correct surface once the App Advisor renderer is ready.
 */
export function AppAdvisorMainRuntimeBridge(): JSX.Element | null {
  return <RuntimeBridge surface="main" />;
}

/**
 * Bridge mounted in the standalone App Advisor renderer. In addition to
 * questions, it owns file and browser actions scoped to the Work Entry that
 * originated the running turn. Explicit target-workspace actions continue to
 * use the main renderer.
 */
export function AppAdvisorWindowRuntimeBridge(): JSX.Element | null {
  return <RuntimeBridge surface="app-advisor" />;
}

/**
 * Backwards-compatible export so legacy mount points can keep importing
 * `AppAdvisorRuntimeBridge` while the split rolls out. Defaults to the
 * main-surface bridge — the main window is the only place the old name
 * was mounted.
 */
export const AppAdvisorRuntimeBridge = AppAdvisorMainRuntimeBridge;

function RuntimeBridge({
  surface,
}: {
  surface: 'main' | 'app-advisor';
}): JSX.Element | null {
  const responseCacheRef = useRef<Map<string, AppAdvisorRendererToolResponse>>(
    new Map(),
  );
  // Response cache, controllers and early cancellations are all keyed by
  // `getRendererToolRequestScopeKey`: request IDs are unique only per chat.
  const requestControllersRef = useRef<Map<string, AbortController>>(new Map());
  const inFlightRef = useRef<
    Map<string, Promise<AppAdvisorRendererToolResponse>>
  >(new Map());
  const fileCloseDisposers = useRef(new Map<string, () => void>());
  const cancelledRequestKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const closeDisposers = fileCloseDisposers.current;
    const disposeRequest = window.api.appAdvisor.onToolRequest((request) => {
      void handleRequest(request);
    });
    const disposeCancellation =
      window.api.appAdvisor.onToolRequestCancelled?.(
        ({ requestId, originChatId }) => {
          const requestKey = getRendererToolRequestScopeKey(
            requestId,
            originChatId,
          );
          const controller = requestControllersRef.current.get(requestKey);
          if (controller) {
            controller.abort();
          } else {
            cancelledRequestKeysRef.current.add(requestKey);
          }
          // Ask-user request IDs are minted per question by main
          // (`randomUUID()`), never from a provider or JSON-RPC ID, so the
          // question store's bare-ID keys cannot collide across chats.
          useAppAdvisorStore.getState().dismissQuestion(requestId);
        },
      ) ?? ((): undefined => undefined);
    void registerInterfaceTools(
      surface === 'main'
        ? ['ui.app_advisor.present', 'ui.get_current_ui_state', 'ui.show_files']
        : ['ui.app_advisor.show_files'],
      `interface-tools:${surface}:${crypto.randomUUID()}`,
    );
    return (): void => {
      disposeRequest();
      disposeCancellation();
      void unregisterAllInterfaceTools();
      closeDisposers.forEach((dispose) => dispose());
      closeDisposers.clear();
    };
    // `handleRequest` captures only refs/stable module functions; listing it
    // in deps would force a re-subscription on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;

  async function handleRequest(
    request: AppAdvisorRendererToolRequest,
  ): Promise<void> {
    const originChatId = getAppAdvisorRendererToolRequestOriginChatId(request);
    const cacheKey = getRendererToolRequestScopeKey(
      request.requestId,
      originChatId,
    );
    const cached = responseCacheRef.current.get(cacheKey);
    if (cached) {
      await window.api.appAdvisor.completeToolRequest(cached);
      return;
    }
    // A retry main sends after a timeout joins the run still in progress, so
    // an action is never run twice for one request id.
    const inFlight = inFlightRef.current.get(cacheKey);
    if (inFlight) {
      await window.api.appAdvisor.completeToolRequest(await inFlight);
      return;
    }
    const run = runRequest(request, cacheKey, originChatId);
    inFlightRef.current.set(cacheKey, run);
    let response: AppAdvisorRendererToolResponse;
    try {
      response = await run;
    } finally {
      inFlightRef.current.delete(cacheKey);
    }
    cacheResponse(cacheKey, response);
    await window.api.appAdvisor.completeToolRequest(response);
  }

  async function runRequest(
    request: AppAdvisorRendererToolRequest,
    cacheKey: string,
    originChatId: string | undefined,
  ): Promise<AppAdvisorRendererToolResponse> {
    const controller = new AbortController();
    if (cancelledRequestKeysRef.current.delete(cacheKey)) {
      controller.abort();
    }
    requestControllersRef.current.set(cacheKey, controller);
    let response: AppAdvisorRendererToolResponse;
    try {
      response = await routeRequest(request, controller.signal);
    } catch (error: unknown) {
      response = {
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            error instanceof Error ? error.message : 'Renderer tool failed.',
        },
        uiState: await getBestEffortEnvelope(surface),
      };
    } finally {
      if (requestControllersRef.current.get(cacheKey) === controller) {
        requestControllersRef.current.delete(cacheKey);
      }
    }

    return originChatId ? { ...response, originChatId } : response;
  }

  async function routeRequest(
    request: AppAdvisorRendererToolRequest,
    signal: AbortSignal,
  ): Promise<AppAdvisorRendererToolResponse> {
    if (request.kind === 'get_current_ui_state') {
      if (surface !== 'main') {
        return surfaceUnavailableResponse(
          request.requestId,
          surface,
          'get_current_ui_state must be handled by the main window.',
        );
      }
      // Page visibility can change without changing a composer's model slice.
      // Re-read mounted controls before handing their transient ids to an agent.
      useCurrentUiStateStore.getState().recomputeEnvelope();
      const envelope = useCurrentUiStateStore.getState().getEnvelope();
      return {
        requestId: request.requestId,
        ok: true,
        uiState: envelope,
      };
    }
    if (request.kind === 'dispatch_action') {
      if (
        request.interfaceToolCall === true &&
        !APP_ADVISOR_PRESENTATION_ACTION_TYPES.has(request.action.type) &&
        !(
          request.action.type === 'worktree-chat.open_tab' &&
          request.action.chatId
        )
      )
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: 'unsupported_action',
            message:
              'Only navigation, panel and window actions run through this tool.',
          },
        };
      const browserAction = isBrowserAction(request.action);
      if (surface !== 'main' && !browserAction) {
        return surfaceUnavailableResponse(
          request.requestId,
          surface,
          `Only ${ORCHESTRATOR_LABEL} browser actions can be handled by this window.`,
        );
      }
      let action = request.action;
      if (surface === 'app-advisor') {
        if (!isBrowserAction(request.action)) {
          return surfaceUnavailableResponse(
            request.requestId,
            surface,
            `Only browser actions can be handled by the ${ORCHESTRATOR_LABEL} window.`,
          );
        }
        if (request.action.projectId || request.action.worktreeId) {
          return surfaceUnavailableResponse(
            request.requestId,
            surface,
            'Explicit project browser actions must be handled by the main window.',
          );
        }
        if (!request.originWorktreeId) {
          return surfaceUnavailableResponse(
            request.requestId,
            surface,
            `The originating ${ORCHESTRATOR_LABEL} Work Entry is unavailable.`,
          );
        }
        const advisorBrowserAction: AppAdvisorBrowserAction = {
          ...request.action,
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: request.originWorktreeId,
        };
        action = advisorBrowserAction;
      }
      const dispatched = await dispatchAppAction({
        requestId: request.requestId,
        action,
        ...(typeof request.expectedUiRevision === 'number'
          ? { expectedUiRevision: request.expectedUiRevision }
          : {}),
        ...(request.originChatTabId
          ? { originChatTabId: request.originChatTabId }
          : {}),
        ...(request.hostSend ? { hostSend: request.hostSend } : {}),
        ...(request.originChatTabId && request.originWorktreeId
          ? {
              originChat: {
                projectId: request.originProjectId ?? APP_ADVISOR_PROJECT_ID,
                worktreeId: request.originWorktreeId,
                chatId: request.originChatTabId,
              },
            }
          : {}),
        source: 'assistant',
        signal,
      });
      return {
        requestId: request.requestId,
        ok: dispatched.ok,
        ...(dispatched.error ? { error: dispatched.error } : {}),
        ...(dispatched.result !== undefined
          ? { result: dispatched.result }
          : {}),
        ...(dispatched.uiState ? { uiState: dispatched.uiState } : {}),
      };
    }
    if (request.kind === 'ask_user_question') {
      if (surface !== 'app-advisor') {
        return surfaceUnavailableResponse(
          request.requestId,
          surface,
          `AskUserQuestion must be handled by the ${ORCHESTRATOR_LABEL} window.`,
        );
      }
      const answer = await useAppAdvisorStore
        .getState()
        .askUserQuestion(request.requestId, request.question, request.chatId);
      const uiState = await getBestEffortEnvelope(surface);
      if (answer === null) {
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: 'execution_failed',
            message: `${ORCHESTRATOR_LABEL} question was dismissed without an answer.`,
          },
          uiState,
        };
      }
      return {
        requestId: request.requestId,
        ok: true,
        answer,
        uiState,
      };
    }
    if (request.kind === 'show_files') {
      const targetsAdvisor =
        request.payload.target.projectId === APP_ADVISOR_PROJECT_ID;
      if (
        (targetsAdvisor && surface !== 'app-advisor') ||
        (!targetsAdvisor && surface !== 'main')
      ) {
        return surfaceUnavailableResponse(
          request.requestId,
          surface,
          targetsAdvisor
            ? `${ORCHESTRATOR_LABEL} files must be opened in the ${ORCHESTRATOR_LABEL} window.`
            : 'Project files must be opened in the main window.',
        );
      }
      const focusReturnId = request.payload.focusReturnId;
      if (focusReturnId && surface === 'main') {
        await revealTurnFileTarget(request.payload.target);
      }
      const result = await showFilesInRenderer(request.payload, surface, {
        reuseBrowserId: request.payload.reuseBrowserId,
      });
      if (focusReturnId && surface === 'main' && result.opened > 0) {
        const opened = result.files[0];
        const target = request.payload.target;
        const viewerKey = `${target.projectId}/${target.worktreeId}/${opened?.tabId ?? opened?.browserId}`;
        fileCloseDisposers.current.get(viewerKey)?.();
        fileCloseDisposers.current.set(
          viewerKey,
          onTurnFileViewerClosed(target, opened, () => {
            fileCloseDisposers.current.delete(viewerKey);
            void window.api.appAdvisor
              .notifyTurnFileClosed(focusReturnId)
              .catch(() => {});
          }),
        );
      }
      const jsonResult: NonNullable<AppAdvisorRendererToolResponse['result']> =
        {
          opened: result.opened,
          failed: result.failed,
          ...(result.presentation !== undefined
            ? { presentation: result.presentation }
            : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          ...(result.activated !== undefined
            ? { activated: result.activated }
            : {}),
          ...(result.deferred !== undefined
            ? { deferred: result.deferred }
            : {}),
          files: result.files.map((file) => ({
            path: file.path,
            ok: file.ok,
            ...(file.opened !== undefined ? { opened: file.opened } : {}),
            ...(file.activated !== undefined
              ? { activated: file.activated }
              : {}),
            ...(file.deferred !== undefined ? { deferred: file.deferred } : {}),
            ...(file.absolutePath !== undefined
              ? { absolutePath: file.absolutePath }
              : {}),
            ...(file.tabId !== undefined ? { tabId: file.tabId } : {}),
            ...(file.browserId !== undefined
              ? { browserId: file.browserId }
              : {}),
            ...(file.openedIn !== undefined ? { openedIn: file.openedIn } : {}),
            ...(file.warning !== undefined ? { warning: file.warning } : {}),
            ...(file.error !== undefined ? { error: file.error } : {}),
          })),
        };
      return {
        requestId: request.requestId,
        ok: result.opened > 0,
        result: jsonResult,
        uiState: await getBestEffortEnvelope(surface),
        ...(result.opened === 0
          ? {
              error: {
                code: 'invalid_target' as const,
                message:
                  result.files[0]?.error ??
                  'None of the requested files could be opened.',
              },
            }
          : {}),
      };
    }
    // Exhaustiveness: unreachable for the current union shape.
    const _exhaustive: never = request;
    void _exhaustive;
    throw new Error('Unsupported App Advisor renderer-tool request');
  }

  function cacheResponse(
    cacheKey: string,
    response: AppAdvisorRendererToolResponse,
  ): void {
    if (!isReplayableAppAdvisorResponse(response)) {
      responseCacheRef.current.delete(cacheKey);
      return;
    }
    responseCacheRef.current.set(cacheKey, response);
    if (responseCacheRef.current.size > 100) {
      const firstKey = responseCacheRef.current.keys().next().value;
      if (firstKey !== undefined) {
        responseCacheRef.current.delete(firstKey);
      }
    }
  }
}

/**
 * Best-effort envelope used in error / surface_unavailable responses.
 *
 * Main surface: the local `useCurrentUiStateStore` IS the canonical
 * envelope, so read it directly to avoid a self-IPC round trip.
 *
 * App Advisor surface: the App Advisor renderer does not own the main
 * UI state, so request it through IPC; fall back to the local (empty)
 * envelope only when the IPC rejects.
 */
async function getBestEffortEnvelope(
  surface: 'main' | 'app-advisor',
): Promise<AppAdvisorUiStateEnvelope> {
  if (surface === 'main') {
    return useCurrentUiStateStore.getState().getEnvelope();
  }
  try {
    return await window.api.appAdvisor.getState();
  } catch {
    return useCurrentUiStateStore.getState().getEnvelope();
  }
}

async function surfaceUnavailableResponse(
  requestId: string,
  surface: 'main' | 'app-advisor',
  message: string,
): Promise<AppAdvisorRendererToolResponse> {
  return {
    requestId,
    ok: false,
    error: {
      code: 'surface_unavailable',
      message,
      retryable: true,
    },
    uiState: await getBestEffortEnvelope(surface),
  };
}

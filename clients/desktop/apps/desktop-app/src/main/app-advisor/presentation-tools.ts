import { randomUUID } from 'node:crypto';
import {
  canopyJsonValueSchemaWithin,
  INTERFACE_TOOL_INPUT_MAX_BYTES,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorRendererToolRequest,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import { getSessionInterfaceToolRegistry } from '../agents/interface-tool-binding';
import {
  interfaceToolOutcomeToRendererResponse,
  requestAppAdvisorRendererTool,
  routeRendererToolRequest,
  setLatestAppAdvisorUiState,
  surfaceUnavailableResponse,
  type AppAdvisorRendererToolSurfaces,
} from '../ipc/app-advisor';

const PRESENTATION_ONLY_MESSAGE =
  'Only navigation, panel and window actions run through this tool.';

const actionInputSchema = canopyJsonValueSchemaWithin(
  INTERFACE_TOOL_INPUT_MAX_BYTES,
);

/** The interface tools the live session of this App Advisor chat was created with. */
export async function boundAppAdvisorInterfaceTools(
  destination: AppAdvisorWatcherDestination,
): Promise<readonly InterfaceToolName[]> {
  const { getActiveSessionCapabilityProfile } =
    await import('../agents/session-manager');
  return (
    getActiveSessionCapabilityProfile(
      destination.projectId,
      destination.worktreeId,
      destination.chatId,
    )?.interfaceTools ?? []
  );
}

function isPresentation(action: AppAdvisorAction): boolean {
  if (action.type === 'worktree-chat.open_tab') return Boolean(action.chatId);
  return appAdvisorActionDisposition(action.type)?.kind === 'presentation';
}

/**
 * CAN-4133 D8: one presentation action, served by the main window's lease.
 * A chat driven from another computer keeps today's routed path (D15).
 * Unbound or without a registry: today's surface_unavailable response, no delivery.
 */
export async function presentAppAdvisorAction(input: {
  action: AppAdvisorAction;
  requestId?: string;
  expectedUiRevision?: number;
  destination: AppAdvisorWatcherDestination;
  remoteFallbackSurfaces: AppAdvisorRendererToolSurfaces;
  /** The calling session's or route's bound interface tools; looked up from SDK sessions when absent. */
  boundTools?: readonly InterfaceToolName[];
  signal?: AbortSignal;
}): Promise<AppAdvisorActionResponse> {
  const { action, destination, expectedUiRevision, signal } = input;
  const requestId = input.requestId ?? randomUUID();
  if (!isPresentation(action))
    return {
      requestId,
      ok: false,
      error: { code: 'unsupported_action', message: PRESENTATION_ONLY_MESSAGE },
    };
  const request: AppAdvisorRendererToolRequest = {
    kind: 'dispatch_action',
    requestId,
    action,
    originWorktreeId: destination.worktreeId,
    originProjectId: destination.projectId,
    originChatTabId: destination.chatId,
    ...(expectedUiRevision !== undefined ? { expectedUiRevision } : {}),
  };
  if (routeRendererToolRequest(request) !== null)
    return requestAppAdvisorRendererTool(
      request,
      input.remoteFallbackSurfaces,
      signal ? { signal } : undefined,
    );
  const registry = getSessionInterfaceToolRegistry();
  const bound = (
    input.boundTools ?? (await boundAppAdvisorInterfaceTools(destination))
  ).includes('ui.app_advisor.present');
  if (!registry || !bound)
    return { ...surfaceUnavailableResponse(request), requestId };
  const serialized: unknown = JSON.parse(JSON.stringify(action));
  const actionInput = actionInputSchema.safeParse(serialized);
  if (!actionInput.success)
    return {
      requestId,
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'The action is too large to send to the window.',
      },
    };
  const outcome = await registry.invoke({
    toolName: 'ui.app_advisor.present',
    input: {
      action: actionInput.data,
      originWorktreeId: destination.worktreeId,
      originProjectId: destination.projectId,
      originChatTabId: destination.chatId,
      ...(expectedUiRevision !== undefined ? { expectedUiRevision } : {}),
    },
    scope: {
      workspaceId: destination.projectId,
      worktreeId: destination.worktreeId,
      chatId: destination.chatId,
    },
    ...(signal ? { signal } : {}),
  });
  const response = interfaceToolOutcomeToRendererResponse(outcome, request);
  if (response.ok && response.uiState)
    setLatestAppAdvisorUiState(response.uiState);
  return { ...response, requestId };
}

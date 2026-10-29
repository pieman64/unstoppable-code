import { rendererContentsOf } from '../lib/renderer-surface';
import { randomUUID } from 'node:crypto';
import {
  IPC_CHANNELS,
  type ApprovalPromptDecision,
  type ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  sendToWindowDetailed,
  type SendableBrowserWindow,
} from '../lib/window-send';
import { getObservabilityService } from '../observability';
import { getAttentionTracker } from '../services/attention-tracker';
import { createPendingApproval, rejectApproval } from './pending-approvals';

/**
 * Sends a tool-approval request to the renderer and awaits the user's
 * decision. Mirrors `requestAnswersFromRenderer`
 * (`canopy-tools/session-runtime.ts`), with two deliberate differences:
 *
 * - No timeout by default: approval prompts block the turn until a decision
 *   is resolved (or the session is torn down). Callers hosted behind an
 *   external deadline may provide a shorter fail-closed timeout.
 * - Undelivered requests throw instead of resolving a fallback value, so the
 *   caller fails closed (treats it as a deny) rather than silently allowing.
 */
export async function requestApprovalFromRenderer(options: {
  sessionKey: string;
  event: Omit<ApprovalRequestEvent, 'requestId'>;
  getWindow: () => SendableBrowserWindow | null;
  onAwaitingUser?: () => void;
  /**
   * Hands the caller the id of the prompt now pending in the registry, so it
   * can later find and resolve that prompt from main (CAN-3083). Invoked only
   * after the request has actually been delivered and registered: a caller can
   * never hold a requestId for a card the user was never shown.
   */
  onRegistered?: (requestId: string) => void;
  timeoutMs?: number;
}): Promise<ApprovalPromptDecision> {
  const requestId = randomUUID();
  const payload: ApprovalRequestEvent = {
    ...options.event,
    requestId,
  };

  const win = options.getWindow();
  const delivery = sendToWindowDetailed(
    win,
    IPC_CHANNELS.approvalRequest,
    payload,
  );
  if (!delivery.delivered) {
    throw new Error('Window not available');
  }
  if (!win) {
    throw new Error('Window not available');
  }

  const pendingDecision = createPendingApproval(
    requestId,
    options.sessionKey,
    rendererContentsOf(win.webContents),
    {
      projectId: options.event.projectId,
      worktreeId: options.event.worktreeId,
      chatId: options.event.chatId,
    },
    payload,
    () => {
      sendToWindowDetailed(
        options.getWindow(),
        IPC_CHANNELS.approvalCancelled,
        {
          requestId,
        },
      );
    },
  );
  options.onRegistered?.(requestId);
  const timeout =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          sendToWindowDetailed(
            options.getWindow(),
            IPC_CHANNELS.approvalCancelled,
            { requestId },
          );
          rejectApproval(requestId, 'approval_timeout');
        }, options.timeoutMs)
      : undefined;
  timeout?.unref?.();
  options.onAwaitingUser?.();
  getObservabilityService().pauseChatTurn(
    options.event.projectId,
    options.event.worktreeId,
    options.event.chatId,
  );
  // The turn is now parked on a human decision. This is one of the two
  // chokepoints that fire at exactly the moment a push is worth sending, so it
  // is also where the cloud attention signal is raised (CAN-3195). The title is
  // the approval card's own summary (the command, the path, the tool), which is
  // exactly the one-phrase context the push body wants.
  getAttentionTracker().mark({
    projectId: options.event.projectId,
    worktreeId: options.event.worktreeId,
    chatId: options.event.chatId,
    state: 'needs_input',
    reason: 'tool_approval',
    sourceId: `approval:${requestId}`,
    detail: options.event.title,
  });
  try {
    return await pendingDecision;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    getObservabilityService().resumeChatTurn(
      options.event.projectId,
      options.event.worktreeId,
      options.event.chatId,
    );
    getAttentionTracker().clear(
      options.event.projectId,
      options.event.worktreeId,
      options.event.chatId,
      `approval:${requestId}`,
    );
  }
}

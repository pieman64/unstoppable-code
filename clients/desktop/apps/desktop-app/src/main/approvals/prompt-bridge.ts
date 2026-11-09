import type {
  ApprovalClientPort,
  ApprovalRevalidation,
  ApprovalSettlement,
} from '@canopy/core-runtime/node/agent/approvals';
import {
  IPC_CHANNELS,
  type ApprovalPromptDecision,
  type ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import { getDesktopChatWaits } from '../chat-waits/desktop-chat-waits';
import { rendererContentsOf } from '../lib/renderer-surface';
import { windowClientPresence } from '../lib/window-client-presence';
import {
  sendToWindowDetailed,
  type SendableBrowserWindow,
} from '../lib/window-send';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { getAttentionTracker } from '../services/attention-tracker';
import { getDesktopApprovalBroker } from './approval-broker';

export type ApprovalBridgeResult =
  | {
      readonly kind: 'decision';
      readonly decision: ApprovalPromptDecision;
      readonly by: 'client' | 'host';
    }
  | { readonly kind: 'policy_denied' }
  | { readonly kind: 'revalidation_failed' };

/** The request was cancelled, expired or failed; `message` is the reason. */
export class ApprovalRequestEndedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ApprovalRequestEndedError';
  }
}

/** The window `getWindow` returns, and Remote Control bridges mirroring it, as one request's clients. */
export function windowApprovalPort(
  getWindow: () => SendableBrowserWindow | null,
): ApprovalClientPort<ApprovalRequestEvent> {
  return {
    presence: windowClientPresence(getWindow),
    // An undelivered send keeps the request open but is not a delivery, so
    // no allow is accepted until a later delivery reaches the window.
    deliver: (request): void => {
      if (
        !sendToWindowDetailed(getWindow(), IPC_CHANNELS.approvalRequest, {
          ...request.presentation,
          requestId: request.requestId,
          policyRevision: request.policyRevision,
        }).delivered
      ) {
        throw new Error('approval card not delivered');
      }
    },
    withdraw: (requestId): void => {
      sendToWindowDetailed(getWindow(), IPC_CHANNELS.approvalCancelled, {
        requestId,
      });
    },
    accepts: (responder): boolean => {
      const window = getWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        return false;
      }
      return (
        Array.isArray(responder) &&
        responder.includes(rendererContentsOf(window.webContents))
      );
    },
  };
}

/**
 * Opens a tool-approval request on the core broker and waits for it to
 * settle (CAN-4129). Nothing here allows a tool: only a decision the broker
 * accepted is returned as one.
 */
export async function requestApprovalDecision(options: {
  sessionKey: string;
  event: Omit<ApprovalRequestEvent, 'requestId' | 'policyRevision'>;
  getWindow: () => SendableBrowserWindow | null;
  revalidate: () => Promise<ApprovalRevalidation>;
  onAwaitingUser?: () => void;
  /** Called synchronously once the request is open, before it is delivered. */
  onRegistered?: (requestId: string) => void;
  timeoutMs?: number;
}): Promise<ApprovalBridgeResult> {
  const { projectId, worktreeId, chatId } = options.event;
  const port = windowApprovalPort(options.getWindow);
  // A request whose own window is absent at open is denied, as before the
  // broker: pipeline and worker sessions have no window to show it in.
  if (!port.presence.attached()) {
    throw new ApprovalRequestEndedError('approval_no_client');
  }
  const handle = getDesktopApprovalBroker().open({
    owner: options.sessionKey,
    scope: { workspaceId: projectId, worktreeId, chatId },
    presentation: (requestId) => ({ ...options.event, requestId }),
    port,
    timeoutMs: options.timeoutMs ?? null,
    revalidate: options.revalidate,
  });
  const open = getDesktopChatWaits().isOpen(handle.requestId);
  if (open) {
    options.onRegistered?.(handle.requestId);
    options.onAwaitingUser?.();
    getExecutionObservabilityIngest().pauseChatTurn(
      projectId,
      worktreeId,
      chatId,
    );
    // The turn is now parked on a human decision. This is one of the two
    // chokepoints that fire at exactly the moment a push is worth sending, so
    // it is also where the cloud attention signal is raised (CAN-3195). The
    // title is the approval card's own summary (the command, the path, the
    // tool), which is exactly the one-phrase context the push body wants.
    getAttentionTracker().mark({
      projectId,
      worktreeId,
      chatId,
      state: 'needs_input',
      reason: 'tool_approval',
      sourceId: `approval:${handle.requestId}`,
      detail: options.event.title,
    });
  }
  let settlement: ApprovalSettlement;
  try {
    settlement = await handle.settled;
  } finally {
    if (open) {
      getExecutionObservabilityIngest().resumeChatTurn(
        projectId,
        worktreeId,
        chatId,
      );
      getAttentionTracker().clear(
        projectId,
        worktreeId,
        chatId,
        `approval:${handle.requestId}`,
      );
    }
  }
  switch (settlement.state) {
    case 'allowed':
      return {
        kind: 'decision',
        decision: settlement.decision,
        by: settlement.by,
      };
    case 'denied':
      if (settlement.by === 'policy') {
        return settlement.reason === 'policy_denied'
          ? { kind: 'policy_denied' }
          : { kind: 'revalidation_failed' };
      }
      return {
        kind: 'decision',
        decision: settlement.decision,
        by: settlement.by,
      };
    case 'cancelled':
      throw new ApprovalRequestEndedError(settlement.reason);
    case 'expired':
      throw new ApprovalRequestEndedError('approval_timeout');
    case 'failed':
      throw new ApprovalRequestEndedError(
        settlement.reason === 'no_client'
          ? 'approval_no_client'
          : settlement.reason,
      );
  }
}

import {
  CoreApprovalRequests,
  type ApprovalAuthorityRevisions,
} from '@canopy/core-runtime/node/agent/approvals';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { getDesktopChatWaits } from '../chat-waits/desktop-chat-waits';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getApprovalAuthorityRevision,
  onApprovalAuthorityRevision,
} from './rule-revisions';

export const desktopApprovalAuthorityRevisions: ApprovalAuthorityRevisions = {
  current: getApprovalAuthorityRevision,
  subscribe: onApprovalAuthorityRevision,
};

let broker: CoreApprovalRequests<ApprovalRequestEvent> | null = null;

/** The one approval broker of this desktop authority (CAN-4129); built on first use. */
export function getDesktopApprovalBroker(): CoreApprovalRequests<ApprovalRequestEvent> {
  broker ??= new CoreApprovalRequests<ApprovalRequestEvent>({
    waits: getDesktopChatWaits(),
    revisions: desktopApprovalAuthorityRevisions,
    // Never log the error itself: it can carry command text.
    onError: (error, context): void =>
      logMainProcessWarn('approval_broker_error', {
        context,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
  });
  return broker;
}

/** Disposes the broker (its open requests settle cancelled); the next call builds a new one over the current lifecycle. */
export function resetDesktopApprovalBrokerForTests(): void {
  broker?.dispose();
  broker = null;
}

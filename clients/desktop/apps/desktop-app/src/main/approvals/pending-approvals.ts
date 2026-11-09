import type { PendingApprovalView } from '@canopy/core-runtime/node/agent/approvals';
import type {
  ApprovalPromptDecision,
  ApprovalRequestEvent,
  ApprovalSecretInputRequest,
} from '@canopy/desktop-shared/types';
import { getDesktopApprovalBroker } from './approval-broker';

// Pending tool approvals are owned by the core approval broker (CAN-4129).
// These adapters keep the names the IPC handlers, the approval session and
// the busy-session checks already use.

interface ApprovalIdentity {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface ApprovalResponder {
  /** Stable id of the answering sender, for replay detection. */
  readonly id: string;
  /** The sender and the window it acts for (`approvalOwnersFor`). */
  readonly owners: readonly object[];
}

// One-use secret consumers stay out of the replayable card presentation.
const secretConsumers = new Map<string, (secret: string) => void>();

function pendingView(
  requestId: string,
): PendingApprovalView<ApprovalRequestEvent> | undefined {
  return getDesktopApprovalBroker()
    .pending()
    .find((view) => view.requestId === requestId);
}

function scopeOf(identity: ApprovalIdentity): {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
} {
  return {
    workspaceId: identity.projectId,
    worktreeId: identity.worktreeId,
    chatId: identity.chatId,
  };
}

function isSecretInputAllow(
  requestId: string,
  decision: ApprovalPromptDecision,
): boolean {
  return (
    decision.behavior === 'allow' &&
    pendingView(requestId)?.presentation.secretInput !== undefined
  );
}

/** Open requests these owners may answer, each with its current policy revision. */
export function pendingApprovalRequests(
  owners: readonly object[],
): ApprovalRequestEvent[] {
  return getDesktopApprovalBroker()
    .pending()
    .filter((view) => {
      try {
        return view.port.accepts(owners);
      } catch {
        return false;
      }
    })
    .map((view) => ({
      ...view.presentation,
      requestId: view.requestId,
      policyRevision: view.policyRevision,
    }));
}

/** True while an approval of this session is open on the chat wait lifecycle. */
export function hasPendingApprovalForSession(sessionKey: string): boolean {
  return getDesktopApprovalBroker().hasPendingForOwner(sessionKey);
}

export function hasPendingApprovalsForSession(sessionKey: string): boolean {
  return getDesktopApprovalBroker().hasPendingForOwner(sessionKey);
}

/** A client's answer: true when it settled the request or repeats the answer that did. */
export function resolveApproval(
  requestId: string,
  decision: ApprovalPromptDecision,
  responder: ApprovalResponder,
  identity: ApprovalIdentity,
  policyRevision: number | undefined,
): boolean {
  // A secret-input card is allowed only with its secret.
  if (isSecretInputAllow(requestId, decision)) return false;
  return (
    getDesktopApprovalBroker().respond({
      requestId,
      scope: scopeOf(identity),
      responderId: responder.id,
      responder: responder.owners,
      policyRevision: policyRevision ?? null,
      decision,
    }).status !== 'refused'
  );
}

/** Host release (CAN-3083): the session key is the authorization. */
export function resolveApprovalFromMain(
  requestId: string,
  sessionKey: string,
  decision: ApprovalPromptDecision,
): boolean {
  if (isSecretInputAllow(requestId, decision)) return false;
  return getDesktopApprovalBroker().resolveFromHost(
    requestId,
    sessionKey,
    decision,
  );
}

export function cancelApproval(requestId: string, reason: string): boolean {
  secretConsumers.delete(requestId);
  return getDesktopApprovalBroker().cancel(requestId, reason);
}

export function rejectAllApprovalsForSession(
  sessionKey: string,
  reason = 'session_destroyed',
): void {
  getDesktopApprovalBroker().cancelForOwner(sessionKey, reason);
}

/** One-use callback for a pending secret-input card, kept out of its presentation. */
export function registerApprovalSecretConsumer(
  requestId: string,
  consumer: (secret: string) => void,
): boolean {
  if (
    pendingView(requestId)?.presentation.secretInput === undefined ||
    secretConsumers.has(requestId)
  ) {
    return false;
  }
  secretConsumers.set(requestId, consumer);
  return true;
}

/**
 * A secret submission is the card's allow: it goes through the broker like
 * any client allow (current revision, eligible sender, first valid answer),
 * and the secret reaches its consumer only once the broker accepted it.
 */
export function resolveApprovalSecretInput(
  request: ApprovalSecretInputRequest,
  responder: ApprovalResponder,
): boolean {
  const consume = secretConsumers.get(request.requestId);
  if (
    !consume ||
    pendingView(request.requestId)?.presentation.secretInput?.bindingId !==
      request.bindingId
  ) {
    return false;
  }
  const result = getDesktopApprovalBroker().respond({
    requestId: request.requestId,
    scope: scopeOf(request),
    responderId: responder.id,
    responder: responder.owners,
    policyRevision: request.policyRevision ?? null,
    decision: { behavior: 'allow', scope: 'once' },
  });
  if (result.status !== 'accepted') return false;
  secretConsumers.delete(request.requestId);
  consume(request.secret);
  return true;
}

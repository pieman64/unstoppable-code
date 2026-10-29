import type {
  ApprovalPromptDecision,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';

interface ApprovalIdentity {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

type ApprovalOwnerWebContents = object & {
  once?: (event: 'destroyed', listener: () => void) => unknown;
  removeListener?: (event: 'destroyed', listener: () => void) => unknown;
};

// Registry of in-flight tool-approval prompts, keyed by requestId. Mirrors
// `../mcp/pending-requests.ts`, but approval prompts never time out — an
// unanswered prompt blocks the turn indefinitely until the user (or session
// teardown) resolves it.
interface PendingApproval {
  resolve: (decision: ApprovalPromptDecision) => void;
  reject: (reason: Error) => void;
  sessionKey: string;
  ownerWebContents: ApprovalOwnerWebContents;
  identity: ApprovalIdentity;
  event: ApprovalRequestEvent;
  /**
   * Called when the entry leaves the registry without the renderer having
   * answered it, so the owner can tell the renderer to take the card down.
   *
   * Fires from `rejectAllApprovalsForSession` — session teardown and turn
   * cancellation. A main-driven resolution (`resolveApprovalFromMain`)
   * deliberately does *not* call it: that path emits its own, more specific
   * `approval:auto-resolved` event carrying the mode and the receipt, and a
   * generic take-the-card-down callback would race it. The rename off
   * `onSessionDestroyed` reflects that the callback is about detachment in
   * general, not that every detaching path uses it.
   */
  onDetached?: () => void;
  onOwnerDestroyed?: () => void;
}

const pending = new Map<string, PendingApproval>();

function removeOwnerDestroyedListener(entry: PendingApproval): void {
  if (
    entry.onOwnerDestroyed &&
    typeof entry.ownerWebContents.removeListener === 'function'
  ) {
    entry.ownerWebContents.removeListener('destroyed', entry.onOwnerDestroyed);
  }
}

export function pendingApprovalRequests(
  ownerWebContents: ApprovalOwnerWebContents,
): ApprovalRequestEvent[] {
  return Array.from(pending.values())
    .filter((entry) => entry.ownerWebContents === ownerWebContents)
    .map((entry) => entry.event);
}

export function createPendingApproval(
  requestId: string,
  sessionKey: string,
  ownerWebContents: ApprovalOwnerWebContents,
  identity: ApprovalIdentity,
  event: ApprovalRequestEvent,
  onDetached?: () => void,
): Promise<ApprovalPromptDecision> {
  return new Promise<ApprovalPromptDecision>((resolve, reject) => {
    const onOwnerDestroyed =
      typeof ownerWebContents.once === 'function'
        ? (): void => {
            rejectApproval(requestId, 'renderer_destroyed');
          }
        : undefined;
    const entry: PendingApproval = {
      resolve,
      reject,
      sessionKey,
      ownerWebContents,
      identity,
      event,
      ...(onDetached ? { onDetached } : {}),
      ...(onOwnerDestroyed ? { onOwnerDestroyed } : {}),
    };
    pending.set(requestId, entry);
    if (onOwnerDestroyed) {
      ownerWebContents.once?.('destroyed', onOwnerDestroyed);
    }
  });
}

export function resolveApproval(
  requestId: string,
  decision: ApprovalPromptDecision,
  ownerWebContents: ApprovalOwnerWebContents,
  identity: ApprovalIdentity,
): boolean {
  const entry = pending.get(requestId);
  if (
    !entry ||
    entry.ownerWebContents !== ownerWebContents ||
    entry.identity.projectId !== identity.projectId ||
    entry.identity.worktreeId !== identity.worktreeId ||
    entry.identity.chatId !== identity.chatId
  ) {
    return false;
  }
  pending.delete(requestId);
  removeOwnerDestroyedListener(entry);
  entry.resolve(decision);
  return true;
}

/**
 * Resolves a pending approval from the main process rather than from a user
 * click. Used when a mode widening releases a card that is already on screen
 * (CAN-3083).
 *
 * `resolveApproval` guards on `ownerWebContents` identity because it is
 * *renderer*-initiated and the sender must be proven to own the prompt. This
 * caller is main, and `sessionKey` is the same ownership token
 * `rejectAllApprovalsForSession` already trusts — so the session key is the
 * authorization here, and a mismatch returns `false` rather than settling
 * someone else's prompt.
 *
 * Returns `false` when the entry is already gone, which is the normal outcome
 * of a race with the user's own click: their explicit decision wins.
 *
 * Synchronous `get` → `delete` → settle with no `await` in between, matching
 * every other settler so the map entry stays a compare-and-delete token.
 */
export function resolveApprovalFromMain(
  requestId: string,
  sessionKey: string,
  decision: ApprovalPromptDecision,
): boolean {
  const entry = pending.get(requestId);
  if (!entry || entry.sessionKey !== sessionKey) {
    return false;
  }
  pending.delete(requestId);
  removeOwnerDestroyedListener(entry);
  entry.resolve(decision);
  return true;
}

export function rejectApproval(requestId: string, reason: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  removeOwnerDestroyedListener(entry);
  entry.reject(new Error(reason));
}

export function rejectAllApprovalsForSession(
  sessionKey: string,
  reason = 'session_destroyed',
): void {
  const ids = Array.from(pending.keys());
  for (const id of ids) {
    const entry = pending.get(id);
    if (entry && entry.sessionKey === sessionKey) {
      pending.delete(id);
      removeOwnerDestroyedListener(entry);
      entry.onDetached?.();
      entry.reject(new Error(reason));
    }
  }
}

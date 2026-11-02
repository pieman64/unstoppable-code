import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';

interface PendingRequest {
  resolve: (answers: McpQuestionAnswer[]) => void;
  reject: (reason: Error) => void;
  sessionKey: string;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();
const cancelledAskUserRequests = new Set<string>();

/** True while a question for this session waits on the user. */
export function hasPendingRequestForSession(sessionKey: string): boolean {
  return Array.from(pending.values()).some(
    (entry) => entry.sessionKey === sessionKey,
  );
}

export function createPendingRequest(
  requestId: string,
  sessionKey: string,
  options?: { timeoutMs?: number; onTimeout?: () => void },
): Promise<McpQuestionAnswer[]> {
  return new Promise<McpQuestionAnswer[]>((resolve, reject) => {
    const entry: PendingRequest = { resolve, reject, sessionKey };
    if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        pending.delete(requestId);
        options.onTimeout?.();
        reject(new Error('ask_user_timeout'));
      }, options.timeoutMs);
    }
    pending.set(requestId, entry);
  });
}

function clearEntryTimer(entry: PendingRequest): void {
  if (entry.timer !== undefined) {
    clearTimeout(entry.timer);
  }
}

export function resolveRequest(
  requestId: string,
  answers: McpQuestionAnswer[],
): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearEntryTimer(entry);
  entry.resolve(answers);
  return true;
}

export function rejectRequest(requestId: string, reason: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  if (reason === 'ask_user_cancelled') cancelledAskUserRequests.add(requestId);
  pending.delete(requestId);
  clearEntryTimer(entry);
  entry.reject(new Error(reason));
  return true;
}

export function isAskUserRequestCancelled(requestId: string): boolean {
  return cancelledAskUserRequests.has(requestId);
}

export function clearAskUserRequestCancellation(requestId: string): void {
  cancelledAskUserRequests.delete(requestId);
}

export function hasPendingRequestsForSession(sessionKey: string): boolean {
  for (const entry of Array.from(pending.values())) {
    if (entry.sessionKey === sessionKey) return true;
  }
  return false;
}

export function rejectAllForSession(sessionKey: string): void {
  const ids = Array.from(pending.keys());
  for (const id of ids) {
    const entry = pending.get(id);
    if (entry && entry.sessionKey === sessionKey) {
      pending.delete(id);
      clearEntryTimer(entry);
      entry.reject(new Error('session_destroyed'));
    }
  }
}

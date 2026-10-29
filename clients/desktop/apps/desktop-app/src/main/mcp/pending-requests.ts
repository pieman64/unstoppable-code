import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';

interface PendingRequest {
  resolve: (answers: McpQuestionAnswer[]) => void;
  reject: (reason: Error) => void;
  sessionKey: string;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

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

export function rejectRequest(requestId: string, reason: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearEntryTimer(entry);
  entry.reject(new Error(reason));
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

import { isE2eBuild } from './e2e-gate';

/**
 * Chats whose root turn an E2E spec opened through the turn-lifecycle seam
 * and has not ended, by worktree scope. Such a turn has no provider session,
 * so host reconciliation would otherwise settle it as interrupted on the next
 * state read, which a real streaming turn never sees.
 */
const liveInjectedTurns = new Map<string, Set<string>>();

function scopeKey(projectId: string, worktreeId: string): string {
  return JSON.stringify([projectId, worktreeId]);
}

export function setE2eInjectedTurnLive(
  scope: { projectId: string; worktreeId: string; chatId: string },
  live: boolean,
): void {
  if (!isE2eBuild()) return;
  const key = scopeKey(scope.projectId, scope.worktreeId);
  const chatIds = liveInjectedTurns.get(key) ?? new Set<string>();
  if (live) chatIds.add(scope.chatId);
  else chatIds.delete(scope.chatId);
  if (chatIds.size > 0) liveInjectedTurns.set(key, chatIds);
  else liveInjectedTurns.delete(key);
}

/** Chats with an open E2E-injected root turn; always empty outside E2E builds. */
export function getE2eInjectedLiveTurnChatIds(
  projectId: string,
  worktreeId: string,
): string[] {
  if (!isE2eBuild()) return [];
  return Array.from(
    liveInjectedTurns.get(scopeKey(projectId, worktreeId)) ?? [],
  );
}

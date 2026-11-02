import type { ChatTab, PendingPlanExit } from '@/stores/chatStore';

/** Resolve live or restored approval state for this composer's own scope. */
export function resolveComposerPendingPlanExit(
  tab:
    | Pick<ChatTab, 'id' | 'pendingPlanExit' | 'pendingPlanExitRequestId'>
    | null
    | undefined,
  scope:
    | { readonly projectId: string; readonly worktreeId: string }
    | null
    | undefined,
  pendingPlanExits: Readonly<Record<string, PendingPlanExit>>,
): PendingPlanExit | null {
  if (!tab || !scope) return null;
  const live = Object.values(pendingPlanExits).find(
    (exit) =>
      exit.chatId === tab.id &&
      exit.projectId === scope.projectId &&
      exit.worktreeId === scope.worktreeId,
  );
  if (live) return live;
  if (!tab.pendingPlanExit) return null;
  const source = tab.pendingPlanExit.source;
  return {
    requestId: tab.pendingPlanExitRequestId ?? '',
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: tab.id,
    source:
      source === 'codex' || source === 'cursor' || source === 'opencode'
        ? source
        : 'claude',
    toolInput: tab.pendingPlanExit,
  };
}

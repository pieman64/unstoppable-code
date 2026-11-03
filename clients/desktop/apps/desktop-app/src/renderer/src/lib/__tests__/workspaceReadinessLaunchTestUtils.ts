import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import { useWorkspaceReadinessLaunchStore } from '@/stores/workspaceReadinessLaunchStore';

/**
 * Test double for the launcher's record write, for suites that mock the
 * launcher wholesale: a successful launch leaves the same record the real
 * launcher writes, pointing at `worktree-1` / `chat-1` unless told otherwise.
 */
export function recordMockLaunch(
  workspaceId: string,
  issue: WorkspaceReadinessIssue,
  baseWorktreeId?: string,
  destination: { worktreeId: string; chatId: string } = {
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  },
): void {
  useWorkspaceReadinessLaunchStore.getState().recordLaunch({
    workspaceId,
    issueKey: workspaceReadinessIssueKey(issue),
    issueCode: issue.code,
    ...(baseWorktreeId === undefined ? {} : { baseWorktreeId }),
    ...destination,
    launchedAt: '2026-10-31T12:00:00.000Z',
  });
}

export function resetWorkspaceReadinessLaunches(): void {
  window.localStorage.clear();
  useWorkspaceReadinessLaunchStore.setState({
    records: {},
    pendingSendKeys: {},
    failedSendKeys: {},
  });
}

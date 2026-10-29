import { forkWorktreePanelLayout } from '@/lib/panels/persistence-bridge';
import { useChatStore } from '@/stores/chatStore';

export interface ForkOpenWorktreeStateRequest {
  readonly projectId: string;
  readonly sourceWorktreeId: string;
  readonly destinationWorktreeId: string;
}

/** Carries live tabs and their panel layout into a branched worktree. */
export async function forkOpenWorktreeState(
  request: ForkOpenWorktreeStateRequest,
): Promise<void> {
  const tabBindings = await useChatStore
    .getState()
    .forkOpenTabsToWorktree(request);
  await forkWorktreePanelLayout({ ...request, tabBindings });
}

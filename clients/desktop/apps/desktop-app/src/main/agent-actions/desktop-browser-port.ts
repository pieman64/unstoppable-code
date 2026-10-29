import type { AgentBrowserPort } from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { dispatchWorktreeAction } from '../canopy-tools/worktree-actions';

/**
 * Runs browser actions on the calling chat's in-app browser through the
 * retained worktree action path, which resolves the browser, its runtime
 * generation and profile, and the action's receipts.
 */
export const desktopBrowserPort: AgentBrowserPort<CanopyInjectedToolRuntime> = {
  dispatch: async (action, call) => {
    const runtime = call.host.worktreeActionRuntime;
    if (!runtime) {
      return {
        text: 'DispatchAction is only available for worktree chats.',
        isError: true,
      };
    }
    return dispatchWorktreeAction({ action }, runtime);
  },
};

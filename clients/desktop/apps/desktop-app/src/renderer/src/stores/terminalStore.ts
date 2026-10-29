import { addTerminalRemovedListener } from '@canopy/app-state/terminal';
import { useTerminalDrawerAttentionStore } from './terminalDrawerAttentionStore';
import './terminalActivityStore';
export {
  useTerminalStore,
  ensureTerminalWorktreeHydrated,
  formatGroupLabel,
  resolveTerminalRowLabel,
  selectBucket,
  type KnownTerminalSession,
  type WorktreeTerminalBucket,
} from '@canopy/app-state/terminal';
addTerminalRemovedListener(({ projectId, worktreeId, terminalId }): void => {
  useTerminalDrawerAttentionStore
    .getState()
    .remove(`${projectId}/${worktreeId}`, terminalId);
});

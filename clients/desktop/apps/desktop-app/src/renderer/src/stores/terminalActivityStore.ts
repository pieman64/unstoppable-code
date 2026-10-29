import {
  configureTerminalActivityHost,
  removeTerminalActivityEntries,
} from '@canopy/app-state/terminal';
import { useChatStore } from './chatStore';
import { useClaudeTerminalStore } from './claudeTerminalStore';
import { useNavigationStore } from './navigationStore';
export {
  useTerminalActivityStore,
  type TerminalActivityEntry,
} from '@canopy/app-state/terminal';

configureTerminalActivityHost({
  isLifecycleManagedTerminal: (terminalId): boolean =>
    useClaudeTerminalStore.getState().terminalIdIndex[terminalId] !== undefined,
  isWorktreeSelected: (worktreeKey): boolean => {
    if (useNavigationStore.getState().activePage !== 'main') return false;
    const selected = useChatStore.getState().selectedWorktree;
    return (
      selected !== null &&
      `${selected.projectId}/${selected.worktreeId}` === worktreeKey
    );
  },
});

let claudeTerminalIndexUnsubscribe: (() => void) | null = null;
function removeIndexedClaudeTerminalActivity(
  state: ReturnType<typeof useClaudeTerminalStore.getState>,
  previous: ReturnType<typeof useClaudeTerminalStore.getState>,
): void {
  const addedTerminalIds = Object.keys(state.terminalIdIndex).filter(
    (terminalId) => previous.terminalIdIndex[terminalId] === undefined,
  );
  if (addedTerminalIds.length > 0)
    removeTerminalActivityEntries(addedTerminalIds);
}

export function initTerminalActivitySubscriptions(): () => void {
  if (!claudeTerminalIndexUnsubscribe) {
    claudeTerminalIndexUnsubscribe = useClaudeTerminalStore.subscribe(
      removeIndexedClaudeTerminalActivity,
    );
  }
  return disposeTerminalActivitySubscriptions;
}
export function disposeTerminalActivitySubscriptions(): void {
  const unsubscribe = claudeTerminalIndexUnsubscribe;
  claudeTerminalIndexUnsubscribe = null;
  unsubscribe?.();
}

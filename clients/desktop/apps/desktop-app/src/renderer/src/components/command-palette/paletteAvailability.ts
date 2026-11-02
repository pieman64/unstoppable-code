import {
  type CommandDefinition,
  type CommandId,
} from '@/lib/keyboardShortcuts';
import { useChatStore } from '@/stores/chatStore';
import { isCoworkChatTarget } from '@/lib/cowork';

export interface PaletteCommandAvailability {
  hasNormalSelectedWorktree: boolean;
  /** A selected cowork work entry (satisfies `allowCoworkSelection` commands). */
  hasCoworkSelectedWorkEntry: boolean;
  hasActiveChatTab: boolean;
  /** The active tab is a conversation, not a file. */
  hasActiveConversationTab?: boolean;
}

export function getPaletteCommandAvailability(
  selectedWorktree: { projectId: string; worktreeId: string } | null,
  selectedWorktreeKey: string | null,
): PaletteCommandAvailability {
  const isCowork =
    selectedWorktree !== null && isCoworkChatTarget(selectedWorktree.projectId);
  const activeTabId =
    selectedWorktreeKey === null
      ? undefined
      : useChatStore.getState().worktreeChats[selectedWorktreeKey]?.activeTabId;
  const activeTab =
    activeTabId === undefined || selectedWorktreeKey === null
      ? undefined
      : useChatStore
          .getState()
          .worktreeChats[
            selectedWorktreeKey
          ]?.tabs.find((tab) => tab.id === activeTabId);

  return {
    hasNormalSelectedWorktree: selectedWorktree !== null && !isCowork,
    hasCoworkSelectedWorkEntry: isCowork,
    hasActiveChatTab: Boolean(activeTabId),
    hasActiveConversationTab:
      activeTab !== undefined && activeTab.kind !== 'file',
  };
}

export function isPaletteCommandAvailable(
  definition: CommandDefinition,
  availability: PaletteCommandAvailability,
  paletteCommandIds: readonly CommandId[],
): boolean {
  if (!paletteCommandIds.includes(definition.id)) {
    return false;
  }

  if (definition.requiresWorktree) {
    const satisfied =
      availability.hasNormalSelectedWorktree ||
      (definition.allowCoworkSelection === true &&
        availability.hasCoworkSelectedWorkEntry);
    if (!satisfied) {
      return false;
    }
  }

  if (definition.requiresActiveChatTab && !availability.hasActiveChatTab) {
    return false;
  }

  if (
    definition.requiresActiveConversationTab &&
    availability.hasActiveConversationTab !== true
  ) {
    return false;
  }

  return true;
}

export function getPaletteCommandUnavailableMessage(
  commandId: CommandId,
): string {
  switch (commandId) {
    case 'new-chat-tab':
      return 'Select a worktree to open a new chat tab.';
    case 'close-chat-tab':
      return 'Select an active worktree chat tab to close it.';
    case 'new-worktree-current-context':
      return 'Select a worktree to create another worktree in the same project.';
    case 'open-worktree-scripts':
      return 'Select a worktree to open its scripts settings.';
    case 'open-worktree-hooks':
      return 'Select a worktree to open its hooks settings.';
    case 'open-file-search-palette':
      return 'Select a worktree to search its files.';
    case 'open-current-pr':
      return 'Select a worktree to open its pull request.';
    case 'open-ledger-panel':
      return 'Select a task to open its Feed.';
    case 'open-cost-panel':
      return 'Select a task to open its Cost panel.';
    case 'open-session-breakdown':
      return 'Select an active chat to open its Session breakdown.';
    case 'panel-select-next-tab':
    case 'panel-select-previous-tab':
      return 'Open a panel group with at least two tabs to switch tabs.';
    default:
      return 'This command is unavailable right now.';
  }
}

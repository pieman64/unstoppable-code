// Re-runs Claude command discovery when Mod admission changes, so an allowed
// Mod's commands appear in the composer before the chat's next message.
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  noteClaudeModAdmissionChange,
  requestDiscoveryForChatTab,
  resolveDiscoveryProviderType,
} from './discovery';
import { chatStoreApi } from './store-ref';
import { getDefaultPlugins } from './tab-utils';
import { worktreeKey } from './utils';

let admissionSignature: string | undefined;

/**
 * Follows the saved Mod admissions. The first call only records them; on a
 * change the selected chat discovers again now, and other Claude tabs when
 * they are next shown.
 */
export function followClaudeModAdmissionPreferences(
  preferences: Pick<
    PreferencesData,
    'claudeModAdmissions' | 'claudeModsDisabled'
  >,
): void {
  const signature = JSON.stringify([
    preferences.claudeModsDisabled,
    preferences.claudeModAdmissions,
  ]);
  const previous = admissionSignature;
  admissionSignature = signature;
  if (previous === undefined || previous === signature) return;

  noteClaudeModAdmissionChange();
  const state = chatStoreApi().getState();
  const selection = state.selectedWorktree;
  if (!selection) return;
  const chats = state.worktreeChats[worktreeKey(selection)];
  const tab = chats?.tabs.find(
    (candidate) => candidate.id === chats.activeTabId,
  );
  if (!tab || resolveDiscoveryProviderType(tab) === 'codex') return;
  requestDiscoveryForChatTab({
    projectId: selection.projectId,
    worktreeId: selection.worktreeId,
    tab,
    defaultPluginSelections: getDefaultPlugins(
      selection.projectId,
      selection.worktreeId,
      state.worktreeDefaultPlugins,
    ),
  });
}

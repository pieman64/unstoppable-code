import {
  CHAT_LABEL,
  CHAT_UNIT_LABEL_PLURAL,
  WORKTREE_LABEL,
} from '@canopy/protocol';
import type { PreferencesData } from '@canopy/desktop-shared/types';

export type DeferredToolsPreferenceField =
  | 'deferredToolsWorktreeChatsEnabled'
  | 'deferredToolsStandaloneChatsEnabled'
  | 'deferredToolsAppAdvisorEnabled'
  | 'deferredToolsPipelineAssistantEnabled';

export interface DeferredToolsRowDescriptor {
  field: DeferredToolsPreferenceField;
  title: string;
  helperText: string;
  testId: string;
}

export const DEFERRED_TOOLS_ROW_DESCRIPTORS: readonly DeferredToolsRowDescriptor[] =
  [
    {
      field: 'deferredToolsWorktreeChatsEnabled',
      title: `${WORKTREE_LABEL} ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`,
      helperText: `Initial setting for new chats attached to a ${WORKTREE_LABEL.toLowerCase()}.`,
      testId: 'settings-plugins-deferred-worktree-chats',
    },
    {
      field: 'deferredToolsStandaloneChatsEnabled',
      title: `${CHAT_LABEL} ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`,
      helperText: `Initial setting for new chats in ${CHAT_LABEL.toLowerCase()} projects.`,
      testId: 'settings-plugins-deferred-standalone-chats',
    },
    {
      field: 'deferredToolsAppAdvisorEnabled',
      title: 'App Advisor',
      helperText: 'Initial setting for new App Advisor chats.',
      testId: 'settings-plugins-deferred-app-advisor',
    },
    {
      field: 'deferredToolsPipelineAssistantEnabled',
      title: 'Pipeline Assistant',
      helperText: 'Initial setting for new Pipeline Assistant chats.',
      testId: 'settings-plugins-deferred-pipeline-assistant',
    },
  ] as const;

export function buildDeferredToolsPreferencePatch(
  field: DeferredToolsPreferenceField,
  value: boolean,
): Partial<PreferencesData> {
  return { [field]: value };
}

import {
  CHAT_LABEL,
  CHAT_UNIT_LABEL_PLURAL,
  WORKTREE_LABEL,
} from '@canopy/protocol';
import type { PreferencesData } from '@canopy/desktop-shared/types';

export type MultiAgentField =
  | 'codexMultiAgentWorktreeChatsEnabled'
  | 'codexMultiAgentStandaloneChatsEnabled'
  | 'codexMultiAgentAppAdvisorEnabled'
  | 'codexMultiAgentPipelinesEnabled';

export interface MultiAgentRowDescriptor {
  field: MultiAgentField;
  title: string;
  helperText: string;
  testId: string;
}

export const MULTI_AGENT_ROW_DESCRIPTORS: readonly MultiAgentRowDescriptor[] = [
  {
    field: 'codexMultiAgentWorktreeChatsEnabled',
    title: `${WORKTREE_LABEL} ${CHAT_UNIT_LABEL_PLURAL}`,
    helperText:
      'Applies to Codex chat sessions attached to a project worktree.',
    testId: 'settings-codex-multi-agent-worktree-chats',
  },
  {
    field: 'codexMultiAgentStandaloneChatsEnabled',
    title: `${CHAT_LABEL} ${CHAT_UNIT_LABEL_PLURAL}`,
    helperText: `Applies to Codex chat sessions in ${CHAT_LABEL.toLowerCase()} projects.`,
    testId: 'settings-codex-multi-agent-standalone-chats',
  },
  {
    field: 'codexMultiAgentAppAdvisorEnabled',
    title: 'App Advisor',
    helperText: 'Applies to Codex-backed App Advisor chats.',
    testId: 'settings-codex-multi-agent-app-advisor',
  },
  {
    field: 'codexMultiAgentPipelinesEnabled',
    title: 'Pipelines',
    helperText:
      'Applies to Codex-backed pipeline actions such as Agent Prompt and Agent Resume.',
    testId: 'settings-codex-multi-agent-pipelines',
  },
] as const;

export function buildMultiAgentPatch(
  field: MultiAgentField,
  value: boolean,
): Partial<PreferencesData> {
  switch (field) {
    case 'codexMultiAgentWorktreeChatsEnabled':
      return { codexMultiAgentWorktreeChatsEnabled: value };
    case 'codexMultiAgentStandaloneChatsEnabled':
      return { codexMultiAgentStandaloneChatsEnabled: value };
    case 'codexMultiAgentAppAdvisorEnabled':
      return { codexMultiAgentAppAdvisorEnabled: value };
    case 'codexMultiAgentPipelinesEnabled':
      return { codexMultiAgentPipelinesEnabled: value };
  }
}

export function saveMultiAgentPreference(
  field: MultiAgentField,
  value: boolean,
): Promise<PreferencesData> {
  return window.api.savePreferences(buildMultiAgentPatch(field, value));
}

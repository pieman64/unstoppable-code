/**
 * Shared fixtures for the `worktree_session_prompt` characterization (5a-1)
 * and the chat-action characterization (CAN-4549). Data only: each test file
 * keeps its own `jest.mock` calls, which must stay hoisted per file.
 */
import type {
  AutomationAction,
  ChatSendMessageRequest,
  ChatTabPluginSelections,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

export const TAB_PLUGINS: ChatTabPluginSelections = {
  collectionIds: ['tab-collection'],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
};

export function codexTab(
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Release planning',
    createdAt: '2026-05-28T11:00:00.000Z',
    kind: 'chat',
    messages: [],
    model: 'gpt-5.5',
    providerType: 'codex',
    executionHarness: 'codex',
    modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
    planMode: false,
    pluginSelections: TAB_PLUGINS,
    sdkSessionId: 'thread-1',
    globalInstructionsSnapshot: 'Snapshot.',
    codexReconstructionSeedId: 'seed-1',
    ...overrides,
  };
}

export type SessionAction = Extract<
  AutomationAction,
  { type: 'worktree_session_prompt' }
>;

export function sessionAction(
  settings: Partial<SessionAction> = {},
): SessionAction {
  return {
    type: 'worktree_session_prompt',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    prompt: 'Continue',
    ...settings,
  };
}

/** The request fields that do not depend on the chat's settings. */
export function envelope(request: ChatSendMessageRequest): object {
  return {
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    text: 'Continue',
    userMessageId: request.userMessageId,
    initiationSource: 'automation',
    automationName: 'Session settings',
    fileReferences: undefined,
    attachmentPaths: undefined,
    attachmentPromptContexts: undefined,
    inputMode: 'typed',
  };
}

/** `buildExistingTabDispatchOptions` for `codexTab()`. */
export const CODEX_TAB_OPTIONS = {
  providerType: 'codex',
  executionHarness: 'codex',
  model: 'gpt-5.5',
  modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
  pluginSelections: TAB_PLUGINS,
  deferredToolsAllowed: true,
  planMode: false,
  sdkSessionId: 'thread-1',
  globalInstructionsSnapshot: 'Snapshot.',
  codexReconstructionSeedId: 'seed-1',
};

/** The explicit fields a runtime change clears. */
export const RUNTIME_RESET = {
  sdkSessionId: undefined,
  globalInstructionsSnapshot: undefined,
  codexReconstructionSeedId: undefined,
  claudeForkSession: undefined,
  claudeForkResumeAt: undefined,
  claudeForkStartsFresh: undefined,
};

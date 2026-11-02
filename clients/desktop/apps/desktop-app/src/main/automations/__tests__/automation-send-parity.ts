/**
 * What each automation chat action does today, so the CAN-4549 moves onto the
 * shared project and bot port can prove they kept it. Expectations are plain
 * data; `chat-actions.characterization.test.ts` pins them on the native path,
 * and a moved action's parity test reuses them unchanged.
 */
import type { AutomationRunResult } from '@canopy/desktop-shared/types';

/** What a chat action must still do after the move. */
export interface ChatActionExpectation {
  /** The behavior fields of the request its turn is dispatched with. */
  request: Record<string, unknown>;
  /** `ChatServiceOptions` facts: tab lineage. */
  options: { executionContext?: string };
  result: AutomationRunResult;
  groupAssignment?: { itemId: string; name?: string } | null;
  dispatched: AutomationRunResult;
  /** Thrown message for failure rows; the parity test asserts it verbatim. */
  error?: string;
}

/** The request fields a parity check compares; everything else is a named delta or plumbing. */
export const PARITY_FIELDS = [
  'projectId',
  'worktreeId',
  'chatId',
  'userMessageId',
  'text',
  'fileReferences',
  'attachmentPaths',
  'attachmentPromptContexts',
  'inputMode',
  'model',
  'providerType',
  'executionHarness',
  'modelConfig',
  'thinkingLevel',
  'planMode',
  'approvalMode',
  'pluginSelections',
  'interfaceMode',
  'initiationSource',
  'automationName',
  'packageOverlay',
  'preserveActiveTab',
  'sdkSessionId',
  'globalInstructionsSnapshot',
  'codexReconstructionSeedId',
  'claudeForkSession',
  'claudeForkResumeAt',
  'claudeForkStartsFresh',
] as const;

/**
 * The parity fields an automation's own send states itself, rather than
 * reading them from the target chat: its address, composition and the
 * `automationDispatch` facts. The chat's settings come from the canonical tab
 * and the turn override, which their own suites pin.
 */
export const AUTOMATION_OWNED_PARITY_FIELDS = [
  'projectId',
  'worktreeId',
  'chatId',
  'userMessageId',
  'text',
  'fileReferences',
  'attachmentPaths',
  'attachmentPromptContexts',
  'inputMode',
  'initiationSource',
  'automationName',
  'packageOverlay',
  'preserveActiveTab',
] as const satisfies ReadonlyArray<(typeof PARITY_FIELDS)[number]>;

export function parityView(
  request: object,
  fields: ReadonlyArray<string> = PARITY_FIELDS,
): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of fields)
    if (Object.hasOwn(request, field))
      view[field] = Reflect.get(request, field);
  return view;
}

/** Fields a moved send may add or change, each tied to a decision. */
export const INTENDED_DELTAS = {
  agentSent: 'D3: the automation sender and title line',
  agentSenderProvenance: 'D3: version-1 provenance with the run owner',
  hiddenContext: 'D3: the IDs-only pipeline sender note',
  turnOverride: '5a-1 D2: the resolved override rides on the request',
  admittedApproval: '5a-1: set when the override names an approval mode',
  automationDispatch: 'CAN-4549: the main-only carrier itself',
  userMessageSource: "D3: 'agent' for a sender-marked row",
} as const;

/**
 * The IDs a native action mints with `randomUUID()`. Expectations take them
 * as inputs, so a moved action supplies its run-derived IDs instead.
 */
export interface MintedIds {
  /** A new chat's ID; absent when the send reuses a fresh worktree's starter chat. */
  chatId?: string;
  userMessageId: string;
}

/** What `gpt-5.5` resolves to with default preferences and no saved config. */
export const CODEX_PROMPT_SETTINGS = {
  model: 'gpt-5.5',
  providerType: 'codex',
  executionHarness: 'codex',
  modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
  thinkingLevel: 'high',
} as const;

/** The chat lane's default (`sonnet`, high) with no saved model. */
export const CLAUDE_DEFAULT_PROMPT_SETTINGS = {
  model: 'sonnet',
  providerType: 'claude',
  executionHarness: 'claude',
  modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
  thinkingLevel: 'high',
} as const;

/**
 * `worktree_prompt`: one `sendWorktreeChatMessage`. A fresh worktree leaves
 * `chatId` unset so the send reuses its starter chat; the run result names
 * the chat the send reports.
 */
export function worktreePromptExpectation(args: {
  ids: MintedIds;
  worktreeId: string;
  /** The chat the send reported. */
  sentChatId: string;
  automationName: string;
  request?: Record<string, unknown>;
  executionContext?: string;
  groupAssignment?: { itemId: string; name: string } | null;
}): ChatActionExpectation {
  const result = {
    projectId: 'workspace-1',
    worktreeId: args.worktreeId,
    chatId: args.sentChatId,
    userMessageId: args.ids.userMessageId,
  };
  return {
    request: {
      projectId: 'workspace-1',
      worktreeId: args.worktreeId,
      ...(args.ids.chatId === undefined ? {} : { chatId: args.ids.chatId }),
      userMessageId: args.ids.userMessageId,
      text: 'Implement',
      fileReferences: undefined,
      planMode: false,
      ...CODEX_PROMPT_SETTINGS,
      initiationSource: 'automation',
      automationName: args.automationName,
      approvalMode: 'full-access',
      ...args.request,
    },
    options: { executionContext: args.executionContext ?? 'personal' },
    result,
    groupAssignment: args.groupAssignment ?? null,
    dispatched: result,
  };
}

/**
 * `standalone_prompt`: one `sendStandaloneChatMessage`, which creates the
 * Work Entry. The run result is keyed as a standalone chat.
 */
export function standalonePromptExpectation(args: {
  ids: { chatId: string };
  /** The message ID the send reported. */
  sentUserMessageId: string;
  request?: Record<string, unknown>;
  groupAssignment?: { itemId: string; name: string } | null;
}): ChatActionExpectation {
  const result = {
    standaloneChatId: args.ids.chatId,
    projectId: 'cowork-1',
    userMessageId: args.sentUserMessageId,
  };
  return {
    request: {
      chatId: args.ids.chatId,
      message: 'Organize notes',
      fileReferences: undefined,
      planMode: false,
      projectLocalId: 'cowork-1',
      ...CODEX_PROMPT_SETTINGS,
      initiationSource: 'automation',
      automationName: 'Notes prompt',
      approvalMode: 'full-access',
      ...args.request,
    },
    options: { executionContext: 'personal' },
    result,
    groupAssignment: args.groupAssignment ?? null,
    dispatched: result,
  };
}

/**
 * `app_advisor_prompt`: the whole `ensureAppAdvisorWindow` quick-prompt
 * request. It carries no `focus` or `layout` (Review Focus 10), on Run now or
 * a scheduled run, and the run succeeds before the renderer sends.
 */
export function appAdvisorPromptExpectation(args: {
  ids: Required<MintedIds>;
  request?: Record<string, unknown>;
}): ChatActionExpectation {
  const result = {
    appAdvisorChatId: args.ids.chatId,
    userMessageId: args.ids.userMessageId,
  };
  return {
    request: {
      quickPrompt: 'Review the app',
      quickPromptFileReferences: undefined,
      quickPromptPlanMode: false,
      quickPromptTitle: 'Advisor prompt',
      quickPromptChatId: args.ids.chatId,
      quickPromptUserMessageId: args.ids.userMessageId,
      quickPromptModel: 'gpt-5.5',
      quickPromptProviderType: 'codex',
      quickPromptModelConfig: CODEX_PROMPT_SETTINGS.modelConfig,
      quickPromptThinkingLevel: 'high',
      quickPromptInitiationSource: 'automation',
      quickPromptAutomationName: 'Advisor prompt',
      quickPromptApprovalMode: 'full-access',
      ...args.request,
    },
    options: {},
    result,
    groupAssignment: null,
    dispatched: result,
  };
}

/** Today's run-history text for the native failure rows. */
export const NATIVE_CHAT_ACTION_ERRORS = {
  cursorDisconnected: 'Connect Cursor in Settings to use it in automations.',
  /** Thrown by `sendStandaloneChatMessage`, not by an automations pre-check. */
  workEntryUnavailable:
    'The selected work entry is no longer available. Choose another work entry and try again.',
} as const;

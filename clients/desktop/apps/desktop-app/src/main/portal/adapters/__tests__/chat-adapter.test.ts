import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../../../canopy-runtime/core-chat-command-adapter';
import { createHash } from 'node:crypto';
import { setDelegationActivity } from '../../../agents/delegation/activity';
import { createDesktopRuntime } from '../../../canopy-runtime/desktop-runtime';
import type { CoreChatSendReceiptResult } from '@canopy/protocol/canopy-core';
import type { ExternalAgentSender } from '@canopy/protocol/portal';
import type * as OpenCodeRuntimeAvailability from '../../../opencode/runtime-availability';
jest.mock('../chat-state-query', () => ({
  queryPortalChatState: (
    context: {
      chatStatePort: {
        getState: (request: {
          projectId: string;
          worktreeId: string;
        }) => Promise<unknown>;
      };
    },
    request: { projectId: string; worktreeId: string },
  ): Promise<unknown> => context.chatStatePort.getState(request),
}));
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
  PIPELINE_EDITOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  getProviderForModel,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  initOllamaModels,
  type PortalChatComposerSetterRequest,
  type HostPortalChatFileReference,
  type AgentModelConfig,
  type ChatBillingFramework,
  type ChatStateCommandPort,
  type ChatTabPluginSelections,
  type PersistedChatTab,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
// Type-only, so it is erased and safe to reference from a hoisted jest.mock
// factory below.
import type * as WorkspaceRegistryModule from '../../../lib/workspace-registry';
import { portalFileReferences } from '../../portal-file-references';
// Type-only, so it is erased and safe to reference from a hoisted jest.mock
// factory below.
import type * as PortalChatAttachmentsModule from '../../portal-chat-attachments';
import {
  PortalChatAttachmentError,
  type MaterializePortalChatAttachmentsInput,
} from '../../portal-chat-attachments';
import { sendToWindowDetailed } from '../../../lib/window-send';
import { requestPortalComposerCommand } from '../../../ipc/portal-composer-command';
import { expandWorkspacePromptMentions } from '../../../lib/workspace-prompt-mentions';
import {
  assertWorktreeChatSendNotSplitLocked,
  buildExistingTabDispatchOptions,
  ExistingTabDispatchTargetNotFoundError,
  sendWorktreeChatMessage,
} from '../../../services/chat-service';
import {
  resolveStandaloneChatPolicyModels,
  sendStandaloneChatMessage,
  setStandaloneChatModel,
} from '../../../services/standalone-chat-service';
import {
  handlePortalChatAnswerQuestion,
  handlePortalChatSend,
  handlePortalChatCloseTab,
  handlePortalChatFork,
  handlePortalChatBranch,
  handlePortalChatShare,
  handlePortalChatCreateTab,
  handlePortalChatDismissQuestion,
  handlePortalChatQueueEdit,
  handlePortalChatQueueSteer,
  handlePortalChatQueueSetEditLock,
  handlePortalChatInputDelivery,
  handlePortalChatSetFastMode,
  handlePortalChatSetModel,
  handlePortalChatSetPlanMode,
  handlePortalChatSetPluginSelections,
  handlePortalChatSetThinkingLevel,
} from '../chat-adapter';
import {
  handlePortalStandaloneChatSend,
  handlePortalStandaloneChatSetModel,
} from '../standalone-chat-adapter';
import type { PortalAdapterContext } from '../types';

// The managed Cursor runtime preflight the desktop chat IPC shares with the
// Portal adapters. Unavailable by default; specs flip it per case.
let cursorRuntimeAvailable = false;
jest.mock('../../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> =>
    Promise.resolve(cursorRuntimeAvailable),
}));
afterEach(() => {
  cursorRuntimeAvailable = false;
});

let copilotRuntimeAvailable = false;
jest.mock('../../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: (): Promise<boolean> =>
    Promise.resolve(copilotRuntimeAvailable),
}));
afterEach(() => {
  copilotRuntimeAvailable = false;
});

let opencodeRuntimeAvailable = false;
jest.mock('../../../opencode/runtime-availability', () => ({
  ...jest.requireActual<typeof OpenCodeRuntimeAvailability>(
    '../../../opencode/runtime-availability',
  ),
  isOpenCodeRuntimeAvailable: (): Promise<boolean> =>
    Promise.resolve(opencodeRuntimeAvailable),
}));
afterEach(() => {
  opencodeRuntimeAvailable = false;
});

const blockedModelIds = new Set<string>();
// Mirrors the real module: an enforcing policy is "some model is blocked".
let orgModelPolicyActive = false;
jest.mock('../../../agents/agent-default-model', () => ({
  pinInheritingAgentToDestination: (model: string): Promise<string> =>
    Promise.resolve(
      model === 'agent_model_inherit' ? `${model}@test-model` : model,
    ),
  resolveSendModelPin: (
    _projectId: string,
    stored: string | undefined,
    requested: string | undefined,
  ): Promise<string | undefined> => {
    const selected = requested ?? stored;
    if (selected === 'agent_model_nested')
      return Promise.reject(new Error('The default model is an Agent.'));
    return Promise.resolve(
      selected === 'agent_model_inherit'
        ? 'agent_model_inherit@test-model'
        : undefined,
    );
  },
}));

jest.mock('../../../lib/model-policy-state', () => ({
  // Async, matching the real guard: enforcement must consult the stored
  // account, not process-local state that is empty during startup.
  isModelBlockedByStoredPolicy: (modelId: string): Promise<boolean> =>
    Promise.resolve(blockedModelIds.has(modelId)),
  // Async, matching the real stored-account predicate the adapters use: the
  // sync one reads process-local state that is empty until the first account
  // read lands, which is exactly the startup window an unknown model must
  // still fail closed in.
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    Promise.resolve(orgModelPolicyActive || blockedModelIds.size > 0),
  isStoredModelPolicyReadDegraded: (): boolean => false,
}));
const laneResolutionCalls: Array<{
  scope: 'chat' | 'worktree';
  stampProjection: boolean | undefined;
}> = [];
let concreteModelDispatchability: 'dispatchable' | 'no-billing-lane' =
  'dispatchable';
let missingDefaultLane: 'billing-lane' | 'policy-allowance' | 'both' =
  'billing-lane';
let hasPolicyAllowedDefaultLane = true;
let resolvedDefaultLane: 'claude-native' | 'codex-native' | 'ai-credits' =
  'claude-native';
let resolvedDefaultLaneProvisional = false;
let resolvedDefaultProvider: 'claude' | 'codex' = 'claude';
jest.mock('../../../lib/default-model-lane-resolver', () => ({
  getLastProjectedDefaultModel: (): undefined => undefined,
  // Fails OPEN, mirroring the real helper on an unknown model or unsettled
  // probe. The concrete-model dead-end refusal has its own spec that overrides
  // this; every other spec here is about routing, policy or composer fields.
  resolveConcreteModelDispatchability: (): Promise<string> =>
    Promise.resolve(concreteModelDispatchability ?? 'dispatchable'),
  resolveLaneAwareDefaultSelection: (
    preferences: Record<string, unknown>,
    scope: 'chat' | 'worktree',
    _credentialScope: unknown,
    preferredProvider?: 'claude' | 'codex' | 'ollama',
    _creditsCandidates?: unknown,
    stampProjection?: boolean,
  ): Promise<unknown> => {
    laneResolutionCalls.push({ scope, stampProjection });
    const defaults = preferences[
      scope === 'chat'
        ? 'defaultChatModelByProvider'
        : 'defaultWorktreeModelByProvider'
    ] as
      | Record<string, { model: string; thinkingLevel: string } | null>
      | undefined;
    const selection = defaults?.[preferredProvider ?? resolvedDefaultProvider];
    return Promise.resolve(
      selection
        ? {
            outcome: 'resolved' as const,
            lane: resolvedDefaultLane,
            provisional: resolvedDefaultLaneProvisional,
            selection,
          }
        : {
            outcome: 'no-dispatchable-model' as const,
            missing: missingDefaultLane,
            lanesNeeded: [],
            hasPolicyAllowedLane: hasPolicyAllowedDefaultLane,
          },
    );
  },
}));

// The send path polices the model it would actually resolve to, which
// includes the stored per-provider default when the payload carries none.
// Mocked so the suite never reads the developer's real preferences file.
// Wire-faithful defaults. `ModelDefaultsByProvider` makes `claude` and `codex`
// REQUIRED and only `ollama` nullable, and `normalizeModelDefaultsByProvider`
// backfills both from `DEFAULT_PREFERENCES` on every read — so "readable
// preferences with no claude/codex default" is not a state the app can reach.
// Modelling it as reachable here is what let an unrealistic fixture stand in
// for the real contract. Tests that want the unreachable case now opt into it
// explicitly by assigning `null`.
const defaultWorktreeModels: {
  claude?: string | null;
  codex?: string | null;
  ollama?: string;
} = {};
const DEFAULT_CLAUDE_MODEL = 'fixture-claude-default';
const DEFAULT_CODEX_MODEL = 'fixture-codex-default';
let preferencesReadable = true;
let deferredToolsWorktreeChatsEnabled: boolean | undefined;
let deferredToolsStandaloneChatsEnabled: boolean | undefined;
let sidebarDefaultPluginSelections: ChatTabPluginSelections | undefined;
let lastChatBillingFramework: ChatBillingFramework | undefined;
let providerModelConfigDefaults:
  | Partial<Record<'claude' | 'codex' | 'ollama' | 'cursor', AgentModelConfig>>
  | undefined;
// `dispatchWorktreeChatTurn` reads `defaultChatModelByProvider` for a cowork
// target and `defaultWorktreeModelByProvider` otherwise, so the preflight has
// to make the same choice. Partial-mocked so the rest of the registry keeps
// its real behavior.
const coworkWorkspaceIds = new Set<string>();
const defaultChatModels: { claude?: string | null; codex?: string | null } = {};
jest.mock('../../../lib/workspace-registry', () => {
  const actual: typeof WorkspaceRegistryModule = jest.requireActual(
    '../../../lib/workspace-registry',
  );
  return {
    ...actual,
    isCoworkWorkspace: (id: string): boolean => coworkWorkspaceIds.has(id),
  };
});
function resetModelPolicyFixtures(): void {
  blockedModelIds.clear();
  orgModelPolicyActive = false;
  concreteModelDispatchability = 'dispatchable';
  missingDefaultLane = 'billing-lane';
  hasPolicyAllowedDefaultLane = true;
  resolvedDefaultLane = 'claude-native';
  resolvedDefaultLaneProvisional = false;
  resolvedDefaultProvider = 'claude';
  lastChatBillingFramework = undefined;
  providerModelConfigDefaults = undefined;
  preferencesReadable = true;
  coworkWorkspaceIds.clear();
  delete defaultWorktreeModels.claude;
  delete defaultWorktreeModels.codex;
  delete defaultWorktreeModels.ollama;
  delete defaultChatModels.claude;
  delete defaultChatModels.codex;
  initModelHarnessAssignments({ revision: 0, assignments: [] });
}
type MockProviderDefaults = {
  claude: { model: string } | undefined;
  codex: { model: string } | undefined;
  ollama: { model: string } | null;
};
jest.mock('../../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{
    defaultWorktreeModelByProvider: MockProviderDefaults;
    defaultChatModelByProvider: MockProviderDefaults;
    deferredToolsWorktreeChatsEnabled?: boolean;
    deferredToolsStandaloneChatsEnabled?: boolean;
    lastChatBillingFramework?: ChatBillingFramework;
    providerModelConfigDefaults?: Partial<
      Record<'claude' | 'codex' | 'ollama' | 'cursor', AgentModelConfig>
    >;
  }> =>
    preferencesReadable
      ? Promise.resolve({
          ...(deferredToolsWorktreeChatsEnabled === undefined
            ? {}
            : { deferredToolsWorktreeChatsEnabled }),
          ...(deferredToolsStandaloneChatsEnabled === undefined
            ? {}
            : { deferredToolsStandaloneChatsEnabled }),
          ...(lastChatBillingFramework === undefined
            ? {}
            : { lastChatBillingFramework }),
          ...(providerModelConfigDefaults === undefined
            ? {}
            : { providerModelConfigDefaults }),
          defaultWorktreeModelByProvider: {
            claude:
              defaultWorktreeModels.claude === null
                ? undefined
                : {
                    model: defaultWorktreeModels.claude ?? DEFAULT_CLAUDE_MODEL,
                  },
            codex:
              defaultWorktreeModels.codex === null
                ? undefined
                : { model: defaultWorktreeModels.codex ?? DEFAULT_CODEX_MODEL },
            ollama: defaultWorktreeModels.ollama
              ? { model: defaultWorktreeModels.ollama }
              : null,
          },
          // Cowork targets resolve from this map instead.
          defaultChatModelByProvider: {
            claude:
              defaultChatModels.claude === null
                ? undefined
                : { model: defaultChatModels.claude ?? DEFAULT_CLAUDE_MODEL },
            codex:
              defaultChatModels.codex === null
                ? undefined
                : { model: defaultChatModels.codex ?? DEFAULT_CODEX_MODEL },
            ollama: null,
          },
        })
      : Promise.reject(new Error('preferences unreadable')),
}));

jest.mock('../../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<{
    items: Array<{
      id: string;
      defaultPluginSelections?: ChatTabPluginSelections;
    }>;
  }> =>
    Promise.resolve({
      items: [
        {
          id: 'ws',
          ...(sidebarDefaultPluginSelections
            ? { defaultPluginSelections: sidebarDefaultPluginSelections }
            : {}),
        },
      ],
    }),
}));

jest.mock('../../../lib/window-send', () => ({
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));
jest.mock('../../../ipc/portal-composer-command', () => ({
  requestPortalComposerCommand: jest.fn(),
}));
jest.mock('../../../lib/workspace-prompt-mentions', () => ({
  expandWorkspacePromptMentions: jest.fn(
    (_projectId: string, text: string, refs: HostPortalChatFileReference[]) =>
      Promise.resolve({ text, fileReferences: refs }),
  ),
}));
jest.mock('../../../services/chat-service', () => {
  class ExistingTabDispatchTargetNotFoundError extends Error {
    constructor() {
      super('Target chat for Worktree Session prompt could not be found.');
      this.name = 'ExistingTabDispatchTargetNotFoundError';
    }
  }

  return {
    assertWorktreeChatSendNotSplitLocked: jest.fn(),
    buildExistingTabDispatchOptions: jest.fn(),
    ExistingTabDispatchTargetNotFoundError,
    sendWorktreeChatMessage: jest.fn(),
  };
});
jest.mock('../../../services/standalone-chat-service', () => ({
  setStandaloneChatModel: jest.fn().mockResolvedValue({ ok: true }),
  sendStandaloneChatMessage: jest
    .fn()
    .mockResolvedValue({ ok: true, chatId: 'chat' }),
  // Default mirrors the real resolver for the simple case: preferences
  // readable, and an explicit payload model is itself a candidate. Tests that
  // exercise the tab/default/unreadable paths override per call.
  resolveStandaloneChatPolicyModels: jest.fn(
    (input: {
      model?: string;
    }): Promise<{ readable: boolean; models: string[] }> =>
      Promise.resolve({
        readable: true,
        models: input.model ? [input.model] : [],
      }),
  ),
}));
const queueEdit = jest.fn();
const queueSetEditLock = jest.fn();
// Default: no attachment-bearing rows, so text edits pass the host invariant.
const queueGetWorktreeSnapshots = jest.fn((): unknown[] => []);
// Default: the sent message is not waiting behind another turn.
const queueHoldsUserMessage = jest.fn((): boolean => false);
const queueRunningTurnUserMessageId = jest.fn(
  (): string | undefined => undefined,
);
jest.mock('../../../services/chat-queue-service', () => ({
  getChatQueueService: (): {
    edit: typeof queueEdit;
    setEditLock: typeof queueSetEditLock;
    getWorktreeSnapshots: typeof queueGetWorktreeSnapshots;
    holdsUserMessage: typeof queueHoldsUserMessage;
    runningTurnUserMessageId: typeof queueRunningTurnUserMessageId;
  } => ({
    edit: queueEdit,
    setEditLock: queueSetEditLock,
    getWorktreeSnapshots: queueGetWorktreeSnapshots,
    holdsUserMessage: queueHoldsUserMessage,
    runningTurnUserMessageId: queueRunningTurnUserMessageId,
  }),
}));
const mockMaterialize = jest.fn<
  Promise<string[]>,
  [MaterializePortalChatAttachmentsInput]
>();
const mockConsumeAttachments = jest.fn<
  Promise<void>,
  [{ sessionId: string | null; attachmentIds: readonly string[] }]
>();
const mockRemoveMaterializedAttachments = jest.fn<
  Promise<void>,
  [readonly string[]]
>();
jest.mock('../../portal-chat-attachments', () => ({
  ...jest.requireActual<typeof PortalChatAttachmentsModule>(
    '../../portal-chat-attachments',
  ),
  materializePortalChatAttachments: (
    input: MaterializePortalChatAttachmentsInput,
  ): Promise<string[]> => mockMaterialize(input),
  consumePortalChatAttachments: (input: {
    sessionId: string | null;
    attachmentIds: readonly string[];
  }): Promise<void> => mockConsumeAttachments(input),
  removeMaterializedPortalChatAttachments: (
    paths: readonly string[],
  ): Promise<void> => mockRemoveMaterializedAttachments(paths),
}));
jest.mock('../../portal-session-manager', () => ({
  getCanopyPortalState: (): { sessionId: string | null } => ({
    sessionId: 'sess-1',
  }),
}));

const mockedSend = jest.mocked(sendToWindowDetailed);
const mockedRequest = jest.mocked(requestPortalComposerCommand);
const mockedBuildExistingTabDispatchOptions = jest.mocked(
  buildExistingTabDispatchOptions,
);
const mockedSendWorktreeChatMessage = jest.mocked(sendWorktreeChatMessage);
const mockedAssertWorktreeChatSendNotSplitLocked = jest.mocked(
  assertWorktreeChatSendNotSplitLocked,
);
const mockedExpandWorkspacePromptMentions = jest.mocked(
  expandWorkspacePromptMentions,
);
const mockedSetStandaloneChatModel = jest.mocked(setStandaloneChatModel);
const mockedSendStandaloneChatMessage = jest.mocked(sendStandaloneChatMessage);
const mockedResolveStandaloneChatPolicyModels = jest.mocked(
  resolveStandaloneChatPolicyModels,
);

function expectRequested(expected: PortalChatComposerSetterRequest): void {
  expect(mockedRequest.mock.calls[0]?.[0]).toEqual(expected);
  expect(mockedRequest.mock.calls[0]?.[1].getMainWindow()).toBeNull();
}

interface RecordedComplete {
  commandId: string;
  result: unknown;
}
interface RecordedFail {
  commandId: string;
  code: string;
  message: string;
}

interface Recorder {
  context: PortalAdapterContext;
  completes: RecordedComplete[];
  fails: RecordedFail[];
}

function recorder(): Recorder {
  const completes: RecordedComplete[] = [];
  const fails: RecordedFail[] = [];
  const context: PortalAdapterContext = {
    sessionId: 'sess-1',
    getWindow: () => null,
    queryChatSendReceipt: async (
      params,
    ): Promise<CoreChatSendReceiptResult> => {
      const port = context.chatStatePort;
      if (port?.getPortalSendReceipt && params.identity) {
        return port.getPortalSendReceipt({
          projectId: params.scope.workspaceId,
          worktreeId: params.scope.worktreeId,
          commandId: params.commandId,
          identity: { chatId: params.scope.chatId, ...params.identity },
        });
      }
      const receipt = await port?.getCommandReceipt?.({
        projectId: params.scope.workspaceId,
        worktreeId: params.scope.worktreeId,
        commandId: params.commandId,
      });
      return receipt ? { outcome: 'matched', receipt } : { outcome: 'missing' };
    },
    enqueueEvent: (): void => {},
    complete: (command, result): void => {
      completes.push({ commandId: command.id, result });
    },
    fail: (command, code, message): void => {
      fails.push({ commandId: command.id, code, message });
    },
  };
  return { context, completes, fails };
}

function setModelCommand(
  payload: PortalCommandPayloadMap['portal.chat.set_model'],
): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.set_model']> {
  return {
    id: 'cmd-model',
    sequence: 1,
    type: 'portal.chat.set_model',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  };
}

function setStandaloneModelCommand(
  payload: PortalCommandPayloadMap['portal.standalone_chat.set_model'],
): PortalCommandEnvelope<
  PortalCommandPayloadMap['portal.standalone_chat.set_model']
> {
  return {
    id: 'cmd-standalone-model',
    sequence: 1,
    type: 'portal.standalone_chat.set_model',
    payload,
    createdAt: '2026-08-18T00:00:00.000Z',
    expiresAt: null,
  };
}

function standaloneSendCommand(
  payload: PortalCommandPayloadMap['portal.standalone_chat.send'],
): PortalCommandEnvelope<
  PortalCommandPayloadMap['portal.standalone_chat.send']
> {
  return {
    id: 'cmd-standalone-send',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    payload,
    createdAt: '2026-08-18T00:00:00.000Z',
    expiresAt: null,
  };
}

function setThinkingCommand(
  payload: PortalCommandPayloadMap['portal.chat.set_thinking_level'],
): PortalCommandEnvelope<
  PortalCommandPayloadMap['portal.chat.set_thinking_level']
> {
  return {
    id: 'cmd-thinking',
    sequence: 1,
    type: 'portal.chat.set_thinking_level',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  };
}

function setPlanCommand(
  payload: PortalCommandPayloadMap['portal.chat.set_plan_mode'],
): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.set_plan_mode']> {
  return {
    id: 'cmd-plan',
    sequence: 1,
    type: 'portal.chat.set_plan_mode',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  };
}

function setFastCommand(
  payload: PortalCommandPayloadMap['portal.chat.set_fast_mode'],
): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.set_fast_mode']> {
  return {
    id: 'cmd-fast',
    sequence: 1,
    type: 'portal.chat.set_fast_mode',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  };
}

function answerQuestionCommand(
  payload: PortalCommandPayloadMap['portal.chat.answer_question'],
): PortalCommandEnvelope<
  PortalCommandPayloadMap['portal.chat.answer_question']
> {
  return {
    id: 'cmd-answer-question',
    sequence: 1,
    type: 'portal.chat.answer_question',
    payload,
    createdAt: '2026-07-22T00:00:00.000Z',
    expiresAt: null,
  };
}

function dismissQuestionCommand(
  payload: PortalCommandPayloadMap['portal.chat.dismiss_question'],
): PortalCommandEnvelope<
  PortalCommandPayloadMap['portal.chat.dismiss_question']
> {
  return {
    id: 'cmd-dismiss-question',
    sequence: 1,
    type: 'portal.chat.dismiss_question',
    payload,
    createdAt: '2026-07-22T00:00:00.000Z',
    expiresAt: null,
  };
}

function sendCommand(
  payload: PortalCommandPayloadMap['portal.chat.send'],
): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.send']> {
  return {
    id: 'cmd-send',
    sequence: 1,
    type: 'portal.chat.send',
    payload,
    createdAt: '2026-07-21T00:00:00.000Z',
    expiresAt: null,
  };
}

function queueCommand<
  T extends 'portal.chat.queue.edit' | 'portal.chat.queue.set_edit_lock',
>(
  type: T,
  payload: PortalCommandPayloadMap[T],
): PortalCommandEnvelope<PortalCommandPayloadMap[T]> {
  return {
    id: 'cmd-queue',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  };
}

describe('chat portal adapter — send (CAN-1517)', () => {
  beforeEach(() => {
    initClaudeModels([
      { id: 'test-model', label: 'Test Model' },
      { id: 'blocked-model', label: 'Blocked Model' },
    ]);
    initCodexModels([{ id: 'gpt-5.2-codex', label: 'GPT 5.2 Codex' }]);
    jest.clearAllMocks();
    // The policy fixtures are module-level, so without this the last test in
    // the `organization model policy` describe below leaks its blocked-model
    // set and stored default into every later test in this file.
    resetModelPolicyFixtures();
    mockedBuildExistingTabDispatchOptions.mockReset();
    mockedAssertWorktreeChatSendNotSplitLocked.mockReset();
    mockedSendWorktreeChatMessage.mockReset();
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
    });
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({});
    // Reset the implementation, not just the call log: a test that makes the
    // materializer REJECT would otherwise leak that rejection into every
    // later send in this file.
    mockMaterialize.mockReset();
    mockMaterialize.mockResolvedValue([]);
    mockConsumeAttachments.mockReset();
    mockConsumeAttachments.mockResolvedValue(undefined);
    mockRemoveMaterializedAttachments.mockReset();
    mockRemoveMaterializedAttachments.mockResolvedValue(undefined);
    mockedExpandWorkspacePromptMentions.mockImplementation(
      (_projectId, text, refs) =>
        Promise.resolve({ text, fileReferences: refs }),
    );
  });

  it.each([
    { requestedModel: 'cursor-default', storedCursor: false },
    { requestedModel: undefined, storedCursor: true },
    { requestedModel: 'test-model', storedCursor: true },
  ])(
    'refuses Cursor dispatch with connect guidance while the runtime is unavailable, despite a contradictory Portal provider: %j',
    async ({ requestedModel, storedCursor }) => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      if (storedCursor)
        mockedBuildExistingTabDispatchOptions.mockResolvedValue({
          providerType: 'cursor',
          model: 'cursor-default',
        });
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Send',
          providerType: 'claude',
          cloudAttachments: [
            {
              attachmentId: '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
              filename: 'photo.png',
              mediaType: 'image/png',
              size: 3,
              contentSha256: 'a'.repeat(64),
              storageKind: 'blob',
              source: '/api/x',
            },
          ],
          ...(requestedModel ? { model: requestedModel } : {}),
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(1);
      // Mirrors the set-model path (`handlePortalChatSetModel`), which fails
      // the same Cursor-unavailable refusal with `invalid_payload`. A plain
      // thrown Error here would map to `execution_failed` via
      // `failServiceError` instead, which is a client-facing bug: the caller
      // cannot tell "your payload/state is invalid" apart from "the server
      // blew up".
      expect(rec.fails[0]?.code).toBe('invalid_payload');
      expect(JSON.stringify(rec.fails)).toContain(
        'Connect Cursor in the desktop app',
      );
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(mockRemoveMaterializedAttachments).toHaveBeenCalledWith([
        '/w/attachments/t/photo.png',
      ]);
    },
  );

  it.each([
    { requestedModel: 'cursor-default', storedCursor: false },
    { requestedModel: undefined, storedCursor: true },
  ])(
    'dispatches a Cursor send when the runtime is available: %j',
    async ({ requestedModel, storedCursor }) => {
      cursorRuntimeAvailable = true;
      if (storedCursor)
        mockedBuildExistingTabDispatchOptions.mockResolvedValue({
          providerType: 'cursor',
          model: 'cursor-default',
        });
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          text: 'Send',
          providerType: 'cursor',
          ...(requestedModel ? { model: requestedModel } : {}),
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(0);
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
        providerType: 'cursor',
        ...(requestedModel ? { model: requestedModel } : {}),
      });
    },
  );

  it.each([
    { requestedModel: 'copilot:fixture', storedCopilot: false },
    { requestedModel: undefined, storedCopilot: true },
    { requestedModel: 'test-model', storedCopilot: true },
  ])(
    'refuses Copilot dispatch with connect guidance while the runtime is unavailable, despite a contradictory Portal provider: %j',
    async ({ requestedModel, storedCopilot }) => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      if (storedCopilot)
        mockedBuildExistingTabDispatchOptions.mockResolvedValue({
          providerType: 'copilot',
          model: 'copilot:fixture',
        });
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Send',
          providerType: 'claude',
          cloudAttachments: [
            {
              attachmentId: '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
              filename: 'photo.png',
              mediaType: 'image/png',
              size: 3,
              contentSha256: 'a'.repeat(64),
              storageKind: 'blob',
              source: '/api/x',
            },
          ],
          ...(requestedModel ? { model: requestedModel } : {}),
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(1);
      // Mirrors the set-model path (`handlePortalChatSetModel`), which fails
      // the same Copilot-unavailable refusal with `invalid_payload`. A plain
      // thrown Error here would map to `execution_failed` via
      // `failServiceError` instead, which is a client-facing bug: the caller
      // cannot tell "your payload/state is invalid" apart from "the server
      // blew up".
      expect(rec.fails[0]?.code).toBe('invalid_payload');
      expect(JSON.stringify(rec.fails)).toContain(
        'Connect Copilot in the desktop app',
      );
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(mockRemoveMaterializedAttachments).toHaveBeenCalledWith([
        '/w/attachments/t/photo.png',
      ]);
    },
  );

  it.each([
    { requestedModel: 'copilot:fixture', storedCopilot: false },
    { requestedModel: undefined, storedCopilot: true },
  ])(
    'dispatches a Copilot send when the runtime is available: %j',
    async ({ requestedModel, storedCopilot }) => {
      copilotRuntimeAvailable = true;
      if (storedCopilot)
        mockedBuildExistingTabDispatchOptions.mockResolvedValue({
          providerType: 'copilot',
          model: 'copilot:fixture',
        });
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          text: 'Send',
          providerType: 'copilot',
          ...(requestedModel ? { model: requestedModel } : {}),
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(0);
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
        providerType: 'copilot',
        ...(requestedModel ? { model: requestedModel } : {}),
      });
    },
  );

  it.each([
    { requestedModel: 'opencode:fixture%2Fmodel', storedOpenCode: false },
    { requestedModel: undefined, storedOpenCode: true },
    { requestedModel: 'test-model', storedOpenCode: true },
  ])(
    'refuses OpenCode dispatch with connect guidance while the runtime is unavailable, despite a contradictory Portal provider: %j',
    async ({ requestedModel, storedOpenCode }) => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      if (storedOpenCode)
        mockedBuildExistingTabDispatchOptions.mockResolvedValue({
          providerType: 'opencode',
          model: 'opencode:fixture%2Fmodel',
        });
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Send',
          providerType: 'claude',
          cloudAttachments: [
            {
              attachmentId: '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
              filename: 'photo.png',
              mediaType: 'image/png',
              size: 3,
              contentSha256: 'a'.repeat(64),
              storageKind: 'blob',
              source: '/api/x',
            },
          ],
          ...(requestedModel ? { model: requestedModel } : {}),
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(1);
      // Same `invalid_payload` refusal as the set-model path.
      expect(rec.fails[0]?.code).toBe('invalid_payload');
      expect(JSON.stringify(rec.fails)).toContain(
        'Connect OpenCode in the desktop app',
      );
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(mockRemoveMaterializedAttachments).toHaveBeenCalledWith([
        '/w/attachments/t/photo.png',
      ]);
    },
  );

  it.each([
    { requestedModel: 'opencode:fixture%2Fmodel', storedOpenCode: false },
    { requestedModel: undefined, storedOpenCode: true },
  ])(
    'dispatches an OpenCode send when the runtime is available: %j',
    async ({ requestedModel, storedOpenCode }) => {
      opencodeRuntimeAvailable = true;
      if (storedOpenCode)
        mockedBuildExistingTabDispatchOptions.mockResolvedValue({
          providerType: 'opencode',
          model: 'opencode:fixture%2Fmodel',
        });
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          text: 'Send',
          providerType: 'opencode',
          ...(requestedModel ? { model: requestedModel } : {}),
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(0);
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
        providerType: 'opencode',
        ...(requestedModel ? { model: requestedModel } : {}),
      });
    },
  );

  it.each(['provider', 'harness'] as const)(
    'refuses unavailable OpenCode selected only by %s without a catalog',
    async (route) => {
      if (route === 'harness') {
        mockedBuildExistingTabDispatchOptions.mockResolvedValue({
          providerType: 'claude',
          executionHarness: 'opencode',
        });
      }
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          text: 'Send',
          ...(route === 'provider' ? { providerType: 'opencode' } : {}),
        }),
        rec.context,
      );
      expect(rec.fails).toEqual([
        expect.objectContaining({
          code: 'invalid_payload',
          message: 'Connect OpenCode in the desktop app to use it here.',
        }),
      ]);
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it('preserves the plan approval identity in canonical paired sends', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-send',
        revision: 8,
        outcome: 'applied' as const,
      }),
    );
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: () => (): void => {},
    } satisfies ChatStateCommandPort;
    const approval = {
      requestId: 'review-1',
      planId: 'plan-1',
      revisionNumber: 2,
    };
    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Implement.',
        planReviewApproval: approval,
        planMode: false,
      }),
      rec.context,
    );
    expect(revisionedCommand.mock.calls).toHaveProperty(
      '0.0.command.planReviewApproval',
      approval,
    );
    expect(revisionedCommand.mock.calls).toHaveProperty('0.1.portalSend');
  });

  it('refuses plan approval when only the compatibility send path is available', async () => {
    const rec = recorder();
    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Implement.',
        planReviewApproval: {
          requestId: 'review-1',
          planId: 'plan-1',
          revisionNumber: 2,
        },
      }),
      rec.context,
    );
    expect(rec.fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('uses the narrow revisioned send command when the state service is available', async () => {
    const rec = recorder();
    const sender: ExternalAgentSender = {
      kind: 'external_agent',
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Research client',
      verified: true,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    Reflect.set(rec.context, 'origin', sender);
    const revisionedCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-send',
        revision: 8,
        outcome: 'applied' as const,
      }),
    );
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Use canonical state',
        selectedRepoId: 'portal-repo',
        modelConfig: { thinkingLevel: 'high', fastMode: true },
        planMode: true,
        codexProposalMode: 'required',
        model: 'renderer-must-not-author-model',
        providerType: 'codex',
      }),
      rec.context,
    );

    expect(revisionedCommand).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        commandId: 'cmd-send',
        projectId: 'workspace',
        worktreeId: 'worktree',
        origin: 'portal',
        command: {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Use canonical state',
          agentSent: sender,
          selectedRepoId: 'portal-repo',
          modelConfig: { thinkingLevel: 'high', speed: 'fast', fastMode: true },
          planMode: true,
          codexProposalMode: 'required',
        },
      },
      {
        portalSend: {
          chatId: 'chat-1',
          userMessageId: 'message-1',
          fingerprint:
            '511cdd52a0832d7de933fbb8242fcc34c3ec0f0f3f8f59d0cdb8dd002961820d',
        },
      },
    );
    expect(mockedBuildExistingTabDispatchOptions).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'chat-1',
    );
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('reports the committed message and that it waits behind the running turn', async () => {
    const rec = recorder();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: jest.fn(() =>
        Promise.resolve({
          commandId: 'cmd-send',
          revision: 8,
          outcome: 'applied' as const,
          entityId: 'chat-1',
          messageId: 'message-1',
        }),
      ),
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    queueHoldsUserMessage.mockReturnValueOnce(true);
    queueRunningTurnUserMessageId.mockReturnValueOnce('earlier-message');

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Queue behind the running turn',
      }),
      rec.context,
    );

    expect(queueHoldsUserMessage).toHaveBeenCalledWith(
      { projectId: 'workspace', worktreeId: 'worktree', chatId: 'chat-1' },
      'message-1',
    );
    expect(rec.completes).toEqual([
      {
        commandId: 'cmd-send',
        result: {
          commandId: 'cmd-send',
          revision: 8,
          outcome: 'applied',
          entityId: 'chat-1',
          messageId: 'message-1',
          userMessageId: 'message-1',
          delivery: 'queued',
        },
      },
    ]);
  });

  it('reports a send that started its own turn as accepted', async () => {
    const rec = recorder();
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
    });
    queueHoldsUserMessage.mockReturnValueOnce(true);
    queueRunningTurnUserMessageId.mockReturnValueOnce('message-1');

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Start now',
      }),
      rec.context,
    );

    expect(rec.completes).toEqual([
      {
        commandId: 'cmd-send',
        result: {
          ok: true,
          chatId: 'chat-1',
          userMessageId: 'message-1',
          delivery: 'accepted',
        },
      },
    ]);
  });

  it('attributes a compatibility send to the context origin and refuses payload attribution', async () => {
    const rec = recorder();
    const sender: ExternalAgentSender = {
      kind: 'external_agent',
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Trusted client',
      verified: true,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    const spoof = { kind: 'external_agent', clientName: 'Untrusted payload' };
    const command = sendCommand({
      projectId: 'workspace',
      worktreeId: 'worktree',
      text: 'Compatibility send',
    });
    Reflect.set(rec.context, 'origin', sender);

    await handlePortalChatSend(command, rec.context);

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentSent: sender }),
      expect.anything(),
    );

    // Only main supplies attribution: a payload carrying it is refused, even
    // beside a trusted origin.
    mockedSendWorktreeChatMessage.mockClear();
    const spoofed = sendCommand({
      projectId: 'workspace',
      worktreeId: 'worktree',
      text: 'Compatibility send',
    });
    Reflect.set(spoofed.payload, 'agentSent', spoof);
    await handlePortalChatSend(spoofed, rec.context);
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('refuses payload attribution without a trusted context origin', async () => {
    const rec = recorder();
    const command = sendCommand({
      projectId: 'workspace',
      worktreeId: 'worktree',
      text: 'Compatibility send',
    });
    Reflect.set(command.payload, 'agentSent', {
      kind: 'external_agent',
      clientName: 'Untrusted payload',
    });

    await handlePortalChatSend(command, rec.context);

    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('rejects a revisioned send while the target worktree is split-locked', async () => {
    mockedAssertWorktreeChatSendNotSplitLocked.mockImplementationOnce(() => {
      throw new Error('Split PR workflow is in progress.');
    });
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Do not bypass the split lock',
      }),
      rec.context,
    );

    expect(mockedAssertWorktreeChatSendNotSplitLocked).toHaveBeenCalledWith(
      'workspace',
      'worktree',
    );
    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(rec.fails[0]).toMatchObject({
      code: 'execution_failed',
      message: 'Split PR workflow is in progress.',
    });
  });

  it('rejects a non-string Portal user message id before revisioned persistence', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    const payload: PortalCommandPayloadMap['portal.chat.send'] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Reject malformed durable ids',
    };
    Reflect.set(payload, 'userMessageId', { malformed: true });

    await handlePortalChatSend(sendCommand(payload), rec.context);

    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('refuses a legacy plan-chat send before any persistence', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSend(
      sendCommand({
        projectId: 'plan-explore-chat',
        worktreeId: 'plan-1',
        chatId: 'legacy-chat',
        userMessageId: 'message-1',
        text: 'Must not persist',
      }),
      rec.context,
    );

    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(rec.fails[0]).toMatchObject({
      code: 'invalid_payload',
      message: 'This plan chat is no longer available.',
    });
  });

  it('rejects an unsafe Portal repository id before revisioned persistence', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Reject the unsafe repository selector',
        selectedRepoId: '../outside',
      }),
      rec.context,
    );

    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('execution_failed');
    expect(rec.fails[0]?.message).toContain('Invalid selectedRepoId');
  });

  it('rejects Portal writes to the App Advisor sentinel before generic dispatch', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSend(
      sendCommand({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Bypass the sentinel guard',
      }),
      rec.context,
    );

    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('applies prompt mention expansion before a revisioned send', async () => {
    const fileReference = portalFileReferences.mint(
      { sessionId: 'sess-1', projectId: 'workspace', worktreeId: 'worktree' },
      { displayPath: 'prompt.md', absolutePath: '/repo/prompt.md' },
    );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          payload: {
            chatId: 'chat-1',
            fileReferences: [
              {
                displayPath: 'prompt.md',
                referenceId: fileReference.referenceId,
              },
            ],
            projectId: 'workspace',
            text: '@prompt',
            userMessageId: 'message-1',
            worktreeId: 'worktree',
          },
          target: null,
          type: 'portal.chat.send',
        }),
      )
      .digest('hex');
    mockedExpandWorkspacePromptMentions.mockResolvedValueOnce({
      text: 'Expanded prompt contents',
      fileReferences: [],
    });
    const rec = recorder();
    const revisionedCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-send',
        revision: 8,
        outcome: 'applied' as const,
      }),
    );
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: '@prompt',
        fileReferences: [fileReference],
      }),
      rec.context,
    );

    expect(revisionedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        command: expect.objectContaining({
          type: 'chat.send_message',
          text: 'Expanded prompt contents',
        }),
      }),
      {
        portalSend: {
          chatId: 'chat-1',
          userMessageId: 'message-1',
          fingerprint,
        },
      },
    );
  });

  it('uses the send service to mint omitted ids even with revisioned state available', async () => {
    const rec = recorder();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: jest.fn(),
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    mockedSendWorktreeChatMessage.mockResolvedValueOnce({
      ok: true,
      chatId: 'generated-chat',
    });

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        text: 'Mint both ids',
      }),
      rec.context,
    );

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalled();
    expect(rec.completes[0]?.result).toEqual({
      ok: true,
      chatId: 'generated-chat',
    });
  });

  it('keeps the terminal-backed guard on revisioned sends', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValueOnce({
      interfaceMode: 'auto',
      sdkSessionId: 'terminal-session',
    });
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Do not resume terminal',
      }),
      rec.context,
    );

    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('conflict');
  });

  it('resumes an existing tab with its persisted dispatch options', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'persisted-session',
      providerType: 'claude',
      model: 'persisted-model',
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      pluginSelections: {
        collectionIds: ['persisted-collection'],
        skillRefs: [{ sourceId: 'source', skillName: 'skill' }],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      },
      deferredToolsAllowed: false,
      planMode: true,
      claudeForkSession: true,
      codexProposalMode: 'required',
    });
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'canonical-chat',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue our conversation',
      }),
      rec.context,
    );

    expect(mockedBuildExistingTabDispatchOptions).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'chat-1',
    );
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue our conversation',
        initiationSource: 'portal',
        sdkSessionId: 'persisted-session',
        providerType: 'claude',
        model: 'persisted-model',
        modelConfig: { thinkingLevel: 'high', fastMode: true },
        pluginSelections: {
          collectionIds: ['persisted-collection'],
          skillRefs: [{ sourceId: 'source', skillName: 'skill' }],
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
        },
        deferredToolsAllowed: false,
        planMode: true,
        claudeForkSession: true,
        codexProposalMode: 'required',
      },
      { getWindow: rec.context.getWindow },
    );
    expect(rec.completes).toEqual([
      {
        commandId: 'cmd-send',
        result: {
          ok: true,
          chatId: 'canonical-chat',
          userMessageId: 'message-1',
          delivery: 'accepted',
        },
      },
    ]);
    expect(rec.fails).toHaveLength(0);
  });

  it('keeps explicit portal composer fields authoritative', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'persisted-session',
      providerType: 'claude',
      model: 'persisted-model',
      modelConfig: { thinkingLevel: 'low', fastMode: false },
      pluginSelections: {
        collectionIds: ['persisted-collection'],
        skillRefs: [],
        pluginRefs: [],
      },
      planMode: false,
      selectedRepoId: 'persisted-repo',
      codexProposalMode: 'optional',
    });
    const rec = recorder();
    const payload: PortalCommandPayloadMap['portal.chat.send'] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Use the portal choices',
      providerType: 'claude',
      model: 'portal-model',
      modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
      pluginSelections: {
        collectionIds: ['portal-collection'],
        skillRefs: [{ sourceId: 'portal-source', skillName: 'portal-skill' }],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
      },
      planMode: true,
      fileReferences: [
        portalFileReferences.mint(
          {
            sessionId: 'sess-1',
            projectId: 'workspace',
            worktreeId: 'worktree',
          },
          {
            displayPath: 'src/example.ts',
            absolutePath: '/repo/src/example.ts',
            repoName: 'repo',
          },
        ),
      ],
      attachmentPaths: ['/tmp/attachment.png'],
      inputMode: 'voice',
      selectedRepoId: 'portal-repo',
      codexProposalMode: 'required',
    };

    await handlePortalChatSend(sendCommand(payload), rec.context);

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      {
        ...payload,
        modelConfig: { thinkingLevel: 'xhigh', speed: 'fast', fastMode: true },
        fileReferences: [
          {
            displayPath: 'src/example.ts',
            absolutePath: '/repo/src/example.ts',
            repoName: 'repo',
          },
        ],
        sdkSessionId: 'persisted-session',
        initiationSource: 'portal',
      },
      { getWindow: rec.context.getWindow },
    );
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('strips undeclared approval grants from Portal payloads', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({});
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
    });
    const rec = recorder();
    const payload: PortalCommandPayloadMap['portal.chat.send'] & {
      approvalMode: string;
      sessionApprovalRules: unknown[];
    } = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      text: 'Attempt remote escalation',
      approvalMode: 'full-access',
      sessionApprovalRules: [
        {
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
        },
      ],
    };

    await handlePortalChatSend(sendCommand(payload), rec.context);

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        text: 'Attempt remote escalation',
        initiationSource: 'portal',
      },
      { getWindow: rec.context.getWindow },
    );
  });

  it('drops the persisted session id when the portal switches provider', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'claude-session',
      providerType: 'claude',
      model: 'persisted-model',
      claudeForkSession: true,
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Switch to codex',
        providerType: 'codex',
      }),
      rec.context,
    );

    const sentRequest = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sentRequest).toEqual(
      expect.objectContaining({
        providerType: 'codex',
        model: 'persisted-model',
      }),
    );
    expect(sentRequest).not.toHaveProperty('sdkSessionId');
    expect(sentRequest).not.toHaveProperty('claudeForkSession');
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('drops the persisted session id when the payload model implies another provider', async () => {
    // The tab never persisted an explicit providerType — only a Claude
    // session — and the portal switches to a Codex model. The guard must
    // resolve providers from the model, like `sendWorktreeChatMessage` does.
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'claude-session',
      claudeForkSession: true,
      executionHarness: 'claude',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Switch to a codex model',
        model: 'gpt-5.2-codex',
      }),
      rec.context,
    );

    const sentRequest = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sentRequest).toEqual(
      expect.objectContaining({ model: 'gpt-5.2-codex' }),
    );
    expect(sentRequest).not.toHaveProperty('sdkSessionId');
    expect(sentRequest).not.toHaveProperty('claudeForkSession');
    expect(sentRequest).not.toHaveProperty('executionHarness');
    expect(rec.fails).toHaveLength(0);
  });

  it('dispatches the payload model when the persisted tab model is stale', async () => {
    // A tab persisted before its model was removed from the registry carries
    // an id no provider claims. That is stale metadata, not grounds to abort
    // the send: the payload names a valid replacement, which the
    // effective-model resolution prefers anyway. The stale value is discarded
    // so it can neither be dispatched nor force a provider.
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      model: 'removed-model-id',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Use the replacement model',
        model: 'test-model',
      }),
      rec.context,
    );

    const sentRequest = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sentRequest).toEqual(
      expect.objectContaining({
        model: 'test-model',
        providerType: 'claude',
      }),
    );
    expect(rec.fails).toHaveLength(0);
    expect(rec.completes).toEqual([
      {
        commandId: 'cmd-send',
        result: {
          ok: true,
          chatId: 'chat-1',
          userMessageId: 'message-1',
          delivery: 'accepted',
        },
      },
    ]);
  });

  it('discards a stale persisted tab model so the stored default resolves', async () => {
    // Same stale persisted model, but the payload names no replacement. The
    // stale id must not be dispatched (downstream would throw on it after the
    // tab and user message were already persisted); dropping it lets dispatch
    // resolve the provider's stored default, exactly as a model-less tab
    // would.
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      model: 'removed-model-id',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Send without naming a model',
      }),
      rec.context,
    );

    const sentRequest = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sentRequest).not.toHaveProperty('model');
    expect(rec.fails).toHaveLength(0);
    expect(rec.completes).toHaveLength(1);
  });

  it('keeps a Codex-harness Ollama session for an explicit Ollama send', async () => {
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: 'ollama-qwen3-coder',
          source: 'ollama',
          harness: 'codex',
          defaultHarness: 'claude',
          configurable: true,
          overridden: true,
        },
      ],
    });
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'codex-ollama-session',
      providerType: 'ollama',
      executionHarness: 'codex',
      model: 'ollama-qwen3-coder',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue locally',
        providerType: 'ollama',
        model: 'ollama-qwen3-coder',
      }),
      rec.context,
    );

    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sdkSessionId: 'codex-ollama-session',
        providerType: 'ollama',
        model: 'ollama-qwen3-coder',
      }),
    );
    expect(rec.fails).toHaveLength(0);
  });

  // CAN-2318. `getOrCreateSession` already fail-closes on a blocked model,
  // but only once the turn starts — by then `sendWorktreeChatMessage` has
  // written the tab/model and the user message. These assert the rejection
  // happens *before* that call, for every way a blocked model can reach it.
  describe('organization model policy', () => {
    beforeEach(() => {
      resetModelPolicyFixtures();
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({});
    });

    it('rejects an explicitly blocked model before any persistence', async () => {
      blockedModelIds.add('blocked-model');
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'Start with a blocked model',
          model: 'blocked-model',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.completes).toHaveLength(0);
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message: 'This model is blocked by your organization policy.',
        },
      ]);
    });

    it('rejects a blocked model persisted on the target tab', async () => {
      blockedModelIds.add('persisted-blocked-model');
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({
        providerType: 'claude',
        model: 'persisted-blocked-model',
      });
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'The payload carries no model of its own',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message: 'This model is blocked by your organization policy.',
        },
      ]);
    });

    // The mobile picker clears a blocked selection to null, which means "use
    // the desktop default". If the policy blocked that default too, the send
    // must fail before it creates partial chat state.
    it('rejects when the resolved provider default is blocked', async () => {
      blockedModelIds.add('blocked-default');
      defaultWorktreeModels.claude = 'blocked-default';
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'No model anywhere — the stored default applies',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message: 'This model is blocked by your organization policy.',
        },
      ]);
    });

    // Refuse over substitute: with preferences unreadable the model this send
    // would run is unknown, and every downstream check treats an unknown model
    // as permitted (`isModelBlockedByStoredPolicy(undefined)` is false).
    it('refuses an unresolvable model while a policy is active', async () => {
      preferencesReadable = false;
      orgModelPolicyActive = true;
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'No model anywhere and preferences are unreadable',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message:
            'Your organization policy could not be applied to this message. Try again.',
        },
      ]);
    });

    // The other half of "unknown means unknown". `readable: true` with no
    // concrete default is unreachable in production — the normalizer backfills
    // claude/codex on every read — but if that guarantee ever lapses the
    // failure is SILENT: the effective model is undefined, every downstream
    // check answers "not blocked" for undefined, and the provider's own
    // implicit default executes unevaluated under an active policy.
    it('refuses a readable-but-defaultless provider while a policy is active', async () => {
      defaultWorktreeModels.claude = null;
      orgModelPolicyActive = true;
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'Readable preferences, but no default to judge',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message:
            'Your organization policy could not be applied to this message. Try again.',
        },
      ]);
    });

    // `dispatchWorktreeChatTurn` selects the defaults map by target kind, so a
    // preflight that always read `defaultWorktreeModelByProvider` would judge
    // the wrong map for a cowork projectId. Cowork is expected to arrive on
    // `portal.standalone_chat.send`, but nothing enforces that here.
    it('judges a cowork target against the chat defaults map', async () => {
      coworkWorkspaceIds.add('workspace');
      defaultChatModels.claude = 'cowork-default';
      defaultWorktreeModels.claude = 'worktree-default';
      blockedModelIds.add('cowork-default');
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'Cowork target routed through the worktree handler',
        }),
        rec.context,
      );

      // Judged against `defaultChatModelByProvider` (blocked), not
      // `defaultWorktreeModelByProvider` (permitted).
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message: 'This model is blocked by your organization policy.',
        },
      ]);
    });

    it('judges a non-cowork target against the worktree defaults map', async () => {
      defaultChatModels.claude = 'cowork-default';
      defaultWorktreeModels.claude = 'worktree-default';
      blockedModelIds.add('cowork-default');
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'Ordinary worktree send',
        }),
        rec.context,
      );

      // The cowork default being blocked is irrelevant here.
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(rec.fails).toHaveLength(0);
    });

    it('refuses a billing dead end BEFORE persisting anything, with no policy active (round-6)', async () => {
      // The resolver's `no-dispatchable-model` outcome used to be collapsed into
      // "this provider has no default". With no org policy the unknown-model
      // branch above does not fire, so the send proceeded:
      // `sendWorktreeChatMessage` persisted the tab and the user message, and
      // only THEN did `dispatchWorktreeChatTurn` throw — durably recording a
      // prompt that provably could not run. That is the exact partial state the
      // sibling cowork adapter was fixed to prevent.
      defaultWorktreeModels.claude = null;
      orgModelPolicyActive = false;
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'No lane can pay for this',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message:
            'No model is available to send this message. Add a billing source, then try again.',
        },
      ]);
    });

    it('refuses a CONCRETE model whose own lanes are all dead, before persisting (round-7)', async () => {
      // The dead-end guard above only covers the IMPLICIT default. A pinned
      // model — explicitly requested or persisted on the tab — was checked for
      // org policy but never for billing, so it reached
      // `sendWorktreeChatMessage`, which persists the tab and the user message
      // before dispatch fails. Cowork already judged concrete models by their
      // own lanes; this is the worktree half.
      concreteModelDispatchability = 'no-billing-lane';
      orgModelPolicyActive = false;
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          model: 'pinned-model',
          text: 'This model itself cannot run',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message:
            'No model is available to send this message. Add a billing source, then try again.',
        },
      ]);
    });

    it('judges an Agent stored on the chat by the route it pins to', async () => {
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({
        model: 'agent_model_inherit',
        providerType: 'claude',
      });
      blockedModelIds.add('agent_model_inherit@test-model');
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'From mobile',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        expect.objectContaining({
          message: 'This model is blocked by your organization policy.',
        }),
      ]);
    });

    it('refuses an Agent whose default is another Agent before persisting', async () => {
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({
        model: 'agent_model_nested',
        providerType: 'claude',
      });
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'From mobile',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message: 'The default model is an Agent.',
        },
      ]);
    });

    it('still sends for Ollama with no default, which is policy-exempt', async () => {
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({
        providerType: 'ollama',
      });
      orgModelPolicyActive = true;
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Local model, exempt at every layer',
        }),
        rec.context,
      );

      // `ollama` is the one legitimately nullable selection, and Ollama models
      // are exempt everywhere — refusing here would be a pure false positive.
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(rec.fails).toHaveLength(0);
    });

    it('still sends on unreadable preferences when no policy is active', async () => {
      preferencesReadable = false;
      orgModelPolicyActive = false;
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'Ungoverned account, transient disk error',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(rec.fails).toHaveLength(0);
    });

    it('does not read preferences when the payload names a model', async () => {
      // The stored default is irrelevant once the client is explicit, so an
      // unreadable preferences file must not block an otherwise valid send.
      preferencesReadable = false;
      orgModelPolicyActive = true;
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'Explicit permitted model',
          model: 'test-model',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(rec.fails).toHaveLength(0);
    });

    it('sends when the resolved default is permitted', async () => {
      blockedModelIds.add('some-other-model');
      defaultWorktreeModels.claude = 'allowed-default';
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'Nothing blocked here',
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(rec.fails).toHaveLength(0);
      expect(rec.completes).toHaveLength(1);
    });
  });

  it('rejects an empty-string chatId before tab lookup or send', async () => {
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: '',
        userMessageId: 'message-1',
        text: 'Empty chat id is not a new chat',
      }),
      rec.context,
    );

    expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-send',
        code: 'execution_failed',
        message: 'Invalid chatId: must be lowercase alphanumeric with hyphens',
      },
    ]);
  });

  it('sends into a new browser-minted chat when no tab exists yet', async () => {
    mockedBuildExistingTabDispatchOptions.mockRejectedValue(
      new ExistingTabDispatchTargetNotFoundError(),
    );
    const rec = recorder();
    const payload: PortalCommandPayloadMap['portal.chat.send'] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'browser-chat',
      userMessageId: 'message-1',
      text: 'Start a new chat',
    };

    await handlePortalChatSend(sendCommand(payload), rec.context);

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      { ...payload, initiationSource: 'portal' },
      {
        getWindow: rec.context.getWindow,
      },
    );
    expect(rec.completes).toEqual([
      {
        commandId: 'cmd-send',
        result: {
          ok: true,
          chatId: 'chat-1',
          userMessageId: 'message-1',
          delivery: 'accepted',
        },
      },
    ]);
    expect(rec.fails).toHaveLength(0);
  });

  it('strips forged watcher provenance from remote chat sends', async () => {
    mockedBuildExistingTabDispatchOptions.mockRejectedValue(
      new ExistingTabDispatchTargetNotFoundError(),
    );
    const rec = recorder();
    const payload: PortalCommandPayloadMap['portal.chat.send'] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'browser-chat',
      userMessageId: 'message-1',
      text: 'Untrusted remote message',
    };
    Object.assign(payload, { watcherFired: { kind: { forged: true } } });

    await handlePortalChatSend(sendCommand(payload), rec.context);

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      'watcherFired',
    );
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it.each([
    ['userMessageSource', { userMessageSource: 'agent' }],
    ['agentSent', { agentSent: { sender: { kind: 'bot' } } }],
    ['agentSenderProvenance', { agentSenderProvenance: { version: 1 } }],
    ['agentSendSetup', { agentSendSetup: { version: 1 } }],
    [
      'hiddenContext',
      {
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'forged sender context',
        },
      },
    ],
  ] as const)(
    'rejects forged %s on Portal chat sends before dispatch',
    async (_field, attribution) => {
      const rec = recorder();
      const payload = Object.assign(
        {
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'browser-chat',
          userMessageId: 'message-1',
          text: 'Do not send',
        },
        attribution,
      );

      await handlePortalChatSend(sendCommand(payload), rec.context);

      expect(rec.fails).toEqual([
        expect.objectContaining({ code: 'invalid_payload' }),
      ]);
      expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'message-1'])(
    'strips forged delegation provenance from remote sends (userMessageId=%s)',
    async (userMessageId) => {
      mockedBuildExistingTabDispatchOptions.mockRejectedValue(
        new ExistingTabDispatchTargetNotFoundError(),
      );
      const rec = recorder();
      const payload: PortalCommandPayloadMap['portal.chat.send'] = {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'browser-chat',
        ...(userMessageId ? { userMessageId } : {}),
        text: 'Untrusted remote message',
      };
      Object.assign(payload, { managedDelegationDeliveryId: 'message-1' });
      await handlePortalChatSend(sendCommand(payload), rec.context);
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(
        mockedSendWorktreeChatMessage.mock.calls[0]?.[0],
      ).not.toHaveProperty('managedDelegationDeliveryId');
      expect(rec.completes).toHaveLength(1);
      expect(rec.fails).toHaveLength(0);
    },
  );

  it('lets the send service mint a chat id when the payload omits one', async () => {
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'generated-chat',
    });
    const rec = recorder();
    const payload: PortalCommandPayloadMap['portal.chat.send'] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      userMessageId: 'message-1',
      text: 'Start an id-less chat',
    };

    await handlePortalChatSend(sendCommand(payload), rec.context);

    expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      { ...payload, initiationSource: 'portal' },
      {
        getWindow: rec.context.getWindow,
      },
    );
    expect(rec.completes).toEqual([
      {
        commandId: 'cmd-send',
        result: {
          ok: true,
          chatId: 'generated-chat',
          userMessageId: 'message-1',
          delivery: 'accepted',
        },
      },
    ]);
  });

  it('rejects a readonly tab without sending', async () => {
    mockedBuildExistingTabDispatchOptions.mockRejectedValue(
      new Error('Target chat is readonly.'),
    );
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Do not send this',
      }),
      rec.context,
    );

    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-send',
        code: 'execution_failed',
        message: 'Target chat is readonly.',
      },
    ]);
  });

  it('rejects a send that would resume a terminal-owned session', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'claude',
      interfaceMode: 'auto',
      sdkSessionId: 'terminal-session',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue terminal chat',
      }),
      rec.context,
    );

    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-send',
        code: 'conflict',
        message: 'Terminal-backed chats cannot be driven from the portal yet.',
      },
    ]);
  });

  // CAN-2318. `...tabOptions` spreads before `...command.payload`, and a JSON
  // payload omits absent fields — so an explicit payload model with no
  // explicit provider used to inherit the TAB's provider. The service then
  // persisted that contradictory pair, and `worktree-chat-turn` resolves
  // `options.providerType ?? getProviderForModel(options.model)`, so the stale
  // provider won: a Claude model dispatched through Codex.
  it('derives the provider from an explicit payload model', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'codex',
      model: 'gpt-5-codex',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Switch to a Claude model',
        model: 'test-model',
      }),
      rec.context,
    );

    const sent = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sent?.model).toBe('test-model');
    expect(sent?.providerType).toBe(getProviderForModel('test-model'));
    expect(sent?.providerType).not.toBe('codex');
    expect(rec.fails).toHaveLength(0);
  });

  it('keeps an explicit payload provider over the derived one', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'claude',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Caller knows best',
        model: 'test-model',
        providerType: 'codex',
      }),
      rec.context,
    );

    // Derivation only fills a gap; it must never override an explicit choice.
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0].providerType).toBe(
      'codex',
    );
  });

  it('does not derive a provider from a malformed payload model', async () => {
    // `command.payload` is untrusted remote JSON. A guard gated on
    // `model !== undefined` would accept `null`, derive `'claude'`, and write
    // it here while the session-id drop above still saw no payload provider —
    // two provider derivations disagreeing, so a Codex tab silently runs the
    // Claude default. Sharing `payloadProvider` makes that impossible.
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'codex',
      model: 'gpt-5-codex',
    });
    const rec = recorder();

    const command = sendCommand({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Malformed model field',
    });
    // The payload TYPE forbids this; the wire does not. Assigned after
    // construction so the test exercises the runtime shape a remote client can
    // actually send without weakening the compile-time contract.
    Object.assign(command.payload, { model: null });

    await handlePortalChatSend(command, rec.context);

    // The tab's own provider stands; nothing is derived from a non-string.
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0].providerType).toBe(
      'codex',
    );
  });

  it('merges a partial portal modelConfig over the persisted one', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'claude',
      modelConfig: { thinkingLevel: 'low', fastMode: true },
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Think harder',
        modelConfig: { thinkingLevel: 'high' },
      }),
      rec.context,
    );

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { thinkingLevel: 'high', speed: 'fast', fastMode: true },
      }),
      { getWindow: rec.context.getWindow },
    );
    expect(rec.fails).toHaveLength(0);
  });

  it('applies deprecated top-level payload fields over the persisted modelConfig', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'codex',
      modelConfig: { thinkingLevel: 'low', fastMode: false },
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Legacy client send',
        thinkingLevel: 'medium',
        codexFastModeEnabled: true,
      }),
      rec.context,
    );

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { thinkingLevel: 'medium', speed: 'fast', fastMode: true },
      }),
      { getWindow: rec.context.getWindow },
    );
    expect(rec.fails).toHaveLength(0);
  });

  describe('Codex speed on Portal worktree sends', () => {
    const ULTRA_TAB_CONFIG: AgentModelConfig = {
      thinkingLevel: 'low',
      speed: 'ultrafast',
      fastMode: false,
    };
    const CLOUD_REF = {
      attachmentId: '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
      filename: 'photo.png',
      mediaType: 'image/png',
      size: 3,
      contentSha256: 'a'.repeat(64),
      storageKind: 'blob' as const,
      source: '/api/x',
    };

    beforeEach(() => {
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({
        providerType: 'codex',
        modelConfig: ULTRA_TAB_CONFIG,
      });
    });

    it('keeps a persisted Ultra fast speed through a thinking-only send', async () => {
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Think harder at the same speed',
          modelConfig: { thinkingLevel: 'high' },
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'ultrafast',
            fastMode: false,
          },
        }),
        { getWindow: rec.context.getWindow },
      );
      expect(rec.fails).toHaveLength(0);
    });

    it.each([
      [{ modelConfig: { fastMode: false } }, 'standard', false],
      [{ codexFastModeEnabled: false }, 'standard', false],
      [{ modelConfig: { fastMode: true } }, 'fast', true],
      [{ codexFastModeEnabled: true }, 'fast', true],
    ] as const)(
      'lets the explicit legacy boolean %j replace Ultra fast',
      async (fields, speed, fastMode) => {
        const rec = recorder();

        await handlePortalChatSend(
          sendCommand({
            projectId: 'workspace',
            worktreeId: 'worktree',
            chatId: 'chat-1',
            userMessageId: 'message-1',
            text: 'Switch speed',
            ...fields,
          }),
          rec.context,
        );

        expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            modelConfig: { thinkingLevel: 'low', speed, fastMode },
          }),
          { getWindow: rec.context.getWindow },
        );
        expect(rec.fails).toHaveLength(0);
      },
    );

    it("honors an upgraded client's exact speed over the persisted one", async () => {
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({
        providerType: 'codex',
        modelConfig: { speed: 'fast', fastMode: true },
      });
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Go faster',
          modelConfig: { speed: 'ultrafast' },
        }),
        rec.context,
      );

      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          modelConfig: { speed: 'ultrafast', fastMode: false },
        }),
        { getWindow: rec.context.getWindow },
      );
      expect(rec.fails).toHaveLength(0);
    });

    it('commits a replaced speed with its derived boolean on a revisioned send', async () => {
      const rec = recorder();
      const revisionedCommand = jest.fn(() =>
        Promise.resolve({
          commandId: 'cmd-send',
          revision: 8,
          outcome: 'applied' as const,
        }),
      );
      rec.context.chatStatePort = {
        getState: jest.fn(),
        command: revisionedCommand,
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Back to Regular',
          modelConfig: { fastMode: false },
        }),
        rec.context,
      );

      expect(revisionedCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          command: expect.objectContaining({
            type: 'chat.send_message',
            modelConfig: {
              thinkingLevel: 'low',
              speed: 'standard',
              fastMode: false,
            },
          }),
        }),
        {
          portalSend: {
            chatId: 'chat-1',
            userMessageId: 'message-1',
            fingerprint:
              '8e301d1e9a0a3272dfade6dc485fe6e04d0bfb0216c2ed56d262bfd185de1ac6',
          },
        },
      );
    });

    it.each([
      [
        { modelConfig: { speed: 'turbo' } },
        'modelConfig.speed must be standard, fast, or ultrafast.',
      ],
      [
        { modelConfig: { speed: 'ultrafast', fastMode: true } },
        'modelConfig.fastMode must match modelConfig.speed.',
      ],
      [
        { modelConfig: { speed: 'ultrafast' }, codexFastModeEnabled: true },
        'codexFastModeEnabled must match modelConfig.speed.',
      ],
      [
        { codexFastModeEnabled: 'yes' },
        'codexFastModeEnabled must be a boolean.',
      ],
    ])(
      'refuses the invalid or contradictory speed %j before any side effect',
      async (wire, message) => {
        const rec = recorder();
        const command = sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Malformed speed',
          cloudAttachments: [CLOUD_REF],
        });
        // Remote JSON can carry values outside the declared contract.
        Object.assign(command.payload, wire);

        await handlePortalChatSend(command, rec.context);

        expect(rec.fails).toEqual([
          { commandId: 'cmd-send', code: 'invalid_payload', message },
        ]);
        expect(mockMaterialize).not.toHaveBeenCalled();
        expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
        expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      },
    );
  });

  it('does not manufacture a session id omitted by terminal normalization', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'claude',
      interfaceMode: 'auto',
    });
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue natively',
      }),
      rec.context,
    );

    const sentRequest = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sentRequest).toEqual(
      expect.objectContaining({
        providerType: 'claude',
        interfaceMode: 'auto',
      }),
    );
    expect(sentRequest).not.toHaveProperty('sdkSessionId');
  });

  it('rejects malformed routing before tab lookup or send', async () => {
    const rec = recorder();

    await handlePortalChatSend(
      sendCommand({
        projectId: '../evil',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Invalid routing',
      }),
      rec.context,
    );

    expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-send',
        code: 'execution_failed',
        message:
          'Invalid projectId: must be lowercase alphanumeric with hyphens',
      },
    ]);
  });

  describe('portal cloudAttachments', () => {
    const CLOUD_REF = {
      attachmentId: '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
      filename: 'photo.png',
      mediaType: 'image/png',
      size: 3,
      contentSha256: 'a'.repeat(64),
      storageKind: 'blob' as const,
      source: '/api/x',
    };

    it('rejects attachment sends without a client-minted chat id before materializing blobs', async () => {
      const rec = recorder();
      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          userMessageId: 'message-1',
          text: 'see photo',
          providerType: 'claude',
          model: 'portal-model',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );
      expect(rec.fails).toEqual([
        expect.objectContaining({
          code: 'invalid_payload',
          message: 'Attachment sends require a chatId and userMessageId.',
        }),
      ]);
      expect(mockMaterialize).not.toHaveBeenCalled();
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    });

    it('merges materialized paths after payload attachmentPaths on the revisioned path', async () => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      const rec = recorder();
      const revisionedCommand = jest.fn(() =>
        Promise.resolve({
          commandId: 'cmd-send',
          revision: 8,
          outcome: 'applied' as const,
        }),
      );
      rec.context.chatStatePort = {
        getState: jest.fn(),
        command: revisionedCommand,
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          attachmentPaths: ['/tmp/existing.png'],
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(mockMaterialize).toHaveBeenCalledWith(
        expect.objectContaining({
          refs: [CLOUD_REF],
          projectId: 'workspace',
          worktreeId: 'worktree',
          sessionId: 'sess-1',
        }),
      );
      expect(revisionedCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            type: 'chat.send_message',
            chatId: 'chat-1',
            userMessageId: 'message-1',
            text: 'see photo',
            attachmentPaths: [
              '/tmp/existing.png',
              '/w/attachments/t/photo.png',
            ],
          },
        }),
        {
          portalSend: {
            chatId: 'chat-1',
            userMessageId: 'message-1',
            fingerprint:
              '05b20eaea46a84fee20d5ee0d1407a2e70dfba4672fa7027324ef1c86dfce68f',
          },
        },
      );
      expect(mockConsumeAttachments).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        attachmentIds: [CLOUD_REF.attachmentId],
      });
      expect(mockRemoveMaterializedAttachments).not.toHaveBeenCalled();
    });

    it('removes retry-local files while consuming blobs for an already-applied send', async () => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo-2.png']);
      const rec = recorder();
      rec.context.chatStatePort = {
        getState: jest.fn(),
        command: jest.fn(() =>
          Promise.resolve({
            commandId: 'cmd-send',
            revision: 8,
            outcome: 'already_applied' as const,
          }),
        ),
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(rec.completes).toHaveLength(1);
      expect(mockConsumeAttachments).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        attachmentIds: [CLOUD_REF.attachmentId],
      });
      expect(mockRemoveMaterializedAttachments).toHaveBeenCalledWith([
        '/w/attachments/t/photo-2.png',
      ]);
    });

    it('completes a receipted retry without downloading consumed attachments', async () => {
      const rec = recorder();
      const command = jest.fn(() =>
        Promise.resolve({
          commandId: 'cmd-send',
          revision: 8,
          outcome: 'already_applied' as const,
        }),
      );
      rec.context.chatStatePort = {
        getState: jest.fn(),
        command,
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;
      Reflect.set(
        rec.context.chatStatePort,
        'getCommandReceipt',
        jest.fn(() =>
          Promise.resolve({
            commandId: 'cmd-send',
            revision: 8,
            outcome: 'applied' as const,
          }),
        ),
      );

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(rec.completes).toEqual([
        {
          commandId: 'cmd-send',
          result: {
            commandId: 'cmd-send',
            revision: 8,
            outcome: 'already_applied',
            userMessageId: 'message-1',
            delivery: 'accepted',
          },
        },
      ]);
      expect(command).not.toHaveBeenCalled();
      expect(mockMaterialize).not.toHaveBeenCalled();
      expect(mockConsumeAttachments).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        attachmentIds: [CLOUD_REF.attachmentId],
      });
    });

    // The blobs are the only copy a retry could use, and a `conflict` is
    // explicitly retryable — consuming here would make the retry impossible.
    it('leaves the blobs alone when the revisioned dispatch reports a retryable conflict', async () => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      const rec = recorder();
      rec.context.chatStatePort = {
        getState: jest.fn(),
        command: jest.fn(() =>
          Promise.resolve({
            commandId: 'cmd-send',
            revision: 8,
            outcome: 'conflict' as const,
            reason: 'Revision moved on.',
          }),
        ),
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(mockMaterialize).toHaveBeenCalled();
      expect(rec.fails[0]).toMatchObject({ code: 'conflict' });
      expect(mockConsumeAttachments).not.toHaveBeenCalled();
      expect(mockRemoveMaterializedAttachments).toHaveBeenCalledWith([
        '/w/attachments/t/photo.png',
      ]);
    });

    it('keeps materialized files when a thrown dispatch has a durable receipt', async () => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      const rec = recorder();
      const getCommandReceipt = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          commandId: 'cmd-send',
          revision: 8,
          outcome: 'applied' as const,
        });
      rec.context.chatStatePort = {
        getState: jest.fn(),
        getCommandReceipt,
        command: jest.fn(() => Promise.reject(new Error('connection lost'))),
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(getCommandReceipt).toHaveBeenCalledTimes(2);
      expect(rec.fails).toEqual([
        expect.objectContaining({
          code: 'execution_failed',
          message: 'The chat state service is temporarily unavailable.',
        }),
      ]);
      expect(mockRemoveMaterializedAttachments).not.toHaveBeenCalled();
      expect(mockConsumeAttachments).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        attachmentIds: [CLOUD_REF.attachmentId],
      });
    });

    it('keeps materialized files when receipt reconciliation is unavailable', async () => {
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      const rec = recorder();
      const getCommandReceipt = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('receipt store unavailable'));
      rec.context.chatStatePort = {
        getState: jest.fn(),
        getCommandReceipt,
        command: jest.fn(() => Promise.reject(new Error('connection lost'))),
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(getCommandReceipt).toHaveBeenCalledTimes(2);
      expect(mockRemoveMaterializedAttachments).not.toHaveBeenCalled();
      expect(mockConsumeAttachments).not.toHaveBeenCalled();
    });

    // Materialization happens before the model/policy preflight, so a refusal
    // after it must not release the blobs either.
    it('leaves the blobs alone when a post-materialize policy refusal fires', async () => {
      blockedModelIds.add('blocked-model');
      mockMaterialize.mockResolvedValue(['/w/attachments/t/photo.png']);
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          model: 'blocked-model',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(mockMaterialize).toHaveBeenCalled();
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message: 'This model is blocked by your organization policy.',
        },
      ]);
      expect(mockConsumeAttachments).not.toHaveBeenCalled();
      expect(mockRemoveMaterializedAttachments).toHaveBeenCalledWith([
        '/w/attachments/t/photo.png',
      ]);
    });

    // `resolveAgentAttachmentsDir` and the turn path disagree about where an
    // app-managed chat's attachments live, so these scopes are refused before
    // a file is written rather than materialized somewhere the send cannot
    // read.
    it.each([
      ['App Advisor', APP_ADVISOR_PROJECT_ID],
      ['the Pipeline Editor', PIPELINE_EDITOR_PROJECT_ID],
      ['the legacy standalone-chat sentinel', STANDALONE_CHAT_PROJECT_ID],
    ])('refuses attachments addressed to %s', async (_label, projectId) => {
      const rec = recorder();

      await handlePortalChatSend(
        sendCommand({
          projectId,
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'see photo',
          cloudAttachments: [CLOUD_REF],
        }),
        rec.context,
      );

      expect(mockMaterialize).not.toHaveBeenCalled();
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-send',
          code: 'invalid_payload',
          message: 'Attachments are not supported for this chat.',
        },
      ]);
    });

    it('fails the command with the materializer code and sends nothing', async () => {
      mockedBuildExistingTabDispatchOptions.mockResolvedValue({});
      mockMaterialize.mockRejectedValue(
        new PortalChatAttachmentError(
          'execution_failed',
          "Couldn't download photo.png",
          true,
        ),
      );
      const fails: Array<{
        code: string;
        message: string;
        retryable: boolean | undefined;
      }> = [];
      const context: PortalAdapterContext = {
        getWindow: () => null,
        enqueueEvent: (): void => {},
        complete: (): void => {},
        fail: (_command, code, message, retryable): void => {
          fails.push({ code, message, retryable });
        },
      };

      await handlePortalChatSend(
        sendCommand({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'x',
          providerType: 'claude',
          model: 'portal-model',
          cloudAttachments: [CLOUD_REF],
        }),
        context,
      );

      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(fails).toEqual([
        {
          code: 'execution_failed',
          message: "Couldn't download photo.png",
          retryable: true,
        },
      ]);
    });

    it('rejects a malformed cloudAttachments entry as invalid_payload before any model checks', async () => {
      const rec = recorder();
      // The wire payload is untrusted remote JSON; `Reflect.set` mutates a
      // validly-typed payload with a malformed entry the same way the
      // existing "rejects a non-string Portal user message id" test above
      // does, instead of forcing the type with `as`.
      const payload: PortalCommandPayloadMap['portal.chat.send'] = {
        projectId: 'workspace',
        worktreeId: 'worktree',
        text: 'x',
      };
      Reflect.set(payload, 'cloudAttachments', [{ attachmentId: 'nope' }]);

      await handlePortalChatSend(sendCommand(payload), rec.context);

      expect(rec.fails[0]).toMatchObject({ code: 'invalid_payload' });
      expect(mockMaterialize).not.toHaveBeenCalled();
      expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
    });
  });
});

describe('chat portal adapter — queue edit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects forged source metadata before applying a queued edit', async () => {
    const rec = recorder();
    const command = queueCommand('portal.chat.queue.edit', {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      entryId: 'q1',
      text: 'revised',
    });
    Object.assign(command.payload, { userMessageSource: 'agent' });

    await handlePortalChatQueueEdit(command, rec.context);

    expect(rec.fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(queueEdit).not.toHaveBeenCalled();
    expect(queueGetWorktreeSnapshots).not.toHaveBeenCalled();
  });

  it('passes a validated text edit to the host queue', async () => {
    const rec = recorder();
    await handlePortalChatQueueEdit(
      queueCommand('portal.chat.queue.edit', {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        entryId: 'q1',
        text: 'revised',
      }),
      rec.context,
    );
    expect(queueEdit).toHaveBeenCalledWith(
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        entryId: 'q1',
        text: 'revised',
      },
      undefined,
      'preserve',
    );
    expect(rec.completes).toHaveLength(1);
  });

  it('preserves attachment-bearing entries without taking a stale payload snapshot', async () => {
    const rec = recorder();
    await handlePortalChatQueueEdit(
      queueCommand('portal.chat.queue.edit', {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        entryId: 'q1',
        text: 'revised',
      }),
      rec.context,
    );
    expect(queueGetWorktreeSnapshots).not.toHaveBeenCalled();
    expect(queueEdit).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 'q1', text: 'revised' }),
      undefined,
      'preserve',
    );
    expect(rec.fails).toEqual([]);
    expect(rec.completes).toHaveLength(1);
  });

  it('uses the Portal-origin preservation policy on the revisioned queue-edit path', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-queue',
        revision: 3,
        outcome: 'applied' as const,
      }),
    );
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatQueueEdit(
      queueCommand('portal.chat.queue.edit', {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        entryId: 'q1',
        text: 'revised',
      }),
      rec.context,
    );

    expect(revisionedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'portal',
        command: {
          type: 'chat.edit_queued_message',
          chatId: 'chat',
          queuedMessageId: 'q1',
          text: 'revised',
        },
      }),
    );
    expect(queueEdit).not.toHaveBeenCalled();
    expect(rec.fails).toEqual([]);
    expect(rec.completes).toHaveLength(1);
  });

  it('routes an authenticated Portal queue command through the core dispatcher', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-queue',
        revision: 3,
        outcome: 'applied' as const,
      }),
    );
    const port: ChatStateCommandPort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      searchTranscript: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: () => (): void => {},
    };
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    rec.context.chatStatePort = port;
    rec.context.dispatchChatCommand = (
      request,
    ): ReturnType<typeof dispatchTrustedChatCommand> =>
      dispatchTrustedChatCommand(
        request,
        createChatCommandDispatchOptions(port, runtime, {
          principalId: 'local-desktop-user',
          clientInstanceId: 'portal-command',
          authorityId: 'local-desktop',
          interfaceKind: 'desktop',
          grants: ['core.chat.write'],
        }),
      );
    const instruction = jest.spyOn(runtime, 'instruction');

    try {
      await handlePortalChatQueueEdit(
        queueCommand('portal.chat.queue.edit', {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          entryId: 'q1',
          text: 'revised',
        }),
        rec.context,
      );
      expect(rec.fails).toEqual([]);
      expect(rec.completes[0]?.result).toMatchObject({ revision: 3 });
      expect(instruction).toHaveBeenCalledWith(
        'core.chat.queue.entry.update',
        expect.anything(),
        expect.anything(),
      );
      expect(revisionedCommand).toHaveBeenCalledWith({
        schemaVersion: 1,
        commandId: 'cmd-queue',
        projectId: 'ws',
        worktreeId: 'wt',
        origin: 'portal',
        command: {
          type: 'chat.edit_queued_message',
          chatId: 'chat',
          queuedMessageId: 'q1',
          text: 'revised',
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('passes a validated edit lock to the host queue', async () => {
    const rec = recorder();
    await handlePortalChatQueueSetEditLock(
      queueCommand('portal.chat.queue.set_edit_lock', {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        entryId: 'q1',
        locked: true,
      }),
      rec.context,
    );
    expect(queueSetEditLock).toHaveBeenCalledWith(
      { projectId: 'ws', worktreeId: 'wt', chatId: 'chat', entryId: 'q1' },
      'q1',
      true,
      'cmd-queue',
    );
    expect(rec.completes).toHaveLength(1);
  });

  it('does not complete a Portal edit lock when the host rejects acquisition', async () => {
    const rec = recorder();
    queueSetEditLock.mockRejectedValueOnce(
      new Error('This message is no longer available to edit.'),
    );

    await expect(
      handlePortalChatQueueSetEditLock(
        queueCommand('portal.chat.queue.set_edit_lock', {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          entryId: 'q1',
          locked: true,
        }),
        rec.context,
      ),
    ).rejects.toThrow('This message is no longer available to edit.');
    expect(rec.completes).toEqual([]);
  });

  it('owns a Portal edit lock by its browser acquisition id', async () => {
    const rec = recorder();
    await handlePortalChatQueueSetEditLock(
      queueCommand('portal.chat.queue.set_edit_lock', {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        entryId: 'q1',
        locked: true,
        acquisitionId: 'browser-acquisition',
      }),
      rec.context,
    );
    expect(queueSetEditLock).toHaveBeenCalledWith(
      { projectId: 'ws', worktreeId: 'wt', chatId: 'chat', entryId: 'q1' },
      'q1',
      true,
      'browser-acquisition',
    );
    expect(rec.completes).toHaveLength(1);
  });

  it('forwards the abandoned acquisition identity for conditional cleanup', async () => {
    const rec = recorder();
    await handlePortalChatQueueSetEditLock(
      queueCommand('portal.chat.queue.set_edit_lock', {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        entryId: 'q1',
        locked: false,
        releaseAcquisitionId: 'abandoned-command',
      }),
      rec.context,
    );
    expect(queueSetEditLock).toHaveBeenCalledWith(
      { projectId: 'ws', worktreeId: 'wt', chatId: 'chat', entryId: 'q1' },
      'q1',
      false,
      'abandoned-command',
    );
    expect(rec.completes).toHaveLength(1);
  });

  it('allows Advisor steering through the canonical queue command', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn().mockResolvedValue({
      commandId: 'cmd-queue',
      revision: 1,
      outcome: 'applied',
    });
    rec.context.chatStatePort = {
      getState: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    await handlePortalChatQueueSteer(
      {
        id: 'cmd-queue',
        sequence: 1,
        type: 'portal.chat.queue.steer',
        createdAt: '2026-09-15T00:00:00.000Z',
        expiresAt: null,
        payload: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'advisor-entry',
          chatId: 'advisor-chat',
          entryId: 'queued-input',
        },
      },
      rec.context,
    );
    expect(rec.fails).toEqual([]);
    expect(revisionedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
        command: {
          type: 'chat.steer_queued_message',
          chatId: 'advisor-chat',
          queuedMessageId: 'queued-input',
        },
      }),
    );
  });

  it('forwards uncertain delivery dismissal with its revision through canonical chat state', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn().mockResolvedValue({
      commandId: 'cmd-dismiss',
      revision: 4,
      outcome: 'applied',
    });
    rec.context.chatStatePort = {
      getState: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    await handlePortalChatInputDelivery(
      {
        id: 'cmd-dismiss',
        sequence: 1,
        type: 'portal.chat.input_delivery',
        createdAt: '2026-10-02T00:00:00.000Z',
        expiresAt: null,
        payload: {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          rowId: 'row-1',
          rowRevision: 3,
          action: 'dismiss',
        },
      },
      rec.context,
    );
    expect(rec.fails).toEqual([]);
    expect(rec.completes).toHaveLength(1);
    expect(revisionedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'ws',
        worktreeId: 'wt',
        origin: 'portal',
        command: {
          type: 'chat.input_delivery_action',
          chatId: 'chat',
          rowId: 'row-1',
          rowRevision: 3,
          action: 'dismiss',
        },
      }),
    );
  });

  it('rejects forged sender metadata on Portal input-delivery actions before dispatch', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatInputDelivery(
      {
        id: 'cmd-delivery-forged',
        sequence: 1,
        type: 'portal.chat.input_delivery',
        createdAt: '2026-10-02T00:00:00.000Z',
        expiresAt: null,
        payload: {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          rowId: 'row-1',
          rowRevision: 3,
          action: 'edit',
          text: 'revised',
          agentSent: { sender: { kind: 'bot' } },
        },
      },
      rec.context,
    );

    expect(rec.fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(revisionedCommand).not.toHaveBeenCalled();
  });

  it('fails revisioned steering and delivery commands when chat state is unavailable', async () => {
    const steer = recorder();
    await handlePortalChatQueueSteer(
      {
        id: 'cmd-steer-unavailable',
        sequence: 1,
        type: 'portal.chat.queue.steer',
        createdAt: '2026-09-16T00:00:00.000Z',
        expiresAt: null,
        payload: {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          entryId: 'q1',
        },
      },
      steer.context,
    );
    expect(steer.completes).toEqual([]);
    expect(steer.fails).toEqual([
      expect.objectContaining({ code: 'execution_failed' }),
    ]);

    const delivery = recorder();
    await handlePortalChatInputDelivery(
      {
        id: 'cmd-delivery-unavailable',
        sequence: 2,
        type: 'portal.chat.input_delivery',
        createdAt: '2026-09-16T00:00:00.000Z',
        expiresAt: null,
        payload: {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          rowId: 'row-1',
          rowRevision: 1,
          action: 'cancel',
        },
      },
      delivery.context,
    );
    expect(delivery.completes).toEqual([]);
    expect(delivery.fails).toEqual([
      expect.objectContaining({ code: 'execution_failed' }),
    ]);
  });
});

describe('chat portal adapter — question mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRequest.mockImplementation(({ requestId }) =>
      Promise.resolve({ requestId, ok: true }),
    );
  });

  it('delivers answer payloads unchanged and completes after renderer success', async () => {
    const answers = [
      {
        questionId: 'scope',
        question: 'Which scope?',
        selectedOptions: ['Focused'],
        freeformText: 'Include tests',
      },
    ];
    const rec = recorder();

    await handlePortalChatAnswerQuestion(
      answerQuestionCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: 'question-request-1',
        answers,
      }),
      rec.context,
    );

    expectRequested({
      requestId: 'cmd-answer-question',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'answer_question',
        questionRequestId: 'question-request-1',
        answers,
      },
    });
    const requestedCommand = mockedRequest.mock.calls[0]?.[0].command;
    expect(requestedCommand?.kind).toBe('answer_question');
    if (requestedCommand?.kind === 'answer_question') {
      expect(requestedCommand.answers).toBe(answers);
    }
    expect(rec.completes).toEqual([
      {
        commandId: 'cmd-answer-question',
        result: { ok: true },
      },
    ]);
    expect(rec.fails).toHaveLength(0);
  });

  it('passes trusted origin as execution metadata on revisioned answers', async () => {
    const sender: ExternalAgentSender = {
      kind: 'external_agent',
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Research client',
      verified: true,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    const rec = recorder();
    const dispatchChatCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-answer-question',
        revision: 1,
        outcome: 'applied' as const,
      }),
    );
    const chatStatePort: ChatStateCommandPort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: jest.fn(),
      subscribe: (): (() => void) => (): void => {},
    };
    Reflect.set(rec.context, 'origin', sender);
    rec.context.chatStatePort = chatStatePort;
    Reflect.set(rec.context, 'dispatchChatCommand', dispatchChatCommand);

    await handlePortalChatAnswerQuestion(
      answerQuestionCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: 'question-request-1',
        answers: [],
      }),
      rec.context,
    );

    expect(dispatchChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          type: 'chat.answer_question',
          chatId: 'chat',
          questionId: 'question-request-1',
          answers: [],
        },
      }),
      { agentSent: sender },
    );
    expect(rec.fails).toHaveLength(0);
  });

  it('fails closed rather than dropping trusted origin on renderer answer fallback', async () => {
    const sender: ExternalAgentSender = {
      kind: 'external_agent',
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Research client',
      verified: true,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    const rec = recorder();
    Reflect.set(rec.context, 'origin', sender);

    await handlePortalChatAnswerQuestion(
      answerQuestionCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: 'question-request-1',
        answers: [],
      }),
      rec.context,
    );

    expect(mockedRequest).not.toHaveBeenCalled();
    const trustedSenderMessage: unknown =
      expect.stringContaining('trusted sender');
    expect(rec.fails).toEqual([
      expect.objectContaining({
        code: 'execution_failed',
        message: trustedSenderMessage,
      }),
    ]);
  });

  it('delivers dismissal to the same scoped chat', async () => {
    const rec = recorder();

    await handlePortalChatDismissQuestion(
      dismissQuestionCommand({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        requestId: 'question-request-1',
      }),
      rec.context,
    );

    expectRequested({
      requestId: 'cmd-dismiss-question',
      command: {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        kind: 'dismiss_question',
        questionRequestId: 'question-request-1',
      },
    });
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('returns not_found for an unknown question without throwing', async () => {
    mockedRequest.mockResolvedValue({
      requestId: 'cmd-answer-question',
      ok: false,
      code: 'not_found',
      error: 'The question request was not found.',
      retryable: false,
    });
    const rec = recorder();

    await expect(
      handlePortalChatAnswerQuestion(
        answerQuestionCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          requestId: 'unknown-question',
          answers: [],
        }),
        rec.context,
      ),
    ).resolves.toBeUndefined();

    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-answer-question',
        code: 'not_found',
        message: 'The question request was not found.',
      },
    ]);
  });

  it.each([
    ['non-array answers', { unexpected: true }],
    ['missing question', [{ selectedOptions: ['Focused'] }]],
    [
      'non-string selected option',
      [{ question: 'Which scope?', selectedOptions: [1] }],
    ],
    [
      'non-string questionId',
      [{ questionId: 1, question: 'Which scope?', selectedOptions: [] }],
    ],
    [
      'non-string freeformText',
      [{ question: 'Which scope?', selectedOptions: [], freeformText: null }],
    ],
  ])('rejects %s before renderer delivery', async (_label, answers) => {
    const rec = recorder();

    await handlePortalChatAnswerQuestion(
      answerQuestionCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: 'question-request-1',
        answers: answers as never,
      }),
      rec.context,
    );

    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toHaveLength(1);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it.each([
    [
      'missing routing id',
      {
        projectId: '',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: 'question-request-1',
        answers: [],
      },
    ],
    [
      'missing request id',
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: '',
        answers: [],
      },
    ],
  ])('rejects a %s before renderer delivery', async (_label, payload) => {
    const rec = recorder();

    await handlePortalChatAnswerQuestion(
      answerQuestionCommand(payload),
      rec.context,
    );

    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toHaveLength(1);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it.each(['invalid_target', 'execution_failed'] as const)(
    'emits one structured %s failure from the renderer',
    async (code) => {
      mockedRequest.mockResolvedValue({
        requestId: 'cmd-dismiss-question',
        ok: false,
        code,
        error: `Renderer reported ${code}.`,
        retryable: false,
      });
      const rec = recorder();

      await handlePortalChatDismissQuestion(
        dismissQuestionCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          requestId: 'question-request-1',
        }),
        rec.context,
      );

      expect(rec.completes).toHaveLength(0);
      expect(rec.fails).toEqual([
        {
          commandId: 'cmd-dismiss-question',
          code,
          message: `Renderer reported ${code}.`,
        },
      ]);
    },
  );
});

describe('chat portal adapter — composer setters (CAN-1217)', () => {
  beforeAll(() => {
    // set_model validates against the runtime model registry via
    // resolveKnownModel, so register a known model for the happy path.
    initClaudeModels([{ id: 'test-model', label: 'Test Model' }]);
    initOllamaModels([
      {
        id: 'ollama-test-model',
        rawModelId: 'test-model',
        label: 'Ollama Test Model',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
  });

  beforeEach(() => {
    blockedModelIds.clear();
    jest.clearAllMocks();
    mockedSend.mockReturnValue({ delivered: true });
    mockedRequest.mockImplementation(({ requestId }) =>
      Promise.resolve({ requestId, ok: true }),
    );
  });

  it('routes revisioned setters through composer orchestration when the service is available', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-model',
        revision: 7,
        outcome: 'applied' as const,
      }),
    );
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'test-model',
      }),
      rec.context,
    );

    expectRequested({
      requestId: 'cmd-model',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'model',
        model: 'test-model',
      },
    });
    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(rec.completes[0]?.result).toEqual({ ok: true });
  });

  it('pins an inheriting Agent to the chat default before policy checks', async () => {
    initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        available: true,
      },
    ]);
    const rec = recorder();
    try {
      await handlePortalChatSetModel(
        setModelCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          model: 'agent_model_inherit',
        }),
        rec.context,
      );
    } finally {
      initAgentModels([]);
    }

    expect(rec.fails).toEqual([]);
    expectRequested({
      requestId: 'cmd-model',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'model',
        model: 'agent_model_inherit@test-model',
      },
    });
    expect(rec.fails).toEqual([]);
  });

  it('persists Auto selection mode directly through the revisioned chat service', async () => {
    const rec = recorder();
    const revisionedCommand = jest.fn(() =>
      Promise.resolve({
        commandId: 'cmd-model',
        revision: 8,
        outcome: 'applied' as const,
      }),
    );
    rec.context.chatStatePort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        selectionMode: 'auto',
      }),
      rec.context,
    );

    expect(revisionedCommand).toHaveBeenCalledWith({
      schemaVersion: 1,
      commandId: 'cmd-model',
      projectId: 'ws',
      worktreeId: 'wt',
      origin: 'portal',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: { modelSelectionMode: 'auto' },
      },
    });
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.completes[0]?.result).toEqual({
      commandId: 'cmd-model',
      revision: 8,
      outcome: 'applied',
    });
  });

  it('rejects an Auto selection payload that also names a concrete model', async () => {
    const rec = recorder();
    const payload = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      selectionMode: 'auto',
      model: 'test-model',
    } as unknown as PortalCommandPayloadMap['portal.chat.set_model'];

    await handlePortalChatSetModel(setModelCommand(payload), rec.context);

    expect(rec.fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Auto selection must not include a concrete model.',
      }),
    ]);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('rejects a Portal Cursor model change with connect guidance while the runtime is unavailable', async () => {
    const rec = recorder();
    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'cursor-default',
      }),
      rec.context,
    );
    expect(rec.fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Connect Cursor in the desktop app to use it here.',
      }),
    ]);
    expect(rec.completes).toHaveLength(0);
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('dispatches a Portal Cursor model change to the renderer when the runtime is available', async () => {
    cursorRuntimeAvailable = true;
    const rec = recorder();
    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'cursor-default',
      }),
      rec.context,
    );
    expectRequested({
      requestId: 'cmd-model',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'model',
        model: 'cursor-default',
      },
    });
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('rejects a Portal OpenCode model change with connect guidance while the runtime is unavailable', async () => {
    const rec = recorder();
    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'opencode:fixture%2Fmodel',
      }),
      rec.context,
    );
    expect(rec.fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Connect OpenCode in the desktop app to use it here.',
      }),
    ]);
    expect(rec.completes).toHaveLength(0);
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('dispatches a Portal OpenCode model change to the renderer when the runtime is available', async () => {
    opencodeRuntimeAvailable = true;
    const rec = recorder();
    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'opencode:fixture%2Fmodel',
      }),
      rec.context,
    );
    expectRequested({
      requestId: 'cmd-model',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'model',
        model: 'opencode:fixture%2Fmodel',
      },
    });
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('completes a valid set_model after its renderer acknowledgement', async () => {
    blockedModelIds.add('some-other-model');
    const rec = recorder();
    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'test-model',
      }),
      rec.context,
    );
    expectRequested({
      requestId: 'cmd-model',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'model',
        model: 'test-model',
      },
    });
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('rejects a model blocked by the current organization policy', async () => {
    blockedModelIds.add('test-model');
    const rec = recorder();

    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'test-model',
      }),
      rec.context,
    );

    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-model',
        code: 'invalid_payload',
        message: 'This model is blocked by your organization policy.',
      },
    ]);
  });

  // Passthrough only: `isModelBlockedByStoredPolicy` is mocked in this file,
  // so this asserts the adapter dispatches whatever the policy check permits —
  // NOT that the real implementation exempts Ollama. That exemption is
  // asserted against the real function in `model-policy-state.test.ts`.
  it('dispatches a model the policy check permits (Ollama id, policy active)', async () => {
    blockedModelIds.add('test-model');
    const rec = recorder();

    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'ollama-test-model',
      }),
      rec.context,
    );

    expectRequested({
      requestId: 'cmd-model',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'model',
        model: 'ollama-test-model',
      },
    });
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('reports a standalone chat model policy rejection from the service', async () => {
    mockedSetStandaloneChatModel.mockRejectedValueOnce(
      new Error('This model is blocked by your organization policy.'),
    );
    const rec = recorder();

    await handlePortalStandaloneChatSetModel(
      setStandaloneModelCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        model: 'test-model',
      }),
      rec.context,
    );

    expect(mockedSetStandaloneChatModel).toHaveBeenCalledWith(
      {
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        model: 'test-model',
      },
      { getWindow: rec.context.getWindow },
    );
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-standalone-model',
        code: 'execution_failed',
        message: 'This model is blocked by your organization policy.',
      },
    ]);
  });

  // CAN-2318: the cowork send is the direct sibling of `portal.chat.send`.
  // `sendStandaloneChatMessage` mints a durable Work Entry and persists the
  // user message before the session gate can refuse, so a blocked model has
  // to be rejected here or it leaves partial state behind.
  it('rejects a blocked standalone chat send before persistence', async () => {
    blockedModelIds.add('test-model');
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'Start a cowork chat on a blocked model',
        model: 'test-model',
      }),
      rec.context,
    );

    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-standalone-send',
        code: 'invalid_payload',
        message: 'This model is blocked by your organization policy.',
      },
    ]);
  });

  // CAN-2318: `sendStandaloneChatMessage` hands `providerType` to
  // `dispatchWorktreeChatTurn`, which resolves the dispatched default as
  // `providerType ?? (model ? providerFor(model) : 'claude')`. Web sends this
  // field on cowork sends (derived from the reference chat's provider), so
  // dropping it here judges a default the turn will never run and lets the one
  // it WILL run through — persisting a Work Entry and the user message first.
  it('forwards the payload providerType to the policy resolver', async () => {
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'No model, provider decides the default',
        providerType: 'codex',
      }),
      rec.context,
    );

    expect(mockedResolveStandaloneChatPolicyModels).toHaveBeenCalledWith(
      expect.objectContaining({ providerType: 'codex' }),
    );
  });

  it('omits providerType when the payload carries none', async () => {
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'Mobile sends neither model nor provider',
      }),
      rec.context,
    );

    // Absent must stay absent so the resolver applies its documented
    // `'claude'` fallback rather than receiving an explicit undefined.
    const call = mockedResolveStandaloneChatPolicyModels.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call && 'providerType' in call).toBe(false);
  });

  it('sends a standalone chat message on a permitted model', async () => {
    blockedModelIds.add('some-other-model');
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'Nothing blocked here',
        model: 'test-model',
      }),
      rec.context,
    );

    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledTimes(1);
    expect(rec.fails).toHaveLength(0);
    expect(rec.completes).toHaveLength(1);
  });

  it('sends a standalone chat message that names no model', async () => {
    // No explicit model means "use the chat's persisted default", which the
    // session gate still polices; this guard must not reject it outright.
    blockedModelIds.add('test-model');
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'No model on the payload',
      }),
      rec.context,
    );

    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledTimes(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('rejects a blocked model persisted on the standalone chat', async () => {
    // The usual cowork send omits `model` — the selection lives on the tab —
    // so checking only the payload would let a policy arriving mid-chat
    // through, and `sendStandaloneChatMessage` mints a Work Entry and
    // persists the message before the session gate can refuse.
    blockedModelIds.add('persisted-blocked-model');
    mockedResolveStandaloneChatPolicyModels.mockResolvedValueOnce({
      readable: true,
      models: ['persisted-blocked-model'],
    });
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'No model on the payload; the tab holds a blocked one',
      }),
      rec.context,
    );

    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-standalone-send',
        code: 'invalid_payload',
        message: 'This model is blocked by your organization policy.',
      },
    ]);
  });

  it('rejects a blocked cowork default on a standalone send', async () => {
    // `sendStandaloneChatMessage` dispatches `request.model ?? the cowork
    // default` — it does NOT inherit the tab's model — so a blocked default
    // must be caught here or it persists a Work Entry and the user message
    // before the session gate refuses.
    blockedModelIds.add('blocked-cowork-default');
    mockedResolveStandaloneChatPolicyModels.mockResolvedValueOnce({
      readable: true,
      models: ['blocked-cowork-default'],
    });
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'No payload model; the cowork default is blocked',
      }),
      rec.context,
    );

    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-standalone-send',
        code: 'invalid_payload',
        message: 'This model is blocked by your organization policy.',
      },
    ]);
  });

  it('refuses a standalone send with unreadable preferences under a policy', async () => {
    blockedModelIds.add('some-other-model');
    mockedResolveStandaloneChatPolicyModels.mockResolvedValueOnce({
      readable: false,
      models: [],
    });
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'Preferences unreadable, so the dispatched model is unknown',
      }),
      rec.context,
    );

    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    expect(rec.fails).toEqual([
      {
        commandId: 'cmd-standalone-send',
        code: 'invalid_payload',
        message:
          'Your organization policy could not be applied to this message. Try again.',
      },
    ]);
  });

  it('still sends on unreadable preferences without an active policy', async () => {
    mockedResolveStandaloneChatPolicyModels.mockResolvedValueOnce({
      readable: false,
      models: [],
    });
    const rec = recorder();

    await handlePortalStandaloneChatSend(
      standaloneSendCommand({
        projectLocalId: 'cowork-project',
        chatId: 'chat',
        message: 'Ungoverned account, transient disk error',
      }),
      rec.context,
    );

    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledTimes(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('requests a thinking composer command', async () => {
    const rec = recorder();
    await handlePortalChatSetThinkingLevel(
      setThinkingCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        thinkingLevel: 'high',
      }),
      rec.context,
    );
    expectRequested({
      requestId: 'cmd-thinking',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'thinking',
        thinkingLevel: 'high',
      },
    });
    expect(rec.completes).toHaveLength(1);
  });

  it('requests a plan composer command', async () => {
    const rec = recorder();
    await handlePortalChatSetPlanMode(
      setPlanCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        planMode: true,
      }),
      rec.context,
    );
    expectRequested({
      requestId: 'cmd-plan',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'plan',
        planMode: true,
      },
    });
    expect(rec.completes).toHaveLength(1);
  });

  it('requests a fast composer command', async () => {
    const rec = recorder();
    await handlePortalChatSetFastMode(
      setFastCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        fastMode: true,
      }),
      rec.context,
    );
    expectRequested({
      requestId: 'cmd-fast',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'fast',
        fastMode: true,
      },
    });
    expect(rec.completes).toHaveLength(1);
  });

  it('rejects a setter with a missing chatId before requesting it', async () => {
    const rec = recorder();
    await handlePortalChatSetPlanMode(
      setPlanCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        // A malformed browser payload can omit chatId at runtime.
        chatId: '',
        planMode: true,
      }),
      rec.context,
    );
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it.each([
    { projectId: '../evil', worktreeId: 'wt', chatId: 'chat' },
    { projectId: 'ws', worktreeId: '../evil', chatId: 'chat' },
    { projectId: 'ws', worktreeId: 'wt', chatId: '../evil' },
  ])('rejects malformed setter target ids: %o', async (target) => {
    const rec = recorder();
    await handlePortalChatSetPlanMode(
      setPlanCommand({ ...target, planMode: true }),
      rec.context,
    );
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('rejects an unknown model id instead of falsely acking', async () => {
    const rec = recorder();
    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'not-a-real-model',
      }),
      rec.context,
    );
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('passes a renderer delivery failure through to the portal', async () => {
    mockedRequest.mockResolvedValue({
      requestId: 'cmd-model',
      ok: false,
      code: 'execution_failed',
      error: 'The desktop app renderer is unavailable.',
      retryable: true,
    });
    const rec = recorder();
    await handlePortalChatSetModel(
      setModelCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        model: 'test-model',
      }),
      rec.context,
    );
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('execution_failed');
    expect(rec.fails[0]?.message).toBe(
      'The desktop app renderer is unavailable.',
    );
  });

  it('carries the deferred policy in the same correlated plugin save', async () => {
    const rec = recorder();
    const payload = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      deferredToolsAllowed: false,
    };
    await handlePortalChatSetPluginSelections(
      {
        id: 'policy-save',
        sequence: 1,
        type: 'portal.chat.set_plugin_selections',
        payload,
        createdAt: '2026-10-12T00:00:00Z',
        expiresAt: null,
      },
      rec.context,
    );
    expectRequested({
      requestId: 'policy-save',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'plugins',
        selections: payload.selections,
        deferredToolsAllowed: false,
      },
    });
    expect(rec.fails).toHaveLength(0);
  });

  it.each(['false', 0, null, {}])(
    'rejects malformed deferred policy %p before dispatch',
    async (deferredToolsAllowed) => {
      const rec = recorder();
      const payload = {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      };
      Object.assign(payload, { deferredToolsAllowed });
      await handlePortalChatSetPluginSelections(
        {
          id: 'policy-save',
          sequence: 1,
          type: 'portal.chat.set_plugin_selections',
          payload,
          createdAt: '2026-10-12T00:00:00Z',
          expiresAt: null,
        },
        rec.context,
      );
      expect(mockedRequest).not.toHaveBeenCalled();
      expect(rec.fails[0]?.code).toBe('invalid_payload');
    },
  );

  it('normalizes and requests a plugins composer command (CAN-1219)', async () => {
    const rec = recorder();
    const command: PortalCommandEnvelope<
      PortalCommandPayloadMap['portal.chat.set_plugin_selections']
    > = {
      id: 'cmd-plugins',
      sequence: 1,
      type: 'portal.chat.set_plugin_selections',
      payload: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        selections: {
          // Legacy `bundleIds` are merged into `collectionIds` by
          // `normalizePluginSelections`, proving the wire shape is canonicalized.
          collectionIds: ['col-1'],
          bundleIds: ['col-2'],
          skillRefs: [{ sourceId: 'src', skillName: 'skill' }],
          pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plugin' }],
          mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
        },
      },
      createdAt: '2026-07-12T00:00:00.000Z',
      expiresAt: null,
    };
    await handlePortalChatSetPluginSelections(command, rec.context);
    expectRequested({
      requestId: 'cmd-plugins',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        kind: 'plugins',
        selections: {
          collectionIds: ['col-1', 'col-2'],
          skillRefs: [{ sourceId: 'src', skillName: 'skill' }],
          pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plugin' }],
          mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
        },
      },
    });
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('fails a plugins command when the routing target is empty', async () => {
    const rec = recorder();
    const command: PortalCommandEnvelope<
      PortalCommandPayloadMap['portal.chat.set_plugin_selections']
    > = {
      id: 'cmd-plugins-bad',
      sequence: 1,
      type: 'portal.chat.set_plugin_selections',
      payload: {
        // Empty projectId trips the shared composer-setter routing guard.
        projectId: '',
        worktreeId: 'wt',
        chatId: 'chat',
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      },
      createdAt: '2026-07-12T00:00:00.000Z',
      expiresAt: null,
    };
    await handlePortalChatSetPluginSelections(command, rec.context);
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  // The Portal summary projects only the selection refs, never the chat's
  // MCP auth choices, so a Portal save that replaces the selection from that
  // projection must not erase them (CAN-3922).
  const authPreferences: NonNullable<
    ChatTabPluginSelections['mcpHttpAuthPreferences']
  > = [
    {
      target: { kind: 'standalone', serverId: 'srv', configId: 'cfg' },
      handler: 'provider',
    },
  ];

  function pluginsStateContext(savedTabId = 'chat'): {
    rec: ReturnType<typeof recorder>;
    command: jest.Mock<
      ReturnType<ChatStateCommandPort['command']>,
      Parameters<ChatStateCommandPort['command']>
    >;
    getState: jest.Mock<
      ReturnType<ChatStateCommandPort['getState']>,
      Parameters<ChatStateCommandPort['getState']>
    >;
  } {
    const rec = recorder();
    const command = jest.fn<
      ReturnType<ChatStateCommandPort['command']>,
      Parameters<ChatStateCommandPort['command']>
    >(() =>
      Promise.resolve({
        commandId: 'cmd-plugins',
        revision: 2,
        outcome: 'applied' as const,
      }),
    );
    const getState = jest.fn<
      ReturnType<ChatStateCommandPort['getState']>,
      Parameters<ChatStateCommandPort['getState']>
    >(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        projectId: 'ws',
        worktreeId: 'wt',
        revision: 1,
        tabsFile: {
          version: 1 as const,
          tabs: [
            {
              id: savedTabId,
              title: 'Chat',
              messages: [],
              createdAt: '2026-10-18T00:00:00.000Z',
              pluginSelections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
                mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
                mcpHttpAuthPreferences: authPreferences,
              },
            },
          ],
          activeTabId: 'chat',
        },
        archives: [],
        runtimeByChatId: {},
        queue: [],
      }),
    );
    rec.context.chatStatePort = {
      getState,
      command,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    return { rec, command, getState };
  }

  function pluginsCommand(
    selections: PortalCommandPayloadMap['portal.chat.set_plugin_selections']['selections'],
  ): PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.set_plugin_selections']
  > {
    return {
      id: 'cmd-plugins',
      sequence: 1,
      type: 'portal.chat.set_plugin_selections',
      payload: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        selections,
      },
      createdAt: '2026-10-18T00:00:00.000Z',
      expiresAt: null,
    };
  }

  it("keeps the chat's MCP auth choices when a Portal save leaves them out", async () => {
    const { rec, command } = pluginsStateContext();
    // The projected selection with one unrelated plugin turned on.
    await handlePortalChatSetPluginSelections(
      pluginsCommand({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plugin' }],
        mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
      }),
      rec.context,
    );
    expect(rec.fails).toHaveLength(0);
    // The canonical commit compares the read selections (covered with the
    // real writer in editor-adapter-canonical-selections.test.ts).
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat',
          patch: {
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plugin' }],
              mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
              mcpHttpAuthPreferences: authPreferences,
            },
          },
          expectedPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
            mcpHttpAuthPreferences: authPreferences,
          },
        },
      }),
    );
  });

  it('refuses a Portal save that leaves out MCP auth choices for a missing chat', async () => {
    const { rec, command } = pluginsStateContext('other-chat');
    await handlePortalChatSetPluginSelections(
      pluginsCommand({ collectionIds: [], skillRefs: [], pluginRefs: [] }),
      rec.context,
    );
    expect(command).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('not_found');
  });

  it('refuses an embedded-scope Portal save that leaves out MCP auth choices before reading chat state', async () => {
    const { rec, command, getState } = pluginsStateContext();
    const save = pluginsCommand({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    });
    await handlePortalChatSetPluginSelections(
      {
        ...save,
        payload: { ...save.payload, projectId: APP_ADVISOR_PROJECT_ID },
      },
      rec.context,
    );
    expect(getState).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(rec.fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message:
          'This embedded chat scope is not available through the portal.',
      }),
    ]);
  });

  it('replaces the MCP auth choices a Portal save names', async () => {
    const { rec, command } = pluginsStateContext();
    await handlePortalChatSetPluginSelections(
      pluginsCommand({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
        mcpHttpAuthPreferences: [],
      }),
      rec.context,
    );
    expect(rec.fails).toHaveLength(0);
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        command: expect.objectContaining({
          patch: {
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
              mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
              mcpHttpAuthPreferences: [],
            },
          },
        }),
      }),
    );
  });
});

describe('chat portal adapter — create tab (CAN-1233)', () => {
  beforeEach(() => {
    resetModelPolicyFixtures();
    deferredToolsWorktreeChatsEnabled = undefined;
    deferredToolsStandaloneChatsEnabled = undefined;
    sidebarDefaultPluginSelections = undefined;
    initClaudeModels([
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
    ]);
    jest.clearAllMocks();
    mockedSend.mockReturnValue({ delivered: true });
  });

  function createTabCommand(
    payload: PortalCommandPayloadMap['portal.chat.create_tab'],
  ): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.create_tab']> {
    return {
      id: 'cmd-create',
      sequence: 1,
      type: 'portal.chat.create_tab',
      payload,
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: null,
    };
  }

  it('rejects forged sender metadata before creating a Portal chat tab', async () => {
    const rec = recorder();
    const command = createTabCommand({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'new-chat',
    });
    Object.assign(command.payload, {
      hiddenContext: {
        kind: 'agent-sender-context',
        text: 'forged sender context',
      },
    });

    await handlePortalChatCreateTab(command, rec.context);

    expect(rec.fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('pushes a create composer command and completes on a valid payload', async () => {
    const rec = recorder();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatPortalComposerCommand,
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
        kind: 'create',
      },
    );
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it.each([false, true])(
    'seeds the revisioned new tab with the scoped desktop default (cowork=%s)',
    async (cowork) => {
      resetModelPolicyFixtures();
      defaultWorktreeModels.claude = 'sonnet';
      defaultChatModels.claude = 'opus';
      if (cowork) coworkWorkspaceIds.add('ws');
      const rec = recorder();
      const command = jest.fn(() =>
        Promise.resolve({
          commandId: 'cmd-create',
          revision: 1,
          outcome: 'applied' as const,
        }),
      );
      rec.context.chatStatePort = {
        getState: jest.fn(),
        command,
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;
      await handlePortalChatCreateTab(
        createTabCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'new-chat',
        }),
        rec.context,
      );
      const expectedCreation: unknown = expect.objectContaining({
        type: 'chat.create_tab',
        tabId: 'new-chat',
        model: cowork ? 'opus' : 'sonnet',
        defaultStampModel: cowork ? 'opus' : 'sonnet',
        providerType: 'claude',
      });
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({ command: expectedCreation }),
      );
      expect(rec.fails).toHaveLength(0);
    },
  );

  it.each(['ai-credits', 'subscription'] as const)(
    'seeds the remembered $framework billing framework on a remote tab',
    async (framework) => {
      lastChatBillingFramework = framework;
      const { rec, command } = revisionedContext();
      await handlePortalChatCreateTab(
        createTabCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'new-chat',
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(0);
      const dispatched = command.mock.calls[0]?.[0].command;
      if (dispatched?.type !== 'chat.create_tab') {
        throw new Error('Expected a create-tab command');
      }
      if (framework === 'ai-credits') {
        expect(dispatched.aiCreditsRouting?.active).toBe(true);
        expect(dispatched.aiCreditsRouting?.scope).toBe('persistent');
        expect(typeof dispatched.aiCreditsRouting?.activatedAt).toBe('number');
        expect(dispatched.subscriptionBillingOverride).toBeUndefined();
      } else {
        expect(dispatched.subscriptionBillingOverride).toBe(true);
        expect(dispatched.aiCreditsRouting).toBeUndefined();
      }
    },
  );

  it.each(['ai-credits', 'subscription'] as const)(
    'does not apply remembered %s billing to an OpenCode default',
    async (framework) => {
      lastChatBillingFramework = framework;
      defaultWorktreeModels.claude = 'opencode:fixture%2Fmodel';
      const { rec, command } = revisionedContext();
      await handlePortalChatCreateTab(
        createTabCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'new-chat',
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(0);
      const dispatched = command.mock.calls[0]?.[0].command;
      expect(dispatched).toMatchObject({
        type: 'chat.create_tab',
        providerType: 'opencode',
        model: 'opencode:fixture%2Fmodel',
      });
      if (dispatched?.type !== 'chat.create_tab')
        throw new Error('Expected create-tab');
      expect(dispatched.aiCreditsRouting).toBeUndefined();
      expect(dispatched.subscriptionBillingOverride).toBeUndefined();
    },
  );

  it('seeds a confirmed AI Credits lane even when the remembered framework is subscription', async () => {
    lastChatBillingFramework = 'subscription';
    resolvedDefaultLane = 'ai-credits';
    resolvedDefaultLaneProvisional = false;
    const { rec, command } = revisionedContext();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(rec.fails).toHaveLength(0);
    const dispatched = command.mock.calls[0]?.[0].command;
    if (dispatched?.type !== 'chat.create_tab') {
      throw new Error('Expected a create-tab command');
    }
    expect(dispatched.aiCreditsRouting?.active).toBe(true);
    expect(dispatched.aiCreditsRouting?.scope).toBe('persistent');
    expect(dispatched.subscriptionBillingOverride).toBeUndefined();
  });

  it('applies provider-level model configuration defaults to a remote tab', async () => {
    initCodexModels([{ id: 'gpt-5.2-codex', label: 'GPT 5.2 Codex' }]);
    resolvedDefaultProvider = 'codex';
    resolvedDefaultLane = 'codex-native';
    defaultWorktreeModels.codex = 'gpt-5.2-codex';
    providerModelConfigDefaults = { codex: { fastMode: true } };
    const { rec, command } = revisionedContext();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(rec.fails).toHaveLength(0);
    const dispatched = command.mock.calls[0]?.[0].command;
    if (dispatched?.type !== 'chat.create_tab') {
      throw new Error('Expected a create-tab command');
    }
    expect(dispatched.providerType).toBe('codex');
    // The seed is a canonical write: the exact speed with its derived boolean.
    expect(dispatched.modelConfig).toEqual({
      thinkingLevel: 'high',
      speed: 'fast',
      fastMode: true,
    });
  });

  it('does not silently create an uninitialized tab if preferences cannot be read', async () => {
    preferencesReadable = false;
    const rec = recorder();
    const command = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(),
      command,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(command).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('execution_failed');
  });

  type PortCommand = ChatStateCommandPort['command'];
  function revisionedContext(): {
    rec: ReturnType<typeof recorder>;
    command: jest.Mock<ReturnType<PortCommand>, Parameters<PortCommand>>;
  } {
    const rec = recorder();
    const command = jest.fn<ReturnType<PortCommand>, Parameters<PortCommand>>(
      () =>
        Promise.resolve({
          commandId: 'cmd-create',
          revision: 1,
          outcome: 'applied' as const,
        }),
    );
    rec.context.chatStatePort = {
      getState: jest.fn(),
      command,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    return { rec, command };
  }

  it('waits for canonical creation before acknowledging the attachment-capable paired Code path', async () => {
    const { rec, command } = revisionedContext();
    rec.context.canReadAssets = (): boolean => true;
    let applyCreation: (() => void) | undefined;
    command.mockImplementationOnce(
      () =>
        new Promise((resolveCreation) => {
          applyCreation = (): void =>
            resolveCreation({
              commandId: 'cmd-create',
              revision: 1,
              outcome: 'applied',
            });
        }),
    );
    const pending = handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(rec.completes).toEqual([]);
    expect(mockedSend).not.toHaveBeenCalled();
    if (!applyCreation)
      throw new Error('Canonical create command was not dispatched');
    applyCreation();
    await pending;
    expect(rec.completes).toHaveLength(1);
  });

  it('does not use renderer acknowledgement for attachment-capable paired Code creation without a canonical port', async () => {
    const rec = recorder();
    rec.context.canReadAssets = (): boolean => true;
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(mockedSend).not.toHaveBeenCalled();
    expect(rec.completes).toEqual([]);
    expect(rec.fails).toEqual([
      expect.objectContaining({ code: 'invalid_target' }),
    ]);
  });

  it('fails clearly instead of creating a modelless tab when no model is dispatchable', async () => {
    defaultWorktreeModels.claude = null;
    const { rec, command } = revisionedContext();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(command).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('invalid_payload');
    expect(rec.fails[0]?.message).toContain('billing source');
  });

  it('reports policy guidance when every lane is policy-blocked', async () => {
    defaultWorktreeModels.claude = null;
    missingDefaultLane = 'both';
    hasPolicyAllowedDefaultLane = false;
    const { rec, command } = revisionedContext();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(command).not.toHaveBeenCalled();
    expect(rec.fails[0]).toMatchObject({
      code: 'invalid_payload',
      message:
        'Your organization policy allows no model that can run a new chat.',
    });
  });

  it('keeps the resolved model when the registry cannot classify its provider yet', async () => {
    defaultWorktreeModels.claude = 'org-gateway/not-yet-hydrated';
    const { rec, command } = revisionedContext();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(rec.fails).toHaveLength(0);
    const expectedCreation: unknown = expect.objectContaining({
      type: 'chat.create_tab',
      tabId: 'new-chat',
      model: 'org-gateway/not-yet-hydrated',
    });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ command: expectedCreation }),
    );
    const dispatched = command.mock.calls[0]?.[0].command;
    expect(
      dispatched?.type === 'chat.create_tab'
        ? dispatched.providerType
        : 'not-a-create',
    ).toBeUndefined();
  });

  it('does not stamp the projected default while creating a remote tab', async () => {
    laneResolutionCalls.length = 0;
    const { rec } = revisionedContext();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(laneResolutionCalls).toEqual([
      { scope: 'worktree', stampProjection: false },
    ]);
  });

  it.each([
    { cowork: false, deferredKey: 'worktree' },
    { cowork: true, deferredKey: 'standalone' },
  ])(
    'seeds the deferred-tools default and leaves project default plugins inherited (cowork=$cowork)',
    async ({ cowork, deferredKey }) => {
      if (cowork) coworkWorkspaceIds.add('ws');
      sidebarDefaultPluginSelections = {
        collectionIds: ['col-1'],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'docs' }],
      };
      if (deferredKey === 'worktree') {
        deferredToolsWorktreeChatsEnabled = false;
        deferredToolsStandaloneChatsEnabled = true;
      } else {
        deferredToolsWorktreeChatsEnabled = true;
        deferredToolsStandaloneChatsEnabled = false;
      }
      const { rec, command } = revisionedContext();
      await handlePortalChatCreateTab(
        createTabCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'new-chat',
        }),
        rec.context,
      );
      expect(rec.fails).toHaveLength(0);
      const expectedCreation: unknown = expect.objectContaining({
        type: 'chat.create_tab',
        deferredToolsAllowed: false,
      });
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({ command: expectedCreation }),
      );
      const createdCommand: unknown = command.mock.calls[0]?.[0];
      expect(createdCommand).not.toHaveProperty('command.pluginSelections');
    },
  );

  it('rejects a create with a missing chatId without pushing to the window', async () => {
    const rec = recorder();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        // The browser must mint the chat id; an empty id is a malformed payload.
        chatId: '',
      }),
      rec.context,
    );
    expect(mockedSend).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('rejects a create with a malformed (path-traversal) chatId', async () => {
    const rec = recorder();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        // A non-empty but invalid id must be rejected by the validateId format
        // guard, since the id becomes a filesystem path segment downstream.
        chatId: '../evil',
      }),
      rec.context,
    );
    expect(mockedSend).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('fails when the renderer window cannot receive the create push', async () => {
    mockedSend.mockReturnValue({ delivered: false, reason: 'no_window' });
    const rec = recorder();
    await handlePortalChatCreateTab(
      createTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'new-chat',
      }),
      rec.context,
    );
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('execution_failed');
  });

  // A Portal `+` and that tab's close reach the desktop as two concurrent
  // commands. The renderer ignores a close for a chat it does not have yet,
  // so a close that overtook the create left the new chat alive.
  it('closes a chat only after its in-flight create is applied', async () => {
    const order: string[] = [];
    let created = false;
    let applyCreate: (() => void) | undefined;
    const tab = (id: string): PersistedChatTab => ({
      id,
      title: 'New Chat',
      messages: [],
      createdAt: '2026-07-14T00:00:00.000Z',
    });
    const rec = recorder();
    rec.context.chatStatePort = {
      // The revisioned close reads the tab list before closing, so it sees
      // the new tab only once the create has been applied.
      getState: jest.fn(() =>
        Promise.resolve({
          schemaVersion: 1 as const,
          projectId: 'ws',
          worktreeId: 'wt',
          revision: created ? 2 : 1,
          tabsFile: {
            version: 1 as const,
            tabs: created
              ? [tab('existing'), tab('new-chat')]
              : [tab('existing')],
            activeTabId: 'existing',
          },
          archives: [],
          runtimeByChatId: {},
          queue: [],
        }),
      ),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: jest.fn(
        (request: Parameters<ChatStateCommandPort['command']>[0]) => {
          if (request.command.type !== 'chat.create_tab') {
            order.push(request.command.type);
            return Promise.resolve({
              commandId: 'cmd-close',
              revision: 3,
              outcome: 'applied' as const,
            });
          }
          return new Promise<{
            commandId: string;
            revision: number;
            outcome: 'applied';
          }>((resolve) => {
            applyCreate = (): void => {
              created = true;
              order.push(request.command.type);
              resolve({
                commandId: 'cmd-create',
                revision: 2,
                outcome: 'applied',
              });
            };
          });
        },
      ),
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;
    const target = { projectId: 'ws', worktreeId: 'wt', chatId: 'new-chat' };

    const creating = handlePortalChatCreateTab(
      createTabCommand(target),
      rec.context,
    );
    const closing = handlePortalChatCloseTab(
      {
        id: 'cmd-close',
        sequence: 2,
        type: 'portal.chat.close_tab',
        payload: target,
        createdAt: '2026-07-14T00:00:00.000Z',
        expiresAt: null,
      },
      rec.context,
    );
    await waitForCondition(() => applyCreate !== undefined);
    applyCreate?.();
    await Promise.all([creating, closing]);

    expect(rec.fails).toEqual([]);
    expect(order).toEqual(['chat.create_tab', 'chat.close_tab']);
  });
});

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('condition was never met');
}

/**
 * Narrow a mocked IPC argument through a runtime check instead of a type
 * assertion: a wrong shape fails the test here rather than propagating as a
 * lie the assertions then trust.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushedPayload(value: unknown): Record<string, unknown> {
  // Narrowed by a type predicate, not an assertion: a wrong shape fails the
  // test here rather than propagating as a lie the assertions then trust.
  if (!isPlainRecord(value)) {
    throw new Error('pushed composer command is not an object');
  }
  return value;
}

describe('chat portal adapter — close tab', () => {
  beforeEach(() => {
    mockedSend.mockReset();
    mockedSend.mockReturnValue({ delivered: true });
  });

  function closeTabCommand(
    payload: PortalCommandPayloadMap['portal.chat.close_tab'],
  ): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.close_tab']> {
    return {
      id: 'cmd-close',
      sequence: 1,
      type: 'portal.chat.close_tab',
      payload,
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: null,
    };
  }

  it('pushes a close composer command and completes on a valid payload', async () => {
    const rec = recorder();
    await handlePortalChatCloseTab(
      closeTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
      }),
      rec.context,
    );
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatPortalComposerCommand,
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        kind: 'close',
      },
    );
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it.each([0, 2])(
    'revisioned close preserves a tab with %s persisted messages and replaces the last tab',
    async (messageCount) => {
      const rec = recorder();
      const revisionedCommand = jest.fn(() =>
        Promise.resolve({
          commandId: 'cmd-close',
          revision: 3,
          outcome: 'applied' as const,
        }),
      );
      rec.context.chatStatePort = {
        getState: jest.fn(() =>
          Promise.resolve({
            schemaVersion: 1 as const,
            projectId: 'ws',
            worktreeId: 'wt',
            revision: 2,
            tabsFile: {
              version: 1 as const,
              tabs: [
                {
                  id: 'chat-1',
                  title: 'Empty',
                  messages: [],
                  transcriptLoaded: false,
                  transcript: {
                    format: 'complete-message-jsonl-v1' as const,
                    committedMessageCount: messageCount,
                    committedByteLength: messageCount * 100,
                    transcriptRevision: 1,
                    hasActiveSidecar: false,
                    messageCount,
                  },
                  createdAt: '2026-07-14T00:00:00.000Z',
                },
              ],
              activeTabId: 'chat-1',
            },
            archives: [],
            runtimeByChatId: {},
            queue: [],
          }),
        ),
        getTranscriptPage: jest.fn(),
        readToolOutput: jest.fn(),
        command: revisionedCommand,
        subscribe: (): (() => void) => (): void => {},
      } satisfies ChatStateCommandPort;
      const routedCommand = jest.fn(() =>
        Promise.resolve({
          commandId: 'cmd-close',
          revision: 3,
          outcome: 'applied' as const,
        }),
      );
      if (messageCount > 0) {
        rec.context.dispatchChatCommand = routedCommand;
      }

      await handlePortalChatCloseTab(
        closeTabCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat-1',
        }),
        rec.context,
      );

      expect(
        messageCount > 0 ? routedCommand : revisionedCommand,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRevision: 2,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          command: expect.objectContaining({
            type: 'chat.close_tab',
            tabId: 'chat-1',
            mode: messageCount > 0 ? 'archive' : 'discard_empty',
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            replacementTabId: expect.any(String),
          }),
        }),
      );
      expect(
        messageCount > 0 ? routedCommand : revisionedCommand,
      ).toHaveBeenCalledTimes(1);
      expect(
        messageCount > 0 ? revisionedCommand : routedCommand,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'streaming',
      runtimeByChatId: {
        'chat-1': { status: 'streaming' as const, queuedMessageIds: [] },
      },
      queue: [],
    },
    {
      name: 'queued work',
      runtimeByChatId: {
        'chat-1': { status: 'queued' as const, queuedMessageIds: ['queued-1'] },
      },
      queue: [
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat-1',
          queue: [{ id: 'queued-1', text: 'wait' }],
        },
      ],
    },
  ])('rejects a revisioned close during $name', async (activity) => {
    const rec = recorder();
    const revisionedCommand = jest.fn();
    rec.context.chatStatePort = {
      getState: jest.fn(() =>
        Promise.resolve({
          schemaVersion: 1 as const,
          projectId: 'ws',
          worktreeId: 'wt',
          revision: 2,
          tabsFile: {
            version: 1 as const,
            revision: 2,
            tabs: [
              {
                id: 'chat-1',
                title: 'Active',
                messages: [],
                createdAt: '2026-07-14T00:00:00.000Z',
              },
            ],
            activeTabId: 'chat-1',
          },
          archives: [],
          runtimeByChatId: activity.runtimeByChatId,
          queue: activity.queue,
        }),
      ),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: revisionedCommand,
      subscribe: (): (() => void) => (): void => {},
    } satisfies ChatStateCommandPort;

    await handlePortalChatCloseTab(
      closeTabCommand({ projectId: 'ws', worktreeId: 'wt', chatId: 'chat-1' }),
      rec.context,
    );

    expect(revisionedCommand).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('conflict');
  });

  it.each([
    { name: 'revisioned', withPort: true },
    { name: 'renderer', withPort: false },
  ])(
    'rejects a $name close while the chat has live delegates',
    async ({ withPort }) => {
      const rec = recorder();
      const revisionedCommand = jest.fn();
      const getState = jest.fn();
      if (withPort)
        rec.context.chatStatePort = {
          getState,
          getTranscriptPage: jest.fn(),
          readToolOutput: jest.fn(),
          command: revisionedCommand,
          subscribe: (): (() => void) => (): void => {},
        } satisfies ChatStateCommandPort;
      setDelegationActivity('portal-close-owner', 'ws/wt/chat-1', 0, 1);
      try {
        await handlePortalChatCloseTab(
          closeTabCommand({
            projectId: 'ws',
            worktreeId: 'wt',
            chatId: 'chat-1',
          }),
          rec.context,
        );
      } finally {
        setDelegationActivity('portal-close-owner', 'ws/wt/chat-1', 0);
      }

      expect(revisionedCommand).not.toHaveBeenCalled();
      expect(mockedSend).not.toHaveBeenCalled();
      expect(rec.completes).toHaveLength(0);
      expect(rec.fails[0]).toMatchObject({
        code: 'conflict',
        message: 'Delegates are still running in this chat. Stop them first.',
      });
    },
  );

  it('rejects a close with a missing chatId without pushing to the window', async () => {
    const rec = recorder();
    await handlePortalChatCloseTab(
      closeTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: '',
      }),
      rec.context,
    );
    expect(mockedSend).not.toHaveBeenCalled();
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('fails when the renderer window cannot receive the close push', async () => {
    mockedSend.mockReturnValue({ delivered: false, reason: 'no_window' });
    const rec = recorder();
    await handlePortalChatCloseTab(
      closeTabCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
      }),
      rec.context,
    );
    expect(rec.completes).toHaveLength(0);
    expect(rec.fails[0]?.code).toBe('execution_failed');
  });
});

describe('chat portal adapter — fork', () => {
  beforeEach(() => {
    mockedSend.mockReset();
    mockedSend.mockReturnValue({ delivered: true });
  });

  function forkCommand(
    payload: PortalCommandPayloadMap['portal.chat.fork'],
  ): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.fork']> {
    return {
      id: 'cmd-fork',
      sequence: 1,
      type: 'portal.chat.fork',
      payload,
      createdAt: '2026-08-28T00:00:00.000Z',
      expiresAt: null,
    };
  }

  it('pushes a fork composer command carrying the fork point', async () => {
    const rec = recorder();
    await handlePortalChatFork(
      forkCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        forkAfterUserMessageId: 'msg-7',
      }),
      rec.context,
    );
    expect(mockedSend).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatPortalComposerCommand,
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        kind: 'fork',
        forkAfterUserMessageId: 'msg-7',
      },
    );
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('omits the fork point entirely when absent, forking the whole chat', async () => {
    // The key must be ABSENT rather than undefined: the renderer forwards the
    // options object to `forkTab`, where an explicit undefined is not the same
    // as omitting the slice point.
    const rec = recorder();
    await handlePortalChatFork(
      forkCommand({ projectId: 'ws', worktreeId: 'wt', chatId: 'chat-1' }),
      rec.context,
    );
    // `toHaveBeenCalledWith` treats a MISSING key and an `undefined` key as
    // equal, so it cannot express this. Assert on the key set directly.
    const pushed = pushedPayload(mockedSend.mock.calls[0]?.[2]);
    expect(Object.keys(pushed).sort()).toStrictEqual([
      'chatId',
      'kind',
      'projectId',
      'worktreeId',
    ]);
    expect(pushed).toStrictEqual({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat-1',
      kind: 'fork',
    });
    expect(rec.completes).toHaveLength(1);
  });

  it('rejects a non-string fork point without pushing to the window', async () => {
    const rec = recorder();
    // A raw envelope with a wire-invalid payload: the handler is typed to
    // accept `unknown` because IT is the validation boundary, so no cast is
    // needed to exercise rejection.
    const invalid: PortalCommandEnvelope<unknown> = {
      id: 'cmd-fork',
      sequence: 1,
      type: 'portal.chat.fork',
      payload: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        forkAfterUserMessageId: 42,
      },
      createdAt: '2026-08-28T00:00:00.000Z',
      expiresAt: null,
    };
    await handlePortalChatFork(invalid, rec.context);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });
});

describe('chat portal adapter — branch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRequest.mockImplementation(({ requestId }) =>
      Promise.resolve({ requestId, ok: true }),
    );
  });

  function branchCommand(
    payload: PortalCommandPayloadMap['portal.chat.branch'],
  ): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.branch']> {
    return {
      id: 'cmd-branch',
      sequence: 1,
      type: 'portal.chat.branch',
      payload,
      createdAt: '2026-08-29T00:00:00.000Z',
      expiresAt: null,
    };
  }

  it('requests a branch command carrying the branch point', async () => {
    const rec = recorder();
    await handlePortalChatBranch(
      branchCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        forkAfterUserMessageId: 'msg-7',
      }),
      rec.context,
    );
    expectRequested({
      requestId: 'cmd-branch',
      command: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        kind: 'branch',
        forkAfterUserMessageId: 'msg-7',
      },
    });
    expect(rec.completes).toHaveLength(1);
    expect(rec.fails).toHaveLength(0);
  });

  it('omits the branch point entirely when absent', async () => {
    // The key must be ABSENT rather than undefined because the renderer
    // forwards the options object verbatim to `branchTab`.
    const rec = recorder();
    await handlePortalChatBranch(
      branchCommand({ projectId: 'ws', worktreeId: 'wt', chatId: 'chat-1' }),
      rec.context,
    );
    // `toHaveBeenCalledWith` treats a MISSING key and an `undefined` key as
    // equal, so it cannot express this. Assert on the key set directly.
    const requested = mockedRequest.mock.calls[0]?.[0].command;
    expect(Object.keys(requested).sort()).toStrictEqual([
      'chatId',
      'kind',
      'projectId',
      'worktreeId',
    ]);
    expect(requested).toStrictEqual({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat-1',
      kind: 'branch',
    });
    expect(rec.completes).toHaveLength(1);
  });

  it('rejects a non-string branch point without requesting the renderer', async () => {
    const rec = recorder();
    // A raw envelope with a wire-invalid payload: the handler is typed to
    // accept `unknown` because IT is the validation boundary, so no cast is
    // needed to exercise rejection.
    const invalid: PortalCommandEnvelope<unknown> = {
      id: 'cmd-branch',
      sequence: 1,
      type: 'portal.chat.branch',
      payload: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        forkAfterUserMessageId: 42,
      },
      createdAt: '2026-08-28T00:00:00.000Z',
      expiresAt: null,
    };
    await handlePortalChatBranch(invalid, rec.context);
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });
});

describe('chat portal adapter — share', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRequest.mockImplementation(({ requestId }) =>
      Promise.resolve({
        requestId,
        ok: true,
        data: { shareUrl: 'https://cloud.example.test/runs/run-1' },
      }),
    );
  });

  function shareCommand(
    payload: PortalCommandPayloadMap['portal.chat.share'],
  ): PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.share']> {
    return {
      id: 'cmd-share',
      sequence: 1,
      type: 'portal.chat.share',
      payload,
      createdAt: '2026-08-30T00:00:00.000Z',
      expiresAt: null,
    };
  }

  it('requests a share command carrying its scope and audience', async () => {
    const rec = recorder();
    await handlePortalChatShare(
      shareCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        shareScope: 'team',
        teamId: 'team-1',
      }),
      rec.context,
    );
    const requested = mockedRequest.mock.calls[0]?.[0].command;
    expect(Object.keys(requested).sort()).toStrictEqual([
      'chatId',
      'kind',
      'projectId',
      'shareScope',
      'teamId',
      'worktreeId',
    ]);
    expect(requested).toStrictEqual({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat-1',
      kind: 'share',
      shareScope: 'team',
      teamId: 'team-1',
    });
  });

  it('rejects an invalid share scope without requesting the renderer', async () => {
    const rec = recorder();
    const invalid: PortalCommandEnvelope<unknown> = {
      id: 'cmd-share',
      sequence: 1,
      type: 'portal.chat.share',
      payload: {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        shareScope: 'public',
      },
      createdAt: '2026-08-30T00:00:00.000Z',
      expiresAt: null,
    };
    await handlePortalChatShare(invalid, rec.context);
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(rec.fails[0]?.code).toBe('invalid_payload');
  });

  it('completes with the correlated share URL', async () => {
    const rec = recorder();
    await handlePortalChatShare(
      shareCommand({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat-1',
        shareScope: 'private',
      }),
      rec.context,
    );
    expect(rec.completes).toStrictEqual([
      {
        commandId: 'cmd-share',
        result: {
          ok: true,
          shareUrl: 'https://cloud.example.test/runs/run-1',
        },
      },
    ]);
  });

  it.each([
    ['team', 'teamId'],
    ['organization', 'organizationId'],
  ] as const)(
    'rejects a %s share without its %s before requesting the renderer',
    async (shareScope, targetField) => {
      const rec = recorder();
      await handlePortalChatShare(
        shareCommand({
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat-1',
          shareScope,
        }),
        rec.context,
      );

      expect(mockedRequest).not.toHaveBeenCalled();
      expect(rec.fails[0]?.code).toBe('invalid_payload');
      expect(rec.fails[0]?.message).toContain(targetField);
    },
  );
});

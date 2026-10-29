import { readFile } from 'node:fs/promises';

const mockPinInheritingAgentToDestination = jest.fn(
  (model: string): Promise<string> => {
    if (model === 'agent_model_inherit')
      return Promise.resolve('agent_model_inherit@gpt-5.5');
    if (model.startsWith('agent_model_pinned@'))
      return Promise.reject(
        new Error('Agent "agent_model_pinned" has its own base model.'),
      );
    return Promise.resolve(model);
  },
);
jest.mock('../../agents/agent-default-model', () => ({
  pinInheritingAgentToDestination: (model: string): Promise<string> =>
    mockPinInheritingAgentToDestination(model),
  resolveCatalogAgentDefaultModel: (projectId: string): Promise<string> =>
    Promise.resolve(`default-for-${projectId}`),
  resolveSendModelPin: async (
    _projectId: string,
    stored: string | undefined,
    requested: string | undefined,
  ): Promise<string | undefined> => {
    const selected = requested ?? stored;
    if (selected === undefined) return undefined;
    const pinned = await mockPinInheritingAgentToDestination(selected);
    return pinned === selected ? undefined : pinned;
  },
}));
import type * as FsPromises from 'node:fs/promises';
import type * as CoworkWorkEntries from '../../lib/cowork-work-entries';
import { getWorkspaceWorkEntriesFilePath } from '../../lib/paths';

const mockCancelChatTurn = jest.fn(() => Promise.resolve());
const mockQueueTerminal = jest.fn();
jest.mock('../../lib/chat-turn-cancel', () => ({
  cancelChatTurn: mockCancelChatTurn,
}));
const mockQueueSubmit = jest.fn(() => Promise.resolve());
const mockGetSession = jest.fn();
const mockGetActiveSessionInfos = jest.fn<
  Array<{ chatId: string; turnActive: boolean }>,
  [string, string]
>(() => []);
const mockGetSessionSelectedModel = jest.fn<
  string | undefined,
  [string, string, string]
>(() => undefined);
const mockGetSessionProviderType = jest.fn<
  string | undefined,
  [string, string, string]
>(() => undefined);
const mockGetWorktreeSnapshots = jest.fn(() => []);
const mockQueueIsTurnActive = jest.fn(() => false);
jest.mock('../chat-queue-service', () => ({
  getChatQueueService: (): {
    submit: typeof mockQueueSubmit;
    onTurnTerminal: typeof mockQueueTerminal;
    isTurnActive: () => boolean;
    getWorktreeSnapshots: typeof mockGetWorktreeSnapshots;
  } => ({
    submit: mockQueueSubmit,
    onTurnTerminal: mockQueueTerminal,
    isTurnActive: mockQueueIsTurnActive,
    getWorktreeSnapshots: mockGetWorktreeSnapshots,
  }),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
  getActiveSessionInfos: mockGetActiveSessionInfos,
  getSession: mockGetSession,
  getSessionSelectedModel: mockGetSessionSelectedModel,
  getSessionProviderType: mockGetSessionProviderType,
}));
jest.mock('../../lib/validation', () => ({
  validateId: jest.fn((value: string, field: string): void => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      throw new Error(`Invalid ${field}`);
    }
  }),
}));
jest.mock('../../lib/cowork-workspace-crud', () => ({
  listCoworkWorkspacesAsChatProjects: jest.fn(),
}));
jest.mock('../../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn((id: string) => id),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn(),
  listWorkEntryChatSummaries: jest.fn(),
  resolveWorkEntryForChat: jest.fn(),
  createWorkEntry: jest.fn(),
}));
jest.mock('../../lib/chat-archives', () => ({
  readChatArchivesFile: jest.fn(),
}));
jest.mock('../../lib/standalone-history-index', () => ({
  listHistoryChatIds: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    eventId: 'event-1',
    clientEventId: 'event-1',
    occurredAt: '2026-05-08T00:00:00.000Z',
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));
jest.mock('../../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: jest.fn(),
  scheduleChatSummary: jest.fn(),
}));
const ingestProviderEventMock = jest.fn<Promise<void>, [input?: unknown]>(() =>
  Promise.resolve(),
);
const chatStateCommandMock = jest.fn<
  Promise<Pick<ChatCommandResult, 'outcome' | 'reason'>>,
  [ChatCommandEnvelope]
>(() => Promise.resolve({ outcome: 'applied' }));
const runWithScopeActivityMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
jest.mock('../chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    ingestProviderEvent: ingestProviderEventMock,
    command: chatStateCommandMock,
    // Mirrors the void commit mock: provider events report no commit.
    ingestProviderEventWithOutcome: async (
      input: unknown,
    ): Promise<ProviderEventIngestOutcome> => {
      await ingestProviderEventMock(input);
      return 'not-applied';
    },
    runWithScopeActivity: runWithScopeActivityMock,
  })),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    handleCanonicalChatStartedEvent: jest.fn(),
  })),
}));
const mockReadPreferencesFile = jest.fn();
jest.mock('../../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: mockReadPreferencesFile,
}));
let concreteModelDispatchability: 'dispatchable' | 'no-billing-lane' =
  'dispatchable';
jest.mock('../../lib/default-model-lane-resolver', () => ({
  getLastProjectedDefaultModel: (): undefined => undefined,
  GLOBAL_LANE_CREDENTIAL_SCOPE: { workspaceId: null },
  // Fails OPEN, mirroring the real helper on an unknown model/probe: these
  // specs exercise harness derivation and policy, not the billing dead end.
  // The dead-end path has its own spec that overrides this.
  resolveConcreteModelDispatchability: (): Promise<string> =>
    Promise.resolve(concreteModelDispatchability ?? 'dispatchable'),
  resolveLaneAwareDefaultSelection: (
    preferences: Record<string, unknown>,
    scope: 'chat' | 'worktree',
    _credentialScope: unknown,
    preferredProvider?: 'claude' | 'codex' | 'ollama',
  ): Promise<unknown> => {
    const defaults = preferences[
      scope === 'chat'
        ? 'defaultChatModelByProvider'
        : 'defaultWorktreeModelByProvider'
    ] as
      | Record<string, { model: string; thinkingLevel: string } | null>
      | undefined;
    const provider =
      preferredProvider ??
      (preferences[
        scope === 'chat' ? 'defaultChatProvider' : 'defaultWorktreeProvider'
      ] as string | undefined) ??
      'claude';
    const selection = defaults?.[provider] ?? defaults?.claude;
    return Promise.resolve(
      selection && typeof selection.model === 'string'
        ? {
            outcome: 'resolved' as const,
            lane: `${provider}-native`,
            selection,
          }
        : {
            outcome: 'no-dispatchable-model' as const,
            missing: 'billing-lane' as const,
            lanesNeeded: [],
          },
    );
  },
}));
jest.mock('../../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: jest.fn(),
  cancelTransientRetriesForChatId: jest.fn(),
  cancelTransientRetriesForWorkspaceChat: jest.fn(),
}));
jest.mock('../../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: jest.fn(),
}));
jest.mock('../../lib/usage-limited-chats-registry', () => ({
  clearUsageLimitedChat: jest.fn(),
}));
const blockedModelIds = new Set<string>();
const mockIsModelBlockedByStoredPolicy = jest.fn(
  (model?: string, owner?: WorkOwner): Promise<boolean> => {
    void owner;
    return Promise.resolve(model !== undefined && blockedModelIds.has(model));
  },
);
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    model?: string,
    owner?: WorkOwner,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(model, owner),
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    Promise.resolve(blockedModelIds.size > 0),
  // Sync variant, still used by the catalog projection this service builds
  // summaries with.
  isModelBlockedByCurrentPolicy: (model?: string): boolean =>
    model !== undefined && blockedModelIds.has(model),
}));
const mockResolveAiCreditsScopeOwner = jest.fn<
  Promise<WorkOwner | undefined>,
  [unknown]
>(() => Promise.resolve({ kind: 'personal' }));
const mockBuildScopeOwner = jest.fn<Promise<WorkOwner | undefined>, [unknown]>(
  () => Promise.resolve({ kind: 'personal' }),
);
const mockCreateAiCreditsScopeOwnerResolver = jest.fn(
  () =>
    (input: unknown): Promise<WorkOwner | undefined> =>
      mockBuildScopeOwner(input),
);
jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (
    input: unknown,
  ): Promise<WorkOwner | undefined> => mockResolveAiCreditsScopeOwner(input),
  createAiCreditsScopeOwnerResolver: (): ((
    input: unknown,
  ) => Promise<WorkOwner | undefined>) =>
    mockCreateAiCreditsScopeOwnerResolver(),
}));
type ModelGatewayRouteCheck =
  | { ok: true; orgRoute: boolean }
  | { ok: false; message: string };
const mockCheckModelGatewayRoute = jest.fn<
  Promise<ModelGatewayRouteCheck>,
  [string | undefined, WorkOwner | undefined]
>(() => Promise.resolve({ ok: true, orgRoute: false }));
jest.mock('../../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: (
    model: string | undefined,
    owner: WorkOwner | undefined,
  ): Promise<ModelGatewayRouteCheck> =>
    mockCheckModelGatewayRoute(model, owner),
}));
const mockIsCursorRuntimeAvailable = jest.fn(() => Promise.resolve(false));
jest.mock('../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> =>
    mockIsCursorRuntimeAvailable(),
}));
const mockBuildProjectedModelCatalog = jest.fn<unknown[], unknown[]>(() => []);
jest.mock('../../portal/model-catalog-projection', () => ({
  buildProjectedModelCatalog: (...args: unknown[]): unknown[] =>
    mockBuildProjectedModelCatalog(...args),
}));
const mockPeekPortalProviderAvailability = jest.fn(() => ({
  ollama: true,
  cursor: true,
}));
jest.mock('../../auth/provider-auth-state', () => ({
  peekPortalProviderAvailability: (): ReturnType<
    typeof mockPeekPortalProviderAvailability
  > => mockPeekPortalProviderAvailability(),
  peekProviderNativeAuthAvailability: (): { ollama: boolean } => ({
    ollama: true,
  }),
}));

import {
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  IPC_CHANNELS,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  type AgentModelConfig,
  type ChatCommandEnvelope,
  type ChatCommandResult,
  type ChatTabsFile,
  type PersistedChatTab,
  type ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import type { ProviderEventIngestOutcome } from '../chat-state-service';
import { readChatTabsFile } from '../../lib/chat-tabs-reader';
import { writeChatTabsFile } from '../../lib/chat-tabs';
import { enqueueChatTabMutation } from '../../lib/chat-tab-mutation-queue';
import { sendToWindow } from '../../lib/window-send';
import { getActiveChatIds } from '../../agents/session-manager';
import {
  dispatchWorktreeChatTurn,
  scheduleChatSummary,
} from '../../lib/worktree-chat-turn';
import { enqueuePortalEvent } from '../../portal/portal-event-bus';
import { listCoworkWorkspacesAsChatProjects } from '../../lib/cowork-workspace-crud';
import {
  createWorkEntry,
  listWorkEntryChatSummaries,
  listWorkEntryIds,
  resolveWorkEntryForChat,
} from '../../lib/cowork-work-entries';
import { readChatArchivesFile } from '../../lib/chat-archives';
import { listHistoryChatIds } from '../../lib/standalone-history-index';
import {
  cancelTransientRetriesForChatId,
  cancelTransientRetriesForWorkspaceChat,
  cancelTransientRetryForChat,
} from '../../lib/transient-error-retry-service';
import { resolvePersistedApprovalMode } from '../../lib/approval-mode-resolution';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../../approvals/live-approval-modes';
import { clearUsageLimitedChat } from '../../lib/usage-limited-chats-registry';
import {
  createStandaloneChatTab,
  cancelStandaloneChat,
  listStandaloneChats,
  emitStandaloneChatSummary,
  emitStandaloneChatSummaryForTab,
  emitStandaloneWorkEntrySummary,
  emitStandaloneWorkspaceWorkEntrySummaries,
  listStandaloneChatTranscript,
  projectStandaloneChatSnapshot,
  resolveStandaloneChatPolicyModels,
  sendStandaloneChatMessage,
  setStandaloneChatModel,
  withStandalonePendingQuestions,
} from '../standalone-chat-service';

const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedWriteChatTabsFile = jest.mocked(writeChatTabsFile);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedGetActiveChatIds = jest.mocked(getActiveChatIds);
const mockedDispatchWorktreeChatTurn = jest.mocked(dispatchWorktreeChatTurn);
const mockedScheduleChatSummary = jest.mocked(scheduleChatSummary);
const mockedEnqueuePortalEvent = jest.mocked(enqueuePortalEvent);
const mockedListProjects = jest.mocked(listCoworkWorkspacesAsChatProjects);
const mockedListWorkEntryIds = jest.mocked(listWorkEntryIds);
const mockedListWorkEntryChatSummaries = jest.mocked(
  listWorkEntryChatSummaries,
);
const mockedResolveWorkEntryForChat = jest.mocked(resolveWorkEntryForChat);
const mockedCreateWorkEntry = jest.mocked(createWorkEntry);
const mockedReadChatArchivesFile = jest.mocked(readChatArchivesFile);
const mockedListHistoryChatIds = jest.mocked(listHistoryChatIds);
const mockedCancelTransientRetryForChat = jest.mocked(
  cancelTransientRetryForChat,
);
const mockedCancelTransientRetriesForWorkspaceChat = jest.mocked(
  cancelTransientRetriesForWorkspaceChat,
);
const mockedCancelTransientRetriesForChatId = jest.mocked(
  cancelTransientRetriesForChatId,
);
const mockedResolvePersistedApprovalMode = jest.mocked(
  resolvePersistedApprovalMode,
);
const mockedClearUsageLimitedChat = jest.mocked(clearUsageLimitedChat);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emittedStandaloneActiveStates(): boolean[] {
  const activeStates: boolean[] = [];
  for (const [event] of mockedEnqueuePortalEvent.mock.calls) {
    const payload: unknown = event.payload;
    if (
      event.type !== 'portal.state.delta' ||
      !isRecord(payload) ||
      !Array.isArray(payload.entities)
    ) {
      continue;
    }
    for (const entity of payload.entities) {
      if (!isRecord(entity) || !isRecord(entity.payload)) {
        continue;
      }
      const hasActiveChat = entity.payload.hasActiveChat;
      if (typeof hasActiveChat === 'boolean') {
        activeStates.push(hasActiveChat);
      }
    }
  }
  return activeStates;
}

function chatTab(input: {
  id: string;
  title: string;
  text: string;
  timestamp: number;
  deferredToolsAllowed?: boolean;
  approvalMode?: PersistedChatTab['approvalMode'];
  sessionApprovalRules?: PersistedChatTab['sessionApprovalRules'];
  unread?: boolean;
}): PersistedChatTab {
  return {
    id: input.id,
    title: input.title,
    createdAt: new Date(input.timestamp).toISOString(),
    kind: 'chat',
    unread: input.unread,
    ...(typeof input.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: input.deferredToolsAllowed }
      : {}),
    ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
    ...(input.sessionApprovalRules
      ? { sessionApprovalRules: input.sessionApprovalRules }
      : {}),
    messages: [
      {
        id: `${input.id}-message`,
        role: 'user',
        timestamp: input.timestamp,
        blocks: [{ type: 'text', text: input.text }],
      },
    ],
  };
}

function chatTabsFile(tabs: PersistedChatTab[]): ChatTabsFile {
  return {
    version: 1,
    tabs,
    activeTabId: tabs[0]?.id ?? '',
  };
}

/**
 * Fixture model: two cowork workspaces, each with one work entry holding one
 * chat. The `shared-chat` id exists in BOTH workspaces (the id-collision
 * routing case).
 */
function mockWorkspaceFixtures(): void {
  mockedListProjects.mockResolvedValue([
    {
      id: 'cowork-default',
      name: 'Default',
      createdAt: '2026-05-08T00:00:00.000Z',
    },
    { id: 'research', name: 'Research', createdAt: '2026-05-08T00:00:00.000Z' },
  ]);
  mockedListWorkEntryIds.mockImplementation(
    (workspaceId: string): Promise<string[]> =>
      Promise.resolve(workspaceId === 'research' ? ['entry-r'] : ['entry-d']),
  );
  mockedListWorkEntryChatSummaries.mockImplementation((workspaceId: string) =>
    Promise.resolve([
      {
        entryId: workspaceId === 'research' ? 'entry-r' : 'entry-d',
        title: 'Explicit entry rename',
        ...(workspaceId === 'research'
          ? {
              order: 2,
              pinned: true,
              status: 'done',
              createdAt: new Date(5).toISOString(),
              lastMessageAt: new Date(20).toISOString(),
              lastTouchedAt: new Date(30).toISOString(),
            }
          : { order: 0, createdAt: new Date(1).toISOString() }),
        chats: [
          {
            id: 'shared-chat',
            title:
              workspaceId === 'research' ? 'Research Chat' : 'Default Chat',
            ...(workspaceId === 'research' ? { customTitle: 'My chat' } : {}),
            createdAt: new Date(
              workspaceId === 'research' ? 20 : 10,
            ).toISOString(),
            lastMessageAt: new Date(
              workspaceId === 'research' ? 20 : 10,
            ).toISOString(),
            executionHarness: workspaceId === 'research' ? 'codex' : 'claude',
            ...(workspaceId === 'research' ? { unread: true } : {}),
          },
        ],
      },
    ]),
  );
  mockedResolveWorkEntryForChat.mockImplementation(
    (workspaceId: string, chatId: string) => {
      if (chatId === 'shared-chat') {
        return Promise.resolve({
          entryId: workspaceId === 'research' ? 'entry-r' : 'entry-d',
          archivedInEntryId: null,
        });
      }
      if (chatId === 'research-only' && workspaceId === 'research') {
        return Promise.resolve({
          entryId: 'entry-r',
          archivedInEntryId: null,
        });
      }
      return Promise.resolve({ entryId: null, archivedInEntryId: null });
    },
  );
  mockedReadChatTabsFile.mockImplementation(
    (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> => {
      if (workspaceId === 'research' && worktreeId === 'entry-r') {
        return Promise.resolve(
          chatTabsFile([
            chatTab({
              id: 'shared-chat',
              title: 'Research Chat',
              text: 'Research message',
              timestamp: 20,
              unread: true,
            }),
          ]),
        );
      }
      if (workspaceId === 'cowork-default' && worktreeId === 'entry-d') {
        return Promise.resolve(
          chatTabsFile([
            chatTab({
              id: 'shared-chat',
              title: 'Default Chat',
              text: 'Default message',
              timestamp: 10,
            }),
          ]),
        );
      }
      return Promise.resolve(chatTabsFile([]));
    },
  );
}

describe('canonical standalone empty chat creation', () => {
  const canonicalCommand = jest.fn<
    ReturnType<ChatStateCommandPort['command']>,
    Parameters<ChatStateCommandPort['command']>
  >();
  const request = { projectLocalId: 'research', chatId: 'new-chat' };
  const options = {
    commandId: 'create-command',
    dispatchCommand: canonicalCommand,
    seed: { model: 'opus', defaultStampModel: 'opus' },
    canCreate: (): boolean => true,
  };
  let registry: typeof CoworkWorkEntries;

  beforeAll(() => {
    // A cold load of the real registry graph can exceed the default test
    // timeout, so it gets its own budget.
    registry = jest.requireActual<typeof CoworkWorkEntries>(
      '../../lib/cowork-work-entries',
    );
  }, 60_000);

  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceFixtures();
    mockedReadChatArchivesFile.mockResolvedValue({ version: 1, archived: [] });
    mockedListHistoryChatIds.mockResolvedValue([]);
    canonicalCommand.mockResolvedValue({
      commandId: 'create-command',
      revision: 1,
      outcome: 'applied',
    });
  });

  it('returns only durably acknowledged canonical identities without a message or provider turn', async () => {
    const result = await createStandaloneChatTab(request, options);
    expect(result).toEqual({
      ok: true,
      chatId: 'new-chat',
      projectLocalId: 'research',
      projectId: 'research',
      worktreeId: 'new-chat',
      workEntryId: 'new-chat',
    });
    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      'research',
      expect.objectContaining({ id: 'new-chat' }),
    );
    expect(mockedCreateWorkEntry.mock.calls[0]?.[1]).toHaveProperty(
      'assertCanCommit',
      expect.any(Function),
    );
    expect(canonicalCommand).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        commandId: 'create-command',
        projectId: 'research',
        worktreeId: 'new-chat',
        origin: 'portal',
        command: {
          type: 'chat.create_tab',
          tabId: 'new-chat',
          model: 'opus',
          defaultStampModel: 'opus',
        },
      },
      { canCommitCreate: options.canCreate },
    );
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    expect(mockQueueSubmit).not.toHaveBeenCalled();
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(ingestProviderEventMock).not.toHaveBeenCalled();
  });

  it('creates the founding entry in the requested sidebar group', async () => {
    await createStandaloneChatTab(
      { ...request, sidebarItemGroupId: 'grp-research' },
      options,
    );
    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      'research',
      expect.objectContaining({
        id: 'new-chat',
        sidebarItemGroupId: 'grp-research',
      }),
    );
  });

  it('keeps retries on the same founding entry with the same or a replacement command id', async () => {
    await createStandaloneChatTab(request, options);
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: 'new-chat',
      archivedInEntryId: null,
    });
    mockedListWorkEntryIds.mockResolvedValue(['new-chat']);
    canonicalCommand.mockResolvedValue({
      commandId: 'retry-command',
      revision: 1,
      outcome: 'already_applied',
    });
    await createStandaloneChatTab(request, options);
    await createStandaloneChatTab(request, {
      ...options,
      commandId: 'retry-command',
    });
    expect(mockedCreateWorkEntry).toHaveBeenCalledTimes(1);
    expect(
      canonicalCommand.mock.calls.map(([envelope]) => envelope.worktreeId),
    ).toEqual(['new-chat', 'new-chat', 'new-chat']);
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('preserves existing durable entries when the pairing is revoked during creation', async () => {
    const workspaceId = 'revocation-service';
    const original = {
      id: 'other-entry',
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    await registry.appendWorkEntryRows(workspaceId, [original]);
    const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const before = await readFile(filePath, 'utf8');
    mockedListProjects.mockResolvedValue([
      { id: workspaceId, name: 'Revocation', createdAt: original.createdAt },
    ]);
    mockedListWorkEntryIds.mockResolvedValue([original.id]);
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: null,
    });
    mockedCreateWorkEntry.mockImplementationOnce(registry.createWorkEntry);
    let authorized = true;
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const originalRename = fs.rename;
    const rename = jest
      .spyOn(fs, 'rename')
      .mockImplementationOnce(async (...args) => {
        await originalRename(...args);
        authorized = false;
      });
    try {
      await expect(
        createStandaloneChatTab(
          { projectLocalId: workspaceId, chatId: 'revoked-chat' },
          { ...options, canCreate: () => authorized },
        ),
      ).rejects.toMatchObject({ code: 'invalid_target' });
      expect(await readFile(filePath, 'utf8')).toBe(before);
      expect(canonicalCommand).not.toHaveBeenCalled();
      expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
    } finally {
      rename.mockRestore();
    }
  });

  it('refuses archived, nonexistent workspace, reused entry identifiers, and revoked consent before mutation', async () => {
    await expect(
      createStandaloneChatTab(request, { ...options, canCreate: () => false }),
    ).rejects.toThrow('authorized');
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: 'old-entry',
    });
    await expect(createStandaloneChatTab(request, options)).rejects.toThrow(
      'Archived',
    );
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: null,
    });
    await expect(
      createStandaloneChatTab(
        { ...request, projectLocalId: 'deleted' },
        options,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    mockedListWorkEntryIds.mockResolvedValue(['new-chat']);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        chatTab({
          id: 'other-chat',
          title: 'Other',
          timestamp: 1,
          text: 'private',
        }),
      ]),
    );
    await expect(createStandaloneChatTab(request, options)).rejects.toThrow(
      'another work entry',
    );
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(canonicalCommand).not.toHaveBeenCalled();
  });

  it('never acknowledges rejected canonical creation or expired authority after admission', async () => {
    canonicalCommand.mockResolvedValue({
      commandId: 'create-command',
      revision: 1,
      outcome: 'rejected',
      reason: 'Not writable',
    });
    await expect(createStandaloneChatTab(request, options)).rejects.toThrow(
      'Not writable',
    );
    jest.clearAllMocks();
    mockWorkspaceFixtures();
    let allowed = true;
    mockedListProjects.mockImplementationOnce(() => {
      allowed = false;
      return Promise.resolve([
        { id: 'research', name: 'Research', createdAt: '2026-10-01' },
      ]);
    });
    await expect(
      createStandaloneChatTab(request, {
        ...options,
        canCreate: () => allowed,
      }),
    ).rejects.toThrow('authorized');
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(canonicalCommand).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });
});

describe('standalone chat service portal routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatStateCommandMock.mockResolvedValue({ outcome: 'applied' });
    blockedModelIds.clear();
    mockResolveAiCreditsScopeOwner.mockResolvedValue({ kind: 'personal' });
    mockCheckModelGatewayRoute.mockResolvedValue({
      ok: true,
      orgRoute: false,
    });
    concreteModelDispatchability = 'dispatchable';
    mockedGetActiveChatIds.mockReturnValue([]);
    mockGetSession.mockReturnValue(undefined);
    mockGetSessionSelectedModel.mockReturnValue(undefined);
    mockGetSessionProviderType.mockReturnValue(undefined);
    mockGetWorktreeSnapshots.mockReturnValue([]);
    mockQueueIsTurnActive.mockReturnValue(false);
    mockWorkspaceFixtures();
    mockedWriteChatTabsFile.mockResolvedValue(undefined);
    mockedReadChatArchivesFile.mockResolvedValue({ version: 1, archived: [] });
    mockedListHistoryChatIds.mockResolvedValue([]);
    mockedDispatchWorktreeChatTurn.mockResolvedValue(undefined);
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
    mockedCreateWorkEntry.mockImplementation(
      (_workspaceId: string, options?: { id?: string }) =>
        Promise.resolve({
          entry: {
            id: options?.id ?? 'new-entry',
            title: 'New Chat',
            createdAt: '2026-05-08T00:00:00.000Z',
            chatCount: 0,
          },
          reusedExistingEmpty: false,
        }),
    );
    // Wire-faithful: a normalized preferences file always carries concrete
    // claude/codex defaults (only `ollama` is nullable), and the send path's
    // policy guard resolves through this map.
    mockReadPreferencesFile.mockResolvedValue({
      deferredToolsStandaloneChatsEnabled: true,
      defaultChatModelByProvider: {
        claude: { model: 'claude-default' },
        codex: { model: 'codex-default' },
        ollama: null,
      },
    });
    mockedResolvePersistedApprovalMode.mockImplementation(
      (_projectId, _worktreeId, tabMode) => Promise.resolve(tabMode ?? 'ask'),
    );
  });

  afterEach(() => {
    clearLiveApprovalMode('research', 'entry-r', 'shared-chat');
  });

  it('holds a busy Portal cowork follow-up in the host queue before transcript persistence', async () => {
    mockedGetActiveChatIds.mockReturnValue(['shared-chat']);
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Queued remotely',
      }),
    ).resolves.toEqual(expect.objectContaining({ delivery: 'queued' }));
    expect(mockQueueSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        text: 'Queued remotely',
      }),
      'portal',
    );
    expect(mockQueueSubmit.mock.calls[0]?.[0]).not.toHaveProperty('agentSent');
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('preserves trusted sender provenance when a standalone send is queued', async () => {
    const agentSent: AgentSentInfo = {
      kind: 'external_agent',
      connectionId: '123e4567-e89b-42d3-a456-426614174000',
      clientName: 'Web MCP Agent',
      verified: true,
      userId: '123e4567-e89b-42d3-a456-426614174001',
    };
    mockedGetActiveChatIds.mockReturnValue(['shared-chat']);

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Queued remotely',
      agentSent,
    });

    expect(mockQueueSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        text: 'Queued remotely',
        agentSent,
      }),
      'portal',
    );
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'portal.chat.event' }),
    );
  });

  it('pins an Agent that inherits the default before queueing a Portal cowork send', async () => {
    mockedGetActiveChatIds.mockReturnValue(['shared-chat']);
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Queued remotely',
      model: 'agent_model_inherit',
    });
    expect(mockPinInheritingAgentToDestination).toHaveBeenCalledWith(
      'agent_model_inherit',
    );
    expect(mockQueueSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'agent_model_inherit@gpt-5.5' }),
      'portal',
    );
  });

  describe('a chat that stores an Agent now on the default model', () => {
    // The chat picked the Agent while it had its own base model, so it stores
    // the bare Agent; the Agent has since switched to the default model.
    let persisted = chatTabsFile([]);

    beforeEach(() => {
      persisted = chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Agent chat',
            text: 'Earlier message',
            timestamp: 20,
          }),
          model: 'agent_model_inherit',
          providerType: 'claude',
        },
      ]);
      mockedReadChatTabsFile.mockImplementation(() =>
        Promise.resolve(persisted),
      );
      mockedWriteChatTabsFile.mockImplementation((_workspace, _entry, next) => {
        persisted = next;
        return Promise.resolve();
      });
    });

    it('pins it before saving a send that names no model', async () => {
      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'From mobile',
      });

      expect(persisted.tabs[0]?.model).toBe('agent_model_inherit@gpt-5.5');
      expect(mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0]?.model).toBe(
        'agent_model_inherit@gpt-5.5',
      );
    });

    it('pins it before queueing a send that names no model', async () => {
      mockedGetActiveChatIds.mockReturnValue(['shared-chat']);

      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'From mobile',
      });

      expect(mockQueueSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'agent_model_inherit@gpt-5.5' }),
        'portal',
      );
    });

    it('saves and queues nothing when the default is another Agent', async () => {
      mockPinInheritingAgentToDestination.mockRejectedValueOnce(
        new Error('the default model is an Agent'),
      );

      await expect(
        sendStandaloneChatMessage({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          message: 'From mobile',
        }),
      ).rejects.toThrow('the default model is an Agent');

      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
      expect(mockQueueSubmit).not.toHaveBeenCalled();
      expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    });
  });

  it('refuses a supplied route for a pinned Agent before persisting', async () => {
    initAgentModels([
      {
        id: 'agent_model_pinned',
        name: 'Pinned',
        baseModel: 'gpt-5.5',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-13T00:00:00.000Z',
        updatedAt: '2026-10-13T00:00:00.000Z',
        available: true,
      },
    ]);
    await expect(
      setStandaloneChatModel({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'agent_model_pinned@gpt-5.5',
      }),
    ).rejects.toThrow('has its own base model');
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    initAgentModels([]);
  });

  const codexSpeedConfigs: AgentModelConfig[] = [
    { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    { thinkingLevel: 'high', speed: 'fast', fastMode: true },
    { thinkingLevel: 'high', speed: 'ultrafast', fastMode: false },
  ];

  it.each(codexSpeedConfigs)(
    'preserves $speed on a thinking-only Portal cowork send',
    async (modelConfig) => {
      let persisted = chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Codex chat',
            text: 'Earlier message',
            timestamp: 20,
          }),
          model: 'codex-default',
          providerType: 'codex',
          executionHarness: 'codex',
          modelConfig,
        },
      ]);
      mockedReadChatTabsFile.mockImplementation(() =>
        Promise.resolve(persisted),
      );
      mockedWriteChatTabsFile.mockImplementation((_workspace, _entry, next) => {
        persisted = next;
        return Promise.resolve();
      });

      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Continue with medium reasoning',
        modelConfig: { thinkingLevel: 'medium' },
      });

      const expected: AgentModelConfig = {
        ...modelConfig,
        thinkingLevel: 'medium',
      };
      expect(persisted.tabs[0]?.modelConfig).toEqual(expected);
      expect(
        mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0]?.modelConfig,
      ).toEqual(expected);
    },
  );

  it.each(codexSpeedConfigs)(
    'preserves $speed on a queued thinking-only Portal cowork send',
    async (modelConfig) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            ...chatTab({
              id: 'shared-chat',
              title: 'Codex chat',
              text: 'Earlier message',
              timestamp: 20,
            }),
            model: 'codex-default',
            providerType: 'codex',
            executionHarness: 'codex',
            modelConfig,
          },
        ]),
      );
      mockedGetActiveChatIds.mockReturnValue(['shared-chat']);

      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Queue medium reasoning',
        modelConfig: { thinkingLevel: 'medium' },
      });

      const expected: AgentModelConfig = {
        ...modelConfig,
        thinkingLevel: 'medium',
      };
      expect(mockQueueSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ modelConfig: expected }),
        'portal',
      );
      expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    },
  );

  it('replaces saved Ultra with Regular on an explicit legacy cowork speed command', async () => {
    let persisted = chatTabsFile([
      {
        ...chatTab({
          id: 'shared-chat',
          title: 'Codex chat',
          text: 'Earlier message',
          timestamp: 20,
        }),
        model: 'codex-default',
        providerType: 'codex',
        executionHarness: 'codex',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteChatTabsFile.mockImplementation((_workspace, _entry, next) => {
      persisted = next;
      return Promise.resolve();
    });

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue at Regular',
      modelConfig: { fastMode: false },
    });

    const expected: AgentModelConfig = {
      thinkingLevel: 'high',
      speed: 'standard',
      fastMode: false,
    };
    expect(persisted.tabs[0]?.modelConfig).toEqual(expected);
    expect(
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0]?.modelConfig,
    ).toEqual(expected);
  });

  it('holds a pending steering follow-up in the host queue after the root settles', async () => {
    mockGetSession.mockReturnValue({
      hasPendingSteeringInput: (): boolean => true,
    });

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Queued while steering is pending',
    });

    expect(mockQueueSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Queued while steering is pending' }),
      'portal',
    );
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  const CURSOR_CONNECT_MESSAGE =
    'Connect Cursor in Settings to send with Cursor, or choose another model.';

  it('refuses a Cursor model change on a Cowork tab while the runtime is disconnected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    mockedGetActiveChatIds.mockReturnValue([]);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Draft',
            text: '',
            timestamp: 20,
          }),
          messages: [],
          model: undefined,
          providerType: undefined,
          executionHarness: undefined,
        },
      ]),
    );
    await expect(
      setStandaloneChatModel({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'cursor-default',
      }),
    ).rejects.toThrow(CURSOR_CONNECT_MESSAGE);
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('persists a Cursor model change on a Cowork tab while the runtime is connected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockedGetActiveChatIds.mockReturnValue([]);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Draft',
            text: '',
            timestamp: 20,
          }),
          messages: [],
          model: undefined,
          providerType: undefined,
          executionHarness: undefined,
        },
      ]),
    );
    await expect(
      setStandaloneChatModel({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'cursor-default',
      }),
    ).resolves.toEqual({ ok: true });
    expect(chatStateCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'entry-r',
        command: {
          type: 'chat.set_model',
          tabId: 'shared-chat',
          model: 'cursor-default',
          providerType: 'cursor',
          executionHarness: 'cursor',
        },
      }),
    );
  });

  it.each(['model', 'providerType', 'executionHarness'] as const)(
    'refuses a Cursor %s Cowork send before persisting while the runtime is disconnected',
    async (field) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(false);
      await expect(
        sendStandaloneChatMessage({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          message: 'Hello',
          [field]: field === 'model' ? 'cursor-default' : 'cursor',
        }),
      ).rejects.toThrow(CURSOR_CONNECT_MESSAGE);
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
      expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    },
  );

  it('refuses a restored Cursor Cowork tab before persisting a send while disconnected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Cursor',
            text: 'Existing',
            timestamp: 20,
          }),
          model: 'cursor-default',
          providerType: 'cursor',
          executionHarness: 'cursor',
        },
      ]),
    );
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Hello',
      }),
    ).rejects.toThrow(CURSOR_CONNECT_MESSAGE);
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('refuses a provider-only Cursor Cowork send with no model to run before persisting, even while connected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Draft',
            text: '',
            timestamp: 20,
          }),
          messages: [],
          model: undefined,
          providerType: undefined,
          executionHarness: undefined,
        },
      ]),
    );
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Hello',
        providerType: 'cursor',
      }),
    ).rejects.toThrow(
      'Choose a Cursor model to send with Cursor, or choose another model.',
    );
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('tells a model-less Cursor Cowork send to choose a Cursor model before judging a default it would never run', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    // No Claude default: the policy preflight would otherwise answer with the
    // billing dead end for a Claude default this Cursor send cannot run.
    mockReadPreferencesFile.mockResolvedValue({
      deferredToolsStandaloneChatsEnabled: true,
      defaultChatModelByProvider: {
        claude: null,
        codex: { model: 'codex-default' },
        ollama: null,
      },
    });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Draft',
            text: '',
            timestamp: 20,
          }),
          messages: [],
          model: undefined,
          providerType: undefined,
          executionHarness: undefined,
        },
      ]),
    );
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Hello',
        providerType: 'cursor',
      }),
    ).rejects.toThrow(
      'Choose a Cursor model to send with Cursor, or choose another model.',
    );
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('runs a model-less Cursor Cowork send on the model the live session holds', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockGetSession.mockReturnValue({
      hasPendingSteeringInput: (): boolean => false,
    });
    mockGetSessionProviderType.mockReturnValue('cursor');
    mockGetSessionSelectedModel.mockReturnValue('cursor-default');
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Cursor',
            text: 'Existing',
            timestamp: 20,
          }),
          model: undefined,
          providerType: 'cursor',
          executionHarness: 'cursor',
        },
      ]),
    );
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Hello',
        providerType: 'cursor',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: true, chatId: 'shared-chat' }),
    );
    // The session's model is what dispatch runs, under the tab's provider, so
    // the live Cursor session is reused rather than replaced by a lane default.
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'cursor-default',
        providerType: 'cursor',
        executionHarness: 'cursor',
      }),
    );
  });

  it('ignores a live Claude session model for a provider-only Cursor send', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockGetSession.mockReturnValue({
      hasPendingSteeringInput: (): boolean => false,
    });
    // The live session runs Claude: its model must not be dispatched under the
    // Cursor provider, so the send has no Cursor model and is refused.
    mockGetSessionProviderType.mockReturnValue('claude');
    mockGetSessionSelectedModel.mockReturnValue('claude-default');
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Draft',
            text: '',
            timestamp: 20,
          }),
          messages: [],
          model: undefined,
          providerType: undefined,
          executionHarness: undefined,
        },
      ]),
    );
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Hello',
        providerType: 'cursor',
      }),
    ).rejects.toThrow(
      'Choose a Cursor model to send with Cursor, or choose another model.',
    );
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('refuses a model-less Cursor Cowork send when the live session holds no model either', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockGetSession.mockReturnValue({
      hasPendingSteeringInput: (): boolean => false,
    });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Cursor',
            text: 'Existing',
            timestamp: 20,
          }),
          model: undefined,
          providerType: 'cursor',
          executionHarness: 'cursor',
        },
      ]),
    );
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Hello',
        providerType: 'cursor',
      }),
    ).rejects.toThrow(
      'Choose a Cursor model to send with Cursor, or choose another model.',
    );
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it.each([
    ['provider', { providerType: 'cursor' as const }],
    ['tab harness', {}],
  ])(
    'judges the live Cursor session model for a model-less Cowork route named by %s',
    async (signal, request) => {
      mockGetSessionProviderType.mockReturnValue('cursor');
      mockGetSessionSelectedModel.mockReturnValue('cursor-default');
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            ...chatTab({
              id: 'shared-chat',
              title: 'Cursor',
              text: 'Existing',
              timestamp: 20,
            }),
            model: undefined,
            providerType: undefined,
            executionHarness: signal === 'tab harness' ? 'cursor' : undefined,
          },
        ]),
      );
      // The Portal adapter consumes this before the service runs, so it must
      // agree with the send path: a live Cursor session's model is the model
      // that dispatch runs, judged like any concrete model.
      await expect(
        resolveStandaloneChatPolicyModels({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          ...request,
        }),
      ).resolves.toEqual({ readable: true, models: ['cursor-default'] });
    },
  );

  it('does not judge a live Claude session model as a Cursor route model', async () => {
    mockGetSessionProviderType.mockReturnValue('claude');
    mockGetSessionSelectedModel.mockReturnValue('claude-default');
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Draft',
            text: '',
            timestamp: 20,
          }),
          messages: [],
          model: undefined,
          providerType: undefined,
          executionHarness: undefined,
        },
      ]),
    );
    await expect(
      resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        providerType: 'cursor',
      }),
    ).resolves.toEqual({
      readable: true,
      models: [],
      cursorModelRequired: true,
    });
  });

  it('reports a Cursor route with no model as its own policy outcome instead of judging a Claude default', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Draft',
            text: '',
            timestamp: 20,
          }),
          messages: [],
          model: undefined,
          providerType: undefined,
          executionHarness: undefined,
        },
      ]),
    );
    await expect(
      resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        providerType: 'cursor',
      }),
    ).resolves.toEqual({
      readable: true,
      models: [],
      cursorModelRequired: true,
    });
  });

  it('dispatches a provider-only Cursor Cowork send when the restored tab holds a Cursor model', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Cursor',
            text: 'Existing',
            timestamp: 20,
          }),
          model: 'cursor-default',
          providerType: 'cursor',
          executionHarness: 'cursor',
        },
      ]),
    );
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Hello',
        providerType: 'cursor',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: true, chatId: 'shared-chat' }),
    );
    // The tab supplied the model, so dispatch derives the provider from it
    // (see the `providerType` precedence at the dispatch call) rather than
    // pairing the request's label with it.
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'cursor-default',
        executionHarness: 'cursor',
      }),
    );
    const dispatchOptions = mockedDispatchWorktreeChatTurn.mock.lastCall?.[0];
    await dispatchOptions?.onBeforeChatEvent?.({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      sequenceNamespace: 'cursor',
      sequence: 1,
      data: { type: 'canopy_assistant_patch', provider: 'cursor', patches: [] },
    });
    expect(ingestProviderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerType: 'cursor' }),
    );
    mockGetSessionProviderType.mockReturnValue('codex');
    await dispatchOptions?.onBeforeChatEvent?.({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      sequenceNamespace: 'codex-substitution',
      sequence: 2,
      data: { type: 'codex', event: { type: 'item.completed' } },
    });
    expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerType: 'codex' }),
    );
  });

  it('publishes entry identity and resolved rename in live chat summaries', async () => {
    const conversational = chatTab({
      id: 'shared-chat',
      title: 'Research Chat',
      text: 'Request',
      timestamp: 20,
    });
    conversational.messages.push({
      id: 'system-tail',
      role: 'system',
      timestamp: 21,
      blocks: [],
    });
    mockedReadChatTabsFile.mockResolvedValueOnce(
      chatTabsFile([conversational]),
    );
    await emitStandaloneChatSummary('research', 'entry-r', 'shared-chat');
    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              lastMessageRole: 'user',
              workEntryId: 'entry-r',
              workEntryTitle: 'Explicit entry rename',
              workEntryCreatedAt: new Date(5).toISOString(),
              workEntryLastMessageAt: new Date(20).toISOString(),
              workEntryLastTouchedAt: new Date(30).toISOString(),
              workEntryOrder: 2,
              workEntryPinned: true,
              workEntryStatus: 'done',
              queuedMessages: [],
              inputDelivery: [],
              // Cowork chats dispatch Cursor, so the summary carries the
              // Cursor catalog rows and the runtime availability flag.
              availableModels: [],
              providerAvailability: { ollama: true, cursor: true },
            },
          },
        ],
      },
    });
    expect(mockBuildProjectedModelCatalog).toHaveBeenCalledWith(undefined, {
      cursor: true,
      copilot: true,
      opencode: true,
      owner: { kind: 'personal' },
      // Agents on the default model are described by this workspace's own.
      agentDefaultModel: 'default-for-research',
    });
  });

  it.each([true, false])(
    'projects the canonical OpenCode report and explicit clearing, reported=%s',
    async (reported) => {
      const report = { context: { usedTokens: 1234, maxTokens: 10000 } };
      const selected: PersistedChatTab = {
        ...chatTab({
          id: 'shared-chat',
          title: 'OpenCode',
          text: 'Done',
          timestamp: 20,
        }),
        providerType: 'opencode',
        model: 'opencode:fixture%2Fmodel',
        usage: {
          contextTokens: 1234,
          contextWindow: 10000,
          maxOutputTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 1,
          model: 'opencode:fixture%2Fmodel',
          ...(reported ? { opencodeReportedUsage: report } : {}),
        },
      };
      mockedReadChatTabsFile.mockResolvedValueOnce(chatTabsFile([selected]));
      await emitStandaloneChatSummary('research', 'entry-r', 'shared-chat');
      expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
        payload: {
          entities: [
            {
              payload: {
                providerType: 'opencode',
                usage: {
                  model: selected.model,
                  opencodeReportedUsage: reported ? report : null,
                },
              },
            },
          ],
        },
      });
    },
  );

  it.each(
    ['stored', 'materialized', 'entry'].flatMap((source) =>
      [false, true].map((turnStartsDuringRead) => ({
        source,
        turnStartsDuringRead,
      })),
    ),
  )(
    'projects legacy policy and live activity for $source summaries (turn starts during read: $turnStartsDuringRead)',
    async ({ source, turnStartsDuringRead }) => {
      mockReadPreferencesFile.mockImplementation(() => {
        mockQueueIsTurnActive.mockReturnValue(turnStartsDuringRead);
        return Promise.resolve({
          deferredToolsStandaloneChatsEnabled: false,
          defaultChatModelByProvider: {
            claude: { model: 'claude-default' },
            codex: { model: 'codex-default' },
            ollama: null,
          },
        });
      });
      const tab = chatTab({
        id: 'shared-chat',
        title: 'Legacy Cowork chat',
        text: 'Earlier conversation',
        timestamp: 20,
      });
      mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([tab]));

      if (source === 'stored')
        await emitStandaloneChatSummary('research', 'entry-r', tab.id);
      else if (source === 'materialized')
        await emitStandaloneChatSummaryForTab(
          'research',
          'entry-r',
          tab,
          false,
        );
      else
        await emitStandaloneWorkEntrySummary('research', 'entry-r', {
          tabs: [tab],
        });

      expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
        payload: {
          entities: [
            {
              payload: {
                deferredToolsAllowed: false,
                hasActiveChat: turnStartsDuringRead,
              },
            },
          ],
        },
      });
      expect(tab).not.toHaveProperty('deferredToolsAllowed');
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    },
  );

  describe('questions and turn state', () => {
    const question = { question: 'Ship it?', options: ['Yes', 'No'] };
    const pendingQuestions = [
      {
        requestId: 'req-1',
        chatId: 'shared-chat',
        toolUseId: 'tool-1',
        questions: [question],
      },
      { requestId: 'req-other', chatId: 'other-chat', questions: [question] },
    ];
    const projected = [
      {
        requestId: 'req-1',
        toolUseId: 'tool-1',
        questions: [question],
        answered: false,
      },
    ];
    const tab = (): PersistedChatTab =>
      chatTab({
        id: 'shared-chat',
        title: 'Cowork chat',
        text: 'Earlier conversation',
        timestamp: 20,
      });
    const emitted = (): unknown =>
      mockedEnqueuePortalEvent.mock.calls[0]?.[0]?.payload;

    beforeEach(() => {
      mockGetActiveSessionInfos.mockReturnValue([]);
    });

    it('projects the Work Entry questions and turn state on a materialized write', async () => {
      mockGetActiveSessionInfos.mockReturnValueOnce([
        { chatId: 'shared-chat', turnActive: true },
      ]);
      await emitStandaloneWorkEntrySummary('research', 'entry-r', {
        tabs: [tab()],
        pendingQuestions,
      });
      expect(mockGetActiveSessionInfos).toHaveBeenCalledWith(
        'research',
        'entry-r',
      );
      expect(emitted()).toMatchObject({
        entities: [
          { payload: { turnActive: true, pendingQuestions: projected } },
        ],
      });
    });

    it('projects how the latest accepted turn ended', async () => {
      await emitStandaloneWorkEntrySummary('research', 'entry-r', {
        tabs: [
          {
            ...tab(),
            lastAcceptedUserMessageId: 'user-1',
            turnEnds: { 'user-1': { outcome: 'failed', endedAt: 0 } },
          },
        ],
      });
      expect(emitted()).toMatchObject({
        entities: [
          {
            payload: {
              lastTurnEnd: {
                userMessageId: 'user-1',
                outcome: 'failed',
                endedAt: '1970-01-01T00:00:00.000Z',
              },
            },
          },
        ],
      });
    });

    it('clears questions from a stored tabs file that has none', async () => {
      mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([tab()]));
      await emitStandaloneChatSummary('research', 'entry-r', 'shared-chat');
      expect(emitted()).toMatchObject({
        entities: [{ payload: { turnActive: false, pendingQuestions: [] } }],
      });
    });

    it('carries an awaited question on streaming updates and listings', async () => {
      // A session waiting on its question pauses the turn.
      mockGetActiveSessionInfos.mockReturnValue([
        { chatId: 'shared-chat', turnActive: false },
      ]);
      mockedReadChatTabsFile.mockResolvedValue({
        ...chatTabsFile([tab()]),
        pendingQuestions,
      });
      await emitStandaloneChatSummaryForTab('research', 'entry-r', tab(), true);
      expect(emitted()).toMatchObject({
        entities: [
          { payload: { turnActive: false, pendingQuestions: projected } },
        ],
      });
      const listed = await listStandaloneChats();
      expect(
        listed.find(
          (chat) =>
            chat.projectLocalId === 'research' && chat.chatId === 'shared-chat',
        ),
      ).toMatchObject({ turnActive: false, pendingQuestions: projected });
    });

    it('skips the update when an awaited question cannot be read', async () => {
      // Publishing without the questions would replace a cached awaited one.
      mockGetActiveSessionInfos.mockReturnValue([
        { chatId: 'shared-chat', turnActive: false },
      ]);
      mockedReadChatTabsFile.mockRejectedValueOnce(new Error('unreadable'));
      await emitStandaloneChatSummaryForTab('research', 'entry-r', tab(), true);
      expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
    });

    it('leaves questions out of an update for a chat with no session', async () => {
      await emitStandaloneChatSummaryForTab(
        'research',
        'entry-r',
        tab(),
        false,
      );
      expect(emitted()).toMatchObject({ entities: [{ payload: {} }] });
      expect(
        JSON.stringify(mockedEnqueuePortalEvent.mock.calls[0]?.[0]),
      ).not.toContain('pendingQuestions');
    });

    it('reads one chat questions from its Work Entry', async () => {
      mockedReadChatTabsFile.mockResolvedValue({
        ...chatTabsFile([tab()]),
        pendingQuestions,
      });
      const chat = {
        projectLocalId: 'research',
        projectId: 'research',
        chatId: 'shared-chat',
        title: 'Cowork chat',
        workEntryId: 'entry-r',
      };
      await expect(withStandalonePendingQuestions(chat)).resolves.toEqual({
        ...chat,
        pendingQuestions: projected,
      });
      expect(mockedReadChatTabsFile).toHaveBeenCalledWith(
        'research',
        'entry-r',
        { chatIds: ['shared-chat'], pageOnly: true },
      );
      mockedReadChatTabsFile.mockRejectedValueOnce(new Error('unreadable'));
      await expect(withStandalonePendingQuestions(chat)).rejects.toThrow(
        'unreadable',
      );
    });

    it('adds the chat latest turn end from the same read, through to the entity', async () => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            ...tab(),
            lastAcceptedUserMessageId: 'user-1',
            turnEnds: { 'user-1': { outcome: 'cancelled', endedAt: 0 } },
          },
        ]),
      );
      const chat = await withStandalonePendingQuestions({
        projectLocalId: 'research',
        projectId: 'research',
        chatId: 'shared-chat',
        title: 'Cowork chat',
        workEntryId: 'entry-r',
      });
      const lastTurnEnd = {
        userMessageId: 'user-1',
        outcome: 'cancelled',
        endedAt: '1970-01-01T00:00:00.000Z',
      };
      expect(chat).toMatchObject({ lastTurnEnd });
      expect(projectStandaloneChatSnapshot(chat)).toMatchObject({
        lastTurnEnd,
      });
    });
  });

  it('projects the full plugin selections of a live standalone chat', async () => {
    const selected: PersistedChatTab = {
      ...chatTab({
        id: 'shared-chat',
        title: 'Research Chat',
        text: 'Research message',
        timestamp: 20,
      }),
      pluginSelections: {
        collectionIds: ['collection-a'],
        bundleIds: ['legacy-collection'],
        skillRefs: [{ sourceId: 'local', skillName: 'review' }],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
        mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
        mcpHttpAuthPreferences: [
          {
            target: { kind: 'standalone', serverId: 'server', configId: 'c' },
            handler: 'canopy',
          },
        ],
      },
    };
    mockedReadChatTabsFile.mockResolvedValueOnce(chatTabsFile([selected]));

    await emitStandaloneChatSummary('research', 'entry-r', 'shared-chat');

    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              pluginSelectionsDetail: {
                collectionIds: ['collection-a', 'legacy-collection'],
                skillRefs: [{ sourceId: 'local', skillName: 'review' }],
                pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
                mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
                mcpHttpAuthPreferences: [
                  {
                    target: {
                      kind: 'standalone',
                      serverId: 'server',
                      configId: 'c',
                    },
                    handler: 'canopy',
                  },
                ],
              },
            },
          },
        ],
      },
    });

    // A live tab without selections projects an explicit empty set.
    mockedEnqueuePortalEvent.mockClear();
    await emitStandaloneChatSummary('cowork-default', 'entry-d', 'shared-chat');
    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              pluginSelectionsDetail: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
              },
            },
          },
        ],
      },
    });
  });

  it('projects compact plugin selections and omits only unrecovered ones', async () => {
    mockedListWorkEntryChatSummaries.mockImplementation((workspaceId) =>
      Promise.resolve([
        {
          entryId: workspaceId === 'research' ? 'entry-r' : 'entry-d',
          title: 'Entry',
          order: 0,
          createdAt: new Date(1).toISOString(),
          chats: [
            {
              id: 'shared-chat',
              title: 'Chat',
              lastMessageRole: 'assistant',
              createdAt: new Date(1).toISOString(),
              lastMessageAt: new Date(1).toISOString(),
              // The registry recovers selections for indexed scopes; the
              // default one models an unopened version 1 scope.
              ...(workspaceId === 'research'
                ? {
                    pluginSelections: {
                      collectionIds: [],
                      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
                      pluginRefs: [],
                    },
                  }
                : {}),
            },
          ],
        },
      ]),
    );

    const summaries = await listStandaloneChats();
    const research = summaries.find((chat) => chat.projectId === 'research');
    const legacy = summaries.find(
      (chat) => chat.projectId === 'cowork-default',
    );
    if (!research || !legacy) throw new Error('Expected both summaries');

    const expected = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
      pluginRefs: [],
    };
    expect(research.lastMessageRole).toBe('assistant');
    expect(projectStandaloneChatSnapshot(research).lastMessageRole).toBe(
      'assistant',
    );
    expect(research.pluginSelectionsDetail).toEqual(expected);
    // Compact summaries have no verified policy; they must not reset opt-outs.
    expect(research).not.toHaveProperty('deferredToolsAllowed');
    expect(legacy).not.toHaveProperty('deferredToolsAllowed');
    expect(
      projectStandaloneChatSnapshot(research).pluginSelectionsDetail,
    ).toEqual(expected);
    // Absent means unknown, never a verified empty selection.
    expect(legacy).not.toHaveProperty('pluginSelectionsDetail');
    expect(projectStandaloneChatSnapshot(legacy).pluginSelectionsDetail).toBe(
      undefined,
    );
  });

  it('marks prompt-context-only queued messages as attachment-bearing', async () => {
    mockGetWorktreeSnapshots.mockReturnValue([
      {
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        turnActive: true,
        queue: [
          {
            id: 'queued-context',
            text: 'Use the attached context',
            origin: 'portal',
            enqueuedAtMs: 1,
            attachmentPromptContexts: [
              {
                attachmentPath: '/tmp/context.md',
                promptKind: 'in-app-browser-resource',
              },
            ],
          },
        ],
      },
    ]);

    await emitStandaloneChatSummary('research', 'entry-r', 'shared-chat');

    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              queuedMessages: [
                expect.objectContaining({
                  id: 'queued-context',
                  hasAttachments: true,
                  attachmentEditsPreservePayload: true,
                }),
              ],
            },
          },
        ],
      },
    });
  });

  it('keeps the sender of a queued agent message in the Portal summary', async () => {
    const agentSent = {
      sender: {
        kind: 'project' as const,
        projectType: 'code' as const,
        projectId: 'source-project',
        taskId: 'source-task',
        chatId: 'source-chat',
      },
      chatTitle: 'Origin',
      projectLabel: 'Source',
    };
    mockGetWorktreeSnapshots.mockReturnValue([
      {
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        turnActive: true,
        queue: [
          {
            id: 'queued-agent',
            text: 'From another chat',
            origin: 'desktop',
            enqueuedAtMs: 1,
            agentSent,
          },
        ],
      },
    ]);

    await emitStandaloneChatSummary('research', 'entry-r', 'shared-chat');

    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              queuedMessages: [
                expect.objectContaining({ id: 'queued-agent', agentSent }),
              ],
            },
          },
        ],
      },
    });
  });

  it('returns standalone chat summaries across every project work entry', async () => {
    mockedGetActiveChatIds.mockImplementation((workspaceId) =>
      workspaceId === 'research' ? ['shared-chat'] : [],
    );
    const summaries = await listStandaloneChats();

    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectLocalId: 'research',
          projectId: 'research',
          chatId: 'shared-chat',
          title: 'Research Chat',
          workEntryId: 'entry-r',
          customTitle: 'My chat',
          workEntryTitle: 'Explicit entry rename',
          workEntryCreatedAt: new Date(5).toISOString(),
          workEntryLastMessageAt: new Date(20).toISOString(),
          workEntryLastTouchedAt: new Date(30).toISOString(),
          workEntryOrder: 2,
          workEntryPinned: true,
          workEntryStatus: 'done',
          hasActiveChat: true,
          hasUnread: true,
          executionHarness: 'codex',
        }),
        expect.objectContaining({
          projectLocalId: 'cowork-default',
          projectId: 'cowork-default',
          chatId: 'shared-chat',
          title: 'Default Chat',
          workEntryId: 'entry-d',
          workEntryCreatedAt: new Date(1).toISOString(),
          workEntryOrder: 0,
          hasActiveChat: false,
          hasUnread: false,
          executionHarness: 'claude',
        }),
      ]),
    );
    // An unpinned, active entry with no activity yet omits those facts, and
    // the snapshot projection carries every fact the summary has.
    const defaultChat = summaries.find(
      (summary) => summary.projectId === 'cowork-default',
    );
    expect(defaultChat).toBeDefined();
    for (const key of [
      'workEntryPinned',
      'workEntryStatus',
      'workEntryLastMessageAt',
      'workEntryLastTouchedAt',
    ]) {
      expect(defaultChat).not.toHaveProperty(key);
    }
    const researchChat = summaries.find(
      (summary) => summary.projectId === 'research',
    );
    if (!researchChat) throw new Error('Expected the research chat summary');
    expect(projectStandaloneChatSnapshot(researchChat)).toMatchObject({
      localId: 'shared-chat',
      customTitle: 'My chat',
      workEntryId: 'entry-r',
      workEntryTitle: 'Explicit entry rename',
      workEntryCreatedAt: new Date(5).toISOString(),
      workEntryLastMessageAt: new Date(20).toISOString(),
      workEntryLastTouchedAt: new Date(30).toISOString(),
      workEntryOrder: 2,
      workEntryPinned: true,
      workEntryStatus: 'done',
    });
  });

  it('resolves summary owners through one resolver per listing', async () => {
    const owner: WorkOwner = { kind: 'organization', organizationId: 'org-1' };
    mockBuildScopeOwner
      .mockResolvedValueOnce(owner)
      .mockResolvedValueOnce(owner);
    await listStandaloneChats();

    expect(mockResolveAiCreditsScopeOwner).not.toHaveBeenCalled();
    expect(mockCreateAiCreditsScopeOwnerResolver).toHaveBeenCalledTimes(1);
    expect(mockBuildScopeOwner.mock.calls).toEqual([
      [
        {
          kind: 'work',
          projectId: 'cowork-default',
          worktreeId: 'entry-d',
          chatId: 'shared-chat',
        },
      ],
      [
        {
          kind: 'work',
          projectId: 'research',
          worktreeId: 'entry-r',
          chatId: 'shared-chat',
        },
      ],
    ]);
    expect(mockBuildProjectedModelCatalog).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ owner }),
    );
  });

  it('refreshes every chat of the workspace so a reorder reaches the portal', async () => {
    mockedListWorkEntryChatSummaries.mockResolvedValue([
      {
        entryId: 'entry-b',
        title: 'B',
        order: 0,
        createdAt: new Date(2).toISOString(),
        chats: [
          {
            id: 'chat-b',
            title: 'Chat B',
            createdAt: new Date(2).toISOString(),
            lastMessageAt: new Date(2).toISOString(),
          },
        ],
      },
      {
        entryId: 'entry-a',
        title: 'A',
        order: 1,
        createdAt: new Date(1).toISOString(),
        chats: [
          {
            id: 'chat-a1',
            title: 'Chat A1',
            createdAt: new Date(1).toISOString(),
            lastMessageAt: new Date(1).toISOString(),
          },
          {
            id: 'chat-a2',
            title: 'Chat A2',
            createdAt: new Date(1).toISOString(),
            lastMessageAt: new Date(1).toISOString(),
          },
        ],
      },
    ]);

    await emitStandaloneWorkspaceWorkEntrySummaries('research');

    const expected: Array<[string, string, number]> = [
      ['chat-b', 'entry-b', 0],
      ['chat-a1', 'entry-a', 1],
      ['chat-a2', 'entry-a', 1],
    ];
    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(expected.length);
    expected.forEach(([localId, workEntryId, workEntryOrder], index) => {
      expect(mockedEnqueuePortalEvent.mock.calls[index]?.[0]).toMatchObject({
        payload: {
          entities: [{ payload: { localId, workEntryId, workEntryOrder } }],
        },
      });
    });
  });

  it('does not read Work Entry transcript bodies while building the desktop snapshot', async () => {
    const entryIds = Array.from({ length: 40 }, (_, index) => `entry-${index}`);
    mockedListProjects.mockResolvedValue([
      {
        id: 'cowork-default',
        name: 'Default',
        createdAt: '2026-05-08T00:00:00.000Z',
      },
    ]);
    mockedListWorkEntryIds.mockResolvedValue(entryIds);
    mockedListWorkEntryChatSummaries.mockResolvedValue(
      entryIds.map((entryId, order) => ({
        entryId,
        title: `Entry ${entryId}`,
        order,
        createdAt: new Date(1).toISOString(),
        chats: [
          {
            id: `${entryId}-chat`,
            title: `Chat for ${entryId}`,
            createdAt: new Date(10).toISOString(),
            lastMessageAt: new Date(10).toISOString(),
          },
        ],
      })),
    );

    await expect(listStandaloneChats()).resolves.toHaveLength(entryIds.length);
    expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, false],
    ['app_advisor', false],
    ['automation', false],
    ['portal', true],
  ] as const)(
    'counts cowork skill usage only for an explicit user source (%s)',
    async (initiationSource, eligible) => {
      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: '/release-notes write notes',
        ...(initiationSource ? { initiationSource } : {}),
      });
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ countsTowardSkillUsage: eligible }),
      );
    },
  );

  it('reads a colliding chat id from the requested standalone project', async () => {
    const transcript = await listStandaloneChatTranscript({
      projectLocalId: 'research',
      chatId: 'shared-chat',
    });

    expect(mockedReadChatTabsFile).toHaveBeenCalledWith('research', 'entry-r', {
      chatIds: ['shared-chat'],
      pageOnly: true,
    });
    expect(transcript[0]?.text).toBe('Research message');
  });

  it('sends Portal standalone turns through the chat entry with native keying', async () => {
    const getWindow = (): null => null;
    let persistedTabsFile = chatTabsFile([
      {
        ...chatTab({
          id: 'shared-chat',
          title: 'Research Chat',
          text: 'Research message',
          timestamp: 20,
          unread: true,
        }),
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: 'Usage limit reached',
          detectedAt: 1,
          dismissKey: 'limit-1',
        },
        dismissedLlmProviderUsageLimitBannerKey: 'limit-1',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_workspaceId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });

    const sendResult = await sendStandaloneChatMessage(
      {
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Continue',
        inputMode: 'voice',
        initiationSource: 'portal',
      },
      { getWindow },
    );

    expect(runWithScopeActivityMock).toHaveBeenCalledWith(
      { projectId: 'research', worktreeId: 'entry-r' },
      expect.any(Function),
    );

    expect(mockedCancelTransientRetriesForWorkspaceChat).toHaveBeenCalledWith(
      'research',
      'shared-chat',
      'manual-send',
    );
    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'standalone-chat',
        worktreeId: 'research',
        chatId: 'shared-chat',
      },
      'manual-send',
    );
    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
      },
      'manual-send',
    );

    expect(mockedWriteChatTabsFile).toHaveBeenCalledWith(
      'research',
      'entry-r',
      expect.any(Object),
    );
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'llmProviderUsageLimitBanner',
    );
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'dismissedLlmProviderUsageLimitBannerKey',
    );
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledWith({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
    });
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        countsTowardSkillUsage: true,
        text: 'Continue',
        inputMode: 'voice',
        getWindow,
      }),
    );
    const dispatchOptions = mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0];
    expect(dispatchOptions?.onBeforeChatEvent).toEqual(expect.any(Function));
    await dispatchOptions?.onBeforeChatEvent?.({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      sequenceNamespace: 'initial',
      sequence: 4,
      data: {
        type: 'assistant',
        message: {
          id: 'assistant-native',
          role: 'assistant',
          content: [{ type: 'text', text: 'Durable standalone output' }],
        },
      },
    });
    const committedProviderEvent = ingestProviderEventMock.mock.calls.find(
      ([input]) => String(input.mutationId).endsWith(':provider:initial:4'),
    )?.[0];
    expect(committedProviderEvent).toMatchObject({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
    });
    const writesBeforeDisplayProjection =
      mockedWriteChatTabsFile.mock.calls.length;
    dispatchOptions?.onChatEvent?.({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      isTerminalEvent: false,
      data: {
        type: 'assistant',
        message: {
          id: 'assistant-native',
          role: 'assistant',
          content: [{ type: 'text', text: 'Durable standalone output' }],
        },
      },
    });
    await enqueueChatTabMutation('research', 'entry-r', () =>
      Promise.resolve(),
    );
    expect(mockedWriteChatTabsFile).toHaveBeenCalledTimes(
      writesBeforeDisplayProjection,
    );
    const dispatchedUserMessageId =
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].userMessageId;
    expect(dispatchedUserMessageId).toEqual(expect.any(String));
    expect(sendResult.userMessageId).toBe(dispatchedUserMessageId);
    const localEventCall = mockedSendToWindow.mock.calls.find(
      (call) =>
        call[1] === IPC_CHANNELS.chatEvent &&
        isRecord(call[2]) &&
        isRecord(call[2].data) &&
        call[2].data.type === 'canopy_user_prompt',
    );
    expect(localEventCall?.[0]).toBe(null);
    expect(localEventCall?.[2]).toMatchObject({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Continue',
        canopy_turn_user_message_id: dispatchedUserMessageId,
        canopy_persisted_messages: [
          expect.objectContaining({
            id: dispatchedUserMessageId,
            role: 'user',
            blocks: [{ type: 'text', text: 'Continue' }],
          }),
        ],
      },
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      {
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: dispatchedUserMessageId,
        },
      },
    );

    const portalEvent = mockedEnqueuePortalEvent.mock.calls[0]?.[0];
    expect(portalEvent).toMatchObject({
      type: 'portal.chat.event',
      payload: {
        scope: 'standalone',
        projectLocalId: 'research',
        projectId: 'research',
        workEntryId: 'entry-r',
        chatId: 'shared-chat',
      },
    });
    expect(emittedStandaloneActiveStates()).toContain(true);
    const sentMessages = persistedTabsFile.tabs[0]?.messages ?? [];
    expect(sentMessages[sentMessages.length - 1]?.inputMode).toBe('voice');
    expect(sentMessages[sentMessages.length - 1]).not.toHaveProperty(
      'agentSent',
    );
    expect(portalEvent?.payload).not.toHaveProperty('message.agentSent');
  });

  it('persists and emits trusted sender provenance for standalone sends', async () => {
    const agentSent: AgentSentInfo = {
      kind: 'external_agent',
      connectionId: '123e4567-e89b-42d3-a456-426614174000',
      clientName: 'Web MCP Agent',
      verified: true,
      userId: '123e4567-e89b-42d3-a456-426614174001',
    };
    let persistedTabsFile = chatTabsFile([
      chatTab({
        id: 'shared-chat',
        title: 'Research Chat',
        text: 'Research message',
        timestamp: 20,
      }),
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_workspaceId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });

    const result = await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue for me',
      initiationSource: 'portal',
      agentSent,
    });

    const persistedMessage = persistedTabsFile.tabs[0]?.messages.find(
      (message) => message.id === result.userMessageId,
    );
    expect(persistedMessage?.agentSent).toEqual(agentSent);
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Continue for me', agentSent }),
    );
    const expectedMessage: unknown = expect.objectContaining({
      role: 'user',
      text: 'Continue for me',
      agentSent,
    });
    const expectedPayload: unknown = expect.objectContaining({
      message: expectedMessage,
    });
    expect(mockedEnqueuePortalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'portal.chat.event',
        payload: expectedPayload,
      }),
    );
  });

  it('derives the persisted harness from the host model instead of client metadata', async () => {
    initClaudeModels([{ id: 'claude-default', label: 'Claude Default' }]);
    let persistedTabsFile = chatTabsFile([
      {
        ...chatTab({
          id: 'shared-chat',
          title: 'Research Chat',
          text: 'Research message',
          timestamp: 20,
        }),
        model: 'claude-default',
        providerType: 'claude',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_workspaceId, _entryId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue',
      model: 'claude-default',
      executionHarness: 'codex',
    });

    expect(persistedTabsFile.tabs[0]?.executionHarness).toBe('claude');
  });

  it('rejects an explicit cross-harness model send before persisting the turn', async () => {
    initClaudeModels([{ id: 'claude-override', label: 'Claude Override' }]);
    initCodexModels([{ id: 'codex-captured', label: 'Codex Captured' }]);
    const persistedTabsFile = chatTabsFile([
      {
        ...chatTab({
          id: 'shared-chat',
          title: 'Research Chat',
          text: 'Research message',
          timestamp: 20,
        }),
        model: 'codex-captured',
        providerType: 'codex',
        executionHarness: 'codex',
      },
    ]);
    mockedReadChatTabsFile.mockResolvedValue(persistedTabsFile);

    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Do not reroute this conversation',
        model: 'claude-override',
        providerType: 'claude',
      }),
    ).rejects.toThrow(/execution harness/i);

    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('does not reject an accepted send when recovery cleanup fails', async () => {
    mockedClearUsageLimitedChat.mockRejectedValueOnce(
      new Error('registry cleanup failed'),
    );
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });

    const result = await sendStandaloneChatMessage(
      {
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Continue',
      },
      { getWindow: () => null },
    );
    expect(result).toMatchObject({
      ok: true,
      chatId: 'shared-chat',
    });
    expect(result.userMessageId).toEqual(expect.any(String));

    const dispatchedUserMessageId =
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].userMessageId;
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      {
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: dispatchedUserMessageId,
        },
      },
    );
  });

  it('keeps a portal turn timer live after dispatch accepts until the terminal event', async () => {
    let onChatEvent:
      | Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']
      | undefined;
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      onChatEvent = options.onChatEvent;
      return Promise.resolve();
    });

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue',
    });

    const dispatchedUserMessageId =
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].userMessageId;
    const timerStatuses = (): string[] =>
      mockedEnqueuePortalEvent.mock.calls.flatMap(([event]) => {
        const payload: unknown = event.payload;
        if (!isRecord(payload) || !isRecord(payload.message)) {
          return [];
        }
        const { messageId, status } = payload.message;
        return messageId === `${dispatchedUserMessageId}:turn-timer` &&
          typeof status === 'string'
          ? [status]
          : [];
      });
    expect(timerStatuses()).toEqual(['streaming']);

    onChatEvent?.({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      isTerminalEvent: true,
      data: {
        type: 'result',
        is_error: false,
        result: 'Turn completed',
      },
    });

    expect(timerStatuses()).toEqual(['streaming', 'complete']);
  });

  it('starts a separate Portal timer and fallback message for an autonomous steering root', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue',
    });
    const callback =
      mockedDispatchWorktreeChatTurn.mock.calls[0][0].onChatEvent;
    const target = {
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
    };
    callback?.({
      ...target,
      isTerminalEvent: true,
      data: { type: 'result', is_error: false },
    });
    callback?.({
      ...target,
      isTerminalEvent: false,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: 'steered-root',
      },
    });
    const messages = (): Record<string, unknown>[] =>
      mockedEnqueuePortalEvent.mock.calls.flatMap(([event]) => {
        const payload: unknown = event.payload;
        return isRecord(payload) && isRecord(payload.message)
          ? [payload.message]
          : [];
      });
    expect(messages()).toContainEqual(
      expect.objectContaining({
        messageId: 'steered-root:turn-timer',
        status: 'streaming',
      }),
    );
    callback?.({
      ...target,
      isTerminalEvent: false,
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'New turn response' }] },
      },
    });
    expect(messages()).toContainEqual(
      expect.objectContaining({ messageId: 'steered-root:assistant' }),
    );
    callback?.({
      ...target,
      isTerminalEvent: true,
      data: { type: 'result', is_error: false },
    });
    expect(messages()).toContainEqual(
      expect.objectContaining({
        messageId: 'steered-root:turn-timer',
        status: 'complete',
      }),
    );
  });

  it('does not start a Portal turn for a host-rejected steering root', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue',
    });
    const callback =
      mockedDispatchWorktreeChatTurn.mock.calls[0][0].onChatEvent;
    callback?.({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      isTerminalEvent: false,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: 'rejected-root',
        turnRootAccepted: false,
      },
    });

    const messages = mockedEnqueuePortalEvent.mock.calls.flatMap(([event]) => {
      const payload: unknown = event.payload;
      return isRecord(payload) && isRecord(payload.message)
        ? [payload.message]
        : [];
    });
    expect(messages).not.toContainEqual(
      expect.objectContaining({ messageId: 'rejected-root:turn-timer' }),
    );
  });

  it('keeps a portal turn timer live for a child Codex terminal event', async () => {
    let onChatEvent:
      | Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']
      | undefined;
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      onChatEvent = options.onChatEvent;
      return Promise.resolve();
    });

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue',
    });

    const dispatchedUserMessageId =
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].userMessageId;
    const timerStatuses = (): string[] =>
      mockedEnqueuePortalEvent.mock.calls.flatMap(([event]) => {
        const payload: unknown = event.payload;
        if (!isRecord(payload) || !isRecord(payload.message)) {
          return [];
        }
        const { messageId, status } = payload.message;
        return messageId === `${dispatchedUserMessageId}:turn-timer` &&
          typeof status === 'string'
          ? [status]
          : [];
      });
    expect(timerStatuses()).toEqual(['streaming']);

    onChatEvent?.({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
      isTerminalEvent: false,
      data: {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'thread-child',
          turn_id: 'turn-child',
        },
      },
    });

    expect(timerStatuses()).toEqual(['streaming']);
  });

  it('publishes an inactive standalone summary on terminal events', async () => {
    mockedGetActiveChatIds.mockReturnValue([]);
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onChatEvent?.({
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
        isTerminalEvent: true,
        data: {
          type: 'result',
          is_error: false,
        },
      });
      return Promise.resolve();
    });

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(emittedStandaloneActiveStates()).toEqual(
      expect.arrayContaining([true, false]),
    );
  });

  it('invalidates canonical retries before async send target resolution', async () => {
    let resolveEntry: (value: {
      entryId: string;
      archivedInEntryId: null;
    }) => void = (): void => undefined;
    mockedResolveWorkEntryForChat.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEntry = resolve;
      }),
    );

    const sendPromise = sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue',
    });

    expect(mockedCancelTransientRetriesForWorkspaceChat).toHaveBeenCalledWith(
      'research',
      'shared-chat',
      'manual-send',
    );
    resolveEntry({ entryId: 'entry-r', archivedInEntryId: null });
    await sendPromise;
  });

  it('does not resurrect a work entry deleted during send target resolution', async () => {
    mockedResolveWorkEntryForChat
      .mockResolvedValueOnce({
        entryId: 'entry-r',
        archivedInEntryId: null,
      })
      .mockResolvedValueOnce({
        entryId: null,
        archivedInEntryId: null,
      });

    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Continue',
      }),
    ).rejects.toThrow('The selected work entry is no longer available');

    expect(runWithScopeActivityMock).toHaveBeenCalledWith(
      { projectId: 'research', worktreeId: 'entry-r' },
      expect.any(Function),
    );
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('cancels the canonical and legacy standalone retry targets on stop', async () => {
    await cancelStandaloneChat({
      projectLocalId: 'research',
      chatId: 'shared-chat',
    });

    expect(mockCancelChatTurn).toHaveBeenCalledWith({
      projectId: 'research',
      worktreeId: 'entry-r',
      chatId: 'shared-chat',
    });
    expect(mockQueueTerminal).toHaveBeenCalledWith(
      { projectId: 'research', worktreeId: 'entry-r', chatId: 'shared-chat' },
      'cancelled',
    );
    expect(mockedCancelTransientRetriesForWorkspaceChat).toHaveBeenCalledWith(
      'research',
      'shared-chat',
      'stop',
    );
    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'standalone-chat',
        worktreeId: 'research',
        chatId: 'shared-chat',
      },
      'stop',
    );
    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
      },
      'stop',
    );
  });

  it('invalidates canonical retries before async Stop target resolution', async () => {
    let resolveEntry: (value: {
      entryId: string;
      archivedInEntryId: null;
    }) => void = (): void => undefined;
    mockedResolveWorkEntryForChat.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEntry = resolve;
      }),
    );

    const cancelPromise = cancelStandaloneChat({
      projectLocalId: 'research',
      chatId: 'shared-chat',
    });

    expect(mockedCancelTransientRetriesForWorkspaceChat).toHaveBeenCalledWith(
      'research',
      'shared-chat',
      'stop',
    );
    resolveEntry({ entryId: 'entry-r', archivedInEntryId: null });
    await cancelPromise;
  });

  it('preserves a persisted disabled deferred-tools policy for Portal sends', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        chatTab({
          id: 'shared-chat',
          title: 'Research Chat',
          text: 'Research message',
          timestamp: 20,
          deferredToolsAllowed: false,
        }),
      ]),
    );

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue without deferred tools',
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ deferredToolsAllowed: false }),
    );
    expect(mockedWriteChatTabsFile).toHaveBeenCalledWith(
      'research',
      'entry-r',
      expect.objectContaining({
        tabs: [expect.objectContaining({ deferredToolsAllowed: false })],
      }),
    );
  });

  it('dispatches the saved plugin selections when a Portal send names none', async () => {
    const saved = {
      collectionIds: ['collection-a'],
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
    };
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Research Chat',
            text: 'Research message',
            timestamp: 20,
          }),
          pluginSelections: saved,
        },
      ]),
    );

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: '/review',
    });
    const requested = { skillRefs: [{ sourceId: 'local', skillName: 'fix' }] };
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: '/fix',
      pluginSelections: requested,
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pluginSelections: saved }),
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pluginSelections: requested }),
    );
  });

  it('sends into an existing chat whose unselected transcript is guarded', async () => {
    // The V2 compatibility read returns metadata-only tabs unless the chat is
    // selected: `messages` throws instead of reading as empty.
    const selectedTab = (): PersistedChatTab =>
      chatTab({
        id: 'shared-chat',
        title: 'Research Chat',
        text: 'Research message',
        timestamp: 20,
      });
    mockedReadChatTabsFile.mockImplementation(
      (_workspaceId, _worktreeId, selection): Promise<ChatTabsFile> => {
        if (selection?.chatIds?.includes('shared-chat')) {
          return Promise.resolve(chatTabsFile([selectedTab()]));
        }
        const tab = selectedTab();
        Object.defineProperty(tab, 'messages', {
          get: (): never => {
            throw new Error('Transcript shared-chat was not selected');
          },
        });
        tab.transcript = {
          format: 'complete-message-jsonl-v1',
          committedMessageCount: 1,
          committedByteLength: 1,
          transcriptRevision: 1,
          hasActiveSidecar: false,
          messageCount: 1,
        };
        return Promise.resolve(chatTabsFile([tab]));
      },
    );

    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: '3+3',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: true, delivery: 'accepted' }),
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalled();
  });

  it('preserves persisted approval state for Portal sends', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        chatTab({
          id: 'shared-chat',
          title: 'Research Chat',
          text: 'Research message',
          timestamp: 20,
          approvalMode: 'auto',
          sessionApprovalRules: [
            {
              id: 'rule-1',
              behavior: 'allow',
              target: { kind: 'command', pattern: 'npm test *' },
              createdAt: '2026-07-23T00:00:00.000Z',
              origin: 'prompt',
            },
          ],
        }),
      ]),
    );

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Continue with saved approvals',
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: 'auto',
        sessionApprovalRules: [expect.objectContaining({ id: 'rule-1' })],
      }),
    );
  });

  it('clamps a Portal send with the native standalone session identity', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        chatTab({
          id: 'shared-chat',
          title: 'Research Chat',
          text: 'Research message',
          timestamp: 20,
          approvalMode: 'full-access',
        }),
      ]),
    );
    setLiveApprovalMode('research', 'entry-r', 'shared-chat', 'ask');

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Use the live downgrade',
    });

    expect(mockedResolvePersistedApprovalMode).toHaveBeenCalledWith(
      'research',
      'entry-r',
      'ask',
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'ask' }),
    );
  });

  it('uses the standalone preference for a new Portal chat', async () => {
    // Not `...Once`: the send path reads preferences twice now (the policy
    // guard resolves the effective model through the same file), so a
    // single-shot mock would leave the second read on the default.
    mockReadPreferencesFile.mockResolvedValue({
      deferredToolsStandaloneChatsEnabled: false,
      defaultChatModelByProvider: {
        claude: { model: 'claude-default' },
        codex: { model: 'codex-default' },
        ollama: null,
      },
    });

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'new-portal-chat',
      message: 'Start with deferred tools disabled',
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ deferredToolsAllowed: false }),
    );
    const writtenTabs = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs;
    expect(
      writtenTabs?.find((tab) => tab.id === 'new-portal-chat'),
    ).toMatchObject({
      deferredToolsAllowed: false,
    });
  });

  it('resolves and persists the cowork approval default for a new Portal chat', async () => {
    mockedResolvePersistedApprovalMode.mockResolvedValueOnce('auto');

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'new-portal-chat',
      message: 'Start with the cowork approval default',
    });

    expect(mockedResolvePersistedApprovalMode).toHaveBeenCalledWith(
      'research',
      'new-portal-chat',
      undefined,
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'auto' }),
    );
    const writtenTabs = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs;
    expect(
      writtenTabs?.find((tab) => tab.id === 'new-portal-chat'),
    ).toMatchObject({
      approvalMode: 'auto',
    });
  });

  it('resolves an unscoped payload to the first project containing the chat', async () => {
    await sendStandaloneChatMessage({
      chatId: 'shared-chat',
      message: 'Use default',
    });

    expect(mockedCancelTransientRetriesForChatId).toHaveBeenCalledWith(
      'shared-chat',
      'manual-send',
    );

    // Workspace scan order comes from listCoworkWorkspacesAsChatProjects.
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-default',
        worktreeId: 'entry-d',
        chatId: 'shared-chat',
      }),
    );
  });

  it('invalidates unscoped retries before scanning projects on send', async () => {
    let resolveProjects: (
      projects: Awaited<ReturnType<typeof listCoworkWorkspacesAsChatProjects>>,
    ) => void = (): void => undefined;
    mockedListProjects.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }),
    );

    const sendPromise = sendStandaloneChatMessage({
      chatId: 'shared-chat',
      message: 'Use default',
    });

    expect(mockedCancelTransientRetriesForChatId).toHaveBeenCalledWith(
      'shared-chat',
      'manual-send',
    );
    resolveProjects([
      {
        id: 'cowork-default',
        name: 'Default',
        createdAt: '2026-05-08T00:00:00.000Z',
      },
    ]);
    await sendPromise;
  });

  it('invalidates unscoped retries before scanning projects on Stop', async () => {
    let resolveProjects: (
      projects: Awaited<ReturnType<typeof listCoworkWorkspacesAsChatProjects>>,
    ) => void = (): void => undefined;
    mockedListProjects.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }),
    );

    const cancelPromise = cancelStandaloneChat({ chatId: 'shared-chat' });

    expect(mockedCancelTransientRetriesForChatId).toHaveBeenCalledWith(
      'shared-chat',
      'stop',
    );
    resolveProjects([
      {
        id: 'cowork-default',
        name: 'Default',
        createdAt: '2026-05-08T00:00:00.000Z',
      },
    ]);
    await cancelPromise;
  });

  it('opens a brand-new chat in a targeted existing work entry', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'brand-new-chat',
      workEntryId: 'entry-r',
      message: 'Hello',
    });

    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'brand-new-chat',
      }),
    );
  });

  it('refuses a targeted work entry that no longer exists before writing', async () => {
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'brand-new-chat',
        workEntryId: 'entry-deleted',
        message: 'Hello',
      }),
    ).rejects.toThrow('The selected work entry is no longer available');

    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('creates a grouped work entry through the existing owner for a brand-new chat', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'brand-new-chat',
      message: 'Hello',
      sidebarItemGroupId: 'grp-review',
    });

    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      'research',
      expect.objectContaining({
        id: 'brand-new-chat',
        sidebarItemGroupId: 'grp-review',
      }),
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'brand-new-chat',
        chatId: 'brand-new-chat',
      }),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.standaloneChatMetaUpdated,
      {
        projectId: 'research',
        chatId: 'brand-new-chat',
      },
    );
    expect(mockedScheduleChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'brand-new-chat',
        chatId: 'brand-new-chat',
        standaloneChatProjectId: 'research',
      }),
    );
    const persistDescription =
      mockedScheduleChatSummary.mock.calls[0]?.[0].persistDescription;
    expect(typeof persistDescription).toBe('function');
    if (!persistDescription) {
      throw new Error('Expected a durable description callback');
    }
    mockedReadChatTabsFile.mockResolvedValueOnce(
      chatTabsFile([
        chatTab({
          id: 'brand-new-chat',
          title: 'Hello',
          text: 'Hello',
          timestamp: 20,
        }),
      ]),
    );
    await persistDescription('Generated cowork description');
    expect(mockedWriteChatTabsFile).toHaveBeenLastCalledWith(
      'research',
      'brand-new-chat',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            id: 'brand-new-chat',
            description: 'Generated cowork description',
          }),
        ],
      }),
    );
  });

  // The portal's Chats row for a chat its first send creates comes from this
  // delta. It must leave before the turn is dispatched, not when the turn
  // ends, and carry the Work Entry title desktop labels the row with
  // (CAN-3108).
  it('projects a brand-new chat and its Work Entry before the turn dispatches', async () => {
    mockedListWorkEntryChatSummaries.mockResolvedValue([
      {
        entryId: 'brand-new-chat',
        title: 'Hello',
        order: 0,
        createdAt: new Date(40).toISOString(),
        chats: [],
      },
    ]);
    let projectedAtDispatch: Record<string, unknown>[] = [];
    mockedDispatchWorktreeChatTurn.mockImplementationOnce(() => {
      projectedAtDispatch = mockedEnqueuePortalEvent.mock.calls.flatMap(
        ([event]) => {
          const payload: unknown = event.payload;
          if (
            event.type !== 'portal.state.delta' ||
            !isRecord(payload) ||
            payload.scope !== 'standalone_chat' ||
            !Array.isArray(payload.entities)
          ) {
            return [];
          }
          return payload.entities.flatMap((entity: unknown) =>
            isRecord(entity) &&
            entity.localId === 'brand-new-chat' &&
            isRecord(entity.payload)
              ? [entity.payload]
              : [],
          );
        },
      );
      return Promise.resolve();
    });

    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'brand-new-chat',
      message: 'Hello',
    });

    expect(projectedAtDispatch[0]).toMatchObject({
      projectLocalId: 'research',
      chatId: 'brand-new-chat',
      title: 'Hello',
      workEntryId: 'brand-new-chat',
      workEntryTitle: 'Hello',
      hasActiveChat: true,
    });
  });

  it.each(['brand-new-plan-chat', 'shared-chat'])(
    'persists automation plan mode on %s before dispatch',
    async (chatId) => {
      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId,
        message: 'Make a plan',
        planMode: true,
        initiationSource: 'automation',
      });
      const persisted = mockedWriteChatTabsFile.mock.calls.find(([, , file]) =>
        file.tabs.some((tab) => tab.id === chatId && tab.planMode === true),
      );
      expect(persisted).toBeDefined();
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ planMode: true }),
      );
    },
  );

  it('rejects a brand-new chat targeting a project that no longer exists (CAN-1989)', async () => {
    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'ghost-workspace',
        chatId: 'brand-new-chat',
        message: 'Hello',
      }),
    ).rejects.toThrow('no longer available');

    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('still creates a brand-new chat in an existing project after the availability guard (CAN-1989)', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'cowork-default',
      chatId: 'guarded-new-chat',
      message: 'Hello',
    });

    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      'cowork-default',
      expect.objectContaining({ id: 'guarded-new-chat' }),
    );
  });

  it('returns the actual Work Entry id when a same-id empty entry is reused', async () => {
    mockedCreateWorkEntry.mockResolvedValueOnce({
      entry: {
        id: 'same-id-chat',
        title: 'New Chat',
        createdAt: '2026-05-08T00:00:00.000Z',
        chatCount: 0,
        chats: [],
      },
      reusedExistingEmpty: true,
    });

    const result = await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'same-id-chat',
      message: 'Hello',
    });

    expect(result).toMatchObject({
      ok: true,
      chatId: 'same-id-chat',
      workEntryId: 'same-id-chat',
    });
    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      'research',
      expect.objectContaining({ id: 'same-id-chat' }),
    );
  });

  it('keeps display projection out of the description mutation queue', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'serialized-chat',
      message: 'Hello',
    });

    const persistDescription =
      mockedScheduleChatSummary.mock.calls[0]?.[0].persistDescription;
    const dispatchOptions = mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0];
    if (!persistDescription || !dispatchOptions?.onBeforeChatEvent) {
      throw new Error('Expected description and provider event callbacks');
    }

    const initialWrite: ChatTabsFile | undefined =
      mockedWriteChatTabsFile.mock.calls[
        mockedWriteChatTabsFile.mock.calls.length - 1
      ]?.[2];
    if (!initialWrite) {
      throw new Error('Expected the initial chat write');
    }
    let persistedTabsFile: ChatTabsFile = initialWrite;
    let releaseDescriptionWrite = (): void => undefined;
    let markDescriptionWriteStarted = (): void => undefined;
    const descriptionWriteGate = new Promise<void>((resolve) => {
      releaseDescriptionWrite = resolve;
    });
    const descriptionWriteStarted = new Promise<void>((resolve) => {
      markDescriptionWriteStarted = resolve;
    });
    let shouldBlockDescriptionWrite = true;
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      async (_workspaceId, _entryId, tabsFile) => {
        const serializedTab = tabsFile.tabs.find(
          (tab) => tab.id === 'serialized-chat',
        );
        if (
          shouldBlockDescriptionWrite &&
          serializedTab?.description === 'Generated description'
        ) {
          shouldBlockDescriptionWrite = false;
          markDescriptionWriteStarted();
          await descriptionWriteGate;
        }
        persistedTabsFile = tabsFile;
      },
    );

    const descriptionPromise = persistDescription('Generated description');
    await descriptionWriteStarted;
    const readsBeforeAssistantEvent = mockedReadChatTabsFile.mock.calls.length;
    const providerEvent = {
      type: 'assistant',
      message_id: 'provider-message-1',
      message: { content: [{ type: 'text', text: 'Hi there.' }] },
    };
    await dispatchOptions.onBeforeChatEvent({
      projectId: 'research',
      worktreeId: 'serialized-chat',
      chatId: 'serialized-chat',
      sequenceNamespace: 'initial',
      sequence: 0,
      data: providerEvent,
    });
    dispatchOptions.onChatEvent?.({
      projectId: 'research',
      worktreeId: 'serialized-chat',
      chatId: 'serialized-chat',
      isTerminalEvent: false,
      data: providerEvent,
    });
    await Promise.resolve();
    expect(mockedReadChatTabsFile).toHaveBeenCalledTimes(
      readsBeforeAssistantEvent,
    );

    releaseDescriptionWrite();
    await descriptionPromise;

    const finalTab = persistedTabsFile.tabs.find(
      (tab) => tab.id === 'serialized-chat',
    );
    expect(finalTab?.description).toBe('Generated description');
    expect(ingestProviderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'serialized-chat',
        chatId: 'serialized-chat',
        data: providerEvent,
      }),
    );
  });

  it('rejects Portal sends to archived chats instead of recreating them', async () => {
    mockedResolveWorkEntryForChat.mockResolvedValueOnce({
      entryId: null,
      archivedInEntryId: 'entry-r',
    });

    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'archived-chat',
        message: 'Continue',
      }),
    ).rejects.toThrow('Archived standalone chats are read-only');

    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('rejects Portal sends to retained chat-history archives', async () => {
    mockedListHistoryChatIds.mockResolvedValueOnce(['legacy-chat']);

    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'legacy-chat',
        message: 'Continue',
      }),
    ).rejects.toThrow('Archived standalone chats are read-only');

    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('rejects Portal sends to retained pre-entry unified archives', async () => {
    mockedReadChatArchivesFile.mockResolvedValueOnce({
      version: 1,
      archived: [
        {
          tab: chatTab({
            id: 'legacy-unified-chat',
            title: 'Legacy unified chat',
            text: 'Archived message',
            timestamp: 30,
          }),
          archivedAt: '2026-05-08T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });

    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'legacy-unified-chat',
        message: 'Continue',
      }),
    ).rejects.toThrow('Archived standalone chats are read-only');

    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('persists automation info before scheduler-initiated standalone messages', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'automation-chat',
      message: 'Run the report',
      initiationSource: 'automation',
      automationName: 'Morning report',
    });

    const finalWrite =
      mockedWriteChatTabsFile.mock.calls[
        mockedWriteChatTabsFile.mock.calls.length - 1
      ];
    const tabsFile = finalWrite?.[2] as ChatTabsFile | undefined;
    const tab = tabsFile?.tabs.find((entry) => entry.id === 'automation-chat');

    expect(tab?.title).toBe('Run the report');
    expect(tab?.messages).toHaveLength(2);
    expect(tab?.messages[0]?.role).toBe('system');
    expect(tab?.messages[0]?.blocks[0]).toMatchObject({
      type: 'automation_info',
      activityName: 'Morning report',
    });
    expect(tab?.messages[1]?.blocks[0]).toMatchObject({
      type: 'text',
      text: 'Run the report',
    });
    expect(mockedScheduleChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'automation-chat',
        chatId: 'automation-chat',
        standaloneChatProjectId: 'research',
      }),
    );
  });

  it('resolves the standalone project by chat id when the payload is not scoped', async () => {
    await sendStandaloneChatMessage({
      chatId: 'research-only',
      message: 'Use owning project',
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'research-only',
      }),
    );
  });

  describe('setStandaloneChatModel (CAN-1219)', () => {
    beforeAll(() => {
      // `setStandaloneChatModel` rejects unknown model ids via
      // `resolveKnownModel`, so register a known model for the happy path.
      initClaudeModels([{ id: 'test-standalone-model', label: 'Test Model' }]);
      initCodexModels([
        { id: 'test-standalone-codex', label: 'Test Codex Model' },
      ]);
    });

    it.each(codexSpeedConfigs)(
      'uses the canonical model command to retain $speed across provider changes',
      async (modelConfig) => {
        mockedReadChatTabsFile.mockResolvedValue(
          chatTabsFile([
            {
              id: 'shared-chat',
              title: 'New Codex chat',
              createdAt: '2026-09-30T00:00:00.000Z',
              kind: 'chat',
              messages: [],
              model: 'test-standalone-codex',
              providerType: 'codex',
              modelConfig,
            },
          ]),
        );

        await setStandaloneChatModel({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          model: 'test-standalone-model',
        });

        expect(chatStateCommandMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'research',
            worktreeId: 'entry-r',
            command: {
              type: 'chat.set_model',
              tabId: 'shared-chat',
              model: 'test-standalone-model',
              providerType: 'claude',
              executionHarness: 'claude',
            },
          }),
        );
        expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
      },
    );

    it('commits the model canonically and re-projects the summary', async () => {
      const getWindow = jest.fn(() => null);
      const result = await setStandaloneChatModel(
        {
          projectLocalId: 'research',
          chatId: 'shared-chat',
          model: 'test-standalone-model',
        },
        { getWindow },
      );

      expect(result).toEqual({ ok: true });
      const commandCall = chatStateCommandMock.mock.calls[0]?.[0];
      expect(commandCall).toMatchObject({
        projectId: 'research',
        worktreeId: 'entry-r',
        command: {
          type: 'chat.set_model',
          tabId: 'shared-chat',
          model: 'test-standalone-model',
        },
      });
      // Re-projects a standalone_chat delta so a connected portal reconciles.
      // (The canonical command is asserted above — the mocked
      // re-read here returns the pre-command tab, so we only assert the delta is
      // emitted for the right chat/scope.)
      const portalEvent = mockedEnqueuePortalEvent.mock.calls[0]?.[0];
      expect(portalEvent).toMatchObject({
        type: 'portal.state.delta',
        payload: {
          scope: 'standalone_chat',
          target: { standaloneChatLocalId: 'shared-chat' },
          entities: [
            expect.objectContaining({
              entityType: 'standalone_chat',
              localId: 'shared-chat',
            }),
          ],
        },
      });
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        null,
        IPC_CHANNELS.standaloneChatMetaUpdated,
        { projectId: 'research', chatId: 'shared-chat' },
      );
    });

    it("persists the model's provider alongside it", async () => {
      await setStandaloneChatModel({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'test-standalone-model',
      });

      // Writing `{ ...tab, model }` alone left `providerType` on the PREVIOUS
      // provider after a cross-provider pick, and nothing else on this path
      // rewrites it. The stale pair then made the summary project a provider
      // that disagreed with its own `modelLabel`, and made an inheriting send
      // dispatch the model under the wrong provider.
      expect(chatStateCommandMock.mock.calls[0]?.[0]).toMatchObject({
        command: {
          model: 'test-standalone-model',
          providerType: 'claude',
        },
      });
    });

    it('rejects a cross-harness model change and keeps a model-less send on the captured harness', async () => {
      let persistedTabsFile = chatTabsFile([
        {
          ...chatTab({
            id: 'shared-chat',
            title: 'Research Chat',
            text: 'Research message',
            timestamp: 20,
          }),
          model: 'test-standalone-codex',
          providerType: 'codex',
          executionHarness: 'codex',
        },
      ]);
      mockedReadChatTabsFile.mockImplementation(() =>
        Promise.resolve(persistedTabsFile),
      );
      mockedWriteChatTabsFile.mockImplementation(
        (_workspaceId, _entryId, tabsFile) => {
          persistedTabsFile = tabsFile;
          return Promise.resolve();
        },
      );

      await expect(
        setStandaloneChatModel({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          model: 'test-standalone-model',
        }),
      ).rejects.toThrow(/execution harness/i);
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();

      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Continue on the captured harness',
      });

      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-standalone-codex',
          executionHarness: 'codex',
        }),
      );
    });

    it('captures the selected model harness on an unstarted tab', async () => {
      mockedGetActiveChatIds.mockReturnValue([]);
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'shared-chat',
            title: 'New Chat',
            createdAt: '2026-05-08T00:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ]),
      );

      await setStandaloneChatModel({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'test-standalone-model',
      });

      expect(chatStateCommandMock.mock.calls[0]?.[0]).toMatchObject({
        command: {
          model: 'test-standalone-model',
          providerType: 'claude',
          executionHarness: 'claude',
        },
      });
    });

    it('does not acknowledge or broadcast a rejected canonical model change', async () => {
      chatStateCommandMock.mockResolvedValue({
        outcome: 'rejected',
        reason: 'Chat scope is being deleted',
      });

      await expect(
        setStandaloneChatModel({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          model: 'test-standalone-model',
        }),
      ).rejects.toThrow('Chat scope is being deleted');
      expect(mockedSendToWindow).not.toHaveBeenCalled();
      expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    });

    it('rejects an unknown model id before writing', async () => {
      await expect(
        setStandaloneChatModel({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          model: 'not-a-real-model',
        }),
      ).rejects.toThrow('model must be a known model id.');
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    });

    it('authorizes the model against the targeted chat owner before writing', async () => {
      const owner = {
        kind: 'organization' as const,
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      };
      mockResolveAiCreditsScopeOwner.mockResolvedValue(owner);
      blockedModelIds.add('test-standalone-model');

      await expect(
        setStandaloneChatModel({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          model: 'test-standalone-model',
        }),
      ).rejects.toThrow('This model is blocked by your organization policy.');

      expect(mockResolveAiCreditsScopeOwner).toHaveBeenCalledWith({
        kind: 'work',
        projectId: 'research',
        worktreeId: 'entry-r',
        chatId: 'shared-chat',
      });
      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        'test-standalone-model',
        owner,
      );
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    });

    it('rejects a model excluded by the targeted chat gateway before writing', async () => {
      mockCheckModelGatewayRoute.mockResolvedValue({
        ok: false,
        message: 'Research requires its configured gateway.',
      });

      await expect(
        setStandaloneChatModel({
          projectLocalId: 'research',
          chatId: 'shared-chat',
          model: 'test-standalone-model',
        }),
      ).rejects.toThrow('Research requires its configured gateway.');

      expect(mockCheckModelGatewayRoute).toHaveBeenCalledWith(
        'test-standalone-model',
        { kind: 'personal' },
      );
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    });
  });

  /**
   * Direct coverage for the shared cowork policy resolver (CAN-2318).
   *
   * These deliberately do NOT go through the Portal adapter.
   * `chat-adapter.test.ts` `jest.mock`s this whole module, so every
   * standalone-send assertion there feeds canned `{ readable, models }` and
   * never executes a line of the resolver — the tab read, the provider
   * narrowing, the candidate set, and the `readable: false` branch were all
   * unverified. Two independent reviewers then reached OPPOSITE conclusions
   * about whether it fails open or closed, which is exactly the failure mode
   * an untested resolver produces.
   */
  // CAN-2318. The Portal adapter's preflight gives a precise client error, but
  // it is not on every path: automations call this service directly, and a
  // queued send is validated at enqueue time yet drains later, by which point
  // the model may have been blocked. Re-checking at the durable-write boundary
  // is what actually keeps a blocked prompt from being recorded.
  it('refuses a blocked model before minting a Work Entry', async () => {
    blockedModelIds.add('blocked-model');

    await expect(
      sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Direct service call, no adapter preflight',
        model: 'blocked-model',
      }),
    ).rejects.toThrow('This model is blocked by your organization policy.');

    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('sends when the resolved model is permitted', async () => {
    await sendStandaloneChatMessage({
      projectLocalId: 'research',
      chatId: 'shared-chat',
      message: 'Nothing blocked here',
      model: 'permitted-model',
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
  });

  describe('resolveStandaloneChatPolicyModels (CAN-2318)', () => {
    const preferencesWithDefaults = (overrides?: {
      claude?: string;
      codex?: string;
      ollama?: string | null;
    }): unknown => ({
      deferredToolsStandaloneChatsEnabled: true,
      defaultChatModelByProvider: {
        claude: { model: overrides?.claude ?? 'claude-default' },
        codex: { model: overrides?.codex ?? 'codex-default' },
        ollama:
          overrides?.ollama === undefined
            ? { model: 'ollama-default' }
            : overrides.ollama === null
              ? null
              : { model: overrides.ollama },
      },
    });

    it('judges only the explicit model, never a default alongside it', async () => {
      mockReadPreferencesFile.mockResolvedValue(preferencesWithDefaults());

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'explicitly-picked',
      });

      expect(result.readable).toBe(true);
      // An explicit pick is what dispatch runs, so the resolved default must
      // NOT join the judged set — refusing over a model the turn never reaches
      // is a permanent outage with no client-side remedy.
      expect(result.models).toEqual(['explicitly-picked']);
      expect(result.noDispatchableModel).toBeUndefined();
    });

    it('reports a dead end for an EXPLICIT model when no lane can pay (round-3 finding 7)', async () => {
      // The old early return made `noDispatchableModel` unreachable here, so a
      // user with no usable billing lane still minted a Work Entry and
      // persisted the user message before dispatch threw.
      //
      // A concrete model is judged by ITS OWN lanes, so the dead end comes
      // from `resolveConcreteModelDispatchability`, not from empty defaults —
      // the default lane is not what this send would run.
      concreteModelDispatchability = 'no-billing-lane';
      mockReadPreferencesFile.mockResolvedValue({
        deferredToolsStandaloneChatsEnabled: true,
        defaultChatModelByProvider: { claude: null, codex: null, ollama: null },
      });

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'explicitly-picked',
      });

      expect(result.readable).toBe(false);
      expect(result.noDispatchableModel).toEqual({ missing: 'billing-lane' });
    });

    it('reports a dead end for a PERSISTED tab model when no lane can pay (round-3 finding 7)', async () => {
      // The ordinary path for an established cowork chat: a saved model, and
      // every billing source since gone away. Judged by the persisted model's
      // own lanes, exactly as the explicit-pick spec above.
      concreteModelDispatchability = 'no-billing-lane';
      mockedReadChatTabsFile.mockImplementation(
        (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> =>
          workspaceId === 'research' && worktreeId === 'entry-r'
            ? Promise.resolve(
                chatTabsFile([
                  {
                    ...chatTab({
                      id: 'shared-chat',
                      title: 'Research Chat',
                      text: 'Research message',
                      timestamp: 20,
                    }),
                    model: 'persisted-model',
                  },
                ]),
              )
            : Promise.resolve(chatTabsFile([])),
      );
      mockReadPreferencesFile.mockResolvedValue({
        deferredToolsStandaloneChatsEnabled: true,
        defaultChatModelByProvider: { claude: null, codex: null, ollama: null },
      });

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
      });

      expect(result.readable).toBe(false);
      expect(result.noDispatchableModel).toEqual({ missing: 'billing-lane' });
    });

    it('judges the dispatch default when the payload names no model', async () => {
      mockReadPreferencesFile.mockResolvedValue(preferencesWithDefaults());

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
      });

      expect(result.readable).toBe(true);
      // The portal payload carries no `providerType`, so dispatch resolves
      // 'claude' — that default is the one that must be judged.
      expect(result.models).toContain('claude-default');
    });

    it('judges an explicit providerType against that provider default', async () => {
      mockReadPreferencesFile.mockResolvedValue(preferencesWithDefaults());

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        providerType: 'codex',
      });

      expect(result.readable).toBe(true);
      expect(result.models).toContain('codex-default');
      expect(result.models).not.toContain('claude-default');
    });

    it("judges exactly one default — the tab's provider, when it has no model", async () => {
      // A modelless tab dispatches `sentTab.providerType`'s default, so that
      // is the one default to judge. Judging BOTH it and the caller's was the
      // earlier bug: `codex` is a REQUIRED key in `ModelDefaultsByProvider`,
      // so a Codex default always exists and a Claude-only org blocks it —
      // refusing every send from a chat that had ever persisted 'codex'.
      mockedReadChatTabsFile.mockImplementation(
        (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> => {
          if (workspaceId === 'research' && worktreeId === 'entry-r') {
            return Promise.resolve(
              chatTabsFile([
                {
                  ...chatTab({
                    id: 'shared-chat',
                    title: 'Research Chat',
                    text: 'Research message',
                    timestamp: 20,
                  }),
                  providerType: 'codex',
                },
              ]),
            );
          }
          return Promise.resolve(chatTabsFile([]));
        },
      );
      mockReadPreferencesFile.mockResolvedValue(preferencesWithDefaults());

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
      });

      expect(result.readable).toBe(true);
      expect(result.models).toEqual(['codex-default']);
    });

    it('judges only the explicit model, not the tab or any default', async () => {
      mockedReadChatTabsFile.mockImplementation(
        (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> => {
          if (workspaceId === 'research' && worktreeId === 'entry-r') {
            return Promise.resolve(
              chatTabsFile([
                {
                  ...chatTab({
                    id: 'shared-chat',
                    title: 'Research Chat',
                    text: 'Research message',
                    timestamp: 20,
                  }),
                  model: 'pinned-on-tab',
                },
              ]),
            );
          }
          return Promise.resolve(chatTabsFile([]));
        },
      );
      mockReadPreferencesFile.mockResolvedValue(preferencesWithDefaults());

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'explicitly-picked',
      });

      // `upsertStandaloneMessages` overwrites the tab with the explicit model
      // and dispatch runs it, so neither the stale tab model nor any default
      // can execute. Judging them would refuse a send that runs a PERMITTED
      // model — the same asymmetry the provider-default fix removed.
      expect(result.models).toEqual(['explicitly-picked']);
    });

    it("judges the tab's model alone, not it plus a default", async () => {
      mockedReadChatTabsFile.mockImplementation(
        (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> => {
          if (workspaceId === 'research' && worktreeId === 'entry-r') {
            return Promise.resolve(
              chatTabsFile([
                {
                  ...chatTab({
                    id: 'shared-chat',
                    title: 'Research Chat',
                    text: 'Research message',
                    timestamp: 20,
                  }),
                  model: 'pinned-on-tab',
                },
              ]),
            );
          }
          return Promise.resolve(chatTabsFile([]));
        },
      );
      mockReadPreferencesFile.mockResolvedValue(preferencesWithDefaults());

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
      });

      // Dispatch passes `request.model ?? sentTab.model`, so the pinned model
      // IS what runs — the default never does. Judging the default too would
      // refuse a permitted pick because an unrelated default was blocked,
      // which for mobile (it sends no `model`) is a permanent outage.
      expect(result.models).toEqual(['pinned-on-tab']);
    });

    it('dispatches the tab model when the caller names none', async () => {
      mockedReadChatTabsFile.mockImplementation(
        (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> => {
          if (workspaceId === 'research' && worktreeId === 'entry-r') {
            return Promise.resolve(
              chatTabsFile([
                {
                  ...chatTab({
                    id: 'shared-chat',
                    title: 'Research Chat',
                    text: 'Research message',
                    timestamp: 20,
                  }),
                  model: 'pinned-on-tab',
                  providerType: 'codex',
                },
              ]),
            );
          }
          return Promise.resolve(chatTabsFile([]));
        },
      );

      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Mobile sends neither model nor provider',
      });

      // The picker's selection has to reach dispatch, or the mobile model
      // picker is cosmetic: it persists through `set_model` and then every
      // send omits `model`, so the provider default used to run instead.
      //
      // `providerType` must NOT be inherited alongside it. A tab persisted
      // before `setStandaloneChatModel` kept the two in sync can hold a
      // provider that contradicts its model, and `resolveAgentModelRuntime`
      // gives an explicit `providerType` precedence over the model's own — so
      // passing the stale pair would start a Codex session running a Claude
      // model id. Leaving it undefined lets the provider derive from the model.
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'pinned-on-tab',
          providerType: undefined,
        }),
      );
    });

    it('does not pair a caller provider with the tab’s model', async () => {
      mockedReadChatTabsFile.mockImplementation(
        (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> => {
          if (workspaceId === 'research' && worktreeId === 'entry-r') {
            return Promise.resolve(
              chatTabsFile([
                {
                  ...chatTab({
                    id: 'shared-chat',
                    title: 'Research Chat',
                    text: 'Research message',
                    timestamp: 20,
                  }),
                  model: 'pinned-on-tab',
                },
              ]),
            );
          }
          return Promise.resolve(chatTabsFile([]));
        },
      );

      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        providerType: 'codex',
        message: 'Provider without a model, tab supplies the model',
      });

      // The caller named a provider but no model, so the model comes from the
      // tab — and the provider must derive from THAT model rather than from a
      // caller field that never described it.
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'pinned-on-tab',
          providerType: undefined,
        }),
      );
    });

    it('inherits the tab provider only when no model dispatches', async () => {
      mockedReadChatTabsFile.mockImplementation(
        (workspaceId: string, worktreeId: string): Promise<ChatTabsFile> => {
          if (workspaceId === 'research' && worktreeId === 'entry-r') {
            return Promise.resolve(
              chatTabsFile([
                {
                  ...chatTab({
                    id: 'shared-chat',
                    title: 'Research Chat',
                    text: 'Research message',
                    timestamp: 20,
                  }),
                  providerType: 'codex',
                },
              ]),
            );
          }
          return Promise.resolve(chatTabsFile([]));
        },
      );

      await sendStandaloneChatMessage({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        message: 'Modelless tab, provider picks the default',
      });

      // With no model to derive from, the tab's provider is what selects the
      // default — and it cannot contradict a model that is not being sent.
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: undefined,
          providerType: 'codex',
        }),
      );
    });

    it('reports unreadable when preferences cannot be read', async () => {
      mockReadPreferencesFile.mockRejectedValue(new Error('EACCES'));

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
      });

      // Callers must not read this as "no model": the dispatched model is
      // unknown, and `isModelBlockedByStoredPolicy(undefined)` answers false.
      expect(result.readable).toBe(false);
    });

    it('stays readable with an explicit model when preferences cannot be read', async () => {
      // The preferences file only decides a DEFAULT this send will not use, so
      // failing to read it must not become a policy-read refusal for a send
      // whose dispatched model is already known.
      mockReadPreferencesFile.mockRejectedValue(new Error('EACCES'));

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        model: 'explicitly-picked',
      });

      expect(result.readable).toBe(true);
      expect(result.models).toEqual(['explicitly-picked']);
    });

    it('reports unreadable when a policed provider has no concrete default', async () => {
      // Unreachable today — `normalizeModelDefaultsByProvider` always emits
      // claude/codex selections — but the guarantee lives in a distant
      // normalizer and its lapse would be SILENT: an undefined model is
      // "not blocked" everywhere downstream, so the provider's own implicit
      // default would execute unevaluated under an active policy.
      mockReadPreferencesFile.mockResolvedValue({
        deferredToolsStandaloneChatsEnabled: true,
        defaultChatModelByProvider: { claude: {}, codex: {}, ollama: null },
      });

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
      });

      expect(result.readable).toBe(false);
    });

    it('stays readable for Ollama, whose models are policy-exempt', async () => {
      mockReadPreferencesFile.mockResolvedValue(
        preferencesWithDefaults({ ollama: null }),
      );

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
        providerType: 'ollama',
      });

      // `ollama` is the one nullable selection, and Ollama models are exempt
      // at every layer — an absent Ollama default cannot leak a blocked model,
      // so refusing here would be a pure false positive.
      expect(result.readable).toBe(true);
    });

    it('reports a dead-end lane distinctly from an unreadable one (round-2 finding 16)', async () => {
      // Collapsing both into `readable: false` meant that without an org policy
      // the send proceeded, minted a durable Work Entry and persisted the user
      // message before throwing in dispatch — and WITH one it was refused as a
      // policy-read failure, the wrong diagnosis.
      mockReadPreferencesFile.mockResolvedValue({
        deferredToolsStandaloneChatsEnabled: true,
        defaultChatModelByProvider: { claude: null, codex: null, ollama: null },
      });

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'shared-chat',
      });

      expect(result.readable).toBe(false);
      expect(result.noDispatchableModel).toEqual({ missing: 'billing-lane' });
    });

    it('falls back to the dispatch default for an unresolvable chat', async () => {
      mockedResolveWorkEntryForChat.mockResolvedValue({
        entryId: null,
        archivedInEntryId: null,
      });
      mockReadPreferencesFile.mockResolvedValue(preferencesWithDefaults());

      const result = await resolveStandaloneChatPolicyModels({
        projectLocalId: 'research',
        chatId: 'no-such-chat',
      });

      // Read-only and never throws; the send itself fails on the same lookup
      // with a real error message. The target contributes no PERSISTED
      // candidate, but the default the send would dispatch is still judged —
      // asserting emptiness here would encode a guarantee the code does not
      // make.
      expect(result.readable).toBe(true);
      expect(result.models).toEqual(['claude-default']);
    });
  });
});

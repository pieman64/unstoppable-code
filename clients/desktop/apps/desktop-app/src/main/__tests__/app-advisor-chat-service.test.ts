import { withChatSendAdmission } from '../services/chat-send-admission';
import type { AgentSession, AgentSessionOptions } from '../agents/types';
import type * as AdvisorRuntime from '../app-advisor/runtime';
import type * as SessionManager from '../agents/session-manager';
import type {
  ApprovalMode,
  ApprovalRule,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
const mockOpenCodeAdmission = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve({ kind: 'native', supportedThinkingLevels: [] }),
);
jest.mock('../opencode/selection', (): unknown => ({
  assertOpenCodeSelectionAvailable: (input: unknown) =>
    mockOpenCodeAdmission(input),
}));
import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import { browserHandoffs } from '../browser/browser-handoffs';
import {
  capturePresentationTurn,
  clearPresentationTurn,
  recordPresentationTurn,
} from '../canopy-tools/presentation-state';
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type * as os from 'node:os';
import type * as ChatStateServiceModule from '../services/chat-state-service';
import type * as ChatStateV2RepositoryModule from '../services/chat-state-v2-repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderEventIngestResult } from '../services/chat-state-service';
import type { ChatQueueRevivalLease } from '../services/chat-queue-service';

let mockChatStateServiceOverride: object | undefined;
import type {
  CanonicalChatStartedEvent,
  CanonicalChatTerminalEvent,
  ChatWatcherEvidence,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';

const handleCanonicalChatStartedEventMock = jest.fn<
  Promise<void>,
  [CanonicalChatStartedEvent]
>(() => Promise.resolve());
const handleCanonicalChatTerminalEventMock = jest.fn<
  Promise<void>,
  [CanonicalChatTerminalEvent]
>(() => Promise.resolve());
const claimNewChatStartedMock = jest.fn(() => Promise.resolve(true));
const captureChatWatcherEvidenceMock = jest.fn<
  Promise<ChatWatcherEvidence>,
  [unknown]
>(() => Promise.resolve({ sourceOwner: null, accountEpoch: 7 }));
const hasCanonicalTurnVisibleOutputMock = jest.fn<
  Promise<boolean | undefined>,
  [unknown, string]
>(() => Promise.resolve(false));
const getCanonicalInputAcceptedAtMock = jest.fn<
  Promise<string | undefined>,
  [unknown, string]
>(() => Promise.resolve('2026-10-16T12:00:00.000Z'));
const createLocalWatcherMock = jest.fn(() =>
  Promise.resolve({ id: 'approved-command-watcher' }),
);
const captureLocalExecutionScopeMock = jest.fn(() =>
  Promise.resolve({
    projectId: 'project-one',
    worktreeId: 'worktree-one',
    createdAt: '2026-10-24T00:00:00.000Z',
  }),
);
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: () => ({
    handleCanonicalChatStartedEvent: handleCanonicalChatStartedEventMock,
    handleCanonicalChatTerminalEvent: handleCanonicalChatTerminalEventMock,
    createLocalWatcher: createLocalWatcherMock,
    captureLocalExecutionScope: captureLocalExecutionScopeMock,
  }),
}));
jest.mock('../services/active-chat-input', () => ({
  resolveCanonicalChatAddress: (target: {
    worktreeId: string;
    chatId: string;
  }) =>
    Promise.resolve({
      botId: 'app_advisor',
      taskId: target.worktreeId,
      chatId: target.chatId,
    }),
  captureChatWatcherEvidence: (address: unknown) =>
    captureChatWatcherEvidenceMock(address),
  hasCanonicalTurnVisibleOutput: (target: unknown, sourceInputId: string) =>
    hasCanonicalTurnVisibleOutputMock(target, sourceInputId),
  getCanonicalInputAcceptedAt: (target: unknown, sourceInputId: string) =>
    getCanonicalInputAcceptedAtMock(target, sourceInputId),
  getCanonicalChatTerminalDisposition: (
    _data: unknown,
    status: string,
    hasVisibleOutput?: boolean,
  ) =>
    status === 'failure'
      ? 'error'
      : status !== 'success'
        ? 'interrupted'
        : hasVisibleOutput === false
          ? 'no_output'
          : 'completed',
}));

const releaseResourceMock = jest.fn();
const reserveChatTurnStartMock = jest.fn(() =>
  Promise.resolve({ release: releaseResourceMock }),
);
const sendMessageMock = jest.fn();
const setPlanModeMock = jest.fn(() => Promise.resolve());
const setApprovalModeMock = jest.fn(() => Promise.resolve());
const setCodexIdleMock = jest.fn(() => Promise.resolve());
const mockCreateCodexSession = jest.fn<AgentSession, [AgentSessionOptions]>();
jest.mock('../agents/codex-session', () => ({
  CodexProvider: jest.fn(() => ({ createSession: mockCreateCodexSession })),
}));
const startChatTurnMock = jest.fn<void, [Record<string, unknown>]>();
const openAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: true, focused: true }),
);
const ensureAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: false, focused: false }),
);
const ensureChatForTrustedSendMock = jest.fn<Promise<void>, [args: unknown]>(
  () => Promise.resolve(),
);
const ingestProviderEventMock = jest.fn<Promise<boolean>, [input?: unknown]>(
  () => Promise.resolve(true),
);
// Delivery reads the typed result; by default it mirrors the boolean commit
// mock so existing commit expectations keep their meaning.
const ingestResultFromCommit = async (
  input: unknown,
): Promise<ProviderEventIngestResult> => {
  const applied = await ingestProviderEventMock(input);
  const data =
    typeof input === 'object' && input !== null && 'data' in input
      ? input.data
      : undefined;
  const isRecordData =
    typeof data === 'object' && data !== null && !Array.isArray(data);
  const isStartingPickup =
    isRecordData &&
    'type' in data &&
    data.type === 'canopy_input_delivery' &&
    'phase' in data &&
    data.phase === 'picked-up' &&
    'startsTurn' in data &&
    data.startsTurn === true;
  const pickupRejectedByRouter =
    isRecordData &&
    'turnRootAccepted' in data &&
    data.turnRootAccepted === false;

  return {
    outcome: applied ? 'applied' : 'not-applied',
    ...(isStartingPickup
      ? { pickup: applied && !pickupRejectedByRouter ? 'accepted' : 'rejected' }
      : {}),
  };
};
const ingestProviderEventWithResultMock = jest.fn(ingestResultFromCommit);
const hasMutationMock = jest.fn(() => Promise.resolve(false));
const updateCompatibilityTabMock = jest.fn(() =>
  Promise.resolve({ updated: false }),
);
const observeChatEventMock = jest.fn();
const recordSessionDiagnosticMock = jest.fn();
const completeChatTurnMock = jest.fn();
const commitTurnPauseMock = jest.fn(() => Promise.resolve());
const runWithScopeActivityMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () =>
    mockChatStateServiceOverride ?? {
      runWithScopeActivity: runWithScopeActivityMock,
      ensureChatForTrustedSend: ensureChatForTrustedSendMock,
      hasMutation: hasMutationMock,
      ingestProviderEvent: ingestProviderEventMock,
      ingestProviderEventWithResult: ingestProviderEventWithResultMock,
      claimNewChatStarted: claimNewChatStartedMock,
      updateCompatibilityTab: updateCompatibilityTabMock,
      // Approval prompts commit their canonical turn pause before publishing.
      commitTurnPause: commitTurnPauseMock,
    },
}));

const mockConsumeClaudeForkMarker = jest.fn();
jest.mock('../lib/claude-fork-session-marker', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../lib/claude-fork-session-marker',
  ),
  consumePersistedClaudeForkSessionMarker: (...args: unknown[]): unknown =>
    mockConsumeClaudeForkMarker(...args),
}));
jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: jest.fn(() => ({
    reserveChatTurnStart: reserveChatTurnStartMock,
  })),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      codexAppServerIdleTimeoutMinutes: 10,
      codexMultiAgentAppAdvisorEnabled: false,
      rtkEnabled: true,
    }),
  ),
}));
jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(() => '/mock/data'),
  // Real directory so the resolver's mkdir succeeds without side effects.
  getAppAdvisorHomeDir: jest.fn(() =>
    jest.requireActual<typeof os>('node:os').tmpdir(),
  ),
  getWorktreeAttachmentsDir: jest.fn(() => '/mock/attachments'),
  getWorktreeDataDir: jest.fn(() => '/mock/worktree-data'),
}));

jest.mock('../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
  hasPendingCodexContinuation: jest.fn(() => false),
  getChatSessionLiveness: jest.fn(() => ({
    foreground: false,
    background: false,
  })),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  destroySession: jest.fn(() => Promise.resolve()),
  restrictSessionApprovalRules: jest.fn(),
  getOrCreateSession: jest.fn(() => ({
    sendMessage: sendMessageMock,
    setPlanMode: setPlanModeMock,
    setApprovalMode: setApprovalModeMock,
    setCodexAppServerIdleTimeoutMinutes: setCodexIdleMock,
  })),
  shouldRecreateSessionOnNextTurn: jest.fn(() => false),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  getActiveSessionInfos: jest.fn(() => []),
  getSessionGlobalInstructionsSnapshot: jest.fn(() => undefined),
}));

const mockReadAuthorityTabs = jest.fn<Promise<ChatTabsFile>, []>();
jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: (
    _project: string,
    _worktree: string,
    mode?: ApprovalMode,
  ) => Promise.resolve(mode ?? 'auto'),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<Record<string, unknown>>('../lib/chat-tabs-reader'),
  readPersistedChatDispatchMetadata: jest.fn(() => Promise.resolve({})),
  readChatTabsFile: () => mockReadAuthorityTabs(),
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    observeChatEvent: observeChatEventMock,
    startChatTurn: startChatTurnMock,
    completeChatTurn: completeChatTurnMock,
    pauseChatTurn: jest.fn(),
    recordSessionDiagnostic: recordSessionDiagnosticMock,
    recordInjectedPromptForOpenChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
    startObservedTask: jest.fn(),
    finalizeObservedTask: jest.fn(),
  })),
}));

jest.mock('../ipc/standalone-chat', () => ({
  generateChatSummaryForProject: jest.fn(() =>
    Promise.resolve({ text: 'Summary', usage: {} }),
  ),
}));

jest.mock('../lib/worktree-chat-turn', () => ({
  scheduleChatSummary: jest.fn(),
}));

jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn(() => Promise.resolve(['entry-one'])),
  resolveWorkEntryForChat: jest.fn(() =>
    Promise.resolve({ entryId: 'entry-one', archivedInEntryId: null }),
  ),
}));

let portalActive = false;
const enqueuePortalEventMock = jest.fn<void, [unknown]>();
jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: (): boolean => portalActive,
  enqueuePortalEvent: (event: unknown): void => {
    enqueuePortalEventMock(event);
  },
  createPortalEvent: (type: string, payload: unknown): unknown => ({
    type,
    payload,
  }),
}));

const projectAppAdvisorChatSummariesMock = jest.fn<Promise<void>, [string]>(
  () => Promise.resolve(),
);
jest.mock('../services/chat-service', () => ({
  projectAppAdvisorChatSummaries: (entryId: string): Promise<void> =>
    projectAppAdvisorChatSummariesMock(entryId),
}));

jest.mock('../lib/agent-attachments', () => ({
  resolveAgentAttachmentsDir: jest.fn(() => '/mock/attachments'),
}));

jest.mock('../lib/app-advisor-workspace', () => ({
  ensureAppAdvisorHomeScaffold: jest.fn(() => Promise.resolve()),
}));

jest.mock('../app-advisor/runtime', () => ({
  createAppAdvisorToolRuntime: jest.fn(() => ({})),
}));

const isCursorRuntimeAvailableMock = jest.fn<Promise<boolean>, []>(() =>
  Promise.resolve(true),
);
jest.mock('../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> =>
    isCursorRuntimeAvailableMock(),
}));

jest.mock('../opencode/connection', (): unknown => ({
  assertOpenCodeModelAvailable: jest.fn(() =>
    Promise.resolve({ id: 'opencode:fixture%2Fmodel' }),
  ),
}));
jest.mock('../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initOpenCodeModels,
  initCopilotModels,
  isVisiblePersistedChatMessage,
  type AppAdvisorUiStateEnvelope,
  type ChatAgentSentInfo,
} from '@canopy/desktop-shared/types';
import {
  captureAppAdvisorSyntheticResultFence,
  dispatchAppAdvisorChatMessage,
  emitAppAdvisorSyntheticResultEvent,
} from '../app-advisor/chat-service';
import {
  destroySession,
  getActiveSessionInfos,
  getOrCreateSession,
  restrictSessionApprovalRules,
} from '../agents/session-manager';
import { readPersistedChatDispatchMetadata } from '../lib/chat-tabs-reader';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import { sendToWindowDetailed } from '../lib/window-send';
import { createAppAdvisorToolRuntime } from '../app-advisor/runtime';
import { isCopilotRuntimeAvailable } from '../copilot/runtime-availability';
import { sessionEventRouterTestExports } from '../agents/session-event-router';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  listWorkEntryIds,
  resolveWorkEntryForChat,
} from '../lib/cowork-work-entries';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  ChatDispatchAuthorizationRegistry,
  getChatDispatchAuthorization,
  type AuthorizedChatDispatch,
} from '../services/chat-dispatch-authorization';
import { getChatQueueService } from '../services/chat-queue-service';
import {
  clearLiveApprovalMode,
  getLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';

beforeAll(() => {
  initOpenCodeModels([
    {
      id: 'opencode:fixture%2Fmodel',
      rawModelId: 'fixture/model',
      label: 'Fixture',
      supportsVision: true,
      supportedThinkingLevels: [],
    },
  ]);
  initClaudeModels([{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }]);
  initCodexModels([
    { id: 'gpt-5.5', label: 'GPT 5.5' },
    { id: 'gpt-6-sol', label: 'GPT 6 Sol' },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' },
  ]);
  initCopilotModels([
    {
      id: 'copilot:fixture-model',
      rawModelId: 'fixture-model',
      label: 'Copilot fixture',
      supportsVision: false,
      supportedThinkingLevels: [],
    },
  ]);
  initCursorModels([
    { id: 'cursor-default', rawModelId: 'default[]', label: 'Cursor default' },
  ]);
});

/** Stands in for a queue-issued capability; every dispatch carries one. */
const TEST_DISPATCH_AUTHORIZATION: AuthorizedChatDispatch = {
  authorizationToken: Symbol('test dispatch'),
  scope: {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'entry-one',
    chatId: 'advisor-chat',
  },
  dispatchOwner: Symbol('test dispatch owner'),
  userMessageId: 'message-1',
  operationEpoch: 1,
  kind: 'ordinary',
};

beforeEach(() => {
  for (const [options] of jest.mocked(getOrCreateSession).mock.calls) {
    clearLiveApprovalMode(
      options.projectId,
      options.worktreeId,
      options.chatId,
    );
  }
  const emptyAuthorityTabs: ChatTabsFile = {
    version: 1,
    activeTabId: '',
    tabs: [],
  };
  // Keep the legacy null active id in this empty authority fixture.
  Reflect.set(emptyAuthorityTabs, 'activeTabId', null);
  mockReadAuthorityTabs.mockReset().mockResolvedValue(emptyAuthorityTabs);
  jest.restoreAllMocks();
  deferredToolsReloadCoordinator.resetForTests();
  getChatQueueService().resetForTests();
  jest.clearAllMocks();
  // Authorize the test capability; any other goes to the real registry.
  const registry = getChatDispatchAuthorization();
  jest.spyOn(registry, 'consume').mockImplementation((authorization, target) =>
    authorization === TEST_DISPATCH_AUTHORIZATION
      ? {
          kind: 'authorized',
          ownership: {
            kind: 'dispatch',
            token: authorization.dispatchOwner,
            userMessageId: target.userMessageId,
            operationEpoch: authorization.operationEpoch,
            reason: 'awaiting-start',
          },
        }
      : ChatDispatchAuthorizationRegistry.prototype.consume.call(
          registry,
          authorization,
          target,
        ),
  );
  // This suite's queue has no bound ownership, so it would issue no
  // capability; a reload continuation gets the test one.
  jest
    .spyOn(getChatQueueService(), 'admitDirectDispatchWhenAllowed')
    .mockResolvedValue({
      authorization: TEST_DISPATCH_AUTHORIZATION,
      release: jest.fn(),
    });
  ensureChatForTrustedSendMock.mockResolvedValue(undefined);
  mockChatStateServiceOverride = undefined;
  ingestProviderEventMock.mockResolvedValue(true);
  ingestProviderEventWithResultMock.mockReset();
  ingestProviderEventWithResultMock.mockImplementation(ingestResultFromCommit);
  hasMutationMock.mockResolvedValue(false);
  claimNewChatStartedMock.mockResolvedValue(true);
  captureChatWatcherEvidenceMock.mockResolvedValue({
    sourceOwner: null,
    accountEpoch: 7,
  });
  hasCanonicalTurnVisibleOutputMock.mockResolvedValue(false);
  getCanonicalInputAcceptedAtMock.mockResolvedValue('2026-10-16T12:00:00.000Z');
  jest.mocked(listWorkEntryIds).mockResolvedValue(['entry-one']);
  portalActive = false;
});

afterEach(() => {
  // App Advisor specs use the real queue singleton. Clear its scheduled drain
  // and gate-reconciliation timers so this suite leaves no worker handles.
  getChatQueueService().resetForTests();
  deferredToolsReloadCoordinator.resetForTests();
  sessionEventRouterTestExports.reset();
});

function makeOptions(): Parameters<typeof dispatchAppAdvisorChatMessage>[1] {
  const getMainWindow: Parameters<
    typeof dispatchAppAdvisorChatMessage
  >[1]['getMainWindow'] = () => null;
  const getAppAdvisorWindow: Parameters<
    typeof dispatchAppAdvisorChatMessage
  >[1]['getAppAdvisorWindow'] = () => null;
  return {
    authorization: TEST_DISPATCH_AUTHORIZATION,
    getMainWindow,
    getAppAdvisorWindow,
    toolSurfaces: {
      getMainWindow,
      getAppAdvisorWindow,
      openAppAdvisorWindow: openAppAdvisorWindowMock,
      ensureAppAdvisorWindow: ensureAppAdvisorWindowMock,
    },
  };
}

function configureClaudeSteeringSession(): void {
  jest.mocked(getOrCreateSession).mockResolvedValueOnce({
    sendMessage: sendMessageMock,
    cancel: jest.fn(),
    destroy: jest.fn(),
    setPlanMode: setPlanModeMock,
    setApprovalMode: setApprovalModeMock,
    setModel: jest.fn(),
    setThinkingLevel: jest.fn(),
    getSteeringCapabilities: () => ({
      provider: 'claude',
      generation: 'live',
      steer: true,
      withdraw: true,
      interrupt: true,
    }),
  });
}

describe('dispatchAppAdvisorChatMessage dispatch authorization', () => {
  it('refuses a capability the queue never issued before any session work', async () => {
    const forged = {
      authorizationToken: Symbol('forged dispatch'),
      scope: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'forged-advisor',
      },
      dispatchOwner: Symbol('forged owner'),
      userMessageId: 'forged-message',
      operationEpoch: 1,
      kind: 'ordinary' as const,
    };
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'forged-advisor',
          userMessageId: 'forged-message',
          text: 'Forged',
          providerType: 'claude',
          model: 'claude-opus-4-8',
        },
        { ...makeOptions(), authorization: forged },
      ),
    ).rejects.toMatchObject({
      outcome: { kind: 'refused', reason: 'authorization' },
    });
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it('refuses a dispatch without a capability before any session work', async () => {
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'unadmitted-advisor',
          userMessageId: 'unadmitted-message',
          text: 'Unadmitted',
          providerType: 'claude',
          model: 'claude-opus-4-8',
        },
        { ...makeOptions(), authorization: undefined },
      ),
    ).rejects.toThrow('Chat dispatch requires an admitted capability.');
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });
});

describe('Advisor browser handoff acceptance (CAN-4663)', () => {
  const origin = {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'entry-one',
    chatTabId: 'advisor-handoff',
  };
  const target = { projectId: 'project-one', worktreeId: 'worktree-one' };
  const request = {
    ...origin,
    chatId: origin.chatTabId,
    userMessageId: 'handoff-reply',
    text: 'Continue',
  };
  const pin = (browserId = 'browser-one') =>
    browserHandoffs.request({ ...target, browserId, origin }, jest.fn());

  afterEach(() => {
    browserHandoffs.releaseWorktree(target.projectId, target.worktreeId);
    clearPresentationTurn(
      `${origin.projectId}/${origin.worktreeId}/${origin.chatTabId}`,
    );
  });

  it.each(['user', 'portal', 'automation', 'hook'] as const)(
    'releases only an accepted human reply, with source %s',
    async (initiationSource) => {
      const handoff = pin();
      await dispatchAppAdvisorChatMessage(
        { ...request, initiationSource },
        makeOptions(),
      );
      expect(capturePresentationTurn(origin)?.source).toBe(initiationSource);
      expect(
        browserHandoffs.snapshot(target.projectId, target.worktreeId).handoff
          ?.handoffId,
      ).toBe(
        initiationSource === 'user' || initiationSource === 'portal'
          ? undefined
          : handoff.handoffId,
      );
    },
  );

  it('keeps the pin and clears provenance when provider admission rejects a reply', async () => {
    const handoff = pin();
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('Rejected reply');
    });
    await expect(
      dispatchAppAdvisorChatMessage(request, makeOptions()),
    ).rejects.toThrow('Rejected reply');
    expect(
      browserHandoffs.snapshot(target.projectId, target.worktreeId).handoff
        ?.handoffId,
    ).toBe(handoff.handoffId);
    expect(capturePresentationTurn(origin)).toBeUndefined();
  });

  it('does not release a replacement created while the accepted send is pending', async () => {
    pin();
    let replacementId: string | undefined;
    ensureChatForTrustedSendMock.mockImplementationOnce(() => {
      replacementId = pin('browser-two').handoffId;
      return Promise.resolve();
    });
    await dispatchAppAdvisorChatMessage(request, makeOptions());
    expect(replacementId).toBeDefined();
    expect(
      browserHandoffs.snapshot(target.projectId, target.worktreeId).handoff
        ?.handoffId,
    ).toBe(replacementId);
  });
});

describe('dispatchAppAdvisorChatMessage observability text', () => {
  it('publishes the first accepted visible input after its durable commit with original evidence and time', async () => {
    const acceptedAt = 1_800_000_000_000;
    getCanonicalInputAcceptedAtMock.mockResolvedValue(undefined);
    jest.spyOn(Date, 'now').mockReturnValue(acceptedAt);
    let release: (() => void) | undefined;
    ingestProviderEventMock.mockImplementation(async (input) => {
      if (
        typeof input === 'object' &&
        input !== null &&
        'mutationId' in input &&
        input.mutationId === 'canonical-start:root:accepted'
      ) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return true;
    });
    const dispatch = dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'canonical-start',
        userMessageId: 'root',
        text: 'Hello',
      },
      makeOptions(),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(release).toBeDefined();
    expect(handleCanonicalChatStartedEventMock).not.toHaveBeenCalled();
    jest.spyOn(Date, 'now').mockReturnValue(acceptedAt + 1000);
    release?.();
    await dispatch;
    expect(claimNewChatStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInputId: 'root',
        occurredAt: new Date(acceptedAt).toISOString(),
      }),
    );
    expect(handleCanonicalChatStartedEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'started',
        address: {
          botId: 'app_advisor',
          taskId: 'entry-one',
          chatId: 'canonical-start',
        },
        sourceInputId: 'root',
        occurredAt: new Date(acceptedAt).toISOString(),
        evidence: { sourceOwner: null, accountEpoch: 7 },
      }),
    );
  });

  it('does not publish another chat start when the durable first-input marker was already consumed', async () => {
    claimNewChatStartedMock.mockResolvedValueOnce(false);
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'canonical-existing',
        userMessageId: 'next',
        text: 'Hello',
      },
      makeOptions(),
    );
    expect(claimNewChatStartedMock).toHaveBeenCalledTimes(1);
    expect(handleCanonicalChatStartedEventMock).not.toHaveBeenCalled();
  });

  it.each(['pickup-terminal', 'terminal-pickup'] as const)(
    'correlates %s in stream order while persistence is blocked',
    async (order) => {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: `canonical-${order}`,
          userMessageId: 'original',
          text: 'Hello',
        },
        makeOptions(),
      );
      const call = jest.mocked(getOrCreateSession).mock.calls[0];
      if (!call) throw new Error('Missing session');
      let release: (() => void) | undefined;
      ingestProviderEventMock.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          }),
      );
      const terminalAt = 1_800_000_010_000;
      jest.spyOn(Date, 'now').mockReturnValue(terminalAt);
      void call[1]({ type: 'assistant_delta', content: 'Visible output' });
      const pickup = {
        type: 'canopy_input_delivery',
        phase: 'picked-up',
        startsTurn: true,
        turnRootAccepted: true,
        userMessageId: 'selected',
      };
      const terminal = { type: 'result', is_error: false };
      if (order === 'pickup-terminal') {
        void call[1](pickup);
        void call[1](terminal);
      } else {
        void call[1](terminal);
        void call[1](pickup);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handleCanonicalChatTerminalEventMock).not.toHaveBeenCalled();
      jest.spyOn(Date, 'now').mockReturnValue(terminalAt + 1000);
      release?.();
      await call[3]?.drainEventsBeforeRemoval?.();
      expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledTimes(1);
      expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'terminal',
          // A pickup moves the turn's root only once the session router
          // confirms its acceptance, which this unit dispatch does not model.
          sourceInputId: 'original',
          sourceInputAcceptedAt: '2026-10-16T12:00:00.000Z',
          occurredAt: new Date(terminalAt).toISOString(),
          evidence: { sourceOwner: null, accountEpoch: 7 },
        }),
      );
    },
  );

  it.each([
    [{ type: 'result', is_error: true, result: 'Failed' }, 'error'],
    [
      { type: 'result', is_error: true, terminal_reason: 'aborted_streaming' },
      'interrupted',
    ],
    [{ type: 'result', is_error: false }, 'no_output'],
  ])(
    'publishes a durable terminal with disposition %s',
    async (data, disposition) => {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'canonical-disposition',
          userMessageId: 'root',
          text: 'Hello',
        },
        makeOptions(),
      );
      const call = jest.mocked(getOrCreateSession).mock.calls[0];
      if (!call) throw new Error('Missing session');
      void call[1](data);
      await call[3]?.drainEventsBeforeRemoval?.();
      expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ sourceInputId: 'root', disposition }),
      );
      await emitAppAdvisorSyntheticResultEvent(
        'canonical-disposition',
        makeOptions().toolSurfaces,
      );
      expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, undefined])(
    'does not report no_output for visible or unavailable output (%s)',
    async (visibleOutput) => {
      hasCanonicalTurnVisibleOutputMock.mockResolvedValueOnce(visibleOutput);
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'canonical-output',
          userMessageId: 'root',
          text: 'Hello',
        },
        makeOptions(),
      );
      const call = jest.mocked(getOrCreateSession).mock.calls[0];
      if (!call) throw new Error('Missing session');
      void call[1]({ type: 'result', is_error: false });
      await call[3]?.drainEventsBeforeRemoval?.();
      expect(hasCanonicalTurnVisibleOutputMock).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'canonical-output' }),
        'root',
      );
      expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ disposition: 'completed' }),
      );
    },
  );

  it.each(['not-applied', 'activity-only', 'failed'] as const)(
    'does not publish a terminal without durable applied evidence (%s)',
    async (outcome) => {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'canonical-rejected',
          userMessageId: 'root',
          text: 'Hello',
        },
        makeOptions(),
      );
      const call = jest.mocked(getOrCreateSession).mock.calls[0];
      if (!call) throw new Error('Missing session');
      if (outcome === 'failed')
        ingestProviderEventWithResultMock.mockRejectedValueOnce(
          new Error('Commit failed'),
        );
      else ingestProviderEventWithResultMock.mockResolvedValueOnce({ outcome });
      void call[1]({ type: 'result', is_error: false });
      await call[3]?.drainEventsBeforeRemoval?.();
      expect(handleCanonicalChatTerminalEventMock).not.toHaveBeenCalled();
    },
  );

  it('retains original acceptance evidence through deferred reload and emits only the final terminal', async () => {
    const request = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      chatId: 'canonical-reload',
      userMessageId: 'root',
      text: 'Hello',
    };
    await dispatchAppAdvisorChatMessage(request, makeOptions());
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    if (!call) throw new Error('Missing session');
    const reload = jest
      .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
      .mockReturnValue(true);
    let release: (() => void) | undefined;
    ingestProviderEventMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    void call[1]({ type: 'result', is_error: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    reload.mockReturnValue(false);
    release?.();
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(handleCanonicalChatTerminalEventMock).not.toHaveBeenCalled();
    captureChatWatcherEvidenceMock.mockResolvedValue({
      sourceOwner: null,
      accountEpoch: 99,
    });
    await dispatchAppAdvisorChatMessage(
      {
        ...request,
        deferredToolsReloadEnabledResources: [],
        deferredToolsReloadRequestId: 'reload',
      },
      makeOptions(),
    );
    const continuation = jest.mocked(getOrCreateSession).mock.calls[1];
    if (!continuation) throw new Error('Missing continuation');
    void continuation[1]({ type: 'result', is_error: false });
    await continuation[3]?.drainEventsBeforeRemoval?.();
    expect(handleCanonicalChatStartedEventMock).toHaveBeenCalledTimes(1);
    expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledTimes(1);
    expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInputId: 'root',
        evidence: { sourceOwner: null, accountEpoch: 7 },
      }),
    );
  });

  it('ignores repeated provider terminals for the same root input', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'canonical-repeat',
        userMessageId: 'root',
        text: 'Hello',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    if (!call) throw new Error('Missing session');
    void call[1]({ type: 'result', is_error: false });
    void call[1]({ type: 'result', is_error: false });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledTimes(1);
  });

  it('does not recapture acceptance evidence when the original root is picked up', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'canonical-original-pickup',
        userMessageId: 'root',
        text: 'Hello',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    if (!call) throw new Error('Missing session');
    captureChatWatcherEvidenceMock.mockResolvedValue({
      sourceOwner: null,
      accountEpoch: 99,
    });
    void call[1]({
      type: 'canopy_input_delivery',
      phase: 'picked-up',
      startsTurn: true,
      turnRootAccepted: true,
      userMessageId: 'root',
    });
    void call[1]({ type: 'result', is_error: false });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: { sourceOwner: null, accountEpoch: 7 },
      }),
    );
  });

  it('follows a committed Claude pickup into its autonomous root turn', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'selected', epoch: 4 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'steering-advisor',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'attempt',
      startsTurn: true,
      userMessageId: 'selected',
    });
    await onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'selected',
      message: {
        id: 'reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Selected reply' }],
      },
    });
    await onEvent({
      type: 'result',
      is_error: false,
      result: 'Done',
      canopy_turn_user_message_id: 'selected',
    });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(acceptTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'steering-advisor',
      }),
      'selected',
    );
    expect(confirmTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'steering-advisor' }),
      lease,
    );
    expect(rollbackTurnRevival).not.toHaveBeenCalled();
    expect(onTurnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'steering-advisor' }),
      'complete',
      'selected',
    );
    expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ turnUserMessageId: 'selected' }),
    );
  });

  it('reads pickup lease metadata before cloning a deferred-tools continuation event', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'continued-root', epoch: 5 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'continuation-pickup-advisor',
        userMessageId: 'original',
        text: 'Continue the existing turn',
        providerType: 'claude',
        model: 'claude-opus-4-8',
        deferredToolsReloadEnabledResources: [],
        deferredToolsReloadRequestId: 'continuation-pickup',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor continuation route');

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'continuation-attempt',
      startsTurn: true,
      userMessageId: 'continued-root',
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(acceptTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'continuation-pickup-advisor' }),
      'continued-root',
    );
    expect(confirmTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'continuation-pickup-advisor' }),
      lease,
    );
    expect(ingestProviderEventWithResultMock.mock.calls[0]?.[0]).toMatchObject({
      data: {
        type: 'canopy_input_delivery',
        canopy_turn_revival: true,
      },
      turnUserMessageId: 'original',
    });
  });

  it('keeps an adopted root after a repeated same-root pickup is rejected', async () => {
    const queue = getChatQueueService();
    const firstLease: ChatQueueRevivalLease = {
      rootId: 'adopted-root',
      epoch: 11,
    };
    const repeatLease: ChatQueueRevivalLease = {
      rootId: 'adopted-root',
      epoch: 12,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValueOnce({ accepted: true, lease: firstLease })
      .mockReturnValueOnce({ accepted: true, lease: repeatLease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'repeat-pickup-steering-advisor',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'first-attempt',
      startsTurn: true,
      userMessageId: 'adopted-root',
    });
    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'not-applied', pickup: 'rejected' };
      },
    );
    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'repeat-attempt',
      startsTurn: true,
      userMessageId: 'adopted-root',
    });
    await onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'adopted-root',
      message: {
        id: 'adopted-reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Continue the adopted turn' }],
      },
    });
    await onEvent({
      type: 'result',
      is_error: false,
      result: 'Adopted turn done',
      canopy_turn_user_message_id: 'adopted-root',
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(acceptTurnRevival).toHaveBeenCalledTimes(2);
    expect(confirmTurnRevival).toHaveBeenCalledTimes(1);
    expect(confirmTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'repeat-pickup-steering-advisor' }),
      firstLease,
    );
    expect(rollbackTurnRevival).not.toHaveBeenCalled();
    expect(ingestProviderEventWithResultMock.mock.calls[2]?.[0]).toMatchObject({
      data: { canopy_turn_user_message_id: 'adopted-root' },
      turnUserMessageId: 'adopted-root',
    });
    expect(onTurnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'repeat-pickup-steering-advisor' }),
      'complete',
      'adopted-root',
    );
  });

  it('keeps the initial execution root after its same-root pickup is rejected', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'initial-root', epoch: 13 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest.spyOn(queue, 'confirmTurnRevival');
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'initial-root-steering-advisor',
        userMessageId: 'initial-root',
        text: 'Initial turn',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'not-applied', pickup: 'rejected' };
      },
    );

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'unknown-attempt',
      startsTurn: true,
      userMessageId: 'initial-root',
    });
    await onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'initial-root',
      message: {
        id: 'initial-root-reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Existing turn continues' }],
      },
    });
    await onEvent({
      type: 'result',
      is_error: false,
      result: 'Initial turn done',
      canopy_turn_user_message_id: 'initial-root',
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(acceptTurnRevival).toHaveBeenCalledTimes(1);
    expect(confirmTurnRevival).not.toHaveBeenCalled();
    expect(rollbackTurnRevival).not.toHaveBeenCalled();
    expect(ingestProviderEventWithResultMock.mock.calls[1]?.[0]).toMatchObject({
      data: { canopy_turn_user_message_id: 'initial-root' },
      turnUserMessageId: 'initial-root',
    });
    expect(onTurnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'initial-root-steering-advisor' }),
      'complete',
      'initial-root',
    );
  });

  it('releases the execution root for an untagged normal terminal event', async () => {
    const queue = getChatQueueService();
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'untagged-terminal-advisor',
        userMessageId: 'current-root',
        text: 'Current turn',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');

    await onEvent({ type: 'result', is_error: false, result: 'Done' });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(onTurnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'untagged-terminal-advisor' }),
      'complete',
      'current-root',
    );
  });

  it('allows a rejected root retry pickup to be ingested and adopted', async () => {
    const queue = getChatQueueService();
    const rejectedLease: ChatQueueRevivalLease = {
      rootId: 'retry-root',
      epoch: 14,
    };
    const retryLease: ChatQueueRevivalLease = {
      rootId: 'retry-root',
      epoch: 15,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValueOnce({ accepted: true, lease: rejectedLease })
      .mockReturnValueOnce({ accepted: true, lease: retryLease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'retry-root-steering-advisor',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    ingestProviderEventWithResultMock
      .mockResolvedValueOnce({ outcome: 'not-applied', pickup: 'rejected' })
      .mockResolvedValueOnce({
        outcome: 'not-applied',
        pickup: 'already-accepted',
      })
      .mockResolvedValueOnce({ outcome: 'applied' });

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'rejected-attempt',
      startsTurn: true,
      userMessageId: 'retry-root',
      canopy_turn_user_message_id: 'retry-root',
    });
    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'accepted-retry-attempt',
      startsTurn: true,
      userMessageId: 'retry-root',
      canopy_turn_user_message_id: 'retry-root',
    });
    await onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'retry-root',
      message: {
        id: 'retry-reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Retry output continues' }],
      },
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(acceptTurnRevival).toHaveBeenCalledTimes(2);
    expect(confirmTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'retry-root-steering-advisor' }),
      retryLease,
    );
    expect(rollbackTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'retry-root-steering-advisor' }),
      rejectedLease,
    );
    expect(ingestProviderEventWithResultMock.mock.calls[2]?.[0]).toMatchObject({
      data: { canopy_turn_user_message_id: 'retry-root' },
      turnUserMessageId: 'retry-root',
    });
  });

  it('rolls back a current-root pickup when its accepted lease confirmation fails', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = {
      rootId: 'current-root',
      epoch: 16,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(false);
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'failed-current-confirm-advisor',
        userMessageId: 'current-root',
        text: 'Current turn',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    ingestProviderEventWithResultMock.mockResolvedValueOnce({
      outcome: 'applied',
      pickup: 'accepted',
    });

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'current-attempt',
      startsTurn: true,
      userMessageId: 'current-root',
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(acceptTurnRevival).toHaveBeenCalledTimes(1);
    expect(confirmTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'failed-current-confirm-advisor' }),
      lease,
    );
    expect(rollbackTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'failed-current-confirm-advisor' }),
      lease,
    );
  });

  it('honors a stamped rejected pickup without re-arbitrating the root', async () => {
    const queue = getChatQueueService();
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: false });
    const confirmTurnRevival = jest.spyOn(queue, 'confirmTurnRevival');
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    configureClaudeSteeringSession();

    try {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'stamped-rejected-steering-advisor',
          userMessageId: 'current',
          text: 'Current turn',
          providerType: 'claude',
          model: 'claude-opus-4-8',
        },
        makeOptions(),
      );
      const call = jest.mocked(getOrCreateSession).mock.calls[0];
      const onEvent = call?.[1];
      if (!onEvent) throw new Error('Expected Advisor route');
      ingestProviderEventWithResultMock.mockImplementationOnce(
        async (input: unknown) => {
          await ingestProviderEventMock(input);
          return { outcome: 'not-applied', pickup: 'rejected' };
        },
      );
      await onEvent({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'late-attempt',
        startsTurn: true,
        userMessageId: 'stale',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(acceptTurnRevival).toHaveBeenCalledTimes(1);
      expect(confirmTurnRevival).not.toHaveBeenCalled();
      expect(rollbackTurnRevival).not.toHaveBeenCalled();
      const refusalPresentation = jest
        .mocked(sendToWindowDetailed)
        .mock.calls.find(
          (call) =>
            call[1] === 'chat:event' &&
            typeof call[2] === 'object' &&
            call[2] !== null &&
            'data' in call[2] &&
            typeof call[2].data === 'object' &&
            call[2].data !== null &&
            'userMessageId' in call[2].data &&
            call[2].data.userMessageId === 'stale',
        )?.[2];
      expect(refusalPresentation).toMatchObject({
        chatId: 'stamped-rejected-steering-advisor',
        data: { userMessageId: 'stale', turnRootAccepted: false },
      });
      expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turnUserMessageId: 'current' }),
      );
    } finally {
      acceptTurnRevival.mockRestore();
    }
  });

  it('follows an already-accepted duplicate pickup even when it was not applied', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'selected', epoch: 7 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'already-accepted-steering-advisor',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'not-applied', pickup: 'already-accepted' };
      },
    );

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'duplicate-attempt',
      startsTurn: true,
      userMessageId: 'selected',
    });
    await onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'selected',
      message: {
        id: 'duplicate-reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'The accepted turn continues' }],
      },
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(acceptTurnRevival).toHaveBeenCalledTimes(1);
    expect(confirmTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'already-accepted-steering-advisor' }),
      lease,
    );
    expect(ingestProviderEventWithResultMock.mock.calls[1]?.[0]).toMatchObject({
      data: { canopy_turn_user_message_id: 'selected' },
      turnUserMessageId: 'selected',
    });
  });

  it('rolls back a rejected pickup before dropping its output and still drains terminal and idle cleanup', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'rejected-root', epoch: 8 };
    const newerLease: ChatQueueRevivalLease = {
      rootId: 'rejected-root',
      epoch: 9,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValueOnce({ accepted: true, lease })
      .mockReturnValueOnce({ accepted: true, lease: newerLease });
    const confirmTurnRevival = jest.spyOn(queue, 'confirmTurnRevival');
    const rollbackTurnRevival = jest
      .spyOn(queue, 'rollbackTurnRevival')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    const reconcileSessionActivity = jest.spyOn(
      queue,
      'reconcileSessionActivity',
    );
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'rejected-steering-advisor',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'not-applied', pickup: 'rejected' };
      },
    );

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'rejected-attempt',
      startsTurn: true,
      userMessageId: 'rejected-root',
    });
    expect(rollbackTurnRevival).toHaveBeenCalledTimes(1);
    expect(rollbackTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'rejected-steering-advisor' }),
      lease,
    );
    expect(confirmTurnRevival).not.toHaveBeenCalled();

    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'not-applied', pickup: 'rejected' };
      },
    );
    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'rejected-retry-attempt',
      startsTurn: true,
      userMessageId: 'rejected-root',
    });
    expect(acceptTurnRevival).toHaveBeenCalledTimes(2);
    expect(rollbackTurnRevival).toHaveBeenCalledTimes(2);
    expect(rollbackTurnRevival).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: 'rejected-steering-advisor' }),
      newerLease,
    );

    ingestProviderEventWithResultMock.mockClear();
    ingestProviderEventMock.mockClear();
    jest.mocked(sendToWindowDetailed).mockClear();
    await onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'rejected-root',
      message: {
        id: 'rejected-reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Do not commit this output' }],
      },
    });
    await onEvent({
      type: 'result',
      is_error: false,
      result: 'Rejected root terminal',
      canopy_turn_user_message_id: 'rejected-root',
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(ingestProviderEventWithResultMock).not.toHaveBeenCalled();
    expect(ingestProviderEventMock).not.toHaveBeenCalled();
    expect(sendToWindowDetailed).not.toHaveBeenCalled();
    expect(rollbackTurnRevival).toHaveBeenCalledTimes(3);
    expect(rollbackTurnRevival).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: 'rejected-steering-advisor' }),
      lease,
    );
    expect(onTurnTerminal).not.toHaveBeenCalled();

    ingestProviderEventWithResultMock.mockClear();
    await onEvent({
      type: 'system',
      subtype: 'status',
      status: 'idle',
      canopy_turn_user_message_id: 'rejected-root',
    });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(ingestProviderEventWithResultMock).not.toHaveBeenCalled();
    expect(reconcileSessionActivity).toHaveBeenCalledTimes(1);
  });

  it('ingests an owned delegation snapshot tagged with a rejected root', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'rejected-root', epoch: 8 };
    jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValueOnce({ accepted: true, lease });
    const rollbackTurnRevival = jest
      .spyOn(queue, 'rollbackTurnRevival')
      .mockReturnValue(true);
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'delegation-rejected-advisor',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'not-applied', pickup: 'rejected' };
      },
    );
    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'rejected-attempt',
      startsTurn: true,
      userMessageId: 'rejected-root',
    });
    expect(rollbackTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'delegation-rejected-advisor' }),
      lease,
    );

    // A delegate started by the rejected turn keeps that turn's tag.
    ingestProviderEventWithResultMock.mockClear();
    await onEvent({
      type: 'canopy_delegation',
      canopy_turn_user_message_id: 'rejected-root',
      delegation: {
        delegationId: 'child',
        runGeneration: 1,
        sequence: 2,
        parentHarnessId: 'claude',
        parentTurnId: 'rejected-root',
        parentToolCallId: 'call',
        createdAt: 1,
        task: {
          description: 'Review',
          prompt: 'Read',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'child',
          status: 'completed',
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'reviewer',
            runtimeModelId: 'runtime',
            harnessId: 'claude',
          },
        },
        transcript: [],
      },
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(ingestProviderEventWithResultMock).toHaveBeenCalledTimes(1);
    const ingested: unknown =
      ingestProviderEventWithResultMock.mock.calls[0]?.[0];
    const ingestedData =
      typeof ingested === 'object' && ingested !== null && 'data' in ingested
        ? ingested.data
        : undefined;
    expect(ingestedData).toMatchObject({
      type: 'canopy_delegation',
      canopy_turn_user_message_id: 'rejected-root',
    });
  });

  it('rolls back when a superseded pickup lease cannot be confirmed', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = {
      rootId: 'superseded-root',
      epoch: 9,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(false);
    const rollbackTurnRevival = jest
      .spyOn(queue, 'rollbackTurnRevival')
      .mockReturnValue(false);
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'superseded-steering-advisor',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');

    await onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'superseded-attempt',
      startsTurn: true,
      userMessageId: 'superseded-root',
    });
    expect(confirmTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'superseded-steering-advisor' }),
      lease,
    );
    expect(rollbackTurnRevival).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'superseded-steering-advisor' }),
      lease,
    );

    ingestProviderEventWithResultMock.mockClear();
    await onEvent({
      type: 'assistant_delta',
      content: 'Current root remains original',
    });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(ingestProviderEventWithResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ turnUserMessageId: 'original' }),
    );
    expect(acceptTurnRevival).toHaveBeenCalledTimes(1);
  });

  it('waits for the previous root terminal commit and queue release before accepting a pickup', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'next-root', epoch: 10 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    jest.spyOn(queue, 'confirmTurnRevival').mockReturnValue(true);
    configureClaudeSteeringSession();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'ordered-steering-advisor',
        userMessageId: 'current-root',
        text: 'Current turn',
        providerType: 'claude',
        model: 'claude-opus-4-8',
      },
      makeOptions(),
    );
    const call = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected Advisor route');
    let resolvePreviousTerminal:
      | ((result: ProviderEventIngestResult) => void)
      | undefined;
    const previousTerminalCommit = new Promise<ProviderEventIngestResult>(
      (resolve) => {
        resolvePreviousTerminal = resolve;
      },
    );
    ingestProviderEventWithResultMock.mockImplementationOnce(
      () => previousTerminalCommit,
    );

    const previousTerminal = onEvent({
      type: 'result',
      is_error: false,
      result: 'Current turn done',
      canopy_turn_user_message_id: 'current-root',
    });
    const pickup = onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'next-attempt',
      startsTurn: true,
      userMessageId: 'next-root',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acceptTurnRevival).not.toHaveBeenCalled();

    if (!resolvePreviousTerminal) {
      throw new Error('Expected held terminal commit resolver');
    }
    resolvePreviousTerminal({ outcome: 'applied' });
    await previousTerminal;
    await pickup;
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(onTurnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'ordered-steering-advisor' }),
      'complete',
      'current-root',
    );
    expect(acceptTurnRevival).toHaveBeenCalledTimes(1);
    const terminalCallOrder = onTurnTerminal.mock.invocationCallOrder[0];
    const acceptCallOrder = acceptTurnRevival.mock.invocationCallOrder[0];
    if (terminalCallOrder === undefined || acceptCallOrder === undefined) {
      throw new Error('Expected queue terminal and acceptance calls');
    }
    expect(terminalCallOrder).toBeLessThan(acceptCallOrder);
  });

  it('uses persisted tab routing before the App Advisor preference on a bare send', async () => {
    jest.mocked(readPersistedChatDispatchMetadata).mockResolvedValueOnce({
      model: 'gpt-6-sol',
      providerType: 'codex',
      executionHarness: 'codex',
      thinkingLevel: 'medium',
      modelConfig: { fastMode: true },
    });

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-persisted-model',
        text: 'Continue with this tab model',
      },
      makeOptions(),
    );

    expect(getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-6-sol',
        selectedModel: 'gpt-6-sol',
        providerType: 'codex',
        executionHarness: 'codex',
        thinkingLevel: 'medium',
        modelConfig: { thinkingLevel: 'medium', speed: 'fast', fastMode: true },
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it.each([true, false])(
    'commits one Advisor watcher row and dispatches without a window (fired=%s)',
    async (fired) => {
      const options = makeOptions();
      options.toolSurfaces.ensureAppAdvisorWindow = jest.fn(() =>
        Promise.reject(new Error('Advisor window failed to load')),
      );
      const userMessageId = fired
        ? 'watcher-advisor-fired'
        : 'watcher-advisor-deleted';
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-watchers',
          userMessageId,
          text: 'Watcher notification',
          providerType: 'codex',
          model: 'gpt-5.5',
          initiationSource: 'user',
          hiddenContext: {
            kind: 'canopy-watcher-event',
            text: 'Watcher context',
          },
          ...(fired
            ? { watcherFired: { kind: 'worktree_chat_completion' } }
            : {}),
        },
        options,
      );
      const commits = ingestProviderEventMock.mock.calls.filter(
        ([input]) =>
          input !== null &&
          typeof input === 'object' &&
          'mutationId' in input &&
          input.mutationId === `advisor-watchers:${userMessageId}:user-prompt`,
      );
      expect(commits).toHaveLength(1);
      expect(commits[0]?.[0]).toMatchObject({
        data: {
          type: 'canopy_user_prompt',
          original_text: 'Watcher notification',
          canopy_turn_user_message_id: userMessageId,
          canopy_persisted_messages: [
            expect.objectContaining({
              id: userMessageId,
              role: 'user',
              ...(fired
                ? { watcherFired: { kind: 'worktree_chat_completion' } }
                : {}),
            }),
          ],
        },
      });
      if (!fired) {
        expect(commits[0]?.[0]).not.toHaveProperty(
          'data.canopy_persisted_messages.0.watcherFired',
        );
      }
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(options.getMainWindow()).toBeNull();
      expect(options.getAppAdvisorWindow()).toBeNull();
      expect(
        options.toolSurfaces.ensureAppAdvisorWindow,
      ).not.toHaveBeenCalled();
    },
  );

  it('refuses fork admission when parent Stop arrives during asynchronous preparation', async () => {
    const stop = new AbortController();
    setPlanModeMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      stop.abort(new Error('Parent stopped during admission'));
    });
    const onTurnAccepted = jest.fn();
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'message-1',
          text: 'Continue',
          providerType: 'codex',
          model: 'gpt-5.5',
        },
        { ...makeOptions(), admissionSignal: stop.signal, onTurnAccepted },
      ),
    ).rejects.toThrow('Parent stopped during admission');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(onTurnAccepted).not.toHaveBeenCalled();
    expect(releaseResourceMock).toHaveBeenCalled();
  });

  it('materializes the canonical tab and user prompt before provider dispatch', async () => {
    const onTurnAccepted = jest.fn();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
        providerType: 'codex',
        model: 'gpt-5.5',
      },
      { ...makeOptions(), onTurnAccepted },
    );

    expect(onTurnAccepted).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      onTurnAccepted.mock.invocationCallOrder[0],
    );
    expect(ensureChatForTrustedSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        providerType: 'codex',
        model: 'gpt-5.5',
      }),
    );
    const committedPrompt = ingestProviderEventMock.mock.calls[0]?.[0];
    expect(committedPrompt).toMatchObject({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      chatId: 'advisor-chat',
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Inspect the UI',
        canopy_turn_user_message_id: 'message-1',
      },
      mutationId: 'advisor-chat:message-1:user-prompt',
    });
    expect(
      ensureChatForTrustedSendMock.mock.invocationCallOrder[0],
    ).toBeLessThan(ingestProviderEventMock.mock.invocationCallOrder[0]);
    expect(ingestProviderEventMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0],
    );
    expect(ingestProviderEventMock.mock.invocationCallOrder[1]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0],
    );
  });

  // D12: a delegate's message is hidden only while it waits in the queue.
  it('shows a sent delegation internal row after a durable reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'app-advisor-internal-row-'));
    const paths = {
      tabs: join(root, 'chats.json'),
      archives: join(root, 'archives.json'),
      journal: join(root, 'journal.jsonl'),
    };
    const { ChatStateV2Repository } = jest.requireActual<
      typeof ChatStateV2RepositoryModule
    >('../services/chat-state-v2-repository');
    const { ChatStateService } = jest.requireActual<
      typeof ChatStateServiceModule
    >('../services/chat-state-service');
    const repository = new ChatStateV2Repository({
      resolvePaths: () => paths,
    });
    const stateService = new ChatStateService({
      repository,
      inputSession: () => Promise.resolve(undefined),
      recordDiagnostic: jest.fn(),
    });
    const reloadedRepository = new ChatStateV2Repository({
      resolvePaths: () => paths,
    });
    const reloadedStateService = new ChatStateService({
      repository: reloadedRepository,
      inputSession: () => Promise.resolve(undefined),
      recordDiagnostic: jest.fn(),
    });
    mockChatStateServiceOverride = stateService;
    const internalRow = {
      kind: 'delegation-request' as const,
      delegationId: 'delegation-1',
      displayLine: 'Waiting for the parent',
    };

    try {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-internal-row-chat',
          userMessageId: 'internal-row-message',
          text: 'Private delegation payload',
          providerType: 'codex',
          model: 'gpt-5.5',
          managedDelegationDeliveryId: 'delivery-1',
          internalRow,
        },
        makeOptions(),
      );

      const reloadedState = await reloadedStateService.getState({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
      });
      const userMessage = reloadedState.tabsFile.tabs
        .find((tab) => tab.id === 'advisor-internal-row-chat')
        ?.messages.find((message) => message.id === 'internal-row-message');

      if (!userMessage) throw new Error('Persisted user row was not reloaded');
      expect(userMessage.hidden).toBeUndefined();
      expect(isVisiblePersistedChatMessage(userMessage)).toBe(true);
    } finally {
      mockChatStateServiceOverride = undefined;
      await Promise.all([repository.drainAll(), reloadedRepository.drainAll()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists accepted agent sender attribution as an agent-authored user message', async () => {
    const agentSent = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'entry-one',
        chatId: 'source-chat',
      },
      chatTitle: 'Source chat',
      projectLabel: 'App Advisor',
    } satisfies ChatAgentSentInfo;
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-agent',
        text: 'Forwarded by an agent',
        agentSent,
        agentSenderProvenance: {
          version: 1,
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'message-agent',
          sender: agentSent.sender,
          owner: { kind: 'none' },
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>trusted</system_instruction>',
        },
      },
      makeOptions(),
    );

    const prompt = ingestProviderEventMock.mock.calls[0]?.[0] as {
      data?: { canopy_persisted_messages?: Array<Record<string, unknown>> };
    };
    expect(prompt.data?.canopy_persisted_messages?.[0]).toMatchObject({
      id: 'message-agent',
      role: 'user',
      userMessageSource: 'agent',
      agentSent,
    });
    expect(prompt.data?.canopy_persisted_messages?.[0]).not.toHaveProperty(
      'agentSenderProvenance',
    );
  });

  it('does not enqueue the provider message when acceptance persistence fails', async () => {
    ingestProviderEventMock
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('acceptance unavailable'));

    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'message-acceptance-failure',
          text: 'Run once',
        },
        makeOptions(),
      ),
    ).rejects.toThrow('acceptance unavailable');

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('retries when the canonical prompt exists but provider acceptance does not', async () => {
    ingestProviderEventMock.mockResolvedValueOnce(false);

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-duplicate',
        text: 'Do not dispatch twice',
      },
      makeOptions(),
    );

    expect(hasMutationMock).toHaveBeenCalledWith(
      { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry-one' },
      'advisor-chat:message-duplicate:accepted',
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when the provider already accepted the prompt', async () => {
    const onTurnAccepted = jest.fn();
    ingestProviderEventMock.mockResolvedValueOnce(false);
    hasMutationMock.mockResolvedValueOnce(true);

    const outcome = await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-accepted',
        text: 'Do not dispatch twice',
      },
      { ...makeOptions(), onTurnAccepted },
    );

    expect(outcome).toBe('already_accepted');
    expect(onTurnAccepted).toHaveBeenCalledTimes(1);
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a reused session', 'parks', true],
    ['a new session', 'sends', false],
  ] as const)(
    'on %s, %s an admitted Claude prompt while a wake runs',
    async (_session, outcome, reusesSession) => {
      const request = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'After the wake',
        providerType: 'claude' as const,
        model: 'claude-opus-4-8',
      };
      if (reusesSession) {
        // A wake needs an earlier turn on the same session.
        let earlier: ReturnType<typeof getOrCreateSession> | undefined;
        const create = jest.mocked(getOrCreateSession).getMockImplementation();
        jest.mocked(getOrCreateSession).mockImplementationOnce((...args) => {
          if (!create)
            throw new Error('The session mock has no implementation');
          earlier = create(...args);
          return earlier;
        });
        await dispatchAppAdvisorChatMessage(
          { ...request, userMessageId: 'message-0' },
          makeOptions(),
        );
        if (!earlier)
          throw new Error('The earlier dispatch created no session');
        jest.mocked(getOrCreateSession).mockReturnValueOnce(earlier);
        startChatTurnMock.mockClear();
        sendMessageMock.mockClear();
      }
      const wake = serializeChatTurnState({
        ...initialChatTurnState(),
        current: {
          id: 'wake-turn',
          origin: 'autonomous',
          startedAtMs: 1,
          pauses: [],
        },
      });
      const { scope, dispatchOwner } = TEST_DISPATCH_AUTHORIZATION;
      jest.spyOn(getChatTurnOwnership(), 'getSnapshot').mockReturnValue({
        scope,
        serviceEpoch: Symbol('service'),
        operationEpoch: 1,
        knowledge: 'known',
        receipt: { generation: 3, state: wake },
        committed: { generation: 3, state: wake },
        unacknowledgedLifecycle: [],
        dispatchOwners: [
          {
            kind: 'dispatch',
            token: dispatchOwner,
            userMessageId: 'message-1',
            operationEpoch: 1,
            reason: 'awaiting-start',
          },
        ],
        stopOwners: [],
        hostQueuedInputCount: 0,
        removalAwaitingSettle: false,
        backgroundFreshness: 'fresh',
      });

      const dispatch = dispatchAppAdvisorChatMessage(request, makeOptions());
      if (outcome === 'sends') {
        // A new Claude session can open a turn at its startup init.
        await dispatch;
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        return;
      }
      await expect(dispatch).rejects.toMatchObject({
        outcome: { kind: 'parked', blockedByTurnId: 'wake-turn' },
      });
      expect(startChatTurnMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(sessionEventRouterTestExports.pendingRouteCount()).toBe(0);
    },
  );

  it('destroys an active session owned by a different requested provider', async () => {
    jest.mocked(getActiveSessionInfos).mockReturnValueOnce([
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        providerType: 'codex',
        executionHarness: 'codex',
        turnActive: false,
        createdAt: 1,
        lastActivityAt: 1,
        turnCount: 1,
        pendingMessageCount: 0,
      },
    ]);
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-provider-switch',
        text: 'Switch providers',
        providerType: 'claude',
        model: 'claude-opus-4-8',
        executionHarness: 'claude',
      },
      makeOptions(),
    );

    expect(destroySession).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-one',
      'advisor-chat',
    );
    expect(getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'claude',
        executionHarness: 'claude',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it.each([true, false])(
    'retains the OpenCode App Advisor deferred capability grant: %s',
    async (allowed) => {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'deferred-message',
          text: 'Use the requested skill',
          model: 'opencode:fixture%2Fmodel',
          deferredToolsAllowed: allowed,
        },
        makeOptions(),
      );
      expect(getOrCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerType: 'opencode',
          deferredToolsAllowed: allowed,
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Object),
      );
    },
  );

  it('refuses OpenCode funding before accepting an Advisor message', async () => {
    mockOpenCodeAdmission.mockRejectedValueOnce(
      new Error('The funding account changed.'),
    );
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'funding-refusal',
          text: 'Review',
          model: 'opencode:fixture%2Fmodel',
        },
        makeOptions(),
      ),
    ).rejects.toThrow('funding account');
    expect(ensureChatForTrustedSendMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('delivers OpenCode App Advisor attachment selections with the canonical root', async () => {
    const attachmentPaths = ['/mock/attachments/photo.png'];
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'attachment-message',
        text: 'Review the image',
        model: 'opencode:fixture%2Fmodel',
        attachmentPaths,
      },
      makeOptions(),
    );
    expect(mockOpenCodeAdmission.mock.calls[0]?.[0]).toMatchObject({
      model: 'opencode:fixture%2Fmodel',
      session: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
      },
    });
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        attachments: { baseDir: '/mock/attachments', paths: attachmentPaths },
      }),
    );
  });

  it('dispatches a Cursor model App Advisor turn on the App Advisor runtime', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'cursor-accepted',
        text: 'Hello',
        model: 'cursor-default',
      },
      makeOptions(),
    );
    expect(isCursorRuntimeAvailableMock).toHaveBeenCalled();
    expect(ensureChatForTrustedSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'cursor',
        executionHarness: 'cursor',
      }),
    );
    expect(getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'cursor',
        executionHarness: 'cursor',
        assistantMode: 'app-advisor',
        rtkEnabled: true,
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
    expect(sendMessageMock).toHaveBeenCalled();
  });

  it('keeps a live Claude session when a Cursor request fails the runtime preflight', async () => {
    jest.mocked(getActiveSessionInfos).mockReturnValueOnce([
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        providerType: 'claude',
        executionHarness: 'claude',
        sdkSessionId: 'claude-session-live',
      } as never,
    ]);
    isCursorRuntimeAvailableMock.mockResolvedValueOnce(false);
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'cursor-switch-unavailable',
          text: 'Hello',
          model: 'cursor-default',
          providerType: 'cursor',
        },
        makeOptions(),
      ),
    ).rejects.toThrow('Connect Cursor in Settings');
    // The failed switch must be side-effect free: the Claude session stays.
    expect(destroySession).not.toHaveBeenCalled();
    expect(ensureChatForTrustedSendMock).not.toHaveBeenCalled();
  });

  it('asks to connect Copilot in Settings before switching to it', async () => {
    jest.mocked(isCopilotRuntimeAvailable).mockResolvedValueOnce(false);
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'copilot-unavailable',
          text: 'Hello',
          model: 'copilot:fixture-model',
          providerType: 'copilot',
        },
        makeOptions(),
      ),
    ).rejects.toThrow(new Error('Connect Copilot in Settings.'));
    expect(ensureChatForTrustedSendMock).not.toHaveBeenCalled();
  });

  it.each([
    { requested: true, stored: false, allowed: true },
    { requested: false, stored: true, allowed: false },
    { requested: undefined, stored: undefined, allowed: true },
    { requested: undefined, stored: false, allowed: false },
  ])(
    'honors Copilot App Advisor deferred policy: request=$requested, stored=$stored',
    async ({ requested, stored, allowed }) => {
      jest
        .mocked(readPersistedChatDispatchMetadata)
        .mockResolvedValueOnce({ deferredToolsAllowed: stored });
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'copilot-policy',
          text: 'Hello',
          model: 'copilot:fixture-model',
          providerType: 'copilot',
          deferredToolsAllowed: requested,
        },
        makeOptions(),
      );
      expect(createAppAdvisorToolRuntime).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ deferredToolsAllowed: allowed }),
      );
      expect(getOrCreateSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerType: 'copilot',
          deferredToolsAllowed: allowed,
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Object),
      );
      expect(ensureChatForTrustedSendMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ deferredToolsAllowed: allowed }),
      );
    },
  );

  it('disables deferred-tool loading for Cursor App Advisor sessions', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'cursor-deferred',
        text: 'Hello',
        model: 'cursor-default',
      },
      makeOptions(),
    );
    // A Cursor turn owns one CLI process and cannot reload mid-turn, so the
    // runtime, the session, and the tool-profile input all say so.
    expect(createAppAdvisorToolRuntime).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ deferredToolsAllowed: false }),
    );
    expect(getOrCreateSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ deferredToolsAllowed: false }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
    expect(ensureChatForTrustedSendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ deferredToolsAllowed: false }),
    );
  });

  it('fails a Cursor App Advisor turn with connect guidance before persisting when the runtime is unavailable', async () => {
    isCursorRuntimeAvailableMock.mockResolvedValueOnce(false);
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'cursor-unavailable',
          text: 'Hello',
          model: 'cursor-default',
        },
        makeOptions(),
      ),
    ).rejects.toThrow(
      'Connect Cursor in Settings to send with Cursor, or choose another model.',
    );
    expect(ensureChatForTrustedSendMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('restores Cursor App Advisor routing from persisted metadata', async () => {
    jest.mocked(readPersistedChatDispatchMetadata).mockResolvedValueOnce({
      model: 'cursor-default',
      providerType: 'cursor',
      executionHarness: 'cursor',
    });
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'cursor-restored',
        text: 'Hello',
      },
      makeOptions(),
    );
    expect(getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'cursor',
        model: 'cursor-default',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('dispatches a deferred-tools continuation without re-committing the original user prompt', async () => {
    ingestProviderEventMock.mockResolvedValueOnce(false);

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-reload',
        text: '<system_instruction>Continue after reload.</system_instruction>',
        providerType: 'claude',
        model: 'claude-opus-4-8',
        sdkSessionId: 'claude-session-123',
        deferredToolsReloadEnabledResources: [],
        deferredToolsReloadRequestId: 'reload-request-1',
      },
      makeOptions(),
    );

    expect(scheduleChatSummary).not.toHaveBeenCalled();
    expect(ingestProviderEventMock).not.toHaveBeenCalled();
    expect(getOrCreateSession).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      '<system_instruction>Continue after reload.</system_instruction>',
      { userMessageId: 'message-reload' },
    );

    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor continuation event handler');
    }
    void onEvent({ type: 'assistant_delta', content: 'Resumed' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(ingestProviderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          type: 'assistant_delta',
          content: 'Resumed',
          canopy_turn_revival: true,
        },
        mutationId:
          'advisor-chat:message-reload:deferred-reload:reload-request-1:provider:0',
      }),
    );
  });

  it('stops tagging a deferred-tools continuation as a revival after its terminal result', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-reload',
        text: '<system_instruction>Continue after reload.</system_instruction>',
        providerType: 'claude',
        model: 'claude-opus-4-8',
        sdkSessionId: 'claude-session-123',
        deferredToolsReloadEnabledResources: [],
        deferredToolsReloadRequestId: 'reload-request-1',
      },
      makeOptions(),
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor continuation event handler');
    }
    void onEvent({ type: 'result', is_error: false, result: 'Done' });
    // Claude reports the settled command after its result. That bookkeeping
    // frame must not reopen the turn it just finished.
    void onEvent({
      type: 'command_lifecycle',
      command_uuid: 'command-1',
      state: 'completed',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(ingestProviderEventMock).toHaveBeenCalledTimes(2);
    expect(ingestProviderEventMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          type: 'result',
          is_error: false,
          result: 'Done',
          canopy_turn_revival: true,
        },
      }),
    );
    expect(ingestProviderEventMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          type: 'command_lifecycle',
          command_uuid: 'command-1',
          state: 'completed',
        },
      }),
    );
  });

  afterEach(() => {
    clearLiveApprovalMode(APP_ADVISOR_PROJECT_ID, 'entry-one', 'advisor-chat');
  });

  it('sends hidden UI context to the provider but not to observability transcripts', async () => {
    mockReadAuthorityTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'advisor-chat',
      tabs: [
        {
          id: 'advisor-chat',
          title: 'Chat',
          createdAt: '2026-07-23T00:00:00.000Z',
          messages: [],
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
        },
      ],
    });

    const envelope: AppAdvisorUiStateEnvelope = {
      version: 1,
      revision: 1,
      capturedAt: new Date(0).toISOString(),
      digest: 'digest',
      snapshot: {
        activePage: 'overview',
        archivedContainers: { count: 0, viewerOpen: false },
        overlays: {
          commandPaletteOpen: false,
          fileSearchPaletteOpen: false,
          prPickerOpen: false,
          canopyPortalOpen: false,
          appAdvisorOpen: true,
        },
      },
    };
    const hiddenText =
      '<app_advisor_context>{"revision":1}</app_advisor_context>';

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
        providerType: 'codex',
        model: 'gpt-5.5',
        hiddenContext: {
          kind: 'app-advisor-ui-state',
          envelope,
          text: hiddenText,
        },
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
      },
      makeOptions(),
    );

    expect(sendMessageMock).toHaveBeenCalledWith(
      [hiddenText, '', 'Inspect the UI'].join('\n'),
      { userMessageId: 'message-1' },
    );
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMode: 'app-advisor',
        initiationSource: 'app_advisor',
        originalUserText: 'Inspect the UI',
        submittedText: 'Inspect the UI',
      }),
    );
    const observedTurn = startChatTurnMock.mock.calls[0]?.[0];
    expect(observedTurn?.originalUserText).not.toContain('app_advisor_context');
    expect(observedTurn?.submittedText).not.toContain('app_advisor_context');
    expect(jest.mocked(getOrCreateSession).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        approvalMode: 'auto',
        sessionApprovalRules: [expect.objectContaining({ id: 'rule-1' })],
      }),
    );
  });

  it('delivers one-shot system instructions with the provider prompt', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-fork',
        userMessageId: 'message-1',
        text: 'Continue',
        providerType: 'codex',
        model: 'gpt-5.5',
        pendingSystemInstructions: [
          { id: 'independent-agent-start', text: 'Investigate independently' },
        ],
      },
      makeOptions(),
    );

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/Investigate independently[\s\S]*Continue$/),
      { userMessageId: 'message-1' },
    );
  });

  it('includes session-affecting App Advisor preferences in the tool profile hash', async () => {
    jest.mocked(readPreferencesFile).mockResolvedValueOnce({
      ...DEFAULT_PREFERENCES,
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: ['bundle-a'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      codexAppServerIdleTimeoutMinutes: 10,
      codexMultiAgentAppAdvisorEnabled: false,
      rtkEnabled: true,
    });
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
      },
      makeOptions(),
    );
    const firstHash =
      jest.mocked(getOrCreateSession).mock.calls[0]?.[0].toolProfileHash;

    jest.mocked(readPreferencesFile).mockResolvedValueOnce({
      ...DEFAULT_PREFERENCES,
      appAdvisorModel: 'gpt-5.6-luna',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: ['bundle-a'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      codexAppServerIdleTimeoutMinutes: 10,
      codexMultiAgentAppAdvisorEnabled: false,
      rtkEnabled: true,
    });
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-2',
        text: 'Inspect again',
      },
      makeOptions(),
    );
    const secondHash =
      jest.mocked(getOrCreateSession).mock.calls[1]?.[0].toolProfileHash;

    expect(firstHash).toBeDefined();
    expect(secondHash).toBeDefined();
    expect(secondHash).not.toBe(firstHash);
  });

  it('forwards the subagent limit and changes the profile when it is reset', async () => {
    for (const limit of [2, null]) {
      jest.mocked(readPreferencesFile).mockResolvedValueOnce({
        ...DEFAULT_PREFERENCES,
        appAdvisorModel: 'gpt-5.5',
        codexMultiAgentAppAdvisorEnabled: true,
        codexMaxConcurrentSubagents: limit,
      });
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: `limit-${limit}`,
          text: 'Inspect the UI',
        },
        makeOptions(),
      );
      expect(jest.mocked(getOrCreateSession).mock.lastCall?.[0]).toEqual(
        expect.objectContaining({
          codexMultiAgentEnabled: true,
          codexMaxConcurrentSubagents: limit,
        }),
      );
    }
    const calls = jest.mocked(getOrCreateSession).mock.calls;
    expect(calls[0][0].toolProfileHash).not.toBe(calls[1][0].toolProfileHash);
  });

  it('clamps a deferred continuation to the current live approval mode', async () => {
    setLiveApprovalMode(
      APP_ADVISOR_PROJECT_ID,
      'entry-one',
      'advisor-chat',
      'ask',
    );

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-reload',
        text: 'Continue after reload',
        providerType: 'codex',
        model: 'gpt-5.5',
        approvalMode: 'full-access',
        deferredToolsReloadEnabledResources: [],
      },
      makeOptions(),
    );

    expect(jest.mocked(getOrCreateSession).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ approvalMode: 'ask' }),
    );
    expect(setApprovalModeMock).toHaveBeenCalledWith('ask');
    expect(setApprovalModeMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('admits a deferred continuation in its own right instead of presenting the consumed capability', async () => {
    const consume = jest
      .spyOn(getChatDispatchAuthorization(), 'consume')
      .mockReturnValue({
        kind: 'authorized',
        ownership: {
          kind: 'dispatch',
          token: Symbol('owner'),
          userMessageId: 'message-1',
          operationEpoch: 1,
          reason: 'awaiting-start',
        },
      });
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    const continuationAuthorization = {
      authorizationToken: Symbol('continuation dispatch'),
      scope: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
      },
      dispatchOwner: Symbol('continuation owner'),
      userMessageId: 'message-2',
      operationEpoch: 1,
      kind: 'ordinary' as const,
    };
    const admit = jest
      .spyOn(getChatQueueService(), 'admitDirectDispatchWhenAllowed')
      .mockResolvedValue({
        authorization: continuationAuthorization,
        release: jest.fn(),
      });
    try {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'message-1',
          text: 'Inspect the UI',
          providerType: 'codex',
          model: 'gpt-5.5',
        },
        {
          ...makeOptions(),
          authorization: {
            authorizationToken: Symbol('issued dispatch'),
            scope: {
              projectId: APP_ADVISOR_PROJECT_ID,
              worktreeId: 'entry-one',
              chatId: 'advisor-chat',
            },
            dispatchOwner: Symbol('owner'),
            userMessageId: 'message-1',
            operationEpoch: 1,
            kind: 'ordinary',
          },
        },
      );
      const resume = registerResumeHandler.mock.calls.find(
        ([scope]) => scope.chatId === 'advisor-chat',
      )?.[1];
      if (!resume) throw new Error('Expected deferred-tools resume handler');
      await resume({
        scope: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
        },
        requestId: 'reload-request',
        toolCallId: 'tool-call',
        userMessageId: 'message-2',
        continuationText: '<system_instruction>Continue</system_instruction>',
        enabledResources: [],
        providerType: 'codex',
        signal: new AbortController().signal,
      });
      // The continuation consumes its own admission, never the root's.
      expect(admit).toHaveBeenCalledWith(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
        },
        'message-2',
        expect.any(AbortSignal),
        'reload-request',
      );
      expect(consume).toHaveBeenCalledTimes(2);
      expect(consume).toHaveBeenLastCalledWith(
        continuationAuthorization,
        expect.objectContaining({ userMessageId: 'message-2' }),
      );
    } finally {
      admit.mockRestore();
      consume.mockRestore();
      registerResumeHandler.mockRestore();
    }
  });

  it.each(['automation', 'hook'] as const)(
    'preserves %s provenance through an Advisor tool reload',
    async (initiationSource) => {
      const registerResumeHandler = jest.spyOn(
        deferredToolsReloadCoordinator,
        'registerResumeHandler',
      );
      const origin = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatTabId: 'advisor-reload',
      };
      try {
        await dispatchAppAdvisorChatMessage(
          {
            projectId: origin.projectId,
            worktreeId: origin.worktreeId,
            chatId: origin.chatTabId,
            userMessageId: 'reload-turn',
            text: 'Load tools',
            initiationSource,
          },
          makeOptions(),
        );
        const resume = registerResumeHandler.mock.calls.find(
          ([scope]) => scope.chatId === origin.chatTabId,
        )?.[1];
        if (!resume) throw new Error('Missing resume handler');
        await resume({
          scope: {
            projectId: origin.projectId,
            worktreeId: origin.worktreeId,
            chatId: origin.chatTabId,
          },
          requestId: 'reload-request',
          toolCallId: 'tool-call',
          userMessageId: 'reload-turn',
          continuationText: '<system_instruction>Continue</system_instruction>',
          enabledResources: [],
          signal: new AbortController().signal,
        });
        expect(capturePresentationTurn(origin)?.source).toBe(initiationSource);
      } finally {
        clearPresentationTurn(
          `${origin.projectId}/${origin.worktreeId}/${origin.chatTabId}`,
        );
        registerResumeHandler.mockRestore();
      }
    },
  );

  it.each(['automation', 'hook'] as const)(
    'preserves an accepted %s pickup through a later Advisor reload',
    async (source) => {
      const registration = jest.spyOn(
        deferredToolsReloadCoordinator,
        'registerResumeHandler',
      );
      const origin = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatTabId: 'pickup-reload',
      };
      try {
        await dispatchAppAdvisorChatMessage(
          {
            projectId: origin.projectId,
            worktreeId: origin.worktreeId,
            chatId: origin.chatTabId,
            userMessageId: 'original-human',
            text: 'Start',
            initiationSource: 'user',
          },
          makeOptions(),
        );
        const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
        const resume = registration.mock.calls.find(
          ([scope]) => scope.chatId === origin.chatTabId,
        )?.[1];
        if (!onEvent || !resume)
          throw new Error('Missing Advisor session callbacks');
        // The delivery coordinator commits and installs the new root before forwarding its pickup event.
        recordPresentationTurn(
          `${origin.projectId}/${origin.worktreeId}/${origin.chatTabId}`,
          'picked-up',
          source,
        );
        void onEvent({
          type: 'canopy_input_delivery',
          provider: 'codex',
          phase: 'picked-up',
          generation: 'live',
          attemptId: 'pickup-attempt',
          startsTurn: true,
          userMessageId: 'picked-up',
          turnRootAccepted: true,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await resume({
          scope: {
            projectId: origin.projectId,
            worktreeId: origin.worktreeId,
            chatId: origin.chatTabId,
          },
          requestId: 'pickup-reload-request',
          toolCallId: 'tool-call',
          userMessageId: 'picked-up',
          continuationText: '<system_instruction>Continue</system_instruction>',
          enabledResources: [],
          signal: new AbortController().signal,
        });
        expect(capturePresentationTurn(origin)).toMatchObject({
          turnId: 'picked-up',
          source,
        });
      } finally {
        clearPresentationTurn(
          `${origin.projectId}/${origin.worktreeId}/${origin.chatTabId}`,
        );
        registration.mockRestore();
      }
    },
  );

  it('admits a deferred continuation through the Work Entry deletion fence', async () => {
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    const agentSent = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'entry-one',
        chatId: 'source-chat',
      },
      chatTitle: 'Source chat',
      projectLabel: 'App Advisor',
    } satisfies ChatAgentSentInfo;
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
        providerType: 'codex',
        model: 'gpt-5.5',
        agentSent,
        agentSenderProvenance: {
          version: 1,
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'message-1',
          sender: agentSent.sender,
          owner: { kind: 'none' },
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>trusted</system_instruction>',
        },
      },
      makeOptions(),
    );
    const registration = registerResumeHandler.mock.calls.find(
      ([scope]) => scope.chatId === 'advisor-chat',
    );
    const resume = registration?.[1];
    if (!resume) throw new Error('Expected deferred-tools resume handler');

    await resume({
      scope: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
      },
      requestId: 'reload-request',
      toolCallId: 'tool-call',
      userMessageId: 'message-2',
      continuationText: '<system_instruction>Continue</system_instruction>',
      enabledResources: [],
      providerType: 'codex',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      signal: new AbortController().signal,
    });

    expect(ensureChatForTrustedSendMock.mock.calls[1]?.[0]).toMatchObject({
      hiddenContext: undefined,
      agentSent: undefined,
      agentSenderProvenance: undefined,
    });

    expect(runWithScopeActivityMock).toHaveBeenCalledWith(
      { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry-one' },
      expect.any(Function),
    );
    registerResumeHandler.mockRestore();
  });

  it('resumes a started Claude fork child after a deferred-tools reload', async () => {
    jest.mocked(getOrCreateSession).mockResolvedValueOnce({
      sendMessage: sendMessageMock,
      cancel: jest.fn(),
      destroy: jest.fn(),
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
      setThinkingLevel: jest.fn(),
      setModel: jest.fn(),
      getProviderSessionId: () => 'fork-child-session',
    });
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    try {
      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-fork',
          userMessageId: 'message-1',
          text: 'Load the deferred tool',
          providerType: 'claude',
          model: 'claude-opus-4-8',
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          claudeForkResumeAt: 'source-anchor-uuid',
        },
        makeOptions(),
      );
      expect(jest.mocked(getOrCreateSession).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          claudeForkResumeAt: 'source-anchor-uuid',
        }),
      );

      const resume = registerResumeHandler.mock.calls.find(
        ([scope]) => scope.chatId === 'advisor-fork',
      )?.[1];
      if (!resume) throw new Error('Expected deferred-tools resume handler');
      await resume({
        scope: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-fork',
        },
        requestId: 'reload-request',
        toolCallId: 'tool-call',
        userMessageId: 'message-1',
        continuationText: '<system_instruction>Continue</system_instruction>',
        enabledResources: [],
        sdkSessionId: 'fork-child-session',
        providerType: 'claude',
        signal: new AbortController().signal,
      });

      const resumedOptions = jest.mocked(getOrCreateSession).mock.lastCall?.[0];
      expect(resumedOptions).toEqual(
        expect.objectContaining({ sdkSessionId: 'fork-child-session' }),
      );
      expect(resumedOptions).not.toHaveProperty('claudeForkSession');
      expect(resumedOptions).not.toHaveProperty('claudeForkResumeAt');
    } finally {
      registerResumeHandler.mockRestore();
    }
  });

  it('passes the persisted SDK session id when resuming an App Advisor chat', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-2',
        text: 'Continue',
        providerType: 'claude',
        model: 'claude-opus-4-8',
        sdkSessionId: 'claude-session-123',
      },
      makeOptions(),
    );

    const sessionCall = jest.mocked(getOrCreateSession).mock.calls[0];
    expect(sessionCall?.[0]).toEqual(
      expect.objectContaining({
        assistantMode: 'app-advisor',
        sdkSessionId: 'claude-session-123',
      }),
    );
    expect(typeof sessionCall?.[3]?.drainEventsBeforeRemoval).toBe('function');
  });

  it('forks a Claude source session instead of resuming it', async () => {
    mockConsumeClaudeForkMarker.mockResolvedValue(null);
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-fork',
        userMessageId: 'message-fork',
        text: 'Continue',
        providerType: 'claude',
        model: 'claude-opus-4-8',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: 'source-message-uuid',
      },
      makeOptions(),
    );

    const sessionCall = jest.mocked(getOrCreateSession).mock.calls[0];
    expect(sessionCall?.[0]).toEqual(
      expect.objectContaining({
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: 'source-message-uuid',
      }),
    );
    await sessionCall?.[1]({
      type: 'system',
      subtype: 'init',
      session_id: 'fork-session',
    });
    expect(mockConsumeClaudeForkMarker).toHaveBeenCalledWith({
      workspaceId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      chatId: 'advisor-fork',
      sessionId: 'fork-session',
    });
  });

  it('registers the provider event commit tail for session teardown draining', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-drain',
        text: 'Finish before archive capture',
      },
      makeOptions(),
    );

    const sessionCall = jest.mocked(getOrCreateSession).mock.calls[0];
    const onEvent = sessionCall?.[1];
    const drainEventsBeforeRemoval = sessionCall?.[3]?.drainEventsBeforeRemoval;
    expect(onEvent).toBeDefined();
    expect(drainEventsBeforeRemoval).toBeDefined();

    let releaseCommit: (() => void) | undefined;
    ingestProviderEventMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = (): void => resolve(true);
        }),
    );
    void onEvent?.({ type: 'assistant_delta', content: 'Final output' });

    let drained = false;
    const drain = drainEventsBeforeRemoval?.().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    releaseCommit?.();
    await drain;
    expect(drained).toBe(true);
  });

  it('records the original App Advisor instruction snapshot when resuming a provider session', async () => {
    jest.mocked(readPreferencesFile).mockResolvedValueOnce({
      ...DEFAULT_PREFERENCES,
      globalInstructions: {
        chats: {
          overall: 'Do not record this on resume.',
          scoped: [],
        },
        pipelines: { overall: '', scoped: [] },
      },
    });

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-resume-audit',
        text: 'Continue',
        providerType: 'claude',
        model: 'claude-opus-4-8',
        sdkSessionId: 'claude-session-123',
        globalInstructionsSnapshot:
          '# User Overall Preferences\n\nOriginal snapshot.',
      },
      makeOptions(),
    );

    expect(scheduleChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'advisor-chat' }),
    );

    const observedTurn = startChatTurnMock.mock.calls[0]?.[0];
    expect(observedTurn?.systemPromptAppend).toContain('App Advisor');
    expect(observedTurn?.systemPromptAppend).toContain('Original snapshot.');
    expect(observedTurn?.systemPromptAppend).not.toContain(
      'Do not record this on resume.',
    );
  });

  it.each([
    ['creating', undefined],
    ['resuming', 'codex-thread-123'],
  ] as const)(
    'rejects a conflicting harness echo when %s an App Advisor chat',
    async (_scenario, sdkSessionId) => {
      jest.mocked(readPersistedChatDispatchMetadata).mockResolvedValueOnce({
        model: 'gpt-5.5',
        executionHarness: 'codex',
        ...(sdkSessionId ? { sdkSessionId } : {}),
      });

      await expect(
        dispatchAppAdvisorChatMessage(
          {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: 'entry-one',
            chatId: 'advisor-chat',
            userMessageId: 'message-conflict',
            text: 'Use the wrong harness',
            model: 'gpt-5.5',
            providerType: 'codex',
            executionHarness: 'claude',
            ...(sdkSessionId ? { sdkSessionId } : {}),
          },
          makeOptions(),
        ),
      ).rejects.toThrow(/execution harness/i);

      expect(getOrCreateSession).not.toHaveBeenCalled();
    },
  );

  it('uses the hydrated model harness for an empty unpinned Advisor tab', async () => {
    const metadata = {
      model: 'claude-opus-4-8',
      executionHarness: 'claude' as const,
      hasConversation: false,
    };
    jest
      .mocked(readPersistedChatDispatchMetadata)
      .mockResolvedValueOnce(metadata);
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-cold',
          userMessageId: 'advisor-ready',
          text: 'First guest turn',
          model: 'gpt-5.6-luna',
          providerType: 'codex',
          executionHarness: 'codex',
        },
        makeOptions(),
      ),
    ).resolves.not.toThrow();
    expect(jest.mocked(getOrCreateSession).mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.6-luna',
      executionHarness: 'codex',
    });
  });

  it.each([
    { hasConversation: true },
    { hasConversation: false, executionHarnessExplicitlyChosen: true },
  ])('preserves a conversation or explicit harness lock: %j', async (lock) => {
    const metadata = {
      model: 'claude-opus-4-8',
      executionHarness: 'claude' as const,
      ...lock,
    };
    jest
      .mocked(readPersistedChatDispatchMetadata)
      .mockResolvedValueOnce(metadata);
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-pinned',
          userMessageId: 'pinned-turn',
          text: 'Preserve the lock',
          model: 'gpt-5.6-luna',
          providerType: 'codex',
          executionHarness: 'codex',
        },
        makeOptions(),
      ),
    ).rejects.toThrow('execution harness does not match');
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it('uses the persisted App Advisor model and reconciles its provider over a stale lock', async () => {
    jest.mocked(readPersistedChatDispatchMetadata).mockResolvedValueOnce({
      model: 'claude-opus-4-8',
      executionHarness: 'claude',
    });

    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'message-substituted',
          text: 'Continue',
          providerType: 'claude',
          executionHarness: 'claude',
          sdkSessionId: 'claude-session-abc',
        },
        makeOptions(),
      ),
    ).resolves.not.toThrow();

    const sessionOptions = jest.mocked(getOrCreateSession).mock.calls[0]?.[0];
    expect(sessionOptions).toEqual(
      expect.objectContaining({
        model: 'gpt-5.5',
        providerType: 'codex',
        executionHarness: 'codex',
      }),
    );
    expect(sessionOptions?.sdkSessionId).toBeUndefined();
    expect(ensureChatForTrustedSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'codex',
        model: 'gpt-5.5',
        executionHarness: 'codex',
      }),
    );
  });

  it('broadcasts App Advisor chat events to main and App Advisor windows', async () => {
    const options = makeOptions();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
      },
      options,
    );

    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor event handler');
    }

    void onEvent({ type: 'assistant_delta', content: 'Working' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendToWindowDetailed).toHaveBeenCalledWith(
      options.getMainWindow(),
      'chat:event',
      expect.objectContaining({ chatId: 'advisor-chat' }),
    );
    expect(sendToWindowDetailed).toHaveBeenCalledWith(
      options.getAppAdvisorWindow(),
      'chat:event',
      expect.objectContaining({ chatId: 'advisor-chat' }),
    );
  });

  it('completes only root Codex errors in multi-agent App Advisor chats', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-root-error',
        text: 'Inspect the failure',
        providerType: 'codex',
        model: 'gpt-5.5',
        sdkSessionId: 'thread-root',
      },
      makeOptions(),
    );

    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) throw new Error('Expected App Advisor event handler');
    void onEvent({
      type: 'codex',
      event: { type: 'error', thread_id: 'thread-child' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completeChatTurnMock).not.toHaveBeenCalled();

    void onEvent({
      type: 'codex',
      event: { type: 'error', thread_id: 'thread-root' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completeChatTurnMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-one',
      'advisor-chat',
      'failure',
      undefined,
    );
  });

  it('omits telemetry and delivery when a provider event is deduplicated', async () => {
    const options = makeOptions();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
      },
      options,
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) throw new Error('Expected App Advisor event handler');
    ingestProviderEventMock.mockResolvedValueOnce(false);
    jest.mocked(sendToWindowDetailed).mockClear();

    void onEvent({ type: 'assistant_delta', content: 'Duplicate' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observeChatEventMock).not.toHaveBeenCalled();
    expect(sendToWindowDetailed).not.toHaveBeenCalled();
  });

  it('delivers an activity-only provider event but not a rejected one', async () => {
    const options = makeOptions();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
      },
      options,
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) throw new Error('Expected App Advisor event handler');
    // The event carries no durable change, so it is not a commit.
    ingestProviderEventMock.mockResolvedValueOnce(false);
    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'activity-only' };
      },
    );
    jest.mocked(sendToWindowDetailed).mockClear();
    const progress = { type: 'system', subtype: 'status', status: 'busy' };

    void onEvent(progress);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observeChatEventMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-one',
      'advisor-chat',
      progress,
    );
    expect(sendToWindowDetailed).toHaveBeenCalledWith(
      options.getMainWindow(),
      'chat:event',
      expect.objectContaining({ chatId: 'advisor-chat', data: progress }),
    );

    ingestProviderEventMock.mockResolvedValueOnce(false);
    ingestProviderEventWithResultMock.mockImplementationOnce(
      async (input: unknown) => {
        await ingestProviderEventMock(input);
        return { outcome: 'not-applied' };
      },
    );
    observeChatEventMock.mockClear();
    jest.mocked(sendToWindowDetailed).mockClear();

    void onEvent({ type: 'system', subtype: 'status', status: 'idle' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observeChatEventMock).not.toHaveBeenCalled();
    expect(sendToWindowDetailed).not.toHaveBeenCalled();
  });

  it('routes approval-capable session events to the App Advisor window', async () => {
    const options = makeOptions();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
      },
      options,
    );

    const getSessionWindow = jest.mocked(getOrCreateSession).mock.calls[0]?.[2];
    expect(getSessionWindow?.()).toBe(options.getAppAdvisorWindow());
  });

  it('constructs the App Advisor runtime with the current chat destination', async () => {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat-destination',
        userMessageId: 'message-1',
        text: 'Watch this',
      },
      makeOptions(),
    );

    expect(createAppAdvisorToolRuntime).toHaveBeenCalledWith(
      expect.any(Object),
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat-destination',
      },
      {
        providerType: 'codex',
        approvalMode: 'auto',
        sessionApprovalRules: [],
        deferredToolsAllowed: true,
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    );
  });

  it('rejects the legacy global slot as a send target', async () => {
    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatId: 'advisor-chat',
          userMessageId: 'message-1',
          text: 'Do not send',
        },
        makeOptions(),
      ),
    ).rejects.toThrow('legacy global chats are read-only');
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown App Advisor entry', async () => {
    jest.mocked(listWorkEntryIds).mockResolvedValueOnce(['entry-one']);

    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-missing',
          chatId: 'advisor-chat',
          userMessageId: 'message-1',
          text: 'Do not send',
        },
        makeOptions(),
      ),
    ).rejects.toThrow('Unknown App Advisor Work Entry entry-missing');
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });
});

describe('App Advisor portal event projection (CAN-2565)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve: (value: T) => void = () => {
      throw new Error('Deferred value was not initialized');
    };
    const promise = new Promise<T>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  function readProperty(value: object, key: string): unknown {
    return Reflect.get(value, key) as unknown;
  }

  function isSyntheticCancelledWindowEvent(call: readonly unknown[]): boolean {
    if (call[1] !== 'chat:event') return false;
    const envelope = call[2];
    if (!envelope || typeof envelope !== 'object') return false;
    const data = readProperty(envelope, 'data');
    return (
      data !== null &&
      typeof data === 'object' &&
      Reflect.get(data, 'type') === 'result' &&
      Reflect.get(data, 'result') === 'Cancelled'
    );
  }

  function isCancelledPortalMessage(call: readonly unknown[]): boolean {
    const event = call[0];
    if (!event || typeof event !== 'object') return false;
    const payload = readProperty(event, 'payload');
    if (!payload || typeof payload !== 'object') return false;
    const message = readProperty(payload, 'message');
    return (
      message !== null &&
      typeof message === 'object' &&
      Reflect.get(message, 'status') === 'cancelled'
    );
  }

  async function emitCommittedEvent(
    onEvent: (data: unknown) => void,
    data: unknown,
  ): Promise<void> {
    onEvent(data);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function dispatchAndGetEventHandler(): Promise<
    (data: unknown) => void
  > {
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-1',
        text: 'Inspect the UI',
      },
      makeOptions(),
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor event handler');
    }
    return onEvent;
  }

  it('emits nothing to the portal when no session is connected', async () => {
    const onEvent = await dispatchAndGetEventHandler();
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });

    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });

  it('mirrors the user message and streamed events as portal.app_advisor.event', async () => {
    portalActive = true;
    const onEvent = await dispatchAndGetEventHandler();

    const userEvent = enqueuePortalEventMock.mock.calls[0]?.[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(userEvent.type).toBe('portal.app_advisor.event');
    // No scope/workspace routing on the wire — the server pins the scope
    // from the event type, so the payload carries exactly chatId + message.
    expect(Object.keys(userEvent.payload).sort()).toEqual([
      'chatId',
      'message',
    ]);
    expect(userEvent.payload.chatId).toBe('advisor-chat');
    expect(userEvent.payload.message).toMatchObject({
      messageId: 'message-1',
      chatId: 'advisor-chat',
      role: 'user',
      status: 'complete',
      text: 'Inspect the UI',
    });

    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });
    const streamedEvent = enqueuePortalEventMock.mock.calls[1]?.[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(streamedEvent.type).toBe('portal.app_advisor.event');
    expect(streamedEvent.payload.chatId).toBe('advisor-chat');
    expect(streamedEvent.payload.message).toMatchObject({
      // Fallback id keyed on the originating user message, matching the
      // worktree portal convention.
      messageId: 'message-1:assistant',
      role: 'assistant',
      text: 'Working',
    });
  });

  it('leaves App Advisor portal turn timers to committed turn state', async () => {
    portalActive = true;
    const onEvent = await dispatchAndGetEventHandler();
    await emitCommittedEvent(onEvent, {
      type: 'result',
      is_error: false,
      result: 'Done',
    });
    const messageIds = enqueuePortalEventMock.mock.calls.flatMap(
      ([event]): unknown[] => {
        if (typeof event !== 'object' || event === null) return [];
        const payload: unknown = Reflect.get(event, 'payload');
        if (typeof payload !== 'object' || payload === null) return [];
        const message: unknown = Reflect.get(payload, 'message');
        return typeof message === 'object' && message !== null
          ? [Reflect.get(message, 'messageId')]
          : [];
      },
    );
    expect(messageIds).toContain('message-1');
    expect(
      messageIds.filter(
        (id) => typeof id === 'string' && id.endsWith(':turn-timer'),
      ),
    ).toEqual([]);
  });

  it('keeps a watcher-shaped dispatch request out of the portal mirror and the recorded turn text (CAN-2569)', async () => {
    // Dispatch-level contract only: the request below is the exact shape the
    // App Advisor renderer produces for a `send_watcher_message` window
    // command (hiddenContext kind `canopy-watcher-event` + watcherFired), fed
    // straight into dispatchAppAdvisorChatMessage. The window-command →
    // renderer → chatSendMessage forwarding leg is NOT exercised here — that
    // end-to-end chain is covered by the CAN-2570 Electron E2E spec.
    portalActive = true;
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-watcher-chat',
        userMessageId: 'watcher-message-1',
        text: 'Pipeline completion watcher fired',
        assistantMode: 'app-advisor',
        hiddenContext: {
          kind: 'canopy-watcher-event',
          // Sentinel chosen to collide with nothing else in the dispatch
          // inputs (model ids, system prompt, tab metadata), so a substring
          // scan over any captured record is a definitive leak check.
          text: '<watcher_event>HIDDEN-WATCHER-SECRET-2569</watcher_event>',
        },
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      makeOptions(),
    );

    const userEvent = enqueuePortalEventMock.mock.calls[0]?.[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(userEvent.type).toBe('portal.app_advisor.event');
    expect(userEvent.payload.chatId).toBe('advisor-watcher-chat');
    expect(userEvent.payload.message).toMatchObject({
      messageId: 'watcher-message-1',
      role: 'user',
      status: 'complete',
      // Visible text only — the hidden watcher context goes to the provider
      // but must not leak into the mirrored portal transcript.
      text: 'Pipeline completion watcher fired',
    });
    // Whole-envelope scan, not just the text field: no portal payload part
    // may carry the hidden context.
    expect(JSON.stringify(userEvent)).not.toContain(
      'HIDDEN-WATCHER-SECRET-2569',
    );
    expect(ingestProviderEventMock.mock.calls[0]?.[0]).toMatchObject({
      data: {
        canopy_persisted_messages: [
          {
            id: 'watcher-message-1',
            watcherFired: { kind: 'Pipeline completion (Deploy)' },
          },
        ],
      },
    });
    // The provider still receives the hidden context ahead of the message.
    expect(sendMessageMock).toHaveBeenCalledWith(
      [
        '<watcher_event>HIDDEN-WATCHER-SECRET-2569</watcher_event>',
        '',
        'Pipeline completion watcher fired',
      ].join('\n'),
      { userMessageId: 'watcher-message-1' },
    );
    // Persisted-record path: the observability turn record is what this suite
    // captures of the durable turn text (originalUserText/submittedText feed
    // transcripts and audit); both must carry the visible text only. The
    // persisted TAB write happens renderer-side and its summary projection is
    // covered in app-advisor-chat-summaries.test.ts.
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        originalUserText: 'Pipeline completion watcher fired',
        submittedText: 'Pipeline completion watcher fired',
      }),
    );
    const recordedTurn = startChatTurnMock.mock.calls[0]?.[0];
    expect(JSON.stringify(recordedTurn)).not.toContain(
      'HIDDEN-WATCHER-SECRET-2569',
    );
  });

  it('drops non-message runtime records from the portal mirror', async () => {
    portalActive = true;
    const onEvent = await dispatchAndGetEventHandler();
    enqueuePortalEventMock.mockClear();

    await emitCommittedEvent(onEvent, {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    });

    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });

  it('fans the synthetic cancel result out to both windows', async () => {
    const options = makeOptions();
    await emitAppAdvisorSyntheticResultEvent('advisor-chat', {
      ...options.toolSurfaces,
    });

    const chatEventSends = jest
      .mocked(sendToWindowDetailed)
      .mock.calls.filter((call) => call[1] === 'chat:event');
    expect(chatEventSends).toHaveLength(2);
    expect(chatEventSends[0]?.[2]).toEqual({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      chatId: 'advisor-chat',
      data: { type: 'result', is_error: false, result: 'Cancelled' },
    });
  });

  it('honors an explicitly captured fence after a newer send replaces the frame', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    portalActive = true;
    const options = makeOptions();
    const oldOnEvent = await dispatchAndGetEventHandler();
    await emitCommittedEvent(oldOnEvent, {
      type: 'assistant_delta',
      content: 'Captured old turn',
    });

    const fence = captureAppAdvisorSyntheticResultFence('advisor-chat');
    const lookup =
      deferred<Awaited<ReturnType<typeof resolveWorkEntryForChat>>>();
    jest.mocked(resolveWorkEntryForChat).mockReturnValueOnce(lookup.promise);
    const pendingCancel = emitAppAdvisorSyntheticResultEvent(
      'advisor-chat',
      options.toolSurfaces,
      { fence, userMessageId: 'message-1' },
    );

    await emitCommittedEvent(oldOnEvent, {
      type: 'result',
      is_error: false,
      result: 'Old turn completed',
    });
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'newer-user-message',
        text: 'Start a newer turn',
      },
      options,
    );
    const newOnEvent = jest.mocked(getOrCreateSession).mock.calls[1]?.[1];
    if (!newOnEvent) {
      throw new Error('Expected the replacement App Advisor event handler');
    }
    await emitCommittedEvent(newOnEvent, {
      type: 'assistant_delta',
      content: 'Newer turn content',
    });
    expect(fence.isCurrent()).toBe(false);
    jest.mocked(sendToWindowDetailed).mockClear();
    enqueuePortalEventMock.mockClear();

    lookup.resolve({ entryId: 'entry-one', archivedInEntryId: null });
    await pendingCancel;

    try {
      expect(
        jest
          .mocked(sendToWindowDetailed)
          .mock.calls.filter(isSyntheticCancelledWindowEvent),
      ).toHaveLength(0);
      expect(
        enqueuePortalEventMock.mock.calls.filter(isCancelledPortalMessage),
      ).toHaveLength(0);
    } finally {
      await emitCommittedEvent(newOnEvent, {
        type: 'result',
        is_error: false,
        result: 'Newer turn completed',
      });
    }
  });

  it('rechecks the host eligibility guard after synthetic-result lookup', async () => {
    const options = makeOptions();
    const fence = captureAppAdvisorSyntheticResultFence('advisor-guard-chat');
    const lookup =
      deferred<Awaited<ReturnType<typeof resolveWorkEntryForChat>>>();
    jest.mocked(resolveWorkEntryForChat).mockReturnValueOnce(lookup.promise);
    let eligible = true;
    const pendingCancel = emitAppAdvisorSyntheticResultEvent(
      'advisor-guard-chat',
      options.toolSurfaces,
      {
        fence,
        userMessageId: 'stopped-user-message',
        isCurrent: () => eligible,
      },
    );
    eligible = false;
    jest.mocked(sendToWindowDetailed).mockClear();
    enqueuePortalEventMock.mockClear();

    lookup.resolve({ entryId: 'entry-one', archivedInEntryId: null });
    await pendingCancel;

    expect(
      jest
        .mocked(sendToWindowDetailed)
        .mock.calls.filter(isSyntheticCancelledWindowEvent),
    ).toHaveLength(0);
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });

  it('skips a delayed synthetic cancel after a real terminal closes its turn', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    portalActive = true;
    const onEvent = await dispatchAndGetEventHandler();
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'The turn is ending',
    });

    const lookup =
      deferred<Awaited<ReturnType<typeof resolveWorkEntryForChat>>>();
    jest.mocked(resolveWorkEntryForChat).mockReturnValueOnce(lookup.promise);
    const options = makeOptions();
    const pendingCancel = emitAppAdvisorSyntheticResultEvent(
      'advisor-chat',
      options.toolSurfaces,
    );

    await emitCommittedEvent(onEvent, {
      type: 'result',
      is_error: false,
      result: 'Done before Stop settled',
    });
    jest.mocked(sendToWindowDetailed).mockClear();
    enqueuePortalEventMock.mockClear();

    lookup.resolve({ entryId: 'entry-one', archivedInEntryId: null });
    await pendingCancel;

    expect(
      jest
        .mocked(sendToWindowDetailed)
        .mock.calls.filter(isSyntheticCancelledWindowEvent),
    ).toHaveLength(0);
    expect(
      enqueuePortalEventMock.mock.calls.filter(isCancelledPortalMessage),
    ).toHaveLength(0);
  });

  it('does not let a delayed synthetic cancel close a newer visible send', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    portalActive = true;
    const options = makeOptions();
    const oldOnEvent = await dispatchAndGetEventHandler();
    await emitCommittedEvent(oldOnEvent, {
      type: 'assistant_delta',
      content: 'Older turn content',
    });

    const lookup =
      deferred<Awaited<ReturnType<typeof resolveWorkEntryForChat>>>();
    jest.mocked(resolveWorkEntryForChat).mockReturnValueOnce(lookup.promise);
    const pendingCancel = emitAppAdvisorSyntheticResultEvent(
      'advisor-chat',
      options.toolSurfaces,
    );

    // Settle the old frame before the replacement send. Besides exercising the
    // stale-frame fence, this closes the old turn timer before the newer turn
    // installs its own timer.
    await emitCommittedEvent(oldOnEvent, {
      type: 'result',
      is_error: false,
      result: 'Older turn finished',
    });
    jest.mocked(sendToWindowDetailed).mockClear();
    enqueuePortalEventMock.mockClear();

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'newer-user-message',
        text: 'A newer turn',
      },
      options,
    );
    const newOnEvent = jest.mocked(getOrCreateSession).mock.calls[1]?.[1];
    if (!newOnEvent) {
      throw new Error('Expected the newer App Advisor event handler');
    }
    await emitCommittedEvent(newOnEvent, {
      type: 'assistant_delta',
      content: 'Newer turn content',
    });

    lookup.resolve({ entryId: 'entry-one', archivedInEntryId: null });
    await pendingCancel;

    try {
      expect(
        jest
          .mocked(sendToWindowDetailed)
          .mock.calls.filter(isSyntheticCancelledWindowEvent),
      ).toHaveLength(0);
      expect(
        enqueuePortalEventMock.mock.calls.filter(isCancelledPortalMessage),
      ).toHaveLength(0);
      expect(
        enqueuePortalEventMock.mock.calls.some((call) => {
          const event = call[0];
          if (!event || typeof event !== 'object') return false;
          const payload = readProperty(event, 'payload');
          if (!payload || typeof payload !== 'object') return false;
          const message = readProperty(payload, 'message');
          return (
            message !== null &&
            typeof message === 'object' &&
            Reflect.get(message, 'messageId') ===
              'newer-user-message:turn-timer' &&
            Reflect.get(message, 'status') === 'complete'
          );
        }),
      ).toBe(false);
    } finally {
      // Keep the newer turn's timer lifecycle tidy even when a red assertion
      // exposes a stale synthetic cancel on unchanged production.
      await emitCommittedEvent(newOnEvent, {
        type: 'result',
        is_error: false,
        result: 'Newer turn finished',
      });
    }
  });

  it('projects trusted agent sender attribution onto the Portal user echo only', async () => {
    portalActive = true;
    const agentSent = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'entry-one',
        chatId: 'source-chat',
      },
      chatTitle: 'Source chat',
      projectLabel: 'App Advisor',
    } satisfies ChatAgentSentInfo;
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-chat',
        userMessageId: 'message-agent-portal',
        text: 'Forwarded message',
        agentSent,
        agentSenderProvenance: {
          version: 1,
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'message-agent-portal',
          sender: agentSent.sender,
          owner: { kind: 'none' },
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>trusted</system_instruction>',
        },
      },
      makeOptions(),
    );

    const userEvent = enqueuePortalEventMock.mock.calls[0]?.[0] as {
      payload: { message: Record<string, unknown> };
    };
    expect(userEvent.payload.message).toMatchObject({
      role: 'user',
      messageId: 'message-agent-portal',
      agentSent,
    });
    expect(userEvent.payload.message).not.toHaveProperty(
      'agentSenderProvenance',
    );
  });

  it('does not let a delayed synthetic cancel terminalize a newer wake timer', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    portalActive = true;
    const options = makeOptions();
    const onEvent = await dispatchAndGetEventHandler();
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Earlier turn content',
    });

    const lookup =
      deferred<Awaited<ReturnType<typeof resolveWorkEntryForChat>>>();
    jest.mocked(resolveWorkEntryForChat).mockReturnValueOnce(lookup.promise);
    const pendingCancel = emitAppAdvisorSyntheticResultEvent(
      'advisor-chat',
      options.toolSurfaces,
    );

    await emitCommittedEvent(onEvent, {
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'newer-wake-attempt',
      startsTurn: true,
      userMessageId: 'newer-wake-root',
    });

    lookup.resolve({ entryId: 'entry-one', archivedInEntryId: null });
    await pendingCancel;

    try {
      expect(
        jest
          .mocked(sendToWindowDetailed)
          .mock.calls.filter(isSyntheticCancelledWindowEvent),
      ).toHaveLength(0);
      expect(
        enqueuePortalEventMock.mock.calls.filter((call) => {
          const event = call[0];
          if (!event || typeof event !== 'object') return false;
          const payload = readProperty(event, 'payload');
          if (!payload || typeof payload !== 'object') return false;
          const message = readProperty(payload, 'message');
          return (
            message !== null &&
            typeof message === 'object' &&
            Reflect.get(message, 'messageId') ===
              'newer-wake-root:turn-timer' &&
            Reflect.get(message, 'status') === 'complete'
          );
        }),
      ).toHaveLength(0);
    } finally {
      await emitCommittedEvent(onEvent, {
        type: 'result',
        is_error: false,
        result: 'Wake turn finished',
      });
    }
  });

  it('closes the streamed portal frame with a cancelled status on cancel', async () => {
    portalActive = true;
    const options = makeOptions();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-cancel-chat',
        userMessageId: 'message-cancel',
        text: 'Long task',
      },
      options,
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor event handler');
    }
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });
    enqueuePortalEventMock.mockClear();

    await emitAppAdvisorSyntheticResultEvent('advisor-cancel-chat', {
      ...options.toolSurfaces,
    });

    // A successful terminal `result` projects to no portal message, so the
    // cancel re-keys 'cancelled' onto the LAST streamed assistant frame —
    // same messageId and text, so the merge cannot clobber streamed content.
    const cancelEvent = enqueuePortalEventMock.mock.calls[0]?.[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(cancelEvent.type).toBe('portal.app_advisor.event');
    expect(cancelEvent.payload.chatId).toBe('advisor-cancel-chat');
    expect(cancelEvent.payload.message).toMatchObject({
      messageId: 'message-cancel:assistant',
      role: 'assistant',
      status: 'cancelled',
      text: 'Working',
    });
    // Summaries re-project so `turnActive` clears immediately.
    expect(projectAppAdvisorChatSummariesMock).toHaveBeenCalledWith(
      'entry-one',
    );
  });

  it('tags a synthetic App Advisor cancel with the stopped turn user message id', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    portalActive = true;
    const options = makeOptions();
    const chatId = 'advisor-tagged-cancel';
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId,
        userMessageId: 'stopped-user-message',
        text: 'Long task',
      },
      options,
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor event handler');
    }
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });
    jest.mocked(sendToWindowDetailed).mockClear();

    await Reflect.apply(emitAppAdvisorSyntheticResultEvent, undefined, [
      chatId,
      options.toolSurfaces,
      {
        fence: { isCurrent: (): boolean => true },
        userMessageId: 'stopped-user-message',
      },
    ]);

    const syntheticCancel = jest
      .mocked(sendToWindowDetailed)
      .mock.calls.find(isSyntheticCancelledWindowEvent);
    expect(syntheticCancel?.[2]).toMatchObject({
      data: {
        type: 'result',
        result: 'Cancelled',
        canopy_turn_user_message_id: 'stopped-user-message',
      },
    });
  });

  it('clears the remembered frame on terminal events even while the portal is disconnected', async () => {
    portalActive = true;
    const options = makeOptions();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-reconnect-chat',
        userMessageId: 'message-reconnect',
        text: 'Long task',
      },
      options,
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor event handler');
    }
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });

    // Portal disconnects, then the turn ends: the remembered frame must be
    // cleared regardless, or a reconnect + cancel would re-emit the prior
    // turn's content as newly cancelled.
    portalActive = false;
    await emitCommittedEvent(onEvent, {
      type: 'result',
      is_error: false,
      result: 'done',
    });
    portalActive = true;
    enqueuePortalEventMock.mockClear();

    await emitAppAdvisorSyntheticResultEvent('advisor-reconnect-chat', {
      ...options.toolSurfaces,
    });

    expect(
      enqueuePortalEventMock.mock.calls.filter(
        (call) =>
          (call[0] as { type?: string }).type === 'portal.app_advisor.event',
      ),
    ).toHaveLength(0);
    expect(projectAppAdvisorChatSummariesMock).toHaveBeenCalledWith(
      'entry-one',
    );
  });

  it('does not strand the remembered frame when cancelling while disconnected', async () => {
    portalActive = true;
    const options = makeOptions();
    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-offline-cancel',
        userMessageId: 'message-offline',
        text: 'Long task',
      },
      options,
    );
    const onEvent = jest.mocked(getOrCreateSession).mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected App Advisor event handler');
    }
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });

    // Cancel while disconnected: the synthetic terminal result must clear the
    // remembered frame even though nothing is emitted to the portal.
    portalActive = false;
    enqueuePortalEventMock.mockClear();
    await emitAppAdvisorSyntheticResultEvent('advisor-offline-cancel', {
      ...options.toolSurfaces,
    });
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();

    // A later reconnected cancel finds no stale frame to resurrect.
    portalActive = true;
    enqueuePortalEventMock.mockClear();
    await emitAppAdvisorSyntheticResultEvent('advisor-offline-cancel', {
      ...options.toolSurfaces,
    });
    expect(
      enqueuePortalEventMock.mock.calls.filter(
        (call) =>
          (call[0] as { type?: string }).type === 'portal.app_advisor.event',
      ),
    ).toHaveLength(0);
  });

  it('skips assistant frames with no text and no parts (stray trailing bubble)', async () => {
    portalActive = true;
    const onEvent = await dispatchAndGetEventHandler();
    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });
    enqueuePortalEventMock.mockClear();

    // Some providers close a turn with a content-less assistant record (own
    // UUID, status complete). Mirroring it rendered an empty dots row at the
    // end of the portal transcript.
    await emitCommittedEvent(onEvent, {
      type: 'assistant',
      message: { id: 'uuid-empty', content: [] },
    });
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();

    // And it must not be remembered either: a cancel re-keys 'cancelled' onto
    // the last REAL streamed frame, not the skipped empty one.
    const options = makeOptions();
    await emitAppAdvisorSyntheticResultEvent('advisor-chat', {
      ...options.toolSurfaces,
    });
    const cancelledFrames = enqueuePortalEventMock.mock.calls
      .map(
        (call) =>
          (
            call[0] as {
              payload: { message?: { messageId?: string; status?: string } };
            }
          ).payload.message,
      )
      .filter((message) => message?.status === 'cancelled');
    expect(cancelledFrames).toHaveLength(1);
    expect(cancelledFrames[0]).toMatchObject({
      messageId: 'message-1:assistant',
      text: 'Working',
    });
  });

  it('skips the cancel frame for a chat that never streamed, but still re-projects', async () => {
    portalActive = true;
    const options = makeOptions();

    await emitAppAdvisorSyntheticResultEvent('advisor-never-streamed', {
      ...options.toolSurfaces,
    });

    expect(
      enqueuePortalEventMock.mock.calls.filter(
        (call) =>
          (call[0] as { type?: string }).type === 'portal.app_advisor.event',
      ),
    ).toHaveLength(0);
    expect(projectAppAdvisorChatSummariesMock).toHaveBeenCalledWith(
      'entry-one',
    );
  });
});

describe('CAN-2835 retained provider callback', () => {
  it('routes a large Codex MCP result to shared ingest without truncation', async () => {
    let retained: ((data: unknown) => void) | undefined;
    jest.mocked(getOrCreateSession).mockImplementation((_opts, onEvent) => {
      retained = onEvent;
      return Promise.resolve({
        sendMessage: sendMessageMock,
        cancel: jest.fn(),
        destroy: jest.fn(),
        setPlanMode: setPlanModeMock,
        setApprovalMode: setApprovalModeMock,
        setThinkingLevel: jest.fn(),
        setModel: jest.fn(),
        setCodexAppServerIdleTimeoutMinutes: setCodexIdleMock,
      });
    });
    const body = `start-${'x'.repeat(65_536)}-end`;
    const event = {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'mcp-call-large',
          type: 'mcp_tool_call',
          status: 'completed',
          result: { content: [{ type: 'text', text: body }] },
        },
      },
    };
    const request = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      chatId: 'large-mcp-advisor',
      userMessageId: 'large-mcp-message',
      text: 'Inspect the result',
      providerType: 'codex' as const,
      model: 'gpt-5.5',
    };

    await dispatchAppAdvisorChatMessage(request, makeOptions());
    retained?.(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(ingestProviderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: event }),
    );
    expect(body).toHaveLength(65_546);
  });

  it.each(['claude', 'codex'] as const)(
    'routes two %s turns and rejects obsolete output',
    async (providerType) => {
      let retained: ((data: unknown) => void) | undefined;
      const shared = {
        sendMessage: sendMessageMock,
        cancel: jest.fn(),
        destroy: jest.fn(),
        setPlanMode: setPlanModeMock,
        setApprovalMode: setApprovalModeMock,
        setThinkingLevel: jest.fn(),
        setModel: jest.fn(),
        setCodexAppServerIdleTimeoutMinutes: setCodexIdleMock,
      };
      jest.mocked(getOrCreateSession).mockImplementation((_opts, onEvent) => {
        retained ??= onEvent;
        return Promise.resolve(shared);
      });
      const request = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'reuse-advisor',
        text: 'testing',
        providerType,
        model: providerType === 'claude' ? 'claude-opus-4-8' : 'gpt-5.5',
      };
      for (const userMessageId of ['first', 'second']) {
        await dispatchAppAdvisorChatMessage(
          { ...request, userMessageId },
          makeOptions(),
        );
        retained?.({
          type: 'assistant',
          canopy_turn_user_message_id: userMessageId,
          message: { content: [{ type: 'text', text: userMessageId }] },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            turnUserMessageId: userMessageId,
            mutationId: `${request.chatId}:${userMessageId}:provider:0`,
          }),
        );
      }
      ingestProviderEventMock.mockClear();
      retained?.({ type: 'assistant', canopy_turn_user_message_id: 'first' });
      retained?.({
        type: 'result',
        canopy_turn_user_message_id: 'first',
        is_error: false,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ingestProviderEventMock).not.toHaveBeenCalled();
    },
  );
});

describe('App Advisor Codex speed', () => {
  function makeSpeedSession(
    setters: {
      setSpeed?: jest.Mock;
      setFastMode?: jest.Mock;
      setCodexFastMode?: jest.Mock;
    } = {},
  ) {
    return {
      sendMessage: sendMessageMock,
      cancel: jest.fn(),
      destroy: jest.fn(),
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
      setModel: jest.fn(),
      setThinkingLevel: jest.fn(),
      ...setters,
    };
  }

  it('applies an exact Ultra fast selection to the session and records its tier', async () => {
    const setSpeed = jest.fn(() => Promise.resolve());
    const setFastMode = jest.fn(() => Promise.resolve());
    jest
      .mocked(getOrCreateSession)
      .mockResolvedValueOnce(makeSpeedSession({ setSpeed, setFastMode }));

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-speed',
        userMessageId: 'speed-selected',
        text: 'Go',
        providerType: 'codex',
        model: 'gpt-5.5',
        modelConfig: { speed: 'ultrafast' },
      },
      makeOptions(),
    );

    expect(setSpeed).toHaveBeenCalledWith('ultrafast');
    expect(setFastMode).not.toHaveBeenCalled();
    expect(
      jest.mocked(getOrCreateSession).mock.calls[0]?.[0].modelConfig,
    ).toEqual(expect.objectContaining({ speed: 'ultrafast', fastMode: false }));
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionHarness: 'codex',
        serviceTier: 'ultrafast',
      }),
    );
    expect(setSpeed.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('applies an Ultra fast Codex default exactly, never as a Regular boolean', async () => {
    jest.mocked(readPreferencesFile).mockResolvedValueOnce({
      ...DEFAULT_PREFERENCES,
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'high',
      codexAppServerIdleTimeoutMinutes: 10,
      codexMultiAgentAppAdvisorEnabled: false,
      rtkEnabled: true,
      providerModelConfigDefaults: { codex: { speed: 'ultrafast' } },
    });
    const setSpeed = jest.fn(() => Promise.resolve());
    const setFastMode = jest.fn(() => Promise.resolve());
    const setCodexFastMode = jest.fn(() => Promise.resolve());
    jest
      .mocked(getOrCreateSession)
      .mockResolvedValueOnce(
        makeSpeedSession({ setSpeed, setFastMode, setCodexFastMode }),
      );

    await dispatchAppAdvisorChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        chatId: 'advisor-speed-default',
        userMessageId: 'speed-default',
        text: 'Go',
      },
      makeOptions(),
    );

    expect(setSpeed).toHaveBeenCalledWith('ultrafast');
    expect(setFastMode).not.toHaveBeenCalled();
    expect(setCodexFastMode).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('rejects Ultra fast before any turn effect when the session cannot receive an exact speed', async () => {
    portalActive = true;
    const setFastMode = jest.fn(() => Promise.resolve());
    jest
      .mocked(getOrCreateSession)
      .mockResolvedValueOnce(makeSpeedSession({ setFastMode }));

    await expect(
      dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-speed-rejected',
          userMessageId: 'speed-rejected',
          text: 'Go',
          providerType: 'codex',
          model: 'gpt-5.5',
          modelConfig: { speed: 'ultrafast' },
        },
        makeOptions(),
      ),
    ).rejects.toMatchObject({
      name: 'CodexSpeedUnsupportedError',
      speed: 'ultrafast',
    });

    expect(setFastMode).not.toHaveBeenCalled();
    expect(startChatTurnMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
    expect(ingestProviderEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: 'advisor-speed-rejected:speed-rejected:accepted',
      }),
    );
    expect(releaseResourceMock).toHaveBeenCalled();
  });
});

describe('app-advisor turn-start authority (CAN-4940)', () => {
  const target = {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'entry-one',
    chatId: 'advisor-authority',
    userMessageId: 'authority-message',
  };
  const grant: ApprovalRule = {
    id: 'grant',
    behavior: 'allow',
    target: { kind: 'command', pattern: 'npm test *' },
    createdAt: '2026-10-24T00:00:00.000Z',
    origin: 'prompt',
  };
  const deny: ApprovalRule = {
    ...grant,
    id: 'deny',
    behavior: 'deny',
    target: { kind: 'command', pattern: 'rm *' },
  };
  function savedAuthority(
    approvalMode: ApprovalMode,
    sessionApprovalRules: ApprovalRule[] = [],
  ): ChatTabsFile {
    return {
      version: 1,
      activeTabId: target.chatId,
      tabs: [
        {
          id: target.chatId,
          title: 'Authority',
          messages: [],
          createdAt: grant.createdAt,
          approvalMode,
          sessionApprovalRules,
        },
      ],
    };
  }
  beforeEach(() =>
    clearLiveApprovalMode(target.projectId, target.worktreeId, target.chatId),
  );
  afterEach(() =>
    clearLiveApprovalMode(target.projectId, target.worktreeId, target.chatId),
  );
  it.each([
    { saved: 'ask', requested: 'full-access', expected: 'ask', grants: false },
    { saved: 'full-access', requested: 'ask', expected: 'ask', grants: false },
    {
      saved: 'full-access',
      requested: 'full-access',
      expected: 'full-access',
      grants: true,
    },
  ] as const)(
    'uses saved $saved narrowed by $requested',
    async ({ saved, requested, expected, grants }) => {
      const savedRules = grants ? [grant] : [];
      const expectedRules = [...savedRules, deny];
      mockReadAuthorityTabs.mockResolvedValue(
        savedAuthority(saved, savedRules),
      );
      await dispatchAppAdvisorChatMessage(
        {
          ...target,
          text: 'npm test',
          providerType: 'codex',
          model: 'gpt-5.5',
          approvalMode: requested,
          sessionApprovalRules: [grant, deny],
        },
        makeOptions(),
      );
      expect(jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          approvalMode: expected,
          sessionApprovalRules: expectedRules,
        }),
      );
      expect(setApprovalModeMock).toHaveBeenLastCalledWith(expected);
      expect(
        getLiveApprovalMode(target.projectId, target.worktreeId, target.chatId),
      ).toBe(expected);

      expect(
        jest.mocked(createAppAdvisorToolRuntime).mock.calls.at(-1)?.[2],
      ).toEqual(
        expect.objectContaining({
          approvalMode: expected,
          sessionApprovalRules: expectedRules,
        }),
      );
    },
  );
  it.each(['missing', 'unreadable', 'admitted'] as const)(
    'fails closed or narrows with %s authority',
    async (state) => {
      if (state === 'unreadable')
        mockReadAuthorityTabs.mockRejectedValue(new Error('unreadable'));
      if (state === 'admitted')
        mockReadAuthorityTabs.mockResolvedValue(
          savedAuthority('full-access', [grant]),
        );
      await dispatchAppAdvisorChatMessage(
        {
          ...target,
          text: 'Continue',
          model: 'gpt-5.5',
          providerType: 'codex',
          approvalMode: 'full-access',
          sessionApprovalRules: [grant, deny],
          ...(state === 'admitted'
            ? {
                admittedApproval: {
                  approvalMode: 'ask',
                  sessionApprovalRules: [],
                },
              }
            : {}),
        },
        makeOptions(),
      );
      expect(jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          approvalMode: state === 'missing' ? 'auto' : 'ask',
          sessionApprovalRules: [deny],
        }),
      );
      if (state === 'admitted')
        expect(
          getLiveApprovalMode(
            target.projectId,
            target.worktreeId,
            target.chatId,
          ),
        ).toBe('full-access');
      expect(ensureChatForTrustedSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalMode:
            state === 'admitted'
              ? 'full-access'
              : state === 'missing'
                ? 'auto'
                : 'ask',
        }),
      );
    },
  );

  it.each(['ask', 'full-access'] as const)(
    'rereads a grant removed during session creation before sending at %s',
    async (mode) => {
      mockReadAuthorityTabs
        .mockResolvedValueOnce(savedAuthority('full-access', [grant]))
        .mockResolvedValue(savedAuthority(mode, [deny]));
      await dispatchAppAdvisorChatMessage(
        {
          ...target,
          text: 'Continue',
          model: 'gpt-5.5',
          providerType: 'codex',
        },
        makeOptions(),
      );
      expect(
        jest.mocked(createAppAdvisorToolRuntime).mock.calls.at(-1)?.[2],
      ).toEqual(
        expect.objectContaining({
          approvalMode: mode,
          sessionApprovalRules: [deny],
        }),
      );
      expect(
        jest.mocked(createAppAdvisorToolRuntime).mock.calls.at(-1)?.[2]
          ?.sessionApprovalRules,
      ).toBe(
        jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0]
          .sessionApprovalRules,
      );
      expect(setApprovalModeMock).toHaveBeenLastCalledWith(mode);
      expect(
        jest.mocked(restrictSessionApprovalRules),
      ).toHaveBeenLastCalledWith(
        target.projectId,
        target.worktreeId,
        target.chatId,
        [deny],
      );
    },
  );

  it.each(['ask', 'full-access'] as const)(
    'rechecks authority after asynchronous watcher setup at %s',
    async (mode) => {
      mockReadAuthorityTabs.mockResolvedValue(
        savedAuthority('full-access', [grant]),
      );
      handleCanonicalChatStartedEventMock.mockImplementationOnce(() => {
        mockReadAuthorityTabs.mockResolvedValue(savedAuthority(mode, [deny]));
        return Promise.resolve();
      });
      await dispatchAppAdvisorChatMessage(
        {
          ...target,
          text: 'npm test',
          model: 'gpt-5.5',
          providerType: 'codex',
        },
        makeOptions(),
      );
      expect(handleCanonicalChatStartedEventMock).toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalled();
      expect(setApprovalModeMock).toHaveBeenLastCalledWith(mode);
      expect(
        jest.mocked(createAppAdvisorToolRuntime).mock.calls.at(-1)?.[2],
      ).toEqual(
        expect.objectContaining({
          approvalMode: mode,
          sessionApprovalRules: [deny],
        }),
      );
      expect(
        jest.mocked(restrictSessionApprovalRules),
      ).toHaveBeenLastCalledWith(
        target.projectId,
        target.worktreeId,
        target.chatId,
        [deny],
      );
    },
  );

  it('keeps a retained runtime within a later turn when setup changed its original mode', async () => {
    let appliedMode: ApprovalMode = 'ask';
    const shared: AgentSession = {
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      setApprovalMode: (mode) => {
        appliedMode = mode;
        return Promise.resolve();
      },
      getAppliedApprovalMode: () => appliedMode,
      cancel: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      setThinkingLevel: () => Promise.resolve(),
    };
    mockReadAuthorityTabs.mockResolvedValue(savedAuthority('ask'));
    jest.mocked(getOrCreateSession).mockImplementationOnce(() => {
      // A legitimate user widening can land while the first session starts.
      mockReadAuthorityTabs.mockResolvedValue(savedAuthority('full-access'));
      setLiveApprovalMode(
        target.projectId,
        target.worktreeId,
        target.chatId,
        'full-access',
      );
      return Promise.resolve(shared);
    });
    await dispatchAppAdvisorChatMessage(
      { ...target, text: 'Start', model: 'gpt-5.5', providerType: 'codex' },
      makeOptions(),
    );
    const retainedContext = jest
      .mocked(createAppAdvisorToolRuntime)
      .mock.calls.at(-1)?.[2];
    const firstOptions = jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0];
    expect(retainedContext?.approvalMode).toBe('full-access');

    // Matching options reuse the provider's first runtime, not the newly built one.
    jest.mocked(getOrCreateSession).mockResolvedValueOnce(shared);
    await dispatchAppAdvisorChatMessage(
      {
        ...target,
        userMessageId: 'narrow-turn',
        text: 'Continue in Ask',
        model: 'gpt-5.5',
        providerType: 'codex',
        approvalMode: 'ask',
      },
      makeOptions(),
    );
    expect(
      jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0].toolProfileHash,
    ).toBe(firstOptions?.toolProfileHash);
    expect(appliedMode).toBe('ask');
    expect(retainedContext?.approvalMode).toBe('ask');
  });

  it.each([
    ['cold', 'revoked allow'],
    ['cold', 'committed deny'],
    ['warm', 'revoked allow'],
    ['warm', 'committed deny'],
    ['warm', 'narrowed mode'],
    ['warm', 'admitted cap'],
  ] as const)(
    'enforces %s WatchCommand approvals with %s after setup',
    async (reuse, change) => {
      // Real session reuse, runtime and approval engine; no provider SDK or shell execution.
      const manager = jest.requireActual<typeof SessionManager>(
        '../agents/session-manager',
      );
      const advisor = jest.requireActual<typeof AdvisorRuntime>(
        '../app-advisor/runtime',
      );
      const ruleSources = await import('../approvals/approval-rule-sources');
      const promptBridge = await import('../approvals/prompt-bridge');
      const auth = await import('../auth/provider-auth-state');
      const workOwner = await import('../agents/work-owner');
      const modelPolicy = await import('../lib/model-policy-state');
      const accountProxy = await import('../account-proxy/routing');
      const advisorIpc = await import('../ipc/app-advisor');
      const worktree = await import('../lib/resolve-worktree');
      jest
        .spyOn(auth, 'ensureProviderAuthBaselineForSession')
        .mockResolvedValue(true);
      jest
        .spyOn(auth, 'peekProviderNativeAuthAvailability')
        .mockReturnValue({ ollama: true });
      jest
        .spyOn(workOwner, 'captureSessionWorkOwner')
        .mockImplementation(() => undefined);
      jest
        .spyOn(workOwner, 'resolveSessionWorkOwner')
        .mockResolvedValue({ kind: 'personal' });
      jest
        .spyOn(modelPolicy, 'isModelBlockedByStoredPolicy')
        .mockResolvedValue(false);
      jest
        .spyOn(accountProxy, 'previewAccountProxySessionRoute')
        .mockResolvedValue(false);
      jest
        .spyOn(ruleSources, 'readWorkspaceApprovalRuleTier')
        .mockResolvedValue({ rules: [], unreadable: false });
      jest
        .spyOn(ruleSources, 'readGlobalApprovalRuleTier')
        .mockResolvedValue({ rules: [], unreadable: false });
      jest
        .spyOn(ruleSources, 'isPathCaseInsensitiveAt')
        .mockResolvedValue(false);
      jest
        .spyOn(ruleSources, 'protectedApprovalFileWritePaths')
        .mockResolvedValue([]);
      const prompt = jest
        .spyOn(promptBridge, 'requestApprovalFromRenderer')
        .mockResolvedValue({ behavior: 'deny', scope: 'once' });
      jest
        .spyOn(worktree, 'resolveWorktreeCwd')
        .mockReturnValue(jest.requireActual<typeof os>('node:os').tmpdir());
      jest
        .spyOn(advisorIpc, 'getCachedAppAdvisorUiStateForChat')
        .mockReturnValue({
          version: 1,
          revision: 1,
          capturedAt: grant.createdAt,
          digest: 'authority',
          snapshot: {
            activePage: 'main',
            archivedContainers: { count: 0, viewerOpen: false },
            overlays: {
              commandPaletteOpen: false,
              fileSearchPaletteOpen: false,
              prPickerOpen: false,
              canopyPortalOpen: false,
              appAdvisorOpen: true,
            },
            selectedWorktree: {
              projectId: 'project-one',
              worktreeId: 'worktree-one',
            },
          },
        });
      const createRuntimeImplementation = jest
        .mocked(createAppAdvisorToolRuntime)
        .getMockImplementation();
      const getSessionImplementation = jest
        .mocked(getOrCreateSession)
        .getMockImplementation();
      const restrictRulesImplementation = jest
        .mocked(restrictSessionApprovalRules)
        .getMockImplementation();
      jest
        .mocked(createAppAdvisorToolRuntime)
        .mockImplementation(advisor.createAppAdvisorToolRuntime);
      jest
        .mocked(getOrCreateSession)
        .mockImplementation(manager.getOrCreateSession);
      jest
        .mocked(restrictSessionApprovalRules)
        .mockImplementation(manager.restrictSessionApprovalRules);
      const command = {
        command: 'npm test --runInBand',
        intervalSeconds: 5,
        maxAttempts: 1,
      };
      const matchingDeny: ApprovalRule = {
        ...grant,
        id: 'command-deny',
        behavior: 'deny',
      };
      const initialMode = change === 'committed deny' ? 'full-access' : 'ask';
      const narrowsMode =
        change === 'narrowed mode' || change === 'admitted cap';
      const initialRules = narrowsMode ? [] : [grant];
      mockReadAuthorityTabs.mockResolvedValue(
        savedAuthority(initialMode, initialRules),
      );
      const watchOutcomes: Array<'allowed' | 'denied'> = [];
      let watchTask: Promise<void> | undefined;
      const retainedRuntimes: AdvisorRuntime.AppAdvisorToolRuntime[] = [];
      mockCreateCodexSession.mockImplementation((opts) => {
        const runtime = opts.appAdvisorRuntime;
        if (!runtime?.watchCommand)
          throw new Error('Expected actual WatchCommand runtime');
        retainedRuntimes.push(runtime);
        const session: AgentSession = {
          sendMessage: () => {
            watchTask = runtime.watchCommand?.(command).then(
              () => {
                watchOutcomes.push('allowed');
              },
              (error: unknown) => {
                expect(error).toEqual(
                  new Error('WatchCommand registration was denied.'),
                );
                watchOutcomes.push('denied');
              },
            );
          },
          setPlanMode: () => Promise.resolve(),
          setApprovalMode: () => Promise.resolve(),
          cancel: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
          setModel: () => Promise.resolve(),
          setThinkingLevel: () => Promise.resolve(),
        };
        manager.registerSession(
          `${opts.projectId}/${opts.worktreeId}/${opts.chatId}`,
          session,
          new AbortController(),
          'codex',
          opts.model,
          opts.assistantMode,
          opts.toolProfileHash,
        );
        return session;
      });
      const request = {
        ...target,
        text: command.command,
        model: 'gpt-5.5',
        providerType: 'codex' as const,
      };
      try {
        if (reuse === 'warm') {
          if (narrowsMode) {
            handleCanonicalChatStartedEventMock.mockImplementationOnce(() => {
              mockReadAuthorityTabs.mockResolvedValue(
                savedAuthority('full-access'),
              );
              setLiveApprovalMode(
                target.projectId,
                target.worktreeId,
                target.chatId,
                'full-access',
              );
              return Promise.resolve();
            });
          }
          await dispatchAppAdvisorChatMessage(request, makeOptions());
          if (!watchTask) throw new Error('Expected WatchCommand execution');
          await watchTask;
          expect(watchOutcomes).toEqual(['allowed']);
          expect(createLocalWatcherMock).toHaveBeenCalledTimes(1);
          expect(prompt).not.toHaveBeenCalled();
          createLocalWatcherMock.mockClear();
        }
        handleCanonicalChatStartedEventMock.mockImplementationOnce(() => {
          mockReadAuthorityTabs.mockResolvedValue(
            savedAuthority(
              change === 'committed deny' || change === 'admitted cap'
                ? 'full-access'
                : 'ask',
              change === 'committed deny' ? [matchingDeny] : [],
            ),
          );
          return Promise.resolve();
        });
        await dispatchAppAdvisorChatMessage(
          {
            ...request,
            userMessageId: 'restricted-watch-turn',
            ...(change === 'narrowed mode'
              ? { approvalMode: 'ask' as const }
              : {}),
            ...(change === 'admitted cap'
              ? {
                  admittedApproval: {
                    approvalMode: 'ask' as const,
                    sessionApprovalRules: [],
                  },
                }
              : {}),
          },
          makeOptions(),
        );
        if (!watchTask) throw new Error('Expected WatchCommand execution');
        await watchTask;
        expect(watchOutcomes.at(-1)).toBe('denied');
        expect(retainedRuntimes).toHaveLength(1);
        expect(mockCreateCodexSession).toHaveBeenCalledTimes(1);
        expect(createLocalWatcherMock).not.toHaveBeenCalled();
        if (change === 'admitted cap') {
          // The chat stays wide; only the reused provider's turn is capped.
          expect(
            getLiveApprovalMode(
              target.projectId,
              target.worktreeId,
              target.chatId,
            ),
          ).toBe('full-access');
        }
        expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'approval_decision',
            decision: 'deny',
            scope: change === 'committed deny' ? 'session' : 'once',
            targetKind: 'command',
          }),
        );
        if (change === 'committed deny') expect(prompt).not.toHaveBeenCalled();
        else expect(prompt).toHaveBeenCalledTimes(1);
      } finally {
        manager.unregisterSession(
          `${target.projectId}/${target.worktreeId}/${target.chatId}`,
        );
        jest.mocked(getOrCreateSession).mockReset();
        if (getSessionImplementation)
          jest
            .mocked(getOrCreateSession)
            .mockImplementation(getSessionImplementation);
        jest.mocked(restrictSessionApprovalRules).mockReset();
        if (restrictRulesImplementation)
          jest
            .mocked(restrictSessionApprovalRules)
            .mockImplementation(restrictRulesImplementation);
        jest.mocked(createAppAdvisorToolRuntime).mockReset();
        if (createRuntimeImplementation)
          jest
            .mocked(createAppAdvisorToolRuntime)
            .mockImplementation(createRuntimeImplementation);
      }
    },
  );

  it('rechecks saved authority through its deferred-tools resume handler', async () => {
    const registration = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    mockReadAuthorityTabs.mockResolvedValue(
      savedAuthority('full-access', [grant]),
    );
    try {
      await dispatchAppAdvisorChatMessage(
        {
          ...target,
          text: 'Start',
          model: 'gpt-5.5',
          providerType: 'codex',
          approvalMode: 'full-access',
          sessionApprovalRules: [grant],
        },
        makeOptions(),
      );
      const resume = registration.mock.calls.find(
        ([scope]) => scope.chatId === target.chatId,
      )?.[1];
      if (!resume) throw new Error('Missing deferred-tools resume handler');
      mockReadAuthorityTabs.mockResolvedValue(savedAuthority('ask'));
      setLiveApprovalMode(
        target.projectId,
        target.worktreeId,
        target.chatId,
        'full-access',
      );
      await resume({
        scope: target,
        requestId: 'reload-authority',
        toolCallId: 'tool',
        userMessageId: target.userMessageId,
        continuationText: 'Continue',
        enabledResources: [],
        sdkSessionId: undefined,
        providerType: 'codex',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        signal: new AbortController().signal,
      });
      expect(jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          approvalMode: 'ask',
          sessionApprovalRules: [],
        }),
      );
      expect(setApprovalModeMock).toHaveBeenLastCalledWith('ask');
    } finally {
      registration.mockRestore();
    }
  });

  it('rechecks registered send admission before creating a provider session', async () => {
    mockReadAuthorityTabs.mockResolvedValue(savedAuthority('ask'));
    await expect(
      withChatSendAdmission(
        target,
        () => 'Authority changed',
        () =>
          dispatchAppAdvisorChatMessage(
            {
              ...target,
              text: 'Start',
              model: 'gpt-5.5',
              providerType: 'codex',
            },
            makeOptions(),
          ),
      ),
    ).rejects.toThrow('Authority changed');
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

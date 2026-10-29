import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import { browserHandoffs } from '../browser/browser-handoffs';
import {
  capturePresentationTurn,
  clearPresentationTurn,
  recordPresentationTurn,
} from '../canopy-tools/presentation-state';
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type * as os from 'node:os';
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
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: () => ({
    handleCanonicalChatStartedEvent: handleCanonicalChatStartedEventMock,
    handleCanonicalChatTerminalEvent: handleCanonicalChatTerminalEventMock,
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
const startChatTurnMock = jest.fn<void, [Record<string, unknown>]>();
const openAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: true, focused: true }),
);
const ensureAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: false, focused: false }),
);
const ensureChatForTrustedSendMock = jest.fn(() => Promise.resolve());
const ingestProviderEventMock = jest.fn<Promise<boolean>, [input?: unknown]>(
  () => Promise.resolve(true),
);
// Delivery reads the three-way outcome; by default it mirrors the boolean
// commit mock so existing commit expectations keep their meaning.
const ingestOutcomeFromCommit = async (
  input: unknown,
): Promise<ProviderEventIngestOutcome> =>
  (await ingestProviderEventMock(input)) ? 'applied' : 'not-applied';
const ingestProviderEventWithOutcomeMock = jest.fn(ingestOutcomeFromCommit);
const hasMutationMock = jest.fn(() => Promise.resolve(false));
const observeChatEventMock = jest.fn();
const completeChatTurnMock = jest.fn();
const runWithScopeActivityMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    runWithScopeActivity: runWithScopeActivityMock,
    ensureChatForTrustedSend: ensureChatForTrustedSendMock,
    hasMutation: hasMutationMock,
    ingestProviderEvent: ingestProviderEventMock,
    ingestProviderEventWithOutcome: ingestProviderEventWithOutcomeMock,
    claimNewChatStarted: claimNewChatStartedMock,
  }),
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
}));

jest.mock('../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  destroySession: jest.fn(() => Promise.resolve()),
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

jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatDispatchMetadata: jest.fn(() => Promise.resolve({})),
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    observeChatEvent: observeChatEventMock,
    startChatTurn: startChatTurnMock,
    completeChatTurn: completeChatTurnMock,
    pauseChatTurn: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
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

jest.mock('../opencode/connection', () => ({
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
  type AppAdvisorUiStateEnvelope,
  type ChatAgentSentInfo,
} from '@canopy/desktop-shared/types';
import {
  dispatchAppAdvisorChatMessage,
  emitAppAdvisorSyntheticResultEvent,
} from '../app-advisor/chat-service';
import {
  destroySession,
  getActiveSessionInfos,
  getOrCreateSession,
} from '../agents/session-manager';
import { readPersistedChatDispatchMetadata } from '../lib/chat-tabs-reader';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import { sendToWindowDetailed } from '../lib/window-send';
import { createAppAdvisorToolRuntime } from '../app-advisor/runtime';
import { listWorkEntryIds } from '../lib/cowork-work-entries';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { getChatQueueService } from '../services/chat-queue-service';
import {
  clearLiveApprovalMode,
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

beforeEach(() => {
  jest.restoreAllMocks();
  deferredToolsReloadCoordinator.resetForTests();
  jest.clearAllMocks();
  ensureChatForTrustedSendMock.mockResolvedValue(undefined);
  ingestProviderEventMock.mockResolvedValue(true);
  ingestProviderEventWithOutcomeMock.mockImplementation(
    ingestOutcomeFromCommit,
  );
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

function makeOptions(): Parameters<typeof dispatchAppAdvisorChatMessage>[1] {
  const getMainWindow: Parameters<
    typeof dispatchAppAdvisorChatMessage
  >[1]['getMainWindow'] = () => null;
  const getAppAdvisorWindow: Parameters<
    typeof dispatchAppAdvisorChatMessage
  >[1]['getAppAdvisorWindow'] = () => null;
  return {
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
          sourceInputId: order === 'pickup-terminal' ? 'selected' : 'original',
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
        ingestProviderEventWithOutcomeMock.mockRejectedValueOnce(
          new Error('Commit failed'),
        );
      else ingestProviderEventWithOutcomeMock.mockResolvedValueOnce(outcome);
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
    jest.mocked(getOrCreateSession).mockReturnValueOnce({
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
    void onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'attempt',
      startsTurn: true,
      userMessageId: 'selected',
    });
    void onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'selected',
      message: {
        id: 'reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Selected reply' }],
      },
    });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ turnUserMessageId: 'selected' }),
    );
  });

  it('honors a stamped rejected pickup without re-arbitrating the root', async () => {
    const onTurnRevived = jest
      .spyOn(getChatQueueService(), 'onTurnRevived')
      .mockReturnValue(false);
    jest.mocked(getOrCreateSession).mockReturnValueOnce({
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
      void onEvent({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'late-attempt',
        startsTurn: true,
        userMessageId: 'stale',
        turnRootAccepted: false,
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(onTurnRevived).toHaveBeenCalledTimes(1);
      expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turnUserMessageId: 'current' }),
      );
    } finally {
      onTurnRevived.mockRestore();
    }
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

  it('persists accepted agent sender attribution as an agent-authored user message', async () => {
    const agentSent: ChatAgentSentInfo = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'entry-one',
        chatId: 'source-chat',
      },
      chatTitle: 'Source chat',
      projectLabel: 'App Advisor',
    };
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
    const envelope: AppAdvisorUiStateEnvelope = {
      version: 1,
      revision: 1,
      capturedAt: new Date(0).toISOString(),
      digest: 'digest',
      snapshot: {
        activePage: 'overview',
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
    const agentSent: ChatAgentSentInfo = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'entry-one',
        chatId: 'source-chat',
      },
      chatTitle: 'Source chat',
      projectLabel: 'App Advisor',
    };
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
    jest.mocked(getOrCreateSession).mockReturnValueOnce({
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
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
    ingestProviderEventWithOutcomeMock.mockImplementationOnce(async (input) => {
      await ingestProviderEventMock(input);
      return 'activity-only';
    });
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
    ingestProviderEventWithOutcomeMock.mockImplementationOnce(async (input) => {
      await ingestProviderEventMock(input);
      return 'not-applied';
    });
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

    // The user echo is immediately followed by the turn-timer start frame —
    // the browser store's authoritative "agent is working" signal (there is
    // no desktop renderer minting one for App Advisor).
    const timerStartEvent = enqueuePortalEventMock.mock.calls[1]?.[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(timerStartEvent.type).toBe('portal.app_advisor.event');
    expect(timerStartEvent.payload.chatId).toBe('advisor-chat');
    expect(timerStartEvent.payload.message).toMatchObject({
      messageId: 'message-1:turn-timer',
      chatId: 'advisor-chat',
      role: 'system',
      status: 'streaming',
    });
    const timerStartParts = (
      timerStartEvent.payload.message as {
        parts?: Array<{ kind: string; data: { completedAt: number | null } }>;
      }
    ).parts;
    expect(timerStartParts?.[0]?.kind).toBe('turn_timer');
    expect(timerStartParts?.[0]?.data.completedAt).toBeNull();

    await emitCommittedEvent(onEvent, {
      type: 'assistant_delta',
      content: 'Working',
    });
    const streamedEvent = enqueuePortalEventMock.mock.calls[2]?.[0] as {
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

  it('projects trusted agent sender attribution onto the Portal user echo only', async () => {
    portalActive = true;
    const agentSent: ChatAgentSentInfo = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'entry-one',
        chatId: 'source-chat',
      },
      chatTitle: 'Source chat',
      projectLabel: 'App Advisor',
    };
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

    // The synthetic cancel `result` is a terminal runtime event, so the seam
    // first terminalizes the live turn timer — the browser's turn lifecycle
    // ends on this frame instead of spinning forever after the cancel.
    const timerEvent = enqueuePortalEventMock.mock.calls[0]?.[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(timerEvent.type).toBe('portal.app_advisor.event');
    expect(timerEvent.payload.chatId).toBe('advisor-cancel-chat');
    expect(timerEvent.payload.message).toMatchObject({
      messageId: 'message-cancel:turn-timer',
      role: 'system',
      status: 'complete',
    });
    const cancelTimerParts = (
      timerEvent.payload.message as {
        parts?: Array<{ kind: string; data: { completedAt: number | null } }>;
      }
    ).parts;
    expect(cancelTimerParts?.[0]?.kind).toBe('turn_timer');
    expect(typeof cancelTimerParts?.[0]?.data.completedAt).toBe('number');

    // A successful terminal `result` projects to no portal message, so the
    // cancel re-keys 'cancelled' onto the LAST streamed assistant frame —
    // same messageId and text, so the merge cannot clobber streamed content.
    const cancelEvent = enqueuePortalEventMock.mock.calls[1]?.[0] as {
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

  it('terminalizes the live turn timer on the terminal runtime event', async () => {
    portalActive = true;
    const onEvent = await dispatchAndGetEventHandler();
    enqueuePortalEventMock.mockClear();

    await emitCommittedEvent(onEvent, {
      type: 'result',
      is_error: false,
      result: 'done',
    });

    // A successful terminal `result` maps to NO content frame — the only
    // mirrored event is the timer's terminal frame, which is what lets the
    // browser store end the turn (spinner + Stop button) once the desktop
    // goes idle.
    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);
    const timerEvent = enqueuePortalEventMock.mock.calls[0]?.[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(timerEvent.type).toBe('portal.app_advisor.event');
    expect(timerEvent.payload.chatId).toBe('advisor-chat');
    expect(timerEvent.payload.message).toMatchObject({
      messageId: 'message-1:turn-timer',
      role: 'system',
      status: 'complete',
    });
    const terminalTimerParts = (
      timerEvent.payload.message as {
        parts?: Array<{ kind: string; data: { completedAt: number | null } }>;
      }
    ).parts;
    expect(terminalTimerParts?.[0]?.kind).toBe('turn_timer');
    expect(typeof terminalTimerParts?.[0]?.data.completedAt).toBe('number');

    // The timer entry is consumed: a later event cannot re-open or re-emit it.
    enqueuePortalEventMock.mockClear();
    await emitCommittedEvent(onEvent, {
      type: 'result',
      is_error: false,
      result: 'done again',
    });
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'keeps the Portal turn timer streaming across a deferred-tools reload (coordinator finishes during commit: %s)',
    async (finishesDuringCommit) => {
      portalActive = true;
      const onInitialEvent = await dispatchAndGetEventHandler();
      const activeReloadSpy = jest
        .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
        .mockReturnValue(true);
      enqueuePortalEventMock.mockClear();
      if (finishesDuringCommit) {
        // Durability can lag the provider callback: the coordinator may already
        // have started the continuation when the old terminal is projected.
        ingestProviderEventMock.mockImplementationOnce(() => {
          activeReloadSpy.mockReturnValue(false);
          return Promise.resolve(true);
        });
      }

      await emitCommittedEvent(onInitialEvent, {
        type: 'result',
        is_error: false,
        result: 'reload requested',
      });

      // The provider's intermediate terminal event must not make Portal appear
      // idle while the hidden continuation is being prepared.
      expect(enqueuePortalEventMock).not.toHaveBeenCalled();

      await dispatchAppAdvisorChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat',
          userMessageId: 'message-1',
          text: '<system_instruction>Continue after reload.</system_instruction>',
          deferredToolsReloadEnabledResources: [],
          deferredToolsReloadRequestId: 'reload-request-1',
        },
        makeOptions(),
      );

      // The continuation reuses the live timer and emits no duplicate user or
      // timer-start frame.
      expect(enqueuePortalEventMock).not.toHaveBeenCalled();

      const onContinuationEvent =
        jest.mocked(getOrCreateSession).mock.calls[1]?.[1];
      if (!onContinuationEvent) {
        throw new Error('Expected App Advisor continuation event handler');
      }
      activeReloadSpy.mockReturnValue(false);
      await emitCommittedEvent(onContinuationEvent, {
        type: 'result',
        is_error: false,
        result: 'done',
      });

      expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);
      const timerEvent = enqueuePortalEventMock.mock.calls[0]?.[0];
      expect(timerEvent).toMatchObject({
        type: 'portal.app_advisor.event',
        payload: {
          message: {
            messageId: 'message-1:turn-timer',
            role: 'system',
            status: 'complete',
          },
        },
      });
    },
  );

  it('completes the retained Portal timer when a deferred-tools reload fails', async () => {
    portalActive = true;
    const onInitialEvent = await dispatchAndGetEventHandler();
    const scope = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      chatId: 'advisor-chat',
    };
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope,
      toolCallId: 'reload-tool-call',
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    });
    expect(intent.accepted).toBe(true);
    enqueuePortalEventMock.mockClear();

    await emitCommittedEvent(onInitialEvent, {
      type: 'result',
      is_error: false,
      result: 'reload requested',
    });
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();

    deferredToolsReloadCoordinator.cancelActiveReload(
      scope,
      'Deferred reload fixture failed.',
    );

    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);
    const timerEvent = enqueuePortalEventMock.mock.calls[0]?.[0] as {
      payload: { message: Record<string, unknown> };
    };
    expect(timerEvent.payload.message).toMatchObject({
      messageId: 'message-1:turn-timer',
      role: 'system',
      status: 'complete',
    });
    deferredToolsReloadCoordinator.resetForTests();
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
  it.each(['claude', 'codex'] as const)(
    'routes two %s turns and rejects obsolete output',
    async (providerType) => {
      let retained: ((data: unknown) => void) | undefined;
      const shared = {
        sendMessage: sendMessageMock,
        setPlanMode: setPlanModeMock,
        setApprovalMode: setApprovalModeMock,
        setCodexAppServerIdleTimeoutMinutes: setCodexIdleMock,
      };
      jest.mocked(getOrCreateSession).mockImplementation((_opts, onEvent) => {
        retained ??= onEvent;
        return shared;
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
      .mockReturnValueOnce(makeSpeedSession({ setSpeed, setFastMode }));

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
      .mockReturnValueOnce(
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
      .mockReturnValueOnce(makeSpeedSession({ setFastMode }));

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

import { DELEGATION_NOTICE_KIND } from '@canopy/agent-actions';
import type {
  ChatJournalRecord,
  ChatSendMessageRequest,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { ChatSteeringCapabilities } from '@canopy/protocol/portal';
import { installDelegationLifecycle } from '../../agents/delegation/lifecycle';
import type { AgentSession } from '../../agents/types';
import {
  reduceChatState,
  type CanonicalChatState,
} from '../chat-state-reducer';
import {
  ChatInputDeliveryCoordinator,
  type InputPickupObserver,
} from '../chat-input-delivery-coordinator';

jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

type RowState = 'pending' | 'queued' | 'none';
type SubmitSteeringInput = NonNullable<AgentSession['submitSteeringInput']>;

function noticeRequest(): ChatSendMessageRequest {
  return {
    ...target,
    userMessageId: 'notice-1',
    delegationNoticeBatchId: 'notice-1',
    text: 'Delegate finished: implementation complete.',
    watcherFired: { kind: DELEGATION_NOTICE_KIND },
    hiddenContext: {
      kind: 'canopy-watcher-event',
      text: 'A delegate has finished.',
    },
  };
}

function makeTab(
  request: ChatSendMessageRequest,
  rowState: RowState,
): PersistedChatTab {
  const tab: PersistedChatTab = {
    id: target.chatId,
    title: 'Chat',
    messages: [],
    createdAt: new Date(0).toISOString(),
  };
  if (rowState === 'none') return tab;
  return {
    ...tab,
    inputDelivery: {
      version: 1,
      epoch: 0,
      rows: [
        {
          id: request.userMessageId,
          revision: 1,
          createdAt: 1,
          state: rowState,
          text: request.text,
          payload: request,
          settingsKey: 'settings-1',
          origin: 'desktop',
          currentAttemptId: 'attempt-1',
          attempts: [
            {
              id: 'attempt-1',
              generation: 'generation-1',
              provider: 'codex',
              createdAt: 1,
              displayText: request.text,
              submittedText: request.text,
              payloadSnapshot: request,
            },
          ],
        },
      ],
    },
  };
}

function steerableSession(
  submitSteeringInput: SubmitSteeringInput,
  steer = true,
): AgentSession {
  const capabilities: ChatSteeringCapabilities = {
    provider: 'codex',
    generation: 'generation-1',
    steer,
    withdraw: true,
    interrupt: true,
  };
  return {
    sendMessage: (): void => undefined,
    getSteeringCapabilities: (): ChatSteeringCapabilities => capabilities,
    getSteeringWorkingDirectory: (): string => '/worktree',
    getAppliedApprovalMode: () => 'ask',
    submitSteeringInput,
    cancel: (): Promise<void> => Promise.resolve(),
    destroy: (): Promise<void> => Promise.resolve(),
    setPlanMode: (): Promise<void> => Promise.resolve(),
    setApprovalMode: (): Promise<void> => Promise.resolve(),
    setThinkingLevel: (): Promise<void> => Promise.resolve(),
    setModel: (): Promise<void> => Promise.resolve(),
  };
}

function createHarness(
  request: ChatSendMessageRequest,
  rowState: RowState,
  session: AgentSession,
): {
  coordinator: ChatInputDeliveryCoordinator;
  getState: () => CanonicalChatState;
  pickup: jest.MockedFunction<InputPickupObserver>;
} {
  const tab = makeTab(request, rowState);
  let state: CanonicalChatState = {
    tabsFile: {
      version: 1,
      tabs: [tab],
      activeTabId: tab.id,
    },
    archivesFile: { version: 1, archived: [] },
    runtimeByChatId: {
      [tab.id]: { status: 'idle', queuedMessageIds: [] },
    },
  };
  let revision = 0;
  const repository: ConstructorParameters<
    typeof ChatInputDeliveryCoordinator
  >[0] = {
    getRevision: (): Promise<number> => Promise.resolve(revision),
    getState: (): Promise<CanonicalChatState> => Promise.resolve(state),
    transactWith: async (scope, build, options) => {
      const baseRevision = revision;
      const mutations = await build(state, revision, {
        getPortalSendReceipt: () => undefined,
        hasRemovedTab: () => false,
        hasRemovedArchiveEntry: () => false,
        hasRemovedMessage: () => false,
      });
      if (mutations.length > 0) {
        state = reduceChatState(state, mutations);
        revision += 1;
      }
      const record: ChatJournalRecord = {
        v: 1,
        revision,
        mutationId: options.mutationId ?? `mutation-${revision}`,
        occurredAt: new Date(0).toISOString(),
        source: options.source,
        mutations,
        ...(options.commandResult
          ? { commandResult: { ...options.commandResult, revision } }
          : {}),
      };
      return {
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        baseRevision,
        revision,
        record,
        state,
        applied: mutations.length > 0,
      };
    },
  };
  const pickup: jest.MockedFunction<InputPickupObserver> = jest.fn<
    ReturnType<InputPickupObserver>,
    Parameters<InputPickupObserver>
  >(() => Promise.resolve());
  const coordinator = new ChatInputDeliveryCoordinator(
    repository,
    (): Promise<AgentSession | undefined> => Promise.resolve(session),
    (): Promise<void> => Promise.resolve(),
    pickup,
    () => Promise.resolve(undefined),
    () => Promise.resolve({ allowed: true }),
  );
  return { coordinator, getState: () => state, pickup };
}

function acceptedSubmission(): jest.MockedFunction<SubmitSteeringInput> {
  return jest.fn<
    ReturnType<SubmitSteeringInput>,
    Parameters<SubmitSteeringInput>
  >((_text, attemptId) => Promise.resolve({ kind: 'accepted', attemptId }));
}

describe('ChatInputDeliveryCoordinator delegation notice rows', () => {
  it('steers an arriving notice without watcher delivery admission and materializes a watcher row', async () => {
    const isDeliveryActive = jest.fn(() => false);
    const claimDelivery = jest.fn(() => false);
    installDelegationLifecycle({
      shutdown: (): Promise<void> => Promise.resolve(),
      revoke: (): Promise<void> => Promise.resolve(),
      closeScope: (): Promise<void> => Promise.resolve(),
      isDeliveryActive,
      claimDelivery,
      releaseDelivery: (): void => undefined,
      retireDelivery: (): void => undefined,
    });
    const request = noticeRequest();
    const submitSteeringInput = acceptedSubmission();
    const harness = createHarness(
      request,
      'none',
      steerableSession(submitSteeringInput),
    );

    await expect(
      harness.coordinator.steerGenerated(request, () => [], 'desktop', true),
    ).resolves.toEqual({ status: 'handled' });
    expect(submitSteeringInput).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveProperty('watcherDeliveryId');
    expect(request).not.toHaveProperty('managedDelegationDeliveryId');
    expect(request).not.toHaveProperty('internalRow');
    expect(isDeliveryActive).not.toHaveBeenCalled();
    expect(claimDelivery).not.toHaveBeenCalled();

    const row = harness.getState().tabsFile.tabs[0]?.inputDelivery?.rows[0];
    const attempt = row?.attempts.find(
      (candidate) => candidate.id === row.currentAttemptId,
    );
    if (!row?.currentAttemptId || !attempt)
      throw new Error('Missing notice delivery attempt');
    await expect(
      harness.coordinator.observe(target, {
        type: 'canopy_input_delivery',
        provider: attempt.provider,
        generation: attempt.generation,
        attemptId: attempt.id,
        phase: 'picked-up',
      }),
    ).resolves.toBe(true);

    const message = harness
      .getState()
      .tabsFile.tabs[0]?.messages.find((candidate) => candidate.id === row.id);
    expect(message?.userMessageSource).toBe('watcher');
    expect(message?.watcherFired).toEqual({ kind: DELEGATION_NOTICE_KIND });
    expect(message).not.toHaveProperty('hidden');
  });

  it('steers an already queued notice without a watcher delivery id', async () => {
    const request = noticeRequest();
    const submitSteeringInput = acceptedSubmission();
    const harness = createHarness(
      request,
      'queued',
      steerableSession(submitSteeringInput),
    );

    await expect(
      harness.coordinator.steerQueuedGenerated(
        request,
        () => [request.userMessageId],
        'desktop',
        () => true,
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'handled' });

    expect(submitSteeringInput).toHaveBeenCalledTimes(1);
  });

  it('falls back when the active session cannot steer an arriving notice', async () => {
    const request = noticeRequest();
    const submitSteeringInput = acceptedSubmission();
    const harness = createHarness(
      request,
      'none',
      steerableSession(submitSteeringInput, false),
    );

    await expect(
      harness.coordinator.steerGenerated(request, () => [], 'desktop', true),
    ).resolves.toEqual({ status: 'fallback' });
    expect(submitSteeringInput).not.toHaveBeenCalled();
  });
  it('materializes a merged notice-headed steer under the watcher id without its main-only snapshot', async () => {
    const request: ChatSendMessageRequest = {
      ...noticeRequest(),
      userMessageId: 'watcher-delivery-1',
      delegationNoticeBatchId: undefined,
      watcherDeliveryId: 'delivery-1',
      watcherFired: { kind: 'Multiple watchers fired (2)' },
      consolidatedWatcherUserMessageIds: ['notice-1', 'watcher-delivery-1'],
      watcherPartSnapshots: [
        {
          userMessageId: 'notice-1',
          kind: DELEGATION_NOTICE_KIND,
          text: 'Notice',
          delegationNoticeBatchId: 'notice-1',
        },
        {
          userMessageId: 'watcher-delivery-1',
          kind: 'Build',
          text: 'Watcher',
          watcherDeliveryId: 'delivery-1',
        },
      ],
    };
    const h = createHarness(
      request,
      'queued',
      steerableSession(acceptedSubmission()),
    );
    await expect(
      h.coordinator.steerQueuedGenerated(
        request,
        () => ['host-row'],
        'desktop',
        () => true,
        () => undefined,
      ),
    ).resolves.toEqual({ status: 'handled' });
    const row = h.getState().tabsFile.tabs[0]?.inputDelivery?.rows[0];
    const attempt = row?.attempts.find((a) => a.id === row.currentAttemptId);
    if (!attempt) throw new Error('Missing attempt');
    await h.coordinator.observe(target, {
      type: 'canopy_input_delivery',
      provider: attempt.provider,
      generation: attempt.generation,
      attemptId: attempt.id,
      phase: 'picked-up',
    });
    const message = h.getState().tabsFile.tabs[0]?.messages[0];
    expect(message).toMatchObject({
      id: 'watcher-delivery-1',
      watcherFired: request.watcherFired,
    });
    expect(message).not.toHaveProperty('watcherPartSnapshots');
    expect(message).not.toHaveProperty('hiddenContext');
    expect(message).not.toHaveProperty('watcherDeliveryId');
  });
});

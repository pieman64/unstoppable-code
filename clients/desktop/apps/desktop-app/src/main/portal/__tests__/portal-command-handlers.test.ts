jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: jest.fn(() => Promise.resolve(false)),
  peekCopilotRuntimeAvailability: jest.fn(() => false),
}));
jest.mock('../../cursor/runtime-availability', () => ({
  peekCursorRuntimeAvailability: jest.fn(() => true),
}));
jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: jest.fn(),
}));
jest.mock('../../account-proxy/service', () => ({
  getAccountProxyStatus: jest.fn(() => Promise.resolve(null)),
  onAccountProxyInventoryChanged: jest.fn(() => jest.fn()),
}));

const mockFindRepositoryOwnerAdapter = jest.fn();
jest.mock('../adapters/org-projects-adapter', () => ({
  handlePortalOrgProjectsFindRepositoryOwner: mockFindRepositoryOwnerAdapter,
}));
jest.mock('../adapters/chat-state-query', () => ({
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
import { getChatStateCommandPort } from '../../ipc/chat-state';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import type { ChatStateCommandPort } from '@canopy/desktop-shared/types';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';

import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type { ExternalAgentSender } from '@canopy/protocol/portal';
import type * as WorkspaceAdapterModule from '../adapters/workspace-adapter';
import type * as WorktreeAdapterModule from '../adapters/worktree-adapter';
jest.mock('../portal-snapshot-builders', () => ({
  buildPortalSnapshot: jest.fn(),
}));

jest.mock('../../services/worktree-diff-stats-cache', () => ({
  getCachedWorktreeDiffStats: jest.fn(() => undefined),
  requestAllWorktreeDiffStatsRefresh: jest.fn(() => Promise.resolve()),
  requestWorkspaceWorktreeDiffStatsRefresh: jest.fn(() => Promise.resolve()),
  warmWorktreeDiffStats: jest.fn(() => Promise.resolve()),
}));

jest.mock('../adapters/pipelines-adapter', () => ({
  handlePortalPipelineCancel: jest.fn(),
  handlePortalPipelineExecutionGet: jest.fn(),
  handlePortalPipelineGet: jest.fn(),
  handlePortalPipelineList: jest.fn(),
  handlePortalPipelineLogRequest: jest.fn(),
  handlePortalPipelineRun: jest.fn(),
}));

jest.mock('../portal-state-store', () => ({
  persistPortalViewMode: jest.fn(),
}));

jest.mock('../../lib/sidebar-items', () => ({
  setWorkspaceActivitySectionOrder: jest.fn(),
}));

jest.mock('../adapters/workspace-adapter', () => ({
  ...jest.requireActual<typeof WorkspaceAdapterModule>(
    '../adapters/workspace-adapter',
  ),
  handlePortalWorkspaceReorder: jest.fn(),
}));

jest.mock('../adapters/worktree-adapter', () => ({
  ...jest.requireActual<typeof WorktreeAdapterModule>(
    '../adapters/worktree-adapter',
  ),
  handlePortalWorktreeUpdate: jest.fn(),
  handlePortalWorktreeReorder: jest.fn(),
}));

import {
  executePortalStateRequest,
  handlePortalCommand,
  setPortalFeatureAdapterForTest,
} from '../portal-command-handlers';
import type { PortalCommandAdapter } from '../adapters/types';
import { buildPortalSnapshot } from '../portal-snapshot-builders';
import { acquirePortalOverviewSnapshot } from '../portal-overview-build';
import {
  setCanopyPortalEventSink,
  notifyPortalModelCatalogChanged,
} from '../portal-event-bus';
import * as ChatService from '../../services/chat-service';
import { getObservabilityService } from '../../observability';
import * as WorkspacePortalService from '../../services/workspace-portal-service';

import { persistPortalViewMode } from '../portal-state-store';
import { setWorkspaceActivitySectionOrder } from '../../lib/sidebar-items';
import { handlePortalWorkspaceReorder } from '../adapters/workspace-adapter';
import {
  handlePortalWorktreeReorder,
  handlePortalWorktreeUpdate,
} from '../adapters/worktree-adapter';
import {
  requestAllWorktreeDiffStatsRefresh,
  requestWorkspaceWorktreeDiffStatsRefresh,
  warmWorktreeDiffStats,
} from '../../services/worktree-diff-stats-cache';

const mockedBuildPortalSnapshot = jest.mocked(buildPortalSnapshot);
const mockedPersistPortalViewMode = jest.mocked(persistPortalViewMode);
const mockedSetWorkspaceActivitySectionOrder = jest.mocked(
  setWorkspaceActivitySectionOrder,
);
const mockedRequestAllWorktreeDiffStatsRefresh = jest.mocked(
  requestAllWorktreeDiffStatsRefresh,
);
const mockedRequestWorkspaceWorktreeDiffStatsRefresh = jest.mocked(
  requestWorkspaceWorktreeDiffStatsRefresh,
);
const mockedWarmWorktreeDiffStats = jest.mocked(warmWorktreeDiffStats);

function command(
  input: Partial<PortalCommandEnvelope> & {
    type: PortalCommandEnvelope['type'];
  },
): PortalCommandEnvelope {
  return {
    ...input,
    id: input.id ?? 'cmd-1',
    sequence: input.sequence ?? 42,
    type: input.type,
    payload: input.payload ?? {},
    createdAt: '2026-05-06T00:00:00.000Z',
    expiresAt: null,
  };
}

describe('handlePortalCommand command result envelopes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedBuildPortalSnapshot.mockResolvedValue({
      snapshot: {
        scope: 'overview',
        entities: [],
        generatedAt: '2026-05-06T00:00:00.000Z',
      },
      followUpEvents: [],
    });
  });

  it('returns contextual access in the originating refresh completion instead of a replaceable cache read', async () => {
    const payload = {
      modelLibraryContext: {
        accountKey: 'account:user-7',
        owner: { kind: 'personal' },
        access: 'needs_purchase',
        authoritative: true,
        requestId: 'cmd-1',
      },
      availableModels: [
        {
          id: 'advanced',
          label: 'Advanced',
          provider: 'claude',
          available: true,
          libraryEligibility: 'locked',
        },
      ],
    };
    mockedBuildPortalSnapshot.mockResolvedValueOnce({
      snapshot: {
        scope: 'chat',
        entities: [{ entityType: 'chat_summary', localId: 'chat-1', payload }],
        generatedAt: '2026-05-06T00:00:00.000Z',
      },
      followUpEvents: [],
    });
    const events: PortalEventEnvelope[] = [];
    await executePortalStateRequest(
      command({ type: 'portal.state.request' }),
      { enqueueEvent: (event) => events.push(event) },
      { scope: 'chat', target: { chatLocalId: 'chat-1' } },
    );
    expect(
      events.find((event) => event.type === 'portal.command.completed')
        ?.payload,
    ).toMatchObject({ result: { modelLibrary: payload } });
  });

  it('lets an overview request join only a shared build that started after it arrived', async () => {
    let release: () => void = () => undefined;
    mockedBuildPortalSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              snapshot: {
                scope: 'overview',
                entities: [],
                generatedAt: '2026-05-06T00:00:00.000Z',
              },
              followUpEvents: [],
            });
        }),
    );
    const structuralPush = acquirePortalOverviewSnapshot(0);
    const joinedEvents: PortalEventEnvelope[] = [];
    const laterEvents: PortalEventEnvelope[] = [];
    const joined = executePortalStateRequest(
      command({ id: 'joined', type: 'portal.state.request' }),
      { enqueueEvent: (event) => joinedEvents.push(event), receivedAtPerf: 0 },
      { scope: 'overview' },
    );
    const later = executePortalStateRequest(
      command({ id: 'later', type: 'portal.state.request' }),
      {
        enqueueEvent: (event) => laterEvents.push(event),
        receivedAtPerf: Number.MAX_SAFE_INTEGER,
      },
      { scope: 'overview' },
    );
    while (mockedBuildPortalSnapshot.mock.calls.length === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([structuralPush, joined, later]);

    expect(mockedBuildPortalSnapshot).toHaveBeenCalledTimes(2);
    expect(joinedEvents.map((event) => event.type)).toEqual([
      'portal.state.snapshot',
      'portal.command.completed',
    ]);
    expect(laterEvents.map((event) => event.type)).toEqual([
      'portal.state.snapshot',
      'portal.command.completed',
    ]);
  });

  it('does not publish or start warming when a session is reset during its build', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    mockedBuildPortalSnapshot.mockImplementationOnce(async () => {
      await gate;
      return {
        snapshot: {
          scope: 'worktree',
          entities: [],
          generatedAt: new Date().toISOString(),
        },
        followUpEvents: [],
      };
    });
    const enqueueEvent = jest.fn();
    const request = executePortalStateRequest(
      command({ type: 'portal.state.request' }),
      { enqueueEvent, isCurrent: () => current },
      {
        scope: 'worktree',
        target: { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      },
    );
    current = false;
    release();
    await request;
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(mockedWarmWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('repairs a hydrated catalog when discovery finishes during its snapshot build', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const summaries = jest
      .spyOn(ChatService, 'listWorktreeChatSummaries')
      .mockResolvedValue([]);
    jest
      .spyOn(WorkspacePortalService, 'getWorkspacePortalWorktreeRuntimeStatus')
      .mockResolvedValue({ hasUnread: false, isStreaming: false });
    jest
      .spyOn(WorkspacePortalService, 'getWorkspacePortalWorktreeEntity')
      .mockResolvedValue(null);
    const events: PortalEventEnvelope[] = [];
    const enqueueEvent = (event: PortalEventEnvelope): void => {
      events.push(event);
    };
    setCanopyPortalEventSink(enqueueEvent);
    mockedBuildPortalSnapshot.mockImplementationOnce(async () => {
      await gate;
      return {
        snapshot: {
          scope: 'worktree',
          target: { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
          entities: [],
          generatedAt: new Date().toISOString(),
        },
        followUpEvents: [],
      };
    });
    try {
      const pending = executePortalStateRequest(
        command({ type: 'portal.state.request' }),
        { enqueueEvent },
        {
          scope: 'worktree',
          target: { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
        },
      );
      await notifyPortalModelCatalogChanged();
      expect(summaries).not.toHaveBeenCalled();
      release();
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(summaries).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
      });
      expect(
        events.findIndex((event) => event.type === 'portal.state.delta'),
      ).toBeGreaterThan(
        events.findIndex((event) => event.type === 'portal.state.snapshot'),
      );
    } finally {
      release();
      setCanopyPortalEventSink(null);
      jest.restoreAllMocks();
    }
  });

  it('emits canonical command.completed payloads with sequenceNumber and generatedAt', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.auth.validate_code',
        payload: { code: '123456', attemptExternalId: 'attempt-1' },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    const completed = events.find(
      (event) => event.type === 'portal.command.completed',
    );
    expect(completed?.payload).toMatchObject({
      commandId: 'cmd-1',
      sequenceNumber: 42,
      result: { approved: true },
    });
    expect(
      typeof (completed?.payload as { generatedAt?: unknown }).generatedAt,
    ).toBe('string');
  });

  it('emits canonical command.failed payloads with structured errors', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.unknown' as PortalCommandEnvelope['type'],
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      commandId: 'cmd-1',
      payload: {
        commandId: 'cmd-1',
        sequenceNumber: 42,
        error: {
          code: 'unsupported_command',
          message: 'Unsupported portal command: portal.unknown',
        },
        retryable: false,
      },
    });
    expect(
      typeof (events[0].payload as { generatedAt?: unknown }).generatedAt,
    ).toBe('string');
  });

  it('registers visual reads and rejects malformed pages', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalCommand(
      command({ type: 'portal.chat.visual.read', payload: { offset: -1 } }),
      {
        sessionId: 'session-1',
        pairingCode: null,
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });

  it('dispatches supported feature commands to adapters', async () => {
    const events: PortalEventEnvelope[] = [];
    const getWindow = (): null => null;
    const adapter: jest.MockedFunction<PortalCommandAdapter> = jest.fn(
      (command, context) => {
        context.complete(command, { ok: true });
      },
    );
    const restore = setPortalFeatureAdapterForTest('portal.chat.send', adapter);

    try {
      await handlePortalCommand(
        command({
          type: 'portal.chat.send',
          payload: { text: 'hello' },
        }),
        {
          pairingCode: '123456',
          getWindow,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );
    } finally {
      restore();
    }

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ getWindow }),
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      commandId: 'cmd-1',
      payload: {
        commandId: 'cmd-1',
        sequenceNumber: 42,
        result: { ok: true },
      },
    });
  });

  it('validates and attaches trusted envelope origin to adapter context', async () => {
    const sender: ExternalAgentSender = {
      kind: 'external_agent',
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Research client',
      verified: true,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    const events: PortalEventEnvelope[] = [];
    const adapter: jest.MockedFunction<PortalCommandAdapter> = jest.fn(
      (receivedCommand, context) => {
        context.complete(receivedCommand, { ok: true });
      },
    );
    const restore = setPortalFeatureAdapterForTest(
      'portal.chat.create_tab',
      adapter,
    );
    try {
      await handlePortalCommand(
        command({
          type: 'portal.chat.create_tab',
          payload: { projectId: 'workspace', worktreeId: 'worktree' },
          origin: sender,
        }),
        {
          pairingCode: '123456',
          getWindow: () => null,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );
    } finally {
      restore();
    }

    expect(adapter).toHaveBeenCalledTimes(1);
    const adapterContext = adapter.mock.calls[0]?.[1];
    expect(
      adapterContext ? Reflect.get(adapterContext, 'origin') : undefined,
    ).toEqual(sender);
    expect(events[0]).toMatchObject({ type: 'portal.command.completed' });
  });

  it.each([null, { kind: 'external_agent' }])(
    'fails malformed present origins before handling the command: %j',
    async (origin) => {
      const events: PortalEventEnvelope[] = [];
      const stop = jest.fn();
      const invalidCommand = command({ type: 'portal.session.end' });
      Reflect.set(invalidCommand, 'origin', origin);

      await handlePortalCommand(invalidCommand, {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop,
      });

      expect(stop).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'portal.command.failed',
        payload: { error: { code: 'invalid_payload' }, retryable: false },
      });
    },
  );

  it.each([
    ['portal.pipeline.run', { pipelineId: 'p-1', inputs: { sender: 'a' } }],
    ['portal.pipeline.run', { pipelineId: 'p-1', inputs: { Origin: 'a' } }],
    ['portal.pipeline.run', { pipelineId: 'p-1', inputs: { origin: 'a' } }],
    [
      'portal.workspace.scripts.save',
      { commands: { agentSent: 'npm test', senderInfo: 'npm run lint' } },
    ],
  ] as const)(
    'routes %s whose user-chosen keys look like sender fields: %j',
    async (type, payload) => {
      const events: PortalEventEnvelope[] = [];
      const adapter: jest.MockedFunction<PortalCommandAdapter> = jest.fn(
        (receivedCommand, context) => context.complete(receivedCommand),
      );
      const restore = setPortalFeatureAdapterForTest(type, adapter);
      try {
        await handlePortalCommand(command({ type, payload }), {
          pairingCode: '123456',
          getWindow: () => null,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        });
      } finally {
        restore();
      }

      expect(adapter).toHaveBeenCalledTimes(1);
      expect(events[0]).toMatchObject({ type: 'portal.command.completed' });
    },
  );

  it('allows unrelated user and connection identity fields in command payloads', async () => {
    const events: PortalEventEnvelope[] = [];
    const adapter: jest.MockedFunction<PortalCommandAdapter> = jest.fn(
      (receivedCommand, context) => context.complete(receivedCommand),
    );
    const restore = setPortalFeatureAdapterForTest('portal.chat.send', adapter);
    try {
      await handlePortalCommand(
        command({
          type: 'portal.chat.send',
          payload: {
            metadata: {
              userId: 'ordinary-user',
              connectionId: 'provider-connection',
              verified: true,
              clientName: 'Unrelated integration',
            },
          },
        }),
        {
          pairingCode: '123456',
          getWindow: () => null,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );
    } finally {
      restore();
    }

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ type: 'portal.command.completed' });
  });

  it('routes exact-turn cancellation through the worktree service and preserves its outcome', async () => {
    const events: PortalEventEnvelope[] = [];
    const cancelWorktreeChatTurn = jest
      .spyOn(ChatService, 'cancelWorktreeChatTurn')
      .mockResolvedValue({ ok: true, outcome: 'turn_not_active' });
    try {
      await handlePortalCommand(
        command({
          type: 'portal.chat.cancel_turn',
          payload: {
            projectId: '11111111-1111-4111-8111-111111111111',
            worktreeId: '22222222-2222-4222-8222-222222222222',
            chatId: '33333333-3333-4333-8333-333333333333',
            turnId: '44444444-4444-4444-8444-444444444444',
          },
        }),
        {
          pairingCode: '123456',
          getWindow: () => null,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );
      expect(cancelWorktreeChatTurn).toHaveBeenCalledWith({
        projectId: '11111111-1111-4111-8111-111111111111',
        worktreeId: '22222222-2222-4222-8222-222222222222',
        chatId: '33333333-3333-4333-8333-333333333333',
        turnId: '44444444-4444-4444-8444-444444444444',
      });
    } finally {
      cancelWorktreeChatTurn.mockRestore();
    }

    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: {
        result: { ok: true, outcome: 'turn_not_active' },
      },
    });
  });

  it('rejects standalone targets for exact-turn cancellation without calling the service', async () => {
    const events: PortalEventEnvelope[] = [];
    const cancelWorktreeChatTurn = jest.spyOn(
      ChatService,
      'cancelWorktreeChatTurn',
    );
    try {
      await handlePortalCommand(
        command({
          type: 'portal.chat.cancel_turn',
          target: { standaloneChatLocalId: 'standalone-chat' },
          payload: {
            projectId: '11111111-1111-4111-8111-111111111111',
            worktreeId: '22222222-2222-4222-8222-222222222222',
            chatId: '33333333-3333-4333-8333-333333333333',
            turnId: '44444444-4444-4444-8444-444444444444',
          },
        }),
        {
          pairingCode: '123456',
          getWindow: () => null,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );
      expect(cancelWorktreeChatTurn).not.toHaveBeenCalled();
    } finally {
      cancelWorktreeChatTurn.mockRestore();
    }

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });

  it('rejects Cowork standalone scope for exact-turn cancellation', async () => {
    const events: PortalEventEnvelope[] = [];
    const cancelWorktreeChatTurn = jest.spyOn(
      ChatService,
      'cancelWorktreeChatTurn',
    );
    try {
      await handlePortalCommand(
        command({
          type: 'portal.chat.cancel_turn',
          payload: {
            projectId: STANDALONE_CHAT_PROJECT_ID,
            worktreeId: '22222222-2222-4222-8222-222222222222',
            chatId: '33333333-3333-4333-8333-333333333333',
            turnId: '44444444-4444-4444-8444-444444444444',
          },
        }),
        {
          pairingCode: '123456',
          getWindow: () => null,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );
      expect(cancelWorktreeChatTurn).not.toHaveBeenCalled();
    } finally {
      cancelWorktreeChatTurn.mockRestore();
    }

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });

  it.each([
    'portal.editor.list_invocables',
    'portal.editor.resolve_invocable',
    'portal.standalone_chat.set_plugin_selections',
  ] as const)(
    'routes %s to its registered adapter (CAN-3923)',
    async (type) => {
      const events: PortalEventEnvelope[] = [];

      await handlePortalCommand(command({ type, payload: {} }), {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      });

      // A registered adapter validates the payload; an unregistered command
      // fails as unsupported before any adapter runs.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'portal.command.failed',
        payload: { error: { code: 'invalid_payload' }, retryable: false },
      });
    },
  );

  it('dispatches workspace and repository owner commands through their registered adapters', async () => {
    const context = {
      pairingCode: '123456',
      getWindow: (): null => null,
      enqueueEvent: jest.fn(),
      markAuthenticated: jest.fn(),
      stop: jest.fn(),
    };
    const cases = [
      {
        envelope: command({
          type: 'portal.org_projects.find_repository_owner',
          payload: { remoteUrl: 'https://github.com/acme/catalog.git' },
        }),
        adapter: mockFindRepositoryOwnerAdapter,
      },
      {
        envelope: command({
          type: 'portal.workspace.reorder',
          payload: { activeWorkspaceId: 'w1', overWorkspaceId: 'w2' },
        }),
        adapter: handlePortalWorkspaceReorder,
      },
      {
        envelope: command({
          type: 'portal.worktree.update',
          payload: { workspaceId: 'w1', worktreeId: 't1', hidden: true },
        }),
        adapter: handlePortalWorktreeUpdate,
      },
      {
        envelope: command({
          type: 'portal.worktree.reorder',
          payload: {
            workspaceId: 'w1',
            activeWorktreeId: 't1',
            overWorktreeId: 't2',
          },
        }),
        adapter: handlePortalWorktreeReorder,
      },
    ] as const;

    for (const { envelope, adapter } of cases) {
      await handlePortalCommand(envelope, context);
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(adapter).toHaveBeenCalledWith(
        envelope,
        expect.objectContaining({ getWindow: context.getWindow }),
      );
    }
  });

  it('translates adapter throws into canonical command.failed events', async () => {
    const events: PortalEventEnvelope[] = [];
    const restore = setPortalFeatureAdapterForTest(
      'portal.chat.send',
      jest.fn(() => {
        throw new Error('adapter exploded');
      }),
    );

    try {
      await handlePortalCommand(command({ type: 'portal.chat.send' }), {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      });
    } finally {
      restore();
    }

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          code: 'execution_failed',
          message: 'adapter exploded',
        },
        retryable: false,
      },
    });
  });

  it('keeps unexpected clone reporting failures path-free and unconfirmed', async () => {
    const events: PortalEventEnvelope[] = [];
    const restore = setPortalFeatureAdapterForTest(
      'portal.workspace.create',
      () => {
        throw new Error('ENOENT: /Users/private/portal-state.json');
      },
    );
    try {
      await handlePortalCommand(command({ type: 'portal.workspace.create' }), {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      });
    } finally {
      restore();
    }
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          message:
            'Could not confirm the clone result on the desktop. Check Projects before trying again.',
        },
        retryable: false,
      },
    });
    expect(JSON.stringify(events[0])).not.toContain('/Users/');
  });

  it('persists view mode for portal.session.set_view_mode', async () => {
    mockedPersistPortalViewMode.mockResolvedValue(undefined);
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.session.set_view_mode',
        payload: { viewMode: 'standalone-chats' },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(mockedPersistPortalViewMode).toHaveBeenCalledWith(
      'standalone-chats',
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: {
        commandId: 'cmd-1',
        result: { viewMode: 'standalone-chats' },
      },
    });
  });

  it('rejects portal.session.set_view_mode with an invalid viewMode', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.session.set_view_mode',
        payload: { viewMode: 'pipelines' },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(mockedPersistPortalViewMode).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: { code: 'invalid_payload' },
      },
    });
  });

  it('persists section order for portal.workspace.set_section_order', async () => {
    mockedSetWorkspaceActivitySectionOrder.mockResolvedValue(true);
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.workspace.set_section_order',
        payload: {
          workspaceLocalId: 'workspace-1',
          order: ['summary', 'plans', 'scripts'],
        },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(mockedSetWorkspaceActivitySectionOrder).toHaveBeenCalledWith(
      'workspace-1',
      ['summary', 'plans', 'scripts'],
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: {
        result: {
          workspaceLocalId: 'workspace-1',
          order: ['summary', 'plans', 'scripts'],
        },
      },
    });
  });

  it('fails portal.workspace.set_section_order when the workspace is unknown', async () => {
    mockedSetWorkspaceActivitySectionOrder.mockResolvedValue(false);
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.workspace.set_section_order',
        payload: { workspaceLocalId: 'missing', order: ['summary'] },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: { code: 'not_found' },
      },
    });
  });

  it('rejects portal.workspace.set_section_order with unknown section ids', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.workspace.set_section_order',
        payload: {
          workspaceLocalId: 'workspace-1',
          order: ['summary', 'definitely-not-a-section'],
        },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(mockedSetWorkspaceActivitySectionOrder).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: { code: 'invalid_payload' },
      },
    });
  });

  it('uses the command envelope target when normalizing state requests', async () => {
    const events: PortalEventEnvelope[] = [];
    const recordStateRequestTarget = jest.fn();

    await handlePortalCommand(
      command({
        type: 'portal.state.request',
        target: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'snake',
        },
        payload: { scope: 'worktree' },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        recordStateRequestTarget,
        stop: jest.fn(),
      },
    );

    expect(mockedBuildPortalSnapshot).toHaveBeenCalledWith(
      {
        scope: 'worktree',
        target: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'snake',
        },
      },
      { commandId: 'cmd-1' },
    );
    expect(events.some((event) => event.type === 'portal.state.snapshot')).toBe(
      true,
    );
    expect(recordStateRequestTarget).toHaveBeenCalledWith({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });
  });

  it('preserves negotiated selected-chat hydration when normalizing requests', async () => {
    const target = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    };
    await handlePortalCommand(
      command({
        type: 'portal.state.request',
        target,
        payload: { scope: 'chat', selectedChatOnly: true },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: jest.fn(),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );
    expect(mockedBuildPortalSnapshot).toHaveBeenCalledWith(
      { scope: 'chat', selectedChatOnly: true, target },
      { commandId: 'cmd-1' },
    );
  });

  it('forwards complete Activity inventory and bypasses shallow overview reuse', async () => {
    await handlePortalCommand(
      command({
        type: 'portal.state.request',
        payload: { scope: 'overview', includeChatSummaries: true },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: jest.fn(),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );
    expect(mockedBuildPortalSnapshot).toHaveBeenCalledWith(
      { scope: 'overview', includeChatSummaries: true },
      { commandId: 'cmd-1' },
    );
  });

  it('passes the batched worktree_chat_summaries scope through unchanged', async () => {
    // CAN-1990: an unknown scope is coerced to 'overview', so this pins the
    // validator accepting the batched chat-summaries hydration scope.
    await handlePortalCommand(
      command({
        type: 'portal.state.request',
        payload: { scope: 'worktree_chat_summaries' },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: jest.fn(),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(mockedBuildPortalSnapshot).toHaveBeenCalledWith(
      { scope: 'worktree_chat_summaries' },
      { commandId: 'cmd-1' },
    );
    // The batched scope carries no diff information; it must not trigger the
    // overview-style diff-stat sweep.
    expect(mockedRequestAllWorktreeDiffStatsRefresh).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'worktree',
      payload: {
        scope: 'worktree' as const,
        target: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'worktree-1',
        },
      },
      expected: 'worktree',
    },
    {
      name: 'workspace',
      payload: {
        scope: 'workspace' as const,
        target: { workspaceLocalId: 'workspace-1' },
      },
      expected: 'workspace',
    },
    {
      name: 'unscoped overview',
      payload: { scope: 'overview' as const },
      expected: 'all',
    },
  ])(
    'starts the $name diff-stat refresh only after enqueueing its snapshot',
    async ({ payload, expected }) => {
      const enqueueEvent = jest.fn<void, [PortalEventEnvelope]>();

      await handlePortalCommand(
        command({ type: 'portal.state.request', payload }),
        {
          pairingCode: '123456',
          getWindow: () => null,
          enqueueEvent,
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );

      const snapshotCall = enqueueEvent.mock.calls.findIndex(
        ([event]) => event.type === 'portal.state.snapshot',
      );
      expect(snapshotCall).toBeGreaterThanOrEqual(0);
      const refresh =
        expected === 'worktree'
          ? mockedWarmWorktreeDiffStats
          : expected === 'workspace'
            ? mockedRequestWorkspaceWorktreeDiffStatsRefresh
            : mockedRequestAllWorktreeDiffStatsRefresh;
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.invocationCallOrder[0]).toBeGreaterThan(
        enqueueEvent.mock.invocationCallOrder[snapshotCall],
      );
      expect(mockedWarmWorktreeDiffStats).toHaveBeenCalledTimes(
        expected === 'worktree' ? 1 : 0,
      );
      expect(
        mockedRequestWorkspaceWorktreeDiffStatsRefresh,
      ).toHaveBeenCalledTimes(expected === 'workspace' ? 1 : 0);
      expect(mockedRequestAllWorktreeDiffStatsRefresh).toHaveBeenCalledTimes(
        expected === 'all' ? 1 : 0,
      );
    },
  );

  it.each([
    {
      name: 'overview',
      payload: { scope: 'overview' as const },
      refresh: mockedRequestAllWorktreeDiffStatsRefresh,
      expectedArgs: [] as string[],
    },
    {
      name: 'workspace',
      payload: {
        scope: 'workspace' as const,
        target: { workspaceLocalId: 'workspace-1' },
      },
      refresh: mockedRequestWorkspaceWorktreeDiffStatsRefresh,
      expectedArgs: ['workspace-1'],
    },
  ])(
    'routes repeated $name state requests through the coalescing refresh entry point',
    async ({ payload, refresh, expectedArgs }) => {
      const context = {
        pairingCode: '123456',
        getWindow: (): null => null,
        enqueueEvent: jest.fn(),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      };

      await handlePortalCommand(
        command({ id: 'cmd-1', type: 'portal.state.request', payload }),
        context,
      );
      await handlePortalCommand(
        command({ id: 'cmd-2', type: 'portal.state.request', payload }),
        context,
      );

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenNthCalledWith(1, ...expectedArgs);
      expect(refresh).toHaveBeenNthCalledWith(2, ...expectedArgs);
    },
  );

  it('does not run a fleet refresh for a targeted overview request', async () => {
    await handlePortalCommand(
      command({
        type: 'portal.state.request',
        payload: {
          scope: 'overview',
          target: { workspaceLocalId: 'workspace-1' },
        },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: jest.fn(),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(mockedRequestAllWorktreeDiffStatsRefresh).not.toHaveBeenCalled();
    expect(
      mockedRequestWorkspaceWorktreeDiffStatsRefresh,
    ).not.toHaveBeenCalled();
    expect(mockedWarmWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('returns a sanitized terminal failure when state preparation fails', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedBuildPortalSnapshot.mockRejectedValue(
      new Error('Unable to read /Users/example/private/worktree'),
    );

    await handlePortalCommand(
      command({
        type: 'portal.state.request',
        payload: { scope: 'worktree' },
      }),
      {
        pairingCode: '123456',
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      commandId: 'cmd-1',
      payload: {
        error: {
          code: 'execution_failed',
          message:
            'Unable to prepare the requested state. Reconnect and try again.',
        },
        retryable: false,
      },
    });
    expect(JSON.stringify(events)).not.toContain('/Users/example/private');
  });
});

describe('mobile read acknowledgements (CAN-2809)', () => {
  afterEach(() => jest.mocked(getChatStateCommandPort).mockReset());

  it.each([
    ['reply-1', 'applied', true],
    ['old-reply', 'applied', false],
    ['reply-1', 'conflict', true],
    [null, 'applied', true],
    ['reply-1', 'applied', true, true],
    ['reply-1', 'applied', true, true, true],
    ['old-reply', 'applied', false, true],
  ])(
    'checks the displayed message %s and commit outcome %s',
    async (
      lastMessageId,
      outcome,
      shouldCommit,
      unloaded = false,
      hiddenTail = false,
    ) => {
      const commit = jest.fn().mockResolvedValue({ outcome, revision: 8 });
      const messages =
        lastMessageId === null
          ? []
          : [
              {
                id: 'reply-1',
                role: 'assistant',
                blocks: [{ type: 'text', text: 'Done' }],
                timestamp: 1000,
              },
            ];
      const getTranscriptPage = jest.fn().mockResolvedValue({
        messages,
        totalMessages: messages.length,
        transcriptRevision: 3,
      });
      const chatStatePort: ChatStateCommandPort = {
        getTranscriptPage,
        readToolOutput: jest.fn(),
        getState: jest.fn().mockResolvedValue({
          revision: 7,
          tabsFile: {
            tabs: [
              {
                id: 'chat-1',
                unread: true,
                messages: unloaded ? [] : messages,
                ...(unloaded ? { transcriptLoaded: false } : {}),
              },
            ],
          },
          runtimeByChatId: {},
        }),
        command: commit,
        subscribe: jest.fn(() => jest.fn()),
      };
      if (hiddenTail) {
        getTranscriptPage.mockResolvedValueOnce({
          messages: Array.from({ length: 500 }, (_, index) => ({
            id: `empty-assistant-${index}`,
            role: 'assistant',
            blocks: [],
            timestamp: 1001 + index,
          })),
          before: 1,
          totalMessages: 501,
          transcriptRevision: 3,
        });
      }
      jest.mocked(getChatStateCommandPort).mockReturnValue(chatStatePort);
      createDesktopRuntime({ chatServices: { getPort: () => chatStatePort } });
      const events: PortalEventEnvelope[] = [];
      await handlePortalCommand(
        command({
          type: 'portal.chat.mark_read' as PortalCommandEnvelope['type'],
          payload: {
            scope: 'worktree',
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            lastMessageId,
          },
        }),
        {
          sessionId: 'portal-session-1',
          pairingCode: null,
          getWindow: () => null,
          enqueueEvent: (event) => events.push(event),
          markAuthenticated: jest.fn(),
          stop: jest.fn(),
        },
      );
      if (shouldCommit) {
        expect(commit).toHaveBeenCalledWith(
          expect.objectContaining({
            commandId: 'cmd-1',
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            expectedRevision: 7,
            origin: 'portal',
            command: { type: 'chat.mark_read', chatId: 'chat-1' },
          }),
        );
      } else {
        expect(commit).not.toHaveBeenCalled();
      }
      if (unloaded) {
        expect(getTranscriptPage).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
          }),
        );
      }
      if (hiddenTail) {
        expect(getTranscriptPage).toHaveBeenLastCalledWith(
          expect.objectContaining({ before: 1, transcriptRevision: 3 }),
        );
      }
      expect(events[events.length - 1]?.type).toBe(
        outcome === 'conflict' && shouldCommit
          ? 'portal.command.failed'
          : 'portal.command.completed',
      );
    },
  );
});

it.each([
  {
    payload: {
      scope: 'worktree',
      projectId: '../escape',
      worktreeId: 'wt',
      chatId: 'chat',
      lastMessageId: 'reply',
    },
  },
  { payload: { scope: 'unknown', chatId: 'chat', lastMessageId: 'reply' } },
  {
    payload: {
      scope: 'worktree',
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
    },
  },
])(
  'rejects invalid read acknowledgements before accessing chat state: %j',
  async ({ payload }) => {
    const getState = jest.fn();
    const chatStatePort: ChatStateCommandPort = {
      getState,
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: jest.fn(),
      subscribe: jest.fn(() => jest.fn()),
    };
    jest.mocked(getChatStateCommandPort).mockReturnValue(chatStatePort);
    const events: PortalEventEnvelope[] = [];
    await handlePortalCommand(
      command({
        type: 'portal.chat.mark_read' as PortalCommandEnvelope['type'],
        payload,
      }),
      {
        pairingCode: null,
        getWindow: () => null,
        enqueueEvent: (event) => events.push(event),
        markAuthenticated: jest.fn(),
        stop: jest.fn(),
      },
    );
    expect(getState).not.toHaveBeenCalled();
    expect(events[events.length - 1]?.payload).toMatchObject({
      error: { code: 'invalid_payload' },
    });
    jest.mocked(getChatStateCommandPort).mockReset();
  },
);

describe('provider usage refresh (CAN-3635)', () => {
  let refreshSpy: jest.SpiedFunction<
    ReturnType<typeof getObservabilityService>['refreshProviderUsage']
  >;

  function handlerContext(events: PortalEventEnvelope[]): {
    pairingCode: string;
    getWindow: () => null;
    enqueueEvent: (event: PortalEventEnvelope) => void;
    markAuthenticated: jest.Mock;
    stop: jest.Mock;
  } {
    return {
      pairingCode: '123456',
      getWindow: () => null,
      enqueueEvent: (event) => events.push(event),
      markAuthenticated: jest.fn(),
      stop: jest.fn(),
    };
  }

  beforeEach(() => {
    refreshSpy = jest.spyOn(getObservabilityService(), 'refreshProviderUsage');
  });

  afterEach(() => {
    refreshSpy.mockRestore();
  });

  it.each(['codex', 'copilot', 'opencode'])(
    'acknowledges a %s refresh before the provider read finishes',
    async (provider) => {
      let finishRefresh: () => void = () => undefined;
      refreshSpy.mockReturnValue(
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
      );
      const events: PortalEventEnvelope[] = [];

      await handlePortalCommand(
        command({
          type: 'portal.provider_usage.refresh',
          payload: { provider },
        }),
        handlerContext(events),
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledWith(provider, { joinInFlight: true });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'portal.command.completed',
        commandId: 'cmd-1',
        payload: {
          commandId: 'cmd-1',
          sequenceNumber: 42,
          result: { provider, accepted: true },
        },
      });
      finishRefresh();
    },
  );

  it.each([
    ['a missing provider', {}],
    ['Cursor', { provider: 'cursor' }],
    ['an unknown provider', { provider: 'gemini' }],
    ['a non-string provider', { provider: 1 }],
    ['a non-object payload', 'codex'],
  ])('rejects %s without refreshing usage', async (_label, payload) => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({ type: 'portal.provider_usage.refresh', payload }),
      handlerContext(events),
    );

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' }, retryable: false },
    });
  });

  it('contains a failed background refresh after acknowledging the command', async () => {
    refreshSpy.mockRejectedValue(new Error('provider unavailable'));
    const events: PortalEventEnvelope[] = [];

    await handlePortalCommand(
      command({
        type: 'portal.provider_usage.refresh',
        payload: { provider: 'claude' },
      }),
      handlerContext(events),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(refreshSpy).toHaveBeenCalledWith('claude', { joinInFlight: true });
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });
});

import type { readWorkspaceConfigDetailed } from '../../lib/workspace-persistence';
import * as chatTurnStop from '../../lib/chat-turn-stop';
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import { beginChatAutoRouting } from '../../lib/chat-turn-stop';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PersistedChatTab,
  WorkspaceContextBroadcast,
  WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import {
  FOREIGN_ACTIVITY_BUSY_ERROR,
  FOREIGN_ACTIVITY_INACTIVE_ERROR,
  ForeignActivityCarryoverService,
} from '../foreign-activity-carryover-service';
import {
  foreignActivitySourceSnapshot,
  resetForeignActivitySources,
  publishForeignScriptActivity,
  publishForeignChatActivity,
  publishForeignPipelineQueueActivity,
} from '../foreign-activity-sources';

jest.mock('../../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: { cancelActiveReload: jest.fn() },
}));
const mockCancelRetry = jest.fn();
const mockSubscribeRetry = jest.fn();
const mockCancelTurn = jest.fn((): Promise<void> => Promise.resolve());
const mockTerminal = jest.fn();
const mockQueueCancel = jest.fn(
  (): Promise<string> => Promise.resolve('applied'),
);
let mockRuntimeByChatId: Record<string, ChatRuntimeState> = {};
const mockIngest = jest.fn((): Promise<boolean> => Promise.resolve(true));
jest.mock('../../lib/transient-error-retry-service', () => ({
  subscribeTransientRetryActivity: (...args: unknown[]): (() => void) => {
    mockSubscribeRetry(...args);
    return (): void => undefined;
  },
  cancelTransientRetryForChat: (...args: unknown[]): unknown =>
    mockCancelRetry(...args),
}));
jest.mock('../../lib/chat-turn-cancel', () => ({
  cancelChatTurn: (): Promise<void> => mockCancelTurn(),
}));
jest.mock('../chat-queue-service', () => ({
  getChatQueueService: (): object => ({
    onTurnTerminal: mockTerminal,
    cancel: mockQueueCancel,
  }),
}));
let mockTabs: PersistedChatTab[] = [];
let mockActiveSessions: object[] = [];
jest.mock('../../agents/session-manager', () => ({
  getAllActiveSessionInfos: (): object[] => mockActiveSessions,
}));
const mockGetActiveHandle = jest.fn();
const mockListQueuedPipelines = jest.fn();
const mockCancelQueuedPipeline = jest.fn();
jest.mock('../../lib/hook-pipeline', () => ({
  listQueuedHookPipelines: (): unknown => mockListQueuedPipelines(),
  cancelQueuedHookPipeline: (queueId: string): unknown =>
    mockCancelQueuedPipeline(queueId),
}));
jest.mock('../../pipelines/pipeline-execution-registry', () => ({
  getActivePipelineExecutionHandles: (): object[] => [],
  getActiveExecutionHandle: (id: string): unknown => mockGetActiveHandle(id),
}));
let mockTrackedScripts: object[] = [];
let mockTrackedListener: (() => void) | undefined;
const mockStopTrackedScript = jest.fn();
jest.mock('../../lib/script-runner', () => ({
  listTrackedShellScripts: (): object[] => mockTrackedScripts,
  subscribeTrackedScriptsChanged: (listener: () => void): (() => void) => {
    mockTrackedListener = listener;
    return (): void => {
      mockTrackedListener = undefined;
    };
  },
  stopTrackedShellScriptRun: (...args: unknown[]): unknown =>
    mockStopTrackedScript(...args),
}));
jest.mock('../chat-state-service', () => ({
  getChatStateService: (): object => ({
    ingestProviderEvent: mockIngest,
    getState: (): Promise<object> =>
      Promise.resolve({
        tabsFile: { tabs: mockTabs },
        runtimeByChatId: mockRuntimeByChatId,
      }),
  }),
}));

const mockReadAccount = jest.fn<Promise<object>, [{ cache: boolean }]>();
let mockDataDir = '';
let mockState: WorkspaceContextState;
let mockAccountListener:
  | ((entry: { account: { id: string } }) => void)
  | undefined;
let mockContextListener:
  | ((state: WorkspaceContextBroadcast) => void)
  | undefined;
const authoritativeOrg = {
  config: {
    version: 1 as const,
    repos: [],
    owner: {
      type: 'organization' as const,
      organizationId: 'org-a',
      projectId: 'project-a',
      instanceId: 'instance-a',
      bindingGeneration: 0,
    },
  },
  authority: 'ok' as const,
  ownerMalformed: false,
};
const mockReadConfig = jest.fn<
  ReturnType<typeof readWorkspaceConfigDetailed>,
  [string?]
>(() => Promise.resolve(authoritativeOrg));
let mockEnabled = true;
let mockFlagListener: (() => void) | undefined;
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockEnabled,
    onSnapshotChanged: (listener: () => void): (() => void) => {
      mockFlagListener = listener;
      return (): void => {
        mockFlagListener = undefined;
      };
    },
  }),
}));
jest.mock('../../lib/paths', () => ({ getDataDir: (): string => mockDataDir }));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (options: {
    cache: boolean;
  }): Promise<object> => mockReadAccount(options),
  subscribeCanopyCloudAccountChanges: (
    listener: typeof mockAccountListener,
  ): (() => void) => {
    mockAccountListener = listener;
    return (): void => {
      mockAccountListener = undefined;
    };
  },
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): object => ({
    getState: (): WorkspaceContextState => mockState,
    subscribe: (listener: typeof mockContextListener): (() => void) => {
      mockContextListener = listener;
      return (): void => {
        mockContextListener = undefined;
      };
    },
  }),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfig: async (): Promise<object> =>
    (await mockReadConfig()).config,
  readWorkspaceConfigDetailed: (
    workspaceId: string,
  ): ReturnType<typeof mockReadConfig> => mockReadConfig(workspaceId),
}));
const mockReadIndex = jest.fn<Promise<{ name: string } | null>, []>();
jest.mock('../../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (): ReturnType<typeof mockReadIndex> =>
    mockReadIndex(),
}));

function publish(
  id: string,
  status = 'running',
  workspaceId = 'workspace',
): void {
  publishForeignScriptActivity({
    workspaceLocalId: workspaceId,
    worktreeLocalId: 'worktree',
    localId: id,
    scriptId: 'script',
    scriptKey: 'script',
    scriptName: 'script',
    name: 'Script',
    target: 'project',
    status,
  });
}
function broadcast(reason: WorkspaceContextBroadcast['reason']): void {
  mockContextListener?.({ ...mockState, reason });
}

describe('foreign activity carryover service', (): void => {
  let service: ForeignActivityCarryoverService;
  beforeEach(async (): Promise<void> => {
    mockReadAccount.mockReset();
    mockReadAccount.mockResolvedValue({
      status: 'ok',
      entry: { account: { id: 'account-a' } },
    });
    mockReadIndex.mockReset();
    mockReadIndex.mockResolvedValue({ name: 'Workspace' });
    mockEnabled = true;
    mockTabs = [];
    mockActiveSessions = [];
    mockTrackedScripts = [];
    mockRuntimeByChatId = {};
    mockSubscribeRetry.mockReset();
    jest.clearAllMocks();
    mockReadConfig.mockReset();
    mockDataDir = await mkdtemp(join(tmpdir(), 'foreign-activity-'));
    mockState = {
      context: { kind: 'personal' },
      revision: 1,
      organizations: [{ id: 'org-a', name: 'Org A', role: 'MEMBER' }],
    };
    mockReadConfig.mockReset();
    mockReadConfig.mockResolvedValue(authoritativeOrg);
    service = new ForeignActivityCarryoverService();
    await service.initialize();
    // Clear cross-test registry state through the real account transition.
    mockAccountListener?.({ account: { id: 'test-account' } });
    await service.whenIdle();
  });
  afterEach(async (): Promise<void> => {
    await service.whenIdle();
    service.dispose();
    await rm(mockDataDir, { recursive: true, force: true });
  });

  it('stops an automatic setup script observed through the tracked lifecycle', async (): Promise<void> => {
    const run = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      scriptKey: 'setup',
      logRef: { runId: 'automatic-setup' },
    };
    mockTrackedScripts = [run];
    mockTrackedListener?.();
    await service.whenIdle();
    const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
    expect(target?.operationId).toBe('automatic-setup');
    if (target === undefined) throw new Error('Missing script target');
    await service.stop({ epoch: service.get().epoch, target });
    expect(mockStopTrackedScript).toHaveBeenCalledWith(run);
  });

  it('rejects Stop when the projected script has already exited', async (): Promise<void> => {
    publish('exited-script');
    await service.whenIdle();
    const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
    if (target === undefined) throw new Error('Missing script target');
    await expect(
      service.stop({ epoch: service.get().epoch, target }),
    ).rejects.toThrow(FOREIGN_ACTIVITY_INACTIVE_ERROR);
    expect(mockStopTrackedScript).not.toHaveBeenCalled();
  });

  async function restartWithoutAccount(): Promise<void> {
    service.dispose();
    resetForeignActivitySources();
    mockReadAccount.mockReset();
    mockReadAccount.mockResolvedValue({ status: 'unavailable' });
    service = new ForeignActivityCarryoverService();
    await service.initialize();
  }

  it.each(['disabled', 'signed-out', 'unavailable'] as const)(
    'purges the startup ledger only for definitive disabled or signed-out state: %s',
    async (startup): Promise<void> => {
      publish('persisted-run');
      await service.whenIdle();
      const filePath = join(mockDataDir, 'foreign-activity-ledger.json');
      const saved = await readFile(filePath, 'utf8');
      expect(saved).toContain('persisted-run');
      service.dispose();
      resetForeignActivitySources();
      mockEnabled = startup !== 'disabled';
      mockReadAccount.mockResolvedValue(
        startup === 'signed-out'
          ? { status: 'ok', entry: null }
          : { status: 'unavailable' },
      );
      service = new ForeignActivityCarryoverService();
      await service.initialize();
      await service.whenIdle();

      if (startup === 'unavailable') {
        expect(await readFile(filePath, 'utf8')).toBe(saved);
      } else {
        await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    },
  );

  it('retries an inconclusive startup account read once', async (): Promise<void> => {
    service.dispose();
    resetForeignActivitySources();
    mockReadAccount.mockClear();
    mockReadAccount.mockResolvedValueOnce({ status: 'unavailable' });
    service = new ForeignActivityCarryoverService();
    await service.initialize();
    publish('recovered-at-start');
    await service.whenIdle();
    expect(service.get().groups[0]?.workspaces[0]?.running).toBe(1);
    expect(mockReadAccount).toHaveBeenCalledTimes(2);
    expect(mockReadAccount).toHaveBeenLastCalledWith({ cache: false });
  });

  it('drains a queued terminal event and persists it before shutdown resolves', async (): Promise<void> => {
    publish('finishing-run');
    await service.whenIdle();
    const listener = jest.fn();
    service.subscribe(listener);
    let release = (): void => undefined;
    mockReadConfig.mockReturnValueOnce(
      new Promise((resolve): void => {
        release = (): void => resolve(authoritativeOrg);
      }),
    );
    publish('finishing-run', 'success');
    const shutdown = service.shutdown();
    release();
    await shutdown;

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        groups: [
          expect.objectContaining({
            workspaces: [
              expect.objectContaining({ running: 0, interrupted: false }),
            ],
          }),
        ],
      }),
    );
    expect(
      await readFile(join(mockDataDir, 'foreign-activity-ledger.json'), 'utf8'),
    ).toContain('FOREIGN_COMPLETED_LINGER');
  });

  it.each(['source', 'context', 'account', 'flag'] as const)(
    'ignores %s intake while draining and after shutdown',
    async (intake): Promise<void> => {
      publish('finishing-run');
      await service.whenIdle();
      let release = (): void => undefined;
      mockReadConfig.mockReturnValueOnce(
        new Promise((resolve): void => {
          release = (): void => resolve(authoritativeOrg);
        }),
      );
      const contextListener = mockContextListener;
      const accountListener = mockAccountListener;
      const flagListener = mockFlagListener;
      const deliver = (): void => {
        if (intake === 'source') publish('late-run');
        if (intake === 'context') {
          contextListener?.({
            ...mockState,
            context: { kind: 'organization', organizationId: 'org-a' },
            reason: 'switch',
          });
        }
        if (intake === 'account')
          accountListener?.({ account: { id: 'late-account' } });
        if (intake === 'flag') {
          mockEnabled = false;
          flagListener?.();
          mockEnabled = true;
        }
      };
      publish('finishing-run', 'success');
      const shutdown = service.shutdown();
      deliver();
      release();
      await shutdown;
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        running: 0,
        interrupted: false,
        latestTarget: { operationId: 'finishing-run' },
      });
      const listener = jest.fn();
      service.subscribe(listener);
      const before = service.get();
      const filePath = join(mockDataDir, 'foreign-activity-ledger.json');
      const saved = await readFile(filePath, 'utf8');
      deliver();
      await service.whenIdle();
      expect(listener).not.toHaveBeenCalled();
      expect(service.get()).toEqual(before);
      expect(await readFile(filePath, 'utf8')).toBe(saved);
    },
  );

  it('disposes only once for repeated shutdown calls', async (): Promise<void> => {
    const dispose = jest.spyOn(service, 'dispose');
    try {
      await Promise.all([service.shutdown(), service.shutdown()]);
      await service.shutdown();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      dispose.mockRestore();
    }
  });

  it.each(['organizations', 'switch', 'departed', 'flag'] as const)(
    'adopts a recovered startup account on %s without a store write',
    async (reason): Promise<void> => {
      await restartWithoutAccount();
      const oldEpoch = service.get().epoch;
      mockReadAccount.mockResolvedValue({
        status: 'ok',
        entry: { account: { id: 'recovered-account' } },
      });
      if (reason === 'flag') {
        mockEnabled = false;
        mockFlagListener?.();
        await service.whenIdle();
        mockEnabled = true;
        mockFlagListener?.();
      } else broadcast(reason);
      await service.whenIdle();
      publish('recovered-run');
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]?.running).toBe(1);
      expect(service.get().epoch).not.toBe(oldEpoch);
      expect(mockReadAccount).toHaveBeenLastCalledWith({ cache: false });
      expect(
        await readFile(
          join(mockDataDir, 'foreign-activity-ledger.json'),
          'utf8',
        ),
      ).toContain('recovered-account');
    },
  );

  it.each([1, 2])(
    'restores the retained same-account ledger after recovery and hydrates transcript revision %s',
    async (revision): Promise<void> => {
      await restartWithTranscript(revision, true, true);
      const filePath = join(mockDataDir, 'foreign-activity-ledger.json');
      const saved = await readFile(filePath, 'utf8');
      expect(saved).toContain('saved-epoch');
      expect(service.get().groups).toEqual([]);
      mockReadAccount.mockResolvedValue({
        status: 'ok',
        entry: { account: { id: 'account-a' } },
      });
      broadcast('organizations');
      await service.whenIdle();

      expect(service.get().epoch).toBe('saved-epoch');
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        running: 0,
        unread: revision === 2 ? 1 : 0,
        interrupted: revision === 1,
        latestTarget: { operationId: 'turn' },
      });
      expect(await readFile(filePath, 'utf8')).toContain('saved-epoch');
    },
  );

  it('recovers a snapshot-only chat started while account reads were unavailable', async (): Promise<void> => {
    await restartWithTranscript(1, true, true);
    mockRuntimeByChatId = {
      chat: {
        status: 'streaming',
        activeTurn: { userMessageId: 'new-turn', startedAt: 1 },
        queuedMessageIds: [],
      },
    };
    publishChatSnapshot();
    await service.whenIdle();
    mockReadAccount.mockResolvedValue({
      status: 'ok',
      entry: { account: { id: 'account-a' } },
    });
    broadcast('organizations');
    await service.whenIdle();
    expect(service.get().epoch).toBe('saved-epoch');
    expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
      running: 1,
      stopTargets: [{ operationId: 'new-turn' }],
    });
    const transcript = mockTabs[0]?.transcript;
    if (transcript === undefined) throw new Error('Missing transcript');
    transcript.transcriptRevision = 2;
    mockRuntimeByChatId = { chat: { status: 'idle', queuedMessageIds: [] } };
    publishChatSnapshot();
    await service.whenIdle();
    expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
      running: 0,
      unread: 1,
    });
  });

  it.each([1, 2])(
    'does not hydrate an obsolete turn as active while another turn runs (revision %s)',
    async (revision): Promise<void> => {
      await restartWithTranscript(revision, true, true);
      mockActiveSessions = [
        {
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat',
          turnActive: true,
        },
      ];
      mockRuntimeByChatId = {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'turn-2', startedAt: 1 },
          queuedMessageIds: [],
        },
      };
      publishChatSnapshot();
      await service.whenIdle();
      mockReadAccount.mockResolvedValue({
        status: 'ok',
        entry: { account: { id: 'account-a' } },
      });
      broadcast('organizations');
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        running: 1,
        unread: revision === 2 ? 1 : 0,
        stopTargets: [{ operationId: 'turn-2' }],
      });
      await expect(
        service.stop({
          epoch: service.get().epoch,
          target: {
            source: 'chat',
            workspaceId: 'workspace',
            worktreeId: 'worktree',
            chatId: 'chat',
            operationId: 'turn',
            resultToken: 'previous-turn:1',
          },
        }),
      ).rejects.toThrow(FOREIGN_ACTIVITY_INACTIVE_ERROR);
    },
  );

  it.each(['active', 'queued'] as const)(
    'retains an exact restored %s chat turn',
    async (state): Promise<void> => {
      await restartWithTranscript(1, true, true);
      mockActiveSessions =
        state === 'active'
          ? [
              {
                projectId: 'workspace',
                worktreeId: 'worktree',
                chatId: 'chat',
                turnActive: true,
              },
            ]
          : [];
      mockRuntimeByChatId = {
        chat: {
          status: state === 'active' ? 'streaming' : 'queued',
          activeTurn:
            state === 'active'
              ? { userMessageId: 'turn', startedAt: 1 }
              : undefined,
          queuedMessageIds: state === 'queued' ? ['turn'] : [],
        },
      };
      mockReadAccount.mockResolvedValue({
        status: 'ok',
        entry: { account: { id: 'account-a' } },
      });
      broadcast('organizations');
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        running: 1,
        interrupted: false,
        stopTargets: [{ operationId: 'turn' }],
      });
    },
  );

  function publishChatSnapshot(): void {
    publishForeignChatActivity({
      projectId: 'workspace',
      worktreeId: 'worktree',
      tabs: mockTabs,
      runtimeByChatId: mockRuntimeByChatId,
      removedTabIds: [],
    });
  }

  it.each(['different-account', 'invalid-json', 'invalid-schema'] as const)(
    'opens a fresh epoch after recovery with a retained %s ledger',
    async (retained): Promise<void> => {
      publish('old-account-run');
      await service.whenIdle();
      const oldEpoch = service.get().epoch;
      const filePath = join(mockDataDir, 'foreign-activity-ledger.json');
      if (retained !== 'different-account')
        await writeFile(filePath, retained === 'invalid-json' ? '{' : '{}');
      const saved = await readFile(filePath, 'utf8');
      await restartWithoutAccount();
      expect(await readFile(filePath, 'utf8')).toBe(saved);
      mockReadAccount.mockResolvedValue({
        status: 'ok',
        entry: { account: { id: 'account-a' } },
      });
      broadcast('organizations');
      await service.whenIdle();

      expect(service.get().epoch).not.toBe(oldEpoch);
      expect(service.get().groups).toEqual([]);
      const fresh = await readFile(filePath, 'utf8');
      expect(fresh).toContain('account-a');
      expect(fresh).not.toContain('old-account-run');
      publish('recovered-run');
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]?.running).toBe(1);
    },
  );

  it('fences a recovery read superseded by an account change', async (): Promise<void> => {
    await restartWithoutAccount();
    let release: ((value: object) => void) | undefined;
    mockReadAccount.mockImplementationOnce(
      (): Promise<object> =>
        new Promise((resolve): void => {
          release = resolve;
        }),
    );
    broadcast('organizations');
    await Promise.resolve();
    mockAccountListener?.({ account: { id: 'new-account' } });
    release?.({ status: 'ok', entry: { account: { id: 'stale-account' } } });
    await service.whenIdle();
    publish('new-account-run');
    await service.whenIdle();
    const file = await readFile(
      join(mockDataDir, 'foreign-activity-ledger.json'),
      'utf8',
    );
    expect(file).toContain('new-account');
    expect(file).not.toContain('stale-account');
  });

  it('prefers unread, then active, then newer linger targets', async (): Promise<void> => {
    const startedAt = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      publishForeignChatActivity({
        projectId: 'workspace',
        worktreeId: 'worktree',
        tabs: [
          { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
        ],
        runtimeByChatId: {
          chat: {
            status: 'streaming',
            activeTurn: { userMessageId: 'unread-turn', startedAt: 1 },
            queuedMessageIds: [],
          },
        },
        removedTabIds: [],
      });
      await service.whenIdle();
      publishForeignChatActivity({
        projectId: 'workspace',
        worktreeId: 'worktree',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            messages: [],
            createdAt: '2026-09-23',
            unread: true,
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: 2,
              committedByteLength: 100,
              transcriptRevision: 1,
              hasActiveSidecar: false,
            },
          },
        ],
        runtimeByChatId: { chat: { status: 'idle', queuedMessageIds: [] } },
        removedTabIds: [],
      });
      await service.whenIdle();
      now.mockReturnValue(startedAt + 1_000);
      publish('active-run');
      publish('linger-run');
      await service.whenIdle();
      now.mockReturnValue(startedAt + 2_000);
      publish('linger-run', 'success');
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        running: 1,
        unread: 1,
        latestTarget: { operationId: 'unread-turn' },
      });
      publishForeignChatActivity({
        projectId: 'workspace',
        worktreeId: 'worktree',
        tabs: [],
        runtimeByChatId: {},
        removedTabIds: ['chat'],
      });
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        running: 1,
        unread: 0,
        latestTarget: { operationId: 'active-run' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it.each([true, false])(
    'restores a durably completed active chat with unread=%s',
    async (unread): Promise<void> => {
      await restartWithTranscript(2, unread);
      const row = service.get().groups[0]?.workspaces[0];
      expect(row).toMatchObject({
        running: 0,
        unread: unread ? 1 : 0,
        interrupted: false,
        latestTarget: { resultToken: 'turn:2' },
      });
      expect(
        await readFile(
          join(mockDataDir, 'foreign-activity-ledger.json'),
          'utf8',
        ),
      ).toContain(
        unread ? 'FOREIGN_COMPLETED_UNREAD' : 'FOREIGN_COMPLETED_LINGER',
      );
    },
  );

  it('keeps an active chat Interrupted when its transcript has not changed', async (): Promise<void> => {
    await restartWithTranscript(1, true);
    expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
      running: 0,
      unread: 0,
      interrupted: true,
    });
  });

  it.each(['absent', 'malformed', 'unretained', 'unreadable'] as const)(
    'validates restored workspace ownership during hydration: %s',
    async (authority): Promise<void> => {
      // Seed a completed unread result for missing/malformed/transient configs,
      // and an active result for an owner changed to an inaccessible org.
      await restartWithTranscript(2, true, true, authority !== 'unretained');
      mockReadConfig.mockResolvedValue(
        authority === 'unretained'
          ? {
              ...authoritativeOrg,
              config: {
                ...authoritativeOrg.config,
                owner: {
                  ...authoritativeOrg.config.owner,
                  organizationId: 'org-no-longer-member',
                },
              },
            }
          : {
              config: { version: 1, repos: [] },
              authority: authority === 'malformed' ? 'ok' : authority,
              ownerMalformed: authority === 'malformed',
            },
      );
      mockReadAccount.mockResolvedValue({
        status: 'ok',
        entry: { account: { id: 'account-a' } },
      });
      broadcast('organizations');
      await service.whenIdle();
      const saved = await readFile(
        join(mockDataDir, 'foreign-activity-ledger.json'),
        'utf8',
      );
      if (authority === 'unreadable') {
        expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
          workspaceId: 'workspace',
          unread: 1,
          interrupted: false,
        });
        expect(saved).toContain('FOREIGN_COMPLETED_UNREAD');
      } else {
        expect(service.get().groups).toEqual([]);
        expect(saved).not.toContain('"workspaceId":"workspace"');
      }
    },
  );

  it('clears restored Interrupted projection when an authoritative terminal result arrives', async (): Promise<void> => {
    await restartWithTranscript(1, true);
    expect(service.get().groups[0]?.workspaces[0]?.interrupted).toBe(true);
    await service.shutdown();
    const transcript = mockTabs[0]?.transcript;
    if (transcript === undefined) throw new Error('Missing saved transcript');
    transcript.transcriptRevision = 2;
    service = new ForeignActivityCarryoverService();
    await service.initialize();
    await service.whenIdle();
    expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
      running: 0,
      unread: 1,
      interrupted: false,
      latestTarget: { resultToken: 'turn:2' },
    });
  });

  async function restartWithTranscript(
    revision: number,
    unread: boolean,
    unavailable = false,
    completed = false,
  ): Promise<void> {
    await service.whenIdle();
    service.dispose();
    resetForeignActivitySources();
    mockTabs = [
      {
        id: 'chat',
        title: 'Chat',
        createdAt: '2026-09-23',
        messages: [],
        unread,
        transcript: {
          format: 'complete-message-jsonl-v1',
          committedMessageCount: 2,
          committedByteLength: 100,
          transcriptRevision: revision,
          hasActiveSidecar: false,
        },
      },
    ];
    await writeFile(
      join(mockDataDir, 'foreign-activity-ledger.json'),
      JSON.stringify({
        version: 1,
        accountId: 'account-a',
        epoch: 'saved-epoch',
        entries: [
          {
            operation: {
              source: 'chat',
              operationId: 'turn',
              workspaceId: 'workspace',
              worktreeId: 'worktree',
              chatId: 'chat',
              context: { kind: 'organization', organizationId: 'org-a' },
              active: !completed,
              resultToken: completed ? 'turn:2' : 'previous-turn:1',
              unreadToken: completed ? 'turn:2' : null,
            },
            baselineToken: 'previous-turn:1',
            state: completed ? 'FOREIGN_COMPLETED_UNREAD' : 'FOREIGN_ACTIVE',
            changedAt: Date.now(),
          },
        ],
      }),
    );
    if (unavailable)
      mockReadAccount.mockResolvedValue({ status: 'unavailable' });
    service = new ForeignActivityCarryoverService();
    await service.initialize();
    await service.whenIdle();
  }

  it('starts a fresh current-context epoch after disable, switch and enable', async (): Promise<void> => {
    publish('old-org-run');
    await service.whenIdle();
    const oldEpoch = service.get().epoch;
    mockEnabled = false;
    mockFlagListener?.();
    await service.whenIdle();
    expect(service.get().groups).toEqual([]);
    await expect(
      readFile(join(mockDataDir, 'foreign-activity-ledger.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    mockState = {
      ...mockState,
      context: { kind: 'organization', organizationId: 'org-a' },
    };
    broadcast('switch');
    publishForeignScriptActivity({
      workspaceLocalId: 'personal-workspace',
      worktreeLocalId: 'worktree',
      localId: 'personal-run',
      scriptId: 'script',
      scriptKey: 'script',
      scriptName: 'script',
      name: 'Script',
      target: 'project',
      status: 'running',
    });
    mockReadConfig.mockImplementation(
      (workspaceId?: string): ReturnType<typeof readWorkspaceConfigDetailed> =>
        Promise.resolve(
          workspaceId === 'personal-workspace'
            ? {
                config: { version: 1, repos: [] },
                authority: 'ok',
                ownerMalformed: false,
              }
            : authoritativeOrg,
        ),
    );
    mockEnabled = true;
    mockFlagListener?.();
    await service.whenIdle();
    expect(service.get().epoch).not.toBe(oldEpoch);
    expect(service.get().groups).toEqual([
      expect.objectContaining({
        context: { kind: 'personal' },
        workspaces: [
          expect.objectContaining({
            workspaceId: 'personal-workspace',
            running: 1,
          }),
        ],
      }),
    ]);
    expect(
      await readFile(join(mockDataDir, 'foreign-activity-ledger.json'), 'utf8'),
    ).toContain('test-account');
  });

  it.each(['queued', 'running', 'missing'] as const)(
    'routes pipeline Stop for a %s execution',
    async (state): Promise<void> => {
      const cancel = jest.fn((): Promise<void> => Promise.resolve());
      mockGetActiveHandle.mockReturnValue(
        state === 'running' ? { cancel } : undefined,
      );
      mockListQueuedPipelines.mockReturnValue(
        state === 'queued'
          ? [
              {
                queueId: 'queue-id',
                executionId: 'execution-id',
                projectId: 'workspace',
                worktreeId: 'worktree',
              },
            ]
          : [],
      );
      publishForeignPipelineQueueActivity({
        type: 'queued',
        executionId: 'execution-id',
        projectId: 'workspace',
        worktreeId: 'worktree',
      });
      await service.whenIdle();
      const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
      if (target === undefined) throw new Error('Missing pipeline target');
      if (state === 'missing') {
        await expect(
          service.stop({ epoch: service.get().epoch, target }),
        ).rejects.toThrow('This operation is no longer active.');
      } else {
        await service.stop({ epoch: service.get().epoch, target });
      }
      if (state === 'queued')
        expect(mockCancelQueuedPipeline).toHaveBeenCalledWith('queue-id');
      else expect(mockCancelQueuedPipeline).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(state === 'running' ? 1 : 0);
    },
  );

  it('rejects Stop on a cancelled queued turn after source removal', async (): Promise<void> => {
    const input: Parameters<typeof publishForeignChatActivity>[0] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      tabs: [
        { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
      ],
      runtimeByChatId: { chat: { status: 'queued', queuedMessageIds: ['X'] } },
      removedTabIds: [],
    };
    publishForeignChatActivity(input);
    await service.whenIdle();
    const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
    if (target === undefined) throw new Error('Missing queued target');
    mockRuntimeByChatId = { chat: { status: 'idle', queuedMessageIds: [] } };
    publishForeignChatActivity({
      ...input,
      runtimeByChatId: mockRuntimeByChatId,
    });
    await service.whenIdle();
    expect(service.get().groups).toEqual([]);
    await expect(
      service.stop({ epoch: service.get().epoch, target }),
    ).rejects.toThrow(FOREIGN_ACTIVITY_INACTIVE_ERROR);
    expect(mockQueueCancel).not.toHaveBeenCalled();
  });

  it.each(['queued-turn', 'active-turn', 'stale-turn'])(
    'routes chat Stop only to the matching %s',
    async (operationId): Promise<void> => {
      const stopTurn = jest.spyOn(chatTurnStop, 'stopChatTurn');
      mockRuntimeByChatId = {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'active-turn', startedAt: 1 },
          queuedMessageIds: ['queued-turn'],
        },
      };
      publishForeignChatActivity({
        projectId: 'workspace',
        worktreeId: 'worktree',
        tabs: [
          { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
        ],
        runtimeByChatId: {
          chat: { status: 'queued', queuedMessageIds: [operationId] },
        },
        removedTabIds: [],
      });
      await service.whenIdle();
      const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
      if (target === undefined) throw new Error('Missing chat target');
      const request = {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
      };
      try {
        if (operationId === 'stale-turn') {
          await expect(
            service.stop({ epoch: service.get().epoch, target }),
          ).rejects.toThrow('This operation is no longer active.');
        } else {
          await service.stop({ epoch: service.get().epoch, target });
        }
        if (operationId === 'active-turn') {
          expect(stopTurn).toHaveBeenCalledWith(request);
          expect(mockQueueCancel).not.toHaveBeenCalled();
        } else {
          expect(stopTurn).not.toHaveBeenCalled();
          expect(mockTerminal).not.toHaveBeenCalled();
          if (operationId === 'queued-turn')
            expect(mockQueueCancel).toHaveBeenCalledWith(request, operationId);
          else expect(mockQueueCancel).not.toHaveBeenCalled();
        }
      } finally {
        stopTurn.mockRestore();
      }
    },
  );

  it.each(['busy', 'became-active', 'inactive'] as const)(
    'handles queued Stop cancellation result when %s',
    async (outcome): Promise<void> => {
      const stopTurn = jest.spyOn(chatTurnStop, 'stopChatTurn');
      mockRuntimeByChatId = {
        chat: { status: 'queued', queuedMessageIds: ['queued-turn'] },
      };
      publishForeignChatActivity({
        projectId: 'workspace',
        worktreeId: 'worktree',
        tabs: [
          { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
        ],
        runtimeByChatId: mockRuntimeByChatId,
        removedTabIds: [],
      });
      await service.whenIdle();
      const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
      if (target === undefined) throw new Error('Missing queued target');
      mockSubscribeRetry.mockClear();
      mockQueueCancel.mockImplementationOnce((): Promise<string> => {
        mockRuntimeByChatId = {
          chat: {
            status: outcome === 'inactive' ? 'idle' : 'streaming',
            queuedMessageIds: [],
            activeTurn:
              outcome === 'inactive'
                ? undefined
                : { userMessageId: 'queued-turn', startedAt: 1 },
          },
        };
        return Promise.resolve(outcome === 'busy' ? 'busy' : 'not_found');
      });
      try {
        const stop = service.stop({ epoch: service.get().epoch, target });
        if (outcome === 'became-active') {
          await stop;
          expect(stopTurn).toHaveBeenCalledWith({
            projectId: 'workspace',
            worktreeId: 'worktree',
            chatId: 'chat',
          });
        } else {
          await expect(stop).rejects.toThrow(
            outcome === 'busy'
              ? FOREIGN_ACTIVITY_BUSY_ERROR
              : FOREIGN_ACTIVITY_INACTIVE_ERROR,
          );
          expect(stopTurn).not.toHaveBeenCalled();
          expect(mockCancelTurn).not.toHaveBeenCalled();
          expect(mockCancelRetry).not.toHaveBeenCalled();
          expect(mockTerminal).not.toHaveBeenCalled();
          if (outcome === 'busy')
            expect(mockSubscribeRetry).not.toHaveBeenCalled();
        }
        expect(mockQueueCancel).toHaveBeenCalledTimes(1);
        expect(mockQueueCancel).toHaveBeenCalledWith(
          { projectId: 'workspace', worktreeId: 'worktree', chatId: 'chat' },
          'queued-turn',
        );
      } finally {
        stopTurn.mockRestore();
      }
    },
  );

  it('foreign Stop cancels the scheduled retry before settling the original chat turn', async (): Promise<void> => {
    const routing = beginChatAutoRouting({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    mockRuntimeByChatId = {
      chat: {
        status: 'failed',
        queuedMessageIds: [],
      },
    };
    mockSubscribeRetry.mockImplementation(
      (
        listener: (
          target: { projectId: string; worktreeId: string; chatId: string },
          active: boolean,
        ) => void,
      ): void => {
        listener(
          { projectId: 'workspace', worktreeId: 'worktree', chatId: 'chat' },
          true,
        );
      },
    );
    let retryScheduled = true;
    mockCancelRetry.mockImplementation((): void => {
      retryScheduled = false;
    });
    publishForeignChatActivity({
      projectId: 'workspace',
      worktreeId: 'worktree',
      tabs: [
        { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
      ],
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurn: { userMessageId: 'original-turn', startedAt: 1 },
        },
      },
      removedTabIds: [],
    });
    await service.whenIdle();
    const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
    if (target === undefined) throw new Error('Missing chat target');
    await service.stop({ epoch: service.get().epoch, target });
    expect(retryScheduled).toBe(false);
    expect(routing.controller.signal.aborted).toBe(true);
    routing.dispose();
    expect(mockCancelRetry).toHaveBeenCalledWith(
      { projectId: 'workspace', worktreeId: 'worktree', chatId: 'chat' },
      'stop',
    );
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { type: 'result', is_error: false, result: 'Cancelled' },
      }),
    );
  });

  it.each(['missing', 'rejected'] as const)(
    'retains authoritative activity when sidebar metadata is %s',
    async (failure): Promise<void> => {
      if (failure === 'missing') mockReadIndex.mockResolvedValue(null);
      else mockReadIndex.mockRejectedValue(new Error('Index unavailable'));
      publish('retained-run');
      await service.whenIdle();
      expect(service.get().groups[0]).toMatchObject({
        context: { kind: 'organization', organizationId: 'org-a' },
        workspaces: [
          {
            workspaceId: 'workspace',
            name: 'Project',
            running: 1,
            latestTarget: { operationId: 'retained-run' },
          },
        ],
      });
      broadcast('switch');
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        name: 'Project',
        running: 1,
      });
    },
  );

  it.each(['unreadable', 'absent', 'malformed', 'unretained'] as const)(
    'removes tracked workspace activity when a terminal update has %s ownership',
    async (failure): Promise<void> => {
      publish('finishing-run');
      publish('sibling-run');
      for (const operationId of ['queued-turn-a', 'queued-turn-b']) {
        publishForeignChatActivity({
          projectId: 'workspace',
          worktreeId: 'worktree',
          tabs: [
            {
              id: 'chat',
              title: 'Chat',
              messages: [],
              createdAt: '2026-09-23',
            },
          ],
          runtimeByChatId: {
            // Reordering keeps the earlier observed head queued, not cancelled.
            chat: {
              status: 'queued',
              queuedMessageIds:
                operationId === 'queued-turn-a'
                  ? [operationId]
                  : [operationId, 'queued-turn-a'],
            },
          },
          removedTabIds: [],
        });
      }
      publish('unrelated-run', 'running', 'other-workspace');
      await service.whenIdle();
      const epoch = service.get().epoch;
      const row = service
        .get()
        .groups[0]?.workspaces.find(
          (workspace): boolean => workspace.workspaceId === 'workspace',
        );
      const target = row?.stopTargets[0];
      if (target === undefined) throw new Error('Missing active target');
      expect(row?.running).toBe(4);
      mockReadConfig.mockImplementation(
        (workspaceId): ReturnType<typeof readWorkspaceConfigDetailed> =>
          Promise.resolve(
            workspaceId !== 'workspace'
              ? authoritativeOrg
              : {
                  ...authoritativeOrg,
                  authority:
                    failure === 'unreadable' || failure === 'absent'
                      ? failure
                      : 'ok',
                  ownerMalformed: failure === 'malformed',
                  config: {
                    ...authoritativeOrg.config,
                    owner: {
                      ...authoritativeOrg.config.owner,
                      organizationId:
                        failure === 'unretained' ? 'org-b' : 'org-a',
                    },
                  },
                },
          ),
      );
      publish('finishing-run', 'success');
      await service.whenIdle();

      expect(service.get().epoch).toBe(epoch);
      expect(service.get().groups[0]?.workspaces).toMatchObject([
        {
          workspaceId: 'other-workspace',
          running: 1,
          latestTarget: { operationId: 'unrelated-run' },
        },
      ]);
      const persisted = await readFile(
        join(mockDataDir, 'foreign-activity-ledger.json'),
        'utf8',
      );
      expect(persisted).not.toContain('finishing-run');
      expect(persisted).not.toContain('sibling-run');
      expect(persisted).not.toContain('queued-turn-');
      expect(persisted).toContain('unrelated-run');
      await expect(service.stop({ epoch, target })).rejects.toThrow(
        'This operation is no longer active.',
      );

      // Multiple removals must not consume the next upstream event's sequence.
      publish('unrelated-run', 'success', 'other-workspace');
      await service.whenIdle();
      expect(service.get().groups[0]?.workspaces[0]).toMatchObject({
        workspaceId: 'other-workspace',
        running: 0,
        stopTargets: [],
      });
      // A new epoch must not register any rejected operation from the snapshot.
      broadcast('switch');
      await service.whenIdle();
      expect(service.get().groups).toEqual([]);
    },
  );

  it.each(['unreadable', 'absent'] as const)(
    'drops operations with %s ownership',
    async (authority): Promise<void> => {
      mockState = {
        ...mockState,
        context: { kind: 'organization', organizationId: 'org-a' },
      };
      broadcast('switch');
      await service.whenIdle();
      mockReadConfig.mockResolvedValue({
        config: { version: 1, repos: [] },
        authority,
        ownerMalformed: false,
      });
      publish('untrusted-run');
      await service.whenIdle();
      expect(service.get().groups).toEqual([]);
    },
  );

  it('drops malformed owners instead of classifying them Personal', async (): Promise<void> => {
    mockState = {
      ...mockState,
      context: { kind: 'organization', organizationId: 'org-a' },
    };
    broadcast('switch');
    await service.whenIdle();
    mockReadConfig.mockResolvedValue({
      config: { version: 1, repos: [] },
      authority: 'ok',
      ownerMalformed: true,
    });
    publish('malformed-run');
    await service.whenIdle();
    expect(service.get().groups).toEqual([]);
  });

  it('classifies authoritative personal and organization ownership', async (): Promise<void> => {
    publish('org-run');
    await service.whenIdle();
    expect(service.get().groups[0]?.context).toEqual({
      kind: 'organization',
      organizationId: 'org-a',
    });
    mockReadConfig.mockResolvedValue({
      config: { version: 1, repos: [] },
      authority: 'ok',
      ownerMalformed: false,
    });
    mockState = {
      ...mockState,
      context: { kind: 'organization', organizationId: 'org-a' },
    };
    broadcast('switch');
    await service.whenIdle();
    expect(service.get().groups[0]?.context).toEqual({ kind: 'personal' });
  });

  it('fences the source registry on account change until the next operation event', async (): Promise<void> => {
    publish('account-run');
    await service.whenIdle();
    const sequence = foreignActivitySourceSnapshot().sequence;
    expect(service.get().groups).toHaveLength(1);
    mockAccountListener?.({ account: { id: 'account-b' } });
    await service.whenIdle();
    broadcast('switch');
    await service.whenIdle();
    expect(service.get().groups).toEqual([]);
    expect(foreignActivitySourceSnapshot().operations).toEqual([]);
    publish('account-run');
    await service.whenIdle();
    expect(service.get().groups[0]?.workspaces[0]?.running).toBe(1);
    expect(foreignActivitySourceSnapshot().sequence).toBeGreaterThan(sequence);
  });

  it.each(['snapshot', 'event'] as const)(
    'rejects an in-flight old-account %s after metadata resolves',
    async (kind): Promise<void> => {
      publish('racing-run');
      await service.whenIdle();
      let release: (() => void) | undefined;
      let started: (() => void) | undefined;
      const entered = new Promise<void>((resolve): void => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve): void => {
        release = resolve;
      });
      mockReadConfig.mockImplementationOnce(
        async (): ReturnType<typeof mockReadConfig> => {
          started?.();
          await gate;
          return authoritativeOrg;
        },
      );
      if (kind === 'snapshot') broadcast('switch');
      else publish('racing-run-updated');
      await entered;
      mockAccountListener?.({ account: { id: 'account-b' } });
      release?.();
      await service.whenIdle();
      expect(service.get().groups).toEqual([]);
    },
  );

  it.each(['organizations', 'departed'] as const)(
    'removes revoked entries from disk and rejects stale Stop on %s',
    async (reason): Promise<void> => {
      publish('revoked-run');
      await service.whenIdle();
      const target = service.get().groups[0]?.workspaces[0]?.stopTargets[0];
      expect(target).toBeDefined();
      if (target === undefined) throw new Error('Missing active target');
      const path = join(mockDataDir, 'foreign-activity-ledger.json');
      expect(await readFile(path, 'utf8')).toContain('org-a');
      mockState = { ...mockState, organizations: [] };
      broadcast(reason);
      await service.whenIdle();
      expect(await readFile(path, 'utf8')).not.toContain('org-a');
      await expect(
        service.stop({ epoch: service.get().epoch, target }),
      ).rejects.toThrow('This operation is no longer active.');
      // Stale registry snapshots and new source events cannot re-import revocation.
      broadcast('switch');
      publish('revoked-run');
      await service.whenIdle();
      expect(await readFile(path, 'utf8')).not.toContain('org-a');
      mockState = {
        ...mockState,
        organizations: [{ id: 'org-a', name: 'Org A', role: 'MEMBER' }],
      };
      broadcast('organizations');
      expect(service.get().groups).toEqual([]);
    },
  );
});

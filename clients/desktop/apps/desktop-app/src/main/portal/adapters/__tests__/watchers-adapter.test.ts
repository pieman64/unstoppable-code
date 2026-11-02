import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
  AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';
import {
  watcherTargetDisplay,
  triggerTitle,
} from '@canopy/desktop-shared/lib/watcher-display';
import {
  clearPortalWatcherProjection,
  emitPortalWatcherProjection,
  handlePortalWatcherDelete,
  listPortalWatcherEntities,
  listPortalWatchersForSnapshot,
  projectPortalWatchers,
} from '../watchers-adapter';
import type { PortalAdapterContext } from '../types';

jest.mock('../../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): {
    list: typeof mockList;
    deleteWatcher: typeof mockDelete;
  } => ({
    list: mockList,
    deleteWatcher: mockDelete,
  }),
}));
jest.mock('../../portal-event-bus', () => ({
  capturePortalEmissionContext: (): { generation: number } => ({
    generation: 1,
  }),
  isPortalEmissionContextCurrent: (): boolean => mockActive,
  createPortalEvent: (
    type: string,
    payload: unknown,
  ): { type: string; payload: unknown } => ({ type, payload }),
  enqueuePortalEvent: (event: PortalEventEnvelope): void => {
    mockEmit(event);
  },
}));
const mockList = jest.fn<Promise<AppAdvisorWatcherSummary[]>, []>();
const mockDelete = jest.fn<
  Promise<boolean>,
  [string, { notifySubscriber: boolean }]
>();
const mockEmit = jest.fn<void, [PortalEventEnvelope]>();
let mockActive = true;
const destination = {
  projectId: 'project',
  worktreeId: 'branch',
  chatId: 'chat',
};
function watcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: 'watcher',
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    label: 'Build',
    createdAt: '2026-10-27T12:00:00.000Z',
    destination,
    target: {
      kind: 'worktree_pipeline',
      projectId: 'other-project',
      worktreeId: 'other-branch',
      pipelineName: 'Tests',
    },
    ...overrides,
  };
}
type TestContext = Omit<PortalAdapterContext, 'complete' | 'fail'> & {
  complete: jest.Mock<void, [PortalCommandEnvelope, unknown?]>;
  fail: jest.Mock<void, [PortalCommandEnvelope, string, string, boolean?]>;
};
function context(): TestContext {
  return {
    sessionId: 'session',
    canReadTranscripts: () => mockActive,
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn<void, [PortalCommandEnvelope, unknown?]>(),
    fail: jest.fn<void, [PortalCommandEnvelope, string, string, boolean?]>(),
  };
}
const command = {
  id: 'command',
  sequence: 1,
  createdAt: '2026-10-27T12:00:00.000Z',
  expiresAt: null,
  commandId: 'command',
  sequenceNumber: 1,
  type: 'portal.watcher.delete' as const,
  payload: { watcherId: 'watcher', notifySubscriber: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockActive = true;
  clearPortalWatcherProjection();
  mockList.mockResolvedValue([watcher()]);
  mockDelete.mockResolvedValue(true);
});

describe('Portal watcher projection', () => {
  it('accepts real worktree and App Advisor chat summaries, excluding standalone and other entity kinds', async () => {
    const advisorDestination = {
      projectId: 'app-advisor',
      worktreeId: 'entry',
      chatId: 'advisor-chat',
    };
    mockList.mockResolvedValue([
      watcher(),
      watcher({ id: 'advisor', destination: advisorDestination }),
    ]);
    const rows = await listPortalWatchersForSnapshot(
      {
        scope: 'worktree',
        target: {
          workspaceLocalId: 'project',
          worktreeLocalId: 'branch',
        },
      },
      [
        {
          entityType: 'chat_summary',
          localId: 'chat',
          payload: {
            scope: 'worktree',
            workspaceLocalId: 'project',
            worktreeLocalId: 'branch',
          },
        },
        {
          entityType: 'chat_summary',
          localId: 'other',
          payload: {
            scope: 'standalone',
            workspaceLocalId: 'project',
            worktreeLocalId: 'branch',
          },
        },
      ],
    );
    expect(rows.map((row) => row.localId)).toEqual(['watcher']);
    const advisor = await listPortalWatchersForSnapshot(
      { scope: 'app_advisor' },
      [
        {
          entityType: 'app_advisor_chat',
          localId: 'advisor-chat',
          payload: { workEntryId: 'entry' },
        },
      ],
    );
    expect(advisor.map((row) => row.localId)).toEqual(['advisor']);
    expect(
      await listPortalWatchersForSnapshot({ scope: 'overview' }, rows),
    ).toEqual([]);
  });
  it('matches subscriber coordinates and visible statuses, including delegates', () => {
    const rows = projectPortalWatchers(
      [
        watcher(),
        watcher({ id: 'failed', status: 'delivery_failed' }),
        watcher({ id: 'firing', status: 'firing' }),
        watcher({ id: 'fired', status: 'fired' }),
        watcher({
          id: 'foreign',
          destination: { ...destination, chatId: 'other' },
        }),
        watcher({
          id: 'foreign-project',
          destination: { ...destination, projectId: 'other' },
        }),
        watcher({
          id: 'foreign-branch',
          destination: { ...destination, worktreeId: 'other' },
        }),
        watcher({
          id: 'delegate',
          destination: { ...destination, delegationId: 'internal-id' },
          ownerDelegate: {
            delegationId: 'internal-id',
            description: 'Builder',
            depth: 1,
          },
        }),
      ],
      [destination],
    );
    expect(rows.map((row) => row.id)).toEqual([
      'delegate',
      'failed',
      'watcher',
    ]);
    expect(rows[0].display.ownerDelegate).toEqual({
      name: 'Builder',
      detail: 'depth 1',
    });
    expect(JSON.stringify(rows)).not.toContain('internal-id');
  });

  it('uses the same display functions as desktop', () => {
    const source = watcher();
    const [row] = projectPortalWatchers([source], [destination]);
    const target = watcherTargetDisplay(source.target);
    expect(row.display).toMatchObject({
      title: source.label,
      subtitle: triggerTitle(source.trigger),
      watching: target.title,
      details: target.details,
    });
  });

  it('omits host metadata and directory details, and does not spread records', () => {
    const source = watcher({
      trigger: 'command_watch_resolved',
      target: {
        kind: 'command_watch',
        command: 'test -f ready',
        cwd: '/Users/private/work',
        intervalSeconds: 5,
        maxAttempts: 10,
      },
      canonicalTarget: { projectId: 'private-target', taskId: 'private-task' },
      localProgress: {
        attempts: 1,
        nextAttemptAt: 'later',
        reason: '/Users/private/error',
      },
      deliveryError: 'Failed reading /Users/private/secret',
    });
    const [row] = projectPortalWatchers([source], [destination]);
    expect(row.display.watching).toBe('test -f ready');
    expect(JSON.stringify(row)).not.toMatch(
      /\/Users\/|private-target|private-task|canonicalTarget|localProgress|"target"/,
    );
    expect(row.display.details).not.toContainEqual(
      expect.objectContaining({ label: 'Directory' }),
    );
  });

  it('seeds a snapshot and emits add, change, delete and fire deltas only once', async () => {
    expect(await listPortalWatcherEntities([destination])).toHaveLength(1);
    emitPortalWatcherProjection([watcher()]);
    expect(mockEmit).not.toHaveBeenCalled();
    emitPortalWatcherProjection([watcher(), watcher({ id: 'added' })]);
    expect(mockEmit.mock.lastCall?.[0].payload).toMatchObject({
      entities: [{ localId: 'added' }],
    });
    emitPortalWatcherProjection([
      watcher({ status: 'delivery_failed' }),
      watcher({ id: 'added' }),
    ]);
    expect(mockEmit.mock.lastCall?.[0].payload).toMatchObject({
      entities: [
        { localId: 'watcher', payload: { status: 'delivery_failed' } },
      ],
    });
    emitPortalWatcherProjection([watcher({ id: 'added', status: 'firing' })]);
    expect(mockEmit.mock.lastCall?.[0].payload).toMatchObject({
      removed: [{ localId: 'added' }, { localId: 'watcher' }],
    });
    const count = mockEmit.mock.calls.length;
    emitPortalWatcherProjection([]);
    expect(mockEmit).toHaveBeenCalledTimes(count);
  });

  it('does not publish unhydrated destinations or a previous session', async () => {
    emitPortalWatcherProjection([watcher()]);
    expect(mockEmit).not.toHaveBeenCalled();
    await listPortalWatcherEntities([destination]);
    mockActive = false;
    emitPortalWatcherProjection([watcher({ id: 'new' })]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('retries a delta after the transport refuses its first emission', async () => {
    await listPortalWatcherEntities([destination]);
    mockEmit.mockImplementationOnce(() => {
      throw new Error('Sink unavailable');
    });
    expect(() => emitPortalWatcherProjection([])).toThrow('Sink unavailable');
    emitPortalWatcherProjection([]);
    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(mockEmit.mock.lastCall?.[0].payload).toMatchObject({
      removed: [{ localId: 'watcher' }],
    });
  });
});

describe('Portal watcher deletion', () => {
  it('sanitizes service failures instead of sending host details', async () => {
    await listPortalWatcherEntities([destination]);
    mockDelete.mockRejectedValue(
      new Error('Could not read /Users/private/watchers.json'),
    );
    const ctx = context();
    await handlePortalWatcherDelete(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'execution_failed',
      'Could not delete the watcher. Try again.',
    );
  });

  it('rechecks authorization after the service read', async () => {
    await listPortalWatcherEntities([destination]);
    mockList.mockImplementationOnce(() => {
      mockActive = false;
      return Promise.resolve([watcher()]);
    });
    const ctx = context();
    await handlePortalWatcherDelete(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'forbidden',
      expect.any(String),
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'reuses deletion with notifySubscriber=%s',
    async (notifySubscriber) => {
      await listPortalWatcherEntities([destination]);
      const ctx = context();
      await handlePortalWatcherDelete(
        { ...command, payload: { watcherId: 'watcher', notifySubscriber } },
        ctx,
      );
      expect(mockDelete).toHaveBeenCalledWith('watcher', { notifySubscriber });
      expect(ctx.complete).toHaveBeenCalledWith(expect.anything(), {
        ok: true,
      });
    },
  );

  it('returns the typed not-found/firing result', async () => {
    await listPortalWatcherEntities([destination]);
    mockDelete.mockResolvedValue(false);
    const ctx = context();
    await handlePortalWatcherDelete(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'not_found_or_firing',
      expect.any(String),
    );
  });

  it('treats a foreign destination like an unknown id', async () => {
    await listPortalWatcherEntities([destination]);
    const foreign = watcher({
      destination: { ...destination, chatId: 'foreign' },
    });
    mockList.mockResolvedValue([foreign]);
    const ctx = context();
    await handlePortalWatcherDelete(command, ctx);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'not_found_or_firing',
      expect.any(String),
    );
  });

  it('refuses a revoked session without looking up a watcher', async () => {
    await listPortalWatcherEntities([destination]);
    mockList.mockClear();
    mockActive = false;
    const ctx = context();
    await handlePortalWatcherDelete(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'forbidden',
      expect.any(String),
    );
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});

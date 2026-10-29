import type { PortalEventEnvelope } from '@canopy/desktop-shared/types';
import { performance } from 'node:perf_hooks';
import { buildPortalSnapshot } from '../portal-snapshot-builders';
import { acquirePortalOverviewSnapshot } from '../portal-overview-build';
import {
  emitWorktreeDiffStatsDelta,
  notifyPortalStructureChanged,
  notifyPortalModelCatalogChanged,
  pushPortalOverviewSnapshot,
  recordPublishedWorktreeDiffStats,
  setCanopyPortalEventSink,
} from '../portal-event-bus';

const mockRecordAppDiagnostic = jest.fn();
jest.mock('../../observability/index', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));

jest.mock('../../services/chat-service', () => ({
  listWorktreeChatSummaries: jest.fn(() =>
    Promise.resolve([
      { chatId: 'chat-1', availableModels: [{ id: 'copilot:fixture-model' }] },
    ]),
  ),
  projectAllAppAdvisorChatSummaries: jest.fn<Promise<void>, [(() => boolean)?]>(
    () => Promise.resolve(),
  ),
}));
import {
  listWorktreeChatSummaries,
  projectAllAppAdvisorChatSummaries,
} from '../../services/chat-service';

jest.mock('../portal-snapshot-builders', () => ({
  buildPortalSnapshot: jest.fn(),
}));

jest.mock('../../services/worktree-diff-stats-cache', () => ({
  cancelPendingWorktreeDiffStatsRefreshes: jest.fn(),
  getCachedWorktreeDiffStats: jest.fn(() => ({
    insertions: 4,
    deletions: 2,
    generation: 3,
  })),
  refreshMissingWorktreeDiffStats: jest.fn(() => Promise.resolve()),
  requestAllWorktreeDiffStatsRefresh: jest.fn(() => Promise.resolve()),
}));

jest.mock('../model-catalog-projection', () => ({
  buildProjectedModelCatalog: jest.fn(() => ({ groups: ['models'] })),
}));

jest.mock('../../auth/provider-auth-state', () => ({
  peekPortalProviderAvailability: jest.fn(() => ({ codex: true })),
  peekProviderNativeAuthAvailability: jest.fn(() => ({ codex: true })),
}));

jest.mock('../../copilot/runtime-availability', () => ({
  peekCopilotRuntimeAvailability: jest.fn(() => undefined),
  isCopilotRuntimeAvailable: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../../copilot/connection', () => ({
  listCopilotModels: jest.fn(() => Promise.resolve([])),
}));
import { isCopilotRuntimeAvailable } from '../../copilot/runtime-availability';
import { listCopilotModels } from '../../copilot/connection';

// Defaults to "already warm" (`true`, not `undefined`) so the cold-cache
// warm-up added to `setCanopyPortalEventSink` no-ops for every pre-existing
// test in this file by default. The dedicated warm-up tests below override
// this back to `undefined` to exercise the cold path deliberately.
jest.mock('../../cursor/runtime-availability', () => ({
  peekCursorRuntimeAvailability: jest.fn(() => true),
  refreshCursorRuntimeAvailability: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../../services/workspace-portal-service', () => ({
  getWorkspacePortalWorktreeRuntimeStatus: jest.fn(() =>
    Promise.resolve({ hasUnread: true, isStreaming: true }),
  ),
  getWorkspacePortalWorktreeEntity: jest.fn(
    (workspaceId: string, worktreeId: string, runtimeStatus: object) =>
      Promise.resolve({
        entityType: 'worktree',
        localId: worktreeId,
        parentLocalId: workspaceId,
        payload: { ...runtimeStatus },
      }),
  ),
}));

jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: jest.fn(() => Promise.resolve(undefined)),
}));

import {
  cancelPendingWorktreeDiffStatsRefreshes,
  getCachedWorktreeDiffStats,
  refreshMissingWorktreeDiffStats,
  requestAllWorktreeDiffStatsRefresh,
} from '../../services/worktree-diff-stats-cache';
import {
  getWorkspacePortalWorktreeEntity,
  getWorkspacePortalWorktreeRuntimeStatus,
} from '../../services/workspace-portal-service';
import {
  peekCursorRuntimeAvailability,
  refreshCursorRuntimeAvailability,
} from '../../cursor/runtime-availability';
import { resolveAiCreditsScopeOwner } from '../../agents/work-owner';
import { buildProjectedModelCatalog } from '../model-catalog-projection';

const mockedPeekCursorRuntimeAvailability = jest.mocked(
  peekCursorRuntimeAvailability,
);
const mockedRefreshCursorRuntimeAvailability = jest.mocked(
  refreshCursorRuntimeAvailability,
);

const mockedResolveAiCreditsScopeOwner = jest.mocked(
  resolveAiCreditsScopeOwner,
);
const mockedBuildPortalSnapshot = jest.mocked(buildPortalSnapshot);
const mockedCancelPendingWorktreeDiffStatsRefreshes = jest.mocked(
  cancelPendingWorktreeDiffStatsRefreshes,
);
const mockedRefreshMissingWorktreeDiffStats = jest.mocked(
  refreshMissingWorktreeDiffStats,
);
const mockedRequestAllWorktreeDiffStatsRefresh = jest.mocked(
  requestAllWorktreeDiffStatsRefresh,
);
const mockedGetCachedWorktreeDiffStats = jest.mocked(
  getCachedWorktreeDiffStats,
);
const mockedGetWorkspacePortalWorktreeEntity = jest.mocked(
  getWorkspacePortalWorktreeEntity,
);
const mockedGetWorkspacePortalWorktreeRuntimeStatus = jest.mocked(
  getWorkspacePortalWorktreeRuntimeStatus,
);

describe('portal structural event bus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // `mockReturnValue`/`mockResolvedValue` persist across `clearAllMocks`
    // (it only clears call history), so restore the "already warm" default
    // explicitly — a test overriding it to exercise the cold path must not
    // bleed into the next test.
    jest.mocked(isCopilotRuntimeAvailable).mockResolvedValue(false);
    mockedPeekCursorRuntimeAvailability.mockReturnValue(true);
    mockedRefreshCursorRuntimeAvailability.mockResolvedValue(true);
    mockedGetCachedWorktreeDiffStats.mockReturnValue({
      insertions: 4,
      deletions: 2,
      refreshedAt: 0,
      generation: 3,
    });
    mockedGetWorkspacePortalWorktreeRuntimeStatus.mockResolvedValue({
      hasUnread: true,
      isStreaming: true,
    });
    mockedGetWorkspacePortalWorktreeEntity.mockImplementation(
      (workspaceId: string, worktreeId: string, runtimeStatus: object) =>
        Promise.resolve({
          entityType: 'worktree',
          localId: worktreeId,
          parentLocalId: workspaceId,
          payload: { ...runtimeStatus },
        }),
    );
  });

  afterEach(() => {
    setCanopyPortalEventSink(null);
    jest.useRealTimers();
  });

  it('discovers the selected account catalog when Portal attaches to a restarted desktop', async () => {
    jest.mocked(isCopilotRuntimeAvailable).mockResolvedValue(true);
    setCanopyPortalEventSink(jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(listCopilotModels).toHaveBeenCalledTimes(1);
    expect(jest.mocked(listCopilotModels).mock.calls[0]?.[0]).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('refreshes catalogs only for hydrated worktrees and clears them on disconnect', async () => {
    const events: PortalEventEnvelope[] = [];
    const sink = (event: PortalEventEnvelope): void => {
      events.push(event);
    };
    setCanopyPortalEventSink(sink);
    recordPublishedWorktreeDiffStats({
      scope: 'overview',
      entities: [],
      generatedAt: '2026-09-29T00:00:00Z',
    });
    await notifyPortalModelCatalogChanged();
    expect(listWorktreeChatSummaries).not.toHaveBeenCalled();
    const owner = {
      kind: 'organization' as const,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    mockedResolveAiCreditsScopeOwner.mockResolvedValueOnce(owner);
    recordPublishedWorktreeDiffStats({
      scope: 'chat',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
      },
      entities: [],
      generatedAt: '2026-09-29T00:00:00Z',
    });
    await notifyPortalModelCatalogChanged();
    expect(listWorktreeChatSummaries).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(buildProjectedModelCatalog).toHaveBeenCalledWith(undefined, {
      owner,
      cursor: true,
      copilot: true,
      opencode: true,
    });
    expect(
      events.find((event) => event.type === 'portal.state.delta')?.payload,
    ).toMatchObject({
      scope: 'worktree',
      entities: [
        {
          entityType: 'chat_summary',
          localId: 'chat-1',
          payload: { availableModels: [{ id: 'copilot:fixture-model' }] },
        },
        {
          entityType: 'worktree',
          payload: { availableModels: { groups: ['models'] } },
        },
      ],
    });
    setCanopyPortalEventSink(null);
    jest.mocked(listWorktreeChatSummaries).mockClear();
    setCanopyPortalEventSink(sink);
    await notifyPortalModelCatalogChanged();
    expect(listWorktreeChatSummaries).not.toHaveBeenCalled();
  });

  it('passes a session and catalog revision guard into Advisor projection', async () => {
    setCanopyPortalEventSink(jest.fn());
    recordPublishedWorktreeDiffStats({
      scope: 'app_advisor',
      entities: [],
      generatedAt: '',
    });
    await notifyPortalModelCatalogChanged();
    const guard = jest.mocked(projectAllAppAdvisorChatSummaries).mock
      .calls[0]?.[0];
    expect(guard?.()).toBe(true);
    setCanopyPortalEventSink(jest.fn());
    expect(guard?.()).toBe(false);
  });

  it('drops an in-flight catalog projection when the Portal sink is replaced', async () => {
    setCanopyPortalEventSink(jest.fn());
    recordPublishedWorktreeDiffStats({
      scope: 'chat',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
      },
      entities: [],
      generatedAt: '2026-09-29T00:00:00Z',
    });
    let release!: (value: null) => void;
    mockedGetWorkspacePortalWorktreeEntity.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        release = resolve;
      }),
    );
    const pending = notifyPortalModelCatalogChanged();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockedGetWorkspacePortalWorktreeEntity).toHaveBeenCalled();
    const replacement = jest.fn();
    setCanopyPortalEventSink(replacement);
    release(null);
    await pending;
    expect(replacement).not.toHaveBeenCalled();
    jest.mocked(listWorktreeChatSummaries).mockClear();
    await notifyPortalModelCatalogChanged();
    expect(listWorktreeChatSummaries).not.toHaveBeenCalled();
  });

  it('coalesces persistence notifications into one authoritative overview snapshot', async () => {
    const enqueueEvent = jest.fn<void, [PortalEventEnvelope]>();
    mockedBuildPortalSnapshot.mockResolvedValue({
      snapshot: {
        scope: 'overview',
        entities: [],
        generatedAt: '2026-07-23T00:00:00.000Z',
      },
      followUpEvents: [],
    });
    setCanopyPortalEventSink(enqueueEvent);
    await jest.advanceTimersByTimeAsync(0);
    mockedRequestAllWorktreeDiffStatsRefresh.mockClear();
    enqueueEvent.mockClear();

    notifyPortalStructureChanged();
    notifyPortalStructureChanged();
    await jest.advanceTimersByTimeAsync(250);

    expect(mockedBuildPortalSnapshot).toHaveBeenCalledTimes(1);
    expect(mockedBuildPortalSnapshot).toHaveBeenCalledWith({
      scope: 'overview',
    });
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent.mock.calls[0]?.[0].type).toBe('portal.state.snapshot');
    expect(enqueueEvent.mock.calls[0]?.[0].payload).toEqual(
      expect.objectContaining({ scope: 'overview' }),
    );
    expect(mockedRefreshMissingWorktreeDiffStats).toHaveBeenCalledTimes(1);
    expect(
      mockedRefreshMissingWorktreeDiffStats.mock.invocationCallOrder[0],
    ).toBeGreaterThan(enqueueEvent.mock.invocationCallOrder[0]);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockedRequestAllWorktreeDiffStatsRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not publish an overview built for a session that has since been replaced', async () => {
    let release: () => void = () => undefined;
    mockedBuildPortalSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              snapshot: {
                scope: 'overview',
                entities: [],
                generatedAt: '2026-07-23T00:00:00.000Z',
              },
              followUpEvents: [],
            });
        }),
    );
    const oldSink = jest.fn<void, [PortalEventEnvelope]>();
    const newSink = jest.fn<void, [PortalEventEnvelope]>();
    setCanopyPortalEventSink(oldSink);
    await jest.advanceTimersByTimeAsync(0);

    pushPortalOverviewSnapshot();
    await jest.advanceTimersByTimeAsync(0);
    setCanopyPortalEventSink(null);
    setCanopyPortalEventSink(newSink);
    release();
    await jest.advanceTimersByTimeAsync(0);

    expect(
      [...oldSink.mock.calls, ...newSink.mock.calls].filter(
        ([event]) => event.type === 'portal.state.snapshot',
      ),
    ).toEqual([]);
  });

  it('lets a dirty push join a shared build that started after its trigger', async () => {
    let tick = 0;
    const now = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => (tick += 1));
    const releases: Array<() => void> = [];
    const gatedBuild = (): ReturnType<typeof buildPortalSnapshot> =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({
            snapshot: {
              scope: 'overview',
              entities: [],
              generatedAt: '2026-07-23T00:00:00.000Z',
            },
            followUpEvents: [],
          }),
        );
      });
    mockedBuildPortalSnapshot.mockImplementation(gatedBuild);
    try {
      setCanopyPortalEventSink(jest.fn());
      await jest.advanceTimersByTimeAsync(0);

      pushPortalOverviewSnapshot();
      await jest.advanceTimersByTimeAsync(0);
      const stateRequest = acquirePortalOverviewSnapshot(performance.now());
      pushPortalOverviewSnapshot();
      releases[0]?.();
      await jest.advanceTimersByTimeAsync(0);
      releases[1]?.();
      await stateRequest;
      await jest.advanceTimersByTimeAsync(0);

      expect(mockedBuildPortalSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      releases.forEach((resolve) => resolve());
      await jest.advanceTimersByTimeAsync(0);
      now.mockRestore();
      mockedBuildPortalSnapshot.mockReset();
    }
  });

  it('runs at most one more overview build for notifications during a build', async () => {
    const enqueueEvent = jest.fn<void, [PortalEventEnvelope]>();
    const releases: Array<() => void> = [];
    const gatedBuild = (): ReturnType<typeof buildPortalSnapshot> =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({
            snapshot: {
              scope: 'overview',
              entities: [],
              generatedAt: '2026-07-23T00:00:00.000Z',
            },
            followUpEvents: [],
          }),
        );
      });
    mockedBuildPortalSnapshot
      .mockImplementationOnce(gatedBuild)
      .mockImplementationOnce(gatedBuild);
    setCanopyPortalEventSink(enqueueEvent);
    await jest.advanceTimersByTimeAsync(0);
    enqueueEvent.mockClear();

    notifyPortalStructureChanged();
    await jest.advanceTimersByTimeAsync(250);
    expect(mockedBuildPortalSnapshot).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 3; index += 1) {
      notifyPortalStructureChanged();
      await jest.advanceTimersByTimeAsync(300);
    }
    expect(mockedBuildPortalSnapshot).toHaveBeenCalledTimes(1);

    releases[0]?.();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockedBuildPortalSnapshot).toHaveBeenCalledTimes(2);
    releases[1]?.();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockedBuildPortalSnapshot).toHaveBeenCalledTimes(2);
    expect(
      enqueueEvent.mock.calls.filter(
        ([event]) => event.type === 'portal.state.snapshot',
      ),
    ).toHaveLength(2);
  });

  it('skips an overview push once the session is no longer attached', async () => {
    pushPortalOverviewSnapshot();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockedBuildPortalSnapshot).not.toHaveBeenCalled();
  });

  it('records a triage diagnostic when an overview push fails and pushes again later', async () => {
    const enqueueEvent = jest.fn<void, [PortalEventEnvelope]>();
    setCanopyPortalEventSink(enqueueEvent);
    await jest.advanceTimersByTimeAsync(0);
    enqueueEvent.mockClear();
    mockedBuildPortalSnapshot.mockRejectedValueOnce(
      new Error('build exploded'),
    );

    pushPortalOverviewSnapshot();
    await jest.advanceTimersByTimeAsync(0);

    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'portal_structural_sync_failed',
        error: 'build exploded',
      }),
    );
    mockedBuildPortalSnapshot.mockResolvedValueOnce({
      snapshot: {
        scope: 'overview',
        entities: [],
        generatedAt: '2026-07-23T00:00:00.000Z',
      },
      followUpEvents: [],
    });
    pushPortalOverviewSnapshot();
    await jest.advanceTimersByTimeAsync(0);
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
  });

  it('does not sweep or arm the TTL refresh before a snapshot-triggered refresh', async () => {
    setCanopyPortalEventSink(jest.fn());

    await jest.advanceTimersByTimeAsync(120_000);

    expect(mockedRequestAllWorktreeDiffStatsRefresh).not.toHaveBeenCalled();
  });

  it('cancels pending diff-stat refreshes when the sink is removed', async () => {
    setCanopyPortalEventSink(jest.fn());
    notifyPortalStructureChanged();
    await jest.advanceTimersByTimeAsync(250);

    setCanopyPortalEventSink(null);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockedCancelPendingWorktreeDiffStatsRefreshes).toHaveBeenCalledTimes(
      1,
    );
    expect(mockedRequestAllWorktreeDiffStatsRefresh).not.toHaveBeenCalled();
  });

  it('records snapshot values and suppresses an already-published cache value', async () => {
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));
    recordPublishedWorktreeDiffStats({
      scope: 'overview',
      entities: [
        {
          entityType: 'worktree',
          localId: 'worktree-1',
          parentLocalId: 'workspace-1',
          payload: { diffStats: { insertions: 4, deletions: 2 } },
        },
      ],
      generatedAt: '2026-07-31T00:00:00.000Z',
    });
    await Promise.resolve();

    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);

    expect(events).toHaveLength(0);
  });

  it('re-emits a cache value after an older snapshot carrying absence is queued', async () => {
    const published = new Promise<PortalEventEnvelope>((resolve) => {
      setCanopyPortalEventSink(resolve);
    });
    recordPublishedWorktreeDiffStats({
      scope: 'overview',
      entities: [
        {
          entityType: 'worktree',
          localId: 'worktree-1',
          parentLocalId: 'workspace-1',
          payload: {},
        },
      ],
      generatedAt: '2026-07-31T00:00:00.000Z',
    });
    expect((await published).type).toBe('portal.state.delta');
  });

  it('retries the same cache value after an earlier delta is rejected', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetWorkspacePortalWorktreeRuntimeStatus
      .mockResolvedValueOnce({ hasUnread: false })
      .mockResolvedValueOnce({ hasUnread: true })
      .mockResolvedValueOnce({ hasUnread: true, isStreaming: true });
    setCanopyPortalEventSink((event) => events.push(event));

    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);
    expect(events).toHaveLength(0);

    mockedGetWorkspacePortalWorktreeRuntimeStatus.mockResolvedValue({
      hasUnread: true,
    });
    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);
    expect(events).toHaveLength(1);
  });

  it('does not propagate best-effort delta publication failures', async () => {
    mockedGetWorkspacePortalWorktreeRuntimeStatus.mockRejectedValue(
      new Error('project removed'),
    );
    setCanopyPortalEventSink(jest.fn());

    await expect(
      emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3),
    ).resolves.toBeUndefined();
  });

  it('clears published values when the sink is removed', async () => {
    const firstSession: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => firstSession.push(event));
    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);
    expect(firstSession).toHaveLength(1);

    setCanopyPortalEventSink(null);
    const secondSession: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => secondSession.push(event));
    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);

    expect(secondSession).toHaveLength(1);
  });

  it('includes canonical runtime status and new-task controls in a diff-stat delta entity', async () => {
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));

    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      scope: 'worktree',
      entities: [
        {
          payload: {
            hasUnread: true,
            isStreaming: true,
            availableModels: { groups: ['models'] },
            providerAvailability: { codex: true },
          },
        },
      ],
    });
    expect(mockedResolveAiCreditsScopeOwner).toHaveBeenCalledWith({
      kind: 'work',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });

  it('rebuilds once when runtime status changes while the entity is built', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetWorkspacePortalWorktreeRuntimeStatus
      .mockResolvedValueOnce({ hasUnread: false })
      .mockResolvedValueOnce({ hasUnread: true })
      .mockResolvedValueOnce({ hasUnread: true });
    setCanopyPortalEventSink((event) => events.push(event));

    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);

    expect(mockedGetWorkspacePortalWorktreeEntity).toHaveBeenCalledTimes(2);
    expect(mockedGetWorkspacePortalWorktreeEntity).toHaveBeenLastCalledWith(
      'workspace-1',
      'worktree-1',
      { hasUnread: true },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      entities: [{ payload: { hasUnread: true } }],
    });
  });

  it('suppresses the diff delta when runtime status changes during its one rebuild', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetWorkspacePortalWorktreeRuntimeStatus
      .mockResolvedValueOnce({ hasUnread: false })
      .mockResolvedValueOnce({ hasUnread: true })
      .mockResolvedValueOnce({ hasUnread: true, isStreaming: true });
    setCanopyPortalEventSink((event) => events.push(event));

    await emitWorktreeDiffStatsDelta('workspace-1', 'worktree-1', 3);

    expect(mockedGetWorkspacePortalWorktreeEntity).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(0);
  });

  describe('cold-cache Cursor availability warm-up on first Portal activation', () => {
    // CAN-3624: a user whose Cursor runtime is already connected, who
    // restarts the desktop and opens the Portal before any local surface has
    // probed the runtime, would otherwise see `providerAvailability.cursor`
    // omitted (and the picker showing "Connect Cursor in the desktop app")
    // until an unrelated desktop interaction happens to warm the cache. The
    // first Portal session activation (sink attaches while inactive) must
    // trigger exactly one background probe when the cache is cold, then push
    // a fresh overview so this session's own next projection already carries
    // the answer.

    it('warms the cache and pushes a fresh overview when the first activation finds Cursor actually available', async () => {
      mockedPeekCursorRuntimeAvailability.mockReturnValue(undefined);
      mockedRefreshCursorRuntimeAvailability.mockResolvedValueOnce(true);
      mockedBuildPortalSnapshot.mockResolvedValue({
        snapshot: {
          scope: 'overview',
          entities: [],
          generatedAt: '2026-09-20T00:00:00.000Z',
        },
        followUpEvents: [],
      });
      const enqueueEvent = jest.fn<void, [PortalEventEnvelope]>();

      setCanopyPortalEventSink(enqueueEvent);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
      // The refresh resolving triggers `notifyPortalStructureChanged()`,
      // which is itself debounced — advance past that window to observe it.
      await jest.advanceTimersByTimeAsync(250);
      expect(mockedBuildPortalSnapshot).toHaveBeenCalledWith({
        scope: 'overview',
      });
      expect(enqueueEvent).toHaveBeenCalled();
    });

    it('does NOT push an overview when the warm-up probe resolves unavailable — `cursor: false` renders identically to the omitted key, so the rebuild would be pure cost for the common (no Cursor) case', async () => {
      mockedPeekCursorRuntimeAvailability.mockReturnValue(undefined);
      mockedRefreshCursorRuntimeAvailability.mockResolvedValueOnce(false);
      mockedBuildPortalSnapshot.mockResolvedValue({
        snapshot: {
          scope: 'overview',
          entities: [],
          generatedAt: '2026-09-20T00:00:00.000Z',
        },
        followUpEvents: [],
      });
      const enqueueEvent = jest.fn<void, [PortalEventEnvelope]>();

      setCanopyPortalEventSink(enqueueEvent);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(250);
      expect(mockedBuildPortalSnapshot).not.toHaveBeenCalled();
      expect(enqueueEvent).not.toHaveBeenCalled();
    });

    it('does not probe when the cache is already warm', async () => {
      mockedPeekCursorRuntimeAvailability.mockReturnValue(false);

      setCanopyPortalEventSink(jest.fn());
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(250);

      expect(mockedRefreshCursorRuntimeAvailability).not.toHaveBeenCalled();
    });

    it('does not probe again on a later activation while still cold — only the trigger, not the cache state, is deduped', async () => {
      mockedPeekCursorRuntimeAvailability.mockReturnValue(undefined);
      let resolveProbe: (value: boolean) => void = () => {};
      mockedRefreshCursorRuntimeAvailability.mockReturnValue(
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
      );

      // First session attaches; its probe is still in flight.
      setCanopyPortalEventSink(jest.fn());
      await Promise.resolve();
      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);

      // That session drops, and a second one attaches before the first
      // probe resolves. The in-flight dedupe guard must still hold: this is
      // the exact "several Portal sessions attach in quick succession"
      // scenario the guard exists for.
      setCanopyPortalEventSink(null);
      setCanopyPortalEventSink(jest.fn());
      await Promise.resolve();

      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);

      resolveProbe(true);
      await Promise.resolve();
    });

    it('probes again on a fresh activation once a prior warm-up has settled', async () => {
      mockedPeekCursorRuntimeAvailability.mockReturnValue(undefined);

      setCanopyPortalEventSink(jest.fn());
      await jest.advanceTimersByTimeAsync(0);
      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);

      setCanopyPortalEventSink(null);
      setCanopyPortalEventSink(jest.fn());
      await jest.advanceTimersByTimeAsync(0);

      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(2);
    });

    it('does not notify or throw when the probe rejects', async () => {
      mockedPeekCursorRuntimeAvailability.mockReturnValue(undefined);
      mockedRefreshCursorRuntimeAvailability.mockRejectedValueOnce(
        new Error('boom'),
      );

      setCanopyPortalEventSink(jest.fn());
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(250);

      expect(mockedBuildPortalSnapshot).not.toHaveBeenCalled();

      // The dedupe flag must still clear after a rejection, or every future
      // activation would be silently blocked from ever warming the cache.
      mockedRefreshCursorRuntimeAvailability.mockResolvedValueOnce(true);
      setCanopyPortalEventSink(null);
      setCanopyPortalEventSink(jest.fn());
      await Promise.resolve();
      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(2);
    });

    it('does not warm on a no-op sink replacement while already active', async () => {
      mockedPeekCursorRuntimeAvailability.mockReturnValue(undefined);
      setCanopyPortalEventSink(jest.fn());
      await Promise.resolve();
      expect(mockedRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
      mockedRefreshCursorRuntimeAvailability.mockClear();

      // Replacing an already-active sink with another non-null sink is not a
      // false -> true transition and must not re-trigger the warm-up.
      setCanopyPortalEventSink(jest.fn());
      await Promise.resolve();

      expect(mockedRefreshCursorRuntimeAvailability).not.toHaveBeenCalled();
    });
  });
});

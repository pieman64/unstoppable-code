import type {
  AgentAuditEntry,
  AgentAuditHistoryRequest,
  AgentAuditHistoryResponse,
  AgentAuditStatus,
  AgentAuditTranscriptRequest,
  AgentAuditTranscriptResponse,
  AgentObservabilitySnapshot,
  AgentObservabilityUpdateEvent,
  CanopyApi,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageTimeseriesRequest,
  UsageTimeseriesResponse,
} from '@canopy/desktop-shared/types';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function makeEntry(
  status: AgentAuditStatus,
  overrides: Partial<Pick<AgentAuditEntry, 'id' | 'startedAt'>> = {},
): AgentAuditEntry {
  const startedAt = overrides.startedAt ?? '2026-03-30T12:00:00.000Z';
  const completedAt =
    status === 'running'
      ? undefined
      : new Date(Date.parse(startedAt) + 60_000).toISOString();

  return {
    id: overrides.id ?? 'entry-1',
    eventType: 'worktree_chat',
    status,
    provider: 'claude',
    label: 'Worktree Chat',
    startedAt,
    completedAt,
    durationMs: status === 'running' ? undefined : 60_000,
    model: 'claude-sonnet-4-6',
    totalCostUsd: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: {
      thinking: 0,
      bash: 0,
      read: 0,
      readLines: 0,
      writeEdit: 0,
      fileEdit: 0,
      fileAdd: 0,
      fileDelete: 0,
      search: 0,
      grep: 0,
      web: 0,
      agent: 0,
      workflow: 0,
      tasks: 0,
      taskStop: 0,
      skills: 0,
      monitor: 0,
      claude: 0,
      scheduleWakeup: 0,
      askUser: 0,
      scriptOutput: 0,
      watcher: 0,
      canopy: 0,
      appAdvisor: 0,
      mcp: 0,
      other: 0,
    },
    projectId: 'proj-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    hasTranscript: true,
  };
}

function makeSnapshot(entry: AgentAuditEntry): AgentObservabilitySnapshot {
  return {
    version: 1,
    historicalMode: 'forward-only',
    retentionDays: 7,
    recentEntries: [entry],
    usage: {
      updatedAt: '2026-03-30T12:00:00.000Z',
      providers: [],
    },
  };
}

function makeUsageTimeseriesResponse(
  inputTokens: number,
): UsageTimeseriesResponse {
  return {
    kind: 'tokens',
    buckets: [
      {
        bucketStart: '2026-03-30T00:00:00.000Z',
        providers: {
          claude: { in: inputTokens, out: 2 },
          codex: { in: 0, out: 0 },
          ollama: { in: 0, out: 0 },
        },
      },
    ],
  };
}

interface DeferredUsageTimeseriesResponse {
  promise: Promise<UsageTimeseriesResponse>;
  resolve: (response: UsageTimeseriesResponse) => void;
}

interface DeferredAuditHistoryResponse {
  promise: Promise<AgentAuditHistoryResponse>;
  resolve: (response: AgentAuditHistoryResponse) => void;
}

function createUsageTimeseriesDeferred(): DeferredUsageTimeseriesResponse {
  let resolve: (response: UsageTimeseriesResponse) => void = () => {
    throw new Error('Expected deferred resolver to be initialized');
  };

  const promise = new Promise<UsageTimeseriesResponse>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

function createAuditHistoryDeferred(): DeferredAuditHistoryResponse {
  let resolve: (response: AgentAuditHistoryResponse) => void = () => {
    throw new Error('Expected deferred resolver to be initialized');
  };

  const promise = new Promise<AgentAuditHistoryResponse>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

describe('observabilityStore transcript cache', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('reloads a transcript after an entry update changes it from running to completed', async () => {
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue(makeSnapshot(makeEntry('running')));
    const loadHistory = jest.fn();
    const loadUsageTimeseries = jest.fn<
      Promise<UsageTimeseriesResponse>,
      [UsageTimeseriesRequest]
    >();
    const loadTranscript = jest
      .fn<
        Promise<AgentAuditTranscriptResponse>,
        [AgentAuditTranscriptRequest]
      >()
      .mockResolvedValueOnce({
        type: 'success',
        lines: [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Partial"}]}}',
        ],
        providerHint: 'claude',
        truncation: {
          truncated: false,
          maxBytes: 524288,
          storedBytes: 32,
        },
        injectedPrompts: [],
      })
      .mockResolvedValueOnce({
        type: 'success',
        lines: [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Final"}]}}',
        ],
        providerHint: 'claude',
        truncation: {
          truncated: false,
          maxBytes: 524288,
          storedBytes: 64,
        },
        injectedPrompts: [],
      });
    let registeredUpdateHandler = false;
    let updateHandler = (event: AgentObservabilityUpdateEvent): void => {
      void event;
      throw new Error('Expected observability update handler');
    };

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          loadHistory,
          loadTranscript,
          loadUsageTimeseries,
          onUpdate: (
            cb: (event: AgentObservabilityUpdateEvent) => void,
          ): (() => void) => {
            registeredUpdateHandler = true;
            updateHandler = cb;
            return (): void => undefined;
          },
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const runningEntry = makeEntry('running');
    const completedEntry = makeEntry('success');

    const partialTranscript = await useObservabilityStore
      .getState()
      .loadTranscript(runningEntry);

    expect(partialTranscript.type).toBe('success');
    if (partialTranscript.type !== 'success') {
      throw new Error('Expected a successful partial transcript response');
    }
    expect(partialTranscript.lines[0]).toContain('Partial');
    expect(loadTranscript).toHaveBeenCalledTimes(1);

    if (!registeredUpdateHandler) {
      throw new Error('Expected observability update handler');
    }

    updateHandler({
      type: 'entries',
      entries: [completedEntry],
    });

    const completedTranscript = await useObservabilityStore
      .getState()
      .loadTranscript(completedEntry);

    expect(completedTranscript.type).toBe('success');
    if (completedTranscript.type !== 'success') {
      throw new Error('Expected a successful completed transcript response');
    }
    expect(completedTranscript.lines[0]).toContain('Final');
    expect(loadTranscript).toHaveBeenCalledTimes(2);
  });

  it('keeps live history updates inside the active date range', async () => {
    const inRangeEntry = makeEntry('success', { id: 'inside' });
    const outsideRangeEntry = makeEntry('success', {
      id: 'outside',
      startedAt: '2026-04-01T12:00:00.000Z',
    });
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue(makeSnapshot(inRangeEntry));
    const loadHistory = jest
      .fn<Promise<AgentAuditHistoryResponse>, [AgentAuditHistoryRequest]>()
      .mockResolvedValue({ entries: [inRangeEntry] });
    const loadUsageTimeseries = jest.fn<
      Promise<UsageTimeseriesResponse>,
      [UsageTimeseriesRequest]
    >();
    const loadTranscript = jest.fn<
      Promise<AgentAuditTranscriptResponse>,
      [AgentAuditTranscriptRequest]
    >();
    let updateHandler = (event: AgentObservabilityUpdateEvent): void => {
      void event;
      throw new Error('Expected observability update handler');
    };

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          loadHistory,
          loadTranscript,
          loadUsageTimeseries,
          onUpdate: (
            cb: (event: AgentObservabilityUpdateEvent) => void,
          ): (() => void) => {
            updateHandler = cb;
            return (): void => undefined;
          },
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();
    await useObservabilityStore.getState().refreshHistory({
      startDate: '2026-03-30T00:00:00.000Z',
      endDate: '2026-03-31T00:00:00.000Z',
    });

    updateHandler({
      type: 'entries',
      entries: [outsideRangeEntry],
    });

    expect(useObservabilityStore.getState().historyEntries).toEqual([
      inRangeEntry,
    ]);
  });

  it('ignores an old load-more response after a new history refresh starts', async () => {
    const initialEntry = makeEntry('success', { id: 'initial' });
    const staleEntry = makeEntry('success', { id: 'stale-page' });
    const freshEntry = makeEntry('success', { id: 'fresh-filter' });
    const stalePage = createAuditHistoryDeferred();
    const freshRefresh = createAuditHistoryDeferred();
    const loadHistory = jest
      .fn<Promise<AgentAuditHistoryResponse>, [AgentAuditHistoryRequest]>()
      .mockResolvedValueOnce({
        entries: [initialEntry],
        nextCursor: 'old-cursor',
      })
      .mockReturnValueOnce(stalePage.promise)
      .mockReturnValueOnce(freshRefresh.promise);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadHistory,
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().refreshHistory({ search: 'old' });
    const oldLoadMore = useObservabilityStore
      .getState()
      .loadMoreHistory({ search: 'old' });
    const newRefresh = useObservabilityStore
      .getState()
      .refreshHistory({ search: 'fresh' });

    stalePage.resolve({
      entries: [staleEntry],
      nextCursor: 'stale-next-cursor',
    });
    await oldLoadMore;

    expect(useObservabilityStore.getState()).toMatchObject({
      historyEntries: [initialEntry],
      nextCursor: 'old-cursor',
      loadingHistory: true,
    });

    freshRefresh.resolve({
      entries: [freshEntry],
      nextCursor: 'fresh-cursor',
    });
    await newRefresh;

    expect(useObservabilityStore.getState()).toMatchObject({
      historyEntries: [freshEntry],
      nextCursor: 'fresh-cursor',
      loadingHistory: false,
    });
  });

  it('invalidates cached usage timeseries after entry updates', async () => {
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue(makeSnapshot(makeEntry('success')));
    const loadHistory = jest.fn();
    const loadTranscript = jest.fn<
      Promise<AgentAuditTranscriptResponse>,
      [AgentAuditTranscriptRequest]
    >();
    const loadUsageTimeseries = jest
      .fn<Promise<UsageTimeseriesResponse>, [UsageTimeseriesRequest]>()
      .mockResolvedValueOnce({ kind: 'tokens', buckets: [] })
      .mockResolvedValueOnce({
        kind: 'tokens',
        buckets: [
          {
            bucketStart: '2026-03-30T00:00:00.000Z',
            providers: {
              claude: { in: 1, out: 2 },
              codex: { in: 0, out: 0 },
              ollama: { in: 0, out: 0 },
            },
          },
        ],
      });
    let updateHandler = (event: AgentObservabilityUpdateEvent): void => {
      void event;
      throw new Error('Expected observability update handler');
    };

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          loadHistory,
          loadTranscript,
          loadUsageTimeseries,
          onUpdate: (
            cb: (event: AgentObservabilityUpdateEvent) => void,
          ): (() => void) => {
            updateHandler = cb;
            return (): void => undefined;
          },
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const request: UsageTimeseriesRequest = {
      startDate: '2026-03-30T00:00:00.000Z',
      endDate: '2026-03-31T00:00:00.000Z',
      bucket: 'day',
    };

    await useObservabilityStore.getState().loadUsageTimeseries(request);
    await useObservabilityStore.getState().loadUsageTimeseries(request);
    expect(loadUsageTimeseries).toHaveBeenCalledTimes(1);

    const versionBeforeUpdate =
      useObservabilityStore.getState().usageTimeseriesVersion;
    updateHandler({
      type: 'entries',
      entries: [makeEntry('success')],
    });
    expect(useObservabilityStore.getState().usageTimeseriesVersion).toBe(
      versionBeforeUpdate + 1,
    );

    const response = await useObservabilityStore
      .getState()
      .loadUsageTimeseries(request);

    expect(loadUsageTimeseries).toHaveBeenCalledTimes(2);
    expect(response.kind).toBe('tokens');
    if (response.kind !== 'tokens') return;
    expect(response.buckets[0]?.providers.claude).toEqual({ in: 1, out: 2 });
  });

  it('caches usage timeseries responses separately by dataset', async () => {
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue(makeSnapshot(makeEntry('success')));
    const loadHistory = jest.fn();
    const loadTranscript = jest.fn<
      Promise<AgentAuditTranscriptResponse>,
      [AgentAuditTranscriptRequest]
    >();
    const loadUsageTimeseries = jest
      .fn<Promise<UsageTimeseriesResponse>, [UsageTimeseriesRequest]>()
      .mockResolvedValueOnce({ kind: 'tokens', buckets: [] })
      .mockResolvedValueOnce({ kind: 'tab-counts', buckets: [] });

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          loadHistory,
          loadTranscript,
          loadUsageTimeseries,
          onUpdate: (
            cb: (event: AgentObservabilityUpdateEvent) => void,
          ): (() => void) => {
            void cb;
            return (): void => undefined;
          },
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const baseRequest = {
      startDate: '2026-03-30T00:00:00.000Z',
      endDate: '2026-03-31T00:00:00.000Z',
      bucket: 'day' as const,
    };

    await useObservabilityStore.getState().loadUsageTimeseries({
      ...baseRequest,
      dataset: { kind: 'tokens' },
    });
    await useObservabilityStore.getState().loadUsageTimeseries({
      ...baseRequest,
      dataset: {
        kind: 'tab-counts',
        tab: 'tools',
        series: ['tool_calls'],
      },
    });

    expect(loadUsageTimeseries).toHaveBeenCalledTimes(2);
  });

  it('keeps usage timeseries loading until overlapping requests settle', async (): Promise<void> => {
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue(makeSnapshot(makeEntry('success')));
    const loadHistory = jest.fn();
    const loadTranscript = jest.fn<
      Promise<AgentAuditTranscriptResponse>,
      [AgentAuditTranscriptRequest]
    >();
    const firstDeferred = createUsageTimeseriesDeferred();
    const secondDeferred = createUsageTimeseriesDeferred();
    const loadUsageTimeseries = jest
      .fn<Promise<UsageTimeseriesResponse>, [UsageTimeseriesRequest]>()
      .mockReturnValueOnce(firstDeferred.promise)
      .mockReturnValueOnce(secondDeferred.promise);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          loadHistory,
          loadTranscript,
          loadUsageTimeseries,
          onUpdate: (
            cb: (event: AgentObservabilityUpdateEvent) => void,
          ): (() => void) => {
            void cb;
            return (): void => undefined;
          },
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const firstRequest: UsageTimeseriesRequest = {
      startDate: '2026-03-30T00:00:00.000Z',
      endDate: '2026-03-31T00:00:00.000Z',
      bucket: 'day',
    };
    const secondRequest: UsageTimeseriesRequest = {
      startDate: '2026-03-31T00:00:00.000Z',
      endDate: '2026-04-01T00:00:00.000Z',
      bucket: 'day',
    };

    const firstLoad = useObservabilityStore
      .getState()
      .loadUsageTimeseries(firstRequest);
    const secondLoad = useObservabilityStore
      .getState()
      .loadUsageTimeseries(secondRequest);

    expect(useObservabilityStore.getState().loadingUsageTimeseries).toBe(true);

    firstDeferred.resolve(makeUsageTimeseriesResponse(1));
    await firstLoad;

    expect(useObservabilityStore.getState().loadingUsageTimeseries).toBe(true);

    secondDeferred.resolve(makeUsageTimeseriesResponse(2));
    await secondLoad;

    expect(useObservabilityStore.getState().loadingUsageTimeseries).toBe(false);
  });

  it('does not cache stale usage timeseries responses after invalidation', async (): Promise<void> => {
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue(makeSnapshot(makeEntry('success')));
    const loadHistory = jest.fn();
    const loadTranscript = jest.fn<
      Promise<AgentAuditTranscriptResponse>,
      [AgentAuditTranscriptRequest]
    >();
    const firstDeferred = createUsageTimeseriesDeferred();
    const loadUsageTimeseries = jest
      .fn<Promise<UsageTimeseriesResponse>, [UsageTimeseriesRequest]>()
      .mockReturnValueOnce(firstDeferred.promise)
      .mockResolvedValueOnce(makeUsageTimeseriesResponse(9));
    let updateHandler = (event: AgentObservabilityUpdateEvent): void => {
      void event;
      throw new Error('Expected observability update handler');
    };

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          loadHistory,
          loadTranscript,
          loadUsageTimeseries,
          onUpdate: (
            cb: (event: AgentObservabilityUpdateEvent) => void,
          ): (() => void) => {
            updateHandler = cb;
            return (): void => undefined;
          },
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const request: UsageTimeseriesRequest = {
      startDate: '2026-03-30T00:00:00.000Z',
      endDate: '2026-03-31T00:00:00.000Z',
      bucket: 'day',
    };

    const staleLoad = useObservabilityStore
      .getState()
      .loadUsageTimeseries(request);

    updateHandler({
      type: 'entries',
      entries: [makeEntry('success')],
    });

    firstDeferred.resolve(makeUsageTimeseriesResponse(1));
    const staleResponse = await staleLoad;

    expect(staleResponse.kind).toBe('tokens');
    if (staleResponse.kind !== 'tokens') return;
    expect(staleResponse.buckets[0]?.providers.claude).toEqual({
      in: 1,
      out: 2,
    });

    const freshResponse = await useObservabilityStore
      .getState()
      .loadUsageTimeseries(request);

    expect(loadUsageTimeseries).toHaveBeenCalledTimes(2);
    expect(freshResponse.kind).toBe('tokens');
    if (freshResponse.kind !== 'tokens') return;
    expect(freshResponse.buckets[0]?.providers.claude).toEqual({
      in: 9,
      out: 2,
    });
  });
});

function emptyUsageMetricsResponse(): UsageMetricsResponse {
  const emptyRows = { total: 0, rows: [] };
  return {
    updatedAt: '2026-05-26T00:00:00.000Z',
    retentionDays: 7,
    worktrees: {
      created: emptyRows,
      merged: emptyRows,
      deletedWithChanges: emptyRows,
      deletedWithoutChanges: emptyRows,
      deletionAgeMs: emptyRows,
    },
    chats: {
      turnCountsPerChat: emptyRows,
      turnCountsPerWorktree: emptyRows,
      turnDurationMs: emptyRows,
      toolCallsPerTurn: emptyRows,
      toolCallsPerChat: emptyRows,
      toolCallsPerWorktree: emptyRows,
      statusCounts: [],
    },
    plans: {
      created: emptyRows,
      updated: emptyRows,
      approved: emptyRows,
      createdPerWorktree: emptyRows,
      updatedPerWorktree: emptyRows,
      approvedPerWorktree: emptyRows,
    },
    tools: {
      byCategory: [],
      byProvider: emptyRows,
      byInitiationSource: emptyRows,
    },
  };
}

describe('observabilityStore usage metrics cache', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function setupApi(args: {
    loadUsageMetrics: jest.Mock<
      Promise<UsageMetricsResponse>,
      [UsageMetricsRequest]
    >;
    onUpdateRef: {
      current: (event: AgentObservabilityUpdateEvent) => void;
    };
  }): void {
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue(makeSnapshot(makeEntry('success')));
    const loadHistory = jest.fn();
    const loadTranscript = jest.fn<
      Promise<AgentAuditTranscriptResponse>,
      [AgentAuditTranscriptRequest]
    >();
    const loadUsageTimeseries = jest.fn<
      Promise<UsageTimeseriesResponse>,
      [UsageTimeseriesRequest]
    >();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          loadHistory,
          loadTranscript,
          loadUsageTimeseries,
          loadUsageMetrics: args.loadUsageMetrics,
          onUpdate: (
            cb: (event: AgentObservabilityUpdateEvent) => void,
          ): (() => void) => {
            args.onUpdateRef.current = cb;
            return (): void => undefined;
          },
        },
      },
    });
  }

  it('reuses cached usage metrics for identical requests', async () => {
    const loadUsageMetrics = jest
      .fn<Promise<UsageMetricsResponse>, [UsageMetricsRequest]>()
      .mockResolvedValue(emptyUsageMetricsResponse());
    const onUpdateRef = {
      current: (event: AgentObservabilityUpdateEvent): void => {
        void event;
      },
    };
    setupApi({ loadUsageMetrics, onUpdateRef });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const request: UsageMetricsRequest = {
      startDate: '2026-05-19T00:00:00.000Z',
      endDate: '2026-05-26T00:00:00.000Z',
      provider: 'all',
      initiationSource: 'all',
    };

    await useObservabilityStore.getState().loadUsageMetrics(request);
    await useObservabilityStore.getState().loadUsageMetrics(request);

    expect(loadUsageMetrics).toHaveBeenCalledTimes(1);

    const equivalent: UsageMetricsRequest = {
      // Same fields, different ordering for the JSON.stringify-based cache.
      endDate: '2026-05-26T00:00:00.000Z',
      startDate: '2026-05-19T00:00:00.000Z',
      initiationSource: 'all',
      provider: 'all',
    };
    await useObservabilityStore.getState().loadUsageMetrics(equivalent);
    expect(loadUsageMetrics).toHaveBeenCalledTimes(1);
  });

  it('uses distinct cache entries when the cache key changes', async () => {
    const loadUsageMetrics = jest
      .fn<Promise<UsageMetricsResponse>, [UsageMetricsRequest]>()
      .mockResolvedValue(emptyUsageMetricsResponse());
    const onUpdateRef = {
      current: (event: AgentObservabilityUpdateEvent): void => {
        void event;
      },
    };
    setupApi({ loadUsageMetrics, onUpdateRef });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    await useObservabilityStore.getState().loadUsageMetrics({
      startDate: '2026-05-19T00:00:00.000Z',
      endDate: '2026-05-26T00:00:00.000Z',
      provider: 'all',
      initiationSource: 'all',
    });

    await useObservabilityStore.getState().loadUsageMetrics({
      startDate: '2026-05-19T00:00:00.000Z',
      endDate: '2026-05-26T00:00:00.000Z',
      provider: 'claude',
      initiationSource: 'all',
    });

    expect(loadUsageMetrics).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached usage metrics on entry observability events', async () => {
    const loadUsageMetrics = jest
      .fn<Promise<UsageMetricsResponse>, [UsageMetricsRequest]>()
      .mockResolvedValue(emptyUsageMetricsResponse());
    const onUpdateRef = {
      current: (event: AgentObservabilityUpdateEvent): void => {
        void event;
      },
    };
    setupApi({ loadUsageMetrics, onUpdateRef });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const request: UsageMetricsRequest = {
      startDate: '2026-05-19T00:00:00.000Z',
      endDate: '2026-05-26T00:00:00.000Z',
      provider: 'all',
      initiationSource: 'all',
    };

    await useObservabilityStore.getState().loadUsageMetrics(request);
    expect(loadUsageMetrics).toHaveBeenCalledTimes(1);

    const versionBefore = useObservabilityStore.getState().usageMetricsVersion;
    onUpdateRef.current({
      type: 'entries',
      entries: [makeEntry('success')],
    });
    expect(useObservabilityStore.getState().usageMetricsVersion).toBe(
      versionBefore + 1,
    );

    await useObservabilityStore.getState().loadUsageMetrics(request);
    expect(loadUsageMetrics).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached usage metrics on usage and retention changes', async () => {
    const loadUsageMetrics = jest
      .fn<Promise<UsageMetricsResponse>, [UsageMetricsRequest]>()
      .mockResolvedValue(emptyUsageMetricsResponse());
    const onUpdateRef = {
      current: (event: AgentObservabilityUpdateEvent): void => {
        void event;
      },
    };
    setupApi({ loadUsageMetrics, onUpdateRef });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const request: UsageMetricsRequest = {
      startDate: '2026-05-19T00:00:00.000Z',
      endDate: '2026-05-26T00:00:00.000Z',
      provider: 'all',
      initiationSource: 'all',
    };

    await useObservabilityStore.getState().loadUsageMetrics(request);
    expect(loadUsageMetrics).toHaveBeenCalledTimes(1);

    const versionBefore = useObservabilityStore.getState().usageMetricsVersion;
    onUpdateRef.current({
      type: 'usage',
      usage: {
        updatedAt: '2026-05-26T00:00:00.000Z',
        providers: [],
      },
    });
    expect(useObservabilityStore.getState().usageMetricsVersion).toBe(
      versionBefore + 1,
    );

    await useObservabilityStore.getState().loadUsageMetrics(request);
    expect(loadUsageMetrics).toHaveBeenCalledTimes(2);

    const versionBeforeRetention =
      useObservabilityStore.getState().usageMetricsVersion;
    onUpdateRef.current({
      type: 'retention',
      retentionDays: 30,
    });
    expect(useObservabilityStore.getState().usageMetricsVersion).toBe(
      versionBeforeRetention + 1,
    );

    await useObservabilityStore.getState().loadUsageMetrics(request);
    expect(loadUsageMetrics).toHaveBeenCalledTimes(3);
  });

  it('exposes an error and clears loading when loadUsageMetrics rejects', async () => {
    const failure = new Error('boom');
    const loadUsageMetrics = jest
      .fn<Promise<UsageMetricsResponse>, [UsageMetricsRequest]>()
      .mockRejectedValue(failure);
    const onUpdateRef = {
      current: (event: AgentObservabilityUpdateEvent): void => {
        void event;
      },
    };
    setupApi({ loadUsageMetrics, onUpdateRef });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    await useObservabilityStore.getState().initialize();

    const request: UsageMetricsRequest = {
      startDate: '2026-05-19T00:00:00.000Z',
      endDate: '2026-05-26T00:00:00.000Z',
      provider: 'all',
      initiationSource: 'all',
    };

    await expect(
      useObservabilityStore.getState().loadUsageMetrics(request),
    ).rejects.toThrow('boom');

    expect(useObservabilityStore.getState().loadingUsageMetrics).toBe(false);
    expect(useObservabilityStore.getState().usageMetricsError).toBe('boom');
  });
});

describe('observabilityStore initialization', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('waits for an in-flight snapshot when initialized is already true', async () => {
    let resolveSnapshot: (
      snapshot: AgentObservabilitySnapshot,
    ) => void = () => {
      throw new Error('Expected snapshot resolver to be initialized');
    };
    const loadSnapshot = jest.fn<Promise<AgentObservabilitySnapshot>, []>(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          observability: {
            loadSnapshot,
            onUpdate: (): (() => void) => (): void => undefined,
          },
        },
      },
    });

    const { useObservabilityStore } =
      await import('../stores/observabilityStore');
    const first = useObservabilityStore.getState().initialize();
    expect(useObservabilityStore.getState().initialized).toBe(true);

    let secondFinished = false;
    const second = useObservabilityStore
      .getState()
      .initialize()
      .then(() => {
        secondFinished = true;
      });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    const snapshot = makeSnapshot(makeEntry('completed'));
    resolveSnapshot(snapshot);
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
    expect(useObservabilityStore.getState().usage).toEqual(snapshot.usage);
  });
});

describe('observabilityStore refreshProviderUsageSnapshot', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('refreshes then loads the snapshot, sets store usage, and returns it', async () => {
    const refreshUsage = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const snapshotUsage = {
      updatedAt: '2026-06-05T12:00:00.000Z',
      providers: [
        {
          provider: 'claude' as const,
          authState: 'authenticated' as const,
          hasRemainingLimits: true,
        },
      ],
    };
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue({
        version: 1,
        historicalMode: 'forward-only',
        retentionDays: 7,
        recentEntries: [],
        usage: snapshotUsage,
      } as unknown as AgentObservabilitySnapshot);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          refreshUsage,
          loadSnapshot,
          onUpdate: (): (() => void) => (): void => undefined,
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    const result = await useObservabilityStore
      .getState()
      .refreshProviderUsageSnapshot('claude');

    expect(refreshUsage).toHaveBeenCalledWith('claude');
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(result).toBe(snapshotUsage);
    expect(useObservabilityStore.getState().usage).toBe(snapshotUsage);
  });

  it('refreshes account-scoped usage details with refreshProviderUsageDetails and invalidates cached usage data', async () => {
    const refreshUsage = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const snapshotUsage = {
      updatedAt: '2026-06-05T12:00:00.000Z',
      providers: [
        {
          provider: 'codex' as const,
          authState: 'authenticated' as const,
          hasRemainingLimits: true,
          accountLabel: 'new@example.com',
        },
      ],
    };
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue({
        version: 1,
        historicalMode: 'forward-only',
        retentionDays: 7,
        recentEntries: [],
        usage: snapshotUsage,
      } as unknown as AgentObservabilitySnapshot);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          refreshUsage,
          loadSnapshot,
          onUpdate: (): (() => void) => (): void => undefined,
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    useObservabilityStore.setState({
      usageTimeseriesCache: { cached: {} as never },
      usageTimeseriesVersion: 2,
      usageMetricsCache: { cached: {} as never },
      usageMetricsVersion: 3,
      usageMetricsViewCache: { cached: {} as never },
      usageMetricsViewVersion: 4,
      usageTabSummaryCache: { cached: {} as never },
      usageTabSummaryVersion: 5,
    });

    const result = await useObservabilityStore
      .getState()
      .refreshProviderUsageDetails('codex');

    expect(refreshUsage).toHaveBeenCalledWith('codex');
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(result).toBe(snapshotUsage);
    expect(useObservabilityStore.getState().usage).toBe(snapshotUsage);
    expect(useObservabilityStore.getState().usageTimeseriesCache).toEqual({});
    expect(useObservabilityStore.getState().usageMetricsCache).toEqual({});
    expect(useObservabilityStore.getState().usageMetricsViewCache).toEqual({});
    expect(useObservabilityStore.getState().usageTabSummaryCache).toEqual({});
    expect(useObservabilityStore.getState().usageTimeseriesVersion).toBe(4);
    expect(useObservabilityStore.getState().usageMetricsVersion).toBe(5);
    expect(useObservabilityStore.getState().usageMetricsViewVersion).toBe(6);
    expect(useObservabilityStore.getState().usageTabSummaryVersion).toBe(7);
  });

  it('coalesces concurrent refreshProviderUsageDetails calls for the same provider', async () => {
    let resolveRefresh: (() => void) | null = null;
    const refreshUsage = jest.fn<Promise<void>, [string]>().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const snapshotUsage = {
      updatedAt: '2026-06-05T12:00:00.000Z',
      providers: [],
    };
    const loadSnapshot = jest
      .fn<Promise<AgentObservabilitySnapshot>, []>()
      .mockResolvedValue({
        version: 1,
        historicalMode: 'forward-only',
        retentionDays: 7,
        recentEntries: [],
        usage: snapshotUsage,
      } as unknown as AgentObservabilitySnapshot);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        observability: {
          refreshUsage,
          loadSnapshot,
          onUpdate: (): (() => void) => (): void => undefined,
        },
      },
    });

    const module = await import('../stores/observabilityStore');
    const useObservabilityStore = module.useObservabilityStore;

    const firstRefresh = useObservabilityStore
      .getState()
      .refreshProviderUsageDetails('claude');
    const secondRefresh = useObservabilityStore
      .getState()
      .refreshProviderUsageDetails('claude');

    expect(
      useObservabilityStore.getState().refreshingProviders.has('claude'),
    ).toBe(true);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).not.toHaveBeenCalled();

    resolveRefresh?.();
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      snapshotUsage,
      snapshotUsage,
    ]);

    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(
      useObservabilityStore.getState().refreshingProviders.has('claude'),
    ).toBe(false);
  });
});

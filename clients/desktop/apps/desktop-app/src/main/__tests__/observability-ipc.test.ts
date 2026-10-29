const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  ),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));

const loadSnapshotMock = jest.fn();
const loadHistoryMock = jest.fn();
const loadTranscriptMock = jest.fn();
const loadUsageTimeseriesMock = jest.fn();
const loadUsageMetricsMock = jest.fn();
const loadUsageMetricsViewMock = jest.fn();
const loadUsageTabSummaryMock = jest.fn();
const subscribeMock = jest.fn();
const refreshProviderUsageMock = jest.fn<Promise<void>, [string]>();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    loadSnapshot: loadSnapshotMock,
    loadHistory: loadHistoryMock,
    loadTranscript: loadTranscriptMock,
    loadUsageTimeseries: loadUsageTimeseriesMock,
    loadUsageMetrics: loadUsageMetricsMock,
    loadUsageMetricsView: loadUsageMetricsViewMock,
    loadUsageTabSummary: loadUsageTabSummaryMock,
    subscribe: subscribeMock,
    refreshProviderUsage: refreshProviderUsageMock,
  })),
}));

const getStablePostHogAnonymousKeyMock = jest.fn<Promise<string>, []>();

const getStableAnonymousKeyMock = jest.fn<Promise<string>, []>();

jest.mock('../lib/anonymous-id', () => ({
  getStableAnonymousKey: getStableAnonymousKeyMock,
  getStablePostHogAnonymousKey: getStablePostHogAnonymousKeyMock,
}));

import {
  IPC_CHANNELS,
  type AgentAuditHistoryRequest,
  type AgentAuditHistoryResponse,
  type AgentAuditTranscriptRequest,
  type AgentAuditTranscriptResponse,
  type UsageMetricsRequest,
  type UsageMetricsResponse,
  type UsageMetricsViewRequest,
  type UsageMetricsViewResponse,
  type UsageTabSummaryRequest,
  type UsageTabSummaryResponse,
  type UsageTimeseriesRequest,
  type UsageTimeseriesResponse,
} from '@canopy/desktop-shared/types';
import { registerObservabilityHandlers } from '../ipc/observability';

interface InvalidUsageTimeseriesDateCase {
  label: string;
  request: UsageTimeseriesRequest;
  message: string;
}

const invalidUsageTimeseriesDateCases: InvalidUsageTimeseriesDateCase[] = [
  {
    label: 'invalid startDate',
    request: {
      startDate: 'not-a-date',
      endDate: '2026-03-08T00:00:00.000Z',
      bucket: 'day',
    },
    message: 'startDate must be a valid ISO 8601 timestamp',
  },
  {
    label: 'invalid endDate',
    request: {
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: 'not-a-date',
      bucket: 'day',
    },
    message: 'endDate must be a valid ISO 8601 timestamp',
  },
  {
    label: 'endDate before startDate',
    request: {
      startDate: '2026-03-08T00:00:00.000Z',
      endDate: '2026-03-01T00:00:00.000Z',
      bucket: 'day',
    },
    message: 'startDate must be before endDate',
  },
];

function invokeHistoryHandler(
  request: AgentAuditHistoryRequest,
): Promise<AgentAuditHistoryResponse> {
  const handler = registeredHandlers.get(IPC_CHANNELS.observabilityLoadHistory);

  if (handler === undefined) {
    throw new Error('Observability history handler was not registered');
  }

  let result: unknown;
  try {
    result = Reflect.apply(handler, undefined, [undefined, request]);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Handler invocation failed'),
    );
  }

  if (result instanceof Promise) {
    return result;
  }

  throw new Error('Observability history handler did not return a Promise');
}

function invokeTranscriptHandler(
  request: AgentAuditTranscriptRequest,
): Promise<AgentAuditTranscriptResponse> {
  const handler = registeredHandlers.get(
    IPC_CHANNELS.observabilityLoadTranscript,
  );

  if (handler === undefined) {
    throw new Error('Observability transcript handler was not registered');
  }

  let result: unknown;
  try {
    result = Reflect.apply(handler, undefined, [undefined, request]);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Handler invocation failed'),
    );
  }

  if (result instanceof Promise) {
    return result;
  }

  throw new Error('Observability transcript handler did not return a Promise');
}

function invokeUsageTimeseriesHandler(
  request: unknown,
): Promise<UsageTimeseriesResponse> {
  const handler = registeredHandlers.get(
    IPC_CHANNELS.observabilityLoadUsageTimeseries,
  );

  if (handler === undefined) {
    throw new Error(
      'Observability usage timeseries handler was not registered',
    );
  }

  let result: unknown;
  try {
    result = Reflect.apply(handler, undefined, [undefined, request]);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Handler invocation failed'),
    );
  }

  if (result instanceof Promise) {
    return result;
  }

  throw new Error(
    'Observability usage timeseries handler did not return a Promise',
  );
}

function invokeUsageMetricsHandler(
  request: unknown,
): Promise<UsageMetricsResponse> {
  const handler = registeredHandlers.get(
    IPC_CHANNELS.observabilityLoadUsageMetrics,
  );

  if (handler === undefined) {
    throw new Error('Observability usage metrics handler was not registered');
  }

  let result: unknown;
  try {
    result = Reflect.apply(handler, undefined, [undefined, request]);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Handler invocation failed'),
    );
  }

  if (result instanceof Promise) {
    return result;
  }

  throw new Error(
    'Observability usage metrics handler did not return a Promise',
  );
}

describe('observability IPC history handler', () => {
  it.each(['cursor', 'copilot'])(
    'refreshes %s through the shared provider usage IPC',
    async (provider) => {
      refreshProviderUsageMock.mockResolvedValue(undefined);
      const handler = registeredHandlers.get(
        IPC_CHANNELS.observabilityRefreshUsage,
      );
      if (!handler) throw new Error('Usage refresh handler was not registered');
      await handler(undefined, provider);
      expect(refreshProviderUsageMock).toHaveBeenCalledWith(provider);
      await expect(handler(undefined, 'unrecognized')).rejects.toThrow(
        'Invalid provider',
      );
      expect(refreshProviderUsageMock).toHaveBeenCalledTimes(1);
    },
  );
  const invalidTranscriptRequests: Array<{
    label: string;
    request: AgentAuditTranscriptRequest;
  }> = [
    {
      label: 'id',
      request: {
        id: '',
        eventType: 'worktree_chat',
        startedAt: '2026-03-30T12:00:00.000Z',
      },
    },
    {
      label: 'startedAt (path traversal)',
      request: {
        id: 'some-id',
        eventType: 'worktree_chat',
        startedAt: '../../etc/passwd',
      },
    },
    {
      label: 'startedAt (not ISO)',
      request: {
        id: 'some-id',
        eventType: 'worktree_chat',
        startedAt: 'not-a-date',
      },
    },
  ];

  beforeEach(() => {
    const unsubscribe = (): void => undefined;

    jest.clearAllMocks();
    registeredHandlers.clear();
    loadSnapshotMock.mockResolvedValue({
      version: 1,
      historicalMode: 'forward-only',
      retentionDays: 7,
      recentEntries: [],
      usage: {
        totalTasks: 0,
        activeTasks: 0,
        byProvider: [],
        updatedAt: '2026-03-26T00:00:00.000Z',
        providers: [],
      },
    });
    loadHistoryMock.mockResolvedValue({
      entries: [],
    });
    loadTranscriptMock.mockResolvedValue({
      type: 'not_available',
    });
    loadUsageTimeseriesMock.mockResolvedValue({ buckets: [] });
    loadUsageMetricsMock.mockResolvedValue({
      updatedAt: '2026-03-26T00:00:00.000Z',
      retentionDays: 7,
      worktrees: {
        created: { total: 0, rows: [] },
        merged: { total: 0, rows: [] },
        deletedWithChanges: { total: 0, rows: [] },
        deletedWithoutChanges: { total: 0, rows: [] },
        deletionAgeMs: { total: 0, rows: [] },
      },
      chats: {
        turnCountsPerChat: { total: 0, rows: [] },
        turnCountsPerWorktree: { total: 0, rows: [] },
        turnDurationMs: { total: 0, rows: [] },
        toolCallsPerTurn: { total: 0, rows: [] },
        toolCallsPerChat: { total: 0, rows: [] },
        toolCallsPerWorktree: { total: 0, rows: [] },
        statusCounts: [],
      },
      plans: {
        created: { total: 0, rows: [] },
        updated: { total: 0, rows: [] },
        approved: { total: 0, rows: [] },
        createdPerWorktree: { total: 0, rows: [] },
        updatedPerWorktree: { total: 0, rows: [] },
        approvedPerWorktree: { total: 0, rows: [] },
      },
      tools: {
        byCategory: [],
        byProvider: { total: 0, rows: [] },
        byInitiationSource: { total: 0, rows: [] },
      },
    });
    loadUsageMetricsViewMock.mockResolvedValue({ rows: [] });
    loadUsageTabSummaryMock.mockResolvedValue({ stats: [] });
    subscribeMock.mockImplementation((): (() => void) => unsubscribe);
    getStableAnonymousKeyMock.mockResolvedValue(
      '11111111-2222-4333-8444-555555555555',
    );
    registerObservabilityHandlers(() => null);
  });

  it('returns the stable anonymous telemetry id', async (): Promise<void> => {
    const handler = registeredHandlers.get(
      IPC_CHANNELS.observabilityGetAnonymousTelemetryId,
    );
    if (handler === undefined) {
      throw new Error('Anonymous telemetry id handler was not registered');
    }

    await expect(Reflect.apply(handler, undefined, [undefined])).resolves.toBe(
      '11111111-2222-4333-8444-555555555555',
    );
    expect(getStableAnonymousKeyMock).toHaveBeenCalledTimes(1);
  });

  it('forwards valid optional IDs to the history service', async (): Promise<void> => {
    const request: AgentAuditHistoryRequest = {
      projectId: 'proj-1',
      worktreeId: 'worktree-1',
      pipelineExecutionId: 'pipeline-1',
    };

    await invokeHistoryHandler(request);

    expect(loadHistoryMock).toHaveBeenCalledWith(request);
  });

  it.each([
    {
      label: 'projectId',
      request: { projectId: 'Project-1' },
    },
    {
      label: 'worktreeId',
      request: { worktreeId: 'Worktree-1' },
    },
    {
      label: 'pipelineExecutionId',
      request: { pipelineExecutionId: 'Pipeline-1' },
    },
  ])(
    'rejects an invalid $label before loading history',
    async ({
      request,
    }: {
      label: string;
      request: AgentAuditHistoryRequest;
    }): Promise<void> => {
      await expect(invokeHistoryHandler(request)).rejects.toThrow(
        'must be lowercase alphanumeric with hyphens',
      );
      expect(loadHistoryMock).not.toHaveBeenCalled();
    },
  );

  it('loads transcripts by immutable chat entry identity', async (): Promise<void> => {
    const request: AgentAuditTranscriptRequest = {
      id: 'chat:proj-1/worktree-1/chat-1:2026-03-30T12:00:00.000Z',
      eventType: 'worktree_chat',
      startedAt: '2026-03-30T12:00:00.000Z',
    };

    await invokeTranscriptHandler(request);

    expect(loadTranscriptMock).toHaveBeenCalledWith(request);
  });

  it.each(invalidTranscriptRequests)(
    'rejects transcript requests with invalid $label at the IPC boundary',
    async ({
      request,
    }: {
      label: string;
      request: AgentAuditTranscriptRequest;
    }): Promise<void> => {
      await expect(invokeTranscriptHandler(request)).resolves.toEqual({
        type: 'not_available',
      });
      expect(loadTranscriptMock).not.toHaveBeenCalled();
    },
  );

  it('forwards valid usage timeseries requests to the service', async (): Promise<void> => {
    const request: UsageTimeseriesRequest = {
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-08T00:00:00.000Z',
      bucket: 'day',
    };

    await invokeUsageTimeseriesHandler(request);

    expect(loadUsageTimeseriesMock).toHaveBeenCalledWith(request);
  });

  it.each([
    {
      label: 'missing startDate',
      request: {
        endDate: '2026-03-08T00:00:00.000Z',
        bucket: 'day',
      },
    },
    {
      label: 'missing endDate',
      request: {
        startDate: '2026-03-01T00:00:00.000Z',
        bucket: 'day',
      },
    },
  ])(
    'rejects usage timeseries requests with $label at the IPC boundary',
    async ({ request }: { label: string; request: unknown }): Promise<void> => {
      await expect(invokeUsageTimeseriesHandler(request)).rejects.toThrow(
        'startDate and endDate must be ISO 8601 strings',
      );
      expect(loadUsageTimeseriesMock).not.toHaveBeenCalled();
    },
  );

  it.each(invalidUsageTimeseriesDateCases)(
    'rejects usage timeseries requests with $label at the IPC boundary',
    async ({
      request,
      message,
    }: InvalidUsageTimeseriesDateCase): Promise<void> => {
      await expect(invokeUsageTimeseriesHandler(request)).rejects.toThrow(
        message,
      );
      expect(loadUsageTimeseriesMock).not.toHaveBeenCalled();
    },
  );

  it('rejects usage timeseries requests with invalid bucket at the IPC boundary', async (): Promise<void> => {
    const request = {
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-08T00:00:00.000Z',
      bucket: 'minute',
    };

    await expect(invokeUsageTimeseriesHandler(request)).rejects.toThrow(
      'Invalid bucket',
    );
    expect(loadUsageTimeseriesMock).not.toHaveBeenCalled();
  });

  it.each(['pipeline', 'cursor'] as const)(
    'forwards valid %s usage metrics requests to the service',
    async (provider): Promise<void> => {
      const request: UsageMetricsRequest = {
        startDate: '2026-03-01T00:00:00.000Z',
        endDate: '2026-03-08T00:00:00.000Z',
        workspaceId: 'workspace-1',
        repoId: '__single_repo__',
        provider,
        initiationSource: 'hook',
      };

      await invokeUsageMetricsHandler(request);

      expect(loadUsageMetricsMock).toHaveBeenCalledWith(request);
    },
  );

  it('rejects usage metrics requests with invalid dates or filters', async (): Promise<void> => {
    await expect(
      invokeUsageMetricsHandler({
        startDate: '2026-03-08T00:00:00.000Z',
        endDate: '2026-03-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('startDate must be before endDate');
    await expect(
      invokeUsageMetricsHandler({
        startDate: '2026-03-01T00:00:00.000Z',
        endDate: '2026-03-08T00:00:00.000Z',
        provider: 'bad-provider',
      }),
    ).rejects.toThrow('Invalid provider');
    await expect(
      invokeUsageMetricsHandler({
        startDate: '2026-03-01T00:00:00.000Z',
        endDate: '2026-03-08T00:00:00.000Z',
        initiationSource: 'bad-source',
      }),
    ).rejects.toThrow('Invalid initiationSource');
    expect(loadUsageMetricsMock).not.toHaveBeenCalled();
  });
});

function invokeUsageTabSummaryHandler(
  request: unknown,
): Promise<UsageTabSummaryResponse> {
  const handler = registeredHandlers.get(
    IPC_CHANNELS.observabilityLoadUsageTabSummary,
  );

  if (handler === undefined) {
    throw new Error(
      'Observability usage tab summary handler was not registered',
    );
  }

  let result: unknown;
  try {
    result = Reflect.apply(handler, undefined, [undefined, request]);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Handler invocation failed'),
    );
  }

  if (result instanceof Promise) {
    return result;
  }

  throw new Error(
    'Observability usage tab summary handler did not return a Promise',
  );
}

function invokeUsageMetricsViewHandler(
  request: unknown,
): Promise<UsageMetricsViewResponse> {
  const handler = registeredHandlers.get(
    IPC_CHANNELS.observabilityLoadUsageMetricsView,
  );

  if (handler === undefined) {
    throw new Error(
      'Observability usage metrics view handler was not registered',
    );
  }

  let result: unknown;
  try {
    result = Reflect.apply(handler, undefined, [undefined, request]);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Handler invocation failed'),
    );
  }

  if (result instanceof Promise) {
    return result;
  }

  throw new Error(
    'Observability usage metrics view handler did not return a Promise',
  );
}

describe('observabilityLoadUsageTabSummary IPC', () => {
  it('rejects unknown tab', async (): Promise<void> => {
    await expect(
      invokeUsageTabSummaryHandler({ tab: 'bogus' }),
    ).rejects.toThrow('Invalid tab');
    expect(loadUsageTabSummaryMock).not.toHaveBeenCalled();
  });

  it.each<{ tab: UsageTabSummaryRequest['tab'] }>([
    { tab: 'worktrees' },
    { tab: 'chats' },
    { tab: 'plans' },
    { tab: 'tools' },
    { tab: 'pipelines' },
  ])(
    'delegates to service.loadUsageTabSummary for tab=$tab',
    async ({ tab }: { tab: UsageTabSummaryRequest['tab'] }): Promise<void> => {
      const request: UsageTabSummaryRequest = { tab };

      await invokeUsageTabSummaryHandler(request);

      expect(loadUsageTabSummaryMock).toHaveBeenCalledWith(request);
    },
  );
});

describe('observabilityLoadUsageMetricsView IPC', () => {
  it('rejects unknown tab', async (): Promise<void> => {
    await expect(
      invokeUsageMetricsViewHandler({
        tab: 'bogus',
        metric: 'created',
        groupBy: 'workspace',
        window: { kind: 'last7d' },
      }),
    ).rejects.toThrow('Invalid tab');
    expect(loadUsageMetricsViewMock).not.toHaveBeenCalled();
  });

  it('rejects missing metric', async (): Promise<void> => {
    await expect(
      invokeUsageMetricsViewHandler({
        tab: 'worktrees',
        metric: 42,
        groupBy: 'workspace',
        window: { kind: 'last7d' },
      }),
    ).rejects.toThrow('metric must be a string');
    expect(loadUsageMetricsViewMock).not.toHaveBeenCalled();
  });

  it('rejects missing groupBy', async (): Promise<void> => {
    await expect(
      invokeUsageMetricsViewHandler({
        tab: 'worktrees',
        metric: 'created',
        groupBy: 99,
        window: { kind: 'last7d' },
      }),
    ).rejects.toThrow('groupBy must be a string');
    expect(loadUsageMetricsViewMock).not.toHaveBeenCalled();
  });

  it('rejects unknown window kind', async (): Promise<void> => {
    await expect(
      invokeUsageMetricsViewHandler({
        tab: 'worktrees',
        metric: 'created',
        groupBy: 'workspace',
        window: { kind: 'yesterday' },
      }),
    ).rejects.toThrow('window has unknown kind');
    expect(loadUsageMetricsViewMock).not.toHaveBeenCalled();
  });

  it('rejects custom window with bad dates', async (): Promise<void> => {
    await expect(
      invokeUsageMetricsViewHandler({
        tab: 'worktrees',
        metric: 'created',
        groupBy: 'workspace',
        window: { kind: 'custom', start: 'not-a-date', end: 'also-not' },
      }),
    ).rejects.toThrow('window.start must be a valid ISO 8601 timestamp');
    expect(loadUsageMetricsViewMock).not.toHaveBeenCalled();
  });

  it('delegates to service.loadUsageMetricsView with a last7d window', async (): Promise<void> => {
    const request: UsageMetricsViewRequest = {
      tab: 'worktrees',
      metric: 'created',
      groupBy: 'workspace',
      window: { kind: 'last7d' },
    };

    await invokeUsageMetricsViewHandler(request);

    expect(loadUsageMetricsViewMock).toHaveBeenCalledWith(request);
  });

  it('accepts a pipelines tab metrics-view request', async (): Promise<void> => {
    const request: UsageMetricsViewRequest = {
      tab: 'pipelines',
      metric: 'pipeline_runs_completed',
      groupBy: 'pipeline',
      window: { kind: 'last7d' },
    };

    await invokeUsageMetricsViewHandler(request);

    expect(loadUsageMetricsViewMock).toHaveBeenCalledWith(request);
  });
});

test('exposes the separate PostHog identity through observability IPC', async () => {
  registerObservabilityHandlers(() => null);
  getStablePostHogAnonymousKeyMock.mockResolvedValue(
    '22222222-2222-4222-8222-222222222222',
  );
  const handler = registeredHandlers.get(
    IPC_CHANNELS.observabilityGetPostHogAnonymousId,
  );
  expect(handler).toBeDefined();
  await expect(handler?.()).resolves.toBe(
    '22222222-2222-4222-8222-222222222222',
  );
  expect(getStablePostHogAnonymousKeyMock).toHaveBeenCalledTimes(1);
});

test('exposes the domain-only instrumentation projection through observability IPC', async () => {
  const instrumentation =
    await import('@canopy/desktop-instrumentation/electron/main');
  const getDomain = jest
    .spyOn(instrumentation, 'getDesktopPostHogEmailDomain')
    .mockResolvedValue('example.test');
  try {
    registerObservabilityHandlers();
    const handler = registeredHandlers.get(
      IPC_CHANNELS.observabilityGetPostHogEmailDomain,
    );
    await expect(handler?.({})).resolves.toBe('example.test');
    expect(getDomain).toHaveBeenCalledTimes(1);
  } finally {
    getDomain.mockRestore();
  }
});

test('broadcasts an adopted PostHog session to every window and ignores competing stale proposals', async () => {
  const { getDesktopPostHogSession } =
    await import('@canopy/desktop-instrumentation/electron/main');
  const { sendToAllWindows } = await import('../lib/window-send');
  registerObservabilityHandlers(() => null);
  const report = registeredHandlers.get(
    IPC_CHANNELS.observabilityReportPostHogSessionRotation,
  );
  const initial = getDesktopPostHogSession();
  const sessionId = `${Date.now()
    .toString(16)
    .padStart(12, '0')
    .replace(/(.{8})/, '$1-')}-7111-8111-111111111111`;
  const adopted = report?.({}, { sessionId, revision: initial.revision });
  expect(adopted).toEqual({ sessionId, revision: initial.revision + 1 });
  expect(sendToAllWindows).toHaveBeenCalledWith(
    IPC_CHANNELS.observabilityPostHogSessionUpdate,
    adopted,
  );
  expect(report?.({}, initial)).toEqual(adopted);
  expect(sendToAllWindows).toHaveBeenCalledTimes(1);
  expect(() => report?.({}, { sessionId: 'invalid', revision: 1 })).toThrow(
    'Invalid PostHog session proposal',
  );
});

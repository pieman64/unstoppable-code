import {
  CORE_OBSERVABILITY_QUERIES,
  CORE_OBSERVABILITY_STREAMS,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
  type ObservabilityAuditEventsItem,
  type ObservabilityAuditOverview,
  type ObservabilityUsageQueryResult,
} from '@canopy/protocol/canopy-core';
import type {
  AgentAuditEntry,
  AgentAuditHistoryRequest,
  AgentAuditHistoryResponse,
  AgentAuditTranscriptResponse,
  AgentObservabilityUpdateEvent,
  UsageMetricsResponse,
  UsageMetricsViewResponse,
  UsageTabSummaryResponse,
  UsageTimeseriesResponse,
} from '@canopy/protocol/observability';

import { createCanopyDispatcher } from '../../runtime/dispatcher';
import type { CanopyDispatcher, CanopyStreamFrame } from '../../runtime/types';
import { defaultTokens, defaultToolCounts } from '../audit-records';
import {
  createCoreObservabilityHandlers,
  type ObservabilityReadModel,
} from '../handlers';

function entry(
  id: string,
  overrides: Partial<AgentAuditEntry> = {},
): AgentAuditEntry {
  return {
    id,
    eventType: 'worktree_chat',
    status: 'running',
    provider: 'claude',
    label: id,
    startedAt: '2026-11-02T09:00:00.000Z',
    tokens: defaultTokens(),
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: defaultToolCounts(),
    hasTranscript: false,
    ...overrides,
  };
}

const EMPTY_ROWS = { total: 0, rows: [] };
const METRICS: UsageMetricsResponse = {
  updatedAt: '2026-11-02T09:00:00.000Z',
  retentionDays: 30,
  worktrees: {
    created: EMPTY_ROWS,
    merged: EMPTY_ROWS,
    deletedWithChanges: EMPTY_ROWS,
    deletedWithoutChanges: EMPTY_ROWS,
    deletionAgeMs: EMPTY_ROWS,
  },
  chats: {
    turnCountsPerChat: { total: 2, rows: [] },
    turnCountsPerWorktree: EMPTY_ROWS,
    turnDurationMs: EMPTY_ROWS,
    toolCallsPerTurn: EMPTY_ROWS,
    toolCallsPerChat: EMPTY_ROWS,
    toolCallsPerWorktree: EMPTY_ROWS,
    statusCounts: [{ status: 'success', count: 2 }],
  },
  plans: {
    created: EMPTY_ROWS,
    updated: EMPTY_ROWS,
    approved: EMPTY_ROWS,
    createdPerWorktree: EMPTY_ROWS,
    updatedPerWorktree: EMPTY_ROWS,
    approvedPerWorktree: EMPTY_ROWS,
  },
  tools: {
    byCategory: [],
    byProvider: EMPTY_ROWS,
    byInitiationSource: EMPTY_ROWS,
  },
};

/** One ingest host's stores: entries keyed by id and its update events. */
class FakeIngest implements ObservabilityReadModel {
  readonly entries = new Map<string, AgentAuditEntry>();
  private readonly listeners = new Set<
    (event: AgentObservabilityUpdateEvent) => void
  >();
  retentionDays = 30;
  usageReads = 0;

  upsert(next: AgentAuditEntry): void {
    this.entries.set(next.id, next);
    // Hosts may publish fields the wire record does not declare.
    const published = { ...next, hostOnly: '/Users/me/project' };
    this.emit({ type: 'entries', entries: [published] });
  }

  purge(id: string): void {
    this.entries.delete(id);
    this.emit({
      type: 'snapshot',
      snapshot: {
        ...this.loadAuditOverview(),
        usage: { updatedAt: '', providers: [] },
      },
    });
  }

  emit(event: AgentObservabilityUpdateEvent): void {
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  loadAuditOverview(): ObservabilityAuditOverview {
    return {
      version: 1,
      historicalMode: 'forward-only',
      retentionDays: this.retentionDays,
      recentEntries: Array.from(this.entries.values()),
    };
  }

  loadHistory(
    request: AgentAuditHistoryRequest,
  ): Promise<AgentAuditHistoryResponse> {
    return Promise.resolve({
      entries: Array.from(this.entries.values()).filter(
        (candidate) =>
          request.status === undefined ||
          request.status === 'all' ||
          candidate.status === request.status,
      ),
    });
  }

  loadTranscript(): Promise<AgentAuditTranscriptResponse> {
    return Promise.resolve({ type: 'not_available' });
  }

  loadUsageTimeseries(): Promise<UsageTimeseriesResponse> {
    return Promise.resolve({ kind: 'tokens', buckets: [] });
  }

  loadUsageMetrics(): Promise<UsageMetricsResponse> {
    this.usageReads += 1;
    return Promise.resolve(METRICS);
  }

  loadUsageMetricsView(): Promise<UsageMetricsViewResponse> {
    return Promise.reject(new Error('view failed'));
  }

  loadUsageTabSummary(): Promise<UsageTabSummaryResponse> {
    return Promise.reject(new Error('unused'));
  }

  getRetentionDays(): number {
    return this.retentionDays;
  }

  subscribe(listener: (event: AgentObservabilityUpdateEvent) => void) {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
}

function client(
  id: string,
  grants: CanopyCallerDescriptor['grants'] = ['core.observability.read'],
): CanopyCallerDescriptor {
  return {
    principalId: `user-${id}`,
    clientInstanceId: id,
    authorityId: 'local-desktop',
    interfaceKind: 'test',
    grants,
  };
}

type ObservabilityDispatcher = CanopyDispatcher<
  typeof CORE_OBSERVABILITY_QUERIES,
  Record<never, never>,
  typeof CORE_OBSERVABILITY_STREAMS
>;

function dispatcherFor(
  ingest: FakeIngest,
  journalCapacity?: number,
): ObservabilityDispatcher {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_OBSERVABILITY_QUERIES,
      instructions: {},
      streams: CORE_OBSERVABILITY_STREAMS,
    },
    handlers: {
      ...createCoreObservabilityHandlers(ingest, {
        epoch: 'epoch-1',
        journalCapacity,
      }),
      instructions: {},
    },
  });
}

type Frame = CanopyStreamFrame<ObservabilityAuditEventsItem, object>;

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

async function open(
  dispatcher: ObservabilityDispatcher,
  id: string,
  cursor?: CanopyStreamCursor,
): Promise<{ frames: Frame[]; close: () => void }> {
  const frames: Frame[] = [];
  const stream = await dispatcher.openStream(
    'core.observability.audit.events',
    cursor ? { cursor } : {},
    { caller: client(id), onFrame: (frame) => frames.push(frame) },
  );
  await flush();
  return { frames, close: () => stream.close() };
}

function items(frames: Frame[]): ObservabilityAuditEventsItem[] {
  return frames.flatMap((frame) => (frame.kind === 'item' ? [frame.item] : []));
}

function lastCursor(frames: Frame[]): CanopyStreamCursor {
  const cursor = frames.at(-1)?.cursor;
  if (!cursor) throw new Error('no frame');
  return cursor;
}

it('refuses a caller without the read grant before reading', async () => {
  const ingest = new FakeIngest();
  const dispatcher = dispatcherFor(ingest);
  await expect(
    dispatcher.query(
      'core.observability.usage.query',
      {
        kind: 'metrics',
        request: {
          startDate: '2026-11-01T00:00:00Z',
          endDate: '2026-11-02T00:00:00Z',
        },
      },
      { caller: client('a', []) },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  expect(ingest.usageReads).toBe(0);
});

it('serves two clients the same filtered audit and usage results', async () => {
  const ingest = new FakeIngest();
  ingest.upsert(entry('done', { status: 'success' }));
  ingest.upsert(entry('live'));
  const dispatcher = dispatcherFor(ingest);
  const read = (
    id: string,
  ): Promise<[AgentAuditHistoryResponse, ObservabilityUsageQueryResult]> =>
    Promise.all([
      dispatcher.query(
        'core.observability.audit.list',
        { status: 'success' },
        { caller: client(id) },
      ),
      dispatcher.query(
        'core.observability.usage.query',
        {
          kind: 'metrics',
          request: {
            startDate: '2026-11-01T00:00:00Z',
            endDate: '2026-11-02T00:00:00Z',
          },
        },
        { caller: client(id) },
      ),
    ]);

  const [a, b] = await Promise.all([read('a'), read('b')]);
  expect(a).toEqual(b);
  expect(a[0].entries.map((candidate) => candidate.id)).toEqual(['done']);
  expect(a[1]).toEqual({ kind: 'metrics', result: METRICS });
});

it('strips host-only fields from served entries', async () => {
  const ingest = new FakeIngest();
  const dispatcher = dispatcherFor(ingest);
  const { frames, close } = await open(dispatcher, 'a');
  ingest.upsert(entry('turn'));
  await flush();
  expect(items(frames)[1]).toEqual({
    kind: 'entries',
    entries: [entry('turn')],
  });
  close();
});

it('replays a terminal state missed while a client was disconnected', async () => {
  const ingest = new FakeIngest();
  ingest.upsert(entry('older', { status: 'success' }));
  const dispatcher = dispatcherFor(ingest);
  const first = await open(dispatcher, 'a');
  ingest.upsert(entry('turn'));
  await flush();
  const cursor = lastCursor(first.frames);
  first.close();

  ingest.upsert(
    entry('turn', {
      status: 'success',
      completedAt: '2026-11-02T09:01:00.000Z',
    }),
  );
  const other = await open(dispatcher, 'b');
  const resumed = await open(dispatcher, 'a', cursor);

  // Only the change since the cursor, in its terminal state.
  expect(items(resumed.frames)).toEqual([
    {
      kind: 'entries',
      entries: [
        entry('turn', {
          status: 'success',
          completedAt: '2026-11-02T09:01:00.000Z',
        }),
      ],
    },
  ]);
  // Both clients see later changes at the same cursor.
  ingest.upsert(entry('next'));
  await flush();
  expect(resumed.frames.at(-1)).toEqual(other.frames.at(-1));
  resumed.close();
  other.close();
});

it('resumes from a fresh overview when the cursor predates a purge', async () => {
  const ingest = new FakeIngest();
  const dispatcher = dispatcherFor(ingest);
  ingest.upsert(entry('gone'));
  const first = await open(dispatcher, 'a');
  const cursor = lastCursor(first.frames);
  first.close();

  ingest.purge('gone');
  ingest.upsert(entry('kept', { status: 'success' }));
  const resumed = await open(dispatcher, 'a', cursor);
  expect(items(resumed.frames)).toEqual([
    {
      kind: 'overview',
      overview: {
        version: 1,
        historicalMode: 'forward-only',
        retentionDays: 30,
        recentEntries: [entry('kept', { status: 'success' })],
      },
    },
  ]);
  resumed.close();
});

it('resumes from a fresh overview once the cursor is older than the journal', async () => {
  const ingest = new FakeIngest();
  const dispatcher = dispatcherFor(ingest, 1);
  const first = await open(dispatcher, 'a');
  const cursor = lastCursor(first.frames);
  first.close();

  ingest.upsert(entry('one', { status: 'failure' }));
  ingest.upsert(entry('two', { status: 'success' }));
  const resumed = await open(dispatcher, 'a', cursor);
  expect(items(resumed.frames).map((item) => item.kind)).toEqual(['overview']);
  resumed.close();
});

it('refuses a cursor from another journal epoch', async () => {
  const dispatcher = dispatcherFor(new FakeIngest());
  const resumed = await open(dispatcher, 'a', {
    daemonEpoch: 'epoch-0',
    sequence: 3,
  });
  const [end] = resumed.frames;
  expect(resumed.frames).toHaveLength(1);
  expect(end?.kind).toBe('end');
  expect(end?.kind === 'end' ? end.error : null).toMatchObject({
    kind: 'failed_precondition',
    code: 'core.observability.snapshotRequired',
  });
});

it('journals retention but not provider usage', async () => {
  const ingest = new FakeIngest();
  const dispatcher = dispatcherFor(ingest);
  const { frames, close } = await open(dispatcher, 'a');
  ingest.emit({ type: 'usage', usage: { updatedAt: '', providers: [] } });
  ingest.emit({ type: 'retention', retentionDays: 7 });
  await flush();
  expect(items(frames).slice(1)).toEqual([
    { kind: 'retention', retentionDays: 7 },
  ]);
  close();
});

it('reports a failed read as an internal error that keeps its cause', async () => {
  const dispatcher = dispatcherFor(new FakeIngest());
  const failure = dispatcher.query(
    'core.observability.usage.query',
    {
      kind: 'view',
      request: {
        tab: 'chats',
        metric: 'chat_turns',
        groupBy: 'chat',
        window: { kind: 'last7d' },
      },
    },
    { caller: client('a') },
  );
  await expect(failure).rejects.toMatchObject({
    payload: { kind: 'internal' },
    runtimeCause: new Error('view failed'),
  });
});

import {
  type CANOPY_STREAM_DEFINITIONS,
  type CanopyQueryHandlerMap,
  type CanopyStreamCursor,
  type ObservabilityAuditEventsItem,
  type ObservabilityAuditOverview,
  type ObservabilitySummaryGetResult,
  type ObservabilityUsageQueryResult,
} from '@canopy/protocol/canopy-core';
import type {
  AgentAuditHistoryRequest,
  AgentAuditHistoryResponse,
  AgentAuditTranscriptRequest,
  AgentAuditTranscriptResponse,
  AgentObservabilityUpdateEvent,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageMetricsViewRequest,
  UsageMetricsViewResponse,
  UsageTabSummaryRequest,
  UsageTabSummaryResponse,
  UsageTimeseriesRequest,
  UsageTimeseriesResponse,
} from '@canopy/protocol/observability';

import { CanopyOperationError } from '../runtime/errors';
import type {
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
} from '../runtime/types';
import {
  AuditEventJournal,
  type AuditJournalItem,
} from './audit-event-journal';

/**
 * The read side of one ingest host's audit and usage stores. The host that
 * writes them serves the reads, so every client reads the same records and
 * the same aggregation; nothing is copied or recounted here.
 */
export interface ObservabilityReadModel {
  loadAuditOverview(): ObservabilityAuditOverview;
  loadHistory(
    request: AgentAuditHistoryRequest,
  ): Promise<AgentAuditHistoryResponse>;
  loadTranscript(
    request: AgentAuditTranscriptRequest,
  ): Promise<AgentAuditTranscriptResponse>;
  loadUsageTimeseries(
    request: UsageTimeseriesRequest,
  ): Promise<UsageTimeseriesResponse>;
  loadUsageMetrics(request: UsageMetricsRequest): Promise<UsageMetricsResponse>;
  loadUsageMetricsView(
    request: UsageMetricsViewRequest,
  ): Promise<UsageMetricsViewResponse>;
  loadUsageTabSummary(
    request: UsageTabSummaryRequest,
  ): Promise<UsageTabSummaryResponse>;
  getRetentionDays(): number;
  subscribe(
    listener: (event: AgentObservabilityUpdateEvent) => void,
  ): () => void;
}

type ObservabilityQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  | 'core.observability.audit.list'
  | 'core.observability.audit.transcript.get'
  | 'core.observability.usage.query'
  | 'core.observability.summary.get'
>;
type ObservabilityStreamHandlers = Pick<
  CanopyDispatcherStreamHandlerMap<typeof CANOPY_STREAM_DEFINITIONS>,
  'core.observability.audit.events'
>;

export interface CoreObservabilityHandlers {
  queries: ObservabilityQueryHandlers;
  streams: ObservabilityStreamHandlers;
}

export interface CoreObservabilityHandlerOptions {
  /** Names this host's audit journal; defaults to a random epoch. */
  readonly epoch?: string;
  readonly journalCapacity?: number;
}

function snapshotRequired(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'core.observability.snapshotRequired',
    message:
      'The audit cursor belongs to another stream. Reopen the stream without a cursor.',
    retry: {
      kind: 'after_refresh',
      resource: 'core.observability.audit.events',
    },
  });
}

async function usageQuery(
  model: ObservabilityReadModel,
  params: Parameters<
    ObservabilityQueryHandlers['core.observability.usage.query']
  >[0],
): Promise<ObservabilityUsageQueryResult> {
  switch (params.kind) {
    case 'timeseries':
      return {
        kind: 'timeseries',
        result: await model.loadUsageTimeseries(params.request),
      };
    case 'metrics':
      return {
        kind: 'metrics',
        result: await model.loadUsageMetrics(params.request),
      };
    case 'view':
      return {
        kind: 'view',
        result: await model.loadUsageMetricsView(params.request),
      };
  }
}

async function summaryGet(
  model: ObservabilityReadModel,
  params: Parameters<
    ObservabilityQueryHandlers['core.observability.summary.get']
  >[0],
): Promise<ObservabilitySummaryGetResult> {
  if (params.kind === 'overview') {
    return { kind: 'overview', overview: model.loadAuditOverview() };
  }
  return {
    kind: 'tab',
    result: await model.loadUsageTabSummary(params.request),
  };
}

/**
 * `core.observability.*` over one ingest host's stores (CAN-4137). Reads go
 * to the host's read model. The audit events stream opens with the overview
 * and then sends each audit change the host publishes; a client that
 * reconnects with its last cursor gets every entry that changed meanwhile in
 * its latest state, so terminal states are never lost to a disconnect.
 */
export function createCoreObservabilityHandlers(
  model: ObservabilityReadModel,
  options: CoreObservabilityHandlerOptions = {},
): CoreObservabilityHandlers {
  let journal: AuditEventJournal | null = null;
  const auditJournal = (): AuditEventJournal => {
    journal ??= new AuditEventJournal(
      {
        retentionDays: (): number => model.getRetentionDays(),
        subscribe: (listener): (() => void) => model.subscribe(listener),
      },
      {
        epoch: options.epoch ?? crypto.randomUUID(),
        capacity: options.journalCapacity,
      },
    );
    return journal;
  };

  return {
    queries: {
      'core.observability.audit.list': (params) => model.loadHistory(params),
      'core.observability.audit.transcript.get': (params) =>
        model.loadTranscript(params),
      'core.observability.usage.query': (params) => usageQuery(model, params),
      'core.observability.summary.get': (params) => summaryGet(model, params),
    },
    streams: {
      'core.observability.audit.events': (
        params,
        _context,
        sink,
      ): Promise<(() => void) | void> => {
        const source = auditJournal();
        const cursorAt = (sequence: number): CanopyStreamCursor => ({
          daemonEpoch: source.epoch,
          sequence,
        });
        const itemOf = (
          item: AuditJournalItem,
        ): ObservabilityAuditEventsItem => {
          switch (item.kind) {
            case 'entries':
              return { kind: 'entries', entries: item.entries };
            case 'retention':
              return { kind: 'retention', retentionDays: item.retentionDays };
            case 'overview':
              return { kind: 'overview', overview: model.loadAuditOverview() };
          }
        };
        const emit = (item: AuditJournalItem): boolean =>
          sink.emitAt(cursorAt(item.sequence), itemOf(item)) !== null;

        const cursor = params.cursor ?? null;
        if (cursor === null) {
          if (!emit({ sequence: source.currentSequence, kind: 'overview' }))
            return Promise.resolve();
        } else {
          const replay = source.replaySince({
            epoch: cursor.daemonEpoch,
            sequence: cursor.sequence,
          });
          if (replay.kind === 'foreign')
            return Promise.reject(snapshotRequired());
          const items: AuditJournalItem[] =
            replay.kind === 'overview'
              ? [{ sequence: replay.sequence, kind: 'overview' }]
              : replay.items;
          for (const item of items) if (!emit(item)) return Promise.resolve();
        }

        let stop = (): void => undefined;
        // The sink refuses items once the stream has ended, including when a
        // slow client overflows its buffer.
        stop = source.listen((item) => {
          if (!emit(item)) stop();
        });
        return Promise.resolve(() => stop());
      },
    },
  };
}

import { z } from 'zod';

import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import { inherentOperationErrorSchema } from '../shared';
import {
  ObservabilityAuditEntrySchema,
  ObservabilityAuditHistoryRequestSchema,
  ObservabilityAuditHistoryResponseSchema,
  ObservabilityAuditTranscriptRequestSchema,
  ObservabilityAuditTranscriptResponseSchema,
  ObservabilityUsageMetricsRequestSchema,
  ObservabilityUsageMetricsResponseSchema,
  ObservabilityUsageMetricsViewRequestSchema,
  ObservabilityUsageMetricsViewResponseSchema,
  ObservabilityUsageTabSummaryRequestSchema,
  ObservabilityUsageTabSummaryResponseSchema,
  ObservabilityUsageTimeseriesRequestSchema,
  ObservabilityUsageTimeseriesResponseSchema,
} from './records';

export const CORE_OBSERVABILITY_GRANTS = {
  read: 'core.observability.read',
} as const;

const retentionDays = z.number().int().min(0);

export const ObservabilityAuditListParamsSchema =
  ObservabilityAuditHistoryRequestSchema;
export const ObservabilityAuditListResultSchema =
  ObservabilityAuditHistoryResponseSchema;

export const ObservabilityAuditTranscriptGetParamsSchema =
  ObservabilityAuditTranscriptRequestSchema;
export const ObservabilityAuditTranscriptGetResultSchema =
  ObservabilityAuditTranscriptResponseSchema;

/** One usage read: token or tab time series, metrics, or one metric view. */
export const ObservabilityUsageQueryParamsSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('timeseries'),
      request: ObservabilityUsageTimeseriesRequestSchema,
    }),
    z.strictObject({
      kind: z.literal('metrics'),
      request: ObservabilityUsageMetricsRequestSchema,
    }),
    z.strictObject({
      kind: z.literal('view'),
      request: ObservabilityUsageMetricsViewRequestSchema,
    }),
  ],
);
export const ObservabilityUsageQueryResultSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('timeseries'),
      result: ObservabilityUsageTimeseriesResponseSchema,
    }),
    z.object({
      kind: z.literal('metrics'),
      result: ObservabilityUsageMetricsResponseSchema,
    }),
    z.object({
      kind: z.literal('view'),
      result: ObservabilityUsageMetricsViewResponseSchema,
    }),
  ],
);

/**
 * The audit overview (retention and the recent entries, newest first) or one
 * usage tab's summary cards. Provider account usage is not part of it.
 */
export const ObservabilitySummaryGetParamsSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('overview') }),
    z.strictObject({
      kind: z.literal('tab'),
      request: ObservabilityUsageTabSummaryRequestSchema,
    }),
  ],
);
export const ObservabilityAuditOverviewSchema = z.object({
  version: z.literal(1),
  historicalMode: z.literal('forward-only'),
  retentionDays,
  recentEntries: z.array(ObservabilityAuditEntrySchema),
});
export const ObservabilitySummaryGetResultSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('overview'),
      overview: ObservabilityAuditOverviewSchema,
    }),
    z.object({
      kind: z.literal('tab'),
      result: ObservabilityUsageTabSummaryResponseSchema,
    }),
  ],
);

/**
 * Opening without a cursor sends the overview first. A cursor from this
 * stream resumes after it: each audit entry changed since then is sent once,
 * in its latest state, before live items.
 */
export const ObservabilityAuditEventsParamsSchema = z.strictObject({
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});
export const ObservabilityAuditEventsOpenResultSchema = z.strictObject({
  subscriptionId: z.string().min(1).max(512),
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});
export const ObservabilityAuditEventsItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('overview'),
    overview: ObservabilityAuditOverviewSchema,
  }),
  z.object({
    kind: z.literal('entries'),
    entries: z.array(ObservabilityAuditEntrySchema),
  }),
  z.object({ kind: z.literal('retention'), retentionDays }),
]);

export const ObservabilityErrorSchema = inherentOperationErrorSchema([
  'core.observability.unavailable',
  'core.observability.snapshotRequired',
]);
export const ObservabilityAuditEventsEndSchema = CanopyStreamEndSchema.extend({
  error: ObservabilityErrorSchema.nullable(),
});

export type ObservabilityUsageQueryParams = z.output<
  typeof ObservabilityUsageQueryParamsSchema
>;
export type ObservabilityUsageQueryResult = z.output<
  typeof ObservabilityUsageQueryResultSchema
>;
export type ObservabilitySummaryGetParams = z.output<
  typeof ObservabilitySummaryGetParamsSchema
>;
export type ObservabilitySummaryGetResult = z.output<
  typeof ObservabilitySummaryGetResultSchema
>;
export type ObservabilityAuditOverview = z.output<
  typeof ObservabilityAuditOverviewSchema
>;
export type ObservabilityAuditEventsItem = z.output<
  typeof ObservabilityAuditEventsItemSchema
>;

export const CORE_OBSERVABILITY_QUERIES = defineCanopyQueryRegistry('core', {
  'core.observability.audit.list': defineCanopyQuery({
    plane: 'core',
    domain: 'observability',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_OBSERVABILITY_GRANTS.read],
    error: ObservabilityErrorSchema,
    params: ObservabilityAuditListParamsSchema,
    result: ObservabilityAuditListResultSchema,
  }),
  'core.observability.audit.transcript.get': defineCanopyQuery({
    plane: 'core',
    domain: 'observability',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_OBSERVABILITY_GRANTS.read],
    error: ObservabilityErrorSchema,
    params: ObservabilityAuditTranscriptGetParamsSchema,
    result: ObservabilityAuditTranscriptGetResultSchema,
  }),
  'core.observability.usage.query': defineCanopyQuery({
    plane: 'core',
    domain: 'observability',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_OBSERVABILITY_GRANTS.read],
    error: ObservabilityErrorSchema,
    params: ObservabilityUsageQueryParamsSchema,
    result: ObservabilityUsageQueryResultSchema,
  }),
  'core.observability.summary.get': defineCanopyQuery({
    plane: 'core',
    domain: 'observability',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_OBSERVABILITY_GRANTS.read],
    error: ObservabilityErrorSchema,
    params: ObservabilitySummaryGetParamsSchema,
    result: ObservabilitySummaryGetResultSchema,
  }),
});

export const CORE_OBSERVABILITY_STREAMS = defineCanopyStreamRegistry('core', {
  'core.observability.audit.events': defineCanopyStream({
    plane: 'core',
    domain: 'observability',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_OBSERVABILITY_GRANTS.read],
    error: ObservabilityErrorSchema,
    params: ObservabilityAuditEventsParamsSchema,
    openResult: ObservabilityAuditEventsOpenResultSchema,
    item: ObservabilityAuditEventsItemSchema,
    end: ObservabilityAuditEventsEndSchema,
  }),
});

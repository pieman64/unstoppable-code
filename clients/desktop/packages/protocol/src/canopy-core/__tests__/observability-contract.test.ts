import type { z } from 'zod';

import type {
  AgentAuditEntry,
  AgentAuditHistoryRequest,
  AgentAuditHistoryResponse,
  AgentAuditToolCounts,
  AgentAuditTranscriptRequest,
  AgentAuditTranscriptResponse,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageMetricsViewRequest,
  UsageMetricsViewResponse,
  UsageTabSummaryRequest,
  UsageTabSummaryResponse,
  UsageTimeseriesRequest,
  UsageTimeseriesResponse,
} from '../../observability';
import {
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
} from '../registry';
import {
  OBSERVABILITY_TOOL_COUNT_KEYS,
  ObservabilityAuditEntrySchema,
  ObservabilityAuditEventsItemSchema,
  ObservabilityAuditHistoryRequestSchema,
  type ObservabilityAuditHistoryResponseSchema,
  ObservabilityAuditToolCountsSchema,
  type ObservabilityAuditTranscriptRequestSchema,
  type ObservabilityAuditTranscriptResponseSchema,
  type ObservabilityUsageMetricsRequestSchema,
  type ObservabilityUsageMetricsResponseSchema,
  type ObservabilityUsageMetricsViewRequestSchema,
  type ObservabilityUsageMetricsViewResponseSchema,
  ObservabilityUsageQueryParamsSchema,
  type ObservabilityUsageTabSummaryRequestSchema,
  type ObservabilityUsageTabSummaryResponseSchema,
  type ObservabilityUsageTimeseriesRequestSchema,
  type ObservabilityUsageTimeseriesResponseSchema,
} from '../core';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type Out<Schema extends z.ZodType> = z.output<Schema>;

// The wire records stay equal to the stored record contracts in both
// directions, so serving them needs no projection or cast.
type _Entry = Expect<
  Equal<Out<typeof ObservabilityAuditEntrySchema>, AgentAuditEntry>
>;
type _HistoryRequest = Expect<
  Equal<
    Out<typeof ObservabilityAuditHistoryRequestSchema>,
    AgentAuditHistoryRequest
  >
>;
type _HistoryResponse = Expect<
  Equal<
    Out<typeof ObservabilityAuditHistoryResponseSchema>,
    AgentAuditHistoryResponse
  >
>;
type _TranscriptRequest = Expect<
  Equal<
    Out<typeof ObservabilityAuditTranscriptRequestSchema>,
    AgentAuditTranscriptRequest
  >
>;
type _TranscriptResponse = Expect<
  Equal<
    Out<typeof ObservabilityAuditTranscriptResponseSchema>,
    AgentAuditTranscriptResponse
  >
>;
type _TimeseriesRequest = Expect<
  Equal<
    Out<typeof ObservabilityUsageTimeseriesRequestSchema>,
    UsageTimeseriesRequest
  >
>;
type _TimeseriesResponse = Expect<
  Equal<
    Out<typeof ObservabilityUsageTimeseriesResponseSchema>,
    UsageTimeseriesResponse
  >
>;
type _MetricsRequest = Expect<
  Equal<Out<typeof ObservabilityUsageMetricsRequestSchema>, UsageMetricsRequest>
>;
type _MetricsResponse = Expect<
  Equal<
    Out<typeof ObservabilityUsageMetricsResponseSchema>,
    UsageMetricsResponse
  >
>;
type _ViewRequest = Expect<
  Equal<
    Out<typeof ObservabilityUsageMetricsViewRequestSchema>,
    UsageMetricsViewRequest
  >
>;
type _ViewResponse = Expect<
  Equal<
    Out<typeof ObservabilityUsageMetricsViewResponseSchema>,
    UsageMetricsViewResponse
  >
>;
type _TabRequest = Expect<
  Equal<
    Out<typeof ObservabilityUsageTabSummaryRequestSchema>,
    UsageTabSummaryRequest
  >
>;
type _TabResponse = Expect<
  Equal<
    Out<typeof ObservabilityUsageTabSummaryResponseSchema>,
    UsageTabSummaryResponse
  >
>;
type _ToolKeys = Expect<
  Equal<
    (typeof OBSERVABILITY_TOOL_COUNT_KEYS)[number],
    keyof AgentAuditToolCounts
  >
>;

type CompileTimeAssertions = [
  _Entry,
  _HistoryRequest,
  _HistoryResponse,
  _TranscriptRequest,
  _TranscriptResponse,
  _TimeseriesRequest,
  _TimeseriesResponse,
  _MetricsRequest,
  _MetricsResponse,
  _ViewRequest,
  _ViewResponse,
  _TabRequest,
  _TabResponse,
  _ToolKeys,
];
const compileTimeAssertions: CompileTimeAssertions = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
void compileTimeAssertions;

function entry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Chat turn',
    startedAt: '2026-11-02T09:00:00.000Z',
    tokens: {
      input: 1,
      output: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 1,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: ObservabilityAuditToolCountsSchema.parse(
      Object.fromEntries(OBSERVABILITY_TOOL_COUNT_KEYS.map((key) => [key, 0])),
    ),
    hasTranscript: true,
    ...overrides,
  };
}

describe('core.observability contracts', () => {
  it('registers the four reads and the audit events stream', () => {
    expect(Object.keys(CANOPY_QUERY_DEFINITIONS)).toEqual(
      expect.arrayContaining([
        'core.observability.audit.list',
        'core.observability.audit.transcript.get',
        'core.observability.usage.query',
        'core.observability.summary.get',
      ]),
    );
    expect(Object.keys(CANOPY_STREAM_DEFINITIONS)).toContain(
      'core.observability.audit.events',
    );
    for (const name of [
      'core.observability.audit.list',
      'core.observability.audit.transcript.get',
      'core.observability.usage.query',
      'core.observability.summary.get',
    ] as const) {
      expect(CANOPY_QUERY_DEFINITIONS[name].requiredGrants).toEqual([
        'core.observability.read',
      ]);
    }
    expect(
      CANOPY_STREAM_DEFINITIONS['core.observability.audit.events']
        .requiredGrants,
    ).toEqual(['core.observability.read']);
  });

  it('serves a stored entry unchanged and drops undeclared keys', () => {
    const stored = entry({
      planEvents: { created: 1, approved: 0, eventIds: ['plan-1'] },
      modelRouting: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: 'selected',
        executionLane: 'ai_credits',
        selectedModelId: 'model',
      },
    });
    expect(ObservabilityAuditEntrySchema.parse(stored)).toEqual(stored);
    expect(
      ObservabilityAuditEventsItemSchema.parse({
        kind: 'entries',
        entries: [{ ...stored, hostOnly: '/Users/me/secret' }],
      }),
    ).toEqual({ kind: 'entries', entries: [stored] });
  });

  it('rejects unknown request fields', () => {
    expect(
      ObservabilityAuditHistoryRequestSchema.safeParse({
        limit: 10,
        unknown: true,
      }).success,
    ).toBe(false);
    expect(
      ObservabilityUsageQueryParamsSchema.safeParse({
        kind: 'view',
        request: {
          tab: 'cost',
          metric: 'cost_model:claude-opus',
          groupBy: 'model',
          window: { kind: 'last7d' },
        },
      }).success,
    ).toBe(true);
    expect(
      ObservabilityUsageQueryParamsSchema.safeParse({
        kind: 'view',
        request: {
          tab: 'tools',
          metric: 'tool_unknown',
          groupBy: 'category',
          window: { kind: 'last7d' },
        },
      }).success,
    ).toBe(false);
  });
});

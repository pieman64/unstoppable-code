import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/services/stats_api_service.dart';

/// Abstraction over the organization usage/statistics backend.
///
/// [MockStatsRepository] backs the Overview UI today; a real implementation
/// (hitting `GET /api/account/organizations/{orgId}/usage`) will implement
/// this same interface once the endpoint is wired.
abstract interface class StatsRepository {
  /// Fetches the usage dashboard for the trailing [window] at [granularity];
  /// both default to 7 days / daily when null.
  ///
  /// [scope] selects org-wide vs a specific sub-team; when
  /// [TelemetryUsageScope.team], [teamId] (the sub-team externalId) must be
  /// supplied. Both default to org scope when null.
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  });
}

/// In-memory [StatsRepository] returning a representative sample payload.
///
/// All tab collections are populated (`headline`, `mostExpensiveRuns`,
/// cost/token buckets, tool categories, event status counts, impact,
/// leaderboard, and pipelines) so every stats tab has data to render.
final class MockStatsRepository implements StatsRepository {
  MockStatsRepository({this.latency = const Duration(milliseconds: 600)});

  final Duration latency;

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) async {
    await Future<void>.delayed(latency);
    return _sampleUsage;
  }
}

/// Live [StatsRepository] backed by [StatsApiService].
final class HttpStatsRepository implements StatsRepository {
  const HttpStatsRepository({required this.service, required this.orgId});

  final StatsApiService service;
  final String orgId;

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) => service.fetchUsage(
    orgId: orgId,
    window: window ?? const Duration(days: 7),
    granularity: granularity ?? TelemetryTimeGranularity.day,
    scope: scope ?? TelemetryUsageScope.organization,
    teamId: teamId,
  );
}

const TeamUsageResponse _sampleUsage = TeamUsageResponse(
  // Mirrors the six server-hard-coded Overview headline cards, in order.
  headline: [
    TelemetryHeadlineCard(
      key: 'totalCostUsd',
      label: 'Observed cost',
      unit: TelemetryCardUnit.currency,
      value: 1284.53,
      previousValue: 1102.10,
    ),
    TelemetryHeadlineCard(
      key: 'totalTokens',
      label: 'Total tokens',
      unit: TelemetryCardUnit.tokens,
      value: 48200000,
      previousValue: 41000000,
    ),
    TelemetryHeadlineCard(
      key: 'turns',
      label: 'Agent turns',
      unit: TelemetryCardUnit.count,
      value: 3120,
      previousValue: 3402,
    ),
    TelemetryHeadlineCard(
      key: 'worktrees',
      label: 'Worktrees',
      unit: TelemetryCardUnit.count,
      value: 214,
    ),
    TelemetryHeadlineCard(
      key: 'plans',
      label: 'Plans',
      unit: TelemetryCardUnit.count,
      value: 63,
    ),
    TelemetryHeadlineCard(
      key: 'pullRequests',
      label: 'Pull requests',
      unit: TelemetryCardUnit.count,
      value: 128,
    ),
  ],
  mostExpensiveRuns: [
    TelemetryExpensiveRun(
      authorName: 'Alex Rivera',
      branchName: 'feat/activity-feed',
      durationMs: 312000,
      eventType: 'WORKTREE_CHAT',
      inputTokens: 1840000,
      label: 'Implement the activity feed screen',
      model: 'claude-opus-4-8',
      outputTokens: 96000,
      prUrl: 'https://github.com/example/canopy/pull/1201',
      provider: 'anthropic',
      startedAtIso: '2026-06-29T14:12:00.000Z',
      status: 'SUCCESS',
      totalCostUsd: 42.18,
      sessionId: 'wt-1:sess-1',
      turnCount: 6,
      worktreeId: 'wt-1',
    ),
    TelemetryExpensiveRun(
      authorName: 'Priya Nair',
      branchName: 'fix/auth-gate',
      durationMs: 141000,
      eventType: 'PIPELINE_AGENT_TURN',
      inputTokens: 720000,
      label: 'Debug the sign-in gate flake',
      model: 'gpt-5',
      outputTokens: 41000,
      provider: 'openai',
      startedAtIso: '2026-06-29T09:03:00.000Z',
      status: 'FAILURE',
      totalCostUsd: 18.44,
      sessionId: 'wt-2:sess-2',
      turnCount: 3,
      worktreeId: 'wt-2',
    ),
    TelemetryExpensiveRun(
      branchName: 'chore/stats-endpoint',
      eventType: 'WORKTREE_CHAT',
      inputTokens: 512000,
      label: 'Wire the usage endpoint',
      model: 'claude-sonnet-4-6',
      outputTokens: 28000,
      provider: 'anthropic',
      startedAtIso: '2026-06-28T18:40:00.000Z',
      status: 'SUCCESS',
      totalCostUsd: 11.07,
      sessionId: 'wt-3:sess-3',
      turnCount: 4,
      worktreeId: 'wt-3',
    ),
  ],
  costByProvider: [
    TelemetryCostBucket(
      bucketStartIso: '2026-06-28T00:00:00.000Z',
      key: 'anthropic',
      totalCostUsd: 82.5,
    ),
    TelemetryCostBucket(
      bucketStartIso: '2026-06-30T00:00:00.000Z',
      key: 'openai',
      totalCostUsd: 14.25,
    ),
  ],
  costByModel: [
    TelemetryCostBucket(
      bucketStartIso: '2026-06-28T00:00:00.000Z',
      key: 'claude-opus-4-8',
      totalCostUsd: 82.5,
    ),
    TelemetryCostBucket(
      bucketStartIso: '2026-06-30T00:00:00.000Z',
      key: 'gpt-5',
      totalCostUsd: 14.25,
    ),
  ],
  tokensByProvider: [
    TelemetryTokenBucket(
      bucketStartIso: '2026-06-28T00:00:00.000Z',
      key: 'anthropic',
      inputTokens: 1200000,
      outputTokens: 90000,
      cacheReadInputTokens: 400000,
      cacheCreationInputTokens: 50000,
    ),
    TelemetryTokenBucket(
      bucketStartIso: '2026-06-30T00:00:00.000Z',
      key: 'openai',
      inputTokens: 300000,
      outputTokens: 20000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    ),
  ],
  tokensByModel: [
    TelemetryTokenBucket(
      bucketStartIso: '2026-06-28T00:00:00.000Z',
      key: 'claude-opus-4-8',
      inputTokens: 1200000,
      outputTokens: 90000,
      cacheReadInputTokens: 400000,
      cacheCreationInputTokens: 50000,
    ),
    TelemetryTokenBucket(
      bucketStartIso: '2026-06-30T00:00:00.000Z',
      key: 'gpt-5',
      inputTokens: 300000,
      outputTokens: 20000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    ),
  ],
  toolCategoryTotals: [
    TelemetryToolCategoryTotal(toolCategory: 'file_edit', total: 480),
    TelemetryToolCategoryTotal(toolCategory: 'shell', total: 320),
    TelemetryToolCategoryTotal(toolCategory: 'search', total: 210),
  ],
  eventTypeStatusCounts: [
    TelemetryEventStatusCount(
      eventType: 'WORKTREE_CHAT',
      status: 'SUCCESS',
      count: 120,
    ),
    TelemetryEventStatusCount(
      eventType: 'WORKTREE_CHAT',
      status: 'FAILURE',
      count: 8,
    ),
    TelemetryEventStatusCount(
      eventType: 'PIPELINE_AGENT_TURN',
      status: 'SUCCESS',
      count: 45,
    ),
  ],
  impactByUser: [
    TelemetryImpactBucket(
      bucketStartIso: '2026-06-28T00:00:00.000Z',
      key: 'Alex Rivera',
      impactScore: 12.5,
    ),
    TelemetryImpactBucket(
      bucketStartIso: '2026-06-30T00:00:00.000Z',
      key: 'Priya Nair',
      impactScore: 9.0,
    ),
  ],
  byUser: [
    TelemetryUserLeaderboardRow(
      agentTurns: 180,
      agentWorkBonus: 9.0,
      agentWorkUnits: 220,
      avgCycleTimeMs: 5400000,
      avgPrSize: 320,
      cacheCreationInputTokens: 50000,
      cacheReadInputTokens: 400000,
      changedFiles: 42,
      checksDecided: 10,
      checksPassing: 9,
      deliveryArtifacts: 0,
      deliveryEntries: 0,
      deliveryEntriesDone: 0,
      deliveryEntriesWithTicket: 0,
      deliveryExternalActions: 0,
      deliveryImpactRaw: 0,
      deliverySharedRuns: 0,
      executionBonus: 2,
      impactScore: 12.5,
      inputTokens: 1200000,
      linesChanged: 3400,
      outputTokens: 90000,
      pipelineAgentSteps: 900,
      pipelineAvgRunMs: 620000,
      pipelineDistinctPipelines: 5,
      pipelineRetries: 3,
      pipelineRuns: 40,
      pipelineRunsCancelled: 2,
      pipelineRunsFailed: 4,
      pipelineRunsSucceeded: 34,
      plansCreated: 4,
      plansImplemented: 3,
      prImpactRaw: 10.5,
      prsCreated: 8,
      prsMerged: 6,
      prsOpen: 2,
      prsWithTicket: 5,
      toolUseCount: 480,
      totalCostUsd: 82.5,
      turnCount: 210,
      userId: 'user-1',
      userName: 'Alex Rivera',
      worktreesCreated: 12,
    ),
  ],
  pipelines: [
    TelemetryPipelineUsage(
      agentTimeMs: 480000,
      clientPipelineId: 'bundled-implementation-autopilot',
      inputTokens: 900000,
      outputTokens: 60000,
      pipelineName: 'Implementation Autopilot',
      runCount: 12,
      totalCostUsd: 64.0,
      turnCount: 80,
    ),
    TelemetryPipelineUsage(
      agentTimeMs: 120000,
      clientPipelineId: 'code-review.yaml',
      inputTokens: 200000,
      outputTokens: 15000,
      pipelineName: null,
      runCount: 5,
      totalCostUsd: 12.5,
      turnCount: 20,
    ),
  ],
  range: TeamUsageResponseRange(
    startIso: '2026-06-24T00:00:00.000Z',
    endIso: '2026-07-01T00:00:00.000Z',
    granularity: TelemetryTimeGranularity.day,
  ),
  scope: TelemetryUsageScope.organization,
);

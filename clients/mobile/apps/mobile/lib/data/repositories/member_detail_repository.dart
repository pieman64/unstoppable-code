import 'package:mobile/data/models/member_detail.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/services/member_detail_api_service.dart';

/// Abstraction over the per-member profile backend: the member's shared plans,
/// approved plans, pipelines, and (gated) usage rollup.
abstract interface class MemberDetailRepository {
  /// Loads the member's plans, pipelines, approved plans, and — when
  /// [canViewStats] is true — their usage rollup. When [canViewStats] is false
  /// the usage section is omitted and no gated usage request is made.
  Future<MemberDetailData> load({required bool canViewStats});
}

/// In-memory [MemberDetailRepository] returning representative sample data.
///
/// Backs the member-detail UI in mock mode (no API config) and in tests. When
/// [canViewStats] is false, [load] returns `usage: null` so the gated section is
/// hidden — matching the live path that never fetches gated data.
final class MockMemberDetailRepository implements MemberDetailRepository {
  MockMemberDetailRepository({
    this.latency = const Duration(milliseconds: 400),
  });

  final Duration latency;

  @override
  Future<MemberDetailData> load({required bool canViewStats}) async {
    await Future<void>.delayed(latency);
    return MemberDetailData(
      sharedPlans: const [
        MemberSharedPlan(
          id: 'plan-1',
          title: 'Activity feed rollout',
          shareScope: 'ORGANIZATION',
          ownerType: 'organization',
          ownerName: 'Acme',
          createdAt: '2026-06-20T10:00:00.000Z',
          updatedAt: '2026-06-29T10:00:00.000Z',
        ),
        MemberSharedPlan(
          id: 'plan-2',
          title: 'Auth gate hardening',
          shareScope: 'TEAM',
          ownerType: 'team',
          ownerName: 'Platform',
          createdAt: '2026-06-18T10:00:00.000Z',
          updatedAt: '2026-06-24T10:00:00.000Z',
        ),
      ],
      approvedPlans: const [
        MemberApprovedPlan(
          id: 'approved-1',
          title: 'Wire the usage endpoint',
          reviewStatus: 'APPROVED',
          planVersion: 3,
          implementationStartedAt: '2026-06-28T18:40:00.000Z',
          updatedAt: '2026-06-28T19:10:00.000Z',
        ),
      ],
      pipelines: const [
        MemberPipeline(
          id: 'pipeline-1',
          name: 'Implementation Autopilot',
          description: 'Plan, implement, and open a PR end to end.',
          icon: 'rocket',
          version: '1.4.0',
          shareScope: 'ORGANIZATION',
          ownerType: 'organization',
          ownerName: 'Acme',
          createdAt: '2026-06-10T10:00:00.000Z',
          updatedAt: '2026-06-27T10:00:00.000Z',
        ),
      ],
      usage: canViewStats ? _sampleUsage : null,
    );
  }
}

/// Live [MemberDetailRepository] backed by [MemberDetailApiService].
///
/// The three list reads run together; the usage read is attempted only when
/// [canViewStats] is true (so no gated data is requested for a viewer who can't
/// see it), and a usage failure is swallowed to `null` so the plans/pipelines
/// sections still render.
final class HttpMemberDetailRepository implements MemberDetailRepository {
  const HttpMemberDetailRepository({
    required this.service,
    required this.orgId,
    required this.memberId,
  });

  final MemberDetailApiService service;
  final String orgId;
  final String memberId;

  @override
  Future<MemberDetailData> load({required bool canViewStats}) async {
    final (sharedPlans, approvedPlans, pipelines) = await (
      service.fetchSharedPlans(orgId: orgId, memberId: memberId),
      service.fetchApprovedPlans(orgId: orgId, memberId: memberId),
      service.fetchPipelines(orgId: orgId, memberId: memberId),
    ).wait;

    TeamUsageResponse? usage;
    if (canViewStats) {
      try {
        usage = await service.fetchMemberUsage(
          orgId: orgId,
          memberId: memberId,
        );
      } catch (_) {
        // A gated-usage failure (including a 403 if the gate changed mid-view)
        // must not fail the whole profile; the section is simply omitted.
        usage = null;
      }
    }

    return MemberDetailData(
      sharedPlans: sharedPlans.items,
      approvedPlans: approvedPlans.items,
      pipelines: pipelines.items,
      usage: usage,
    );
  }
}

const TeamUsageResponse _sampleUsage = TeamUsageResponse(
  headline: [
    TelemetryHeadlineCard(
      key: 'totalCostUsd',
      label: 'Observed cost',
      unit: TelemetryCardUnit.currency,
      value: 214.72,
      previousValue: 180.44,
    ),
    TelemetryHeadlineCard(
      key: 'totalTokens',
      label: 'Total tokens',
      unit: TelemetryCardUnit.tokens,
      value: 8200000,
      previousValue: 7100000,
    ),
    TelemetryHeadlineCard(
      key: 'turns',
      label: 'Agent turns',
      unit: TelemetryCardUnit.count,
      value: 540,
      previousValue: 610,
    ),
    TelemetryHeadlineCard(
      key: 'worktrees',
      label: 'Worktrees',
      unit: TelemetryCardUnit.count,
      value: 38,
    ),
    TelemetryHeadlineCard(
      key: 'plans',
      label: 'Plans',
      unit: TelemetryCardUnit.count,
      value: 11,
    ),
    TelemetryHeadlineCard(
      key: 'pullRequests',
      label: 'Pull requests',
      unit: TelemetryCardUnit.count,
      value: 22,
    ),
  ],
  mostExpensiveRuns: [],
  costByProvider: [],
  costByModel: [],
  tokensByProvider: [],
  tokensByModel: [],
  toolCategoryTotals: [],
  eventTypeStatusCounts: [],
  impactByUser: [],
  byUser: [],
  pipelines: [],
  range: TeamUsageResponseRange(
    startIso: '2026-06-03T00:00:00.000Z',
    endIso: '2026-07-03T00:00:00.000Z',
    granularity: TelemetryTimeGranularity.day,
  ),
  scope: TelemetryUsageScope.organization,
  filterUserId: 'member-1',
);

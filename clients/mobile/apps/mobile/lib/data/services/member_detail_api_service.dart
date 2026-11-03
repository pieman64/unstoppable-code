import 'package:mobile/data/models/member_detail.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the per-member profile endpoints under
/// `/api/account/organizations/{orgId}/members/{memberId}/...` plus the
/// member-scoped usage read.
///
/// The three list routes each return a `{ data: [...], nextCursor }` envelope
/// (not a bare array), so they are read via [ApiClient.getJson] and unwrapped
/// here. Per-member usage reuses the org usage endpoint with a `userId`
/// attribution filter; the server enforces the org's `usageStatsMinRole` gate
/// and returns 403 when the viewer cannot see stats.
final class MemberDetailApiService {
  const MemberDetailApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Lists the member's TEAM/ORGANIZATION-shared plans (first page).
  Future<MemberListPage<MemberSharedPlan>> fetchSharedPlans({
    required String orgId,
    required String memberId,
  }) async {
    final json = await apiClient.getJson(
      _membersPath(orgId, memberId, 'plans'),
    );
    return _page(json, MemberSharedPlan.fromJson);
  }

  /// Lists the approved (telemetry) plans the member has started implementing.
  Future<MemberListPage<MemberApprovedPlan>> fetchApprovedPlans({
    required String orgId,
    required String memberId,
  }) async {
    final json = await apiClient.getJson(
      _membersPath(orgId, memberId, 'approved-plans'),
    );
    return _page(json, MemberApprovedPlan.fromJson);
  }

  /// Lists the member's TEAM/ORGANIZATION-shared pipelines (first page).
  Future<MemberListPage<MemberPipeline>> fetchPipelines({
    required String orgId,
    required String memberId,
  }) async {
    final json = await apiClient.getJson(
      _membersPath(orgId, memberId, 'pipelines'),
    );
    return _page(json, MemberPipeline.fromJson);
  }

  /// Fetches the member-scoped usage dashboard for [orgId] over the trailing
  /// [window], filtered to [memberId] via the `userId` attribution filter. The
  /// server applies the org's `usageStatsMinRole` gate and throws (403) when the
  /// viewer cannot view usage statistics.
  Future<TeamUsageResponse> fetchMemberUsage({
    required String orgId,
    required String memberId,
    Duration window = const Duration(days: 30),
    TelemetryTimeGranularity granularity = TelemetryTimeGranularity.day,
  }) async {
    final end = DateTime.now().toUtc();
    final start = end.subtract(window);
    final json = await apiClient.getJson(
      '/api/account/organizations/$orgId/usage',
      query: {
        'scope': 'organization',
        'granularity': granularity.wire,
        'start': start.toIso8601String(),
        'end': end.toIso8601String(),
        'userId': memberId,
      },
    );
    return TeamUsageResponse.fromJson(json);
  }

  String _membersPath(String orgId, String memberId, String resource) =>
      '/api/account/organizations/$orgId/members/$memberId/$resource';
}

/// Unwraps a `{ data: [...], nextCursor }` envelope, mapping each element with
/// [fromJson]. A missing/non-list `data` yields an empty page; a non-string
/// `nextCursor` is normalized to `null`.
MemberListPage<T> _page<T>(
  Map<String, dynamic> json,
  T Function(Map<String, dynamic>) fromJson,
) {
  final data = json['data'];
  final items = data is List<dynamic>
      ? data
            .whereType<Map<String, dynamic>>()
            .map(fromJson)
            .toList(growable: false)
      : <T>[];
  final nextCursor = json['nextCursor'];
  return MemberListPage<T>(
    items: items,
    nextCursor: nextCursor is String ? nextCursor : null,
  );
}

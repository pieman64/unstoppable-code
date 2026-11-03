import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the organization usage-statistics endpoint
/// (`GET /api/account/organizations/{orgId}/usage`).
final class StatsApiService {
  const StatsApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Fetches the usage dashboard for [orgId] over the trailing [window]
  /// (default 7 days, daily granularity, org scope — matching the web default).
  ///
  /// When [scope] is [TelemetryUsageScope.team], [teamId] (the sub-team
  /// externalId) is required and is sent as the `teamId` query param — matching
  /// the web `parseTeamUsageParams` contract, which rejects team scope without
  /// a `teamId`.
  Future<TeamUsageResponse> fetchUsage({
    required String orgId,
    Duration window = const Duration(days: 7),
    TelemetryTimeGranularity granularity = TelemetryTimeGranularity.day,
    TelemetryUsageScope scope = TelemetryUsageScope.organization,
    String? teamId,
  }) async {
    final scopedTeamId = teamId?.trim();
    if (scope == TelemetryUsageScope.team &&
        (scopedTeamId == null || scopedTeamId.isEmpty)) {
      throw ArgumentError.value(
        teamId,
        'teamId',
        'teamId is required when scope is team',
      );
    }

    final end = DateTime.now().toUtc();
    final start = end.subtract(window);
    final json = await apiClient.getJson(
      '/api/account/organizations/$orgId/usage',
      query: {
        'scope': scope.wire,
        'granularity': granularity.wire,
        'start': start.toIso8601String(),
        'end': end.toIso8601String(),
        if (scope == TelemetryUsageScope.team) 'teamId': scopedTeamId!,
      },
    );
    return TeamUsageResponse.fromJson(json);
  }
}

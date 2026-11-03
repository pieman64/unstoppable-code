import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Selectable usage-window presets, each with a sensible default granularity
/// (mirrors the web statistics dashboard's range picker).
enum StatsRange {
  last24h('24h', Duration(hours: 24), TelemetryTimeGranularity.hour),
  last7d('7d', Duration(days: 7), TelemetryTimeGranularity.day),
  last30d('30d', Duration(days: 30), TelemetryTimeGranularity.day),
  last90d('90d', Duration(days: 90), TelemetryTimeGranularity.week);

  const StatsRange(this.label, this.window, this.granularity);

  final String label;
  final Duration window;
  final TelemetryTimeGranularity granularity;
}

/// The selected usage scope: org-wide, or a specific sub-team.
///
/// Carries the sub-team [teamId] (its externalId, threaded to the `teamId`
/// query param the web `parseTeamUsageParams` requires for team scope) and its
/// display [teamName] so the control can label the selection without a second
/// lookup. Equality is value-based so [StatsViewModel.setScope] can no-op when
/// the same scope is re-selected.
@immutable
final class StatsScope {
  const StatsScope.organization()
    : kind = TelemetryUsageScope.organization,
      teamId = null,
      teamName = null;

  const StatsScope.team({required String this.teamId, required this.teamName})
    : kind = TelemetryUsageScope.team;

  final TelemetryUsageScope kind;

  /// Sub-team externalId when [kind] is [TelemetryUsageScope.team]; null org-wide.
  final String? teamId;

  /// Sub-team display name when scoped to a team; null org-wide.
  final String? teamName;

  @override
  bool operator ==(Object other) =>
      other is StatsScope &&
      other.kind == kind &&
      other.teamId == teamId &&
      other.teamName == teamName;

  @override
  int get hashCode => Object.hash(kind, teamId, teamName);
}

/// Manages state for the Overview (usage-statistics) screen.
final class StatsViewModel extends ChangeNotifier with DisposeSafeNotifier {
  StatsViewModel({required this.repository});

  final StatsRepository repository;

  StatsRange _range = StatsRange.last7d;
  StatsScope _scope = const StatsScope.organization();
  bool _isLoading = false;
  int _loadGeneration = 0;
  TeamUsageResponse? _usage;
  Object? _error;

  /// The selected time-window preset.
  StatsRange get range => _range;

  /// The selected usage scope (org-wide by default, or a specific sub-team).
  StatsScope get scope => _scope;

  /// True while a [loadUsage] call is in flight.
  bool get isLoading => _isLoading;

  /// The current usage payload, or `null` until the first successful load.
  TeamUsageResponse? get usage => _usage;

  /// Non-null when the most recent [loadUsage] ended with an error.
  Object? get error => _error;

  /// The structured org-billing lapse payload when the most recent load
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get planLapse => errorOrgTeamsLapse(_error);

  /// User-presentable copy for the most recent load failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get errorMessage => presentableErrorMessage(_error);

  /// Fetches the usage payload for the selected [range] and [scope], replacing
  /// any existing state.
  Future<void> loadUsage() async {
    final generation = ++_loadGeneration;
    final requestedRange = _range;
    final requestedScope = _scope;
    _isLoading = true;
    _error = null;
    notifyListenersSafe();

    try {
      final usage = await repository.fetchUsage(
        window: requestedRange.window,
        granularity: requestedRange.granularity,
        scope: requestedScope.kind,
        teamId: requestedScope.teamId,
      );
      if (generation != _loadGeneration) return;
      _usage = usage;
    } catch (e) {
      if (generation != _loadGeneration) return;
      _error = e;
      _usage = null;
    } finally {
      if (generation == _loadGeneration) {
        _isLoading = false;
        notifyListenersSafe();
      }
    }
  }

  /// Switches the selected time window and reloads. A no-op when [range] is
  /// already selected.
  Future<void> setRange(StatsRange range) async {
    if (range == _range) return;
    _range = range;
    await loadUsage();
  }

  /// Switches the selected usage scope and reloads (the in-flight generation
  /// guard in [loadUsage] discards any stale response). A no-op when [scope] is
  /// already selected.
  Future<void> setScope(StatsScope scope) async {
    if (scope == _scope) return;
    _scope = scope;
    await loadUsage();
  }
}

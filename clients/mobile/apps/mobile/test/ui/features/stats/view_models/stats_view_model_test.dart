import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';

/// [StatsRepository] whose [fetchUsage] future resolves only when the test
/// decides, so a load can be held in flight across [StatsViewModel.dispose].
final class _ControllableStatsRepository implements StatsRepository {
  final Completer<TeamUsageResponse> completer = Completer<TeamUsageResponse>();

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) => completer.future;
}

/// [StatsRepository] that records each request and lets tests complete them in
/// any order.
final class _QueuedStatsRepository implements StatsRepository {
  final List<Completer<TeamUsageResponse>> completers = [];
  final List<Duration?> requestedWindows = [];
  final List<TelemetryTimeGranularity?> requestedGranularities = [];
  final List<TelemetryUsageScope?> requestedScopes = [];
  final List<String?> requestedTeamIds = [];

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) {
    requestedWindows.add(window);
    requestedGranularities.add(granularity);
    requestedScopes.add(scope);
    requestedTeamIds.add(teamId);
    final completer = Completer<TeamUsageResponse>();
    completers.add(completer);
    return completer.future;
  }
}

/// [StatsRepository] that records the window/granularity/scope of each fetch and
/// delegates to the sample payload, for asserting range- and scope-driven
/// reloads.
final class _RecordingStatsRepository implements StatsRepository {
  _RecordingStatsRepository()
    : _delegate = MockStatsRepository(latency: Duration.zero);

  final MockStatsRepository _delegate;
  int calls = 0;
  Duration? lastWindow;
  TelemetryTimeGranularity? lastGranularity;
  TelemetryUsageScope? lastScope;
  String? lastTeamId;

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) {
    calls++;
    lastWindow = window;
    lastGranularity = granularity;
    lastScope = scope;
    lastTeamId = teamId;
    return _delegate.fetchUsage(
      window: window,
      granularity: granularity,
      scope: scope,
      teamId: teamId,
    );
  }
}

void main() {
  group('StatsViewModel', () {
    test(
      'defaults to the 7-day daily range and passes it to the repo',
      () async {
        final repo = _RecordingStatsRepository();
        final vm = StatsViewModel(repository: repo);

        expect(vm.range, StatsRange.last7d);
        await vm.loadUsage();

        expect(repo.lastWindow, const Duration(days: 7));
        expect(repo.lastGranularity, TelemetryTimeGranularity.day);
        // Defaults to org-wide scope with no team id.
        expect(repo.lastScope, TelemetryUsageScope.organization);
        expect(repo.lastTeamId, isNull);
      },
    );

    test('defaults to organization scope', () {
      final vm = StatsViewModel(repository: _RecordingStatsRepository());
      expect(vm.scope, const StatsScope.organization());
      expect(vm.scope.kind, TelemetryUsageScope.organization);
      expect(vm.scope.teamId, isNull);
    });

    test('setScope to a sub-team reloads with team scope + teamId', () async {
      final repo = _RecordingStatsRepository();
      final vm = StatsViewModel(repository: repo);

      await vm.setScope(
        const StatsScope.team(teamId: 'team-fe', teamName: 'Frontend'),
      );

      expect(vm.scope.kind, TelemetryUsageScope.team);
      expect(vm.scope.teamId, 'team-fe');
      expect(vm.scope.teamName, 'Frontend');
      expect(repo.calls, 1);
      expect(repo.lastScope, TelemetryUsageScope.team);
      expect(repo.lastTeamId, 'team-fe');
    });

    test('setScope back to the organization reloads org-wide', () async {
      final repo = _RecordingStatsRepository();
      final vm = StatsViewModel(repository: repo);

      await vm.setScope(
        const StatsScope.team(teamId: 'team-fe', teamName: 'Frontend'),
      );
      await vm.setScope(const StatsScope.organization());

      expect(vm.scope, const StatsScope.organization());
      expect(repo.calls, 2);
      expect(repo.lastScope, TelemetryUsageScope.organization);
      expect(repo.lastTeamId, isNull);
    });

    test('setScope to the current scope is a no-op', () async {
      final repo = _RecordingStatsRepository();
      final vm = StatsViewModel(repository: repo);

      await vm.setScope(const StatsScope.organization()); // already the default

      expect(repo.calls, 0);
    });

    test('ignores stale load results when scope changes quickly', () async {
      final repo = _QueuedStatsRepository();
      final vm = StatsViewModel(repository: repo);
      final staleUsage = _usageForRange(StatsRange.last7d);
      final latestUsage = _usageForRange(StatsRange.last7d);

      final firstLoad = vm.loadUsage(); // org scope
      final secondLoad = vm.setScope(
        const StatsScope.team(teamId: 'team-be', teamName: 'Backend'),
      );

      expect(repo.requestedScopes, [
        TelemetryUsageScope.organization,
        TelemetryUsageScope.team,
      ]);
      expect(repo.requestedTeamIds, [null, 'team-be']);

      repo.completers[1].complete(latestUsage);
      await secondLoad;

      expect(vm.scope.teamId, 'team-be');
      expect(vm.usage, same(latestUsage));

      // The stale org-scope response resolves last but must be discarded.
      repo.completers[0].complete(staleUsage);
      await firstLoad;

      expect(vm.scope.teamId, 'team-be');
      expect(vm.usage, same(latestUsage));
      expect(vm.error, isNull);
    });

    test('setRange changes the range and reloads with its window', () async {
      final repo = _RecordingStatsRepository();
      final vm = StatsViewModel(repository: repo);

      await vm.setRange(StatsRange.last90d);

      expect(vm.range, StatsRange.last90d);
      expect(repo.calls, 1);
      expect(repo.lastWindow, const Duration(days: 90));
      expect(repo.lastGranularity, TelemetryTimeGranularity.week);
    });

    test('setRange to the current range is a no-op', () async {
      final repo = _RecordingStatsRepository();
      final vm = StatsViewModel(repository: repo);

      await vm.setRange(StatsRange.last7d); // already the default

      expect(repo.calls, 0);
    });

    test('loadUsage populates usage and clears loading', () async {
      final vm = StatsViewModel(
        repository: MockStatsRepository(latency: Duration.zero),
      );
      expect(vm.isLoading, isFalse);
      expect(vm.usage, isNull);

      await vm.loadUsage();

      expect(vm.isLoading, isFalse);
      expect(vm.usage, isNotNull);
      expect(vm.usage?.headline, isNotEmpty);
      expect(vm.error, isNull);
    });

    test('ignores stale load results when range changes quickly', () async {
      final repo = _QueuedStatsRepository();
      final vm = StatsViewModel(repository: repo);
      final staleUsage = _usageForRange(StatsRange.last7d);
      final latestUsage = _usageForRange(StatsRange.last90d);

      final firstLoad = vm.loadUsage();
      final secondLoad = vm.setRange(StatsRange.last90d);

      expect(repo.requestedWindows, [
        const Duration(days: 7),
        const Duration(days: 90),
      ]);
      expect(repo.requestedGranularities, [
        TelemetryTimeGranularity.day,
        TelemetryTimeGranularity.week,
      ]);

      repo.completers[1].complete(latestUsage);
      await secondLoad;

      expect(vm.range, StatsRange.last90d);
      expect(vm.usage, same(latestUsage));
      expect(vm.isLoading, isFalse);
      expect(vm.error, isNull);

      repo.completers[0].complete(staleUsage);
      await firstLoad;

      expect(vm.range, StatsRange.last90d);
      expect(vm.usage, same(latestUsage));
      expect(vm.isLoading, isFalse);
      expect(vm.error, isNull);
    });

    test(
      'loadUsage resolving after dispose does not notify a disposed notifier',
      () async {
        final repo = _ControllableStatsRepository();
        final vm = StatsViewModel(repository: repo);

        final pending = vm.loadUsage(); // suspended awaiting the repository
        vm.dispose(); // torn down (e.g. sign-out) before the load completes

        repo.completer.completeError(StateError('resolved after dispose'));

        // Without the DisposeSafeNotifier guard the finally-block notify would
        // throw "A StatsViewModel was used after being disposed".
        await expectLater(pending, completes);
        expect(vm.isDisposed, isTrue);
      },
    );
  });
}

TeamUsageResponse _usageForRange(StatsRange range) => TeamUsageResponse(
  byUser: const [],
  costByModel: const [],
  costByProvider: const [],
  eventTypeStatusCounts: const [],
  headline: const [],
  impactByUser: const [],
  mostExpensiveRuns: const [],
  pipelines: const [],
  range: TeamUsageResponseRange(
    startIso: '2026-01-01T00:00:00.000Z',
    endIso: '2026-01-02T00:00:00.000Z',
    granularity: range.granularity,
  ),
  scope: TelemetryUsageScope.organization,
  tokensByModel: const [],
  tokensByProvider: const [],
  toolCategoryTotals: const [],
);

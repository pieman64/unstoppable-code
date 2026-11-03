// Regression guard for the "Could not load stats" incidents (2026-07-08 and
// 2026-08-13).
//
// The mobile app is released nightly from `develop`, but the web backend
// deploys on its own, slower cadence. A shipped mobile build therefore
// routinely talks to a backend that is OLDER than the build itself
// (2026-08-13: build `mobile-internal-2026.08.13` was cut from ef12ba0f3 while
// staging served 635d012e7 and production served 1d04c9018 — neither of which
// emits the Cowork delivery fields added by ef12ba0f3).
//
// Two properties keep that skew survivable, and both are asserted here:
//
//   1. A required numeric field the older backend does not send parses as 0
//      rather than throwing `type 'Null' is not a subtype of type 'num'`.
//   2. A row that still cannot be parsed is skipped, not fatal. `byUser` and
//      friends are required by TeamUsageResponse, so before this guard a single
//      unparseable row failed the WHOLE response and all seven Overview tabs
//      fell into the shared "Could not load stats" error state.
//
// Every pre-existing usage fixture sent `'byUser': []`, which is why both
// incidents reached users with a green CI. Keep these collections non-empty.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';

void main() {
  group('TeamUsageResponse.fromJson backend skew', () {
    test('parses a leaderboard row from a backend older than this build', () {
      // Exactly the TelemetryUserLeaderboardRow shape served by the deployed
      // backend at 635d012e7 / 1d04c9018 — i.e. without the seven Cowork
      // delivery fields introduced later by ef12ba0f3.
      final usage = TeamUsageResponse.fromJson(_usageJsonFromOlderBackend);

      expect(usage.byUser, hasLength(1));
      final row = usage.byUser.single;
      expect(row.userName, 'Ada L.');
      expect(row.impactScore, 12.5);
      expect(row.prImpactRaw, 8.5);

      // Fields the older backend does not send degrade to a neutral zero
      // rather than throwing and taking the entire response down with them.
      expect(row.deliveryImpactRaw, 0);
      expect(row.deliveryEntries, 0);
      expect(row.deliveryArtifacts, 0);
      expect(row.deliveryExternalActions, 0);
      expect(row.deliveryEntriesWithTicket, 0);
      expect(row.deliveryEntriesDone, 0);
      expect(row.deliverySharedRuns, 0);

      // Same for the agent-work fields that replaced `pipelineBonus`: the old
      // key is ignored and the new ones default to zero.
      expect(row.agentTurns, 0);
      expect(row.agentWorkBonus, 0);
      expect(row.agentWorkUnits, 0);
    });

    test('skips an unparseable row instead of failing the whole response', () {
      final json = Map<String, dynamic>.from(_usageJsonFromOlderBackend);
      json['byUser'] = <dynamic>[
        // Wrong type for a required numeric field: not recoverable by the
        // missing-field default, so this row must be dropped.
        <String, dynamic>{
          ..._leaderboardRowFromOlderBackend,
          'impactScore': 'not-a-number',
        },
        _leaderboardRowFromOlderBackend,
      ];

      final usage = TeamUsageResponse.fromJson(json);

      // The healthy row survives, so the other six tabs still render.
      expect(usage.byUser, hasLength(1));
      expect(usage.byUser.single.userName, 'Ada L.');
    });
  });
}

/// A complete, valid usage response as served by a backend predating the
/// Cowork delivery fields, with a non-empty `byUser`.
final Map<String, dynamic> _usageJsonFromOlderBackend = <String, dynamic>{
  'scope': 'organization',
  'range': <String, dynamic>{
    'startIso': '2026-08-05T00:00:00.000Z',
    'endIso': '2026-08-12T00:00:00.000Z',
    'granularity': 'day',
  },
  'headline': <dynamic>[
    <String, dynamic>{
      'key': 'totalCostUsd',
      'label': 'Observed usage',
      'unit': 'currency',
      'value': 100,
    },
  ],
  'byUser': <dynamic>[_leaderboardRowFromOlderBackend],
  'impactByUser': <dynamic>[],
  'tokensByProvider': <dynamic>[],
  'tokensByModel': <dynamic>[],
  'costByProvider': <dynamic>[],
  'costByModel': <dynamic>[],
  'toolCategoryTotals': <dynamic>[],
  'eventTypeStatusCounts': <dynamic>[],
  'pipelines': <dynamic>[],
  'mostExpensiveRuns': <dynamic>[],
};

const Map<String, dynamic> _leaderboardRowFromOlderBackend = <String, dynamic>{
  'userId': 'user-1',
  'userName': 'Ada L.',
  'impactScore': 12.5,
  'prImpactRaw': 8.5,
  'executionBonus': 2,
  // Retired in favour of `agentWorkBonus`/`agentTurns`/`agentWorkUnits`; an
  // older backend still sends it and the parser must ignore it.
  'pipelineBonus': 2,
  'totalCostUsd': 42.5,
  'inputTokens': 1200000,
  'outputTokens': 90000,
  'cacheReadInputTokens': 400000,
  'cacheCreationInputTokens': 20000,
  'turnCount': 310,
  'toolUseCount': 880,
  'worktreesCreated': 12,
  'plansCreated': 6,
  'plansImplemented': 4,
  'prsCreated': 9,
  'prsMerged': 7,
  'prsOpen': 2,
  'linesChanged': 5400,
  'changedFiles': 120,
  'avgCycleTimeMs': 7200000,
  'checksPassing': 30,
  'checksDecided': 32,
  'avgPrSize': 771,
  'prsWithTicket': 5,
  'pipelineAgentSteps': 18,
  'pipelineRuns': 11,
  'pipelineRunsSucceeded': 9,
  'pipelineRunsFailed': 1,
  'pipelineRunsCancelled': 1,
  'pipelineDistinctPipelines': 3,
  'pipelineRetries': 2,
  'pipelineAvgRunMs': 480000,
};

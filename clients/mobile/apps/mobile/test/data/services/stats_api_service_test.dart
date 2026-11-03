import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/stats_api_service.dart';

import '../../support/usage_fixture.dart';

void main() {
  group('StatsApiService', () {
    test(
      'fetchUsage hits the usage endpoint with scope + granularity',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response(jsonEncode(_usageJson), 200);
        });
        final service = StatsApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        );

        final usage = await service.fetchUsage(orgId: 'org-1');

        expect(captured.url.path, '/api/account/organizations/org-1/usage');
        expect(captured.url.queryParameters['scope'], 'organization');
        expect(captured.url.queryParameters['granularity'], 'day');
        // Org scope must not send a teamId (web rejects a stray team filter).
        expect(captured.url.queryParameters.containsKey('teamId'), isFalse);
        expect(usage.headline, hasLength(1));
        expect(usage.scope, TelemetryUsageScope.organization);
      },
    );

    test(
      'fetchUsage parses every collection in the current server shape',
      () async {
        final client = MockClient(
          (request) async => http.Response(jsonEncode(_usageJson), 200),
        );
        final service = StatsApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        );

        final usage = await service.fetchUsage(orgId: 'org-1');

        // Each list is populated in the fixture, so an empty one here means the
        // rows silently failed to parse and `_parseList` dropped them — the
        // failure mode that shipped "Could not load stats" twice. Assert on the
        // collections rather than the response object so the next additive
        // protocol field is caught here instead of by a user.
        expect(usage.byUser, hasLength(1));
        expect(usage.impactByUser, hasLength(1));
        expect(usage.tokensByProvider, hasLength(1));
        expect(usage.tokensByModel, hasLength(1));
        expect(usage.costByProvider, hasLength(1));
        expect(usage.costByModel, hasLength(1));
        expect(usage.toolCategoryTotals, hasLength(1));
        expect(usage.eventTypeStatusCounts, hasLength(1));
        expect(usage.pipelines, hasLength(1));
        expect(usage.mostExpensiveRuns, hasLength(1));

        final row = usage.byUser.single;
        expect(row.userName, 'Ada L.');
        expect(row.impactScore, 12.5);
        expect(row.deliveryImpactRaw, 1.5);
        expect(row.deliveryEntries, 4);
      },
    );

    test('fetchUsage sends scope=team + teamId for a sub-team', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_usageJson), 200);
      });
      final service = StatsApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      await service.fetchUsage(
        orgId: 'org-1',
        scope: TelemetryUsageScope.team,
        teamId: 'team-fe',
      );

      expect(captured.url.path, '/api/account/organizations/org-1/usage');
      expect(captured.url.queryParameters['scope'], 'team');
      expect(captured.url.queryParameters['teamId'], 'team-fe');
    });

    test('fetchUsage rejects team scope without a teamId', () async {
      var requested = false;
      final client = MockClient((request) async {
        requested = true;
        return http.Response(jsonEncode(_usageJson), 200);
      });
      final service = StatsApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      await expectLater(
        service.fetchUsage(orgId: 'org-1', scope: TelemetryUsageScope.team),
        throwsA(isA<ArgumentError>().having((e) => e.name, 'name', 'teamId')),
      );
      expect(requested, isFalse);
    });

    test('fetchUsage rejects team scope with a blank teamId', () async {
      var requested = false;
      final client = MockClient((request) async {
        requested = true;
        return http.Response(jsonEncode(_usageJson), 200);
      });
      final service = StatsApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      await expectLater(
        service.fetchUsage(
          orgId: 'org-1',
          scope: TelemetryUsageScope.team,
          teamId: '   ',
        ),
        throwsA(isA<ArgumentError>().having((e) => e.name, 'name', 'teamId')),
      );
      expect(requested, isFalse);
    });

    test('fetchUsage omits teamId when scope stays organization', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_usageJson), 200);
      });
      final service = StatsApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      // A stray teamId under org scope is ignored — only team scope sends it.
      await service.fetchUsage(orgId: 'org-1', teamId: 'team-fe');

      expect(captured.url.queryParameters['scope'], 'organization');
      expect(captured.url.queryParameters.containsKey('teamId'), isFalse);
    });
  });
}

/// The shared current-shape payload, with every collection non-empty.
///
/// This used to be a local literal whose lists were all `[]`, which meant no
/// row type was ever parsed here — see [buildUsageJson] for why that matters.
final Map<String, dynamic> _usageJson = buildUsageJson();

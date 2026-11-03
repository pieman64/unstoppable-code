import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/member_detail_api_service.dart';

void main() {
  group('MockMemberDetailRepository', () {
    test('load returns sample plans, approved plans, and pipelines', () async {
      final repository = MockMemberDetailRepository(latency: Duration.zero);

      final data = await repository.load(canViewStats: true);

      expect(data.sharedPlans, isNotEmpty);
      expect(data.approvedPlans, isNotEmpty);
      expect(data.pipelines, isNotEmpty);
      expect(data.usage, isNotNull);
    });

    test('load omits usage when the viewer cannot view stats', () async {
      final repository = MockMemberDetailRepository(latency: Duration.zero);

      final data = await repository.load(canViewStats: false);

      // The gated section is hidden — no usage is surfaced.
      expect(data.usage, isNull);
      // But the ungated lists still load.
      expect(data.sharedPlans, isNotEmpty);
    });
  });

  group('HttpMemberDetailRepository', () {
    HttpMemberDetailRepository repositoryWith(MockClient client) =>
        HttpMemberDetailRepository(
          service: MemberDetailApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          orgId: 'org-1',
          memberId: 'member-1',
        );

    test('does not request usage when canViewStats is false', () async {
      final requestedPaths = <String>[];
      final client = MockClient((request) async {
        requestedPaths.add(request.url.path);
        return http.Response('{"data": [], "nextCursor": null}', 200);
      });

      final data = await repositoryWith(client).load(canViewStats: false);

      expect(data.usage, isNull);
      // The three list endpoints are hit; the gated usage endpoint is not.
      expect(requestedPaths.any((p) => p.endsWith('/usage')), isFalse);
      expect(requestedPaths.where((p) => p.endsWith('/plans')), hasLength(1));
      expect(
        requestedPaths.where((p) => p.endsWith('/pipelines')),
        hasLength(1),
      );
      expect(
        requestedPaths.where((p) => p.endsWith('/approved-plans')),
        hasLength(1),
      );
    });

    test('swallows a usage failure so the lists still load', () async {
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/usage')) {
          return http.Response('forbidden', 403);
        }
        return http.Response('{"data": [], "nextCursor": null}', 200);
      });

      final data = await repositoryWith(client).load(canViewStats: true);

      // The 403 gate rejection is swallowed to null rather than failing load.
      expect(data.usage, isNull);
      expect(data.sharedPlans, isEmpty);
      expect(data.approvedPlans, isEmpty);
      expect(data.pipelines, isEmpty);
    });

    test(
      'surfaces usage when the gate permits and the read succeeds',
      () async {
        final client = MockClient((request) async {
          if (request.url.path.endsWith('/usage')) {
            return http.Response(_usageBody, 200);
          }
          return http.Response('{"data": [], "nextCursor": null}', 200);
        });

        final data = await repositoryWith(client).load(canViewStats: true);

        expect(data.usage, isNotNull);
        expect(data.usage!.headline, hasLength(1));
      },
    );
  });
}

const String _usageBody = '''
{
  "headline": [
    {"key": "turns", "label": "Agent turns", "unit": "count", "value": 5}
  ],
  "mostExpensiveRuns": [],
  "costByProvider": [],
  "costByModel": [],
  "tokensByProvider": [],
  "tokensByModel": [],
  "toolCategoryTotals": [],
  "eventTypeStatusCounts": [],
  "impactByUser": [],
  "byUser": [],
  "pipelines": [],
  "range": {
    "startIso": "2026-06-03T00:00:00.000Z",
    "endIso": "2026-07-03T00:00:00.000Z",
    "granularity": "day"
  },
  "scope": "organization"
}
''';

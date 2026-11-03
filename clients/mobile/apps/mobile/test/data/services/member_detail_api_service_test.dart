import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/member_detail_api_service.dart';

void main() {
  group('MemberDetailApiService', () {
    MemberDetailApiService serviceWith(MockClient client) =>
        MemberDetailApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        );

    test('fetchSharedPlans hits the plans path and unwraps { data }', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'data': [
              {
                'id': 'plan-1',
                'title': 'Shared plan',
                'shareScope': 'ORGANIZATION',
                'owner': {'type': 'organization', 'name': 'Acme'},
                'createdAt': '2026-06-20T10:00:00.000Z',
                'updatedAt': '2026-06-29T10:00:00.000Z',
              },
            ],
            'nextCursor': 'cursor-2',
          }),
          200,
        );
      });

      final page = await serviceWith(
        client,
      ).fetchSharedPlans(orgId: 'org-1', memberId: 'member-1');

      expect(captured.method, 'GET');
      expect(
        captured.url.path,
        '/api/account/organizations/org-1/members/member-1/plans',
      );
      expect(page.items, hasLength(1));
      expect(page.items.first.title, 'Shared plan');
      expect(page.items.first.shareScope, 'ORGANIZATION');
      expect(page.items.first.ownerType, 'organization');
      expect(page.items.first.ownerName, 'Acme');
      expect(page.nextCursor, 'cursor-2');
    });

    test('fetchApprovedPlans parses reviewStatus + start time', () async {
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode({
            'data': [
              {
                'id': 'approved-1',
                'title': 'Approved plan',
                'reviewStatus': 'APPROVED',
                'planVersion': 3,
                'implementationStartedAt': '2026-06-28T18:40:00.000Z',
                'updatedAt': '2026-06-28T19:10:00.000Z',
              },
            ],
            'nextCursor': null,
          }),
          200,
        ),
      );

      final page = await serviceWith(
        client,
      ).fetchApprovedPlans(orgId: 'org-1', memberId: 'member-1');

      expect(page.items, hasLength(1));
      expect(page.items.first.reviewStatus, 'APPROVED');
      expect(page.items.first.planVersion, 3);
      expect(page.nextCursor, isNull);
    });

    test('fetchPipelines hits the pipelines path and parses owner', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'data': [
              {
                'id': 'pipeline-1',
                'name': 'Autopilot',
                'description': 'Do the thing',
                'icon': 'rocket',
                'version': '1.4.0',
                'shareScope': 'TEAM',
                'owner': {'type': 'team', 'name': 'Platform'},
                'createdAt': '2026-06-10T10:00:00.000Z',
                'updatedAt': '2026-06-27T10:00:00.000Z',
              },
            ],
            'nextCursor': null,
          }),
          200,
        );
      });

      final page = await serviceWith(
        client,
      ).fetchPipelines(orgId: 'org-1', memberId: 'member-1');

      expect(
        captured.url.path,
        '/api/account/organizations/org-1/members/member-1/pipelines',
      );
      expect(page.items, hasLength(1));
      expect(page.items.first.name, 'Autopilot');
      expect(page.items.first.shareScope, 'TEAM');
      expect(page.items.first.ownerType, 'team');
      expect(page.items.first.version, '1.4.0');
    });

    test('a missing/non-list data envelope yields an empty page', () async {
      final client = MockClient(
        (request) async => http.Response(jsonEncode({'nextCursor': null}), 200),
      );

      final page = await serviceWith(
        client,
      ).fetchSharedPlans(orgId: 'org-1', memberId: 'member-1');

      expect(page.items, isEmpty);
      expect(page.nextCursor, isNull);
    });

    test(
      'fetchMemberUsage scopes to the member via the userId query param',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response(jsonEncode(_usageJson), 200);
        });

        final usage = await serviceWith(client).fetchMemberUsage(
          orgId: 'org-1',
          memberId: 'member-1',
          granularity: TelemetryTimeGranularity.day,
        );

        expect(captured.method, 'GET');
        expect(captured.url.path, '/api/account/organizations/org-1/usage');
        expect(captured.url.queryParameters['scope'], 'organization');
        expect(captured.url.queryParameters['userId'], 'member-1');
        expect(captured.url.queryParameters['granularity'], 'day');
        expect(captured.url.queryParameters['start'], isNotNull);
        expect(captured.url.queryParameters['end'], isNotNull);
        expect(usage.headline, hasLength(1));
        expect(usage.filterUserId, 'member-1');
      },
    );

    test('fetchMemberUsage propagates a 403 gate rejection', () async {
      final client = MockClient(
        (request) async => http.Response('forbidden', 403),
      );

      await expectLater(
        serviceWith(client).fetchMemberUsage(orgId: 'org-1', memberId: 'm'),
        throwsA(isA<ApiException>()),
      );
    });
  });
}

const Map<String, dynamic> _usageJson = {
  'headline': [
    {
      'key': 'totalCostUsd',
      'label': 'Observed cost',
      'unit': 'currency',
      'value': 214.72,
      'previousValue': 180.44,
    },
  ],
  'mostExpensiveRuns': <dynamic>[],
  'costByProvider': <dynamic>[],
  'costByModel': <dynamic>[],
  'tokensByProvider': <dynamic>[],
  'tokensByModel': <dynamic>[],
  'toolCategoryTotals': <dynamic>[],
  'eventTypeStatusCounts': <dynamic>[],
  'impactByUser': <dynamic>[],
  'byUser': <dynamic>[],
  'pipelines': <dynamic>[],
  'range': {
    'startIso': '2026-06-03T00:00:00.000Z',
    'endIso': '2026-07-03T00:00:00.000Z',
    'granularity': 'day',
  },
  'scope': 'organization',
  'filterUserId': 'member-1',
};

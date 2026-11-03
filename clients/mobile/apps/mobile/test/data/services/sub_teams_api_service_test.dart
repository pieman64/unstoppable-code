import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/sub_teams_api_service.dart';

void main() {
  group('SubTeamsApiService', () {
    SubTeamsApiService serviceWith(MockClient client) => SubTeamsApiService(
      apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
    );

    test('createSubTeam POSTs the name and parses the detail', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_orgJson), 201);
      });

      final org = await serviceWith(
        client,
      ).createSubTeam(orgId: 'org-1', name: 'Platform');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/account/organizations/org-1/teams');
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['name'], 'Platform');
      expect(org.id, 'org-1');
      expect(org.subTeams, hasLength(1));
    });

    test('renameSubTeam PATCHes the team name and parses the detail', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_orgJson), 200);
      });

      final org = await serviceWith(
        client,
      ).renameSubTeam(orgId: 'org-1', teamId: 'team-1', name: 'Renamed');

      expect(captured.method, 'PATCH');
      expect(
        captured.url.path,
        '/api/account/organizations/org-1/teams/team-1',
      );
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['name'], 'Renamed');
      expect(org.id, 'org-1');
    });

    test('deleteSubTeam DELETEs the team and parses the detail', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_orgJson), 200);
      });

      final org = await serviceWith(
        client,
      ).deleteSubTeam(orgId: 'org-1', teamId: 'team-1');

      expect(captured.method, 'DELETE');
      expect(
        captured.url.path,
        '/api/account/organizations/org-1/teams/team-1',
      );
      expect(org.id, 'org-1');
    });

    test('setMembership PUTs the member ids and parses the detail', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_orgJson), 200);
      });

      final org = await serviceWith(client).setMembership(
        orgId: 'org-1',
        teamId: 'team-1',
        memberUserIds: ['u1', 'u2'],
      );

      expect(captured.method, 'PUT');
      expect(
        captured.url.path,
        '/api/account/organizations/org-1/teams/team-1/members',
      );
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['memberUserIds'], ['u1', 'u2']);
      expect(org.id, 'org-1');
    });

    test('surfaces a non-2xx response as an ApiException', () async {
      final client = MockClient(
        (request) async => http.Response('forbidden', 403),
      );

      expect(
        () => serviceWith(client).createSubTeam(orgId: 'org-1', name: 'X'),
        throwsA(isA<ApiException>()),
      );
    });
  });
}

const Map<String, dynamic> _orgJson = {
  'id': 'org-1',
  'name': 'Acme',
  'viewerRole': 'ADMIN',
  'canViewUsageStats': true,
  'usageStatsMinRole': 'MEMBER',
  'githubConnection': <String, dynamic>{'connected': false},
  'members': [
    {
      'id': 'u1',
      'name': 'Alex',
      'email': 'alex@acme.dev',
      'role': 'OWNER',
      'subTeamIds': ['team-1'],
    },
  ],
  'subTeams': [
    {'id': 'team-1', 'name': 'Platform', 'memberCount': 1},
  ],
};

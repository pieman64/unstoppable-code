import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/account_api_service.dart';
import 'package:mobile/data/services/api_client.dart';

void main() {
  group('AccountApiService', () {
    test('listOrganizations parses the organizations array', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'organizations': [
              {
                'id': 'org-1',
                'name': 'Acme',
                'role': 'ADMIN',
                'memberCount': 4,
                'subTeamCount': 2,
              },
            ],
          }),
          200,
        );
      });
      final service = AccountApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      final account = await service.listOrganizations();
      final orgs = account.organizations;

      expect(captured.url.path, '/api/account/organizations');
      expect(orgs, hasLength(1));
      expect(orgs.first.id, 'org-1');
      expect(orgs.first.name, 'Acme');
      expect(account.personalOrganizationId, isNull);
    });

    test('listOrganizations keeps Personal apart from the teams', () async {
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode({
            'organizations': <Object>[],
            'personalOrganizationId': 'personal-1',
          }),
          200,
        ),
      );
      final service = AccountApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      final account = await service.listOrganizations();

      expect(account.organizations, isEmpty);
      expect(account.personalOrganizationId, 'personal-1');
    });

    test('listOrganizations tolerates a missing array', () async {
      final client = MockClient((request) async => http.Response('{}', 200));
      final service = AccountApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      final account = await service.listOrganizations();
      expect(account.organizations, isEmpty);
      expect(account.personalOrganizationId, isNull);
    });
  });
}

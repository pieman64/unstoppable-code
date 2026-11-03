import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/org_api_service.dart';

const _baseUrl = 'https://canopy.example.com';

OrgApiService _service(MockClient client) => OrgApiService(
  apiClient: ApiClient(
    baseUrl: _baseUrl,
    defaultHeaders: const {},
    httpClient: client,
  ),
);

Map<String, dynamic> _orgDetailJson(String id, String name) => {
  'id': id,
  'name': name,
  'viewerRole': 'OWNER',
  'canViewUsageStats': true,
  'githubConnection': {'connected': false},
  'usageStatsMinRole': 'MEMBER',
  'subTeams': <dynamic>[],
  'members': <dynamic>[],
};

void main() {
  group('OrgApiService', () {
    test('createOrganization posts the name and parses the detail', () async {
      String? method;
      Uri? uri;
      String? body;
      final client = MockClient((req) async {
        method = req.method;
        uri = req.url;
        body = req.body;
        return http.Response(
          jsonEncode(_orgDetailJson('org-new', 'Acme')),
          201,
        );
      });

      final detail = await _service(client).createOrganization('Acme');

      expect(method, 'POST');
      expect(uri?.path, '/api/account/organizations');
      expect(jsonDecode(body!), {'name': 'Acme'});
      expect(detail.id, 'org-new');
      expect(detail.name, 'Acme');
    });

    test('renameOrganization patches the id path with the name', () async {
      String? method;
      Uri? uri;
      String? body;
      final client = MockClient((req) async {
        method = req.method;
        uri = req.url;
        body = req.body;
        return http.Response(
          jsonEncode(_orgDetailJson('org-7', 'Renamed')),
          200,
        );
      });

      final detail = await _service(
        client,
      ).renameOrganization(orgId: 'org-7', name: 'Renamed');

      expect(method, 'PATCH');
      expect(uri?.path, '/api/account/organizations/org-7');
      expect(jsonDecode(body!), {'name': 'Renamed'});
      expect(detail.name, 'Renamed');
    });

    test('leaveOrganization posts to the leave path', () async {
      String? method;
      Uri? uri;
      final client = MockClient((req) async {
        method = req.method;
        uri = req.url;
        return http.Response('', 204);
      });

      await _service(client).leaveOrganization('org-9');

      expect(method, 'POST');
      expect(uri?.path, '/api/account/organizations/org-9/leave');
    });

    test('deleteOrganization deletes the id path', () async {
      String? method;
      Uri? uri;
      final client = MockClient((req) async {
        method = req.method;
        uri = req.url;
        return http.Response('', 204);
      });

      await _service(client).deleteOrganization('org-9');

      expect(method, 'DELETE');
      expect(uri?.path, '/api/account/organizations/org-9');
    });
  });
}

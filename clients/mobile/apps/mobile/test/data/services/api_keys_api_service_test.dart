import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/api_keys_api_service.dart';

const _baseUrl = 'https://canopy.example.com';

ApiKeysApiService _service(MockClient client) => ApiKeysApiService(
  apiClient: ApiClient(
    baseUrl: _baseUrl,
    defaultHeaders: const {},
    httpClient: client,
  ),
);

Map<String, dynamic> _keyJson(String id, String name) => {
  'id': id,
  'name': name,
  'source': 'MANUAL',
  'createdIp': '203.0.113.7',
  'createdAt': '2026-06-20T10:00:00.000Z',
  'lastUsedAt': null,
};

void main() {
  group('ApiKeysApiService', () {
    test('listApiKeys parses a top-level JSON array', () async {
      Uri? uri;
      String? method;
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        return http.Response(
          jsonEncode([_keyJson('k1', 'CI'), _keyJson('k2', 'Dev')]),
          200,
        );
      });

      final keys = await _service(client).listApiKeys();

      expect(method, 'GET');
      expect(uri?.path, '/api/account/api-keys');
      expect(keys, hasLength(2));
      expect(keys.first.name, 'CI');
      expect(keys.first.source, UserApiKeySource.manual);
    });

    test('createApiKey posts the name and parses the one-time token', () async {
      String? method;
      String? body;
      final client = MockClient((req) async {
        method = req.method;
        body = req.body;
        return http.Response(
          jsonEncode({'token': 'sk-123', 'userApiKey': _keyJson('k3', 'New')}),
          201,
        );
      });

      final resp = await _service(client).createApiKey('New');

      expect(method, 'POST');
      expect(jsonDecode(body!), {'name': 'New'});
      expect(resp.token, 'sk-123');
      expect(resp.userApiKey.id, 'k3');
    });

    test('revokeApiKey deletes the id path', () async {
      Uri? uri;
      String? method;
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        return http.Response('', 204);
      });

      await _service(client).revokeApiKey('k9');

      expect(method, 'DELETE');
      expect(uri?.path, '/api/account/api-keys/k9');
    });
  });
}

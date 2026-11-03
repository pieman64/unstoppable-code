import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/auth_sources_api_service.dart';

const _baseUrl = 'https://canopy.example.com';

AuthSourcesApiService _service(MockClient client) => AuthSourcesApiService(
  apiClient: ApiClient(
    baseUrl: _baseUrl,
    defaultHeaders: const {},
    httpClient: client,
  ),
);

Map<String, dynamic> _sourceJson(
  String providerId,
  String label, {
  required bool canUnlink,
}) => {
  'providerId': providerId,
  'accountId': 'acct-$providerId',
  'label': label,
  'linkedAt': '2026-06-20T10:00:00.000Z',
  'canUnlink': canUnlink,
};

void main() {
  group('AuthSourcesApiService', () {
    test('listAuthSources parses the top-level object', () async {
      Uri? uri;
      String? method;
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        return http.Response(
          jsonEncode({
            'user': {
              'name': 'Ada',
              'email': 'ada@example.com',
              'twoFactorEnabled': true,
            },
            'sources': [
              _sourceJson('credential', 'Email and password', canUnlink: false),
              _sourceJson('google', 'Google', canUnlink: true),
            ],
          }),
          200,
        );
      });

      final response = await _service(client).listAuthSources();

      expect(method, 'GET');
      expect(uri?.path, '/api/account/auth-sources');
      expect(response.user.name, 'Ada');
      expect(response.user.email, 'ada@example.com');
      expect(response.user.twoFactorEnabled, isTrue);
      expect(response.sources, hasLength(2));
      expect(response.sources.first.providerId, 'credential');
      expect(response.sources.first.label, 'Email and password');
      expect(response.sources.first.canUnlink, isFalse);
      expect(response.sources[1].providerId, 'google');
      expect(response.sources[1].canUnlink, isTrue);
    });

    test('unlinkAuthSource deletes the providerId path with the accountId '
        'body', () async {
      Uri? uri;
      String? method;
      String requestBody = '';
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        requestBody = req.body;
        return http.Response('', 204);
      });

      await _service(
        client,
      ).unlinkAuthSource(providerId: 'google', accountId: 'acct-google');

      expect(method, 'DELETE');
      expect(uri?.path, '/api/account/auth-sources/google');
      expect(jsonDecode(requestBody), {'accountId': 'acct-google'});
    });
  });
}

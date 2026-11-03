import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';

void main() {
  group('ApiClient.deleteJsonWithBody', () {
    test('sends a DELETE carrying a JSON body', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });
      final api = ApiClient(
        baseUrl: 'https://api.test',
        httpClient: client,
        defaultHeaders: const {'Content-Type': 'application/json'},
      );

      await api.deleteJsonWithBody(
        '/api/account/devices',
        body: {'token': 't'},
      );

      expect(captured.method, 'DELETE');
      expect(captured.url.path, '/api/account/devices');
      expect(jsonDecode(captured.body), {'token': 't'});
    });

    test('sends no body when none is provided', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      await api.deleteJsonWithBody('/x');

      expect(captured.body, isEmpty);
    });

    test('throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('boom', 409));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      expect(
        () => api.deleteJsonWithBody('/x', body: {'token': 't'}),
        throwsA(isA<ApiException>()),
      );
    });
  });
}

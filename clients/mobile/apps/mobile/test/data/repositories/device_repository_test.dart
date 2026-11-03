import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/device_registration.dart';
import 'package:mobile/data/repositories/device_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/device_api_service.dart';

void main() {
  group('MockDeviceRepository', () {
    test('register records the token', () async {
      final repo = MockDeviceRepository(latency: Duration.zero);

      await repo.register(token: 'tok-1', platform: DevicePlatform.ios);

      expect(repo.registeredTokens, ['tok-1']);
      expect(repo.unregisteredTokens, isEmpty);
    });

    test('unregister records the token', () async {
      final repo = MockDeviceRepository(latency: Duration.zero);

      await repo.unregister(token: 'tok-1');

      expect(repo.unregisteredTokens, ['tok-1']);
      expect(repo.registeredTokens, isEmpty);
    });
  });

  group('HttpDeviceRepository', () {
    HttpDeviceRepository build(MockClient client) => HttpDeviceRepository(
      service: DeviceApiService(
        apiClient: ApiClient(
          baseUrl: 'https://api.test',
          defaultHeaders: const {'Content-Type': 'application/json'},
          httpClient: client,
        ),
      ),
    );

    test('register posts the token and wire platform', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 201);
      });

      await build(
        client,
      ).register(token: 'tok-1', platform: DevicePlatform.ios);

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/account/devices');
      expect(jsonDecode(captured.body), {'token': 'tok-1', 'platform': 'IOS'});
    });

    test('register sends ANDROID for the android platform', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 201);
      });

      await build(
        client,
      ).register(token: 'tok-2', platform: DevicePlatform.android);

      expect(jsonDecode(captured.body), {
        'token': 'tok-2',
        'platform': 'ANDROID',
      });
    });

    test('unregister sends a DELETE carrying the token body', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });

      await build(client).unregister(token: 'tok-1');

      expect(captured.method, 'DELETE');
      expect(captured.url.path, '/api/account/devices');
      expect(jsonDecode(captured.body), {'token': 'tok-1'});
    });

    test('register throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('boom', 500));

      expect(
        () => build(client).register(token: 't', platform: DevicePlatform.ios),
        throwsA(isA<ApiException>()),
      );
    });

    test('unregister throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('boom', 500));

      expect(
        () => build(client).unregister(token: 't'),
        throwsA(isA<ApiException>()),
      );
    });
  });
}

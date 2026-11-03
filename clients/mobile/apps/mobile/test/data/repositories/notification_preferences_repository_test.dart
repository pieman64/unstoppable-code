import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/notification_preferences.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/notification_preferences_api_service.dart';

void main() {
  group('NotificationPreferences.fromJson', () {
    test('defaults pushEnabled to true when the key is missing', () {
      final prefs = NotificationPreferences.fromJson(<String, dynamic>{});

      expect(prefs.pushEnabled, isTrue);
    });

    test('defaults pushEnabled to true when the key is not a bool', () {
      final prefs = NotificationPreferences.fromJson(<String, dynamic>{
        'pushEnabled': 'nope',
      });

      expect(prefs.pushEnabled, isTrue);
    });

    test('reads an explicit false', () {
      final prefs = NotificationPreferences.fromJson(<String, dynamic>{
        'pushEnabled': false,
      });

      expect(prefs.pushEnabled, isFalse);
    });
  });

  group('MockNotificationPreferencesRepository', () {
    test('load returns the seeded pushEnabled value', () async {
      final repo = MockNotificationPreferencesRepository(
        latency: Duration.zero,
      );

      final prefs = await repo.load();

      expect(prefs.pushEnabled, isTrue);
    });

    test('update round-trips the new pushEnabled value', () async {
      final repo = MockNotificationPreferencesRepository(
        latency: Duration.zero,
      );

      final updated = await repo.update(pushEnabled: false);

      expect(updated.pushEnabled, isFalse);
      expect((await repo.load()).pushEnabled, isFalse);
    });
  });

  group('HttpNotificationPreferencesRepository', () {
    HttpNotificationPreferencesRepository build(MockClient client) =>
        HttpNotificationPreferencesRepository(
          service: NotificationPreferencesApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
        );

    test('load GETs the notification-preferences route', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode({'pushEnabled': false}), 200);
      });

      final prefs = await build(client).load();

      expect(captured.method, 'GET');
      expect(captured.url.path, '/api/account/notification-preferences');
      expect(prefs.pushEnabled, isFalse);
    });

    test('update PATCHes the pushEnabled value in the body', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode({'pushEnabled': true}), 200);
      });

      final prefs = await build(client).update(pushEnabled: true);

      expect(captured.method, 'PATCH');
      expect(captured.url.path, '/api/account/notification-preferences');
      expect(jsonDecode(captured.body), {'pushEnabled': true});
      expect(prefs.pushEnabled, isTrue);
    });

    test('load throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('boom', 500));

      expect(() => build(client).load(), throwsA(isA<ApiException>()));
    });

    test('update throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('boom', 500));

      expect(
        () => build(client).update(pushEnabled: true),
        throwsA(isA<ApiException>()),
      );
    });
  });
}
